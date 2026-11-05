// src/server/http.mjs — HIVE 看板 HTTP 服务（零依赖，只用 node:http / node:fs）
//
// 职责：
//   · 静态文件：web/（index.html / app.js / style.css）——无构建、无 CDN、离线可用
//   · /api/*   ：路由交给 src/server/api.mjs；统一 JSON、统一 {error}
//   · /api/stream：SSE（api.mjs → sse.mjs 接管响应）
//   · 仅监听回环地址（默认 127.0.0.1）；config.server.token 非空时校验 X-Hive-Token
//
// CLI：
//   node src/server/http.mjs                 # 端口取 config.server.port（默认 8787）
//   node src/server/http.mjs --port 8899     # 覆盖端口（测试用）
//   node src/server/http.mjs --host 127.0.0.1
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../core/config.mjs';
import { matchRoute, HttpError, HANDLED } from './api.mjs';
import { closeAll, clientCount } from './sse.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // 内联样式仅用于少量动态颜色（style 属性），脚本严格外链
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
}

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
}

function sendNotFound(req, res, pathname) {
  if (pathname.startsWith('/api')) return sendJson(res, 404, { error: `未找到路由: ${req.method} ${pathname}` });
  sendText(res, 404, `<!doctype html><meta charset="utf-8"><title>404</title>
<body style="background:#0b0f14;color:#8fa3b8;font:14px/1.7 system-ui;padding:48px">
<h1 style="color:#e5edf5">404 · 找不到 ${pathname.replace(/[<>&"]/g, '')}</h1>
<p>看板静态资源只从 web/ 目录提供。</p>
<p><a href="/" style="color:#f5b942">← 回到控制台</a></p></body>`, 'text/html; charset=utf-8');
}

function readJsonBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        settled = true;
        reject(new HttpError(413, `请求体过大（> ${limitBytes} 字节）`));
        try { req.destroy(); } catch { /* noop */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new HttpError(400, `JSON 解析失败: ${e.message}`)); }
    });
    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function sendFileResult(res, out) {
  let st;
  try { st = fs.statSync(out.__file); }
  catch { return sendJson(res, 404, { error: '产物文件已不存在' }); }
  if (!st.isFile()) return sendJson(res, 400, { error: '产物不是普通文件' });
  res.writeHead(200, {
    'Content-Type': mimeOf(out.__file),
    'Content-Length': st.size,
    'Content-Disposition': `inline; filename="${encodeURIComponent(out.name || path.basename(out.__file))}"`,
    'Cache-Control': 'no-store',
  });
  const stream = fs.createReadStream(out.__file);
  stream.on('error', () => { try { res.destroy(); } catch { /* noop */ } });
  stream.pipe(res);
}

async function handleApi(req, res, env, url, pathname) {
  const token = env.runtime.token;
  if (token) {
    const got = req.headers['x-hive-token'] || url.searchParams.get('token');
    if (!got || !safeEqual(got, token)) {
      return sendJson(res, 401, { error: '未授权：需要正确的 X-Hive-Token' });
    }
  }

  const hit = matchRoute(req.method, pathname);
  if (!hit) return sendJson(res, 404, { error: `未找到路由: ${req.method} ${pathname}` });
  if (hit.methodMismatch) {
    return sendJson(res, 405, { error: `方法不允许: ${req.method} ${pathname}，应使用 ${hit.allowed}` });
  }

  let out;
  try {
    let body = null;
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      body = await readJsonBody(req, env.bodyLimit);
    }
    const ctx = {
      req, res, url,
      query: url.searchParams,
      params: hit.params,
      body,
      cfg: env.cfg,
      server: env.runtime,
    };
    out = await hit.handler(ctx);
  } catch (e) {
    return handleError(res, e, env, pathname);
  }

  if (out === HANDLED) return; // 处理器已自行写出响应（SSE）
  if (out && typeof out === 'object' && typeof out.__file === 'string') return sendFileResult(res, out);
  sendJson(res, 200, out ?? { ok: true });
}

function handleError(res, e, env, pathname) {
  if (res.headersSent) { try { res.end(); } catch { /* noop */ } return; }
  if (e instanceof HttpError) {
    const payload = { error: e.message, ...(e.extra && typeof e.extra === 'object' ? e.extra : {}) };
    return sendJson(res, e.status, payload);
  }
  // 兜底：绝不把内部堆栈糊到用户脸上，但要在服务端日志留痕
  env.logger(`[hive] 500 ${pathname}: ${e && e.stack ? e.stack : e}`);
  sendJson(res, 500, { error: String(e && e.message ? e.message : e) });
}

