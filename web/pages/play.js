/**
 * 游玩页编排层：store ← transport → protocol 装配 + store 订阅重渲 +
 * 权限/按钮闸 + 会话 modal 统一生命周期；三块输入/标记/暂停选项归 views/play-input.js，
 * 流式卡片/panels/历史回显归 views/play-stream.js，直编 modal 归 views/state-editor.js。
 *
 * 状态所有权：
 * ① 服务端权威状态 = web/session-store.js（runId/revision/连接态/world/characters/events/
 *    history/pipeline/streaming 槽/needsResync）——本页只读（S()），经 subscribe 重渲；
 * ② transient UI 态 = views/play-input.js（markers 草稿 / knownChars / 三块输入 / pauseState），
 *    本模块只留 sideView / canInputNow——reset 规则表：
 *      runId 变化（snapshot 信号）：inputView.resetTransient()、scrollPinned 钉底、
 *        会话 modal 统一关闭（closeSessionModals）；
 *      任意 snapshot/transition：canInputNow 由 updatePermission 按 store 重算；
 *      保留不 reset：sideView（用户视图选择）、pauseState（localStorage 跨会话持久化）；
 * ③ view 局部态 = views/play-stream.js（streamEl/panels/scrollPinned）+ 本模块 DOM 引用
 *    （runIdEl/sideOut/按钮等）——renderPlay 建立，不随会话 reset。
 *
 * busy 语义：
 * - 输入权限 = !selectBusy(store)（streaming 在途 || phase !== await_player || 突发评估挂起即禁用）；
 *   步间（agent_end → 下一 agent_start → transition）phase 仍非 await_player → 不再瞬闪；
 * - 按钮类闸按 streaming 槽单独判定（暂停点 busy=true 但必须可操作）：
 *   继续 = streaming===null && !interrupted && (phase!==await_player || 突发评估挂起)；
 *   停止 = streaming!==null；直接编辑 = streaming===null 且有会话；
 *   重 roll / 编辑模态可点 = streaming===null 且 seq 匹配 pipeline 当前步。
 *
 * WS 上行协议以 src/contracts/protocol.ts（ClientCommandSchema）为唯一权威；
 * 本页所有发送经 protocol.sendCommand（自动附加 requestId/runId/baseRevision 消息身份，
 * 从 store 读取；Promise 按 requestId 关联应答；未连接立即 reject 并显示错误行）。
 * 跳号恢复：store 置 needsResync → protocol 自动 query snapshot 整体替换。
 *
 * 竞态收口（守卫纯逻辑在 web/async-guards.js）：
 * - CID 请求（竞态 2）：play-input 的 refreshCids 捕获 {runId, worldSetId}，晚到核验后弃写；
 * - 读档导航（竞态 3）：导出走 async-guards.loadSessionThenNavigate（sendSessionCommand 注入），
 *   command_result 成功才 navigate；new_session 在页内不导航，失败经 sendCmd 错误行可见；
 * - 会话 modal（竞态 4）：trackModal 统一注册，runId 变化 closeSessionModals 全部关闭
 *   （挂 document.body 的也不例外）；modal 内部 await 后 isModalLive 核验兜底。
 */
import { api, el } from "../app.js";
import { createProtocol } from "../protocol.js";
import { CONNECTION, createSessionStore, selectBusy } from "../session-store.js";
import { createSessionTransport } from "../session-transport.js";
import { createPlayInput } from "../views/play-input.js";
import { createPlayStream } from "../views/play-stream.js";
import { openStateEditor } from "../views/state-editor.js";

// ---------------------------------------------------------------------------
// 装配：store ← transport → protocol；transport 独占 socket，protocol 路由下行。
// ---------------------------------------------------------------------------

const sessionStore = createSessionStore();
/** store 只读快捷方式（本页一切服务端权威状态的唯一读取口）。 */
const S = () => sessionStore.getState();

const transport = createSessionTransport({
  WebSocketImpl: WebSocket,
  url: () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
  onMessage: (text) => {
    try {
      protocol.handleMessage(JSON.parse(text));
    } catch {
      /* 非法 JSON 帧：无落点，丢弃 */
    }
  },
  onStatus: (status) => {
    sessionStore.dispatch({ type: "connection", status });
    if (status === CONNECTION.OPEN) {
      // 重连/首连：已有会话身份时主动拉一致快照（不依赖服务端推送）；
      // 无身份时靠服务端 onConnect 单播（query 会触发服务端自动建会话，不能盲发）。
      if (S().runId !== null) protocol.sendCommand("query", { query: "snapshot" }).catch(() => {});
      sendPauseOptions(); // 重连后重发暂停选项（服务端为内存态）
    }
  },
});

