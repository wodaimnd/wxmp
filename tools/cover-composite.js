/**
 * 封面背景合成：AI 生成抽象底图 + GDI 叠中文标题。
 *
 * ## 为什么是这个组合（不是"全交给 AI"）
 * 实测结论（2026-11-06，本机 PowerShell 7 + GDI+）：
 *   - GDI 能把任意底图等比铺满 900×383 不变形，并在上面叠出**笔画锐利**的中文标题
 *   - 但 AI 模型（gpt-image-2 / nano-banana 等）画**中文字**经常糊、串笔、乱码
 * 所以分工：AI 只做「无字抽象背景」（质感、光影、构图是它擅长的），
 * 文字仍由 GDI 用雅黑 Bold 排——各做自己擅长的部分。
 *
 * ## 与 cover-layout.js 的关系
 * 版式计算（断行/字号/位置）**完全复用** cover-layout.js，这里只多一件事：
 * 把背景来源分三档，并把底图按等比裁剪算好。
 *
 *   1. `--bg <图片>`        用户给底图（最可控，现在就能用）
 *   2. `--image-gen`        AI 生成（需 key，失败自动降级到第 3 档）
 *   3. 都不给               回落现有渐变（零依赖默认）
 *
 * ## 关键设计：压暗蒙版
 * 底图亮的地方白字看不清。合成前必须铺一层半透明深色，
 * 强度可调（`scrimAlpha`），默认 0.42——实测这个值在深绿/亮蓝底上都能保证可读。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { COVER_SIZE, LAYOUT, planCover } from './cover-layout.js'

/** 背景来源的三种模式。 */
export const BACKGROUND_MODES = {
  FILE: 'file', // --bg 用户提供
  GENERATED: 'generated', // --image-gen AI 生成
  GRADIENT: 'gradient', // 回落渐变
}

/**
 * 等比裁剪计算：把 srcW×srcH 的图铺满 dstW×dstH，居中裁掉多余部分。
 *
 * 为什么不直接拉伸：900×383 是 2.35:1，而 AI 常用 1536×1024（1.5:1）。
 * 直接拉伸会把图压扁成「饼」，等比裁剪只丢掉上下/左右的一部分，形变不可见。
 *
 * @returns {{sx, sy, sw, sh, dx, dy, dw, dh}} GDI DrawImage 的源/目标矩形
 */
export function planBackgroundFit(srcW, srcH, dstW = COVER_SIZE.width, dstH = COVER_SIZE.height) {
  const sw = Number(srcW) || 0
  const sh = Number(srcH) || 0
  if (!sw || !sh) {
    // 尺寸未知就整张铺（交给 GDI 自己缩），不抛错
    return { sx: 0, sy: 0, sw: 0, sh: 0, dx: 0, dy: 0, dw: dstW, dh: dstH }
  }
  const srcRatio = sw / sh
  const dstRatio = dstW / dstH
  // 源比目标更宽 → 左右裁；更窄 → 上下裁
  if (srcRatio > dstRatio) {
    // 以高度为准，裁宽
    const visibleW = sh * dstRatio
    return {
      sx: Math.round((sw - visibleW) / 2),
      sy: 0,
      sw: Math.round(visibleW),
      sh,
      dx: 0,
      dy: 0,
      dw: dstW,
      dh: dstH,
    }
  }
  const visibleH = sw / dstRatio
  return {
    sx: 0,
    sy: Math.round((sh - visibleH) / 2),
    sw,
    sh: Math.round(visibleH),
    dx: 0,
    dy: 0,
    dw: dstW,
    dh: dstH,
  }
}

/** 读 PNG/JPEG 的像素尺寸（只用文件头，不解码整图）。 */
export function readImageSize(filePath) {
  const buf = fs.readFileSync(filePath)
  // PNG: 8 字节签名 + IHDR，宽高在偏移 16/20
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: 'image/png' }
  }
  // JPEG: 扫 SOF 段
  if (buf.length >= 4 && buf[0] === 255 && buf[1] === 216) {
    let offset = 2
    while (offset < buf.length - 9) {
      if (buf[offset] !== 255) {
        offset += 1
        continue
      }
      const marker = buf[offset + 1]
      // SOF0-SOF15（排除 DHT/JPG/DAC）
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5), mime: 'image/jpeg' }
      }
      const segLen = buf.readUInt16BE(offset + 2)
      offset += 2 + segLen
    }
  }
  return { width: 0, height: 0, mime: 'unknown' }
}

