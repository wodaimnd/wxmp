/**
 * 全部命令。
 *
 * 命令族：
 *   config    凭据管理（set / show / clear）
 *   article   本地文章（new / list / show / check / preview）
 *   cover     封面生成
 *   draft     草稿箱（create / list / get / update / delete / count）
 *   publish   发布（submit / status / list / delete / wait）
 *   doctor    环境与凭据自检
 *
 * 安全默认：publish submit 需要 --yes 才真正提交；否则只做 dry-run 打印将要发生的事。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { WechatClient, WechatApiError } from './wechat.js'
import {
  ArticleError,
  fileFingerprint,
  loadArticle,
  newArticleTemplate,
  parseFrontMatter,
  patchFrontMatter,
  resolveArticleFile,
  resolveAssetPath,
  safeFileName,
} from './article.js'
import {
  makeDigest,
  outline,
  parseMarkdown,
  plainText,
  renderHtml,
  stats,
  THEMES,
} from './markdown.js'
import { ARTICLE_TEMPLATE_HELP } from './help.js'
import { renderCover, listThemes } from '../tools/cover.js'
import { composeWithBackground } from '../tools/cover-composite.js'
import { planCover, normalizeCoverSize, formatCoverSize } from '../tools/cover-layout.js'
import { generateBackgroundForCover, describeImageProviders } from '../tools/cover-imagegen.js'
import { IMAGE_PROVIDER_IDS } from '../lib/absorbed/wewrite-imagegen.js'
import { extractArticle, buildMarkdownFile } from '../lib/absorbed/wechat-extractor.js'
import { wrapPreview, toFileUrl } from './preview.js'
import { reviewArticle, formatReview, THRESHOLDS, collectStructure } from './review.js'
import { buildTitleBrief, buildTitleCandidates, scoreTitleCandidate } from './title-lab.js'
import { FORMS, buildSkeleton, describeSkeleton, detectForm } from './outline-lab.js'
import { buildWritingBrief } from './writing-brief.js'
import { listLibraryImages } from './material-library.js'
import { applyInsertions, planImageInsertions } from './image-planner.js'
import { buildNamingGuide, validateName } from './naming-guide.js'
import {
  THRESHOLD_SPEC,
  WEIGHT_SPEC,
  exportPreset,
  importPreset,
  safePresetId,
  writePresetDir,
  removePresetDir,
} from './presets.js'
import { resolvePreset, listPresets, loadPreset, savePresetSelection, currentPresetId, ensurePresets, presetsDir, composePresetPrompt } from './preset-resolve.js'
import {
  articleDir,
  configPath,
  homeDir,
  maskSecret,
  readJson,
  requireCredentials,
  resolveCredentials,
  saveConfig,
  tokenPath,
} from './state.js'
import { flagNumber, flagString, flagBool } from './args.js'
import {
  AUTHOR_MAX,
  CONTENT_MAX_BYTES,
  CONTENT_MAX_CHARS,
  CliError,
  DIGEST_MAX,
  TITLE_MAX,
  compactJson,
  failure,
  humanBytes,
  humanTime,
  ok,
  rule,
  truncate,
} from './output.js'

/* ------------------------------------------------------------------ */
/* 通用                                                                */
/* ------------------------------------------------------------------ */

function clientFromOptions(flags) {
  const creds = requireCredentials()
  const baseUrl = flagString(flags, 'base-url', '') || undefined
  return {
    client: WechatClient.fromCredentials(creds, {
      baseUrl,
      verbose: flagBool(flags, 'verbose'),
    }),
    creds,
  }
}

function wrapError(error) {
  if (error instanceof CliError) return error
  if (error instanceof ArticleError) return new CliError(error.code, error.message, 1)
  if (error instanceof WechatApiError) {
    const hint = apiHint(error.errcode)
    return new CliError(
      `wechat_${error.errcode}`,
      `${error.message}${hint ? `\n修复：${hint}` : ''}`,
      1,
      { errcode: error.errcode, errmsg: error.errmsg },
    )
  }
  if (error && error.code === 'credentials_missing') {
    return new CliError('credentials_missing', `${error.message}\n${error.hint || ''}`, 1)
  }
  return error
}

/** 常见错误码给出可操作建议。 */
export function apiHint(errcode) {
  const hints = {
    40001: 'AppSecret 不对或 token 已被刷新；执行 `wxmp config set --appid ... --secret ...` 后重试',
    40125: 'AppSecret 无效，检查是否有空格或大小写差异',
    40013: 'AppID 无效，检查是否与公众号后台一致',
    40164: '调用 IP 不在白名单：公众平台 → 开发 → 基本配置 → IP 白名单，把本机出口 IP 加进去',
    48001: '接口未授权：个人/未认证号没有 freepublish 权限。草稿已经进了草稿箱，打开 https://mp.weixin.qq.com 在「草稿箱」里手动群发；只有认证服务号能用 API 直发',
    45009: '当天接口调用额度用尽，明天再试',
    45011: '调用太频繁，等一分钟再试',
    53404: '账号被限制带货能力，删掉商品卡片重试',
    53503: '草稿未通过发布检查：通常是标题/正文超长、图片非 mmbiz 域名或缺封面',
    53504: '需要在公众平台官网手动使用该草稿',
    53505: '需要先在官网手动保存一次再发表',
    40007: '封面 thumb_media_id 无效或已过期；另外草稿没传封面也会报这个码（微信把「缺参数」也报成 invalid media_id）。先 wxmp cover --file <文章> 重建封面再试',
    88000: '没有评论权限：把 comments 设为 false',
  }
  return hints[errcode] || ''
}

/** 从 flags 里取文章文件（--file / 位置参数）。positional 已不含命令名。 */
function articleFileFrom(flags, positional, index = 0) {
  const explicit = flagString(flags, 'file', '') || positional[index] || ''
  return resolveArticleFile(explicit)
}

/** 渲染一篇文章（不联网）：返回 AST、HTML、统计。 */
function renderArticle(article) {
  const nodes = parseMarkdown(article.body)
  const { html, images } = renderHtml(nodes, { theme: article.theme })
  const digest = article.digest || makeDigest(nodes, DIGEST_MAX)
  return {
    nodes,
    html,
    images,
    digest,
    stats: stats(nodes, html),
    outline: outline(nodes),
    plain: plainText(nodes),
  }
}

/** 校验文章是否满足微信的硬限制。 */
export function validateArticle(article, rendered) {
  const issues = []
  const warnings = []

  if (!article.title) issues.push({ level: 'error', field: 'title', message: '缺少标题' })
  else if (article.title.length > TITLE_MAX)
    issues.push({ level: 'error', field: 'title', message: `标题 ${article.title.length} 字，上限 ${TITLE_MAX}` })

  if (article.author && article.author.length > AUTHOR_MAX)
    issues.push({ level: 'error', field: 'author', message: `作者 ${article.author.length} 字，上限 ${AUTHOR_MAX}` })

  const digestLength = String(rendered.digest || '').length
  if (digestLength > DIGEST_MAX)
    issues.push({ level: 'error', field: 'digest', message: `摘要 ${digestLength} 字，上限 ${DIGEST_MAX}` })

  const chars = rendered.html.length
  if (chars >= CONTENT_MAX_CHARS)
    issues.push({ level: 'error', field: 'content', message: `正文 ${chars} 字符，上限 ${CONTENT_MAX_CHARS - 1}` })
  const bytes = Buffer.byteLength(rendered.html, 'utf8')
  if (bytes >= CONTENT_MAX_BYTES)
    issues.push({ level: 'error', field: 'content', message: `正文 ${humanBytes(bytes)}，上限 1 MB` })

  if (!article.cover) warnings.push({ level: 'warning', field: 'cover', message: '没有封面（cover），草稿会缺首图' })
  if (rendered.images.length) {
    warnings.push({
      level: 'warning',
      field: 'images',
      message: `正文有 ${rendered.images.length} 张图片，发布前必须上传（微信会过滤外链）`,
    })
  }
  if (article.cover && /^https?:\/\//i.test(article.cover)) {
    warnings.push({
      level: 'warning',
      field: 'cover',
      message: '封面是远程 URL，会先下载再上传成永久素材',
    })
  }
  if (!article.sourceUrl) warnings.push({ level: 'info', field: 'sourceUrl', message: '没有「阅读原文」链接' })

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    limits: {
      title: [article.title.length, TITLE_MAX],
      author: [article.author.length, AUTHOR_MAX],
      digest: [digestLength, DIGEST_MAX],
      contentChars: [chars, CONTENT_MAX_CHARS - 1],
      contentBytes: [bytes, CONTENT_MAX_BYTES],
    },
  }
}

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */

async function configCmd(positional, flags) {
  // positional 已经不含命令名：`wxmp config set ...` → positional = ['set']
  const sub = positional[0] || 'show'

  if (sub === 'set') {
    // AI 配图 key：--image-key <供应商> <key>
    // 与公众号凭据分开走，因为它们是两类完全不同的东西（一个发文，一个出图），
    // 混在一个 set 里会让"只想配图"的人被迫重新填一遍 appid/secret。
    const imageKeyProvider = flagString(flags, 'image-key', '')
    if (imageKeyProvider) {
      const key = flagString(flags, 'value', '') || positional[1] || positional[2] || ''
      const id = imageKeyProvider.toLowerCase()
      if (!IMAGE_PROVIDER_IDS.includes(id) && !flagBool(flags, 'custom')) {
        throw new CliError(
          'provider_unknown',
          `未知图片供应商 ${id}，可用：${IMAGE_PROVIDER_IDS.join(' / ')}（自定义中转站加 --custom）`,
          2,
        )
      }
      if (!key) {
        throw new CliError('args_required', `用法：wxmp config set --image-key ${id} --value <key>`, 2)
      }
      // 空值 = 删除这一家的 key
      saveConfig({ imageKeys: { [id]: key === '-' ? '' : key } })
      const after = describeImageProviders()
      return ok(
        { provider: id, imageProviders: after },
        key === '-'
          ? `已移除 ${id} 的 key。当前可用：${after.providers.map((p) => p.providerId).join(' / ') || '无'}`
          : `已保存 ${id} 的 key（${maskSecret(key)}）。当前可用：${after.providers.map((p) => p.providerId).join(' / ')}`,
      )
    }
    // 自定义供应商（中转站）：需要 baseUrl + model
    const customId = flagString(flags, 'image-provider', '')
    if (customId) {
      const baseUrl = flagString(flags, 'base-url', '')
      const model = flagString(flags, 'model', '')
      if (!baseUrl) {
        throw new CliError('args_required', `用法：wxmp config set --image-provider ${customId} --base-url <url> [--model <name>]`, 2)
      }
      const saved = loadConfig()
      const list = Array.isArray(saved.imageProviders) ? saved.imageProviders.slice() : []
      const existing = list.findIndex((item) => (typeof item === 'string' ? item : item.providerId) === customId)
      const entry = {
        providerId: customId,
        custom: { baseUrl },
        ...(model ? { model } : {}),
      }
      // 内置供应商只需改 baseUrl（走代理时用），不需要 custom 声明
      const payload = IMAGE_PROVIDER_IDS.includes(customId)
        ? { providerId: customId, baseUrl, ...(model ? { model } : {}) }
        : entry
      if (existing >= 0) list[existing] = payload
      else list.push(payload)
      saveConfig({ imageProviders: list })
      return ok(
        { provider: customId, baseUrl, imageProviders: describeImageProviders() },
        `已设置 ${customId} 的接入地址：${baseUrl}${model ? `（模型 ${model}）` : ''}`,
      )
    }
    const appid = flagString(flags, 'appid', '') || positional[1] || ''
    const secret = flagString(flags, 'secret', '') || positional[2] || ''
    if (!appid || !secret) {
      throw new CliError(
        'args_required',
        '用法：wxmp config set --appid <AppID> --secret <AppSecret>\n      wxmp config set --image-key <供应商> --value <key>',
        2,
      )
    }
    if (!/^wx[0-9a-f]{16}$/i.test(appid)) {
      throw new CliError('appid_invalid', `AppID 格式不对（应为 wx 开头 18 位）：${maskSecret(appid)}`, 2)
    }
    const saved = saveConfig({ appid, secret })
    return ok(
      { appid: saved.appid, secretMasked: maskSecret(saved.secret), path: configPath() },
      `已保存凭据\n  appid : ${saved.appid}\n  secret: ${maskSecret(saved.secret)}\n  路径  : ${configPath()}`,
    )
  }

  if (sub === 'clear') {
    saveConfig({ appid: '', secret: '' })
    try {
      fs.unlinkSync(tokenPath())
    } catch {
      /* 本来就没有 */
    }
    return ok({ cleared: true }, '已清除本地凭据与 token 缓存')
  }

  const creds = resolveCredentials()
  const lines = [
    `配置目录: ${homeDir()}`,
    `配置文件: ${configPath()}`,
    `appid   : ${creds.appid || '(未配置)'}`,
    `secret  : ${creds.secret ? maskSecret(creds.secret) : '(未配置)'}`,
    `来源    : ${creds.source}`,
    `token缓存: ${fs.existsSync(tokenPath()) ? '有' : '无'}`,
  ]
  return ok(
    {
      appid: creds.appid,
      secretMasked: creds.secret ? maskSecret(creds.secret) : '',
      source: creds.source,
      configPath: configPath(),
      tokenCached: fs.existsSync(tokenPath()),
    },
    lines.join('\n'),
  )
}

