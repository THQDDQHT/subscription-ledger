"""Pure domain functions. Windows are [today, today + N days)."""
import calendar
import re
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP
from urllib.parse import urlsplit

STATES = {'active', 'cancelling', 'cancelled', 'ended'}

def parse_date(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError('日期必须为 YYYY-MM-DD')
    d = date.fromisoformat(value)
    if not 1900 <= d.year <= 2100:
        raise ValueError('日期年份须在 1900–2100')
    return d

def validate(data, previous=None, restoring=False):
    if not isinstance(data, dict):
        raise ValueError('记录必须是对象')
    out = {}
    for key, maximum in [('name',120),('url',2000),('notes',5000)]:
        val = data.get(key,'')
        if not isinstance(val,str) or len(val)>maximum:
            raise ValueError(f'{key} 长度或类型不正确')
        out[key] = val.strip()
    if not out['name']: raise ValueError('名称不能为空')
    if out['url']:
        u = urlsplit(out['url'])
        if u.scheme not in ('http','https') or not u.hostname or u.username or u.password or any(c.isspace() for c in out['url']):
            raise ValueError('管理链接仅支持无凭证的 http/https URL')
    amount = data.get('amount')
    if not isinstance(amount,str) or not re.fullmatch(r'(0|[1-9]\d{0,7})(\.\d{1,2})?',amount):
        raise ValueError('金额须为非负人民币数字，最多两位小数、八位整数')
    out['amount_cents'] = int(Decimal(amount)*100)
    out['amount'] = money(out['amount_cents'])
    cycle = data.get('cycle')
    if cycle not in ('monthly','yearly','days'): raise ValueError('周期不正确')
    out['cycle'] = cycle
    days=data.get('days')
    if cycle=='days' and (type(days) is not int or not 1<=days<=36500): raise ValueError('天数须为 1–36500 的整数')
    out['days'] = days if cycle=='days' else None
    d=parse_date(data.get('next_date')); out['next_date']=d.isoformat()
    if type(data.get('auto_renew')) is not bool: raise ValueError('自动续费须为开关值')
    out['auto_renew']=data['auto_renew']
    if data.get('status') not in STATES: raise ValueError('状态不正确')
    out['status']=data['status']
    end=data.get('end_date')
    out['end_date']=parse_date(end).isoformat() if end else None
    # Editing a planned date/cycle explicitly resets the anchor; confirmations do not.
    keep=previous and previous['next_date']==out['next_date'] and previous['cycle']==cycle
    out['anchor_day']=previous['anchor_day'] if keep else d.day
    out['anchor_month']=previous['anchor_month'] if keep else d.month
    if restoring:
        for key,maximum in [('anchor_day',31),('anchor_month',12)]:
            val=data.get(key)
            if type(val) is not int or not 1<=val<=maximum: raise ValueError('日期锚点不正确')
            out[key]=val
    return out

def money(cents):
    return f'{Decimal(cents)/100:.2f}'

def advance(r):
    d=date.fromisoformat(r['next_date'])
    if r['cycle']=='days': return (d+timedelta(days=r['days'])).isoformat()
    if r['cycle']=='monthly':
        year=d.year+(d.month==12); month=d.month%12+1
    else:
        year=d.year+1; month=r['anchor_month']
    return date(year,month,min(r['anchor_day'],calendar.monthrange(year,month)[1])).isoformat()

def summary(rows,today):
    budget=Decimal(0); upcoming=[]; overdue=[]
    end=today+timedelta(days=30)
    for r in rows:
        if r['status'] not in ('active','cancelling'): continue
        cents=Decimal(r['amount_cents'])
        budget += cents if r['cycle']=='monthly' else cents/12 if r['cycle']=='yearly' else cents*365/r['days']/12
        if date.fromisoformat(r['next_date'])<today: overdue.append(r)
        occurrence=dict(r)
        # Jump past historical cycles in O(1), retaining the original anchors.
        planned=date.fromisoformat(r['next_date'])
        if planned<today:
            if r['cycle']=='days':
                periods=((today-planned).days+r['days']-1)//r['days']
                candidate=planned+timedelta(days=periods*r['days'])
            else:
                year=today.year
                month=today.month if r['cycle']=='monthly' else r['anchor_month']
                candidate=date(year,month,min(r['anchor_day'],calendar.monthrange(year,month)[1]))
                # A custom confirmed date remains the first occurrence; only
                # subsequent cycles use the anchor and may be fast-forwarded.
                first=date.fromisoformat(advance(r))
                if candidate<first: candidate=first
                occurrence['next_date']=candidate.isoformat()
                if candidate<today: candidate=date.fromisoformat(advance(occurrence))
            occurrence['next_date']=candidate.isoformat()
        # Expand the schedule for forecasts only: never mutate recorded dates.
        while date.fromisoformat(occurrence['next_date'])<end:
            if date.fromisoformat(occurrence['next_date'])>=today: upcoming.append(dict(occurrence))
            occurrence['next_date']=advance(occurrence)
    upcoming.sort(key=lambda r:r['next_date'])
    return {'today':today.isoformat(),'monthly_budget':money(budget.quantize(Decimal('1'),rounding=ROUND_HALF_UP)),
            'forecast_30':money(sum(r['amount_cents'] for r in upcoming)),
            'upcoming_7':[r for r in upcoming if date.fromisoformat(r['next_date'])<today+timedelta(days=7)],
            'upcoming_30':upcoming,'overdue':sorted(overdue,key=lambda r:r['next_date'])}
