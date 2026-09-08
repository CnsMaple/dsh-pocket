// dsh >= v0.1.3-alpha.2 兼容回归：ctx.webServer 存在时，installPocketRpc 必须直接挂载
// webServer prefix 路由（connection.rpc.handle 在该版本从插件 fiber 调用必抛
// "cannot get property webServer without inject"），且线协议与原 rpc.handle 一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { installPocketRpc } from '../lib/web-rpc.js';
import { POCKET_RPC_CHANNEL, POCKET_ENDPOINTS } from '../client/api.js';

function fakeRes() {
  return {
    statusCode: 0, headers: {}, chunks: '', writableEnded: false,
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers ?? {}); },
    end(chunk) { if (chunk) this.chunks += String(chunk); this.writableEnded = true; },
    on() {},
  };
}

async function request(handler, { method = 'POST', path = `${POCKET_RPC_CHANNEL}/pocket.version`, body = '', headers = { 'content-type': 'application/json' } } = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.url = path;
  req.headers = headers;
  const res = fakeRes();
  await handler(req, res);
  return res;
}

function envelope(rpcId, endpoint) {
  return JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: {} });
}

test('webServer 可用时直接注册 prefix 路由，不走 connection.rpc.handle', async () => {
  const routes = [];
  let handled = 0;
  const ctx = {
    webServer: { port: 3080, register: (route) => { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); } },
    connection: { requestRejection: () => { handled += 1; return undefined; }, rpc: { handle: () => { throw new Error('rpc.handle must not be used'); } } },
  };
  const dispose = installPocketRpc(ctx, {
    service: { status: async () => ({}) },
    log: { warn() {}, error() {} },
    runUpdate: { currentVersion: () => '9.9.9', loadedVersion: () => '9.9.9' },
  });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, POCKET_RPC_CHANNEL);

  // 正常调用：server-response 信封
  const res = await request(routes[0].handler, { body: envelope('r-1', POCKET_ENDPOINTS.version) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.chunks), { type: 'server-response', rpcId: 'r-1', result: { ok: true, value: { current: '9.9.9', loaded: '9.9.9' } } });

  // requestRejection 认证门保留：401 → unauthorized 文本
  ctx.connection.requestRejection = () => 401;
  const denied = await request(routes[0].handler, { body: envelope('r-2', POCKET_ENDPOINTS.version) });
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.chunks, 'unauthorized');

  ctx.connection.requestRejection = () => undefined;

  // 非 POST → 404；非 JSON content-type → 415；坏信封 → gateway/bad-request + invalid-request
  assert.equal((await request(routes[0].handler, { method: 'GET' })).statusCode, 404);
  assert.equal((await request(routes[0].handler, { headers: {}, body: '{}' })).statusCode, 415);
  const bad = JSON.parse((await request(routes[0].handler, { body: '{"type":"nope"}' })).chunks);
  assert.equal(bad.rpcId, 'invalid-request');
  assert.equal(bad.result.error.code, 'gateway/bad-request');

  // 信封 method 与 URL endpoint 不一致 → gateway/bad-request（同 connection）
  const mismatch = JSON.parse((await request(routes[0].handler, { body: envelope('r-3', 'other.endpoint') })).chunks);
  assert.equal(mismatch.result.error.code, 'gateway/bad-request');
  // URL endpoint 合法但未知（method 与之一致）→ rpcHandler 的 bad-request 业务错误
  const unknown = JSON.parse((await request(routes[0].handler, { path: `${POCKET_RPC_CHANNEL}/nope.unknown`, body: envelope('r-4', 'nope.unknown') })).chunks);
  assert.equal(unknown.result.error.code, 'bad-request');

  dispose();
  assert.equal(routes.length, 0);
});
