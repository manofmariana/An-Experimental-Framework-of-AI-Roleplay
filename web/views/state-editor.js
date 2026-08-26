/**
 * 状态编辑器 view：
 * 直编 modal——「变量 / 事件」两标签页（一次只显示一个）：变量页为树状状态编辑器
 * （var-tree-model 数据核心 + var-tree-editor DOM 层，打开时深拷贝 store world/characters
 * 为工作副本，全部编辑作用于副本；只做实例状态编辑——结构编辑在世界页），
 * 事件页维持 raw JSON 数组编辑；保存走 PUT /api/session/state（直编，commit →
 * transition 广播刷新面板）。
 *
 * UX 纪律：
 * - 整树重渲保持 modal 滚动容器 scrollTop（var-tree-editor scrollHost 注入，不跳顶）；
 * - 保存成功不关窗：行内提示「已保存」（短暂自动消隐），baseRevision 用保存后的新
 *   revision 刷新（应答 revision 与同 runId 的 store revision 取大——transition 广播
 *   可能先于 HTTP 应答到达）；保存失败（400/409）行为不变；
 * - 取消/点遮罩关闭前脏检查：有未保存修改先 confirm 确认（confirm 注入，与 play-stream
 *   同一浏览器 confirm 口径），无修改直接关闭。
 *
 * 竞态 4 收口（modal 身份）：
 * - 打开时捕获 {runId, baseRevision}（runId 不可变）；保存前核验 store 当前 runId，
 *   会话已切换 → 拒绝保存并提示重开（runId 变化时页面层也会统一 remove 存活 modal）；
 * - baseRevision 随 PUT 上送（Coordinator direct_edit 乐观并发闸）：409 REVISION_CONFLICT
 *   → 编辑器内提示「状态已变化，请刷新」，不静默覆盖、不退出编辑态；
 * - overlay 经 trackModal 注册进会话 modal 统一生命周期（挂 document.body 也不例外）。
 *
 * 纯 ESM：el/api/getState/trackModal/mountModal/confirm 全部注入（node:test 可用极简
 * fake element 桩驱动，见 test/webStateEditor.test.ts）。
 */

import { createVarTreeModel } from "./var-tree-model.js";
import { createVarTreeEditor } from "./var-tree-editor.js";

export const DIRECT_EDIT_WARNING =
  "直接编辑真相层：保存后立即生效并写入存档。变量编辑会并入当前轮的变量变更记录，回溯时随该轮一并还原；" +
  "事件替换不走变更记录，回溯按轮次截断事件。" +
  "timer/group/acted/channel 等调度变量填错会破坏运行；timer 为绝对分钟标量。";

/**
 * @param {object} deps
 * @param {(tag: string, className?: string|null, text?: string) => any} deps.el DOM 构造器
 * @param {(path: string, method?: string, body?: any) => Promise<any>} deps.api
 * @param {() => {runId: string|null, revision: number, world: any, characters: any, events: any}} deps.getState store 只读口
 * @param {(overlay: any) => () => void} deps.trackModal 注册会话绑定 modal，返回 close（remove + 注销）
 * @param {(overlay: any) => void} deps.mountModal 挂 document.body
 * @param {(text: string) => void} deps.notifyError 无会话等即时错误的落点（游玩页错误行）
 * @param {(msg: string) => boolean} deps.confirm 取消确认（有未保存修改时）
 */
