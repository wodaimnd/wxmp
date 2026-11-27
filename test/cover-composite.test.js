/**
 * 封面背景合成的测试。
 *
 * 重点是三个会**静默出错**的地方：
 *  1. 等比裁剪算错 → 图被拉扁（人眼看得出来，但代码返回值全是成功）
 *  2. 尺寸读取错 → 裁剪矩形越界，GDI 画出一片空白也不报错
 *  3. 底图缺失/损坏时整个 cover 崩 → 用户拿不到任何封面
 *
 * 合成本身依赖 Windows GDI+，所以「算矩形」和「读尺寸」用纯单测，
 * 「真的能生成图」用带 skip 的集成用例（非 Windows 跳过）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { COVER_SIZE, planCover } from '../tools/cover-layout.js'
import {
  BACKGROUND_MODES,
  buildCompositeScript,
  composeWithBackground,
  planBackgroundFit,
  readImageSize,
} from '../tools/cover-composite.js'
import { buildCoverPrompt, chooseRequestSizes, describeImageProviders, resolveImageChain } from '../tools/cover-imagegen.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wxmp-comp-'))
test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('等比裁剪：宽图裁左右，不拉伸变形', () => {
  // 1536×1024（1.5:1）→ 900×383（2.35:1）：源更"高"，应以高度为准裁左右
  const fit = planBackgroundFit(1536, 1024, 900, 383)
  // 期望可见宽 = 1024 * 2.35 ≈ 2407 > 1536？不，应当以宽为准 → 裁上下
  // 实际：1.5 < 2.35，源比目标更窄 → 裁上下
  assert.equal(fit.dx, 0)
  assert.equal(fit.dy, 0)
  assert.equal(fit.dw, 900)
  assert.equal(fit.dh, 383)
  // 裁完的源区域宽高比必须等于目标宽高比，否则一定变形
  const srcRatio = fit.sw / fit.sh
  const dstRatio = fit.dw / fit.dh
  assert.ok(Math.abs(srcRatio - dstRatio) < 0.01, `源裁剪比 ${srcRatio.toFixed(3)} 与目标 ${dstRatio.toFixed(3)} 不一致 → 会变形`)
  // 且不能越界
  assert.ok(fit.sw <= 1536 && fit.sh <= 1024, '裁剪区域不得超出原图')
})

test('等比裁剪：超宽图裁左右，比例同样守得住', () => {
  const fit = planBackgroundFit(3000, 1000, 900, 383) // 3:1 → 2.35:1，源更宽
  const srcRatio = fit.sw / fit.sh
  const dstRatio = fit.dw / fit.dh
  assert.ok(Math.abs(srcRatio - dstRatio) < 0.01, `会变形：${srcRatio} vs ${dstRatio}`)
  assert.ok(fit.sx > 0, '超宽图应当从左右裁，sx 不该为 0')
  assert.equal(fit.sy, 0)
  assert.ok(fit.sx + fit.sw <= 3000, '左右裁不能越界')
})

test('等比裁剪：正方形图裁上下，居中裁', () => {
  const fit = planBackgroundFit(1000, 1000, 900, 383)
  const srcRatio = fit.sw / fit.sh
  assert.ok(Math.abs(srcRatio - 2.35) < 0.02)
  assert.equal(fit.sx, 0)
  assert.ok(fit.sy > 0, '正方形应当裁上下')
  assert.ok(fit.sy + fit.sh <= 1000)
})

test('尺寸未知时不崩：整张铺满，交给 GDI 自己缩', () => {
  const fit = planBackgroundFit(0, 0, 900, 383)
  assert.equal(fit.dw, 900)
  assert.equal(fit.dh, 383)
  // 不能返回负数或 NaN
  for (const key of ['sx', 'sy', 'sw', 'sh']) {
    assert.ok(Number.isFinite(fit[key]), `${key} 不是有限数`)
    assert.ok(fit[key] >= 0, `${key} 不能为负`)
  }
})

test('PNG 尺寸读取：从文件头拿，不解码整图', () => {
  // 造一个最小合法 PNG 头（宽 900 高 383）
  const buf = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buf, 0)
  buf.writeUInt32BE(900, 16)
  buf.writeUInt32BE(383, 20)
  const file = path.join(tmp, 'fake.png')
  fs.writeFileSync(file, buf)
  const size = readImageSize(file)
  assert.equal(size.width, 900)
  assert.equal(size.height, 383)
  assert.equal(size.mime, 'image/png')
})

test('合成脚本包含关键步骤：读图、裁剪、压暗、中文标题', () => {
  const plan = planCover({ title: '把公众号写作搬进 AI 工作台：一个插件的取舍', subtitle: 'YG', badge: 'WXMP' })
  const script = buildCompositeScript({
    plan,
    backgroundPath: 'C:\\bg.png',
    backgroundWidth: 1536,
    backgroundHeight: 1024,
    outPath: 'C:\\out.png',
  })
  // 1) 必须读底图
  assert.match(script, /Image\]::FromFile/, '缺少读取底图')
  // 2) 必须用源/目标矩形做裁剪（不是简单 DrawImage 拉伸）
  assert.match(script, /DrawImage\(\$bg, \$dstRect, \$srcRect/, '没按矩形裁剪，会拉伸变形')
  // 3) 必须有压暗蒙版（否则亮底白字看不清）
  //    注意 $ 要转义：正则里 $scrim 会被当成行尾锚点，永远匹配不到
  assert.match(script, /\$scrim/, '缺少压暗蒙版')
  // 4) 字体必须显式 Pixel（Point 单位会让标题冲出画布，已踩过坑）
  assert.match(script, /GraphicsUnit\]::Pixel/, '字体单位没指定 Pixel，46pt 会变大 1.33 倍')
  // 5) 必须 NoWrap，不能让 GDI 二次折行破坏版式
  assert.match(script, /NoWrap/, '缺少 NoWrap，GDI 会自己折行')
  // 6) 标题逐行绘制（plan.placements 有几行就画几次）
  const draws = (script.match(/DrawString/g) || []).length
  assert.ok(draws >= plan.placements.length, `标题行数 ${plan.placements.length}，DrawString 只有 ${draws} 次`)
})

test('底图不存在时返回明确错误，不抛异常', async () => {
  const result = await composeWithBackground({
    backgroundPath: path.join(tmp, 'nope.png'),
    outPath: path.join(tmp, 'out.png'),
    plan: planCover({ title: 'x' }),
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /底图不存在/)
})

test('真合成：能生成 900×383 且不再是纯色（Windows 才跑）', { skip: process.platform !== 'win32' }, async () => {
  // 造一张有内容的底图：左深右亮的渐变
  const mk = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap -ArgumentList 1536,1024
$g = [System.Drawing.Graphics]::FromImage($bmp)
$br = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point 0,0), (New-Object System.Drawing.Point 1536,1024),
  [System.Drawing.Color]::FromArgb(10,30,50), [System.Drawing.Color]::FromArgb(200,220,240))
$g.FillRectangle($br, 0, 0, 1536, 1024)
$bmp.Save('${path.join(tmp, 'bg.png').replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`
  const psFile = path.join(tmp, 'mk.ps1')
  fs.writeFileSync(psFile, mk, 'utf8')
  const { spawnSync } = await import('node:child_process')
  const made = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], { encoding: 'utf8' })
  assert.equal(made.status, 0, `造底图失败：${made.stderr}`)

  const outPath = path.join(tmp, 'cover.png')
  const plan = planCover({ title: '中文标题测试', subtitle: '副标题', badge: 'WXMP' })
  const result = await composeWithBackground({ backgroundPath: path.join(tmp, 'bg.png'), outPath, plan })
  assert.equal(result.ok, true, result.error)

  const buf = fs.readFileSync(outPath)
  const size = readImageSize(outPath)
  assert.equal(size.width, COVER_SIZE.width)
  assert.equal(size.height, COVER_SIZE.height)
  // 必须真的是有内容的图（不是全黑或全白）：抽样看看有没有多样颜色
  assert.ok(buf.length > 20 * 1024, `生成图太小（${buf.length} 字节），可能没画上内容`)
})

test('内置提示词必须是散文短句、不出现会被画进图的结构化标记', () => {
  const prompt = buildCoverPrompt({ title: '测试标题', theme: 'dark' })
  // 实测教训：写成 "IMPORTANT CONSTRAINTS:" + 列表条目时，
  // AI 会把清单文字本身画进图里，压住中文标题。
  assert.doesNotMatch(prompt, /IMPORTANT CONSTRAINTS/i, '不能用大写强调词，会被当成要渲染的内容')
  assert.doesNotMatch(prompt, /^\s*[-*]\s/m, '不能用列表，列表会被理解为排版内容')
  assert.doesNotMatch(prompt, /\n/, '应该是一段连贯散文，不是分行清单')
  // 主题色调要跟着 theme 走
  assert.match(prompt, /navy blue/i, 'dark 主题应给深蓝色调')
  // 标题不能作为要渲染的内容塞进去（否则模型会把标题画在图上）
  assert.doesNotMatch(prompt, /测试标题/, '副标题不该出现在提示词里，会被画进图')
  // 2026-11-09：不再追加任何内容约束。
  // 用户反馈原话：「限制了 AI 生成图片，不需要」—— 写了浓郁色彩却拿到被冲淡的抽象图。
  assert.doesNotMatch(
    prompt,
    /headline|placed on top|no writing|no lettering|no symbols|no logos|low-contrast|left side stays calm/i,
    '不得再追加内容约束（无字 / 左侧留空 / 低对比），用户明确说过这限制了 AI 出图',
  )
})

test('自定义提示词：逐字提交，一个字符都不追加', () => {
  const custom = '深蓝色与青色流动渐变，右上角柔和光晕，电影质感'
  const prompt = buildCoverPrompt({ title: 'x', theme: 'default' }, { customPrompt: custom })
  // 这是本用例的全部意义：用户写什么就提交什么。
  // 用 equal 而不是 startsWith —— startsWith 会放过"后面又追加了一句"的回归。
  assert.equal(prompt, custom, '用户提示词必须逐字提交，不许追加任何约束或前缀')
  assert.doesNotMatch(prompt, /Wide panorama backdrop/i, '不能追加英文句，会被渲染成图上文字')
  assert.doesNotMatch(prompt, /横向全景构图/, '不再追加横向构图约束')
  assert.doesNotMatch(prompt, /不要出现任何文字/, '不再追加无文字约束')
  // 主题色板也不能混进用户自己的提示词里
  assert.doesNotMatch(prompt, /forest green|navy blue|crimson/i, '用户写了提示词时不该掺入内置色板')
})

test('自定义提示词为空白时回落内置模板（空白不能当成"用户写了空提示词"）', () => {
  const builtin = buildCoverPrompt({ title: 'x', theme: 'default' })
  for (const blank of ['', '   ', '\n\t ']) {
    const out = buildCoverPrompt({ title: 'x', theme: 'default' }, { customPrompt: blank })
    assert.equal(out, builtin, `空白提示词 ${JSON.stringify(blank)} 应回落内置模板`)
  }
})

test('请求尺寸：推荐比例沿用实测档，改了比例才现算', () => {
  // 推荐比例（含不传 coverSize）必须原样返回实测跑通过的组合。
  // 用 equal 而不是 match —— 公式算出来"更准"的 1664x708 会踩供应商 400，不能悄悄换掉。
  assert.deepEqual(chooseRequestSizes(undefined), { size: '1536x1024', sizeWide: '1664x704' })
  assert.deepEqual(chooseRequestSizes({ width: 900, height: 383 }), { size: '1536x1024', sizeWide: '1664x704' })
  // 微小偏离（900×384）仍算推荐档，不该换尺寸
  assert.deepEqual(chooseRequestSizes({ width: 900, height: 384 }), { size: '1536x1024', sizeWide: '1664x704' })

  // 真改了比例：OpenAI 档必须落在合法枚举里，魔搭档必须是 WxH 且高度为偶数
  const wide = chooseRequestSizes({ width: 1600, height: 500 })
  assert.ok(['1536x1024', '1024x1024', '1024x1536'].includes(wide.size), `OpenAI 档不能瞎给：${wide.size}`)
  assert.match(wide.sizeWide, /^1664x\d+$/, `魔搭档必须是 1664x<偶数>：${wide.sizeWide}`)
  assert.equal(Number(wide.sizeWide.split('x')[1]) % 2, 0, '高度必须取偶数')
  // 宽扁比例应该选最宽的那档，而不是默认的第一档
  assert.equal(wide.size, '1536x1024', '16:5 应该挑最接近的横档')

  const tall = chooseRequestSizes({ width: 400, height: 900 })
  assert.equal(tall.size, '1024x1536', '竖构图应该挑竖档，否则出来的图取向完全不对')
})

test('提示词规格说明与实际请求尺寸一致（改了后端不会忘改文案）', async () => {
  const { PROMPT_SPEC_INFO } = await import('../tools/cover-imagegen.js')
  const { COVER_SIZE } = await import('../tools/cover-layout.js')
  // 文案里写的像素值必须等于真实的封面尺寸
  assert.ok(
    PROMPT_SPEC_INFO.size.includes(String(COVER_SIZE.width)),
    `规格文案 "${PROMPT_SPEC_INFO.size}" 与真实宽度 ${COVER_SIZE.width} 不一致`,
  )
  assert.ok(PROMPT_SPEC_INFO.size.includes(String(COVER_SIZE.height)))
  // 比例也要对得上（900/383 ≈ 2.35）
  const ratio = (COVER_SIZE.width / COVER_SIZE.height).toFixed(2)
  assert.equal(PROMPT_SPEC_INFO.aspect, `${ratio}:1`, `比例文案应为 ${ratio}:1`)
})

test('无 key 时 resolveImageChain 返回空链（调用方据此回落，不是报错）', () => {
  // 这个用例不能依赖「本机恰好没配 key」——用户的真实配置里可能已经配了。
  // 所以用独立的 WXMP_HOME 造一个干净环境，并清掉相关环境变量。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wxmp-nokey-'))
  const savedHome = process.env.WXMP_HOME
  const touched = [
    'WXMP_IMG_OPENAI', 'OPENAI_API_KEY', 'WXMP_IMG_GEMINI', 'GEMINI_API_KEY',
    'WXMP_IMG_MODELSCOPE', 'MODELSCOPE_API_TOKEN', 'WXMP_IMG_DOUBAO', 'ARK_API_KEY',
  ]
  const saved = {}
  for (const name of touched) {
    saved[name] = process.env[name]
    delete process.env[name]
  }
  process.env.WXMP_HOME = home
  try {
    const result = resolveImageChain({})
    assert.equal(result.chain.length, 0, '没有 key 时不该有可用供应商')
    // 而且必须返回 note，供上层说明
    assert.equal(typeof result.note, 'string')
    const desc = describeImageProviders()
    assert.equal(desc.available, false, 'available 应为 false')
  } finally {
    if (savedHome === undefined) delete process.env.WXMP_HOME
    else process.env.WXMP_HOME = savedHome
    for (const name of touched) {
      if (saved[name] !== undefined) process.env[name] = saved[name]
    }
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('有 key 时进链，且没 key 的供应商被剔除', () => {
  process.env.WXMP_IMG_OPENAI = 'sk-fake-for-test'
  try {
    const result = resolveImageChain({})
    assert.ok(result.chain.length >= 1, '有 key 的应当进链')
    const openai = result.chain.find((e) => e.providerId === 'openai')
    assert.ok(openai, 'openai 有 key 却没进链')
    assert.equal(openai.apiKey, 'sk-fake-for-test')
    // 其它家没 key，不该出现在链里（避免白跑必失败请求）
    assert.equal(result.chain.filter((e) => e.providerId === 'gemini').length, 0)
  } finally {
    delete process.env.WXMP_IMG_OPENAI
  }
})

test('BACKGROUND_MODES 三档齐全（对应三种背景来源）', () => {
  assert.equal(BACKGROUND_MODES.FILE, 'file')
  assert.equal(BACKGROUND_MODES.GENERATED, 'generated')
  assert.equal(BACKGROUND_MODES.GRADIENT, 'gradient')
})
