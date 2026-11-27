/**
 * 吸收代码的行为验证 —— 证明从 dsh-wewrite 搬来的配图逻辑在新宿主里行为一致。
 *
 * 为什么要这个文件：吸收最大的风险是「代码在原来那个插件里对，搬过来悄悄不对了」。
 * 这里不测「有没有这个函数」，而是测**那段代码最值钱的两个行为**：
 *   1. 单家失败必须自动降下一家（不是整条链失败）
 *   2. 可重试错误必须重试，鉴权错误必须不重试（否则白等）
 *
 * 全程注入假 fetchImpl，不联网。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  IMAGE_PROVIDER_IDS,
  DEFAULT_IMAGE_PROVIDER_CHAIN,
  PROVIDER_FACTORIES,
  ImageProviderError,
  ImageFallbackExhaustedError,
  MAX_TRIES_PER_PROVIDER,
  RETRYABLE_BY_CODE,
  buildProviderChain,
  classifyStatus,
  createCustomProvider,
  joinUrl,
  runImageFallback,
  sniffMime,
  truncateMessage,
} from '../lib/absorbed/wewrite-imagegen.js'

/** 造一个可控的假 fetch：按 URL 决定返回什么。 */
function makeFetch(routes) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body })
    for (const [pattern, handler] of routes) {
      if (url.includes(pattern)) return handler(url, init)
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: 'no route' } }) }
  }
  impl.calls = calls
  return impl
}

/** 造一个假 provider，行为由 fn 决定。 */
function fakeProvider(id, fn) {
  return { id, async generate(req, cfg) { return fn(req, cfg) } }
}

const GOOD_IMAGE = {
  images: [{ buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), mime: 'image/png' }],
  model: 'test-model',
}

test('10 家供应商全在，默认链顺序合理', () => {
  assert.equal(Object.keys(PROVIDER_FACTORIES).length, 10)
  assert.deepEqual(IMAGE_PROVIDER_IDS.slice().sort(), [
    'azure_openai', 'dashscope', 'doubao', 'gemini', 'jimeng', 'minimax',
    'modelscope', 'openai', 'openrouter', 'replicate',
  ])
  // openai 排第一：质量优先；魔搭排第二：国内直连最稳
  assert.equal(DEFAULT_IMAGE_PROVIDER_CHAIN[0], 'openai')
  assert.equal(DEFAULT_IMAGE_PROVIDER_CHAIN[1], 'modelscope')
  // 链里每一项都要有工厂，否则运行时空转
  for (const id of DEFAULT_IMAGE_PROVIDER_CHAIN) {
    assert.ok(PROVIDER_FACTORIES[id], `默认链里的 ${id} 没有对应工厂`)
  }
  // 顺序表与工厂表必须一一对应，不能有漏（漏了就是"配了 key 却永远轮不到"）
  assert.deepEqual(
    DEFAULT_IMAGE_PROVIDER_CHAIN.slice().sort(),
    IMAGE_PROVIDER_IDS.slice().sort(),
    '默认链与工厂表必须覆盖同一批供应商',
  )
})

test('fallback：第一家失败自动降第二家，最终成功', async () => {
  const calls = []
  const providers = [
    fakeProvider('bad', async () => {
      calls.push('bad')
      throw new ImageProviderError({ providerId: 'bad', code: 'PROVIDER', message: 'boom' })
    }),
    fakeProvider('good', async () => {
      calls.push('good')
      return GOOD_IMAGE
    }),
  ]
  const outcome = await runImageFallback(providers, () => ({}), { prompt: 'x', n: 1 })
  assert.equal(outcome.providerId, 'good', '应当降级到第二家并成功')
  assert.equal(outcome.result.images.length, 1)
  // attempts 必须记录两家，且第一家标记 error
  assert.equal(outcome.attempts.length, 2)
  assert.equal(outcome.attempts[0].outcome, 'error')
  assert.equal(outcome.attempts[1].outcome, 'success')
})

test('fallback：可重试错误会重试到上限，再降级（不是一次就放弃）', async () => {
  let badTries = 0
  const providers = [
    fakeProvider('flaky', async () => {
      badTries += 1
      throw new ImageProviderError({ providerId: 'flaky', code: 'RATE_LIMIT', message: '429' })
    }),
    fakeProvider('good', async () => GOOD_IMAGE),
  ]
  const outcome = await runImageFallback(providers, () => ({}), { prompt: 'x', n: 1 })
  // 断言写死 2，不引用 MAX_TRIES_PER_PROVIDER：
  // 引用被测常量会让「把 2 改成 1」这种退化永远不被发现（断言跟着常量一起变）。
  assert.equal(badTries, 2, `可重试错误应试满 2 次，实际 ${badTries}`)
  assert.equal(outcome.providerId, 'good')
  assert.equal(outcome.attempts[0].tries, 2)
  // 顺带锁住常量本身就是 2（这条能独立抓住退化）
  assert.equal(MAX_TRIES_PER_PROVIDER, 2, '单家重试上限应为 2')
})

