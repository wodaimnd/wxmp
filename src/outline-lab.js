/**
 * 结构骨架 —— 把 `forms.md` 的三种文体变成可套用的骨架。
 *
 * ## 来源
 * `md2wechat/references/writing/forms.md` 明确给了三种文体的组织方式：
 *
 * | 文体 | 原文要求 |
 * |---|---|
 * | 教程 | 「按输入、前提、步骤、可观察结果和失败边界组织」 |
 * | 对比 | 「按同一口径、适用条件和证据组织，缺数据不评胜负」 |
 * | 案例 | 「按背景、行动、真实结果和限制组织，假设示例明确标注」 |
 * | 百科 | 「围绕读者问题组织定义、主要用途、工作方式、适用人群、使用前提与限制、真实例子及来源」 |
 *
 * ## 这个模块做什么
 * 不是"替你写"，而是**给出该写哪几节、每节该放什么**。
 * 作者卡住的常见原因不是不会写句子，而是不知道整体该有哪些块——
 * 先把块摆出来，写起来就顺了。
 *
 * ## 与体检的关系
 * `review-content.js` 的 `checkTutorialCompleteness` 已经在检查「教程缺不缺前提/失败边界」。
 * 那个检查的判定标准，正好就是这里的骨架清单：**检查项与生成项同源**，
 * 不会出现"骨架说要写、体检又不认"的矛盾。
 */

/**
 * 四种文体的骨架。
 * 每一项：`key`（唯一标识，用于合并已有内容）、`heading`（建议小标题）、
 * `prompt`（这一节该写什么）、`required`（缺了体检会扣分的）。
 */
export const FORMS = {
  tutorial: {
    id: 'tutorial',
    label: '教程',
    when: '教读者完成一件具体的事（安装、配置、部署、复现）',
    sections: [
      { key: 'goal', heading: '这件事能解决什么', prompt: '一句话说清读者做完能得到什么，不要铺垫', required: true },
      { key: 'prereq', heading: '前提', prompt: '环境、版本、需要先装什么；缺了这节读者会在第一步就卡住', required: true },
      { key: 'steps', heading: '步骤', prompt: '按顺序编号；每一步只做一件事，给出可复制的命令', required: true },
      { key: 'result', heading: '做完是什么样', prompt: '给一个可观察的结果：输出长什么样、页面变成什么样', required: true },
      { key: 'pitfall', heading: '可能会卡住的地方', prompt: '常见报错与原因、不适用的情况；没有这节读者出事时不知道找谁', required: true },
      { key: 'next', heading: '下一步', prompt: '接下来可以做什么', required: false },
    ],
  },
  comparison: {
    id: 'comparison',
    label: '对比',
    when: '比较两个或多个方案、工具、做法',
    sections: [
      { key: 'question', heading: '要回答的问题', prompt: '明确"在什么场景下选哪个"，而不是笼统说谁更好', required: true },
      { key: 'basis', heading: '按什么标准比', prompt: '测试条件、样本、版本；口径不一致的比较没有意义', required: true },
      { key: 'dimensions', heading: '逐项对比', prompt: '同一口径下逐项比，缺数据的维度写"未验证"而不是猜', required: true },
      { key: 'conditions', heading: '各自适合什么场景', prompt: '没有全局最优，只有场景最优', required: true },
      { key: 'verdict', heading: '结论', prompt: '在既定口径下给结论；数据不足时明确说"不足以判断胜负"', required: false },
    ],
  },
  case: {
    id: 'case',
    label: '案例',
    when: '讲一件真实发生过的事（复盘、踩坑、项目经历）',
    sections: [
      { key: 'background', heading: '背景', prompt: '当时的情况、目标、约束条件', required: true },
      { key: 'action', heading: '做了什么', prompt: '具体的动作与选择，包括走过的弯路', required: true },
      { key: 'result', heading: '真实结果', prompt: '实际发生了什么，含不理想的部分；不要只报喜', required: true },
      { key: 'limits', heading: '这些经验的边界', prompt: '在什么条件下成立、换环境还灵不灵', required: true },
      { key: 'takeaway', heading: '回头看的结论', prompt: '如果重来会怎么做', required: false },
    ],
  },
  explainer: {
    id: 'explainer',
    label: '百科式解释',
    when: '介绍一个概念、产品或工具是什么、有什么用',
    sections: [
      { key: 'problem', heading: '读者的问题', prompt: '先说读者遇到什么，再引出这个东西', required: true },
      { key: 'definition', heading: '它是什么', prompt: '定义要能独立读懂，不依赖前文', required: true },
      { key: 'how', heading: '怎么工作的', prompt: '核心机制，配一张图或一个类比', required: true },
      { key: 'usecase', heading: '谁适合用', prompt: '明确不适用的场景，避免读者误买', required: true },
      { key: 'limits', heading: '限制与代价', prompt: '门槛、成本、做不到什么', required: true },
      { key: 'example', heading: '一个真实例子', prompt: '可核对的实例；假设的例子要明确标注', required: false },
    ],
  },
}

