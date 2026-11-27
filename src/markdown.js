/**
 * Markdown → 微信公众号正文 HTML。
 *
 * 为什么必须自己渲染：微信正文会剥掉 <script>、<style>、class 选择器和外部 CSS，
 * 只有**内联 style** 才生效；同时它还会过滤非 mmbiz 域名的图片。
 * 所以这里做三件事：
 *   1. 把 Markdown 解析成轻量 AST（不发网络请求、不依赖第三方库）；
 *   2. 用一套「行内样式主题」把 AST 渲染成微信能吃的 HTML；
 *   3. 记录正文里出现的图片，交给上层上传后回填真实 URL。
 */

/* ------------------------------------------------------------------ */
/* 1. 解析                                                             */
/* ------------------------------------------------------------------ */

/**
 * 解析 Markdown 为节点数组。
 * 支持的语法：标题(1-6)、段落、粗体、斜体、删除线、行内代码、链接、图片、
 * 无序/有序列表（含缩进嵌套）、引用、分割线、代码块、表格。
 */
export function parseMarkdown(source) {
  const text = String(source ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
  const lines = text.split('\n')
  const nodes = []
  let i = 0

  const isBlank = (line) => !line.trim()

  while (i < lines.length) {
    const line = lines[i]

    if (isBlank(line)) {
      i += 1
      continue
    }

    // 代码块
    const fence = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/.exec(line)
    if (fence) {
      const marker = fence[1][0]
      const lang = fence[2] || ''
      const body = []
      i += 1
      while (i < lines.length && !new RegExp(`^ {0,3}${marker}{3,}\\s*$`).test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      i += 1
      nodes.push({ type: 'code', lang, value: body.join('\n') })
      continue
    }

    // 图片独占一行（常见于「题图」写法）
    const soloImage = /^ {0,3}!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*$/.exec(line)
    if (soloImage) {
      nodes.push({ type: 'image', alt: soloImage[1], src: soloImage[2], title: soloImage[3] || '' })
      i += 1
      continue
    }

    // 标题
    const heading = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      nodes.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2].trim()) })
      i += 1
      continue
    }

    // 分割线
    if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      nodes.push({ type: 'hr' })
      i += 1
      continue
    }

    // 表格：表头 + 分隔行
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const header = splitTableRow(line)
      i += 2
      const rows = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]))
        i += 1
      }
      nodes.push({ type: 'table', header, rows })
      continue
    }

    // 引用
    if (/^ {0,3}>/.test(line)) {
      const collected = []
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        collected.push(lines[i].replace(/^ {0,3}>\s?/, ''))
        i += 1
      }
      nodes.push({ type: 'quote', children: parseMarkdown(collected.join('\n')) })
      continue
    }

    // 列表
    const listMatch = /^ {0,3}([-*+]|\d+[.)])\s+/.exec(line)
    if (listMatch) {
      const ordered = /\d/.test(listMatch[1])
      const items = []
      let start = ordered ? Number.parseInt(listMatch[1], 10) : 1
      while (i < lines.length) {
        const match = /^( {0,3})([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
        if (!match) break
        if (/\d/.test(match[2]) !== ordered) break
        const indent = match[1].length
        if (indent > 3) break
        const itemLines = [match[3]]
        i += 1
        // 续行：缩进 ≥ 2 空格且不是新的列表项
        while (i < lines.length) {
          const next = lines[i]
          if (!next.trim()) break
          if (/^ {0,3}([-*+]|\d+[.)])\s+/.test(next)) break
          if (/^ {2,}/.test(next)) {
            itemLines.push(next.replace(/^ {2,}/, ''))
            i += 1
            continue
          }
          break
        }
        items.push(parseMarkdown(itemLines.join('\n')))
      }
      nodes.push({ type: 'list', ordered, start, items })
      continue
    }

    // 段落：吃到空行 / 块级语法起点为止
    const paragraph = []
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) {
      paragraph.push(lines[i])
      i += 1
    }
    if (!paragraph.length) {
      // 防御：无法识别的一行当作普通段落，避免死循环
      paragraph.push(lines[i])
      i += 1
    }
    nodes.push({ type: 'paragraph', children: parseInline(paragraph.join('\n').trim()) })
  }

  return nodes
}

