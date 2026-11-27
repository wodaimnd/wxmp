/**
 * 稿件体检的测试。
 *
 * 这个模块最容易腐化成「分数玄学」，所以断言分两类：
 *   (1) **具体规则必须命中**：给定一篇文章，哪些 code 必须出现、行号必须对；
 *   (2) **分数必须由规则决定**：改掉问题后分数必须真的上升，否则分数就没有反馈价值。
 *
 * 全部纯函数，不联网、不建假服务器。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { parseMarkdown, renderHtml, makeDigest, outline, stats } from '../src/markdown.js'
import { reviewArticle, formatReview, THRESHOLDS, WEIGHTS } from '../src/review.js'

/** 把 body 压成一个 article + rendered，模拟 renderArticle() 的输出。 */
function build(body, meta = {}) {
  const article = {
    title: meta.title ?? '正常标题',
    author: meta.author ?? '作者',
    digest: meta.digest ?? '',
    cover: meta.cover === undefined ? 'c.png' : meta.cover,
    theme: 'default',
    sourceUrl: meta.sourceUrl ?? 'https://example.com',
    mediaId: '',
    name: 't',
    path: 'C:/tmp/t.md',
    body,
    bodyStartLine: meta.bodyStartLine ?? 9,
  }
  const nodes = parseMarkdown(body)
  const { html, images } = renderHtml(nodes, { theme: 'default' })
  const rendered = {
    nodes,
    html,
    images,
    digest: article.digest || makeDigest(nodes, 120),
    stats: stats(nodes, html),
    outline: outline(nodes),
  }
  return { article, rendered }
}

const run = (body, meta) => {
  const { article, rendered } = build(body, meta)
  return reviewArticle(article, rendered)
}

const codes = (report) => report.findings.map((item) => item.code)

test('权重加总必须是 100：否则分数会没有意义', () => {
  const total = Object.values(WEIGHTS).reduce((sum, value) => sum + value, 0)
  assert.equal(total, 100, `分项权重加起来是 ${total}，改成 100 再发`)
})

test('干净的稿子拿高分且不误报', () => {
  const body = [
    '为什么你的公众号没人看？先看这三个数字。',
    '',
    '## 打开率掉了',
    '',
    '先说结论：不是内容变差了，是标题没抓住人。',
    '',
    '## 三个可动的按钮',
    '',
    '标题、封面、首段。每个都能单独测。',
    '',
    '## 现在就能做',
    '',
    '把上一篇的标题改短，再发一次试试。',
  ].join('\n')
  const report = run(body)
  assert.ok(report.score >= THRESHOLDS.passScore, `干净稿子应当达标，实际 ${report.score}`)
  assert.equal(report.pass, true)
  assert.equal(report.counts.error, 0)
  assert.equal(report.counts.warn, 0, `干净稿子不该有 warn：${JSON.stringify(report.findings)}`)
})

test('硬限制超标：限制项直接 0 分，且 pass=false（分数再高也发不出去）', () => {
  // 标题必须真超过 32 字、作者真超过 16 字 —— 差一个字都不算超（这里以前写错过）
  const longTitle = '超'.repeat(33)
  const longAuthor = '名'.repeat(17)
  const report = run('正文。', { title: longTitle, author: longAuthor })
  assert.equal(report.metrics.titleChars, 33, '测试前提：标题必须真的超过 32 字')
  assert.equal(report.metrics.authorChars, 17, '测试前提：作者必须真的超过 16 字')
  assert.ok(codes(report).includes('title_long'))
  assert.ok(codes(report).includes('author_long'))
  assert.equal(report.breakdown.limits, 0, '有 error 时限制项必须清零')
  assert.equal(report.pass, false)
  assert.ok(report.score < 100)
})

test('长段落在两个档位上分别降级：200+ 记 info，320+ 记 warn', () => {
  // 边界必须实测：'内容'.repeat(120) 只有 246 字，够不到 320 的 warn 档
  const mild = `这一段比较长${'内容'.repeat(100)}` // 约 206 字
  const huge = `这一段特别长${'内容'.repeat(160)}` // 约 326 字
  assert.ok(mild.length >= THRESHOLDS.paragraphLong && mild.length < THRESHOLDS.paragraphHuge, `mild 长度 ${mild.length} 不在 info 档`)
  assert.ok(huge.length >= THRESHOLDS.paragraphHuge, `huge 长度 ${huge.length} 没到 warn 档`)

  const mildHit = run(['开头。', '', mild].join('\n')).findings.find((item) => item.code === 'paragraph_long')
  assert.equal(mildHit.level, 'info', `${THRESHOLDS.paragraphLong}~${THRESHOLDS.paragraphHuge} 字应为 info`)

  const hugeHit = run(['开头。', '', huge].join('\n')).findings.find((item) => item.code === 'paragraph_long')
  assert.equal(hugeHit.level, 'warn', `超过 ${THRESHOLDS.paragraphHuge} 字应升级为 warn`)
  assert.match(hugeHit.suggest, /拆成/, '建议必须是可执行动作')
})

