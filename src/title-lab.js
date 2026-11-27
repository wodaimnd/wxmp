/**
 * 候选标题生成 —— 把 skill 的「生成 5 个爆款标题」变成可执行的产出。
 *
 * ## 为什么不是"调 LLM 生成"
 * wxmp 全程零依赖、不带 key、不联网（除微信 API 与图片生成）。在这里内置一个 LLM 调用
 * 意味着要配 key、要管 token、要处理"AI 起得还不如用户自己写"。
 *
 * 所以这里做的是**任务书 + 机械候选**两件事：
 *   1. **机械候选**：按标题公式直接拼出可用的标题（不需要 AI，立刻能用）
 *   2. **任务书**：输出一段结构化提示词，交给调用方（agent 或人）去生成更好的
 *
 * 这解决的是真实痛点：作者卡在"起不出标题"时，需要的是**几个能改的起点**，
 * 而不是"你这个标题不够好"的判断。
 *
 * ## 来源
 *   - `wechat-article-writer` Step 3「生成 5 个爆款标题」五特点：
 *     痛点明确 / 数字吸引 / 结果导向 / 情绪调动 / 悬念设置
 *   - `md2wechat` 的 `title suggest` 思路：它也是"产出提示词交给 host agent"，
 *     不自己写最终标题（见 SKILL.md Intent Routing）
 */

/** 标题公式：每种给出一个可填空的骨架 + 说明它为什么有效。 */
export const TITLE_FORMULAS = [
  {
    id: 'number',
    label: '数字式',
    why: '具体数字比形容词可信，读者能立刻判断"要花多久"',
    build: ({ topic, number }) => `${number} 个${topic}`,
  },
  {
    id: 'pain',
    label: '痛点式',
    why: '直击读者正在经历的问题，他会在列表里停下来确认"这说的是我"',
    build: ({ topic }) => `还在手动${topic}？`,
  },
  {
    id: 'result',
    label: '结果式',
    why: '承诺具体收益，把"要不要点"变成"值不值得"',
    build: ({ topic, result }) => `${topic}：${result}`,
  },
  {
    id: 'contrast',
    label: '反常识式',
    why: '先立一个共识再推翻，制造认知缺口',
    build: ({ topic }) => `都以为${topic}很难，其实只差这一步`,
  },
  {
    id: 'howto',
    label: '方法式',
    why: '明确告诉读者"这里有可操作的东西"',
    build: ({ topic }) => `怎么把${topic}做对`,
  },
]