const protocol = createProtocol({
  transport,
  store: sessionStore,
  onStreaming: (msg) => streamView.onStreaming(msg),
  onUncorrelated: (msg) => {
    streamView.appendLine("line-error", `[错误] ${msg.message}`);
  },
});

// ---------------------------------------------------------------------------
// 会话绑定 modal 统一生命周期：trackModal 注册 → runId 变化统一关闭。
// ---------------------------------------------------------------------------

/** 存活 modal 的 close 函数集（close = remove + 注销，幂等）。 */
const modalClosers = new Set();

/** 注册会话绑定 modal，返回 close（remove + 注销）；挂 document.body 的也必须经此注册。 */
function trackModal(overlay) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    modalClosers.delete(close);
    overlay.remove();
  };
  modalClosers.add(close);
  return close;
}

/** runId 变化信号 → 关闭全部存活会话 modal（迟到响应因 isConnected=false 弃写）。 */
function closeSessionModals() {
  for (const close of [...modalClosers]) close();
}

// ---------------------------------------------------------------------------
// view 装配：play-stream（流区）/ play-input（输入区）；state-editor 按需 open。
// ---------------------------------------------------------------------------

/** WS 发送收口：默认失败处理 = 错误行 + 权限重算（未连接由 protocol 立即 reject "WS 未连接"——
 *  取代旧的静默不执行）。需要精确成败处理的调用方（edit_result）直接用 protocol.sendCommand。 */
function sendCmd(type, fields) {
  const p = protocol.sendCommand(type, fields);
  p.catch((err) => {
    streamView.appendLine("line-error", `[错误] ${err.message}`);
    updatePermission();
  });
  return p;
}

const streamView = createPlayStream({
  el,
  api,
  getState: S,
  sendCmd,
  sendCommand: (type, fields) => protocol.sendCommand(type, fields),
  trackModal,
  confirm: (msg) => window.confirm(msg),
});

const inputView = createPlayInput({
  el,
  api,
  // CID 数据源身份：store runId + 世界包选择器当前值（worldSel 在 renderPlay 建立）
  getCharsIdentity: () => ({ runId: S().runId, worldSetId: worldSel?.value ?? "" }),
  onInputChange: () => refreshSend(),
  onEnter: () => doSend(),
  onPauseChanged: () => sendPauseOptions(),
});

// ---------------------------------------------------------------------------
// 编排层模块态（view 局部态 DOM 引用 + 两个保留的 transient 位）
// ---------------------------------------------------------------------------

let sendBtn = null;
let runIdEl = null;
let sideOut = null;
let continueBtn = null;
let stopBtn = null;
let phaseHint = null;
let worldSel = null;
/** 输入权限快照（selectBusy/pipeline 驱动，updatePermission 维护） */
let canInputNow = true;
/** 状态栏"编辑"按钮（updatePermission 维护禁用态） */
let editStateBtn = null;
/** 侧栏当前视图（state=状态 / events=事件）；推送到达时仅重渲匹配视图；runId 变化保留 */
let sideView = "events";

// ---------------------------------------------------------------------------
// 状态面板 timer 结构化显示（移植自 src/vars/systemWorld.ts 的 minutesToWorldTime：
// y 0 基、m/d 1 基，30 日/月、12 月/年历法，每年 12 月承接 30 日月制余下的 5 天）——只改显示层，数据源不变
// ---------------------------------------------------------------------------

function minutesToWorldTime(totalMinutes) {
  let value = Math.max(0, Math.floor(totalMinutes));
  const min = value % 60; value = Math.floor(value / 60);
  const h = value % 24; value = Math.floor(value / 24);
  const y = Math.floor(value / 365);
  const dayOfYear = value % 365;
  const m = Math.min(12, Math.floor(dayOfYear / 30) + 1);
  const d = dayOfYear - (m - 1) * 30 + 1;
  return { y, m, d, h, min };
}

const pad2 = (n) => String(n).padStart(2, "0");

/** 角色 timer 显示：null 且单人组（group=0）→ 已离开待结算；其余 null → 无计时器；数值 → 结构化世界时间。 */
function formatTimerForPanel(timer, group) {
  if (timer === null || timer === undefined) return group === 0 ? "已离开待结算" : "无计时器";
  if (typeof timer !== "number") return timer;
  const t = minutesToWorldTime(timer);
  return `${t.y}年${t.m}月${t.d}日 ${pad2(t.h)}:${pad2(t.min)}`;
}

