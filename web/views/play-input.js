/**
 * 游玩页输入区 view：
 * 模式页签（主控/上帝）+ 主控面板（三块结构化输入「台词/行动/内心含意图」+ 五标记区
 * chips + 参数小表单 + 关系记录区 relations 条目行：目标 CID + name/impression + 写作指令槽）
 * + 上帝面板（上帝指令槽 + 写作指令槽）+ 暂停选项行。两模式各带独立写作指令槽。
 *
 * 状态所有权：本 view 持有 transient UI 态——markers 与 relations 草稿 / knownChars（CID 下拉数据源）/
 * blockEls / directiveEls / pauseState（localStorage 跨会话持久化）。reset 规则与 busy 语义见 play.js 头注。
 *
 * 竞态 2 收口（refreshCids）：调用时捕获 {runId, worldSetId}，await 后经
 * sameCharsIdentity 与当前身份比对，不符不写 knownChars（world A→B 逆序响应只接受 B）。
 *
 * 纯 ESM：el/api/身份读取/回调全部注入，不 import app.js（import 期零副作用）。
 */
import { fetchKnownChars, sameCharsIdentity } from "../async-guards.js";

const PAUSE_STORAGE_KEY = "ofair-pause-options";

/**
 * @param {object} deps
 * @param {(tag: string, className?: string|null, text?: string) => any} deps.el
 * @param {(path: string) => Promise<any>} deps.api GET JSON 助手
 * @param {() => {runId: string|null, worldSetId: string}} deps.getCharsIdentity CID 数据源身份（store runId + 世界包选择器当前值）
 * @param {() => void} deps.onInputChange 输入/标记变化（play.js 重算发送按钮）
 * @param {() => void} deps.onEnter Enter 发送
 * @param {(mode: "god"|"writing", text: string, key: string) => void} deps.onDirective 指令发送（上帝/写作；key = 槽位唯一键；play.js 接线 directive 命令，成功清空对应槽）
 * @param {() => void} deps.onPauseChanged 暂停选项变更（play.js 下发 pause_options）
 */