/** 从文章里抽取可复用的信息（主题词、数字、结果）。 */
export function extractTitleMaterial(article, info) {
  const title = String((article && article.title) || '').trim()
  const body = String((article && article.body) || '')
  const headings = (info && info.headings) || []

  /**
   * 主题词必须是**名词性短语**，不能是完整句子。
   *
   * 三层实测教训，逐层收窄：
   * 1. 直接把原标题整句当 topic → 「3 个DSH 是什么 一个把 AI 变成能干活的操作台」，全超长
   * 2. 取标题第一个 ≤14 字片段 → 取到「DSH 是什么」（问句），「3 个DSH 是什么」语义不通
   * 3. 改成小标题优先 → 取到「技能让经验能传下去」（完整句子），
   *    「还在手动技能让经验能传下去？」依然生硬
   *
   * 结论：**机械拼装天然做不出好标题**，因为好的中文标题需要重新组织语言，
   * 不是套公式能得到的。所以这里的作用降级为「提供原料」：
   * 抽出可能用到的名词短语与数字，交给调用方组合，
   * 而不是硬拼 5 条半成品假装它们能用。
   */
  const NOUN_ENDINGS = /(机制|设计|原理|方案|方法|流程|结构|思路|经验|技巧|陷阱|差别|区别|取舍|选择|清单|步骤|工具|插件|技能|记忆|能力|成本|代价|细节|要点|问题|原因|做法|实践|复盘|案例)$/
  const usable = (text) => {
    const value = String(text || '')
      .replace(/^[\d.、)\s]+/, '')
      .replace(/^(如何|怎么|为什么|是不是|要不要|能不能|该不该|什么是)/, '')
      .replace(/^(一|二|三|四|五|六|七|八|九|十)、/, '')
      .trim()
    if (!value || value.length < 2 || value.length > 12) return ''
    // 问句/感叹句不要
    if (/[？?！!]$/.test(value)) return ''
    // 陈述句尾巴（"…能传下去"、"…在哪"）不要
    if (/[了着过下去上来]|在哪|是什么|怎么办/.test(value)) return ''
    if (/^(最后|小结|总结|结语|写在)/.test(value)) return ''
    return value
  }

  /** 从文本里挖出所有像名词短语的片段（供调用方组合，不直接拼标题）。 */
  const harvestPhrases = (texts) => {
    const found = []
    for (const text of texts) {
      const pieces = String(text)
        .split(/[：:，,。.！!？?、；;——\-—|｜()（）【】\[\]《》"]/)
        .map((piece) => piece.trim())
        .filter(Boolean)
      for (const piece of pieces) {
        const cleaned = usable(piece)
        if (cleaned && !found.includes(cleaned)) found.push(cleaned)
      }
      // 命中名词结尾词的整句也收（哪怕它不是纯名词，但结尾是名词性）
      const trimmed = String(text).replace(/^[\d.、)\s]+/, '').trim()
      if (trimmed.length <= 12 && NOUN_ENDINGS.test(trimmed) && !found.includes(trimmed)) {
        found.push(trimmed)
      }
    }
    return found
  }

  const headingTexts = headings.map((item) => item.text)
  const phrases = harvestPhrases([...headingTexts, title])
  // 优先选以名词结尾的短语（"关键设计"优于"技能让经验能传下去"）
  const topic = phrases.find((item) => NOUN_ENDINGS.test(item)) || phrases[0] || '这件事'

  // 正文里的数字（跳过前 200 字，避免把标题里的数字重复利用）
  const numberMatch = body.slice(200, 2000).match(/(\d+)\s*(个|步|种|条|分钟|小时|天|倍)/)
  const number = numberMatch ? numberMatch[1] : '3'

  // 结果词：正文里出现的效果描述
  const resultMatch = body.match(/(省[下了]?|快[了出]?|少走|避免|搞定|一次通过|不再)[^。，；\n]{0,10}/)
  const result = resultMatch ? resultMatch[0].trim().slice(0, 12) : '少走弯路'

  return { title, topic, phrases, number, result }
}

/**
 * 机械候选标题。
 *
 * ## 定位（重要，别高估它）
 * 这些是**半成品起点**，不是可直接发布的标题。三轮实测证明：
 * 机械套公式做不出好的中文标题——「还在手动{名词短语}？」这种句式对很多主题是生硬的。
 *
 * 所以这里的价值只有两个：
 *   1. 把空白的输入框变成几个能改的句子（**打破空白页**）
 *   2. 顺便演示五种方向长什么样
 *
 * 真正的标题应该来自 `buildTitleBrief` 交给 AI/人 生成。
 * 面板上必须把这个定位说清楚，否则用户会以为"AI 起的标题就这水平"。
 *
 * @returns {{material, candidates: Array<{text, formula, label, why, notes, usable}>}}
 *          usable=false 表示这条明显不成立，只是展示方向
 */
export function buildTitleCandidates(article, info, options = {}) {
  const material = extractTitleMaterial(article, info)
  const limit = Number(options.count) > 0 ? Number(options.count) : TITLE_FORMULAS.length
  const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : 26

  const candidates = []
  for (const formula of TITLE_FORMULAS) {
    const text = formula.build(material)
    const notes = []
    let usable = true

    if (text.length > maxChars) {
      notes.push(`偏长（${text.length} 字，建议 ≤ ${maxChars}）`)
      usable = false
    }
    if (!/\d/.test(text) && !/为什么|怎么|如何|还在|别再|其实|只差/.test(text)) {
      notes.push('缺少数字或钩子词')
    }
    // 主题词本身是句子时，套进公式通常不通顺 → 标记为需改写
    if (/[了着过]$|在哪|是什么/.test(material.topic)) {
      notes.push('主题词是句子，套用后可能不通顺，需手改')
      usable = false
    }

    candidates.push({
      text,
      formula: formula.id,
      label: formula.label,
      why: formula.why,
      notes,
      usable,
    })
    if (candidates.length >= limit) break
  }
  return { material, candidates }
}

