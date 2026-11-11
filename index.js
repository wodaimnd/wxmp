/**
 * DSH bundle 插件：把 wxmp CLI 暴露成一个模型工具 `wxmp`。
 *
 * 与 winpilot 插件同一套设计约定：
 *  1. 只用 ctx.tools.register() + 手写 JSON Schema，不 import 任何 @deepseek-ai/*，
 *     这样 profile 安装和 plugins/ 目录 link 加载都能工作。
 *  2. 子进程 stdio 指向文件而不是管道（受限沙箱里管道会 EPERM）。
 *  3. 串行执行：draft create 会把 media_id 写回文章 front matter，
 *     publish submit 依赖那个 media_id，并发会让它们互相踩踏。
 *
 * 安全默认：插件不改写 CLI 的 dry-run 语义——publish submit 必须显式传 yes: true。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// F4：PKG_VERSION 由 ui-backend 从 package.json 读一次，index.js 不再自带版本号（单一来源）
// F4：VERSION 与 PKG_VERSION 同源（见下方 L32 注释）。
// task-11：deleteArticleFile 是删除的**唯一实现**，面板路径与工具路径共用。
import { ROUTE, UI_OPERATIONS, createUiHandler, PKG_VERSION, deleteArticleFile } from './ui-backend.js'
import { createLogger } from './logger.js'

export const name = 'tool-wxmp'

/**
 * 依赖闸门必须留空：模块级 inject 是**全有全无**的——只写 ['tools'] 时，
 * apply() 里访问 webServer / logger 都会拿不到服务，面板后端会静默不挂载
 * （这正是 0.1.0 版「工具能用、面板打不开」的根因）。
 * 每块功能各自 ctx.inject([...]) 声明：缺 tools 只降级工具，缺 webServer 只降级面板。
 */
export const inject = []

// F4：版本号唯一来源是 package.json（由 ui-backend 的 PKG_VERSION 读一次并导出）。
// 这里曾经硬编码 '1.7.7'，与 package.json 构成双源：改一边忘一边，就会变成
// 「面板显示旧版本、manifest 报新版本」，而且**任何地方都不会报错**。
// 所以不再保留硬编码——宁可读不到时显示 'unknown'，也不显示一个骗人的数字。
const VERSION = PKG_VERSION

const pluginDir = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_TIMEOUT_MS = 120000

/** 与 cordis.patch.yml 的 config 必须逐字一致（不能用 `!!js` 条件修饰开关行）。 */
const DEFAULTS = {
  cliPath: '',
  stateDir: '',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  logLevel: 'info',
  logMaxBytes: 2 * 1024 * 1024,
}

export { DEFAULTS }

/**
 * 工具暴露的 operation 全集 = 模型能做的全部事情。
 * 导出是为了让测试能断言「这里的每一项 buildArgv 都真的认」——
 * 加进枚举却忘了写分支，模型调用时只会拿到 unknown_operation。
 */
export const OPERATIONS = [
  'config_show',
  'config_set',
  'config_clear',
  'config_set_image_key',
  'config_set_image_provider',
  'image_providers',
  'article_new',
  // task-11：能力等价——面板能删文章，模型也得能删（走同一条宿主半实现，不经 CLI）。
  'article_delete',
  'article_list',
  'article_show',
  'article_check',
  'article_review',
  'article_import',
  'article_titles',
  'article_brief',
  'article_outline',
  'article_set_title',
  'article_set_author',
  'article_library',
  'article_illustrate',
  'article_presets',
  'article_preset_show',
  'article_preset_use',
  'article_preset_export',
  'article_preset_import',
  'article_preset_remove',
  'article_preset_reset',
  'article_preview',
  'cover',
  'draft_create',
  'draft_list',
  'draft_get',
  'draft_update',
  'draft_delete',
  'draft_count',
  'publish_submit',
  'publish_status',
  'publish_wait',
  'publish_list',
  'publish_delete',
  'doctor',
]

/**
 * task-11：本地执行的 operation（**不经 CLI**）。
 *
 * CLI 根本没有 `article delete` 子命令（见 buildArgv 里同名 case 的注释），删除只能由
 * 宿主半自己 fs 完成。这个集合决定 execute 把哪些 operation 交给本地实现，
 * 而不是翻译成 argv 交给子进程——加错了的后果是「本该本地删，却去敲一条 CLI 不认的命令」。
 */
const LOCAL_OPERATIONS = new Set(['article_delete'])

/**
 * 参数速查（会进工具描述，模型据此决定传什么）。
 * 导出是为了让测试能断言「这里声明过的参数，buildArgv 必须真的转发」——
 * cover 的 prompt/width/height 就曾在这里声明、却没被转发，传了静默无效。
 */
export const PARAMETER_HINTS = [
  'config_set(appid, secret), config_show, config_clear, doctor,',
  'config_set_image_key(provider, value, custom?), config_set_image_provider(provider, baseUrl, model?),',
  'image_providers,  // 出图前先问它：没 key 时 cover(imageGen) 只会回落渐变',
  'article_new(title, author?, theme?, cover?), article_list, article_show(file?),',
  // task-11：删本地文章（只删文章目录内的 .md；微信后台草稿不受影响）。
  'article_delete(file),  // 本地删除，不走 CLI；file 必填。只删本地 .md，微信草稿不动',
  'article_check(file?), article_review(file?, minScore?, preset?), article_preview(file?, out?, open?),',
  'article_import(url|list),  // 把在线文章抓成本地可编辑 .md；list 是一行一个链接的文件',
  'article_titles(file?, titles?, brief?), article_brief(topic?, file?, form?, words?, audience?, angle?, preset?),',
  'article_outline(file?, form?), article_set_title(file, title),',
  'article_set_author(file, author),  // author 传空字符串即清空作者名',
  'article_library(check?, guide?, audit?, usable?), article_illustrate(file?, max?, apply?),',
  'article_presets, article_preset_show(id), article_preset_use(id), article_preset_export(id, out?), article_preset_import(file, as?, force?),',
  'article_preset_remove(id, allowBuiltin?), article_preset_reset,',
  'cover(file?, subtitle?, badge?, theme?, bg?, imageGen?, prompt?, width?, height?),',
  'draft_create(file?, dryRun?, thumbMediaId?), draft_list(offset?, count?, full?),',
  'draft_get(mediaId), draft_update(file?, mediaId?, index?), draft_delete(mediaId), draft_count,',
  'publish_submit(mediaId?|file?, yes?), publish_status(publishId),',
  'publish_wait(publishId, timeoutMs?, intervalMs?), publish_list(offset?, count?),',
  'publish_delete(articleId, yes?)',
  '所有操作都接受 baseUrl（指向自建网关，默认走 api.weixin.qq.com）。',
].join(' ')

