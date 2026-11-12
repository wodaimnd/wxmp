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
import { spawn } from 'node:child_process'

export const ROUTE = '/api/wxmp'
/** 图片供应商 id 清单：清空 key 时逐家删除要用。
 *  这里重复一份而不 import 主包，是为了让面板半不依赖 CLI 内部模块
 *  （面板半只该依赖 loopback 协议，不该 import 业务实现）。 */
const DIRECT_IMAGE_PROVIDER_IDS = [
  'openai', 'azure_openai', 'doubao', 'dashscope', 'jimeng',
  'minimax', 'gemini', 'openrouter', 'replicate', 'modelscope',
]

const MAX_BODY = 256 * 1024
/** 只有封面底图这个 op 需要更大的 body（最长边 12 MB 的图转 base64 会到 ~16 MB）。
 *  不能整体放宽：那等于给所有 op 开一个 16 MB 的攻击面。
 *  所以读的时候用宽松上限，解析出 op 之后再按 op 精确校验。 */
const MAX_BODY_UPLOAD = 20 * 1024 * 1024

/**
 * F2：底图文件名的**唯一口径** —— 裁剪（save-background）与计数（health.bgCount）
 * 必须用同一个正则。
 *
 * 之前两处各写一份，裁剪漏了 gif、计数含 gif：手工放进来的 `bg-*.gif` 只被计数、
 * 永远轮不到被裁，底图会永久卡在 21 个（每张 ≤12MB）。改这里就等于同时改两处口径，
 * 不要再在其它地方手写这份扩展名列表。
 */
const BG_FILE_RE = /^bg-.*\.(png|jpe?g|gif|webp)$/i

/**
 * N7：版本号从 package.json 读，不再写死默认值。
 * 原来 createUiHandler 的默认参数是 `version = '1.7.1'`——index.js 每次都会传真值
 * 覆盖它，所以这个默认值永远不生效，一旦哪天没人传，面板就会报出一个早就不存在的版本号。
 * 读不到就返回 'unknown'：宁可显示「不知道」，也不显示一个骗人的数字。
 */
