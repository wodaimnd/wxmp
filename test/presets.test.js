/**
 * 预设系统的测试。
 *
 * 这一层的风险不在「功能能不能跑」，而在三个会**静默出错**的地方：
 *  1. **预设坏了把体检带崩** —— 反馈通道自己挂掉，AI 又瞎了；
 *  2. **权重和不是 100 却照常打分** —— 分数从此不可横向比较，而且没人会发现；
 *  3. **导入覆盖掉用户调好的参数** —— 用户的劳动成果被一次误操作抹掉。
 * 所以下面每个用例都对着其中一条来写，并且断言「坏值被拒绝」，而不只是「没崩」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* ── 隔离：临时 WXMP_HOME，必须在 import 之前设好 ─────────────────── */
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wxmp-preset-'))
if (!tmpHome.includes('wxmp-preset-')) throw new Error('测试目录没落在临时区，拒绝运行')
process.env.WXMP_HOME = tmpHome

const presets = await import('../src/presets.js')
const resolve = await import('../src/preset-resolve.js')
const builtins = await import('../src/builtin-presets.js')
const { parseMarkdown, renderHtml, makeDigest, outline, stats } = await import('../src/markdown.js')
const { reviewArticle } = await import('../src/review.js')

test.after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

/** 造一个可打分的最小 article+rendered。 */
function build(body = '正文一段。', meta = {}) {
  const article = {
    title: meta.title ?? '正常标题',
    author: meta.author ?? '作者',
    digest: '',
    cover: meta.cover === undefined ? 'c.png' : meta.cover,
    theme: 'default',
    sourceUrl: 'https://example.com',
    mediaId: '',
    name: 't',
    path: 'C:/tmp/t.md',
    body,
    bodyStartLine: 1,
  }
  const nodes = parseMarkdown(body)
  const { html, images } = renderHtml(nodes, { theme: 'default' })
  const rendered = { nodes, html, images, digest: makeDigest(nodes, 120), stats: stats(nodes, html), outline: outline(nodes) }
  return { article, rendered }
}

test('内置预设：三个都在，权重各自加总 100，且阈值在允许范围内', () => {
  for (const preset of builtins.PRESETS) {
    const normalized = presets.normalizePreset(preset)
    assert.equal(normalized.ok, true, `${preset.id} 不合法：${normalized.errors.join('；')}`)
    const total = Object.values(normalized.preset.weights).reduce((sum, value) => sum + value, 0)
    assert.equal(total, 100, `${preset.id} 权重合计 ${total}`)
    for (const [key, spec] of Object.entries(presets.THRESHOLD_SPEC)) {
      const value = normalized.preset.thresholds[key]
      assert.ok(value >= spec.min && value <= spec.max, `${preset.id}.${key}=${value} 超出 ${spec.min}~${spec.max}`)
    }
  }
  const ids = builtins.PRESETS.map((item) => item.id)
  assert.deepEqual(ids.slice().sort(), ['deep-longform', 'short-punch', 'standard'])
  // 「短平快」必须真的比「深度长文」宽松更严（否则换预设没有意义）
  const standard = builtins.builtinPresetById('standard')
  const short = builtins.builtinPresetById('short-punch')
  const deep = builtins.builtinPresetById('deep-longform')
  assert.ok(
    short.thresholds.paragraphLong < standard.thresholds.paragraphLong,
    '短稿预设的段落阈值应比标准更严',
  )
  assert.ok(
    deep.thresholds.paragraphLong > standard.thresholds.paragraphLong,
    '长文预设的段落阈值应比标准更宽（否则长文永远不合格）',
  )
})