const PROMPT_TEXT = [
  'Use the wxmp tool to author and publish WeChat Official Account (公众号/服务号) articles.',
  'Write Markdown with front matter (article_new), then GET FEEDBACK with article_review — it returns a 0-100 score,',
  'per-category breakdown, and a findings list where every item carries a LINE NUMBER and a concrete fix.',
  'Loop: article_review → apply the suggested fixes → article_review again until pass=true (score >= 80).',
  'Use article_check only for hard publish limits; article_review is the one that tells you whether the draft reads well.',
  'Scoring standards are presets (like DSH agent presets): article_presets lists them, and article_review takes preset=<id>.',
  'Pick a fitting standard: short-punch for notices/quick posts, deep-longform for long method pieces, standard otherwise.',
  'After the score passes: cover (writes cover: back into the article), draft_create, then publish_submit with yes=true + publish_wait.',
  'Publishing is asynchronous and publish_submit requires explicit yes=true, otherwise it only dry-runs.',
  'Body images must be local files (draft_create uploads them); WeChat filters non-mmbiz image URLs.',
].join(' ')

const PARAMETERS = {
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      enum: [...OPERATIONS],
      description: 'wxmp 操作名。',
    },
    params: {
      type: 'object',
      additionalProperties: true,
      description: `操作参数。${PARAMETER_HINTS}`,
    },
  },
  required: ['operation'],
  additionalProperties: false,
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'CLI 是否成功（退出码 0）。' },
    exitCode: { type: 'integer', description: 'CLI 退出码。' },
    // F19：失败时短码与下一步提示**顶层**就有，不必先知道 data.error.code 这条内部结构。
    // 本地 op（article_delete）一直这么给，CLI 路径原来只埋在 data.error.code 里。
    code: { type: 'string', description: '失败时的稳定短码（成功时不出现）。' },
    error: { type: 'string', description: '失败时的人话原因（成功时不出现）。' },
    hint: { type: 'string', description: '失败时的下一步建议（成功时不出现）。' },
    data: { description: 'CLI 的结构化结果；失败时含 error.code / error.message。' },
    text: { type: 'string', description: '模型可读的紧凑输出（截断到 4000 字符）。' },
  },
  required: ['ok', 'exitCode', 'data', 'text'],
}

class ToolInputError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ToolInputError'
    this.code = code
  }
}

function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  return {
    cliPath: typeof config.cliPath === 'string' ? config.cliPath : DEFAULTS.cliPath,
    stateDir: typeof config.stateDir === 'string' ? config.stateDir : DEFAULTS.stateDir,
    timeoutMs:
      Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULTS.timeoutMs,
    logLevel: ['debug', 'info', 'warn', 'error'].includes(config.logLevel)
      ? config.logLevel
      : DEFAULTS.logLevel,
    logMaxBytes:
      Number.isFinite(config.logMaxBytes) && config.logMaxBytes > 0
        ? config.logMaxBytes
        : DEFAULTS.logMaxBytes,
  }
}

export function resolveCliPath(config = {}) {
  const candidates = []
  if (config.cliPath) candidates.push(path.resolve(config.cliPath))
  if (process.env.WXMP_CLI_JS) candidates.push(path.resolve(process.env.WXMP_CLI_JS))
  candidates.push(path.resolve(pluginDir, '..', 'bin', 'wxmp.js'))
  candidates.push(path.resolve(pluginDir, '..', '..', 'wxmp', 'bin', 'wxmp.js'))
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* 试下一个 */
    }
  }
  return ''
}

function requireString(params, key, fallbackKey) {
  const value = params[key] ?? (fallbackKey ? params[fallbackKey] : undefined)
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolInputError('invalid_params', `缺少参数 ${key}`)
  }
  return value
}

function pushFlag(argv, name, value) {
  if (value === undefined || value === null || value === false) return
  if (value === true) {
    argv.push(`--${name}`)
    return
  }
  argv.push(`--${name}`, String(value))
}

/**
 * 把工具参数翻译成 CLI argv（纯函数，便于测试）。
 * @param {string} operation
 * @param {Record<string, unknown>} params
 * @returns {string[]}
 */
