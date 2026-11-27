/**
 * 文章清单（front matter）与文件定位。
 *
 * 一篇文章就是一个 Markdown 文件，开头可选 YAML 风格 front matter：
 *
 *   ---
 *   title: 标题（必填，≤32 字）
 *   author: 作者（≤16 字）
 *   digest: 摘要（≤120 字，不填自动截取正文前 120 字）
 *   cover: ./cover.png           封面图，本地路径或 http(s) URL
 *   sourceUrl: 阅读原文链接
 *   theme: default | dark | magazine
 *   comments: true                是否开启评论
 *   ---
 *
 *   有两个键是插件自己写回去的，手写没意义（写了也只在内容对得上时才认）：
 *   mediaId       草稿 id（draft create 写回）
 *   thumbMediaId  封面在微信侧的永久素材 id + coverHash（封面内容指纹）
 *                 两者配套使用：封面没变就不再 add_material，
 *                 否则每改一句正文推一次草稿，公众号后台就多一条永久素材。
 *
 *   正文...
 *
 * 只解析单层 `key: value`，够用且不会引入 YAML 依赖。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { articleDir } from './state.js'

export class ArticleError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ArticleError'
    this.code = code
  }
}

/** 解析 front matter，返回 {meta, body, bodyStartLine}。 */
export function parseFrontMatter(source) {
  const text = String(source ?? '').replace(/\r\n?/g, '\n')
  const match = /^\uFEFF?---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!match) return { meta: {}, body: text.replace(/^\uFEFF/, ''), bodyStartLine: 1 }

  const meta = {}
  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    let value = kv[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (value === 'true') meta[kv[1]] = true
    else if (value === 'false') meta[kv[1]] = false
    else meta[kv[1]] = value
  }
  const bodyStartLine = match[0].split('\n').length
  return { meta, body: text.slice(match[0].length), bodyStartLine }
}

/**
 * 找到文章文件。
 * `--file` 优先；否则在文章目录里找同名 `.md`（支持带不带扩展名）。
 */
export function resolveArticleFile(input) {
  const explicit = String(input || '').trim()
  if (explicit) {
    const candidates = [explicit, `${explicit}.md`, path.join(articleDir(), explicit), path.join(articleDir(), `${explicit}.md`)]
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) return path.resolve(candidate)
      } catch {
        /* 试下一个 */
      }
    }
    throw new ArticleError('article_not_found', `找不到文章文件：${explicit}`)
  }

  const dir = articleDir()
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (!files.length) {
    throw new ArticleError(
      'article_not_found',
      `文章目录里没有 .md 文件：${dir}\n先执行 wxmp article new --title "标题"`,
    )
  }
  return path.join(dir, files[0].name)
}

/** 读取并解析文章。 */
export function loadArticle(filePath) {
  const absolute = path.resolve(filePath)
  const source = fs.readFileSync(absolute, 'utf8')
  const { meta, body, bodyStartLine } = parseFrontMatter(source)
  const dir = path.dirname(absolute)
  const title = String(meta.title || '').trim()
  if (!title) {
    throw new ArticleError(
      'title_required',
      `文章缺少 title：在 ${path.basename(absolute)} 开头的 front matter 里写 title: <标题>`,
    )
  }
  return {
    path: absolute,
    dir,
    name: path.basename(absolute, path.extname(absolute)),
    source,
    meta,
    body,
    bodyStartLine,
    title,
    author: String(meta.author || '').trim(),
    digest: String(meta.digest || '').trim(),
    cover: String(meta.cover || '').trim(),
    sourceUrl: String(meta.sourceUrl || meta.source_url || '').trim(),
    theme: String(meta.theme || 'default').trim(),
    comments: meta.comments === true,
    mediaId: String(meta.mediaId || meta.media_id || '').trim(),
    thumbMediaId: String(meta.thumbMediaId || meta.thumb_media_id || '').trim(),
    coverHash: String(meta.coverHash || meta.cover_hash || '').trim(),
  }
}

