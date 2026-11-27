/**
 * 封面 AI 背景生成 —— 把吸收来的供应商链接到「生成一张封面背景」这件事上。
 *
 * 这一层只做三件事，逻辑都薄，复杂度都在它下面：
 *   1. **从配置里取出供应商链与 key**（读 config.json / 环境变量）
 *   2. **问 LLM 写一个提示词**（可选：没 LLM 就用模板拼）
 *   3. **调用 fallback 链生成图，落盘**
 *
 * ## 提示词为什么还是专门构造（但不再加约束）
 * 2026-11-09 之前这里会往提示词里塞三条内容约束（不许有字、左半边压暗、整体低对比）。
 * 用户反馈原话：**"限制了 AI 生成图片，不需要"** —— 写了"山间日出、浓郁色彩"却拿到
 * 一张被冲淡的抽象图，输入框等于打折。现在：
 *   - 用户写了提示词 → **逐字原样提交，一个字符都不追加**
 *   - 用户没写       → 用内置的抽象光影模板（本身不含任何禁止项）
 * 构图不再靠文字约束，改由**请求尺寸**（size / sizeWide）保证；
 * 供应商忽略尺寸参数的（Gemini），靠合成阶段 planBackgroundFit 等比裁剪兜底。
 *
 * ## 没有 key 时的行为
 * 返回 `{ ok:false, error:'未配置任何图片供应商 key' }`，调用方（coverCmd）
 * 收到后自动回落到渐变封面 —— **不阻塞成稿**，这是原插件的取舍，照搬。
 */

import fs from 'node:fs'
import path from 'node:path'

import { loadConfig } from '../src/state.js'
import { COVER_SIZE, WECHAT_COVER_RATIO, formatCoverSize } from './cover-layout.js'
import {
  IMAGE_PROVIDER_IDS,
  ImageFallbackExhaustedError,
  ImageProviderError,
  buildProviderChain,
  runImageFallback,
} from '../lib/absorbed/wewrite-imagegen.js'

/**
 * 封面背景的生成尺寸。
 *
 * 必须是 **2.35:1 横图**，与封面 900×383 一致：
 *   - 实测魔搭默认出竖图（760×1280），铺到 2.35:1 画布上要把横向裁掉 60% 以上，
 *     构图全废。所以尺寸必须显式指定。
 *   - 实测 `1664x704` 出图正好 2.36:1，铺满 900×383 几乎不需要裁剪。
 *   - 格式用 `WxH`（字母 x）：魔搭传 `1280*720` 会 400 `size format should be WxH`。
 *
 * 各供应商对尺寸的接受度不同：
 *   - 魔搭：认 `size: "1664x704"`
 *   - OpenAI/兼容：认 `size: "1536x1024"`（它的合法值集合有限，不认任意尺寸）
 *   - Gemini：不认 size，靠提示词控制构图
 * 所以这里给两套值，由各 provider 自己取用。
 */
const COVER_IMAGE_SIZE = '1536x1024'       // OpenAI 兼容系的合法档位（横）
const COVER_IMAGE_SIZE_WIDE = '1664x704'   // 魔搭实测可用的 2.36:1

/**
 * 按目标比例挑一套请求尺寸。
 *
 * 两套值分开是因为两边的自由度不同：
 *   - OpenAI 兼容系只认固定档位（1024x1024 / 1536x1024 / 1024x1536），给别的值直接 400
 *   - 魔搭这类认任意 `WxH`（注意是字母 x，不是 `*`）
 *
 * 推荐比例这一档**原样保留实测过的 1664x704 与 1536x1024**：
 * 那是真跑通过的组合，不该因为"公式算出来更准"就换掉。
 * 只有用户真的改了输出比例，才现算一套新的。
 */
