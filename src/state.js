/**
 * 本地配置与凭据管理。
 *
 * 目录优先级：
 *   1. WXMP_HOME（测试/插件用）
 *   2. %LOCALAPPDATA%\wxmp
 *   3. <cwd>\.wxmp（目录不可写时兜底）
 *
 * 凭据来源优先级（前一个非空就赢）：
 *   1. 环境变量 WXMP_APPID / WXMP_SECRET
 *   2. config.json 里的 appid / secret
 * 凭据只写进本地文件，不打印、不进入 --json 输出。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let cachedHome = ''
let cachedEnv = null

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.write-probe-${process.pid}`)
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

export function homeDir() {
  // 缓存必须对 WXMP_HOME 的变化敏感：同一个进程里跑多套测试时，
  // 各测试文件会切到不同的目录，写死第一次的结果就会串味。
  const override = process.env.WXMP_HOME || ''
  if (cachedHome && cachedEnv === override) return cachedHome
  cachedEnv = override
  if (override) {
    cachedHome = path.resolve(override)
    return cachedHome
  }
  const local = process.env.LOCALAPPDATA
  const preferred =
    process.platform === 'win32' && local ? path.join(local, 'wxmp') : path.join(os.homedir(), '.wxmp')
  cachedHome = writable(preferred) ? preferred : path.resolve(process.cwd(), '.wxmp')
  return cachedHome
}

export function resetHomeCache() {
  cachedHome = ''
  cachedEnv = null
}

export function configPath() {
  return path.join(homeDir(), 'config.json')
}

export function tokenPath() {
  return path.join(homeDir(), 'token.json')
}

export function articleDir() {
  const dir = path.join(homeDir(), 'articles')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function assetDir() {
  const dir = path.join(homeDir(), 'assets')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

export function loadConfig() {
  const config = readJson(configPath(), {})
  return config && typeof config === 'object' ? config : {}
}

export function saveConfig(patch) {
  const current = loadConfig()
  const next = { ...current, ...(patch || {}) }
  // imageKeys / imageProviders 是「按键累加」的配置：
  // 直接浅合并会让「配第二家的 key」把第一家冲掉，
  // 而用户以为是两家都在，直到某天第一家不生效才发现。
  if (patch && patch.imageKeys && typeof patch.imageKeys === 'object') {
    next.imageKeys = { ...(current.imageKeys || {}), ...patch.imageKeys }
    // 值为空字符串表示"删掉这一家"，不留在配置里占位
    for (const [key, value] of Object.entries(next.imageKeys)) {
      if (!value) delete next.imageKeys[key]
    }
    if (!Object.keys(next.imageKeys).length) delete next.imageKeys
  }
  writeJsonAtomic(configPath(), next)
  return next
}

/**
 * 解析有效凭据（不落盘、不打印）。
 * @returns {{appid: string, secret: string, source: string}}
 */
export function resolveCredentials() {
  const config = loadConfig()
  const envAppid = String(process.env.WXMP_APPID || '').trim()
  const envSecret = String(process.env.WXMP_SECRET || '').trim()
  if (envAppid && envSecret) return { appid: envAppid, secret: envSecret, source: 'env' }

  const appid = String(config.appid || '').trim()
  const secret = String(config.secret || '').trim()
  if (appid && secret) return { appid, secret, source: 'config' }

  const missing = []
  if (!appid && !envAppid) missing.push('appid')
  if (!secret && !envSecret) missing.push('secret')
  return { appid: '', secret: '', source: 'none', missing }
}

/**
 * 是否有可用凭据；有就返回，没有就抛带修复提示的错误。
 */
export function requireCredentials() {
  const creds = resolveCredentials()
  if (creds.appid && creds.secret) return creds
  const missing = creds.missing && creds.missing.length ? creds.missing.join('、') : 'appid、secret'
  const error = new Error(`缺少公众号凭据：${missing}`)
  error.code = 'credentials_missing'
  error.hint =
    '在微信公众平台「设置与开发 → 基本配置」拿到 AppID / AppSecret，然后执行：\n' +
    '  wxmp config set --appid <AppID> --secret <AppSecret>\n' +
    '或用环境变量 WXMP_APPID / WXMP_SECRET（不落盘）。'
  throw error
}

/** 打码后的 appid/secret，用于日志与 doctor。 */
export function maskSecret(value) {
  const text = String(value || '')
  if (!text) return '(空)'
  if (text.length <= 6) return `${text[0] || ''}***`
  return `${text.slice(0, 4)}***${text.slice(-2)}`
}

/** 清理旧 token 缓存（force-refresh 或出错时）。 */
export function clearTokenCache() {
  try {
    fs.unlinkSync(tokenPath())
  } catch {
    /* 本来就没有 */
  }
}
