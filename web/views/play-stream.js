/**
 * 游玩页流式区 view（优化阶段 D5 抽取，docs/optimization-review.md §10「最小模块」）：
 * 流式卡片（三 agent 同构 panel + 思维链/原始返回/提示词模态 + 回滚/重 roll/编辑菜单）、
 * panels 卡片 Map、renderHistory 历史回显、钉底滚动。
 *
 * 竞态 4 收口（会话绑定 modal 晚到）：showPrompts/showHistoryReasoning 打开时捕获 runId，
 * await 后经 isModalLive（捕获 runId === 当前 runId 且 overlay.isConnected）核验才填内容；
 * 所有 modal 经 trackModal 注册统一生命周期——runId 变化由编排层统一 close
 * （挂 document.body 的也不例外），remove 后 isConnected=false 兜住已发出的晚到响应。
 *
 * 状态所有权：本 view 持有 view 局部态——streamEl/panels/scrollPinned（renderPlay 建立，
 * 不随会话 reset；reset 规则表见 play.js 头注）。
 *
 * 纯 ESM：el/api/getState/命令通道/trackModal/confirm 全部注入，不 import app.js
 * （import 期零副作用；浏览器 view，内部函数使用 document 全局）。
 */
import { isModalLive } from "../async-guards.js";

const BADGE = { character: "【角色】", gm: "【GM】", prose: "【正文】" };

/**
 * @param {object} deps
 * @param {(tag: string, className?: string|null, text?: string) => any} deps.el
 * @param {(path: string) => Promise<any>} deps.api GET JSON 助手
 * @param {() => any} deps.getState store 只读口（S()）
 * @param {(type: string, fields?: object) => void} deps.sendCmd 默认失败处理命令通道（rollback/重 roll）
 * @param {(type: string, fields?: object) => Promise<any>} deps.sendCommand 精确应答通道（edit_result）
 * @param {(overlay: any) => () => void} deps.trackModal 注册会话绑定 modal，返回 close
 * @param {(msg: string) => boolean} deps.confirm
 */
