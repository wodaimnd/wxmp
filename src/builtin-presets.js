/**
 * 内置预设：三个不同文风的写作提示词 + 打分标准。
 *
 * 为什么需要「不同标准」而不是一个：公众号有完全不同的两种活——
 *  短平快（通知、三点式、案例拆解）本来就该短段短句、少小节；
 *  深度长文（复盘、方法论）段长一点、小节多一点是正常的。
 *  用同一把尺子量，短稿会被嫌「没结构」、长稿会被嫌「太啰嗦」，分数就失去意义。
 *
 * 每个预设都只动**阈值与权重**，规则引擎（16 条检查）完全共用——
 * 这样「换个标准」不会换出一套跑不通的代码，只是同一套规则的松紧不同。
 *
 * 1.8.0 起每个预设多带一份 **style**（风格提示词）：
 * 预设的第一身份是「教 AI 怎么写」，打分只是写完后的复核。
 * style 会落成预设目录里的 style.md，`article preset prompt` 把它和阈值节奏
 * 拼成一份完整写作提示词交给写作侧；改阈值不必同步改 style，两份各管各的。
 */

import { BUILTIN } from './presets.js'

/** standard 的风格提示词（BUILTIN 在 presets.js 里不带 style，避免数据层掺文案）。 */
const STANDARD_STYLE = `「标准公众号」的写法 —— 通用长文，信息密度优先，观点要带证据。

开头：三段内进入正题。第一段给读者一个停下来的理由（具体场景、具体处境或一个反差），行业背景一律压到正题之后。
段落：一段只讲一件事，到 200 字就在语义断开处换段。读者在手机上读，每段三四行就该喘口气。
小节：3~8 个 ## 小节当路标，每个 15 字以内，写「这节讲什么」，不写抒情句。
语气：像给同事讲一件刚跑通的事。判断后面跟依据（实测数字、命令输出、截图、出处）；「进行」「实现」「赋能」一律还原成具体动作。
句子：60 字以内。长句拆短句，主语先出现。
结尾：给下一步动作（跑哪个命令、改哪个文件、按什么顺序验证），不是「希望对你有帮助」。
忌：同构排比连用、「不是 A 而是 B」的翻案腔、机构腔开场（「随着…的发展」）。`

/** short-punch 的风格提示词。 */
const SHORT_PUNCH_STYLE = `「短平快」的写法 —— 一篇只讲一件事，读完只要两三分钟。

开头：80 字内必须出现钩子，三选一：一个反常数字、一句直问读者处境的话、一句推翻共识的实测结论。删光铺垫，第一句就是事件本身。
段落：120 字以内一段，一两句一段也正常。碎片化阅读，密度靠短段堆出来。
小节：2~5 个就够，每节一个要点；单点心得不到 500 字可以不分节。
句子：45 字以内，越短越冲。形容词能删就删，动词和数字保留。
标题方向：痛点式（还在手动…？）或数字式（三步搞定…），26 字以内。
结尾：一句话给动作（命令、链接、一个明确判断），不总结不升华。
忌：把通知写成散文；三个要点硬撑成十个小节。`

/** deep-longform 的风格提示词。 */
const DEEP_LONGFORM_STYLE = `「深度长文」的写法 —— 复盘、方法论、长案例，结构层次优先，素材密度撑住篇幅。

结构：4~10 个小节，每节推进一层（背景 → 决策 → 实测 → 边界 → 结论），节与节之间能看出递进，不并列凑数。
段落：可以到 300 字，但一段只讲一件事；转折处宁可断段。
素材：每个关键判断跟一手材料（实测数据、命令输出、截图、出处）。没有材料支撑的判断降级成「我的猜测」，并明说。
句子：允许 80 字长句容纳复杂逻辑，但主语必须先出现，从句不超过两层。
开头：先给问题或处境，再给背景；背景压到一节以内。
结尾：诚实写边界（什么条件下结论成立、什么情况没验证），下一步给方向而不是口号。
忌：把长度当深度注水；同一论点换三种说法反复讲。`

export const PRESETS = [
  {
    ...BUILTIN, // standard：出厂默认，兜底用
    style: STANDARD_STYLE,
  },
  {
    id: 'short-punch',
    name: '短平快三点式',
    description: '通知 / 案例 / 观点短稿：鼓励 2~5 个小节、短句短段，更要紧的是开头有钩子。适合同步更新、活动通知、单点方法论。',
    order: 20,
    style: SHORT_PUNCH_STYLE,
    thresholds: {
      paragraphLong: 120, // 短稿里 120 字就该拆了
      paragraphHuge: 200,
      paragraphAvg: 90,
      sentenceLong: 45,
      headingLong: 12,
      sectionsMin: 2,
      sectionsMax: 5,
      codeLinesWarn: 12,
      tableColsWarn: 4,
      hookChars: 80,
      passScore: 80,
    },
    // 短稿里结构要求相对低（2 个小节也合格），可读性和钩子权重抬高
    // 短稿的成败在标题和开头钩子，所以 content 抬到与 readability 并列最高
    weights: { limits: 20, structure: 15, readability: 25, assets: 15, content: 25 },
  },
  {
    id: 'deep-longform',
    name: '深度长文',
    description: '复盘 / 方法论 / 长案例：允许更长的段落与小节数，重点看结构层次与素材完整度，而不是一味嫌长。适合认真写的长文。',
    order: 30,
    style: DEEP_LONGFORM_STYLE,
    thresholds: {
      paragraphLong: 300,
      paragraphHuge: 450,
      paragraphAvg: 240,
      sentenceLong: 80,
      headingLong: 20,
      sectionsMin: 4,
      sectionsMax: 10,
      codeLinesWarn: 30,
      tableColsWarn: 6,
      hookChars: 150,
      passScore: 75, // 长文本来就难拿高分，及格线略低
    },
    // 长文更看重结构层次与素材（图表、案例、引用）
    // 长文靠结构层次撑住，content 让一部分给 structure
    weights: { limits: 20, structure: 30, readability: 20, assets: 15, content: 15 },
  },
]

/** 按 id 找内置预设；找不到返回 null（调用方自己决定是否报错）。 */
export function builtinPresetById(id) {
  return PRESETS.find((preset) => preset.id === id) || null
}
