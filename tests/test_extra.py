import json
import sqlite3
from pathlib import Path
from datetime import date
import pytest
from domain import validate, summary, advance
from test_ledger import item, app, client, post


def test_year_month_and_precision():
    rows=[validate(item(amount='0.10',next_date='2024-01-01')),validate(item(amount='0.20',next_date='2024-01-01'))]
    assert summary(rows,date(2024,1,1))['monthly_budget']=='0.30'
    assert summary([validate(item(cycle='yearly',amount='120.00',next_date='2024-01-01'))],date(2024,1,1))['monthly_budget']=='10.00'
    daily=validate(item(cycle='days',days=1,amount='0.01',next_date='2024-01-01'))
    s=summary([daily],date(2024,1,1))
    assert s['forecast_30']=='0.30' and len(s['upcoming_7'])==7
    assert advance(validate(item(next_date='2023-01-31')))=='2023-02-28'
    assert advance(validate(item(next_date='2024-12-31')))=='2025-01-31'


def test_restored_anchor_and_history(client):
    ident=post(client,'/api/items',item()).json['id']
    assert post(client,f'/api/items/{ident}/renew',{'actual_date':'2024-01-31','next_date':'2024-02-29','confirm':True}).status_code==200
    backup=client.get('/api/export').json
    assert post(client,'/api/restore',{'confirm':True,'backup':backup}).status_code==200
    assert client.get('/api/items').json[0]['suggested_next']=='2024-03-31'
    assert client.get('/api/export').json['renewals']==backup['renewals']
    for mutation in ('duplicate','anchor','history','currency'):
        bad=json.loads(json.dumps(backup))
        if mutation=='duplicate': bad['items'].append(bad['items'][0])
        if mutation=='anchor': bad['items'][0]['anchor_day']=False
        if mutation=='history': bad['renewals'][0]['subscription_id']='0'*32
        if mutation=='currency': bad['currency']='USD'
        assert post(client,'/api/restore',{'confirm':True,'backup':bad}).status_code==400
        assert client.get('/api/export').json==backup


def test_transaction_rollback_on_database_failure(client,app):
    post(client,'/api/items',item())
    before=client.get('/api/export').json
    path=Path(app.config['DATA_DIR'])/'ledger.sqlite3'
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TRIGGER refuse_insert BEFORE INSERT ON subscriptions BEGIN SELECT RAISE(ABORT, 'injected failure'); END;")
    with pytest.raises(sqlite3.IntegrityError):
        post(client,'/api/restore',{'confirm':True,'backup':before})
    assert client.get('/api/export').json==before
    backups=list((path.parent/'backups').glob('*.sqlite3')); assert len(backups)==1
    with sqlite3.connect(backups[0]) as conn:
        assert conn.execute('SELECT COUNT(*) FROM subscriptions').fetchone()[0]==1


def test_unconfirmed_renew_future_and_status(client):
    ident=post(client,'/api/items',item()).json['id']
    for patch in ({'confirm':False},{'actual_date':'2100-01-01'},{'next_date':'2024-01-01'}):
        data={'confirm':True,'actual_date':'2024-01-31','next_date':'2024-02-29',**patch}
        assert post(client,f'/api/items/{ident}/renew',data).status_code==400
    for state in ('cancelling','cancelled','ended','active'):
        assert post(client,f'/api/items/{ident}',item(status=state),'put').status_code==200
        assert client.get('/api/items').json[0]['status']==state


def test_backup_failure_does_not_modify(client,app,monkeypatch):
    post(client,'/api/items',item())
    before=client.get('/api/export').json
    import os
    real=os.open
    def denied(path,*args,**kwargs):
        if 'backups' in str(path): raise PermissionError('simulated disk failure')
        return real(path,*args,**kwargs)
    monkeypatch.setattr(os,'open',denied)
    with pytest.raises(PermissionError):post(client,'/api/restore',{'confirm':True,'backup':before})
    assert client.get('/api/export').json==before
