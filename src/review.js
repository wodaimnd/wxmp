/**
 * 稿件体检：给 Agent 的「写得怎么样」结构化反馈。
 *
 * 设计前提（这是整个模块存在的理由）：
 *   Agent 写完文章后，**看不见自己在屏幕上写了什么**。它只有两种信息源——
 *   (1) 硬限制是否超（标题 32 字、正文 2 万字…），(2) 人随口说一句「太长了」。
 *   于是它只能瞎改。这个模块把「人眼一读就皱眉的东西」变成机器可读的数字 + 行号，
 *   让 Agent 改完之后能立刻验证自己是不是真的改好了（分数会动）。
 *
 * 三条硬约束：
 *  1. **纯函数、不联网、不读盘**：只吃 article + rendered，任何环境都能跑，测试不需要假服务器。
 *  2. **每条建议必须带行号**：没有行号的建议等于「你自己去找吧」，Agent 会去重写整篇。
 *  3. **分数必须可解释**：每个扣分项都要能在 breakdown 里追溯到具体规则，否则
 *     分数变成玄学，Agent 会开始猜「是不是 87 分就够了」。
 *
 * 行号怎么来的：markdown.js 的解析器不记位置（改解析器成本高于收益），
 * 这里用原文正文按行回查首个命中行；查不到的行号返回 null，绝不编造。
 */

import { TITLE_MAX, AUTHOR_MAX, DIGEST_MAX, CONTENT_MAX_CHARS, CONTENT_MAX_BYTES } from './output.js'
import { BUILTIN, WEIGHT_SPEC } from './presets.js'
import { CONTENT_LAYER_SPEC, runContentChecks } from './review-content.js'

/* ── 阈值与权重：**出厂值**在这里，实际体检用什么由预设决定 ─────────
 *  原先这些是模块级常量，导致「什么算写得好」焊死在代码里，
 *  想换一种文风只能改源码。现在它们只是 `BUILTIN` 预设的副本，
 *  reviewArticle(article, rendered, preset) 接受任意预设。
 *  保留这两个导出是为了兼容既有调用方与测试（等于内置 standard）。
 */
export const THRESHOLDS = BUILTIN.thresholds
export const WEIGHTS = BUILTIN.weights

const isCjk = (ch) => /[\u4e00-\u9fa5]/.test(ch)

/** 从正文里切句：中文标点为主，英文句号为辅。 */
function splitSentences(text) {
  return String(text)
    .split(/(?<=[。！？!?])|\n+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

/** 在原文正文里定位一段文字的行号（文件绝对行号）。查不到返回 null。 */
function makeLocator(body, bodyStartLine) {
  const lines = String(body || '').split(/\r?\n/)
  return function locate(text) {
    const needle = String(text || '').trim().replace(/\s+/g, ' ')
    if (!needle) return null
    // 用前 16 字做锚：够独特，又不至于因为标点差异整个失配
    const anchor = needle.slice(0, 16)
    for (let i = 0; i < lines.length; i += 1) {
      const flat = lines[i].replace(/\s+/g, ' ')
      if (flat.includes(anchor)) return bodyStartLine + i
    }
    // 退一步：只在前 6 字里找（标题被改过标点但主体没变）
    const loose = needle.slice(0, 6)
    if (loose.length >= 3) {
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].includes(loose)) return bodyStartLine + i
      }
    }
    return null
  }
}

/** 收集节点树里的结构信息。 */
export function collectStructure(nodes) {
  const info = {
    paragraphs: [],
    headings: [],
    images: [],
    codes: [],
    tables: [],
    lists: 0,
    quotes: 0,
  }
  const inlineText = (children) =>
    (children || [])
      .map((node) => {
        if (node.type === 'text' || node.type === 'code') return node.value
        if (node.type === 'image') return ''
        if (node.children) return inlineText(node.children)
        return ''
      })
      .join('')

  const walk = (list) => {
    for (const node of list) {
      if (node.type === 'paragraph') {
        info.paragraphs.push(inlineText(node.children).trim())
      } else if (node.type === 'heading') {
        info.headings.push({ level: node.level, text: inlineText(node.children).trim() })
      } else if (node.type === 'image') {
        info.images.push({ src: node.src || '', alt: node.alt || '' })
      } else if (node.type === 'code') {
        info.codes.push({ lang: node.lang || '', lines: String(node.value || '').split('\n').length })
      } else if (node.type === 'table') {
        info.tables.push({ cols: (node.header || []).length, rows: (node.rows || []).length })
      } else if (node.type === 'list') {
        info.lists += 1
        walk(node.items.flat())
      } else if (node.type === 'quote') {
        info.quotes += 1
        walk(node.children)
      }
    }
  }
  walk(nodes)
  return info
}

