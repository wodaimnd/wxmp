/**
 * 内容层体检规则的测试。
 *
 * 每条规则都对应 skill 文档里的一条判断标准，所以要验证两件事：
 *  1. **该报的时候报**（否则规则形同虚设）
 *  2. **不该报的时候不报**（误报比漏报更糟 —— 会让作者去改没问题的句子）
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONTENT_LAYER_SPEC,
  checkClaims,
  checkComparison,
  checkFakeExperience,
  checkNumbers,
  checkOpening,
  checkPunchline,
  checkTitle,
  checkTutorialCompleteness,
  runContentChecks,
} from '../src/review-content.js'

/** 收集 push 出来的 findings。 */
function collector() {
  const items = []
  const push = (level, category, code, message, suggest) => {
    items.push({ level, category, code, message, suggest })
  }
  return { items, push, codes: () => items.map((item) => item.code) }
}

/* ── 标题 ─────────────────────────────────────────────────────── */

test('标题：有数字/结果/痛点的不报', () => {
  for (const title of [
    '3 个命令搞定公众号排版',
    '效率提升后我不再手动复制',
    '为什么你的文章没人看完',
  ]) {
    const { items, push } = collector()
    checkTitle(title, push)
    assert.equal(items.length, 0, `「${title}」不该被报`)
  }
})

test('标题：空洞名词堆砌要报 title_vague 与 title_noun_pile', () => {
  const { codes, push } = collector()
  checkTitle('插件架构设计思考', push)
  assert.ok(codes().includes('title_vague'), '没有数字/结果/痛点应报 title_vague')
})

test('标题：空标题交给 limits 层，这里不重复报', () => {
  const { items, push } = collector()
  checkTitle('', push)
  assert.equal(items.length, 0)
})

/* ── 开头 ─────────────────────────────────────────────────────── */

test('开头：有场景或有读者处境或有反差的不报', () => {
  for (const opening of [
    '那天我打开终端，看到一个从没见过的报错。',
    '你是不是也遇到过这种情况：改完代码忘了跑测试。',
    '都说这个方案更快，但我实测下来并非如此。',
  ]) {
    const { items, push } = collector()
    checkOpening({}, opening, push)
    assert.equal(items.length, 0, `「${opening.slice(0, 12)}…」不该被报`)
  }
})

test('开头：平铺直叙要报 opening_flat', () => {
  const { codes, push } = collector()
  checkOpening({}, '这篇文章主要介绍插件的加载机制以及相关的实现细节，包括配置解析和依赖注入两个部分。', push)
  assert.ok(codes().includes('opening_flat'))
})

test('开头：过长要报 opening_too_long（手机第一屏全是字）', () => {
  const { codes, push } = collector()
  checkOpening({}, '内容'.repeat(100), push)
  assert.ok(codes().includes('opening_too_long'))
})

/* ── 事实依据 ─────────────────────────────────────────────────── */

test('声称实测但没有任何可核对痕迹 → claim_no_evidence', () => {
  const { codes, push } = collector()
  checkClaims('我实测下来这个方案确实快很多，效果非常明显。', push)
  assert.ok(codes().includes('claim_no_evidence'))
})

test('声称实测但附近有命令/输出/链接 → 不报（真实经验不该被误伤）', () => {
  const { items, push } = collector()
  checkClaims('我实测下来确实更快，跑的是：\n```\nnode bench.js\n```\n输出 p95 从 320ms 降到 120ms。', push)
  assert.equal(items.length, 0, '有证据的实测不该被报')
})

test('没有声称实测的文章不报 claim_no_evidence', () => {
  const { items, push } = collector()
  checkClaims('按官方文档说明，这个接口会在三秒后超时。', push)
  assert.equal(items.length, 0)
})

test('夸张百分比没有出处 → number_unbacked', () => {
  const { codes, push } = collector()
  checkNumbers('改用新方案后效率提升了 300%，团队都很满意。', push)
  assert.ok(codes().includes('number_unbacked'))
})

test('小幅改进的百分比不报（50% 以内算合理）', () => {
  const { items, push } = collector()
  checkNumbers('启动时间降低了 20%，基本感觉不出来。', push)
  assert.equal(items.length, 0)
})

test('有来源的百分比不报', () => {
  const { items, push } = collector()
  checkNumbers('据官方 benchmark 数据，吞吐提升了 300%。', push)
  assert.equal(items.length, 0)
})

/* ── 体裁完整性 ───────────────────────────────────────────────── */

test('教程缺前提 → tutorial_no_prereq；缺失败边界 → tutorial_no_pitfall', () => {
  const { codes, push } = collector()
  checkTutorialCompleteness({}, '第一步打开终端，第二步执行下面的命令，第三步看结果。', push)
  assert.ok(codes().includes('tutorial_no_prereq'), '缺前提应报')
  assert.ok(codes().includes('tutorial_no_pitfall'), '缺失败边界应报')
})

test('完整的教程不报', () => {
  const { items, push } = collector()
  checkTutorialCompleteness(
    {},
    '前提：需要 Node 18 以上。第一步打开终端执行命令。注意可能会遇到权限报错，这时加 sudo。',
    push,
  )
  assert.equal(items.length, 0)
})

test('非教程文章不做教程检查（避免误报）', () => {
  const { items, push } = collector()
  checkTutorialCompleteness({}, '这是一篇随笔，讲讲我最近的一些想法和感受。', push)
  assert.equal(items.length, 0)
})

