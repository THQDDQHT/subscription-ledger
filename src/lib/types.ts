/** API 数据类型，与服务端响应一一对应。 */
export interface Subscription {
  kind?: 'prepaid';
  cost_type?: 'fixed' | 'estimated';
  balance_cents?: number;
  balance_as_of?: string;
  low_balance_cents?: number;
  id: string;
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
  status: 'active' | 'cancelling' | 'cancelled' | 'ended';
  end_date: string | null;
  anchor_day: number;
  anchor_month: number;
  suggested_next?: string;
}

export interface Renewal {
  id: string;
  subscription_id: string;
  actual_date: string;
  previous_date: string;
  next_date: string;
  amount_cents: number | null;
  amount: string | null;
  recorded_at: string | null;
  undoable: boolean;
}

export interface Summary {
  today: string;
  monthly_budget: string;
  forecast_30: string;
  upcoming_7: Subscription[];
  upcoming_30: Subscription[];
  overdue: Subscription[];
}

export interface SessionInfo {
  authenticated: boolean;
  csrf: string;
  configured: boolean;
}

export interface Backup {
  format: 'subscription-ledger';
  version: 1 | 2;
  currency: 'CNY';
  items: Subscription[];
  renewals: Renewal[];
  balance_entries?: BalanceEntry[];
}

export interface BalanceEntry {
  id: string;
  subscription_id: string;
  kind: 'opening' | 'charge' | 'topup' | 'reconcile' | 'bill_adjustment';
  delta_cents: number;
  balance_after_cents: number;
  effective_date: string;
  recorded_at: string;
  source: 'web' | 'agent' | 'schedule';
  period_date: string | null;
  reference_id: string | null;
  bill_amount_cents: number | null;
  estimated: boolean;
  notes: string;
}

export interface Reminder {
  key: string;
  subscription_id: string;
  kind: 'renewal' | 'low_balance';
  title: string;
  text: string;
  date: string;
}

export type ViewKey = 'recent' | 'all' | 'backup';
export type StatusKey = Subscription['status'];