test('同一篇稿子在不同预设下分数不同（换预设必须真的有效）', () => {
  const body = [
    '为什么没人点开？三个数字说明问题。',
    '',
    '## 标题太长',
    '',
    `${'这句比较长'.repeat(40)}。`,
    '',
    '## 现在能做',
    '',
    '把标题改短再发一次试试。',
  ].join('\n')
  const { article, rendered } = build(body)
  const shortReport = reviewArticle(article, rendered, builtins.builtinPresetById('short-punch'))
  const deepReport = reviewArticle(article, rendered, builtins.builtinPresetById('deep-longform'))
  // 这段正文在短稿标准下算长段，在长文标准下不算 —— 分数必须能反映差异
  const shortLong = shortReport.findings.some((item) => item.code === 'paragraph_long')
  const deepLong = deepReport.findings.some((item) => item.code === 'paragraph_long')
  assert.ok(shortLong, '短稿标准下这段应被判为长段落')
  assert.ok(!deepLong, '长文标准下同一段不该被判为长段落')
  assert.notEqual(shortReport.score, deepReport.score, '两个预设给出的分数必须不同')
})

test('权重合计不是 100 必须被拒绝（否则分数失去可比性）', () => {
  // 注意：只给 4 个旧键会走「旧预设迁移」路径被自动折算成 100，
  // 所以这里刻意给满 5 个键，测的是"用户明确写错了总和"。
  const wrongTotal = presets.normalizePreset({
    id: 'bad',
    weights: { limits: 30, structure: 25, readability: 25, assets: 10, content: 5 }, // 95
  })
  assert.equal(wrongTotal.ok, false, '权重合计 95 却通过了校验')
  assert.match(wrongTotal.errors.join('；'), /合计 95/)

  // 5 键合计正好 100 必须通过（别把正确配置也拒了）
  const correct = presets.normalizePreset({
    id: 'good',
    weights: { limits: 25, structure: 20, readability: 20, assets: 15, content: 20 },
  })
  assert.equal(correct.ok, true, `5 键合计 100 应当通过，实际：${(correct.errors || []).join('；')}`)
})

test('阈值超界、类型不对、min>max 都要报出具体字段', () => {
  const cases = [
    [{ passScore: 999 }, /passScore/],
    [{ paragraphLong: 'abc' }, /paragraphLong/],
    [{ sectionsMin: 9, sectionsMax: 3 }, /sectionsMin/],
    [{ paragraphLong: 400, paragraphHuge: 200 }, /paragraphLong/],
  ]
  for (const [patch, expect] of cases) {
    const result = presets.normalizePreset({ id: 'x', thresholds: patch })
    assert.equal(result.ok, false, `${JSON.stringify(patch)} 应被拒绝`)
    assert.match(result.errors.join('；'), expect)
  }
  // 被拒绝时仍返回可用的 preset（体检能继续跑，只是要告知用户）
  const still = presets.normalizePreset({ id: 'x', thresholds: { passScore: 999 } })
  assert.ok(still.preset.thresholds.passScore <= 100, '坏值不该直接进到 preset 里')
})

test('preset.yml 解析与生成只认三个字段，且会压掉换行', () => {
  const yml = presets.stringifyPresetYml({ name: '测试\n预设', description: '多行\n描述', order: 7 })
  assert.ok(!yml.includes('\n\n\n'), '生成结果不该有多余空行')
  const parsed = presets.parseSimpleYaml(yml)
  assert.equal(parsed.name, '测试 预设', '换行必须压成空格')
  assert.equal(parsed.description, '多行 描述')
  assert.equal(parsed.order, 7)
  // 注释与空行要能跳过
  const parsed2 = presets.parseSimpleYaml('# 注释\nname: A\n\norder: 3\n')
  assert.equal(parsed2.name, 'A')
  assert.equal(parsed2.order, 3)
})

test('首次使用自动落盘内置预设，二次调用不覆盖用户改动', () => {
  const root = resolve.presetsDir()
  const first = presets.ensureBuiltinPresets(root, builtins.PRESETS)
  assert.equal(first.created.length, 3, `首次应落盘 3 个，实际 ${first.created.length}`)
  assert.equal(first.error, null)

  // 模拟用户改了 standard 的及格线
  const stdJson = path.join(root, 'standard', 'review.json')
  const tuned = JSON.parse(fs.readFileSync(stdJson, 'utf8'))
  tuned.thresholds.passScore = 55
  fs.writeFileSync(stdJson, JSON.stringify(tuned), 'utf8')

  const second = presets.ensureBuiltinPresets(root, builtins.PRESETS)
  assert.equal(second.created.length, 0, '第二次不该再新建')
  assert.ok(second.skipped.includes('standard'))
  const after = JSON.parse(fs.readFileSync(stdJson, 'utf8'))
  assert.equal(after.thresholds.passScore, 55, '用户的改动被覆盖了 —— 这是不可接受的')
})

