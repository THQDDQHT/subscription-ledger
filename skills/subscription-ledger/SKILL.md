---
name: subscription-ledger
description: 管理私人订阅和话费、水电等余额账户，查询续费提醒，记录充值、实际账单和余额校正。通过账本 API 操作，适用于用户要求记账或查询到期事项时。
required_environment_variables:
  - name: LEDGER_BASE_URL
    prompt: 账本根地址
    required_for: API access
  - name: LEDGER_API_TOKEN
    prompt: 账本 Agent 令牌
    required_for: API access
---

# 订阅与余额账本

使用 `scripts/ledger.py` 调用外部账本。Python 3 标准库即可，无需安装依赖。

## 配置

从账本「备份与设置 → Agent API 与 Skill」生成独立令牌。只读令牌用于查询，读写令牌用于记账。通过 Agent 的环境变量机制设置 `LEDGER_BASE_URL`（账本根地址，无 `/api/v1` 后缀）和 `LEDGER_API_TOKEN`。不要把凭据写到 Skill、命令参数或聊天回复。

## 操作流程

1. 查询 `/items`，按名称和备注定位账户。遇到同名记录或账期不明确时，先澄清，不能取第一条猜测。
2. 查询 `/summary` 取得账本的上海时区日期。新建余额账户需要费用、周期、下次扣减日、余额及核对日期。用户说“大概”时选择 `estimated`；“每月固定”选择 `fixed`。日期或金额缺失时补问。
3. 每个独立写操作生成一个 UUID 作为 `--key`，保存请求 JSON 到文件；同一次超时重试保持同一 key 和原文件，不换 key。接口返回 409 时先查明冲突，不能换 key 强行重做。验证失败可修正字段并使用新 key。
4. 写入后回读 `/items/{id}` 及对应流水，报告名称、变动金额、余额和下次日期。结果不明确时说明待核实。

操作映射：

| 用户意图 | 接口与关键字段 |
| --- | --- |
| 新增记录 | POST `/items`，字段见下方示例或 `/openapi.json` |
| 改名称、计划、费用、暂停 | GET `/items/{id}` 后 PUT 完整记录，修改指定字段；`cancelled` 暂停扣减，`active` 恢复 |
| “充值了 100” | POST `/items/{id}/topup`，`{"amount":"100.00"}`，增加余额 |
| “实际还剩 83” | POST `/items/{id}/reconcile`，`{"balance":"83.00"}`，对齐今天的实际余额，可为负 |
| “这期实际水费 41” | GET `/items/{id}/balance-entries` 定位该期 `charge`；POST `/items/{id}/bill`，`{"entry_id":"…","amount":"41.00"}` |
| 已续费 | POST `/items/{id}/renew`，`confirm:true`、`actual_date`、`next_date`、`amount`；下次默认建议可从单条记录的 `suggested_next` 获取 |
| 删除记录 | 仅在用户明确要求删除时 DELETE `/items/{id}`，`{"confirm":true}`，会删除全部流水 |
| 待续费、余额不足 | GET `/reminders`；查询没有发送或确认副作用 |

充值、校正、实际账单是不同操作。实际账单填本期**总额**，服务端只调整与已记账金额的差额；如果之后已经核对过真实余额，补录仅修正历史，不再影响当前余额。

新余额账户首个扣减日期必须晚于余额核对日期，防止把已经包含在余额里的消费再次扣除。首次余额不是充值。暂停后恢复会补齐未记录周期；如果暂停期间的实际余额已知，先校正余额再恢复。

## 示例调用

```sh
python3 scripts/ledger.py GET /items
python3 scripts/ledger.py GET /summary
python3 scripts/ledger.py GET /openapi.json
python3 scripts/ledger.py POST /items --body /tmp/ledger-intent.json --key <本次UUID>
python3 scripts/ledger.py GET /items/<返回的id>
python3 scripts/ledger.py GET /reminders
```

新余额账户请求示例（日期应按用户实际信息填写）：

```json
{"name":"手机话费","kind":"prepaid","amount":"59.00","cycle":"monthly","next_date":"2026-10-01","status":"active","auto_renew":false,"cost_type":"fixed","balance":"120.00","balance_as_of":"2026-09-15","low_balance":"0"}
```

费用均为人民币十进制字符串。返回的 `*_cents` 是整数分。周期支持 `monthly`、`quarterly`、`semiannual`、`yearly`、`days` + `days`、`months` + `months`、`years` + `years`。例如每 2 个月用 `cycle=months, months=2`。

## 独立推送

账本自己调度扣减并使用专用 Telegram Bot 发送通知，不依赖 Hermes。Skill 的 `/reminders` 查询不会标记账本通知为已发送。用户要求 Hermes 推送时，用 Hermes 已配置且获授权的发送能力；本 Skill 不提供发送能力或收件人配置权限。两边分别开启相同提醒时，可能各发一条。
