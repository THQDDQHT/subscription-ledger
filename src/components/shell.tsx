'use client';

import { CalendarClock, Contrast, List, LogOut, Moon, PanelLeft, Shield, Sun, X, Plus, Search, Pencil, Check, ExternalLink, Trash2, Download, Upload, ChevronRight, ListFilter, Undo2 } from 'lucide-react';
import { useLedger } from './ledger-context';
import { applyTheme, currentTheme, type ThemeMode } from '@/lib/theme';
import { useState } from 'react';
import type { ViewKey } from '@/lib/types';

export const Icons = { CalendarClock, Contrast, List, LogOut, Moon, PanelLeft, Shield, Sun, X, Plus, Search, Pencil, Check, ExternalLink, Trash2, Download, Upload, ChevronRight, ListFilter, Undo2 };

export function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  return (
    <span className={className} aria-hidden="true">
      <CalendarClock />
    </span>
  );
}

export function ThemePicker({ mobile = false }: { mobile?: boolean }) {
  const [mode, setMode] = useState<ThemeMode>(() => currentTheme());
  const entries: Array<[ThemeMode, typeof Sun, string, string]> = [
    ['system', Contrast, mobile ? '跟随系统' : '系统', '跟随系统'],
    ['light', Sun, '浅色', '浅色'],
    ['dark', Moon, '深色', '深色'],
  ];
  return (
    <div className="theme-picker" role="group" aria-label="外观">
      {entries.map(([value, Icon, text, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={mode === value}
          aria-label={label}
          title={label}
          onClick={() => {
            applyTheme(value, true);
            setMode(value);
          }}
        >
          <Icon aria-hidden="true" />
          <span className="theme-label">{text}</span>
        </button>
      ))}
    </div>
  );
}

const NAV: Array<{ view: ViewKey; label: string; Icon: typeof List }> = [
  { view: 'recent', label: '近期处理', Icon: CalendarClock },
  { view: 'all', label: '全部订阅', Icon: List },
  { view: 'backup', label: '备份与设置', Icon: Shield },
];

export function Sidebar({ recentCount }: { recentCount: number }) {
  const { view, navigate, items, logout } = useLedger();
  return (
    <aside className="sidebar" aria-label="工作空间">
      <div className="brand">
        <BrandMark />
        <div className="brand-copy">
          <b>订阅账本</b>
          <small>个人订阅工作台</small>
        </div>
      </div>
      <nav aria-label="主导航">
        {NAV.map(({ view: v, label, Icon }) => (
          <a key={v} href={`#${v}`} data-view={v} className="nav-item" aria-current={view === v ? 'page' : undefined} onClick={(e) => { e.preventDefault(); navigate(v); }}>
            <Icon aria-hidden="true" />
            <span className="nav-text">{label}</span>
            {v === 'recent' && <span id="recent-count" className="count">{recentCount}</span>}
            {v === 'all' && <span id="all-count" className="count">{items.length}</span>}
          </a>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <ThemePicker />
        <button id="logout" className="nav-item" onClick={() => void logout()}>
          <LogOut aria-hidden="true" />
          <span className="nav-text">退出登录</span>
        </button>
      </div>
    </aside>
  );
}

export function Topbar({ title, desc, navCollapsed, onToggleNav }: { title: string; desc: string; navCollapsed: boolean; onToggleNav: () => void }) {
  const { view, openEditor } = useLedger();
  return (
    <header className="topbar">
      <button
        id="collapse-nav"
        className="icon-btn"
        aria-label={navCollapsed ? '展开导航' : '收起导航'}
        aria-expanded={!navCollapsed}
        onClick={onToggleNav}
      >
        <PanelLeft aria-hidden="true" />
      </button>
      <span className="brand-mark topbar-mark" aria-hidden="true">
        <CalendarClock />
      </span>
      <h1 id="page-title">{title}</h1>
      <span id="page-desc" className="muted">{desc}</span>
      <span className="grow" />
      {view !== 'backup' && (
        <button id="add" title="快捷键 N" onClick={() => openEditor(null)}>
          <Plus aria-hidden="true" />
          新增订阅
        </button>
      )}
    </header>
  );
}

export function MobileNav() {
  const { view, navigate } = useLedger();
  return (
    <nav className="mobile-nav" aria-label="手机导航">
      {NAV.map(({ view: v, label, Icon }) => (
        <a key={v} href={`#${v}`} data-view={v} aria-current={view === v ? 'page' : undefined} onClick={(e) => { e.preventDefault(); navigate(v); }}>
          <Icon aria-hidden="true" />
          {label === '备份与设置' ? '备份' : label}
        </a>
      ))}
    </nav>
  );
}
