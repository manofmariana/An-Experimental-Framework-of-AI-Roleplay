/**
 * 游玩页：玩家输入卡 + 三个 agent 同构卡片（角色决策 / GM 裁决 / 正文）。
 * 每张 agent 卡片头部右上角按钮：思维链 / 原始返回 / 提示词 + 回滚 / 重 roll / 编辑（B 步）。
 * 暂停态：phase ≠ await_player 时输入禁用，可继续（interrupted 时须编辑或回滚）。
 * 暂停选项：自动继续（默认）/ 每轮暂停 / GM 前 / GM 后 / 正文后——localStorage 持久化，
 * 会话开始/恢复时自动重发 pause_options。
 * 本页 DOM 常驻（app.js 不销毁），WS 在模块加载时建立。
 *
 * WS 协议（JSDoc 注释版，拷贝自 src/server/ws-protocol.ts）：
 *   下行：agent_start{agent,title} / delta{agent,text} / reasoning{agent,text}
 *         / agent_end{agent} / summary{agent,text} / retry{agent,attempt,reason}
 *         / decision{agent,pkg} / adjudication{agent,pkg} / turn_done
 *         / pipeline{seq,phase,interrupted,kind} / edit_done{kind,result}
 *         / state{data} / events{data} / stats{data}
 *         / session_started{runId} / history{history,replace?} / error{message}
 *   上行：input{text} / command{command} / new_session{world_set?} / load_session{runId}
 *         / rollback{seq} / reroll{seq} / continue / stop / edit_result{text}
 *         / pause_options{every_step,before_gm,after_gm,after_prose}
 */
import { api, el } from "../app.js";

let ws = null;
let streamEl = null;
let sendBtn = null;
let runIdEl = null;
let sideOut = null;
let continueBtn = null;
let stopBtn = null;
let phaseHint = null;
let worldSel = null;
/** 三块输入：台词（可空）/ 行动（可空）/ 内心含意图（必填）；台词与行动至少填一个 */
let blockEls = null;
/** 待发标记（DecisionPackage.markers；即抛指令位，发送后清空） */
let markers = [];
let markerChipsEl = null;
let markerFormEl = null;
/** 会话角色列表（标记 CID 下拉数据源；不含 C0 玩家自己） */
let knownChars = [];
/** 输入权限快照（busy/pipeline 驱动，updatePermission 维护） */
let canInputNow = true;

let currentRunId = null;
let currentTurn = 0;

/** 流水线状态（pipeline 消息驱动：输入权限/继续按钮/暂停态） */
let pipe = { seq: 0, phase: "await_player", interrupted: false, kind: null };
/** 流式进行中（agent_start → turn_done/error/stop） */
let busy = false;
/** LLM 调用在途计数（agent_start/agent_end 维护；直接编辑按钮空闲闸） */
let inflight = 0;
/** WS state/events 推送的最新真相层数据（直接编辑模态预填数据源；服务端逐轮广播保持新鲜） */
let latestState = null;
let latestEvents = null;
/** 状态栏"编辑"按钮（updatePermission 维护禁用态） */
let editStateBtn = null;
/** 侧栏当前视图（state=状态 / events=事件）；推送到达时仅重渲匹配视图 */
let sideView = "events";
/** 编辑按钮按下时数据未备：先发 state/events 查询，到齐后由 onMessage 自动开模态 */
let pendingStateEditOpen = false;

/** 当前流式卡片：角色按 agent/CID 分轨，避免同轮多角色互相覆盖。 */
const panels = new Map();

const BADGE = { character: "【角色】", gm: "【GM】", prose: "【正文】" };

function agentKind(agent) {
  return agent === "gm" ? "gm" : agent === "prose" ? "prose" : "character";
}

function panelKey(agent) {
  return agentKind(agent) === "character" ? agent : agentKind(agent);
}

function characterTitle(agent, fallback = "决策") {
  const cid = agent.startsWith("character:") ? agent.slice("character:".length) : agent;
  return `${fallback} · ${cid}`;
}

function agentSlug(agent) {
  return agent.replace(/[^\w-]/g, "-");
}

/** 正文指称占位符渲染：[[称呼|@CID]] → 称呼（镜像 src/truth/identity.ts 的 REF 正则，容忍缺 @）。 */
const renderRefs = (text) => text.replace(/\[\[([^\]|]+)\|@?C\d+\]\]/g, "$1");

// ---------------------------------------------------------------------------
// 状态面板 timer 结构化显示（移植自 src/truth/timeStore.ts 的 minutesToWorldTime：
// 30 日/月、12 月/年历法，每年 12 月承接 30 日月制余下的 5 天）——只改显示层，数据源不变
// ---------------------------------------------------------------------------

function minutesToWorldTime(totalMinutes) {
  let value = Math.max(0, Math.floor(totalMinutes));
  const min = value % 60; value = Math.floor(value / 60);
  const h = value % 24; value = Math.floor(value / 24);
  const y = Math.floor(value / 365) + 1;
  const dayOfYear = value % 365;
  const m = Math.min(12, Math.floor(dayOfYear / 30) + 1);
  const d = dayOfYear - (m - 1) * 30 + 1;
  return { y, m, d, h, min };
}

const pad2 = (n) => String(n).padStart(2, "0");

/** 角色 timer 显示：null → 无计时器；≥ MAX_SAFE_INTEGER → 已离开待结算；其余 → 结构化世界时间。 */
function formatTimerForPanel(timer) {
  if (timer === null || timer === undefined) return "无计时器";
  if (typeof timer !== "number") return timer;
  if (timer >= Number.MAX_SAFE_INTEGER) return "已离开待结算";
  const t = minutesToWorldTime(timer);
  return `${t.y}年${t.m}月${t.d}日 ${pad2(t.h)}:${pad2(t.min)}`;
}

/** 状态面板渲染副本：各角色 timer 替换为结构化显示（其余字段原样 JSON）。 */
function formatStateForPanel(data) {
  const clone = JSON.parse(JSON.stringify(data ?? {}));
  for (const c of Object.values(clone.characters ?? {})) {
    if (c && typeof c === "object" && "timer" in c) c.timer = formatTimerForPanel(c.timer);
  }
  return JSON.stringify(clone, null, 2);
}

