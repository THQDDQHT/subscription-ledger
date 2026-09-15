# 余额与 Agent 功能部署计划

## 部署对象

- SSH：`root@139.196.98.1:50022`（用户已明确允许 root）；Git 操作用仓库属主 `q2qs` 执行。
- 目录：`/home/q2qs/projects/subscription-ledger`。
- Git：`https://github.com/THQDDQHT/subscription-ledger.git`，本地 `main` 推送到 `origin/main`。最终完整 commit 在部署确认消息中锁定。
- 只读预检：工作区干净，运行 commit 为 `e8bbc57305db41d8813472cebeed0640e28aab28`。
- Compose：网页 `ledger` 加独立 `worker`，同一个已核对 revision 的镜像；以镜像 digest 固定 `LEDGER_IMAGE`。
- 端口仍为 `127.0.0.1:8765 → 8000`；复用现有反向代理和 HTTPS。
- 数据卷：`subscription-ledger_ledger-data:/data`，新增 SQLite 表与 `notifications.json`，不更换卷。

## 获批后的执行顺序

1. 推送已锁定的本地 `main` commit，等待 GitHub Actions 测试、生产构建和多架构镜像发布成功。
2. 重新核实服务器工作区干净、origin 正确；用 `runuser -u q2qs -- git -C ... fetch origin` 获取代码，再 checkout 已锁定的完整 SHA。
3. 拉取该 SHA 的镜像，验证 `org.opencontainers.image.revision` 与完整 SHA 一致，取得 digest 并以 `LEDGER_IMAGE` 固定本次及后续 Compose 操作。保留原 `.env` 其他字段和权限。
4. 校验 `docker compose config --quiet`。停止旧网页写入（后续升级也停止 worker），产生短暂访问中断。
5. **先备份生产数据库**，然后单独执行迁移：

   ```sh
   docker compose run --rm --no-deps ledger node maintenance.cjs backup
   docker compose run --rm --no-deps ledger node maintenance.cjs migrate
   ```

   备份保存于现有数据卷的 `/data/backups/pre-upgrade-*.sqlite3`，记录实际文件名；迁移新增余额流水、请求去重、Agent 令牌、通知及 worker 状态表，保留全部原订阅和续费历史。任一步失败则停止升级，不自动覆盖数据或回滚。

6. `docker compose up -d ledger worker`，核对网页访问、未登录隔离、worker 健康状态、日志、镜像 revision 和数据条数。
7. 把仓库 `skills/subscription-ledger` 安装到现有 Hermes 数据目录的 `skills/subscription-ledger`。只安装这项新 Skill；已有同名目录时先比较并保留备份。
8. 在账本设置页配置专用 Telegram Bot、选择本人 Chat ID 并发送测试；此步骤需要用户新 Bot 信息，目前尚未提供。通过设置页创建 Hermes 的独立令牌，配置其 `LEDGER_BASE_URL` 和 `LEDGER_API_TOKEN` 后执行只读回验。新令牌只在服务器秘密配置中传递，不输出到聊天或提交 Git。

账本的扣减和通知不依赖第 7–8 步中的 Hermes 接入。新 Bot 配置前 Telegram 默认关闭，worker 仍正常记账。不得从现有 Hermes Telegram 配置中取值作为账本 Bot。

## 回滚候选与限制

部署前版本：`e8bbc57305db41d8813472cebeed0640e28aab28`。保留原镜像 digest 和升级前数据库备份。回滚需另行确认，停止网页和 worker，先保存当前数据再恢复选定数据库及旧镜像；升级后新增的流水需要从保留副本人工核对，不能悄悄丢弃。

本次开发只完成本地实现、测试和服务器只读预检，尚未 push、部署或执行生产迁移。真实 Telegram 发送、Hermes 运行时调用和服务器镜像运行需部署后验证。