/** 从文本里推断最可能的文体。 */
export function detectForm(article, text) {
  const body = String(text || '')
  const title = String((article && article.title) || '')
  const joined = `${title}\n${body}`

  const scores = {
    tutorial: 0,
    comparison: 0,
    case: 0,
    explainer: 0,
  }

  // 教程信号
  for (const re of [/步骤|第一步|首先|安装|配置|部署|执行|运行|命令|输入/g]) {
    scores.tutorial += (joined.match(re) || []).length
  }
  // 对比信号
  for (const re of [/对比|相比|优于|不如|强于|vs\.?|选择哪个|该选/g]) {
    scores.comparison += (joined.match(re) || []).length
  }
  // 案例信号
  for (const re of [/那天|当时|我们|团队|项目|复盘|踩坑|遇到过|最终/g]) {
    scores.case += (joined.match(re) || []).length
  }
  // 解释信号
  for (const re of [/是什么|指的是|定义|本质|概念|原理|用来/g]) {
    scores.explainer += (joined.match(re) || []).length
  }

  let best = 'explainer'
  let bestScore = 0
  for (const [form, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score
      best = form
    }
  }
  return { form: best, scores, confident: bestScore >= 3 }
}

/**
 * 把已有文章的小标题与骨架对齐，标出哪些节已有、哪些缺。
 *
 * ## 匹配策略（实测校准）
 * 第一版只做「小标题是否包含骨架关键词」，结果一篇真实文章被判定
 * "还缺 5 节"——因为它的实际小标题是「一、Harness 到底是个什么东西」这种
 * 自由命名，跟骨架的「前提/步骤/结果」一个字都不沾。
 *
 * 但那些节其实**内容是有的**，只是标题不叫这个名字。
 * 所以现在做两道判断：
 *   1. 关键词匹配（标题像）
 *   2. **内容探测**：正文里有没有这一节该有的信号（比如"前提"节看有没有版本/环境词）
 * 只有两道都不过，才算真的缺。
 */
