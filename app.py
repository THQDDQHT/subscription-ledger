import json
import os
import secrets
import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import click
from flask import Flask, g, jsonify, render_template, request, session
from werkzeug.security import check_password_hash, generate_password_hash
from domain import validate, advance, summary, parse_date


def db():
    if 'db' not in g:
        from flask import current_app
        g.db = sqlite3.connect(Path(current_app.config['DATA_DIR'])/'ledger.sqlite3', timeout=15)
        g.db.row_factory = sqlite3.Row
    return g.db


def create_app(config=None):
    app=Flask(__name__)
    app.config.update(DATA_DIR=os.environ.get('LEDGER_DATA_DIR',str(Path(__file__).parent/'data')),
                      SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE='Strict',
                      SESSION_COOKIE_SECURE=os.environ.get('LEDGER_COOKIE_SECURE','0')=='1',
                      PERMANENT_SESSION_LIFETIME=timedelta(hours=12), MAX_CONTENT_LENGTH=2*1024*1024)
    if config: app.config.update(config)
    root=Path(app.config['DATA_DIR']); root.mkdir(parents=True,exist_ok=True,mode=0o700)
    secret=root/'session.key'
    try:
        fd=os.open(secret,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as f: f.write(secrets.token_hex(32))
    except FileExistsError: pass
    app.secret_key=secret.read_text().strip()
    with app.app_context():
        db().executescript('''
        CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS renewals (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, actual_date TEXT NOT NULL, previous_date TEXT NOT NULL, next_date TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS attempts (ip TEXT PRIMARY KEY, count INTEGER NOT NULL, start REAL NOT NULL);
        ''')
        db().commit()
        os.chmod(root/'ledger.sqlite3',0o600)
        db().close(); g.pop('db',None)

    @app.teardown_appcontext
    def close_db(error=None):
        conn=g.pop('db',None)
        if conn: conn.close()

    def password_hash():
        if app.config.get('TESTING') and app.config.get('PASSWORD_HASH'): return app.config['PASSWORD_HASH']
        p=root/'password.hash'
        return p.read_text().strip() if p.exists() else None

    def rows():
        return [dict(json.loads(r['payload']),id=r['id']) for r in db().execute('SELECT * FROM subscriptions')]

    def get_row(ident):
        r=db().execute('SELECT payload FROM subscriptions WHERE id=?',(ident,)).fetchone()
        if r is None: return None
        return dict(json.loads(r['payload']),id=ident)

    def payload():
        data=request.get_json(silent=True)
        if not isinstance(data,dict): raise ValueError('请求必须为 JSON 对象')
        return data

    def export_data():
        return {'format':'subscription-ledger','version':1,'currency':'CNY',
                'items':sorted(rows(),key=lambda r:r['id']),
                'renewals':[dict(r) for r in db().execute('SELECT * FROM renewals ORDER BY id')]}

    @app.before_request
    def security():
        if request.path.startswith('/api/'):
            session.setdefault('csrf',secrets.token_urlsafe(32))
            if request.path not in ('/api/login','/api/session') and not session.get('authenticated'):
                return jsonify(error='请先登录'),401
            if request.method not in ('GET','HEAD','OPTIONS'):
                token=request.headers.get('X-CSRF-Token','')
                if not secrets.compare_digest(token,session['csrf']): return jsonify(error='CSRF 校验失败，请刷新重试'),403

    @app.after_request
    def headers(response):
        response.headers['Cache-Control']='no-store'
        response.headers['X-Content-Type-Options']='nosniff'
        response.headers['X-Frame-Options']='DENY'
        response.headers['Referrer-Policy']='no-referrer'
        response.headers['Content-Security-Policy']="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        return response

    @app.errorhandler(ValueError)
    def invalid(error): return jsonify(error=str(error)),400

    @app.errorhandler(413)
    def too_large(error): return jsonify(error='文件过大，限制 2 MiB'),413

    @app.get('/')
    def index(): return render_template('index.html')

    @app.get('/api/session')
    def session_info():
        return jsonify(authenticated=bool(session.get('authenticated')),csrf=session['csrf'],configured=bool(password_hash()))

    @app.post('/api/login')
    def login():
        supplied=payload().get('password')
        if not isinstance(supplied,str) or len(supplied)>1024: raise ValueError('密码格式不正确')
        stored=password_hash()
        if not stored: return jsonify(error='请先在服务器运行 init-password 初始化密码'),503
        # Do not trust X-Forwarded-For. Reverse-proxied deployments intentionally share one limiter.
        ip=request.remote_addr or 'unknown'; now=time.time(); conn=db()
        conn.execute('BEGIN IMMEDIATE')
        attempt=conn.execute('SELECT * FROM attempts WHERE ip=?',(ip,)).fetchone()
        count=attempt['count'] if attempt and now-attempt['start']<900 else 0
        start=attempt['start'] if count else now
        if count>=5:
            conn.rollback()
            return jsonify(error='尝试过多，请在 15 分钟窗口结束后重试'),429,{'Retry-After':str(max(1,int(900-(now-start))))}
        if not check_password_hash(stored,supplied):
            conn.execute('INSERT OR REPLACE INTO attempts VALUES (?,?,?)',(ip,count+1,start))
            conn.commit(); return jsonify(error='密码错误'),401
        conn.execute('DELETE FROM attempts WHERE ip=?',(ip,)); conn.commit()
        session.clear(); session.update(authenticated=True,csrf=secrets.token_urlsafe(32))
        session.permanent=True
        return jsonify(ok=True,csrf=session['csrf'])

    @app.post('/api/logout')
    def logout(): session.clear(); return jsonify(ok=True)

    @app.get('/api/items')
    def list_items():
        result=rows()
        for r in result: r['suggested_next']=advance(r)
        return jsonify(sorted(result,key=lambda r:r['next_date']))

    @app.get('/api/summary')
    def stats(): return jsonify(summary(rows(),datetime.now(ZoneInfo('Asia/Shanghai')).date()))

    @app.post('/api/items')
    def add_item():
        r=validate(payload()); ident=secrets.token_hex(16)
        with db(): db().execute('INSERT INTO subscriptions VALUES (?,?)',(ident,json.dumps(r,ensure_ascii=False)))
        return jsonify(dict(r,id=ident)),201

    @app.route('/api/items/<ident>',methods=['PUT','DELETE'])
    def change_item(ident):
        conn=db(); conn.execute('BEGIN IMMEDIATE'); old=get_row(ident)
        if old is None: conn.rollback(); return jsonify(error='记录不存在'),404
        data=payload()
        if request.method=='DELETE':
            if data.get('confirm') is not True: raise ValueError('删除需要明确确认')
            conn.execute('DELETE FROM subscriptions WHERE id=?',(ident,))
            conn.execute('DELETE FROM renewals WHERE subscription_id=?',(ident,))
        else:
            r=validate(data,previous=old)
            conn.execute('UPDATE subscriptions SET payload=? WHERE id=?',(json.dumps(r,ensure_ascii=False),ident))
        conn.commit(); return jsonify(ok=True)

    @app.post('/api/items/<ident>/renew')
    def renew(ident):
        conn=db(); conn.execute('BEGIN IMMEDIATE'); r=get_row(ident)
        if not r: conn.rollback(); return jsonify(error='记录不存在'),404
        data=payload()
        if data.get('confirm') is not True: raise ValueError('续费需要明确确认')
        if r['status'] not in ('active','cancelling'): raise ValueError('取消或结束记录不能确认续费，请先修改状态')
        actual=parse_date(data.get('actual_date')); nxt=parse_date(data.get('next_date'))
        today=datetime.now(ZoneInfo('Asia/Shanghai')).date()
        if actual>today: raise ValueError('实际续费日期不能在未来')
        if nxt<=actual or nxt<=parse_date(r['next_date']): raise ValueError('下一次日期须晚于实际续费日期和原计划日期')
        conn.execute('INSERT INTO renewals VALUES (?,?,?,?,?)',(secrets.token_hex(16),ident,actual.isoformat(),r['next_date'],nxt.isoformat()))
        r.pop('id'); r['next_date']=nxt.isoformat()
        conn.execute('UPDATE subscriptions SET payload=? WHERE id=?',(json.dumps(r,ensure_ascii=False),ident)); conn.commit()
        return jsonify(ok=True)

    @app.get('/api/export')
    def export():
        response=jsonify(export_data()); response.headers['Content-Disposition']='attachment; filename="subscription-ledger.json"'
        return response

    @app.post('/api/restore')
    def restore():
        data=payload()
        if data.get('confirm') is not True: raise ValueError('恢复覆盖需要明确确认')
        backup=data.get('backup')
        if not isinstance(backup,dict) or backup.get('format')!='subscription-ledger' or type(backup.get('version')) is not int or backup['version']!=1 or backup.get('currency')!='CNY': raise ValueError('备份格式/版本不支持（仅人民币）')
        items=backup.get('items'); history=backup.get('renewals')
        if not isinstance(items,list) or len(items)>2000 or not isinstance(history,list) or len(history)>10000: raise ValueError('备份列表无效或超限')
        import re
        def identifier(value):
            if not isinstance(value,str) or not re.fullmatch('[a-f0-9]{32}',value): raise ValueError('备份 ID 无效')
            return value
        prepared=[]; ids=set(); history_ids=set()
        for r in items:
            clean=validate(r,restoring=True); ident=identifier(r.get('id'))
            if ident in ids: raise ValueError('备份存在重复记录')
            ids.add(ident); prepared.append((ident,json.dumps(clean,ensure_ascii=False)))
        prepared_history=[]
        for h in history:
            if not isinstance(h,dict): raise ValueError('续费历史无效')
            ident=identifier(h.get('id')); sub=identifier(h.get('subscription_id'))
            if ident in history_ids or sub not in ids: raise ValueError('续费历史引用/ID 无效')
            actual=parse_date(h.get('actual_date')); prev=parse_date(h.get('previous_date')); nxt=parse_date(h.get('next_date'))
            if nxt<=actual or nxt<=prev: raise ValueError('续费历史日期无效')
            history_ids.add(ident); prepared_history.append((ident,sub,actual.isoformat(),prev.isoformat(),nxt.isoformat()))
        # Lock out other writers BEFORE backing up the same committed snapshot.
        conn=db(); conn.execute('BEGIN IMMEDIATE')
        directory=root/'backups'; directory.mkdir(exist_ok=True,mode=0o700)
        target=directory/(datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+secrets.token_hex(6)+'.sqlite3')
        try:
            fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); os.close(fd)
            with sqlite3.connect(root/'ledger.sqlite3') as source, sqlite3.connect(target) as dest:
                source.backup(dest)
            conn.execute('DELETE FROM renewals'); conn.execute('DELETE FROM subscriptions')
            conn.executemany('INSERT INTO subscriptions VALUES (?,?)',prepared)
            conn.executemany('INSERT INTO renewals VALUES (?,?,?,?,?)',prepared_history)
            conn.commit()
        except Exception:
            conn.rollback(); raise
        return jsonify(ok=True,backup_file=target.name)

    @app.cli.command('init-password')
    def init_password():
        """Initialize/change password interactively; invalidates existing sessions."""
        password=click.prompt('设置登录密码（至少 12 字符）',hide_input=True,confirmation_prompt=True)
        if len(password)<12 or len(password)>1024: raise click.ClickException('密码长度必须为 12–1024')
        p=root/'password.hash'; temp=root/'password.hash.tmp'
        fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
        with os.fdopen(fd,'w') as f: f.write(generate_password_hash(password,method='scrypt'))
        os.replace(temp,p)
        secret.write_text(secrets.token_hex(32)); click.echo('密码已安全哈希保存。请重启应用使旧会话失效。')
    return app