export const PKG_VERSION = (() => {
  try {
    const raw = fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
})()

/**
 * 面板可用的操作清单。前端与后端共用这一份，避免「面板发了一个后端不认的 op」
 * 这类只在真机才会暴露的偏差。
 */
export const UI_OPERATIONS = [
  'ping',
  'health',
  'state',
  'list-articles',
  'read-article',
  'check-article',
  'review-article',
  'import-article',
  'title-lab',
  'set-title',
  'set-author',
  'outline-lab',
  'writing-brief',
  'material-library',
  'illustrate',
  'image-providers',
  'config-set-image',
  'config-clear-image',
  'save-background',
  'preset-list',
  'preset-show',
  // 1.8.0：预设 → 写作提示词（面板「复制写作提示词」按钮用）
  'preset-prompt',
  'preset-use',
  'preset-export',
  'preset-import',
  'preset-remove',
  'preset-reset',
  'preview-article',
  // 1.8.1：快捷打开（📄 打开文件 / 📂 所在文件夹）。本地 op，不落 argv。
  'open-article',
  'new-article',
  'write-article',
  // task-8：删除本地文章。CLI 没有 `article delete` 子命令，删除由宿主半自己做 fs 删除，
  // 所以它不产生 argv（local op），但和别的 op 一样列进这份前后端共用清单。
  'article-delete',
  'list-drafts',
  'list-published',
  'cover',
  'draft-create',
  'draft-delete',
  'publish-submit',
  'publish-status',
  'config-show',
  'config-set',
  'config-clear',
  'doctor',
  'logs',
  'clear-plugin-data',
]

const message = (error) => {
  const code = error && error.code ? `${String(error.code)}: ` : ''
  const text = error && error.message ? error.message : String(error)
  return `${code}${text}`
}

/**
 * task-8：给「路径收敛 / 只 .md」这类判定错误打一个稳定短码。
 * 调用方按 err.code 换成三段式回执，**不靠匹配错误文案**——文案会被人改，短码不会。
 */
const taggedError = (code, text) => {
  const error = new Error(text)
  error.code = code
  return error
}

const send = (res, status, body) => {
  // 连接可能已经被关掉（请求被中断 / 测试里 server 先 close）：
  // 再写一次头就会抛 ERR_HTTP_HEADERS_SENT，把无害的收尾变成一条假错误。
  if (res.writableEnded || res.headersSent) return
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

/** 封面可用的图片类型：只放行这几种，别让任意文件被读出去。 */
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/**
 * 解析封面文件的绝对路径，并**强制**限定在文章目录内。
 *
 * 为什么单独一个函数：封面文件名来自 front matter（用户可写），
 * 直接拼进路径就等于把读文件的能力交出去了。这里用 realpath 比对，
 * 相对路径、绝对路径、目录穿越都会被拦在同一处。
 */
export function resolveCoverPath(articleDirPath, name) {
  const raw = String(name || '').trim()
  if (!raw) throw Object.assign(new Error('缺少封面文件名'), { code: 'cover_missing' })
  if (/^(https?|data|file):/i.test(raw)) {
    throw Object.assign(new Error('封面是远程地址，面板不代理外链'), { code: 'cover_remote' })
  }
  const root = path.resolve(articleDirPath)
  const target = path.isAbsolute(raw) ? raw : path.resolve(root, raw)
  const rel = path.relative(root, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw Object.assign(new Error('只能读取文章目录内的封面'), { code: 'cover_outside' })
  }
  const ext = path.extname(target).toLowerCase()
  if (!IMAGE_TYPES[ext]) {
    throw Object.assign(new Error(`不支持的图片类型：${ext || '(无扩展名)'}`), { code: 'cover_bad_type' })
  }
  let real
  try {
    real = fs.realpathSync(target)
  } catch {
    throw Object.assign(new Error('封面文件不存在（可能还没生成）'), { code: 'cover_not_found' })
  }
  // realpath 之后再比一次：防符号链接指到目录外
  const realRoot = fs.realpathSync(root)
  const realRel = path.relative(realRoot, real)
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
    throw Object.assign(new Error('封面路径越界'), { code: 'cover_outside' })
  }
  return { file: real, contentType: IMAGE_TYPES[ext] }
}

const readBody = (req, limit = MAX_BODY) =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error(`请求体超过 ${limit} 字节`), { code: 'body_too_large' }))
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
    case 'article_list':
      return { argv: ['article', 'list'], kind: 'articles' }
    case 'read-article':
      return { argv: ['article', 'show', '--file', str(p.file)], kind: 'article', needFile: true }
    case 'check-article':
      return { argv: ['article', 'check', '--file', str(p.file)], kind: 'check', needFile: true }
    case 'review-article':
      // 体检：面板也能看分数与带行号的改法（不带 --min-score，看分数不需要判失败）
      return { argv: ['article', 'review', '--file', str(p.file)], kind: 'review', needFile: true }
    case 'preview-article':
      // 1.8.1：open:true → CLI --open，生成后直接用默认浏览器打开（快捷预览）。
      // 原来只生成不打开，路径只在 notify 里闪一下；现在一步到位。
      return {
        argv: ['article', 'preview', '--file', str(p.file), ...(p.open === true ? ['--open'] : [])],
        kind: 'preview',
        needFile: true,
      }
    // 1.8.1：快捷打开（📄 打开文件 / 📂 所在文件夹）。与 article-delete 同款本地 op：
    // argv 为空 + local:true，判定与打开动作在 handler 的 spec.openArticle 分支做 ——
    // 「先收敛路径再打开」需要 fs 与 realpath，套不进这里的 argv 拼装。
    // what 只认 file | folder；缺省按 file（打开 .md 本身）。
    case 'open-article':
      return {
        argv: [],
        kind: 'articleOpened',
        local: true,
        openArticle: { what: p.what === 'folder' ? 'folder' : 'file' },
      }
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
          // N4：`article new` 只认 --cover（CLI src/commands.js:950），没有 --bg / --image-gen
          //（那两个只属于 cover 子命令）。原来传的两串是永不生效的死参数，parseArgv 静默丢掉；
          // 名字还与 CLI 契约不符。工具侧 `article_new` 一直用 --cover —— 以它为准对齐。
          ...(p.cover ? ['--cover', str(p.cover)] : []),
          ...(p.force ? ['--force'] : []),
        ],
        kind: 'created',
      }
    case 'article_new':
      return {
        argv: [
          'article',
          'new',
          '--title',
          str(p.title),
          ...(p.author ? ['--author', str(p.author)] : []),
          ...(p.theme ? ['--theme', str(p.theme)] : []),
          // N4：`article new` 只认 --cover（CLI src/commands.js:950），没有 --bg / --image-gen
          //（那两个只属于 cover 子命令）。原来传的两串是永不生效的死参数，parseArgv 静默丢掉；
          // 名字还与 CLI 契约不符。工具侧 `article_new` 一直用 --cover —— 以它为准对齐。
          ...(p.cover ? ['--cover', str(p.cover)] : []),
          ...(p.force ? ['--force'] : []),
        ],
        kind: 'created',
      }
    case 'write-article':
      return { argv: [], kind: 'write', local: true, needFile: true }
    // task-8：删除本地文章。CLI 侧**没有** `article delete` 子命令
    //（G:\AI PGRM\DSH\wxmp\src\commands.js 的 article 子命令只有 set/clear/import/titles/
    // library/illustrate/brief/outline/set-title/set-author/new/list/show/check/review/presets/preview），
    // 所以删除由宿主半自己 fs 完成：不假装走 CLI，也不去改 CLI。
    // argv 为空 + local:true：真正的删除在 handler 的 spec.articleDelete 分支里，
    // 因为「先判定再删」需要 fs 与逐条错误码，套不进这里的 argv 拼装。
    case 'article-delete':
      return { argv: [], kind: 'articleDeleted', local: true, articleDelete: true }
    case 'cover':
      return {
        argv: [
          'cover',
          '--file',
          str(p.file),
          ...(p.subtitle ? ['--subtitle', str(p.subtitle)] : []),
          ...(p.badge ? ['--badge', str(p.badge)] : []),
          ...(p.theme ? ['--theme', str(p.theme)] : []),
          ...(p.bg ? ['--bg', str(p.bg)] : []),
          ...(p.imageGen ? ['--image-gen', p.imageGen === true ? 'true' : str(p.imageGen)] : []),
          // 面板上的提示词输入框：写了才传；空串/纯空白不传，避免覆盖内置模板
          ...(p.prompt && String(p.prompt).trim() ? ['--prompt', String(p.prompt).trim()] : []),
          // 输出尺寸：只有在面板传了正整数时才追加，默认（不传）走 CLI 的推荐值 900×383。
          // 越界与比例的收敛都在 CLI 的 normalizeCoverSize 里做 —— 面板不做安全逻辑。
          ...(Number.isFinite(Number(p.width)) && Number(p.width) > 0
            ? ['--width', String(Math.round(Number(p.width)))]
            : []),
          ...(Number.isFinite(Number(p.height)) && Number(p.height) > 0
            ? ['--height', String(Math.round(Number(p.height)))]
            : []),
        ],
        kind: 'cover',
        needFile: true,
      }
    /**
     * 从公众号链接导入文章。
     * 面板只传 URL，白名单校验在后端 extractor 里做（面板不重复实现安全逻辑）。
     */
    case 'import-article': {
      const url = str(p.url)
      const list = str(p.list)
      if (!url && !list) {
        return { argv: [], kind: 'invalid', local: true, error: { code: 'args_required', message: '需要一个公众号链接' } }
      }
      return {
        argv: ['article', 'import', ...(url ? [url] : []), ...(list ? ['--list', list] : [])],
        kind: 'imported',
      }
    }
    /**
     * 写作辅助三件套：标题、骨架、任务书。
     * 都是只读操作（不写文件），只在 set-title 时才改 front matter。
     */
    case 'title-lab':
      return {
        argv: ['article', 'titles', ...(p.file ? ['--file', str(p.file)] : []), ...(p.brief ? ['--brief'] : [])],
        kind: 'titles',
      }
    case 'set-title':
      return {
        argv: ['article', 'set-title', '--file', str(p.file), '--title', str(p.title)],
        kind: 'titleSet',
        needFile: true,
      }
    // 改作者名。`author` 传空字符串是**有意为之**：它就是「清空」，
    // 不能像别的可选参数那样省略，否则 CLI 会把空串当成"没传"而报缺参。
    case 'set-author':
      return {
        argv: ['article', 'set-author', '--file', str(p.file), '--author', str(p.author)],
        kind: 'authorSet',
        needFile: true,
      }
    case 'outline-lab':
      return {
        argv: ['article', 'outline', ...(p.file ? ['--file', str(p.file)] : []), ...(p.form ? ['--form', str(p.form)] : [])],
        kind: 'outline',
      }
    case 'writing-brief':
      return {
        argv: ['article', 'brief', str(p.topic), ...(p.form ? ['--form', str(p.form)] : []), ...(p.words ? ['--words', String(p.words)] : [])],
        kind: 'brief',
      }
    /** 素材库：列出公众号后台的图片素材（标注哪些能当正文插图）。 */
    case 'material-library':
      return { argv: ['article', 'library', ...(p.usable ? ['--usable'] : [])], kind: 'library' }
    /** 智能插图：从素材库选图并按语义给位置；apply 才真的写进文章。 */
    case 'illustrate':
      return {
        argv: [
          'article', 'illustrate',
          '--file', str(p.file),
          ...(p.max ? ['--max', String(p.max)] : []),
          ...(p.apply ? ['--apply'] : []),
        ],
        kind: 'illustrated',
        needFile: true,
      }
    /**
     * 探测 AI 配图是否可用（有没有配 key）。
     * 面板需要在**点按钮之前**就知道能不能用，
     * 否则用户点一次才被告知「未配置 key」，等于白点。
     */
    case 'image-providers':
      return { argv: ['image-providers'], kind: 'imageProviders' }
    /** 保存某家图片供应商的 key（面板设置页用）。 */
    case 'config-set-image': {
      const provider = str(p.provider)
      const key = str(p.key)
      if (!provider || !key) {
        return { argv: [], kind: 'invalid', local: true, error: { code: 'args_required', message: '供应商与 key 都不能为空' } }
      }
      return {
        argv: ['config', 'set', '--image-key', provider, '--value', key],
        kind: 'imageKeySaved',
      }
    }
    /** 清空所有图片 key：逐个删除已知供应商。 */
    case 'config-clear-image': {
      return { argv: [], kind: 'imageKeysCleared', local: true, clearImageKeys: true }
    }
    /**
     * 面板选了底图 → 落盘到文章目录，返回文件名供 cover --bg 引用。
     * 为什么不在前端用 data URL 直接塞给 cover：
     *   图可能几 MB，塞进 JSON body 既慢又容易触 body 上限（本路由限 256 KB）。
     * 这里单独放行更大的 body，并在落盘前做类型/尺寸/越界校验。
     */
    case 'save-background':
      return { argv: [], kind: 'backgroundSaved', local: true, needsBackground: true }

    /**
     * N3③：清除本插件数据（排障日志）。
     * logger.js 的 clear() 从写下那天起就没有调用点 —— 残留的明文密钥躺在
     * plugin.log 里没人能一键回收。这里把入口补上，不经过 CLI：删的是插件自己的文件。
     * 真删除动作由宿主侧回调完成（index.js 的 clearPluginData）。
     */
    case 'clear-plugin-data':
      return { argv: [], kind: 'dataCleared', local: true, clearData: true }

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

    // ── 体检预设：面板上选 / 导出 / 导入 ────────────────────────
    case 'preset-list':
      return { argv: ['article', 'preset', 'list'], kind: 'presetList' }
    case 'preset-show':
      return { argv: ['article', 'preset', 'show', str(p.id)], kind: 'presetShown' }
    case 'preset-prompt':
      // id 可选：不传就用当前生效的预设（CLI 侧 currentPresetId 兜底）
      return {
        argv: ['article', 'preset', 'prompt', ...(p.id ? [str(p.id)] : [])],
        kind: 'presetPrompt',
      }
    case 'preset-use':
      // 面板点「用这个标准」——写进 config.json，之后 CLI/工具/面板都按它打分
      return { argv: ['article', 'preset', 'use', str(p.id)], kind: 'presetUsed' }
    case 'preset-export':
      return { argv: ['article', 'preset', 'export', str(p.id)], kind: 'presetExported' }
    case 'preset-import': {
      // 面板把文件内容读进来，落成临时文件再交给 CLI（CLI 只认路径）
      return {
        argv: ['article', 'preset', 'import', '__PRESET_FILE__', ...(p.as ? ['--as', str(p.as)] : []), ...(p.force ? ['--force'] : [])],
        kind: 'presetImported',
        needsPresetFile: true,
      }
    }
    case 'preset-remove':
      return { argv: ['article', 'preset', 'remove', str(p.id)], kind: 'presetRemoved' }
    case 'preset-reset':
      return { argv: ['article', 'preset', 'reset'], kind: 'presetReset' }

    default:
      return null
  }
}