export function buildArgv(operation, params) {
  const p = params && typeof params === 'object' ? params : {}
  const argv = []

  switch (operation) {
    case 'config_show':
      argv.push('config', 'show')
      break
    case 'config_set':
      argv.push('config', 'set', '--appid', requireString(p, 'appid'), '--secret', requireString(p, 'secret'))
      break
    case 'config_clear':
      // 清凭据 + token 缓存。配错了凭据时靠它回到干净状态。
      argv.push('config', 'clear')
      break
    case 'config_set_image_key':
      // AI 配图 key 与公众号凭据分开配：一个出图、一个发文，混在一起会逼着
      // 「只想配图」的人重填一遍 appid/secret。
      // value 传 '-' = 删除这一家的 key（parseArgv 把单独的 '-' 当值，不当 flag）。
      argv.push('config', 'set', '--image-key', requireString(p, 'provider'))
      pushFlag(argv, 'value', p.value)
      pushFlag(argv, 'custom', p.custom === true)
      break
    case 'config_set_image_provider':
      // 自定义中转站，或给内置供应商改接入地址（走代理时用）。
      argv.push('config', 'set', '--image-provider', requireString(p, 'provider'))
      pushFlag(argv, 'base-url', p.baseUrl ?? p.base_url)
      pushFlag(argv, 'model', p.model)
      break
    case 'image_providers':
      // 探测「现在能不能 AI 出图」：不联网、不花额度，只读本地 key。
      // 调 cover(imageGen) 之前先问它，否则只会看到"回落渐变"。
      argv.push('image-providers')
      break
    case 'doctor':
      argv.push('doctor')
      break
    case 'article_new':
      argv.push('article', 'new', '--title', requireString(p, 'title'))
      pushFlag(argv, 'author', p.author)
      pushFlag(argv, 'theme', p.theme)
      pushFlag(argv, 'cover', p.cover)
      pushFlag(argv, 'force', p.force)
      break
    case 'article_delete':
      // task-11：删除是**本地 op**，CLI 没有 `article delete` 子命令，这条 argv 不会交给子进程。
      // 那为什么还要返回它？buildArgv 的契约是「OPERATIONS 里每一项都能翻译出非空 argv」
      // （见 test/plugin.test.js「OPERATIONS 每一项都有 buildArgv 分支」），返回空数组会被判成
      // 「枚举加了、分支没接上」。execute 在调 buildArgv **之前**就按 LOCAL_OPERATIONS 分流，
      // 所以不要把这个结果直接塞进 runCli——那只会撞上 CLI 的 unknown subcommand。
      argv.push('article', 'delete', '--file', requireString(p, 'file'))
      break
    case 'article_list':
      argv.push('article', 'list')
      break
    case 'article_show':
      argv.push('article', 'show')
      pushFlag(argv, 'file', p.file)
      break
    case 'article_check':
      argv.push('article', 'check')
      pushFlag(argv, 'file', p.file)
      break
    case 'article_review':
      // 体检：0~100 分 + 带行号的改法。minScore 传了就变成门槛
      // （分数不够时 CLI 退出码 1，工具侧 ok=false，Agent 能据此继续改）。
      argv.push('article', 'review')
      pushFlag(argv, 'file', p.file)
      pushFlag(argv, 'min-score', p.minScore ?? p.min_score)
      // preset 让 Agent 可以按文风换标准（短稿/长文），不传就用用户上次选的
      pushFlag(argv, 'preset', p.preset)
      break
    case 'article_import':
      // 把一个已在线的公众号文章链接抓成本地可编辑 .md（素材收集，不是抄）。
      // 单个用 url，批量用 list（一行一个链接，空行与 # 注释会被跳过）；
      // 同名不覆盖，自动加 -2/-3 —— 导入不该悄悄盖掉改过的稿子。
      argv.push('article', 'import')
      pushFlag(argv, 'url', p.url)
      pushFlag(argv, 'list', p.list)
      break
    case 'article_titles':
      // 起标题：给 file 出「机械候选 + 任务书」；给 titles 数组则只打分排序。
      // brief:true 只返回任务书（纯 JSON，适合直接交给调用方生成）。
      argv.push('article', 'titles')
      if (Array.isArray(p.titles) && p.titles.length) argv.push(...p.titles.map(String))
      pushFlag(argv, 'file', p.file)
      pushFlag(argv, 'brief', p.brief === true)
      break
    case 'article_brief':
      // 写作任务书：该搜什么、按什么骨架写、标题往哪起、写完自查什么。
      // 不生成、不联网、不调 LLM —— 它把方法论固化成作业单。
      argv.push('article', 'brief')
      pushFlag(argv, 'topic', p.topic)
      pushFlag(argv, 'file', p.file)
      pushFlag(argv, 'form', p.form)
      pushFlag(argv, 'words', p.words)
      pushFlag(argv, 'audience', p.audience)
      pushFlag(argv, 'angle', p.angle)
      pushFlag(argv, 'preset', p.preset)
      break
    case 'article_outline':
      // 结构骨架：整体该有哪些块。file 对比现状，form 只看某文体骨架。
      argv.push('article', 'outline')
      pushFlag(argv, 'file', p.file)
      pushFlag(argv, 'form', p.form)
      break
    case 'article_set_title':
      // 标题写回 front matter。故意不用 requireString：CLI 的 title_required /
      // title_too_long 带字数上限与建议，比工具层的 invalid_params 有用。
      argv.push('article', 'set-title')
      pushFlag(argv, 'file', p.file)
      pushFlag(argv, 'title', p.title)
      break
    case 'article_presets':
      argv.push('article', 'preset', 'list')
      break
    case 'article_preset_show':
      argv.push('article', 'preset', 'show', requireString(p, 'id'))
      break
    case 'article_preset_use':
      argv.push('article', 'preset', 'use', requireString(p, 'id'))
      break
    case 'article_preset_export':
      argv.push('article', 'preset', 'export', requireString(p, 'id'))
      pushFlag(argv, 'out', p.out)
      break
    case 'article_preset_import':
      // 导入要真文件路径：Agent 可以自己先 write 到磁盘，再把路径交进来
      argv.push('article', 'preset', 'import', requireString(p, 'file'))
      pushFlag(argv, 'as', p.as)
      pushFlag(argv, 'force', p.force === true)
      break
    case 'article_preset_remove':
      // 删自定义预设。内置的（standard 等）默认受保护，要显式 allowBuiltin。
      argv.push('article', 'preset', 'remove', requireString(p, 'id'))
      pushFlag(argv, 'allow-builtin', p.allowBuiltin === true)
      break
    case 'article_preset_reset':
      // 把缺失的内置预设重新落盘；不覆盖用户改过的文件。
      argv.push('article', 'preset', 'reset')
      break
    case 'article_preview':
      argv.push('article', 'preview')
      pushFlag(argv, 'file', p.file)
      pushFlag(argv, 'out', p.out)
      pushFlag(argv, 'open', p.open)
      break
    case 'article_set_author':
      // 有意用 pushFlag 而不是 requireString：author 传空字符串是「清空作者」这个
      // 合法动作，requireString 会把空串当成缺参而拒绝。
      argv.push('article', 'set-author')
      pushFlag(argv, 'file', p.file)
      pushFlag(argv, 'author', p.author)
      break
    case 'article_library':
      // 公众号后台的图片素材库。usable:true 只看能当正文插图的
      // （有语义文件名、非封面类）—— 插图匹配率完全取决于文件名有没有意义。
      argv.push('article', 'library')
      pushFlag(argv, 'check', p.check)
      pushFlag(argv, 'guide', p.guide === true)
      pushFlag(argv, 'audit', p.audit === true)
      pushFlag(argv, 'usable', p.usable === true)
      break
    case 'article_illustrate':
      // 从素材库按语义选图并给插入位置。默认只建议；apply:true 才真写进文章
      // （会改结构，所以必须显式要求）。
      argv.push('article', 'illustrate')
      pushFlag(argv, 'file', p.file)
      pushFlag(argv, 'max', p.max)
      pushFlag(argv, 'apply', p.apply === true)
      break
    case 'cover':
      argv.push('cover')
      pushFlag(argv, 'file', p.file)
      pushFlag(argv, 'subtitle', p.subtitle)
      pushFlag(argv, 'badge', p.badge)
      pushFlag(argv, 'theme', p.theme)
      pushFlag(argv, 'out', p.out)
      // 背景来源：bg=用户底图；imageGen=AI 生成（无 key 会回落渐变并说明原因）
      pushFlag(argv, 'bg', p.bg)
      pushFlag(argv, 'image-gen', p.imageGen === true ? true : (typeof p.imageGen === 'string' ? p.imageGen : p.image_gen))
      // 下面三个 CLI 早已支持（commands.js 的 coverCmd 会读 --prompt/--width/--height），
      // 但工具层一直没转发 —— 参数说明里写着却不生效，属于"说了能用、其实没用"。
      pushFlag(argv, 'prompt', p.prompt)
      pushFlag(argv, 'width', p.width)
      pushFlag(argv, 'height', p.height)
      break
    case 'draft_create':
      argv.push('draft', 'create')
      pushFlag(argv, 'file', p.file)
      pushFlag(argv, 'dry-run', p.dryRun === true)
      pushFlag(argv, 'thumb-media-id', p.thumbMediaId)
      break
    case 'draft_list':
      argv.push('draft', 'list')
      pushFlag(argv, 'offset', p.offset)
      pushFlag(argv, 'count', p.count)
      pushFlag(argv, 'full', p.full)
      break
    case 'draft_get':
      argv.push('draft', 'get', '--media-id', requireString(p, 'mediaId', 'media_id'))
      break
    case 'draft_update':
      argv.push('draft', 'update')
      pushFlag(argv, 'file', p.file)
      pushFlag(argv, 'media-id', p.mediaId ?? p.media_id)
      pushFlag(argv, 'index', p.index)
      pushFlag(argv, 'dry-run', p.dryRun === true)
      break
    case 'draft_delete':
      argv.push('draft', 'delete', '--media-id', requireString(p, 'mediaId', 'media_id'))
      break
    case 'draft_count':
      argv.push('draft', 'count')
      break
    case 'publish_submit': {
      argv.push('publish', 'submit')
      pushFlag(argv, 'file', p.file)
      pushFlag(argv, 'media-id', p.mediaId ?? p.media_id)
      pushFlag(argv, 'yes', p.yes === true)
      break
    }
    case 'publish_status':
      argv.push('publish', 'status', '--publish-id', requireString(p, 'publishId', 'publish_id'))
      break
    case 'publish_wait':
      argv.push('publish', 'wait', '--publish-id', requireString(p, 'publishId', 'publish_id'))
      pushFlag(argv, 'timeout', p.timeoutMs)
      pushFlag(argv, 'interval', p.intervalMs)
      break
    case 'publish_list':
      argv.push('publish', 'list')
      pushFlag(argv, 'offset', p.offset)
      pushFlag(argv, 'count', p.count)
      break
    case 'publish_delete':
      argv.push('publish', 'delete', '--article-id', requireString(p, 'articleId', 'article_id'))
      pushFlag(argv, 'yes', p.yes === true)
      pushFlag(argv, 'index', p.index)
      break
    default:
      throw new ToolInputError('unknown_operation', `未知操作: ${operation}`)
  }

  // 允许指向自建/沙箱网关（测试与内网联调用），默认走官方域名。
  // 例外：config_set_image_provider 的 `--base-url` 是「图片供应商的接入地址」，
  // 与网关同名不同义。再追加一个 --base-url 会让 parseArgv 的后写者胜出，
  // 把供应商地址悄悄换成网关地址 —— 这个参数就不能重复发。
  if (!argv.includes('--base-url')) {
    pushFlag(argv, 'base-url', p.baseUrl ?? p.base_url)
  }

  return argv
}