function startsBlock(line) {
  return (
    /^ {0,3}(`{3,}|~{3,})/.test(line) ||
    /^ {0,3}#{1,6}\s/.test(line) ||
    /^ {0,3}>/.test(line) ||
    /^ {0,3}([-*+]|\d+[.)])\s+/.test(line) ||
    /^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)
  )
}

function splitTableRow(line) {
  return String(line)
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/* ------------------------------------------------------------------ */
/* 行内解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 行内元素解析：粗体、斜体、删除线、行内代码、链接、图片。
 * 采用「先切行内代码（避免里面的 ** 被解析）」的两段式策略。
 */
export function parseInline(source) {
  const text = String(source ?? '')
  const nodes = []
  let buffer = ''

  const flush = () => {
    if (buffer) {
      nodes.push({ type: 'text', value: buffer })
      buffer = ''
    }
  }

  let i = 0
  while (i < text.length) {
    // 转义
    if (text[i] === '\\' && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!>~|]/.test(text[i + 1])) {
      buffer += text[i + 1]
      i += 2
      continue
    }

    // 行内代码
    if (text[i] === '`') {
      const run = /^`+/.exec(text.slice(i))[0]
      const end = text.indexOf(run, i + run.length)
      if (end > 0) {
        flush()
        nodes.push({ type: 'code', value: text.slice(i + run.length, end) })
        i = end + run.length
        continue
      }
    }

    // 图片 ![alt](src "title")
    if (text[i] === '!' && text[i + 1] === '[') {
      const match = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/.exec(text.slice(i))
      if (match) {
        flush()
        nodes.push({ type: 'image', alt: match[1], src: match[2], title: match[3] || '' })
        i += match[0].length
        continue
      }
    }

    // 链接 [text](url "title")
    if (text[i] === '[') {
      const match = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/.exec(text.slice(i))
      if (match) {
        flush()
        nodes.push({
          type: 'link',
          href: match[2],
          title: match[3] || '',
          children: parseInline(match[1]),
        })
        i += match[0].length
        continue
      }
    }

    // 粗体 / 斜体 / 删除线
    if (text.startsWith('***', i) || text.startsWith('___', i)) {
      const marker = text.slice(i, i + 3)
      const end = text.indexOf(marker, i + 3)
      if (end > 0) {
        flush()
        nodes.push({ type: 'strong', children: [{ type: 'italic', children: parseInline(text.slice(i + 3, end)) }] })
        i = end + 3
        continue
      }
    }
    if (text.startsWith('**', i) || text.startsWith('__', i)) {
      const marker = text.slice(i, i + 2)
      const end = text.indexOf(marker, i + 2)
      if (end > 0) {
        flush()
        nodes.push({ type: 'strong', children: parseInline(text.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }
    if (text.startsWith('~~', i)) {
      const end = text.indexOf('~~', i + 2)
      if (end > 0) {
        flush()
        nodes.push({ type: 'strike', children: parseInline(text.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }
    if (text[i] === '*' || text[i] === '_') {
      const marker = text[i]
      const end = text.indexOf(marker, i + 1)
      if (end > i + 1 && !/\s/.test(text[i + 1])) {
        flush()
        nodes.push({ type: 'italic', children: parseInline(text.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }

    buffer += text[i]
    i += 1
  }

  flush()
  return nodes
}

/* ------------------------------------------------------------------ */
/* 2. 渲染                                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_THEME = 'default'

export const THEMES = {
  /** 默认：微信编辑器默认观感，正文 15px/1.75，主色 #07C160 家族。 */
  default: {
    accent: '#07c160',
    accentDark: '#059b4c',
    text: '#3f3f3f',
    heading: '#1a1a1a',
    muted: '#8a8a8a',
    rule: '#e6e6e6',
    blockquoteBg: '#f7f7f7',
    blockquoteBorder: '#07c160',
    codeBg: '#f6f8fa',
    codeBorder: '#eaecef',
    fontFamily:
      "-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue','Hiragino Sans GB','Microsoft YaHei',sans-serif",
    fontSize: 15,
    lineHeight: 1.75,
    letterSpacing: 0.4,
  },
  /** 深色科技感：适合技术类文章。 */
  dark: {
    accent: '#3ea6ff',
    accentDark: '#1d7fd1',
    text: '#3a3a3a',
    heading: '#111',
    muted: '#999',
    rule: '#e8e8e8',
    blockquoteBg: '#f2f7ff',
    blockquoteBorder: '#3ea6ff',
    codeBg: '#0f1720',
    codeBorder: '#0f1720',
    codeColor: '#e6edf3',
    fontFamily:
      "-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue','Microsoft YaHei',sans-serif",
    fontSize: 15,
    lineHeight: 1.75,
    letterSpacing: 0.4,
  },
  /** 杂志感：大标题、宽留白。 */
  magazine: {
    accent: '#c0392b',
    accentDark: '#96271c',
    text: '#2e2e2e',
    heading: '#111',
    muted: '#9a9a9a',
    rule: '#ebebeb',
    blockquoteBg: '#fdf6f5',
    blockquoteBorder: '#c0392b',
    codeBg: '#f7f7f7',
    codeBorder: '#ececec',
    fontFamily: "'Georgia','Songti SC','SimSun',serif",
    fontSize: 16,
    lineHeight: 1.85,
    letterSpacing: 0.2,
  },
}

export function themeByName(name) {
  return THEMES[String(name || DEFAULT_THEME)] || THEMES[DEFAULT_THEME]
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 渲染成微信可用的 HTML（全内联样式）。
 *
 * @param {object[]} nodes parseMarkdown 的结果
 * @param {{theme?: string, images?: Map<string,string>, keepRemoteImages?: boolean}} options
 *   images：原始 src → 已上传后的 mmbiz URL（缺省时保留原 src，微信会过滤掉外链）
 * @returns {{html: string, images: string[]}} images 是正文引用到的原始 src 列表
 */
export function renderHtml(nodes, options = {}) {
  const theme = themeByName(options.theme)
  const images = []
  const imageMap = options.images instanceof Map ? options.images : new Map(Object.entries(options.images || {}))

  // 微信正文限制 2 万字符，如果每个标签都重复 font-family/font-size/line-height/color，
  // 一篇正常长度的文章就会超限。CSS 是继承的 —— 把这些“基础样式”只放在最外层
  // section 上设置一次，子元素只写差异（字号、颜色、对齐），字符数能省一半以上。
  const containerStyle =
    `font-family:${theme.fontFamily};font-size:${theme.fontSize}px;` +
    `line-height:${theme.lineHeight};letter-spacing:${theme.letterSpacing}px;` +
    `color:${theme.text};word-break:break-word;`

  /** 子元素只写差异样式；传入的 extra 就是全部。 */
  const base = (extra = '') => extra

  const renderInline = (children) =>
    (children || [])
      .map((node) => {
        switch (node.type) {
          case 'text':
            return escapeHtml(node.value).replace(/\n/g, '<br/>')
          case 'strong':
            return `<strong style="${base('font-weight:bold;')}">${renderInline(node.children)}</strong>`
          case 'italic':
            return `<em style="${base('font-style:italic;')}">${renderInline(node.children)}</em>`
          case 'strike':
            return `<span style="${base('text-decoration:line-through;')}">${renderInline(node.children)}</span>`
          case 'code':
            return (
              `<code style="background:${theme.codeBg};border:1px solid ${theme.codeBorder};border-radius:3px;` +
              `padding:1px 5px;margin:0 2px;font-size:0.9em;color:${theme.accentDark};` +
              `font-family:Consolas,Monaco,Menlo,monospace;">${escapeHtml(node.value)}</code>`
            )
          case 'link':
            return (
              `<a href="${escapeHtml(node.href)}" style="${base(`color:${theme.accentDark};text-decoration:none;` +
              `border-bottom:1px solid ${theme.accentDark};`)}">${renderInline(node.children)}</a>`
            )
          case 'image': {
            images.push(node.src)
            const src = imageMap.get(node.src) || node.src
            return (
              `<img src="${escapeHtml(src)}" alt="${escapeHtml(node.alt)}" ` +
              `style="max-width:100%;height:auto;display:block;margin:16px auto;border-radius:4px;" />`
            )
          }
          default:
            return ''
        }
      })
      .join('')

  const renderNodes = (list, ctx = {}) =>
    list
      .map((node) => {
        switch (node.type) {
          case 'heading': {
            const sizes = { 1: 22, 2: 19, 3: 17, 4: 16, 5: 15, 6: 15 }
            const size = sizes[node.level] || 16
            const extra =
              node.level <= 2
                ? `border-left:4px solid ${theme.accent};padding-left:10px;`
                : node.level === 3
                  ? `color:${theme.accentDark};`
                  : ''
            return (
              `<h${node.level} style="${base(
                `font-size:${size}px;font-weight:bold;color:${theme.heading};` +
                  `margin:26px 0 14px;line-height:1.5;${extra}`,
              )}">${renderInline(node.children)}</h${node.level}>`
            )
          }
          case 'paragraph':
            return `<p style="${base('margin:0 0 16px;text-align:justify;')}">${renderInline(node.children)}</p>`
          case 'hr':
            return `<div style="border-top:1px solid ${theme.rule};margin:26px 0;height:0;font-size:0;line-height:0;">&nbsp;</div>`
          case 'code':
            return (
              `<pre style="background:${theme.codeBg};border:1px solid ${theme.codeBorder};border-radius:6px;` +
              `padding:14px 16px;margin:0 0 18px;overflow-x:auto;font-size:13px;line-height:1.6;` +
              `font-family:Consolas,Monaco,Menlo,monospace;color:${theme.codeColor || '#333'};` +
              `white-space:pre-wrap;word-break:break-all;"><code style="font-family:inherit;` +
              `color:inherit;background:none;padding:0;border:none;">${escapeHtml(node.value)}</code></pre>`
            )
          case 'quote':
            return (
              `<div style="background:${theme.blockquoteBg};border-left:3px solid ${theme.blockquoteBorder};` +
              `padding:12px 16px;margin:0 0 18px;color:${theme.text};font-size:14px;line-height:1.7;">` +
              `${renderNodes(node.children, { inQuote: true })}</div>`
            )
          case 'list': {
            const tag = node.ordered ? 'ol' : 'ul'
            const startAttr = node.ordered && node.start !== 1 ? ` start="${node.start}"` : ''
            const items = node.items
              .map(
                (item) =>
                  `<li style="${base('margin:0 0 8px;padding-left:2px;')}">${renderNodes(item, {
                    inList: true,
                  })}</li>`,
              )
              .join('')
            return `<${tag} style="margin:0 0 18px;padding-left:22px;${node.ordered ? '' : 'list-style-type:disc;'}">${items}</${tag}>`
          }
          case 'table': {
            const cell = (text, tag, index) => {
              const isHeader = tag === 'th'
              return (
                `<${tag} style="${base(
                  `padding:8px 10px;border:1px solid ${theme.rule};font-size:13px;` +
                    (isHeader
                      ? `background:${theme.blockquoteBg};font-weight:bold;color:${theme.heading};`
                      : '') +
                    (index === 0 ? 'font-weight:bold;' : ''),
                )}">${renderInline(parseInline(text))}</${tag}>`
              )
            }
            const head = `<tr>${node.header.map((text, index) => cell(text, 'th', index)).join('')}</tr>`
            const body = node.rows
              .map((row) => `<tr>${row.map((text, index) => cell(text, 'td', index)).join('')}</tr>`)
              .join('')
            return (
              `<table style="border-collapse:collapse;width:100%;margin:0 0 18px;font-size:13px;` +
              `table-layout:auto;word-break:break-all;"><tbody>${head}${body}</tbody></table>`
            )
          }
          case 'image': {
            images.push(node.src)
            const src = imageMap.get(node.src) || node.src
            return (
              `<p style="margin:0 0 18px;text-align:center;"><img src="${escapeHtml(src)}" ` +
              `alt="${escapeHtml(node.alt)}" style="max-width:100%;height:auto;display:block;margin:0 auto;` +
              `border-radius:4px;" /></p>`
            )
          }
          case 'text':
            return `<p style="${base('margin:0 0 16px;')}">${escapeHtml(node.value)}</p>`
          default:
            return ''
        }
      })
      .join('')

  const html = renderNodes(nodes)
  // 包一层 section 承载基础样式，子元素靠继承拿到字体与行高。
  const wrapped = html ? `<section style="${containerStyle}">${html}</section>` : ''
  return { html: wrapped, images }
}