/**
 * 面板只允许操作文章目录内的 .md，防目录穿越。
 *
 * task-8：加了第二参数 opts.requireRealpath（article-delete 用），并给抛出的错误打上
 * 稳定短码（err.code），供调用方换成三段式回执——**不靠匹配错误文案**。
 * 为什么需要 realpath：上面的词法收敛（path.resolve + path.relative）看不出软链，
 * 「文章目录内的软链指向目录外」会顺利通过词法检查，只有 realpath 才能发现。
 * 既有调用方不传 opts，行为与文案完全不变。
 */
export function resolveInsideArticleDir(articleDirPath, requested, opts = {}) {
  const raw = String(requested || '').trim()
  if (!raw) throw taggedError('article_missing_arg', '缺少 file 参数')
  const target = path.resolve(articleDirPath, raw)
  const root = path.resolve(articleDirPath)
  const rel = path.relative(root, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw taggedError('article_path_invalid', '只能操作文章目录内的文件')
  }
  if (!target.toLowerCase().endsWith('.md')) throw taggedError('article_not_md', '只支持 .md 文章文件')
  if (opts.requireRealpath) {
    let realTarget = ''
    try {
      realTarget = fs.realpathSync(target)
    } catch (error) {
      // 悬空软链与真不存在都落在这里：从用户视角「这个文件取不到」，按不存在处理。
      if (error && error.code === 'ENOENT') throw taggedError('article_not_found', '文章不存在')
      throw taggedError('article_path_invalid', `路径无法解析：${message(error)}`)
    }
    const realRoot = fs.realpathSync(root)
    const realRel = path.relative(realRoot, realTarget)
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      // 词法看着在目录内、realpath 落在目录外——典型的一条软链指向 ../config.json。
      throw taggedError('article_path_invalid', '只能操作文章目录内的文件')
    }
  }
  return target
}

