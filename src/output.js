/**
 * 统一的结果结构与输出格式化。
 *
 * 所有命令都返回 {ok, exitCode, data, text}：
 *  - text 给模型/人看（紧凑、截断）
 *  - data 给程序/Agent 解析（--json）
 */

export const MAX_OUTPUT_CHARS = 4000

export class CliError extends Error {
  constructor(code, message, exitCode = 1, data) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.exitCode = exitCode
    this.data = data
  }
}

export function ok(data, text) {
  return { ok: true, exitCode: 0, data: data ?? {}, text: String(text ?? '') }
}

export function failure(error) {
  if (error instanceof CliError) {
    return {
      ok: false,
      exitCode: error.exitCode,
      data: { error: { code: error.code, message: error.message, ...(error.data || {}) } },
      text: `${error.code}: ${error.message}`,
    }
  }
  const code = (error && error.code) || 'internal_error'
  const message = (error && error.message) || String(error)
  return { ok: false, exitCode: 1, data: { error: { code, message } }, text: `${code}: ${message}` }
}

export function truncate(text, max = MAX_OUTPUT_CHARS) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n[truncated, originalLength=${value.length}]`
}

export function rule() {
  return '─'.repeat(34)
}

export function compactJson(value, max = 2000) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (text === undefined) text = 'null'
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 字节数 → 人类可读。 */
export function humanBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

/** 时间戳（秒）→ `YYYY-MM-DD HH:mm`。 */
export function humanTime(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return '-'
  const date = new Date(value * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** 微信正文限制：少于 2 万字符且小于 1M。 */
export const CONTENT_MAX_CHARS = 20000
export const CONTENT_MAX_BYTES = 1024 * 1024
export const TITLE_MAX = 32
export const AUTHOR_MAX = 16
export const DIGEST_MAX = 120
