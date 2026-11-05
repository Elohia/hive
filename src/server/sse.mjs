// src/server/sse.mjs — Server-Sent Events 推送（零依赖，node:http）
//
// 设计要点：
// 1. 只做「历史重放 + 实时广播 + 心跳」，不做任何状态判断（状态在 DB，事件由 core/events 广播）。
// 2. 所有推送都用默认 message 事件（不带 event: 字段），前端 EventSource.onmessage 一处接收，
//    方便断线重连后统一处理。
// 3. 心跳注释行 `: ping` 防止中间层/浏览器把空闲连接掐掉。
import { recent, subscribe } from '../core/events.mjs';

/** 路由处理器已经自行写出响应（不要再序列化 JSON）的哨兵值 */
export const HANDLED = Symbol('hive.handled');

const clients = new Set();
let heartbeat = null;

export function clientCount() { return clients.size; }

/** config.server.sse 默认开启；显式 false 时 /api/stream 返回 503 JSON */
export function isStreamingEnabled(cfg) { return cfg?.server?.sse !== false; }

/** 把 events 行转成前端友好的对象（data 字段尝试解析为 JSON） */
export function shapeEvent(ev) {
  let data = ev?.data;
  if (typeof data === 'string' && data) {
    try { data = JSON.parse(data); } catch { /* 保留原始字符串 */ }
  }
  return {
    id: ev?.id ?? null,
    ts: ev?.ts ?? null,
    actor: ev?.actor ?? 'system',
    type: ev?.type ?? 'event',
    level: ev?.level ?? 'info',
    item_id: ev?.item_id ?? null,
    task_id: ev?.task_id ?? null,
    run_id: ev?.run_id ?? null,
    approval_id: ev?.approval_id ?? null,
    message: ev?.message ?? '',
    data: data ?? null,
  };
}

function write(res, payload) {
  try { res.write(`data: ${JSON.stringify(payload)}\n\n`); return true; }
  catch { return false; }
}

function startHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const c of clients) {
      try { c.res.write(': ping\n\n'); }
      catch { c.close(); }
    }
  }, 15000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
}

function stopHeartbeat() {
  if (heartbeat && clients.size === 0) { clearInterval(heartbeat); heartbeat = null; }
}

/**
 * 打开一条 SSE 流。
 * @returns {symbol} HANDLED —— 告诉 http 层「响应已经写完了」。
 */
export function openStream({ req, res, cfg, query }) {
  if (!isStreamingEnabled(cfg)) {
    const body = JSON.stringify({ error: 'SSE 已关闭（config.server.sse=false）' });
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
    return HANDLED;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Hive-Stream': '1',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  // 客户端断线 3s 后自动重连（EventSource 内建行为）
  res.write('retry: 3000\n\n');

  const sinceId = Number(query?.get?.('since') || 0) || 0;
  const replay = sinceId
    ? recent({ since: sinceId, limit: 100 }).slice().reverse() // 旧 → 新
    : [];

  const client = { res, close: null };
  const onClose = () => client.close();
  client.close = () => {
    if (!clients.has(client)) return;
    clients.delete(client);
    try { res.end(); } catch { /* 已断开 */ }
    stopHeartbeat();
  };

  clients.add(client);
  startHeartbeat();

  // 先订阅再重放：极端情况下可能与重放重复，前端按 event.id 去重。
  const unsub = subscribe((ev) => {
    if (!write(res, { type: 'event', event: shapeEvent(ev) })) client.close();
  });

  for (const ev of replay) write(res, { type: 'event', event: shapeEvent(ev) });

  write(res, {
    type: 'hello',
    ts: new Date().toISOString(),
    since: sinceId,
    replay: replay.length,
    clients: clients.size,
  });

  req.on('close', onClose);
  req.on('error', onClose);
  res.on('error', onClose);
  res.on('close', onClose);

  // 订阅在客户端关闭时释放
  const originalClose = client.close;
  client.close = () => { try { unsub(); } catch { /* noop */ } originalClose(); };
  // 若在挂载期间就已断开，立即清理
  if (res.destroyed) client.close();

  return HANDLED;
}

/** 服务关闭时：关掉所有 SSE 连接（否则 server.close() 会一直挂着） */
export function closeAll() {
  for (const c of [...clients]) {
    try { c.close(); } catch { /* noop */ }
  }
  clients.clear();
  stopHeartbeat();
}
