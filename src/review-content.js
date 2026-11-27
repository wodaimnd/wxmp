/**
 * 内容层体检规则 —— 把公众号写作 skill 的判断标准变成可执行检查。
 *
 * ## 来源
 * 这些规则不是我自己想的，是从本机装的 skill 文档里提炼的判断标准：
 *
 * | 规则 | 来源 |
 * |---|---|
 * | 标题要有具体数字/痛点 | `wechat-article-writer` Step 3「爆款标题」五特点 |
 * | 开头要有钩子 | 同上 Step 2「故事化开头，带情感色彩」 |
 * | 事实与观点要分开 | `md2wechat/references/writing/workflow.md`〈事实与依据〉 |
 * | 不能编造数字/案例/来源 | 同上「不能编造价格、经历、案例、排名或来源」 |
 * | 段落 3~5 行 | `wechat-article-writer` Step 4「排版优化」 |
 * | 平台适配的表达 | `md2wechat/references/writing/platforms.md` |
 * | 教程类要有步骤与失败边界 | `forms.md`「教程按输入、前提、步骤、可观察结果和失败边界组织」 |
 *
 * ## 为什么单独一个文件
 * 原来的 `review.js` 只管**排版层面**（段落长度、句长、标题层级、封面）。
 * 这批 skill 补的是**内容层面**：说得对不对、有没有依据、标题能不能吸引人。
 * 两类规则混在一个函数里会越来越难改，所以分开。
 *
 * ## 设计约束
 * 每条必须是**可机械判定**的。像「语气要朴素」这种没法测，就不进来。
 * 宁可少几条真能用的，也不要一堆永远通过的假检查。
 */

import { COVER_SIZE } from '../tools/cover-layout.js'

/* ── 标题层 ───────────────────────────────────────────────────── */

/** 标题里出现这些词说明是"结果导向"的表达（skill 明确列出的爆款要素）。 */
const RESULT_WORDS = /效率|省|提升|翻倍|\d+\s*倍|暴涨|搞定|拿下|从.+到|一步|只需|不再|告别|避坑|踩坑/
/** 标题里的数字（含中文数字与百分比）。 */
const NUMBERISH = /\d+|[一二三四五六七八九十百千]+[个种步招条]/
/** 痛点式提问。 */
const PAIN_HOOK = /还在|是不是|为什么|怎么|如何|别再|是不是也|有没有|难道/

/**
 * 标题质量：是否含具体信息（数字/结果/痛点），而不是空洞的名词堆砌。
 * 来源：wechat-article-writer Step 3 的五个特点（痛点/数字/结果/情绪/悬念）。
 */
export function checkTitle(title, push) {
  const text = String(title || '').trim()
  if (!text) return // 空标题由 limits 层报错，这里不重复

  const hasNumber = NUMBERISH.test(text)
  const hasResult = RESULT_WORDS.test(text)
  const hasPain = PAIN_HOOK.test(text)
  const signals = [hasNumber, hasResult, hasPain].filter(Boolean).length

  if (signals === 0) {
    push(
      'info',
      'content',
      'title_vague',
      `标题「${text}」没有具体信息（数字/结果/痛点都没有）`,
      '至少加一样：一个具体数字、一个可为读者带来的结果、或一个他正遇到的问题',
      null,
    )
  } else if (signals === 1 && text.length > 26) {
    // 长标题只靠一个信号撑着，读者在列表里只会看到前 15 个字
    push(
      'info',
      'content',
      'title_weak_signal',
      `标题 ${text.length} 字但只有一种吸引力（数字/结果/痛点之一）`,
      '长标题建议「痛点 + 结果」各来一样，前 15 字就要有钩子',
      null,
    )
  }

  // 纯名词罗列：没有动词也没有标点分隔，读起来像标签
  if (!/[，。：、？！,.:?!]/.test(text) && !/是|把|让|用|做|从|到|就|也|都|才|会|能/.test(text) && text.length > 12) {
    push(
      'info',
      'content',
      'title_noun_pile',
      `标题「${text}」像标签堆砌，没有可读的句子结构`,
      '改成一句能读出来的话，哪怕只加一个动词',
      null,
    )
  }
}

/* ── 开头层 ───────────────────────────────────────────────────── */

/**
 * 开头是否有钩子。
 * 来源：wechat-article-writer Step 2「故事化开头，带情感色彩」+ Step 4 排版建议。
 * 注意：review.js 已有 weak_hook（查问题/数字/反差），这里查的是**更具体的三件事**：
 * 是否直接进入场景、是否点出读者处境、是否太长才进入正题。
 */
