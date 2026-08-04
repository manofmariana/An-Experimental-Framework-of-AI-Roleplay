/**
 * WS 入站协议权威契约（优化阶段 D1，docs/optimization-review.md §9「协议单一来源」
 * 「rollback_and_continue 复合命令」）：Zod discriminated union 是 client → server
 * 消息的唯一权威定义，取代 ws-protocol.ts 手维护 ClientMessage 联合 + 先断言后手检。
 *
 * 字段口径与 SessionCoordinator 命令形状对齐（camelCase）：旧协议字段重命名——
 * input→player_input、command{command}→query{query}、rollback/reroll{seq}→{targetSeq}、
 * new_session{world_set}→{worldSetId}、pause_options 蛇形平铺→options 嵌套 camelCase。
 * 旧 reroll 消息删除、不留兼容映射：重 roll = rollback_and_continue 单条复合命令。
 *
 * 阶段 D2「消息身份」（docs/optimization-review.md §5）：mutation 命令携带
 * requestId（定向应答关联）/ runId（会话身份，携带且 ≠ 当前 → SESSION_SWITCHED）/
 * baseRevision（乐观并发闸，不符 → REVISION_CONFLICT）。豁免口径：
 * - pause_options/stop/query/new_session/load_session 免 baseRevision（非 mutation 或自有语义）；
 * - player_input 的 runId 可省略（首次输入自动建会话）；
 * - new_session 无 runId（尚无会话）；load_session 的 runId 是命令参数（目标存档）；
 * - stop 另带可选 activationId（携带且 ≠ 当前在途 → 幂等成功空结果）；
 * - query 带 runId（会话身份核对）。
 * 全部身份字段可选（缺省 = 跳过对应校验，兼容无身份调用方），各分支 .strict() 不变。
 *
 * 下行消息（ServerMessage）定义在 src/server/ws-protocol.ts；
 * contracts/ 不依赖 truth / agents / server / llm / application（依赖审计守护）。
 */
import { z } from "zod";

/** 暂停选项（与 GameSession.PauseOptions 同形；自动继续 = 全 false）。 */
export const PauseOptionsSchema = z.object({
  everyStep: z.boolean(),
  beforeGm: z.boolean(),
  afterGm: z.boolean(),
  afterProse: z.boolean(),
}).strict();
export type PauseOptionsPayload = z.infer<typeof PauseOptionsSchema>;

/** 定向应答关联 ID（前端 crypto.randomUUID 生成；command_result/command_error 原样回带）。 */
const requestIdField = { requestId: z.string().min(1).optional() };
/** 会话身份（携带且 ≠ 当前活跃会话 → SESSION_SWITCHED）。 */
const runIdField = { runId: z.string().min(1).optional() };
/** 乐观并发闸（携带且 ≠ 当前 revision → REVISION_CONFLICT）。 */
const baseRevisionField = { baseRevision: z.number().int().min(0).optional() };

/**
 * WS 入站命令（client → server）唯一权威。各分支 .strict()：未知字段即协议错误，
 * 与 web/protocol.js buildCommand 的字段白名单对称（身份字段由 protocol.js sendCommand 自动附加）。
 */
export const ClientCommandSchema = z.discriminatedUnion("type", [
  /** 玩家意图（三块输入拼装后的文本）；runId 可省略（首次输入自动建会话） */
  z.object({ type: z.literal("player_input"), text: z.string().min(1), ...requestIdField, ...runIdField, ...baseRevisionField }).strict(),
  /** 继续：按 pipeline 当前进度接着跑 */
  z.object({ type: z.literal("continue"), ...requestIdField, ...runIdField, ...baseRevisionField }).strict(),
  /** 回溯：回到第 targetSeq 步刚完成的位置（丢弃其后内容） */
  z.object({ type: z.literal("rollback"), targetSeq: z.number().int().min(1), ...requestIdField, ...runIdField, ...baseRevisionField }).strict(),
  /** 原子重 roll：丢弃第 targetSeq 步及之后内容，并在同一串行任务内续跑（不可插队） */
  z.object({ type: z.literal("rollback_and_continue"), targetSeq: z.number().int().min(2), ...requestIdField, ...runIdField, ...baseRevisionField }).strict(),
  /** 编辑当前步原始返回（决策包/裁决包须合法 JSON；正文纯文本） */
  z.object({ type: z.literal("edit_result"), text: z.string(), ...requestIdField, ...runIdField, ...baseRevisionField }).strict(),
  /** 重建会话（资源修改在新会话生效；worldSetId 可选，省略 = 缺省世界设定集）；无 runId（尚无会话） */
  z.object({ type: z.literal("new_session"), worldSetId: z.string().optional(), ...requestIdField }).strict(),
  /** 读取历史存档继续游玩（runId = 目标存档，是命令参数而非身份字段） */
  z.object({ type: z.literal("load_session"), runId: z.string().min(1), ...requestIdField }).strict(),
  /** 暂停选项（内存态；自动继续 = 全 false；互斥由前端保证，服务端按位生效） */
  z.object({ type: z.literal("pause_options"), options: PauseOptionsSchema, ...requestIdField, ...runIdField }).strict(),
  /** 停止：中止在途 LLM 调用，冻结为 interrupted；activationId 携带且 ≠ 当前在途 → 幂等成功 */
  z.object({ type: z.literal("stop"), ...requestIdField, ...runIdField, activationId: z.string().min(1).optional() }).strict(),
  /** 查询当前会话的一致快照 / 缓存埋点（snapshot = 单 revision 一致快照；stats = 缓存埋点） */
  z.object({ type: z.literal("query"), query: z.enum(["snapshot", "stats"]), ...requestIdField, ...runIdField }).strict(),
]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

/**
 * 协议错误：所有入站解析失败（非法 JSON / null / 数组 / 非对象 / 未知 type /
 * 字段类型错误 / 未知字段）统一抛它，message 稳定（`协议错误: <原因>`），
 * 不产生未捕获的原生 JSON/SyntaxError。
 */
export class ProtocolError extends Error {
  override readonly name = "ProtocolError";
  constructor(reason: string) {
    super(`协议错误: ${reason}`);
  }
}

/**
 * 入站唯一收敛点：原始 WS 文本 → 校验后的 ClientCommand。
 * 任何不合法输入抛 ProtocolError（含原因），绝不抛原生异常、绝不返回未校验对象。
 */
export function parseClientCommand(raw: string): ClientCommand {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ProtocolError(`非法 JSON: ${raw.slice(0, 120)}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new ProtocolError("消息必须是 JSON 对象");
  }
  const type = (data as { type?: unknown }).type;
  if (typeof type !== "string") {
    throw new ProtocolError("缺少命令类型字段 type");
  }
  const known = ClientCommandSchema.options.some((o) => o.shape.type.value === type);
  if (!known) {
    throw new ProtocolError(`未知命令类型: ${type}`);
  }
  const result = ClientCommandSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    throw new ProtocolError(`字段不合法（${type}）: ${where}${issue?.message ?? "未知"}`);
  }
  return result.data;
}
