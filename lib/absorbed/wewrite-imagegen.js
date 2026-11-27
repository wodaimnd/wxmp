/**
 * AI 配图供应商链 —— 吸收自 dsh-wewrite 的 providers 模块。
 *
 * ## 来源
 *   - 包：dsh-wewrite v0.5.3（MIT）
 *   - 文件：lib/index.js
 *     - `host/providers/types`      L3089-3108（错误类型与可重试表）
 *     - `host/providers/registry`   L3110-3148（fallback 编排）
 *     - `host/redaction`            L3150-3153（消息截断）
 *     - `host/providers/transport`  L3155-3267（HTTP 传输与响应解析）
 *     - `host/providers/*`          L3269-3460（9 家供应商声明）
 *   - 改动幅度：**原样迁入**（依赖面 0 个 ctx / 0 个 import，本身就是纯函数 + 注入 fetchImpl）
 *   - 只做三件事：加中文注释、导出内部辅助函数便于测试、把 ID 列表收进常量
 *
 * ## 为什么这段值得原样搬
 * 它把「配图」这件事最难的部分处理得很干净，而且全部是可测的纯逻辑：
 *   1. **注入 fetchImpl**，不直接摸全局 fetch → 测试不需要联网
 *   2. **错误分类可重试性**（AUTH 不重试、RATE_LIMIT/TIMEOUT/NETWORK 才重试）
 *   3. **单家最多试 2 次**，失败自动降下一家，全部失败给完整 attempts 供排查
 *   4. **b64_json 与 url 两种返回都支持**，url 还要再下载一次（这步很多人漏）
 *   5. **sniffMime 按文件头判断真实类型**，不信 content-type
 *
 * ## 刻意的偏离
 *   - 原 `runImageFallback` 抛出时把 providerId 固定写死成 `'openai'`（原代码 L3122），
 *     这里改成 `'chain'`：那个值是错误的，只是恰好没人在意。
 *   - 原文件把 9 家工厂都写死在一个对象里；这里导出 `createProvider` 工厂表，
 *     并额外支持「自定义供应商」——bananai 这类 OpenAI 兼容中转站就是靠这个进来的。
 */

import { Buffer } from 'node:buffer'

/* ── 错误类型与可重试性 ─────────────────────────────────────────── */

/** 按错误码决定要不要重试。鉴权错了重试没意义，反而浪费时间。 */
export const RETRYABLE_BY_CODE = {
  AUTH: false,
  RATE_LIMIT: true,
  TIMEOUT: true,
  NETWORK: true,
  PROVIDER: true,
}

export class ImageProviderError extends Error {
  constructor(input) {
    super(`${input.providerId} ${input.code}: ${input.message}`)
    this.name = 'ImageProviderError'
    this.providerId = input.providerId
    this.code = input.code
    this.retryable = input.retryable ?? RETRYABLE_BY_CODE[input.code]
  }
}

/** 整条链都失败时抛出，带完整的尝试记录，便于回答「到底哪几家挂了」。 */
export class ImageFallbackExhaustedError extends Error {
  constructor(attempts) {
    super(`全部图片供应商失败（${attempts.length} 家尝试链）`)
    this.name = 'ImageFallbackExhaustedError'
    this.attempts = attempts
  }
}

export const MAX_TRIES_PER_PROVIDER = 2

/* ── 工具 ──────────────────────────────────────────────────────── */

/** 截断长消息，避免把整个响应体塞进日志。 */
export function truncateMessage(message, max = 500) {
  const text = String(message ?? '')
  return text.length <= max ? text : text.slice(0, max)
}

/* ── HTTP 传输 ─────────────────────────────────────────────────── */