export function parseCliOutput(raw, exitCode) {
  const text = String(raw || '')
  const lines = text.split(/\r?\n/).filter((line) => line.trim().startsWith('{'))
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i])
      return {
        ok: parsed.ok === true,
        exitCode: Number.isInteger(parsed.exitCode) ? parsed.exitCode : exitCode ?? 1,
        data: parsed.data === undefined ? null : parsed.data,
        text: typeof parsed.text === 'string' ? parsed.text : '',
      }
    } catch {
      /* 继续找上一行 */
    }
  }
  const trimmed = text.trim()
  return {
    ok: exitCode === 0,
    exitCode: exitCode ?? 1,
    data: null,
    text: trimmed ? trimmed.slice(-2000) : '(wxmp 没有输出)',
  }
}

function defaultStateBase(cwd) {
  const local = process.env.LOCALAPPDATA
  if (local) return path.join(local, 'wxmp')
  return path.join(cwd, '.wxmp')
}

/** 文章目录：与 CLI 的 articleDir() 保持一致。 */
function defaultArticleDir(cwd) {
  const base = process.env.WXMP_HOME || defaultStateBase(cwd)
  return path.join(base, 'articles')
}

function runCli(argv, options) {
  const { cliPath, cwd, env, timeoutMs, stateDir } = options
  return new Promise((resolve) => {
    const bases = [stateDir || defaultStateBase(cwd), path.join(cwd, '.wxmp')]
    const logName = `call-${process.pid}-${Date.now()}.log`
    let logFile = path.join(bases[0], 'logs', logName)
    let fd
    for (const base of bases) {
      try {
        const dir = path.join(base, 'logs')
        fs.mkdirSync(dir, { recursive: true })
        logFile = path.join(dir, logName)
        fd = fs.openSync(logFile, 'w')
        break
      } catch {
        fd = undefined
      }
    }
    const stdio = fd === undefined ? ['ignore', 'ignore', 'ignore'] : ['ignore', fd, fd]
    let child
    try {
      child = spawn(process.execPath, [cliPath, ...argv, '--json'], {
        cwd,
        env,
        windowsHide: true,
        stdio,
      })
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd)
        } catch {
          /* ignore */
        }
      }
      resolve({
        ok: false,
        exitCode: 1,
        data: { error: { code: 'spawn_failed', message: error.message } },
        text: `spawn_failed: ${error.message}`,
      })
      return
    }
    runningChildren.add(child)
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }

    let settled = false
    function finish(result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      finish({
        ok: false,
        exitCode: 124,
        data: { error: { code: 'timeout', message: `wxmp ${argv[0]} 超过 ${timeoutMs}ms` } },
        text: `timeout: wxmp ${argv.join(' ')} 超过 ${timeoutMs}ms`,
      })
    }, timeoutMs)

    child.once('error', (error) => {
      runningChildren.delete(child)
      finish({
        ok: false,
        exitCode: 1,
        data: { error: { code: 'spawn_failed', message: error.message } },
        text: `spawn_failed: ${error.message}`,
      })
    })
    child.once('close', (code) => {
      let raw = ''
      try {
        raw = fs.readFileSync(logFile, 'utf8')
      } catch {
        /* 没有日志就当作无输出 */
      }
      finish(parseCliOutput(raw, code))
      // call-log-unbounded：每次调用产生一个 call-*.log，读完就删，防止无限增长
      if (fd !== undefined) {
        try {
          fs.unlinkSync(logFile)
        } catch {
          /* 已在别处清掉或文件被占用，忽略 */
        }
      }
      runningChildren.delete(child)
    })
  })
}

