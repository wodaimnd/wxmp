/**
 * 公众号文章提取 —— 从 mp.weixin.qq.com 链接抓取标题/作者/正文。
 *
 * ## 来源
 *   - 包：wechat-article-extractor（本机 skill，MIT）
 *   - 文件：`~/.dsh/skills/wechat-article-extractor/scripts/extract.js`（574 行）
 *   - 改动幅度：**重写**。原实现依赖 5 个 npm 包，全部替换为 Node 内置能力：
 *
 *     | 原依赖            | 用了几次 | 现在用什么 |
 *     |------------------|---------|-----------|
 *     | request-promise  | 1       | fetch（Node 18+ 内置） |
 *     | cheerio          | 1       | 正则（公众号 HTML 结构稳定，见下） |
 *     | dayjs            | 3       | 手写 formatDate |
 *     | qs               | 1       | URLSearchParams |
 *     | lodash.unescape  | 1       | decodeEntities |
 *
 *   - 保留：错误码体系（2001 链接无效 / 2002 过期 / 2008 系统出错 / 2012 屏蔽 …）、
 *           `var msg_link =` 这类 JS 变量的提取策略、多文章类型识别
 *   - 放弃：图片列表、视频、语音等非正文类型的完整支持（只处理图文，其余明确报错）
 *
 * ## 为什么能用正则替代 cheerio
 * 原实现里 cheerio 的用法全是 `$('#id').text()` / `$('.cls').html()` 这种**定点提取**，
 * 而公众号页面的容器 id（`js_content`、`activity-name`、`profile_nickname`）
 * 多年未变。真正的主力其实是页面里的 `var msg_title = ...` 等 JS 变量，
 * 原实现也是优先用它们、cheerio 只做兜底。
 */

/* ── 错误码：与原 skill 保持一致，便于对照它的文档 ────────────── */
export const EXTRACT_ERRORS = {
  2001: '链接无效：请确认是 mp.weixin.qq.com/s/... 形式的文章链接',
  2002: '链接已过期或被删除',
  2003: '抓取失败：网络异常',
  2008: '微信系统出错，稍后重试',
  2012: '该账号已被屏蔽',
  2013: '该账号已自主注销',
  2014: '该内容已被辟谣',
  2015: '该账号处于迁移流程中',
  2016: '访问过于频繁，稍后重试',
  2017: '需要验证（该文章有访问限制）',
  2018: '页面里找不到正文容器（可能是非图文类型）',
}

export class ExtractError extends Error {
  constructor(code, detail) {
    const message = EXTRACT_ERRORS[code] || `未知错误 ${code}`
    super(detail ? `${message}（${detail}）` : message)
    this.name = 'ExtractError'
    this.code = code
  }
}

/* ── 工具：全部用内置能力实现 ─────────────────────────────────── */

/** HTML 实体解码。只处理公众号正文会出现的那些。 */
export function decodeEntities(text) {
  if (!text) return ''
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ldquo: '“',
    rdquo: '”',
    lsquo: '‘',
    rsquo: '’',
    mdash: '—',
    ndash: '–',
    hellip: '…',
    middot: '·',
    copy: '©',
  }
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeFromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCode(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (whole, name) => (name in named ? named[name] : whole))
}

function safeFromCode(code) {
  try {
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ''
  } catch {
    return ''
  }
}

