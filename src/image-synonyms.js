/**
 * 图片同义词表 —— 让「架构图」也能匹配到「分层」「模块」「拓扑」。
 *
 * ## 为什么需要
 * 素材库里一张图叫「架构图」，而正文可能写成：
 *   "这一节讲模块怎么分层" / "各层之间怎么通信" / "调用链是这样的"
 * 只要字面不同，字面匹配就失效。同义词表把这类说法归到同一个概念。
 *
 * ## 设计约束
 * 1. **表要能改**：放数据不写死在逻辑里，以后加词只改这里。
 * 2. **分组要有边界**：一组同义词代表"同一个视觉概念"，
 *    不能把"架构"和"截图"混在一组——它们对应的图完全不同。
 * 3. **宁可少不要错**：只收语义确实等价的词。收得太宽会导致乱配图，
 *    而乱配比不配更糟（读者看到无关的图会困惑）。
 *
 * ## 与文件名命名的关系
 * 见 `naming-guide.js` 的 NAMING_GUIDE：文件名前缀建议用这里的**组名**，
 * 这样前缀一出现，整组同义词都会参与匹配。
 */

/**
 * 概念组：`id` 是规范名（建议用作文件名前缀），`aliases` 是所有等价说法。
 * 顺序有意义：靠前的组更容易命中（泛用度高的放前面反而会抢），
 * 所以把**具体的**放前面，泛的放后面。
 */
export const CONCEPT_GROUPS = [
  /* ── 结构类图（正文里常被描述为"怎么分层/怎么组织"）── */
  {
    id: '架构',
    label: '架构 / 结构',
    aliases: ['架构', '分层', '模块', '拓扑', '组件图', '系统设计', '整体设计', '组织方式', '分层设计', '结构'],
  },
  {
    id: '流程',
    label: '流程 / 步骤',
    aliases: ['流程', '步骤', '时序', '调用链', '执行过程', '工作流', '链路', '先后顺序', '怎么走'],
  },
  {
    id: '数据流',
    label: '数据流 / 数据走向',
    aliases: ['数据流', '数据走向', '数据经过', '数据怎么流', '输入输出', '管道', '数据链路'],
  },
  {
    id: '状态',
    label: '状态 / 生命周期',
    // id 必须包含在别名里：否则 expandSynonyms('状态') 查不到自己，
    // 一张叫「状态.png」的图永远不会匹配。
    aliases: ['状态', '状态机', '生命周期', '状态流转', '状态变化', '各个阶段'],
  },

  /* ── 运行证据类（最常被当作"凭证"插图）── */
  {
    id: '截图',
    label: '界面 / 屏幕截图',
    // ⚠ 删掉了「是这样的」「长什么样」：实测它们会在任何文章里误命中，
    // 一句话结尾说「是这样」就被判成"这里有截图"，等于噪音。
    // 同义词必须能独立表达"这是屏幕画面"，否则不收。
    aliases: ['截图', '界面', '屏幕', '页面', '控制台画面', '软件界面'],
  },
  {
    id: '终端',
    label: '终端 / 命令行',
    aliases: ['终端', '命令行', '黑框', 'shell', '控制台', '敲命令', '执行结果'],
  },
  {
    id: '报错',
    label: '报错 / 异常',
    aliases: ['报错', '错误', '异常', '失败', '堆栈', 'stack', 'error', '红字'],
  },
  {
    id: '日志',
    label: '日志 / 输出',
    aliases: ['日志', '输出', '打印', 'log', '回显'],
  },

  /* ── 对比与数据类 ── */
  {
    id: '对比',
    label: '对比 / 比较',
    aliases: ['对比', '比较', '前后', '左边右边', '优于', '差异', '差别'],
  },
  {
    id: '性能',
    label: '性能 / 指标',
    aliases: ['性能', '指标', '基准', '压测', 'benchmark', '耗时', '延迟', '吞吐', 'qps'],
  },
  {
    id: '图表',
    label: '图表 / 曲线',
    aliases: ['图表', '曲线', '柱状图', '折线图', '趋势', '增长曲线'],
  },
  {
    id: '表格',
    label: '表格 / 矩阵',
    aliases: ['表格', '矩阵', '对照表', '清单'],
  },

  /* ── 内容素材类（非技术图）── */
  {
    id: '工业',
    label: '工业 / 制造',
    aliases: ['工业', '工厂', '产线', '车间', '设备', '制造', '自动化'],
  },
  {
    id: '红包',
    label: '红包 / 活动奖励',
    aliases: ['红包', '利是', '压岁钱', '奖励', '福利', '优惠券'],
  },
  {
    id: '吉祥物',
    label: '吉祥物 / 形象',
    aliases: ['吉祥物', '形象', '玩偶', '卡通', '代言'],
  },
  {
    id: '海报',
    label: '海报 / 宣传图',
    aliases: ['海报', '宣传图', 'banner', '横幅', '推广图'],
  },
  {
    id: '人物',
    label: '人物 / 团队',
    aliases: ['人物', '团队', '合影', '头像', '同事', '成员'],
  },
  {
    id: '场景',
    label: '场景 / 实景',
    aliases: ['场景', '实景', '现场', '办公', '会议室'],
  },
]

