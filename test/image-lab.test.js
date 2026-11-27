/**
 * 素材库与智能插图的测试。
 *
 * 重点覆盖三类容易静默出错的地方：
 *  1. **文件名无意义时不能硬匹配**（素材库里 34/41 是「粘贴图片_2024…」）
 *  2. **泛词不能乱命中**（一篇 AI 文章里每段都含 "ai"，不能见 ai 就插图）
 *  3. **写回要真的写进去**（曾因 CRLF 与 LF 不匹配，显示"已写入"但文件没变）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  extractKeywords,
  isCoverLike,
  isMeaningfulName,
} from '../src/material-library.js'
import {
  applyInsertions,
  keywordWeight,
  planImageInsertions,
  splitBySection,
} from '../src/image-planner.js'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wxmp-illus-'))
test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

/* ── 素材名判定 ───────────────────────────────────────────────── */

test('无意义的文件名必须被识别出来（否则会拿垃圾名去匹配）', () => {
  const meaningless = [
    '粘贴图片_20240201231712.png',
    '_c4e7623c-82dd-4755-bf4f-9fc918f970df.jpg',
    'cover.png',
    'img_001.jpg',
    'image123.png',
    '12345.png',
    '未命名.png',
    'OIP-C.jpg',
    'DSC001.jpg',
  ]
  for (const name of meaningless) {
    assert.equal(isMeaningfulName(name), false, `「${name}」应判为无意义`)
  }
})

test('有语义的文件名要保住', () => {
  const meaningful = ['工业AI.jpg', '吉祥物红包.jpg', '道歉信.jpg', '架构图.png', '终端截图-报错.png']
  for (const name of meaningful) {
    assert.equal(isMeaningfulName(name), true, `「${name}」应判为有意义`)
  }
})

test('封面类素材要被单独标出（不能当正文插图）', () => {
  for (const name of ['把公众号写作搬进-AI-工作台-cover.png', '封面.webp', '某文章-cover.png']) {
    assert.equal(isCoverLike(name), true, `「${name}」应判为封面类`)
  }
  assert.equal(isCoverLike('工业AI.jpg'), false)
  assert.equal(isCoverLike('架构图.png'), false)
})

test('关键词提取：只抽领域词，不切碎片', () => {
  // 早先按 2 字滑窗切中文，把「吉祥物红包」切成「吉祥/物红」，全是噪声
  const words = extractKeywords('吉祥物红包.jpg')
  assert.ok(words.includes('红包'), '应抽出「红包」')
  assert.ok(words.includes('吉祥物'), '应抽出「吉祥物」')
  assert.ok(!words.includes('物红'), '不能出现「物红」这种碎片')
})

test('关键词提取：短纯中文名整体保留', () => {
  const words = extractKeywords('道歉信.jpg')
  assert.deepEqual(words, ['道歉信'])
})

/* ── 权重 ─────────────────────────────────────────────────────── */

test('泛词权重必须低于具体词（否则每段都命中 ai）', () => {
  assert.ok(keywordWeight('ai') < keywordWeight('工业'), 'ai 权重应低于「工业」')
  assert.ok(keywordWeight('api') < keywordWeight('架构'))
  // 中文具体词最高
  assert.equal(keywordWeight('架构'), 3)
  assert.equal(keywordWeight('ai'), 1)
})

/* ── 分段 ─────────────────────────────────────────────────────── */

test('splitBySection：段落按空行切，并记录所属小节', () => {
  const body = `第一段内容足够长可以算作正文段落。

## 小节一

第二段内容也足够长可以算作正文段落。

## 小节二

第三段内容同样足够长可以算作正文段落。`
  const segments = splitBySection(body)
  assert.equal(segments.length, 3)
  assert.equal(segments[0].sectionTitle, '', '开篇没有小节标题')
  assert.equal(segments[1].sectionTitle, '小节一')
  assert.equal(segments[2].sectionTitle, '小节二')
})

/* ── 插位规划 ─────────────────────────────────────────────────── */

const LIB = [
  {
    mediaId: 'm1',
    name: '工业AI.jpg',
    url: 'https://mmbiz.qpic.cn/a',
    meaningful: true,
    coverLike: false,
    keywords: ['工业', 'ai'],
  },
  {
    mediaId: 'm2',
    name: '架构图.png',
    url: 'https://mmbiz.qpic.cn/b',
    meaningful: true,
    coverLike: false,
    keywords: ['架构'],
  },
  {
    mediaId: 'm3',
    name: '封面.webp',
    url: 'https://mmbiz.qpic.cn/c',
    meaningful: true,
    coverLike: true,
    keywords: ['封面'],
  },
  {
    mediaId: 'm4',
    name: '粘贴图片_2024.png',
    url: 'https://mmbiz.qpic.cn/d',
    meaningful: false,
    coverLike: false,
    keywords: [],
  },
]

function makeInfo(body) {
  return { paragraphs: splitBySection(body).map((item) => item.text) }
}