test('对比结论缺口径 → comparison_no_basis', () => {
  const { codes, push } = collector()
  checkComparison('这个方案明显优于另一个，快得多。', push)
  assert.ok(codes().includes('comparison_no_basis'))
})

test('有口径的对比不报', () => {
  const { items, push } = collector()
  checkComparison('在同一台机器同一数据集下对比，这个方案启动更快。', push)
  assert.equal(items.length, 0)
})

/* ── 平台表达禁忌 ─────────────────────────────────────────────── */

test('第一人称经历但没有具体细节 → experience_vague（platforms.md 要求不能虚构经历）', () => {
  const { codes, push } = collector()
  checkFakeExperience('我曾经用它跑了一段时间，感觉还行。', push)
  assert.ok(codes().includes('experience_vague'))
})

test('第一人称经历带具体时间 → 不报', () => {
  const { items, push } = collector()
  checkFakeExperience('我去年用了 6 个月，期间踩了不少坑。', push)
  assert.equal(items.length, 0)
})

test('没有第一人称经历的文章不报', () => {
  const { items, push } = collector()
  checkFakeExperience('该工具提供命令行接口，支持批量处理。', push)
  assert.equal(items.length, 0)
})

/* ── 金句 ─────────────────────────────────────────────────────── */

test('全文没有可独立成段的短句 → no_punchline', () => {
  const { codes, push } = collector()
  checkPunchline(['这是一段很长的正文内容，讲了很多细节和背景信息，远远超过四十个字的上限所以不算金句。'], push)
  assert.ok(codes().includes('no_punchline'))
})

test('有短句时不报 no_punchline', () => {
  const { items, push } = collector()
  checkPunchline(['这是一段很长的正文内容，讲了很多细节和背景信息，远远超过四十个字的上限所以不算金句。', '能力要强，但每一刀都得能收回来。'], push)
  assert.equal(items.length, 0)
})

/* ── 汇总 ─────────────────────────────────────────────────────── */

test('runContentChecks：所有 finding 的 category 都必须是 content', () => {
  const { items, push } = collector()
  runContentChecks(
    { title: '插件设计', body: '我实测过效果好，效率提升 300%。第一步执行命令。这个方案优于那个。' },
    { paragraphs: ['我实测过效果好'] },
    push,
  )
  assert.ok(items.length > 0, '这段文本应当触发多条规则')
  for (const item of items) {
    assert.equal(item.category, 'content', `规则 ${item.code} 的类别应为 content`)
    assert.ok(item.message, `规则 ${item.code} 缺少 message`)
    assert.ok(item.suggest, `规则 ${item.code} 缺少可执行的改法`)
  }
})

test('CONTENT_LAYER_SPEC 的扣分参数被 review.js 使用（改了名字要同步）', () => {
  assert.equal(CONTENT_LAYER_SPEC.key, 'content')
  assert.equal(typeof CONTENT_LAYER_SPEC.deductInfo, 'number')
  assert.equal(typeof CONTENT_LAYER_SPEC.deductWarn, 'number')
  assert.ok(CONTENT_LAYER_SPEC.deductWarn > CONTENT_LAYER_SPEC.deductInfo, 'warn 扣分应大于 info')
})

/* ── 预设迁移（新增 content 类别的兼容性）────────────────────── */

test('旧预设（4 个权重）被明确拒绝，并给出可直接照抄的 5 键写法', async () => {
  const { normalizePreset } = await import('../src/presets.js')
  const result = normalizePreset({ weights: { limits: 30, structure: 25, readability: 25, assets: 20 } })

  // 不静默改用户数据：明确拒绝
  assert.equal(result.ok, false, '缺 content 权重的预设应被拒绝，而不是自动折算')
  const errors = result.errors.join('；')
  assert.match(errors, /缺少类别.*content/, '错误里要点名缺哪个类别')

  // 必须给出可照抄的完整写法（含折算参考值），否则用户不知道该填什么数
  assert.match(errors, /"limits"\s*:\s*\d+/, '要给出完整的 5 键示例')
  assert.match(errors, /"content"\s*:\s*\d+/, '示例里必须包含 content')
  const match = errors.match(/\{[\s\S]*?"content"[\s\S]*?\}/)
  assert.ok(match, '要能从错误信息里提取出 JSON 示例')
  const suggested = JSON.parse(match[0])
  const total = Object.values(suggested).reduce((sum, value) => sum + value, 0)
  assert.equal(total, 100, `给出的示例合计必须是 100，实际 ${total}`)
  // 示例要保留原侧重：原来 limits 最高，折算后仍应最高
  assert.ok(suggested.limits >= suggested.structure, '示例应保留用户原来的侧重')
})

test('完整 5 键预设正常通过，不被误拒', async () => {
  const { normalizePreset } = await import('../src/presets.js')
  const result = normalizePreset({
    weights: { limits: 20, structure: 20, readability: 20, assets: 20, content: 20 },
  })
  assert.equal(result.ok, true, (result.errors || []).join('；'))
  assert.equal(result.preset.weights.limits, 20)
  assert.equal(result.preset.weights.content, 20)
})

test('新预设（含 content）不被折算，按用户给的值执行', async () => {
  const { normalizePreset } = await import('../src/presets.js')
  const result = normalizePreset({
    weights: { limits: 20, structure: 20, readability: 20, assets: 20, content: 20 },
  })
  const weights = result.preset ? result.preset.weights : result.weights
  assert.equal(weights.limits, 20)
  assert.equal(weights.content, 20)
})