/** 按当前侧栏视图渲染缓存（缓存未到则保留占位提示；推送/页签切换共用）。 */
function renderSidePanel() {
  if (!sideOut) return;
  if (sideView === "state") {
    sideOut.textContent = latestState !== null ? formatStateForPanel(latestState) : "（状态数据未到——等待服务端推送）";
  } else {
    sideOut.textContent = latestEvents !== null ? JSON.stringify(latestEvents, null, 2) : "（事件数据未到——等待服务端推送）";
  }
}

/** 钉底状态：近底（40px 内）跟随流式输出，用户上滑后松钉不再拽回 */
let scrollPinned = true;

function scrollToBottom(force = false) {
  if (streamEl && (force || scrollPinned)) streamEl.scrollTop = streamEl.scrollHeight;
}

function appendLine(className, text) {
  const line = el("div", className, text);
  streamEl.appendChild(line);
  scrollToBottom();
  return line;
}

/** 玩家输入卡（简单卡片，无 agent 菜单；seq 可选——历史卡显示 #N 徽标）。
 *  结构化输入（DecisionPackage JSON）按块渲染（无 action 时只显示台词），纯文本原样显示。 */
function playerCard(text, seq) {
  const card = el("div", "player-card");
  card.appendChild(el("span", "player-card-label", "你"));
  const pkg = tryParsePlayerPkg(text);
  if (pkg) {
    const body = el("div", "player-card-blocks");
    if (pkg.dialogue) body.appendChild(el("div", "player-block-line", `「${pkg.dialogue}」`));
    if (pkg.action) body.appendChild(el("div", "player-block-line", pkg.action));
    for (const m of pkg.markers ?? []) body.appendChild(el("span", "marker-chip", markerLabel(m)));
    card.appendChild(body);
  } else {
    card.appendChild(el("span", "player-card-text", text));
  }
  if (seq > 0) card.appendChild(el("span", "seq-badge", `#${seq}`));
  return card;
}

/** 尝试把玩家输入解析为 DecisionPackage（前端仅用于展示，校验以后端 schema 为准）。 */
function tryParsePlayerPkg(text) {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  try {
    const obj = JSON.parse(t);
    return obj !== null && typeof obj === "object" && typeof obj.inner === "string" ? obj : null;
  } catch {
    return null;
  }
}

function markerLabel(m) {
  switch (m.type) {
    case "gm_request": return "GM 请求";
    case "leave": return "离开";
    case "recall": return `召回 ${m.target}`;
    case "contact": return `联系（${m.channel}）${m.targets.join("、")}`;
    case "confirm": return "确认";
    default: return m.type;
  }
}

// ---------------------------------------------------------------------------
// 标记区（M2-b §5.2）：结构化指令位，即抛；GM 请求与离开互斥（UI 层先挡）
// ---------------------------------------------------------------------------

function addMarker(m) {
  if (m.type === "gm_request") markers = markers.filter((x) => x.type !== "leave");
  if (m.type === "leave") markers = markers.filter((x) => x.type !== "gm_request");
  // 单例标记去重（gm_request/leave/confirm 至多各一条）
  if (m.type === "gm_request" || m.type === "leave" || m.type === "confirm") {
    markers = markers.filter((x) => x.type !== m.type);
  }
  markers.push(m);
  renderMarkerChips();
  refreshSend();
}

function renderMarkerChips() {
  if (!markerChipsEl) return;
  markerChipsEl.textContent = "";
  markers.forEach((m, i) => {
    const chip = el("span", "marker-chip", markerLabel(m));
    const x = el("button", "marker-chip-x", "×");
    x.title = "移除标记";
    x.onclick = () => {
      markers.splice(i, 1);
      renderMarkerChips();
      refreshSend();
    };
    chip.appendChild(x);
    markerChipsEl.appendChild(chip);
  });
}

function cidSelect(multiple) {
  const sel = document.createElement("select");
  if (multiple) sel.multiple = true;
  for (const c of knownChars) {
    const opt = el("option", null, `${c.name}（${c.cid}）`);
    opt.value = c.cid;
    sel.appendChild(opt);
  }
  return sel;
}

/** 召回/联系需要参数：在标记行展开小表单，确定后加标记并收起。 */
function openMarkerForm(kind) {
  if (!markerFormEl) return;
  markerFormEl.textContent = "";
  const close = () => { markerFormEl.textContent = ""; };
  if (kind === "recall") {
    const sel = cidSelect(false);
    const ok = el("button", "act marker-btn", "添加");
    ok.onclick = () => {
      if (sel.value) {
        addMarker({ type: "recall", target: sel.value });
        close();
      }
    };
    const cancel = el("button", "act marker-btn", "取消");
    cancel.onclick = close;
    markerFormEl.append(el("span", "muted", "召回目标："), sel, ok, cancel);
  } else if (kind === "contact") {
    const channel = document.createElement("input");
    channel.type = "text";
    channel.placeholder = "途径（如 电话）";
    const sel = cidSelect(true);
    const ok = el("button", "act marker-btn", "添加");
    ok.onclick = () => {
      const targets = [...sel.selectedOptions].map((o) => o.value);
      if (channel.value.trim() && targets.length > 0) {
        addMarker({ type: "contact", channel: channel.value.trim(), targets });
        close();
      }
    };
    const cancel = el("button", "act marker-btn", "取消");
    cancel.onclick = close;
    markerFormEl.append(el("span", "muted", "途径："), channel, el("span", "muted", "对象（可多选）："), sel, ok, cancel);
  }
}

/** 刷新会话角色列表（标记 CID 下拉数据源）：有活跃会话读档内 characters，否则读世界设定集 manifest。 */
async function refreshCids() {
  let list = [];
  try {
    if (currentRunId) {
      const data = await api(`/api/sessions/${currentRunId}/characters`);
      list = Object.entries(data.characters ?? {}).map(([cid, c]) => ({ cid, name: c?.name ?? cid }));
    } else {
      const set = worldSel?.value;
      const data = await api(`/api/characters${set ? `?set=${encodeURIComponent(set)}` : ""}`);
      list = data.map((item) => ({ cid: item.id, name: item.manifest?.name ?? item.id }));
    }
  } catch {
    list = [];
  }
  knownChars = list.filter((c) => c.cid !== "C0");
}