/** 规范名 → 组的索引。 */
const BY_ID = new Map(CONCEPT_GROUPS.map((group) => [group.id, group]))

/**
 * 把一个词扩展成它的整组同义词。
 * @param {string} word 文件名里抽出的词或用户输入
 * @returns {{groupId, aliases: string[]}} 找不到就返回该词自身
 */
export function expandSynonyms(word) {
  const needle = String(word || '').toLowerCase().trim()
  if (!needle) return { groupId: '', aliases: [] }

  /**
   * 去掉图类后缀再匹配。
   * 实测：「架构图」直接查表查不到，因为表里是「架构」。
   * 但用户命名时几乎一定会写「架构图.png」——不带这一层剥壳，同义词表等于白做。
   */
  const SUFFIXES = ['图', '截图', '示意图', '草图', '照片']
  const core = needle.replace(new RegExp(`(${SUFFIXES.join('|')})$`), '').trim() || needle

  for (const group of CONCEPT_GROUPS) {
    if (group.id.toLowerCase() === core) {
      return { groupId: group.id, aliases: group.aliases.slice() }
    }
    if (group.aliases.some((alias) => alias.toLowerCase() === core)) {
      return { groupId: group.id, aliases: group.aliases.slice() }
    }
  }
  // 剥壳后仍查不到：把原词（含后缀）也带上，让精确匹配还有机会
  return { groupId: '', aliases: [needle] }
}

/**
 * 一次性把一组词全部扩展（去重）。
 * 这是匹配时真正调用的入口。
 */
export function expandAll(words) {
  const out = new Set()
  const groups = new Set()
  for (const word of words || []) {
    const key = String(word || '').toLowerCase().trim()
    if (!key) continue
    out.add(key)
    const { groupId, aliases } = expandSynonyms(key)
    if (groupId) {
      groups.add(groupId)
      for (const alias of aliases) out.add(alias.toLowerCase())
    }
  }
  return { terms: [...out], groups: [...groups] }
}

/**
 * 判断一段文本里是否出现了某个概念组（用于给匹配结果加"概念命中"分）。
 * 返回命中的别名列表。
 */
export function matchGroups(text) {
  const haystack = String(text || '').toLowerCase()
  const hits = []
  for (const group of CONCEPT_GROUPS) {
    const matched = group.aliases.filter((alias) => haystack.includes(alias.toLowerCase()))
    if (matched.length) hits.push({ groupId: group.id, label: group.label, matched })
  }
  return hits
}

/** 供 CLI/面板展示：所有概念组（命名时可选的前缀）。 */
export function listConceptGroups() {
  return CONCEPT_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    aliasCount: group.aliases.length,
  }))
}