/* ------------------------------------------------------------------ */
/* article                                                             */
/* ------------------------------------------------------------------ */

/**
 * 给导入的文章找一个不冲突的文件名。
 *
 * 为什么不像 article new 那样直接报「已存在」：
 * 导入是"收集素材"的场景，用户常常同一篇导两次（第一次觉得没抓全）。
 * 报错会打断批量流程；自动加 -2/-3 后缀既保留旧稿，也不丢新导入的。
 * 真正的覆盖危险来自"悄悄覆盖掉用户精心改过的稿子"，加后缀就避免了。
 */
function uniqueArticleName(dir, title) {
  const base = safeFileName(String(title || '未命名')).slice(0, 60) || '未命名'
  let name = `${base}.md`
  let counter = 2
  while (fs.existsSync(path.join(dir, name))) {
    name = `${base}-${counter}.md`
    counter += 1
    // 防御：不可能同时存在 1000 个同名文件；真到了就是标题有问题
    if (counter > 999) break
  }
  return name
}

/**
 * 保留 front matter 原文，只换正文。
 *
 * 为什么不用 `source.replace(body, next)`：
 * 磁盘上可能是 CRLF（Windows 编辑器、git autocrlf 都会产生），
 * 而 parseFrontMatter 返回的 body 是 LF —— 两者永远匹配不到，
 * 表现为"命令说已写入，文件其实没变"。这是踩过的坑。
 *
 * 所以按 `---` 分隔符定位 front matter 的结束位置，从那里开始整段替换。
 */
function rebuildWithNewBody(source, nextBody) {
  const text = String(source || '')
  // front matter 必须在文件开头（允许 BOM 与前置空白行）
  const match = /^(\uFEFF?\s*---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?)([\s\S]*)$/.exec(text)
  if (!match) return text // 没有 front matter：不动，交给调用方判断
  const frontMatter = match[1]
  // 统一成 LF 再写入 —— 一篇文章里混着 CRLF/LF 会让后续 diff 很难看
  return `${frontMatter}\n${String(nextBody || '').replace(/\r\n/g, '\n').replace(/^\n+/, '')}\n`
}

