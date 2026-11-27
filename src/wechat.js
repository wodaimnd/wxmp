/**
 * 微信公众平台 API 客户端（服务端接口，纯 HTTP + JSON）。
 *
 * 只覆盖「做文章 → 发文章」这条链路用得到的接口：
 *   稳定版 token     POST /cgi-bin/stable_token
 *   正文图片上传      POST /cgi-bin/media/uploadimg        （不占素材库配额，<1MB，jpg/png）
 *   永久图片素材      POST /cgi-bin/material/add_material  （封面 thumb_media_id 要用这个）
 *   新增草稿          POST /cgi-bin/draft/add
 *   更新草稿          POST /cgi-bin/draft/update
 *   草稿列表          POST /cgi-bin/draft/batchget
 *   草稿详情          POST /cgi-bin/draft/get
 *   删除草稿          POST /cgi-bin/draft/delete
 *   草稿计数          POST /cgi-bin/draft/count
 *   提交发布          POST /cgi-bin/freepublish/submit
 *   发布状态          POST /cgi-bin/freepublish/get
 *   已发布列表        POST /cgi-bin/freepublish/batchget
 *   删除发布          POST /cgi-bin/freepublish/delete
 *
 * 错误处理：微信用 HTTP 200 + errcode 报错，所以每个响应都要过 errcode 检查。
 * token 过期（40001/42001）自动刷新并重试一次。
 */

import fs from 'node:fs'
import path from 'node:path'

import { encodeMultipart, guessContentType } from './multipart.js'
import { readJson, tokenPath, writeJsonAtomic } from './state.js'

const API_BASE = 'https://api.weixin.qq.com'
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

export class WechatApiError extends Error {
  constructor(errcode, errmsg, endpoint, payload) {
    super(`[${errcode}] ${errmsg || 'unknown'}（接口 ${endpoint}）`)
    this.name = 'WechatApiError'
    this.errcode = errcode
    this.errmsg = errmsg
    this.endpoint = endpoint
    this.payload = payload
    this.code = `wechat_${errcode}`
  }
}

/** token 失效类错误码：刷新后重试一次。 */
const TOKEN_ERROR_CODES = new Set([40001, 40014, 42001])

export class WechatClient {
  constructor(options = {}) {
    this.appid = options.appid || ''
    this.secret = options.secret || ''
    this.baseUrl = options.baseUrl || API_BASE
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.timeoutMs = options.timeoutMs || 30000
    this.tokenStore = options.tokenStore || tokenPath()
    this.now = options.now || (() => Date.now())
    this.verbose = options.verbose === true
    this.log = options.log || (() => {})
    this._token = null
  }

  static fromCredentials(credentials, options = {}) {
    return new WechatClient({ ...options, appid: credentials.appid, secret: credentials.secret })
  }

  /* ---------------- token ---------------- */

  /** 读本地缓存的 token（未过期才用）。 */
  cachedToken() {
    if (this._token && this._token.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.now()) return this._token
    const cached = readJson(this.tokenStore, null)
    if (!cached || !cached.access_token || !cached.expires_at) return null
    if (cached.appid && cached.appid !== this.appid) return null
    if (Number(cached.expires_at) - TOKEN_REFRESH_MARGIN_MS <= this.now()) return null
    this._token = {
      access_token: cached.access_token,
      expiresAt: Number(cached.expires_at),
    }
    return this._token
  }

  async accessToken(options = {}) {
    if (!options.force) {
      const cached = this.cachedToken()
      if (cached) return cached.access_token
    }
    const result = await this.request('/cgi-bin/stable_token', {
      method: 'POST',
      body: {
        grant_type: 'client_credential',
        appid: this.appid,
        secret: this.secret,
        force_refresh: options.force === true,
      },
      token: null,
      raw: true,
    })
    // raw 模式不会过通用 errcode 检查，这里自己查一次：
    // 否则 40125（secret 错）会被当成「没返回 access_token」的 -1，掩盖真实原因。
    if (result && typeof result.errcode === 'number' && result.errcode !== 0) {
      throw new WechatApiError(result.errcode, result.errmsg, '/cgi-bin/stable_token', result)
    }
    const token = String(result.access_token || '')
    if (!token) throw new WechatApiError(-1, 'stable_token 没有返回 access_token', '/cgi-bin/stable_token', result)
    const expiresIn = Number(result.expires_in) || 7200
    this._token = { access_token: token, expiresAt: this.now() + expiresIn * 1000 }
    writeJsonAtomic(this.tokenStore, {
      appid: this.appid,
      access_token: token,
      expires_at: this._token.expiresAt,
      updated_at: this.now(),
    })
    this.log(`token 已刷新（有效期 ${expiresIn}s）`)
    return token
  }

  invalidateToken() {
    this._token = null
    writeJsonAtomic(this.tokenStore, { appid: this.appid, access_token: '', expires_at: 0, updated_at: this.now() })
  }

  /* ---------------- 底层请求 ---------------- */

  url(endpoint, token) {
    const base = `${this.baseUrl}${endpoint}`
    if (!token) return base
    return `${base}${base.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`
  }

