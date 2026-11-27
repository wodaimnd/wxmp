/**
 * 图片插位 —— 分析正文，给素材库里的图找到语义最合适的位置。
 *
 * ## 用户要的是什么
 * "写文章时有意识地调用素材库的图片，在合适的位置插入"。
 * 关键词是**有意识**和**合适**——不是随机撒图，也不是每节硬塞一张。
 *
 * ## 匹配逻辑（按可信度分三层）
 *   1. **关键词命中**：段落文本里出现图片关键词（如"架构"→架构图）
 *   2. **章节归属**：图片插在它命中的那一节**第一个命中段落的后面**，
 *      而不是随便找个地方
 *   3. **位置约束**：不插在第一段（那是开头，插图会打断钩子），
 *      不插在最后一段（那是收尾），不插在列表/代码块中间
 *
 * ## 什么时候不插
 * - 图片关键词在整篇文章里都找不到 → 不插（宁可少也不要错）
 * - 同一节已经有图 → 不再插（一节塞两张图会散）
 * - 段落太短（< 40 字）→ 不插（图比文字还长很怪）
 * - 接口/列表/代码块 → 不插（会破坏结构）
 *
 * ## 输出
 * 不直接改文章，而是给出**建议列表** + 一份可直接应用的 Markdown 补丁。
 * 改稿是不可逆操作，必须让人看一眼再决定。
 */

import { expandAll } from './image-synonyms.js'

