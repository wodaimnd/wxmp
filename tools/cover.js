/**
 * 封面图生成：900×383（微信 2.35:1 封面）与 200×200（小图）。
 *
 * 两条渲染路径：
 *  1. Windows：调用 PowerShell + GDI+（System.Drawing），能正确排中文、抗锯齿、
 *     渐变、自动换行——实际产线走这条。
 *  2. 其它平台 / GDI 不可用：退化为纯 JS PNG 编码器，画渐变 + 几何装饰，不含文字。
 *     这样在没有图形栈的环境里也不会失败，只是封面没有标题文字。
 *
 * 子进程输出走文件而不是管道（受限沙箱里管道会 EPERM），与 winpilot 同一套做法。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'

import { THEMES, themeByName } from '../src/markdown.js'
import { COVER_SIZE as LAYOUT_SIZE, COVER_TONE, mixColor, planCover, measure } from './cover-layout.js'

export const COVER_SIZE = LAYOUT_SIZE
export const SQUARE_SIZE = { width: 200, height: 200 }

/* ------------------------------------------------------------------ */
/* 纯 JS PNG 编码（无文字，只有渐变 + 装饰）                            */
/* ------------------------------------------------------------------ */

function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i]
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crcBuf])
}

function hexToRgb(hex) {
  const value = String(hex).replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ]
}

/**
 * 生成渐变封面 PNG（纯 JS）。
 *
 * 尺寸优先级：显式 width/height > plan 的宽高 > 推荐值。
 * 认 plan 是必要的 —— GDI 失败时 renderCover 会拿同一份 options 回落，
 * 如果这里只看 options.width，用户改了尺寸又恰好碰上 GDI 失败，
 * 拿到的会是一张 900×383 的渐变图，而返回值全是成功，几乎查不出来。
 *
 * @param {{width?: number, height?: number, plan?: {width: number, height: number}, theme?: string, from?: string, to?: string}} options
 * @returns {Buffer}
 */