export function checkOpening(article, firstParagraph, push) {
  const first = String(firstParagraph || '').trim()
  if (!first) return

  // 开头超过一定长度还没分段 → 手机上第一屏全是字
  if (first.length > 180) {
    push(
      'info',
      'content',
      'opening_too_long',
      `开头第一段 ${first.length} 字，手机第一屏几乎全是字`,
      '把开头压到 100 字以内，先把读者拽进来，细节放后面',
      null,
    )
  }

  // 三个钩子信号：具体场景 / 读者处境 / 一个可感知的对比
  const scene = /那天|昨天|最近|上周|有一次|第一次|当我|我们在|前段时间|前几天|前几天/.test(first)
  const reader = /你|大家|很多人|大多数人|不少人|我们/.test(first)
  const contrast = /但|却|然而|结果|反而|其实|没想到/.test(first)
  const signals = [scene, reader, contrast].filter(Boolean).length

  if (signals === 0 && first.length > 40) {
    push(
      'info',
      'content',
      'opening_flat',
      '开头是平铺直叙，没有场景、没有读者处境、也没有反差',
      '试三选一：给一个具体场景（"那天我…"）、直接问读者（"你是不是…"）、或先立后破（"都说…但"）',
      null,
    )
  }
}

/* ── 事实层：不能编造 ─────────────────────────────────────────── */

/**
 * 可疑的"实测"表述。
 * 来源：platforms.md 的 CSDN 一栏明确列出「未运行却声称实测」为不可制造的内容；
 * workflow.md 也要求「不能编造…案例、排名或来源」。
 *
 * 判定逻辑刻意保守：只在**声称实测但附近没有任何可核对痕迹**时才报。
 * 因为"我测了"这种话如果是真的，文章里通常会有命令、输出、截图、链接之一。
 */