test('选择预设会持久化到 config，并在下次 resolve 时生效', () => {
  assert.equal(resolve.currentPresetId(), 'standard', '初始应为 standard')
  const saved = resolve.savePresetSelection('short-punch')
  assert.equal(saved.ok, true, saved.error || '')
  assert.equal(resolve.currentPresetId(), 'short-punch')
  const fromConfig = resolve.resolvePreset()
  assert.equal(fromConfig.resolvedFrom, 'config', '应当从 config 读回来')
  // 显式传入优先级最高
  const explicit = resolve.resolvePreset('deep-longform')
  assert.equal(explicit.preset.id, 'deep-longform')
  assert.equal(explicit.resolvedFrom, 'explicit')
  // 保存不存在的预设要拒绝
  const bad = resolve.savePresetSelection('nope-xyz')
  assert.equal(bad.ok, false)
  assert.equal(resolve.currentPresetId(), 'short-punch', '拒绝时不该改掉当前选择')
})

test('全新环境：内置预设没落盘时 use/export 不能误判「不合法」（1.7.7 真实 bug 回归）', () => {
  // 模拟首次使用：删掉 short-punch 的磁盘目录，loadPreset 只剩内置回落路径。
  // 1.7.7 的内置对象没有 ok 字段，savePresetSelection 把 !preset.ok 当不合法，
  // 导致全新安装 `wxmp article preset use <内置>` 必挂——这里锁死修复。
  const dir = path.join(resolve.presetsDir(), 'short-punch')
  fs.rmSync(dir, { recursive: true, force: true })

  const loaded = resolve.loadPreset('short-punch')
  assert.equal(loaded.fallback, false, '内置回落不该标 fallback')
  assert.equal(loaded.preset.ok, true, '内置预设必须带 ok:true（listPresets 同一惯例）')

  const saved = resolve.savePresetSelection('short-punch')
  assert.equal(saved.ok, true, `内置未落盘也应能 use：${saved.error || ''}`)
  assert.equal(resolve.currentPresetId(), 'short-punch')

  // export 同理不吃这个亏
  const exported = presets.exportPreset(resolve.loadPreset('short-punch').preset)
  assert.match(exported, /wxmp-review-preset/)

  // 还原磁盘目录，后面的用例还依赖它
  presets.ensureBuiltinPresets(resolve.presetsDir(), builtins.PRESETS)
  assert.ok(fs.existsSync(path.join(dir, 'preset.yml')))
})

test('找不到的预设不报错，回落 standard 并说清原因', () => {
  const result = resolve.resolvePreset('does-not-exist')
  assert.equal(result.preset.id, 'standard')
  assert.match(result.notes.join('；'), /找不到预设 does-not-exist/)
})

