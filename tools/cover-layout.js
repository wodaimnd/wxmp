/**
 * 封面版式计算：把「标题怎么断行、字号多大」从绘图脚本里拆出来。
 *
 * 为什么必须拆出来：
 *  原先字号是 `Math.floor(width/18)` 的粗算（900px → 50pt），加上 `WordEllipsis`
 *  交给 GDI 硬折行，实测把「…AI 工作台：一个插件的取舍」折成
 *  「把公众号写作搬进 AI 工作 / 台：一个插件的取舍」——
 *  **折在「工作|台」中间**，读起来是断的，而且占了 76% 的高度，视觉上压得慌。
 *
 *  这里改成：先量宽（CJK 按全角、西文按半角估算），再按「平衡断行」把标题拆成
 *  行数最少、各行长度最接近的若干行，最后按可用高度反推字号。
 *  纯函数 → 可单测，不用起 PowerShell 就能验证版式。
 */

import fs from 'node:fs'
import zlib from 'node:zlib'

/**
 * **推荐**封面尺寸：微信大图封面就是 2.35:1，900×383 是它的标准档。
 *
 * 2026-11-09 起这不再是"不可修改"的硬规格 —— 用户可以在面板里强制改。
 * 默认值不变，改过的尺寸由 normalizeCoverSize 收敛后一路传下来。
 */
export const COVER_SIZE = { width: 900, height: 383 }

/** 微信推荐比例（大图封面）。非这个比例，公众号后台会再裁一次。 */
export const WECHAT_COVER_RATIO = COVER_SIZE.width / COVER_SIZE.height

/**
 * 自定义尺寸的允许范围。
 *
 * 下限不是随便定的：GDI 那一侧最小字号 30pt、最多 2 行标题，再加副标题与上下留白，
 * 低于 320×140 就会出现标题溢出画布（实测过 320×120 直接压到边线外）。
 * 上限到 4096 就够了 —— 公众号后台会把图压回 900 宽，再大只是白等上传。
 */
export const COVER_SIZE_LIMITS = {
  minWidth: 320,
  minHeight: 140,
  maxWidth: 4096,
  maxHeight: 4096,
}

/** `900×383 像素（2.35:1）` —— 界面与 CLI 共用同一段文案，避免两处写法漂移。 */
export function formatCoverSize(size) {
  const width = (size && size.width) || COVER_SIZE.width
  const height = (size && size.height) || COVER_SIZE.height
  return `${width}×${height} 像素（${(width / height).toFixed(2)}:1）`
}

/**
 * 把「用户随手填的两个数字」收敛成能用的尺寸。
 *
 * 三种情况分得很清楚，因为界面文案完全不同：
 *   - 没填 / 填了非数字 → 用推荐值，`requested:false`
 *   - 填了但越界       → 夹到边界，`clamped:true`（必须让用户看见被夹了）
 *   - 比例偏离推荐     → 不拦，只给 `ratioWarn`，由界面做二次确认
 *
 * 刻意**不**因为比例不对就拒绝：用户明确要"可以强行更改"，
 * 拦下来等于把"可改"变成"改不了"。风险交给二次确认说清楚。
 */
export function normalizeCoverSize(input = {}) {
  const rawWidth = Number(input.width)
  const rawHeight = Number(input.height)
  const usable =
    Number.isFinite(rawWidth) && rawWidth > 0 && Number.isFinite(rawHeight) && rawHeight > 0

  if (!usable) {
    return {
      width: COVER_SIZE.width,
      height: COVER_SIZE.height,
      requested: false,
      clamped: false,
      isDefault: true,
      ratioWarn: '',
    }
  }

  const width = Math.round(Math.min(Math.max(rawWidth, COVER_SIZE_LIMITS.minWidth), COVER_SIZE_LIMITS.maxWidth))
  const height = Math.round(Math.min(Math.max(rawHeight, COVER_SIZE_LIMITS.minHeight), COVER_SIZE_LIMITS.maxHeight))
  const ratio = width / height
  const drift = Math.abs(ratio - WECHAT_COVER_RATIO) / WECHAT_COVER_RATIO

  return {
    width,
    height,
    requested: true,
    clamped: width !== Math.round(rawWidth) || height !== Math.round(rawHeight),
    isDefault: width === COVER_SIZE.width && height === COVER_SIZE.height,
    // 2% 以内不算偏离：900×384 这种手抖不该天天弹警告
    ratioWarn:
      drift > 0.02
        ? `比例 ${ratio.toFixed(2)}:1 不等于微信推荐的 ${WECHAT_COVER_RATIO.toFixed(2)}:1，公众号会按推荐比例再裁一次`
        : '',
  }
}

