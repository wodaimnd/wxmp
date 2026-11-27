/**
 * 写作辅助三件套的测试：标题、骨架、任务书。
 *
 * 这三块的共同点是**半成品**：它们不替你写，只提供起点与检查。
 * 所以测试重点不是"输出好看"，而是：
 *  1. 不产出**明显不成立**的东西（超长标题、语义不通的拼装）
 *  2. 不**凭空编造**（骨架里的提示不能假装是文章已有内容）
 *  3. 检查项与生成项**同源**（骨架说要写，体检就认这个标准）
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TITLE_FORMULAS,
  buildTitleBrief,
  buildTitleCandidates,
  extractTitleMaterial,
  scoreTitleCandidate,
} from '../src/title-lab.js'
import {
  FORMS,
  alignSections,
  buildSkeleton,
  describeSkeleton,
  detectForm,
} from '../src/outline-lab.js'
import { buildWritingBrief, guessForm, suggestQueries } from '../src/writing-brief.js'

/* ── 标题 ─────────────────────────────────────────────────────── */

test('主题词必须抽出名词短语，不能把整句标题塞进公式', () => {
  // 三轮实测的回归防线：
  // 1. 整句照搬 → 「3 个DSH 是什么 一个把 AI 变成能干活的操作台」（超长且不通）
  // 2. 取问句片段 → 「3 个DSH 是什么」（语义不通）
  // 注意：extractTitleMaterial 直接返回 material 对象（不包一层）
  const material = extractTitleMaterial(
    { title: 'DSH 是什么：一个把 AI 变成能干活的操作台', body: '' },
    {
      headings: [
        { level: 2, text: '一、Harness 到底是个什么东西' },
        { level: 2, text: '三、DSH 的几个关键设计' },
      ],
      paragraphs: [],
    },
  )
  assert.ok(material.topic.length <= 12, `主题词应 ≤12 字，实际「${material.topic}」`)
  assert.doesNotMatch(material.topic, /是什么$/, '主题词不能是问句')
  assert.ok(!material.topic.includes('操作台'), '主题词不该是原标题整句')
})

test('机械候选全部标出问题，且不假装成品', () => {
  const { candidates } = buildTitleCandidates(
    { title: '测试标题：一个很长的副标题说明', body: '' },
    { headings: [{ level: 2, text: '关键设计' }], paragraphs: [] },
  )
  assert.equal(candidates.length, TITLE_FORMULAS.length, '每个公式出一条')
  for (const item of candidates) {
    assert.ok(item.label, '每条要有方向名')
    assert.ok(item.why, '每条要解释为什么这个方向有效')
    assert.equal(typeof item.usable, 'boolean', 'usable 标记必须有（面板据此区分成品/半成品）')
  }
})

test('标题打分：有数字与钩子的高分，夸张套话扣分', () => {
  const good = scoreTitleCandidate('3 步让 AI 真正替你干活')
  const bad = scoreTitleCandidate('震惊！99% 的人都不知道的 AI 用法')
  assert.ok(good.score > bad.score, `好标题(${good.score}) 应高于夸张标题(${bad.score})`)
  assert.ok(bad.issues.some((issue) => /夸张|空喊/.test(issue)), '夸张套话必须被点名')
})

test('标题打分：超长标题要指出会被截断', () => {
  const long = scoreTitleCandidate('这是一个非常非常长的标题超过二十六个字符肯定会被微信截断掉')
  assert.ok(long.issues.some((issue) => /过长/.test(issue)))
})

test('标题任务书必须带上硬约束与五个方向', () => {
  const brief = buildTitleBrief({ title: '原标题', body: '正文' }, { headings: [], paragraphs: [] })
  assert.match(brief, /≤ 26 字|26 字/, '要写清长度上限')
  assert.match(brief, /痛点式/, '要列出痛点式方向')
  assert.match(brief, /数字式/)
  assert.match(brief, /结果式/)
  assert.match(brief, /反常识式/)
  assert.match(brief, /输出格式/, '要给出输出格式，否则调用方返回一堆散文')
})

test('标题任务书：原标题超长时要警告（微信列表会截断）', () => {
  const brief = buildTitleBrief(
    { title: '这是一个非常非常长肯定会被截断的标题超过二十二个字了', body: '' },
    { headings: [], paragraphs: [] },
  )
  assert.match(brief, /截断/, '长标题必须警告')
})

/* ── 骨架 ─────────────────────────────────────────────────────── */

test('四种文体都有完整的骨架定义', () => {
  for (const [id, form] of Object.entries(FORMS)) {
    assert.ok(form.label, `${id} 缺 label`)
    assert.ok(form.when, `${id} 缺适用说明`)
    assert.ok(form.sections.length >= 4, `${id} 骨架太单薄`)
    for (const section of form.sections) {
      assert.ok(section.key && section.heading && section.prompt, `${id}/${section.key} 字段不全`)
      assert.equal(typeof section.required, 'boolean')
    }
  }
})

