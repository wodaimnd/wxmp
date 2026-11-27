/**
 * 测试用的「假微信公众平台」：一个说微信 API 协议的 HTTP 服务端。
 *
 * 覆盖 stable_token / uploadimg / add_material / draft/* / freepublish/*
 * 的关键行为，让整条链路（渲染 → 上传 → 草稿 → 发布 → 轮询）在没有真实
 * 公众号、没有外网的环境里也能端到端跑。
 *
 * 刻意模拟真实坑：
 *  - 错误以 HTTP 200 + errcode 返回；
 *  - 首次稳定 token 会过期一次（errCode 40001），逼客户端走刷新重试；
 *  - draft/add 不带 thumb_media_id 就报 53503；
 *  - 正文里出现非 mmbiz 外链图片就报 45166（模拟正文过滤）。
 */

import http from 'node:http'
import crypto from 'node:crypto'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

export async function startFakeWechat(options = {}) {
  const state = {
    drafts: new Map(),
    published: new Map(),
    mediaCounter: 0,
    publishCounter: 1770000000,
    uploads: [],
    calls: [],
    tokens: new Set(),
    expireNextToken: options.expireNextToken === true,
    /** 下一次 draft/add 或 draft/update 回 40007（封面素材失效），只吃一次 */
    rejectNextDraft: false,
    /** 模拟发布 3 秒后成功 */
    publishDelayMs: options.publishDelayMs ?? 3000,
    publishOutcome: options.publishOutcome || 0,
  }

  // 已应答的哨兵：必须返回**真值**。
  // 原来 json()/fail() 返回 undefined，于是 `const blocked = requireToken(); if (blocked) return blocked`
  // 永远不成立 —— token 校验形同不存在，而且请求会继续往下走，导致同一连接被写第二次响应
  // （ERR_HTTP_HEADERS_SENT，测试结束后冒出来，把整个套件钉成 exit 1）。
  const SENT = Symbol('responded')
  const json = (res, status, payload) => {
    if (res.writableEnded || res.headersSent) return SENT
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
    return SENT
  }
  const fail = (res, errcode, errmsg) => json(res, 200, { errcode, errmsg })

  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks)))
    })

  const parseMultipart = (buffer, contentType) => {
    const boundary = (contentType.match(/boundary=(.+)$/i) || [])[1]
    if (!boundary) return { fields: {}, files: [] }
    const delimiter = Buffer.from(`--${boundary}`)
    const fields = {}
    const files = []
    let offset = 0
    while (true) {
      const start = buffer.indexOf(delimiter, offset)
      if (start < 0) break
      const next = buffer.indexOf(delimiter, start + delimiter.length)
      if (next < 0) break
      const part = buffer.subarray(start + delimiter.length + 2, next - 2)
      offset = next
      const headerEnd = part.indexOf('\r\n\r\n')
      if (headerEnd < 0) continue
      const headers = part.subarray(0, headerEnd).toString('utf8')
      const body = part.subarray(headerEnd + 4)
      const nameMatch = /name="([^"]+)"/.exec(headers)
      const filenameMatch = /filename="([^"]+)"/.exec(headers)
      if (filenameMatch) {
        files.push({ name: nameMatch ? nameMatch[1] : 'media', filename: filenameMatch[1], data: body })
      } else if (nameMatch) {
        fields[nameMatch[1]] = body.toString('utf8')
      }
    }
    return { fields, files }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const pathname = url.pathname
    const token = url.searchParams.get('access_token') || ''
    const raw = await readBody(req)
    let body = {}
    if (raw.length && /application\/json/i.test(req.headers['content-type'] || '')) {
      try {
        body = JSON.parse(raw.toString('utf8'))
      } catch {
        return fail(res, 44002, 'invalid json')
      }
    }
    state.calls.push({ path: pathname, method: req.method, body: JSON.parse(JSON.stringify(body)) })

    const requireToken = () => {
      if (!token) return fail(res, 41001, 'access_token missing')
      if (!state.tokens.has(token)) return fail(res, 40001, 'invalid credential, access_token is invalid')
      return null
    }

    // ---------- token ----------
    if (pathname === '/cgi-bin/stable_token') {
      if (req.method !== 'POST') return fail(res, 43002, 'require POST method')
      const appid = String(body.appid || '')
      const secret = String(body.secret || '')
      if (!appid) return fail(res, 41002, 'appid missing')
      if (!secret) return fail(res, 41004, 'appsecret missing')
      if (secret !== (options.secret || 'test-secret')) return fail(res, 40125, 'invalid appsecret')
      const fresh = `tok_${crypto.randomBytes(6).toString('hex')}`
      state.tokens.add(fresh)
      if (state.expireNextToken) {
        // 第一次拿到的 token 立刻作废，逼客户端走 40001 → force_refresh 重试
        state.expireNextToken = false
        state.tokens.delete(fresh)
        return json(res, 200, { access_token: fresh, expires_in: 7200 })
      }
      return json(res, 200, { access_token: fresh, expires_in: 7200 })
    }

    // ---------- 素材上传 ----------
    if (pathname === '/cgi-bin/media/uploadimg' || pathname === '/cgi-bin/material/add_material') {
      const blocked = requireToken()
      if (blocked) return blocked
      const { files } = parseMultipart(raw, req.headers['content-type'] || '')
      const file = files[0]
      if (!file) return fail(res, 40005, 'invalid file type')
      const isPermanent = pathname.includes('add_material')
      const type = url.searchParams.get('type') || 'image'
      if (isPermanent && type !== 'image') return fail(res, 40005, 'invalid media type')
      if (!isPermanent && file.data.length > 1024 * 1024) return fail(res, 40009, 'invalid image size')
      state.mediaCounter += 1
      const id = `media_${state.mediaCounter}`
      state.uploads.push({ kind: isPermanent ? 'permanent' : 'content', filename: file.filename, bytes: file.data.length })
      if (isPermanent) {
        return json(res, 200, {
          media_id: id,
          url: `http://mmbiz.qpic.cn/${id}.jpg`,
        })
      }
      return json(res, 200, { url: `http://mmbiz.qpic.cn/${id}.png`, errcode: 0, errmsg: 'ok' })
    }

    // ---------- 草稿 ----------
    if (pathname === '/cgi-bin/draft/add' || pathname === '/cgi-bin/draft/update') {
      // 模拟"封面素材在后台被删了"：下一次草稿写入回 40007，
      // 用来验证客户端会不会重新上传封面而不是把错误丢给用户。
      if (state.rejectNextDraft) {
        state.rejectNextDraft = false
        return fail(res, 40007, 'invalid media_id')
      }
    }

    if (pathname === '/cgi-bin/draft/add') {
      const blocked = requireToken()
      if (blocked) return blocked
      const articles = Array.isArray(body.articles) ? body.articles : []
      if (!articles.length) return fail(res, 44003, 'empty news data')
      for (const article of articles) {
        if (!article.title) return fail(res, 44004, 'empty title')
        if (article.article_type === 'news' && !article.thumb_media_id) {
          return fail(res, 53503, '该草稿未通过发布检查（缺封面 thumb_media_id）')
        }
        if (article.content && /<img[^>]+src="(?!http:\/\/mmbiz|https:\/\/mmbiz)/i.test(article.content)) {
          return fail(res, 45166, 'invalid content（正文图片必须来自 mmbiz）')
        }
      }
      state.mediaCounter += 1
      const mediaId = `draft_${state.mediaCounter}`
      state.drafts.set(mediaId, {
        media_id: mediaId,
        update_time: Math.floor(Date.now() / 1000),
        content: { news_item: articles.map((article) => ({ ...article, url: `http://mp.weixin.qq.com/s/${mediaId}` })) },
      })
      return json(res, 200, { media_id: mediaId })
    }

    if (pathname === '/cgi-bin/draft/batchget') {
      const blocked = requireToken()
      if (blocked) return blocked
      const offset = Number(body.offset) || 0
      const count = Math.min(20, Math.max(1, Number(body.count) || 20))
      const all = [...state.drafts.values()]
      const page = all.slice(offset, offset + count).map((item) => ({
        media_id: item.media_id,
        update_time: item.update_time,
        content: body.no_content
          ? { news_item: item.content.news_item.map((n) => ({ title: n.title })) }
          : item.content,
      }))
      return json(res, 200, { total_count: all.length, item_count: page.length, item: page })
    }

    if (pathname === '/cgi-bin/draft/get') {
      const blocked = requireToken()
      if (blocked) return blocked
      const item = state.drafts.get(String(body.media_id || ''))
      if (!item) return fail(res, 40007, 'invalid media_id')
      return json(res, 200, item.content.__proto__ ? { ...item.content } : item.content)
    }

    if (pathname === '/cgi-bin/draft/update') {
      const blocked = requireToken()
      if (blocked) return blocked
      const item = state.drafts.get(String(body.media_id || ''))
      if (!item) return fail(res, 40007, 'invalid media_id')
      const index = Number(body.index) || 0
      if (index >= item.content.news_item.length) return fail(res, 40114, 'invalid index value')
      if (/<img[^>]+src="(?!http:\/\/mmbiz|https:\/\/mmbiz)/i.test(String(body.articles?.content || ''))) {
        return fail(res, 45166, 'invalid content')
      }
      item.content.news_item[index] = { ...item.content.news_item[index], ...(body.articles || {}) }
      item.update_time = Math.floor(Date.now() / 1000)
      return json(res, 200, { errcode: 0, errmsg: 'ok' })
    }

    if (pathname === '/cgi-bin/draft/delete') {
      const blocked = requireToken()
      if (blocked) return blocked
      const mediaId = String(body.media_id || '')
      if (!state.drafts.has(mediaId)) return fail(res, 40007, 'invalid media_id')
      state.drafts.delete(mediaId)
      return json(res, 200, { errcode: 0, errmsg: 'ok' })
    }

    if (pathname === '/cgi-bin/draft/count') {
      const blocked = requireToken()
      if (blocked) return blocked
      return json(res, 200, { total_count: state.drafts.size })
    }

    // ---------- 发布 ----------
    if (pathname === '/cgi-bin/freepublish/submit') {
      const blocked = requireToken()
      if (blocked) return blocked
      const mediaId = String(body.media_id || '')
      if (!state.drafts.has(mediaId)) return fail(res, 40007, 'invalid media_id')
      state.publishCounter += 1
      const publishId = String(state.publishCounter)
      const draft = state.drafts.get(mediaId)
      state.published.set(publishId, {
        publish_id: publishId,
        publish_status: 1,
        media_id: mediaId,
        drafts: draft.content.news_item.map((item) => ({ ...item })),
        readyAt: Date.now() + state.publishDelayMs,
      })
      return json(res, 200, { errcode: 0, errmsg: 'ok', publish_id: publishId })
    }

    if (pathname === '/cgi-bin/freepublish/get') {
      const blocked = requireToken()
      if (blocked) return blocked
      const publishId = String(body.publish_id || '')
      const job = state.published.get(publishId)
      if (!job) return fail(res, 40007, 'invalid publish_id')
      if (job.publish_status === 1 && Date.now() >= job.readyAt) {
        if (state.publishOutcome === 0) {
          job.publish_status = 0
          job.article_id = `art_${publishId}`
          job.article_detail = {
            count: job.drafts.length,
            item: job.drafts.map((item, index) => ({
              idx: index + 1,
              article_url: `http://mp.weixin.qq.com/s/${publishId}`,
            })),
          }
          // 成功发布后草稿会被移除（真实行为）
          state.drafts.delete(job.media_id)
        } else {
          job.publish_status = state.publishOutcome
          job.fail_idx = [1]
        }
      }
      return json(res, 200, {
        publish_id: publishId,
        publish_status: job.publish_status,
        ...(job.article_id ? { article_id: job.article_id } : {}),
        ...(job.article_detail ? { article_detail: job.article_detail } : {}),
        ...(job.fail_idx ? { fail_idx: job.fail_idx } : {}),
      })
    }

    if (pathname === '/cgi-bin/freepublish/batchget') {
      const blocked = requireToken()
      if (blocked) return blocked
      const done = [...state.published.values()].filter((job) => job.publish_status === 0)
      return json(res, 200, {
        total_count: done.length,
        item_count: done.length,
        item: done.map((job) => ({
          article_id: job.article_id,
          update_time: Math.floor(Date.now() / 1000),
          content: { news_item: job.drafts.map((item) => ({ ...item, url: `http://mp.weixin.qq.com/s/${job.publish_id}` })) },
        })),
      })
    }

    if (pathname === '/cgi-bin/freepublish/delete') {
      const blocked = requireToken()
      if (blocked) return blocked
      return json(res, 200, { errcode: 0, errmsg: 'ok' })
    }

    return fail(res, 404, `unknown endpoint: ${pathname}`)
  })

  await new Promise((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const port = server.address().port

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    secret: options.secret || 'test-secret',
    state,
    png: PNG_1X1,
    reset() {
      state.calls.length = 0
      state.uploads.length = 0
    },
    close() {
      return new Promise((resolve) => server.close(resolve))
    },
  }
}