/** 封面底色：不用主题的亮 accent 直接铺满（900×383 上纯 #07c160 太刺眼，
 *  白字对比度也低）。改成「深墨 -> 中调」的斜向渐变，文字区更沉，右上留亮。
 *  数值是相对主题 accent 的混色比例，换主题时会跟着变。 */
export const COVER_TONE = {
  /** 左上角：accent 混掉 62% 黑，得到深墨绿背景（白字对比度足够） */
  darkMix: 0.62,
  /** 右下角：accent 基本保持原色，形成亮的落点 */
  lightMix: 0.06,
  /** 透光斑中心透明度 */
  glowAlpha: 40,
}

/** 把颜色按比例向 target 混色（默认混黑），返回 [r,g,b]。 */
export function mixColor(hex, mix, target = [0, 0, 0]) {
  const value = String(hex).replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  const rgb = [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ]
  return rgb.map((channel, i) => Math.round(channel * (1 - mix) + target[i] * mix))
}

/** 版式参数：改封面观感只需要动这一处。 */
export const LAYOUT = {
  padX: 68, // 左右留白（900 宽的 7.5%）
  padTop: 58,
  padBottom: 52,
  titleMaxLines: 2, // 超过 2 行就该缩字号，而不是继续堆行
  titleMinSize: 30,
  titleMaxSize: 46,
  /** 行距 = 字号 × 该倍数（中文行距 1.28 比较舒服） */
  lineHeightRatio: 1.3,
  subSize: 16,
  badgeSize: 13,
  /** 标题与副标题之间至少留这么多，不然会粘在一起 */
  gapMin: 26,
}

/** 字符宽度估算（单位：字号为 1 时的像素当量）。
 *
 *  关键：CJK 字形实际宽度约等于字号，但雅黑 Bold 有轻微侧承，且 GDI 绘制时
 *  会有亚像素扩散，所以按 1.02 估，宁可略微保守也不要溢出。
 */
export function charWidth(ch) {
  const code = ch.codePointAt(0) || 0
  if (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x3400 && code <= 0x4dbf)
  ) {
    return 1.02
  }
  if (ch === ' ') return 0.32
  if (/[iIlj1]/.test(ch)) return 0.3
  if (/[A-Z0-9]/.test(ch)) return 0.66
  return 0.58
}

/** 一段文字的宽度（以「字号为 1 的中文字宽」为单位）。 */
export function measure(text, fontSize = 1) {
  let units = 0
  for (const ch of String(text || '')) units += charWidth(ch)
  return units * fontSize
}

/**
 * 平衡断行：把文本拆成 lines 行，让各行宽度尽量接近，且尽量在标点/空格处断开。
 *
 * 不是为了「塞进一行」，而是为了**避免把词拆开**：
 * 「工作台」被拆成「工作 / 台」是最刺眼的排版事故，所以断点优先级里
 * 冒号、空格、破折号高于「任意字之间」。
 */
export function wrapBalanced(text, maxUnits, maxLines = LAYOUT.titleMaxLines) {
  const raw = String(text || '').trim()
  if (!raw) return []
  const chars = [...raw]

  // 候选断点打分：越高越"该在这儿断"
  const breakScore = (index) => {
    const prev = chars[index - 1] || ''
    const next = chars[index] || ''
    if (/[：:，,。.!！?？、]/.test(prev)) return 3 // 标点后断开最自然
    if (prev === ' ' || next === ' ') return 2
    if (/[—\-·]/.test(prev)) return 2
    return 0
  }

  // 先按 maxUnits 粗暴切，得到至少要几行
  const totalUnits = measure(raw)
  const minLines = Math.max(1, Math.ceil(totalUnits / maxUnits))
  const lines = Math.min(Math.max(minLines, 1), maxLines)
  if (lines <= 1) return [raw]

  // 目标每行宽度
  const target = totalUnits / lines
  const result = []
  let cursor = 0
  for (let lineIndex = 0; lineIndex < lines; lineIndex += 1) {
    const isLast = lineIndex === lines - 1
    if (isLast) {
      result.push(chars.slice(cursor).join('').trim())
      break
    }
    // 从 cursor 开始累加，找到最接近 target 的位置
    const remainingLines = lines - lineIndex
    const remainingUnits = measure(chars.slice(cursor).join(''))
    const lineTarget = remainingUnits / remainingLines
    let units = 0
    let cut = cursor
    let bestCut = -1
    let bestScore = -1
    for (let i = cursor; i < chars.length; i += 1) {
      if (units >= lineTarget) {
        // 在 ±4 个字符范围内找最佳断点，优先标点/空格
        const lo = Math.max(cursor + 1, i - 4)
        const hi = Math.min(chars.length - 1, i + 4)
        for (let j = lo; j <= hi; j += 1) {
          const widthHere = measure(chars.slice(cursor, j).join(''))
          const score = breakScore(j) * 10 - Math.abs(widthHere - lineTarget)
          if (score > bestScore) {
            bestScore = score
            bestCut = j
          }
        }
        cut = bestCut > 0 ? bestCut : i
        break
      }
      units += charWidth(chars[i])
    }
    if (cut <= cursor) cut = Math.min(chars.length, cursor + 1)
    result.push(chars.slice(cursor, cut).join('').trim())
    cursor = cut
  }
  // 保证最后一行非空
  if (!result[result.length - 1]) {
    result.pop()
    if (result.length) result[result.length - 1] += chars.slice(cursor).join('')
  }
  return result.filter(Boolean)
}

