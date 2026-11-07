// scripts/build-longform-html.mjs — 长文 Markdown → 自包含 HTML（X 长文阅读版）
//
// 为什么要它：长文要反复改（改标题、改数字、加段），手搓一份 HTML 改一次要同步两处。
// 所以只让 md 做唯一事实源，html 每次从它生成。
//
// 特点：
//   · 单文件、零外部请求（无 CDN、无字体外链、无图片外链）—— 离线/内网都能开
//   · 版式按 X 长文阅读习惯排：窄栏 680px、行高 1.9、中文优先字体栈
//   · 顶部带「字数 / 复制全文 / 打印」三个工具；复制出来的是可直接贴进 X 的纯文本
//   · 跟随系统深浅色（prefers-color-scheme），打印时自动转黑字白底
//
// 用法：
//   node scripts/build-longform-html.mjs docs/x-longform-2026-11-07.md
//   node scripts/build-longform-html.mjs <in.md> <out.html> [--author 幻] [--handle ElohiaO_o]
//
// 只支持长文会用到的那几种 Markdown 语法（标题/段落/代码块/引用/列表/加粗/行内码/分隔线/链接）。
// 不引第三方库：这是刻意的——HIVE 的整个运行时零 npm 依赖，工具链也不该例外。
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = '') => { const i = argv.indexOf('--' + n); return i === -1 ? d : (argv[i + 1] ?? d); };
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]?.startsWith('--')));
const inPath = pos[0];
if (!inPath || !fs.existsSync(inPath)) {
  console.error('用法: node scripts/build-longform-html.mjs <input.md> [output.html] [--author 幻] [--handle ElohiaO_o]');
  process.exit(2);
}
const outPath = pos[1] || inPath.replace(/\.md$/i, '.html');
const AUTHOR = flag('author', '幻');
const HANDLE = flag('handle', 'ElohiaO_o');

const md = fs.readFileSync(inPath, 'utf8');

/* ───────────────────────── 极简 Markdown → HTML ───────────────────────── */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s) {
  return esc(s)
    // 行内代码先占位，避免里面的 * 被当成加粗
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>');
}

/** 去掉 md 的元信息头（第一行 # 标题 + 括号里的「文章草稿…」说明），正文单独取 */
function splitMeta(text) {
  const lines = text.split(/\r?\n/);
  let i = 0;
  // 跳过开头空行
  while (i < lines.length && !lines[i].trim()) i++;
  let title = '';
  if (lines[i]?.startsWith('# ')) { title = lines[i].slice(2).trim(); i++; }
  // 跳过紧跟的「（文章草稿 · …）」说明行和空行
  while (i < lines.length && (!lines[i].trim() || /^（.*）\s*$/.test(lines[i].trim()))) i++;
  if (lines[i]?.trim() === '---') i++;
  return { title, body: lines.slice(i).join('\n') };
}