/**
 * task-8 / task-11：删除本地文章的**唯一实现**。
 *
 * 面板路径（handler 的 `spec.articleDelete` 分支）与模型路径（index.js 的 `article_delete`）
 * 都调这一个函数——两份判定链慢慢跑偏的后果是：同一个输入两条路径给出不同的错误码，
 * 用户看到的「为什么删不掉」就不一样了，而 skill 文档只写得下一种。
 *
 * 判定顺序按「越早越便宜、越早越安全」排：缺参 → 路径收敛（含 realpath）→ statSync → 才 unlink。
 * 任何一步不过都原样返回，**绝不在判定不全时动 unlink**。
 * 返回 { ok, exitCode, data, text }（与面板回执、工具结果同形）；
 * 失败额外带顶层 error / code / hint（面板的 runAction 与模型都按顶层读）。
 */
export function deleteArticleFile(articleDirPath, requested, opts = {}) {
  const { logLocalOp = null, op = 'article-delete' } = opts
  const startedAt = Date.now()
  // 日志只记 basename（N5 口径）：绝对路径含用户名，不该落到日志里。
  const nameForLog = typeof requested === 'string' && requested ? path.basename(requested) : ''
  const logDelete = (record) => {
    // 日志写失败不许拖垮删除本身；但也不静默——由 index.js 侧回落到宿主日志。
    try {
      if (typeof logLocalOp === 'function') logLocalOp({ op, ms: Date.now() - startedAt, ...record })
    } catch {
      /* 日志回调自己保证不抛；这里只是最后一道防线 */
    }
  }
  const fail = (code, errorText, hint) => {
    logDelete({ ok: false, file: nameForLog, code, error: errorText, hint })
    // 三段式在**顶层**再给一份（error/code/hint）：面板的 runAction 按顶层读，
    // data.error 只是详情副本，两个都给才不会「看得见 ok:false、看不见原因」。
    return {
      ok: false,
      exitCode: 1,
      error: errorText,
      code,
      hint,
      data: { error: { code, message: errorText }, hint },
      text: `${code}: ${errorText}（${hint}）`,
    }
  }

  if (requested === undefined || requested === null || String(requested).trim() === '') {
    return fail('article_missing_arg', '缺少 file 参数', '传入文章文件名（文章目录内的 .md）后重试')
  }

  let target = ''
  try {
    // 复用既有收敛函数，不另写一份 realpath 比对；requireRealpath 额外拦住
    // 「目录内的软链指向目录外」——词法检查看不出软链，那样就会删到目录外的文件。
    target = resolveInsideArticleDir(articleDirPath, requested, { requireRealpath: true })
  } catch (error) {
    const code = (error && error.code) || 'article_path_invalid'
    const text = (error && error.message) || '路径不合法'
    const hint =
      code === 'article_not_md'
        ? '这里只能删 .md 文章；封面底图请在封面设置里替换（它有独立的裁剪逻辑）'
        : code === 'article_not_found'
          ? '文件可能已被删除或移动，刷新列表后重试'
          : '只能删除文章目录内的 .md 文件，请从文章列表里选择'
    return fail(code, text, hint)
  }

  let stats = null
  try {
    stats = fs.statSync(target)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return fail('article_not_found', '文章不存在（可能已被删除或移动）', '刷新文章列表后重试')
    }
    return fail('article_delete_failed', `读取文章信息失败：${(error && error.message) || error}`, '确认文件未被占用或锁定后重试')
  }
  if (!stats.isFile()) {
    // 目标是目录（哪怕名字以 .md 结尾）也不能删：删除是破坏性的，宁可不做。
    return fail('article_not_md', '目标不是普通文件（可能是目录）', '只能删除文章目录内的单篇 .md 文件')
  }

  try {
    fs.unlinkSync(target)
  } catch (error) {
    return fail('article_delete_failed', `删除失败：${(error && error.message) || error}`, '关闭正在占用该文件的编辑器或预览窗口后重试')
  }

  const doneName = path.basename(target)
  logDelete({ ok: true, file: doneName, bytes: stats.size })
  return {
    ok: true,
    exitCode: 0,
    // N5：回执只给 basename。面板自己会显示标题，不需要路径，更不该带用户名。
    data: { file: doneName, bytes: stats.size },
    text: `已删除 ${doneName}`,
  }
}