// ---------------------------------------------------------------------------
// 发送载荷：三块输入 → DecisionPackage JSON（内心必填；台词与行动至少其一）
// ---------------------------------------------------------------------------

function buildPayload() {
  if (blockEls === null) return null;
  const dialogue = blockEls.dialogue.value.trim();
  const action = blockEls.action.value.trim();
  const inner = blockEls.inner.value.trim();
  if (!inner) return null; // 内心（含意图）必填
  if (!dialogue && !action) return null; // 台词与行动至少填一个
  const pkg = { inner };
  if (action) pkg.action = action;
  if (dialogue) pkg.dialogue = dialogue;
  if (markers.length > 0) pkg.markers = markers;
  return JSON.stringify(pkg);
}

function refreshSend() {
  if (!sendBtn) return;
  sendBtn.disabled = !canInputNow || buildPayload() === null;
}

// ---------------------------------------------------------------------------
// 暂停选项（取代"默认自动继续"）：localStorage 持久化 + 变更即下发 pause_options。
// 互斥：自动继续/每轮暂停各自排除其余四项/三项；GM 前·GM 后·正文后可自由组合。
// ---------------------------------------------------------------------------

const PAUSE_STORAGE_KEY = "airp-pause-options";
/** 五选项 UI 态（auto 为展示态，不下发；其余四项映射 pause_options 消息字段） */
let pauseState = { auto: true, everyStep: false, beforeGm: false, afterGm: false, afterProse: false };
let pauseCheckboxes = null;

try {
  const saved = JSON.parse(localStorage.getItem(PAUSE_STORAGE_KEY) ?? "null");
  if (saved && typeof saved === "object") pauseState = { ...pauseState, ...saved };
} catch { /* 损坏的本地存储回退默认（自动继续） */ }

function persistPause() {
  localStorage.setItem(PAUSE_STORAGE_KEY, JSON.stringify(pauseState));
}

/** 下发当前暂停选项（auto 勾选 = 全 false = 自动继续）。 */
function sendPauseOptions() {
  sendMsg({
    type: "pause_options",
    every_step: !pauseState.auto && pauseState.everyStep,
    before_gm: !pauseState.auto && pauseState.beforeGm,
    after_gm: !pauseState.auto && pauseState.afterGm,
    after_prose: !pauseState.auto && pauseState.afterProse,
  });
}

function syncPauseCheckboxes() {
  if (!pauseCheckboxes) return;
  for (const [key, box] of Object.entries(pauseCheckboxes)) box.checked = pauseState[key];
}

function onPauseChange(key, checked) {
  pauseState[key] = checked;
  if (key === "auto" && checked) {
    // 勾自动继续：清其余四项
    pauseState.everyStep = pauseState.beforeGm = pauseState.afterGm = pauseState.afterProse = false;
  } else if (key === "everyStep" && checked) {
    // 勾每轮暂停：清自动继续与后三项
    pauseState.auto = pauseState.beforeGm = pauseState.afterGm = pauseState.afterProse = false;
  } else if ((key === "beforeGm" || key === "afterGm" || key === "afterProse") && checked) {
    // 勾后三项任一：清自动继续与每轮暂停
    pauseState.auto = pauseState.everyStep = false;
  } else if (!checked && key !== "auto" &&
    !pauseState.everyStep && !pauseState.beforeGm && !pauseState.afterGm && !pauseState.afterProse) {
    pauseState.auto = true; // 全部取消 → 回到自动继续
  }
  syncPauseCheckboxes();
  persistPause();
  sendPauseOptions();
}

/** 一排勾选：自动继续（默认）/ 每轮暂停 / GM 前 / GM 后 / 正文后。 */
function pauseBar() {
  const bar = el("div", "pause-bar");
  bar.appendChild(el("span", "muted", "暂停："));
  pauseCheckboxes = {};
  for (const [key, label] of [
    ["auto", "自动继续"],
    ["everyStep", "每轮暂停"],
    ["beforeGm", "GM 前"],
    ["afterGm", "GM 后"],
    ["afterProse", "正文后"],
  ]) {
    const wrap = el("label", "pause-opt");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = pauseState[key];
    box.onchange = () => onPauseChange(key, box.checked);
    pauseCheckboxes[key] = box;
    wrap.append(box, document.createTextNode(label));
    bar.appendChild(wrap);
  }
  return bar;
}

// ---------------------------------------------------------------------------
// 结构化卡片（角色决策 / GM 裁决）
// ---------------------------------------------------------------------------

function cardSection(title, contentNode) {
  const sec = el("div", "card-section");
  sec.appendChild(el("div", "card-title", title));
  sec.appendChild(contentNode);
  return sec;
}

function renderDecisionCard(pkg) {
  const card = el("div", "agent-card");
  if (pkg.action) card.appendChild(cardSection("行动", el("div", "card-action", pkg.action)));
  if (pkg.dialogue) card.appendChild(cardSection("台词", el("div", "card-action", pkg.dialogue)));
  if (pkg.inner) {
    card.appendChild(cardSection("内心想法", el("div", "card-mono", pkg.inner)));
  }
  if (pkg.relations?.length) {
    const ul = el("ul", "card-list");
    for (const r of pkg.relations) {
      const parts = [];
      if (r.name) parts.push(`名字：${r.name}`);
      if (r.impression) parts.push(`印象：${r.impression}`);
      ul.appendChild(el("li", null, `${r.target} → ${parts.join(" · ")}`));
    }
    card.appendChild(cardSection("人际关系更新", ul));
  }
  return card;
}

