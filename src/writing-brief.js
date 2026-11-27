/**
 * 写作任务书 —— 把 skill 的四步流程变成一份可执行的作业单。
 *
 * ## 来源
 * `wechat-article-writer` 的四步：
 *   Step 1 搜索资料（并行搜多源、优先最新、深度总结）
 *   Step 2 撰写文章（1000-1500 字、故事化开头、结构：效果展示 → 问题 → 步骤 → 升华）
 *   Step 3 生成标题（5 个，痛点/数字/结果/情绪/悬念）
 *   Step 4 排版优化（段落 3-5 行、配图位置、代码块留白、金句单独成段）
 *
 * 以及 `md2wechat/references/writing/workflow.md` 的硬约束：
 *   区分事实与观点、不能编造数字/案例/来源、冲突不随意选边、
 *   不覆盖源文件、仅写文章时不自动发布。
 *
 * ## 这个模块做什么
 * **不做生成，只做编排**。输出一份任务书，交给调用方（agent 或人）执行。
 *
 * 为什么这样设计：写作本身需要判断力与素材，wxmp 既不联网搜资料、也不调 LLM。
 * 但"该搜什么、按什么结构写、标题往哪个方向起、写完检查什么"——
 * 这些是可以事先定好的，而且**定好之后写起来快得多**。
 *
 * 这也是 skill 文档自己的主张：md2wechat 的 title suggest 明确说它
 * "emits a host-Agent AI request and does not choose or write the final title"。
 */

import { FORMS } from './outline-lab.js'

/** 每个文体的写作提示（来自 forms.md 对各体裁的组织要求）。 */
const FORM_GUIDE = {
  tutorial: {
    structure: '效果展示 → 问题描述 → 步骤教学 → 失败边界 → 升华总结',
    watchOut: ['步骤必须可复现（给出环境和版本）', '必须写失败边界，否则读者卡住时无从下手'],
  },
  comparison: {
    structure: '问题 → 比较口径 → 逐项对比 → 各自适用场景 → 结论',
    watchOut: ['缺数据的维度写"未验证"，不要猜', '数据不足时明确说"不足以判断胜负"'],
  },
  case: {
    structure: '背景 → 行动 → 真实结果 → 经验边界 → 回看结论',
    watchOut: ['不要只报喜，真实结果包含不理想的部分', '经验要写清楚在什么条件下成立'],
  },
  explainer: {
    structure: '读者的问题 → 它是什么 → 怎么工作 → 谁适合 → 限制 → 真实例子',
    watchOut: ['定义要能独立读懂', '要写不适用的人群，避免误用'],
  },
}

/**
 * 生成写作任务书。
 *
 * @param {object} options
 * @param {string} options.topic 主题（必填）
 * @param {string} [options.form] 文体；不给就按主题猜
 * @param {string} [options.audience] 目标读者
 * @param {string} [options.angle] 切入角度
 * @param {number} [options.words] 目标字数
 * @param {string} [options.file] 已有文章路径（改稿场景）
 * @param {object} [options.info] 已有文章的结构信息
 * @param {string} [options.styleSection] 预设风格节（完整 Markdown，含节奏参考）；
 *   调用方用 composePresetPrompt 拼好传进来——本模块不 import 预设层，
 *   任务书保持「只编排，不读盘」的边界。
 */
