/** 展示格式化：金额千分位、日期保留 ISO 记录并补中文读法。移植自原 app.js。 */

export const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function money(value: string | number): string {
  const [whole, fraction] = String(value).split('.');
  return '¥' + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '');
}

export function moneyCents(cents: number): string {
  return money((cents / 100).toFixed(2));
}

export function parseDay(iso: string): number {
  return Date.parse(iso + 'T00:00:00Z');
}

export function daysUntil(dateStr: string, today: string): number {
  return (parseDay(dateStr) - parseDay(today)) / 86400000;
}

export function friendlyDate(iso: string, today: string): string {
  if (!iso) return '';
  const time = parseDay(iso);
  if (Number.isNaN(time)) return iso;
  const d = new Date(time);
  const year = d.getUTCFullYear();
  const sameYear = !today || today.slice(0, 4) === String(year);
  return `${sameYear ? '' : year + '年'}${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${WEEKDAYS[d.getUTCDay()]}`;
}

export function relativeDay(iso: string, today: string): { text: string; cls: string } {
  if (!today) return { text: '', cls: '' };
  const days = daysUntil(iso, today);
  if (days < 0) return { text: `逾期 ${-days} 天`, cls: 'overdue' };
  if (days === 0) return { text: '今天', cls: 'soon' };
  if (days === 1) return { text: '明天', cls: 'soon' };
  return { text: `还剩 ${days} 天`, cls: days < 7 ? 'soon' : '' };
}

export function cycleLabel(r: { cycle: string; days?: number | string | null }): string {
  return r.cycle === 'monthly' ? '月付' : r.cycle === 'quarterly' ? '季付' : r.cycle === 'yearly' ? '年付' : `每 ${r.days} 天`;
}

/** 续费历史标题摘要：合计只累加记录了金额的条目，早期无金额记录如实说明。 */
export function historySummary(rows: Array<{ amount_cents: number | null }>): string {
  const known = rows.filter((h) => h.amount_cents !== null && h.amount_cents !== undefined);
  let s = `共 ${rows.length} 次`;
  if (known.length) s += ` · 实付合计 ${moneyCents(known.reduce((n, h) => n + (h.amount_cents as number), 0))}`;
  if (known.length < rows.length) s += `（${rows.length - known.length} 次早期记录未含金额，不计入）`;
  return s;
}

/** 记录时间只显示到分钟。 */
export function recordedAt(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '';
}

export function fileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(2)} MB`;
}
