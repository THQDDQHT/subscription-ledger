from datetime import date
import pytest
import domain
from test_ledger import item


@pytest.mark.parametrize('cycle,days,start,expected',[
    ('days',1,'1900-01-01','2024-02-01'),
    ('monthly',None,'1900-01-31','2024-02-29'),
    ('yearly',None,'1904-02-29','2024-02-29'),
])
def test_forecast_fast_forwards_old_records(monkeypatch,cycle,days,start,expected):
    row=domain.validate(item(cycle=cycle,days=days,next_date=start))
    original=domain.advance
    calls=0
    def bounded(r):
        nonlocal calls
        calls+=1
        assert calls<=32, 'forecast iterated over historical cycles'
        return original(r)
    monkeypatch.setattr(domain,'advance',bounded)
    result=domain.summary([row],date(2024,2,1))
    assert result['upcoming_30'][0]['next_date']==expected
    assert result['overdue'][0]['next_date']==start
    assert row['next_date']==start


def test_fast_forward_preserves_custom_year_anchor():
    row=domain.validate(item(cycle='yearly',next_date='2024-01-01'))
    row['anchor_month']=2
    row['anchor_day']=29
    assert domain.summary([row],date(2028,2,1))['upcoming_30'][0]['next_date']=='2028-02-29'
