/**
 * 同义词表与命名规范的测试。
 *
 * 这两块共同决定"插图能不能匹配上"，所以要锁住三件事：
 *  1. **同义词扩展要准**（架构图 → 分层/模块/拓扑），但不能乱扩
 *  2. **误命中要防住**（"是这样的"不该判成截图）
 *  3. **命名建议不能误导**（不知道图类时别乱猜前缀）
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONCEPT_GROUPS,
  expandAll,
  expandSynonyms,
  listConceptGroups,
  matchGroups,
} from '../src/image-synonyms.js'
import {
  NAMING_RULES,
  TYPE_PREFIXES,
  buildNamingGuide,
  validateName,
} from '../src/naming-guide.js'

/* ── 同义词 ───────────────────────────────────────────────────── */

test('扩展：核心概念能覆盖整组说法', () => {
  const arch = expandSynonyms('架构')
  assert.equal(arch.groupId, '架构')
  assert.ok(arch.aliases.length >= 5, '架构组应有足够别名')
  for (const word of ['分层', '模块', '拓扑', '系统设计']) {
    assert.ok(arch.aliases.includes(word), `架构组应包含「${word}」`)
  }
})

test('扩展：带「图」后缀也能识别（用户命名几乎一定带后缀）', () => {
  for (const name of ['架构图', '架构示意图', '流程图', '终端截图']) {
    const result = expandSynonyms(name)
    assert.notEqual(result.groupId, '', `「${name}」应能识别出概念组`)
  }
})

test('扩展：别名反向也能命中同组', () => {
  // 用户可能直接命名为「分层.png」
  const result = expandSynonyms('分层')
  assert.equal(result.groupId, '架构', '「分层」应归到架构组')
})

test('扩展：不认识的词原样返回，不乱扩', () => {
  const result = expandSynonyms('某个奇怪的东西')
  assert.equal(result.groupId, '')
  assert.deepEqual(result.aliases, ['某个奇怪的东西'])
})

test('expandAll：多词合并去重，并返回涉及的组', () => {
  const result = expandAll(['架构', '红包'])
  assert.ok(result.groups.includes('架构'))
  assert.ok(result.groups.includes('红包'))
  // 去重后不应有重复
  assert.equal(new Set(result.terms).size, result.terms.length)
  // 两组的词都在
  assert.ok(result.terms.includes('分层'), '应含架构组别名')
  assert.ok(result.terms.includes('利是'), '应含红包组别名')
})

test('matchGroups：正文里出现别名就能命中组', () => {
  const hits = matchGroups('这一节讲模块怎么分层，各层之间怎么通信。')
  const ids = hits.map((item) => item.groupId)
  assert.ok(ids.includes('架构'), '「分层/模块」应命中架构组')
})

test('matchGroups：泛用短语不能误命中（"是这样的"曾被当成截图）', () => {
  const hits = matchGroups('这个方案就是这样，没什么特别的。')
  const ids = hits.map((item) => item.groupId)
  assert.ok(!ids.includes('截图'), '「是这样」不该命中截图组')
})

test('每个概念组都要有 id 与至少 3 个别名（避免空组）', () => {
  for (const group of CONCEPT_GROUPS) {
    assert.ok(group.id && group.id.length > 0, '组必须有 id')
    assert.ok(group.label, `${group.id} 缺 label`)
    assert.ok(group.aliases.length >= 3, `${group.id} 别名太少（${group.aliases.length}）`)
    // id 必须在自己的别名里，否则扩展时会漏掉自己
    assert.ok(group.aliases.includes(group.id), `${group.id} 的别名里应包含自己`)
  }
})

test('listConceptGroups：供 CLI/面板展示的清单完整', () => {
  const list = listConceptGroups()
  assert.equal(list.length, CONCEPT_GROUPS.length)
  for (const item of list) {
    assert.ok(item.id && item.label)
    assert.ok(item.aliasCount >= 3)
  }
})

/* ── 命名规范 ─────────────────────────────────────────────────── */

test('合规的命名能通过校验', () => {
  const good = [
    '架构图-插件加载.png',
    '架构示意图-分层.png',
    '终端截图-401报错.jpg',
    '流程-鉴权链路.png',
    '红包-春节活动.png',
  ]
  for (const name of good) {
    const result = validateName(name)
    assert.equal(result.ok, true, `「${name}」应合规，问题：${result.issues.join('；')}`)
  }
})

test('不合规的命名要指出问题', () => {
  const cases = [
    ['粘贴图片_20240201231712.png', /图类前缀/],
    ['cover.png', /图类前缀/],
    ['插件加载.png', /图类前缀/],
    ['截图.png', /只有图类没有具体内容/],
  ]
  for (const [name, pattern] of cases) {
    const result = validateName(name)
    assert.equal(result.ok, false, `「${name}」应被判不合规`)
    assert.ok(
      result.issues.some((issue) => pattern.test(issue)),
      `「${name}」的问题里应提到 ${pattern}，实际：${result.issues.join('；')}`,
    )
  }
})

test('命名建议不能乱猜图类（曾把 cover.png 建议成 架构-cover.png）', () => {
  // 无信息量的名字：不该给出带具体图类的建议
  for (const name of ['cover.png', '粘贴图片_20240201231712.png', '截图.png']) {
    const result = validateName(name)
    assert.equal(result.ok, false)
    assert.ok(
      !/^架构-/.test(result.suggestion || ''),
      `「${name}」不该被建议成「架构-…」，实际：${result.suggestion}`,
    )
  }
})

test('有内容但不知道图类时，建议里用占位符而不是瞎猜', () => {
  const result = validateName('插件加载.png')
  assert.equal(result.ok, false)
  assert.match(result.suggestion, /<图类>/, '应用占位符让用户自己选前缀')
  assert.match(result.suggestion, /插件加载/, '内容段要保留')
})

test('超长名字要提示会被截断', () => {
  const result = validateName('架构图-这是一个非常非常长的具体内容描述超过了建议的长度上限.png')
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((issue) => /截断|≤/.test(issue)))
})

test('扩展名不在微信白名单要报出来', () => {
  const result = validateName('架构图-插件加载.tiff')
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((issue) => /扩展名/.test(issue)))
})

test('TYPE_PREFIXES 与同义词组一一对应（加组忘加前缀会导致命名表缺项）', () => {
  assert.equal(TYPE_PREFIXES.length, CONCEPT_GROUPS.length)
  for (const group of CONCEPT_GROUPS) {
    const found = TYPE_PREFIXES.find((item) => item.prefix === group.id)
    assert.ok(found, `概念组 ${group.id} 在命名表里没有对应前缀`)
    assert.ok(found.when && found.when.length > 0, `${group.id} 缺"什么时候用"的说明`)
  }
})

test('命名规范表包含格式、正例、反例与全部前缀', () => {
  const guide = buildNamingGuide()
  assert.match(guide, /格式/, '要有格式说明')
  assert.match(guide, /<图类>-<具体内容>/, '要写清格式')
  assert.match(guide, /正例/, '要有正例')
  assert.match(guide, /反例/, '要有反例')
  assert.match(guide, /同义词扩展|覆盖这些说法/, '要解释为什么这样命名')
  // 每个前缀都要出现在表里
  for (const item of TYPE_PREFIXES) {
    assert.ok(guide.includes(`\`${item.prefix}\``), `规范表里缺少前缀 ${item.prefix}`)
  }
  assert.ok(NAMING_RULES.maxLength > 0)
})