/**
 * 生成给调用方（agent）用的标题任务书。
 *
 * 关键设计：把 skill 的五个特点、目标读者、已有标题、文章要点**全部结构化写出来**，
 * 让调用方一次就能产出合格标题，不用来回追问。
 */
export function buildTitleBrief(article, info, options = {}) {
  const material = extractTitleMaterial(article, info)
  const count = Number(options.count) > 0 ? Number(options.count) : 5
  const headings = ((info && info.headings) || []).map((item) => `  ${'  '.repeat(item.level - 1)}${item.text}`)
  const firstPara = ((info && info.paragraphs) || [])[0] || ''

  return [
    '# 标题生成任务',
    '',
    `请为下面这篇文章生成 ${count} 个公众号标题候选，并说明每个标题用了哪种吸引力。`,
    '',
    '## 硬约束',
    `- 每个标题 ≤ 26 字（微信列表里超过会被截断）`,
    '- 前 10 个字就要有钩子，读者在列表里只看得到开头',
    '- 不要用"震惊""必看""99%的人不知道"这类空喊，要具体',
    '- 不要堆名词，要能读成一个句子',
    '',
    '## 五个可用方向（每个方向出 1 个）',
    '1. **痛点式**：直击读者正在经历的问题（"还在手动…"）',
    '2. **数字式**：给一个具体数字，让工作量可感知（"3 步"、"5 个"）',
    '3. **结果式**：承诺具体收益，而非模糊的"更好用"',
    '4. **反常识式**：先立一个共识再推翻，制造认知缺口',
    '5. **方法式**：明确"这里有可操作的东西"',
    '',
    '## 这篇文章的现状',
    `原标题：${material.title || '(无)'}（${material.title ? material.title.length + ' 字' : '—'}）`,
    material.title && material.title.length > 22 ? '⚠ 原标题偏长，微信列表会截断' : '',
    '',
    '## 正文要点（来自小标题）',
    headings.length ? headings.join('\n') : '  (没有小标题)',
    '',
    '## 开头两段（用于判断语气）',
    firstPara.slice(0, 300) || '(空)',
    '',
    '## 输出格式',
    '每个候选一行，格式：`标题 | 方向 | 一句话说明为什么这样起`',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * 检查用户给的标题列表，标出明显问题。
 * 这是「生成」之后的第二道关：给出选项后要能判断哪个更好。
 */
export function scoreTitleCandidate(text, options = {}) {
  const value = String(text || '').trim()
  const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : 26
  const issues = []
  let score = 50

  if (!value) return { text: value, score: 0, issues: ['空标题'] }
  if (/\d/.test(value)) score += 15
  else issues.push('没有具体数字')
  if (/为什么|怎么|如何|还在|别再|其实|只差|不再|告别|避坑/.test(value)) score += 12
  else issues.push('缺少钩子词')
  if (/效率|省|提升|搞定|拿下|一步|只需|从.+到/.test(value)) score += 10
  if (value.length <= maxChars) score += 13
  else issues.push(`过长 ${value.length} 字（建议 ≤ ${maxChars}）`)
  if (/震惊|必看|99%|绝对|史上最/.test(value)) {
    score -= 15
    issues.push('有夸张套话，读者会反感')
  }
  if (value.length > 12 && !/[，。：、是|把|让|用|做|从|到]/.test(value)) {
    score -= 8
    issues.push('像名词堆砌')
  }

  return { text: value, score: Math.max(0, Math.min(100, score)), issues }
}
