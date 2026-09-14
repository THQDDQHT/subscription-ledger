'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, setCsrf, setSessionExpiredHandler, ApiError } from '@/lib/api';
import { parseRoute, routeURL, defaultCollapsed, recentGroup } from '@/lib/grouping';
import type { Renewal, Subscription, Summary, ViewKey } from '@/lib/types';
import { LedgerContext, type ConfirmOptions, type LedgerContextValue, type Message } from './ledger-context';
import LoginPanel from './LoginPanel';
import { Sidebar, Topbar, MobileNav } from './shell';
import Overview from './Overview';
import SubscriptionList from './SubscriptionList';
import DetailPanel from './DetailPanel';
import { ConfirmDialog, EditorDialog, RenewDialog } from './dialogs';
import BackupView from './BackupView';

const TITLES: Record<ViewKey, [string, string]> = {
  recent: ['近期处理', '先处理到期事项，再整理订阅'],
  all: ['全部订阅', '查找、比较与管理全部订阅'],
  backup: ['数据备份', '备份你的账本，按需恢复'],
};

interface ConfirmState extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

export default function LedgerApp() {
  const [booted, setBooted] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [items, setItems] = useState<Subscription[]>([]);
  const [stats, setStats] = useState<Summary | null>(null);
  const [view, setView] = useState<ViewKey>('recent');
  const [selectedId, setSelectedId] = useState('');
  const [filter, setFilterState] = useState('all');
  const [sort, setSortState] = useState<'date' | 'name' | 'amount'>('date');
  const [keyword, setKeywordState] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set(defaultCollapsed));
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState<Message | null>(null);
  const [detailError, setDetailError] = useState('');
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [wide, setWide] = useState(true);
  const [editing, setEditing] = useState<Subscription | null | undefined>(undefined);
  const [renewing, setRenewing] = useState<Subscription | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  const detailRef = useRef<HTMLDialogElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const reportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyCache = useRef(new Map<string, Promise<Renewal[]>>());
  const focusKeyRef = useRef('');
  const [focusTick, setFocusTick] = useState(0);

  const today = stats?.today ?? '';
  const searching = keyword.trim().length > 0;

  // ---------- 回执 ----------

  const clearReport = useCallback(() => {
    if (reportTimer.current) clearTimeout(reportTimer.current);
    setMessage(null);
  }, []);

  const reportOk = useCallback((text: string) => {
    if (reportTimer.current) clearTimeout(reportTimer.current);
    setMessage({ text, ok: true });
    reportTimer.current = setTimeout(() => setMessage(null), 6000);
  }, []);

  const reportError = useCallback((error: unknown) => {
    if (reportTimer.current) clearTimeout(reportTimer.current);
    const text = error instanceof Error ? error.message : String(error);
    setMessage({ text, ok: false });
    setDetailError((current) => (detailRef.current?.open ? text : current));
  }, []);

  // ---------- 会话失效：清空全部私有状态并回到登录页 ----------

  const resetPrivateState = useCallback(() => {
    setItems([]);
    setStats(null);
    setView('recent');
    setSelectedId('');
    setFilterState('all');
    setSortState('date');
    setKeywordState('');
    setCollapsed(new Set(defaultCollapsed));
    setFiltersOpen(false);
    setDetailError('');
    setLoadError('');
    setMessage(null);
    setEditing(undefined);
    setRenewing(null);
    setConfirmState((current) => {
      current?.resolve(false);
      return null;
    });
    historyCache.current.clear();
    history.replaceState(null, '', location.pathname + location.search);
    setAuthed(false);
  }, []);

  useEffect(() => {
    setSessionExpiredHandler(resetPrivateState);
  }, [resetPrivateState]);

  // ---------- 加载 ----------

  const applyRoute = useCallback(() => {
    const route = parseRoute(location.hash);
    if (route.view !== view) {
      setKeywordState('');
      setFilterState('all');
      if (listScrollRef.current) listScrollRef.current.scrollTop = 0;
    }
    setView(route.view);
    setSelectedId(route.id);
    setDetailError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const load = useCallback(async () => {
    const first = items.length === 0;
    let pending: ReturnType<typeof setTimeout> | undefined;
    if (first) pending = setTimeout(() => setLoading(true), 120);
    try {
      const [list, summary] = await Promise.all([api<Subscription[]>('/api/items'), api<Summary>('/api/summary')]);
      setItems(list);
      setStats(summary);
      setLoadError('');
      historyCache.current.clear();
      applyRoute();
    } catch (error) {
      if (first) setLoadError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      if (pending) clearTimeout(pending);
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, applyRoute]);

  // ---------- 会话引导 ----------

  useEffect(() => {
    (async () => {
      try {
        const s = await api<{ authenticated: boolean; csrf: string; configured: boolean }>('/api/session');
        setCsrf(s.csrf);
        setConfigured(s.configured);
        setAuthed(s.authenticated);
        if (!s.configured) reportError(new Error('尚未设置密码，请在服务器按 README 初始化。'));
        if (s.authenticated) await load();
      } catch (error) {
        reportError(error);
      } finally {
        setBooted(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 路由 ----------

  useEffect(() => {
    const onHash = () => applyRoute();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [applyRoute]);

  const navigate = useCallback((next: ViewKey) => {
    location.hash = routeURL(next);
  }, []);

  const showDetail = useCallback(
    (r: Subscription) => {
      location.hash = routeURL(view, r.id);
    },
    [view],
  );

  const closeDetail = useCallback(() => {
    focusKeyRef.current = selectedId ? `${selectedId}:detail` : '';
    setFocusTick((n) => n + 1);
    setSelectedId('');
    history.replaceState(null, '', routeURL(view));
  }, [selectedId, view]);

  // ---------- 详情弹窗形态：宽屏并排（非模态），窄屏模态 ----------

  const editorOpen = editing !== undefined;
  const renewOpen = renewing !== null;
  const confirmOpen = confirmState !== null;

  useEffect(() => {
    const mq = window.matchMedia('(max-width:1279px)');
    const update = () => setWide(!mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const d = detailRef.current;
    if (!d) return;
    if (!selectedId || !authed) {
      if (d.open) d.close();
      return;
    }
    if (editorOpen || renewOpen || confirmOpen) return;
    const modal = !wide;
    if (d.open && d.dataset.modal === String(modal)) return;
    if (d.open) d.close();
    d.dataset.modal = String(modal);
    if (modal) d.showModal();
    else d.show();
  }, [selectedId, authed, editorOpen, renewOpen, confirmOpen, wide]);

  // ---------- 动作 ----------

  const login = useCallback(
    async (password: string) => {
      const session = await api<{ csrf: string }>('/api/session');
      setCsrf(session.csrf);
      const result = await api<{ csrf: string }>('/api/login', 'POST', { password });
      setCsrf(result.csrf);
      setAuthed(true);
      setDetailError('');
      await load();
    },
    [load],
  );

  const logout = useCallback(async () => {
    try {
      await api('/api/logout', 'POST', {});
      location.reload();
    } catch (error) {
      reportError(error);
    }
  }, [reportError]);

  const openEditor = useCallback((r: Subscription | null) => setEditing(r), []);
  const openRenew = useCallback((r: Subscription) => setRenewing(r), []);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setConfirmState({ ...options, resolve });
    });
  }, []);

  const setFilter = useCallback((value: string) => {
    setFilterState(value);
    if (listScrollRef.current) listScrollRef.current.scrollTop = 0;
  }, []);

  const setSort = useCallback((value: 'date' | 'name' | 'amount') => setSortState(value), []);

  const setKeyword = useCallback((value: string) => {
    setKeywordState(value);
    if (listScrollRef.current) listScrollRef.current.scrollTop = 0;
  }, []);

  const setGroupCollapsed = useCallback((key: string, open: boolean) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (open) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const setFocusKey = useCallback((key: string) => {
    focusKeyRef.current = key;
    setFocusTick((n) => n + 1);
  }, []);

  const fetchHistory = useCallback((id: string) => {
    if (!historyCache.current.has(id)) {
      const pending = api<Renewal[]>(`/api/items/${id}/renewals`).catch((error) => {
        historyCache.current.delete(id);
        throw error;
      });
      historyCache.current.set(id, pending);
    }
    return historyCache.current.get(id) as Promise<Renewal[]>;
  }, []);

  // ---------- 焦点恢复（对应原 restoreListFocus） ----------

  useEffect(() => {
    const want = focusKeyRef.current;
    if (!want) return;
    focusKeyRef.current = '';
    const d = detailRef.current;
    if (d?.open) {
      d.querySelector<HTMLButtonElement>('#close-detail')?.focus({ preventScroll: true });
      return;
    }
    const id = want.split(':')[0];
    const target =
      document.querySelector<HTMLElement>(`[data-key="${want}"]`) ??
      document.querySelector<HTMLElement>(`[data-key="${id}:detail"]`);
    const group = target?.closest('details');
    if (target && (!group || group.open)) target.focus({ preventScroll: true });
    else document.querySelector<HTMLElement>(`[data-view="${view}"]`)?.focus({ preventScroll: true });
  }, [focusTick, items, view]);

  // ---------- 快捷键：/ 聚焦搜索，N 新增，Esc 关闭并排详情 ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !authed) return;
      const target = e.target as HTMLElement;
      const typing = Boolean(target.closest('input,textarea,select,[contenteditable]'));
      const modalOpen =
        editorOpen || renewOpen || confirmOpen || (detailRef.current?.dataset.modal === 'true' && detailRef.current.open);
      if (e.key === 'Escape') {
        if (modalOpen || (typing && (target as HTMLInputElement).value)) return;
        if (detailRef.current?.open) {
          e.preventDefault();
          closeDetail();
        }
        return;
      }
      if (typing || modalOpen || view === 'backup') return;
      if (e.key === '/') {
        e.preventDefault();
        const search = document.querySelector<HTMLInputElement>('#search');
        search?.focus();
        search?.select();
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        setEditing(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [authed, editorOpen, renewOpen, confirmOpen, view, closeDetail]);

  // ---------- 上下文 ----------

  const value: LedgerContextValue = useMemo(
    () => ({
      booted,
      authed,
      configured,
      items,
      stats,
      today,
      view,
      selectedId,
      filter,
      sort,
      keyword,
      collapsed,
      searching,
      loading,
      loadError,
      message,
      detailError,
      wide,
      detailRef,
      listScrollRef,
      login,
      logout,
      load,
      navigate,
      showDetail,
      closeDetail,
      openEditor,
      openRenew,
      confirm,
      setFilter,
      setSort,
      setKeyword,
      setGroupCollapsed,
      reportOk,
      reportError,
      clearReport,
      fetchHistory,
      setFocusKey,
    }),
    [
      booted, authed, configured, items, stats, today, view, selectedId, filter, sort, keyword,
      collapsed, searching, loading, loadError, message, detailError, wide,
      login, logout, load, navigate, showDetail, closeDetail, openEditor, openRenew, confirm,
      setFilter, setSort, setKeyword, setGroupCollapsed, reportOk, reportError, clearReport, fetchHistory, setFocusKey,
    ],
  );

  const selected = items.find((r) => r.id === selectedId) ?? null;
  const recentCount = items.filter((r) => recentGroup(r, today) !== null).length;

  if (!booted) return null;

  return (
    <LedgerContext.Provider value={value}>
      <p id="message" role="status" aria-live="polite" className={message?.ok ? 'ok' : ''}>
        {message?.text ?? ''}
      </p>
      {!authed ? (
        <LoginPanel />
      ) : (
        <div id="ledger" className={`app-shell${navCollapsed ? ' nav-collapsed' : ''}`}>
          <Sidebar recentCount={recentCount} />
          <main className="main-workspace">
            <Topbar
              title={TITLES[view][0]}
              desc={TITLES[view][1]}
              navCollapsed={navCollapsed}
              onToggleNav={() => setNavCollapsed((v) => !v)}
            />
            {view === 'recent' && <Overview />}
            {view !== 'backup' ? (
              <div className={`workspace${selected ? ' has-detail' : ''}${filtersOpen ? ' filters-open' : ''}`} id="board">
                <SubscriptionList filtersOpen={filtersOpen} onToggleFilters={() => setFiltersOpen((v) => !v)} />
                <DetailPanel selected={selected} />
              </div>
            ) : (
              <BackupView />
            )}
          </main>
          <MobileNav />
        </div>
      )}
      {authed && (
        <>
          <EditorDialog editing={editing} onClose={() => setEditing(undefined)} />
          <RenewDialog renewing={renewing} onClose={() => setRenewing(null)} />
          <ConfirmDialog state={confirmState} onDone={(v) => { confirmState?.resolve(v); setConfirmState(null); }} />
        </>
      )}
    </LedgerContext.Provider>
  );
}
