/**
 * Host 半的 UI 后端：一个 loopback-only 的 HTTP 路由 `/api/wxmp`。
 *
 * 为什么需要它：模型侧通过 `wxmp` 工具驱动 CLI，而**用户侧的面板**需要同一批能力
 * （列文章、看校验、生成封面、建草稿、发布）。面板跑在浏览器里，不能直接 spawn，
 * 所以这里暴露一个受控的 HTTP 接口，内部仍然是调同一个 CLI。
 *
 * 安全边界：
 *  1. 只接受回环地址（127.0.0.1 / ::1），外部网卡访问一律 403；
 *  2. 操作走白名单，不接受任意 CLI 参数 —— 前端永远无法拼出 `config set --secret` 之外的东西；
 *  3. 文章路径限定在文章目录内，不允许穿越。
 *
 * 返回形状与 CLI 的 `--json` 一致：{ ok, exitCode, data, text }，前端直接消费。
 */

import fs from 'node:fs'
import path from 'node:path'

export const ROUTE = '/api/wxmp'
const MAX_BODY = 256 * 1024

const message = (error) => {
  const code = error && error.code ? `${String(error.code)}: ` : ''
  const text = error && error.message ? error.message : String(error)
  return `${code}${text}`
}

const send = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

const loopback = (req) => {
  const address = String((req && req.socket && req.socket.remoteAddress) || '')
  return address === '127.0.0.1' || address === '::1' || address === 'ffff:127.0.0.1' || address === '::ffff:127.0.0.1'
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error(`请求体超过 ${MAX_BODY} 字节`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

/** 允许面板触发的操作白名单 → CLI argv。纯函数，便于单测。 */
export function buildUiArgv(op, params = {}) {
  const p = params && typeof params === 'object' ? params : {}
  const str = (v) => (v === undefined || v === null ? '' : String(v))

  switch (op) {
    // ── 读：文章与状态 ──────────────────────────────────────────
    case 'state':
      return { argv: ['draft', 'count'], kind: 'count' }
    case 'list-articles':
      return { argv: ['article', 'list'], kind: 'articles' }
    case 'read-article':
      return { argv: ['article', 'show', '--file', str(p.file)], kind: 'article', needFile: true }
    case 'check-article':
      return { argv: ['article', 'check', '--file', str(p.file)], kind: 'check', needFile: true }
    case 'preview-article':
      return { argv: ['article', 'preview', '--file', str(p.file)], kind: 'preview', needFile: true }
    case 'list-drafts':
      return { argv: ['draft', 'list', '--count', str(p.count || 20)], kind: 'drafts' }
    case 'list-published':
      return { argv: ['publish', 'list', '--count', str(p.count || 20)], kind: 'published' }

    // ── 写：本地文件与封面 ──────────────────────────────────────
    case 'new-article':
      return {
        argv: [
          'article',
          'new',
          '--title',
          str(p.title),
          ...(p.author ? ['--author', str(p.author)] : []),
          ...(p.theme ? ['--theme', str(p.theme)] : []),
          ...(p.force ? ['--force'] : []),
        ],
        kind: 'created',
      }
    case 'write-article':
      return { argv: [], kind: 'write', local: true, needFile: true }
    case 'cover':
      return {
        argv: [
          'cover',
          '--file',
          str(p.file),
          ...(p.subtitle ? ['--subtitle', str(p.subtitle)] : []),
          ...(p.badge ? ['--badge', str(p.badge)] : []),
          ...(p.theme ? ['--theme', str(p.theme)] : []),
        ],
        kind: 'cover',
        needFile: true,
      }

    // ── 微信侧写操作 ────────────────────────────────────────────
    case 'draft-create':
      return { argv: ['draft', 'create', '--file', str(p.file)], kind: 'draftCreated', needFile: true }
    case 'draft-delete':
      return { argv: ['draft', 'delete', '--media-id', str(p.mediaId)], kind: 'deleted' }
    case 'publish-submit':
      return {
        argv: ['publish', 'submit', '--media-id', str(p.mediaId), '--yes'],
        kind: 'submitted',
      }
    case 'publish-status':
      return { argv: ['publish', 'status', '--publish-id', str(p.publishId)], kind: 'status' }

    // ── 配置 ────────────────────────────────────────────────────
    case 'config-show':
      return { argv: ['config', 'show'], kind: 'config' }
    case 'config-set':
      return {
        argv: ['config', 'set', '--appid', str(p.appid), '--secret', str(p.secret)],
        kind: 'configSaved',
      }
    case 'config-clear':
      return { argv: ['config', 'clear'], kind: 'configCleared' }
    case 'doctor':
      return { argv: ['doctor'], kind: 'doctor' }

    default:
      return null
  }
}

/** 面板只允许操作文章目录内的 .md，防目录穿越。 */
export function resolveInsideArticleDir(articleDirPath, requested) {
  const raw = String(requested || '').trim()
  if (!raw) throw new Error('缺少 file 参数')
  const target = path.resolve(articleDirPath, raw)
  const root = path.resolve(articleDirPath)
  const rel = path.relative(root, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('只能操作文章目录内的文件')
  }
  if (!target.toLowerCase().endsWith('.md')) throw new Error('只支持 .md 文章文件')
  return target
}

export function createUiHandler({ runCli, articleDir, version = '0.1.0' }) {
  return async function handle(req, res) {
    if (!loopback(req)) return send(res, 403, { ok: false, error: { code: 'forbidden', message: '只允许本机访问' } })
    if (req.method !== 'POST') {
      return send(res, 405, { ok: false, error: { code: 'method_not_allowed', message: '只接受 POST' } })
    }

    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch (error) {
      return send(res, 400, { ok: false, error: { code: 'bad_request', message: message(error) } })
    }

    const op = String((body && body.op) || '')
    if (op === 'ping') {
      return send(res, 200, { ok: true, data: { version }, text: 'pong' })
    }

    const spec = buildUiArgv(op, (body && body.params) || {})
    if (!spec) {
      return send(res, 400, {
        ok: false,
        error: { code: 'unknown_op', message: `不支持的操作：${op}` },
      })
    }

    try {
      let filePath = ''
      if (spec.needFile) {
        filePath = resolveInsideArticleDir(articleDir, (body.params || {}).file)
      }

      // 本地写入：只改 front matter / 正文，不经过 CLI 之外的能力
      if (spec.local && op === 'write-article') {
        const content = String((body.params || {}).content ?? '')
        if (!fs.existsSync(filePath)) {
          throw new Error('文章不存在，可能已被移动或删除')
        }
        fs.writeFileSync(filePath, content, 'utf8')
        return send(res, 200, {
          ok: true,
          exitCode: 0,
          data: { file: filePath, bytes: Buffer.byteLength(content, 'utf8') },
          text: '已保存',
        })
      }

      const argv = spec.argv.map((item) => (item === '__FILE__' ? filePath : item))
      const forward = spec.needFile ? argv : spec.argv
      const result = await runCli(forward)
      return send(res, 200, result)
    } catch (error) {
      return send(res, 200, {
        ok: false,
        exitCode: 1,
        data: { error: { code: (error && error.code) || 'ui_backend_error', message: message(error) } },
        text: message(error),
      })
    }
  }
}