export function joinUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`
}

/** 按文件头嗅探真实 MIME：供应商返回的 content-type 经常是错的。 */
export function sniffMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png'
  }
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg'
  if (buffer.length >= 6 && buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return 'image/png'
}

/** HTTP 状态 → 错误码 + 是否重试。401/403 归类为鉴权错误。 */
export function classifyStatus(status) {
  if (status === 401 || status === 403) return { code: 'AUTH', retryable: false }
  if (status === 429) return { code: 'RATE_LIMIT', retryable: true }
  return { code: 'PROVIDER', retryable: true }
}

/** 从 URL 下载图片字节（有些供应商只返回 url，不返回 base64）。 */
async function readImageBytes(providerId, url, req, fetchImpl) {
  const response = await fetchImpl(url, { method: 'GET', signal: req.signal })
  if (!response.ok) {
    const { code, retryable } = classifyStatus(response.status)
    throw new ImageProviderError({ providerId, code, retryable, message: `图片下载返回 HTTP ${response.status}` })
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  return { buffer, mime: response.headers.get('content-type')?.split(';')[0] || sniffMime(buffer) }
}

/**
 * OpenAI 兼容的 `/images/generations` 调用与响应解析。
 * 这是所有供应商的公共路径：9 家里 7 家就是它加不同的 baseUrl/model。
 */
async function postJsonImages(input) {
  const { providerId, req } = input
  const fetchImpl = input.fetchImpl ?? fetch
  let response
  try {
    response = await fetchImpl(input.url, {
      method: 'POST',
      headers: { ...input.headers },
      body: JSON.stringify(input.body),
      signal: req.signal,
    })
  } catch (error) {
    if (req.signal?.aborted) {
      throw new ImageProviderError({ providerId, code: 'TIMEOUT', message: '请求已中止' })
    }
    throw new ImageProviderError({
      providerId,
      code: 'NETWORK',
      message: truncateMessage(error instanceof Error ? error.message : String(error ?? '网络异常')),
    })
  }
  if (!response.ok) {
    const { code, retryable } = classifyStatus(response.status)
    let detail = ''
    try {
      const payload = await response.json()
      detail = payload?.error?.message ?? ''
    } catch {
      detail = ''
    }
    throw new ImageProviderError({
      providerId,
      code,
      retryable,
      message: truncateMessage(`HTTP ${response.status}${detail ? ` ${detail}` : ''}`),
    })
  }
  const payload = await response.json()
  const items = payload?.data
  if (!Array.isArray(items) || items.length === 0) {
    throw new ImageProviderError({ providerId, code: 'PROVIDER', message: '响应缺少 data 数组或为空' })
  }
  const images = []
  for (const item of items.slice(0, Math.max(1, req.n))) {
    if (item.b64_json) {
      const buffer = Buffer.from(item.b64_json, 'base64')
      images.push({ buffer, mime: sniffMime(buffer) })
    } else if (item.url) {
      const downloaded = await readImageBytes(providerId, item.url, req, fetchImpl).catch((error) => {
        if (error instanceof ImageProviderError) throw error
        throw new ImageProviderError({ providerId, code: 'NETWORK', message: String(error) })
      })
      images.push({ buffer: downloaded.buffer, mime: downloaded.mime })
    }
  }
  if (!images.length) {
    throw new ImageProviderError({ providerId, code: 'PROVIDER', message: '响应图片条目既无 b64_json 也无 url' })
  }
  return { images, model: input.resultModel }
}

/**
 * 把「供应商声明」变成可调用对象。
 * 声明里只要写 id / baseUrl / model / endpoint / headers / body，剩下的都在这。
 */
export function declareProvider(declaration, fetchImpl) {
  return {
    id: declaration.id,
    displayName: declaration.displayName || declaration.id,
    async generate(req, cfg) {
      const model = cfg.model ?? declaration.defaultModel
      const { path, query } = declaration.endpoint(req, cfg)
      const url = `${joinUrl(cfg.baseUrl ?? declaration.defaultBaseUrl, path)}${query ?? ''}`
      return postJsonImages({
        providerId: declaration.id,
        url,
        headers: declaration.headers(cfg),
        body: declaration.body(req, model),
        req,
        resultModel: model,
        ...(fetchImpl ? { fetchImpl } : {}),
      })
    },
  }
}

/* ── 9 家供应商声明 ────────────────────────────────────────────── */
/** 每家的差异只有三样：baseUrl、model、endpoint（少数要特殊 header）。 */

const API_VERSION = '2024-10-21'

export const PROVIDER_FACTORIES = {
  openai: (fetchImpl) =>
    declareProvider(
      {
        id: 'openai',
        displayName: 'OpenAI',
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-image-2',
        endpoint: () => ({ path: '/images/generations' }),
        headers: (cfg) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` }),
        body: (req) => ({ model: 'gpt-image-2', prompt: req.prompt, size: req.size, n: req.n }),
      },
      fetchImpl,
    ),

  azure_openai: (fetchImpl) =>
    declareProvider(
      {
        id: 'azure_openai',
        displayName: 'Azure OpenAI',
        defaultBaseUrl: 'https://your-resource.openai.azure.com',
        defaultModel: 'gpt-image-2',
        endpoint: (req, cfg) => {
          const deployment = cfg.extra?.deployment ?? cfg.model ?? 'gpt-image-2'
          return {
            path: `/openai/deployments/${deployment}/images/generations`,
            query: `?api-version=${API_VERSION}`,
          }
        },
        headers: (cfg) => ({ 'Content-Type': 'application/json', 'api-key': cfg.apiKey }),
        body: (req) => ({ prompt: req.prompt, size: req.size, n: req.n }),
      },
      fetchImpl,
    ),

  doubao: (fetchImpl) =>
    declareProvider(
      {
        id: 'doubao',
        displayName: '豆包（火山方舟）',
        defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        defaultModel: 'doubao-seedream-3-0-t2i',
        endpoint: () => ({ path: '/images/generations' }),
        headers: (cfg) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` }),
        body: (req, model) => ({ model, prompt: req.prompt, size: req.size, n: req.n, response_format: 'b64_json' }),
      },
      fetchImpl,
    ),

  dashscope: (fetchImpl) =>
    declareProvider(
      {
        id: 'dashscope',
        displayName: '通义万相（DashScope）',
        defaultBaseUrl: 'https://dashscope.aliyuncs.com',
        defaultModel: 'wan2.2-t2i-flash',
        endpoint: () => ({ path: '/api/v1/services/aigc/text2image/image-synthesis' }),
        headers: (cfg) => ({
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'disable',
          Authorization: `Bearer ${cfg.apiKey}`,
        }),
        body: (req, model) => ({
          model,
          input: { prompt: req.prompt },
          parameters: { size: req.size, n: req.n },
        }),
      },
      fetchImpl,
    ),

  jimeng: (fetchImpl) =>
    declareProvider(
      {
        id: 'jimeng',
        displayName: '即梦（火山方舟）',
        defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        defaultModel: 'jimeng-t2i',
        endpoint: () => ({ path: '/images/generations' }),
        headers: (cfg) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` }),
        body: (req, model) => ({ model, prompt: req.prompt, size: req.size, n: req.n, response_format: 'b64_json' }),
      },
      fetchImpl,
    ),

  minimax: (fetchImpl) =>
    declareProvider(
      {
        id: 'minimax',
        displayName: 'MiniMax',
        defaultBaseUrl: 'https://api.minimax.chat',
        defaultModel: 'image-01',
        endpoint: () => ({ path: '/v1/image_generation' }),
        headers: (cfg) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` }),
        body: (req, model) => ({ model, prompt: req.prompt, aspect_ratio: '16:9', n: req.n, response_format: 'base64' }),
      },
      fetchImpl,
    ),

  // Gemini 协议与其它家不同，走独立实现（见 createGeminiProvider）
  gemini: (fetchImpl) => createGeminiProvider(fetchImpl),

  openrouter: (fetchImpl) =>
    declareProvider(
      {
        id: 'openrouter',
        displayName: 'OpenRouter',
        defaultBaseUrl: 'https://openrouter.ai/api/v1',
        defaultModel: 'openai/gpt-image-2',
        endpoint: () => ({ path: '/images/generations' }),
        headers: (cfg) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` }),
        body: (req, model) => ({ model, prompt: req.prompt, size: req.size, n: req.n }),
      },
      fetchImpl,
    ),

  replicate: (fetchImpl) =>
    declareProvider(
      {
        id: 'replicate',
        displayName: 'Replicate',
        defaultBaseUrl: 'https://api.replicate.com',
        defaultModel: 'black-forest-labs/flux-schnell',
        endpoint: () => ({ path: '/v1/predictions' }),
        headers: (cfg) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` }),
        body: (req, model) => ({ version: model, input: { prompt: req.prompt, aspect_ratio: '16:9' } }),
      },
      fetchImpl,
    ),

  // ModelScope（魔搭）协议与 OpenAI 接近但错误语义与异步任务不同，走独立实现
  modelscope: (fetchImpl) => createModelscopeProvider(fetchImpl),
}

/** 默认 fallback 顺序（与原插件一致：openai 优先；魔搭放前面因为国内直连稳）。
 *  实测 2026-11-07：api.openai.com 在本机能连通；魔搭国内速度更好。 */
export const DEFAULT_IMAGE_PROVIDER_CHAIN = [
  'openai',
  'modelscope',
  'gemini',
  'doubao',
  'dashscope',
  'jimeng',
  'minimax',
  'azure_openai',
  'openrouter',
  'replicate',
]

export const IMAGE_PROVIDER_IDS = Object.keys(PROVIDER_FACTORIES)

/* ── fallback 编排 ─────────────────────────────────────────────── */

/**
 * 依次尝试供应商链，单家失败自动降下一家。
 * @param {Array} providers  已按顺序排好的 provider 对象
 * @param {(id: string) => object} resolveConfig  给某家取配置（apiKey/baseUrl/model）
 * @param {{prompt:string, size?:string, n?:number, signal?:AbortSignal}} req
 * @returns {Promise<{result, providerId, attempts}>}  带实际使用者，可追溯
 */
export async function runImageFallback(providers, resolveConfig, req) {
  if (req.signal?.aborted) {
    // 原代码这里把 providerId 写死成 'openai'，是错误的；改成 chain 表示"还没开始就中止了"
    throw new ImageProviderError({ providerId: 'chain', code: 'NETWORK', message: '请求已中止，未发起任何供应商调用' })
  }
  const attempts = []
  for (const provider of providers) {
    const codes = []
    let tries = 0
    for (;;) {
      tries += 1
      try {
        const result = await provider.generate(req, resolveConfig(provider.id))
        attempts.push({ providerId: provider.id, tries, outcome: 'success', codes })
        return { result, providerId: provider.id, attempts }
      } catch (thrown) {
        const error =
          thrown instanceof ImageProviderError
            ? thrown
            : new ImageProviderError({
                providerId: provider.id,
                code: 'PROVIDER',
                message: thrown instanceof Error ? thrown.message : String(thrown ?? '未知错误'),
              })
        codes.push(error.code)
        if (error.retryable && tries < MAX_TRIES_PER_PROVIDER) continue
        // 把最后一条错误消息也记下来：只记 code 的话，
        // 上层只能看到 "PROVIDER"，不知道为什么失败（比如"配额为 0"）。
        attempts.push({ providerId: provider.id, tries, outcome: 'error', codes, message: error.message })
        break
      }
    }
  }
  throw new ImageFallbackExhaustedError(attempts)
}

/**
 * 自定义供应商：给 bananai 这类「OpenAI 兼容中转站」用。
 * 只要它兼容 `/images/generations`，填 baseUrl + model 就能接。
 */
export function createCustomProvider({ id, displayName, baseUrl, model, apiKey, extraHeaders }, fetchImpl) {
  return declareProvider(
    {
      id,
      displayName: displayName || id,
      defaultBaseUrl: baseUrl,
      defaultModel: model,
      endpoint: () => ({ path: '/images/generations' }),
      headers: (cfg) => ({
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
        ...extraHeaders,
      }),
      body: (req, modelName) => ({ model: modelName, prompt: req.prompt, size: req.size, n: req.n }),
    },
    fetchImpl,
  )
}

/**
 * Gemini 与其它 8 家**协议完全不同**，不能套 declareProvider：
 *
 *   请求：POST /v1beta/models/{model}:generateContent
 *         { contents:[{role,parts:[{text}]}], generationConfig:{responseModalities:['IMAGE']} }
 *   鉴权：header `x-goog-api-key`（官方推荐），或 query `?key=`；两种都支持
 *   响应：candidates[0].content.parts[]，图片在 **inlineData.data**（base64），
 *         而且一个响应里可能同时有 text 与 image 段，必须遍历挑出 inlineData
 *
 * 这正是上一版照搬 wewrite 留下的坑：原实现走 OpenAI 的 `data[].b64_json`，
 * 在 Gemini 上永远拿不到图（解析空数组 → 报「响应缺少 data 数组」），
 * 但从没被真正跑通过，所以一直没暴露。
 */
function createGeminiProvider(fetchImpl) {
  const doFetch = fetchImpl ?? fetch
  return {
    id: 'gemini',
    displayName: 'Gemini（Nano Banana）',
    async generate(req, cfg) {
      const model = cfg.model ?? 'gemini-2.5-flash-image'
      // 鉴权优先走 header；baseUrl 里带了 ?key= 也能用（用户可能习惯这么配）
      const base = String(cfg.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/+$/, '')
      const url = `${base}/v1beta/models/${model}:generateContent`
      const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey || '' }

      let response
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
            // 只要图：文本段会让部分模型返回描述而不出图
            generationConfig: { responseModalities: ['IMAGE'] },
          }),
          signal: req.signal,
        })
      } catch (error) {
        if (req.signal?.aborted) {
          throw new ImageProviderError({ providerId: 'gemini', code: 'TIMEOUT', message: '请求已中止' })
        }
        throw new ImageProviderError({
          providerId: 'gemini',
          code: 'NETWORK',
          message: truncateMessage(error instanceof Error ? error.message : String(error ?? '网络异常')),
        })
      }

      if (!response.ok) {
        const { code, retryable } = classifyStatus(response.status)
        let detail = ''
        let fullMessage = ''
        try {
          const payload = await response.json()
          // Gemini 的错误嵌在 error.message，配额说明往往是多行
          const raw = payload?.error?.message ?? ''
          fullMessage = String(raw)
          // 日志/展示只取第一行（避免整段配额链接刷屏），
          // 但**判定必须用完整消息**——"limit: 0" 通常出现在第二行以后。
          detail = fullMessage.split('\n')[0]
        } catch {
          detail = ''
          fullMessage = ''
        }
        // 429 且 message 里含 "limit: 0" 说明是该项目「配额为零」而非暂时限流：
        // 这种情况重试毫无意义，标记为不可重试，让 fallback 立刻降下一家。
        // 注意：code 改成 PROVIDER 后，RETRYABLE_BY_CODE 会给它 retryable=true，
        // 所以必须**显式传 retryable:false**，否则会被表的默认值又翻回来。
        const quotaZero = response.status === 429 && /limit:\s*0\b/i.test(fullMessage)
        throw new ImageProviderError({
          providerId: 'gemini',
          code: quotaZero ? 'PROVIDER' : code,
          retryable: quotaZero ? false : retryable,
          message: truncateMessage(
            quotaZero
              ? `该项目的图片生成配额为 0（免费层不含图片生成，需在 Google Cloud 开通结算）：${detail}`
              : `HTTP ${response.status}${detail ? ` ${detail}` : ''}`,
          ),
        })
      }

      const payload = await response.json()
      const candidates = payload?.candidates
      if (!Array.isArray(candidates) || !candidates.length) {
        // 被安全策略拦下时会有 promptFeedback，要把原因带出来
        const blockReason = payload?.promptFeedback?.blockReason
        throw new ImageProviderError({
          providerId: 'gemini',
          code: 'PROVIDER',
          message: blockReason ? `内容被安全策略拦截（${blockReason}）` : '响应缺少 candidates',
        })
      }

      // 遍历所有 parts，挑出 inlineData（同一个响应里可能有 text + image）
      const images = []
      for (const candidate of candidates.slice(0, Math.max(1, req.n))) {
        const parts = candidate?.content?.parts ?? []
        for (const part of parts) {
          const inline = part?.inlineData ?? part?.inline_data
          if (inline?.data) {
            const buffer = Buffer.from(inline.data, 'base64')
            images.push({ buffer, mime: inline.mimeType ?? inline.mime_type ?? sniffMime(buffer) })
          }
        }
      }
      if (!images.length) {
        const textPart = candidates[0]?.content?.parts?.find((p) => p?.text)?.text
        throw new ImageProviderError({
          providerId: 'gemini',
          code: 'PROVIDER',
          message: textPart
            ? `响应只有文本没有图片：${truncateMessage(textPart, 160)}`
            : '响应里没有 inlineData 图片段',
        })
      }
      return { images: images.slice(0, Math.max(1, req.n)), model }
    },
  }
}

/**
 * ModelScope（魔搭）—— 实测校准过的实现（2026-11-07 真实调用验证）。
 *
 * 四处与"想当然"不同的地方，全部来自实测，不是推测：
 *
 *   1. **默认异步**：POST 立刻返回 `{"task_status":"SUCCEED","task_id":"..."}` ——
 *      注意即使 task_status 已经是 SUCCEED，`task_id` 也还没有图，必须轮询。
 *   2. **轮询必须带 `X-ModelScope-Task-Type: image_generation`**。
 *      不带这个头时 `/v1/tasks/{id}` 返回 `{"errors":{"code":500,"message":"task not found"}}`
 *      —— 看起来像"任务丢了"，其实是少了个头。
 *   3. **图片在 `output_images` 数组**（不是 `output.results[].url`）。
 *      完整成功响应长这样：
 *        { "output_images": ["https://...png"], "task_status": "SUCCEED", "task_id": "..." }
 *   4. **出图很慢**：实测约 2 分钟（RUNNING 持续 ~140 秒）。
 *      轮询上限必须给到 5 分钟，90 秒会误判超时。
 *
 * 另外：默认出的是**竖图**（实测 760×1280）。封面要 2.35:1 横图，
 * 所以必须显式传 size/宽高。魔搭的尺寸参数各家模型不一，这里传常见的 size 字段，
 * 并在提示词里强调横向构图做双保险。
 */
function createModelscopeProvider(fetchImpl) {
  const doFetch = fetchImpl ?? fetch
  const DEFAULT_MODEL = 'Qwen/Qwen-Image'
  /**
   * 轮询上限。
   * 实测波动极大：有的一次 90 秒出图，有的 RUNNING 超过 150 秒还在跑。
   * 这是魔搭免费队列的正常现象（排队 + 冷启动），不是错误。
   * 给到 8 分钟：允许成功，但不无限等。
   *
   * 可通过 cfg.pollTimeoutMs / cfg.pollIntervalMs 覆盖——测试用它把 8 分钟压成几十毫秒，
   * 否则「测超时路径」要真等 8 分钟。
   */
  const MAX_POLL = 8 * 60 * 1000
  const POLL_INTERVAL = 3000

  /** 把魔搭的业务错误翻译成人能照着做的提示。 */
  const explain = (status, payload) => {
    const raw = payload?.errors?.message || payload?.error?.message || ''
    const text = String(raw)
    if (/bind your Alibaba Cloud account/i.test(text)) {
      return {
        message: '魔搭账号未绑定阿里云：token 本身有效，但图片生成要求先在 modelscope.cn 绑定阿里云账号并实名认证',
        code: 'AUTH',
        retryable: false,
      }
    }
    if (/task not found/i.test(text)) {
      return {
        message: '任务查不到：轮询时缺了 X-ModelScope-Task-Type 头，或 task_id 已过期',
        code: 'PROVIDER',
        retryable: false,
      }
    }
    if (status === 401 || status === 403) {
      return { message: text || `HTTP ${status}`, code: 'AUTH', retryable: false }
    }
    const { code, retryable } = classifyStatus(status)
    return { message: `HTTP ${status}${text ? ` ${text}` : ''}`, code, retryable }
  }

  return {
    id: 'modelscope',
    displayName: 'ModelScope（魔搭）',
    async generate(req, cfg) {
      const model = cfg.model ?? DEFAULT_MODEL
      const base = String(cfg.baseUrl ?? 'https://api-inference.modelscope.cn/v1').replace(/\/+$/, '')
      const authHeader = { Authorization: `Bearer ${cfg.apiKey || ''}` }

      /* ── 1. 提交任务 ── */
      let submit
      try {
        submit = await doFetch(`${base}/images/generations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeader,
            // 显式声明异步：不加时行为不稳定，加了才有确定的 task_id 路径
            'X-ModelScope-Async-Mode': 'true',
          },
          body: JSON.stringify({
            model,
            prompt: req.prompt,
            n: req.n ?? 1,
            // 尺寸格式实测必须是 `WxH`（字母 x）。传 `1280*720` 会被拒：
            //   {"errors":{"message":"size format should be WxH"}}
            // 封面要 2.35:1，默认不传尺寸时魔搭出竖图（实测 760×1280），
            // 所以优先用调用方给的 sizeWide（2.36:1 的 1664x704），
            // 再退回 size，最后归一化。允许写 1280x720 / 1280*720 / {w,h}。
            ...(() => {
              const wide = normalizeMSSize(req.sizeWide)
              const any = wide || normalizeMSSize(req.size)
              return any ? { size: any } : {}
            })(),
          }),
          signal: req.signal,
        })
      } catch (error) {
        if (req.signal?.aborted) {
          throw new ImageProviderError({ providerId: 'modelscope', code: 'TIMEOUT', message: '请求已中止' })
        }
        throw new ImageProviderError({
          providerId: 'modelscope',
          code: 'NETWORK',
          message: truncateMessage(error instanceof Error ? error.message : String(error ?? '网络异常')),
        })
      }

      if (!submit.ok) {
        let payload = null
        try {
          payload = await submit.json()
        } catch {
          payload = null
        }
        const explained = explain(submit.status, payload)
        throw new ImageProviderError({ providerId: 'modelscope', ...explained })
      }

      const submitted = await submit.json()

      // 极少见：直接同步返回了图
      if (Array.isArray(submitted?.output_images) && submitted.output_images.length) {
        return { images: await downloadAll(submitted.output_images, req, doFetch, 'modelscope'), model }
      }
      if (Array.isArray(submitted?.data) && submitted.data.length) {
        return { images: await decodeDataArray(submitted.data, req, doFetch, 'modelscope'), model }
      }

      const taskId = submitted?.task_id || submitted?.taskId
      if (!taskId) {
        throw new ImageProviderError({
          providerId: 'modelscope',
          code: 'PROVIDER',
          message: '提交后既没有 task_id，也没有直接返回图片',
        })
      }

      /* ── 2. 轮询任务（必须带 Task-Type 头）── */
      const maxPoll = Number(cfg.pollTimeoutMs) > 0 ? Number(cfg.pollTimeoutMs) : MAX_POLL
      const interval = Number(cfg.pollIntervalMs) > 0 ? Number(cfg.pollIntervalMs) : POLL_INTERVAL
      const deadline = Date.now() + maxPoll
      let polls = 0
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, interval))
        polls += 1
        // 给调用方一个进度回调：魔搭出图可能几分钟，界面不能只是静默转圈
        if (typeof req.onProgress === 'function') {
          try {
            req.onProgress({ phase: 'polling', taskId, seconds: Math.round((polls * interval) / 1000) })
          } catch {
            /* 进度回调失败不该影响主流程 */
          }
        }
        let poll
        try {
          poll = await doFetch(`${base}/tasks/${encodeURIComponent(taskId)}`, {
            method: 'GET',
            headers: {
              ...authHeader,
              // 实测缺这个头会返回 "task not found"
              'X-ModelScope-Task-Type': 'image_generation',
            },
            signal: req.signal,
          })
        } catch {
          continue // 单次轮询网络抖动不该让整个任务失败
        }
        if (!poll.ok) {
          let payload = null
          try {
            payload = await poll.json()
          } catch {
            payload = null
          }
          // 4xx 才放弃；5xx/429 继续等
          if (poll.status >= 400 && poll.status < 500 && poll.status !== 429) {
            const explained = explain(poll.status, payload)
            throw new ImageProviderError({ providerId: 'modelscope', ...explained })
          }
          continue
        }
        const state = await poll.json()
        const status = String(state?.task_status || state?.status || '').toUpperCase()
        if (status === 'SUCCEED' || status === 'SUCCEEDED' || status === 'SUCCESS') {
          const urls = Array.isArray(state?.output_images)
            ? state.output_images
            : Array.isArray(state?.outputs)
              ? state.outputs
              : []
          if (!urls.length) {
            throw new ImageProviderError({
              providerId: 'modelscope',
              code: 'PROVIDER',
              message: '任务成功但 output_images 为空',
            })
          }
          return { images: await downloadAll(urls, req, doFetch, 'modelscope'), model }
        }
        if (status === 'FAILED' || status === 'CANCELED' || status === 'CANCELLED') {
          throw new ImageProviderError({
            providerId: 'modelscope',
            code: 'PROVIDER',
            retryable: false,
            message: truncateMessage(state?.errors?.message || state?.message || `任务状态 ${status}`),
          })
        }
        // RUNNING / PENDING / QUEUED → 继续等
      }
      throw new ImageProviderError({
        providerId: 'modelscope',
        code: 'TIMEOUT',
        retryable: false,
        message: `异步任务 ${Math.round(MAX_POLL / 1000)} 秒仍未完成（魔搭出图实测约 2 分钟，可能队列拥堵）`,
      })
    },
  }
}