function handleStatic(req, res, env, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: '静态资源只支持 GET/HEAD' });
  }
  if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!rel) rel = 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';

  const target = path.resolve(env.webRoot, rel);
  const rootWithSep = env.webRoot.endsWith(path.sep) ? env.webRoot : env.webRoot + path.sep;
  if (!(target === env.webRoot || target.startsWith(rootWithSep))) {
    return sendJson(res, 403, { error: '禁止访问 web/ 之外的路径' });
  }

  let st;
  try { st = fs.statSync(target); } catch { return sendNotFound(req, res, pathname); }
  let file = target;
  if (st.isDirectory()) {
    file = path.join(target, 'index.html');
    try { st = fs.statSync(file); } catch { return sendNotFound(req, res, pathname); }
  }
  if (!st.isFile()) return sendNotFound(req, res, pathname);

  res.writeHead(200, {
    'Content-Type': mimeOf(file),
    'Content-Length': st.size,
    'Cache-Control': 'no-store',
    'Last-Modified': st.mtime.toUTCString(),
  });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file);
  stream.on('error', () => { try { res.destroy(); } catch { /* noop */ } });
  stream.pipe(res);
}

async function handle(req, res, env) {
  const t0 = Date.now();
  const rawUrl = req.url || '/';
  res.on('finish', () => {
    if (rawUrl.startsWith('/api/stream')) return; // 长连接：不按请求计时
    if (rawUrl.startsWith('/api/') || res.statusCode >= 400) {
      env.logger(`[hive] ${req.method} ${rawUrl} ${res.statusCode} ${Date.now() - t0}ms`);
    }
  });

  setSecurityHeaders(res);
  let url;
  try { url = new URL(rawUrl, 'http://127.0.0.1'); }
  catch { return sendJson(res, 400, { error: '非法 URL' }); }

  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { return sendJson(res, 400, { error: '非法 URL 编码' }); }

  if (pathname === '/api' || pathname.startsWith('/api/')) return handleApi(req, res, env, url, pathname);
  return handleStatic(req, res, env, pathname);
}

// ───────────────────────────── 对外接口 ─────────────────────────────

/**
 * 创建一个未监听的 HTTP 服务。
 * @param {{cfg?:object, webRoot?:string, logger?:Function, bodyLimit?:number}} [opts]
 */
export function createHiveServer(opts = {}) {
  const cfg = opts.cfg || loadConfig();
  // 静态根永远跟【代码根】走，不跟 HIVE_HOME 走：
  //   HIVE_HOME 只改数据/配置目录，代码资产（web/）留在源码树里。
  const webRoot = path.resolve(
    opts.webRoot
    || cfg.resolved?.web
    || path.join(cfg.codeRoot || cfg.home, 'web')
  );
  const logger = typeof opts.logger === 'function' ? opts.logger : (line) => console.log(line);
  const runtime = {
    startedAt: Date.now(),
    port: null,
    host: null,
    token: String(cfg.server?.token || ''),
    get sseClients() { return clientCount(); },
  };
  const env = {
    cfg,
    webRoot,
    logger,
    runtime,
    bodyLimit: opts.bodyLimit ?? 1024 * 1024,
  };

  const server = http.createServer((req, res) => {
    handle(req, res, env).catch((e) => {
      try { handleError(res, e, env, req.url || ''); }
      catch { try { res.destroy(); } catch { /* noop */ } }
    });
  });
  server.on('clientError', (err, socket) => {
    try {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    } catch { /* noop */ }
  });
  server.headersTimeout = 30000;
  server.requestTimeout = 120000;
  server.keepAliveTimeout = 5000;

  return { server, cfg, webRoot, runtime, env };
}

function resolvePort(explicit, cfg) {
  const fromEnv = process.env.HIVE_PORT != null && process.env.HIVE_PORT !== '' ? Number(process.env.HIVE_PORT) : NaN;
  const candidates = [explicit, fromEnv, cfg.server?.port, 8787];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
  }
  return 8787;
}

/**
 * 启动服务。
 * @param {{port?:number, host?:string, cfg?:object, webRoot?:string, logger?:Function}} [opts]
 * @returns {Promise<{server:import('node:http').Server, cfg:object, port:number, host:string, url:string, close:Function}>}
 */