/**
 * 文件内容指纹（sha1）。
 *
 * 用途只有一个：判断"封面还是不是上次上传的那一张"。封面通常一百多 KB，
 * 读完算一次哈希是毫秒级；换来的是一整类事故——每推一次草稿就在公众号后台
 * 多一条永久素材，而且永久素材**删不干净**（要逐条去后台删）。
 */
export function fileFingerprint(filePath) {
  const hash = crypto.createHash('sha1')
  hash.update(fs.readFileSync(filePath))
  return `sha1:${hash.digest('hex')}`
}

/** 绝对化封面/图片路径（相对于文章所在目录）。 */
export function resolveAssetPath(article, value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) return { kind: 'remote', value: raw }
  const candidates = [path.resolve(article.dir, raw), path.resolve(raw)]
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return { kind: 'local', value: candidate }
    } catch {
      /* 试下一个 */
    }
  }
  throw new ArticleError('asset_not_found', `找不到图片文件：${raw}`)
}

/**
 * 把 front matter 的改动写回文件（更新 mediaId / cover 之类）。
 *
 * 保留值为空的键（写成 `key:`）：旧实现会把 `digest:` / `sourceUrl:` 这类空行整条删掉，
 * 于是每跑一次 draft create，用户文件就被悄悄改一次版式。
 */
export function patchFrontMatter(filePath, patch) {
  const source = fs.readFileSync(filePath, 'utf8')
  const { meta, body } = parseFrontMatter(source)
  const merged = { ...meta, ...patch }
  const block = Object.entries(merged)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      if (value === '') return `${key}:`
      return `${key}: ${typeof value === 'string' && value.includes(':') ? `"${value}"` : value}`
    })
    .join('\n')
  const next = `---\n${block}\n---\n${body}`
  fs.writeFileSync(filePath, next, 'utf8')
  return next
}

/** 新建文章模板（含示例正文，方便直接跑通链路）。 */
export function newArticleTemplate({ title, author = '', theme = 'default', cover = '' }) {
  const meta = [
    `title: ${title}`,
    author ? `author: ${author}` : '',
    'digest: ',
    cover ? `cover: ${cover}` : 'cover: ',
    'sourceUrl: ',
    `theme: ${theme}`,
    'comments: false',
  ]
    .filter(Boolean)
    .join('\n')
  return `---
${meta}
---

${title}：一句话说清这篇要讲什么。

## 为什么现在要聊这个

把背景交代清楚：读者为什么关心、现在的做法有什么问题。

## 拆开看

- 第一点：结论 + 一句证据
- 第二点：结论 + 一句证据
- 第三点：结论 + 一句证据

> 引用一段能撑住观点的原文或数据。

## 怎么做

1. 先做最小验证，拿到可复现的结果
2. 再把流程固化成脚本或清单
3. 最后补上验证与回滚

**收尾一句**：读者看完应该能直接动手做什么。

\`\`\`js
// 代码块也可以，微信正文里会渲染成浅色底
console.log('hello wxmp')
\`\`\`
`
}

/** 生成安全的文件名（保留中文）。 */
export function safeFileName(title) {
  const base = String(title || '')
    .trim()
    // 半角非法字符：Windows 文件名禁用
    .replace(/[\\/:*?"<>|]/g, '')
    // 全角标点在 Windows 上合法，但会让命令行引用、git 显示、跨工具传递都变麻烦，
    // 而且从公众号标题直接来时最常见的正是 ：和 ？——统一换成空格更稳。
    .replace(/[：？！，。；、“”‘’（）【】《》…—]/g, ' ')
    .replace(/\s+/g, '-')
    // 连着多个短横线压成一个（标题里原有标点被换成空格后可能连出 --- ）
    .replace(/-{2,}/g, '-')
    // 首尾的短横线没有意义
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    // 截断后可能又出现尾部短横线
    .replace(/-+$/g, '')
  return base || `article-${Date.now()}`
}
