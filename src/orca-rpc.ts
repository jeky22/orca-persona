import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'

export type RuntimeMetadata = { endpoint: string; authToken: string }

export class RpcUnavailableError extends Error {
  code = 'runtime_unavailable'
  constructor(message: string) {
    super(message)
    this.name = 'RpcUnavailableError'
  }
}

export class RpcCallError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message)
    this.name = 'RpcCallError'
  }
}

export type RpcCall = (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>

const DEFAULT_TIMEOUT_MS = 1500

export function defaultUserDataPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (env.ORCA_USER_DATA_PATH) return env.ORCA_USER_DATA_PATH
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'orca')
  if (platform === 'win32') {
    if (!env.APPDATA) throw new RpcUnavailableError('APPDATA is not set')
    return path.join(env.APPDATA, 'orca')
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'orca')
}

/** orca-runtime.json을 읽어 unix/named-pipe 엔드포인트를 고른다. 없거나 깨졌으면 throw RpcUnavailableError. */
export function readRuntimeMetadata(userDataPath: string): RuntimeMetadata {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(userDataPath, 'orca-runtime.json'), 'utf8'))
  } catch (e) {
    throw new RpcUnavailableError(`cannot read orca-runtime.json: ${(e as Error).message}`)
  }
  const meta = (parsed ?? {}) as { authToken?: unknown; transports?: unknown }
  if (typeof meta.authToken !== 'string' || !meta.authToken) {
    throw new RpcUnavailableError('orca-runtime.json has no authToken')
  }
  const transports = Array.isArray(meta.transports) ? meta.transports : []
  for (const t of transports) {
    const tr = (t ?? {}) as { kind?: unknown; endpoint?: unknown }
    if ((tr.kind === 'unix' || tr.kind === 'named-pipe') && typeof tr.endpoint === 'string' && tr.endpoint) {
      return { endpoint: tr.endpoint, authToken: meta.authToken }
    }
  }
  throw new RpcUnavailableError('orca-runtime.json has no unix/named-pipe transport')
}

/** 연결 → 한 줄 요청 → 응답 한 프레임(keepalive 무시) → 끝. 기본 timeout 1500ms. */
export function createRpcCall(metadata: () => RuntimeMetadata): RpcCall {
  return (method, params, timeoutMs = DEFAULT_TIMEOUT_MS) =>
    new Promise<unknown>((resolve, reject) => {
      let meta: RuntimeMetadata
      try {
        meta = metadata()
      } catch (e) {
        reject(e instanceof RpcUnavailableError ? e : new RpcUnavailableError((e as Error).message))
        return
      }
      const id = randomUUID()
      const socket = net.createConnection(meta.endpoint)
      let buf = ''
      let settled = false
      let timer: NodeJS.Timeout | undefined

      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        fn()
        socket.end()
        socket.destroy()
      }
      const arm = () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(
          () => settle(() => reject(new RpcCallError('runtime_timeout', `Orca runtime did not respond within ${timeoutMs}ms`))),
          timeoutMs
        )
      }
      arm()

      socket.setEncoding('utf8')
      socket.on('connect', () => {
        socket.write(JSON.stringify({ id, authToken: meta.authToken, method, params }) + '\n')
      })
      socket.on('data', (chunk: string) => {
        arm()
        buf += chunk
        let nl: number
        while (!settled && (nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          let frame: { _keepalive?: boolean; id?: string; ok?: boolean; result?: unknown; error?: { code?: string; message?: string } }
          try {
            frame = JSON.parse(line)
          } catch {
            settle(() => reject(new RpcCallError('invalid_runtime_response', 'Orca runtime sent an unparsable frame')))
            return
          }
          if (!frame || frame._keepalive || frame.id !== id) continue
          if (frame.ok) {
            const result = frame.result
            settle(() => resolve(result))
          } else {
            const err = frame.error ?? {}
            settle(() => reject(new RpcCallError(err.code ?? 'runtime_error', err.message ?? 'Orca runtime call failed')))
          }
          return
        }
      })
      socket.on('error', (e) => settle(() => reject(new RpcUnavailableError(`cannot reach Orca runtime: ${e.message}`))))
      socket.on('close', () => settle(() => reject(new RpcUnavailableError('Orca runtime closed the connection without a response'))))
    })
}
