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

import { ROUTE, createUiHandler } from './ui-backend.js'

export const name = 'tool-wxmp'

/** `tools` 提供模型侧工具；`webServer` 可选，用于面板的 HTTP 后端。 */
export const inject = ['tools']

const VERSION = '0.1.0'

const pluginDir = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_TIMEOUT_MS = 120000

const OPERATIONS = [
  'config_show',
  'config_set',
  'article_new',
  'article_list',
  'article_show',
  'article_check',
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

const PARAMETER_HINTS = [
  'config_set(appid, secret), config_show, doctor,',
  'article_new(title, author?, theme?, cover?), article_list, article_show(file?),',
  'article_check(file?), article_preview(file?, out?, open?),',
  'cover(file?, title?, subtitle?, badge?, theme?, out?),',
  'draft_create(file?, dryRun?, thumbMediaId?), draft_list(offset?, count?, full?),',
  'draft_get(mediaId), draft_update(file?, mediaId?, index?), draft_delete(mediaId), draft_count,',
  'publish_submit(mediaId?|file?, yes?), publish_status(publishId),',
  'publish_wait(publishId, timeoutMs?, intervalMs?), publish_list(offset?, count?),',
  'publish_delete(articleId, yes?)',
  '所有操作都接受 baseUrl（指向自建网关，默认走 api.weixin.qq.com）。',
].join(' ')

const PROMPT_TEXT = [
  'Use the wxmp tool to author and publish WeChat Official Account (公众号/服务号) articles:',
  'write Markdown with front matter (wxmp article new), validate against WeChat limits (article_check),',
  'generate a cover image (cover), create a draft (draft_create), then publish (publish_submit + publish_wait).',
  'Publish requires yes=true; without it the call only dry-runs. Publishing is asynchronous — always poll with publish_wait.',
  'Body images must be uploaded (the tool does it) because WeChat filters non-mmbiz image URLs; the CLI handles that in draft_create.',
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
    cliPath: typeof config.cliPath === 'string' ? config.cliPath : '',
    stateDir: typeof config.stateDir === 'string' ? config.stateDir : '',
    timeoutMs:
      Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS,
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
    case 'article_preview':
      argv.push('article', 'preview')
      pushFlag(argv, 'file', p.file)
      pushFlag(argv, 'out', p.out)
      pushFlag(argv, 'open', p.open)
      break
    case 'cover':
      argv.push('cover')
      pushFlag(argv, 'file', p.file)
      pushFlag(argv, 'subtitle', p.subtitle)
      pushFlag(argv, 'badge', p.badge)
      pushFlag(argv, 'theme', p.theme)
      pushFlag(argv, 'out', p.out)
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
  pushFlag(argv, 'base-url', p.baseUrl ?? p.base_url)

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
    })
  })
}

function failure(code, message, exitCode = 2) {
  return { ok: false, exitCode, data: { error: { code, message } }, text: `${code}: ${message}` }
}

const disposersByCtx = new WeakMap()

/**
 * @param {object} ctx cordis 上下文（必须 inject `tools`）
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

  try {
    ctx.systemPrompt?.section?.({
      name: 'tool:wxmp',
      order: 114,
      text: PROMPT_TEXT,
    })
  } catch {
    /* systemPrompt 是可选服务 */
  }

  let queue = Promise.resolve()

  const tool = {
    name: 'wxmp',
    description: [
      '在本地制作并发布微信公众号（服务号/订阅号）文章：Markdown 成稿 → 校验 → 封面 → 草稿箱 → 发布。',
      `操作: ${OPERATIONS.join(', ')}。`,
      `参数: ${PARAMETER_HINTS}`,
      'publish_submit 必须显式传 yes=true 才真正发布，否则只 dry-run。',
      '发布是异步任务：提交后必须用 publish_wait 轮询，submit 成功不等于发布成功。',
    ].join(' '),    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => [{ type: 'text', text: String(value && value.text ? value.text : '') }],
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args) {
      const operation = args && args.operation
      const params = (args && args.params) || {}
      const run = async () => {
        if (typeof operation !== 'string' || !operation) {
          return failure('invalid_params', '缺少 operation')
        }
        if (!OPERATIONS.includes(operation)) {
          return failure('unknown_operation', `不支持的操作: ${operation}`)
        }
        const cliPath = resolveCliPath(resolved)
        if (!cliPath) {
          return failure('cli_not_found', '找不到 bin/wxmp.js，请配置 cliPath 或设置 WXMP_CLI_JS')
        }
        let argv
        try {
          argv = buildArgv(operation, params)
        } catch (error) {
          if (error instanceof ToolInputError) return failure(error.code, error.message)
          return failure('invalid_params', error.message)
        }
        const cwd = process.cwd()
        const stateDir = resolved.stateDir ? path.resolve(resolved.stateDir) : ''
        const env = { ...process.env }
        if (stateDir) env.WXMP_HOME = stateDir
        return runCli(argv, { cliPath, cwd, stateDir, timeoutMs: resolved.timeoutMs, env })
      }
      queue = queue.then(run, run)
      return queue
    },
  }

  const disposer = ctx.tools.register(tool)
  if (typeof disposer === 'function') disposersByCtx.set(ctx, [disposer])

  // ── 面板的 HTTP 后端 ────────────────────────────────────────────
  // 没有 webServer 服务时静默跳过：模型侧工具仍然可用，只是 UI 面板会自己报
  // 「后端未就绪」而不是整个插件挂掉。
  const disposers = typeof disposer === 'function' ? [disposer] : []

  try {
    const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer
    if (webServer && typeof webServer.register === 'function') {
      const cwd = process.cwd()
      const articleDir = resolved.stateDir
        ? path.join(path.resolve(resolved.stateDir), 'articles')
        : defaultArticleDir(cwd)

      const runUiCli = async (argv) => {
        const cliPath = resolveCliPath(resolved)
        if (!cliPath) {
          return {
            ok: false,
            exitCode: 1,
            data: { error: { code: 'cli_not_found', message: '找不到 bin/wxmp.js' } },
            text: '找不到 CLI 入口',
          }
        }
        const stateDir = resolved.stateDir ? path.resolve(resolved.stateDir) : ''
        const env = { ...process.env }
        if (stateDir) env.WXMP_HOME = stateDir
        return runCli(argv, { cliPath, cwd, stateDir, timeoutMs: resolved.timeoutMs, env })
      }

      const handler = createUiHandler({ runCli: runUiCli, articleDir, version: VERSION })
      const routeDisposer = webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: (req, res) => handler(req, res),
      })
      if (typeof routeDisposer === 'function') disposers.push(routeDisposer)
    }
  } catch (error) {
    try {
      ctx.logger?.warn?.(`[wxmp] UI 后端注册失败：${error && error.message ? error.message : error}`)
    } catch {
      /* 日志服务也不可用就算了 */
    }
  }

  if (disposers.length) disposersByCtx.set(ctx, disposers)
}

export { VERSION }

