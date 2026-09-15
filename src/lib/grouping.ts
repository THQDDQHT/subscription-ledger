/** 列表分组/筛选/排序与 hash 路由解析。移植自原 app.js。 */
import type { StatusKey, Subscription, ViewKey } from './types';
import { daysUntil } from './format';

export const labels: Record<StatusKey, string> = {
  active: '使用中',
  cancelling: '准备取消',
  cancelled: '已取消续费',
  ended: '已结束',
};

export function isActive(r: Subscription): boolean {
  return r.status === 'active' || r.status === 'cancelling';
}

export type RecentGroupKey = 'low_balance' | 'pending' | 'overdue' | 'week' | 'month';

/** 近期按订阅的当前计划分组；预测事件只用于统计，不生成重复操作。 */
export function recentGroup(r: Subscription, today: string): RecentGroupKey | null {
  if (!isActive(r)) return null;
  const days = daysUntil(r.next_date, today);
  if (r.kind === 'prepaid') {
    if (days <= 0) return 'pending';
    if (r.balance_cents! < Math.max(r.amount_cents, r.low_balance_cents ?? 0)) return 'low_balance';
  }
  return days < 0 ? 'overdue' : days < 7 ? 'week' : days < 30 ? 'month' : null;
}

export interface Group {
  key: string;
  title: string;
  rows: Subscription[];
}

export interface Selection {
  view: ViewKey;
  filter: StatusKey | 'all';
  keyword: string;
  sort: 'date' | 'name' | 'amount';
  today: string;
}

export function selectGroups(items: Subscription[], sel: Selection): Group[] {
  const query = sel.keyword.trim().toLocaleLowerCase();
  const selected = items.filter(
    (r) =>
      (sel.view !== 'recent' || recentGroup(r, sel.today) !== null) &&
      (sel.filter === 'all' || r.status === sel.filter) &&
      (!query || (r.name + ' ' + r.notes).toLocaleLowerCase().includes(query)),
  );
  selected.sort((a, b) => {
    const primary =
      sel.sort === 'name'
        ? a.name.localeCompare(b.name, 'zh-CN')
        : sel.sort === 'amount'
          ? b.amount_cents - a.amount_cents
          : a.next_date < b.next_date
            ? -1
            : a.next_date > b.next_date
              ? 1
              : 0;
    return primary || a.name.localeCompare(b.name, 'zh-CN');
  });
  const definitions: Array<[string, string]> =
    sel.view === 'recent'
      ? [['low_balance', '余额不足，待充值'], ['pending', '待自动扣减'], ['overdue', '逾期未确认'], ['week', '未来 7 天'], ['month', '之后至 30 天']]
      : Object.entries(labels);
  return definitions
    .map(([key, title]) => ({
      key: `${sel.view}:${key}`,
      title,
      rows: selected.filter((r) => (sel.view === 'recent' ? recentGroup(r, sel.today) : r.status) === key),
    }))
    .filter((g) => g.rows.length > 0);
}

export interface Route {
  view: ViewKey;
  id: string;
}

export function parseRoute(hash: string): Route {
  const [view, query] = (hash.replace(/^#/, '') || 'recent').split('?');
  return {
    view: (['recent', 'all', 'backup'].includes(view) ? view : 'recent') as ViewKey,
    id: view === 'backup' ? '' : new URLSearchParams(query).get('item') || '',
  };
}

export function routeURL(view: ViewKey, id = ''): string {
  return '#' + view + (id ? '?item=' + encodeURIComponent(id) : '');
}

/** 默认折叠的分组：对应原 collapsedGroups 初值。 */
export const defaultCollapsed = new Set(['recent:month', 'all:cancelled', 'all:ended']);
