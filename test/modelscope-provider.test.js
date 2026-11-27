/**
 * ModelScope（魔搭）供应商的协议测试。
 *
 * 它和 Gemini 一样不能套 OpenAI 的实现，但坑的位置不同：
 *   1. **401 有两种含义**：token 无效 vs 账号没绑定阿里云。
 *      两者下一步完全不同（换 key / 去绑定），必须分开提示。
 *   2. **可能走异步任务**：返回 task_id 要轮询 `/tasks/{id}`，
 *      状态字段叫 `task_status`，图片在 `output.results[].url`。
 *   3. 同步形态与 OpenAI 一致（`data[].b64_json | url`），两种都要支持。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { PROVIDER_FACTORIES, ImageProviderError } from '../lib/absorbed/wewrite-imagegen.js'

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function makeFetch(handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    return handler(url, init)
  }
  impl.calls = calls
  return impl
}

test('请求：打到 /v1/images/generations，Bearer 鉴权，body 含 model+prompt+n', async () => {
  const fetchImpl = makeFetch(async () => ({ ok: true, json: async () => ({ data: [{ b64_json: TINY_PNG_B64 }] }) }))
  const provider = PROVIDER_FACTORIES.modelscope(fetchImpl)
  await provider.generate({ prompt: '深绿抽象背景', n: 1 }, { apiKey: 'ms-test' })

  const call = fetchImpl.calls[0]
  assert.equal(call.url, 'https://api-inference.modelscope.cn/v1/images/generations')
  assert.equal(call.method, 'POST')
  assert.equal(call.headers.Authorization, 'Bearer ms-test')
  const sent = JSON.parse(call.body)
  assert.equal(sent.prompt, '深绿抽象背景')
  assert.ok(sent.model, '必须带 model（魔搭不接受空模型）')
})

test('同步形态：data[].b64_json 正确解码为 PNG 字节', async () => {
  const fetchImpl = makeFetch(async () => ({ ok: true, json: async () => ({ data: [{ b64_json: TINY_PNG_B64 }] }) }))
  const provider = PROVIDER_FACTORIES.modelscope(fetchImpl)
  const result = await provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k' })
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0].buffer.subarray(1, 4).toString('ascii'), 'PNG')
})

test('同步形态：data[].url 会再下载一次', async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const fetchImpl = makeFetch(async (url) => {
    if (url.includes('/images/generations')) {
      return { ok: true, json: async () => ({ data: [{ url: 'https://cdn.ms/img.png' }] }) }
    }
    return { ok: true, arrayBuffer: async () => bytes, headers: { get: () => null } }
  })
  const provider = PROVIDER_FACTORIES.modelscope(fetchImpl)
  const result = await provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k' })
  assert.equal(result.images.length, 1)
  assert.equal(fetchImpl.calls.length, 2, 'url 形态必须再 GET 一次')
})

test('401 + "bind your Alibaba Cloud account" → 明确说是账号未绑定，不是 key 无效', async () => {
  const fetchImpl = makeFetch(async () => ({
    ok: false,
    status: 401,
    json: async () => ({ errors: { message: 'Please bind your Alibaba Cloud account before use.' } }),
  }))
  const provider = PROVIDER_FACTORIES.modelscope(fetchImpl)
  await assert.rejects(
    () => provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k' }),
    (error) => {
      assert.ok(error instanceof ImageProviderError)
      assert.equal(error.code, 'AUTH')
      assert.equal(error.retryable, false, 'AUTH 不该重试')
      assert.match(error.message, /未绑定阿里云/, '必须指出是账号绑定问题')
      assert.match(error.message, /token 本身有效/, '要让用户知道不用换 key')
      return true
    },
  )
})

test('401 但消息是普通鉴权失败 → 仍归为 AUTH，不误报成绑定问题', async () => {
  const fetchImpl = makeFetch(async () => ({
    ok: false,
    status: 401,
    json: async () => ({ errors: { message: 'Invalid token' } }),
  }))
  const provider = PROVIDER_FACTORIES.modelscope(fetchImpl)
  await assert.rejects(
    () => provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'bad' }),
    (error) => {
      assert.equal(error.code, 'AUTH')
      assert.doesNotMatch(error.message, /未绑定阿里云/, '不该把普通鉴权失败误报成账号绑定')
      assert.match(error.message, /Invalid token/)
      return true
    },
  )
})

test('异步形态：返回 task_id 时轮询，成功后从 output_images 取图（实测结构）', async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  let pollCount = 0
  const fetchImpl = makeFetch(async (url) => {
    if (url.includes('/images/generations')) {
      // 实测：即使 task_status 已是 SUCCEED，也还没有图，必须轮询
      return { ok: true, json: async () => ({ task_status: 'SUCCEED', task_id: 'task-abc' }) }
    }
    if (url.includes('/tasks/task-abc')) {
      pollCount += 1
      if (pollCount < 2) return { ok: true, json: async () => ({ task_status: 'RUNNING', outputs: {} }) }
      // 实测成功响应：图片在 output_images（数组），不是 output.results[].url
      return {
        ok: true,
        json: async () => ({
          input: { outputs: {} },
          output_images: ['https://cdn.ms/out.png'],
          task_status: 'SUCCEED',
          task_id: 'task-abc',
        }),
      }
    }
    // 图片下载
    return { ok: true, arrayBuffer: async () => bytes, headers: { get: () => null } }
  })
  const provider = PROVIDER_FACTORIES.modelscope(fetchImpl)
  const result = await provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k' })
  assert.equal(result.images.length, 1, '异步任务成功后应拿到图')
  assert.ok(pollCount >= 2, `应当轮询到出图为止，实际轮询 ${pollCount} 次`)
  // 轮询请求必须是 GET，且**带上 X-ModelScope-Task-Type 头**（缺了会返回 task not found）
  const pollCall = fetchImpl.calls.find((c) => c.url.includes('/tasks/'))
  assert.equal(pollCall.method, 'GET')
  assert.equal(pollCall.headers['X-ModelScope-Task-Type'], 'image_generation', '缺这个头会报 task not found')
  assert.match(pollCall.headers.Authorization, /^Bearer /)
})

test('缺 Task-Type 头导致的 "task not found" 不会被静默吞掉', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url.includes('/images/generations')) return { ok: true, json: async () => ({ task_id: 't9' }) }
    return { ok: false, status: 500, json: async () => ({ errors: { code: 500, message: 'task not found' } }) }
  })
  const provider = PROVIDER_FACTORIES.modelscope(fetchImpl)
  await assert.rejects(
    // 把 8 分钟压成 60ms：否则测超时路径要真等 8 分钟
    () => provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k', pollTimeoutMs: 60, pollIntervalMs: 10 }),
    (error) => {
      assert.ok(error instanceof ImageProviderError)
      assert.equal(error.code, 'TIMEOUT', '一直查不到任务时应报超时，而不是静默成功')
      assert.equal(error.retryable, false, '超时不该让上层再重试整条链')
      return true
    },
  )
})

test('提交后既无 task_id 也无图片 → 明确报错', async () => {
  const fetchImpl = makeFetch(async () => ({ ok: true, json: async () => ({ unexpected: true }) }))
  const provider = PROVIDER_FACTORIES.modelscope(fetchImpl)
  await assert.rejects(
    () => provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k' }),
    (error) => {
      assert.match(error.message, /既没有 task_id/)
      return true
    },
  )
})

test('异步形态：任务失败要报出原因且不重试', async () => {
  const fetchImpl = makeFetch(async (url) => {
    if (url.includes('/images/generations')) return { ok: true, json: async () => ({ task_id: 't1' }) }
    return { ok: true, json: async () => ({ task_status: 'FAILED', errors: { message: '模型额度不足' } }) }
  })
  const provider = PROVIDER_FACTORIES.modelscope(fetchImpl)
  await assert.rejects(
    () => provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k' }),
    (error) => {
      assert.equal(error.code, 'PROVIDER')
      assert.equal(error.retryable, false, '任务已 FAILED，重试无意义')
      assert.match(error.message, /额度不足/)
      return true
    },
  )
})

test('响应既无 data 也无 task_id → 明确报错', async () => {
  const fetchImpl = makeFetch(async () => ({ ok: true, json: async () => ({ unexpected: true }) }))
  const provider = PROVIDER_FACTORIES.modelscope(fetchImpl)
  await assert.rejects(
    () => provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k' }),
    (error) => {
      assert.match(error.message, /既没有 task_id/, '要说清是缺 task_id，而不是笼统报错')
      return true
    },
  )
})

test('自定义 model 生效（魔搭上不同模型名差异很大）', async () => {
  const fetchImpl = makeFetch(async () => ({ ok: true, json: async () => ({ data: [{ b64_json: TINY_PNG_B64 }] }) }))
  const provider = PROVIDER_FACTORIES.modelscope(fetchImpl)
  await provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k', model: 'MusePublic/489_ckpt_FLUX_1' })
  const sent = JSON.parse(fetchImpl.calls[0].body)
  assert.equal(sent.model, 'MusePublic/489_ckpt_FLUX_1')
})

test('自定义 baseUrl 生效', async () => {
  const fetchImpl = makeFetch(async () => ({ ok: true, json: async () => ({ data: [{ b64_json: TINY_PNG_B64 }] }) }))
  const provider = PROVIDER_FACTORIES.modelscope(fetchImpl)
  await provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k', baseUrl: 'https://my-gw.example/v1' })
  assert.equal(fetchImpl.calls[0].url, 'https://my-gw.example/v1/images/generations')
})

test('网络异常 → NETWORK，不抛原始 fetch 错误', async () => {
  const fetchImpl = makeFetch(async () => {
    throw new Error('ECONNREFUSED')
  })
  const provider = PROVIDER_FACTORIES.modelscope(fetchImpl)
  await assert.rejects(
    () => provider.generate({ prompt: 'x', n: 1 }, { apiKey: 'k' }),
    (error) => {
      assert.equal(error.code, 'NETWORK')
      return true
    },
  )
})