/**
 * 生成 GDI 合成脚本：底图铺满 + 压暗蒙版 + 中文标题。
 *
 * 与纯渐变脚本的区别只有前几步（读图/裁剪/蒙版），
 * 标题那一段**完全复用** cover-layout.js 算好的坐标，保证版式不因背景来源漂移。
 */
export function buildCompositeScript(options = {}) {
  const plan = options.plan || planCover(options)
  const width = plan.width
  const height = plan.height
  const outPath = options.outPath
  const bgPath = options.backgroundPath
  const srcW = Number(options.backgroundWidth) || 0
  const srcH = Number(options.backgroundHeight) || 0
  const scrimAlpha = Number.isFinite(options.scrimAlpha) ? options.scrimAlpha : 0.42
  const fit = planBackgroundFit(srcW, srcH, width, height)

  const lines = [
    'Add-Type -AssemblyName System.Drawing',
    `$w = ${width}`,
    `$h = ${height}`,
    '$bmp = New-Object System.Drawing.Bitmap -ArgumentList $w, $h',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    "$g.SmoothingMode = 'HighQuality'",
    "$g.InterpolationMode = 'HighQualityBicubic'",
    "$g.TextRenderingHint = 'AntiAliasGridFit'",
    // 底图：等比裁剪铺满
    `$bg = [System.Drawing.Image]::FromFile(${psQuote(bgPath)})`,
    `$srcRect = New-Object System.Drawing.Rectangle -ArgumentList ${fit.sx}, ${fit.sy}, ${fit.sw}, ${fit.sh}`,
    `$dstRect = New-Object System.Drawing.Rectangle -ArgumentList ${fit.dx}, ${fit.dy}, ${fit.dw}, ${fit.dh}`,
    '$g.DrawImage($bg, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)',
    '$bg.Dispose()',
    // 压暗蒙版：保证白字可读（底图亮的地方不铺会看不清）
    `$scrim = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb([Math]::Round(255 * ${Math.round(scrimAlpha * 100) / 100}), 0, 0, 0))`,
    '$g.FillRectangle($scrim, 0, 0, $w, $h)',
    '$scrim.Dispose()',
    // 右下角留一点通透感：叠一层极淡的白，避免整张死黑
    `$lift = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.Point 0,0), (New-Object System.Drawing.Point $w,$h), [System.Drawing.Color]::FromArgb(0,255,255,255), [System.Drawing.Color]::FromArgb(28,255,255,255))`,
    '$g.FillRectangle($lift, 0, 0, $w, $h)',
    '$lift.Dispose()',
  ]

  // ── 标题：与纯渐变版完全一致的排版 ──
  if (plan.placements.length) {
    lines.push(
      `$titleFont = New-Object System.Drawing.Font -ArgumentList @('Microsoft YaHei', ${plan.size}, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)`,
      '$shadowBrush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(90,0,0,0))',
      '$titleBrush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(255,255,255,255))',
      '$fmt = New-Object System.Drawing.StringFormat',
      "$fmt.Trimming = 'None'",
      "$fmt.FormatFlags = 'NoWrap'",
    )
    for (const item of plan.placements) {
      const x = Math.round(item.x)
      const y = Math.round(item.y)
      lines.push(
        `$g.DrawString(${psQuote(item.text)}, $titleFont, $shadowBrush, ${x + 1}, ${y + 2}, $fmt)`,
        `$g.DrawString(${psQuote(item.text)}, $titleFont, $titleBrush, ${x}, ${y}, $fmt)`,
      )
    }
  }

  // 副标题 + 装饰线
  if (plan.subtitle) {
    lines.push(
      '$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(170,255,255,255)), 2',
      `$g.DrawLine($pen, ${Math.round(plan.rule.x)}, ${Math.round(plan.rule.y)}, ${Math.round(plan.rule.x + plan.rule.width)}, ${Math.round(plan.rule.y)})`,
      `$subFont = New-Object System.Drawing.Font -ArgumentList @('Microsoft YaHei', ${plan.subtitle.size}, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)`,
      `$subBrush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(215,255,255,255))`,
      `$subRect = New-Object System.Drawing.RectangleF -ArgumentList ${Math.round(plan.subtitle.x)}, ${Math.round(plan.subtitle.y)}, ${width - plan.padX * 2}, ${Math.round(plan.subtitle.size * 1.6)}`,
      `$g.DrawString(${psQuote(plan.subtitle.text)}, $subFont, $subBrush, $subRect, $fmt)`,
    )
  } else if (plan.rule) {
    lines.push(
      '$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(140,255,255,255)), 2',
      `$g.DrawLine($pen, ${Math.round(plan.rule.x)}, ${Math.round(plan.rule.y)}, ${Math.round(plan.rule.x + plan.rule.width)}, ${Math.round(plan.rule.y)})`,
    )
  }

  // 角标
  if (plan.badge) {
    lines.push(
      `$badgeFont = New-Object System.Drawing.Font -ArgumentList @('Microsoft YaHei', ${plan.badge.size}, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)`,
      `$badgeSize = $g.MeasureString(${psQuote(plan.badge.text)}, $badgeFont)`,
      '$badgeW = $badgeSize.Width + 22',
      '$badgeH = $badgeSize.Height + 8',
      `$badgeX = ${Math.round(plan.badge.right)} - $badgeW`,
      `$badgeY = ${Math.round(plan.badge.top)}`,
      '$badgePath = New-Object System.Drawing.Drawing2D.GraphicsPath',
      '$r = 10',
      '$badgePath.AddArc($badgeX, $badgeY, ($r * 2), ($r * 2), 180, 90)',
      '$badgePath.AddArc(($badgeX + $badgeW - $r * 2), $badgeY, ($r * 2), ($r * 2), 270, 90)',
      '$badgePath.AddArc(($badgeX + $badgeW - $r * 2), ($badgeY + $badgeH - $r * 2), ($r * 2), ($r * 2), 0, 90)',
      '$badgePath.AddArc($badgeX, ($badgeY + $badgeH - $r * 2), ($r * 2), ($r * 2), 90, 90)',
      '$badgePath.CloseFigure()',
      '$badgeBrush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(45,255,255,255))',
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

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

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
      child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        windowsHide: true,
        stdio,
      })
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd)
        } catch {
          /* ignore */
        }
      }
      resolve({ ok: false, error: error.message })
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
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      finish({ ok: false, error: `合成脚本超时（${timeoutMs}ms）` })
    }, timeoutMs)
    child.once('error', (error) => finish({ ok: false, error: error.message }))
    child.once('close', (code) => {
      let out = ''
      try {
        out = fs.readFileSync(logPath, 'utf8')
      } catch {
        /* ignore */
      }
      const ok = code === 0 && out.includes('WXMP_COVER_OK')
      finish(ok ? { ok: true } : { ok: false, error: `退出码 ${code}；输出：${out.slice(-300)}` })
    })
  })
}

