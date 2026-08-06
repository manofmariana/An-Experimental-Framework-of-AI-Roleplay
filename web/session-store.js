/**
 * 会话状态 store：
 * 服务端权威状态的唯一前端持有者——runId/revision/连接态/快照三域（world/characters/events）/
 * 历史回显/流水线/当前流式槽。其余两类（transient UI 态、view 局部态）仍归 play.js。
 *
 * 纯 reducer、零 DOM 零网络（node:test 可直接 import；本文件禁出现 DOM/存储/socket 全局，
 * 测试有源码断言守护——「连接/发送」归 session-transport，「命令应答关联」归 protocol）。
 *
 * state 形状终稿：
 *   runId: string|null          当前会话身份（snapshot 建立；null = 尚无会话）
 *   revision: number            已同步到的 revision（transition 连续性以它为准）
 *   connection: string          "connecting" | "open" | "closed"（transport 内部消息上报）
 *   world: object|null          快照/transition 维护的 world 变量树（transition 恒整换）
 *   characters: object          CID → 角色视图（transition 逐 CID 并集，null 值 = 删除）
 *   events: array               事件数组（append / 按 seq 截断）
 *   history: object|null        历史回显载荷（historyPatch v1 恒 replace）
 *   pipeline: {seq, phase, interrupted, kind, pending_incident}  流水线视图（snapshot/transition 携带）
 *   streaming: null | {activationId, agent, turn, title}  当前接受的流式槽
 *   needsResync: boolean        跳号置位（protocol 据此自动补发 snapshot query；快照到达清）
 *
 * dispatch 身份纪律：
 * - snapshot：整体替换 + runId 变化信号（meta.runIdChanged，通知里才携带）；
 * - transition：仅 runId 匹配且 fromRevision === state.revision 才应用，否则置 needsResync
 *   （与 D2 语义一致，只是收口到 store）；
 * - 流式七种：仅 runId + activationId 匹配才进 streaming 槽（agent_start 置位、agent_end 清空），
 *   消息本体（delta 文本等）不进 store——经 protocol 的 onStreaming 回调直通 view；
 * - command_result / command_error：不进 store（protocol 的 pending Map 消化）。
 */

export const CONNECTION = { CONNECTING: "connecting", OPEN: "open", CLOSED: "closed" };

/**
 * busy 推导（D4 锁语义的单一出口，单测钉死）：
 * busy = 流式在途（streaming 槽非空）|| 流水线不在玩家输入位（phase !== "await_player"）
 *        || 突发评估挂起（pending_incident——phase 是盲的，await_player 为假相位）。
 * 用途 = 输入权限（canInputNow）；按钮类闸（继续/停止/直接编辑/重 roll/编辑模态）按
 * streaming 槽单独判定（暂停点 busy=true 但须可点，见 play.js 头注）。
 * 收敛效果：transition 到达即清 busy 的中段瞬闪消除——步间 phase 仍非 await_player。
 */
export function selectBusy(state) {
  return (
    state.streaming !== null ||
    state.pipeline.phase !== "await_player" ||
    state.pipeline.pending_incident === true
  );
}

const STREAMING_TYPES = new Set([
  "agent_start",
  "delta",
  "reasoning",
  "agent_end",
  "retry",
  "decision",
  "adjudication",
]);

function initialState() {
  return {
    runId: null,
    revision: 0,
    connection: CONNECTION.CLOSED,
    world: null,
    characters: {},
    events: [],
    history: null,
    pipeline: { seq: 0, phase: "await_player", interrupted: false, kind: null, pending_incident: false },
    streaming: null,
    needsResync: false,
  };
}

/**
 * @returns {{ getState: () => object, dispatch: (msg: object) => void,
 *             subscribe: (fn: (state: object, meta: object) => void) => () => void }}
 * subscribe 返回退订函数；meta = {type, runIdChanged?}（runIdChanged 仅 snapshot 换 run 时 true）。
 */
export function createSessionStore() {
  let state = initialState();
  const listeners = new Set();

  function emit(meta) {
    for (const fn of listeners) fn(state, meta);
  }

  function applySnapshot(msg) {
    const runIdChanged = state.runId !== null && state.runId !== msg.runId;
    state = {
      ...initialState(),
      connection: state.connection, // 连接态归 transport 上报，快照不碰
      runId: msg.runId,
      revision: msg.revision,
      world: msg.state?.world ?? null,
      characters: msg.state?.characters ?? {},
      events: msg.events ?? [],
      history: msg.history ?? null,
      pipeline: msg.pipeline ?? initialState().pipeline,
      // streaming 恒清空、needsResync 恒清（快照即权威）
    };
    emit({ type: "snapshot", runIdChanged });
  }

  function applyTransition(msg) {
    if (state.runId === null) return; // 尚无身份（快照未到）→ 丢弃
    if (msg.runId !== state.runId) return; // 旧 run 晚到 → 丢弃
    if (msg.fromRevision !== state.revision) {
      state = { ...state, needsResync: true }; // 跳号：protocol 自动补 query snapshot
      emit({ type: "transition" });
      return;
    }
    const changed = msg.changed ?? {};
    let { world, characters, events, history } = state;
    if (changed.world !== undefined) world = changed.world;
    if (changed.characters !== undefined) {
      const next = { ...characters };
      for (const [cid, view] of Object.entries(changed.characters)) {
        if (view === null) delete next[cid];
        else next[cid] = view;
      }
      characters = next;
    }
    if (changed.truncateEventsAfterSeq !== undefined) {
      events = events.filter((e) => e.seq <= changed.truncateEventsAfterSeq);
    }
    if (changed.appendedEvents !== undefined) events = [...events, ...changed.appendedEvents];
    if (changed.historyPatch !== undefined) history = changed.historyPatch.history;
    state = {
      ...state,
      revision: msg.revision,
      world,
      characters,
      events,
      history,
      pipeline: msg.pipeline ?? state.pipeline,
    };
    emit({ type: "transition", changed });
  }

  function applyStreaming(msg) {
    if (msg.runId !== state.runId) return;
    if (msg.type === "agent_start") {
      state = {
        ...state,
        streaming: {
          activationId: msg.activationId,
          agent: msg.agent,
          turn: msg.turn ?? 0,
          title: msg.title ?? "",
        },
      };
      emit({ type: "streaming" });
      return;
    }
    if (state.streaming === null || msg.activationId !== state.streaming.activationId) return;
    if (msg.type === "agent_end") {
      state = { ...state, streaming: null };
      emit({ type: "streaming" });
    }
    // delta/reasoning/retry/decision/adjudication 只校验身份，槽不变（本体走 onStreaming）
  }

  function dispatch(msg) {
    if (msg === null || typeof msg !== "object") return;
    switch (msg.type) {
      case "snapshot":
        applySnapshot(msg);
        break;
      case "transition":
        applyTransition(msg);
        break;
      case "connection": // transport 内部消息：{type:"connection", status: CONNECTION.*}
        state = { ...state, connection: msg.status };
        emit({ type: "connection" });
        break;
      default:
        if (STREAMING_TYPES.has(msg.type)) applyStreaming(msg);
        break;
    }
  }

  return {
    getState: () => state,
    dispatch,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