test('文体检测：教程/对比/案例/解释 各自能被认出', () => {
  const cases = [
    ['第一步安装，然后执行命令，运行测试', 'tutorial'],
    ['这两个方案对比下来，A 优于 B', 'comparison'],
    ['那天我们团队复盘了这个项目，当时踩了很多坑', 'case'],
    ['这个东西指的是什么？它的定义和原理是什么', 'explainer'],
  ]
  for (const [text, expected] of cases) {
    const result = detectForm({ title: '' }, text)
    assert.equal(result.form, expected, `「${text.slice(0, 12)}…」应识别为 ${expected}`)
  }
})

test('骨架对齐：内容已有但标题不叫这个时，不能谎报"缺失"', () => {
  // 实测教训：只做标题关键词匹配时，一篇内容完整的文章被判定"还缺 5 节"
  const body = '前提：需要 Node 18 以上。执行命令后会看到输出。注意可能会遇到权限报错。'
  const aligned = alignSections('tutorial', [{ level: 2, text: '一、这东西是什么' }], body)
  const prereq = aligned.find((item) => item.key === 'prereq')
  const pitfall = aligned.find((item) => item.key === 'pitfall')
  assert.equal(prereq.status, 'present', '正文写了前提，不该报缺')
  assert.equal(pitfall.status, 'present', '正文写了注意事项，不该报缺')
  // 但要标出标题没对上，方便作者考虑重组
  assert.equal(prereq.headingMismatch, true, '应标出标题不匹配')
})

test('骨架对齐：内容真的没有时才报 missing', () => {
  const aligned = alignSections('tutorial', [], '这是一段完全无关的文字，没有任何环境说明。')
  const prereq = aligned.find((item) => item.key === 'prereq')
  assert.equal(prereq.status, 'missing')
})

test('骨架输出：必需节标「待写」，已有节标「已有内容」', () => {
  const result = buildSkeleton('tutorial', { headings: [], text: '' })
  assert.match(result.markdown, /## 前提/)
  assert.match(result.markdown, /待写/, '缺的节要提示待写')
  assert.ok(result.missing.length > 0)
  // 骨架里的注释不能是可执行内容（不能真被当成正文发出去）
  assert.match(result.markdown, /<!--/, '提示要用 HTML 注释，否则会进正文')
})

test('describeSkeleton 要能一句话说清缺什么', () => {
  const result = buildSkeleton('case', { headings: [], text: '' })
  const desc = describeSkeleton(result)
  assert.match(desc, /文体：案例/)
  assert.match(desc, /还缺/)
})

test('未知文体要报错并列出可用选项', () => {
  assert.throws(() => buildSkeleton('nonsense', {}), /未知文体/)
})

/* ── 任务书 ───────────────────────────────────────────────────── */

test('任务书包含四步，且每步都有可执行内容', () => {
  const brief = buildWritingBrief({ topic: '测试主题', form: 'tutorial' })
  const text = brief.markdown
  assert.match(text, /第一步|先找资料/, '缺第一步')
  assert.match(text, /第二步|按这个结构写/, '缺第二步')
  assert.match(text, /第三步|起标题/, '缺第三步')
  assert.match(text, /第四步|写完自己过一遍/, '缺第四步')
  // 每一步都要有具体的检查项，不能只是标题
  assert.match(text, /段落|句子|小标题/, '自查步骤要给出具体项')
})

test('任务书带上 forms.md 的硬约束（不能编造）', () => {
  const brief = buildWritingBrief({ topic: '测试', form: 'comparison' })
  assert.match(brief.markdown, /不能编造/, '必须写明禁止编造')
  assert.match(brief.markdown, /出处|来源/, '要求给出处')
})

test('任务书提醒不要自动发布（workflow.md 的边界）', () => {
  const brief = buildWritingBrief({ topic: '测试' })
  assert.match(brief.markdown, /别自动发|另外两步|单独确认/, '要说明发表是另外一步')
})

test('文体不同的任务书给出不同的结构建议', () => {
  const tutorial = buildWritingBrief({ topic: '测试', form: 'tutorial' })
  const comparison = buildWritingBrief({ topic: '测试', form: 'comparison' })
  assert.notEqual(tutorial.markdown, comparison.markdown, '不同文体不能产出同一份任务书')
  assert.match(tutorial.markdown, /失败边界/)
  assert.match(comparison.markdown, /口径/)
})

test('guessForm：按关键词猜文体', () => {
  assert.equal(guessForm('怎么配置这个工具'), 'tutorial')
  assert.equal(guessForm('A 和 B 选哪个'), 'comparison')
  assert.equal(guessForm('项目复盘'), 'case')
  assert.equal(guessForm('这个东西是什么'), 'explainer')
})

test('suggestQueries：给出可执行的搜索方向，不重复', () => {
  const queries = suggestQueries('公众号排版', 'tutorial')
  assert.ok(queries.length >= 3, '至少给三条方向')
  // 不能每条都是同一句（早先的实现会输出四行几乎一样的话）
  const unique = new Set(queries)
  assert.equal(unique.size, queries.length, '搜索方向不能重复')
})

test('空主题不崩，给出提示而不是空字符串', () => {
  const brief = buildWritingBrief({})
  assert.ok(brief.markdown.length > 0, '空主题也要有输出，不能是空')
  assert.match(brief.markdown, /未指定|主题/, '要提示主题未指定')
})