export function alignSections(form, headings, text) {
  const skeleton = FORMS[form]
  if (!skeleton) return null
  const headingTexts = (headings || []).map((item) => String(item.text || ''))
  const body = String(text || '')

  /**
   * 每节的"内容信号"：正文里出现这些词，说明这一节的内容其实写过了。
   *
   * ⚠ 实测教训：早先 prereq 的信号里只写了 /环境/，于是
   * 「这是一段完全无关的文字，没有任何环境说明」这种**明确说没写环境**的句子
   * 反而被判定为"前提节已写" —— 单个宽泛名词太容易误命中。
   * 所以信号改成"词 + 邻近有实义"的组合，并要求不处于否定语境。
   */
  const CONTENT_SIGNALS = {
    prereq: /(需要先|前提是|依赖|适用于)\s*[^\s。，]{2,}|(Node|Python|Windows|macOS|Linux|npm|pnpm)\s*[>≥]?\s*\d|版本\s*[:：]?\s*\d/,
    steps: /(第一步|步骤\s*\d|首先.+然后|执行.+命令|运行.+后)/,
    result: /(输出如下|你会看到|完成后|返回如下|效果是|结果如下)/,
    pitfall: /(注意[：:，]|常见报错|可能会失败|如果报错|不适用|会失败|踩坑|注意可能)/,
    basis: /(测试条件|同一口径|相比之下|基准|依据是|因为.+所以|在同一)/,
    dimensions: /(优于|不如|更快|更慢|相比.+更|对比下来)/,
    conditions: /(适合.+场景|不适合|取决于|看情况|视情况)/,
    background: /(当时|背景是|那段时间|目标是把|约束是)/,
    action: /(我?做了|尝试|采用的方案|改成了|调整成)/,
    limits: /(限制是|边界|不适用|前提是|代价是|成本是)/,
    definition: /(指的是|定义为|可以理解为|本质上?是)/,
    how: /(工作原理|机制是|内部流程|怎么工作的)/,
    usecase: /(适合.+人|适合.+场景|如果你是|目标读者)/,
  }

  return skeleton.sections.map((section) => {
    // 1) 标题像不像
    const keywords = section.heading
      .split(/[与和的、]/)
      .map((word) => word.trim())
      .filter((word) => word.length >= 2)
    const matchedHeading = headingTexts.find((text2) => keywords.some((word) => text2.includes(word)))

    // 2) 内容里有没有
    const signal = CONTENT_SIGNALS[section.key]
    const hasContent = signal ? signal.test(body) : false

    let status = 'missing'
    if (matchedHeading || hasContent) {
      // 有内容就算 present；只是标题没对上时仍然是 present（内容在就行）
      status = 'present'
    } else if (!section.required) {
      status = 'optional'
    }

    return {
      ...section,
      existing: matchedHeading || null,
      // 标出"内容有但标题没对上"，方便作者考虑是否重命名
      headingMismatch: Boolean(hasContent && !matchedHeading),
      status,
    }
  })
}

/**
 * 生成骨架大纲（Markdown 形式，可直接粘进文章）。
 *
 * @param {string} form 文体 id
 * @param {object} options
 * @param {boolean} options.keepExisting 已有小节是否保留标题原文（默认保留）
 * @param {Array} options.headings 现有小标题
 * @returns {{markdown, sections, missing, form}}
 */
export function buildSkeleton(form, options = {}) {
  const skeleton = FORMS[form]
  if (!skeleton) {
    throw new Error(`未知文体 ${form}，可用：${Object.keys(FORMS).join(' / ')}`)
  }
  const aligned = alignSections(form, options.headings, options.text)
  const keepExisting = options.keepExisting !== false

  const lines = []
  for (const section of aligned) {
    const headingText = keepExisting && section.existing ? section.existing : section.heading
    lines.push(`## ${headingText}`)
    lines.push('')
    if (section.status === 'present') {
      const hint = section.headingMismatch
        ? '内容已有但标题不叫这个，可考虑重组：' + section.prompt
        : '已有内容，检查是否覆盖了：' + section.prompt
      lines.push('<!-- ' + hint + ' -->')
    } else if (section.status === 'missing') {
      lines.push('<!-- 待写：' + section.prompt + ' -->')
    } else {
      lines.push('<!-- ' + section.prompt + ' -->')
    }
    lines.push('')
  }

  return {
    form,
    label: skeleton.label,
    markdown: lines.join('\n').trimEnd(),
    sections: aligned,
    missing: aligned.filter((item) => item.status === 'missing').map((item) => item.heading),
    optional: aligned.filter((item) => item.status === 'optional').map((item) => item.heading),
  }
}

/** 给 CLI/面板用的一句话说明：这个骨架在要求什么。 */
export function describeSkeleton(result) {
  if (!result) return ''
  const parts = [`文体：${result.label}（${FORMS[result.form].when}）`]
  if (result.missing.length) {
    parts.push(`还缺 ${result.missing.length} 节：${result.missing.join('、')}`)
  } else {
    parts.push('必需的小节都齐了')
  }
  if (result.optional.length) parts.push(`可选：${result.optional.join('、')}`)
  return parts.join('\n')
}
