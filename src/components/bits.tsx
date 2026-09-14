'use client';

import { friendlyDate, money } from '@/lib/format';

/** 金额：货币符号退后一步，数字才是主角。 */
export function MoneyText({ value }: { value: string }) {
  return (
    <>
      <span className="cur">¥</span>
      {money(value).slice(1)}
    </>
  );
}

/** 日期：中文读法展示，ISO 保留在 dateTime/title。 */
export function DateText({ iso, today }: { iso: string; today: string }) {
  return (
    <time dateTime={iso} title={iso}>
      {friendlyDate(iso, today)}
    </time>
  );
}