async function articleCmd(positional, flags) {
  const sub = positional[0] || 'show'

  /**
   * 从公众号链接导入文章。
   *
   *   wxmp article import <url>              导入单篇
   *   wxmp article import --list urls.txt    批量导入（一行一个 URL）
   *   wxmp import <url>                      等价简写
   *
   * 设计取舍：
   *   - 只接受 mp.weixin.qq.com（白名单在 extractor 里，不在命令行）——
   *     否则用户贴任意 URL 就能让插件访问内网。
   *   - 同名文件不覆盖，自动加 -2 / -3 后缀。导入是"收集素材"，
   *     悄悄覆盖掉之前精心改过的稿子是灾难。
   *   - 批量时单篇失败不中断，最后汇总报告：几篇成功、几篇失败、为什么失败。
   */
  if (sub === 'import') {
    const single = positional[1] || flagString(flags, 'url', '')
    const listFile = flagString(flags, 'list', '')
    if (!single && !listFile) {
      throw new CliError(
        'args_required',
        '用法：wxmp article import <url>\n      wxmp article import --list urls.txt（一行一个链接）',
        2,
      )
    }

    // 收集待导入的 URL 列表
    const targets = []
    if (single) targets.push(single)
    if (listFile) {
      const listPath = path.isAbsolute(listFile) ? listFile : path.resolve(process.cwd(), listFile)
      if (!fs.existsSync(listPath)) {
        throw new CliError('list_not_found', `找不到列表文件：${listPath}`, 2)
      }
      const content = fs.readFileSync(listPath, 'utf8')
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim()
        // 跳过空行与注释行（# 开头），方便用户在列表里写备注
        if (!trimmed || trimmed.startsWith('#')) continue
        targets.push(trimmed)
      }
    }
    if (!targets.length) {
      throw new CliError('args_required', '列表里没有可用的链接（空行和 # 注释会被跳过）', 2)
    }

    const dir = articleDir()
    const results = []
    let index = 0
    for (const target of targets) {
      index += 1
      if (targets.length > 1) process.stderr.write(`  [${index}/${targets.length}] 抓取中…\n`)
      try {
        const article = await extractArticle(target)
        const fileName = uniqueArticleName(dir, article.title)
        fs.writeFileSync(path.join(dir, fileName), buildMarkdownFile(article), 'utf8')
        results.push({
          ok: true,
          url: target,
          file: fileName,
          title: article.title,
          chars: article.charCount,
        })
      } catch (error) {
        // 单篇失败继续下一篇：批量导入最怕第一篇的 404 把整批中断
        results.push({
          ok: false,
          url: target,
          code: error && error.code ? error.code : 'unknown',
          error: error && error.message ? error.message : String(error),
        })
      }
    }

    const okList = results.filter((item) => item.ok)
    const failList = results.filter((item) => !item.ok)
    const lines = []
    if (okList.length) {
      lines.push(`已导入 ${okList.length} 篇：`)
      for (const item of okList) lines.push(`  · ${item.file}（${item.title}，${item.chars} 字）`)
    }
    if (failList.length) {
      lines.push('')
      lines.push(`${failList.length} 篇失败：`)
      for (const item of failList) lines.push(`  · ${item.url}\n    [${item.code}] ${item.error}`)
    }
    return ok({ total: results.length, imported: okList.length, failed: failList.length, results }, lines.join('\n'))
  }

  /**
   * 候选标题：解决"卡在起标题"这个真实痛点。
   *
   *   wxmp article titles --file <文章>            机械候选 + 任务书
   *   wxmp article titles --file <文章> --brief    只输出任务书（给 AI 用）
   *   wxmp article titles "标题A" "标题B" ...       给已有标题打分排序
   *
   * 设计取舍：wxmp 不内置 LLM，所以这里产出的是
   *   ① 机械候选（半成品起点，打破空白页）
   *   ② 结构化任务书（交给调用方生成真正的标题）
   * 面板上必须把这两者的区别说清楚，否则用户会误以为"AI 起标题就这水平"。
   */
  if (sub === 'titles' || sub === 'title') {
    const briefOnly = flagBool(flags, 'brief')
    const explicitFile = flagString(flags, 'file', '')
    // 判断"用户是想给标题打分"还是"想给文章起标题"：
    // 有 --file 一律按文件处理；否则看第 2 个参数像不像文件名。
    // 不能直接调 articleFileFrom —— 它会把纯标题当成文章名去找，报 article_not_found。
    const rest = positional.slice(1).filter(Boolean)
    const looksLikeFile = (text) => /\.md$/i.test(text) || /[\\/]/.test(text)
    const scoringMode = !explicitFile && rest.length > 0 && !looksLikeFile(rest[0])

    // 用法 3：给已有标题打分
    if (scoringMode) {
      const scored = rest.map((text) => scoreTitleCandidate(text)).sort((a, b) => b.score - a.score)
      return ok(
        { scored },
        [
          '标题评分（供参考，不替代人的判断）：',
          ...scored.map((item, index) => {
            const mark = index === 0 ? '★' : ' '
            return `${mark} ${item.score} 分  ${item.text}${item.issues.length ? `\n     问题：${item.issues.join('；')}` : ''}`
          }),
        ].join('\n'),
      )
    }

    const file = articleFileFrom(flags, positional, 1)

    if (!file) {
      throw new CliError(
        'args_required',
        '用法：wxmp article titles --file <文章>\n      wxmp article titles "标题A" "标题B"（给已有标题打分）',
        2,
      )
    }
    const article = loadArticle(file)
    const rendered = renderArticle(article)
    const info = collectStructure(rendered.nodes || [])

    const brief = buildTitleBrief(article, info, { count: 5 })
    if (briefOnly) {
      return ok({ brief, file: article.path }, brief)
    }

    const { material, candidates } = buildTitleCandidates(article, info, { count: 5 })
    const lines = [
      `当前标题：${article.title}（${article.title.length} 字）`,
      article.title.length > 22 ? '⚠ 超过 22 字，微信列表会截断' : '',
      '',
      '机械候选（半成品起点，需要你改；真正好的标题在下面的任务书里生成）：',
      ...candidates.map((item) => {
        const mark = item.usable ? '○' : '△'
        const note = item.notes.length ? `\n     ⚠ ${item.notes.join('；')}` : ''
        return `${mark} [${item.label}] ${item.text}${note}`
      }),
      '',
      `可复用的素材：主题词「${material.topic}」· 数字 ${material.number} · 结果「${material.result}」`,
      '',
      '─────────────────────────────',
      brief,
    ].filter((line) => line !== '')
    return ok({ file: article.path, current: article.title, material, candidates, brief }, lines.join('\n'))
  }

  /**
   * 素材库：直接读公众号后台的图片素材。
   *
   *   wxmp article library                 列出素材库（标注哪些能用）
   *   wxmp article library --usable        只看能当正文插图的
   *
   * 关键事实：微信 batchget_material 返回的 url 是可直接在正文里用的 mmbiz 链接，
   * 不需要下载再上传。
   */
  if (sub === 'library' || sub === 'assets') {
    // 校验单个文件名：wxmp article library --check "架构图-插件加载.png"
    const checkName = flagString(flags, 'check', '')
    if (checkName) {
      const result = validateName(checkName)
      const lines = result.ok
        ? [`✓ ${checkName} 符合规范（图类前缀：${result.prefix}）`]
        : [
            `✗ ${checkName} 不符合规范：`,
            ...result.issues.map((issue) => `  · ${issue}`),
            '',
            `建议改成：${result.suggestion}`,
          ]
      return ok({ name: checkName, ...result }, lines.join('\n'))
    }

    // 打印命名规范表：wxmp article library --guide
    if (flagBool(flags, 'guide')) {
      return ok({ guide: buildNamingGuide() }, buildNamingGuide())
    }

    // 给素材库里的图片批量检查命名：wxmp article library --audit
    if (flagBool(flags, 'audit')) {
      const lib = await listLibraryImages()
      const bad = lib.items
        .map((item) => ({ name: item.name, ...validateName(item.name) }))
        .filter((item) => !item.ok)
      if (!bad.length) {
        return ok({ bad: [] }, `素材库里 ${lib.total} 张图的命名都符合规范。`)
      }
      const lines = [
        `${bad.length} / ${lib.total} 张图的命名不符合规范（这些图无法参与语义匹配）：`,
        '',
      ]
      for (const item of bad.slice(0, 15)) {
        lines.push(`  · ${item.name}`)
        lines.push(`    ${item.issues[0]}`)
        if (item.suggestion) lines.push(`    → 建议：${item.suggestion}`)
      }
      if (bad.length > 15) lines.push(`  …还有 ${bad.length - 15} 张`)
      lines.push('')
      lines.push('完整规范：wxmp article library --guide')
      return ok({ total: lib.total, badCount: bad.length, bad }, lines.join('\n'))
    }

    const lib = await listLibraryImages({ onlyMeaningful: flagBool(flags, 'usable') })
    const usable = lib.items.filter((item) => item.meaningful && item.keywords.length && !item.coverLike)
    const lines = [
      `素材库图片：${lib.total} 张`,
      `可用于正文插图：${usable.length} 张（有语义名、非封面类）`,
      lib.untagged ? `无法匹配：${lib.untagged} 张（文件名无意义）` : '',
      '',
    ]
    if (usable.length) {
      lines.push('可插图的素材：')
      for (const item of usable) {
        lines.push(`  · ${item.name}`)
        lines.push(`    关键词 ${item.keywords.join(' / ')}  ·  ${item.url.slice(0, 60)}…`)
      }
    } else {
      lines.push('（没有可用于正文的素材——需要去公众号后台给图片改成能看出内容的文件名）')
    }
    if (lib.hint) {
      lines.push('')
      lines.push(`提示：${lib.hint}`)
    }
    return ok(
      { total: lib.total, untagged: lib.untagged, usable, items: lib.items },
      lines.filter((line) => line !== '').join('\n'),
    )
  }

  /**
   * 智能插图：从素材库选图，按内容语义给出插入位置。
   *
   *   wxmp article illustrate --file <文章>           只给建议
   *   wxmp article illustrate --file <文章> --apply   直接写进文章
   *
   * 默认只建议不改稿——插图会改变文章结构，必须让人看一眼。
   */
  if (sub === 'illustrate') {
    const file = articleFileFrom(flags, positional, 1)
    const article = loadArticle(file)
    const rendered = renderArticle(article)
    const info = collectStructure(rendered.nodes || [])
    const lib = await listLibraryImages()

    const plan = planImageInsertions(article, info, lib.items, {
      maxImages: flagNumber(flags, 'max', 0) || 4,
    })

    const lines = []
    if (plan.suggestions.length) {
      lines.push(`找到 ${plan.suggestions.length} 处可插图的位置：`)
      lines.push('')
      for (const item of plan.suggestions) {
        lines.push(`  · ${item.image}`)
        lines.push(`    位置：「${item.section}」第 ${item.afterParagraph + 1} 段之后`)
        lines.push(`    原因：${item.reason}（匹配分 ${item.hits}）`)
        lines.push(`    这一段：${item.afterText}…`)
        lines.push('')
      }
    } else {
      lines.push(plan.reason || '没有找到合适的插入位置。')
    }

    if (plan.skipped.length) {
      lines.push('未插入的素材：')
      for (const item of plan.skipped) lines.push(`  · ${item.image}：${item.reason}`)
      lines.push('')
    }

    if (lib.untagged) {
      lines.push(`提示：${lib.untagged} 张素材文件名无意义，无法参与匹配。`)
      lines.push('去公众号后台给它们改个能看出内容的文件名（如"架构图-插件加载"），匹配率会立刻提高。')
      lines.push('')
    }

    // 真正写进文章
    let applied = false
    if (flagBool(flags, 'apply') && plan.suggestions.length) {
      const before = fs.readFileSync(article.path, 'utf8')
      // ⚠ 不能用 source.replace(article.body, nextBody)：
      // 磁盘文件可能是 CRLF（Windows 编辑器写的），而 parseFrontMatter 返回的 body 是 LF，
      // 两者永远匹配不上 —— 曾导致"显示已写入但文件没变"。
      // 正确做法：拆出 front matter 原文，重新拼装。
      const nextBody = applyInsertions(article.body || '', plan.suggestions)
      const rebuilt = rebuildWithNewBody(before, nextBody)
      if (rebuilt === before) {
        throw new CliError(
          'apply_failed',
          '正文替换没有生效（文件可能是 CRLF 或 front matter 格式特殊）。没有写入，避免把文章改坏。',
          3,
        )
      }
      fs.writeFileSync(article.path, rebuilt, 'utf8')
      applied = true
      lines.push(`已写入文章：${article.path}`)
      lines.push('（图片用的是素材库的 mmbiz 直链，发布时不会被微信过滤）')
    } else if (plan.suggestions.length) {
      lines.push('上面只是建议。要直接写进文章，加 --apply 重跑。')
    }

    return ok(
      { file: article.path, suggestions: plan.suggestions, skipped: plan.skipped, applied, untagged: lib.untagged },
      lines.filter((line) => line !== '').join('\n'),
    )
  }

  /**
   * 写作任务书：把四步流程变成一张作业单。
   *
   *   wxmp article brief "主题"                            新写
   *   wxmp article brief "主题" --form tutorial --words 1200
   *   wxmp article brief --file <文章>                     改稿（带上现状）
   *
   * 不做生成、不联网、不调 LLM —— 只把"该搜什么、按什么结构写、
   * 标题往哪个方向起、写完自查什么"定好，交给调用方执行。
   *
   * 1.8.0 起任务书带「风格要求」节：默认用当前生效的预设，--preset 指定别的。
   * 预设是写作提示词（先教怎么写），打分只是写完后的复核——所以风格在写之前给，
   * 而不是等 review 扣分了再回头补。
   */
  if (sub === 'brief') {
    const fileFlag = flagString(flags, 'file', '')
    let article = null
    let info = null
    if (fileFlag) {
      const resolved = articleFileFrom(flags, positional, 1)
      article = loadArticle(resolved)
      const rendered = renderArticle(article)
      info = collectStructure(rendered.nodes || [])
    }

    const topic = flagString(flags, 'topic', '') || positional[1] || (article ? article.title : '')
    if (!topic) {
      throw new CliError(
        'args_required',
        '用法：wxmp article brief "主题"\n      wxmp article brief --file <文章>（改稿）',
        2,
      )
    }

    // 改稿时用检测出的文体；新写时用 --form 或按主题猜
    const detected = article ? detectForm(article, article.body || '') : null
    const formFlag = flagString(flags, 'form', '')
    const form = formFlag || (detected && detected.confident ? detected.form : undefined)

    // 预设解析一次，风格节与改稿现状共用同一个结果（两次 resolve 理论上同源，
    // 但显式 --preset 拼写错误时 notes 只会提示一次，别让两处各说各话）
    const chosenPreset = resolvePreset(flagString(flags, 'preset', ''))
    const promptParts = composePresetPrompt(chosenPreset.preset)
    const styleSection = [
      `## 风格要求（预设：${promptParts.name}）`,
      '',
      promptParts.style || '这个预设还没有风格提示词。先按下面的节奏参考写；想补风格就往预设目录里加 style.md。',
      '',
      '节奏参考（同一套标准的打分阈值，写作时当节奏，不是扣分表）：',
      ...promptParts.rhythmLines,
    ].join('\n')

    const brief = buildWritingBrief({
      topic,
      form,
      audience: flagString(flags, 'audience', ''),
      angle: flagString(flags, 'angle', ''),
      words: flagNumber(flags, 'words', 0),
      file: article ? article.path : '',
      info,
      styleSection,
    })

    // 改稿场景：附上当前体检结论，让任务书针对真问题而不是泛泛而谈
    let currentState = ''
    if (article) {
      const review = reviewArticle(article, renderArticle(article), chosenPreset.preset)
      const issues = review.findings.filter((item) => item.level !== 'ok')
      currentState = [
        '',
        '',
        '─────────────────────────────',
        '## 这篇文章的现状',
        '',
        `体检：${review.grade} · ${review.score}/100${review.pass ? '' : '（未达标）'}`,
        issues.length ? `待改 ${issues.length} 处：` : '没有明显问题',
        ...issues.slice(0, 8).map((item) => `- [${item.code}] ${item.message}`),
        issues.length > 8 ? `- …还有 ${issues.length - 8} 处，跑 review 看全部` : '',
      ]
        .filter((line) => line !== '')
        .join('\n')
    }

    return ok(
      {
        topic: brief.topic,
        form: brief.form,
        formLabel: brief.formLabel,
        words: brief.words,
        markdown: brief.markdown,
        preset: { id: chosenPreset.preset.id, name: chosenPreset.preset.name, hasStyle: promptParts.hasStyle },
        file: article ? article.path : null,
      },
      brief.markdown + currentState,
    )
  }

  /**
   * 结构骨架：告诉作者"整体该有哪些块"。
   *
   *   wxmp article outline --file <文章>                 自动识别文体并对比
   *   wxmp article outline --file <文章> --form tutorial  指定文体
   *   wxmp article outline --form case                    只看某个文体的骨架
   *
   * 这不是"替你写"，而是把 forms.md 的三种文体组织方式摆出来，
   * 并把已有小标题对上去——作者卡住的常见原因不是不会写句子，
   * 而是不知道整体该有哪些块。
   */
  if (sub === 'outline') {
    const formFlag = flagString(flags, 'form', '')
    const file = flagString(flags, 'file', '') || (positional[1] || '')

    let article = null
    let info = null
    let detected = null
    if (file) {
      const resolved = articleFileFrom(flags, positional, 1)
      article = loadArticle(resolved)
      const rendered = renderArticle(article)
      info = collectStructure(rendered.nodes || [])
      detected = detectForm(article, article.body || '')
    }

    const form = formFlag || (detected ? detected.form : '')
    if (!form) {
      throw new CliError(
        'args_required',
        `用法：wxmp article outline --file <文章>\n      或 wxmp article outline --form <${Object.keys(FORMS).join('|')}>`,
        2,
      )
    }
    if (!FORMS[form]) {
      throw new CliError('form_unknown', `未知文体 ${form}，可用：${Object.keys(FORMS).join(' / ')}`, 2)
    }

    const skeleton = buildSkeleton(form, {
      headings: info ? info.headings : [],
      text: article ? article.body : '',
    })

    const lines = []
    if (detected) {
      lines.push(`检测到的文体：${FORMS[detected.form].label}${detected.confident ? '' : '（信号较少，可用 --form 指定）'}`)
      if (!formFlag && detected.form !== form) lines.push(`实际使用：${FORMS[form].label}`)
    }
    lines.push(describeSkeleton(skeleton))
    lines.push('')
    lines.push('─────────────────────────────')
    lines.push(skeleton.markdown)

    return ok(
      {
        form,
        detected: detected ? detected.form : null,
        sections: skeleton.sections,
        missing: skeleton.missing,
        markdown: skeleton.markdown,
      },
      lines.join('\n'),
    )
  }

  /**
   * 把选定的标题写回 front matter。
   * 单独一个子命令，是因为"选中哪个标题"必须由人决定，不能自动改。
   */
  if (sub === 'set-title') {
    /* 写命令必须写明目标文件。
     * resolveArticleFile('') 会**回落到最近改动的那篇**（那是给 article show /
     * review 省事的），但用在写命令上就成了隐患：`set-title --title "x"` 少写一个
     * --file，就会把用户最近在改的稿子改了名，而且它不会报错。
     * 这里显式要求 --file，不接受回落。 */
    if (!flagString(flags, 'file', '') && !positional[1]) {
      throw new CliError('args_required', '用法：wxmp article set-title --file <文章> --title "新标题"\n（写命令必须写明 --file，不会默认改最近一篇）', 2)
    }
    const file = articleFileFrom(flags, positional, 1)
    const title = flagString(flags, 'title', '') || positional[2] || ''
    if (!file) throw new CliError('args_required', '用法：wxmp article set-title --file <文章> --title "新标题"', 2)
    if (!title.trim()) throw new CliError('title_required', '标题不能为空', 2)
    if (title.length > TITLE_MAX) {
      throw new CliError('title_too_long', `标题 ${title.length} 字，微信上限 ${TITLE_MAX}`, 2)
    }
    const article = loadArticle(file)
    const scored = scoreTitleCandidate(title)
    patchFrontMatter(article.path, { title: title.trim() })
    return ok(
      { file: article.path, before: article.title, after: title.trim(), scored },
      [
        `标题已更新：${article.title}`,
        `         → ${title.trim()}`,
        '',
        `自评：${scored.score} 分${scored.issues.length ? `\n问题：${scored.issues.join('；')}` : ''}`,
      ].join('\n'),
    )
  }

  /**
   * 改作者名 —— 这条补的是个真实缺口：
   * `article new --author` 只在建文章时能传一次，建完之后 front matter 里的
   * `author` 就再没有入口能改了。而作者名会被三处直接读走：封面副标题
   * （commands.js coverCmd 里 `|| article.author`）、预览页的 byline、
   * 面板文章详情的作者行。用户想换名字，只能拿编辑器去改 .md —— 那不该是唯一办法。
   *
   * `--author` 传空字符串 = **清空**（front matter 里写成 `author:`），三处就都不再出现它。
   */
  if (sub === 'set-author') {
    // 同 set-title：写命令必须点明是哪一篇，绝不回落到"最近改过的那篇"。
    if (!flagString(flags, 'file', '') && !positional[1]) {
      throw new CliError(
        'args_required',
        '用法：wxmp article set-author --file <文章> --author "名字"\n      留空即清空：wxmp article set-author --file <文章> --author ""\n（写命令必须写明 --file，不会默认改最近一篇）',
        2,
      )
    }
    const file = articleFileFrom(flags, positional, 1)
    const author = (flagString(flags, 'author', '') || positional[2] || '').trim()
    if (author.length > AUTHOR_MAX) {
      throw new CliError(
        'author_too_long',
        `作者 ${author.length} 字，上限 ${AUTHOR_MAX}：微信不认更长的作者名，建草稿时会被挡回来。改短一点。`,
        2,
      )
    }
    const article = loadArticle(file)
    if (article.author === author) {
      return ok(
        { file: article.path, author, changed: false },
        author ? `作者本来就是「${author}」，没有改动。` : '这篇文章本来就没有作者，没有改动。',
      )
    }
    patchFrontMatter(article.path, { author })
    return ok(
      { file: article.path, before: article.author, after: author, changed: true },
      [
        author ? `作者已更新：${article.author || '（无）'}` : '作者已清空：',
        `         → ${author || '（无）'}`,
        '',
        author
          ? '封面副标题默认取作者名，预览与面板也会跟着显示。只想换封面上那一行、不动作者，用 cover --subtitle。'
          : '封面副标题、预览页 byline、面板作者行都不会再出现它。',
      ].join('\n'),
    )
  }

  if (sub === 'new') {
    const title = flagString(flags, 'title', '') || positional[1] || ''
    if (!title) throw new CliError('title_required', '用法：wxmp article new --title "标题"', 2)
    if (title.length > TITLE_MAX) {
      throw new CliError('title_too_long', `标题 ${title.length} 字，上限 ${TITLE_MAX}`, 2)
    }
    const author = flagString(flags, 'author', '')
    if (author.length > AUTHOR_MAX) {
      throw new CliError(
        'author_too_long',
        `作者 ${author.length} 字，上限 ${AUTHOR_MAX}：微信不认更长的作者名，建草稿时会被挡回来。改短一点再建。`,
        2,
      )
    }
    const theme = flagString(flags, 'theme', 'default')
    if (!THEMES[theme]) {
      throw new CliError('theme_unknown', `未知主题 ${theme}，可用：${Object.keys(THEMES).join(' / ')}`, 2)
    }
    const cover = flagString(flags, 'cover', '')
    const name = `${safeFileName(title)}.md`
    const filePath = path.join(articleDir(), name)
    if (fs.existsSync(filePath) && !flagBool(flags, 'force')) {
      throw new CliError('article_exists', `已存在 ${filePath}，加 --force 覆盖`, 2)
    }
    fs.writeFileSync(filePath, newArticleTemplate({ title, author, theme, cover }), 'utf8')
    return ok(
      { path: filePath, title, theme },
      `已创建文章: ${filePath}\n下一步：编辑这个 .md 的正文，然后 wxmp article preview --file <路径>`,
    )
  }

  if (sub === 'list') {
    const dir = articleDir()
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.md'))
      .map((name) => {
        const filePath = path.join(dir, name)
        const stat = fs.statSync(filePath)
        const { meta } = parseFrontMatter(fs.readFileSync(filePath, 'utf8'))
        return {
          name,
          path: filePath,
          title: String(meta.title || '(无标题)'),
          mediaId: String(meta.mediaId || ''),
          updated: humanTime(stat.mtimeMs / 1000),
          size: stat.size,
        }
      })
      .sort((a, b) => b.updated.localeCompare(a.updated))

    if (!files.length) {
      return ok({ dir, articles: [] }, `文章目录为空: ${dir}\n先执行 wxmp article new --title "标题"`)
    }
    const lines = [`文章目录: ${dir}`, rule()]
    for (const file of files) {
      lines.push(
        `${file.title}${file.mediaId ? ` [草稿 ${file.mediaId.slice(0, 12)}…]` : ''}\n` +
          `  ${file.name} · ${humanBytes(file.size)} · ${file.updated}`,
      )
    }
    return ok({ dir, articles: files }, lines.join('\n'))
  }

  if (sub === 'show') {
    const file = articleFileFrom(flags, positional, 1)
    const article = loadArticle(file)
    const rendered = renderArticle(article)
    const report = validateArticle(article, rendered)
    const lines = [
      `文件: ${article.path}`,
      `标题: ${article.title}（${article.title.length}/${TITLE_MAX}）`,
      article.author ? `作者: ${article.author}（${article.author.length}/${AUTHOR_MAX}）` : '作者: (未设置)',
      `摘要: ${rendered.digest}（${rendered.digest.length}/${DIGEST_MAX}）`,
      article.cover ? `封面: ${article.cover}` : '封面: (未设置)',
      article.thumbMediaId
        ? `封面素材: ${article.thumbMediaId}（封面没变就复用，不会重复上传）`
        : '封面素材: (还没上传过)',
      `主题: ${article.theme}`,
      article.mediaId ? `草稿: ${article.mediaId}` : '草稿: (还没创建)',
      rule(),
      `正文: ${rendered.stats.words} 字 · ${rendered.stats.images} 图 · HTML ${rendered.stats.htmlChars} 字符`,
      `大纲:\n${rendered.outline.map((item) => `  ${'  '.repeat(item.level - 1)}H${item.level} ${item.text}`).join('\n') || '  (无标题)'}`,
    ]
    const problems = [...report.issues, ...report.warnings]
    if (problems.length) {
      lines.push(rule())
      for (const item of problems) lines.push(`${item.level === 'error' ? '✘' : item.level === 'warning' ? '!' : 'i'} ${item.field}: ${item.message}`)
    }
    return ok({ article: articleSummary(article), rendered: renderedSummary(rendered), report }, lines.join('\n'))
  }

  if (sub === 'check') {
    const file = articleFileFrom(flags, positional, 1)
    const article = loadArticle(file)
    const rendered = renderArticle(article)
    const report = validateArticle(article, rendered)
    const lines = [`校验: ${article.path}`, rule()]
    if (!report.issues.length && !report.warnings.length) lines.push('✔ 没有发现问题')
    for (const item of report.issues) lines.push(`✘ [${item.field}] ${item.message}`)
    for (const item of report.warnings) lines.push(`${item.level === 'warning' ? '!' : 'i'} [${item.field}] ${item.message}`)
    lines.push(
      rule(),
      `标题 ${report.limits.title[0]}/${report.limits.title[1]} · 作者 ${report.limits.author[0]}/${report.limits.author[1]} · ` +
        `摘要 ${report.limits.digest[0]}/${report.limits.digest[1]}`,
      `正文 ${report.limits.contentChars[0]}/${report.limits.contentChars[1]} 字符 · ${humanBytes(report.limits.contentBytes[0])}/1 MB`,
    )
    const result = ok({ path: article.path, report }, lines.join('\n'))
    return report.ok ? result : { ...result, ok: false, exitCode: 1 }
  }

  if (sub === 'review') {
    const file = articleFileFrom(flags, positional, 1)
    const article = loadArticle(file)
    const rendered = renderArticle(article)
    const report = validateArticle(article, rendered)
    // 用哪个标准由预设决定：--preset 显式 > config 里记住的 > standard
    const chosen = resolvePreset(flagString(flags, 'preset', ''))
    const review = reviewArticle(article, rendered, chosen.preset)
    // 硬限制超了就直接连带说一句：体检分数再高也发不出去
    const text = [
      `文件: ${article.path}`,
      `预设: ${chosen.preset.id}（${chosen.preset.name}）· 来源 ${chosen.resolvedFrom}`,
      ...(chosen.notes.length ? [`注意: ${chosen.notes.join('；')}`] : []),
      rule(),
      formatReview(review, { showNext: !flagBool(flags, 'no-next') }),
      ...(report.ok ? [] : ['', rule(), '注意：还有硬限制没过（这些必须在发布前解决）:', ...report.issues.map((item) => `✘ [${item.field}] ${item.message}`)]),
    ].join('\n')
    const minScore = flagNumber(flags, 'min-score', 0)
    const result = ok(
      {
        path: article.path,
        review,
        report,
        preset: { id: chosen.preset.id, name: chosen.preset.name, source: chosen.resolvedFrom },
        notes: chosen.notes,
      },
      text,
    )
    const failed = minScore > 0 && review.score < minScore
    if (!review.pass || failed) {
      return {
        ...result,
        ok: false,
        exitCode: 1,
        text: failed
          ? `${text}\n\n未达标：${review.score} < --min-score ${minScore}`
          : text,
      }
    }
    return result
  }

  if (sub === 'presets' || sub === 'preset') {
    const action = positional[1] || 'list'

    if (action === 'list') {
      const { presets, root, error } = listPresets()
      const current = currentPresetId()
      const lines = [
        `预设目录: ${root}`,
        ...(error ? [`! ${error}`] : []),
        rule(),
        ...presets.map((item) => {
          const mark = item.id === current ? '▸' : ' '
          const bad = item.ok ? '' : `  ! ${item.errors.join('；')}`
          // 有风格提示词的标出来：它不只能打分，还能当写作提示词用
          const styleMark = item.style ? '  · 有风格提示词' : ''
          return `${mark} ${item.id.padEnd(14)} ${item.name}${item.source === 'builtin' ? '（内置）' : ''}${styleMark}${bad}\n    ${item.description || '(无描述)'}`
        }),
        '',
        `当前生效: ${current}（改它: wxmp article preset use <id>）`,
        '把预设当写作提示词用: wxmp article preset prompt <id>',
      ]
      return ok({ root, current, presets }, lines.join('\n'))
    }

    if (action === 'show') {
      const id = positional[2] || flagString(flags, 'id', '')
      if (!id) throw new CliError('preset_id_required', '用法：wxmp article preset show <id>', 2)
      const loaded = loadPreset(id)
      const t = loaded.preset.thresholds
      const w = loaded.preset.weights
      const style = String(loaded.preset.style || '').trim()
      const lines = [
        `${loaded.preset.id} · ${loaded.preset.name}`,
        loaded.preset.description || '(无描述)',
        ...(loaded.notes.length ? ['', `! ${loaded.notes.join('；')}`] : []),
        rule(),
        '阈值:',
        ...Object.entries(THRESHOLD_SPEC).map(([key, spec]) => `  ${key.padEnd(16)} ${String(t[key]).padStart(5)}   ${spec.label}（${spec.min}~${spec.max}）`),
        '',
        '权重:',
        ...Object.entries(WEIGHT_SPEC).map(([key]) => `  ${key.padEnd(16)} ${String(w[key]).padStart(5)}   ${WEIGHT_SPEC[key]}`),
        `  ${'合计'.padEnd(16)} ${String(Object.values(w).reduce((s, v) => s + v, 0)).padStart(5)}   必须正好 100`,
        '',
        '风格提示词:',
        ...(style
          ? style.split('\n').map((line) => `  ${line}`)
          : ['  （没有。往预设目录加 style.md，或导出 JSON 补 style 字段再导入）']),
        '',
        `写作提示词（风格+节奏拼好版）: wxmp article preset prompt ${loaded.preset.id}`,
      ]
      return ok({ preset: loaded.preset, notes: loaded.notes }, lines.join('\n'))
    }

    if (action === 'prompt') {
      // 把预设拼成一份「写作提示词」交出去：风格正文 + 阈值节奏。
      // 这是预设的第一身份——写之前给 AI 的指令；打分只是写完后的复核。
      // 不带 id 就用当前生效的预设；带错了不炸，回落 standard 但必须说明
      // （跟 resolvePreset 同一语义——静默换成另一个预设比报错更坑）。
      const id = positional[2] || flagString(flags, 'id', '') || ''
      const chosen = resolvePreset(id)
      const promptParts = composePresetPrompt(chosen.preset)
      const lines = [
        `# 写作提示词 · ${promptParts.name}`,
        '',
        promptParts.style ||
          `这个预设还没有风格提示词，下面只有它的节奏参考。\n想补风格：往 ${path.join(presetsDir(), chosen.preset.id)}\\style.md 写一份，或导出 JSON 补 style 字段再导入。`,
        '',
        '## 节奏参考（同一套标准的打分阈值；写作时当节奏，不是扣分表）',
        '',
        ...promptParts.rhythmLines,
        ...(chosen.notes.length ? ['', `! ${chosen.notes.join('；')}`] : []),
      ]
      return ok(
        { id: chosen.preset.id, name: promptParts.name, hasStyle: promptParts.hasStyle, notes: chosen.notes, prompt: lines.join('\n') },
        lines.join('\n'),
      )
    }

    if (action === 'use') {
      const id = positional[2] || flagString(flags, 'id', '')
      if (!id) throw new CliError('preset_id_required', '用法：wxmp article preset use <id>', 2)
      const saved = savePresetSelection(id)
      if (!saved.ok) throw new CliError('preset_select_failed', saved.error, 1)
      const styleHint = saved.preset.style
        ? `\n写之前先拿它的风格提示词: wxmp article preset prompt ${saved.preset.id}`
        : ''
      return ok({ current: saved.preset.id }, `已切换体检预设: ${saved.preset.id}（${saved.preset.name}）\n之后的 article review 默认按这个标准打分。${styleHint}`)
    }

    if (action === 'export') {
      const id = positional[2] || flagString(flags, 'id', '')
      if (!id) throw new CliError('preset_id_required', '用法：wxmp article preset export <id> [--out 文件]', 2)
      const loaded = loadPreset(id)
      if (!loaded.preset.ok) throw new CliError('preset_invalid', `预设不合法，无法导出：\n${loaded.notes.join('\n')}`, 1)
      const out = flagString(flags, 'out', '')
      const text = exportPreset(loaded.preset)
      if (out) {
        const target = path.resolve(out)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, text, 'utf8')
        return ok({ id: loaded.preset.id, out: target, bytes: text.length }, `已导出 ${loaded.preset.id} → ${target}（${humanBytes(text.length)}）`)
      }
      // 不指定文件就打印到 stdout：方便管道与复制
      return ok({ id: loaded.preset.id, json: text }, text)
    }

    if (action === 'import') {
      const from = flagString(flags, 'file', '') || positional[2] || ''
      if (!from) throw new CliError('preset_file_required', '用法：wxmp article preset import <文件.json> [--as <id>] [--force]', 2)
      const source = path.resolve(from)
      if (!fs.existsSync(source)) throw new CliError('preset_file_not_found', `文件不存在：${source}`, 2)
      const asId = flagString(flags, 'as', '')
      const parsed = importPreset(fs.readFileSync(source, 'utf8'), { id: asId })
      if (!parsed.ok) throw new CliError('preset_invalid', `导入失败：\n${parsed.errors.join('\n')}`, 1)
      // 没给 --as 就用文件名当 id（用户一般会把文件命名成想要的名字）
      const id = safePresetId(asId || path.basename(source, path.extname(source)))
      const written = writePresetDir(presetsDir(), { ...parsed.preset, id }, { force: flagBool(flags, 'force') })
      const lines = [
        `已导入: ${written.id}（${written.preset.name}）`,
        `目录: ${written.dir}`,
        ...(parsed.warnings.length ? [`! ${parsed.warnings.join('；')}`] : []),
        '',
        `启用它: wxmp article preset use ${written.id}`,
      ]
      return ok({ id: written.id, dir: written.dir, preset: written.preset, warnings: parsed.warnings }, lines.join('\n'))
    }

    if (action === 'remove' || action === 'rm') {
      const id = positional[2] || flagString(flags, 'id', '')
      if (!id) throw new CliError('preset_id_required', '用法：wxmp article preset remove <id>', 2)
      const removed = removePresetDir(presetsDir(), id, { allowBuiltin: flagBool(flags, 'allow-builtin') })
      const current = currentPresetId()
      return ok(
        { id: removed.id, current },
        `已删除预设: ${removed.id}${current === removed.id ? '\n注意：当前生效的预设被删了，下次体检会自动退回 standard' : ''}`,
      )
    }

    if (action === 'reset') {
      // 恢复出厂：把内置预设重新写进目录（只补缺失的文件，不覆盖用户改过的）
      const ensured = ensurePresets()
      return ok(
        ensured,
        `已确保内置预设落盘。新建 ${ensured.created.length} 个${ensured.created.length ? `：${ensured.created.join(', ')}` : ''}` +
          `${ensured.skipped.length ? `\n已存在（未覆盖）：${ensured.skipped.join(', ')}` : ''}` +
          '\n想彻底恢复某个预设的出厂值，先 remove 它再 reset。',
      )
    }

    throw new CliError('unknown_subcommand', `未知子命令 article preset ${action}\n可用: list / show / prompt / use / export / import / remove / reset`, 2)
  }

  if (sub === 'preview') {
    const file = articleFileFrom(flags, positional, 1)
    const article = loadArticle(file)
    const rendered = renderArticle(article)
    const outPath =
      flagString(flags, 'out', '') || path.join(homeDir(), 'previews', `${article.name}.html`)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })

    let coverUrl = ''
    if (article.cover) {
      const asset = resolveAssetPath(article, article.cover)
      coverUrl = asset.kind === 'local' ? toFileUrl(asset.value, path) : asset.value
    }
    // 正文里的本地图片换成 file:// 才能在浏览器里看到
    const localImages = new Map()
    for (const src of rendered.images) {
      if (/^https?:/i.test(src)) continue
      try {
        const asset = resolveAssetPath(article, src)
        if (asset.kind === 'local') localImages.set(src, toFileUrl(asset.value, path))
      } catch {
        /* 图片缺失就先留原样，preview 不阻断 */
      }
    }
    const previewHtml = wrapPreview({
      title: article.title,
      author: article.author,
      digest: rendered.digest,
      html: renderHtml(rendered.nodes, { theme: article.theme, images: localImages }).html,
      coverUrl,
      themeName: article.theme,
      dir: path.basename(article.path),
    })
    fs.writeFileSync(outPath, previewHtml, 'utf8')

    if (flagBool(flags, 'open')) openFile(outPath)
    return ok(
      { path: outPath, bytes: previewHtml.length },
      `预览已生成: ${outPath}\n用浏览器打开即可检查排版；发布前建议先 \`wxmp article check\`。`,
    )
  }

  throw new CliError('unknown_subcommand', `未知子命令 article ${sub}`, 2)
}

