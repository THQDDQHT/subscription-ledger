/** 移植自 scripts/ui_regression.cjs：分组日期边界、搜索/筛选/排序、格式化与路由。 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { selectGroups, parseRoute, routeURL } from '@/lib/grouping';
import { money, moneyCents, friendlyDate, relativeDay, historySummary, recordedAt } from '@/lib/format';
import type { Subscription } from '@/lib/types';

const TODAY = '2026-09-12';

function row(patch: Record<string, unknown>): Subscription {
  return {
    id: '', name: '', notes: '', url: '', amount: '0.00', amount_cents: 0,
    cycle: 'monthly', days: null, next_date: TODAY, auto_renew: false,
    status: 'active', end_date: null, anchor_day: 12, anchor_month: 9, ...patch,
  } as Subscription;
}

const FIXTURE: Subscription[] = [
  row({ id: 'past', name: 'Past', status: 'active', next_date: '2026-09-11', amount_cents: 900 }),
  row({ id: 'today', name: 'Today', status: 'active', next_date: '2026-09-12', amount_cents: 100 }),
  row({ id: 'six', name: 'Six', status: 'cancelling', next_date: '2026-09-18', amount_cents: 500 }),
  row({ id: 'seven', name: 'Seven', status: 'active', next_date: '2026-09-19', amount_cents: 800 }),
  row({ id: 'last', name: 'Last', status: 'active', next_date: '2026-10-11', amount_cents: 300 }),
  row({ id: 'outside', name: 'Outside', status: 'active', next_date: '2026-10-12', amount_cents: 700 }),
  row({ id: 'cancelled', name: 'Cancelled', status: 'cancelled', next_date: '2026-09-12', amount_cents: 200 }),
  row({ id: 'daily', name: 'Daily', notes: '特殊备注', status: 'active', next_date: '2026-09-12', amount_cents: 400 }),
];

function ids(groups: ReturnType<typeof selectGroups>): Array<[string, string[]]> {
  return groups.map((g) => [g.key, g.rows.map((r) => r.id)]);
}

describe('近期分组与筛选排序', () => {
  test('日期边界分组', () => {
    const groups = selectGroups(FIXTURE, { view: 'recent', filter: 'all', keyword: '', sort: 'date', today: TODAY });
    expect(ids(groups)).toEqual([
      ['recent:overdue', ['past']],
      ['recent:week', ['daily', 'today', 'six']],
      ['recent:month', ['seven', 'last']],
    ]);
    // 预测展开不生成重复操作
    expect(groups.flatMap((g) => g.rows).filter((r) => r.id === 'daily')).toHaveLength(1);
  });

  test('名称/备注搜索', () => {
    const groups = selectGroups(FIXTURE, { view: 'recent', filter: 'all', keyword: ' 特殊备注 ', sort: 'date', today: TODAY });
    expect(ids(groups)).toEqual([['recent:week', ['daily']]]);
  });

  test('状态筛选与金额排序', () => {
    let groups = selectGroups(FIXTURE, { view: 'all', filter: 'cancelled', keyword: 'cAnCeL', sort: 'date', today: TODAY });
    expect(ids(groups)).toEqual([['all:cancelled', ['cancelled']]]);
    groups = selectGroups(FIXTURE, { view: 'all', filter: 'active', keyword: '', sort: 'amount', today: TODAY });
    expect(ids(groups)[0][1]).toEqual(['past', 'seven', 'outside', 'daily', 'last', 'today']);
  });

  test('120 条记录与空结果', () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      row({ id: String(i), name: `服务${i}`, status: 'active', next_date: TODAY, amount_cents: i }),
    );
    let groups = selectGroups(many, { view: 'all', filter: 'all', keyword: '', sort: 'date', today: TODAY });
    expect(groups.flatMap((g) => g.rows)).toHaveLength(120);
    groups = selectGroups(many, { view: 'all', filter: 'all', keyword: '不会匹配', sort: 'date', today: TODAY });
    expect(groups).toHaveLength(0);
    groups = selectGroups(FIXTURE, { view: 'recent', filter: 'cancelled', keyword: '', sort: 'date', today: TODAY });
    expect(groups).toHaveLength(0);
  });
});

describe('页面回归（原 test_updated_page_and_favicon）', () => {
  test('编辑器包含季付选项，favicon 为本地 SVG', () => {
    const dialogs = readFileSync(path.resolve(__dirname, '../src/components/dialogs.tsx'), 'utf8');
    expect(dialogs).toContain('value="quarterly"');
    expect(dialogs).toContain('<details');
    const icon = readFileSync(path.resolve(__dirname, '../src/app/icon.svg'), 'utf8');
    expect(icon).toContain('<svg');
  });
});

describe('路由解析', () => {
  test('parseRoute / routeURL', () => {
    expect(parseRoute('#all?item=abc')).toEqual({ view: 'all', id: 'abc' });
    expect(parseRoute('#backup?item=abc')).toEqual({ view: 'backup', id: '' });
    expect(parseRoute('#unknown').view).toBe('recent');
    expect(routeURL('all', 'a b')).toBe('#all?item=a%20b');
  });
});

describe('格式化', () => {
  test('金额千分位', () => {
    expect(money('138.00')).toBe('¥138.00');
    expect(money('34323.97')).toBe('¥34,323.97');
    expect(money('1234567.5')).toBe('¥1,234,567.5');
    expect(moneyCents(77600)).toBe('¥776.00');
  });

  test('中文日期与相对天数', () => {
    expect(friendlyDate('2026-09-08', TODAY)).toBe('9月8日 周二');
    expect(friendlyDate('2027-01-31', TODAY)).toBe('2027年1月31日 周日');
    expect(friendlyDate('', TODAY)).toBe('');
    expect(relativeDay('2026-09-08', TODAY)).toEqual({ text: '逾期 4 天', cls: 'overdue' });
    expect(relativeDay('2026-09-12', TODAY)).toEqual({ text: '今天', cls: 'soon' });
    expect(relativeDay('2026-09-13', TODAY)).toEqual({ text: '明天', cls: 'soon' });
    expect(relativeDay('2026-09-18', TODAY)).toEqual({ text: '还剩 6 天', cls: 'soon' });
    expect(relativeDay('2026-09-19', TODAY)).toEqual({ text: '还剩 7 天', cls: '' });
  });

  test('续费历史摘要与记录时间', () => {
    expect(historySummary([])).toBe('共 0 次');
    expect(historySummary([{ amount_cents: 1230 }, { amount_cents: 3050 }])).toBe('共 2 次 · 实付合计 ¥42.80');
    expect(historySummary([{ amount_cents: 1230 }, { amount_cents: null }])).toBe('共 2 次 · 实付合计 ¥12.30（1 次早期记录未含金额，不计入）');
    expect(historySummary([{ amount_cents: null }])).toBe('共 1 次（1 次早期记录未含金额，不计入）');
    expect(recordedAt('2026-09-12T20:15:30+08:00')).toBe('2026-09-12 20:15');
    expect(recordedAt(null)).toBe('');
  });
});
