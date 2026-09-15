/**
 * 纯领域函数，逐行平移自原 domain.py。窗口为 [today, today + N days)。
 * summary 通过 domain 命名空间调用 advance，保持与原 Python 模块相同的可拦截性（测试用）。
 */

export const STATES = new Set(['active', 'cancelling', 'cancelled', 'ended']);
const AMOUNT_RE = /^(0|[1-9]\d{0,7})(\.\d{1,2})?$/;
const MAX_CENTS = 99_999_999_99; // 八位整数 + 两位小数

export interface SubscriptionRecord {
  name: string;
  url: string;
  notes: string;
  amount_cents: number;
  amount: string;
  cycle: 'monthly' | 'quarterly' | 'semiannual' | 'yearly' | 'days' | 'months' | 'years';
  days: number | null;
  months?: number;
  years?: number;
  next_date: string;
  auto_renew: boolean;
  status: string;
  end_date: string | null;
  anchor_day: number;
  anchor_month: number;
  id?: string;
  suggested_next?: string;
}

/** 领域/入参校验错误：API 层映射为 400；其余异常一律 500。对应 Python 版的 ValueError。 */
export class DomainError extends Error {}

export function fail(message: string): never {
  throw new DomainError(message);
}

export function parseAmount(value: unknown): number {
  if (typeof value !== 'string' || !AMOUNT_RE.test(value)) {
    fail('金额须为非负人民币数字，最多两位小数、八位整数');
  }
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
}

/** 恢复一侧的整数分校验；布尔一律拒绝。 */
export function parseCents(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_CENTS) {
    fail('金额（分）无效');
  }
  return value;
}