/**
 * 用底图合成封面。
 * @param {object} options
 * @param {string} options.backgroundPath  底图绝对路径
 * @param {string} options.outPath         输出路径
 * @param {object} [options.plan]          版式（不传就按 title/subtitle/badge 现算）
 * @returns {Promise<{ok, path?, bytes?, error?}>}
 */
export async function composeWithBackground(options = {}) {
  const outPath = path.resolve(options.outPath)
  const bgPath = path.resolve(options.backgroundPath)
  if (!fs.existsSync(bgPath)) return { ok: false, error: `底图不存在：${bgPath}` }
  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  let size = { width: 0, height: 0 }
  try {
    size = readImageSize(bgPath)
  } catch (error) {
    return { ok: false, error: `底图读不出尺寸：${error.message}` }
  }

  if (process.platform !== 'win32') {
    return { ok: false, error: '背景合成依赖 Windows GDI+；当前平台不可用' }
  }

  const workDir = options.workDir || path.join(os.tmpdir(), 'wxmp-cover')
  try {
    fs.mkdirSync(workDir, { recursive: true })
  } catch {
    /* 用临时目录兜底 */
  }
  const stamp = `${process.pid}-${Date.now()}`
  const scriptPath = path.join(workDir, `compose-${stamp}.ps1`)
  const logPath = path.join(workDir, `compose-${stamp}.log`)

  try {
    const plan = options.plan || planCover(options)
    const script = buildCompositeScript({
      ...options,
      plan,
      backgroundPath: bgPath,
      backgroundWidth: size.width,
      backgroundHeight: size.height,
      outPath,
    })
    fs.writeFileSync(scriptPath, `\uFEFF${script}`, 'utf8')
    const result = await runPowerShell(scriptPath, logPath, options.timeoutMs)
    if (!result.ok) return { ok: false, error: result.error }
    const bytes = fs.statSync(outPath).size
    return { ok: true, path: outPath, bytes, backgroundSize: size, plan }
  } catch (error) {
    return { ok: false, error: error.message }
  } finally {
    for (const file of [scriptPath, logPath]) {
      try {
        fs.unlinkSync(file)
      } catch {
        /* ignore */
      }
    }
  }
}