test('fallback：鉴权错误不重试（AUTH 重试没意义，只会浪费时间）', async () => {
  let authTries = 0
  const providers = [
    fakeProvider('noauth', async () => {
      authTries += 1
      throw new ImageProviderError({ providerId: 'noauth', code: 'AUTH', message: '401' })
    }),
    fakeProvider('good', async () => GOOD_IMAGE),
  ]
  await runImageFallback(providers, () => ({}), { prompt: 'x', n: 1 })
  assert.equal(authTries, 1, 'AUTH 错误必须只试 1 次')
  // 直接验证可重试表：把 AUTH 改成 true 这条就会红
  assert.equal(RETRYABLE_BY_CODE.AUTH, false, 'AUTH 必须标记为不可重试')
  assert.equal(RETRYABLE_BY_CODE.RATE_LIMIT, true)
  assert.equal(RETRYABLE_BY_CODE.TIMEOUT, true)
  assert.equal(RETRYABLE_BY_CODE.NETWORK, true)
})

test('fallback：整条链都失败时抛出汇总错误，带完整 attempts', async () => {
  const providers = [
    fakeProvider('a', async () => { throw new ImageProviderError({ providerId: 'a', code: 'AUTH', message: 'x' }) }),
    fakeProvider('b', async () => { throw new ImageProviderError({ providerId: 'b', code: 'PROVIDER', message: 'y' }) }),
  ]
  await assert.rejects(
    () => runImageFallback(providers, () => ({}), { prompt: 'x', n: 1 }),
    (error) => {
      assert.ok(error instanceof ImageFallbackExhaustedError)
      assert.equal(error.attempts.length, 2, '必须记录每一次尝试，否则无法排查')
      assert.deepEqual(error.attempts.map((a) => a.providerId), ['a', 'b'])
      return true
    },
  )
})

test('fallback：请求开始前已中止，一次供应商调用都不发起', async () => {
  const controller = new AbortController()
  controller.abort()
  const providers = [fakeProvider('x', async () => { throw new Error('不该被调用') })]
  await assert.rejects(
    () => runImageFallback(providers, () => ({}), { prompt: 'x', n: 1, signal: controller.signal }),
    (error) => {
      assert.equal(error.code, 'NETWORK')
      assert.match(error.message, /中止/)
      return true
    },
  )
})

test('HTTP 状态分类：401/403 不重试，429 与其它可重试', () => {
  assert.deepEqual(classifyStatus(401), { code: 'AUTH', retryable: false })
  assert.deepEqual(classifyStatus(403), { code: 'AUTH', retryable: false })
  assert.deepEqual(classifyStatus(429), { code: 'RATE_LIMIT', retryable: true })
  assert.deepEqual(classifyStatus(500), { code: 'PROVIDER', retryable: true })
})

test('sniffMime 按文件头判断，不信 content-type', () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 0])
  const gif = Buffer.from('GIF89a', 'ascii')
  const webp = Buffer.alloc(12)
  webp.write('RIFF', 0, 'ascii')
  webp.write('WEBP', 8, 'ascii')
  assert.equal(sniffMime(png), 'image/png')
  assert.equal(sniffMime(jpeg), 'image/jpeg')
  assert.equal(sniffMime(gif), 'image/gif')
  assert.equal(sniffMime(webp), 'image/webp')
  // 认不出来就按 png 兜底，不抛错
  assert.equal(sniffMime(Buffer.from([1, 2, 3])), 'image/png')
})

test('joinUrl 处理斜杠边界', () => {
  assert.equal(joinUrl('https://a.com/v1', '/images'), 'https://a.com/v1/images')
  assert.equal(joinUrl('https://a.com/v1/', '/images'), 'https://a.com/v1/images')
  assert.equal(joinUrl('https://a.com/v1/', 'images'), 'https://a.com/v1/images')
})

test('truncateMessage 截断长消息，不影响短消息', () => {
  assert.equal(truncateMessage('abc'), 'abc')
  const long = 'x'.repeat(600)
  const out = truncateMessage(long)
  assert.equal(out.length, 500)
})

test('真实 provider：走 OpenAI 兼容格式，b64_json 正确解码', async () => {
  // 一张 1x1 PNG 的 base64
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const fetchImpl = makeFetch([
    ['/images/generations', async () => ({
      ok: true,
      json: async () => ({ data: [{ b64_json: tinyPng }] }),
    })],
  ])
  const provider = PROVIDER_FACTORIES.openai(fetchImpl)
  const result = await provider.generate(
    { prompt: '一片深绿色的抽象背景', size: '1536x1024', n: 1 },
    { apiKey: 'sk-test' },
  )
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].mime, 'image/png', '必须按文件头嗅探出 png')
  assert.ok(result.images[0].buffer.length > 0)
  // 请求必须打到 OpenAI 兼容路径，且带 Bearer
  const call = fetchImpl.calls[0]
  assert.equal(call.url, 'https://api.openai.com/v1/images/generations')
  assert.equal(call.method, 'POST')
  const sent = JSON.parse(call.body)
  assert.equal(sent.prompt, '一片深绿色的抽象背景')
  assert.equal(sent.size, '1536x1024')
})