export function chooseRequestSizes(coverSize) {
  const ratio =
    coverSize && coverSize.width > 0 && coverSize.height > 0
      ? coverSize.width / coverSize.height
      : WECHAT_COVER_RATIO

  if (Math.abs(ratio - WECHAT_COVER_RATIO) < 0.01) {
    return { size: COVER_IMAGE_SIZE, sizeWide: COVER_IMAGE_SIZE_WIDE }
  }

  const openaiChoices = ['1536x1024', '1024x1024', '1024x1536']
  let best = openaiChoices[0]
  let bestGap = Number.POSITIVE_INFINITY
  for (const choice of openaiChoices) {
    const [w, h] = choice.split('x').map(Number)
    const gap = Math.abs(w / h - ratio)
    if (gap < bestGap) {
      bestGap = gap
      best = choice
    }
  }
  // 魔搭：宽固定 1664，高按比例反算并取偶数（尺寸必须是整数）
  const wideHeight = Math.max(320, Math.round(1664 / ratio / 2) * 2)
  return { size: best, sizeWide: `1664x${wideHeight}` }
}

/** 各家 key 的环境变量名（用户配 key 时可以用环境变量，不一定要写进 config）。 */
const KEY_ENV = {
  openai: ['WXMP_IMG_OPENAI', 'OPENAI_API_KEY'],
  azure_openai: ['WXMP_IMG_AZURE', 'AZURE_OPENAI_API_KEY'],
  doubao: ['WXMP_IMG_DOUBAO', 'ARK_API_KEY'],
  dashscope: ['WXMP_IMG_DASHSCOPE', 'DASHSCOPE_API_KEY'],
  jimeng: ['WXMP_IMG_JIMENG'],
  minimax: ['WXMP_IMG_MINIMAX', 'MINIMAX_API_KEY'],
  gemini: ['WXMP_IMG_GEMINI', 'GEMINI_API_KEY'],
  openrouter: ['WXMP_IMG_OPENROUTER', 'OPENROUTER_API_KEY'],
  replicate: ['WXMP_IMG_REPLICATE', 'REPLICATE_API_TOKEN'],
  modelscope: ['WXMP_IMG_MODELSCOPE', 'MODELSCOPE_API_TOKEN'],
}

/**
 * 从配置解析出一条可用的供应商链。
 * 优先级：config.imageProviders（用户显式排的）> 默认链。
 * 每家 key 来源：config.imageKeys[id] > 环境变量。
 *
 * @returns {{chain: Array, note: string}}  chain 为空表示一家都没配
 */
export function resolveImageChain(config = {}) {
  const saved = config || {}
  const configured = Array.isArray(saved.imageProviders) && saved.imageProviders.length
    ? saved.imageProviders
    : null

  const entries = []
  const providerIds = configured || IMAGE_PROVIDER_IDS

  for (const item of providerIds) {
    // 允许两种写法：字符串 id，或 { providerId, baseUrl, model, custom }
    const entry = typeof item === 'string' ? { providerId: item } : item || {}
    const id = String(entry.providerId || '').trim()
    if (!id) continue

    const keyFromConfig = saved.imageKeys && saved.imageKeys[id] ? String(saved.imageKeys[id]) : ''
    const envNames = KEY_ENV[id] || [`WXMP_IMG_${id.toUpperCase()}`]
    let apiKey = keyFromConfig
    if (!apiKey) {
      for (const name of envNames) {
        if (process.env[name]) {
          apiKey = process.env[name]
          break
        }
      }
    }
    if (!apiKey) continue // 没 key 的就不进链，避免白跑一次必失败的请求

    entries.push({
      providerId: id,
      apiKey,
      ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.custom ? { custom: entry.custom } : {}),
      ...(entry.extra ? { extra: entry.extra } : {}),
    })
  }

  return {
    chain: entries,
    note: configured ? '使用你排好的供应商链' : '使用默认供应商链',
  }
}

/**
 * 规格说明（给界面展示用）。
 *
 * 2026-11-09 起这里只是**推荐值**，不再是硬规格 —— 用户可以在面板里改输出尺寸。
 * 真正生效的尺寸以请求里传来的 coverSize 为准（见 chooseRequestSizes）。
 */
