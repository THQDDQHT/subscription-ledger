/** 展示用状态：存储状态不变，已取消且服务截止日已过的普通订阅按「已结束」显示。 */
export function effectiveStatus<S extends string>(
  r: { status: S; end_date: string | null; kind?: string },
  today: string,
): S | 'ended' {
  // 余额账户的“已取消”表示暂停自动扣减，不做推算。
  if (r.kind !== 'prepaid' && r.status === 'cancelled' && r.end_date && r.end_date < today) return 'ended';
  return r.status;
}
