// 飞书自定义机器人：把公网链接以文本消息推送到群（手动触发一次一条；或隧道就绪自动发送）。
// Webhook 形如 https://open.feishu.cn/open-apis/bot/v2/hook/<token>（国际版 larksuite.com）。
// 注意：若机器人设置了「自定义关键词」安全策略，消息需包含关键词，失败原因会原样抛回前端。

import { createHmac } from 'node:crypto';

/**
 * 飞书加签校验的签名（官方算法）：
 *   string_to_sign = `${timestamp}\n${secret}`，以其为 HMAC-SHA256 密钥、空消息，
 *   摘要 base64 即 sign；请求体同时携带秒级时间戳。
 * @param {string} secret 机器人加签密钥
 * @param {number} timestamp 秒级时间戳
 * @returns {string} base64 签名
 */
export function feishuSign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`;
  return createHmac('sha256', stringToSign).update('').digest('base64');
}

/**
 * 发送一条文本消息到飞书自定义机器人。
 * @param {string} webhook 机器人 Webhook 地址
 * @param {string} text 消息正文
 * @param {{ timeoutMs?: number, secret?: string }} [opts] secret 为机器人加签密钥，留空不加签
 * @throws 网络失败或飞书返回非 0 错误码时抛错（消息含飞书侧原因）。
 */
export async function sendFeishuText(webhook, text, { timeoutMs = 15000, secret = '' } = {}) {
  const url = String(webhook ?? '').trim();
  if (!url) throw new Error('飞书 Webhook 未配置 | Feishu webhook not configured');
  const body = { msg_type: 'text', content: { text: String(text ?? '') } };
  const trimmedSecret = String(secret ?? '').trim();
  if (trimmedSecret) {
    const timestamp = Math.floor(Date.now() / 1000);
    body.timestamp = String(timestamp);
    body.sign = feishuSign(trimmedSecret, timestamp);
  }
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`飞书 Webhook 请求失败：${err?.message ?? err} | Feishu webhook request failed`);
  }
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 响应按状态码判断 */ }
  if (!res.ok) {
    throw new Error(`飞书 Webhook 返回 HTTP ${res.status} | Feishu webhook HTTP ${res.status}`);
  }
  // 新版响应 {code:0,msg:'success'}；旧版 {StatusCode:0}。code 缺失视为成功（部分网关代理）
  const code = json?.code ?? json?.StatusCode ?? json?.errcode ?? 0;
  if (code !== 0) {
    throw new Error(`飞书发送失败（code=${code}）：${json?.msg ?? ''} | Feishu send failed`);
  }
}
