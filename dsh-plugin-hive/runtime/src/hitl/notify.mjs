// src/hitl/notify.mjs — 主动推送（Windows Toast / 邮件 / 看板），全部 fail-soft
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../core/config.mjs';
import { emit } from '../core/events.mjs';
import { logger } from '../core/log.mjs';
import { q } from '../core/db.mjs';

const pexec = promisify(execFile);

/** Windows 10/11 原生 Toast（用 Windows PowerShell 5.1 走 WinRT，无需任何模块） */
export async function toast({ title, body, tag = 'hive' } = {}) {
  const t = String(title || 'HIVE').replace(/[<>"'&]/g, ' ');
  const b = String(body || '').replace(/[<>"'&]/g, ' ').slice(0, 240);
  const ps = `
$ErrorActionPreference='Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$tpl = @"
<toast duration="long">
  <visual><binding template="ToastGeneric">
    <text>${t}</text>
    <text>${b}</text>
  </binding></visual>
</toast>
"@
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($tpl)
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
Write-Output 'toast-shown'
`;
  try {
    const { stdout } = await pexec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000, windowsHide: true });
    return { ok: /toast-shown/.test(stdout), channel: 'toast' };
  } catch (e) {
    return { ok: false, channel: 'toast', error: String(e.message).slice(0, 200) };
  }
}

/** 邮件通知：走 agently-cli 两阶段确认。默认关闭——只有配置里显式启用且填了收件人才发。 */
export async function mail({ subject, body } = {}) {
  const cfg = loadConfig();
  const m = cfg.notify?.mail || {};
  if (!m.enabled || !m.to) return { ok: false, channel: 'mail', error: '未启用或未配置 to' };
  try {
    const cmd = m.command || 'agently-cli';
    const { stdout } = await pexec(cmd, [
      'message', '+send', '--to', m.to,
      '--subject', String(subject || 'HIVE 待办').slice(0, 120),
      '--body', String(body || '').slice(0, 20000),
    ], { timeout: 45000, windowsHide: true });
    const out = safeJson(stdout);
    if (out?.data?.confirmation_token) {
      // 两阶段确认：把 ctk 记下来，等人工确认后再发（不在自动流程里自动确认）
      return { ok: false, channel: 'mail', pending: true, ctk: out.data.confirmation_token, summary: out.data.summary };
    }
    return { ok: true, channel: 'mail' };
  } catch (e) {
    return { ok: false, channel: 'mail', error: String(e.message).slice(0, 200) };
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

/** 今日已推送计数（防止打扰过载） */
function todayNotified() {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  return q.get("SELECT COUNT(*) n FROM events WHERE type='notify.sent' AND ts >= ?", dayStart.toISOString())?.n ?? 0;
}

/**
 * 统一推送入口：遵守「守中」与每日上限。
 * @param {{title:string, body:string, level?:'info'|'warn'|'error', channels?:string[], force?:boolean}} o
 */
export async function notify(o) {
  const cfg = loadConfig();
  const limit = cfg.settings.maxNotifyPerDay ?? 12;
  const used = todayNotified();
  if (!o.force && used >= limit) {
    emit({ actor: 'notify', type: 'notify.suppressed', level: 'warn', message: `今日推送已达上限 ${limit}，抑制：${o.title}` });
    return { ok: false, suppressed: true, used, limit };
  }
  const channels = o.channels || ['toast'];
  const results = [];
  if (channels.includes('toast') && cfg.notify?.toast?.enabled) {
    results.push(await toast({ title: o.title, body: o.body }));
  }
  if (channels.includes('mail') && cfg.notify?.mail?.enabled) {
    results.push(await mail({ subject: o.title, body: o.body }));
  }
  const anyOk = results.some((r) => r.ok) || channels.includes('dashboard');
  emit({
    actor: 'notify', type: 'notify.sent', level: o.level || 'info',
    message: o.title, data: { body: String(o.body || '').slice(0, 400), results },
  });
  logger.info(`notify: ${o.title}`, results.map((r) => `${r.channel}:${r.ok ? 'ok' : 'fail'}`).join(','));
  return { ok: anyOk, results, used: used + 1, limit };
}

/** 审批请求的推送文案 */
export function approvalMessage(ap) {
  const opts = safeJson(ap.options) || [];
  const lines = [];
  if (ap.summary) lines.push(ap.summary);
  if (ap.recommendation) lines.push(`建议：${ap.recommendation}`);
  if (opts.length) lines.push('选项：' + opts.map((x) => `${x.id}=${x.label}`).join(' / '));
  lines.push(`回复或到看板 Outbox 处理（${ap.id.slice(0, 12)}…）`);
  return { title: `需你拍板 · ${ap.title}`, body: lines.join('\n') };
}
