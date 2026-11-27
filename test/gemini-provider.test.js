/**
 * Gemini 供应商的协议测试 —— 专门锁住「与 OpenAI 不同」的那几处。
 *
 * 背景：上一版照搬 dsh-wewrite 时，Gemini 被套进了 OpenAI 的 `data[].b64_json` 解析，
 * 于是永远拿不到图。这类错误的特点：**代码不报错，只是静默返回空**，
 * 而且当时没有真跑通过（无 key），所以一直没暴露。
 *
 * 所以这里每条断言都对着一个「如果写错了会静默失败」的点：
 *   1. 响应里图片在 `candidates[].content.parts[].inlineData.data`
 *   2. 同一响应里 text 与 image 段并存，必须遍历挑出 inlineData
 *   3. `inline_data` / `mimeType` 的 snake_case 变体也要认（不同版本 SDK 命名不一）
 *   4. 429 + `limit: 0` 是「配额为零」，必须不可重试（否则白等 2 次）
 *   5. 只有 text 没有图时，必须报错并带上那段的文本（便于判断是不是被拦了）
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { PROVIDER_FACTORIES, ImageProviderError } from '../lib/absorbed/wewrite-imagegen.js'

/** 一段真实的 1x1 PNG（base64）。 */
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 造可观测的假 fetch。 */
function makeFetch(handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    return handler(url, init)
  }
  impl.calls = calls
  return impl
}

/** Gemini 成功响应的标准形状（text + image 并存）。 */
function geminiOkResponse(extraParts = []) {
  return {
    ok: true,
    json: async () => ({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'Here is the generated image.' },
              { inlineData: { mimeType: 'image/png', data: TINY_PNG_B64 } },
              ...extraParts,
            ],
          },
          finishReason: 'STOP',
          index: 0,
        },
      ],
    }),
  }
}

test('请求：打到 correct 端点，用 x-goog-api-key 头鉴权', async () => {
  const fetchImpl = makeFetch(async () => geminiOkResponse())
  const provider = PROVIDER_FACTORIES.gemini(fetchImpl)
  await provider.generate({ prompt: '一片深绿抽象背景', n: 1 }, { apiKey: 'AIza-test' })

  const call = fetchImpl.calls[0]
  assert.match(call.url, /\/v1beta\/models\/gemini-2\.5-flash-image:generateContent$/)
  assert.equal(call.method, 'POST')
  // 关键：Gemini 用 header 鉴权，不是 Authorization: Bearer
  assert.equal(call.headers['x-goog-api-key'], 'AIza-test')
  assert.equal(call.headers.Authorization, undefined, '不该用 Bearer（那是 OpenAI 的写法）')
  assert.equal(call.headers['Content-Type'], 'application/json')
})

test('请求体：contents[].parts[].text + responseModalities=[IMAGE]', async () => {
  const fetchImpl = makeFetch(async () => geminiOkResponse())
  const provider = PROVIDER_FACTORIES.gemini(fetchImpl)
  await provider.generate({ prompt: '测试提示词', n: 1 }, { apiKey: 'k' })

  const sent = JSON.parse(fetchImpl.calls[0].body)
  assert.equal(sent.contents[0].parts[0].text, '测试提示词')
  // 只要 IMAGE：混入 TEXT 会让部分模型返回描述而不出图
  assert.deepEqual(sent.generationConfig.responseModalities, ['IMAGE'])
})

test('响应解析：从 candidates[].content.parts[].inlineData.data 取图（不是 data[].b64_json）', async () => {
  const fetchImpl = makeFetch(async () => geminiOkResponse())
  const provider = PROVIDER_FACTORIES.gemini(fetchImpl)
  const result = await provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k' })

  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].mime, 'image/png')
  assert.ok(result.images[0].buffer.length > 0, '图片字节不能为空')
  // 必须真的解码出 PNG（文件头校验），而不是把 base64 当字节塞进去
  assert.equal(result.images[0].buffer.subarray(1, 4).toString('ascii'), 'PNG')
  assert.equal(result.model, 'gemini-2.5-flash-image')
})

test('响应里 text 与 image 并存时，必须跳过 text 挑出 inlineData', async () => {
  // 这是最容易写错的地方：parts[0] 是 text，直接取 parts[0] 就什么都拿不到
  const fetchImpl = makeFetch(async () => ({
    ok: true,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              { text: '一段很长的描述文字' },
              { text: '还有第二段文字' },
              { inlineData: { mimeType: 'image/png', data: TINY_PNG_B64 } },
            ],
          },
        },
      ],
    }),
  }))
  const provider = PROVIDER_FACTORIES.gemini(fetchImpl)
  const result = await provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k' })
  assert.equal(result.images.length, 1, '必须遍历 parts 找到 inlineData')
})

