/**
 * 封面版式的测试。
 *
 * 三个 bug 都是「图能生成、也能打开，但人一看就觉得难看」，单看返回值全是成功的：
 *  1. 字号被当成 Point 用 → 46pt = 61px，标题冲出画布；
 *  2. GDI 在矩形里自己折行 → 把「工作台」拆成「工作 / 台」；
 *  3. 角标坐标算错 → 跑到画布外，右侧还留一道渐变硬边。
 *
 * 所以这里不只断言「plan 有值」，而是断言**几何约束**：
 * 每行不超宽、行数受控、断点不拆词、角标在画布内。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  COVER_SIZE,
  COVER_SIZE_LIMITS,
  WECHAT_COVER_RATIO,
  LAYOUT,
  COVER_TONE,
  charWidth,
  formatCoverSize,
  measure,
  mixColor,
  normalizeCoverSize,
  planCover,
  wrapBalanced,
} from '../tools/cover-layout.js'

const REAL_TITLE = '把公众号写作搬进 AI 工作台：一个插件的取舍'

test('量宽：CJK 按全角、西文按半角，比例合理', () => {
  assert.equal(charWidth('中') >= 1, true, 'CJK 应当是全角宽度')
  assert.equal(charWidth('a') < 0.7, true, '小写西文应当明显窄于 CJK')
  assert.equal(charWidth(' ') < 0.4, true, '空格最窄')
  // 一句话里 CJK 越多，总宽越大
  const cjk = measure('中文标题四个字')
  const latin = measure('ABCDEF')
  assert.ok(cjk > latin, '6 个西文字母不该宽于 6 个汉字')
})

test('断行不拆词：在冒号处断开，而不是拆「工作台」', () => {
  const lines = wrapBalanced(REAL_TITLE, 16, 2)
  assert.equal(lines.length, 2, `应当断成 2 行，实际 ${lines.length}：${JSON.stringify(lines)}`)
  // 旧实现会把「工作台」拆开，断言这个组合没被拆
  const joined = lines.join('|')
  assert.ok(!joined.includes('工作|台'), `把「工作台」拆开了：${joined}`)
  assert.ok(lines[0].endsWith('：') || lines[0].endsWith(':'), `第一行应在冒号处收尾：${lines[0]}`)
})

test('planCover 的每行都在可用宽度内（字号不被当成 Point 放大 1.33 倍）', () => {
  const plan = planCover({ title: REAL_TITLE, subtitle: 'YG · 插件实践', badge: 'WXMP' })
  const usable = plan.width - plan.padX * 2
  assert.ok(plan.size <= LAYOUT.titleMaxSize, `字号不该超过上限：${plan.size}`)
  assert.ok(plan.size >= LAYOUT.titleMinSize, `字号不该低于下限：${plan.size}`)
  for (const line of plan.placements) {
    assert.ok(line.width <= usable, `行溢出：${Math.round(line.width)} > 可用 ${usable}（「${line.text}」）`)
  }
  assert.ok(plan.lines.length <= LAYOUT.titleMaxLines, `行数超上限：${plan.lines.length}`)
})

test('planCover 输出带 Pixel 语义的字号：脚本必须显式指定 GraphicsUnit', () => {
  // 这不是样式偏好，是真实事故：Font 默认 Point，46pt=61px 直接冲出画布。
  // 断言放在 cover.js 的脚本生成里（见下一条），这里只锁住 plan 给的是像素值。
  const plan = planCover({ title: REAL_TITLE })
  // 行高应当是字号的 1.2~1.4 倍，而不是 1.3 倍再放大 1.33
  assert.ok(plan.lineHeight >= plan.size * 1.2 && plan.lineHeight <= plan.size * 1.45,
    `行高 ${plan.lineHeight} 与字号 ${plan.size} 比例异常（可能混进了 pt→px 换算）`)
})

test('角标在画布内（右边界坐标不重复换算）', () => {
  const plan = planCover({ title: REAL_TITLE, badge: 'WXMP' })
  assert.ok(plan.badge, '应当有角标')
  // right 是右边界；绘制侧减去宽度即可，宽度不会超过 200
  assert.ok(plan.badge.right <= plan.width, `角标右边界越界：${plan.badge.right}`)
  assert.ok(plan.badge.right > plan.width / 2, `角标应当在右半边（旧 bug 会跑到左侧）：${plan.badge.right}`)
  assert.ok(plan.badge.top >= 0 && plan.badge.top < plan.height / 2, `角标应当在顶部：${plan.badge.top}`)
})

test('超长标题降级：字号变小，行数不无限增长', () => {
  const long = '这是一个非常非常非常非常非常非常非常非常非常非常非常长的标题用于测试极限降级行为'
  const plan = planCover({ title: long })
  assert.ok(plan.size < LAYOUT.titleMaxSize, `超长标题应当缩字号，实际 ${plan.size}`)
  assert.ok(plan.lines.length <= 3, `超长标题最多 3 行，实际 ${plan.lines.length}`)
  const usable = plan.width - plan.padX * 2
  for (const line of plan.placements) {
    assert.ok(line.width <= usable * 1.02, `降级后仍溢出：${Math.round(line.width)}`)
  }
})

test('短标题只占一行，且整体垂直居中而非贴顶', () => {
  const plan = planCover({ title: '一个很短的标题', subtitle: '副标题' })
  assert.equal(plan.lines.length, 1)
  assert.ok(plan.titleTop > LAYOUT.padTop, `应当垂直居中（不该贴着顶部）：top=${plan.titleTop}`)
  assert.ok(plan.titleTop + plan.blockHeight < plan.height, '标题块不该超出下边界')
})

test('无副标题时也有装饰线，避免右下角空得发慌', () => {
  const plan = planCover({ title: REAL_TITLE })
  assert.equal(plan.subtitle, null)
  assert.ok(plan.rule && plan.rule.width > 0, '应当有装饰线')
  assert.ok(plan.rule.y > plan.titleTop, '装饰线在标题下方')
})

test('混色：深底足以承载白字（对比度不是靠运气）', () => {
  const deep = mixColor('#07c160', COVER_TONE.darkMix)
  assert.ok(deep.every((v) => v >= 0 && v <= 255), '混色结果必须是合法 RGB')
  // 亮度粗略估计：白字在深底上才清楚
  const luminance = (deep[0] * 0.299 + deep[1] * 0.587 + deep[2] * 0.114) / 255
  assert.ok(luminance < 0.45, `底色太亮（亮度 ${luminance.toFixed(2)}），白字对比度不够`)
  // 亮角要明显比深角亮，否则整个封面平掉
  const light = mixColor('#07c160', COVER_TONE.lightMix)
  const lightLum = (light[0] * 0.299 + light[1] * 0.587 + light[2] * 0.114) / 255
  assert.ok(lightLum > luminance + 0.1, '右侧亮角不够亮，图层会显得平')
})

test('尺寸与微信封面比例一致（2.35:1）', () => {
  assert.equal(COVER_SIZE.width, 900)
  assert.equal(COVER_SIZE.height, 383)
  const ratio = COVER_SIZE.width / COVER_SIZE.height
  assert.ok(Math.abs(ratio - 2.35) < 0.01, `比例 ${ratio.toFixed(3)} 不符合 2.35:1`)
})

/* 2026-11-09：900×383 从"不可修改的硬规格"降级为"默认推荐值"。
 * 下面这组用例守的是"可改"这件事本身 —— 以及改了之后必须说清楚发生了什么。 */