function articleSummary(article) {
  return {
    path: article.path,
    name: article.name,
    dir: article.dir,
    title: article.title,
    author: article.author,
    digest: article.digest,
    cover: article.cover,
    theme: article.theme,
    sourceUrl: article.sourceUrl,
    mediaId: article.mediaId,
    /**
     * 封面永久素材的缓存。回传出去有两个用处：
     * 一是面板/agent 能看出"下次推是不是会复用封面"，
     * 二是诊断时能一眼确认 front matter 里到底有没有写回这两个键。
     */
    thumbMediaId: article.thumbMediaId,
    coverHash: article.coverHash,
    /**
     * 正文与字数必须回传：面板要显示「正文 N 字符」并渲染内容。
     * 原先这里只有元信息，面板拿不到 body，于是一直显示「正文 0 字符」——
     * 数据没缺，是这个摘要里根本没带。
     */
    body: article.body,
    bodyChars: String(article.body || '').length,
  }
}

function renderedSummary(rendered) {
  return {
    digest: rendered.digest,
    stats: rendered.stats,
    outline: rendered.outline,
    images: rendered.images,
    htmlChars: rendered.html.length,
  }
}

function openFile(filePath) {
  try {
    const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', filePath] : [filePath]
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  } catch {
    /* 打不开就算了，路径已经打印 */
  }
}