export function openStateEditor({ el, api, getState, trackModal, mountModal, notifyError, confirm }) {
  const state = getState();
  if (state.runId === null) {
    // 无活跃会话不可编辑（有会话时 store 数据恒新鲜——snapshot/transition 逐提交维护）
    notifyError("[错误] 当前无活跃会话，无法直接编辑");
    return;
  }
  // 打开即捕获身份（runId 不可变；baseRevision 保存成功后随新 revision 推进）
  const captured = { runId: state.runId, baseRevision: state.revision };
  let dirty = false; // 未保存修改标记（取消确认用；保存成功清零）

  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal-box state-editor");
  box.appendChild(el("h3", null, "直接编辑真相层"));
  box.appendChild(el("div", "state-editor-warning", DIRECT_EDIT_WARNING));

  const content = el("div", "modal-content state-editor-content");
  // 「变量 / 事件」标签页：一次只显示一个（两区常驻挂载，display 切换）
  const tabs = el("div", "state-editor-tabs");
  const tabVars = el("button", "state-editor-tab active", "变量");
  const tabEvents = el("button", "state-editor-tab", "事件");
  tabs.append(tabVars, tabEvents);
  const varsSection = el("div", "state-editor-section");
  varsSection.appendChild(el("div", "muted", "变量（状态编辑：世界 / 各角色分页；结构编辑在世界页；保存时整体提交 { world, characters }）"));
  // 工作副本：打开时深拷贝 store 数据，全部编辑作用于副本，保存才上送（world 原样
  // 携带 _sys.varsTemplate——结构编辑不在此，工作副本机制不变）
  const model = createVarTreeModel({
    world: JSON.parse(JSON.stringify(state.world ?? {})),
    characters: JSON.parse(JSON.stringify(state.characters ?? {})),
  });
  // scrollHost = modal 滚动容器：整树重渲（chip 增删等）保持 scrollTop 不跳顶；
  // onEdit = 脏标记（取消确认用）
  varsSection.appendChild(
    createVarTreeEditor({ el, model, scrollHost: content, onEdit: () => { dirty = true; } }).root,
  );
  const eventsSection = el("div", "state-editor-section");
  eventsSection.appendChild(el("div", "muted", "事件（数组）"));
  const eventsTa = el("textarea", "state-editor-textarea");
  eventsTa.value = JSON.stringify(state.events ?? [], null, 2);
  eventsTa.onchange = () => {
    dirty = true;
  };
  eventsSection.appendChild(eventsTa);
  eventsSection.style.display = "none"; // 默认变量页
  tabVars.onclick = () => {
    tabVars.className = "state-editor-tab active";
    tabEvents.className = "state-editor-tab";
    varsSection.style.display = "";
    eventsSection.style.display = "none";
  };
  tabEvents.onclick = () => {
    tabEvents.className = "state-editor-tab active";
    tabVars.className = "state-editor-tab";
    eventsSection.style.display = "";
    varsSection.style.display = "none";
  };
  content.append(tabs, varsSection, eventsSection);

  const footer = el("div", "raw-footer");
  const errEl = el("span", "raw-error");
  const okEl = el("span", "raw-ok");
  const save = el("button", "act", "保存");
  const closeBtn = el("button", "act", "取消");

  const close = trackModal(overlay);
  /** 关闭前脏检查：有未保存修改先确认，无修改直接关。 */
  const requestClose = () => {
    if (dirty && !confirm("有未保存的修改，确定放弃并关闭？")) return;
    close();
  };
  closeBtn.onclick = requestClose;
  overlay.onclick = (e) => {
    if (e.target === overlay) requestClose();
  };

  save.onclick = async () => {
    errEl.textContent = "";
    okEl.textContent = "";
    // 变量区 = 树编辑器工作副本（model 内部已逐操作校验；服务端三套 parse 兜底）
    const vars = model.getPayload();
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
    // 会话身份核验：打开后切过 run → 本次捕获作废，拒绝写入当前会话
    if (getState().runId !== captured.runId) {
      errEl.textContent = "会话已切换，本次编辑已失效：请重新打开编辑器";
      save.disabled = true;
      return;
    }
    save.disabled = true;
    try {
      const resp = await api("/api/session/state", "PUT", {
        world: vars.world,
        characters: vars.characters,
        events,
        baseRevision: captured.baseRevision, // 乐观并发闸：revision 前进 → 409
      });
      // 保存成功不关窗：baseRevision 推进到保存后的新 revision（transition 广播可能
      // 先于 HTTP 应答刷新 store，两者取大），行内提示「已保存」短暂驻留
      const cur = getState();
      const storeRev = cur.runId === captured.runId && Number.isInteger(cur.revision) ? cur.revision : 0;
      const respRev = resp !== null && typeof resp === "object" && Number.isInteger(resp.revision) ? resp.revision : 0;
      captured.baseRevision = Math.max(captured.baseRevision, storeRev, respRev);
      dirty = false; // 工作副本已落档，取消不再需要确认
      okEl.textContent = "已保存";
      const timer = setTimeout(() => {
        okEl.textContent = "";
      }, 2000);
      timer.unref?.(); // node:test 下不为提示定时器拖住进程
      save.disabled = false;
    } catch (err) {
      // 409 REVISION_CONFLICT = 状态已前进：编辑器内提示刷新，不静默覆盖
      errEl.textContent =
        err.code === "REVISION_CONFLICT" ? "状态已变化，请刷新" : `保存失败：${err.message}`;
      save.disabled = false;
    }
  };
  footer.append(save, closeBtn, errEl, okEl);
  box.append(content, footer);
  overlay.appendChild(box);
  mountModal(overlay);
}