export const PROMPT_SPEC_INFO = {
  aspect: `${WECHAT_COVER_RATIO.toFixed(2)}:1`,
  size: formatCoverSize(COVER_SIZE),
  note: '中文标题由本插件排版叠加在背景上；AI 只管画图，出什么风格由提示词决定',
}

/**
 * 构造封面背景提示词。
 *
 * ## 实测教训（2026-11-07 真实出图）
 * 第一版提示词写成结构化清单（"IMPORTANT CONSTRAINTS:" + 多条 - 开头的条目），
 * 结果 **AI 把清单文字本身画进了图里**，封面上出现 "IMPORTANT CONSTRAINTS" 的残影，
 * 而且压在中文标题下面，导致标题几乎读不出来。
 * 另一条实测：追加英文短语 "Wide panorama backdrop for an article cover" 时，
 * 左上角出现 "Wide bartline" 的文字残影。
 *
 * 原因：文生图模型对"结构化文本"很敏感，列表形式会被理解成"要渲染的排版内容"。
 *
 * ## 现在的写法（2026-11-09 起：不再追加任何约束）
 * 用户反馈原话：「限制了 AI 生成图片，不需要」。
 * 原来无论用户写什么，后面都会接一句中文约束（不许有字 / 左侧留空 / 低对比），
 * 用户想要浓郁色彩或具体场景时，拿到的仍是一张被冲淡的抽象图 —— 等于输入框打了折。
 * 所以现在：
 *   1. 用户写了 → **逐字原样提交**，一个字都不加、不改、不拼
 *   2. 用户没写 → 用下面的内置抽象光影模板（模板本身也不含任何禁止句/约束句）
 *
 * 构图改由**请求尺寸**保证；供应商忽略尺寸参数的（如 Gemini），
 * 由合成阶段的 planBackgroundFit 等比裁剪兜底 —— 那里才是真正决定像素的地方。
 */
export function buildCoverPrompt(article, options = {}) {
  const theme = options.theme || article?.theme || 'default'
  // 主题 → 色调倾向，让生成图与文章主题一致
  const palette = {
    default: 'deep forest green fading into soft teal',
    dark: 'deep navy blue fading into slate blue',
    magazine: 'deep crimson fading into warm amber',
  }[theme] || 'deep forest green fading into soft teal'

  const userPrompt = String(options.customPrompt || '').trim()

  // 用户写了提示词：原样返回。不加"横向全景"、不加"不要出现文字"、不加任何约束。
  if (userPrompt) {
    return userPrompt
  }

  // 内置兜底模板：只描述想要的画面，不写任何"不要什么"。
  return [
    `A wide panorama of pure abstract light and color, ${palette}.`,
    'Smooth flowing gradients, soft glowing blooms of light, a quiet grainy texture, modern minimal editorial mood.',
  ].join(' ')
}

/**
 * 生成一张封面背景图并落盘。
 * @returns {Promise<{ok, path?, providerId?, model?, bytes?, error?, attempts?}>}
 */