const CLAIM_WORDS = /实测|亲测|测试过|跑过|验证过|试过|跑通|验证通过/
const EVIDENCE_HINTS = /```|`[^`]+`|http|\$ |C:\\|node |npm |python |截图|输出如下|返回|报错|日志/

export function checkClaims(text, push) {
  const body = String(text || '')
  const claims = body.match(new RegExp(CLAIM_WORDS.source, 'g')) || []
  if (!claims.length) return

  const hasEvidence = EVIDENCE_HINTS.test(body)
  if (!hasEvidence) {
    push(
      'info',
      'content',
      'claim_no_evidence',
      `文章里出现 ${claims.length} 处「${claims[0]}」这类断言，但没有任何可核对痕迹`,
      '给一处证据就算数：一段命令与输出、一张截图、一个链接。否则改成「按文档说明…」',
      null,
    )
  }
}

/**
 * 虚假精确的数字。
 * 来源：workflow.md「效果数字、比较优势、价格和时间敏感声明按需要核实」。
 * 这里抓的是最典型的一类：「效率提升 300%」这种没有出处的百分比。
 */
export function checkNumbers(text, push) {
  const body = String(text || '')
  // 百分比 + 效果词。注意"提升了 300%"里有个"了"，
  // 早先的正则写成 `提升\s*\d+%` 匹配不到"提升了 300%"，规则形同虚设。
  const re = /(?:提升|提高|增长|下降|降低|节省|快了?|慢了?|优化|改善)了?\s*(\d{2,4})\s*[%％]/g
  let match
  let reported = 0
  while ((match = re.exec(body)) && reported < 2) {
    const value = Number(match[1])
    // 只报夸张的数字（>50%），小幅改进是合理的
    if (value <= 50) continue
    // 来源检测只看**紧邻的前后半句**：
    // 早先用 ±120/160 字的窗口，会把下一句里的"据官方 benchmark"也算进来，
    // 于是"提升 300%。据官方数据，另一个指标…"被误判成有出处。
    const before = body.slice(Math.max(0, match.index - 40), match.index)
    const after = body.slice(match.index + match[0].length, match.index + match[0].length + 40)
    // 同一句内出现来源词才算有出处（句号/换行打断）
    const sameSentence = (segment) => !/[。！？\n]/.test(segment)
    const sourceWord = /来源|据|参考|测试环境|样本|benchmark|github|文档|官网/i
    const hasSource =
      (sameSentence(before) && sourceWord.test(before.replace(/^[\s\S]*[。！？\n]/, ''))) ||
      (sameSentence(after) && sourceWord.test(after.replace(/[。！？\n][\s\S]*$/, '')))
    if (!hasSource) {
      push(
        'info',
        'content',
        'number_unbacked',
        `「${match[0]}」这样的数字没有出处`,
        '补一句来源（测试环境/样本量/官方文档），或改成"明显变快"这类不给具体数的说法',
        null,
      )
      reported += 1
    }
  }
}

/* ── 结构与体裁层 ─────────────────────────────────────────────── */

/**
 * 教程类文章要有「前提」与「失败边界」。
 * 来源：forms.md「教程按输入、前提、步骤、可观察结果和失败边界组织」。
 *
 * 怎么判断是教程：出现「步骤」「第一步」「安装」「配置」「执行」这类词。
 */
export function checkTutorialCompleteness(article, text, push) {
  const body = String(text || '')
  const isTutorial = /步骤|第一步|首先|安装|配置|执行|运行|命令|输入/.test(body)
  if (!isTutorial) return

  // 前提/环境
  const hasPrereq = /前提|环境|要求|准备|需要先|依赖|版本|Linux|Windows|macOS|Node|Python/i.test(body)
  if (!hasPrereq) {
    push(
      'info',
      'content',
      'tutorial_no_prereq',
      '看起来是教程，但没交代前提（环境、版本、需要先装什么）',
      '开头补一小段：在什么系统/什么版本下、需要先准备什么',
      null,
    )
  }

  // 失败边界：读者照着做会卡在哪
  const hasPitfall = /注意|坑|可能失败|如果报错|常见问题|会失败|不适用|限制|前提是|不支持/.test(body)
  if (!hasPitfall) {
    push(
      'info',
      'content',
      'tutorial_no_pitfall',
      '教程没有写失败边界，读者卡住时不知道是哪里错了',
      '补一处「可能会遇到…，这时…」，比多写十步更有用',
      null,
    )
  }
}

/**
 * 对比/排名类表述要有统一口径。
 * 来源：forms.md「对比按同一口径、适用条件和证据组织，缺数据不评胜负」。
 */
export function checkComparison(text, push) {
  const body = String(text || '')
  const isComparison = /对比|相比|比.+好|优于|胜过|吊打|不如|强于/.test(body)
  if (!isComparison) return
  // 有没有给出评判依据
  const hasBasis = /口径|测试条件|同一|基准|依据|数据|因为|原因是|在.+场景下/.test(body)
  if (!hasBasis) {
    push(
      'info',
      'content',
      'comparison_no_basis',
      '有对比结论，但没说按什么标准比的',
      '补一句比较口径（同一台机器？同一个数据集？只看启动速度还是整体？）',
      null,
    )
  }
}

/* ── 平台适配层 ───────────────────────────────────────────────── */

/**
 * 公众号平台的表达禁忌。
 * 来源：platforms.md 的「公众号」一栏：
 *   建议 = 作者关心的问题、解释、用途与边界
 *   不可制造 = 第一人称使用经历（如果是编的）
 *
 * 这里只查一件能机械判定的事：**有没有把假设写成亲历**。
 * 例如「我曾经用它跑了三个月」这类话在某篇文章里出现，但全文没有任何具体细节支撑。
 */
export function checkFakeExperience(text, push) {
  const body = String(text || '')
  // 第一人称经历表述
  const re = /(?:我|笔者)(?:曾经|之前|当初|去年|上个月|那段时间)?.{0,8}(?:用了?|跑了?|做了?|试了?|踩过|遇到)/g
  const matches = body.match(re) || []
  if (!matches.length) return

  // 有具体细节（时间/数字/工具名/地点）算真实经历
  const hasDetail = /\d{4}\s*年|\d+\s*(?:天|周|个月|年|次|小时)/.test(body)
  if (!hasDetail) {
    push(
      'info',
      'content',
      'experience_vague',
      `出现 ${matches.length} 处第一人称经历，但没有具体的时间或细节`,
      '要么补上具体细节（什么时候、用了多久、结果如何），要么改成"按文档说明"这类不冒充实测的说法',
      null,
    )
  }
}

/* ── 金句层 ───────────────────────────────────────────────────── */

/**
 * 有没有可以单独成段的金句/收尾。
 * 来源：wechat-article-writer Step 4「金句：单独成段，增强记忆点」。
 *
 * 判定：找一句**独立成段的短句**（≤ 40 字），并且不是标题、不是列表项。
 * 这不检查"写得好不好"，只检查"有没有这样一个位置"——后者能机械判定。
 */
export function checkPunchline(paragraphs, push) {
  const list = (paragraphs || []).filter((item) => item && item.length >= 6 && item.length <= 40)
  if (!list.length) {
    push(
      'info',
      'content',
      'no_punchline',
      '全文没有可以单独成段的短句，读完后记不住哪一句',
      '挑一句最想让人记住的话，单独成段（≤ 40 字），前后各留一个空行',
      null,
    )
  }
}

/* ── 汇总入口 ─────────────────────────────────────────────────── */

/**
 * 跑全部内容层规则。
 * @param {object} article  { title, body, ... }
 * @param {object} info     review.js 解析出的结构信息（paragraphs/headings…）
 * @param {Function} push   与 review.js 相同的记录函数
 */
export function runContentChecks(article, info, push) {
  const body = String((article && article.body) || '')
  const paragraphs = (info && info.paragraphs) || []

  checkTitle(article && article.title, push)
  checkOpening(article, paragraphs[0], push)
  checkClaims(body, push)
  checkNumbers(body, push)
  checkTutorialCompleteness(article, body, push)
  checkComparison(body, push)
  checkFakeExperience(body, push)
  checkPunchline(paragraphs, push)
}

/** 供预设说明展示：这一层规则覆盖什么。 */
export const CONTENT_LAYER_SPEC = {
  key: 'content',
  label: '内容（标题吸引力、开头钩子、依据、体裁完整性）',
  /** 内容层默认权重。占 20 分：它重要，但不像硬限制那样一票否决。 */
  defaultWeight: 20,
  /** 每条 info 扣多少分（内容层的发现都是建议性质）。 */
  deductInfo: 3,
  deductWarn: 7,
}

/** 封面尺寸（供文案展示，与真实渲染保持一致）。 */
export const COVER_SIZE_TEXT = `${COVER_SIZE.width}×${COVER_SIZE.height}`