/** 把 ms 时间戳格式化成 `YYYY/MM/DD HH:mm:ss`（原实现用 dayjs，这里手写）。 */
export function formatDate(input) {
  const ts = Number(input)
  if (!Number.isFinite(ts) || ts <= 0) return null
  // 微信有时给秒级时间戳（10 位），统一成毫秒
  const ms = ts < 1e12 ? ts * 1000 : ts
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 从页面里抓一个 JS 变量。
 * 公众号把文章元数据写在 <script> 里的 `var msg_title = '...'` 这种形式。
 * 这是原实现的主力路径，比解析 HTML 稳得多。
 *
 * ## 真实页面实测（2026-11-08，真实文章）
 * 部分字段被包在 `htmlDecode(...)` 里：
 *     var msg_desc = htmlDecode("大模型会聊天，但不会替你改文件...")
 *     var nickname = htmlDecode("快乐愿享")
 * 早先的正则只认裸字符串，于是这两个字段全部取不到，
 * 摘要退回 HTML 容器时抓到了整个作者区块（结果是"快乐愿享 快乐愿享 快乐愿享"）。
 * 所以必须先剥掉 htmlDecode 外壳再解引用。
 */
export function readJsVar(html, name) {
  const valuePatterns = [
    `'([^']*)'`, // 单引号
    `"([^"]*)"`, // 双引号
  ]
  for (const valuePattern of valuePatterns) {
    // 裸字符串：var x = '...'
    const plain = new RegExp(`var\\s+${name}\\s*=\\s*${valuePattern}`)
    const plainMatch = html.match(plain)
    if (plainMatch && plainMatch[1] !== undefined) return plainMatch[1]

    // 包了 htmlDecode：var x = htmlDecode("...")
    const wrapped = new RegExp(`var\\s+${name}\\s*=\\s*htmlDecode\\s*\\(\\s*${valuePattern}\\s*\\)`)
    const wrappedMatch = html.match(wrapped)
    if (wrappedMatch && wrappedMatch[1] !== undefined) return decodeJsEscapes(wrappedMatch[1])
  }

  // window.x = "..." 与 "x": "..." 作为兜底
  const alternates = [
    new RegExp(`window\\.${name}\\s*=\\s*["']([^"']*)["']`),
    new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`),
  ]
  for (const re of alternates) {
    const match = html.match(re)
    if (match && match[1] !== undefined) return match[1]
  }
  return null
}

/**
 * 解开 JS 字符串字面量里的转义。
 * 公众号有时把引号写成 `\x26quot;` 或 `\u4e2d`，直接当文本用会显示成乱码。
 */
export function decodeJsEscapes(text) {
  if (!text) return ''
  return String(text)
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

/**
 * 读 <meta> 标签。
 * 实测这些标签非常可靠（og:title / og:description / author 都在），
 * 而且不受 htmlDecode 包装影响，是 JS 变量失败后的最佳兜底。
 */
export function readMeta(html, keys) {
  for (const key of keys) {
    const re = new RegExp(
      `<meta[^>]*(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)`,
      'i',
    )
    const match = html.match(re)
    if (match && match[1]) return match[1]
  }
  return null
}

/** 取某个 id 容器的 innerHTML（近似实现：找开始标签后配对到同层结束标签）。 */
export function extractElementHtml(html, id) {
  // 匹配 <div ... id="xxx" ...> ... </div>，用深度计数找配对结束标签
  const openRe = new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i')
  const open = openRe.exec(html)
  if (!open) return null
  const tagName = open[1].toLowerCase()
  const start = open.index + open[0].length
  const tagRe = new RegExp(`<(/?)${tagName}\\b[^>]*>`, 'gi')
  tagRe.lastIndex = start
  let depth = 1
  let match
  while ((match = tagRe.exec(html))) {
    if (match[1] === '/') {
      depth -= 1
      if (depth === 0) return html.slice(start, match.index)
    } else if (!match[0].endsWith('/>')) {
      depth += 1
    }
  }
  // 没找到配对：退回"取到脚本前"
  const tail = html.indexOf('</body>', start)
  return html.slice(start, tail > 0 ? tail : undefined)
}

/** 取某个 class 的第一个元素文本。 */
export function extractByClassText(html, className) {
  const re = new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*\\bclass=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)</\\1>`, 'i')
  const match = html.match(re)
  if (!match) return null
  return stripTags(match[2]).trim() || null
}

/** 去掉所有标签，保留文字。 */
export function stripTags(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
}

/**
 * 把正文 HTML 转成适合存档的 Markdown 近似文本。
 *
 * 为什么不做完整 HTML→Markdown：公众号正文里嵌套层极多（section/section/section），
 * 完整转换需要完整的 DOM 解析器。这里只保留结构性的东西：
 * 段落分隔、图片占位、加粗与链接。**够用来重新排版**，也不会把整篇压成一行。
 */
export function htmlToMarkdown(html) {
  let text = String(html || '')
  // 图片：保留 src 作为 Markdown 图片（用户在 wxmp 里能看到原图位置）
  text = text.replace(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi, (_, src) => `\n\n![](${src})\n\n`)
  // 加粗 / 斜体 / 链接
  text = text.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, inner) => `**${stripTags(inner).trim()}**`)
  text = text.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, inner) => `*${stripTags(inner).trim()}*`)
  text = text.replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const label = stripTags(inner).trim()
    return label ? `[${label}](${href})` : ''
  })
  // 标题
  for (const level of [1, 2, 3, 4]) {
    text = text.replace(
      new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)</h${level}>`, 'gi'),
      (_, inner) => `\n\n${'#'.repeat(level)} ${stripTags(inner).trim()}\n\n`,
    )
  }
  // 段落 / 换行
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/(p|section|div|li|blockquote)>/gi, '\n\n')
  text = text.replace(/<li\b[^>]*>/gi, '- ')
  // 剩余标签全去掉
  text = text.replace(/<[^>]+>/g, '')
  text = decodeEntities(text)
  // 收拾空白：连续空行压成一个，去掉行尾空格
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return text
}

/**
 * 校验并规范化 URL。
 * 只接受 mp.weixin.qq.com 的文章链接 —— 不做通用抓取器，
 * 那样会成为 SSRF 跳板（用户贴任意 URL 就能让插件访问内网）。
 */
export function normalizeArticleUrl(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new ExtractError(2001, '空链接')
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new ExtractError(2001, '不是合法 URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ExtractError(2001, `不支持的协议 ${url.protocol}`)
  }
  if (url.hostname !== 'mp.weixin.qq.com') {
    throw new ExtractError(2001, `只支持 mp.weixin.qq.com，收到 ${url.hostname}`)
  }
  return url.toString()
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

/**
 * 抓取并解析一篇公众号文章。
 * @param {string} input 文章 URL
 * @param {{fetchImpl?: Function, timeoutMs?: number, keepHtml?: boolean}} options
 * @returns {Promise<{title, author, account, publishTime, digest, contentHtml, markdown, url}>}
 */
export async function extractArticle(input, options = {}) {
  const url = normalizeArticleUrl(input)
  const doFetch = options.fetchImpl ?? fetch
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20000

  // 超时必须自己控：公众号偶尔会挂住不返回，没有超时就会一直卡着
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let html
  try {
    const response = await doFetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!response.ok) {
      throw new ExtractError(2003, `HTTP ${response.status}`)
    }
    html = await response.text()
  } catch (error) {
    if (error instanceof ExtractError) throw error
    if (error?.name === 'AbortError') throw new ExtractError(2003, `超时 ${timeoutMs}ms`)
    throw new ExtractError(2003, error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timer)
  }

  return parseArticleHtml(html, url, options)
}

/**
 * 从页面 HTML 解析出文章信息（与网络分离，便于测试）。
 */
export function parseArticleHtml(html, url, options = {}) {
  const page = String(html || '')

  /* ── 1. 先判错误页（顺序重要：错误页有时也含 js_content，要先看特征）── */
  const hasContent = page.includes('id="js_content"') || page.includes('id=\\"js_content\\"')
  if (/访问过于频繁/.test(page) && !hasContent) throw new ExtractError(2016)
  if (/链接已过期/.test(page) && !hasContent) throw new ExtractError(2002)
  if (/此帐号已被屏蔽/.test(page) && !hasContent) throw new ExtractError(2012)
  if (/此帐号已自主注销/.test(page) && !hasContent) throw new ExtractError(2013)
  if (/此帐号处于帐号迁移流程中/.test(page) && !hasContent) throw new ExtractError(2015)
  if (/page_rumor/.test(page) && !hasContent) throw new ExtractError(2014)
  if (!hasContent) {
    if (/系统出错/.test(page)) throw new ExtractError(2008)
    throw new ExtractError(2018)
  }

  /* ── 2. 元数据：JS 变量 → meta 标签 → HTML 容器（逐级兜底）── */
  const title =
    clean(readJsVar(page, 'msg_title')) ||
    readMeta(page, ['og:title', 'twitter:title']) ||
    extractByClassText(page, 'activity-name') ||
    extractByClassText(page, 'rich_media_title') ||
    ''
  if (!title) throw new ExtractError(2018, '找不到标题')

  const author =
    clean(readJsVar(page, 'author')) ||
    readMeta(page, ['author']) ||
    extractByClassText(page, 'rich_media_meta_text') ||
    ''

  // 账号名：nickname 被 htmlDecode 包着（已处理），profile_nickname 在新页面里已消失
  const account =
    clean(readJsVar(page, 'nickname')) ||
    extractByClassText(page, 'profile_nickname') ||
    extractByClassText(page, 'wx_follow_nickname') ||
    ''

  // 发布时间：ct 是秒级时间戳
  const ctRaw = readJsVar(page, 'ct') || readJsVar(page, 'create_time')
  const publishTime = formatDate(ctRaw)

  /**
   * 摘要：优先 msg_desc，其次 meta description。
   *
   * ⚠ 曾经的错误做法：拿 `rich_media_meta_list` 整个容器当摘要兜底。
   * 实测那个容器装的是「原创 作者 公众号名」这排 meta，不是一个摘要，
   * 结果摘要变成"快乐愿享 快乐愿享 快乐愿享"。宁可为空，也不要脏数据。
   */
  const digest =
    clean(readJsVar(page, 'msg_desc')) ||
    readMeta(page, ['og:description', 'description']) ||
    ''

  // 原文链接（转载声明里的"阅读原文"）
  const sourceUrl = clean(readJsVar(page, 'msg_source_url')) || ''

  // 原创标记
  const isOriginal =
    /copyright_logo/.test(page) ||
    /原创/.test(extractByClassText(page, 'rich_media_meta_text') || '')

  /* ── 3. 正文 ── */
  const contentHtml = extractElementHtml(page, 'js_content') || ''
  if (!contentHtml.trim()) throw new ExtractError(2018, '正文为空')

  const markdown = htmlToMarkdown(contentHtml)

  return {
    url,
    title,
    author,
    account,
    publishTime,
    digest,
    isOriginal,
    sourceUrl,
    markdown,
    contentHtml: options.keepHtml ? contentHtml : undefined,
    charCount: markdown.replace(/\s/g, '').length,
  }
}

function clean(value) {
  if (!value) return ''
  return decodeEntities(String(value)).replace(/\s+/g, ' ').trim()
}

/**
 * 生成带 front matter 的 Markdown 文件内容。
 *
 * front matter 的键与 wxmp 现有格式保持一致（title/author/digest/sourceUrl），
 * 这样导入的文章可以直接走体检 → 封面 → 发布，不需要额外转换。
 */
export function buildMarkdownFile(article) {
  const escape = (text) => String(text || '').replace(/\n/g, ' ').trim()
  const lines = [
    '---',
    `title: ${escape(article.title)}`,
    article.author ? `author: ${escape(article.author)}` : 'author:',
    article.digest ? `digest: ${escape(article.digest)}` : 'digest:',
    article.publishTime ? `publishTime: ${article.publishTime}` : null,
    article.account ? `sourceAccount: ${escape(article.account)}` : null,
    `sourceUrl: ${escape(article.url)}`,
    article.isOriginal ? 'sourceOriginal: true' : null,
    // 原文链接（转载文章里的"阅读原文"）。与 sourceUrl 区分：
    // sourceUrl 是文章在微信上的地址，sourceOriginalUrl 是它转载的原始出处。
    article.sourceUrl ? `sourceOriginalUrl: ${escape(article.sourceUrl)}` : null,
    '---',
    '',
    article.markdown,
    '',
  ].filter((line) => line !== null)
  return lines.join('\n')
}