/**
 * 1.8.1：系统层「打开」的默认实现（进程里 fire-and-forget，不等待、不接输出）。
 * file → 交给系统默认程序（编辑器）；folder → 资源管理器定位并选中该文件。
 * Windows 的 `explorer /select,"路径"` 必须把逗号和路径连在一个参数里才可靠；
 * spawn 的参数数组保证路径不会被 shell 再拆一次。
 */
export function defaultShellOpen(target, what) {
  try {
    let command = ''
    let args = []
    if (process.platform === 'win32') {
      if (what === 'folder') {
        command = 'explorer.exe'
        args = ['/select,', target]
      } else {
        command = 'cmd.exe'
        args = ['/c', 'start', '', target]
      }
    } else if (process.platform === 'darwin') {
      command = 'open'
      args = what === 'folder' ? ['-R', target] : [target]
    } else {
      command = 'xdg-open'
      args = [what === 'folder' ? path.dirname(target) : target]
    }
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  } catch {
    /* 打不开就算了：回执里已带回路径，用户可以自己进文件夹 */
  }
}

/**
 * 1.8.1：快捷打开本地文章的**唯一实现**（与 deleteArticleFile 同款「唯一实现」范式）。
 *
 * 面板路径（handler 的 `spec.openArticle` 分支）只有这一个入口，判定顺序照抄删除链：
 * 缺参 → 路径收敛（只 .md、含 realpath 拦软链）→ 交给 shellOpen。
 * shellOpen 由调用方注入（测试用记录器，绝不真弹窗口）；默认 defaultShellOpen。
 * 返回 { ok, exitCode, data, text }；失败带顶层 error / code / hint（runAction 按顶层读）。
 */
export function openArticleFile(articleDirPath, requested, opts = {}) {
  const { what = 'file', shellOpen = defaultShellOpen, logLocalOp = null, op = 'open-article' } = opts
  const nameForLog = typeof requested === 'string' && requested ? path.basename(requested) : ''
  const logOpen = (record) => {
    try {
      if (typeof logLocalOp === 'function') logLocalOp({ op, ...record })
    } catch {
      /* 日志回调自己保证不抛；这里只是最后一道防线 */
    }
  }
  const fail = (code, errorText, hint) => {
    logOpen({ ok: false, file: nameForLog, code, error: errorText, hint })
    return {
      ok: false,
      exitCode: 1,
      error: errorText,
      code,
      hint,
      data: { error: { code, message: errorText }, hint },
      text: `${code}: ${errorText}（${hint}）`,
    }
  }

  let target = ''
  try {
    target = resolveInsideArticleDir(articleDirPath, requested, { requireRealpath: true })
  } catch (error) {
    const code = (error && error.code) || 'article_path_invalid'
    const text = (error && error.message) || '路径不合法'
    const hint =
      code === 'article_not_md'
        ? '只能打开 .md 文章文件'
        : code === 'article_not_found'
          ? '文件可能已被删除或移动，刷新列表后重试'
          : '只能打开文章目录内的 .md 文件，请从文章列表里选择'
    return fail(code, text, hint)
  }

  shellOpen(target, what)
  logOpen({ ok: true, file: nameForLog, what })
  return {
    ok: true,
    exitCode: 0,
    data: { path: target, what },
    text: what === 'folder' ? `已在资源管理器中显示：${nameForLog}` : `已打开：${nameForLog}`,
  }
}