/**
 * 把各种尺寸写法归一成魔搭要求的 `WxH`。
 * 接受：`1280x720` / `1280*720` / `1280X720` / `1280×720` / {width,height}
 * 不接受的一律返回空串（让调用方走默认尺寸，不传坏值导致 400）。
 */
export function normalizeMSSize(size) {
  if (!size) return ''
  if (typeof size === 'object') {
    const w = Number(size.width)
    const h = Number(size.height)
    return w > 0 && h > 0 ? `${Math.round(w)}x${Math.round(h)}` : ''
  }
  const match = String(size).match(/^\s*(\d+)\s*[xX*×]\s*(\d+)\s*$/)
  if (!match) return ''
  const w = Number(match[1])
  const h = Number(match[2])
  if (!(w > 0 && h > 0)) return ''
  return `${w}x${h}`
}

/** 下载一组图片 URL（任务成功后统一走这里）。 */
async function downloadAll(urls, req, doFetch, providerId) {
  const images = []
  for (const url of urls.slice(0, Math.max(1, req.n))) {
    const one = await readImageBytes(providerId, String(url), req, doFetch)
    images.push({ buffer: one.buffer, mime: one.mime })
  }
  if (!images.length) {
    throw new ImageProviderError({ providerId, code: 'PROVIDER', message: '图片 URL 列表为空' })
  }
  return images
}