const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/** ISO 8601 记录时间；归一化到秒，保证导出可往返。 */
export function parseTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40) fail('记录时间格式不正确');
  const m = TIMESTAMP_RE.exec(value);
  if (!m) fail('记录时间格式不正确');
  const [, day, hh, mm, ss = '00', zone] = m;
  const [y, mo, d] = day.split('-').map(Number);
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    fail('记录时间格式不正确');
  }
  if (Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59) fail('记录时间格式不正确');
  if (Number.isNaN(Date.parse(value.replace(' ', 'T')))) fail('记录时间格式不正确');
  const offset = zone === undefined ? '' : zone === 'Z' ? '+00:00' : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
  return `${day}T${hh}:${mm}:${ss}${offset}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDate(value: unknown): string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) fail('日期必须为 YYYY-MM-DD');
  const [y, m, d] = value.split('-').map(Number);
  if (y < 1900 || y > 2100) fail('日期年份须在 1900–2100');
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    fail('日期必须为 YYYY-MM-DD');
  }
  return value;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return t.toISOString().slice(0, 10);
}

function stripOuterWhitespace(value: unknown, key: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum) fail(`${key} 长度或类型不正确`);
  return value.trim();
}

export function validate(data: unknown, previous?: SubscriptionRecord, restoring = false): SubscriptionRecord {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) fail('记录必须是对象');
  const input = data as Record<string, unknown>;
  const name = stripOuterWhitespace(input.name ?? '', 'name', 120);
  const url = stripOuterWhitespace(input.url ?? '', 'url', 2000);
  const notes = stripOuterWhitespace(input.notes ?? '', 'notes', 5000);
  if (!name) fail('名称不能为空');
  if (url) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      fail('管理链接仅支持无凭证的 http/https URL');
    }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password || /\s/.test(url)) {
      fail('管理链接仅支持无凭证的 http/https URL');
    }
  }
  const amountCents = parseAmount(input.amount);
  const cycle = input.cycle;
  if (cycle !== 'monthly' && cycle !== 'quarterly' && cycle !== 'semiannual' && cycle !== 'yearly' && cycle !== 'days' && cycle !== 'months' && cycle !== 'years') fail('周期不正确');
  const custom = cycle === 'days' || cycle === 'months' || cycle === 'years';
  const interval = custom ? input[cycle] : undefined;
  if (custom) {
    const [label, maximum] = cycle === 'days' ? ['天数', 36500] as const : cycle === 'months' ? ['月数', 1200] as const : ['年数', 100] as const;
    if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 1 || interval > maximum) {
      fail(`${label}须为 1–${maximum} 的整数`);
    }
  }
  const nextDate = parseDate(input.next_date);
  if (typeof input.auto_renew !== 'boolean') fail('自动续费须为开关值');
  if (typeof input.status !== 'string' || !STATES.has(input.status)) fail('状态不正确');
  const end = input.end_date;
  const endDate = end ? parseDate(end) : null;
  // 显式编辑计划日期/周期会重置锚点；确认续费不会。
  const keep = previous !== undefined && previous.next_date === nextDate && previous.cycle === cycle &&
    (!custom || previous[cycle] === interval);
  const record: SubscriptionRecord = {
    name,
    url,
    notes,
    amount_cents: amountCents,
    amount: money(amountCents),
    cycle,
    days: cycle === 'days' ? (interval as number) : null,
    ...(cycle === 'months' ? { months: interval as number } : {}),
    ...(cycle === 'years' ? { years: interval as number } : {}),
    next_date: nextDate,
    auto_renew: input.auto_renew,
    status: input.status,
    end_date: endDate,
    anchor_day: keep ? previous.anchor_day : Number(nextDate.slice(8, 10)),
    anchor_month: keep ? previous.anchor_month : Number(nextDate.slice(5, 7)),
  };
  if (restoring) {
    for (const [key, maximum] of [['anchor_day', 31], ['anchor_month', 12]] as const) {
      const value = input[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) fail('日期锚点不正确');
      record[key] = value;
    }
  }
  return record;
}

/** 整数分 → 定点两位小数字符串，与 Python Decimal 口径一致。 */
export function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function advance(r: SubscriptionRecord): string {
  const [year, month] = r.next_date.split('-').map(Number);
  if (r.cycle === 'days') return addDays(r.next_date, r.days as number);
  if (r.cycle !== 'yearly' && r.cycle !== 'years') {
    const step = calendarMonths(r);
    const total = year * 12 + (month - 1) + step;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    return iso(y, m, Math.min(r.anchor_day, daysInMonth(y, m)));
  }
  const y = year + calendarMonths(r) / 12;
  return iso(y, r.anchor_month, Math.min(r.anchor_day, daysInMonth(y, r.anchor_month)));
}

/** 日历周期统一折算为月数；天数周期单独按天计算。 */
function calendarMonths(r: SubscriptionRecord): number {
  switch (r.cycle) {
    case 'monthly': return 1;
    case 'quarterly': return 3;
    case 'semiannual': return 6;
    case 'yearly': return 12;
    case 'months': return r.months as number;
    case 'years': return (r.years as number) * 12;
    case 'days': return fail('天数周期不能按日历月计算');
  }
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export interface Summary {
  today: string;
  monthly_budget: string;
  forecast_30: string;
  upcoming_7: SubscriptionRecord[];
  upcoming_30: SubscriptionRecord[];
  overdue: SubscriptionRecord[];
}

export function summary(rows: SubscriptionRecord[], today: string): Summary {
  // 月度等效预算：以 BigInt 有理数精确求和后四舍五入到分（HALF_UP），不使用浮点。
  let budgetNum = 0n;
  let budgetDen = 1n;
  const upcoming: SubscriptionRecord[] = [];
  const overdue: SubscriptionRecord[] = [];
  const end = addDays(today, 30);
  for (const r of rows) {
    if (r.status !== 'active' && r.status !== 'cancelling') continue;
    const cents = BigInt(r.amount_cents);
    let num: bigint;
    let den: bigint;
    if (r.cycle === 'days') [num, den] = [cents * 365n, BigInt(r.days as number) * 12n];
    else [num, den] = [cents, BigInt(calendarMonths(r))];
    budgetNum = budgetNum * den + num * budgetDen;
    budgetDen *= den;
    if (r.next_date < today) overdue.push(r);
    const occurrence: SubscriptionRecord = { ...r };
    // 以 O(1) 快进跳过历史周期，保留原始锚点。
    if (occurrence.next_date < today) {
      const planned = occurrence.next_date;
      let candidate: string;
      if (r.cycle === 'days') {
        const periods = Math.ceil(diffDays(planned, today) / (r.days as number));
        candidate = addDays(planned, periods * (r.days as number));
      } else {
        const [py, pm] = planned.split('-').map(Number);
        const [ty, tm] = today.split('-').map(Number);
        let y: number;
        let m: number;
        if (r.cycle !== 'yearly' && r.cycle !== 'years') {
          const step = calendarMonths(r);
          const elapsed = (ty - py) * 12 + tm - pm;
          // 保持计划的月份相位，包括手工确认过的日期。
          const periods = Math.max(1, Math.floor(elapsed / step));
          const total = py * 12 + (pm - 1) + periods * step;
          y = Math.floor(total / 12);
          m = (total % 12) + 1;
        } else {
          const step = calendarMonths(r) / 12;
          const periods = Math.max(1, Math.floor((ty - py) / step));
          y = py + periods * step;
          m = r.anchor_month;
        }
        candidate = iso(y, m, Math.min(r.anchor_day, daysInMonth(y, m)));
        // 手工确认过的日期仍是首次发生；只有后续周期使用锚点并可以快进。
        const first = domain.advance(occurrence);
        if (candidate < first) candidate = first;
        occurrence.next_date = candidate;
        if (candidate < today) candidate = domain.advance(occurrence);
      }
      occurrence.next_date = candidate;
    }
    // 仅为预测展开计划：绝不回写记录日期。
    while (occurrence.next_date < end) {
      if (occurrence.next_date >= today) upcoming.push({ ...occurrence });
      occurrence.next_date = domain.advance(occurrence);
    }
  }
  upcoming.sort((a, b) => (a.next_date < b.next_date ? -1 : a.next_date > b.next_date ? 1 : 0));
  overdue.sort((a, b) => (a.next_date < b.next_date ? -1 : a.next_date > b.next_date ? 1 : 0));
  // 四舍五入（HALF_UP）到整数分。
  let budgetCents = budgetNum / budgetDen;
  if ((budgetNum % budgetDen) * 2n >= budgetDen) budgetCents += 1n;
  return {
    today,
    monthly_budget: money(Number(budgetCents)),
    forecast_30: money(upcoming.reduce((sum, r) => sum + r.amount_cents, 0)),
    upcoming_7: upcoming.filter((r) => r.next_date < addDays(today, 7)),
    upcoming_30: upcoming,
    overdue,
  };
}

function diffDays(fromIso: string, toIso: string): number {
  return (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000;
}

/** 与原 Python 模块对应的对象形态导出，测试可替换 advance 观察调用次数。 */
export const domain = { advance, summary, validate, money, parseAmount, parseCents, parseTimestamp, parseDate };

const SHANGHAI = 'Asia/Shanghai';

/** 今天（Asia/Shanghai），YYYY-MM-DD。 */
export function todayInShanghai(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SHANGHAI, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** 当前时刻的 ISO 8601（Asia/Shanghai，到秒，带 +08:00），用于续费记录时间。 */
export function nowIsoInShanghai(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+08:00`;
}
