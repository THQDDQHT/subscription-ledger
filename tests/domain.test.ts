import { describe, expect, test, afterEach } from 'vitest';
import { validate, summary, domain, type SubscriptionRecord } from '@/server/domain';

/** 与 tests/test_ledger.py 的 item() 对应的构造器。 */
export function item(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '测试', amount: '12.30', cycle: 'monthly', days: null,
    next_date: '2024-01-31', auto_renew: true, status: 'active',
    end_date: null, url: '', notes: '', ...patch,
  };
}

describe('日期递推与锚点', () => {
  test('月付/年付的月底与闰年锚点', () => {
    let r = validate(item());
    expect(domain.advance(r)).toBe('2024-02-29');
    r.next_date = domain.advance(r);
    expect(domain.advance(r)).toBe('2024-03-31');
    r = validate(item({ cycle: 'yearly', next_date: '2024-02-29' }));
    for (const _year of [2025, 2026, 2027, 2028]) r.next_date = domain.advance(r);
    expect(r.next_date).toBe('2028-02-29');
    expect(domain.advance(validate(item({ next_date: '2023-01-31' })))).toBe('2023-02-28');
    expect(domain.advance(validate(item({ next_date: '2024-12-31' })))).toBe('2025-01-31');
  });

  test.each([
    ['2024-01-31', ['2024-04-30', '2024-07-31', '2024-10-31', '2025-01-31']],
    ['2023-11-30', ['2024-02-29', '2024-05-30']],
    ['2024-11-30', ['2025-02-28', '2025-05-30']],
    ['2024-02-29', ['2024-05-29', '2024-08-29', '2024-11-29', '2025-02-28']],
  ])('季付按三个日历月递推并保留日锚点：%s', (start, expected) => {
    const row = validate(item({ cycle: 'quarterly', next_date: start }));
    const anchor = row.anchor_day;
    for (const target of expected) {
      row.next_date = domain.advance(row);
      expect(row.next_date).toBe(target);
      expect(row.anchor_day).toBe(anchor);
    }
  });
});

describe('校验', () => {
  test.each([
    { amount: '1.001' }, { amount: 'NaN' }, { amount: '-1' }, { amount: 1.2 },
    { url: 'javascript:alert(1)' }, { cycle: 'days', days: 0 }, { status: 'bad' },
    { next_date: '2024-02-30' }, { auto_renew: 'yes' }, { name: '' },
  ])('非法输入被拒绝：%o', (patch) => {
    expect(() => validate(item(patch))).toThrow();
  });
});

describe('统计', () => {
  test('预算折算、预测窗口与状态排除', () => {
    const r = validate(item({ cycle: 'days', days: 10, next_date: '2024-01-01', amount: '10.00' }));
    const s = summary([r], '2024-01-01');
    expect(s.forecast_30).toBe('30.00');
    expect(s.monthly_budget).toBe('30.42');
    expect(s.upcoming_7).toHaveLength(1);
    expect(s.upcoming_30).toHaveLength(3);
    for (const status of ['cancelled', 'ended']) {
      expect(summary([{ ...r, status }], '2024-01-01').forecast_30).toBe('0.00');
    }
    expect(summary([{ ...r, status: 'cancelling' }], '2024-01-01').forecast_30).toBe('30.00');
    expect(summary([r], '2024-01-02').overdue[0].next_date).toBe('2024-01-01');
  });

  test('金额精度：分进位与年付/每日折算', () => {
    const rows = [
      validate(item({ amount: '0.10', next_date: '2024-01-01' })),
      validate(item({ amount: '0.20', next_date: '2024-01-01' })),
    ];
    expect(summary(rows, '2024-01-01').monthly_budget).toBe('0.30');
    expect(summary([validate(item({ cycle: 'yearly', amount: '120.00', next_date: '2024-01-01' }))], '2024-01-01').monthly_budget).toBe('10.00');
    const daily = validate(item({ cycle: 'days', days: 1, amount: '0.01', next_date: '2024-01-01' }));
    const s = summary([daily], '2024-01-01');
    expect(s.forecast_30).toBe('0.30');
    expect(s.upcoming_7).toHaveLength(7);
  });

  test('季付预算与窗口边界', () => {
    const row = validate(item({ cycle: 'quarterly', amount: '10.00', next_date: '2024-04-30' }));
    for (const [today, count, seven] of [
      ['2024-03-31', 0, 0], ['2024-04-01', 1, 0], ['2024-04-23', 1, 0], ['2024-04-24', 1, 1], ['2024-04-30', 1, 1],
    ] as const) {
      const result = summary([row], today);
      expect(result.monthly_budget).toBe('3.33');
      expect(result.upcoming_30).toHaveLength(count);
      expect(result.upcoming_7).toHaveLength(seven);
    }
    expect(summary([row, row, row], '2024-04-30').monthly_budget).toBe('10.00');
  });
});

describe('预测快进', () => {
  const originalAdvance = domain.advance;
  afterEach(() => {
    domain.advance = originalAdvance;
  });

  function bounded(limit: number) {
    let calls = 0;
    domain.advance = (r: SubscriptionRecord) => {
      calls += 1;
      expect(calls, '预测不得逐次迭代历史周期').toBeLessThanOrEqual(limit);
      return originalAdvance(r);
    };
  }

  test.each([
    ['1900-01-31', '2024-04-01', '2024-04-30'],
    ['1900-02-28', '2024-04-30', '2024-05-28'],
    ['1900-11-30', '2024-02-01', '2024-02-29'],
    ['1900-11-30', '2025-02-01', '2025-02-28'],
    ['2024-01-31', '2024-05-01', null],
    ['2024-01-31', '2024-07-31', '2024-07-31'],
  ])('季付快进 %s → %s', (start, today, expected) => {
    bounded(4);
    const row = validate(item({ cycle: 'quarterly', next_date: start }));
    const result = summary([row], today);
    expect(result.upcoming_30.map((r) => r.next_date)).toEqual(expected ? [expected] : []);
    expect(row.next_date).toBe(start);
  });

  test.each([
    ['days', 1, '1900-01-01', '2024-02-01'],
    ['monthly', null, '1900-01-31', '2024-02-29'],
    ['yearly', null, '1904-02-29', '2024-02-29'],
  ])('老记录快进：%s %s', (cycle, days, start, expected) => {
    bounded(32);
    const row = validate(item({ cycle, days, next_date: start }));
    const result = summary([row], '2024-02-01');
    expect(result.upcoming_30[0].next_date).toBe(expected);
    expect(result.overdue[0].next_date).toBe(start);
    expect(row.next_date).toBe(start);
  });

  test('快进保留自定义年锚点', () => {
    const row = validate(item({ cycle: 'yearly', next_date: '2024-01-01' }));
    row.anchor_month = 2;
    row.anchor_day = 29;
    expect(summary([row], '2028-02-01').upcoming_30[0].next_date).toBe('2028-02-29');
  });
});
