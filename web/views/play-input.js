/**
 * 游玩页输入区 view：
 * 三块结构化输入（台词/行动/内心含意图）+ 五标记区（chips + 参数小表单）+
 * 关系记录区（relations 条目行：目标 CID + name/impression）+ 暂停选项行。
 *
 * 状态所有权：本 view 持有 transient UI 态——markers 与 relations 草稿 / knownChars（CID 下拉数据源）/
 * blockEls / pauseState（localStorage 跨会话持久化）。reset 规则与 busy 语义见 play.js 头注。
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
 * @param {() => void} deps.onPauseChanged 暂停选项变更（play.js 下发 pause_options）
 */
export function createPlayInput({ el, api, getCharsIdentity, onInputChange, onEnter, onPauseChanged }) {
  /** 三块输入元素 {dialogue, action, inner}（mount 后非空） */
  let blockEls = null;
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

  /** 构建输入区 DOM（三块输入 + 标记区 + 关系记录区 + 暂停选项行；发送/停止/继续行归编排层）。 */
  function mount() {
    const inputArea = el("div");
    inputArea.id = "inputarea";

    // 三块：台词（可空）/ 行动（可空）/ 内心含意图（必填）；台词与行动至少填一个
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
    const relationBtn = el("button", "act marker-btn", "记录关系…");
    relationBtn.onclick = () => openMarkerForm("relation");
    markerBtns.append(recallBtn, contactBtn, relationBtn);
    markerChipsEl = el("span", "marker-chips");
    markerFormEl = el("span", "marker-form");
    markerBar.append(markerBtns, markerChipsEl, markerFormEl);
    inputArea.appendChild(markerBar);

    // 关系记录区：已添加的 relations 条目行（目标 + name/impression + 删除）
    relationsEl = el("div", "relations-bar");
    inputArea.appendChild(relationsEl);

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
    knownChars = [];
  }

  /** 发送成功后清空三块输入、待发标记与关系记录。 */
  function clearAfterSend() {
    if (blockEls) for (const k of Object.keys(blockEls)) blockEls[k].value = "";
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

  return { mount, buildPayload, resetTransient, clearAfterSend, refreshCids, setEnabled, pauseOptionsPayload };
}
