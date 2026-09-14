"""续费历史：实付金额、记录时间、历史列表、撤销与旧库/旧备份兼容。"""
import json
import sqlite3
from pathlib import Path
import pytest
from werkzeug.security import generate_password_hash
from app import create_app
from test_ledger import item, app, client, post

RENEW={'actual_date':'2024-01-31','next_date':'2024-02-29','confirm':True}


def test_renew_records_amount_and_time(client):
    ident=post(client,'/api/items',item(amount='12.30')).json['id']
    res=post(client,f'/api/items/{ident}/renew',RENEW); assert res.status_code==200 and res.json['renewal_id']
    history=client.get(f'/api/items/{ident}/renewals').json
    assert len(history)==1 and history[0]['id']==res.json['renewal_id']
    assert history[0]['amount_cents']==1230 and history[0]['amount']=='12.30'   # 默认取当前每期金额
    assert history[0]['recorded_at'].endswith('+08:00') and history[0]['undoable'] is True
    assert history[0]['previous_date']=='2024-01-31' and history[0]['next_date']=='2024-02-29'
    # 显式实付金额只进历史，不改订阅本身的金额。
    assert post(client,f'/api/items/{ident}/renew',{'actual_date':'2024-02-29','next_date':'2024-03-31','amount':'30.5','confirm':True}).status_code==200
    history=client.get(f'/api/items/{ident}/renewals').json
    assert [h['amount'] for h in history]==['30.50','12.30'] and [h['undoable'] for h in history]==[True,False]
    assert client.get('/api/items').json[0]['amount']=='12.30'
    for bad in ('abc','1.234','-1',12,''):
        assert post(client,f'/api/items/{ident}/renew',{'actual_date':'2024-03-31','next_date':'2024-04-30','amount':bad,'confirm':True}).status_code==400
    assert len(client.get(f'/api/items/{ident}/renewals').json)==2


def test_undo_latest_only_and_keeps_anchor(client):
    ident=post(client,'/api/items',item()).json['id']
    first=post(client,f'/api/items/{ident}/renew',RENEW).json['renewal_id']
    second=post(client,f'/api/items/{ident}/renew',{'actual_date':'2024-02-29','next_date':'2024-03-31','confirm':True}).json['renewal_id']
    undo=lambda rid,body={'confirm':True}: post(client,f'/api/items/{ident}/renewals/{rid}/undo',body)
    assert undo(second,{'confirm':False}).status_code==400
    assert undo(first).status_code==400 and '最近一次' in undo(first).json['error']
    assert undo('0'*32).status_code==404
    assert post(client,f'/api/items/{"0"*32}/renewals/{second}/undo',{'confirm':True}).status_code==404
    res=undo(second); assert res.status_code==200 and res.json['next_date']=='2024-02-29'
    assert client.get('/api/items').json[0]['next_date']=='2024-02-29'
    assert undo(first).status_code==200
    row=client.get('/api/items').json[0]
    assert row['next_date']=='2024-01-31' and row['suggested_next']=='2024-02-29'   # 月底锚点未被撤销破坏
    assert row['amount']=='12.30' and row['status']=='active'
    assert client.get(f'/api/items/{ident}/renewals').json==[]
    assert undo(second).status_code==404


def test_undo_refused_after_plan_edited(client):
    ident=post(client,'/api/items',item()).json['id']
    rid=post(client,f'/api/items/{ident}/renew',RENEW).json['renewal_id']
    assert post(client,f'/api/items/{ident}',item(next_date='2024-03-15'),'put').status_code==200
    history=client.get(f'/api/items/{ident}/renewals').json
    assert history[0]['undoable'] is False
    res=post(client,f'/api/items/{ident}/renewals/{rid}/undo',{'confirm':True})
    assert res.status_code==400 and '已被修改' in res.json['error']
    assert client.get('/api/items').json[0]['next_date']=='2024-03-15'
    # 撤销不要求状态为使用中：改成已取消后仍能撤回记录错误的续费。
    assert post(client,f'/api/items/{ident}',item(next_date='2024-02-29',status='cancelled'),'put').status_code==200
    assert post(client,f'/api/items/{ident}/renewals/{rid}/undo',{'confirm':True}).status_code==200
    assert client.get('/api/items').json[0]['next_date']=='2024-01-31'


