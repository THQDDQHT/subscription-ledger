import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, dataRoot } from './db';
import { rows, settleAll } from './ledger';
import { DomainError, nowIsoInShanghai, todayInShanghai, money } from './domain';
import type { Reminder } from '../lib/types';

interface Settings { enabled: boolean; token: string; chat_id: string; lead_days: number; base_url: string }
const defaults: Settings = { enabled: false, token: '', chat_id: '', lead_days: 3, base_url: '' };
export function settings(): Settings {
  const file = path.join(dataRoot(), 'notifications.json');
  return fs.existsSync(file) ? { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) } : { ...defaults };
}
export function notificationStatus() {
  const { token, ...publicSettings } = settings();
  return { ...publicSettings, token_configured: Boolean(token), worker: db().prepare('SELECT checked_at,error FROM worker_state WHERE id=1').get() ?? null,
    recent: db().prepare('SELECT notification_key,status,attempts,error,sent_at FROM notifications ORDER BY rowid DESC LIMIT 20').all() };
}
export function saveSettings(data: Record<string, unknown>) {
  const old = settings();
  if (typeof data.enabled !== 'boolean') throw new DomainError('通知开关不正确');
  if (typeof data.lead_days !== 'number' || !Number.isInteger(data.lead_days) || data.lead_days < 0 || data.lead_days > 30) throw new DomainError('提前提醒天数须为 0–30 的整数');
  const token = data.clear_token === true ? '' : data.token === '' || data.token === undefined ? old.token : data.token;
  if (typeof token !== 'string' || (token && !/^\d+:[A-Za-z0-9_-]{20,200}$/.test(token))) throw new DomainError('Bot Token 格式不正确');
  if (typeof data.chat_id !== 'string' || (data.chat_id && !/^-?\d{1,20}$/.test(data.chat_id))) throw new DomainError('接收 Chat ID 须为数字');
  if (data.enabled && (!token || !data.chat_id)) throw new DomainError('请先配置独立 Bot Token 和接收 Chat ID');
  const base = data.base_url ?? '';
  if (typeof base !== 'string' || base.length > 2000) throw new DomainError('账本地址不正确');
  if (base) {
    let u: URL;
    try { u = new URL(base); } catch { throw new DomainError('账本地址须为 http/https URL'); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new DomainError('账本地址须为不含凭证、参数或锚点的 http/https URL');
  }
  const value: Settings = { enabled: data.enabled, token, chat_id: data.chat_id, lead_days: data.lead_days, base_url: base.replace(/\/$/, '') };
  const temp = path.join(dataRoot(), `notifications-${crypto.randomBytes(8).toString('hex')}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, path.join(dataRoot(), 'notifications.json'));
  return notificationStatus();
}

export function reminders(items = rows(), today = todayInShanghai(), config = settings()): Reminder[] {
  const result: Reminder[] = [];
  for (const r of items) {
    if (!['active', 'cancelling'].includes(r.status)) continue;
    const days = (Date.parse(r.next_date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000;
    let key: string;
    let title: string;
    let text: string;
    const cost = `${r.cost_type === 'estimated' ? '估算' : '每期'}费用 ¥${money(r.amount_cents)}`;
    if (r.kind === 'prepaid') {
      const minimum = Math.max(r.amount_cents, r.low_balance_cents ?? 0);
      const balance = r.balance_cents!;
      const lowNow = balance < minimum;
      const lowAfter = days <= config.lead_days && balance - r.amount_cents < minimum;
      if (!lowNow && !lowAfter) continue;
      const latest = db().prepare('SELECT id FROM balance_entries WHERE subscription_id=? ORDER BY sequence DESC LIMIT 1').get(r.id) as { id: string } | undefined;
      key = `balance:${r.id}:${r.next_date}:${latest?.id ?? ''}:${minimum}:${lowNow ? 'now' : 'next'}`;
      title = `${r.name}：${lowNow ? '余额不足，请充值' : '下次扣减后余额偏低'}`;
      const expected = lowNow ? balance : balance - r.amount_cents;
      text = `${title}\n账面余额 ¥${money(balance)} · ${cost}\n下次扣减 ${r.next_date}\n${lowNow ? '当前' : '扣减后预计'}距提醒标准还差 ¥${money(minimum - expected)}\n余额核对日期 ${r.balance_as_of}；以平台实际余额为准。`;
    } else {
      if (days > config.lead_days) continue;
      key = `renewal:${r.id}:${r.next_date}:${days > 0 ? 'before' : 'due'}`;
      title = `${r.name}：${days > 0 ? `${days} 天后续费` : days === 0 ? '今天需要续费' : '续费计划已逾期'}`;
      text = `${title}\n计划日期 ${r.next_date} · 每期 ¥${money(r.amount_cents)}\n请核对是否续费，已完成后在账本记录。`;
    }
    if (config.base_url) text += `\n${config.base_url}/#all?item=${r.id}`;
    result.push({ key, subscription_id: r.id, kind: r.kind === 'prepaid' ? 'low_balance' : 'renewal', title, text, date: r.next_date });
  }
  return result;
}

export class DeliveryError extends Error {
  constructor(message: string, public retryAfter = 0) { super(message); }
}
export async function sendTelegram(text: string, config = settings(), fetcher: typeof fetch = fetch): Promise<void> {
  if (!config.token || !config.chat_id) throw new DeliveryError('尚未配置独立 Telegram Bot 和接收目标');
  try {
    const response = await fetcher(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chat_id, text, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.json() as { ok?: boolean; error_code?: number; parameters?: { retry_after?: number } };
    if (!response.ok || body.ok !== true) {
      const retry = Number(body.parameters?.retry_after ?? 0);
      throw new DeliveryError(`Telegram 发送失败（${response.status}/${body.error_code ?? 'unknown'}）`, Number.isFinite(retry) ? Math.min(86400, Math.max(0, retry)) : 0);
    }
  } catch (error) {
    // fetch 错误可能含请求 URL（包括 Token），不得记录或返回原始异常。
    if (error instanceof DeliveryError) throw error;
    throw new DeliveryError('Telegram 网络请求失败或超时，稍后重试');
  }
}

export async function tick(fetcher: typeof fetch = fetch): Promise<{ charged: number; sent: number; errors: number }> {
  const settled = settleAll();
  let sent = 0;
  let errors = settled.errors.length;
  const config = settings();
  if (config.enabled) {
    const active = db().transaction(() => reminders(rows(), todayInShanghai(), config))();
    const keys = new Set(active.map(r => r.key));
    db().transaction(() => {
      for (const r of active) db().prepare("INSERT INTO notifications(notification_key,subscription_id,payload) VALUES (?,?,?) ON CONFLICT(notification_key) DO UPDATE SET payload=excluded.payload,status=CASE WHEN notifications.status='cancelled' THEN 'pending' ELSE notifications.status END").run(r.key, r.subscription_id, JSON.stringify(r));
      for (const row of db().prepare("SELECT notification_key FROM notifications WHERE status IN ('pending','sending')").all() as Array<{ notification_key: string }>) {
        if (!keys.has(row.notification_key)) db().prepare("UPDATE notifications SET status='cancelled' WHERE notification_key=?").run(row.notification_key);
      }
    }).immediate();
    for (let i = 0; i < 20; i++) {
      const row = db().transaction(() => {
        const found = db().prepare("SELECT notification_key,payload,attempts FROM notifications WHERE status IN ('pending','sending') AND retry_at<=? ORDER BY rowid LIMIT 1")
          .get(Date.now()) as { notification_key: string; payload: string; attempts: number } | undefined;
        if (found) db().prepare("UPDATE notifications SET status='sending',attempts=attempts+1,retry_at=? WHERE notification_key=?").run(Date.now() + 60000, found.notification_key);
        return found;
      }).immediate();
      if (!row) break;
      try {
        const current = settings();
        const reminder = current.enabled ? db().transaction(() => reminders(rows(), todayInShanghai(), current).find(r => r.key === row.notification_key))() : undefined;
        if (!reminder) {
          db().prepare("UPDATE notifications SET status='cancelled' WHERE notification_key=?").run(row.notification_key);
          continue;
        }
        await sendTelegram(reminder.text, current, fetcher);
        db().prepare("UPDATE notifications SET status='sent',sent_at=?,error=NULL WHERE notification_key=?").run(nowIsoInShanghai(), row.notification_key);
        sent++;
      } catch (error) {
        const retry = error instanceof DeliveryError ? error.retryAfter * 1000 : 0;
        const delay = Math.max(retry, Math.min(3600000, 60000 * 2 ** Math.min(row.attempts, 6)));
        db().prepare("UPDATE notifications SET status='pending',retry_at=?,error=? WHERE notification_key=?").run(Date.now() + delay, error instanceof DeliveryError ? error.message : '发送失败', row.notification_key);
        errors++;
      }
    }
  }
  db().prepare('INSERT INTO worker_state VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at,error=excluded.error')
    .run(nowIsoInShanghai(), errors ? `本次有 ${errors} 项未完成，请检查余额计划或通知发送记录` : null);
  return { charged: settled.count, sent, errors };
}

/** 配置页面主动读取新 Bot 的最近私聊；不推进 offset，不消费更新。 */
export async function telegramChats(tokenInput: unknown, fetcher: typeof fetch = fetch): Promise<Array<{ id: string; label: string }>> {
  const token = tokenInput || settings().token;
  if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]{20,200}$/.test(token)) throw new DomainError('请先填写独立 Bot Token');
  try {
    const res = await fetcher(`https://api.telegram.org/bot${token}/getUpdates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 100, timeout: 0, allowed_updates: ['message'] }), signal: AbortSignal.timeout(10000) });
    const data = await res.json() as { ok?: boolean; result?: Array<{ message?: { chat?: { id: number; type: string; first_name?: string; username?: string } } }> };
    if (!res.ok || !data.ok || !Array.isArray(data.result)) throw new DeliveryError(`无法读取 Bot 私聊（${res.status}），请确认这是未配置 webhook 的独立 Bot`);
    const chats = new Map<string, { id: string; label: string }>();
    for (const update of data.result) {
      const c = update.message?.chat;
      if (c?.type === 'private') chats.set(String(c.id), { id: String(c.id), label: c.first_name || c.username || String(c.id) });
    }
    return [...chats.values()];
  } catch (e) {
    if (e instanceof DeliveryError) throw e;
    throw new DeliveryError('读取 Telegram 私聊失败，请稍后重试');
  }
}