export function createPlayInput({ el, api, getCharsIdentity, onInputChange, onEnter, onDirective, onPauseChanged }) {
  /** 三块输入元素 {dialogue, action, inner}（mount 后非空） */
  let blockEls = null;
  /** 指令输入元素（槽位键 → input；mount 后非空；写作指令两槽 = "writing"（主控面板）与 "god_writing"（上帝面板）） */
  let directiveEls = null;
  /** 输入区模式（main = 主控 / god = 上帝）；用户视图选择，runId reset 不重置 */
  let mode = "main";
  /** 待发标记（DecisionPackage.markers；即抛指令位） */
  let markers = [];
  let markerChipsEl = null;
  let markerFormEl = null;
  /** 待发关系记录（DecisionPackage.relations；name/impression 至少其一才合法） */
  let relations = [];
  let relationsEl = null;
  /** 会话角色列表（标记 CID 下拉数据源；不含 C0 玩家自己） */
  let knownChars = [];
  /** 五选项 UI 态（auto 为展示态，不下发；其余四项映射 pause_options 消息字段） */
  let pauseState = { auto: true, everyStep: false, beforeGm: false, afterGm: false, afterProse: false };
  let pauseCheckboxes = null;

  try {
    const saved = JSON.parse(localStorage.getItem(PAUSE_STORAGE_KEY) ?? "null");
    if (saved && typeof saved === "object") pauseState = { ...pauseState, ...saved };
  } catch {
    /* 损坏的本地存储回退默认（自动继续） */
  }

  function persistPause() {
    localStorage.setItem(PAUSE_STORAGE_KEY, JSON.stringify(pauseState));
  }

  // -------------------------------------------------------------------------
  // 标记区：结构化指令位，即抛；GM 请求与离开互斥（UI 层先挡）
  // -------------------------------------------------------------------------

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

  function addMarker(m) {
    if (m.type === "gm_request") markers = markers.filter((x) => x.type !== "leave");
    if (m.type === "leave") markers = markers.filter((x) => x.type !== "gm_request");
    // 单例标记去重（gm_request/leave/confirm 至多各一条）
    if (m.type === "gm_request" || m.type === "leave" || m.type === "confirm") {
      markers = markers.filter((x) => x.type !== m.type);
    }
    markers.push(m);
    renderMarkerChips();
    onInputChange();
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
        onInputChange();
      };
      chip.appendChild(x);
      markerChipsEl.appendChild(chip);
    });
  }

  /** 关系记录条目行：目标 CID 标签 + name/impression 输入 + 删除；提交前在输入区可见。 */
  function renderRelations() {
    if (!relationsEl) return;
    relationsEl.textContent = "";
    relations.forEach((r, i) => {
      const row = el("span", "relation-row");
      row.appendChild(el("span", "relation-target", r.target));
      const name = el("input");
      name.type = "text";
      name.placeholder = "名字（可选）";
      name.value = r.name;
      name.oninput = () => {
        r.name = name.value;
        onInputChange();
      };
      const impression = el("input");
      impression.type = "text";
      impression.placeholder = "印象（可选）";
      impression.value = r.impression;
      impression.oninput = () => {
        r.impression = impression.value;
        onInputChange();
      };
      const x = el("button", "marker-chip-x", "×");
      x.title = "移除关系记录";
      x.onclick = () => {
        relations.splice(i, 1);
        renderRelations();
        onInputChange();
      };
      row.append(name, impression, x);
      relationsEl.appendChild(row);
    });
  }

  function cidSelect(multiple) {
    const sel = el("select");
    if (multiple) sel.multiple = true;
    for (const c of knownChars) {
      const opt = el("option", null, `${c.name}（${c.cid}）`);
      opt.value = c.cid;
      sel.appendChild(opt);
    }
    return sel;
  }

  /** 召回/联系/记录关系需要参数：在标记行展开小表单，确定后加标记/条目并收起。 */
  function openMarkerForm(kind) {
    if (!markerFormEl) return;
    markerFormEl.textContent = "";
    const close = () => {
      markerFormEl.textContent = "";
    };
    if (kind === "relation") {
      const sel = cidSelect(false);
      const ok = el("button", "act marker-btn", "添加");
      ok.onclick = () => {
        if (sel.value) {
          relations.push({ target: sel.value, name: "", impression: "" });
          renderRelations();
          onInputChange();
          close();
        }
      };
      const cancel = el("button", "act marker-btn", "取消");
      cancel.onclick = close;
      markerFormEl.append(el("span", "muted", "关系对象："), sel, ok, cancel);
    } else if (kind === "recall") {
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
      const channel = el("input");
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

  /**
   * 刷新会话角色列表（竞态 2）：调用时捕获身份，await 后核验——
   * 会话或世界包已切换则晚到响应弃写（不覆盖新身份的 knownChars）。
   */
  async function refreshCids() {
    const captured = getCharsIdentity();
    let list = [];
    try {
      list = await fetchKnownChars(api, captured);
    } catch {
      list = [];
    }
    if (!sameCharsIdentity(captured, getCharsIdentity())) return; // 晚到弃写
    knownChars = list;
  }

  // -------------------------------------------------------------------------
  // 暂停选项（localStorage 持久化 + 变更即通知编排层下发 pause_options）。
  // 互斥：自动继续/每轮暂停各自排除其余四项/三项；GM 前·GM 后·正文后可自由组合。
  // -------------------------------------------------------------------------

  function syncPauseCheckboxes() {
    if (!pauseCheckboxes) return;
    for (const [key, box] of Object.entries(pauseCheckboxes)) box.checked = pauseState[key];
  }

  function onPauseChange(key, checked) {
    pauseState[key] = checked;
    if (key === "auto" && checked) {
      pauseState.everyStep = pauseState.beforeGm = pauseState.afterGm = pauseState.afterProse = false;
    } else if (key === "everyStep" && checked) {
      pauseState.auto = pauseState.beforeGm = pauseState.afterGm = pauseState.afterProse = false;
    } else if ((key === "beforeGm" || key === "afterGm" || key === "afterProse") && checked) {
      pauseState.auto = pauseState.everyStep = false;
    } else if (!checked && key !== "auto" &&
      !pauseState.everyStep && !pauseState.beforeGm && !pauseState.afterGm && !pauseState.afterProse) {
      pauseState.auto = true; // 全部取消 → 回到自动继续
    }
    syncPauseCheckboxes();
    persistPause();
    onPauseChanged();
  }

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
      const box = el("input");
      box.type = "checkbox";
      box.checked = pauseState[key];
      box.onchange = () => onPauseChange(key, box.checked);
      pauseCheckboxes[key] = box;
      wrap.append(box, document.createTextNode(label));
      bar.appendChild(wrap);
    }
    return bar;
  }

  // -------------------------------------------------------------------------
  // 对外接口
  // -------------------------------------------------------------------------

  /** 构建输入区 DOM：模式页签（主控/上帝）+ 两面板 + 暂停选项行（发送/停止/继续行归编排层）。
   *  主控面板 = 三块输入（写作指令槽并入网格第四格，内心同行右列）+ 标记区 + 关系记录区；
   *  上帝面板 = 上帝指令槽（主提交）+ 写作指令槽。写作指令不能独立注入（无发送钮）——
   *  主控模式随主发送捆绑、上帝模式随上帝指令捆绑。模式切换只显隐——面板 DOM 一次性构建，
   *  各槽输入值存于元素本身，切换不丢；模式是用户视图选择，runId reset 不重置。 */
  function mount() {
    const inputArea = el("div");
    inputArea.id = "inputarea";

    // 指令槽（当轮一次性）：写作槽 = 无发送钮纯输入（不能独立注入——主控面板随主发送捆绑、
    // 上帝面板随上帝指令捆绑）；上帝槽 = 上帝面板的主提交（发送钮/Enter），发送时捆绑本面板写作槽。
    // key = 槽位唯一键（清空按槽位；两个写作槽 mode 同为 writing、槽位不同）
    directiveEls = {};
    /** 写作指令槽（无发送钮；onPrimary = 所属面板的主提交动作，Enter 触发） */
    const addWritingSlot = (host, key, note, onPrimary) => {
      const wrap = el("label", "input-block");
      const head = el("span", "input-block-label", "写作指令");
      if (note) head.appendChild(el("span", "muted input-block-note", note));
      const input = el("input");
      input.type = "text";
      input.placeholder = "对正文文风/写法的直接指令…";
      input.onkeydown = (e) => {
        if (e.key === "Enter") onPrimary();
      };
      wrap.append(head, input);
      host.appendChild(wrap);
      directiveEls[key] = input;
    };
    /** 上帝面板主提交：上帝指令 + 捆绑本面板写作指令（各按槽位键回报，成功各自清空） */
    const fireGod = () => {
      const godText = directiveEls.god.value.trim();
      if (!godText) return;
      onDirective("god", godText, "god");
      const writingText = directiveEls.god_writing.value.trim();
      if (writingText) onDirective("writing", writingText, "god_writing");
    };

    // 模式页签（主控 = 三块输入撰写决策包；上帝 = 上帝指令 + 写作指令）
    const modeTabs = el("div", "mode-tabs");
    const panelMain = el("div", "input-mode-panel");
    const panelGod = el("div", "input-mode-panel");
    panelGod.style.display = "none";
    for (const [m, label] of [["main", "主控"], ["god", "上帝"]]) {
      const b = el("button", "act", label);
      b.dataset.mode = m;
      b.classList.toggle("active", m === mode);
      b.onclick = () => {
        mode = m;
        for (const t of modeTabs.querySelectorAll("button")) t.classList.toggle("active", t.dataset.mode === m);
        panelMain.style.display = m === "main" ? "" : "none";
        panelGod.style.display = m === "god" ? "" : "none";
        onInputChange(); // 编排层 refreshSend：上帝模式无主决策包可发，主发送钮收起
      };
      modeTabs.appendChild(b);
    }
    inputArea.appendChild(modeTabs);

    // 主控面板 · 三块：台词（可空）/ 行动（可空）/ 内心含意图（必填）；台词与行动至少填一个
    const blocks = el("div", "input-blocks");
    blockEls = {};
    const addBlock = (key, label, placeholder, note) => {
      const wrap = el("label", "input-block");
      const head = el("span", "input-block-label", label);
      if (note) head.appendChild(el("span", "muted input-block-note", note));
      const input = el("input");
      input.type = "text";
      input.placeholder = placeholder;
      input.oninput = onInputChange;
      input.onkeydown = (e) => {
        if (e.key === "Enter") onEnter();
      };
      wrap.append(head, input);
      blocks.appendChild(wrap);
      blockEls[key] = input;
    };
    addBlock("dialogue", "台词（可空）", "说出的话…");
    addBlock("action", "行动（可空）", "做的事…", "台词与行动至少填一个");
    addBlock("inner", "内心", "内心想法与意图（必填）", "GM 可见，正文作情绪参考");
    // 写作指令槽 = 三块网格第四格（内心同行右列）：无发送钮，随主发送捆绑注入
    addWritingSlot(blocks, "writing", "仅正文可见，随主发送注入", () => onEnter());
    panelMain.appendChild(blocks);

    // 主控面板 · 标记区：chips（可移除）+ 五个标记按钮；召回/联系展开参数小表单
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
    const relationBtn = el("button", "act marker-btn", "记录关系…");
    relationBtn.onclick = () => openMarkerForm("relation");
    markerBtns.append(recallBtn, contactBtn, relationBtn);
    markerChipsEl = el("span", "marker-chips");
    markerFormEl = el("span", "marker-form");
    markerBar.append(markerBtns, markerChipsEl, markerFormEl);
    panelMain.appendChild(markerBar);

    // 主控面板 · 关系记录区：已添加的 relations 条目行（目标 + name/impression + 删除）
    relationsEl = el("div", "relations-bar");
    panelMain.appendChild(relationsEl);
    inputArea.appendChild(panelMain);

    // 上帝面板：上帝指令槽（主提交，带发送钮）+ 写作指令槽（无钮，随上帝指令捆绑）
    {
      const wrap = el("label", "input-block");
      const head = el("span", "input-block-label", "上帝指令");
      head.appendChild(el("span", "muted input-block-note", "仅 GM 可见，本轮有效"));
      const row = el("div", "directive-row");
      const input = el("input");
      input.type = "text";
      input.placeholder = "对世界/剧情的直接指令…";
      const btn = el("button", "act marker-btn", "发送");
      btn.onclick = fireGod;
      input.onkeydown = (e) => {
        if (e.key === "Enter") fireGod();
      };
      row.append(input, btn);
      wrap.append(head, row);
      panelGod.appendChild(wrap);
      directiveEls["god"] = input;
    }
    addWritingSlot(panelGod, "god_writing", "仅正文可见，随上帝指令注入", () => fireGod());
    inputArea.appendChild(panelGod);

    inputArea.appendChild(pauseBar());
    return inputArea;
  }

  /** 三块输入 + 标记 + 关系记录 → DecisionPackage JSON（内心必填；台词与行动至少其一；
   *  relations 条目 name/impression 至少其一；不合法返回 null）。 */
  function buildPayload() {
    if (blockEls === null) return null;
    const dialogue = blockEls.dialogue.value.trim();
    const action = blockEls.action.value.trim();
    const inner = blockEls.inner.value.trim();
    if (!inner) return null;
    if (!dialogue && !action) return null;
    const pkg = { inner };
    if (action) pkg.action = action;
    if (dialogue) pkg.dialogue = dialogue;
    if (markers.length > 0) pkg.markers = markers;
    if (relations.length > 0) {
      const rels = [];
      for (const r of relations) {
        const name = r.name.trim();
        const impression = r.impression.trim();
        if (!r.target) return null;
        if (!name && !impression) return null; // relation 至少需要 name 或 impression
        const entry = { target: r.target };
        if (name) entry.name = name;
        if (impression) entry.impression = impression;
        rels.push(entry);
      }
      pkg.relations = rels;
    }
    return JSON.stringify(pkg);
  }

  /** runId 变化 transient 统一 reset（规则表见 play.js 头注；pauseState 保留）。 */
  function resetTransient() {
    markers = [];
    renderMarkerChips();
    relations = [];
    renderRelations();
    if (markerFormEl) markerFormEl.textContent = "";
    if (blockEls) for (const k of Object.keys(blockEls)) blockEls[k].value = "";
    if (directiveEls) for (const k of Object.keys(directiveEls)) directiveEls[k].value = "";
    knownChars = [];
  }

  /** 指令发送成功后清空对应槽位（编排层在 command_result 后调用；按槽位键，同 mode 两槽互不影响）。 */
  function clearDirective(key) {
    if (directiveEls && directiveEls[key]) directiveEls[key].value = "";
  }

  /** 当前输入区模式（"main" | "god"；编排层 refreshSend 据此收起主发送钮）。 */
  function getMode() {
    return mode;
  }

  /** 读槽位当前文本（trim 后；编排层主发送捆绑写作指令用）。 */
  function slotValue(key) {
    return directiveEls && directiveEls[key] ? directiveEls[key].value.trim() : "";
  }

  /** 发送成功后清空三块输入、待发标记与关系记录（含主控面板写作槽——已随主发送捆绑注入）。 */
  function clearAfterSend() {
    if (blockEls) for (const k of Object.keys(blockEls)) blockEls[k].value = "";
    if (directiveEls && directiveEls.writing) directiveEls.writing.value = "";
    markers = [];
    renderMarkerChips();
    relations = [];
    renderRelations();
    if (markerFormEl) markerFormEl.textContent = "";
  }

  /** 输入权限闸（busy 语义见 play.js 头注）：三块禁用/解禁，解禁时聚焦台词框。 */
  function setEnabled(can) {
    if (!blockEls) return;
    for (const k of Object.keys(blockEls)) blockEls[k].disabled = !can;
    if (can) blockEls.dialogue.focus();
  }

  /** 当前暂停选项的下发载荷（auto 勾选 = 全 false = 自动继续；camelCase 直发）。 */
  function pauseOptionsPayload() {
    return {
      everyStep: !pauseState.auto && pauseState.everyStep,
      beforeGm: !pauseState.auto && pauseState.beforeGm,
      afterGm: !pauseState.auto && pauseState.afterGm,
      afterProse: !pauseState.auto && pauseState.afterProse,
    };
  }

  return { mount, getMode, slotValue, buildPayload, resetTransient, clearAfterSend, clearDirective, refreshCids, setEnabled, pauseOptionsPayload };
}