/* ------------------------------------------------------------------ */
/* 3. 纯文本与大纲                                                     */
/* ------------------------------------------------------------------ */

/** 提取纯文本（用于自动摘要与字数统计）。 */
export function plainText(nodes) {
  const walkInline = (children) =>
    (children || [])
      .map((node) => {
        if (node.type === 'text' || node.type === 'code') return node.value
        if (node.type === 'image') return ''
        if (node.children) return walkInline(node.children)
        return ''
      })
      .join('')

  const walk = (list) =>
    list
      .map((node) => {
        if (node.type === 'heading' || node.type === 'paragraph') return walkInline(node.children)
        if (node.type === 'code') return node.value
        if (node.type === 'quote' || node.type === 'list') {
          const inner = node.type === 'list' ? node.items.flat() : node.children
          return walk(inner)
        }
        if (node.type === 'table') return [node.header, ...node.rows].flat().join(' ')
        return ''
      })
      .filter(Boolean)
      .join('\n')

  return walk(nodes).replace(/\s+/g, ' ').trim()
}

/** 生成摘要：取正文前 N 个字，尽量在句号处断开；结果保证不超过 N（含省略号）。 */
export function makeDigest(nodes, limit = 120) {
  const text = plainText(nodes)
  if (text.length <= limit) return text
  // 省略号也占 1 个字符，正文只能取 limit-1，否则自动摘要会自己超限。
  const slice = text.slice(0, limit - 1)
  const lastStop = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('！'), slice.lastIndexOf('？'))
  if (lastStop >= (limit - 1) * 0.6) return slice.slice(0, lastStop + 1)
  return `${slice}…`
}

/** 文章大纲：标题层级 + 文字，给 Agent 复核结构用。 */
export function outline(nodes) {
  const rows = []
  const walk = (list, depth = 0) => {
    for (const node of list) {
      if (node.type === 'heading') {
        rows.push({ level: node.level, text: plainText([{ type: 'paragraph', children: node.children }]) })
      } else if (node.type === 'list') {
        walk(node.items.flat(), depth + 1)
      } else if (node.type === 'quote') {
        walk(node.children, depth + 1)
      }
    }
  }
  walk(nodes)
  return rows
}

/** 统计：字数、图片数、是否超限。 */
export function stats(nodes, html) {
  const text = plainText(nodes)
  return {
    words: text.length,
    images: html ? (html.match(/<img /g) || []).length : 0,
    headings: outline(nodes).length,
    htmlChars: html ? html.length : 0,
  }
}
