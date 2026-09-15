# 私人订阅账本

单用户中文账本，Next.js + TypeScript + SQLite，所有金额固定人民币。支持订阅续费，以及话费、水电等余额账户。余额按固定或估算费用自动记账，专用 Telegram Bot 发送提醒，Hermes 等 Agent 通过 API 和 Skill 管理。

## 本机运行

需要 Node 24、pnpm（版本见 `packageManager`），构建及 Skill 客户端需要 Python 3。

```sh
pnpm install
pnpm init-password         # 交互设置密码
pnpm dev                   # 网页 http://127.0.0.1:8765
pnpm worker                # 另一个终端运行，每分钟检查一次
```

生产构建：

```sh
pnpm build                 # Next standalone + worker + CLI + Skill 下载包
pnpm serve
node .next/standalone/worker.cjs
```

两个进程必须使用同一个 `LEDGER_DATA_DIR`（默认项目 `data/`）。worker 独立运行，无需打开网页、模型服务或 Hermes。`--once` 可执行一轮后退出。设置页显示 worker 最近检查时间与错误。

## 订阅与余额账户

- 周期：月付、季付、半年付、年付，自定义天数（1–36500）、月数（1–1200）、年数（1–100）。例如每 2 个月用自定义月数 2。
- 月/年按日历递推，目标月份没有对应日期时取月末，后续保留原始锚点；直接修改计划日期、周期或数量会重置锚点。例如 1 月 31 日月付 → 2 月 28 日 → 3 月 31 日。首次选择 2 月 28 日则以 28 日为锚点。
- 订阅仍需手工确认续费：填写实际日期、金额和下一次日期。到期只提醒，不自动假定已经支付。最近一次且计划未再修改的续费可撤销。
- 余额账户填写当前余额、余额核对日期、固定/估算费用、周期、下次自动扣减日期。首个扣减日须晚于核对日，防止重复记录余额已经包含的消费。
- worker 对使用中/准备取消的余额账户按期生成扣减流水；停机后补齐漏掉的账期。余额可以为负数，表示账本预计欠额，以运营商实际余额为准。
- 「记录充值」增加本次金额；「校正余额」对齐今天核对的实际余额；「补录实际账单」填写该期总额，只调整与已经入账金额的差额。若之后已经核对过余额，补录只修正历史，避免重复改变当前余额。
- 「暂停自动扣减」不记账，恢复使用中后会补齐旧计划；已知暂停期间的实际余额时，先校正再恢复。
- 账面变动保留期初、充值、消费、校正及来源流水；不会向银行、运营商或水电平台发起真实支付，也不替用户取消服务。

预算只按有效账户的周期费用统计，充值和校正不重复计入支出。月度等效采用整数有理数求和后四舍五入到分；估算费用会在界面标注。所有日期按 Asia/Shanghai，统计窗口为 `[今天, 今天+7/30天)`。

## 独立 Telegram Bot