export function createUiHandler({ runCli, articleDir, version = PKG_VERSION, health = null, logTail = null, logFile = null, stateDir = '', clearData = null, logLocalOp = null }) {
  return async function handle(req, res) {
    if (!loopback(req)) return send(res, 403, { ok: false, error: { code: 'forbidden', message: '只允许本机访问' } })

    const url = new URL(req.url || '/', 'http://127.0.0.1')
    // P2：POST 只允许精确路由 /api/wxmp，子路径一律 404，避免请求落入宿主默认流程
    if (req.method === 'POST' && url.pathname !== ROUTE) {
      return send(res, 404, { ok: false, error: { code: 'not_found', message: '未知 POST 路径' } })
    }

    // ── GET /api/wxmp/cover?f=<封面文件名> ────────────────────────
    // 唯一一个 GET：<img> 不能发 POST，而封面必须能在面板里显示成图。
    // 权限收敛在 resolveCoverPath 里（目录内 + 白名单后缀 + realpath 二次校验）。
    if (req.method === 'GET') {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (url.pathname !== `${ROUTE}/cover`) {
        return send(res, 404, { ok: false, error: { code: 'not_found', message: '未知 GET 路径' } })
      }
      try {
        const { file, contentType } = resolveCoverPath(articleDir, url.searchParams.get('f'))
        const body = fs.readFileSync(file)
        if (res.writableEnded || res.headersSent) return
        res.writeHead(200, {
          'content-type': contentType,
          // 封面会随「重新生成封面」变化，所以不能被浏览器长期缓存：
          // 用 mtime 做 ETag，配合 no-cache 让每次刷新都拿到最新一张。
          'cache-control': 'no-cache',
          etag: `"${fs.statSync(file).mtimeMs}"`,
        })
        res.end(body)
      } catch (error) {
        return send(res, error && error.code === 'cover_not_found' ? 404 : 400, {
          ok: false,
          error: { code: (error && error.code) || 'cover_error', message: message(error) },
        })
      }
      return undefined
    }

    if (req.method !== 'POST') {
      return send(res, 405, { ok: false, error: { code: 'method_not_allowed', message: '只接受 POST' } })
    }

    let body
    let rawBody = ''
    try {
      // 用宽松上限读取：这时还不知道 op，无法按 op 决定上限。
      // 真正的精确校验在下面拿到 op 之后做（非上传类 op 仍按 256 KB 卡）。
      rawBody = await readBody(req, MAX_BODY_UPLOAD)
      body = JSON.parse(rawBody)
    } catch (error) {
      return send(res, 400, { ok: false, error: { code: (error && error.code) || 'bad_request', message: message(error) } })
    }

    const op = String((body && body.op) || '')
    // 精确校验：除封面底图外，其它 op 的 body 不该超过 256 KB。
    // JSON.stringify 的实际字节比原文略大，用 rawBody 的字节数直接比更准。
    if (op !== 'save-background' && Buffer.byteLength(rawBody, 'utf8') > MAX_BODY) {
      return send(res, 413, {
        ok: false,
        error: { code: 'body_too_large', message: `请求体超过 ${MAX_BODY} 字节（${op} 不允许大 body）` },
      })
    }
    if (op === 'ping') {
      return send(res, 200, { ok: true, data: { version }, text: 'pong' })
    }
    // P6：健康与日志接口不把绝对路径（含用户名）回给面板，改为 basename 或占位。
    const hidePath = (p) => (typeof p === 'string' && p ? path.basename(p) : '(未提供)')
    // 面板自检：后端到底挂没挂、挂在哪个 route、CLI 与目录在哪，一次问清。
    if (op === 'health') {
      const info = typeof health === 'function' ? health() : { version }
      return send(res, 200, {
        ok: true,
        exitCode: 0,
        data: {
          version,
          route: info && info.route,
          cliPath: hidePath(info && info.cliPath),
          stateDir: hidePath(info && info.stateDir),
          articleDir: hidePath(info && info.articleDir),
          config: info && info.config ? info.config : { timeoutMs: 0 },
          // W3②：密钥明文存于 <stateDir>/config.json —— 写配置的唯一权威是 CLI，
          // 插件侧若自己加密会分裂成「面板改了 CLI 读不到」。既然只能明文，
          // 就必须让面板看得见这句风险提示，否则用户排障时会把整个目录打包发出去。
          // 路径仍按 P6 只回文件名/目录名，不回含用户名的绝对路径。
          configFile: hidePath(path.join(String(stateDir || ''), 'config.json')),
          configNotice: `密钥（appid / secret / imageKeys）以明文存放在 ${hidePath(stateDir)} 目录下的 config.json，请勿共享该目录`,
          // N6：底图数量要让面板看得见——只在自己上传时才清理是用户看不见的，
          // 设置页可以据此提示「累积了多少张底图、要不要清」。读不到给 null，不静默成 0。
          bgCount: (() => {
            try {
              // F2：与裁剪共用 BG_FILE_RE —— 计数口径与清理口径必须字面一致，
              // 否则「看得见 21 个、却永远清不掉第 21 个」。
              return fs.readdirSync(articleDir).filter((name) => BG_FILE_RE.test(name)).length
            } catch {
              return null
            }
          })(),
          ops: UI_OPERATIONS,
        },
        text: `后端在线 · v${version} · ${(info && info.route) || ROUTE} · 密钥明文存于 ${hidePath(stateDir)}/config.json，请勿共享该目录`,
      })
    }
    // 事后复盘：面板里直接看最近日志，不用再去翻目录。
    if (op === 'logs') {
      const lines = typeof logTail === 'function' ? logTail(Number((body.params || {}).lines) || 20) : []
      return send(res, 200, {
        ok: true,
        exitCode: 0,
        data: { lines, file: typeof logFile === 'function' ? hidePath(logFile()) : '' },
        text: lines.length ? lines.join('\n') : '（日志为空）',
      })
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

      // N3③：清除本插件日志数据（面板「清除本插件数据」）。
      // 删除动作在宿主侧实现（clearData 回调）；拿不到实现时也要给人话，不能静默。
      if (spec.clearData) {
        if (typeof clearData !== 'function') {
          // 失败三段式在**顶层**再给一份（error/code/hint）：面板的 runAction 按顶层读，
          // data.error 只是详情副本，两个都给才不会「看得见 ok:false、看不见原因」。
          const hint = '插件版本不匹配：重装 @local/wxmp 或重启 DSH 后重试'
          return send(res, 200, {
            ok: false,
            exitCode: 1,
            error: '宿主没有提供清除数据的实现',
            code: 'clear_unavailable',
            hint,
            data: {
              error: { code: 'clear_unavailable', message: '宿主没有提供清除数据的实现' },
              hint,
            },
            text: 'clear_unavailable: 宿主没有提供清除数据的实现（重装插件或重启 DSH 后重试）',
          })
        }
        let cleared
        try {
          cleared = clearData()
        } catch (error) {
          cleared = { ok: false, removed: [], failed: [message(error)] }
        }
        const done = !(cleared && cleared.ok === false)
        const failedText = cleared && cleared.failed ? cleared.failed.join('；') : '未知原因'
        return send(res, 200, {
          ok: done,
          exitCode: done ? 0 : 1,
          // 部分失败也要看得见：删失败多半是文件被占用，用户需要知道「哪些没删掉」。
          ...(done ? {} : { error: failedText, code: 'clear_partial', hint: '停掉正在使用日志的进程后重试；配置与文章未受影响' }),
          data: cleared,
          text: done
            ? `已清除 ${(cleared && cleared.removed ? cleared.removed.length : 0)} 项日志数据`
            : `清除未完成：${failedText}`,
        })
      }

      // task-8：删除本地文章（只 .md，路径收敛在文章目录内）。
      // 这是本插件唯一不可逆的本地写操作，所以判定顺序按「越早越便宜、越早越安全」排：
      // 缺参 → 路径收敛（含 realpath，拦软链）→ statSync 存在与类型 → 才 unlink。
      // 任何一步不过都原样返回三段式失败，**绝不在判定不全时动 unlink**。
      // 不假装走 CLI：CLI 没有 article delete（见 buildUiArgv 的注释）。
      if (spec.articleDelete) {
        // task-11：判定链**只有一份**——面板路径与模型路径（index.js 的 article_delete）
        // 都调 deleteArticleFile，两条路径的返回结构与错误码天然一致。
        // 对外契约不变：失败仍给顶层 { ok:false, error, code, hint }，成功仍只回 basename。
        return send(res, 200, deleteArticleFile(articleDir, (body.params || {}).file, { logLocalOp, op }))
      }

      // 1.8.1：快捷打开（📄 打开文件 / 📂 所在文件夹）。
      // 判定链与删除同一条（resolveInsideArticleDir + realpath），打开动作交给
      // openArticleFile 的注入实现——面板进程只 fire-and-forget，不等待 shell 返回。
      if (spec.openArticle) {
        return send(
          res,
          200,
          openArticleFile(articleDir, (body.params || {}).file, {
            what: spec.openArticle.what,
            logLocalOp,
            op,
          }),
        )
      }

      // 清空所有图片 key：通过 CLI 逐家删除（- 表示删除）。
      // 不自己直接改 config.json：写配置的唯一权威是 CLI，
      // 面板绕过它会出现"面板改了但 CLI 看不到"的分裂状态。
      if (spec.clearImageKeys) {
        const providers = Array.isArray(body.params && body.params.providers)
          ? body.params.providers
          : DIRECT_IMAGE_PROVIDER_IDS
        const results = []
        for (const id of providers) {
          const one = await runCli(['config', 'set', '--image-key', String(id), '--value', '-'])
          results.push({ provider: id, ok: Boolean(one && one.ok) })
        }
        return send(res, 200, {
          ok: true,
          exitCode: 0,
          data: { results, removed: results.filter((r) => r.ok).map((r) => r.provider) },
          text: `已清空 ${results.filter((r) => r.ok).length} 家的 key`,
        })
      }

      // 面板上传封面底图：base64 落盘到文章目录，返回文件名。
      // 收敛点：类型白名单 + 尺寸上限 + 文件名净化 + 必须落在文章目录内。
      if (spec.needsBackground) {
        const p = body.params || {}
        const mime = String(p.mime || '').toLowerCase()
        const EXT_BY_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }
        const ext = EXT_BY_MIME[mime]
        if (!ext) throw Object.assign(new Error(`不支持的图片类型：${mime || '(空)'}（只收 png / jpeg / webp）`), { code: 'bg_bad_type' })
        const raw = String(p.content || '')
        if (!raw) throw Object.assign(new Error('图片内容为空'), { code: 'bg_empty' })
        const buffer = Buffer.from(raw, 'base64')
        if (!buffer.length) throw Object.assign(new Error('图片 base64 解码后为空'), { code: 'bg_empty' })
        const MAX_BG = 12 * 1024 * 1024
        if (buffer.length > MAX_BG) {
          throw Object.assign(new Error(`底图 ${Math.round(buffer.length / 1048576)} MB 超过 12 MB`), { code: 'bg_too_large' })
        }
        // 文件名净化：只留安全字符，且用固定前缀避免与文章封面撞名
        const base = path.basename(String(p.name || 'bg'), path.extname(String(p.name || '')))
        const safe = base.replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 40) || 'bg'
        const outName = `bg-${safe}-${Date.now()}${ext}`
        const dir = path.resolve(articleDir)
        const outPath = path.join(dir, outName)
        fs.writeFileSync(outPath, buffer)

        // ── N6：底图会随每次上传累积（每个 ≤12MB，落在 articleDir 里永不回收） ──
        // 只保留最近 KEEP_BG 个：全删不行 —— 其它文章的 front matter 可能还引用旧底图，
        // 删掉会把别人的封面变成空白框。清理失败一律带回面板，不静默吞掉。
        const KEEP_BG = 20
        const pruned = []
        const pruneFailed = []
        let bgBefore = 0
        let bgTotal = 0
        try {
          const entries = fs
            .readdirSync(dir)
            // F2：裁剪口径与 health.bgCount 共用 BG_FILE_RE（原来这里漏了 gif）
            .filter((n) => BG_FILE_RE.test(n))
            .map((n) => {
              try {
                return { name: n, mtimeMs: fs.statSync(path.join(dir, n)).mtimeMs }
              } catch {
                return null
              }
            })
            .filter(Boolean)
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
          bgBefore = entries.length
          for (const item of entries.slice(KEEP_BG)) {
            try {
              fs.rmSync(path.join(dir, item.name), { force: true })
              pruned.push(item.name)
            } catch (error) {
              pruneFailed.push(`${item.name}: ${message(error)}`)
            }
          }
          // F1：bgTotal 取的是**清理后**的真实剩余数。
          // 原来写 `bgTotal = entries.length`（清之前的 26），文案却说「保留最近 20 个」，
          // 同一句回执里两个数字互相矛盾。失败的删除仍在盘上，所以只减成功数。
          bgTotal = bgBefore - pruned.length
        } catch (error) {
          pruneFailed.push(message(error))
        }

        return send(res, 200, {
          ok: true,
          exitCode: 0,
          // N5：不回绝对路径（含用户名）给面板——P6 对 health/logs 做过同样处理，这里是同型残留
          data: { name: outName, path: hidePath(outPath), bytes: buffer.length, mime, bgBefore, bgTotal, pruned, pruneFailed },
          text:
            `底图已保存：${outName}（${Math.round(buffer.length / 1024)} KB）` +
            (pruned.length
              ? `；已清理 ${pruned.length} 个旧底图（清理前 ${bgBefore} 个 → 保留最近 ${KEEP_BG} 个，现共 ${bgTotal} 个）`
              : '') +
            (pruneFailed.length ? `；旧底图清理失败：${pruneFailed.join('；')}` : ''),
        })
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
          // N5：同 health/logs —— 只回文件名，不回含用户名的绝对路径
          data: { file: hidePath(filePath), bytes: Buffer.byteLength(content, 'utf8') },
          text: '已保存',
        })
      }

      const argv = spec.argv.map((item) => (item === '__FILE__' ? filePath : item))
      const forward = spec.needFile ? argv : spec.argv

      // 面板导入预设：把上传内容落成临时文件再交给 CLI（CLI 只认路径）。
      // 临时文件限定在 stateDir/tmp 内，用完立刻删——不留垃圾也不越界。
      if (spec.needsPresetFile) {
        const content = String((body.params || {}).content ?? '')
        if (!content.trim()) throw new Error('导入内容为空')
        if (content.length > 64 * 1024) throw new Error('预设文件超过 64 KB，明显不是预设')
        const tmpRoot = path.join(String(stateDir || ''), 'tmp')
        if (!stateDir) throw new Error('宿主未提供 stateDir，无法落临时文件')
        fs.mkdirSync(tmpRoot, { recursive: true })
        const tmpFile = path.join(tmpRoot, `preset-import-${process.pid}-${Date.now()}.json`)
        fs.writeFileSync(tmpFile, content, 'utf8')
        try {
          const args = spec.argv.map((item) => (item === '__PRESET_FILE__' ? tmpFile : item))
          return send(res, 200, await runCli(args))
        } finally {
          try {
            fs.unlinkSync(tmpFile)
          } catch {
            /* 删不掉不影响导入结果，下次启动也能被清理 */
          }
        }
      }

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
