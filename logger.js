/**
 * 插件运行日志 —— 单一文件、按大小轮转、写失败不拖垮业务。
 *
 * 为什么需要它：这个插件的故障几乎都不是「当场报错」，而是「几天后才发现不对劲」——
 * 面板显示「后台未响应」、工具从列表里消失、draft create 写了 media_id 但 publish 拿不到。
 * 现场如果没留下痕迹，事后只能靠复现，而很多问题不可复现。Electron 宿主里 console 看不到，
 * 所以必须落盘。
 *
 * 与 winpilot 的 logger 同一套约定，三条硬规则：
 *  1. **日志永远不能把插件弄坏**：任何写盘异常都被吞掉并返回 false。
 *  2. **落点跟随状态目录**：与 CLI 自己的 logs/ 同基准，用户清缓存时一起清掉。
 *  3. **按大小轮转**：超过 maxBytes 滚成 .1/.2/.3，不把磁盘写满。
 *
 * 格式：`2026-11-05T09:12:31.123Z  INFO   [wxmp] /api/wxmp 已挂载 {"pid":14428}`。
 */

import fs from 'node:fs'
import path from 'node:path'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * @param {object} options
 * @param {() => string} options.dir 现算日志目录（配置改了立刻生效）
 * @param {string} [options.fileName='plugin.log']
 * @param {number} [options.maxBytes=2MB]
 * @param {number} [options.maxFiles=3] 轮转保留份数（.1 / .2 / .3）
 * @param {string} [options.minLevel='info']
 * @param {string} [options.tag=''] 行内标签，例如 'wxmp'
 * @param {(level: string, line: string) => void} [options.mirror] 同时往宿主 logger 镜像
 */
export function createLogger(options = {}) {
  const dirOf = typeof options.dir === 'function' ? options.dir : () => options.dir || ''
  const fileName = options.fileName || 'plugin.log'
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : 2 * 1024 * 1024
  const maxFiles = Number(options.maxFiles) > 0 ? Number(options.maxFiles) : 3
  const minLevel = LEVELS[options.minLevel] !== undefined ? options.minLevel : 'info'
  const tag = options.tag ? `[${options.tag}] ` : ''
  const mirror = typeof options.mirror === 'function' ? options.mirror : null

  /** 把当前文件滚成 .1、.1 → .2 …… 失败就跳过（下一个周期还能写）。 */
  function rotate(file) {
    try {
      for (let i = maxFiles; i >= 1; i -= 1) {
        const from = i === 1 ? file : `${file}.${i - 1}`
        const to = `${file}.${i}`
        if (fs.existsSync(from)) {
          if (i === maxFiles && fs.existsSync(to)) fs.rmSync(to, { force: true })
          fs.renameSync(from, to)
        }
      }
      return true
    } catch {
      return false
    }
  }

  function write(level, message, meta) {
    const threshold = LEVELS[minLevel] ?? LEVELS.info
    if ((LEVELS[level] ?? LEVELS.info) < threshold) return false

    const dir = String(dirOf() || '')
    if (!dir) return false

    let text
    try {
      const extra = meta === undefined ? '' : ` ${safeJson(meta)}`
      text = maskSecrets(`${new Date().toISOString()}  ${level.toUpperCase().padEnd(5)} ${tag}${String(message)}${extra}\n`)
    } catch {
      text = maskSecrets(`${new Date().toISOString()}  ${level.toUpperCase().padEnd(5)} ${tag}${String(message)}\n`)
    }

    const file = path.join(dir, fileName)
    try {
      fs.mkdirSync(dir, { recursive: true })
      let size = 0
      try {
        size = fs.statSync(file).size
      } catch {
        size = 0
      }
      if (size >= maxBytes) rotate(file)
      fs.appendFileSync(file, text, 'utf8')
    } catch {
      // 写不进就不写：日志不是主功能，绝不允许它抛到调用方
      if (mirror) {
        try {
          mirror(level, String(message))
        } catch {
          /* 镜像也失败就算了 */
        }
      }
      return false
    }

    if (mirror) {
      try {
        mirror(level, String(message))
      } catch {
        /* 镜像失败不影响文件日志 */
      }
    }
    return true
  }

  return {
    dir: () => String(dirOf() || ''),
    file: () => {
      const dir = String(dirOf() || '')
      return dir ? path.join(dir, fileName) : ''
    },
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
    /** 读回最近 N 行（面板「最近日志」用；读不到返回空数组，不抛）。 */
    tail: (lines = 40) => {
      const dir = String(dirOf() || '')
      if (!dir) return []
      try {
        const text = fs.readFileSync(path.join(dir, fileName), 'utf8')
        return text.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, lines))
      } catch {
        return []
      }
    },
    /** 清空（面板「清除本插件数据」用）。轮转文件一并清掉。 */
    clear: () => {
      const dir = String(dirOf() || '')
      if (!dir) return false
      try {
        const file = path.join(dir, fileName)
        for (let i = 0; i <= maxFiles; i += 1) {
          const target = i === 0 ? file : `${file}.${i}`
          if (fs.existsSync(target)) fs.rmSync(target, { force: true })
        }
        return true
      } catch {
        return false
      }
    },
  }
}

/**
 * 把整行文字里的密钥盖掉。
 *
 * 为什么不能只靠 safeJson 的 key 判断：面板与工具把命令组装成 argv 字符串落盘，
 * `config set --appid wx... --secret b54e4c...` 里的 secret 是**值**、不是键，
 * key 里没有 "secret" 字样，按 key 打码整条漏过去。实测就漏过一次。
 */
export function maskSecrets(text) {
  return String(text)
    .replace(/(--secret[\s=]+)(\S+)/gi, (match, head) => `${head}****`)
    .replace(/(--value[\s=]+)(\S+)/gi, (match, head) => `${head}****`)
    .replace(/(secret["']?\s*[:=]\s*["']?)([A-Za-z0-9_-]{6,})/gi, (match, head) => `${head}****`)
    .replace(/([?&]secret=)([^&\s"']+)/gi, (match, head) => `${head}****`)
    .replace(/(--appid[\s=]+)(\S{6,})/gi, (match, head, value) => `${head}${value.slice(0, 4)}****`)
}

/** JSON 化时对长字符串与 Error 做收敛，避免一条日志几十 KB；密钥一律打码。 */
function safeJson(value) {
  try {
    return JSON.stringify(value, (key, item) => {
      if (item instanceof Error) return `${item.name}: ${item.message}`
      if (typeof item === 'string' && /secret/i.test(key)) return `${item.slice(0, 4)}***`
      if (typeof item === 'string' && item.length > 400) return `${item.slice(0, 400)}…`
      return item
    })
  } catch {
    return '"[unserializable]"'
  }
}