function renderAdjudicationCard(pkg) {
  const card = el("div", "agent-card");
  // 裁决包 v2（M2）：事件数组（事件数 = GM 计划的新组划分）
  for (const ev of pkg.events ?? []) {
    const text = ev.location ? `${ev.text}（@${ev.location}）` : ev.text;
    card.appendChild(cardSection("事件", el("div", "card-action", text)));
  }
  if (pkg.deltas?.length) {
    const ul = el("ul", "card-list mono");
    for (const d of pkg.deltas) ul.appendChild(el("li", null, `${d.path} ${d.op} ${JSON.stringify(d.value)}`));
    card.appendChild(cardSection("变量变更", ul));
  }
  if (pkg.timer?.length) {
    const ul = el("ul", "card-list mono");
    for (const t of pkg.timer) ul.appendChild(el("li", null, `${t.cid} → +${JSON.stringify(t.span)}`));
    card.appendChild(cardSection("计时器", ul));
  }
  if (pkg.location?.length) {
    const ul = el("ul", "card-list");
    for (const l of pkg.location) ul.appendChild(el("li", null, `${l.cid} → ${l.location.name}`));
    card.appendChild(cardSection("地点更新", ul));
  }
  card.appendChild(
    cardSection(
      "meta",
      el("div", "card-meta", `narrativity ${pkg.narrativity} · 事件 ${(pkg.events ?? []).length} 条`),
    ),
  );
  return card;
}

// ---------------------------------------------------------------------------
// 提示词弹层
// ---------------------------------------------------------------------------