test('真实 provider：返回 url 时会再下载一次（很多供应商只给 url）', async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const fetchImpl = makeFetch([
    ['/images/generations', async () => ({ ok: true, json: async () => ({ data: [{ url: 'https://cdn.x/img.png' }] }) })],
    ['https://cdn.x/img.png', async () => ({ ok: true, arrayBuffer: async () => bytes, headers: { get: () => null } })],
  ])
  const provider = PROVIDER_FACTORIES.openai(fetchImpl)
  const result = await provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k' })
  assert.equal(result.images.length, 1)
  // 必须有第二次调用（下载图片）
  assert.equal(fetchImpl.calls.length, 2, 'url 形态必须再 GET 一次拿字节')
  assert.equal(fetchImpl.calls[1].method, 'GET')
})

test('HTTP 失败时抛出带 code 的 ImageProviderError，不乱抛原始错误', async () => {
  const fetchImpl = makeFetch([
    ['/images/generations', async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'slow down' } }) })],
  ])
  const provider = PROVIDER_FACTORIES.openai(fetchImpl)
  await assert.rejects(
    () => provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k' }),
    (error) => {
      assert.ok(error instanceof ImageProviderError)
      assert.equal(error.code, 'RATE_LIMIT')
      assert.equal(error.retryable, true)
      assert.match(error.message, /slow down/, '要把上游的错误详情带出来')
      return true
    },
  )
})

test('自定义供应商（bananai 这类中转站）：填 baseUrl + model 即可用', async () => {
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const fetchImpl = makeFetch([
    ['/images/generations', async () => ({ ok: true, json: async () => ({ data: [{ b64_json: tinyPng }] }) })],
  ])
  const provider = createCustomProvider(
    { id: 'bananai', baseUrl: 'https://api.bananai.io/v1', model: 'nano-banana' },
    fetchImpl,
  )
  const result = await provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'sk-test' })
  assert.equal(result.images.length, 1)
  assert.equal(fetchImpl.calls[0].url, 'https://api.bananai.io/v1/images/generations')
})

test('buildProviderChain 返回 {provider, config} 包装，调用方须取 .provider 再喂给 runImageFallback', () => {
  // 这是一个真实踩过的 bug：把包装数组直接传给 runImageFallback，
  // 它调 .generate() 会失败、attempts 里 providerId 变 undefined，
  // 而外层只看到 "undefined:error(PROVIDER)"，完全无法排查。
  const built = buildProviderChain({ chain: [{ providerId: 'gemini', apiKey: 'x' }] })
  assert.equal(built.length, 1)
  assert.ok(built[0].provider, '必须带 provider 字段')
  assert.ok(built[0].config, '必须带 config 字段')
  assert.equal(built[0].provider.id, 'gemini')

  // 正确用法：取 .provider
  const providers = built.map((item) => item.provider)
  assert.equal(providers[0].id, 'gemini')
  assert.equal(typeof providers[0].generate, 'function')
  // 错误用法会拿到没有 id/generate 的对象 —— 断言这个反例，说明为什么必须解包
  assert.equal(built[0].id, undefined, '包装层本身不该假装是 provider')
})

test('fallback 的 attempts 必须带错误消息，否则上层只能看到 code 无法排查', async () => {
  const providers = [
    fakeProvider('quota', async () => {
      throw new ImageProviderError({
        providerId: 'quota',
        code: 'PROVIDER',
        retryable: false,
        message: '该项目的图片生成配额为 0',
      })
    }),
  ]
  await assert.rejects(
    () => runImageFallback(providers, () => ({}), { prompt: 'x', n: 1 }),
    (error) => {
      const attempt = error.attempts[0]
      assert.equal(attempt.providerId, 'quota', 'providerId 不能是 undefined')
      assert.ok(attempt.message, 'attempts 必须带 message')
      assert.match(attempt.message, /配额为 0/, '要能看出真因，而不是只有一个 PROVIDER 码')
      return true
    },
  )
})

test('buildProviderChain：自定义供应商能混进链里，且带自己的配置', () => {
  const chain = buildProviderChain({
    chain: [
      { providerId: 'bananai', apiKey: 'sk-x', custom: { baseUrl: 'https://api.bananai.io/v1' }, model: 'nano-banana' },
      { providerId: 'openai', apiKey: 'sk-y' },
    ],
  })
  assert.equal(chain.length, 2)
  assert.equal(chain[0].provider.id, 'bananai')
  assert.equal(chain[0].config.model, 'nano-banana')
  assert.equal(chain[1].provider.id, 'openai')
  // 未知 id 且没有 custom 声明 → 直接剔除，不让它变成运行时炸弹
  const filtered = buildProviderChain({ chain: [{ providerId: 'not-a-real-provider', apiKey: 'x' }] })
  assert.equal(filtered.length, 0)
})