test('预设目录损坏时体检仍然可用（退回内置值），并报告原因', () => {
  const dir = path.join(resolve.presetsDir(), 'broken-one')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'preset.yml'), 'name: 坏预设\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'review.json'), '{ 这不是 JSON', 'utf8')

  const loaded = resolve.loadPreset('broken-one')
  assert.equal(loaded.fallback, true, '损坏的预设必须标记为回落')
  assert.ok(loaded.notes.length > 0, '要让用户知道为什么退回了默认')
  assert.equal(loaded.preset.thresholds.passScore, presets.BUILTIN.thresholds.passScore)
  // 关键：拿它打分不能崩
  const { article, rendered } = build()
  const report = reviewArticle(article, rendered, loaded.preset)
  assert.equal(typeof report.score, 'number')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('导出→导入往返后规则与风格完全一致（v2 格式）', () => {
  const source = resolve.loadPreset('deep-longform').preset
  const exported = presets.exportPreset(source)
  const parsed = JSON.parse(exported)
  assert.equal(parsed.format, 'wxmp-review-preset')
  assert.equal(parsed.version, 2, 'v2 才带 style 字段')

  const imported = presets.importPreset(exported, { id: 'roundtrip' })
  assert.equal(imported.ok, true, imported.errors.join('；'))
  assert.deepEqual(imported.preset.thresholds, source.thresholds, '往返后阈值必须逐字一致')
  assert.deepEqual(imported.preset.weights, source.weights, '往返后权重必须逐字一致')
  assert.equal(imported.preset.style, source.style, '往返后风格提示词必须逐字一致')
})

test('v1 老导出文件没有 style 也能导入（只是没有风格提示词）', () => {
  const source = resolve.loadPreset('standard').preset
  const v1 = JSON.stringify({
    format: 'wxmp-review-preset',
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    name: source.name,
    description: source.description,
    order: source.order,
    thresholds: source.thresholds,
    weights: source.weights,
  })
  const imported = presets.importPreset(v1, { id: 'legacy-v1' })
  assert.equal(imported.ok, true, imported.errors.join('；'))
  assert.deepEqual(imported.preset.thresholds, source.thresholds, 'v1 的阈值必须原样进来')
  assert.equal(imported.preset.style, '', 'v1 没有 style，导入后风格为空')
  assert.ok(imported.warnings.some((w) => /风格提示词/.test(w)), '要让用户知道这份预设只能打分')
})

test('内置预设自带风格提示词（预设先是写作提示词，再是打分线）', () => {
  for (const preset of builtins.PRESETS) {
    assert.ok(String(preset.style || '').trim().length > 50, `${preset.id} 的风格提示词缺失或太短`)
  }
})

test('缺风格提示词只警告不算错误（打分不依赖它）', () => {
  const noStyle = presets.normalizePreset({
    id: 'no-style',
    weights: { limits: 25, structure: 20, readability: 20, assets: 15, content: 20 },
  })
  assert.equal(noStyle.ok, true, (noStyle.errors || []).join('；'))
  assert.ok(noStyle.warnings.some((w) => /风格提示词/.test(w)), '缺 style 必须给出警告')
  assert.equal(noStyle.preset.style, '')
})

test('composePresetPrompt：风格正文 + 六行节奏参考；无风格时 hasStyle=false', () => {
  const std = resolve.loadPreset('standard').preset
  const prompt = resolve.composePresetPrompt(std)
  assert.equal(prompt.id, 'standard')
  assert.equal(prompt.hasStyle, true)
  assert.ok(prompt.style.length > 50, '风格正文不能是空的')
  assert.equal(prompt.rhythmLines.length, 6, '节奏参考固定六行')
  assert.ok(
    prompt.rhythmLines.some((line) => line.includes(String(std.thresholds.passScore))),
    '节奏行要带真实阈值（及格线），不能是写死的数',
  )
  const bare = resolve.composePresetPrompt({
    id: 'bare',
    name: '裸预设',
    thresholds: { ...presets.BUILTIN.thresholds },
    weights: { ...presets.BUILTIN.weights },
  })
  assert.equal(bare.hasStyle, false)
  assert.equal(bare.style, '')
  assert.equal(bare.rhythmLines.length, 6)
  // 坏输入回落内置 standard，不能抛错
  assert.equal(resolve.composePresetPrompt(null).id, 'standard')
})

test('style.md 与预设同步：有风格写文件，force 覆盖成无风格要删残留', () => {
  const root = resolve.presetsDir()
  const withStyle = { ...resolve.loadPreset('short-punch').preset, id: 'sync-me' }
  presets.writePresetDir(root, withStyle)
  const stylePath = path.join(root, 'sync-me', 'style.md')
  assert.ok(fs.existsSync(stylePath), '带风格的预设落盘必须写 style.md')

  presets.writePresetDir(root, { ...withStyle, style: '' }, { force: true })
  assert.ok(!fs.existsSync(stylePath), '覆盖成无风格后残留的 style.md 必须被删掉')
  assert.equal(resolve.loadPreset('sync-me').preset.style, '')

  presets.removePresetDir(root, 'sync-me')
})

test('1.7.x 升级路径：ensure 逐文件补齐 style.md，不覆盖用户调过的 review.json', () => {
  const root = resolve.presetsDir()
  const dir = path.join(root, 'deep-longform')
  const stylePath = path.join(dir, 'style.md')
  fs.rmSync(stylePath, { force: true })
  const jsonPath = path.join(dir, 'review.json')
  const tuned = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  tuned.thresholds.passScore = 60
  fs.writeFileSync(jsonPath, JSON.stringify(tuned, null, 2), 'utf8')

  const result = presets.ensureBuiltinPresets(root, builtins.PRESETS)
  assert.ok(result.created.includes('deep-longform'), '缺 style.md 的存量预设应被补齐')
  assert.ok(fs.existsSync(stylePath), '升级后 style.md 必须回来（存量用户也要拿到风格提示词）')
  const after = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  assert.equal(after.thresholds.passScore, 60, '补齐风格不能覆盖用户的调参')
})

test('导入不认识的内容要拒绝，并说明哪里不对', () => {
  const notJson = presets.importPreset('not json at all')
  assert.equal(notJson.ok, false)
  assert.match(notJson.errors.join('；'), /不是合法 JSON/)

  const wrongFormat = presets.importPreset(JSON.stringify({ format: 'something-else' }))
  assert.equal(wrongFormat.ok, false)
  assert.match(wrongFormat.errors.join('；'), /format/)
})

test('同名导入默认拒绝覆盖；force 才允许（保护用户的调参成果）', () => {
  const root = resolve.presetsDir()
  const preset = { ...resolve.loadPreset('short-punch').preset, id: 'mine' }
  const first = presets.writePresetDir(root, preset)
  assert.equal(first.id, 'mine')
  assert.ok(fs.existsSync(path.join(root, 'mine', 'review.json')))

  const again = () => presets.writePresetDir(root, preset)
  assert.throws(again, (error) => {
    assert.equal(error.code, 'preset_exists', '必须用可识别的错误码，上层才能给提示')
    assert.match(error.message, /force/)
    return true
  })
  // 显式 force 才能覆盖
  const forced = presets.writePresetDir(root, preset, { force: true })
  assert.equal(forced.id, 'mine')
})

test('删除：standard 受保护，其它可删，删不存在要报 not_found', () => {
  const root = resolve.presetsDir()
  assert.throws(
    () => presets.removePresetDir(root, 'standard'),
    (error) => {
      assert.equal(error.code, 'preset_protected')
      return true
    },
  )
  // 上面刚建的 mine 可以被删
  presets.removePresetDir(root, 'mine')
  assert.ok(!fs.existsSync(path.join(root, 'mine')))
  assert.throws(
    () => presets.removePresetDir(root, 'mine'),
    (error) => {
      assert.equal(error.code, 'preset_not_found')
      return true
    },
  )
})

test('预设 id 白名单挡住目录穿越', () => {
  for (const bad of ['../evil', 'a/b', '', ' ', 'con:x', '.hidden']) {
    assert.throws(() => presets.safePresetId(bad), (error) => {
      assert.equal(error.code, 'preset_id_invalid', `${JSON.stringify(bad)} 没被挡住`)
      return true
    })
  }
  assert.equal(presets.safePresetId('my-style_2'), 'my-style_2')
})

test('列表按 order 排序，并标出当前生效的那个', () => {
  const { presets: rows } = resolve.listPresets()
  assert.ok(rows.length >= 3)
  const orders = rows.map((item) => item.order)
  for (let i = 1; i < orders.length; i += 1) {
    assert.ok(orders[i] >= orders[i - 1], '预设列表必须按 order 升序')
  }
  const current = resolve.currentPresetId()
  assert.ok(rows.some((item) => item.id === current), '当前生效的预设必须在列表里')
})