async function showPrompts(agent, turn) {
  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal-box");
  const close = el("button", "act", "关闭");
  close.onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  box.appendChild(el("h3", null, `提示词 · 第 ${turn} 轮 · ${agent}`));
  const content = el("div", "modal-content", "（加载中…）");
  box.append(content, close);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  // runId 可能尚未经 session_started 同步（极端时序），从 API 兜底取活跃会话
  let runId = currentRunId;
  try {
    if (!runId) {
      const sessions = await api("/api/sessions");
      runId = sessions.active;
    }
    if (!runId) {
      content.textContent = "读取失败：当前无活跃会话（还没有 runId）。";
      return;
    }
    const path = `/api/sessions/${runId}/llm-recent/${agentSlug(agent)}`;
    try {
      const records = await api(path);
      content.textContent = "";
      // llm-recent 只保留最近 5 轮（滚动窗口）；目标 seq 不在窗内 = 已轮换出窗
      const rec = records.find((r) => r.seq === turn);
      if (!rec) {
        content.textContent = `（第 ${turn} 轮已轮换出窗：llm-recent 只保留最近 5 轮）`;
        return;
      }
      // 提示词模态只显示发送的 messages；思维链只在「思维链」模态出现
      for (const m of rec.messages) {
        content.appendChild(el("div", "prompt-role", `── ${m.role} ──`));
        content.appendChild(el("pre", "prompt-body", m.content));
      }
    } catch (err) {
      content.textContent = `读取失败：GET ${path} → ${err.message}`;
    }
  } catch (err) {
    content.textContent = `读取失败：${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// agent 卡片（三 agent 同构）：头部 = 标题 + 右上角 "..." 菜单
// 菜单项：思维链 / 原始返回 / 提示词 / 编辑（仅 pipeline.current 可点，历史卡不出现）
//        / 回滚 / 重 roll；思维链、原始返回、编辑、提示词均为独立模态窗口。
// tools="full"：流式轮（思维链/原始返回取本地流式缓存，含编辑项）
// tools="prompt"：历史轮（思维链取 llm-recent 滚动窗、原始返回取 archive raw，无编辑项）
// 右下角 #N 徽标 = 该卡 seq。
// ---------------------------------------------------------------------------

function openViewModal(title, text, cls) {
  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal-box");
  const close = el("button", "act", "关闭");
  close.onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  box.appendChild(el("h3", null, title));
  const content = el("div", "modal-content");
  content.appendChild(el("pre", "prompt-body", text || "（无）"));
  if (cls) content.firstChild.classList.add(cls);
  box.append(content, close);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

/** 思维链模态（历史卡）：llm-recent 滚动窗内取 seq，超窗显示"已轮换出窗"。 */
async function showHistoryReasoning(agent, seq, runId) {
  let text;
  try {
    const records = await api(`/api/sessions/${runId}/llm-recent/${agentSlug(agent)}`);
    const rec = records.find((r) => r.seq === seq);
    text = rec ? rec.reasoning || "（该轮无思维链）" : `（第 ${seq} 轮已轮换出窗：llm-recent 只保留最近 5 轮）`;
  } catch (err) {
    text = `读取失败：${err.message}`;
  }
  openViewModal(`思维链 · #${seq} · ${agent}`, text, "reasoning");
}

/** 头部 "..." 菜单。items: [{label, onclick, disabled?, hidden?, when?}]；when() 在每次打开菜单时动态判定可见性 */
function makeMenu(items) {
  const wrap = el("span", "menu-wrap");
  const btn = el("button", "head-btn menu-btn", "…");
  btn.title = "更多操作";
  const menu = el("div", "menu");
  menu.hidden = true;
  const refs = {};
  for (const item of items) {
    const b = el("button", "menu-item", item.label);
    if (item.disabled) b.disabled = true;
    if (item.hidden) b.hidden = true;
    b.onclick = (e) => {
      e.stopPropagation();
      menu.hidden = true;
      item.onclick();
    };
    menu.appendChild(b);
    refs[item.label] = b;
  }
  btn.onclick = (e) => {
    e.stopPropagation();
    const wasHidden = menu.hidden;
    for (const m of document.querySelectorAll(".menu")) m.hidden = true;
    if (wasHidden) {
      // 打开前按当前流水线状态重算动态项（如"重 roll"仅最新步可见）
      for (const item of items) {
        if (item.when) refs[item.label].hidden = !item.when();
      }
    }
    menu.hidden = !wasHidden;
  };
  wrap.append(btn, menu);
  return { wrap, refs };
}

function makeAgentCard(kind, title, agentName, turn, tools = "full", opts = {}) {
  const seq = opts.seq ?? turn;
  const root = el("div", `agent-panel panel-${kind}`);
  // seq+kind → 卡片寻址（edit_done 原地重渲用）
  root.dataset.kind = kind;
  root.dataset.seq = String(seq);
  const head = el("div", "panel-head");
  head.appendChild(el("span", "panel-title", `${BADGE[kind]} ${title}`));

  const state = { root, body: null, reasoningBox: null, rawBox: null, proseBlock: null, kind, agentName };
  root._cardState = state;

  // 流式内容累积进游离节点（不进 DOM；"..." 菜单的模态视图读取）
  state.reasoningBox = el("div", "reasoning");
  state.rawBox = el("div", "json-stream");

  const menuItems = [];
  if (tools === "full") {
    menuItems.push(
      { label: "思维链", onclick: () => openViewModal(`思维链 · #${seq} · ${agentName}`, state.reasoningBox.textContent, "reasoning") },
      { label: "原始返回", onclick: () => openRawModal(kind, seq, agentName, () => state.rawBox.textContent) },
    );
  } else {
    menuItems.push(
      { label: "思维链", onclick: () => showHistoryReasoning(agentName, seq, currentRunId) },
      { label: "原始返回", onclick: () => openRawModal(kind, seq, agentName, () => opts.raw ?? "") },
    );
  }
  if (agentName) {
    menuItems.push({ label: "提示词", onclick: () => showPrompts(agentName, turn) });
  }
  if (seq > 0) {
    menuItems.push({
      label: "回滚",
      onclick: () => {
        if (confirm(`回到第 ${seq} 步之后？其后的内容将全部丢弃。`)) {
          sendMsg({ type: "rollback", seq });
        }
      },
    });
    if (seq > 1) {
      menuItems.push({
        label: "重 roll",
        // 仅最新步可重 roll（动态判定：流水线 seq 会随回滚/续跑变化）
        when: () => !busy && seq === pipe.seq,
        onclick: () => {
          if (confirm(`重 roll 第 ${seq} 步？该步（最新步）的内容将被丢弃并重跑。`)) {
            // 两步走：先回滚到上一步（服务端会广播历史清掉旧卡），再继续重跑
            sendMsg({ type: "rollback", seq: seq - 1 });
            sendMsg({ type: "continue" });
          }
        },
      });
    }
  }
  const { wrap } = makeMenu(menuItems);
  head.appendChild(wrap);
  root.appendChild(head);

  state.body = el("div", "panel-body");
  if (kind === "prose") {
    state.proseBlock = el("div", "prose-block");
    state.body.appendChild(state.proseBlock);
  }
  root.appendChild(state.body);
  if (seq > 0) root.appendChild(el("span", "seq-badge", `#${seq}`));
  return state;
}

/**
 * 原始返回模态（编辑已并入）：默认只读；底部「编辑」仅最新步
 * （pipeline.current，按 seq + kind 匹配）可点——点击进入编辑态（保存/取消）。
 * 保存走 edit_result 校验：失败在模态内报错且不退出编辑态；成功退出编辑态。
 */
let pendingEdit = null;

function openRawModal(kind, seq, agentName, getRaw) {
  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal-box");
  const close = el("button", "act", "关闭");
  close.onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  box.appendChild(el("h3", null, `原始返回 · #${seq} · ${agentName ?? BADGE[kind]}`));

  const content = el("div", "modal-content");
  const ta = el("textarea", "raw-editor");
  ta.rows = 16;
  ta.readOnly = true;
  ta.value = getRaw();
  content.appendChild(ta);

  const footer = el("div", "raw-footer");
  const errEl = el("span", "raw-error");
  const editBtn = el("button", "act", "编辑");
  const editable =
    !busy &&
    pipe.seq === seq &&
    pipe.kind !== null &&
    (pipe.kind === kind || pipe.kind.startsWith(`${kind}:`));
  editBtn.disabled = !editable;
  if (!editable) editBtn.title = "只有最新一步（pipeline.current）可以编辑";
  editBtn.onclick = () => enterEdit();
  footer.append(editBtn, errEl);
  box.append(content, footer, close);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  function enterEdit() {
    ta.readOnly = false;
    ta.focus();
    footer.textContent = "";
    errEl.textContent = "";
    const save = el("button", "act", "保存");
    const cancel = el("button", "act", "取消");
    save.onclick = () => {
      errEl.textContent = "";
      pendingEdit = {
        success: () => exitEdit(ta.value),
        fail: (msg) => { errEl.textContent = `保存失败：${msg}`; },
      };
      sendMsg({ type: "edit_result", text: ta.value });
    };
    cancel.onclick = () => exitEdit(getRaw());
    footer.append(save, cancel, errEl);
  }

  function exitEdit(text) {
    pendingEdit = null;
    ta.readOnly = true;
    ta.value = text;
    footer.textContent = "";
    footer.append(editBtn, errEl);
  }
}

function onMessage(msg) {
  switch (msg.type) {
    case "agent_start": {
      busy = true;
      inflight += 1;
      updatePermission();
      const kind = agentKind(msg.agent);
      const title = kind === "character" ? characterTitle(msg.agent) : msg.title;
      const state = makeAgentCard(kind, title, msg.agent, msg.turn);
      streamEl.appendChild(state.root);
      panels.set(panelKey(msg.agent), state);
      scrollToBottom();
      break;
    }
    case "reasoning": {
      const state = panels.get(panelKey(msg.agent));
      if (!state?.reasoningBox) break;
      state.reasoningBox.appendChild(document.createTextNode(msg.text));
      scrollToBottom();
      break;
    }
    case "delta": {
      const kind = agentKind(msg.agent);
      const state = panels.get(panelKey(msg.agent));
      if (!state) break;
      // 原始返回一律累积（正文卡的原始返回预留给以后的正则后处理对照）
      state.rawBox?.appendChild(document.createTextNode(msg.text));
      if (kind === "prose" && state.proseBlock) {
        // 每次 delta 从 raw 全文重渲指称占位符（跨 delta 拆开的占位符也能正确渲染）
        state.proseBlock.textContent = renderRefs(state.rawBox.textContent);
      }
      scrollToBottom();
      break;
    }
    case "agent_end":
      inflight = Math.max(0, inflight - 1);
      updatePermission(); // 直接编辑按钮的空闲闸跟在途计数走
      break;
    case "decision": {
      const state = panels.get(panelKey(msg.agent ?? "character"));
      if (state) state.body.appendChild(renderDecisionCard(msg.pkg));
      scrollToBottom();
      break;
    }
    case "adjudication": {
      const state = panels.get("gm");
      if (state) state.body.appendChild(renderAdjudicationCard(msg.pkg));
      scrollToBottom();
      break;
    }
    case "summary":
      // 结构化卡片上线后摘要行已冗余：消息保留（CLI 仍用），前端不再渲染
      break;
    case "retry": {
      appendLine("line-retry", `[解析失败，重试（第 ${msg.attempt + 1} 次）] ${msg.reason}`);
      // 重试黏连修复：清空该 agent 卡片的流式缓存，后续 delta/思维链只显示最新一次尝试
      const state = panels.get(panelKey(msg.agent));
      if (state) {
        if (state.reasoningBox) state.reasoningBox.textContent = "";
        if (state.rawBox) state.rawBox.textContent = "";
        if (state.proseBlock) state.proseBlock.textContent = "";
      }
      break;
    }
    case "turn_done":
      busy = false;
      inflight = 0;
      currentTurn = msg.turn ?? currentTurn;
      updatePermission();
      break;
    case "pipeline":
      pipe = msg;
      updatePermission();
      break;
    case "edit_done": {
      if (pendingEdit) {
        pendingEdit.success();
        pendingEdit = null;
      }
      // 按 seq+kind 寻址原地重渲该卡（live 与历史卡同构；不整段重渲历史）
      const kind = agentKind(msg.kind);
      const rootEl = streamEl.querySelector(`[data-kind="${kind}"][data-seq="${msg.seq}"]`);
      const state = rootEl?._cardState ?? panels.get(panelKey(msg.kind));
      if (!state) break;
      const r = msg.result ?? {};
      if (kind === "character" && r.decision) {
        state.body.textContent = "";
        state.body.appendChild(renderDecisionCard(r.decision));
      } else if (kind === "gm" && r.adjudication) {
        state.body.textContent = "";
        state.body.appendChild(renderAdjudicationCard(r.adjudication));
      } else if (kind === "prose" && r.prose !== undefined && state.proseBlock) {
        state.proseBlock.textContent = renderRefs(r.prose);
      }
      if (state.rawBox && r.raw !== undefined) state.rawBox.textContent = r.raw;
      scrollToBottom();
      break;
    }
    case "session_started": {
      const freshRun = currentRunId === null; // 服务端内存中无会话后的首次建立（自动建会话）
      const changed = currentRunId !== null && currentRunId !== msg.runId;
      currentRunId = msg.runId;
      runIdEl.textContent = `会话：${msg.runId}`;
      if (changed) {
        // 切换会话（新会话/读档）才清流区；同会话的重复通知（如首次输入自动建会话）保留现有内容
        streamEl.textContent = "";
        scrollPinned = true; // 内容整体替换：重置钉底
        appendLine("line-info", `已载入会话（${msg.runId}）`);
      }
      if (changed || freshRun) {
        // 真相层缓存随会话失效（防跨会话陈旧数据进入直编模态）；新会话推送到达前显示占位
        latestState = null;
        latestEvents = null;
        renderSidePanel();
      }
      busy = false;
      inflight = 0;
      updatePermission();
      refreshCids();
      sendPauseOptions(); // 会话开始/恢复：重发本地持久化的暂停选项
      break;
    }
    case "history":
      if (msg.replace) {
        streamEl.textContent = ""; // 回溯/重 roll：对话记录回到目标轮状态
        scrollPinned = true; // 内容整体替换：重置钉底
      }
      renderHistory(msg.history);
      break;
    case "error":
      busy = false;
      inflight = 0;
      pendingStateEditOpen = false; // 查询应答失败：解除待开窗，避免后续无关应答误开模态
      if (pendingEdit) {
        // 原始返回模态内的编辑保存失败：错误显示在模态内，不退出编辑态
        pendingEdit.fail(msg.message);
        pendingEdit = null;
      } else {
        appendLine("line-error", `[错误] ${msg.message}`);
      }
      updatePermission();
      break;
    case "state":
      latestState = msg.data;
      if (sideView === "state") renderSidePanel(); // 仅当前视图匹配才重渲，避免互相覆盖
      if (pendingStateEditOpen && latestEvents !== null) {
        pendingStateEditOpen = false;
        openStateEditor();
      }
      break;
    case "events":
      latestEvents = msg.data;
      if (sideView === "events") renderSidePanel();
      if (pendingStateEditOpen && latestState !== null) {
        pendingStateEditOpen = false;
        openStateEditor();
      }
      break;
    case "stats":
      break; // 缓存统计显示已移除：消息仍接收，不渲染
  }
}

// ---------------------------------------------------------------------------
// 历史回显
// ---------------------------------------------------------------------------

function renderHistory(history) {
  if (history.mode === "simple") {
    appendLine("line-info", `── 历史（${history.events.length} 条事件，旧存档简化视图）──`);
    for (const e of history.events) {
      appendLine("line-info", e.payload);
    }
    return;
  }
  currentTurn = history.turns.length;
  appendLine("line-info", `── 历史（${history.turns.length} 轮）──`);
  for (const t of history.turns) {
    // 卡片按 seq 归位（玩家卡可能处于一轮中间：无判定轮跨周期时角色先行、玩家后动）
    const items = [];
    if (t.playerInput) {
      items.push({ seq: t.seqs.player ?? t.turn, node: playerCard(t.playerInput, t.seqs.player) });
    } else {
      items.push({ seq: t.turn, node: el("div", "line-info npc-round", `── NPC 世界推进 · 轮首 #${t.turn} ──`) });
    }
    // 角色卡：一轮可有多张；历史卡保留独立的 raw / prompt / reasoning / 回滚菜单，但不可编辑。
    for (const character of t.characters) {
      const agent = `character:${character.cid}`;
      const charState = makeAgentCard(
        "character",
        characterTitle(agent),
        agent,
        character.seq,
        "prompt",
        { seq: character.seq, raw: character.raw },
      );
      if (character.decision) {
        charState.body.appendChild(renderDecisionCard(character.decision));
      } else {
        charState.body.appendChild(el("div", "line-info", character.interrupted ? "（已停止，原始返回可编辑补全）" : "（无结构化决策）"));
      }
      items.push({ seq: character.seq, node: charState.root });
    }
    // GM 卡
    if (t.adjudication) {
      const gmState = makeAgentCard("gm", "裁决", "gm", t.seqs.gm ?? t.turn, "prompt", { seq: t.seqs.gm ?? 0, raw: t.raws?.gm });
      gmState.body.appendChild(renderAdjudicationCard(t.adjudication));
      items.push({ seq: t.seqs.gm ?? t.turn, node: gmState.root });
    }
    // 正文卡
    if (t.prose) {
      const proseState = makeAgentCard("prose", "正文", "prose", t.seqs.prose ?? t.turn, "prompt", { seq: t.seqs.prose ?? 0, raw: t.raws?.prose });
      proseState.proseBlock.textContent = renderRefs(t.prose);
      items.push({ seq: t.seqs.prose ?? t.turn, node: proseState.root });
    }
    items.sort((a, b) => a.seq - b.seq);
    for (const item of items) streamEl.appendChild(item.node);
  }
  scrollToBottom();
}

// ---------------------------------------------------------------------------
// 状态栏直接编辑（大模态窗）：变量 {world, characters} + 事件数组两个 JSON 编辑区；
// 保存走 PUT /api/session/state（LLM 在途服务端同样拒），成功后等 WS state/events 广播刷新。
// ---------------------------------------------------------------------------

const DIRECT_EDIT_WARNING =
  "直接编辑真相层：保存后立即生效并写入存档。变量编辑会并入当前轮的变量变更记录，回溯时随该轮一并还原；" +
  "事件替换不走变更记录，回溯按轮次截断事件。" +
  "timer/group/acted/channel 等调度变量填错会破坏运行；timer 为绝对分钟标量。";

function openStateEditor() {
  if (latestState === null || latestEvents === null) {
    // 数据未备（会话刚建、推送未到）：先发查询，到齐后由 onMessage 用新缓存自动开本窗。
    // 缓存非空即可信——服务端在 turn_done/回溯/重 roll/步编辑/直编后均广播 state/events。
    pendingStateEditOpen = true;
    sendMsg({ type: "command", command: "state" });
    sendMsg({ type: "command", command: "events" });
    return;
  }
  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal-box state-editor");
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  box.appendChild(el("h3", null, "直接编辑真相层"));
  box.appendChild(el("div", "state-editor-warning", DIRECT_EDIT_WARNING));

  const content = el("div", "modal-content state-editor-content");
  const varsSection = el("div", "state-editor-section");
  varsSection.appendChild(el("div", "muted", "变量（{ world, characters }）"));
  const varsTa = el("textarea", "state-editor-textarea");
  varsTa.value = JSON.stringify(
    { world: latestState?.world ?? {}, characters: latestState?.characters ?? {} },
    null,
    2,
  );
  varsSection.appendChild(varsTa);
  const eventsSection = el("div", "state-editor-section");
  eventsSection.appendChild(el("div", "muted", "事件（数组）"));
  const eventsTa = el("textarea", "state-editor-textarea");
  eventsTa.value = JSON.stringify(latestEvents ?? [], null, 2);
  eventsSection.appendChild(eventsTa);
  content.append(varsSection, eventsSection);

  const footer = el("div", "raw-footer");
  const errEl = el("span", "raw-error");
  const save = el("button", "act", "保存");
  const close = el("button", "act", "取消");
  close.onclick = () => overlay.remove();
  save.onclick = async () => {
    errEl.textContent = "";
    let vars;
    try {
      vars = JSON.parse(varsTa.value);
    } catch (err) {
      errEl.textContent = `变量 JSON 解析失败：${err.message}`;
      return;
    }
    if (vars === null || typeof vars !== "object" || Array.isArray(vars)) {
      errEl.textContent = "变量区必须是 { world, characters } 对象";
      return;
    }
    let events;
    try {
      events = JSON.parse(eventsTa.value);
    } catch (err) {
      errEl.textContent = `事件 JSON 解析失败：${err.message}`;
      return;
    }
    if (!Array.isArray(events)) {
      errEl.textContent = "事件区必须是事件数组";
      return;
    }
    save.disabled = true;
    try {
      await api("/api/session/state", "PUT", {
        world: vars.world,
        characters: vars.characters,
        events,
      });
      overlay.remove(); // 成功后关闭，等 WS state/events 广播刷新面板
    } catch (err) {
      errEl.textContent = `保存失败：${err.message}`;
      save.disabled = false;
    }
  };
  footer.append(save, close, errEl);
  box.append(content, footer);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function updatePermission() {
  if (!blockEls) return;
  canInputNow = !busy && pipe.phase === "await_player";
  for (const k of Object.keys(blockEls)) blockEls[k].disabled = !canInputNow;
  refreshSend();
  if (canInputNow) blockEls.dialogue.focus();
  if (continueBtn) {
    continueBtn.style.display =
      !busy && pipe.phase !== "await_player" && !pipe.interrupted ? "" : "none";
  }
  if (editStateBtn) {
    // 直接编辑空闲闸：LLM 在途（inflight）或步间循环在途（busy/pipeline 兜底）禁用
    editStateBtn.disabled = busy || inflight > 0 || currentRunId === null;
  }
  if (stopBtn) stopBtn.style.display = busy ? "" : "none";
  if (phaseHint) {
    phaseHint.textContent = busy
      ? ""
      : pipe.interrupted
        ? "当前步已被停止：编辑补全或回滚后继续"
        : pipe.phase !== "await_player"
          ? "世界进行中，可继续或回滚"
          : "";
  }
}

function sendMsg(obj) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function send(text) {
  if (ws?.readyState !== WebSocket.OPEN) {
    appendLine("line-error", "[错误] WebSocket 未连接");
    return;
  }
  // 轮次不再由前端猜测：以 WS 下行消息（agent_start/turn_done 的 turn 字段）为准
  busy = true;
  updatePermission();
  sendMsg({ type: "input", text });
}

/** 供会话页调用：读取历史存档（加载结果经 session_started/history 广播回流）。 */
export function loadSession(runId) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "load_session", runId }));
  }
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onopen = () => sendPauseOptions(); // 重连后重发暂停选项（服务端为内存态）
  ws.onclose = () => {
    if (streamEl) appendLine("line-error", "[连接断开] 2 秒后重连…");
    setTimeout(connect, 2000);
  };
}
connect();