def test_backup_round_trip_and_legacy_history(client):
    ident=post(client,'/api/items',item()).json['id']
    post(client,f'/api/items/{ident}/renew',{**RENEW,'amount':'99.99'})
    backup=client.get('/api/export').json
    entry=backup['renewals'][0]
    assert entry['amount_cents']==9999 and entry['amount']=='99.99' and entry['recorded_at']
    assert post(client,'/api/restore',{'confirm':True,'backup':backup}).status_code==200
    assert client.get('/api/export').json==backup
    assert client.get(f'/api/items/{ident}/renewals').json[0]['amount']=='99.99'
    # 旧版本导出的历史没有金额与时间：恢复后显示为未记录，而不是用当前金额冒充。
    legacy=json.loads(json.dumps(backup))
    for key in ('amount_cents','amount','recorded_at'): legacy['renewals'][0].pop(key)
    assert post(client,'/api/restore',{'confirm':True,'backup':legacy}).status_code==200
    restored=client.get(f'/api/items/{ident}/renewals').json[0]
    assert restored['amount_cents'] is None and restored['amount'] is None and restored['recorded_at'] is None and restored['undoable'] is True
    assert client.get('/api/export').json['renewals'][0]['amount_cents'] is None
    # 恢复以 amount_cents 为准，忽略展示用的 amount 字符串。
    skewed=json.loads(json.dumps(backup)); skewed['renewals'][0]['amount']='1.00'
    assert post(client,'/api/restore',{'confirm':True,'backup':skewed}).status_code==200
    assert client.get(f'/api/items/{ident}/renewals').json[0]['amount']=='99.99'
    for key,value in (('amount_cents',True),('amount_cents',-1),('amount_cents','9999'),('amount_cents',10**10),('recorded_at','昨天'),('recorded_at',123),('recorded_at','x'*41)):
        bad=json.loads(json.dumps(backup)); bad['renewals'][0][key]=value
        assert post(client,'/api/restore',{'confirm':True,'backup':bad}).status_code==400, (key,value)
        assert client.get('/api/export').json['renewals'][0]['amount']=='99.99'


def test_legacy_database_is_migrated(tmp_path):
    path=tmp_path/'ledger.sqlite3'
    with sqlite3.connect(path) as conn:
        conn.executescript('''
        CREATE TABLE subscriptions (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE renewals (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, actual_date TEXT NOT NULL, previous_date TEXT NOT NULL, next_date TEXT NOT NULL);
        CREATE TABLE attempts (ip TEXT PRIMARY KEY, count INTEGER NOT NULL, start REAL NOT NULL);''')
        payload=dict(name='旧记录',amount='12.30',amount_cents=1230,cycle='monthly',days=None,next_date='2024-02-29',auto_renew=True,status='active',end_date=None,url='',notes='',anchor_day=31,anchor_month=1)
        conn.execute('INSERT INTO subscriptions VALUES (?,?)',('a'*32,json.dumps(payload)))
        conn.execute('INSERT INTO renewals VALUES (?,?,?,?,?)',('b'*32,'a'*32,'2024-01-31','2024-01-31','2024-02-29'))
    for _ in range(2):   # 迁移必须幂等
        application=create_app({'TESTING':True,'DATA_DIR':str(tmp_path),'PASSWORD_HASH':generate_password_hash('test-password-123')})
    with sqlite3.connect(path) as conn:
        assert {row[1] for row in conn.execute('PRAGMA table_info(renewals)')}>={'amount_cents','recorded_at'}
    c=application.test_client(); token=c.get('/api/session').json['csrf']
    assert c.post('/api/login',json={'password':'test-password-123'},headers={'X-CSRF-Token':token}).status_code==200
    c.token=c.get('/api/session').json['csrf']
    history=c.get(f'/api/items/{"a"*32}/renewals').json
    assert history==[{'id':'b'*32,'subscription_id':'a'*32,'actual_date':'2024-01-31','previous_date':'2024-01-31','next_date':'2024-02-29','amount_cents':None,'amount':None,'recorded_at':None,'undoable':True}]
    # 新记录排在无时间戳的旧记录前面，旧记录仍可在轮到它时撤销。
    post(c,f'/api/items/{"a"*32}/renew',{'actual_date':'2024-02-29','next_date':'2024-03-31','confirm':True})
    history=c.get(f'/api/items/{"a"*32}/renewals').json
    assert [h['recorded_at'] is None for h in history]==[False,True] and history[0]['undoable'] and not history[1]['undoable']
    assert post(c,f'/api/items/{"a"*32}/renewals/{history[0]["id"]}/undo',{'confirm':True}).status_code==200
    assert post(c,f'/api/items/{"a"*32}/renewals/{"b"*32}/undo',{'confirm':True}).status_code==200
    assert c.get('/api/items').json[0]['next_date']=='2024-01-31'