/** 状态面板渲染副本：各角色 timer 替换为结构化显示（其余字段原样 JSON）。 */
function formatStateForPanel(data) {
  const clone = JSON.parse(JSON.stringify(data ?? {}));
  for (const c of Object.values(clone.characters ?? {})) {
    if (c && typeof c === "object" && "timer" in c) c.timer = formatTimerForPanel(c.timer, c.group);
  }
  return JSON.stringify(clone, null, 2);
}

/** 按当前侧栏视图渲染 store 数据（会话未建立则保留占位提示；推送/页签切换共用）。 */
function renderSidePanel() {
  if (!sideOut) return;
  if (S().runId === null) {
    sideOut.textContent = "（数据未到——等待服务端推送）";
    return;
  }
  if (sideView === "state") {
    sideOut.textContent = formatStateForPanel({ world: S().world, characters: S().characters });
  } else {
    sideOut.textContent = JSON.stringify(S().events, null, 2);
  }
}

// ---------------------------------------------------------------------------
// store 订阅 → 重渲：snapshot/transition 进 store，
// command_result/error 由 protocol pending 消化，流式经 protocol.onStreaming 直通。
// ---------------------------------------------------------------------------

/** store 变化 → 侧栏/权限/runId 行重渲；snapshot 整段重渲历史 + transient reset（规则表见头注）。 */
function onStoreChange(state, meta) {
  if (!streamView.isMounted()) return; // 模块加载早于 renderPlay 的极端时序：DOM 未建，等下次变化
  if (meta.type === "snapshot") {
    if (meta.runIdChanged) {
      // runId 变化信号 → transient 统一 reset + 会话 modal 统一关闭（保留 sideView/pauseState）
      inputView.resetTransient();
      closeSessionModals();
    }
    runIdEl.textContent = `会话：${state.runId}`;
    streamView.clearStream(); // 全量替换：清流区后按历史重渲
    if (meta.runIdChanged) streamView.appendLine("line-info", `已载入会话（${state.runId}）`);
    if (state.history) streamView.renderHistory(state.history);
    renderSidePanel();
    updatePermission();
    refreshSend(); // reset 清空输入不触发 oninput，手动重算发送按钮
    inputView.refreshCids();
    sendPauseOptions(); // 会话开始/恢复：重发本地持久化的暂停选项
    return;
  }
  if (meta.type === "transition") {
    renderSidePanel();
    const changed = meta.changed ?? {};
    if (changed.historyPatch) {
      // historyPatch v1 恒 replace：整段重渲（流式卡随步提交归位为历史卡）
      streamView.clearStream();
      streamView.renderHistory(changed.historyPatch.history);
    }
    if (changed.editedResult) streamView.onEditedResult(changed.editedResult);
    updatePermission();
    return;
  }
  if (meta.type === "streaming") {
    updatePermission(); // 流式槽置位/清空 → 输入闸与按钮闸跟随
    return;
  }
  if (meta.type === "connection") {
    if (state.connection === CONNECTION.CLOSED) streamView.appendLine("line-error", "[连接断开] 自动重连中…");
    updatePermission();
  }
}

// ---------------------------------------------------------------------------
// 权限/发送/暂停选项（编排层）
// ---------------------------------------------------------------------------

function refreshSend() {
  if (!sendBtn) return;
  sendBtn.disabled = !canInputNow || inputView.buildPayload() === null;
}

function updatePermission() {
  if (!streamView.isMounted()) return;
  const state = S();
  const busy = selectBusy(state); // 输入权限闸（头注「busy 语义终稿」：流式在途 || 非玩家位）
  const streaming = state.streaming !== null; // 按钮类闸（暂停点 busy=true 但须可继续/可编辑）
  canInputNow = !busy;
  inputView.setEnabled(canInputNow);
  refreshSend();
  if (continueBtn) {
    // 突发评估挂起时 phase 是盲的（await_player 为假相位）：同样显示「继续」先结算
    continueBtn.style.display =
      !streaming &&
      !state.pipeline.interrupted &&
      (state.pipeline.phase !== "await_player" || state.pipeline.pending_incident === true)
        ? ""
        : "none";
  }
  if (editStateBtn) {
    // 直接编辑空闲闸：LLM 在途（流式槽）或无会话禁用；暂停点可用
    editStateBtn.disabled = streaming || state.runId === null;
  }
  if (stopBtn) stopBtn.style.display = streaming ? "" : "none";
  if (phaseHint) {
    phaseHint.textContent = streaming
      ? ""
      : state.pipeline.interrupted
        ? "当前步已被停止：编辑补全或回滚后继续"
        : state.pipeline.pending_incident === true
          ? "突发事件判定中：请继续"
          : state.pipeline.phase !== "await_player"
            ? "世界进行中，可继续或回滚"
            : "";
  }
}