function render(body) {
  const lines = body.split(/\r?\n/);
  const out = [];
  let i = 0;
  const flushParagraph = (buf) => {
    if (!buf.length) return;
    out.push(`<p>${inline(buf.join(' '))}</p>`);
    buf.length = 0;
  };
  let para = [];

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // 代码块
    if (/^```/.test(line.trim())) {
      flushParagraph(para);
      const lang = line.trim().slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      i++; // 跳过收尾 ```
      out.push(`<pre class="code"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 标题
    const h = /^(#{2,4})\s+(.*)$/.exec(line.trim());
    if (h) { flushParagraph(para); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }

    // 分隔线
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flushParagraph(para); out.push('<hr>'); i++; continue; }

    // 引用（支持连续多行）
    if (/^>\s?/.test(line)) {
      flushParagraph(para);
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // 无序列表
    if (/^[-*]\s+/.test(line)) {
      flushParagraph(para);
      const buf = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) { buf.push(lines[i].replace(/^[-*]\s+/, '')); i++; }
      out.push(`<ul>${buf.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`);
      continue;
    }

    // 有序列表
    if (/^\d+[.)]\s+/.test(line)) {
      flushParagraph(para);
      const buf = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\d+[.)]\s+/, '')); i++; }
      out.push(`<ol>${buf.map((x) => `<li>${inline(x)}</li>`).join('')}</ol>`);
      continue;
    }

    // 空行 = 段落边界
    if (!line.trim()) { flushParagraph(para); i++; continue; }

    para.push(line.trim());
    i++;
  }
  flushParagraph(para);
  return out.join('\n');
}

/** 供「复制全文」用：去掉 markdown 记号，保留可读纯文本 */
function plainText(body) {
  return body
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*/g, '').trim())
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*]\s+/gm, '· ')
    .replace(/^\d+[.)]\s+/gm, (m) => m)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const { title, body } = splitMeta(md);
const htmlBody = render(body);
const plain = plainText(body);
const cnCount = (plain.match(/[\u4e00-\u9fff]/g) || []).length;
const chCount = plain.length;

/* ───────────────────────── 页面 ───────────────────────── */
const avatar = `<svg viewBox="0 0 32 32" width="44" height="44" aria-hidden="true">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#ffb648"/><stop offset="1" stop-color="#f2701f"/>
  </linearGradient></defs>
  <path d="M16 2.6 27 9v14L16 29.4 5 23V9z" fill="url(#g)"/>
  <path d="M16 9.4 22.6 13v7L16 23.6 9.4 20v-7z" fill="none" stroke="#1a1206" stroke-width="1.6" stroke-linejoin="round"/>
  <circle cx="16" cy="16.4" r="1.9" fill="#1a1206"/>
</svg>`;

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title || '长文')}</title>
<style>
  :root{
    --bg:#ffffff; --fg:#0f1419; --dim:#536471; --line:#eff3f4; --code-bg:#f7f9f9;
    --quote:#536471; --quote-bg:#f7f9f9; --link:#1d6fd6; --btn:#0f1419; --btn-fg:#fff;
  }
  @media (prefers-color-scheme: dark){
    :root{ --bg:#15202b; --fg:#e7e9ea; --dim:#8b98a5; --line:#263340; --code-bg:#1c2a35;
           --quote:#a7b4c0; --quote-bg:#1c2a35; --link:#7cb4f5; --btn:#e7e9ea; --btn-fg:#15202b; }
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:var(--bg);color:var(--fg)}
  body{
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB",
                "Microsoft YaHei","Source Han Sans SC",system-ui,sans-serif;
    font-size:17px; line-height:1.9; -webkit-font-smoothing:antialiased;
    text-rendering:optimizeLegibility;
  }
  .wrap{max-width:680px;margin:0 auto;padding:0 22px 96px}

  /* 顶部工具条 */
  .bar{position:sticky;top:0;z-index:9;background:color-mix(in srgb, var(--bg) 88%, transparent);
       backdrop-filter:blur(10px);border-bottom:1px solid var(--line);
       display:flex;align-items:center;gap:10px;padding:10px 0;margin-bottom:26px}
  .meta{font-size:12.5px;color:var(--dim);letter-spacing:.02em}
  .spacer{flex:1}
  button{font:inherit;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--line);
         background:transparent;color:var(--fg);border-radius:999px;padding:7px 14px;transition:.15s}
  button:hover{border-color:var(--dim)}
  button.primary{background:var(--btn);color:var(--btn-fg);border-color:var(--btn)}
  button.done{background:#0a7f4b;border-color:#0a7f4b;color:#fff}

  /* 作者行 */
  .author{display:flex;align-items:center;gap:12px;margin:8px 0 26px}
  .author .name{font-weight:800;font-size:15.5px}
  .author .handle{color:var(--dim);font-size:14px}
  .badge{display:inline-block;width:15px;height:15px;vertical-align:-2px;margin-left:3px}

  h1{font-size:27px;line-height:1.45;margin:0 0 22px;font-weight:800;letter-spacing:-.01em}
  h2{font-size:21px;line-height:1.5;margin:44px 0 14px;font-weight:800;letter-spacing:-.01em}
  h3{font-size:18px;margin:32px 0 10px;font-weight:700}
  p{margin:0 0 20px}
  strong{font-weight:800}
  a{color:var(--link);text-decoration:none;border-bottom:1px solid transparent}
  a:hover{border-bottom-color:var(--link)}
  hr{border:0;border-top:1px solid var(--line);margin:36px 0}

  code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
       font-size:14.5px;background:var(--code-bg);padding:2px 6px;border-radius:5px}
  pre.code{background:var(--code-bg);border:1px solid var(--line);border-radius:10px;
           padding:14px 16px;overflow:auto;margin:0 0 22px;position:relative}
  pre.code code{background:none;padding:0;font-size:13.5px;line-height:1.75;white-space:pre}
  pre.code[data-lang]::after{content:attr(data-lang);position:absolute;top:8px;right:12px;
           font-size:11px;color:var(--dim);font-family:ui-monospace,monospace}

  blockquote{margin:0 0 22px;padding:12px 16px;background:var(--quote-bg);
             border-left:3px solid var(--dim);border-radius:0 8px 8px 0;color:var(--quote)}
  blockquote p:last-child{margin:0}

  ul,ol{margin:0 0 20px;padding-left:26px}
  li{margin:6px 0}

  .toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,20px);opacity:0;
         background:#0a7f4b;color:#fff;font-size:13.5px;font-weight:600;padding:10px 18px;
         border-radius:999px;transition:.22s;pointer-events:none}
  .toast.show{opacity:1;transform:translate(-50%,0)}

  @media print{
    .bar,.toast{display:none}
    html,body{background:#fff;color:#000}
    .wrap{max-width:none;padding:0}
    body{font-size:12pt;line-height:1.7}
    h2{page-break-after:avoid}
    pre.code{page-break-inside:avoid}
  }
  @media (max-width:560px){
    body{font-size:16px}
    h1{font-size:23px}
    .wrap{padding:0 16px 72px}
  }
</style>
</head>
<body>
<div class="wrap">

  <div class="bar">
    <span class="meta" id="counts">${cnCount} 汉字 · ${chCount} 字符</span>
    <span class="spacer"></span>
    <button id="copy" class="primary">复制全文</button>
    <button id="print">打印 / PDF</button>
  </div>

  <div class="author">
    ${avatar}
    <div>
      <div class="name">${esc(AUTHOR)}<svg class="badge" viewBox="0 0 22 22" aria-hidden="true"><path fill="#1d9bf0" d="M12.1 1.5 14.4 3l2.7-.6 1.3 2.4 2.6 1 .2 2.7 2 1.9-1.4 2.3.5 2.7-2.4 1.4-1 2.6-2.7.1-1.9 2-2.3-1.3-2.7.5-1.4-2.4-2.6-1-.1-2.7-2-1.9L2.8 9.9l-.5-2.7L4.8 5.8l1-2.6 2.7-.1z"/><path fill="#fff" d="m9.9 14.6-2.8-2.8 1.2-1.2 1.6 1.6 3.9-3.9 1.2 1.2z"/></svg></div>
      <div class="handle">@${esc(HANDLE)}</div>
    </div>
  </div>

  ${title ? `<h1>${inline(title)}</h1>` : ''}

${htmlBody}

</div>

<div class="toast" id="toast">已复制，可直接贴进 X</div>

<script>
  const PLAIN = ${JSON.stringify(plain)};
  const $ = (s) => document.querySelector(s);
  async function copy() {
    const btn = $('#copy');
    try {
      await navigator.clipboard.writeText(PLAIN);
    } catch {
      // 剪贴板 API 不可用（file:// 或旧浏览器）→ 退回到 textarea 选中复制
      const ta = document.createElement('textarea');
      ta.value = PLAIN; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {}
      ta.remove();
    }
    const old = btn.textContent;
    btn.textContent = '✓ 已复制'; btn.classList.add('done');
    const toast = $('#toast');
    toast.classList.add('show');
    setTimeout(() => { btn.textContent = old; btn.classList.remove('done'); toast.classList.remove('show'); }, 1900);
  }
  $('#copy').addEventListener('click', copy);
  $('#print').addEventListener('click', () => window.print());
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'c' && !window.getSelection()?.toString()) copy();
  });
</script>
</body>
</html>
`;

fs.writeFileSync(outPath, html, 'utf8');
const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
console.log(`✓ ${outPath}`);
console.log(`  ${cnCount} 汉字 · ${chCount} 字符 · ${kb} KB · 零外部请求`);
console.log(`  复制按钮带出的纯文本 ${plain.length} 字符（可直接贴进 X 长文）`);