export function startServer(opts = {}) {
  const { server, cfg, webRoot, runtime } = createHiveServer(opts);
  const port = resolvePort(opts.port, cfg);
  const host = opts.host || cfg.server?.host || '127.0.0.1';

  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.off('listening', onListening);
      if (e && e.code === 'EADDRINUSE') {
        reject(new Error(`端口 ${port} 已被占用：${e.message}（可用 --port 换一个）`));
      } else if (e && e.code === 'EACCES') {
        reject(new Error(`无权监听 ${host}:${port}：${e.message}`));
      } else {
        reject(e);
      }
    };
    const onListening = () => {
      server.off('error', onError);
      const addr = server.address();
      runtime.port = addr && typeof addr === 'object' ? addr.port : port;
      runtime.host = host;
      const url = `http://${host.includes(':') ? `[${host}]` : host}:${runtime.port}/`;

      // close 必须：① 幂等（重复调用返回同一个 promise，绝不重复 close 句柄）
      //           ② 先结束所有 SSE 客户端 ③ server.close() 回调只结算一次
      //           ④ 兜底强拆残留连接（否则 keep-alive / SSE 会拖住进程）
      let closing = null;
      const close = () => {
        if (closing) return closing;
        closing = new Promise((done) => {
          let settled = false;
          let guard = null;
          const finish = () => {
            if (settled) return;
            settled = true;
            if (guard) clearTimeout(guard);
            done();
          };
          try { closeAll(); } catch { /* SSE 清理失败不阻断关闭 */ }
          try { server.close(() => finish()); }
          catch { finish(); }
          // 兜底：1.5s 后强制断开仍在挂着的连接，再结算（只结算一次）
          guard = setTimeout(() => {
            try { server.closeAllConnections?.(); } catch { /* noop */ }
            finish();
          }, 1500);
          if (guard && typeof guard.unref === 'function') guard.unref();
        });
        return closing;
      };
      resolve({ server, cfg, webRoot, runtime, port: runtime.port, host, url, close });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host, exclusive: true });
  });
}

// ───────────────────────────── CLI ─────────────────────────────

function parseArgs(argv) {
  const out = { port: undefined, host: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice('--port='.length));
    else if (a === '--host') out.host = argv[++i];
    else if (a.startsWith('--host=')) out.host = a.slice('--host='.length);
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--quiet') out.quiet = true;
  }
  if (out.port !== undefined && (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535)) {
    out.port = undefined;
  }
  return out;
}

const HELP = `HIVE 看板服务（零依赖）
用法：
  node src/server/http.mjs [--port 8787] [--host 127.0.0.1] [--quiet]

选项：
  --port, -p <n>   监听端口（默认取 config/hive.json 的 server.port，即 8787）
  --host <addr>    监听地址（默认 127.0.0.1，仅回环）
  --quiet          不打印逐条请求日志
  --help, -h       显示本帮助

环境变量：
  HIVE_PORT        端口（--port 优先）
  HIVE_HOME        项目根（默认由配置模块推导）

接口：
  GET  /api/health /api/overview /api/items /api/items/:id /api/tasks /api/approvals
       /api/events /api/context /api/doctor
  POST /api/items /api/items/:id/action /api/tasks/:id/retry /api/tasks/:id/cancel
       /api/approvals/:id/decide /api/scan /api/context
  GET  /api/stream   （SSE 实时事件）`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return 0; }

  let cfg;
  try { cfg = loadConfig(); }
  catch (e) {
    console.error(`[hive] 配置加载失败: ${e.message}`);
    return 1;
  }

  const quiet = !!args.quiet;
  const logger = quiet ? () => {} : (line) => console.log(line);

  let srv;
  try {
    srv = await startServer({ cfg, port: args.port, host: args.host, logger });
  } catch (e) {
    console.error(`[hive] 启动失败: ${e.message}`);
    return 1;
  }

  const bindWarn = srv.host !== '127.0.0.1' && srv.host !== '::1' && srv.host !== 'localhost'
    ? `  ⚠ 非回环地址，注意暴露风险` : '';
  console.log(`[hive] 看板已启动 ${srv.url}`);
  console.log(`[hive] home=${cfg.home}`);
  console.log(`[hive] db=${cfg.resolved.db}`);
  console.log(`[hive] token=${cfg.server?.token ? 'on' : 'off（本地免密）'}  sse=${cfg.server?.sse === false ? 'off' : 'on'}${bindWarn}`);
  console.log('[hive] Ctrl+C 退出');

  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return;
    closing = true;
    console.log(`\n[hive] 收到 ${sig}，正在关闭…`);
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return -1; // 常驻
}

const isMain = (() => {
  try {
    return !!(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
  } catch { return false; }
})();

if (isMain) {
  main().then((code) => { if (typeof code === 'number' && code >= 0) process.exit(code); })
    .catch((e) => { console.error(`[hive] 未捕获错误: ${e && e.stack ? e.stack : e}`); process.exit(1); });
}