/**
 * 体检主入口。
 * @param {object} article loadArticle() 的返回值
 * @param {object} rendered renderArticle() 的返回值
 * @param {object} [preset] 预设（含 thresholds / weights）；不传就用内置 standard
 * @returns {object} 结构化报告
 */
export function reviewArticle(article, rendered, preset = BUILTIN) {
  const T = { ...BUILTIN.thresholds, ...((preset && preset.thresholds) || {}) }
  const W = { ...BUILTIN.weights, ...((preset && preset.weights) || {}) }
  const locate = makeLocator(article.body, article.bodyStartLine || 1)
  const info = collectStructure(rendered.nodes || [])
  const findings = []
  const push = (level, category, code, message, suggest, line) =>
    findings.push({ level, category, code, message, suggest, line: line ?? null })

  const text = info.paragraphs.join('\n')
  const sentences = splitSentences(text)
  const chars = rendered.html ? rendered.html.length : 0
  const bytes = Buffer.byteLength(rendered.html || '', 'utf8')

  /* ── 1. 硬限制（超了就是发不出去，不是「建议」）──────────────── */
  if (!article.title) push('error', 'limits', 'title_missing', '缺少标题', '在 front matter 写 title:', 1)
  else if (article.title.length > TITLE_MAX)
    push('error', 'limits', 'title_long', `标题 ${article.title.length} 字，上限 ${TITLE_MAX}`, '把标题压到 32 字以内', 2)
  if (article.author && article.author.length > AUTHOR_MAX)
    push('error', 'limits', 'author_long', `作者 ${article.author.length} 字，上限 ${AUTHOR_MAX}`, '作者名压到 16 字以内', 3)
  if (String(rendered.digest || '').length > DIGEST_MAX)
    push('error', 'limits', 'digest_long', `摘要 ${rendered.digest.length} 字，上限 ${DIGEST_MAX}`, '摘要压到 120 字以内', 4)
  if (chars >= CONTENT_MAX_CHARS)
    push('error', 'limits', 'content_long', `正文 ${chars} 字符，上限 ${CONTENT_MAX_CHARS - 1}`, '拆成两篇，或把长段落/长代码压缩', null)
  if (bytes >= CONTENT_MAX_BYTES)
    push('error', 'limits', 'content_big', `正文 ${bytes} 字节，上限 1 MB`, '压缩正文图片，或减少内联图片', null)

  /* ── 2. 结构 ────────────────────────────────────────────────── */
  const h2 = info.headings.filter((item) => item.level === 2)
  const h1 = info.headings.filter((item) => item.level === 1)
  if (!info.headings.length) {
    push('warn', 'structure', 'no_outline', '正文没有任何小标题，手机上是一堵字墙', '加 3~6 个 ## 小节，每节讲一件事', locate(article.body))
  } else {
    if (h1.length > 1)
      push('info', 'structure', 'h1_many', `有 ${h1.length} 个一级标题`, '文章标题在 front matter 里，正文不要再用 #；小标题统一用 ##', locate(h1[1] && h1[1].text))
    if (h2.length < T.sectionsMin)
      push('warn', 'structure', 'few_sections', `只有 ${h2.length} 个小节，读者很难跳读`, `拆到 ${T.sectionsMin}~${T.sectionsMax} 个 ## 小节`, null)
    if (h2.length > T.sectionsMax)
      push('info', 'structure', 'many_sections', `有 ${h2.length} 个小节，主线可能散了`, '合并相近小节，或拆成系列文章', null)
    // 层级跳级：正文第一个标题必须是 H2（H1 属于 front matter 的 title），
    // 之后每次最多 +1。这里先单独查首标题，再查后续 —— 只查 prev 非零会漏掉「开头直接 H4」。
    const first = info.headings[0]
    if (first && first.level !== 2 && first.level !== 0) {
      push(
        'warn',
        'structure',
        'first_heading_level',
        `正文第一个标题是 H${first.level}「${first.text}」`,
        '文章标题写在 front matter 的 title，正文小节统一从 ## 开始',
        locate(first.text),
      )
    }
    let prev = first ? first.level : 0
    for (const head of info.headings.slice(1)) {
      if (head.level > prev + 1)
        push('warn', 'structure', 'level_jump', `标题跳级：H${prev} → H${head.level}「${head.text}」`, `改成 H${prev + 1}`, locate(head.text))
      prev = head.level
    }
    for (const head of info.headings) {
      if (head.text.length > T.headingLong)
        push('info', 'structure', 'heading_long', `小标题 ${head.text.length} 字，手机上会折两行：「${head.text}」`, '压到 15 字以内', locate(head.text))
    }
  }

  /* ── 3. 可读性 ──────────────────────────────────────────────── */
  const longParagraphs = info.paragraphs
    .map((value, index) => ({ value, index }))
    .filter((item) => item.value.length >= T.paragraphLong)
  for (const item of longParagraphs) {
    const level = item.value.length >= T.paragraphHuge ? 'warn' : 'info'
    push(
      level,
      'readability',
      'paragraph_long',
      `第 ${item.index + 1} 段 ${item.value.length} 字，一屏读不完`,
      `在「${item.value.slice(0, 14)}…」这里断开，拆成 2~3 段，每段 ≤ 200 字`,
      locate(item.value),
    )
  }
  if (info.paragraphs.length) {
    const avg = info.paragraphs.reduce((sum, value) => sum + value.length, 0) / info.paragraphs.length
    if (avg > T.paragraphAvg)
      push('info', 'readability', 'paragraph_avg', `平均段落 ${Math.round(avg)} 字，整体偏密`, '把长段再切一刀，每段 3~5 行', null)
  }

  const longSentences = sentences.filter((value) => value.length > T.sentenceLong)
  for (const sentence of longSentences.slice(0, 3)) {
    push(
      'info',
      'readability',
      'sentence_long',
      `一句 ${sentence.length} 字：「${sentence.slice(0, 18)}…」`,
      '拆成两句，或用顿号/分号断一下',
      locate(sentence),
    )
  }
  if (longSentences.length > 3)
    push('info', 'readability', 'sentence_long_many', `还有 ${longSentences.length - 3} 句超过 ${T.sentenceLong} 字`, '整篇统一改短：一句话只讲一件事', null)

  // 完全重复的段落：AI 写长文时最容易出现的自我复制
  const seen = new Map()
  for (const item of info.paragraphs) {
    if (item.length < 20) continue
    seen.set(item, (seen.get(item) || 0) + 1)
  }
  for (const [value, count] of seen) {
    if (count > 1)
      push('warn', 'readability', 'paragraph_duplicated', `同一段出现 ${count} 次：「${value.slice(0, 14)}…」`, '删掉重复的那一处', locate(value))
  }

  // 排版小毛病：连续空行、行尾多余空格、中英文标点混用
  if (/\n{3,}/.test(article.body || '')) {
    push('info', 'readability', 'blank_lines', '有连续 3 行以上空行，微信里会显示成突兀的留白', '压成 1 个空行', null)
  }
  if (/[，。！？；：]\s*[,.:;!?]/.test(text) || /[,.:;!?]\s*[，。！？；：]/.test(text)) {
    push('info', 'readability', 'punct_mixed', '中英文标点混用（例如中文句子里混了英文逗号）', '中文句子统一用全角标点', null)
  }

  /* ── 4. 素材与封面 ──────────────────────────────────────────── */
  if (!article.cover)
    push('warn', 'assets', 'cover_missing', '没有封面，草稿缺首图，发出去列表里是灰块', '跑 wxmp cover --file <文章>（会自动写回 cover）', 5)

  const remoteImages = info.images.filter((item) => /^https?:\/\//i.test(item.src) && !/mmbiz\.|qpic\.cn|wxqcloud/i.test(item.src))
  for (const item of remoteImages) {
    push('warn', 'assets', 'image_remote', `正文引用了外链图片（微信会过滤）：${item.src.slice(0, 40)}`, '换成同目录本地图片，draft create 会自动上传成 mmbiz URL', locate(item.src))
  }
  const noAlt = info.images.filter((item) => !item.alt)
  if (noAlt.length)
    push('info', 'assets', 'image_no_alt', `${noAlt.length} 张图片没有 alt 文字`, '给图片写一句 alt，加载失败时读者知道那是什么', null)

  for (const code of info.codes) {
    if (code.lines > T.codeLinesWarn)
      push('info', 'assets', 'code_long', `代码块 ${code.lines} 行，微信里要横向滑动`, '只留关键几行，或截成图片', null)
  }
  for (const table of info.tables) {
    if (table.cols > T.tableColsWarn)
      push('info', 'assets', 'table_wide', `表格 ${table.cols} 列，手机上要横向拖`, '砍到 5 列以内，或改成列表', null)
  }

  /* ── 5. 开篇与收尾（语气层面，只给 info，不重罚）─────────────── */
  const opening = (info.paragraphs[0] || '').slice(0, T.hookChars)
  const hookSignals = [/[？?]/, /\d/, /为什么|怎么|如何|别再|其实|真相|误区|踩坑|代价/]
  if (opening && !hookSignals.some((re) => re.test(opening)))
    push('info', 'readability', 'weak_hook', '开头 100 字里没有钩子（问题/数字/反差）', '第一句直接抛读者关心的问题或一个具体数字', locate(info.paragraphs[0]))

  const ending = (info.paragraphs.at(-1) || '')
  if (ending && !/试|做|改|下一步|动手|开始|可以|建议|记住/.test(ending))
    push('info', 'readability', 'weak_ending', '结尾没有给出下一步动作', '末尾加一句「你现在就可以做什么」', locate(ending))

  /* ── 5.5 内容层（来自公众号写作 skill 的判断标准）─────────────────
   * 前 5 组只管排版（段落多长、标题几级、有没有封面）。
   * 这一组管内容：标题吸不吸引人、开头有没有钩子、说的有没有依据、
   * 教程有没有交代前提和失败边界。规则实现与来源见 review-content.js。
   */
  runContentChecks(article, info, push)

  /* ── 6. 打分 ────────────────────────────────────────────────── */
  /* 三个 map 全部由 WEIGHT_SPEC 派生，不写死类别名。
   * 加 content 那一轮就是这么踩的：breakdown/deduct/求和三处都要手改，
   * 漏一处就是「分数算错但界面看不出来」。现在新增类别只需改 WEIGHT_SPEC
   * 与 DEDUCT 表两处，其余自动跟上。
   */

  /** 每个类别扣多少分。没有列出的类别按 info=2 处理（保守，不冤枉作者）。 */
  const DEDUCT = {
    // 硬限制：任一 error 直接清零（发不出去，谈别的没意义）
    limits: () => 0, // 实际由下面的 Infinity 规则处理
    structure: (item) => (item.level === 'warn' ? 8 : item.level === 'info' ? 3 : 0),
    readability: (item) => (item.level === 'warn' ? 6 : item.level === 'info' ? 2 : 0),
    assets: (item) => (item.level === 'warn' ? 6 : item.level === 'info' ? 2 : 0),
    // 内容层都是建议性质（没法机械判定"写得好不好"），所以扣分轻
    content: (item) =>
      item.level === 'warn' ? CONTENT_LAYER_SPEC.deductWarn : item.level === 'info' ? CONTENT_LAYER_SPEC.deductInfo : 0,
  }
  const weightKeys = Object.keys(WEIGHT_SPEC)
  const breakdown = {}
  for (const category of weightKeys) {
    breakdown[category] = W[category] ?? 0
  }

  for (const category of weightKeys) {
    let lost = 0
    let zeroed = false
    const cost = DEDUCT[category] || ((item) => (item.level === 'warn' ? 4 : item.level === 'info' ? 2 : 0))
    for (const item of findings) {
      if (item.category !== category) continue
      // limits 是硬限制：任一 error 直接清零
      if (category === 'limits' && item.level === 'error') {
        zeroed = true
        continue
      }
      lost += cost(item)
    }
    breakdown[category] = zeroed ? 0 : Math.max(0, (W[category] ?? 0) - lost)
  }
  // 按 WEIGHT_SPEC 的实际键求和（weightKeys 上面已声明过）
  const earned = weightKeys.reduce((sum, key) => sum + (breakdown[key] ?? 0), 0)
  const totalWeight = weightKeys.reduce((sum, key) => sum + (W[key] ?? 0), 0)
  const score = totalWeight > 0 ? Math.round((earned / totalWeight) * 100) : 0
  const grade = score >= 90 ? 'A' : score >= T.passScore ? 'B' : score >= 70 ? 'C' : 'D'

  const metrics = {
    titleChars: article.title.length,
    authorChars: article.author ? article.author.length : 0,
    digestChars: String(rendered.digest || '').length,
    totalChars: chars,
    totalBytes: bytes,
    paragraphs: info.paragraphs.length,
    avgParagraphChars: info.paragraphs.length
      ? Math.round(info.paragraphs.reduce((sum, value) => sum + value.length, 0) / info.paragraphs.length)
      : 0,
    maxParagraphChars: info.paragraphs.reduce((max, value) => Math.max(max, value.length), 0),
    sentences: sentences.length,
    avgSentenceChars: sentences.length
      ? Math.round(sentences.reduce((sum, value) => sum + value.length, 0) / sentences.length)
      : 0,
    longSentences: longSentences.length,
    headings: info.headings.length,
    h2: h2.length,
    images: info.images.length,
    remoteImages: remoteImages.length,
    lists: info.lists,
    quotes: info.quotes,
    tables: info.tables.length,
    codes: info.codes.length,
  }

  // 建议按「先必须改、再该改、最后可选」+ 行号排序：Agent 从上到下照做即可
  const order = { error: 0, warn: 1, info: 2 }
  findings.sort((a, b) => (order[a.level] - order[b.level]) || ((a.line || 1e9) - (b.line || 1e9)))

  return {
    score,
    grade,
    pass: score >= T.passScore && !findings.some((item) => item.level === 'error'),
    breakdown,
    weights: W,
    thresholds: T,
    // 报告要自报用的是哪个预设：换预设后分数变了，得知道为什么变
    preset: { id: (preset && preset.id) || BUILTIN.id, name: (preset && preset.name) || BUILTIN.name },
    metrics,
    findings,
    counts: {
      error: findings.filter((item) => item.level === 'error').length,
      warn: findings.filter((item) => item.level === 'warn').length,
      info: findings.filter((item) => item.level === 'info').length,
    },
    nextActions: findings
      .filter((item) => item.level === 'error' || item.level === 'warn')
      .slice(0, 5)
      .map((item) => (item.line ? `L${item.line}: ${item.suggest}` : item.suggest),
      ),
  }
}

/** 把报告排成 Agent 一眼能懂的文字（CLI text 与工具 text 共用）。 */
export function formatReview(report, options = {}) {
  const lines = []
  // 这里必须读**报告自带**的阈值与权重：formatReview 可能被拿去格式化任意一份报告
  // （含历史报告/别人传进来的），不能依赖 reviewArticle 里的闭包变量。
  const T = report.thresholds || BUILTIN.thresholds
  const W = report.weights || BUILTIN.weights
  const presetLabel = report.preset && report.preset.name ? `（${report.preset.name}）` : ''
  const bar = (value) => `${'█'.repeat(Math.round(value / 5))}${'·'.repeat(20 - Math.round(value / 5))}`
  // 分项按 WEIGHT_SPEC 动态生成：新增类别（如 content）时不用再改这里，
  // 以前写成 4 项固定文案，加了 content 后它会静默不显示。
  const CATEGORY_LABELS = { limits: '限制', structure: '结构', readability: '可读', assets: '素材', content: '内容' }
  const breakdownLine = Object.keys(CATEGORY_LABELS)
    .filter((key) => W[key] !== undefined)
    .map((key) => `${CATEGORY_LABELS[key]} ${report.breakdown[key] ?? 0}/${W[key]}`)
    .join(' · ')
  lines.push(
    `体检 ${report.grade} · ${report.score}/100${report.pass ? '（达标）' : `（未达标，及格线 ${T.passScore}）`}${presetLabel}`,
    `分项: ${breakdownLine}`,
    `${bar(report.score)} ${report.score}`,
    '',
    `规模: ${report.metrics.totalChars} 字符 / ${report.metrics.paragraphs} 段 / ${report.metrics.sentences} 句 / ` +
      `${report.metrics.headings} 个标题（H2 ${report.metrics.h2}）/ ${report.metrics.images} 图`,
    `密度: 平均段 ${report.metrics.avgParagraphChars} 字 · 最长段 ${report.metrics.maxParagraphChars} 字 · ` +
      `平均句 ${report.metrics.avgSentenceChars} 字 · 超长句 ${report.metrics.longSentences} 句`,
  )

  if (!report.findings.length) {
    lines.push('', '没有发现问题：结构、密度、素材都过线。')
    return lines.join('\n')
  }

  lines.push('', `问题 ${report.counts.error} 必须改 / ${report.counts.warn} 该改 / ${report.counts.info} 可选`)
  for (const item of report.findings) {
    const mark = item.level === 'error' ? '✘' : item.level === 'warn' ? '!' : 'i'
    const where = item.line ? `L${item.line}` : '—'
    lines.push(`${mark} ${where.padEnd(6)} [${item.category}/${item.code}] ${item.message}`)
    lines.push(`        改法: ${item.suggest}`)
  }

  if (options.showNext !== false && report.nextActions.length) {
    lines.push('', '先做这几件:')
    report.nextActions.forEach((item, index) => lines.push(`  ${index + 1}. ${item}`))
  }
  return lines.join('\n')
}