/**
 * F19：CLI 路径与本地 op 路径的失败结构必须同形。
 *
 * 原来这里只把短码埋在 `data.error.code`，而本地 op（ui-backend.deleteArticleFile）
 * 在**顶层**也给 code / error / hint —— 于是模型按工具描述读顶层时，
 * `unknown_operation` 这类失败的 code 是 undefined（复核时真的踩到过一次）。
 * 现在两条路径一视同仁：顶层给 code / error / hint，`data.error.code` 保留不动（兼容既有读法）。
 */
const FAILURE_HINTS = {
  cli_not_found: '确认 bin/wxmp.js 存在，或配置 cliPath / 环境变量 WXMP_CLI_JS。',
  unknown_operation: '操作名不在列表里：先看工具描述里的 op 列表，或先调 doctor 自查环境。',
  invalid_params: '按参数提示补齐必填项；探路可以先用 article_list / config_show 这类只读 op。',
}

function failure(code, message, exitCode = 2, hint = '') {
  return {
    ok: false,
    exitCode,
    code,
    error: message,
    hint: hint || FAILURE_HINTS[code] || '按 message 修正参数后重试；需要更多上下文可先调 doctor。',
    data: { error: { code, message } },
    text: `${code}: ${message}`,
  }
}

const disposersByCtx = new WeakMap()
// inflight-child-not-cancelled：记录在飞的 CLI 子进程，停用/卸载时统一 kill，
// 避免插件已卸载后子进程仍在写 front matter。
const runningChildren = new Set()

/**
 * W2：杀掉所有在飞的 CLI 子进程。apply 重入与插件 dispose **共用这一条路径**。
 *
 * 原来只有 apply 重入会 kill（:644），停用/卸载插件时子进程会一直跑到自身超时
 * （默认 120s）并占着串行队列，插件已经卸载了它还在写 front matter。
 */
function killRunningChildren(log) {
  let killed = 0
  const pids = []
  for (const child of runningChildren) {
    try {
      child.kill()
      killed += 1
      // F7：记子进程**自己**的 pid。原来记的是 process.pid（插件宿主自己的进程号），
      // 排障时拿这个号去 tasklist 里找，找到的是 DSH 本身，永远对不上真正的 CLI 子进程。
      pids.push(child.pid)
    } catch {
      /* 已经退出，忽略 */
    }
  }
  if (killed > 0 && log) log.info(`已终止在飞的 CLI 子进程 ${killed} 个`, { killed, pids })
  return killed
}

/**
 * P1：disposers 语义统一为「追加」。
 * 原来 mountTool 的兜底分支写 set(ctx, [disposer])——那会把已登记的其它 disposer
 * 整段覆盖掉（真 effect 下不可达，但语义是错的）。现在所有登记点都走这里。
 */
function addDisposer(ctx, dispose) {
  if (typeof dispose !== 'function') return
  const list = disposersByCtx.get(ctx) || []
  list.push(dispose)
  disposersByCtx.set(ctx, list)
}

/**
 * N3③：清除本插件数据（面板「清除本插件数据」按钮用）。
 *
 * logger.js 的 clear() 从写下那天起就没有调用点——残留的明文密钥躺在 plugin.log 里
 * 也没人能一键回收。这里把它接上，并顺手扫掉崩溃残留的 call-*.log
 * （正常路径读完即删，只有进程被杀才会留下）。
 *
 * 返回结构化结果而不是 boolean：删失败必须看得见（文件被占用 / 目录不可写）。
 */
export function clearPluginData(log, stateDir) {
  const removed = []
  const failed = []
  const dir = path.join(String(stateDir || ''), 'logs')

  // 1) plugin.log 及其轮转文件（logger.clear() 内部按 maxFiles 一起删）
  let pluginLogCleared = false
  try {
    pluginLogCleared = log.clear() === true
  } catch (error) {
    failed.push(`plugin.log: ${messageOf(error)}`)
  }
  if (pluginLogCleared) removed.push('plugin.log（含轮转文件）')
  else if (!failed.length) failed.push('plugin.log: 删除返回 false（文件被占用或目录不可写）')

  // 2) 崩溃残留的 call-*.log
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^call-.*\.log$/.test(name)) continue
      try {
        fs.rmSync(path.join(dir, name), { force: true })
        removed.push(name)
      } catch (error) {
        failed.push(`${name}: ${messageOf(error)}`)
      }
    }
  } catch (error) {
    // 目录不存在属正常：说明还没产生过任何调用日志
    if (!error || error.code !== 'ENOENT') failed.push(`logs 目录: ${messageOf(error)}`)
  }

  const result = {
    ok: failed.length === 0,
    removed,
    failed,
    logDirName: path.basename(dir),
    // 日志删掉后 mount-state.json 保留：它记录的是「装上没有」，不是排障日志
    kept: ['mount-state.json', 'config.json（由 CLI 管理，不在这里删）'],
  }
  if (log) {
    if (result.ok) log.info('已清除本插件日志数据', { removed: removed.length, dir: path.basename(dir) })
    else log.warn('清除本插件日志数据部分失败', { failed, hint: '多半是文件被占用，停掉使用日志的进程后重试' })
  }
  return result
}

/** 面板与 CLI 之间的串行队列是共享的：draft create 会把 media_id 写回 front matter，
 *  publish submit 依赖它，面板和模型并发就会互相踩踏。 */

/**
 * @param {object} ctx cordis 上下文
 * @param {object} [config]
 */
