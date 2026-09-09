import json
from datetime import date
import pytest
from werkzeug.security import generate_password_hash
from app import create_app
from domain import validate, advance, summary


def item(**kw):
    return dict(name='测试', amount='12.30', cycle='monthly', days=None,
                next_date='2024-01-31', auto_renew=True, status='active',
                end_date=None, url='', notes='', **kw) if not kw else {**item(), **kw}

@pytest.fixture
def app(tmp_path):
    return create_app({'TESTING': True, 'DATA_DIR': str(tmp_path),
                       'PASSWORD_HASH': generate_password_hash('test-password-123')})

@pytest.fixture
def client(app):
    c = app.test_client()
    token = c.get('/api/session').json['csrf']
    assert c.post('/api/login', json={'password':'test-password-123'}, headers={'X-CSRF-Token':token}).status_code == 200
    c.token = c.get('/api/session').json['csrf']
    return c

def post(c, url, data, method='post'):
    return getattr(c, method)(url, json=data, headers={'X-CSRF-Token': c.token})

def test_dates():
    r=validate(item())
    assert advance(r)=='2024-02-29'
    r['next_date']=advance(r)
    assert advance(r)=='2024-03-31'
    r=validate(item(cycle='yearly', next_date='2024-02-29'))
    for year in (2025,2026,2027,2028):
        r['next_date']=advance(r)
    assert r['next_date']=='2028-02-29'

@pytest.mark.parametrize('patch', [{'amount':'1.001'},{'amount':'NaN'},{'amount':'-1'},{'amount':1.2},{'url':'javascript:alert(1)'},{'cycle':'days','days':0},{'status':'bad'},{'next_date':'2024-02-30'},{'auto_renew':'yes'},{'name':''}])
def test_invalid(patch):
    with pytest.raises(ValueError): validate(item(**patch))

def test_summary():
    r=validate(item(cycle='days',days=10,next_date='2024-01-01',amount='10.00'))
    s=summary([r], date(2024,1,1))
    assert s['forecast_30']=='30.00'
    assert s['monthly_budget']=='30.42'
    assert len(s['upcoming_7'])==1
    assert len(s['upcoming_30'])==3
    for state in ('cancelled','ended'):
        assert summary([{**r,'status':state}],date(2024,1,1))['forecast_30']=='0.00'
    assert summary([{**r,'status':'cancelling'}],date(2024,1,1))['forecast_30']=='30.00'
    assert summary([r],date(2024,1,2))['overdue'][0]['next_date']=='2024-01-01'

def test_auth_csrf(app,client):
    anon=app.test_client()
    for url in ('/api/items','/api/export','/api/summary'):
        assert anon.get(url).status_code==401
    assert client.post('/api/items',json=item()).status_code==403
    assert post(client,'/api/items',item(url='file:///etc/passwd')).status_code==400
    cookie=client.get('/api/session').headers.get('Set-Cookie','')
    assert 'HttpOnly' in cookie and 'SameSite=Strict' in cookie
    token=anon.get('/api/session').json['csrf']
    for _ in range(5):
        assert anon.post('/api/login',json={'password':'wrong'},headers={'X-CSRF-Token':token}).status_code==401
    assert anon.post('/api/login',json={'password':'wrong'},headers={'X-CSRF-Token':token}).status_code==429

def test_crud_renew_persistence(app,client):
    res=post(client,'/api/items',item()); assert res.status_code==201
    r=res.json; ident=r['id']
    assert post(client,f'/api/items/{ident}/renew',{'actual_date':'2024-01-31','next_date':'2024-02-29','confirm':True}).status_code==200
    assert client.get('/api/items').json[0]['next_date']=='2024-02-29'
    assert client.get('/api/items').json[0]['suggested_next']=='2024-03-31'
    assert post(client,f'/api/items/{ident}',item(next_date='2024-02-29',status='cancelled',end_date='2024-03-01'), 'put').status_code==200
    assert post(client,f'/api/items/{ident}/renew',{'actual_date':'2024-02-29','next_date':'2024-03-31','confirm':True}).status_code==400
    fresh=create_app(dict(app.config)); assert len(fresh.test_client().get('/api/session').json)>0
    with fresh.app_context():
        from app import db
        assert db().execute('select count(*) from subscriptions').fetchone()[0]==1
    assert post(client,f'/api/items/{ident}',{},'delete').status_code==400
    assert post(client,f'/api/items/{ident}',{'confirm':True},'delete').status_code==200
    assert client.get('/api/items').json==[]

def test_restore(client,app):
    post(client,'/api/items',item())
    original=client.get('/api/export').json
    assert 'password' not in json.dumps(original).lower()
    assert post(client,'/api/restore',{'confirm':False,'backup':original}).status_code==400
    bad=json.loads(json.dumps(original)); bad['items'].append({**bad['items'][0], 'amount':'bad'})
    assert post(client,'/api/restore',{'confirm':True,'backup':bad}).status_code==400
    assert client.get('/api/export').json==original
    assert post(client,'/api/restore',{'confirm':True,'backup':original}).status_code==200
    from pathlib import Path
    backups=list((Path(app.config['DATA_DIR'])/'backups').glob('*.sqlite3'))
    assert len(backups)==1
    assert client.get('/api/export').json==original
