// 本地真机冒烟测试：针对真实 DSH web（127.0.0.1:3080）+ 真实 cloudflared 隧道，
// 验证「局域网（LAN）」与「公网（public）」两条访问路径的通路 + 认证是否正常。
//
// 不进 CI：package.json 的 `test` 脚本只跑 test/*.test.js（顶层，不递归子目录），
// 本文件在 test/local/，由 `npm run test:local` 单独运行。
//
// 严格模式（与常规单测不同）：
//   - 本机 dsh web 未运行 → 红灯
//   - cloudflared 未安装 / 隧道连不通 → 红灯（不降级成 skipped）
// 因为这两个前提正是「手机 / 公网能不能用」的本体，假绿没意义。
//
// 运行前提：
//   1. 先在宿主端打开 DSH（127.0.0.1:3080 有响应）；
//   2. dsh-pocket 所需的 cloudflared 可用（通常已下载缓存到 $DSH_HOME/dsh-pocket/bin）。
// 然后：npm run test:local

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { WebSocket } from 'ws';

import { createPocketProxy, classifyHost } from '../../lib/proxy.mjs';
import { startQuickTunnel } from '../../lib/tunnel.mjs';

const DSH_WEB_PORT = 3080;
const TEST_PIN = '24681357';
const TEST_SESSION = 'local-smoke-session-key';
const LOGIN_MARKER = 'DSH Pocket · 访问验证';

// 从真实 dsh web 响应里抽若干稳定子串，作为「真内容」判定锚点。代理只会往 <head>
// 注入一个 polyfill script，主体 HTML 原样转发，所以这些锚点必然也出现在代理后的响应里。
function deriveMarkers(body) {
  const markers = [];
  if (body.length < 64) return markers;
  const step = Math.max(8, Math.floor(body.length / 8));
  for (let i = 1; i < 8; i++) {
    const slice = body.slice(i * step, i * step + 24).replace(/\s+/g, ' ').trim();
    if (slice.length >= 8) markers.push(slice);
  }
  return markers;
}

function assertRealContent(label, body, markers) {
  assert.ok(body.length > 500, `${label}：响应体过小（${body.length} 字节），不像真实 dsh web 内容`);
  assert.ok(!body.includes(LOGIN_MARKER), `${label}：返回的是登录页，而不是真实内容`);
  const hit = markers.filter((m) => body.includes(m)).length;
  assert.ok(hit >= 2, `${label}：与真实 dsh web 内容重合不足（命中 ${hit}/${markers.length} 个锚点）`);
}

function firstLanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

function wsResult(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    ws.on('open', () => finish({ ok: true, ws }));
    ws.on('unexpected-response', (_req, res) => finish({ ok: false, status: res.statusCode }));
    ws.on('error', (e) => finish({ ok: false, err: e.message }));
    setTimeout(() => finish({ ok: false, timeout: true }), 8000);
  });
}

test('本机真机冒烟：局域网 + 公网 通路与认证', { timeout: 300000 }, async (t) => {
  // --- 前置：真实 dsh web 可达 ---
  const refRes = await fetch(`http://127.0.0.1:${DSH_WEB_PORT}/`);
  assert.ok(
    refRes.status >= 200 && refRes.status < 400,
    `本机 dsh web（127.0.0.1:${DSH_WEB_PORT}）未就绪（status=${refRes.status}）。请先在宿主端打开 DSH 再跑本测试。`,
  );
  const refBody = await refRes.text();
  assert.ok(refBody.length > 200, 'dsh web 响应体异常（过短）');
  const markers = deriveMarkers(refBody);
  assert.ok(markers.length >= 2, '无法从 dsh web 响应抽取内容锚点（响应体异常？）');

  // --- 起一个只用于本测试的代理：本机免密、局域网 / 公网要密码（与插件版语义一致）---
  const proxy = await createPocketProxy({
    port: 0,
    host: '0.0.0.0',
    upstream: { host: '127.0.0.1', port: DSH_WEB_PORT },
    auth: {
      getToken: () => TEST_PIN,
      isProtected: (h) => classifyHost(h) !== 'loopback',
      sessionKey: TEST_SESSION,
    },
  });
  t.after(() => proxy.close());

  const base = `http://127.0.0.1:${proxy.port}`;
  const lanIp = firstLanIp();
  const lanBase = lanIp ? `http://${lanIp}:${proxy.port}` : null;

  // --- 本机（loopback）免密直达真实内容 ---
  await t.test('本机 loopback 免密直达真实 dsh web 内容', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200, '本机访问应直接放行（免密）');
    const body = await res.text();
    assertRealContent('本机', body, markers);
  });

  // --- 局域网：无密码被挡在登录页 ---
  await t.test('局域网无密码 → 登录页', async () => {
    if (!lanBase) return t.skip('本机无可用局域网 IP');
    const res = await fetch(`${lanBase}/`);
    assert.equal(res.status, 200, '局域网无密码应回登录页（200）');
    const body = await res.text();
    assert.ok(body.includes(LOGIN_MARKER), '局域网无密码应显示登录页');
  });

  // --- 局域网：带密码拿到真实内容 ---
  await t.test('局域网带密码 → 真实 dsh web 内容', async () => {
    if (!lanBase) return t.skip('本机无可用局域网 IP');
    const res = await fetch(`${lanBase}/?token=${TEST_PIN}`);
    assert.equal(res.status, 200, '局域网带正确密码应放行');
    const body = await res.text();
    assertRealContent('局域网', body, markers);
  });

  // --- 局域网：WebSocket 无密码被拒（认证旁路检查）---
  await t.test('局域网 WebSocket 无密码被拒', async () => {
    if (!lanBase) return t.skip('本机无可用局域网 IP');
    const r = await wsResult(`ws://${lanIp}:${proxy.port}/`);
    try {
      assert.ok(!r.ok, '局域网 WS 无密码应被拒绝（拿到升级即视为漏过认证）');
    } finally {
      try { r.ws?.close(); } catch { /* ignore */ }
    }
  });

  // --- 公网：真起 cloudflared 隧道，验证无密码 / 带密码两条 ---
  let tunnel = null;
  try {
    tunnel = await startQuickTunnel({ port: proxy.port });
  } catch (e) {
    await t.test('公网隧道无密码 → 登录页', async () => {
      throw new Error(`无法建立公网隧道：${e.message}`);
    });
    await t.test('公网隧道带密码 → 真实 dsh web 内容', async () => {
      throw new Error(`无法建立公网隧道：${e.message}`);
    });
    return;
  }
  t.after(() => tunnel?.kill());

  await t.test('公网隧道无密码 → 登录页', async () => {
    const res = await fetch(tunnel.url);
    assert.equal(res.status, 200, '公网无密码应回登录页（200）');
    const body = await res.text();
    assert.ok(body.includes(LOGIN_MARKER), '公网无密码应显示登录页');
  });

  await t.test('公网隧道带密码 → 真实 dsh web 内容', async () => {
    const res = await fetch(`${tunnel.url}/?token=${TEST_PIN}`);
    assert.equal(res.status, 200, '公网带正确密码应放行');
    const body = await res.text();
    assertRealContent('公网', body, markers);
  });
});
