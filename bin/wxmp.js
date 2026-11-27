#!/usr/bin/env node
/**
 * wxmp CLI 入口。
 *
 * 约定与 winpilot 一致：
 *   默认打印 text（截断到 4000 字符）
 *   --json 打印 {ok, exitCode, data, text} 单行 JSON
 */

import { dispatch, HELP } from '../src/commands.js'
import { parseArgv } from '../src/args.js'
import { failure, truncate } from '../src/output.js'

const VERSION = '1.7.1'

const { command, positional, flags } = parseArgv(process.argv.slice(2))

function print(result) {
  if (flags.json === true) {
    const payload = {
      ok: result.ok,
      exitCode: result.exitCode,
      data: result.data,
      text: truncate(result.text),
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`)
    return
  }
  if (result.text) process.stdout.write(`${truncate(result.text)}\n`)
}

if (flags.version === true || command === 'version') {
  process.stdout.write(`wxmp ${VERSION}\n`)
  process.exitCode = 0
} else if (!command || flags.help === true || command === 'help') {
  process.stdout.write(`${HELP}\n`)
  process.exitCode = 0
} else {
  try {
    const result = await dispatch(command, positional, flags)
    print(result)
    process.exitCode = result.exitCode
  } catch (error) {
    const result = failure(error)
    print(result)
    process.exitCode = result.exitCode
  }
}
