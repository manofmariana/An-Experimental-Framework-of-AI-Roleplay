/**
 * 状态编辑器 view：
 * 直编 modal——变量 {world, characters} + 事件数组两个 JSON 编辑区，保存走
 * PUT /api/session/state（直编，commit → transition 广播刷新面板）。
 *
 * 竞态 4 收口（modal 身份）：
 * - 打开时捕获 {runId, baseRevision}（不可变）；保存前核验 store 当前 runId，
 *   会话已切换 → 拒绝保存并提示重开（runId 变化时页面层也会统一 remove 存活 modal）；
 * - baseRevision 随 PUT 上送（Coordinator direct_edit 乐观并发闸）：409 REVISION_CONFLICT
 *   → 编辑器内提示「状态已变化，请刷新」，不静默覆盖、不退出编辑态；
 * - overlay 经 trackModal 注册进会话 modal 统一生命周期（挂 document.body 也不例外）。
 *
 * 纯 ESM：el/api/getState/trackModal/mountModal 全部注入（node:test 可用极简
 * fake element 桩驱动，见 test/webStateEditor.test.ts）。
 */

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
 */
export function openStateEditor({ el, api, getState, trackModal, mountModal, notifyError }) {
  const state = getState();
  if (state.runId === null) {
    // 无活跃会话不可编辑（有会话时 store 数据恒新鲜——snapshot/transition 逐提交维护）
    notifyError("[错误] 当前无活跃会话，无法直接编辑");
    return;
  }
  // 打开即捕获身份（不可变）：保存只认本次捕获，revision 前进由服务端 409 兜住
  const captured = { runId: state.runId, baseRevision: state.revision };

  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal-box state-editor");
  box.appendChild(el("h3", null, "直接编辑真相层"));
  box.appendChild(el("div", "state-editor-warning", DIRECT_EDIT_WARNING));

  const content = el("div", "modal-content state-editor-content");
  const varsSection = el("div", "state-editor-section");
  varsSection.appendChild(el("div", "muted", "变量（{ world, characters }）"));
  const varsTa = el("textarea", "state-editor-textarea");
  varsTa.value = JSON.stringify(
    { world: state.world ?? {}, characters: state.characters ?? {} },
    null,
    2,
  );
  varsSection.appendChild(varsTa);
  const eventsSection = el("div", "state-editor-section");
  eventsSection.appendChild(el("div", "muted", "事件（数组）"));
  const eventsTa = el("textarea", "state-editor-textarea");
  eventsTa.value = JSON.stringify(state.events ?? [], null, 2);
  eventsSection.appendChild(eventsTa);
  content.append(varsSection, eventsSection);

  const footer = el("div", "raw-footer");
  const errEl = el("span", "raw-error");
  const save = el("button", "act", "保存");
  const closeBtn = el("button", "act", "取消");

  const close = trackModal(overlay);
  closeBtn.onclick = close;
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };

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
    // 会话身份核验：打开后切过 run → 本次捕获作废，拒绝写入当前会话
    if (getState().runId !== captured.runId) {
      errEl.textContent = "会话已切换，本次编辑已失效：请重新打开编辑器";
      save.disabled = true;
      return;
    }
    save.disabled = true;
    try {
      await api("/api/session/state", "PUT", {
        world: vars.world,
        characters: vars.characters,
        events,
        baseRevision: captured.baseRevision, // 乐观并发闸：revision 前进 → 409
      });
      close(); // 成功后关闭，等 WS transition 广播刷新面板
    } catch (err) {
      // 409 REVISION_CONFLICT = 状态已前进：编辑器内提示刷新，不静默覆盖
      errEl.textContent =
        err.code === "REVISION_CONFLICT" ? "状态已变化，请刷新" : `保存失败：${err.message}`;
      save.disabled = false;
    }
  };
  footer.append(save, closeBtn, errEl);
  box.append(content, footer);
  overlay.appendChild(box);
  mountModal(overlay);
}