/** 解析 OpenAI 风格的 data[]（同步返回时用）。 */
async function decodeDataArray(data, req, doFetch, providerId) {
  const images = []
  for (const item of data.slice(0, Math.max(1, req.n))) {
    if (item.b64_json) {
      const buffer = Buffer.from(item.b64_json, 'base64')
      images.push({ buffer, mime: sniffMime(buffer) })
    } else if (item.url) {
      const one = await readImageBytes(providerId, item.url, req, doFetch)
      images.push({ buffer: one.buffer, mime: one.mime })
    }
  }
  if (!images.length) {
    throw new ImageProviderError({ providerId, code: 'PROVIDER', message: 'data 里既无 b64_json 也无数 url' })
  }
  return images
}

/**
 * 组装一条可用的供应商链。
 * @param {object} options
 * @param {Array<{providerId, apiKey, baseUrl?, model?, custom?}>} options.chain
 * @returns {Array} provider 对象数组（已按顺序）
 */
export function buildProviderChain(options = {}) {
  const chain = Array.isArray(options.chain) && options.chain.length
    ? options.chain
    : DEFAULT_IMAGE_PROVIDER_CHAIN.map((providerId) => ({ providerId, apiKey: '' }))
  const fetchImpl = options.fetchImpl

  return chain
    .map((entry) => {
      // 自定义供应商优先：id 不在内置表里，或者显式给了 custom 声明
      if (entry.custom || !PROVIDER_FACTORIES[entry.providerId]) {
        if (!entry.custom) return null
        return {
          config: {
            apiKey: entry.apiKey || '',
            ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
            ...(entry.model ? { model: entry.model } : {}),
          },
          provider: createCustomProvider(
            {
              id: entry.providerId,
              displayName: entry.custom.displayName,
              baseUrl: entry.custom.baseUrl,
              model: entry.model || entry.custom.model,
              extraHeaders: entry.custom.extraHeaders,
            },
            fetchImpl,
          ),
        }
      }
      return {
        config: {
          apiKey: entry.apiKey || '',
          ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
          ...(entry.model ? { model: entry.model } : {}),
          ...(entry.extra ? { extra: entry.extra } : {}),
        },
        provider: PROVIDER_FACTORIES[entry.providerId](fetchImpl),
      }
    })
    .filter(Boolean)
}
