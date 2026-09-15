'use client';

import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, Clock3, Download, FileJson, KeyRound, RefreshCw, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { useLedger } from './ledger-context';

interface NotificationConfig {
  enabled: boolean;
  token_configured: boolean;
  chat_id: string;
  lead_days: number;
  base_url: string;
  worker: { checked_at: string; error: string | null } | null;
  recent: { notification_key: string; status: string; error: string | null; sent_at: string | null }[];
}
interface Token { id: string; name: string; scope: 'read' | 'write'; created_at: string }
type FeedbackArea = 'telegram' | 'agent' | 'general';

export default function IntegrationsSettings() {
  const { confirm } = useLedger();
  const [config, setConfig] = useState<NotificationConfig | null>(null);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [chats, setChats] = useState<Array<{ id: string; label: string }>>([]);
  const [secret, setSecret] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [feedbackArea, setFeedbackArea] = useState<FeedbackArea>('general');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const [n, t] = await Promise.all([api<NotificationConfig>('/api/notifications'), api<Token[]>('/api/tokens')]);
    setConfig(n);
    setTokens(t);
  };
  const run = async (area: FeedbackArea, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setFeedbackArea(area);
    setError('');
    setStatus('');
    try { await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, []);

  const save = (form: HTMLFormElement) => run('telegram', async () => {
    const f = new FormData(form);
    const result = await api<NotificationConfig>('/api/notifications', 'PUT', {
      enabled: f.get('enabled') === 'on', token: f.get('token'), chat_id: f.get('chat_id'),
      lead_days: Number(f.get('lead_days')), base_url: f.get('base_url'),
    });
    setConfig(result);
    (form.elements.namedItem('token') as HTMLInputElement).value = '';
    setChats([]);
    setStatus('通知设置已保存。');
  });
  const findChats = (form: HTMLFormElement) => run('telegram', async () => {
    const list = await api<Array<{ id: string; label: string }>>('/api/notifications/chats', 'POST', {
      token: new FormData(form).get('token'),
    });
    setChats(list);
    setStatus(list.length ? '已读取私聊，请选择接收人后保存设置。' : '没有最近私聊，请先向新 Bot 发送 /start，再重试。');
  });
  const test = () => run('telegram', async () => {
    if (!await confirm({ title: '发送 Telegram 测试通知？', body: '使用已保存的独立 Bot，向已配置的 Chat ID 发送一条测试消息。', accept: '发送测试', danger: false })) return;
    await api('/api/notifications/test', 'POST', { confirm: true });
    setStatus('测试消息已发送。');
  });
  const create = (form: HTMLFormElement) => run('agent', async () => {
    const token = await api<Token & { token: string }>('/api/tokens', 'POST', Object.fromEntries(new FormData(form)));
    setSecret(token.token);
    form.reset();
    await refresh();
    setStatus('令牌已创建，请保存下方完整令牌。');
  });
  const revoke = (token: Token) => run('agent', async () => {
    if (!await confirm({ title: `撤销「${token.name}」的访问？`, body: '使用此令牌的 Agent 将立即失去账本访问权限。', accept: '撤销令牌' })) return;
    await api(`/api/tokens/${token.id}`, 'DELETE', { confirm: true });
    await refresh();
    setStatus('令牌已撤销。');
  });
  const feedback = (area: FeedbackArea) => feedbackArea === area && (error || status) ? (
    <p className={`settings-feedback${error ? ' is-error' : ''}`} role={error ? 'alert' : 'status'}>{error || status}</p>
  ) : null;
  const workerStale = !config?.worker || Date.now() - Date.parse(config.worker.checked_at) > 180000;

  return (
    <section className="integrations" aria-labelledby="integrations-title">
      <header className="settings-section-heading">
        <h2 id="integrations-title">通知与 Agent 接入</h2>
        <p>设置提醒渠道，管理 Agent 的账本访问权限。</p>
      </header>
      {feedback('general')}
      <div className="integrations-grid">
        <article className="integration-card integration-card--wide notification-settings" aria-labelledby="telegram-title">
          <header className="integration-card-head">
            <div className="integration-title"><Send aria-hidden="true" /><h3 id="telegram-title">独立 Telegram 通知</h3>
              {config && <span className={`settings-badge${config.enabled ? ' is-active' : ''}`}>{config.enabled ? '已启用' : '未启用'}</span>}
            </div>
            {config && (<label className="notification-toggle" htmlFor="notifications-enabled">
                  <span className="toggle-copy"><strong>启用 Telegram 通知</strong><small>保存设置后生效</small></span>
                  <input id="notifications-enabled" type="checkbox" name="enabled" form="telegram-settings-form" defaultChecked={config.enabled} role="switch" aria-label="启用 Telegram 通知" />
                  <span className="toggle-track" aria-hidden="true" />
                </label>)}
          </header>
          <p className="integration-intro">用专用 Bot 接收续费与余额提醒，与 Hermes 独立运行。</p>
          {!config ? (
            <div className="integration-loading"><button className="ghost" disabled={busy} onClick={() => void run('telegram', refresh)}>重新加载设置</button>{feedback('telegram')}</div>
          ) : (
            <>
              <form id="telegram-settings-form" className="settings-form notification-form" onSubmit={e => { e.preventDefault(); void save(e.currentTarget); }}>

                <fieldset className="settings-fieldset">
                  <legend>连接信息</legend>
                  <label htmlFor="notification-token">独立 Bot Token
                    <input id="notification-token" type="password" name="token" autoComplete="new-password" aria-describedby="notification-token-hint" placeholder={config.token_configured ? '已设置，留空保留' : '粘贴 BotFather 提供的 Token'} />
                  </label>
                  <p id="notification-token-hint" className="settings-hint">在 <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">BotFather</a> 创建 Bot 后，先向新 Bot 发送 <code>/start</code>。</p>
                  <div className="settings-field">
                    <label htmlFor="notification-chat">接收 Chat ID</label>
                    <div className="input-action">
                      <input id="notification-chat" name="chat_id" inputMode="text" defaultValue={config.chat_id} placeholder="例如 123456789" />
                      <button type="button" className="ghost" disabled={busy} aria-label="读取 Bot 最近私聊" onClick={e => { if (e.currentTarget.form) void findChats(e.currentTarget.form); }}>读取私聊</button>
                    </div>
                  </div>
                  {chats.length > 0 && <label>选择接收人
                    <select defaultValue="" onChange={e => {
                      const input = e.target.form?.elements.namedItem('chat_id') as HTMLInputElement;
                      if (input) input.value = e.target.value;
                    }}>
                      <option value="" disabled>请选择你的私聊</option>
                      {chats.map(c => <option key={c.id} value={c.id}>{c.label} · {c.id}</option>)}
                    </select>
                  </label>}
                </fieldset>
                <fieldset className="settings-fieldset">
                  <legend>提醒偏好</legend>
                  <div className="notification-preferences">
                    <div className="settings-field">
                      <label htmlFor="notification-lead">提前提醒天数</label>
                      <div className="input-unit"><input id="notification-lead" name="lead_days" type="number" min={0} max={30} required defaultValue={config.lead_days} /><span aria-hidden="true">天</span></div>
                    </div>
                    <label htmlFor="notification-url">账本访问地址 <span className="field-optional">选填</span>
                      <input id="notification-url" name="base_url" type="url" defaultValue={config.base_url} placeholder="https://你的账本域名" />
                    </label>
                  </div>
                  <p className="settings-hint">填写访问地址后，提醒消息会附上账本详情链接。</p>
                </fieldset>
                {feedback('telegram')}
                <div className="settings-actions">
                  <button type="submit" disabled={busy}>{busy && feedbackArea === 'telegram' ? '处理中…' : '保存通知设置'}</button>
                  <button type="button" className="ghost" disabled={busy || !config.token_configured || !config.chat_id} onClick={() => void test()}><Send aria-hidden="true" />发送测试通知</button>
                </div>
              </form>
              <details className="notification-diagnostics">
                <summary>
                  <span className={`worker-indicator${workerStale || config.worker?.error ? ' is-pending' : ''}`}>
                    {workerStale ? <Clock3 aria-hidden="true" /> : <Check aria-hidden="true" />}
                    {workerStale ? '自动记账尚未就绪' : config.worker?.error ? '后台任务有待处理项' : '自动记账运行正常'}
                  </span>
                  <span className="diagnostics-label">运行记录<ChevronDown aria-hidden="true" /></span>
                </summary>
                <div className="diagnostics-body">
                  <p>{!config.worker ? '后台任务尚未启动，自动记账与通知暂不可用。' : `最近检查：${config.worker.checked_at}${workerStale ? '，超过 3 分钟未更新。' : ''}`}</p>
                  {config.worker?.error && <p className="error">{config.worker.error}</p>}
                  <h4>最近发送记录</h4>
                  {config.recent.length ? <ul className="delivery-list">{config.recent.map(r => (
                    <li key={r.notification_key}><span className="settings-badge">{({ sent: '已发送', pending: '等待重试', sending: '发送中', cancelled: '已取消' } as Record<string, string>)[r.status]}</span><span>{r.sent_at ?? r.error ?? '等待发送'}</span></li>
                  ))}</ul> : <p className="muted">暂无发送记录</p>}
                  <button type="button" className="ghost" disabled={busy} onClick={() => void run('telegram', refresh)}><RefreshCw aria-hidden="true" />刷新状态</button>
                </div>
              </details>
            </>
          )}
        </article>
        <article className="integration-card integration-card--wide agent-settings" aria-labelledby="agent-title">
          <header className="integration-card-head">
            <div className="integration-title"><KeyRound aria-hidden="true" /><h3 id="agent-title">Agent API 与 Skill</h3></div>
            <span className="settings-badge">{tokens.length ? `${tokens.length} 个令牌` : '未接入'}</span>
          </header>
          <p className="integration-intro">授权 Hermes 等 Agent 查询提醒、记录和管理账本。</p>
          <div className="agent-layout">
            <div className="agent-setup">
          <form className="settings-form" onSubmit={e => { e.preventDefault(); void create(e.currentTarget); }}>
            <fieldset className="settings-fieldset">
              <legend>创建访问令牌</legend>
              <label>令牌名称<input name="name" required maxLength={80} placeholder="例如 Hermes" /></label>
              <label>访问权限<select name="scope" defaultValue="read"><option value="read">只读（查询与提醒）</option><option value="write">读写（新增、修改与记账）</option></select></label>
            </fieldset>
            {feedback('agent')}
            <div className="settings-actions"><button disabled={busy}><KeyRound aria-hidden="true" />{busy && feedbackArea === 'agent' ? '处理中…' : '创建令牌'}</button></div>
          </form>
          {secret && <div className="token-result">
            <label>完整令牌（仅本次显示）<textarea readOnly value={secret} rows={3} spellCheck={false} onFocus={e => e.currentTarget.select()} /></label>
            <p className="settings-hint">保存为环境变量 <code>LEDGER_API_TOKEN</code>，账本地址填入 <code>LEDGER_BASE_URL</code>。</p>
            <button className="ghost" onClick={() => { setSecret(''); setStatus(''); }}>我已保存，隐藏令牌</button>
          </div>}
            </div>
            <div className="agent-access">
          <div className="agent-resources">
            <a href="/api/openapi.json" target="_blank" rel="noreferrer"><FileJson aria-hidden="true" /><span>接口文档<small>OpenAPI</small></span><ArrowUpRight aria-hidden="true" /></a>
            <a href="/skills/subscription-ledger.zip" download><Download aria-hidden="true" /><span>下载 Skill<small>Hermes 等 Agent</small></span><ArrowUpRight aria-hidden="true" /></a>
          </div>
          <section className="connected-agents" aria-label="已创建的访问令牌">
            <div className="connected-agents-heading"><h4>访问令牌</h4><span>{tokens.length}</span></div>
            {tokens.length ? <ul className="token-list">{tokens.map(t => (
              <li key={t.id}><div className="token-info"><strong>{t.name}</strong><small>{t.scope === 'read' ? '只读' : '读写'} · 创建于 {t.created_at.slice(0, 10)}</small></div><button className="ghost" disabled={busy} onClick={() => void revoke(t)}>撤销</button></li>
            ))}</ul> : <p className="token-empty">还没有访问令牌。创建后即可连接你的 Agent。</p>}
          </section>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}
