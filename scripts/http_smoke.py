"""Real TCP HTTP acceptance, isolated temp data and random loopback port.
No permanent server, production secrets, Docker or user data involved.
"""
import http.cookiejar
import json
import multiprocessing
from pathlib import Path
import secrets
import socket
import sys
import tempfile
import threading
import urllib.error
import urllib.request

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import create_app
from werkzeug.security import generate_password_hash
from werkzeug.serving import make_server


def serve(root, password_hash, pipe):
    app=create_app({'TESTING':True,'DATA_DIR':root,'PASSWORD_HASH':password_hash})
    server=make_server('127.0.0.1',0,app)
    pipe.send(server.server_port); pipe.close()
    server.serve_forever()


def main():
    checks=[]
    with tempfile.TemporaryDirectory(prefix='ledger-http-') as root:
        password=secrets.token_urlsafe(24); hashed=generate_password_hash(password)
        def start():
            parent,child=multiprocessing.Pipe()
            process=multiprocessing.Process(target=serve,args=(root,hashed,child)); process.start()
            if not parent.poll(15): process.terminate();process.join();raise RuntimeError('HTTP server did not become ready')
            port=parent.recv();parent.close();return process,port
        process,port=start()
        jar=http.cookiejar.CookieJar(); opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        def request(path,method='GET',body=None,token=None):
            headers={'Content-Type':'application/json'}
            if token is not None: headers['X-CSRF-Token']=token
            req=urllib.request.Request(f'http://127.0.0.1:{port}'+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method=method)
            try: response=opener.open(req,timeout=10)
            except urllib.error.HTTPError as e: response=e
            raw=response.read(); return response.status,json.loads(raw) if 'application/json' in response.headers.get('Content-Type','') else raw.decode(),response.headers
        try:
            assert request('/')[0]==200
            assert request('/static/app.js')[0]==200
            assert request('/static/style.css')[0]==200
            assert request('/static/favicon.svg')[0]==200
            assert request('/api/items')[0]==401;checks.append('HTTP 未登录隔离/HTML及静态资源')
            _,s,h=request('/api/session');token=s['csrf'];assert any(cookie.has_nonstandard_attr('HttpOnly') for cookie in jar)
            assert request('/api/login','POST',{'password':password},token='invalid')[0]==403
            status,s,_=request('/api/login','POST',{'password':password},token);assert status==200;token=s['csrf'];checks.append('真实 Cookie 登录及 CSRF')
            record={'name':'HTTP验收 <script>','amount':'19.99','cycle':'monthly','days':None,'next_date':'2024-01-31','status':'active','auto_renew':True,'url':'https://example.com/manage','notes':'临时测试，不是用户数据','end_date':None}
            status,r,_=request('/api/items','POST',record,token);assert status==201;ident=r['id']
            record['amount']='20.01';assert request('/api/items/'+ident,'PUT',record,token)[0]==200
            assert request('/api/items/'+ident+'/renew','POST',{'actual_date':'2024-01-31','next_date':'2024-02-29','confirm':True},token)[0]==200
            assert request('/api/items')[1][0]['suggested_next']=='2024-03-31';checks.append('HTTP 新增/编辑/月底续费')
            quarterly={**record,'name':'HTTP季付验收','cycle':'quarterly','next_date':'2024-01-31'}
            status,q,_=request('/api/items','POST',quarterly,token);assert status==201;qid=q['id']
            assert request('/api/items/'+qid+'/renew','POST',{'actual_date':'2024-01-31','next_date':'2024-04-30','confirm':True},token)[0]==200
            assert next(r for r in request('/api/items')[1] if r['id']==qid)['suggested_next']=='2024-07-31'
            original=request('/api/export')[1]
            assert request('/api/restore','POST',{'confirm':True,'backup':{'bad':1}},token)[0]==400
            assert request('/api/export')[1]==original
            assert request('/api/restore','POST',{'confirm':True,'backup':original},token)[0]==200
            assert request('/api/export')[1]==original
            assert next(r for r in request('/api/items')[1] if r['id']==qid)['suggested_next']=='2024-07-31'
            checks.append('HTTP 季付月底续费及混合周期备份恢复')
            assert len(list((Path(root)/'backups').glob('*.sqlite3')))==1;checks.append('HTTP 导出/坏输入保护/恢复前备份')
            assert request('/api/summary')[0]==200
            process.terminate();process.join(timeout=10)
            process,port=start()
            assert request('/api/items')[1][0]['amount']=='20.01';checks.append('进程真实重启后数据库及会话持久化')
            assert request('/api/items/'+ident,'DELETE',{'confirm':True},token)[0]==200
            assert request('/api/items/'+qid,'DELETE',{'confirm':True},token)[0]==200
            assert request('/api/items')[1]==[]
            assert request('/api/logout','POST',{},token)[0]==200
            assert request('/api/export')[0]==401;checks.append('HTTP 删除/退出后拒绝读取')
        finally:
            process.terminate();process.join(timeout=10)
            if process.is_alive(): process.kill();process.join()
        with socket.socket() as probe:
            assert probe.connect_ex(('127.0.0.1',port))!=0
        checks.append('临时服务停止、端口关闭；临时库退出后删除')
    print('\n'.join('PASS '+check for check in checks))
    print(f'HTTP SMOKE: {len(checks)} groups passed')

if __name__=='__main__': main()