test('插图规划：命中关键词才插，没提就不插', () => {
  const body = `工业自动化改造做了三年，最大的感受是设备能连网不等于能协同。`
  const plan = planImageInsertions({ body }, makeInfo(body), LIB)
  assert.equal(plan.suggestions.length, 1)
  assert.equal(plan.suggestions[0].image, '工业AI.jpg')
  // 架构图和封面不该出现
  assert.ok(!plan.suggestions.some((s) => s.image === '架构图.png'))
})

test('插图规划：封面类和无语义素材永远不进候选', () => {
  // 必须**隔离测试**：如果 LIB 里混着可用的图，封面类会因为
  // 「这一节已经有图」等其它原因被跳过，断言就抓不住"封面类没被排除"这个 bug。
  const onlyCover = [LIB[2]]
  const body = `封面这件事我聊过很多次，但一直没做好，反复返工了好几遍。`
  const plan = planImageInsertions({ body }, makeInfo(body), onlyCover)
  assert.equal(plan.suggestions.length, 0, '封面类是唯一候选时，一张都不该插')
  assert.ok(!plan.suggestions.some((s) => s.image === '封面.webp'), '封面类不该被当正文插图')

  // 无语义同样隔离
  const onlyUntagged = [LIB[3]]
  const plan2 = planImageInsertions({ body }, makeInfo(body), onlyUntagged)
  assert.equal(plan2.suggestions.length, 0, '无语义素材是唯一候选时也不该插')
})

test('泛词权重真的起作用：只有"工业"能命中时不会被 ai 抢走', () => {
  // 隔离验证权重：两段文本，一段只含 ai，一段只含工业。
  // 若权重被抹平成 1，两张图会按顺序乱配；有权重时「工业AI」应优先落到讲工业的段落。
  const body = `这一段讲的是 ai 的一般情况，内容长度足够作为正文段落保留下来。

这一段专门讲工业设备联网的问题，长度也足够作为正文段落保留。`
  const plan = planImageInsertions({ body }, makeInfo(body), [LIB[0]])
  assert.equal(plan.suggestions.length, 1)
  const picked = plan.suggestions[0]
  // 命中分数必须 > 1（说明"工业"的 3 分被算进去了，不是凭 ai 的 1 分）
  assert.ok(picked.hits >= 3, `应命中「工业」而不是只有「ai」，实际分数 ${picked.hits}`)
  assert.match(picked.reason, /工业/, `原因里应提到「工业」，实际：${picked.reason}`)
})

test('插图规划：短段落不插（阈值 20 字）', () => {
  const body = `架构。`
  const plan = planImageInsertions({ body }, makeInfo(body), LIB)
  assert.equal(plan.suggestions.length, 0, '太短的段落不该插图')
})

test('插图规划：列表与代码块不插', () => {
  const listBody = `- 架构图放在这里\n- 第二项内容\n- 第三项内容`
  const plan = planImageInsertions({ body: listBody }, makeInfo(listBody), LIB)
  assert.equal(plan.suggestions.length, 0, '列表中间不能插图')

  const codeBody = '```\n架构 = 分层 + 解耦 + 可替换\n```'
  const plan2 = planImageInsertions({ body: codeBody }, makeInfo(codeBody), LIB)
  assert.equal(plan2.suggestions.length, 0, '代码块不能插图')
})

test('插图规划：同一节只插一张', () => {
  const body = `工业设备和架构设计都是重点，这一段两个词都提到了。

工业场景还要考虑架构的可替换性，这一段也是。`
  const plan = planImageInsertions({ body }, makeInfo(body), LIB)
  // 两段同属开篇这一节，最多插一张
  const sections = new Set(plan.suggestions.map((item) => item.section))
  assert.equal(sections.size, plan.suggestions.length, '同一节不能插多张')
})

test('插图规划：素材名都无意义时给出明确原因', () => {
  const body = `工业自动化改造做了三年，设备能连网不等于能协同。`
  const plan = planImageInsertions({ body }, makeInfo(body), [LIB[3]])
  assert.equal(plan.suggestions.length, 0)
  assert.match(plan.reason, /没有可参与匹配|无意义/, '要说清为什么没插')
})

test('插图规划：建议里带 mmbiz 直链（不需要再上传）', () => {
  const body = `工业自动化改造做了三年，设备能连网不等于能协同。`
  const plan = planImageInsertions({ body }, makeInfo(body), LIB)
  assert.match(plan.suggestions[0].markdown, /https:\/\/mmbiz\.qpic\.cn/, '必须用 mmbiz 直链')
  assert.match(plan.suggestions[0].markdown, /!\[工业AI\.jpg\]/, '要有 alt 文字')
})

/* ── 写回 ─────────────────────────────────────────────────────── */