/** 正文里这些块不适合插图。 */
function isUnfitParagraph(text) {
  const value = String(text || '').trim()
  if (!value) return '空段落'
  // 阈值从 40 降到 20：实测很多文章用小段落讲要点，
  // 40 字会让大部分正常段落都被判"太短"，等于功能失效。
  // 20 字以下才是真的碎片句（"就这样。""是的。"），那种旁边配图确实怪。
  if (value.length < 20) return '段落太短，插图会显得突兀'
  if (/^```/.test(value)) return '代码块不能插图'
  if (/^[-*+]\s/m.test(value) && value.split('\n').every((line) => /^[-*+]|^\s*$/.test(line))) return '列表中间不能插图'
  if (/^\|/.test(value)) return '表格不能插图'
  if (/^>/.test(value)) return '引用块内不插图'
  if (/!\[[^\]]*\]\(/.test(value)) return '这里已经是图了'
  if (/^#{1,6}\s/.test(value)) return '标题行不能插图'
  return null
}

/**
 * 关键词的信息量权重。
 *
 * ## 为什么需要这个
 * 实测："工业AI.jpg" 的关键词是 ["工业","ai"]，而 "把公众号写作搬进-AI-工作台-cover.png"
 * 的关键词只有 ["ai"]。如果按命中数量平权，一张讲 AI 的文章里
 * **任何一段提到 "ai" 的都会同时命中这两张**，选哪张全看顺序。
 *
 * 泛词（ai/api/ui）在技术文章里到处都是，命中它几乎等于没命中。
 * 所以给泛词低权重，具体词（架构/工业/红包）高权重。
 */
const GENERIC_TERMS = new Set(['ai', 'api', 'sdk', 'ui', 'ux', 'gpu', 'cpu', 'llm', 'gpt', 'dsh', '代码', '日志'])

export function keywordWeight(keyword) {
  const word = String(keyword || '').toLowerCase()
  if (!word) return 0
  if (GENERIC_TERMS.has(word)) return 1
  // 中文具体词信息量最高
  if (/[\u4e00-\u9fa5]/.test(word)) return 3
  return 2
}

/**
 * 分析文章，给出插图建议。
 *
 * @param {object} article { title, body }
 * @param {object} info collectStructure 的结果（paragraphs / headings）
 * @param {Array} images listLibraryImages 返回的 items
 * @param {object} options
 * @param {number} options.maxImages 最多建议几张（默认 4）
 * @param {boolean} options.allowRepeat 允许同一关键词匹配多张图
 * @returns {{suggestions, skipped, markdownPatch}}
 */
export function planImageInsertions(article, info, images, options = {}) {
  const body = String((article && article.body) || '')
  const maxImages = Number(options.maxImages) > 0 ? Number(options.maxImages) : 4
  const paragraphs = (info && info.paragraphs) || []
  const headings = (info && info.headings) || []

  /**
   * 只看有语义、有 url 的图，并把关键词**扩展到同义词组**。
   *
   * 一张叫「架构图」的图，正文可能写成「模块」「分层」「拓扑」——只要字面不同，
   * 字面匹配就失效。扩展后一张图能覆盖整组说法，这是命中率提升的主要来源。
   *
   * 扩展必须**逐图独立**：用全库并集的话每张图都会命中所有词。
   */
  const usable = (images || [])
    .filter((item) => item.meaningful && item.url && item.keywords.length && !item.coverLike)
    .map((item) => {
      const { terms, groups } = expandAll(item.keywords)
      return { ...item, matchTerms: terms, conceptGroups: groups }
    })
  if (!usable.length) {
    return {
      suggestions: [],
      skipped: [],
      reason: '素材库里没有可参与匹配的图（文件名都没有语义）。去公众号后台给图片改个能看出内容的文件名再来。',
      markdownPatch: '',
    }
  }

  /**
   * 把正文按段落切开，同时记住每段属于哪个小节。
   * 这样匹配到关键词后能知道"这属于哪一节"，避免同一节插两张。
   */
  const segments = splitBySection(body)
  const suggestions = []
  const skipped = []
  const usedImages = new Set()
  const usedSections = new Set()

  for (const image of usable) {
    if (suggestions.length >= maxImages) break
    if (usedImages.has(image.mediaId)) continue

    // 在段落里找命中该图任一关键词的位置
    let best = null
    for (const segment of segments) {
      const reason = isUnfitParagraph(segment.text)

      /**
       * 匹配范围包含**两处**：
       *   1. 段落正文
       *   2. 所属小节标题
       *
       * 之前只看正文，结果「## 插件架构设计」这种标题明明给了强信号，
       * 却因为正文段落没再提「架构」两个字而匹配不到 —— 这是真缺陷。
       * 小节标题是作者亲手提炼的，信息密度比正文高。
       *
       * 标题命中额外加权（×1.5）：一段正文顺口提到某个词，
       * 和作者专门为它起了个小节标题，信号强度完全不同。
       */
      const bodyText = segment.text.toLowerCase()
      const titleText = String(segment.sectionTitle || '').toLowerCase()

      let hits = 0
      const matched = []
      const matchedInTitle = []
      for (const keyword of image.matchTerms) {
        const needle = String(keyword).toLowerCase()
        if (needle.length < 2) continue
        const inBody = bodyText.includes(needle)
        const inTitle = titleText.includes(needle)
        if (!inBody && !inTitle) continue
        // 加权：泛词 1 分，具体中文词 3 分；标题命中再乘 1.5
        const weight = keywordWeight(keyword)
        hits += inTitle ? weight * 1.5 : weight
        matched.push(keyword)
        if (inTitle) matchedInTitle.push(keyword)
      }
      if (hits === 0) continue

      // 命中分数越高越优先；同分时取靠前的（先讲的先配图）
      if (!best || hits > best.hits) {
        best = { segment, hits, matched, matchedInTitle, blockReason: reason }
      }
    }

    if (!best) {
      skipped.push({ image: image.name, reason: `正文里没有出现它的关键词（${image.keywords.join('/')}）` })
      continue
    }
    if (best.blockReason) {
      skipped.push({ image: image.name, reason: `命中了但位置不合适：${best.blockReason}` })
      continue
    }
    if (usedSections.has(best.segment.sectionIndex)) {
      skipped.push({ image: image.name, reason: '这一节已经有图了，一节一张就够' })
      continue
    }

    usedImages.add(image.mediaId)
    usedSections.add(best.segment.sectionIndex)
    suggestions.push({
      image: image.name,
      mediaId: image.mediaId,
      url: image.url,
      keywords: image.keywords,
      hits: best.hits,
      // 插在这一段之后
      afterParagraph: best.segment.index,
      afterText: best.segment.text.slice(0, 40),
      section: best.segment.sectionTitle || '（开篇）',
      reason: buildMatchReason(best),
      markdown: `\n\n![${image.name}](${image.url})`,
    })
  }

  if (!suggestions.length) {
    return {
      suggestions,
      skipped,
      reason: '没有找到合适的插入位置。可能原因：图片关键词在正文里没出现，或命中的段落太短/是列表/已有图。',
      markdownPatch: '',
    }
  }

  return {
    suggestions,
    skipped,
    reason: '',
    markdownPatch: buildPatchMarkdown(suggestions),
  }
}

/**
 * 把匹配结果写成一句人能看懂的原因。
 *
 * 为什么单独一个函数：命中可能发生在**标题**或**正文**，也可能两处都有。
 * 早先只用 `image.keywords.filter(k => 正文.includes(k))`，
 * 标题命中的词不在正文里，于是显示成「这一段提到了「」」——空引号，等于没解释。
 */
function buildMatchReason(best) {
  const inTitle = (best && best.matchedInTitle) || []
  const inBody = ((best && best.matched) || []).filter((word) => !inTitle.includes(word))
  const parts = []
  if (inTitle.length) parts.push(`标题提到了「${inTitle.join('、')}」`)
  if (inBody.length) parts.push(`${inTitle.length ? '正文' : '这一段'}提到了「${inBody.join('、')}」`)
  return parts.length ? parts.join('，') : '按同义词匹配到相关内容'
}

/**
 * 把正文切成「段落 + 所属小节」。
 * 段落用空行分隔（Markdown 的规矩），同时跟踪当前所处的 H2 标题。
 */
export function splitBySection(body) {
  const lines = String(body || '').split('\n')
  const segments = []
  let buffer = []
  let sectionIndex = 0
  let sectionTitle = ''
  let paraIndex = 0

  const flush = () => {
    const text = buffer.join('\n').trim()
    if (text) {
      segments.push({
        index: paraIndex,
        text,
        sectionIndex,
        sectionTitle,
      })
      paraIndex += 1
    }
    buffer = []
  }

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line)
    if (headingMatch) {
      flush()
      sectionIndex += 1
      sectionTitle = headingMatch[2].trim()
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    buffer.push(line)
  }
  flush()
  return segments
}

/** 把建议整理成一份人类可读的补丁清单。 */
export function buildPatchMarkdown(suggestions) {
  const lines = ['# 插图建议', '']
  for (const item of suggestions) {
    lines.push(`## 在「${item.section}」的第 ${item.afterParagraph + 1} 段之后插入`)
    lines.push('')
    lines.push(`- 图片：${item.image}`)
    lines.push(`- 原因：${item.reason}`)
    lines.push(`- 这段开头：${item.afterText}…`)
    lines.push('')
    lines.push('```markdown')
    lines.push(item.markdown.trim())
    lines.push('```')
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * 把建议真正应用到正文，返回新正文。
 *
 * 从后往前插，避免前面的插入让后面的下标偏移——这是最容易写错的地方。
 */
export function applyInsertions(body, suggestions) {
  const segments = splitBySection(body)
  const paragraphs = segments.map((item) => item.text)

  // 按段落下标分组，一个段落只插一张（多了会连成一串图）
  const byParagraph = new Map()
  for (const item of suggestions) {
    if (!byParagraph.has(item.afterParagraph)) {
      byParagraph.set(item.afterParagraph, item)
    }
  }

  // 从大下标往小处理，保证前面的位置不受影响
  const indexes = [...byParagraph.keys()].sort((a, b) => b - a)
  let output = String(body || '')
  for (const idx of indexes) {
    const target = paragraphs[idx]
    if (!target) continue
    const item = byParagraph.get(idx)
    // 定位这一段在原文里的位置，在它结束后插入
    const at = output.indexOf(target)
    if (at < 0) continue
    const insertPos = at + target.length
    output = output.slice(0, insertPos) + item.markdown + output.slice(insertPos)
  }
  return output
}