1. 在 [BotFather](https://t.me/BotFather) 创建专用 Bot，向新 Bot 私聊发送 `/start`。
2. 打开「备份与设置 → 独立 Telegram 通知」，填写新 Bot Token。
3. 点击「读取 Bot 最近私聊」，选择自己的接收人，也可直接填写数字 Chat ID。读取不消费更新，不配置 webhook；此 Bot 用于账本通知。
4. 填写提醒提前天数（默认 3 天），可填账本地址用于消息中的详情链接，勾选启用后保存。
5. 点击「发送测试通知」确认目标；查看最近发送状态。

规则：订阅提前提醒阶段和到期阶段各发送一次；余额不足一期费用或自设阈值时提醒，临近扣减时也预测扣减后余额。充值、校正、推进账期后重新判断。失败持久化并退避重试；问题解决后取消待发旧提醒。正常重复检查不重复发送；网络超时若 Telegram 已收件但响应丢失，重试可能重复，外部发送无法保证严格一次。

Bot Token 仅存于服务端 `notifications.json`（0600），设置读取不回显，不进入账本 JSON 备份。账本不读取 Hermes 配置、Bot Token 或 cron。Hermes 自行推送和账本通知相互独立，分别启用同一提醒可能各发一条。

## Agent API 与 Hermes Skill

在设置页创建独立可撤销令牌，支持只读和读写；完整令牌仅创建时显示，数据库只保存哈希。

- API 根路径：`/api/v1`，使用 `Authorization: Bearer <token>`；不接受网页登录 Cookie 代替令牌。
- 文档：网页登录后 `/api/openapi.json`；Agent 使用 `/api/v1/openapi.json`。
- 查询：`GET /items`、`/items/{id}`、`/summary`、`/reminders`、`/items/{id}/balance-entries`、`/items/{id}/renewals`。
- 操作：`POST /items`；`PUT/DELETE /items/{id}`；`POST /items/{id}/topup|reconcile|bill|renew`；`POST /items/{id}/renewals/{rid}/undo`。
- 所有 Agent 写入需要 `Idempotency-Key`（建议 UUID）。同一操作重试保持原 key 和原 JSON，不同内容重用会返回 409。网页余额操作也带此标识。
- Agent 无权改 Telegram 配置、管理令牌或恢复数据库。删除和续费需要 `confirm:true`，Skill 按用户明确意图操作。

[Skill 源码](skills/subscription-ledger/SKILL.md) 可从页面下载 ZIP。将 ZIP 中的 `subscription-ledger/` 放入 Hermes 实际 `HERMES_HOME/skills/`，通过 Hermes 的秘密环境配置设置 `LEDGER_BASE_URL` 和 `LEDGER_API_TOKEN`。Skill 已声明所需环境变量以便透传到工具执行环境，无需修改 Hermes 本体。

```sh
python3 skills/subscription-ledger/scripts/ledger.py GET /items
python3 skills/subscription-ledger/scripts/ledger.py GET /reminders
```

客户端使用 Python 标准库，不把密钥放进命令参数，不跟随重定向。HTTP 只允许本机回环，其余地址要求 HTTPS。Hermes 可根据 `/reminders` 结果使用自己的获授权渠道推送；查询不修改账本发送状态。参考 [Hermes Skill 文档](https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills)。

## 会话与数据安全

网页登录 Cookie 为 HMAC 签名、HttpOnly、SameSite=Strict，登录后固定 **30 天**失效，访问不续期；退出立即清除浏览器登录状态。旧的 12 小时凭证仍按原期限到期，重新登录后才是 30 天。写入校验 CSRF；登录错误全局限速为 15 分钟 5 次。

数据目录 0700，数据库、密码哈希、会话密钥和通知配置 0600。密码 12–1024 字符，用 scrypt 存储；更换后重启网页进程使缓存旧会话密钥失效。公网通过 HTTPS 反代并设置 `LEDGER_COOKIE_SECURE=1`，服务端口保持 loopback。CSP、no-store 等响应头由 `src/proxy.ts` 设置。

## 备份与迁移

普通订阅导出保持 v1；有余额账户时导出 v2，包含完整余额流水。两者均不含网页登录密码、Bot Token 或 Agent 令牌。恢复严格校验金额、日期、引用、流水顺序与最终余额。最多 2000 条记录、10000 条续费历史、50000 条余额流水，请求体最大 16 MiB。旧备份可继续恢复；有余额账户的备份不能交给旧版本恢复。

JSON 恢复会替换全部记录与历史，在同一写锁下先备份旧数据库再覆盖；失败回滚。保留当前密码、Agent 令牌、通知配置。通知发送状态会重新生成。请求去重历史保留，已经用过的请求 key 仍不能当作新的操作重复使用。

升级前先停止写入方、创建备份，再迁移。明确维护命令：

```sh
node .next/standalone/maintenance.cjs backup
node .next/standalone/maintenance.cjs migrate
```

`backup` 使用 SQLite Backup API 生成 `data/backups/pre-upgrade-*.sqlite3`；`migrate` 幂等新增余额流水、请求去重、Agent 令牌、通知状态和 worker 状态表，保留现有订阅和续费历史。旧库补列兼容原 Python 版。首次启动也会检查并补齐表；生产部署必须先执行上面的备份与迁移步骤，再启动新版服务。

回滚时停止网页及 worker，保留当前数据目录副本，用明确选定的备份恢复数据库，再切回旧镜像；不能在运行中覆盖 SQLite 文件。完整服务器迁移需备份整个数据目录，包含秘密，不可公开分享。

## Docker 部署

Compose 使用同一镜像启动 `ledger` 和 `worker`，共用 `ledger-data:/data`。非 root、只读根文件系统、日志轮转，只有网页绑定 `127.0.0.1:8765`。worker 无公开端口，带最近运行时间健康检查。

CI 测试通过后发布多架构镜像到 `ghcr.io/thqddqht/subscription-ledger`。`LEDGER_IMAGE` 可指定版本镜像或 digest，默认 `:main`。本机手工构建用 `docker build -t subscription-ledger:local .`，再用 `LEDGER_IMAGE=subscription-ledger:local docker compose up -d`。

首次设置密码：`docker compose run --rm ledger node init-password.cjs`。已有数据升级不重新初始化密码。生产升级计划见 [部署说明](docs/deployment-prepaid.md)，迁移和服务重启需按实际授权执行。

## 验证

```sh
pnpm test
pnpm build
pnpm smoke
```

测试覆盖日期/金额、原订阅流程、余额扣减及校正、Agent 权限和去重、v1/v2 备份、通知判断和重试。HTTP 烟测在临时数据目录运行真实生产服务、两个并发 worker 和 Python Skill 客户端，验证记账、备份迁移、下载及令牌撤销，结束后清理进程与数据。Telegram 自动测试使用模拟响应，不向真实用户发送消息。