test('兼容 snake_case 变体：inline_data / mime_type', async () => {
  const fetchImpl = makeFetch(async () => ({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/jpeg', data: TINY_PNG_B64 } }] } }],
    }),
  }))
  const provider = PROVIDER_FACTORIES.gemini(fetchImpl)
  const result = await provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k' })
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].mime, 'image/jpeg', '应读取 mime_type 变体')
})

test('429 + limit:0 → 判定为「配额为零」，必须不可重试', async () => {
  const fetchImpl = makeFetch(async () => ({
    ok: false,
    status: 429,
    json: async () => ({
      error: {
        message:
          'Quota exceeded.\n* Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-2.5-flash-image',
      },
    }),
  }))
  const provider = PROVIDER_FACTORIES.gemini(fetchImpl)
  await assert.rejects(
    () => provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k' }),
    (error) => {
      assert.ok(error instanceof ImageProviderError)
      // 关键：limit:0 是"该项目没有这个配额"，重试没有意义
      assert.equal(error.retryable, false, 'limit:0 必须标记为不可重试，否则白等两轮')
      assert.match(error.message, /配额为 0/, '要说清是配额为零，不是暂时限流')
      return true
    },
  )
})

test('普通 429（真限流）仍可重试', async () => {
  const fetchImpl = makeFetch(async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: { message: 'Resource has been exhausted (per minute quota)' } }),
  }))
  const provider = PROVIDER_FACTORIES.gemini(fetchImpl)
  await assert.rejects(
    () => provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k' }),
    (error) => {
      assert.equal(error.code, 'RATE_LIMIT')
      assert.equal(error.retryable, true)
      return true
    },
  )
})

test('401 无效 key → AUTH，不可重试', async () => {
  const fetchImpl = makeFetch(async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: 'API key not valid' } }),
  }))
  const provider = PROVIDER_FACTORIES.gemini(fetchImpl)
  await assert.rejects(
    () => provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'bad' }),
    (error) => {
      assert.equal(error.code, 'AUTH')
      assert.equal(error.retryable, false)
      return true
    },
  )
})

test('只有文本没有图 → 报错并带上那段文本（便于判断是否被安全策略拦）', async () => {
  const fetchImpl = makeFetch(async () => ({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'I cannot generate that image.' }] } }],
    }),
  }))
  const provider = PROVIDER_FACTORIES.gemini(fetchImpl)
  await assert.rejects(
    () => provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k' }),
    (error) => {
      assert.equal(error.code, 'PROVIDER')
      assert.match(error.message, /只有文本没有图片/)
      assert.match(error.message, /cannot generate/, '要把模型的原话带出来')
      return true
    },
  )
})

test('被安全策略拦截（有 promptFeedback.blockReason）→ 说明原因', async () => {
  const fetchImpl = makeFetch(async () => ({
    ok: true,
    json: async () => ({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } }),
  }))
  const provider = PROVIDER_FACTORIES.gemini(fetchImpl)
  await assert.rejects(
    () => provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k' }),
    (error) => {
      assert.match(error.message, /安全策略/)
      assert.match(error.message, /SAFETY/)
      return true
    },
  )
})

test('自定义模型名会进入 URL（同一家可换 Nano Banana 变体）', async () => {
  const fetchImpl = makeFetch(async () => geminiOkResponse())
  const provider = PROVIDER_FACTORIES.gemini(fetchImpl)
  await provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k', model: 'gemini-3-pro-image-preview' })
  assert.match(fetchImpl.calls[0].url, /gemini-3-pro-image-preview:generateContent/)
})

test('自定义 baseUrl 生效（走代理或自建网关时用）', async () => {
  const fetchImpl = makeFetch(async () => geminiOkResponse())
  const provider = PROVIDER_FACTORIES.gemini(fetchImpl)
  await provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k', baseUrl: 'https://my-proxy.example/v1beta' })
  // 注意：baseUrl 若已含 /v1beta，不该重复拼接
  assert.ok(fetchImpl.calls[0].url.startsWith('https://my-proxy.example'), `实际：${fetchImpl.calls[0].url}`)
  assert.match(fetchImpl.calls[0].url, /:generateContent$/)
})

test('网络异常 → NETWORK 错误，不抛原始 fetch 错误', async () => {
  const fetchImpl = makeFetch(async () => {
    throw new Error('ECONNRESET')
  })
  const provider = PROVIDER_FACTORIES.gemini(fetchImpl)
  await assert.rejects(
    () => provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k' }),
    (error) => {
      assert.ok(error instanceof ImageProviderError)
      assert.equal(error.code, 'NETWORK')
      return true
    },
  )
})