test('normalizeCoverSize：没填 / 填了非数字 → 用推荐值且标记 requested=false', () => {
  for (const blank of [undefined, {}, { width: 0, height: 0 }, { width: 'abc', height: 'x' }, { width: -100, height: 200 }]) {
    const out = normalizeCoverSize(blank)
    assert.equal(out.width, COVER_SIZE.width, `输入 ${JSON.stringify(blank)} 应回落推荐宽度`)
    assert.equal(out.height, COVER_SIZE.height)
    assert.equal(out.requested, false)
    assert.equal(out.isDefault, true)
    assert.equal(out.ratioWarn, '', '推荐值不该有比例警告')
  }
})

test('normalizeCoverSize：越界夹到边界，并且必须标记 clamped', () => {
  const tiny = normalizeCoverSize({ width: 100, height: 60 })
  assert.equal(tiny.width, COVER_SIZE_LIMITS.minWidth)
  assert.equal(tiny.height, COVER_SIZE_LIMITS.minHeight)
  assert.equal(tiny.clamped, true, '夹了就必须说，否则用户以为设置生效了')
  assert.equal(tiny.requested, true)

  const huge = normalizeCoverSize({ width: 99999, height: 99999 })
  assert.equal(huge.width, COVER_SIZE_LIMITS.maxWidth)
  assert.equal(huge.height, COVER_SIZE_LIMITS.maxHeight)
  assert.equal(huge.clamped, true)
})

test('normalizeCoverSize：比例偏离只给警告，不拒绝 —— 用户要的是"可以强行改"', () => {
  // 2% 以内（900×384）不算偏离，否则手抖一下就弹警告
  const near = normalizeCoverSize({ width: 900, height: 384 })
  assert.equal(near.ratioWarn, '', '2% 以内的偏离不该报警')
  assert.equal(near.clamped, false)

  // 明显改了比例：照做，但要能说清"公众号会再裁一次"
  const square = normalizeCoverSize({ width: 1000, height: 1000 })
  assert.equal(square.width, 1000, '不拒绝：用户明确要求可以强行更改')
  assert.equal(square.height, 1000)
  assert.match(square.ratioWarn, /2\.35:1/, '警告里要写出推荐比例，否则用户不知道差在哪')
  assert.equal(square.clamped, false)
  assert.equal(square.isDefault, false)
})

test('formatCoverSize：界面与 CLI 文案同源，格式固定', () => {
  assert.equal(formatCoverSize(COVER_SIZE), '900×383 像素（2.35:1）')
  assert.equal(formatCoverSize({ width: 1000, height: 400 }), '1000×400 像素（2.50:1）')
  // 传空也不能崩（面板会把 null 的尺寸直接丢进来）
  assert.equal(formatCoverSize(undefined), '900×383 像素（2.35:1）')
})

test('WECHAT_COVER_RATIO 与 COVER_SIZE 同源（防止两处各写一份比例）', () => {
  assert.equal(WECHAT_COVER_RATIO, COVER_SIZE.width / COVER_SIZE.height)
  assert.ok(Math.abs(WECHAT_COVER_RATIO - 2.35) < 0.01)
})