export async function generateBackgroundForCover(options = {}) {
  const config = loadConfig()
  const { chain, note } = resolveImageChain(config)

  // 允许 --image-gen 指定某一家（在链里过滤出来放最前）
  const hint = String(options.supplierHint || '').trim()
  let effective = chain
  if (hint) {
    const preferred = chain.filter((entry) => entry.providerId === hint)
    if (!preferred.length) {
      return {
        ok: false,
        error: `指定的供应商 ${hint} 不在已配置链里（已配置：${chain.map((e) => e.providerId).join(', ') || '无'}）`,
      }
    }
    effective = [...preferred, ...chain.filter((entry) => entry.providerId !== hint)]
  }

  if (!effective.length) {
    // 这是「没有 key」的正常分支：调用方会回落渐变，不是错误
    return {
      ok: false,
      error: '未配置任何图片供应商 key（可用 WXMP_IMG_OPENAI 等环境变量，或 config set --image-key）',
    }
  }

  // buildProviderChain 返回的是 { provider, config } 包装；
  // 而 runImageFallback 需要裸 provider 对象（配置通过 resolveConfig 回调注入）。
  // 之前直接把包装数组喂进去 → 调用 .generate() 失败、providerId 变 undefined。
  const built = buildProviderChain({ chain: effective })
  const providers = built.map((item) => item.provider)
  const configById = new Map(effective.map((entry) => [entry.providerId, entry]))
  const resolveConfig = (providerId) => {
    const entry = configById.get(providerId) || {}
    return {
      apiKey: entry.apiKey || '',
      ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.extra ? { extra: entry.extra } : {}),
    }
  }

  const prompt = buildCoverPrompt(options.article, {
    theme: options.theme,
    // 用户在面板/CLI 里写的提示词；为空则用内置模板
    customPrompt: options.customPrompt,
  })
  // 尺寸不能按"链里有没有魔搭"一刀切：
  // 混合链（魔搭失败 → 降级到 openai）时，两家认的尺寸档位不同，
  // 给错就是 400。所以把两套值都传给 req，由各 provider 自己挑自己认的那个。
  //
  // 2026-11-09：两套值不再是常量，而是按用户设定的输出尺寸算出来的
  // （推荐比例时原样返回实测过的 1536x1024 / 1664x704）。
  const requestSizes = chooseRequestSizes(options.coverSize)
  const req = {
    prompt,
    n: 1,
    size: requestSizes.size, // OpenAI 兼容系
    sizeWide: requestSizes.sizeWide, // 魔搭这类接受任意 WxH 的
    // 魔搭出图要几十秒到几分钟，必须给用户进度，否则表现为"卡住了"
    onProgress: (event) => {
      if (typeof options.onProgress === 'function') {
        try {
          options.onProgress(event)
        } catch {
          /* 进度回调失败不影响生成 */
        }
      }
    },
  }

  try {
    const outcome = await runImageFallback(providers, resolveConfig, req)
    const image = outcome.result.images[0]
    if (!image || !image.buffer || !image.buffer.length) {
      return { ok: false, error: `${outcome.providerId} 返回了空图片` }
    }
    const workDir = options.workDir || path.join(process.cwd(), 'tmp')
    fs.mkdirSync(workDir, { recursive: true })
    // 用嗅探出的真实 mime 定扩展名：供应商的 content-type 不可信
    const ext = image.mime === 'image/jpeg' ? '.jpg' : image.mime === 'image/webp' ? '.webp' : '.png'
    const outPath = path.join(workDir, `ai-bg-${process.pid}-${Date.now()}${ext}`)
    fs.writeFileSync(outPath, image.buffer)
    return {
      ok: true,
      path: outPath,
      providerId: outcome.providerId,
      model: outcome.result.model,
      bytes: image.buffer.length,
      attempts: outcome.attempts,
      note,
    }
  } catch (error) {
    if (error instanceof ImageFallbackExhaustedError) {
      // 把每一家的失败原因压成一行，方便用户判断是 key 错、配额为 0 还是网络问题。
      // 只给 code 不够：「PROVIDER」看不出该去开通结算还是该换 key。
      const detail = error.attempts
        .map((item) => {
          const reason = item.message ? String(item.message).split('\n')[0] : item.codes.join('/')
          return `${item.providerId}: ${reason}`
        })
        .join(' → ')
      return { ok: false, error: `全部供应商失败：${detail}`, attempts: error.attempts }
    }
    if (error instanceof ImageProviderError) {
      return { ok: false, error: `${error.providerId} ${error.code}: ${error.message}` }
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 供面板/CLI 显示：当前配了哪几家（不含 key）。 */
export function describeImageProviders() {
  const config = loadConfig()
  const { chain, note } = resolveImageChain(config)
  return {
    providers: chain.map((entry) => ({
      providerId: entry.providerId,
      model: entry.model || '',
      baseUrl: entry.baseUrl || '',
    })),
    note,
    available: chain.length > 0,
  }
}
