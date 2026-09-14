/** API 数据类型，与服务端响应一一对应。 */
export interface Subscription {
  id: string;
  name: string;
  url: string;
  notes: string;
  amount_cents: number;
  amount: string;
  cycle: 'monthly' | 'quarterly' | 'yearly' | 'days';
  days: number | null;
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
  version: 1;
  currency: 'CNY';
  items: Subscription[];
  renewals: Renewal[];
}

export type ViewKey = 'recent' | 'all' | 'backup';
export type StatusKey = Subscription['status'];