test('长段落的行号指向原文那一行', () => {
  const huge = `这一段特别长${'内容'.repeat(160)}`
  const body = ['开头一段。', '', huge, '', '## 小节', '', '结尾。'].join('\n')
  const report = run(body, { bodyStartLine: 9 })
  const hit = report.findings.find((item) => item.code === 'paragraph_long')
  assert.ok(hit, '300+ 字的段落必须被标出来')
  // body 第 3 行（1-based）→ 文件第 9 + 2 = 11 行
  assert.equal(hit.line, 11, `行号应是 11，实际 ${hit.line}`)
})

test('行号定位不会编造：找不到就给 null，不硬凑', () => {
  const report = run('一段普通的话。')
  for (const item of report.findings) {
    assert.ok(item.line === null || typeof item.line === 'number')
  }
})

test('结构问题：没有小标题、首标题不是 H2、标题跳级，都要报', () => {
  const noHead = run('一段话。\n\n又一段话。')
  assert.ok(codes(noHead).includes('no_outline'), '没有任何标题必须报 no_outline')

  // 首标题 H4，之后降到 H2：报「首标题不是 H2」，**不该报 level_jump**（降级不是跳级）
  const drop = run('开头。\n\n#### 一上来就是四级\n\n正文。\n\n## 然后是二级')
  assert.ok(codes(drop).includes('first_heading_level'), '正文第一标题是 H4 必须报（旧实现会漏掉）')
  assert.ok(!codes(drop).includes('level_jump'), 'H4 → H2 是降级，不是跳级，报错会误导')

  // 升级跳级：H2 直接到 H4
  const up = run('开头。\n\n## 二级\n\n正文两段。\n\n#### 直接跳到四级')
  assert.ok(codes(up).includes('level_jump'), 'H2 → H4 必须报 level_jump')
  assert.ok(!codes(up).includes('first_heading_level'), '首标题是 H2 时不该报 first_heading_level')
})

test('重复段落被抓住（AI 写长文最常见的自我复制）', () => {
  const dup = '这一段被复制了两次，长度刚好够触发检测的阈值要求。'
  const report = run(['开头。', '', dup, '', '中间。', '', dup].join('\n'))
  assert.ok(codes(report).includes('paragraph_duplicated'))
})

test('素材问题：无封面、外链图、超宽表格、超长代码块', () => {
  const body = [
    '开头。',
    '',
    '![图](https://example.com/a.png)',
    '',
    '| a | b | c | d | e | f | g |',
    '| - | - | - | - | - | - | - |',
    '| 1 | 2 | 3 | 4 | 5 | 6 | 7 |',
    '',
    '```js',
    ...Array.from({ length: 25 }, (_, i) => `const v${i} = ${i}`),
    '```',
  ].join('\n')
  const report = run(body, { cover: '' })
  assert.ok(codes(report).includes('cover_missing'))
  assert.ok(codes(report).includes('image_remote'))
  assert.ok(codes(report).includes('table_wide'))
  assert.ok(codes(report).includes('code_long'))
})

test('mmbiz 域名图片不算外链（草稿里本来就该是它）', () => {
  const report = run('开头。\n\n## 小节\n\n![图](http://mmbiz.qpic.cn/a.png)\n\n结尾试试。')
  assert.ok(!codes(report).includes('image_remote'))
})

test('改好之后分数必须上升（分数就是反馈本身）', () => {
  const before = run(`开头就一句话。\n\n${'很长很长'.repeat(90)}\n\n结尾。`, { cover: '' })
  const after = run(
    [
      '为什么没人点开？三个数字说明问题。',
      '',
      '## 标题太长',
      '',
      '超过 32 字的部分会被折叠。',
      '',
      '## 首段太远',
      '',
      '第一句就要给结论。',
      '',
      '## 现在能做',
      '',
      '把标题改短，再发一次试试。',
    ].join('\n'),
  )
  assert.ok(after.score > before.score, `改好后应上升：${before.score} → ${after.score}`)
  assert.ok(before.score < THRESHOLDS.passScore)
  assert.ok(after.score >= THRESHOLDS.passScore)
})

test('findings 按「先必须改」排序，nextActions 最多 5 条且带行号', () => {
  const report = run('一段话。', { title: '超长标题超长标题超长标题超长标题超长标题超长标题超长标题超长标题', cover: '' })
  const order = { error: 0, warn: 1, info: 2 }
  const levels = report.findings.map((item) => order[item.level])
  const sorted = [...levels].sort((a, b) => a - b)
  assert.deepEqual(levels, sorted, 'findings 必须按严重程度排序，Agent 才会从上往下改')
  assert.ok(report.nextActions.length <= 5)
  assert.ok(report.nextActions.every((item) => typeof item === 'string' && item.length > 0))
})

test('formatReview 输出的每条问题都带「改法」，没有改法的建议等于没建议', () => {
  const report = run('一段话。', { cover: '' })
  const text = formatReview(report)
  assert.match(text, /体检 /)
  assert.match(text, /分项:/)
  for (const item of report.findings) {
    assert.ok(item.suggest && item.suggest.length > 0, `${item.code} 缺少改法`)
  }
  assert.match(text, /改法:/)
})

test('空文章不会崩：所有规则都必须容忍空输入', () => {
  const report = run('')
  assert.equal(typeof report.score, 'number')
  assert.ok(report.score >= 0 && report.score <= 100)
  assert.ok(Array.isArray(report.findings))
})
