# 订阅账本 MVP Implementation Plan

**Goal:** 单用户人民币订阅管理，真实持久化且安全恢复。
**Architecture:** Flask + SQLite，服务端鉴权/校验/日期计算，原生移动端界面；无外部前端资源。
**Tech Stack:** Python 3.11+、Flask、Werkzeug scrypt、pytest、gunicorn。

1. 先写核心/接口测试并执行 RED：金额、锚点、预算、鉴权、CSRF、CRUD、恢复事务、持久化。
2. 实现 domain.py 日期递推、字段校验、统计；数据库以整数分存储，月年保留月日锚点。
3. 实现 app.py：密码初始化 CLI、SQLite 持久登录限速、CSRF、CRUD、续费历史、备份恢复。
4. 实现中文 HTML/CSS/JS：登录、列表/筛选/统计、编辑/续费/删除/导出恢复；安全 DOM 渲染。
5. 跑全套测试与真实 loopback HTTP 测试（临时库，服务结束清理）。
6. README/Docker/compose，安全复制至宿主机全新目录，在宿主机虚拟环境重复验收。
7. 提交父代理独立需求/安全 review；不启动 Docker、不改 Nginx、不上线。

测试命令：`.venv/bin/python -m pytest -q`、`.venv/bin/python scripts/http_smoke.py`。