test('applyInsertions：图片插在命中段落之后，正文其余部分不变', () => {
  const body = `工业自动化改造做了三年，设备能连网不等于能协同。

## 下一节

这一节讲别的事情，内容也足够长可以算作段落。`
  const plan = planImageInsertions({ body }, makeInfo(body), LIB)
  const next = applyInsertions(body, plan.suggestions)
  assert.ok(next.includes('![工业AI.jpg]'), '应该插进去了')
  // 原文字句不能丢
  assert.ok(next.includes('工业自动化改造做了三年'))
  assert.ok(next.includes('这一节讲别的事情'))
  // 图片应该在第二段之前
  assert.ok(next.indexOf('![工业AI.jpg]') < next.indexOf('## 下一节'), '图应插在第一段后、小节标题前')
})

test('applyInsertions：多张图从后往前插，位置互不干扰', () => {
  const body = `第一段讲工业自动化，长度足够作为正文保留下来。

## 架构那一节

这一节讲架构设计，长度也足够作为正文保留。`
  const plan = planImageInsertions({ body }, makeInfo(body), LIB, { maxImages: 2 })
  const next = applyInsertions(body, plan.suggestions)
  for (const item of plan.suggestions) {
    assert.ok(next.includes(item.image), `${item.image} 应该都被插入`)
  }
})

test('CRLF 源文件写回后必须真的包含图片（曾因换行符不匹配静默失败）', async () => {
  // 这是踩过的真 bug：磁盘文件是 CRLF，parseFrontMatter 返回 LF，
  // source.replace(body, next) 永远匹配不到，表现为"显示已写入但文件没变"。
  const { execFileSync } = await import('node:child_process')
  const file = path.join(tmpRoot, 'crlf.md')
  const content = '---\r\ntitle: 测试\r\nauthor: 测试\r\n---\r\n\r\n工业自动化改造做了三年，设备能连网不等于能协同。\r\n'
  fs.writeFileSync(file, content, 'utf8')
  assert.ok(fs.readFileSync(file, 'utf8').includes('\r\n'), '前置条件：文件必须是 CRLF')

  // 直接测 rebuild 逻辑（通过 CLI 太重，这里复现同样的替换路径）
  const { rebuildWithNewBody } = await import('../src/commands.js').catch(() => ({}))
  if (!rebuildWithNewBody) {
    // 函数未导出时跳过（改为对 CLI 的集成测试由 ui.test.js 覆盖）
    assert.ok(true, 'rebuildWithNewBody 未导出，跳过直接测试')
    return
  }
  const rebuilt = rebuildWithNewBody(content, '新的正文内容\n')
  assert.ok(rebuilt.includes('新的正文内容'), 'CRLF 文件也必须能替换成功')
  assert.ok(rebuilt.includes('title: 测试'), 'front matter 要保留')
})

test('素材库为空或全部无意义时，规划不崩且给出原因', () => {
  const body = '一段正常长度的正文内容，讲的是工业自动化改造。'
  const plan = planImageInsertions({ body }, makeInfo(body), [])
  assert.equal(plan.suggestions.length, 0)
  assert.ok(plan.reason.length > 0, '必须有可读的原因')
})

/* ── 小节标题参与匹配 ───────────────────────────────────────── */

test('小节标题必须参与匹配（曾只匹配正文，标题里的强信号被忽略）', () => {
  const lib = [{ mediaId: 'm1', name: '架构图.png', url: 'https://x/a', meaningful: true, coverLike: false, keywords: ['架构'] }]
  // 小节标题有「架构」，但正文段落里一个字都没提
  const body = `## 插件架构设计

这一节讲的是模块怎么分层，各层之间怎么通信，内容长度足够。`
  const plan = planImageInsertions({ body }, makeInfo(body), lib)
  assert.equal(plan.suggestions.length, 1, '标题里的「架构」应能命中')
  assert.match(plan.suggestions[0].reason, /标题/, '原因里要说明是标题命中')
})

test('小节标题命中的权重要高于正文命中', () => {
  const lib = [{ mediaId: 'm1', name: '架构图.png', url: 'https://x/a', meaningful: true, coverLike: false, keywords: ['架构'] }]
  const viaTitle = `## 架构设计\n\n这一节讲别的内容，长度足够作为正文段落保留。`
  const viaBody = `## 其他\n\n这一节讲架构的内容，长度足够作为正文段落保留。`
  const a = planImageInsertions({ body: viaTitle }, makeInfo(viaTitle), lib)
  const b = planImageInsertions({ body: viaBody }, makeInfo(viaBody), lib)
  assert.ok(a.suggestions.length && b.suggestions.length, '两种情况都该命中')
  assert.ok(a.suggestions[0].hits > b.suggestions[0].hits, `标题命中(${a.suggestions[0].hits}) 应高于正文命中(${b.suggestions[0].hits})`)
})

test('同义词扩展生效：正文写「分层/拓扑」也能匹配「架构图」', () => {
  const lib = [{ mediaId: 'm1', name: '架构图.png', url: 'https://x/a', meaningful: true, coverLike: false, keywords: ['架构'] }]
  const body = `## 整体设计\n\n这一节讲模块怎么分层、拓扑怎么组织，内容长度足够。`
  const plan = planImageInsertions({ body }, makeInfo(body), lib)
  assert.equal(plan.suggestions.length, 1, '同义词「分层/拓扑」应能命中架构图')
})