'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLedger } from './ledger-context';

interface NotificationConfig {
  enabled: boolean; token_configured: boolean; chat_id: string; lead_days: number; base_url: string;
  worker: { checked_at: string; error: string | null } | null;
  recent: { notification_key: string; status: string; error: string | null; sent_at: string | null }[];
}
interface Token { id: string; name: string; scope: 'read' | 'write'; created_at: string }
export default function IntegrationsSettings() {
  const { confirm } = useLedger();
  const [config, setConfig] = useState<NotificationConfig | null>(null);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [chats, setChats] = useState<Array<{ id: string; label: string }>>([]);
  const [secret, setSecret] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const [n, t] = await Promise.all([api<NotificationConfig>('/api/notifications'), api<Token[]>('/api/tokens')]);
    setConfig(n); setTokens(t);
  };
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(''); setStatus('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, []);
  const save = (form: HTMLFormElement) => run(async () => {
    const f = new FormData(form);
    const result = await api<NotificationConfig>('/api/notifications', 'PUT', {
      enabled: f.get('enabled') === 'on', token: f.get('token'), chat_id: f.get('chat_id'), lead_days: Number(f.get('lead_days')), base_url: f.get('base_url'),
    });
    setConfig(result);
    (form.elements.namedItem('token') as HTMLInputElement).value = '';
    setStatus('通知设置已保存。');
  });
  const findChats = (form: HTMLFormElement) => run(async () => {
    const list = await api<Array<{ id: string; label: string }>>('/api/notifications/chats', 'POST', { token: new FormData(form).get('token') });
    setChats(list);
    setStatus(list.length ? '已读取私聊，请选择接收人后保存设置。' : '没有最近私聊，请先向新 Bot 发送 /start，再重试。');
  });
  const test = () => run(async () => {
    if (!await confirm({ title: '发送 Telegram 测试通知？', body: '使用已保存的独立 Bot，向已配置的 Chat ID 发送一条测试消息。', accept: '发送测试', danger: false })) return;
    await api('/api/notifications/test', 'POST', { confirm: true }); setStatus('测试消息已发送。');
  });
  const create = (form: HTMLFormElement) => run(async () => {
    const token = await api<Token & { token: string }>('/api/tokens', 'POST', Object.fromEntries(new FormData(form)));
    setSecret(token.token); form.reset(); await refresh(); setStatus('令牌已创建，请保存下方完整令牌。');
  });
  const revoke = (token: Token) => run(async () => {
    if (!await confirm({ title: `撤销「${token.name}」的访问？`, body: '使用此令牌的 Agent 将立即失去账本访问权限。', accept: '撤销令牌' })) return;
    await api(`/api/tokens/${token.id}`, 'DELETE', { confirm: true }); await refresh(); setStatus('令牌已撤销。');
  });
  return <section className="integrations" aria-label="通知与 Agent 接入">
    <h2>通知与 Agent 接入</h2>
    {error && <p className="error" role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    <div className="backup-grid">
      <article className="backup-card"><h3>独立 Telegram 通知</h3>
        <p className="muted">使用你新建的 Bot 发送续费与余额提醒。先在 Telegram 向这个 Bot 发送 /start。</p>
        {!config ? <button className="ghost" disabled={busy} onClick={() => void run(refresh)}>加载设置</button> : <>
          <p className={!config.worker || Date.now() - Date.parse(config.worker.checked_at) > 180000 ? 'error' : 'muted'}>
            {!config.worker ? '定时记账尚未运行，请启动 worker。' : `定时任务最近运行：${config.worker.checked_at}${Date.now() - Date.parse(config.worker.checked_at) > 180000 ? '（超过 3 分钟未更新，请检查 worker）' : ''}`}
          </p>
          {config.worker?.error && <p className="error">{config.worker.error}</p>}
          <form className="settings-form" onSubmit={e => { e.preventDefault(); void save(e.currentTarget); }}>
            <label className="check"><input type="checkbox" name="enabled" defaultChecked={config.enabled} />启用 Telegram 通知</label>
            <label>独立 Bot Token<input type="password" name="token" autoComplete="new-password" placeholder={config.token_configured ? '已设置，留空保留' : '粘贴 BotFather 提供的 Token'} /></label>
            <label>接收 Chat ID<input name="chat_id" inputMode="text" defaultValue={config.chat_id} placeholder="例如 123456789" /></label>
            <button type="button" className="ghost" disabled={busy} onClick={e => { if (e.currentTarget.form) void findChats(e.currentTarget.form); }}>读取 Bot 最近私聊</button>
            {chats.length > 0 && <label>选择接收人<select defaultValue="" onChange={e => { const input = e.target.form?.elements.namedItem('chat_id') as HTMLInputElement; if (input) input.value = e.target.value; }}><option value="" disabled>请选择你的私聊</option>{chats.map(c => <option key={c.id} value={c.id}>{c.label} · {c.id}</option>)}</select></label>}
            <label>提前提醒天数<input name="lead_days" type="number" min={0} max={30} required defaultValue={config.lead_days} /></label>
            <label>账本访问地址<input name="base_url" type="url" defaultValue={config.base_url} placeholder="https://你的账本域名" /></label>
            <div className="settings-actions"><button disabled={busy}>保存通知设置</button><button type="button" className="ghost" disabled={busy || !config.token_configured || !config.chat_id} onClick={() => void test()}>发送测试通知</button></div>
          </form>
          <details><summary>最近发送记录</summary>{config.recent.length ? <ul>{config.recent.map(r => <li key={r.notification_key}>{({ sent: '已发送', pending: '等待重试', sending: '发送中', cancelled: '已取消' } as Record<string, string>)[r.status]} · {r.sent_at ?? r.error ?? '等待发送'}</li>)}</ul> : <p className="muted">暂无发送记录</p>}<button className="ghost compact" disabled={busy} onClick={() => void run(refresh)}>刷新状态</button></details>
        </>}
      </article>
      <article className="backup-card"><h3>Agent API 与 Skill</h3>
        <p className="muted">给 Hermes 或其他 Agent 单独的访问令牌。只读令牌可查询提醒；读写令牌可以记账。Hermes 可以使用自己的推送方式。</p>
        <p><a href="/api/openapi.json" target="_blank" rel="noreferrer">查看 OpenAPI 接口说明</a> · <a href="/skills/subscription-ledger.zip" download>下载 Skill</a></p>
        <form className="settings-form" onSubmit={e => { e.preventDefault(); void create(e.currentTarget); }}>
          <label>令牌名称<input name="name" required maxLength={80} placeholder="例如 Hermes" /></label>
          <label>访问权限<select name="scope" defaultValue="read"><option value="read">只读（查询与提醒）</option><option value="write">读写（新增、修改与记账）</option></select></label>
          <button disabled={busy}>创建令牌</button>
        </form>
        {secret && <div className="token-result"><label>完整令牌（仅本次显示）<textarea readOnly value={secret} rows={3} spellCheck={false} onFocus={e => e.currentTarget.select()} /></label><p className="muted">将其保存为 Agent 环境变量 LEDGER_API_TOKEN；LEDGER_BASE_URL 填账本访问地址。</p><button className="ghost" onClick={() => setSecret('')}>我已保存，隐藏令牌</button></div>}
        <ul className="token-list">{tokens.map(t => <li key={t.id}><span>{t.name} · {t.scope === 'read' ? '只读' : '读写'}</span><button className="ghost compact" disabled={busy} onClick={() => void revoke(t)}>撤销</button></li>)}</ul>
      </article>
    </div>
  </section>;
}