export function buildWritingBrief(options = {}) {
  const topic = String(options.topic || '').trim()
  const form = options.form && FORMS[options.form] ? options.form : guessForm(topic)
  const guide = FORM_GUIDE[form] || FORM_GUIDE.explainer
  const skeleton = FORMS[form]
  const words = Number(options.words) > 0 ? Number(options.words) : 1200
  const audience = String(options.audience || '').trim()
  const angle = String(options.angle || '').trim()
  const isRevision = Boolean(options.file)
  const styleSection = String(options.styleSection || '').trim()

  const parts = []

  parts.push(`# 写作任务书${isRevision ? '（改稿）' : ''}`)
  parts.push('')
  parts.push(`**主题**：${topic || '(未指定)'}`)
  parts.push(`**文体**：${skeleton.label} —— ${skeleton.when}`)
  if (audience) parts.push(`**目标读者**：${audience}`)
  if (angle) parts.push(`**切入角度**：${angle}`)
  parts.push(`**目标篇幅**：约 ${words} 字`)
  parts.push('')

  /* ── 风格：写之前给，而不是扣分之后再改 ── */
  if (styleSection) {
    parts.push(styleSection)
    parts.push('')
  }

  /* ── Step 1 资料 ── */
  parts.push('## 第一步：先找资料，别急着写')
  parts.push('')
  parts.push('开工前先确认这三件事，缺哪件就先补哪件：')
  parts.push('')
  parts.push('1. **要回答读者什么问题**——用一句话写下来，写不出说明还没想清楚')
  parts.push('2. **有哪些一手材料**——自己跑过的、查过的、能给出处的')
  parts.push('3. **哪些是不知道的**——明确标出来，不要用推测填空')
  parts.push('')
  parts.push('建议的搜索方向（按重要性排序）：')
  for (const query of suggestQueries(topic, form)) {
    parts.push(`- ${query}`)
  }
  parts.push('')
  parts.push('> 硬约束：不能编造价格、经历、案例、排名或来源。')
  parts.push('> 数字与效果声明要么给得出出处，要么不写具体数值。')
  parts.push('')

  /* ── Step 2 结构 ── */
  parts.push('## 第二步：按这个结构写')
  parts.push('')
  parts.push(`推荐主线：**${guide.structure}**`)
  parts.push('')
  parts.push('小节骨架：')
  for (const section of skeleton.sections) {
    const mark = section.required ? '（必需）' : '（可选）'
    parts.push(`- **${section.heading}**${mark}：${section.prompt}`)
  }
  parts.push('')
  parts.push('这个文体要特别注意：')
  for (const item of guide.watchOut) parts.push(`- ${item}`)
  parts.push('')

  /* ── 开头 ── */
  parts.push('### 开头怎么写')
  parts.push('')
  parts.push('第一段要让读者停下来。三选一：')
  parts.push('- **场景**：一个具体的时间地点人物事件（"那天我打开终端，看到…"）')
  parts.push('- **读者处境**：直接问他（"你是不是也遇到过…"）')
  parts.push('- **反差**：先立共识再推翻（"都说这个方案更快，但我实测下来…"）')
  parts.push('')
  parts.push('不要用"随着…的发展""在当今…"这类开头，读者会立刻划走。')
  parts.push('')

  /* ── Step 3 标题 ── */
  parts.push('## 第三步：起标题')
  parts.push('')
  parts.push('写完正文再起标题——正文写完你才知道真正想说什么。')
  parts.push('')
  parts.push('出 5 个候选，每个走一个方向：')
  parts.push('')
  parts.push('| 方向 | 公式 | 适合什么 |')
  parts.push('|---|---|---|')
  parts.push('| 痛点式 | 还在手动…？ | 读者正在经历的具体麻烦 |')
  parts.push('| 数字式 | N 个/N 步 + 主题 | 能让工作量可感知 |')
  parts.push('| 结果式 | 主题：具体收益 | 收益能用一句话说清 |')
  parts.push('| 反常识式 | 都以为…其实… | 文章有推翻常识的内容 |')
  parts.push('| 方法式 | 怎么把…做对 | 有明显的可操作路径 |')
  parts.push('')
  parts.push('约束：每个 ≤ 26 字；前 10 字就要有钩子；不用"震惊""必看""99%"这类空喊。')
  parts.push('')
  parts.push('可用命令：`wxmp article titles --file <文章>` 会给出机械候选与打分。')
  parts.push('')

  /* ── Step 4 自查 ── */
  parts.push('## 第四步：写完自己过一遍')
  parts.push('')
  parts.push('| 检查项 | 怎么算过关 |')
  parts.push('|---|---|')
  parts.push('| 段落 | 每段 ≤ 200 字，超过就在语义断开处切一刀 |')
  parts.push('| 句子 | 单句 ≤ 60 字，超长句拆成两句 |')
  parts.push('| 小标题 | 3~8 个，每个 ≤ 15 字 |')
  parts.push('| 金句 | 至少有一句能单独成段（≤ 40 字） |')
  parts.push('| 依据 | 每个"实测/数据"都能指出证据 |')
  parts.push('| 开头 | 第一段有场景/读者处境/反差之一 |')
  parts.push('| 结尾 | 给出下一步动作，不是"希望对你有帮助" |')
  parts.push('')
  parts.push('跑一次体检会把上面这些逐条查出来：')
  parts.push('```')
  parts.push('wxmp article review --file <文章>')
  parts.push('```')
  parts.push('')

  /* ── 边界 ── */
  parts.push('## 修完别自动发')
  parts.push('')
  parts.push('任务到"文章写好、体检通过"为止。建草稿与发表是另外两步，需要单独确认：')
  parts.push('```')
  parts.push('wxmp cover --file <文章>          # 生成封面')
  parts.push('wxmp draft create --file <文章>   # 进草稿箱')
  parts.push('```')

  return {
    topic,
    form,
    formLabel: skeleton.label,
    words,
    markdown: parts.join('\n'),
  }
}

/** 按主题猜文体（关键词很弱，只用于给建议）。 */
export function guessForm(topic) {
  const text = String(topic || '')
  if (/教程|怎么|如何|步骤|上手|配置|部署|安装/.test(text)) return 'tutorial'
  if (/对比|比较|选哪个|vs|还是/.test(text)) return 'comparison'
  if (/复盘|踩坑|经历|案例|项目/.test(text)) return 'case'
  return 'explainer'
}

/** 给出与该主题相关的搜索方向建议（去重，避免同一句重复四遍）。 */
export function suggestQueries(topic, form) {
  const base = String(topic || '').trim()
  if (!base) return ['(先确定主题)']
  const common = [
    `「${base}」的官方文档或权威说明`,
    `「${base}」最近一年的实践记录与踩坑`,
  ]
  const extra = {
    tutorial: ['完整步骤与环境要求', '常见报错与解决'],
    comparison: ['对比评测（注意看测试口径）', '各方在什么场景下更合适'],
    case: ['类似的真实项目复盘', '失败案例与限制条件'],
    explainer: ['核心机制拆解', '它不适合什么场景'],
  }[form] || []
  // 后半段只写补语，不重复主题词，避免四行长得一样
  return [...common, ...extra.map((item) => `「${base}」${item}`)]
}
