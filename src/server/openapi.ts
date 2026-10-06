const money = { type: 'string', pattern: '^\\d{1,8}(\\.\\d{1,2})?$', description: '人民币元的十进制字符串；余额可为负数，API 返回 *_cents 为整数分' };
const date = { type: 'string', format: 'date', description: '上海时区 YYYY-MM-DD' };
const item = {
  type: 'object', required: ['name', 'amount', 'cycle', 'next_date', 'status', 'auto_renew'],
  properties: {
    name: { type: 'string', maxLength: 120 }, amount: money,
    kind: { type: 'string', enum: ['subscription', 'prepaid'], default: 'subscription' },
    cycle: { type: 'string', enum: ['monthly', 'quarterly', 'semiannual', 'yearly', 'days', 'months', 'years'] },
    days: { type: 'integer', minimum: 1, maximum: 36500 }, months: { type: 'integer', minimum: 1, maximum: 1200 }, years: { type: 'integer', minimum: 1, maximum: 100 },
    next_date: date, status: { type: 'string', enum: ['active', 'cancelling', 'cancelled', 'ended'] }, auto_renew: { type: 'boolean' },
    cost_type: { type: 'string', enum: ['fixed', 'estimated'], description: '余额账户必填' },
    balance: { type: 'string', description: '新余额账户必填，实际余额（元），支持负数。编辑请改用 reconcile。' },
    balance_as_of: { ...date, description: '首次余额核对日期，不晚于今天；next_date 必须在此日期之后' },
    low_balance: { ...money, description: '提醒余额下限，实际取此值与一期费用的较大者' },
    url: { type: 'string' }, notes: { type: 'string' }, end_date: { ...date, nullable: true, description: '服务可用截止日；当天仍可用' },
    cancelled_at: { ...date, readOnly: true, description: '只读：取消日期，仅普通订阅取消后存在，经 cancel 操作写入；旧记录可能缺失' },
    cancel_reason: { type: 'string', maxLength: 500, readOnly: true, description: '只读：取消原因，仅普通订阅取消后存在' },
    effective_status: { type: 'string', enum: ['active', 'cancelling', 'cancelled', 'ended'], readOnly: true, description: '只读：展示状态。普通订阅 status 为 cancelled 且 end_date 早于今天时为 ended，存储的 status 不变' },
  },
};
const object = (properties: object, required: string[]) => ({ type: 'object', properties, required });
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{32}$' } };
const key = { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' }, description: '每次独立写入生成新 UUID；超时重试必须保持原 key 和原请求体。同 key 不同内容返回 409。' };
function op(summary: string, body?: object, identified = false) {
  return { summary, parameters: [...(identified ? [id] : []), ...(body ? [key] : [])],
    ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } } : {}),
    responses: { '200': { description: '成功；金额以整数分和十进制字符串返回' }, ...(body === item ? { '201': { description: '创建成功，返回记录与 id' } } : {}), '400': { description: '字段校验失败' }, '401': { description: '令牌无效或已撤销' }, '403': { description: '无访问权限' }, '404': { description: '记录不存在' }, '409': { description: '幂等键冲突' }, '503': { description: '正在恢复备份，可稍后重试' } } };
}
export const openapi = {
  openapi: '3.0.3', info: { title: 'Subscription Ledger Agent API', version: '1.0.0', description: '订阅与余额记账。每次写操作需要读写令牌和 Idempotency-Key。不会发起真实支付。PUT 使用完整记录；先读取再修改。充值、校正与账单补录有独立接口。所有返回数据为 JSON。' },
  servers: [{ url: '/api/v1' }], security: [{ bearerAuth: [] }],
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, schemas: { ItemInput: item } },
  paths: {
    '/items': { get: op('查询全部记录，含 suggested_next 与 effective_status，可按 name/notes 在客户端筛选'), post: op('新增订阅或余额账户', item) },
    '/items/{id}': { get: op('查询单条，含 suggested_next 与 effective_status', undefined, true), put: op('完整更新计划，不能更换记录类型或覆盖余额；普通订阅不能经此把状态改为 cancelled，请使用 cancel 操作', item, true), delete: op('永久删除该记录及全部历史，须明确删除意图', object({ confirm: { type: 'boolean', enum: [true] } }, ['confirm']), true) },
    '/items/{id}/balance-entries': { get: op('余额流水，按入账顺序返回。charge 为周期扣减，bill_adjustment 通过 reference_id 关联原账单。', undefined, true) },
    '/items/{id}/topup': { post: op('充值：余额增加本次金额（须大于零）', object({ amount: money, notes: { type: 'string' } }, ['amount']), true) },
    '/items/{id}/reconcile': { post: op('校正：对齐今天核对的实际余额', object({ balance: { type: 'string' }, notes: { type: 'string' } }, ['balance']), true) },
    '/items/{id}/bill': { post: op('补录指定 charge 的实际总额，仅调整差额；之后已核对余额时仅校正历史', object({ entry_id: { type: 'string' }, amount: money, notes: { type: 'string' } }, ['entry_id', 'amount']), true) },
    '/items/{id}/renew': { post: op('记录订阅续费，余额账户不使用此操作', object({ confirm: { type: 'boolean', enum: [true] }, actual_date: date, next_date: date, amount: money }, ['confirm', 'actual_date', 'next_date']), true) },
    '/items/{id}/cancel': { post: op('取消订阅：仅普通订阅的 active/cancelling 可取消。记录 cancelled_at 与 cancel_reason，status 改为 cancelled、auto_renew 改为 false，不改下次日期与金额；之后不计入预算和提醒。账本不会替你在服务方取消', object({ confirm: { type: 'boolean', enum: [true] }, cancelled_at: { ...date, description: '默认今天，不能在未来' }, end_date: { ...date, description: '服务可用截止日，必填' }, reason: { type: 'string', maxLength: 500, description: '可选，去首尾空白' } }, ['confirm', 'end_date']), true) },
    '/items/{id}/reactivate': { post: op('恢复订阅：仅普通订阅的已取消或已结束记录可恢复。status 改为 active，清除取消信息与截止日，next_date 不能早于今天；日期改变时重置锚点', object({ confirm: { type: 'boolean', enum: [true] }, next_date: date, auto_renew: { type: 'boolean', default: false } }, ['confirm', 'next_date']), true) },
    '/items/{id}/renewals': { get: op('查询订阅续费历史，最新在前', undefined, true) },
    '/items/{id}/renewals/{rid}/undo': { post: { ...op('撤销最近一次可撤销的续费', object({ confirm: { type: 'boolean', enum: [true] } }, ['confirm']), true), parameters: [id, { ...id, name: 'rid' }, key] } },
    '/summary': { get: op('预算汇总，充值不重复计入费用') },
    '/reminders': { get: op('查询当前提醒，无发送副作用。kind 为 renewal、low_balance 或 cancel（准备取消的订阅临近续费日）。Hermes 可使用自己的渠道独立推送。') },
    '/openapi.json': { get: op('接口说明') },
  },
};
