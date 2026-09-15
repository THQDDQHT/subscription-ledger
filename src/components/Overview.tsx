'use client';

import { useLedger } from './ledger-context';
import { friendlyDate, daysUntil } from '@/lib/format';
import { isActive } from '@/lib/grouping';
import { MoneyText } from './bits';

export default function Overview() {
  const { stats, items, today, loading } = useLedger();
  const overdueCount = today ? items.filter((r) => r.kind !== 'prepaid' && isActive(r) && daysUntil(r.next_date, today) < 0).length : 0;
  return (
    <section id="overview" className={`overview${loading ? ' is-loading' : ''}`} aria-label="统计">
      <div className="metrics">
        <article>
          <span>未来 30 天预计费用</span>
          <strong id="forecast">{stats ? <MoneyText value={stats.forecast_30} /> : '—'}</strong>
          <small>按计划估算，非已扣款</small>
        </article>
        <article className={overdueCount > 0 ? 'has-overdue' : ''}>
          <span>逾期未确认</span>
          <strong id="overdue-count" className={overdueCount === 0 ? 'is-zero' : ''}>
            {stats ? (overdueCount ? `${overdueCount} 项` : '—') : '—'}
          </strong>
          <small>确认是否已续费，或更新计划</small>
        </article>
        <article>
          <span>月度等效预算</span>
          <strong id="budget">{stats ? <MoneyText value={stats.monthly_budget} /> : '—'}</strong>
          <small>周期折算，非实际账单</small>
        </article>
      </div>
      <div className="overview-note">
        <p id="window-note">{today ? `今天 ${today} · ${friendlyDate(today, today)} · 中国标准时间` : ''}</p>
        <details className="calculation">
          <summary>统计口径</summary>
          <p>使用中与准备取消计入预算。未来 30 天包含今天，不包含第 30 天，包含订阅续费和余额账户的预计消耗；充值与余额校正不重复计为消费。月度预算按计划折算。余额账户按期自动记账，实际扣费和余额以服务平台为准。</p>
        </details>
      </div>
    </section>
  );
}