export function apply(ctx, config) {
  const resolved = normalizeConfig(config)
  const previous = disposersByCtx.get(ctx) || []
  while (previous.length) {
    const dispose = previous.pop()
    try {
      dispose()
    } catch {
      /* 已经释放过 */
    }
  }
  // inflight-child-not-cancelled：停用时杀掉所有在飞的 CLI 子进程（与 dispose 同一条路径）
  killRunningChildren()

  /** 状态目录与 CLI 同一个基准；日志跟着它走，用户清缓存时一起清掉。 */
  const stateDirOf = () => (resolved.stateDir ? path.resolve(resolved.stateDir) : defaultStateBase(process.cwd()))
  const articleDirOf = () => {
    if (resolved.stateDir) return path.join(path.resolve(resolved.stateDir), 'articles')
    return defaultArticleDir(process.cwd())
  }

  const log = createLogger({
    dir: () => path.join(stateDirOf(), 'logs'),
    fileName: 'plugin.log',
    tag: 'wxmp',
    minLevel: resolved.logLevel,
    maxBytes: resolved.logMaxBytes,
    mirror: (level, message) => {
      if (level === 'warn') ctx.logger?.warn?.(`wxmp: ${message}`)
      else if (level === 'error') ctx.logger?.error?.(`wxmp: ${message}`)
    },
  })
  log.info('apply 开始', {
    version: VERSION,
    cliPath: resolveCliPath(resolved) || '(未找到)',
    stateDir: stateDirOf(),
    articleDir: articleDirOf(),
    logFile: log.file(),
  })

  /**
   * W2：停用/卸载插件时把在飞的子进程收干净。
   * 只依赖 apply 重入那条路径不够——正常停用插件不会再走一次 apply，
   * 子进程就会跑到自身超时。这里挂在 ctx.effect 上，dispose 时 LIFO 最后执行
   * （路由与工具都已注销之后），与 :644 的重入路径行为一致。
   */
  const releaseChildren = () => {
    // F7：在 kill **之前**取快照，才是「停用那一刻在飞几个」。
    // 原来把 runningChildren.size 记成 remaining：那时 kill 刚发出去、close 还没回调，
    // 集合根本没删，remaining 恒等于 killed，这一项等于假数据。
    const atDispose = runningChildren.size
    const killed = killRunningChildren(log)
    // 没有子进程也要留一条，否则线上无法区分「没杀」和「没在跑」
    log.info('插件停用：回收在飞子进程', { atDispose, killed, at: new Date().toISOString() })
  }
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => releaseChildren)
    } catch (error) {
      log.warn(`注册停用回收钩子失败 ${messageOf(error)}`, { hint: '子进程可能跑到自身超时' })
      addDisposer(ctx, releaseChildren)
    }
  } else {
    addDisposer(ctx, releaseChildren)
  }

  try {
    ctx.systemPrompt?.section?.({
      name: 'tool:wxmp',
      order: 114,
      text: PROMPT_TEXT,
    })
  } catch (error) {
    log.warn(`systemPrompt 注册失败 ${messageOf(error)}`)
  }

  let queue = Promise.resolve()

  /** 瞬态故障可重试：超时（124）与 spawn_failed，重试 2 次，每次递增退避。 */
  const RETRYABLE_CODES = new Set(['timeout', 'spawn_failed'])
  const MAX_RETRIES = 2

  /**
   * N1：只有**只读**调用才允许自动重试。
   *
   * 为什么：timeout ≠ 服务端没执行。publish submit / draft create / draft delete /
   * article import / config set 这类写操作在 120s 超时后被无差别自动重试，如果首次
   * 其实已经被微信受理，重试就等于重复发布 / 重复建稿 / 重复删稿——不可逆的外部后果。
   * 改法取「宁可不重试」：超时错误原样抛给调用方（错误三段已有人话），用户手动重试时
   * 先用 publish status / draft list 确认首次到底成没成。
   *
   * 键 = argv 开头的命令路径（前 3 个不以 -- 开头的词），如 'publish submit'、
   * 'article preset use'、'draft create'。**不在表里的一律不重试**（白名单，不是黑名单）。
   * 匹配方式见下面的 isReadOnlyCall：逐级前缀任一命中即读类（F5），
   * 所以这里**只放完整的命令路径**，不要放 'article' 这种泛化键。
   */
  const RETRYABLE_CALLS = new Set([
    'doctor', // 本机自检，纯只读
    'image-providers', // 只读本地 key
    'config show',
    'article list',
    'article show',
    'article check',
    'article review',
    'article titles',
    'article brief',
    'article outline',
    'article library',
    'article preset list',
    'article preset show',
    'draft list',
    'draft get',
    'draft count',
    'publish status',
    'publish list',
    'publish wait',
  ])

  /**
   * 从 argv 取「命令路径」的词：从头收集不以 -- 开头的词，最多 3 个。
   * 为什么不用 argv[0] 就够：'article preset use' 与 'article preset list' 前两词相同，
   * 一个写一个读，必须靠第三个词区分。
   */
  const callWordsOf = (argv) => {
    const parts = []
    for (const item of argv) {
      if (typeof item !== 'string' || item.startsWith('--')) break
      parts.push(item)
      if (parts.length === 3) break
    }
    return parts
  }
  const callKeyOf = (argv) => callWordsOf(argv).join(' ')

  /**
   * F5：同一个操作的两条调用路径必须得到同一个判定。
   *
   * 工具路径把参数写成 `--topic` 形态（`article brief --topic X`，第三个词就是 -- 开头），
   * 面板路径把选题写成**位置参数**（ui-backend.js 的 `case 'writing-brief'` → `article brief X`）。
   * 用 callKeyOf 做全等匹配，就会变成「article brief 在工具侧重试、在面板侧不重试」——
   * 同一个操作两套标准。改成**逐级前缀任一命中即读类**：
   * `article brief 我的选题` 的前缀里命中 `article brief`，两条路径判定一致。
   *
   * 为什么这个方案不会把写类误判成读类：
   *  1. 表里没有任何 1 段的**命名空间键**：'article' / 'config' / 'draft' / 'publish' / 'article preset'
   *     这类泛化前缀一律不在表里——它们一旦入表，'article import'、'config set'、
   *     'article preset use' 这些写操作就会被前缀命中而误判成读类，那才是真正的风险。
   *     表里确实有 'doctor' 与 'image-providers' 两个 1 段键（F9 订正：原注释写成「没有任何
   *     1 段键」，与事实不符），但它们是**没有子命令的单命令**：没有任何写操作的命令路径以
   *     这两个词开头，入表安全。新增键要守的规矩是「不许放命名空间前缀」，不是「不许 1 段」。
   *  2. 读写子命令在同一词位上就分开了，且互不为前缀：'article preset list' /
   *     'article preset show' 是 3 段，'article preset use' / 'remove' / 'import' 既
   *     不等于它们、也不以它们为前缀，反之亦然。
   *  3. 位置参数只可能出现在读命令的**第 3 词之后**（如 brief 的 topic）；
   *     前缀最多吃掉一个多余词，命中要求表里真有那条 2 段读键，写命令混不进来。
   */
  const isReadOnlyCall = (argv) => {
    const words = callWordsOf(argv)
    // `article illustrate` 不带 --apply 只出建议（CLI src/commands.js:632-637、677-697），
    // 带 --apply 才把插图写进正文。这里按 argv 分流，不做「整体当写类」的保守处理。
    if (words[0] === 'article' && words[1] === 'illustrate') return !argv.includes('--apply')
    for (let n = words.length; n >= 1; n -= 1) {
      if (RETRYABLE_CALLS.has(words.slice(0, n).join(' '))) return true
    }
    return false
  }

  /** 唯一的执行入口：工具和面板都走这里，串行 + 逐次记录。 */
  const enqueue = (argv, options = {}) => {
    const run = async () => {
      const startedAt = Date.now()
      const cliPath = resolveCliPath(resolved)
      if (!cliPath) {
        log.warn('找不到 CLI 入口', { candidates: [resolved.cliPath || '(未配置)', 'WXMP_CLI_JS', '../bin/wxmp.js'] })
        return failure('cli_not_found', '找不到 bin/wxmp.js，请配置 cliPath 或设置环境变量 WXMP_CLI_JS')
      }
      const cwd = process.cwd()
      const stateDir = resolved.stateDir ? path.resolve(resolved.stateDir) : ''
      const env = { ...process.env }
      if (stateDir) env.WXMP_HOME = stateDir

      let attempt = 0
      let result
      const callKey = callKeyOf(argv)
      while (true) {
        attempt += 1
        result = await runCli(argv, {
          cliPath,
          cwd,
          stateDir,
          timeoutMs: options.timeoutMs || resolved.timeoutMs,
          env,
        })
        const faultCode = result.data?.error?.code
        // N1：写类 op 一次都不自动重试 —— 先判白名单（isReadOnlyCall，含 F5 的前缀匹配），再判次数
        if (result.ok || !RETRYABLE_CODES.has(faultCode) || attempt > MAX_RETRIES) break
        if (!isReadOnlyCall(argv)) {
          // 失败路径必须可见：不重试这件事要留痕，否则线上只看日志会以为「重试逻辑坏了」
          log.warn(`op ${callKey} 属写类调用，超时不自动重试`, {
            op: callKey,
            code: faultCode,
            attempt,
            ms: Date.now() - startedAt,
            hint: '手动重试前先用 publish status / draft list 确认首次是否已被服务端受理',
          })
          break
        }
        const delayMs = attempt * 1000
        log.warn(`op 瞬态故障，${delayMs}ms 后重试第 ${attempt} 次`, {
          op: callKey || '?',
          code: faultCode,
          attempt,
          ms: Date.now() - startedAt,
        })
        await new Promise((resolveTimer) => setTimeout(resolveTimer, delayMs))
      }

      // argv 里可能带 --value=<key> 之类的密钥，只记前两个词，不记完整命令行。
      const safeArgv = [argv[0] || '?', argv[1] || ''].filter(Boolean).join(' ');
      const isRetried = attempt > 1
      log.info(`op ${safeArgv}`.trim(), {
        ok: result.ok === true,
        exitCode: result.exitCode,
        ms: Date.now() - startedAt,
        argv: safeArgv,
        retries: attempt - 1,
        ...(result.ok === true ? {} : { error: result.text, fault: true }),
        ...(isRetried ? { recovered: result.ok } : {}),
      })
      return result
    }
    queue = queue.then(run, run)
    return queue
  }

  /**
   * task-8 / task-11：本地 op（不经 CLI、没有 call-log 可写）的日志落点。
   * 面板路径与工具路径**共用这一个函数**，两条路径的日志形状才一致。
   * 沿用同一个 plugin.log 通道，成功与失败都记，**只记 basename**（绝对路径含用户名）。
   */
  const logLocalOpRecord = (record) => {
    const entry = {
      op: record && record.op,
      ok: record && record.ok === true,
      file: record && typeof record.file === 'string' ? path.basename(record.file) : '',
      bytes: record && record.bytes,
      code: record && record.code,
      ms: record && record.ms,
    }
    try {
      if (entry.ok) log.info(`op ${entry.op}（本地）成功`, entry)
      else log.warn(`op ${entry.op}（本地）失败`, { ...entry, error: record && record.error, hint: record && record.hint })
    } catch (error) {
      // 日志写失败不许拖垮删除操作本身，但也不能静默：回落到宿主日志。
      try {
        ctx.logger.warn(`[wxmp] 本地 op 日志写入失败：${messageOf(error)}`)
      } catch {
        /* 宿主日志也写不了就真没地方落了：此时业务结果仍然照常返回给面板 */
      }
    }
  }

  /**
   * task-11：本地 op 的执行入口（目前只有 article_delete）。
   *
   * 返回结构与 CLI 路径同形（`{ok, exitCode, data, text}`，失败时 data.error.code + 顶层 code 都带稳定短码），
   * 这样工具描述里写的返回约定对本地 op 与 CLI op 一样成立。
   * 实现来自 ui-backend.deleteArticleFile —— 与面板路径同一份判定链，所以同一个输入两条路径给同一个错误码。
   */
  const runLocalOperation = (operation, params) => {
    if (operation === 'article_delete') {
      return deleteArticleFile(articleDirOf(), params && params.file, {
        logLocalOp: logLocalOpRecord,
        op: operation,
      })
    }
    return failure('unknown_operation', `本地 op 未实现: ${operation}`)
  }

  const tool = {
    name: 'wxmp',
    description: [
      '在本地制作并发布微信公众号（服务号/订阅号）文章：Markdown 成稿 → 校验 → 封面 → 草稿箱 → 发布。',
      `操作: ${OPERATIONS.join(', ')}。`,
      `参数: ${PARAMETER_HINTS}`,
      'publish_submit 必须显式传 yes=true 才真正发布，否则只 dry-run。',
      '发布是异步任务：提交后必须用 publish_wait 轮询，submit 成功不等于发布成功。',
    ].join(' '),
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => [{ type: 'text', text: String(value && value.text ? value.text : '') }],
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args) {
      const operation = args && args.operation
      const params = (args && args.params) || {}
      if (typeof operation !== 'string' || !operation) {
        return failure('invalid_params', '缺少 operation')
      }
      if (!OPERATIONS.includes(operation)) {
        return failure('unknown_operation', `不支持的操作: ${operation}`)
      }
      // task-11：本地 op **不走 CLI、也不进 enqueue 的串行队列**。放在 buildArgv 之前有两个理由：
      // ① 缺 file 时要给出与面板一致的 article_missing_arg，而 buildArgv 对缺参会抛 invalid_params
      //    （那是「CLI 参数翻译」的口径，不是「删除」的口径）；
      // ② 删除是写类操作，绝不能进超时重试——重试会撞上「第一次其实已经删掉了」的 ENOENT，
      //    把成功报成失败（N1 白名单只治 CLI 调用，本地 op 靠这条分流兜住）。
      if (LOCAL_OPERATIONS.has(operation)) {
        return runLocalOperation(operation, params)
      }
      let argv
      try {
        argv = buildArgv(operation, params)
      } catch (error) {
        if (error instanceof ToolInputError) return failure(error.code, error.message)
        return failure('invalid_params', error.message)
      }
      return enqueue(argv)
    },
  }

  /**
   * 工具这一块单独 inject：缺 tools 只降级工具，
   * 不会像模块级 inject 那样让面板和路由一起消失。
   */
  const mountTool = (tctx) => {
    const target = tctx && tctx.tools ? tctx : ctx
    if (!target.tools || typeof target.tools.register !== 'function') {
      log.warn('缺少 tools 服务，模型工具未注册（CLI 与面板仍可用）')
      return
    }
    const register = () => {
      try {
        return target.tools.register(tool)
      } catch (error) {
        log.error(`注册工具失败 ${messageOf(error)}`, { hint: '工具名 wxmp 可能与别的插件撞了' })
        return () => {}
      }
    }
    if (typeof target.effect === 'function') {
      target.effect(register)
      return
    }
    const disposer = register()
    // P1：统一走 addDisposer（追加语义），不再 set(ctx, [disposer]) 覆盖已登记的其它 disposer
    addDisposer(ctx, disposer)
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], mountTool)
    } catch (error) {
      log.warn(`inject(tools) 失败 ${messageOf(error)}`)
      mountTool()
    }
  } else {
    mountTool()
  }

  // ── 面板的 HTTP 后端（单独一块 inject）───────────────────────────
  const mountUi = (uctx) => {
    const target = uctx && uctx.webServer ? uctx : ctx
    if (!target.webServer || typeof target.webServer.register !== 'function') {
      log.warn('缺少 webServer 服务，面板后端未挂载', {
        route: ROUTE,
        hint: '面板会显示「后台未响应」；模型侧工具不受影响',
      })
      writeMountState(log, { mounted: false, reason: '宿主没有提供 webServer 服务' })
      return
    }
    // CLI 找不到时**照样挂路由**：挂上之后面板能显示「找不到 CLI」这句人话，
    // 而不是「连不上本机后端」——用户看不出区别，排查方向也完全不同。
    const handler = createUiHandler({
      runCli: enqueue,
      articleDir: articleDirOf(),
      version: VERSION,
      stateDir: stateDirOf(),
      health: () => ({
        route: ROUTE,
        mountedAt: new Date().toISOString(),
        pid: process.pid,
        cliPath: resolveCliPath(resolved) || '',
        stateDir: stateDirOf(),
        articleDir: articleDirOf(),
        config: { timeoutMs: resolved.timeoutMs },
        ops: UI_OPERATIONS,
      }),
      logTail: (lines) => log.tail(lines),
      logFile: () => log.file(),
      // N3③：把 logger.clear() 接上——面板「清除本插件数据」按钮的宿主侧实现
      clearData: () => clearPluginData(log, stateDirOf()),
      // task-8 / task-11：本地 op 的日志落点。面板路径与工具路径共用同一份实现
      //（logLocalOpRecord 定义在 execute 之前），两条路径的日志形状才一致。
      logLocalOp: logLocalOpRecord,
    })
    const register = () => {
      try {
        const table = target.webServer.exact
        if (table && typeof table.has === 'function' && table.has(ROUTE)) {
          log.warn(`${ROUTE} 已被占用，本插件不再重复注册`, { hint: '可能是另一个插件或上一实例没释放' })
          writeMountState(log, { mounted: false, reason: `${ROUTE} 已被占用`, route: ROUTE })
          return () => {}
        }
        // POST /api/wxmp —— 精确路由，承载全部白名单 op。
        const disposer = target.webServer.register({
          kind: 'exact',
          path: ROUTE,
          handler: (req, res) => handler(req, res),
        })

        /**
         * prefix /api/wxmp —— GET /api/wxmp/cover 必须靠它才能到达。
         *
         * 这是 0.4.0 漏掉的一环（面板封面一直是空框的直接原因）：
         * `kind: 'exact'` 只匹配 `/api/wxmp` 这一条**完整路径**，
         * 子路径 `/api/wxmp/cover` 不会被它命中，于是落到宿主默认处理，
         * 返回 `403 Browser access is disabled` —— 看起来像"权限问题"，
         * 实际是"没人接这个请求"。
         *
         * 为什么两个都要：exact 优先于 prefix，所以 POST 走 exact 拿到严格白名单；
         * 其余子路径（目前只有 cover 的 GET）由 prefix 兜住，handler 内部再按路径分发。
         */
        const prefixDisposer = target.webServer.register({
          kind: 'prefix',
          path: ROUTE,
          handler: (req, res) => handler(req, res),
        })

        writeMountState(log, { mounted: true, reason: '本插件注册成功', route: ROUTE })
        log.info(`${ROUTE} 已挂载（exact + prefix，含 /cover 取图）`, { pid: process.pid })

        return () => {
          try {
            if (typeof disposer === 'function') disposer()
          } catch {
            /* 已经释放过 */
          }
          try {
            if (typeof prefixDisposer === 'function') prefixDisposer()
          } catch {
            /* 已经释放过 */
          }
        }
      } catch (error) {
        log.error(`注册 ${ROUTE} 失败 ${messageOf(error)}`, { hint: '宿主 webServer 接口可能变了' })
        writeMountState(log, { mounted: false, reason: messageOf(error), route: ROUTE })
        return () => {}
      }
    }
    if (typeof target.effect === 'function') {
      const dispose = target.effect(register)
      // P1：统一走 addDisposer
      addDisposer(ctx, dispose)
      return
    }
    const disposer = register()
    // P1：统一走 addDisposer
    addDisposer(ctx, disposer)
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], mountUi)
    } catch (error) {
      log.warn(`inject(webServer) 失败 ${messageOf(error)}`)
      mountUi()
    }
  } else {
    mountUi()
  }
}

function messageOf(error) {
  return error && error.message ? error.message : String(error)
}

/**
 * 权威落盘记录：面板/工具出问题时先读这个文件，不靠复现。
 * 与 plugin-forge 的 mount-state.json 同形（at / route / mounted / reason / pid）。
 */
function writeMountState(log, info) {
  const payload = {
    at: new Date().toISOString(),
    route: info.route || ROUTE,
    mounted: info.mounted === true,
    reason: info.reason || '',
    pid: process.pid,
    platform: process.platform,
    version: VERSION,
    logFile: log.file(),
  }
  try {
    const dir = log.dir()
    fs.mkdirSync(dir, { recursive: true })
    const tmp = path.join(dir, 'mount-state.json.tmp')
    const final = path.join(dir, 'mount-state.json')
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    fs.renameSync(tmp, final)
  } catch (error) {
    log.warn(`写 mount-state.json 失败 ${messageOf(error)}`)
  }
  return payload
}

export { VERSION }