export function createPlayStream({ el, api, getState, sendCmd, sendCommand, trackModal, confirm }) {
  /** 流区根元素（mount 后非空；模块加载早于 renderPlay 的极端时序下方法全部空转） */
  let streamEl = null;
  /** 当前流式卡片：角色按 agent/CID 分轨，避免同轮多角色互相覆盖。 */
  const panels = new Map();
  /** 钉底状态：近底（40px 内）跟随流式输出，用户上滑后松钉不再拽回 */
  let scrollPinned = true;

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

  function scrollToBottom(force = false) {
    if (streamEl && (force || scrollPinned)) streamEl.scrollTop = streamEl.scrollHeight;
  }

  function appendLine(className, text) {
    if (!streamEl) return null;
    const line = el("div", className, text);
    streamEl.appendChild(line);
    scrollToBottom();
    return line;
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

  // -------------------------------------------------------------------------
  // 结构化卡片（角色决策 / GM 裁决）
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // 模态窗（全部经 trackModal 进统一生命周期；异步填充前 isModalLive 核验）
  // -------------------------------------------------------------------------

  /** 注册 + 挂载 + 关闭接线（关闭按钮与点击遮罩）；返回 close。 */
  function wireOverlay(overlay, closeBtn) {
    const close = trackModal(overlay);
    if (closeBtn) closeBtn.onclick = close;
    overlay.onclick = (e) => {
      if (e.target === overlay) close();
    };
    document.body.appendChild(overlay);
    return close;
  }

  /** 提示词弹层：llm-recent 滚动窗取该轮 messages（超窗显示"已轮换出窗"）。 */
  async function showPrompts(agent, turn) {
    const overlay = el("div", "modal-overlay");
    const box = el("div", "modal-box");
    const closeBtn = el("button", "act", "关闭");
    box.appendChild(el("h3", null, `提示词 · 第 ${turn} 轮 · ${agent}`));
    const content = el("div", "modal-content", "（加载中…）");
    box.append(content, closeBtn);
    overlay.appendChild(box);
    wireOverlay(overlay, closeBtn);
    // 打开即捕获 runId（可能为 null 的极端时序：尚未经 snapshot 同步，从 API 兜底取活跃会话）
    const capturedRunId = getState().runId;
    const live = () => isModalLive(capturedRunId, getState().runId, overlay.isConnected);
    try {
      let runId = capturedRunId;
      if (!runId) {
        const sessions = await api("/api/sessions");
        if (!live()) return; // 晚到弃写
        runId = sessions.active;
      }
      if (!runId) {
        content.textContent = "读取失败：当前无活跃会话（还没有 runId）。";
        return;
      }
      const path = `/api/sessions/${runId}/llm-recent/${agentSlug(agent)}`;
      const records = await api(path);
      if (!live()) return; // 晚到弃写（会话已切/modal 已关）
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
      if (!live()) return;
      content.textContent = `读取失败：${err.message}`;
    }
  }

  function openViewModal(title, text, cls) {
    const overlay = el("div", "modal-overlay");
    const box = el("div", "modal-box");
    const closeBtn = el("button", "act", "关闭");
    box.appendChild(el("h3", null, title));
    const content = el("div", "modal-content");
    content.appendChild(el("pre", "prompt-body", text || "（无）"));
    if (cls) content.firstChild.classList.add(cls);
    box.append(content, closeBtn);
    overlay.appendChild(box);
    wireOverlay(overlay, closeBtn);
  }

  /** 思维链模态（历史卡）：llm-recent 滚动窗内取 seq，超窗显示"已轮换出窗"。 */
  async function showHistoryReasoning(agent, seq) {
    const capturedRunId = getState().runId; // 打开即捕获（点击时身份）
    let text;
    try {
      const records = await api(`/api/sessions/${capturedRunId}/llm-recent/${agentSlug(agent)}`);
      // 晚到核验：会话已切换 → 不展示上一 run 的内容
      if (!isModalLive(capturedRunId, getState().runId, true)) return;
      const rec = records.find((r) => r.seq === seq);
      text = rec ? rec.reasoning || "（该轮无思维链）" : `（第 ${seq} 轮已轮换出窗：llm-recent 只保留最近 5 轮）`;
    } catch (err) {
      if (!isModalLive(capturedRunId, getState().runId, true)) return;
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

  /**
   * 原始返回模态（编辑已并入）：默认只读；底部「编辑」仅最新步
   * （pipeline.current，按 seq + kind 匹配）可点——点击进入编辑态（保存/取消）。
   * 保存走 edit_result：requestId 精确关联应答（D2，取代旧 pendingEdit 猜测），
   * 失败在模态内报错且不退出编辑态；成功退出编辑态。
   */
  function openRawModal(kind, seq, agentName, getRaw) {
    const overlay = el("div", "modal-overlay");
    const box = el("div", "modal-box");
    const closeBtn = el("button", "act", "关闭");
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
      getState().streaming === null &&
      getState().pipeline.seq === seq &&
      getState().pipeline.kind !== null &&
      (getState().pipeline.kind === kind || getState().pipeline.kind.startsWith(`${kind}:`));
    editBtn.disabled = !editable;
    if (!editable) editBtn.title = "只有最新一步（pipeline.current）可以编辑";
    editBtn.onclick = () => enterEdit();
    footer.append(editBtn, errEl);
    box.append(content, footer, closeBtn);
    overlay.appendChild(box);
    wireOverlay(overlay, closeBtn);

    function enterEdit() {
      ta.readOnly = false;
      ta.focus();
      footer.textContent = "";
      errEl.textContent = "";
      const save = el("button", "act", "保存");
      const cancel = el("button", "act", "取消");
      save.onclick = () => {
        errEl.textContent = "";
        save.disabled = true;
        // requestId 精确关联：本命令的 command_result/command_error 直接决出成败
        sendCommand("edit_result", { text: ta.value }).then(
          () => {
            if (!overlay.isConnected) return; // modal 已随会话切换关闭
            exitEdit(ta.value);
          },
          (err) => {
            if (!overlay.isConnected) return;
            errEl.textContent = `保存失败：${err.message}`;
            save.disabled = false;
          },
        );
      };
      cancel.onclick = () => exitEdit(getRaw());
      footer.append(save, cancel, errEl);
    }

    function exitEdit(text) {
      ta.readOnly = true;
      ta.value = text;
      footer.textContent = "";
      footer.append(editBtn, errEl);
    }
  }

  // -------------------------------------------------------------------------
  // agent 卡片（三 agent 同构）：头部 = 标题 + 右上角 "..." 菜单
  // 菜单项：思维链 / 原始返回 / 提示词 / 回滚 / 重 roll（仅最新步可点，动态判定）
  // tools="full"：流式轮（思维链/原始返回取本地流式缓存）
  // tools="prompt"：历史轮（思维链取 llm-recent 滚动窗、原始返回取 archive raw）
  // 右下角 #N 徽标 = 该卡 seq。
  // -------------------------------------------------------------------------

  function makeAgentCard(kind, title, agentName, turn, tools = "full", opts = {}) {
    const seq = opts.seq ?? turn;
    const root = el("div", `agent-panel panel-${kind}`);
    // seq+kind → 卡片寻址（transition.editedResult 原地重渲用）
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
        { label: "思维链", onclick: () => showHistoryReasoning(agentName, seq) },
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
            sendCmd("rollback", { targetSeq: seq });
          }
        },
      });
      if (seq > 1) {
        menuItems.push({
          label: "重 roll",
          // 仅最新步可重 roll（动态判定：流水线 seq 会随回滚/续跑变化；流式在途不可点）
          when: () => getState().streaming === null && seq === getState().pipeline.seq,
          onclick: () => {
            if (confirm(`重 roll 第 ${seq} 步？该步（最新步）的内容将被丢弃并重跑。`)) {
              // 单条复合命令：服务端在同一队列任务内回滚到上一步并续跑（不可插队）
              sendCmd("rollback_and_continue", { targetSeq: seq });
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

  // -------------------------------------------------------------------------
  // 流式消息与历史回显
  // -------------------------------------------------------------------------

  /** 流式消息（protocol 已过 runId + activationId 身份校验）：卡片创建与流式追加。 */
  function onStreaming(msg) {
    if (!streamEl) return;
    switch (msg.type) {
      case "agent_start": {
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
        break; // 槽清空与权限重算由 store 订阅处理
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
    }
  }

  /** edit_result 提交附带：按 seq+kind 寻址原地重渲该卡（live 与历史卡同构；不整段重渲历史）。 */
  function onEditedResult(edited) {
    if (!streamEl) return;
    const kind = agentKind(edited.kind);
    const rootEl = streamEl.querySelector(`[data-kind="${kind}"][data-seq="${edited.seq}"]`);
    const state = rootEl?._cardState ?? panels.get(panelKey(edited.kind));
    if (!state) return;
    const r = edited.result ?? {};
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
  }

  function renderHistory(history) {
    if (!streamEl) return;
    if (history.mode === "simple") {
      appendLine("line-info", `── 历史（${history.events.length} 条事件，旧存档简化视图）──`);
      for (const e of history.events) {
        appendLine("line-info", e.payload);
      }
      return;
    }
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

  // -------------------------------------------------------------------------
  // 对外接口
  // -------------------------------------------------------------------------

  /** 构建流区根元素（含钉底滚动监听与初始提示行）。 */
  function mount() {
    streamEl = el("div");
    streamEl.id = "stream";
    scrollPinned = true;
    // 钉底：用户滚轮上滑（离底 >40px）即松钉，回到底部附近恢复跟随
    streamEl.addEventListener("scroll", () => {
      scrollPinned = streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight < 40;
    });
    streamEl.appendChild(el("div", "line-info", "输入你的行动或话语，Enter 发送。agent 的活动会实时显示在上方卡片里。"));
    return streamEl;
  }

  /** snapshot/整段重渲前置：清流区 + 清卡片索引 + 钉底。 */
  function clearStream() {
    if (!streamEl) return;
    streamEl.textContent = "";
    scrollPinned = true;
    panels.clear();
  }

  function pinScroll() {
    scrollPinned = true;
  }

  /** 玩家发言即时上卡（发送方本地回显）并强制滚到底。 */
  function appendSelfCard(text) {
    if (!streamEl) return;
    streamEl.appendChild(playerCard(text));
    scrollToBottom(true); // 自己发言：强制滚到底看最新进展
  }

  return {
    mount,
    isMounted: () => streamEl !== null,
    appendLine,
    appendSelfCard,
    clearStream,
    pinScroll,
    scrollToBottom,
    playerCard,
    renderHistory,
    onStreaming,
    onEditedResult,
  };
}
