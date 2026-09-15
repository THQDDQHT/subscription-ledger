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

  test.each([
    [{ cycle: 'semiannual' }, '2023-08-31', ['2024-02-29', '2024-08-31', '2025-02-28', '2025-08-31']],
    [{ cycle: 'months', months: 2 }, '2023-12-31', ['2024-02-29', '2024-04-30', '2024-06-30', '2024-08-31']],
    [{ cycle: 'months', months: 18 }, '2024-08-31', ['2026-02-28', '2027-08-31']],
    [{ cycle: 'years', years: 2 }, '2024-02-29', ['2026-02-28', '2028-02-29']],
    [{ cycle: 'years', years: 3 }, '2023-12-31', ['2026-12-31', '2029-12-31']],
  ])('半年付和自定义日历周期：%o，从 %s 开始', (patch, start, expected) => {
    const row = validate(item({ ...patch, next_date: start }));
    for (const date of expected) {
      row.next_date = domain.advance(row);
      expect(row.next_date).toBe(date);
    }
  });

  test.each([
    { cycle: 'months', months: 2 },
    { cycle: 'years', years: 2 },
  ])('编辑数量重置锚点，编辑金额保留锚点：%o', (patch) => {
    const old = validate(item({ ...patch, next_date: '2024-02-29' }));
    old.next_date = '2026-02-28';
    const unchanged = validate({ ...old, amount: '20.00' }, old);
    expect(unchanged.anchor_day).toBe(29);
    const edited = validate({ ...old, [patch.cycle]: 3 }, old);
    expect(edited.anchor_day).toBe(28);
    expect(edited.anchor_month).toBe(2);
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

  test.each([
    ['months', 1200, '月数'], ['years', 100, '年数'],
  ] as const)('自定义 %s 只接受范围内整数', (cycle, maximum, label) => {
    for (const value of [undefined, null, true, '2', 0, -1, 1.5, maximum + 1, NaN, Infinity]) {
      expect(() => validate(item({ cycle, [cycle]: value }))).toThrow(`${label}须为 1–${maximum} 的整数`);
    }
    for (const value of [1, maximum]) {
      expect(validate(item({ cycle, [cycle]: value }))[cycle]).toBe(value);
    }
  });

  test('切换周期清除不再使用的数量，旧记录无需月数年数字段', () => {
    const old = validate(item({ cycle: 'months', months: 2 }));
    const changed = validate({ ...old, cycle: 'years', years: 3 }, old);
    expect(changed.months).toBeUndefined();
    expect(changed.years).toBe(3);
    expect(changed.days).toBeNull();
    expect(validate(item())).not.toHaveProperty('months');
    expect(validate(item())).not.toHaveProperty('years');
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

  test.each([
    [{ cycle: 'semiannual' }, '2.05'],
    [{ cycle: 'months', months: 2 }, '6.15'],
    [{ cycle: 'years', years: 2 }, '0.51'],
  ])('日历周期预算精确折算与预测窗口：%o', (patch, budget) => {
    const row = validate(item(patch));
    const s = summary([row], '2024-01-31');
    expect(s.monthly_budget).toBe(budget);
    expect(s.forecast_30).toBe('12.30');
    expect(s.upcoming_30.map((r) => r.next_date)).toEqual(['2024-01-31']);
    expect(summary([row], '2024-01-01').forecast_30).toBe('0.00');
    expect(summary([{ ...row, status: 'ended' }], '2024-01-31').monthly_budget).toBe('0.00');
  });

  test('混合日历周期预算合计后舍入', () => {
    const rows = [
      validate(item({ cycle: 'semiannual', amount: '0.01' })),
      validate(item({ cycle: 'months', months: 3, amount: '0.01' })),
      validate(item({ cycle: 'years', years: 2, amount: '0.12' })),
    ];
    expect(summary(rows, '2024-01-31').monthly_budget).toBe('0.01');
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

  test.each([
    [{ cycle: 'semiannual' }, '1900-08-31', '2024-02-01', '2024-02-29'],
    [{ cycle: 'semiannual' }, '1900-08-31', '2024-03-01', null],
    [{ cycle: 'months', months: 2 }, '1900-12-31', '2024-04-01', '2024-04-30'],
    [{ cycle: 'months', months: 5 }, '1900-01-31', '2024-03-02', '2024-03-31'],
    [{ cycle: 'months', months: 18 }, '1900-08-31', '2025-02-01', '2025-02-28'],
    [{ cycle: 'years', years: 2 }, '1904-02-29', '2026-02-01', '2026-02-28'],
    [{ cycle: 'years', years: 2 }, '1904-02-29', '2027-02-01', null],
    [{ cycle: 'years', years: 3 }, '1904-02-29', '2027-02-01', '2027-02-28'],
  ])('自定义周期快进保留月份/年份相位：%o，%s → %s', (patch, start, today, expected) => {
    bounded(4);
    const row = validate(item({ ...patch, next_date: start }));
    expect(summary([row], today).upcoming_30.map((r) => r.next_date)).toEqual(expected ? [expected] : []);
    expect(row.next_date).toBe(start);
  });

  test('多年周期手动续费后，快进保留原始月日锚点和新的年份相位', () => {
    const row = validate(item({ cycle: 'years', years: 3, next_date: '2024-02-29' }));
    row.next_date = '2028-05-15';
    expect(domain.advance(row)).toBe('2031-02-28');
    expect(summary([row], '2030-02-01').upcoming_30).toEqual([]);
    expect(summary([row], '2031-02-01').upcoming_30[0].next_date).toBe('2031-02-28');
    expect(summary([row], '2040-02-01').upcoming_30[0].next_date).toBe('2040-02-29');
  });
});
