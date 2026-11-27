/**
 * 素材命名规范 —— 一份可照着用的命名表。
 *
 * ## 为什么需要
 * 素材库的匹配完全靠文件名。实测你的 41 张图里 35 张叫
 * `粘贴图片_20240201231712.png` / `_c4e7623c-82dd-...jpg`，
 * 这些名字对匹配零信息量，等于这些图永远用不上。
 *
 * 改名是**一次性成本、长期收益**的动作。但改也要改对：
 * 随便改成「图1」「截图A」跟没改一样。所以这里定一套格式。
 *
 * ## 格式的由来
 * 格式不是拍脑袋定的，是**由匹配逻辑反推**出来的：
 *   - 匹配靠「词」，所以名字里必须有能对应到正文的词 → 需要「内容」段
 *   - 同义词表按「概念组」扩展，所以前缀用组名能一次覆盖一组说法 → 需要「图类」段
 *   - 顺序影响可读性，靠前的词更容易被扫到 → 组名放最前
 *
 * 于是格式是：`<图类>-<具体内容>[-<补充>].<扩展名>`
 */

import { CONCEPT_GROUPS } from './image-synonyms.js'

/**
 * 图类前缀 —— 与 `image-synonyms.js` 的 CONCEPT_GROUPS.id 一一对应。
 *
 * 用这个前缀的好处：前缀一出现，整组同义词都会参与匹配。
 * 例如 `架构图-插件加载` 会自动匹配正文里的「分层」「模块」「拓扑」「系统设计」。
 */
export const TYPE_PREFIXES = CONCEPT_GROUPS.map((group) => ({
  prefix: group.id,
  meaning: group.label,
  /** 什么时候用这个前缀（给用户看的判断依据） */
  when: {
    架构: '画系统/模块怎么分层、怎么组成',
    流程: '画步骤顺序、调用链、时序',
    数据流: '画数据从哪来到哪去',
    状态: '画状态机、生命周期、阶段变化',
    截图: '软件界面、网页、App 画面',
    终端: '命令行窗口、shell 输出',
    报错: '错误弹窗、堆栈、异常提示',
    日志: '日志片段、控制台输出',
    对比: '左右并排、前后对照',
    性能: '耗时、延迟、吞吐的度量结果',
    图表: '柱状图、折线图、趋势图',
    表格: '对照表、矩阵、清单',
    工业: '工厂、产线、设备实景或示意',
    红包: '红包、奖励、福利相关',
    吉祥物: '品牌形象、玩偶、卡通角色',
    海报: '宣传图、banner、推广物料',
    人物: '人物照片、团队合影',
    场景: '办公现场、实景照片',
  }[group.id] || group.label,
  aliasCount: group.aliases.length,
}))

/** 命名规则的正例与反例。 */
export const NAMING_EXAMPLES = {
  good: [
    {
      name: '架构图-插件加载.png',
      why: '前缀「架构图」触发整组同义词；「插件加载」是具体内容，能精确匹配',
    },
    {
      name: '终端截图-401报错.png',
      why: '命中「终端」和「报错」两组，正文提到"命令行"或"红字"都能配上',
    },
    {
      name: '流程-鉴权链路.png',
      why: '「流程」组覆盖"步骤/时序/调用链"，正文怎么说都能匹配',
    },
    {
      name: '对比-两方案性能.png',
      why: '同时命中「对比」与「性能」两组',
    },
    {
      name: '红包-春节活动.png',
      why: '非技术图也照同一套格式，前缀用概念组名',
    },
  ],
  bad: [
    { name: '粘贴图片_20240201231712.png', why: '零信息量，永远匹配不上' },
    { name: 'image1.png', why: '没有内容描述' },
    { name: '截图.png', why: '只有图类没有内容，会匹配到所有提到截图的段落' },
    { name: '插件加载.png', why: '没有图类前缀，同义词扩展不了' },
    { name: '插件加载最终版v2改.png', why: '混了版本与流程词，且过长' },
    { name: '架构图插件加载详情页设计稿终稿.png', why: '太长，后台列表里显示不全' },
  ],
}

/** 分隔符与长度约束。 */
export const NAMING_RULES = {
  /** 段落分隔符：短横线最稳（下划线在某些工具里会被当特殊字符） */
  separator: '-',
  /** 建议最大字符数（不含扩展名）：公众号后台列表宽度有限，太长会截断看不见内容 */
  maxLength: 24,
  /** 扩展名：微信素材库只接受这几种 */
  extensions: ['.png', '.jpg', '.jpeg', '.gif', '.bmp'],
}

/**
 * 在一段文件名里找出图类前缀。
 *
 * ## 为什么要容忍这些变体
 * 实测用户会写成「架构图-xxx」「架构示意图-xxx」「终端截图-xxx」——
 * 都带了「图/截图」后缀。如果严格要求前缀必须与组名一字不差，
 * 90% 的真实命名都会被判违规，规范就成了摆设。
 *
 * 返回 `{ prefix, consumed }`：consumed 是前缀在原文里占掉的长度，
 * 调用方用它切出后面的「具体内容」。
 */
function findTypePrefix(base) {
  // 长前缀优先匹配，避免「终端截图」被「终端」抢先吃掉
  const sorted = [...TYPE_PREFIXES].sort((a, b) => b.prefix.length - a.prefix.length)
  for (const item of sorted) {
    // 允许前缀后跟 图/截图/示意图 这类后缀
    const pattern = new RegExp(`^(${item.prefix}(?:图|截图|示意图|草图)?)(?=[-_]|$)`)
    const match = pattern.exec(base)
    if (match) {
      return { prefix: item.prefix, matchedText: match[1], consumed: match[1].length }
    }
  }
  return null
}