/**
 * 计算整张封面的版式：标题行、字号、各行基线、副标题与角标位置。
 * @param {{title:string, subtitle?:string, badge?:string, width?:number, height?:number}} input
 */
export function planCover(input = {}) {
  const width = input.width || COVER_SIZE.width
  const height = input.height || COVER_SIZE.height
  const padX = Math.round(width * (LAYOUT.padX / COVER_SIZE.width))
  const usableWidth = width - padX * 2

  const title = String(input.title || '').trim()
  // 可用高度 = 总高 - 上留白 - 下留白 - 副标题高度 - 与副标题的间距
  const subBlock = input.subtitle ? LAYOUT.subSize + LAYOUT.gapMin : 0
  const usableHeight = height - LAYOUT.padTop - LAYOUT.padBottom - subBlock

  // 从大往小试字号，选第一个能在 maxLines 内排下的
  let size = LAYOUT.titleMaxSize
  let lines = []
  for (; size >= LAYOUT.titleMinSize; size -= 1) {
    const maxUnits = usableWidth / size
    lines = wrapBalanced(title, maxUnits, LAYOUT.titleMaxLines)
    const lineHeight = size * LAYOUT.lineHeightRatio
    const fitsHeight = lines.length * lineHeight <= usableHeight
    const fitsWidth = lines.every((line) => measure(line, size) <= usableWidth)
    if (fitsHeight && fitsWidth && lines.length <= LAYOUT.titleMaxLines) break
  }
  // 兜底：最小字号还排不下就允许 3 行（宁可多一行也不缩成看不清）
  if (size < LAYOUT.titleMinSize) {
    size = LAYOUT.titleMinSize
    lines = wrapBalanced(title, usableWidth / size, 3)
  }

  const lineHeight = Math.round(size * LAYOUT.lineHeightRatio)
  const blockHeight = lines.length * lineHeight
  // 标题块与副标题整体垂直居中，而不是贴着顶部（原先 0.16 起手太空）
  const contentHeight = blockHeight + subBlock
  const titleTop = Math.round(Math.max(LAYOUT.padTop, (height - contentHeight) / 2))

  const placements = lines.map((text, index) => ({
    text,
    x: padX,
    y: titleTop + index * lineHeight,
    width: measure(text, size),
  }))

  return {
    width,
    height,
    padX,
    size,
    lineHeight,
    lines,
    placements,
    titleTop,
    blockHeight,
    subtitle: input.subtitle
      ? {
          text: String(input.subtitle),
          x: padX,
          y: titleTop + blockHeight + LAYOUT.gapMin,
          size: LAYOUT.subSize,
        }
      : null,
    badge: input.badge
      ? {
          text: String(input.badge),
          size: LAYOUT.badgeSize,
          // 注意：这里给的是**右边界**坐标，绘制侧自己减宽度（别再减一次，会跑到画布外）。
          right: width - padX,
          top: Math.round(LAYOUT.padTop * 0.62),
        }
      : null,
    /** 装饰线的位置：副标题下方，作为视觉落点 */
    rule: input.subtitle
      ? { x: padX, y: titleTop + blockHeight + LAYOUT.gapMin + LAYOUT.subSize + 18, width: 64 }
      : { x: padX, y: titleTop + blockHeight + 20, width: 64 },
  }
}

/** 把版式结果序列化成 JSON，供 PowerShell 侧读取（避免两边算法漂移）。 */
export function planToJson(plan) {
  return JSON.stringify(plan)
}
