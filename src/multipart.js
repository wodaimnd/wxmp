/**
 * multipart/form-data 编码器。
 *
 * 为什么不用第三方库：整个项目零依赖，而 Node 自带的 FormData 配合 fetch
 * 会把中文文件名按 RFC 5987 编码，微信侧对 filename 只认 latin1/utf8 原样；
 * 这里自己拼字节流反而更可控，也方便单测。
 */

export class MultipartError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MultipartError'
    this.code = 'multipart_error'
  }
}

/**
 * @param {{boundary?: string, fields?: Record<string, string|number|boolean>, files?: Array<{name: string, filename: string, contentType?: string, data: Buffer}>}} parts
 * @returns {{body: Buffer, contentType: string}}
 */
export function encodeMultipart(parts = {}) {
  const boundary = parts.boundary || `wxmp-${Math.random().toString(36).slice(2)}-${Date.now()}`
  const chunks = []

  for (const [name, value] of Object.entries(parts.fields || {})) {
    if (value === undefined || value === null) continue
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${escapeName(name)}"\r\n` +
          'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
          `${String(value)}\r\n`,
        'utf8',
      ),
    )
  }

  for (const file of parts.files || []) {
    if (!file || !file.data) throw new MultipartError(`文件 ${file && file.filename} 没有内容`)
    const filename = escapeName(file.filename || 'file')
    const contentType = file.contentType || guessContentType(filename)
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${escapeName(file.name)}"; filename="${filename}"\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
        'utf8',
      ),
    )
    chunks.push(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data))
    chunks.push(Buffer.from('\r\n', 'utf8'))
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

function escapeName(name) {
  return String(name).replace(/["\r\n]/g, '_')
}

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.amr': 'audio/amr',
  '.mp4': 'video/mp4',
}

export function guessContentType(filename) {
  const ext = String(filename || '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || ''
  return CONTENT_TYPES[ext] || 'application/octet-stream'
}