export function renderPlay() {
  const root = el("div");
  root.id = "play";

  // 顶栏
  const topbar = el("div", "topbar");
  const newBtn = el("button", "act", "新会话");
  // 世界设定集选择（data/worlds/*；只有一套时默认选中）
  worldSel = document.createElement("select");
  worldSel.title = "世界设定集（新会话生效）";
  worldSel.onchange = () => refreshCids();
  api("/api/worlds")
    .then(({ sets }) => {
      for (const s of sets) {
        const opt = el("option", null, s);
        opt.value = s;
        worldSel.appendChild(opt);
      }
      refreshCids();
    })
    .catch(() => {});
  newBtn.onclick = () => {
    if (ws?.readyState === WebSocket.OPEN) {
      busy = false;
      pipe = { seq: 0, phase: "await_player", interrupted: false, kind: null };
      updatePermission();
      sendMsg({ type: "new_session", world_set: worldSel.value || undefined });
    }
  };
  runIdEl = el("span", "muted", "会话：（未开始，首次输入自动创建）");
  topbar.append(worldSel, newBtn, runIdEl);

  // 主区：流 + 右侧面板
  const main = el("div", "main");
  streamEl = el("div");
  streamEl.id = "stream";
  // 钉底：用户滚轮上滑（离底 >40px）即松钉，回到底部附近恢复跟随
  scrollPinned = true;
  streamEl.addEventListener("scroll", () => {
    scrollPinned = streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight < 40;
  });
  streamEl.appendChild(el("div", "line-info", "输入你的行动或话语，Enter 发送。agent 的活动会实时显示在上方卡片里。"));

  const sidepanel = el("div");
  sidepanel.id = "sidepanel";
  const btns = el("div", "btns");
  for (const [cmd, label] of [["state", "状态"], ["events", "事件"]]) {
    const b = el("button", "act", label);
    b.onclick = () => {
      sideView = cmd; // 切换视图：先用缓存立即渲染，再发查询兜底（缓存未到时由应答重渲）
      renderSidePanel();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "command", command: cmd }));
      }
    };
    btns.appendChild(b);
  }
  editStateBtn = el("button", "act", "编辑");
  editStateBtn.disabled = true;
  editStateBtn.title = "直接编辑真相层（变量 + 事件）；LLM 运行中不可用";
  editStateBtn.onclick = () => openStateEditor();
  btns.appendChild(editStateBtn);
  sideOut = el("pre", null, "（事件数据未到——等待服务端推送）");
  sidepanel.append(btns, sideOut);
  main.append(streamEl, sidepanel);

  // 输入区：三块结构化输入（台词/行动/内心含意图）+ 标记按钮 + 暂停选项 + 暂停态提示
  const inputArea = el("div");
  inputArea.id = "inputarea";

  // 三块：台词（可空）/ 行动（可空）/ 内心含意图（必填）；台词与行动至少填一个
  const blocks = el("div", "input-blocks");
  blockEls = {};
  const addBlock = (key, label, placeholder, note) => {
    const wrap = el("label", "input-block");
    const head = el("span", "input-block-label", label);
    if (note) head.appendChild(el("span", "muted input-block-note", note));
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder;
    input.oninput = refreshSend;
    input.onkeydown = (e) => { if (e.key === "Enter") doSend(); };
    wrap.append(head, input);
    blocks.appendChild(wrap);
    blockEls[key] = input;
  };
  addBlock("dialogue", "台词（可空）", "说出的话…");
  addBlock("action", "行动（可空）", "做的事…", "台词与行动至少填一个");
  addBlock("inner", "内心", "内心想法与意图（必填）", "GM 可见，正文作情绪参考");
  inputArea.appendChild(blocks);

  // 标记区：chips（可移除）+ 五个标记按钮；召回/联系展开参数小表单
  const markerBar = el("div", "marker-bar");
  const markerBtns = el("span", "marker-btns");
  for (const [type, label] of [["gm_request", "GM 请求"], ["leave", "离开"], ["confirm", "确认"]]) {
    const b = el("button", "act marker-btn", label);
    b.onclick = () => addMarker({ type });
    markerBtns.appendChild(b);
  }
  const recallBtn = el("button", "act marker-btn", "召回…");
  recallBtn.onclick = () => openMarkerForm("recall");
  const contactBtn = el("button", "act marker-btn", "联系…");
  contactBtn.onclick = () => openMarkerForm("contact");
  markerBtns.append(recallBtn, contactBtn);
  markerChipsEl = el("span", "marker-chips");
  markerFormEl = el("span", "marker-form");
  markerBar.append(markerBtns, markerChipsEl, markerFormEl);
  inputArea.appendChild(markerBar);

  // 暂停选项行（自动继续 / 每轮暂停 / GM 前 / GM 后 / 正文后；localStorage 持久化）
  inputArea.appendChild(pauseBar());

  // 输入行（停止 / 继续 / 发送）
  const bar = el("div");
  bar.id = "inputbar";
  stopBtn = el("button", "act danger", "停止");
  stopBtn.style.display = "none";
  stopBtn.title = "中止当前生成，冻结为可编辑状态";
  stopBtn.onclick = () => sendMsg({ type: "stop" });
  continueBtn = el("button", "act", "继续");
  continueBtn.style.display = "none";
  continueBtn.title = "按当前进度继续（角色 → GM → 正文）";
  continueBtn.onclick = () => {
    busy = true; // 兜底：续跑期间（含首个 agent_start 前的间隙）禁用输入与直接编辑
    updatePermission();
    sendMsg({ type: "continue" });
  };
  const doSend = () => {
    const text = buildPayload();
    if (text === null) return;
    streamEl.appendChild(playerCard(text));
    scrollToBottom(true); // 自己发言：强制滚到底看最新进展
    send(text);
    for (const k of Object.keys(blockEls)) blockEls[k].value = "";
    markers = [];
    renderMarkerChips();
    if (markerFormEl) markerFormEl.textContent = "";
    refreshSend();
  };
  sendBtn = el("button", "act", "发送");
  sendBtn.onclick = doSend;
  bar.append(stopBtn, continueBtn, sendBtn);
  inputArea.appendChild(bar);
  phaseHint = el("div", "muted");

  root.append(topbar, main, inputArea, phaseHint);
  return root;
}
