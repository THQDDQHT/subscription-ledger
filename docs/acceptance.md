# 核心验收记录

本次接手保留原项目，没有从零重写。

## 实际执行结果

- workspace Python 3.13：pytest **24 passed in 2.42s**。
- 宿主机 `/home/q2qs/projects/subscription-ledger`，独立 Python 3.12 venv：pytest **24 passed in 2.11s**。
- 两端真实 TCP HTTP 烟测：**7 groups passed**，包括进程重启后库与会话持久化、恢复前 SQLite 备份、退出后拒绝读取；临时服务 loopback、执行结束终止并检查端口关闭。
- 两端 Node 前端回归通过：401 更新 CSRF；刷新请求离线时仍清除私人 DOM、状态和弹窗。
- workspace 压测：2000 条从 1900 年开始的每天续费记录，展开 60000 个未来事件，实际 **0.155 秒**。
- 复制时 21 个源文件逐文件 SHA-256 校验一致，不含本地 venv、数据、密钥和缓存。本文件为验收后补充。

## 修复

- 添加 pytest.ini，修复直接运行 pytest 时 app/domain 导入失败。
- 预测用算术快进跳过历史周期，保留月末/闰年锚点；新增回归先观察到 3 项失败，再修复通过。
- 会话失效清除私人界面并刷新 CSRF，登录前再次取 token；新增 Node 回归先失败、修复后通过。

## 安装问题及处理

宿主机 Python 缺少 ensurepip，默认 `python3 -m venv` 失败。未安装系统包、未 sudo，改用 `python3 -m venv --without-pip .venv`，从官方 HTTPS `https://bootstrap.pypa.io/pip/pip.pyz` 下载到 `.venv/pip.pyz`，通过以下命令把依赖仅安装到项目 venv：

```sh
python3 .venv/pip.pyz --python .venv/bin/python install -r requirements-dev.txt
```

## 尚未验收/上线

- 尚未进行真实手机浏览器主要操作验收（响应式样式存在，HTTP/Node 测试不能替代浏览器验收）。
- Docker 配置提供但依要求未构建/启动。
- 没有初始化用户正式密码、常驻应用服务、修改 Nginx、域名、生产服务或开放公网端口；这些需另行授权。