/** 下发当前暂停选项（auto 勾选 = 全 false = 自动继续；camelCase 直发，协议权威 = contracts/protocol.ts）。 */
function sendPauseOptions() {
  sendCmd("pause_options", { options: inputView.pauseOptionsPayload() });
}

function send(text) {
  sendCmd("player_input", { text });
}

const doSend = () => {
  const text = inputView.buildPayload();
  if (text === null) return;
  streamView.appendSelfCard(text);
  send(text);
  inputView.clearAfterSend();
  refreshSend();
};

/** 供会话页调用的原始命令通道：load_session 应答 promise 按 requestId 精确关联，
 *  成功才导航；未连接立即 reject。 */
export function sendSessionCommand(type, fields) {
  return protocol.sendCommand(type, fields);
}

// 装配收尾：store 订阅 → 重渲；transport 建立首个连接（自动重连由 transport 内部退避负责）。
sessionStore.subscribe(onStoreChange);
transport.connect();

export function renderPlay() {
  const root = el("div");
  root.id = "play";

  // 顶栏
  const topbar = el("div", "topbar");
  const newBtn = el("button", "act", "新会话");
  // 世界设定集选择（data/assets/*；只有一套时默认选中）
  worldSel = el("select");
  worldSel.title = "世界设定集（新会话生效）";
  worldSel.onchange = () => inputView.refreshCids();
  api("/api/worlds")
    .then(({ sets }) => {
      for (const s of sets) {
        const opt = el("option", null, s);
        opt.value = s;
        worldSel.appendChild(opt);
      }
      inputView.refreshCids();
    })
    .catch(() => {});
  newBtn.onclick = () => {
    // 未连接/失败由 sendCmd 错误行可见（取代旧的静默不执行）；状态重置等 snapshot 广播回流
    sendCmd("new_session", { worldSetId: worldSel.value || undefined });
  };
  runIdEl = el("span", "muted", "会话：（未开始，首次输入自动创建）");
  topbar.append(worldSel, newBtn, runIdEl);

  // 主区：流（view）+ 右侧面板
  const main = el("div", "main");
  const stream = streamView.mount();

  const sidepanel = el("div");
  sidepanel.id = "sidepanel";
  const btns = el("div", "btns");
  for (const [cmd, label] of [["state", "状态"], ["events", "事件"]]) {
    const b = el("button", "act", label);
    b.onclick = () => {
      sideView = cmd; // 切换视图：先用缓存立即渲染，再发一致快照查询兜底（缓存未到时由应答重渲）
      renderSidePanel();
      sendCmd("query", { query: "snapshot" });
    };
    btns.appendChild(b);
  }
  editStateBtn = el("button", "act", "编辑");
  editStateBtn.disabled = true;
  editStateBtn.title = "直接编辑真相层（变量 + 事件）；LLM 运行中不可用";
  editStateBtn.onclick = () =>
    void openStateEditor({
      el,
      api,
      getState: S,
      trackModal,
      mountModal: (overlay) => document.body.appendChild(overlay),
      notifyError: (text) => streamView.appendLine("line-error", text),
      confirm: (msg) => window.confirm(msg),
    }).catch((err) => streamView.appendLine("line-error", `[错误] ${err.message}`));
  btns.appendChild(editStateBtn);
  sideOut = el("pre", null, "（事件数据未到——等待服务端推送）");
  sidepanel.append(btns, sideOut);
  main.append(stream, sidepanel);

  // 输入区（view：三块输入 + 标记 + 暂停选项）+ 输入行（停止 / 继续 / 发送，编排层）
  const inputArea = inputView.mount();
  const bar = el("div");
  bar.id = "inputbar";
  stopBtn = el("button", "act danger", "停止");
  stopBtn.style.display = "none";
  stopBtn.title = "中止当前生成，冻结为可编辑状态";
  stopBtn.onclick = () =>
    sendCmd("stop", S().streaming !== null ? { activationId: S().streaming.activationId } : {});
  continueBtn = el("button", "act", "继续");
  continueBtn.style.display = "none";
  continueBtn.title = "按当前进度继续（角色 → GM → 正文）";
  continueBtn.onclick = () => {
    continueBtn.style.display = "none"; // 乐观收起：失败由 sendCmd catch → updatePermission 恢复
    sendCmd("continue");
  };
  sendBtn = el("button", "act", "发送");
  sendBtn.onclick = doSend;
  bar.append(stopBtn, continueBtn, sendBtn);
  inputArea.appendChild(bar);
  phaseHint = el("div", "muted");

  root.append(topbar, main, inputArea, phaseHint);
  return root;
}
