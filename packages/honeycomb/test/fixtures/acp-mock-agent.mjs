#!/usr/bin/env node
/**
 * ACP (Agent Client Protocol) mock agent —— 跑在子进程里，按 ACP JSON-RPC 协议
 * 与父进程通信。用于 honeycomb ACP adapter 的生命周期测试。
 *
 * 协议流程：
 *   1. 父进程写入 {"jsonrpc":"2.0","id":1,"method":"initialize",...}
 *   2. 子进程回 {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,...}}
 *   3. 父进程写入 {"jsonrpc":"2.0","id":2,"method":"session/new",...}
 *   4. 子进程回 {"jsonrpc":"2.0","id":2,"result":{"sessionId":"mock-session"}}
 *   5. 父进程写入 {"jsonrpc":"2.0","id":3,"method":"session/prompt",...}
 *   6. 子进程发 notification {"method":"session/update","params":{"update":...}}
 *      多次（stream chunks、tool-call、tool-result），再回 {"id":3,"result":{"stopReason":"end_turn"}}
 *   7. 处理完 prompt 后子进程自动退出（避免父进程永远 hang 在 stdin 'end'）。
 *
 * 也支持 `session/cancel` 通知：父进程发出后，mock 会在当前 chunk 循环中
 * 跳出，并以 `stopReason: "cancelled"` 响应 in-flight prompt。
 *
 * 行为可通过环境变量定制：
 *   - ACP_MOCK_FAIL_AFTER=<n>：第 n 个 chunk 后停止响应（用于测试故障路径）
 *   - ACP_MOCK_EMIT_TOOLCALL=1：除 stream chunks 外还发一条 tool_call + tool_result
 *   - ACP_MOCK_EMIT_IMAGE=1：在第 1 个 stream chunk 之后插一条 agent_message_chunk
 *     携带 image content（PNG base64），用于测试 image 透传
 *   - ACP_MOCK_DELAY_MS=<n>：每条消息间隔 n ms（默认 5）
 *   - ACP_MOCK_KEEP_ALIVE=1：处理完 prompt 后不退出（用于 live 测试）
 *   - ACP_MOCK_CANCEL_AFTER=<n>：在发出第 n 个 chunk 后，假装收到 session/cancel
 *     并提前结束 turn（无需父进程真的发通知，用于纯 mock 端的取消测试）
 */

import { setTimeout as sleep } from 'node:timers/promises'

const failAfter = Number(process.env.ACP_MOCK_FAIL_AFTER ?? Infinity)
const emitToolcall = process.env.ACP_MOCK_EMIT_TOOLCALL === '1'
const emitImage = process.env.ACP_MOCK_EMIT_IMAGE === '1'
const delayMs = Number(process.env.ACP_MOCK_DELAY_MS ?? 5)
const keepAlive = process.env.ACP_MOCK_KEEP_ALIVE === '1'
const cancelAfter = Number(process.env.ACP_MOCK_CANCEL_AFTER ?? Infinity)

let buffered = ''
let exited = false
let cancelRequested = false

process.stdin.on('data', (chunk) => {
  buffered += chunk.toString('utf8')
  processBuffer()
})

process.stdin.on('end', () => {
  // 父进程关闭 stdin —— 兜底也 flush 一次
  processBuffer(true)
})

async function processBuffer(forceExit = false) {
  let nlIdx
  while ((nlIdx = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, nlIdx).trim()
    buffered = buffered.slice(nlIdx + 1)
    if (!line) continue
    let req
    try {
      req = JSON.parse(line)
    } catch {
      continue
    }
    try {
      await handle(req)
    } catch (err) {
      writeRpc({ id: req.id, error: { code: -32000, message: err.message ?? String(err) } })
    }
  }
  if (forceExit && !keepAlive) doExit()
}

function doExit() {
  if (exited) return
  exited = true
  // 写完所有响应后再退，给 stdout 一点 flush 时间
  setImmediate(() => process.exit(0))
}

function writeRpc(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function writeNotification(method, params) {
  writeRpc({ jsonrpc: '2.0', method, params })
}

async function handle(req) {
  switch (req.method) {
    case 'initialize': {
      writeRpc({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          agentInfo: { name: 'acp-mock', version: '0.0.1' },
        },
      })
      return
    }
    case 'session/new': {
      writeRpc({
        jsonrpc: '2.0',
        id: req.id,
        result: { sessionId: 'mock-session-' + Date.now() },
      })
      return
    }
    case 'session/prompt': {
      cancelRequested = false
      // emit a few stream chunks
      const chunks = ['Hello', ', ', 'world', '!']
      let i = 0
      for (const c of chunks) {
        if (i >= failAfter) break
        if (cancelRequested || i >= cancelAfter) break
        writeNotification('session/update', {
          sessionId: req.params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: c },
          },
        })
        i++
        // 第一条 stream chunk 之后插一条 image chunk（如果开启）
        if (emitImage && i === 1) {
          writeNotification('session/update', {
            sessionId: req.params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'image',
                data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
                mimeType: 'image/png',
              },
            },
          })
          if (delayMs) await sleep(delayMs)
        }
        if (delayMs) await sleep(delayMs)
      }
      if (emitToolcall && !cancelRequested && i < failAfter && i < cancelAfter) {
        writeNotification('session/update', {
          sessionId: req.params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-1',
            title: 'echo',
            name: 'echo',
            status: 'pending',
            content: [],
            rawInput: { text: 'ping' },
          },
        })
        await sleep(delayMs)
        writeNotification('session/update', {
          sessionId: req.params.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-1',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'pong' } }],
            rawOutput: { text: 'pong' },
          },
        })
      }
      const stopReason = cancelRequested || i >= cancelAfter ? 'cancelled' : 'end_turn'
      writeRpc({
        jsonrpc: '2.0',
        id: req.id,
        result: { stopReason },
      })
      // 测试场景：处理完一个 prompt 就退出，让父进程能稳定地 close。
      // live 测试可通过 ACP_MOCK_KEEP_ALIVE=1 保持存活。
      if (!keepAlive) doExit()
      return
    }
    case 'session/cancel': {
      // 通知，无 id；触发 in-flight prompt 的提早结束。
      cancelRequested = true
      return
    }
    default:
      writeRpc({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32601, message: 'method not found: ' + req.method },
      })
  }
}