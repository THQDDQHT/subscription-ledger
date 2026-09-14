'use client';

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { Renewal, SessionInfo, Subscription, Summary, ViewKey } from '@/lib/types';

export interface ConfirmOptions {
  title: string;
  body: string;
  note?: string;
  accept?: string;
  danger?: boolean;
}

export interface Message {
  text: string;
  ok: boolean;
}

export interface LedgerContextValue {
  booted: boolean;
  authed: boolean;
  configured: boolean;
  items: Subscription[];
  stats: Summary | null;
  today: string;
  view: ViewKey;
  selectedId: string;
  filter: string;
  sort: 'date' | 'name' | 'amount';
  keyword: string;
  collapsed: ReadonlySet<string>;
  searching: boolean;
  loading: boolean;
  loadError: string;
  message: Message | null;
  detailError: string;
  wide: boolean;
  detailRef: React.RefObject<HTMLDialogElement | null>;
  listScrollRef: React.RefObject<HTMLDivElement | null>;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  load: () => Promise<void>;
  navigate: (view: ViewKey) => void;
  showDetail: (r: Subscription) => void;
  closeDetail: () => void;
  openEditor: (r: Subscription | null) => void;
  openRenew: (r: Subscription) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  setFilter: (value: string) => void;
  setSort: (value: 'date' | 'name' | 'amount') => void;
  setKeyword: (value: string) => void;
  setGroupCollapsed: (key: string, open: boolean) => void;
  reportOk: (text: string) => void;
  reportError: (error: unknown) => void;
  clearReport: () => void;
  fetchHistory: (id: string) => Promise<Renewal[]>;
  /** 操作后的焦点恢复，取值如 `${id}:detail` / `${id}:renew`。 */
  setFocusKey: (key: string) => void;
}

export const LedgerContext = createContext<LedgerContextValue | null>(null);

export function useLedger(): LedgerContextValue {
  const ctx = useContext(LedgerContext);
  if (!ctx) throw new Error('useLedger 必须在 LedgerApp 内使用');
  return ctx;
}

export type { Renewal, SessionInfo, Subscription, Summary, ViewKey };
