/**
 * 参数解析：`wxmp <command> [sub] [positional...] [--flag value]`。
 * 与 winpilot 保持同一套约定，方便两个工具有一致的手感。
 */

const BOOLEAN_FLAGS = new Set([
  'json',
  'verbose',
  'help',
  'version',
  'force',
  'dry-run',
  'no-refresh',
  'keep-comments',
  'full',
  'raw',
  'open',
])

export function parseArgv(argv) {
  const tokens = [...argv]
  const positional = []
  const flags = {}

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const body = token.slice(2)
    if (!body) continue
    const eq = body.indexOf('=')
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }
    const next = tokens[i + 1]
    if (!BOOLEAN_FLAGS.has(body) && next !== undefined && !next.startsWith('--')) {
      flags[body] = next
      i += 1
      continue
    }
    flags[body] = true
  }

  const command = positional.shift() || ''
  return { command, positional, flags }
}

export function flagString(flags, name, fallback = '') {
  const raw = flags[name]
  return raw === undefined || raw === true ? fallback : String(raw)
}

export function flagNumber(flags, name, fallback) {
  const raw = flags[name]
  if (raw === undefined || raw === true) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

export function flagBool(flags, name) {
  return flags[name] === true
}
