/**
 * 浏览器唯一协议适配器（优化阶段 D1「协议单一来源」+ D2「消息身份」+ D4「装配收口」）：
 * 所有 WS 上行命令经 buildCommand 构造 + serialize 序列化，页面不再散落 {type: ...} 字面量。
 * 权威定义是服务端 src/contracts/protocol.ts 的 ClientCommandSchema（契约测试双向对拍）。
 *
 * D4 最终形 = createProtocol({transport, store, onStreaming, onUncorrelated}) 工厂：
 * - pending Map：requestId → {resolve, reject, command}，command_result/command_error
 *   按 requestId 定向应答关联，并发请求互不消费；
 * - sendCommand 自动附加消息身份——requestId（crypto.randomUUID）+ 从 store 读
 *   runId/revision（豁免口径与服务端一致：pause_options/stop/query/new_session/load_session
 *   免 baseRevision；new_session 无 runId；load_session 的 runId 是命令参数不盖身份）；
 *   未连接（transport.send 返回 false）立即 reject；
 * - handleMessage 路由：result/error → pending；snapshot/transition → store.dispatch
 *   （needsResync 时自动补发 snapshot query 跳号恢复）；流式七种 → store.dispatch（身份槽）
 *   + 身份匹配才 onStreaming 直通 view。
 *
 * 纯 ESM、零 DOM、零 socket 构造（node:test 可直接 import；契约测试有源码断言守护）——
 * 发送能力全部来自装配注入的 transport。
 */

/** 命令类型 → 允许字段白名单（与服务端 schema 的 .strict() 分支对称；身份字段由 sendCommand 附加）。 */
const COMMAND_FIELDS = {
  player_input: ["text"],
  continue: [],
  rollback: ["targetSeq"],
  rollback_and_continue: ["targetSeq"],
  edit_result: ["text"],
  new_session: ["worldSetId"],
  load_session: ["runId"],
  pause_options: ["options"],
  stop: ["activationId"],
  query: ["query"],
};

/** 免 baseRevision 的命令（非 mutation 或自有语义，与 contracts/protocol.ts 注释口径一致）。 */
const NO_BASE_REVISION = new Set(["pause_options", "stop", "query", "new_session", "load_session"]);
/** 免 runId 身份的命令（new_session 尚无会话；load_session 的 runId 是目标存档参数）。 */
const NO_RUN_IDENTITY = new Set(["new_session", "load_session"]);

/** 下行流式消息类型（身份由 store 槽校验，本体直通 onStreaming）。 */
const STREAMING_TYPES = new Set([
  "agent_start",
  "delta",
  "reasoning",
  "agent_end",
  "retry",
  "decision",
  "adjudication",
]);

/**
 * 唯一命令构造出口：未知命令类型或白名单外字段立即抛错（前端侧尽早暴露协议漂移）。
 * @param {string} type 命令类型（COMMAND_FIELDS 的键）
 * @param {object} [fields] 命令字段（仅限白名单内）
 * @returns {object} 可序列化的命令对象
 */
export function buildCommand(type, fields = {}) {
  const allowed = COMMAND_FIELDS[type];
  if (!allowed) {
    throw new Error(`未知命令类型: ${type}`);
  }
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) {
      throw new Error(`命令 ${type} 不支持字段: ${key}`);
    }
  }
  return { type, ...fields };
}

/** 命令对象 → WS 文本帧。 */
export function serialize(cmd) {
  return JSON.stringify(cmd);
}

/**
 * 协议实例工厂：transport（发送）× store（消息身份与权威状态）× onStreaming（view 直通）。
 * @param {object} deps
 * @param {{send: (text: string) => boolean}} deps.transport session-transport 实例
 * @param {{getState: () => object, dispatch: (msg: object) => void}} deps.store session-store 实例
 * @param {(msg: object) => void} [deps.onStreaming] 流式七种（已过 runId + activationId 身份校验）
 * @param {(msg: object) => void} [deps.onUncorrelated] 无关联 command_error（协议错误等）兜底
 */
export function createProtocol({ transport, store, onStreaming, onUncorrelated }) {
  /** 在途请求（requestId → {resolve, reject, command}；handleMessage 按 requestId 收口）。 */
  const pending = new Map();

  /**
   * 发送命令（自动附加 requestId/runId/baseRevision 消息身份；未连接立即 reject）。
   * @param {string} type 命令类型
   * @param {object} [fields] 命令字段（白名单内）
   * @returns {Promise<object>} command_result；command_error → reject（err.code/err.details）
   */
  function sendCommand(type, fields = {}) {
    const cmd = buildCommand(type, fields);
    cmd.requestId = crypto.randomUUID();
    const { runId, revision } = store.getState();
    if (!NO_RUN_IDENTITY.has(type) && runId !== null) cmd.runId = runId;
    if (!NO_BASE_REVISION.has(type)) cmd.baseRevision = revision;
    return new Promise((resolve, reject) => {
      pending.set(cmd.requestId, { resolve, reject, command: type });
      let sent = false;
      try {
        sent = transport.send(serialize(cmd)) === true;
      } catch {
        sent = false;
      }
      if (!sent) {
        pending.delete(cmd.requestId);
        reject(new Error("WS 未连接"));
      }
    });
  }

  /**
   * 下行消息唯一入口（transport.onMessage 解析 JSON 后喂入）：
   * command_result/command_error → pending 关联；snapshot/transition → store；
   * 流式 → store 身份槽 + （身份匹配才）onStreaming。
   */
  function handleMessage(msg) {
    if (msg === null || typeof msg !== "object") return;
    switch (msg.type) {
      case "command_result":
      case "command_error": {
        const id = msg.requestId;
        if (typeof id !== "string" || !pending.has(id)) {
          // 无关联错误（协议错误等；已关联的由 sendCommand Promise 的 catch 处理）
          if (msg.type === "command_error") onUncorrelated?.(msg);
          return;
        }
        const entry = pending.get(id);
        pending.delete(id);
        if (msg.type === "command_error") {
          const err = new Error(msg.message ?? "命令失败");
          err.code = msg.code;
          err.details = msg.details;
          entry.reject(err);
        } else {
          entry.resolve(msg);
        }
        return;
      }
      case "snapshot":
        // query 应答同样只进 store（不再单独 resolve——快照即权威，调用方读 store 拿新鲜数据）
        store.dispatch(msg);
        return;
      case "transition":
        store.dispatch(msg);
        if (store.getState().needsResync) {
          // 跳号恢复：整体重同步（query 免 baseRevision；应答 snapshot 到达即清 needsResync）
          sendCommand("query", { query: "snapshot" }).catch(() => {});
        }
        return;
      default:
        if (STREAMING_TYPES.has(msg.type)) {
          const before = store.getState().streaming;
          store.dispatch(msg);
          const after = store.getState().streaming;
          const accepted =
            msg.type === "agent_start"
              ? after !== null && after.activationId === msg.activationId
              : before !== null && before.activationId === msg.activationId;
          if (accepted) onStreaming?.(msg);
        }
        return;
    }
  }

  return { pending, sendCommand, handleMessage };
}