export function renderGradientPng(options = {}) {
  const plan = options.plan || {}
  const width = options.width || plan.width || COVER_SIZE.width
  const height = options.height || plan.height || COVER_SIZE.height
  const theme = themeByName(options.theme)
  const from = hexToRgb(options.from || theme.accent)
  const to = hexToRgb(options.to || theme.accentDark)

  const raw = Buffer.alloc(height * (width * 3 + 1))
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0 // filter: none
    offset += 1
    for (let x = 0; x < width; x += 1) {
      const t = (x / Math.max(1, width - 1) * 0.7 + y / Math.max(1, height - 1) * 0.3)
      // 斜向大色块：右下角叠一层更亮的圆形光斑，避免纯渐变太单调
      const cx = width * 0.82
      const cy = height * 0.2
      const distance = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / (width * 0.55)
      const glow = Math.max(0, 1 - distance) * 55
      raw[offset] = Math.min(255, Math.round(from[0] + (to[0] - from[0]) * t + glow))
      raw[offset + 1] = Math.min(255, Math.round(from[1] + (to[1] - from[1]) * t + glow))
      raw[offset + 2] = Math.min(255, Math.round(from[2] + (to[2] - from[2]) * t + glow))
      offset += 3
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------------------------------------------ */
/* Windows GDI 渲染（支持中文）                                         */
/* ------------------------------------------------------------------ */

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** 生成 PowerShell 脚本：由 JS 算好的版式逐行绘制（不在脚本里折行）。 */
export function buildGdiScript(options = {}) {
  const plan = options.plan || planCover(options)
  const width = plan.width
  const height = plan.height
  const theme = themeByName(options.theme)
  const outPath = options.outPath
  const pad = plan.padX
  const from = hexToRgb(options.from || theme.accent)
  const to = hexToRgb(options.to || theme.accentDark)
  // 深墨 → 中调：左上更沉（白字清楚），右下更亮（有落点）。
  // 用 mixColor 而不是直接拿 accent，否则 900×383 上一片亮绿，白字对比度不够。
  const deepFrom = options.from ? from : mixColor(theme.accent, COVER_TONE.darkMix)
  const deepTo = options.to ? to : mixColor(theme.accent, COVER_TONE.lightMix)

  const lines = [
    'Add-Type -AssemblyName System.Drawing',
    `$w = ${width}`,
    `$h = ${height}`,
    '$bmp = New-Object System.Drawing.Bitmap $w, $h',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    "$g.SmoothingMode = 'AntiAlias'",
    "$g.TextRenderingHint = 'AntiAliasGridFit'",
    "$g.InterpolationMode = 'HighQualityBicubic'",

    // 底色：深墨 → 中调 的斜向渐变。
    // 不再用主题的亮 accent 直接铺满（纯绿太刺眼、白字对比度低）。
    `$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(` +
      `(New-Object System.Drawing.Point 0,0), (New-Object System.Drawing.Point $w,$h), ` +
      `[System.Drawing.Color]::FromArgb(${deepFrom.join(',')}), ` +
      `[System.Drawing.Color]::FromArgb(${deepTo.join(',')}))`,
    '$g.FillRectangle($brush, 0, 0, $w, $h)',

    // 右上角柔光斑（半径更大、透明度更低，避免出现"圆盘"边）
    `$glow = New-Object System.Drawing.Drawing2D.GraphicsPath`,
    `$glow.AddEllipse(($w * 0.58), (-$h * 0.55), ($w * 0.9), ($w * 0.9))`,
    `$glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($glow)`,
    '$glowBrush.CenterColor = [System.Drawing.Color]::FromArgb(46,255,255,255)',
    '$glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0,255,255,255))',
    '$g.FillPath($glowBrush, $glow)',
  ]

  // ── 标题：逐行绘制，位置与字号都来自 JS 的 planCover ──
  if (plan.placements.length) {
    lines.push(
      // 必须显式指定 Pixel 单位！Font 构造默认用 Point：
      // 46 Point = 61px，实测标题直接冲出画布（900 宽被撑到 1200+）。
      `$titleFont = New-Object System.Drawing.Font -ArgumentList @('Microsoft YaHei', ${plan.size}, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)`,
      // 轻微阴影：深底上手写体量感更稳，也不会糊
      '$shadowBrush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(60,0,0,0))',
      `$titleBrush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(255,255,255,255))`,
      '$fmt = New-Object System.Drawing.StringFormat',
      "$fmt.Trimming = 'None'",
      // NoWrap 很关键：否则 GDI 会自己在矩形里再折一次行，把 JS 算好的断行破坏掉
      "$fmt.FormatFlags = 'NoWrap'",
    )
    // 用 DrawString(text, font, brush, x, y) 的重载：不给矩形，GDI 不会折行
    for (const item of plan.placements) {
      const x = Math.round(item.x)
      const y = Math.round(item.y)
      lines.push(
        `$g.DrawString(${psQuote(item.text)}, $titleFont, $shadowBrush, ${x + 1}, ${y + 2}, $fmt)`,
        `$g.DrawString(${psQuote(item.text)}, $titleFont, $titleBrush, ${x}, ${y}, $fmt)`,
      )
    }
  }

  // ── 副标题 + 装饰线 ──
  if (plan.subtitle) {
    lines.push(
      `$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(150,255,255,255)), 2`,
      `$g.DrawLine($pen, ${Math.round(plan.rule.x)}, ${Math.round(plan.rule.y)}, ${Math.round(plan.rule.x + plan.rule.width)}, ${Math.round(plan.rule.y)})`,
      `$subFont = New-Object System.Drawing.Font -ArgumentList @('Microsoft YaHei', ${plan.subtitle.size}, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)`,
      `$subBrush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(205,255,255,255))`,
      `$subRect = New-Object System.Drawing.RectangleF @(${Math.round(plan.subtitle.x)}, ${Math.round(plan.subtitle.y)}, ${width - pad * 2}, ${Math.round(plan.subtitle.size * 1.6)})`,
      `$g.DrawString(${psQuote(plan.subtitle.text)}, $subFont, $subBrush, $subRect, $fmt)`,
    )
  } else if (plan.rule) {
    // 没有副标题也要有一条线，否则右下角空得发慌
    lines.push(
      `$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(120,255,255,255)), 2`,
      `$g.DrawLine($pen, ${Math.round(plan.rule.x)}, ${Math.round(plan.rule.y)}, ${Math.round(plan.rule.x + plan.rule.width)}, ${Math.round(plan.rule.y)})`,
    )
  }

  // ── 角标：右上角圆形胶囊，测宽后画 ──
  if (plan.badge) {
    lines.push(
      `$badgeFont = New-Object System.Drawing.Font -ArgumentList @('Microsoft YaHei', ${plan.badge.size}, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)`,
      `$badgeSize = $g.MeasureString(${psQuote(plan.badge.text)}, $badgeFont)`,
      `$badgeW = $badgeSize.Width + 22`,
      `$badgeH = $badgeSize.Height + 8`,
      `$badgeX = ${Math.round(plan.badge.right)} - $badgeW`,
      `$badgeY = ${Math.round(plan.badge.top)}`,
      '$badgePath = New-Object System.Drawing.Drawing2D.GraphicsPath',
      '$r = 10',
      '$badgePath.AddArc($badgeX, $badgeY, ($r * 2), ($r * 2), 180, 90)',
      '$badgePath.AddArc(($badgeX + $badgeW - $r * 2), $badgeY, ($r * 2), ($r * 2), 270, 90)',
      '$badgePath.AddArc(($badgeX + $badgeW - $r * 2), ($badgeY + $badgeH - $r * 2), ($r * 2), ($r * 2), 0, 90)',
      '$badgePath.AddArc($badgeX, ($badgeY + $badgeH - $r * 2), ($r * 2), ($r * 2), 90, 90)',
      '$badgePath.CloseFigure()',
      '$badgeBrush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(38,255,255,255))',
      '$g.FillPath($badgeBrush, $badgePath)',
      `$g.DrawString(${psQuote(plan.badge.text)}, $badgeFont, [System.Drawing.Brushes]::White, ($badgeX + 11), ($badgeY + 4))`,
    )
  }

  lines.push(
    '$g.Dispose()',
    `$bmp.Save(${psQuote(outPath)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$bmp.Dispose()',
    "Write-Output 'WXMP_COVER_OK'",
  )
  return lines.join('\r\n')
}

/** 用子进程跑一次脚本（输出走文件）。 */
function runPowerShell(scriptPath, logPath, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let fd
    try {
      fd = fs.openSync(logPath, 'w')
    } catch {
      fd = undefined
    }
    const stdio = fd === undefined ? ['ignore', 'ignore', 'ignore'] : ['ignore', fd, fd]
    let child
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { windowsHide: true, stdio },
      )
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd)
        } catch {
          /* ignore */
        }
      }
      resolve({ ok: false, error: error.message, output: '' })
      return
    }
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let output = ''
      try {
        output = fs.readFileSync(logPath, 'utf8')
      } catch {
        /* 没有日志 */
      }
      resolve({ ...result, output })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      finish({ ok: false, error: 'powershell timeout' })
    }, timeoutMs)
    child.once('error', (error) => finish({ ok: false, error: error.message }))
    child.once('close', (code) => finish({ ok: code === 0 }))
  })
}

/**
 * 生成封面图。优先 GDI（中文可用），失败回退纯 JS 渐变。
 *
 * @param {{title?: string, subtitle?: string, badge?: string, theme?: string,
 *          width?: number, height?: number, outPath: string, workDir?: string}} options
 * @returns {Promise<{path: string, method: 'gdi'|'gradient', bytes: number, error?: string}>}
 */
export async function renderCover(options) {
  const outPath = path.resolve(options.outPath)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  if (process.platform === 'win32') {
    const workDir = options.workDir || path.join(os.tmpdir(), 'wxmp-cover')
    try {
      fs.mkdirSync(workDir, { recursive: true })
    } catch {
      /* 用临时目录兜底 */
    }
    const stamp = `${process.pid}-${Date.now()}`
    const scriptPath = path.join(workDir, `cover-${stamp}.ps1`)
    const logPath = path.join(workDir, `cover-${stamp}.log`)
    try {
      // 必须带 UTF-8 BOM：PowerShell 5.1 默认按 ANSI 读取无 BOM 的 .ps1，
      // 中文标题会变成乱码并破坏引号配对，报 "Missing ')' in method call"。
      fs.writeFileSync(scriptPath, `\uFEFF${buildGdiScript({ ...options, outPath })}`, 'utf8')
      const result = await runPowerShell(scriptPath, logPath)
      if (result.ok && fs.existsSync(outPath)) {
        const bytes = fs.statSync(outPath).size
        cleanup([scriptPath, logPath])
        return { path: outPath, method: 'gdi', bytes }
      }
      const error = (result.output || result.error || '').trim().slice(0, 300)
      fs.writeFileSync(outPath, renderGradientPng(options))
      cleanup([scriptPath, logPath])
      return { path: outPath, method: 'gradient', bytes: fs.statSync(outPath).size, error }
    } catch (error) {
      const fallback = renderGradientPng(options)
      fs.writeFileSync(outPath, fallback)
      return { path: outPath, method: 'gradient', bytes: fallback.length, error: error.message }
    }
  }

  const buffer = renderGradientPng(options)
  fs.writeFileSync(outPath, buffer)
  return { path: outPath, method: 'gradient', bytes: buffer.length }
}

function cleanup(files) {
  for (const file of files) {
    try {
      fs.unlinkSync(file)
    } catch {
      /* 没有就算了 */
    }
  }
}

/** 主题清单（给 CLI 的 --list 用）。 */
export function listThemes() {
  return Object.keys(THEMES)
}