/**
 * 校验一个文件名是否符合规范。
 * @returns {{ok: boolean, issues: string[], suggestion: string}}
 */
export function validateName(name) {
  const raw = String(name || '').trim()
  const issues = []

  if (!raw) return { ok: false, issues: ['文件名为空'], suggestion: '' }

  const ext = (raw.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()
  const base = raw.replace(/\.[a-z0-9]+$/i, '')

  if (!ext) issues.push('缺少扩展名')
  else if (!NAMING_RULES.extensions.includes(ext)) {
    issues.push(`扩展名 ${ext} 不被微信素材库接受（只收 ${NAMING_RULES.extensions.join(' / ')}）`)
  }

  if (base.length > NAMING_RULES.maxLength) {
    issues.push(`名称 ${base.length} 字，建议 ≤ ${NAMING_RULES.maxLength}（后台列表会截断）`)
  }

  const found = findTypePrefix(base)
  if (!found) {
    issues.push(`开头不是图类前缀（可用：${TYPE_PREFIXES.slice(0, 6).map((p) => p.prefix).join(' / ')} …）`)
  }

  // 前缀之后的部分就是具体内容
  const rest = found ? base.slice(found.consumed).replace(/^[-_]/, '') : base

  if (found && !rest) {
    issues.push('只有图类没有具体内容，会匹配到所有同类段落')
  }

  // 噪音词
  if (/粘贴图片|未命名|最终版|终稿|副本|\(\d+\)/.test(base)) {
    issues.push('含"粘贴图片/终稿/副本"等噪音词，建议删掉')
  }

  let suggestion = ''
  if (issues.length) {
    const prefix = found ? found.prefix : ''
    // 内容段：去掉噪音词与版本痕迹，截到合理长度
    const cleaned = rest
      .replace(/粘贴图片|未命名|最终版|终稿|副本|\(\d+\)/g, '')
      .replace(/[_]/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, NAMING_RULES.maxLength - 6)

    /**
     * 只在能给出**有意义**的建议时才给。
     *
     * 实测反例：`cover.png` 被建议成 `架构-cover.png`，`工业AI.jpg` 被建议成 `架构-工业AI.jpg`。
     * 前缀是我瞎猜的，内容段也没信息量 —— 这种建议比不给更糟，
     * 用户照着改了还是一样匹配不上，还多花了时间。
     *
     * 所以：不知道图类就不填图类；内容段无意义就不给建议，只说明问题。
     */
    const contentMeaningful = cleaned && !/^[a-z0-9-]+$/i.test(cleaned) && cleaned.length >= 2
    if (prefix && contentMeaningful) {
      suggestion = `${prefix}-${cleaned}${ext || '.png'}`
    } else if (contentMeaningful) {
      // 有内容但不知道图类 → 只补内容段，让用户自己选前缀
      suggestion = `<图类>-${cleaned}${ext || '.png'}`
    }
    // 两者都没有：不给建议（说明问题就够了）
  }

  return { ok: issues.length === 0, issues, suggestion, prefix: found ? found.prefix : '' }
}

/**
 * 生成给人看的命名规范表（Markdown）。
 */
export function buildNamingGuide() {
  const lines = []

  lines.push('# 素材命名规范')
  lines.push('')
  lines.push('## 格式')
  lines.push('')
  lines.push('```')
  lines.push(`<图类>-<具体内容>${NAMING_RULES.extensions[0]}`)
  lines.push('```')
  lines.push('')
  lines.push(`- 分隔符用短横线 \`${NAMING_RULES.separator}\``)
  lines.push(`- 图类 + 内容合计建议 ≤ ${NAMING_RULES.maxLength} 字（后台列表会截断，太长看不见重点）`)
  lines.push(`- 扩展名只用：${NAMING_RULES.extensions.join(' / ')}`)
  lines.push('')
  lines.push('## 为什么这样命名')
  lines.push('')
  lines.push('自动插图靠**文件名里的词**去匹配正文。图类前缀能触发**同义词扩展**：')
  lines.push('')
  lines.push('| 前缀 | 一次覆盖这些说法 |')
  lines.push('|---|---|')
  for (const group of CONCEPT_GROUPS.slice(0, 8)) {
    lines.push(`| \`${group.id}\` | ${group.aliases.slice(0, 6).join('、')} … |`)
  }
  lines.push('')
  lines.push('也就是说 `架构图-插件加载.png` 会自动匹配正文里的「分层」「模块」「拓扑」「系统设计」，')
  lines.push('你不用在正文里写"架构图"三个字。')
  lines.push('')
  lines.push('## 图类前缀可选值')
  lines.push('')
  lines.push('| 前缀 | 含义 | 什么时候用 |')
  lines.push('|---|---|---|')
  for (const item of TYPE_PREFIXES) {
    lines.push(`| \`${item.prefix}\` | ${item.meaning} | ${item.when} |`)
  }
  lines.push('')
  lines.push('## 正例')
  lines.push('')
  for (const item of NAMING_EXAMPLES.good) {
    lines.push(`- \`${item.name}\``)
    lines.push(`  ${item.why}`)
  }
  lines.push('')
  lines.push('## 反例')
  lines.push('')
  for (const item of NAMING_EXAMPLES.bad) {
    lines.push(`- \`${item.name}\` —— ${item.why}`)
  }
  lines.push('')
  lines.push('## 检查自己的命名')
  lines.push('')
  lines.push('```')
  lines.push('wxmp article library --check "你的文件名.png"')
  lines.push('```')
  lines.push('')
  lines.push('会指出哪里不符合规范，并给出建议名称。')

  return lines.join('\n')
}
