import { assert, test } from 'orca/testing'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { RpcCallError, RpcUnavailableError, createRpcCall, defaultUserDataPath, readRuntimeMetadata } from './orca-rpc'

type Seen = { id: string; authToken: string; method: string; params: unknown }
let counter = 0

async function withServer(
  respond: (req: Seen, socket: net.Socket) => void,
  run: (ctx: { userData: string; token: string; seen: Seen[] }) => Promise<void>
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-rpc-'))
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\orca-persona-test-${process.pid}-${counter++}`
      : path.join(fs.realpathSync(dir), 's.sock')
  const token = 'tok-' + counter
  const seen: Seen[] = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    let buf = ''
    socket.on('data', (d) => {
      buf += d.toString('utf8')
      const i = buf.indexOf('\n')
      if (i < 0) return
      const req = JSON.parse(buf.slice(0, i)) as Seen
      seen.push(req)
      respond(req, socket)
    })
  })
  try {
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    fs.writeFileSync(
      path.join(dir, 'orca-runtime.json'),
      JSON.stringify({
        runtimeId: 'r',
        pid: 1,
        transports: [
          { kind: 'websocket', endpoint: 'ws://127.0.0.1:1' },
          { kind: process.platform === 'win32' ? 'named-pipe' : 'unix', endpoint }
        ],
        authToken: token,
        startedAt: 0
      })
    )
    await run({ userData: dir, token, seen })
  } finally {
    for (const s of sockets) s.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('call: keepalive를 무시하고 결과를 돌려주며 요청에 토큰/메서드/파라미터가 실린다', async () => {
  await withServer(
    (req, socket) => {
      socket.write('{"_keepalive":true}\n')
      socket.write(JSON.stringify({ id: req.id, ok: true, result: { hello: 1 }, _meta: { runtimeId: 'r' } }) + '\n')
    },
    async ({ userData, token, seen }) => {
      const call = createRpcCall(() => readRuntimeMetadata(userData))
      assert.deepEqual(await call('x.y', { a: 1 }), { hello: 1 })
      assert.equal(seen.length, 1)
      assert.equal(seen[0].authToken, token)
      assert.equal(seen[0].method, 'x.y')
      assert.deepEqual(seen[0].params, { a: 1 })
      assert.ok(seen[0].id.length > 0)
    }
  )
})

test('call: ok:false면 RpcCallError(code)', async () => {
  await withServer(
    (req, socket) => socket.write(JSON.stringify({ id: req.id, ok: false, error: { code: 'nope', message: 'no' } }) + '\n'),
    async ({ userData }) => {
      const call = createRpcCall(() => readRuntimeMetadata(userData))
      await assert.rejects(call('a.b', {}), (e: unknown) => e instanceof RpcCallError && e.code === 'nope' && e.message === 'no')
    }
  )
})

test('call: 응답 없이 연결이 닫히면 runtime_unavailable', async () => {
  await withServer(
    (_req, socket) => socket.end(),
    async ({ userData }) => {
      const call = createRpcCall(() => readRuntimeMetadata(userData))
      await assert.rejects(call('a.b', {}), (e: unknown) => e instanceof RpcUnavailableError && e.code === 'runtime_unavailable')
    }
  )
})

test('call: 응답이 없으면 runtime_timeout', async () => {
  await withServer(
    () => {},
    async ({ userData }) => {
      const call = createRpcCall(() => readRuntimeMetadata(userData))
      await assert.rejects(call('a.b', {}, 100), (e: unknown) => e instanceof RpcCallError && e.code === 'runtime_timeout')
    }
  )
})

test('call: 소켓에 연결할 수 없으면 RpcUnavailableError', async () => {
  const call = createRpcCall(() => ({ endpoint: path.join(os.tmpdir(), 'orca-rpc-none-' + process.pid + '.sock'), authToken: 't' }))
  await assert.rejects(call('a.b', {}), (e: unknown) => e instanceof RpcUnavailableError)
})

test('readRuntimeMetadata: 파일이 없으면 RpcUnavailableError', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-rpc-'))
  try {
    assert.throws(() => readRuntimeMetadata(dir), (e: unknown) => e instanceof RpcUnavailableError)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('defaultUserDataPath', () => {
  assert.equal(defaultUserDataPath('darwin', {}, '/Users/me'), path.join('/Users/me', 'Library', 'Application Support', 'orca'))
  assert.equal(defaultUserDataPath('linux', { XDG_CONFIG_HOME: '/x' }, '/home/me'), path.join('/x', 'orca'))
  assert.equal(defaultUserDataPath('linux', {}, '/home/me'), path.join('/home/me', '.config', 'orca'))
  assert.equal(defaultUserDataPath('win32', { APPDATA: 'C:\\A' }, 'C:\\h'), path.join('C:\\A', 'orca'))
  assert.equal(defaultUserDataPath('linux', { ORCA_USER_DATA_PATH: '/o' }, '/home/me'), '/o')
  assert.throws(() => defaultUserDataPath('win32', {}, 'C:\\h'), (e: unknown) => e instanceof RpcUnavailableError)
})