  async rawRequest(url, init) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal })
      const text = await response.text()
      let json
      try {
        json = JSON.parse(text)
      } catch {
        throw new WechatApiError(
          -1,
          `响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`,
          url.split('?')[0],
        )
      }
      return { status: response.status, json }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 调用一个 JSON 接口。
   * @param {string} endpoint 以 / 开头的路径
   * @param {{method?: string, body?: unknown, token?: string|null, raw?: boolean, retryOnTokenError?: boolean}} options
   */
  async request(endpoint, options = {}) {
    const needsToken = options.token !== null
    let token = ''
    if (needsToken) token = options.token || (await this.accessToken())

    const init = {
      method: options.method || (options.body === undefined ? 'GET' : 'POST'),
      headers: {},
    }
    if (options.body !== undefined) {
      init.headers['content-type'] = 'application/json; charset=utf-8'
      // 微信对中文要求「不要用 \uXXXX 转义」——JSON.stringify 默认输出原始字符，正好符合。
      init.body = JSON.stringify(options.body)
    }

    const { status, json } = await this.rawRequest(this.url(endpoint, token), init)
    if (options.raw) return json

    if (json && typeof json.errcode === 'number' && json.errcode !== 0) {
      if (needsToken && !options.token && TOKEN_ERROR_CODES.has(json.errcode)) {
        // token 失效：清缓存、强制刷新、重试一次
        this.invalidateToken()
        const fresh = await this.accessToken({ force: true })
        const retry = await this.rawRequest(this.url(endpoint, fresh), init)
        if (retry.json && typeof retry.json.errcode === 'number' && retry.json.errcode !== 0) {
          throw new WechatApiError(retry.json.errcode, retry.json.errmsg, endpoint, retry.json)
        }
        return retry.json
      }
      throw new WechatApiError(json.errcode, json.errmsg, endpoint, json)
    }
    if (status >= 400) {
      throw new WechatApiError(-1, `HTTP ${status}`, endpoint, json)
    }
    return json
  }

  /** 上传一个文件（multipart）。token 失效时刷新并重试一次。 */
  async upload(endpoint, { field = 'media', filePath, filename, extraFields, extraQuery }) {
    const data = fs.readFileSync(filePath)
    const name = filename || path.basename(filePath)
    const { body, contentType } = encodeMultipart({
      fields: extraFields || {},
      files: [{ name: field, filename: name, contentType: guessContentType(name), data }],
    })

    const attempt = async (token) => {
      let url = this.url(endpoint, token)
      if (extraQuery) {
        for (const [key, value] of Object.entries(extraQuery)) {
          url += `&${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
        }
      }
      const { json } = await this.rawRequest(url, {
        method: 'POST',
        headers: { 'content-type': contentType, 'content-length': String(body.length) },
        body,
      })
      return json
    }

    let json = await attempt(await this.accessToken())
    if (json && typeof json.errcode === 'number' && TOKEN_ERROR_CODES.has(json.errcode)) {
      // 上传走的是另一条 token 路径，同样要清缓存重试，否则前端只会看到一次莫名失败
      this.invalidateToken()
      json = await attempt(await this.accessToken({ force: true }))
    }
    if (json && typeof json.errcode === 'number' && json.errcode !== 0) {
      throw new WechatApiError(json.errcode, json.errmsg, endpoint, json)
    }
    return json
  }

  /* ---------------- 素材 ---------------- */

  /** 正文内图片（不占素材库配额，jpg/png，<1MB）。 */
  uploadContentImage(filePath, filename) {
    return this.upload('/cgi-bin/media/uploadimg', { filePath, filename })
  }

  /** 永久图片素材（封面 thumb_media_id 用这个）。 */
  uploadPermanentImage(filePath, filename) {
    return this.upload('/cgi-bin/material/add_material', {
      filePath,
      filename,
      extraQuery: { type: 'image' },
    })
  }

  /* ---------------- 草稿 ---------------- */

  addDraft(articles) {
    return this.request('/cgi-bin/draft/add', { method: 'POST', body: { articles } })
  }

  updateDraft(mediaId, index, article) {
    return this.request('/cgi-bin/draft/update', {
      method: 'POST',
      body: { media_id: mediaId, index: Number(index) || 0, articles: article },
    })
  }

  listDrafts({ offset = 0, count = 20, noContent = true } = {}) {
    return this.request('/cgi-bin/draft/batchget', {
      method: 'POST',
      body: { offset: Number(offset) || 0, count: Math.min(20, Math.max(1, Number(count) || 20)), no_content: noContent ? 1 : 0 },
    })
  }

  getDraft(mediaId) {
    return this.request('/cgi-bin/draft/get', { method: 'POST', body: { media_id: mediaId } })
  }

  deleteDraft(mediaId) {
    return this.request('/cgi-bin/draft/delete', { method: 'POST', body: { media_id: mediaId } })
  }

  countDrafts() {
    return this.request('/cgi-bin/draft/count', { method: 'POST', body: {} })
  }

  /* ---------------- 发布 ---------------- */

  submitPublish(mediaId) {
    return this.request('/cgi-bin/freepublish/submit', { method: 'POST', body: { media_id: mediaId } })
  }

  getPublishStatus(publishId) {
    return this.request('/cgi-bin/freepublish/get', { method: 'POST', body: { publish_id: String(publishId) } })
  }

  listPublished({ offset = 0, count = 20, noContent = true } = {}) {
    return this.request('/cgi-bin/freepublish/batchget', {
      method: 'POST',
      body: { offset: Number(offset) || 0, count: Math.min(20, Math.max(1, Number(count) || 20)), no_content: noContent ? 1 : 0 },
    })
  }

  deletePublish(articleId, index = 0) {
    return this.request('/cgi-bin/freepublish/delete', {
      method: 'POST',
      body: { article_id: String(articleId), index: Number(index) || 0 },
    })
  }
}