/* ------------------------------------------------------------------ */
/* cover                                                               */
/* ------------------------------------------------------------------ */

/**
 * 封面在 front matter 里的引用名：与文章同目录用文件名，别处返回 ''。
 * 别处不写回，是因为 front matter 里塞绝对路径换台机器就废了。
 */
function coverReference(article, outPath) {
  const resolved = path.resolve(outPath)
  if (path.dirname(resolved) !== path.resolve(article.dir)) return ''
  return path.basename(resolved)
}

/**
 * 找文章同目录里已经存在的封面：先找 `<文章名>-cover.png`（每篇独立，不会互踩），
 * 再兼容旧的共享 `cover.png`。都没有返回 ''。
 */
export function findLocalCover(article) {
  for (const name of [`${article.name}-cover.png`, 'cover.png']) {
    try {
      if (fs.statSync(path.join(article.dir, name)).isFile()) return name
    } catch {
      /* 试下一个 */
    }
  }
  return ''
}

async function coverCmd(positional, flags) {
  // cover 没有子命令：positional[0] 就是文章路径
  const file = articleFileFrom(flags, positional, 0)
  const article = loadArticle(file)
  const theme = flagString(flags, 'theme', article.theme || 'default')
  if (!THEMES[theme]) {
    throw new CliError('theme_unknown', `未知主题 ${theme}，可用：${listThemes().join(' / ')}`, 2)
  }
  const subtitle = flagString(flags, 'subtitle', '') || article.author
  const badge = flagString(flags, 'badge', '')
  // 默认每篇一个文件名：旧的共享 cover.png 会让后生成的文章覆盖前一篇的封面
  const outPath = flagString(flags, 'out', '') || path.join(article.dir, `${article.name}-cover.png`)

  /* 输出尺寸：默认推荐 900×383（2.35:1），但**可以改**。
   * 面板侧会先做二次确认，这里只负责收敛 —— 越界夹边界、比例偏了照做不误。
   * 版式（planCover）本来就按比例缩放 padding，所以换尺寸不需要改排版算法。 */
  const coverSize = normalizeCoverSize({
    width: flagNumber(flags, 'width', 0),
    height: flagNumber(flags, 'height', 0),
  })

  const workDir = path.join(homeDir(), 'tmp')
  const plan = planCover({ title: article.title, subtitle, badge, width: coverSize.width, height: coverSize.height })

  /* ── 背景来源三档（前一个可用就赢）─────────────────────────
   *  1. --bg <图片>       用户给的底图，最可控
   *  2. --image-gen [供应商] AI 生成（需 key，失败自动回落渐变）
   *  3. 都不给            现有渐变（零依赖默认）
   * 三种情况标题排版都走同一份 plan，版式不因背景来源漂移。
   */
  let result = null
  let background = { mode: 'gradient', source: '', note: '' }
  const bgFlag = flagString(flags, 'bg', '')
  const genFlag = flagString(flags, 'image-gen', '')
  const useImageGen = flagBool(flags, 'image-gen') || genFlag !== ''

  if (bgFlag) {
    const bgPath = path.isAbsolute(bgFlag) ? bgFlag : path.resolve(article.dir, bgFlag)
    const composed = await composeWithBackground({ backgroundPath: bgPath, outPath, plan, workDir })
    if (composed.ok) {
      result = { path: composed.path, method: 'composite', bytes: composed.bytes }
      background = { mode: 'file', source: bgPath, note: `底图: ${path.basename(bgPath)}` }
    } else {
      // 底图失败不该让整个 cover 失败：降级到渐变，并把原因带出去
      background = { mode: 'gradient', source: bgPath, note: `底图合成失败（${composed.error}），已回落渐变` }
    }
  }

  if (!result && useImageGen) {
    // 魔搭这类供应商出图可能几分钟，必须让用户看到"还在跑"，
    // 否则表现为 CLI 卡死。只在 stderr 打进度，不污染 stdout 的 JSON。
    const progress = (event) => {
      if (!event || event.phase !== 'polling') return
      if (event.seconds && event.seconds % 15 === 0) {
        process.stderr.write(`  AI 出图中… ${event.seconds} 秒（魔搭免费队列可能需要几分钟）\n`)
      }
    }
    const generated = await generateBackgroundForCover({
      article,
      supplierHint: genFlag && genFlag !== 'true' ? genFlag : '',
      // 用户自定义提示词（可选）：写什么就提交什么 —— 2026-11-09 起不再追加任何约束
      customPrompt: flagString(flags, 'prompt', ''),
      // AI 出的图按目标尺寸档位请求，合成时再按 plan 等比裁剪铺满
      coverSize,
      workDir,
      onProgress: progress,
    })
    if (generated.ok) {
      const composed = await composeWithBackground({ backgroundPath: generated.path, outPath, plan, workDir })
      if (composed.ok) {
        result = { path: composed.path, method: 'composite', bytes: composed.bytes }
        background = {
          mode: 'generated',
          source: generated.path,
          note: `AI 背景: ${generated.providerId}${generated.model ? `（${generated.model}）` : ''}`,
        }
      } else {
        background = { mode: 'gradient', source: '', note: `AI 背景合成失败（${composed.error}），已回落渐变` }
      }
    } else {
      background = { mode: 'gradient', source: '', note: `AI 配图不可用（${generated.error}），已回落渐变` }
    }
  }

  if (!result) {
    result = await renderCover({
      title: article.title,
      subtitle,
      badge,
      theme,
      outPath,
      workDir,
      plan,
    })
  }

  const note =
    result.method === 'composite'
      ? `AI 背景 + GDI 中文标题（${background.note || background.mode}）`
      : result.method === 'gdi'
        ? 'GDI+ 渲染（含中文标题）'
        : `纯色渐变回退（无文字）${result.error ? `：${result.error}` : ''}`
  // 用户明确要求了 AI 背景却回落了，必须把原因说出来：
  // 否则他以为 AI 图生效了，实际拿到的是渐变，还以为"AI 画得就这水平"。
  const degraded =
    background.mode === 'gradient' && background.note
      ? `\n注意：${background.note}`
      : ''

  // 生成后立刻写回 front matter：否则「生成封面 → 建草稿」这一步断在中间，
  // 现象是草稿建不出来、微信回 40007 invalid media_id（其实是压根没传 thumb_media_id）。
  const coverRef = coverReference(article, result.path)
  let frontMatter = { written: false, value: coverRef }
  const sizeNote = formatCoverSize(coverSize)
  // 越界被夹、比例偏离推荐：都要说出来，否则用户以为设置生效了
  const sizeWarn = [
    coverSize.clamped ? `要求的尺寸超出可用范围，已夹到 ${sizeNote}` : '',
    coverSize.ratioWarn ? `注意：${coverSize.ratioWarn}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  let text = `封面已生成: ${result.path}（${humanBytes(result.bytes)}，${sizeNote}）\n方式: ${note}${degraded}`
  if (sizeWarn) text += `\n${sizeWarn}`
  if (coverRef) {
    try {
      patchFrontMatter(article.path, { cover: coverRef })
      frontMatter = { written: true, value: coverRef }
      text += `\n已写入 front matter: cover: ${coverRef}`
    } catch (error) {
      const reason = (error && error.message) || String(error)
      text += `\n写回 front matter 失败：${reason}\n手动补一行: cover: ${coverRef}`
    }
  } else {
    text += `\n封面不在文章目录里，没有改 front matter；需要的话在文章里加一行: cover: ${result.path}`
  }
  return ok(
    {
      path: result.path,
      method: result.method,
      bytes: result.bytes,
      theme,
      coverRef,
      frontMatter,
      coverSize: { width: coverSize.width, height: coverSize.height },
    },
    text,
  )
}

/* ------------------------------------------------------------------ */
/* draft                                                               */
/* ------------------------------------------------------------------ */

/** 下载远程图片到本地临时文件。 */
async function downloadToLocal(url, client) {
  const fetchImpl = client.fetchImpl
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  if (typeof timer.unref === 'function') timer.unref()
  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    if (!response.ok) throw new CliError('image_download_failed', `下载图片失败 HTTP ${response.status}: ${url}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    const ext = (url.match(/\.(png|jpg|jpeg|gif|bmp|webp)(?:[?#]|$)/i) || ['.png'])[0].replace(/[?#].*$/, '')
    const dir = path.join(homeDir(), 'tmp')
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `dl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
    fs.writeFileSync(filePath, buffer)
    return filePath
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 失效封面素材的判据：微信把这条 media_id 删了，或者它本来就不属于这个号。
 * 微信对这种情况固定回 40007 invalid media_id。
 */
function isStaleThumbError(error) {
  const code = String((error && error.code) || '')
  const text = String((error && error.message) || '')
  return code === 'wechat_40007' || /40007|invalid media_id/i.test(text)
}

/**
 * 该写回 front matter 的封面素材键。
 * 只在"这次真的新上传了"才返回：复用的时候值本来就没变，写回去只是白改一次文件。
 */
function materialPatch(assets) {
  if (assets.thumbFrom !== 'upload' || !assets.thumbMediaId) return {}
  const patch = { thumbMediaId: assets.thumbMediaId }
  if (assets.coverHash) patch.coverHash = assets.coverHash
  return patch
}

/** 给用户看的一句话：这次封面素材是怎么来的。 */
function describeThumbFrom(thumbFrom) {
  if (thumbFrom === 'flag') return '命令行指定，未动'
  if (thumbFrom === 'reuse') return '复用缓存，没重复上传'
  if (thumbFrom === 'upload') return '本次新上传'
  return '未知来源'
}

/**
 * 把文章准备好上传：处理封面（永久素材）和正文图片（uploadimg）。
 *
 * 封面这一步是本项目最容易捅娄子的地方：`material/add_material` 每调一次，
 * 公众号后台就**多一条永久素材**，而且删不干净（要逐条去后台删）。
 * 于是「改一句话 → draft update」这个动作如果每次都重传封面，反复改几稿
 * 就会攒出一堆一模一样的封面。
 *
 * 所以这里做一件事：**封面内容没变就复用上次上传的 thumb_media_id**。
 * front matter 里成对存着 `thumbMediaId` 与 `coverHash`（封面内容指纹），
 * 两者一致就直接拿去用，一次网络请求都不发。
 *
 * 远程封面（http(s) URL）不走复用：比较内容得先下载，而"URL 没变内容变了"
 * 是可能的，宁可多一条素材也不要拿错图当封面。这种情况会给明确警告。
 *
 * @returns {{thumbMediaId: string, thumbFrom: string, coverHash: string,
 *            imageMap: Map<string,string>, warnings: string[], kept: string[],
 *            coverRef: string, coverAuto: boolean}}
 *   thumbFrom: 'flag'（命令行指定）| 'reuse'（复用缓存）| 'upload'（这次真上传了）| ''
 */
async function prepareAssets(article, rendered, client, options = {}) {
  const warnings = []
  let thumbMediaId = String(options.thumbMediaId || '')
  // 封面来源：命令行显式给了就听命令行的，别的分支才轮到缓存和上传
  let thumbFrom = thumbMediaId ? 'flag' : ''
  let coverHash = ''
  const imageMap = new Map()
  const kept = []

  // 微信 draft/add 必须带 thumb_media_id：没封面就别等到微信回 40007 才发现。
  // 先本地兜底（同目录里已经生成好的封面），再本地拦下并说清下一步。
  let coverAuto = false
  if (!thumbMediaId && !article.cover) {
    const fallback = findLocalCover(article)
    if (fallback) {
      article.cover = fallback
      coverAuto = true
      warnings.push(`文章没写 cover，自动使用同目录的 ${fallback}`)
    }
  }
  if (!thumbMediaId && !article.cover) {
    throw new CliError(
      'cover_required',
      [
        '这篇文章没有封面，草稿建不出来：微信要求 thumb_media_id，缺了会回 40007 invalid media_id。',
        '二选一：',
        `  1) 先生成封面（会自动写回 front matter）: wxmp cover --file "${article.path}"`,
        '  2) 在 front matter 里写一行 cover: <图片路径>（本地文件或 http(s) 都行）',
      ].join('\n'),
      1,
      { hint: '先跑 wxmp cover --file <文章>，生成后会自动写回 cover 字段' },
    )
  }

  if (!thumbMediaId && article.cover) {
    const asset = resolveAssetPath(article, article.cover)
    const remote = asset.kind === 'remote'

    /* 本地封面：先算指纹，能复用就一个字节都不上传。
     * forceUpload 是给"缓存里的素材在后台被删了"那条补救路径用的。 */
    if (!remote) {
      coverHash = fileFingerprint(asset.value)
      if (
        !options.forceUpload &&
        article.thumbMediaId &&
        article.coverHash &&
        article.coverHash === coverHash
      ) {
        thumbMediaId = article.thumbMediaId
        thumbFrom = 'reuse'
        warnings.push(`封面没变，复用已有永久素材（没重复上传）: ${thumbMediaId}`)
      }
    }

    if (!thumbMediaId) {
      let filePath = asset.value
      if (remote) filePath = await downloadToLocal(asset.value, client)
      if (remote) {
        warnings.push(
          '封面是远程 URL，无法廉价比对内容，这次会新建一条永久素材；想让反复推送不再产生新素材，把它下载到本地再引用',
        )
      }
      const size = fs.statSync(filePath).size
      if (size > 10 * 1024 * 1024) {
        throw new CliError('cover_too_large', `封面 ${humanBytes(size)}，永久素材上限 10 MB`, 1)
      }
      const uploaded = await client.uploadPermanentImage(filePath)
      thumbMediaId = String(uploaded.media_id || '')
      if (!thumbMediaId) throw new CliError('cover_upload_failed', '永久素材上传没有返回 media_id', 1)
      thumbFrom = 'upload'
      // 远程封面下载到临时文件，指纹要在删之前算，否则下次还是认不出来
      if (remote) {
        try {
          coverHash = fileFingerprint(filePath)
        } catch {
          coverHash = ''
        }
      }
      warnings.push(`封面已上传为永久素材（${humanBytes(size)}）`)
      if (remote) {
        try {
          fs.unlinkSync(filePath)
        } catch {
          /* 临时文件清不掉不影响结果 */
        }
      }
    }
  }

  for (const src of rendered.images) {
    if (/^https?:\/\//i.test(src) && /mmbiz\.|qpic\.cn|wxqcloud/i.test(src)) {
      kept.push(src)
      continue
    }
    let filePath
    let temporary = false
    if (/^https?:\/\//i.test(src)) {
      filePath = await downloadToLocal(src, client)
      temporary = true
    } else {
      const asset = resolveAssetPath(article, src)
      filePath = asset.value
    }
    const size = fs.statSync(filePath).size
    if (size > 1024 * 1024) {
      throw new CliError(
        'content_image_too_large',
        `正文图片 ${path.basename(filePath)} 是 ${humanBytes(size)}，uploadimg 上限 1 MB；先压缩再试`,
        1,
      )
    }
    const uploaded = await client.uploadContentImage(filePath)
    const url = String(uploaded.url || '')
    if (!url) throw new CliError('content_image_upload_failed', `正文图片 ${src} 上传没有返回 url`, 1)
    imageMap.set(src, url)
    if (temporary) {
      try {
        fs.unlinkSync(filePath)
      } catch {
        /* ignore */
      }
    }
  }

  if (kept.length) warnings.push(`${kept.length} 张图片已是 mmbiz 域名，直接复用`)
  return { thumbMediaId, thumbFrom, coverHash, imageMap, warnings, kept, coverRef: String(article.cover || ''), coverAuto }
}

/** 组装 draft/add 需要的 article 对象。 */
export function buildDraftArticle(article, rendered, options = {}) {
  const { html } = renderHtml(rendered.nodes, {
    theme: article.theme,
    images: options.imageMap || new Map(),
  })
  const payload = {
    article_type: 'news',
    title: article.title,
    content: html,
    need_open_comment: options.comments === undefined ? (article.comments ? 1 : 0) : options.comments ? 1 : 0,
    only_fans_can_comment: 0,
  }
  if (article.author) payload.author = article.author
  if (rendered.digest) payload.digest = rendered.digest
  if (article.sourceUrl) payload.content_source_url = article.sourceUrl
  if (options.thumbMediaId) payload.thumb_media_id = options.thumbMediaId
  return payload
}

async function draftCmd(positional, flags) {
  const sub = positional[0] || 'list'

  if (sub === 'create') {
    const file = articleFileFrom(flags, positional, 1)
    const article = loadArticle(file)
    const rendered = renderArticle(article)
    const report = validateArticle(article, rendered)
    if (!report.ok) {
      const problems = report.issues.map((item) => `- [${item.field}] ${item.message}`).join('\n')
      throw new CliError('article_invalid', `文章不满足微信限制：\n${problems}`, 1, { issues: report.issues })
    }

    if (flagBool(flags, 'dry-run')) {
      const payload = buildDraftArticle(article, rendered)
      const coverForDry = article.cover || findLocalCover(article)
      const coverNote = article.cover
        ? '会先上传成 thumb_media_id'
        : coverForDry
          ? `front matter 没写，建草稿时会自动兜底用它 → 上传成 thumb_media_id`
          : '缺封面：真正建草稿会在本地就拦下（cover_required），先跑 wxmp cover'
      return ok(
        { dryRun: true, article: articleSummary(article), payload: { ...payload, content: `${payload.content.slice(0, 200)}…` } },
        [
          'dry-run：不会真的上传/创建草稿。',
          `标题: ${article.title}`,
          `正文: ${rendered.stats.htmlChars} 字符 · ${rendered.stats.images} 图`,
          `封面: ${coverForDry || '(缺)'} → ${coverNote}`,
          `正文图片: ${rendered.images.length} 张 → 会逐张走 uploadimg`,
          '', '去掉 --dry-run 才会真正调用接口。',
        ].join('\n'),
      )
    }

    const { client } = clientFromOptions(flags)
    let assets = await prepareAssets(article, rendered, client, {
      thumbMediaId: flagString(flags, 'thumb-media-id', ''),
    })
    const buildPayload = () =>
      buildDraftArticle(article, rendered, {
        thumbMediaId: assets.thumbMediaId,
        imageMap: assets.imageMap,
        comments: flagBool(flags, 'comments') ? true : undefined,
      })
    let result
    try {
      result = await client.addDraft([buildPayload()])
    } catch (error) {
      if (assets.thumbFrom !== 'reuse' || !isStaleThumbError(error)) throw error
      // 复用的素材被人在后台删了：重新上传一张再试一次，别让用户卡在 40007
      assets = await prepareAssets(article, rendered, client, { thumbMediaId: '', forceUpload: true })
      assets.warnings.unshift('缓存里的封面素材已失效（40007），已重新上传一张，草稿继续创建')
      result = await client.addDraft([buildPayload()])
    }
    const mediaId = String(result.media_id || '')
    if (!mediaId) throw new CliError('draft_create_failed', 'draft/add 没有返回 media_id', 1)

    // 把 media_id 写回 front matter，后续 update / publish 直接引用；
    // 封面素材 id + 内容指纹也一起写回 —— 下次封面没变就能复用，
    // 不然每推一次草稿，公众号后台就多一条永久素材。
    // 封面若是自动兜底来的，顺手一起写回，免得下次又走同一条兜底路径。
    const patch = { mediaId, ...materialPatch(assets) }
    if (assets.coverAuto && assets.coverRef) patch.cover = assets.coverRef
    patchFrontMatter(article.path, patch)

    return ok(
      {
        mediaId,
        path: article.path,
        assets: {
          thumbMediaId: assets.thumbMediaId,
          thumbFrom: assets.thumbFrom,
          images: assets.imageMap.size,
          cover: assets.coverRef,
          coverAuto: assets.coverAuto,
        },
        payload: { ...buildPayload(), content: `${buildPayload().content.slice(0, 120)}…` },
      },
      [
        `草稿已创建: ${mediaId}`,
        `文章: ${article.path}（mediaId${assets.coverAuto ? ' 与 cover' : ''} 已写回 front matter）`,
        assets.thumbMediaId ? `封面素材: ${assets.thumbMediaId}（${describeThumbFrom(assets.thumbFrom)}）` : '封面: 未上传',
        `正文图片: ${assets.imageMap.size} 张已换成 mmbiz URL`,
        ...assets.warnings.map((item) => `  · ${item}`),
        `下一步: wxmp publish submit --file <文章> --yes`,
      ].join('\n'),
    )
  }

  if (sub === 'list') {
    const { client } = clientFromOptions(flags)
    const offset = flagNumber(flags, 'offset', 0)
    const count = flagNumber(flags, 'count', 20)
    const data = await client.listDrafts({ offset, count, noContent: !flagBool(flags, 'full') })
    const items = (data.item || []).map((item) => {
      const news = (item.content && item.content.news_item) || []
      const first = news[0] || {}
      return {
        mediaId: item.media_id,
        title: String(first.title || '(无标题)'),
        author: String(first.author || ''),
        updateTime: Number(item.update_time) || 0,
        articleCount: news.length,
        url: String(first.url || ''),
      }
    })
    const lines = [
      `草稿总数: ${data.total_count ?? items.length}（本次 ${data.item_count ?? items.length} 条，offset=${offset}）`,
      rule(),
    ]
    for (const item of items) {
      lines.push(`${item.title}\n  ${item.mediaId} · ${humanTime(item.updateTime)}${item.articleCount > 1 ? ` · ${item.articleCount} 篇` : ''}`)
    }
    if (!items.length) lines.push('(没有草稿)')
    return ok({ total: data.total_count ?? items.length, items }, lines.join('\n'))
  }

  if (sub === 'get') {
    const mediaId = flagString(flags, 'media-id', '') || positional[1]
    if (!mediaId) throw new CliError('media_id_required', '用法：wxmp draft get --media-id <media_id>', 2)
    const { client } = clientFromOptions(flags)
    const data = await client.getDraft(mediaId)
    const news = (data.news_item || []).map((item) => ({
      title: item.title,
      author: item.author,
      digest: item.digest,
      thumbMediaId: item.thumb_media_id,
      url: item.url,
      contentChars: String(item.content || '').length,
    }))
    const lines = [`草稿: ${mediaId}（${news.length} 篇）`, rule()]
    for (const [index, item] of news.entries()) {
      lines.push(
        `${index + 1}. ${item.title}\n   作者: ${item.author || '-'} · 正文 ${item.contentChars} 字符\n   摘要: ${item.digest || '-'}\n   封面: ${item.thumbMediaId}\n   临时链接: ${item.url || '-'}`,
      )
    }
    if (flagBool(flags, 'raw')) lines.push('', compactJson(data, 1200))
    return ok({ mediaId, news }, lines.join('\n'))
  }

  if (sub === 'count') {
    const { client } = clientFromOptions(flags)
    const data = await client.countDrafts()
    // 真实响应是 { total_count }，不是 { total }；两个都认，避免又一次 undefined。
    const total = data.total_count ?? data.total ?? 0
    return ok({ total, totalCount: total }, `草稿总数: ${total}`)
  }

  if (sub === 'delete') {
    const mediaId = flagString(flags, 'media-id', '') || positional[1]
    if (!mediaId) throw new CliError('media_id_required', '用法：wxmp draft delete --media-id <media_id>', 2)
    const { client } = clientFromOptions(flags)
    await client.deleteDraft(mediaId)
    const file = flagString(flags, 'file', '')
    if (file) {
      try {
        patchFrontMatter(resolveArticleFile(file), { mediaId: '' })
      } catch {
        /* 文件不存在就算了 */
      }
    }
    return ok({ mediaId, deleted: true }, `已删除草稿: ${mediaId}`)
  }

  if (sub === 'update') {
    const file = articleFileFrom(flags, positional, 1)
    const article = loadArticle(file)
    const mediaId = flagString(flags, 'media-id', '') || article.mediaId
    if (!mediaId) {
      throw new CliError('media_id_required', '文章还没有草稿 media_id：先 wxmp draft create，或用 --media-id 指定', 2)
    }
    const rendered = renderArticle(article)
    const report = validateArticle(article, rendered)
    if (!report.ok) {
      throw new CliError(
        'article_invalid',
        `文章不满足微信限制：\n${report.issues.map((i) => `- [${i.field}] ${i.message}`).join('\n')}`,
        1,
      )
    }
    if (flagBool(flags, 'dry-run')) {
      return ok(
        { dryRun: true, mediaId },
        `dry-run：将更新草稿 ${mediaId} 的第 ${flagNumber(flags, 'index', 0) + 1} 篇为「${article.title}」`,
      )
    }
    const { client } = clientFromOptions(flags)
    let assets = await prepareAssets(article, rendered, client, {
      thumbMediaId: flagString(flags, 'thumb-media-id', ''),
    })
    const buildPayload = () =>
      buildDraftArticle(article, rendered, {
        thumbMediaId: assets.thumbMediaId,
        imageMap: assets.imageMap,
        comments: flagBool(flags, 'comments') ? true : undefined,
      })
    try {
      await client.updateDraft(mediaId, flagNumber(flags, 'index', 0), buildPayload())
    } catch (error) {
      if (assets.thumbFrom !== 'reuse' || !isStaleThumbError(error)) throw error
      // 复用的素材被人在后台删了：重新上传一张再试一次，别让用户卡在 40007
      assets = await prepareAssets(article, rendered, client, { thumbMediaId: '', forceUpload: true })
      assets.warnings.unshift('缓存里的封面素材已失效（40007），已重新上传一张，草稿继续更新')
      await client.updateDraft(mediaId, flagNumber(flags, 'index', 0), buildPayload())
    }
    /* 封面素材 id 与内容指纹写回 front matter —— 这是"反复刷稿不再堆永久素材"
     * 能成立的前提：下次 update 只要封面没变，就直接复用这一条。
     * 写不回（文件只读等）不影响草稿已经更新这件事，但要让用户看见。 */
    const patch = materialPatch(assets)
    if (assets.coverAuto && assets.coverRef) patch.cover = assets.coverRef
    if (Object.keys(patch).length) {
      try {
        patchFrontMatter(article.path, patch)
      } catch {
        assets.warnings.push('封面素材信息没能写回 front matter，下次更新可能会重新上传封面')
      }
    }
    return ok(
      {
        mediaId,
        index: flagNumber(flags, 'index', 0),
        title: article.title,
        thumbFrom: assets.thumbFrom,
        thumbMediaId: assets.thumbMediaId,
        warnings: assets.warnings,
      },
      `已更新草稿: ${mediaId}\n标题: ${article.title}\n正文图片: ${assets.imageMap.size} 张` +
        (assets.thumbMediaId ? `\n封面素材: ${assets.thumbMediaId}（${describeThumbFrom(assets.thumbFrom)}）` : '') +
        (assets.warnings.length ? `\n${assets.warnings.map((item) => `  · ${item}`).join('\n')}` : ''),
    )
  }

  throw new CliError('unknown_subcommand', `未知子命令 draft ${sub}`, 2)
}

/* ------------------------------------------------------------------ */
/* publish                                                             */
/* ------------------------------------------------------------------ */

async function publishCmd(positional, flags) {
  const sub = positional[0] || 'status'

  if (sub === 'submit') {
    const file = flagString(flags, 'file', '') || positional[1] || ''
    let mediaId = flagString(flags, 'media-id', '')
    if (!mediaId) {
      const article = loadArticle(articleFileFrom(flags, positional, 1))
      mediaId = article.mediaId
      if (!mediaId) {
        throw new CliError(
          'media_id_required',
          `文章 ${article.path} 还没有草稿：先 wxmp draft create --file <文章>，或用 --media-id 指定`,
          2,
        )
      }
    }
    if (!flagBool(flags, 'yes')) {
      return ok(
        { dryRun: true, mediaId },
        [
          'dry-run：还没有真的发布。',
          `将发布草稿: ${mediaId}`,
          '',
          '确认内容无误后加 --yes 真正提交：',
          `  wxmp publish submit --media-id ${mediaId} --yes`,
          '',
          '注意：发布是异步任务，提交成功不等于发布成功；用 wxmp publish wait 轮询状态。',
        ].join('\n'),
      )
    }
    const { client } = clientFromOptions(flags)
    const data = await client.submitPublish(mediaId)
    const publishId = String(data.publish_id || '')
    if (!publishId) {
      throw new CliError('publish_submit_failed', `freepublish/submit 没有返回 publish_id：${compactJson(data)}`, 1)
    }
    return ok(
      { mediaId, publishId, msgDataId: data.msg_data_id || '' },
      [
        `已提交发布任务: publish_id=${publishId}`,
        `草稿: ${mediaId}`,
        '',
        '提交成功 ≠ 发布成功（平台审核/原创校验还在后面）。',
        `继续: wxmp publish wait --publish-id ${publishId}`,
      ].join('\n'),
    )
  }

  if (sub === 'status') {
    const publishId = flagString(flags, 'publish-id', '') || positional[1]
    if (!publishId) throw new CliError('publish_id_required', '用法：wxmp publish status --publish-id <id>', 2)
    const { client } = clientFromOptions(flags)
    const data = await client.getPublishStatus(publishId)
    const status = describePublishStatus(data.publish_status)
    const urls = ((data.article_detail && data.article_detail.item) || []).map((item) => ({
      idx: item.idx,
      url: item.article_url,
    }))
    const lines = [
      `publish_id: ${data.publish_id || publishId}`,
      `状态: ${status.label}（${status.code}）${status.note ? `\n  ${status.note}` : ''}`,
    ]
    if (data.article_id) lines.push(`article_id: ${data.article_id}`)
    if (urls.length) {
      lines.push('文章链接:')
      for (const item of urls) lines.push(`  ${item.idx}. ${item.url}`)
    }
    if (Array.isArray(data.fail_idx) && data.fail_idx.length) lines.push(`失败篇目: ${data.fail_idx.join(', ')}`)
    return ok({ ...data, statusLabel: status.label }, lines.join('\n'))
  }

  if (sub === 'wait') {
    const publishId = flagString(flags, 'publish-id', '') || positional[1]
    if (!publishId) throw new CliError('publish_id_required', '用法：wxmp publish wait --publish-id <id>', 2)
    const timeoutMs = flagNumber(flags, 'timeout', 120000)
    const interval = flagNumber(flags, 'interval', 5000)
    const { client } = clientFromOptions(flags)
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() <= deadline) {
      last = await client.getPublishStatus(publishId)
      const status = describePublishStatus(last.publish_status)
      if (last.publish_status !== 1) {
        const urls = ((last.article_detail && last.article_detail.item) || []).map((item) => item.article_url)
        const lines = [`publish_id: ${publishId}`, `状态: ${status.label}（${status.code}）`]
        if (urls.length) lines.push(`链接: ${urls.join('\n      ')}`)
        const result = ok({ ...last, statusLabel: status.label }, lines.join('\n'))
        return last.publish_status === 0 ? result : { ...result, ok: false, exitCode: 1 }
      }
      await sleep(interval)
    }
    const status = describePublishStatus(last ? last.publish_status : 1)
    return {
      ok: false,
      exitCode: 1,
      data: { publishId, last, timeout: timeoutMs },
      text: `等待超时（${timeoutMs}ms），当前状态: ${status.label}。可以稍后再 \`wxmp publish status --publish-id ${publishId}\`。`,
    }
  }

  if (sub === 'list') {
    const { client } = clientFromOptions(flags)
    const offset = flagNumber(flags, 'offset', 0)
    const count = flagNumber(flags, 'count', 20)
    const data = await client.listPublished({ offset, count, noContent: !flagBool(flags, 'full') })
    const items = (data.item || []).map((item) => {
      const first = ((item.content && item.content.news_item) || [])[0] || {}
      return {
        articleId: item.article_id,
        title: String(first.title || '(无标题)'),
        url: String(first.url || ''),
        updateTime: Number(item.update_time) || 0,
        deleted: first.is_deleted === true,
      }
    })
    const lines = [`已发布总数: ${data.total_count ?? items.length}`, rule()]
    for (const item of items) {
      lines.push(`${item.title}${item.deleted ? ' [已删除]' : ''}\n  ${humanTime(item.updateTime)}\n  ${item.url}`)
    }
    if (!items.length) lines.push('(没有已发布内容)')
    return ok({ total: data.total_count ?? items.length, items }, lines.join('\n'))
  }

  if (sub === 'delete') {
    const articleId = flagString(flags, 'article-id', '') || positional[1]
    if (!articleId) throw new CliError('article_id_required', '用法：wxmp publish delete --article-id <id>', 2)
    if (!flagBool(flags, 'yes')) {
      return ok({ dryRun: true, articleId }, `dry-run：将删除已发布文章 ${articleId}（加 --yes 真的删）`)
    }
    const { client } = clientFromOptions(flags)
    await client.deletePublish(articleId, flagNumber(flags, 'index', 0))
    return ok({ articleId, deleted: true }, `已删除已发布文章: ${articleId}`)
  }

  throw new CliError('unknown_subcommand', `未知子命令 publish ${sub}`, 2)
}

export function describePublishStatus(code) {
  const map = {
    0: { label: '发布成功', note: '' },
    1: { label: '发布中', note: '任务还在处理，稍等再查' },
    2: { label: '原创校验失败', note: '可能与其他文章重复度高；改写后重新提交' },
    3: { label: '常规失败', note: '内容或账号状态有问题，看 fail_idx 对应篇目' },
    4: { label: '平台审核不通过', note: '内容不合规，需要修改' },
    5: { label: '发布后被删除', note: '' },
    6: { label: '发布后被系统封禁', note: '' },
  }
  const entry = map[Number(code)]
  return entry || { label: '未知状态', note: '' }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ------------------------------------------------------------------ */
/* doctor                                                              */
/* ------------------------------------------------------------------ */

async function doctorCmd() {
  const checks = []
  const push = (name, okValue, detail, fix) => checks.push({ name, ok: okValue, detail, fix })

  push('Node', true, `${process.version} / ${process.platform}`)
  let homeOk = true
  try {
    fs.mkdirSync(homeDir(), { recursive: true })
    const probe = path.join(homeDir(), `.probe-${process.pid}`)
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
  } catch {
    homeOk = false
  }
  push('本地目录', homeOk, homeDir(), '检查路径权限，或用 WXMP_HOME 指定可写目录')

  const creds = resolveCredentials()
  push(
    '公众号凭据',
    Boolean(creds.appid && creds.secret),
    creds.appid
      ? `appid=${creds.appid} secret=${creds.secret ? maskSecret(creds.secret) : '(空)'} 来源=${creds.source}`
      : `未配置${creds.missing ? `（缺 ${creds.missing.join('、')}）` : ''}`,
    'wxmp config set --appid <AppID> --secret <AppSecret>',
  )

  push(
    'token 缓存',
    true,
    fs.existsSync(tokenPath()) ? `有（${tokenPath()}）` : '无（第一次调用会自动获取）',
  )

  if (creds.appid && creds.secret) {
    try {
      const client = WechatClient.fromCredentials(creds)
      const token = await client.accessToken()
      push('接口连通', true, `stable_token 成功（token ${token.slice(0, 8)}…）`)
      try {
        const counts = await client.countDrafts()
        const total = counts.total_count ?? counts.total ?? 0
        push('草稿接口', true, `draft/count 成功，当前草稿 ${total} 条`)
      } catch (error) {
        const hint = error instanceof WechatApiError ? apiHint(error.errcode) : ''
        push('草稿接口', false, error.message, hint || '检查公众号类型与接口权限')
      }
    } catch (error) {
      const hint = error instanceof WechatApiError ? apiHint(error.errcode) : ''
      push('接口连通', false, error.message, hint || '检查 AppID/AppSecret 与 IP 白名单')
    }
  } else {
    push('接口连通', false, '没有凭据，跳过在线检查', 'wxmp config set --appid ... --secret ...')
  }

  let themesOk = true
  push('主题', themesOk, Object.keys(THEMES).join(' / '))

  if (process.platform === 'win32') {
    let gdiOk = false
    let detail = '未测试'
    try {
      const theme = THEMES.default
      const { buildGdiScript } = await import('../tools/cover.js')
      const tmpDir = path.join(homeDir(), 'tmp')
      fs.mkdirSync(tmpDir, { recursive: true })
      const outPath = path.join(tmpDir, 'doctor-cover.png')
      const result = await renderCover({ title: '封面渲染自检', subtitle: 'wxmp doctor', theme: theme === THEMES.default ? 'default' : 'default', outPath, workDir: tmpDir })
      gdiOk = result.method === 'gdi'
      detail = `方式=${result.method} ${humanBytes(result.bytes)}`
      void buildGdiScript
      try {
        fs.unlinkSync(outPath)
      } catch {
        /* ignore */
      }
    } catch (error) {
      detail = error.message
    }
    push('封面渲染', gdiOk, detail, gdiOk ? '' : '会回退成不带文字的纯渐变封面')
  }

  const lines = ['wxmp doctor', rule()]
  for (const check of checks) {
    lines.push(`${check.ok ? '✔' : '✘'} ${check.name}: ${check.detail}`)
    if (!check.ok && check.fix) lines.push(`  修复: ${check.fix}`)
  }
  lines.push(`配置: ${configPath()}`)
  const allOk = checks.every((check) => check.ok || check.name === '接口连通' || check.name === '封面渲染')
  const result = ok({ checks, ok: checks.every((c) => c.ok) }, lines.join('\n'))
  return allOk ? result : { ...result, ok: false, exitCode: 1 }
}

/* ------------------------------------------------------------------ */
/* 帮助                                                                */
/* ------------------------------------------------------------------ */

const HELP = `wxmp — 微信公众号文章制作与发布 CLI

准备:
  wxmp config set --appid <AppID> --secret <AppSecret>
  wxmp doctor

写文章:
  wxmp article new --title "标题" [--author 作者] [--theme default|dark|magazine]
  wxmp article list
  wxmp article show   --file <文章.md>
  wxmp article check  --file <文章.md>
  wxmp article review --file <文章.md> [--min-score 80] [--json]
  wxmp article preview --file <文章.md> [--open]
  wxmp article set-title  --file <文章.md> --title "新标题"
  wxmp article set-author --file <文章.md> --author "作者名"   （--author "" 即清空）

稿件体检（写完之后给 AI 看的那一份）:
  article check 只回答「能不能发」（硬限制有没有超）。
  article review 回答「写得好不好」：0~100 打分 + 每条问题带**行号**和**改法**。
  --min-score N：分数低于 N 时退出码 1，方便脚本/AI 循环「改→再体检」直到过线。
  分项权重: 限制 30 / 结构 25 / 可读 25 / 素材 20；任一硬限制超标则「限制」项直接 0 分。
  规则阈值集中在 src/review.js 的 THRESHOLDS，要调风格只改那一处。

封面:
  wxmp cover --file <文章.md> [--theme ...] [--subtitle ...] [--badge ...] [--out cover.png]

草稿:
  wxmp draft create --file <文章.md> [--dry-run]
  wxmp draft list [--offset 0] [--count 20] [--full]
  wxmp draft get    --media-id <id>
  wxmp draft update --file <文章.md> [--media-id <id>] [--index 0]
  wxmp draft delete --media-id <id>
  wxmp draft count

发布:
  wxmp publish submit --file <文章.md> [--yes]
  wxmp publish status --publish-id <id>
  wxmp publish wait   --publish-id <id> [--timeout 120000]
  wxmp publish list   [--offset 0] [--count 20]
  wxmp publish delete --article-id <id> [--yes]

全局: --json  --verbose  --base-url <url>（自测用）

说明: 不写 --yes 一律 dry-run；发布是异步任务，提交后用 publish wait 查结果。
${ARTICLE_TEMPLATE_HELP}`

/**
 * 探测 AI 配图能力：面板/脚本在点按钮之前用它判断「现在能不能用 AI 出图」。
 * 不联网、不花额度，只看本地配了哪些 key。
 */
async function imageProvidersCmd() {
  const info = describeImageProviders()
  if (!info.available) {
    return ok(
      { ...info },
      [
        'AI 配图未配置：没有任何可用的图片供应商 key。',
        '',
        '配一种就能用（任选）：',
        '  1) 环境变量：$env:WXMP_IMG_OPENAI / WXMP_IMG_GEMINI / WXMP_IMG_DOUBAO …',
        '  2) config.json 里写 imageKeys: { "<供应商>": "<key>" }',
        '',
        '没有 key 时封面仍可用：--bg 传自己的底图，或让它回落渐变。',
      ].join('\n'),
    )
  }
  return ok(
    { ...info },
    [
      `AI 配图可用：${info.providers.length} 家已配置（${info.note}）`,
      ...info.providers.map((item) => `  · ${item.providerId}${item.model ? `（${item.model}）` : ''}${item.baseUrl ? ` @ ${item.baseUrl}` : ''}`),
      '',
      '用法：wxmp cover --file <文章> --image-gen [供应商] [--width 900 --height 383] [--prompt "画面描述"]',
      '尺寸默认推荐 900×383（2.35:1，微信大图封面档），加 --width/--height 可改。',
      '--prompt 写什么就提交什么，不再追加任何约束。',
    ].join('\n'),
  )
}

export const COMMANDS = {
  config: configCmd,
  article: articleCmd,
  // 顶层简写：`wxmp import <url>` 等价于 `wxmp article import <url>`
  import: async (positional, flags) => articleCmd(['import', ...positional], flags),
  cover: coverCmd,
  'image-providers': imageProvidersCmd,
  draft: draftCmd,
  publish: publishCmd,
  doctor: async () => doctorCmd(),
  help: async () => ok({ commands: Object.keys(COMMANDS) }, HELP),
}

export async function dispatch(command, positional, flags) {
  const handler = COMMANDS[command]
  if (!handler) {
    throw new CliError('unknown_command', `未知命令: ${command}\n\n${HELP}`, 2)
  }
  try {
    return await handler(positional, flags)
  } catch (error) {
    throw wrapError(error)
  }
}

export { HELP }
