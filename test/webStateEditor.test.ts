/**
 * web/views/state-editor.js 单元测试（unit 层）：
 * 无 jsdom——极简 fake element 桩（textContent/appendChild/append/isConnected/remove 级别）
 * 覆盖 modal 生命周期断言：
 * - 「变量 / 事件」两标签页：默认变量页（事件区 display:none），切换互显互隐；
 * - 打开捕获 {runId, baseRevision}，保存 PUT 携带 baseRevision，成功后**不关窗**——
 *   行内提示「已保存」+ baseRevision 用应答新 revision 推进（下一次保存带新闸值）；
 * - 变量区为树状状态编辑器（var-tree-model 工作副本）：无编辑时保存载荷与打开时 store 数据一致；
 * - 打开后切 run → 保存被拒（不写当前会话），编辑器内提示；
 * - 409 REVISION_CONFLICT → 编辑器内提示「状态已变化，请刷新」，不静默覆盖、不退出；
 * - 事件 JSON 解析失败 → 编辑器内报错，不发请求；
 * - 无会话 → notifyError，不挂 modal；
 * - trackModal 注册 → 模拟 runId 变化统一关闭（isConnected 变 false）；
 * - 取消确认：有未保存修改先 confirm（拒 = 不关；确认 = 关），无修改直接关不 confirm；
 *   保存成功清脏 → 取消直接关；
 * - 滚动保持：整树重渲（折叠切换）保持 modal 滚动容器 scrollTop 不跳顶。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openStateEditor, type StateEditorState } from "../web/views/state-editor.js";

// ---------------------------------------------------------------------------
// 极简 fake element 桩（覆盖 state-editor 与 var-tree-editor 用到的 DOM 面）
// ---------------------------------------------------------------------------

class FakeEl {
  readonly tag: string;
  className = "";
  textContent = "";
  value = "";
  disabled = false;
  isConnected = false;
  id = "";
  scrollTop = 0;
  readonly style: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  onclick: ((e?: unknown) => unknown) | null = null;
  onchange: (() => unknown) | null = null;
  constructor(tag: string) {
    this.tag = tag;
  }
  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }
  append(...cs: FakeEl[]): void {
    this.children.push(...cs);
  }
  setAttribute(_name: string, _value: string): void {}
  remove(): void {
    this.isConnected = false;
  }
}

function fakeEl(tag: string, className?: string | null, text?: string): FakeEl {
  const node = new FakeEl(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 深度遍历（含根）。 */
function walk(node: FakeEl): FakeEl[] {
  return [node, ...node.children.flatMap(walk)];
}

function findByText(root: FakeEl, tag: string, text: string): FakeEl {
  const hit = walk(root).find((n) => n.tag === tag && n.textContent === text);
  assert.ok(hit, `未找到 <${tag}>「${text}」`);
  return hit;
}

function findByClass(root: FakeEl, cls: string): FakeEl {
  const hit = walk(root).find((n) => n.className === cls);
  assert.ok(hit, `未找到 class=${cls}`);
  return hit;
}

// ---------------------------------------------------------------------------
// 装配：fake el/api/store/trackModal/mountModal
// ---------------------------------------------------------------------------

interface PutCall {
  path: string;
  method: string;
  body: Record<string, unknown>;
}

function harness(options: {
  runId: string | null;
  revision?: number;
  apiError?: Error & { code?: string };
  confirmResult?: boolean;
}) {
  const state: StateEditorState = {
    runId: options.runId,
    revision: options.revision ?? 7,
    world: { hp: 1 },
    characters: { C1001: { name: "甲" } },
    events: [{ id: "e1", seq: 1 }],
  };
  const mounted: FakeEl[] = [];
  const closers = new Set<() => void>(); // 模拟 play.js 的会话 modal 注册表
  const puts: PutCall[] = [];
  const errors: string[] = [];
  const confirms: string[] = [];
  const deps = {
    el: fakeEl,
    api: async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
      puts.push({ path, method, body: body as Record<string, unknown> });
      if (options.apiError) throw options.apiError;
      return { note: "已保存，立即生效", revision: 8 }; // 应答附保存后新 revision
    },
    getState: () => state,
    trackModal: (overlay: FakeEl) => {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        closers.delete(close);
        overlay.remove();
      };
      closers.add(close);
      return close;
    },
    mountModal: (overlay: FakeEl) => {
      overlay.isConnected = true;
      mounted.push(overlay);
    },
    notifyError: (text: string) => {
      errors.push(text);
    },
    confirm: (msg: string) => {
      confirms.push(msg);
      return options.confirmResult ?? true;
    },
  };
  return { state, mounted, closers, puts, errors, confirms, deps };
}

describe("状态编辑器：打开捕获与保存语义", () => {
  it("「变量 / 事件」标签页：默认变量页，切换互显互隐", () => {
    const h = harness({ runId: "000001" });
    openStateEditor(h.deps);
    const overlay = h.mounted[0]!;
    const tabVars = findByText(overlay, "button", "变量");
    const tabEvents = findByText(overlay, "button", "事件");
    const sections = walk(overlay).filter((n) => n.className === "state-editor-section");
    assert.equal(sections.length, 2);
    const [varsSection, eventsSection] = sections;
    assert.equal(tabVars.className, "state-editor-tab active"); // 默认变量页
    assert.equal(eventsSection!.style.display, "none");
    assert.equal(varsSection!.style.display, undefined);

    tabEvents.onclick!();
    assert.equal(tabEvents.className, "state-editor-tab active");
    assert.equal(tabVars.className, "state-editor-tab");
    assert.equal(eventsSection!.style.display, "");
    assert.equal(varsSection!.style.display, "none");

    tabVars.onclick!();
    assert.equal(varsSection!.style.display, "");
    assert.equal(eventsSection!.style.display, "none");
  });

  it("打开捕获 {runId, baseRevision}；保存 PUT 携带 baseRevision，成功后不关窗并推进闸值", async () => {
    const h = harness({ runId: "000001", revision: 7 });
    openStateEditor(h.deps);
    assert.equal(h.mounted.length, 1);
    const overlay = h.mounted[0]!;
    assert.equal(overlay.isConnected, true);
    assert.equal(h.closers.size, 1); // 已注册进统一生命周期
    // 变量区 = 树状编辑器（无 textarea）；事件区 = 唯一 textarea，预填打开时事件数组
    const textareas = walk(overlay).filter((n) => n.tag === "textarea");
    assert.equal(textareas.length, 1);
    assert.deepEqual(JSON.parse(textareas[0]!.value), [{ id: "e1", seq: 1 }]);

    await findByText(overlay, "button", "保存").onclick!();
    assert.equal(h.puts.length, 1);
    assert.equal(h.puts[0]!.path, "/api/session/state");
    assert.equal(h.puts[0]!.method, "PUT");
    assert.equal(h.puts[0]!.body.baseRevision, 7); // 捕获的 baseRevision 上送
    assert.deepEqual(h.puts[0]!.body.world, { hp: 1 }); // 无编辑 → 工作副本原样上送
    assert.deepEqual(h.puts[0]!.body.characters, { C1001: { name: "甲" } });
    // 保存成功不关窗：行内提示「已保存」、注册表仍持有、保存钮恢复可用
    assert.equal(overlay.isConnected, true);
    assert.equal(h.closers.size, 1);
    assert.equal(findByClass(overlay, "raw-ok").textContent, "已保存");
    assert.equal(findByText(overlay, "button", "保存").disabled, false);

    // baseRevision 用应答新 revision 推进：第二次保存带新闸值 8
    await findByText(overlay, "button", "保存").onclick!();
    assert.equal(h.puts.length, 2);
    assert.equal(h.puts[1]!.body.baseRevision, 8);
  });

  it("整树重渲保持 modal 滚动容器 scrollTop（折叠切换不跳顶）", () => {
    const h = harness({ runId: "000001" });
    openStateEditor(h.deps);
    const overlay = h.mounted[0]!;
    const content = findByClass(overlay, "modal-content state-editor-content");
    content.scrollTop = 123;
    // 触发整树重渲：点击「世界变量」区块折叠箭头
    const chevron = walk(overlay).find((n) => n.className === "vte-fold" && n.textContent === "▾");
    assert.ok(chevron, "未找到折叠箭头");
    chevron.onclick!();
    assert.equal(content.scrollTop, 123); // 重渲后滚动位还原
  });

  it("取消确认：有未保存修改先 confirm（拒不关/确认才关）；无修改直接关不 confirm", async () => {
    // 无修改 → 直接关闭，不弹确认
    const clean = harness({ runId: "000001" });
    openStateEditor(clean.deps);
    findByText(clean.mounted[0]!, "button", "取消").onclick!();
    assert.equal(clean.confirms.length, 0);
    assert.equal(clean.mounted[0]!.isConnected, false);

    // 有修改（事件区编辑置脏）+ 用户拒绝 → 不关
    const deny = harness({ runId: "000001", confirmResult: false });
    openStateEditor(deny.deps);
    const overlay = deny.mounted[0]!;
    walk(overlay).filter((n) => n.tag === "textarea")[0]!.onchange!();
    findByText(overlay, "button", "取消").onclick!();
    assert.equal(deny.confirms.length, 1);
    assert.equal(overlay.isConnected, true);

    // 有修改 + 用户确认 → 关闭
    const ok = harness({ runId: "000001", confirmResult: true });
    openStateEditor(ok.deps);
    const overlay2 = ok.mounted[0]!;
    walk(overlay2).filter((n) => n.tag === "textarea")[0]!.onchange!();
    findByText(overlay2, "button", "取消").onclick!();
    assert.equal(ok.confirms.length, 1);
    assert.equal(overlay2.isConnected, false);

    // 保存成功清脏 → 取消直接关，不再确认
    const saved = harness({ runId: "000001" });
    openStateEditor(saved.deps);
    const overlay3 = saved.mounted[0]!;
    walk(overlay3).filter((n) => n.tag === "textarea")[0]!.onchange!(); // 先置脏
    await findByText(overlay3, "button", "保存").onclick!(); // 保存成功清脏
    findByText(overlay3, "button", "取消").onclick!();
    assert.equal(saved.confirms.length, 0);
    assert.equal(overlay3.isConnected, false);
  });

  it("打开后切 run → 保存被拒（不写当前会话），编辑器内提示且不发请求", async () => {
    const h = harness({ runId: "000001" });
    openStateEditor(h.deps);
    const overlay = h.mounted[0]!;
    h.state.runId = "000002"; // 会话已切换
    await findByText(overlay, "button", "保存").onclick!();
    assert.equal(h.puts.length, 0);
    assert.match(findByClass(overlay, "raw-error").textContent, /会话已切换/);
  });

  it("409 REVISION_CONFLICT → 编辑器内提示「状态已变化，请刷新」，不静默覆盖", async () => {
    const conflict = new Error("revision 冲突") as Error & { code?: string };
    conflict.code = "REVISION_CONFLICT";
    const h = harness({ runId: "000001", apiError: conflict });
    openStateEditor(h.deps);
    const overlay = h.mounted[0]!;
    const save = findByText(overlay, "button", "保存");
    await save.onclick!();
    assert.equal(h.puts.length, 1);
    assert.equal(findByClass(overlay, "raw-error").textContent, "状态已变化，请刷新");
    assert.equal(save.disabled, false); // 不退出编辑态，可修正后重试
    assert.equal(overlay.isConnected, true);
    assert.equal(h.closers.size, 1);
  });

  it("事件 JSON 非法 → 编辑器内报错，不发请求", async () => {
    const h = harness({ runId: "000001" });
    openStateEditor(h.deps);
    const overlay = h.mounted[0]!;
    walk(overlay).filter((n) => n.tag === "textarea")[0]!.value = "{ 非法";
    await findByText(overlay, "button", "保存").onclick!();
    assert.equal(h.puts.length, 0);
    assert.match(findByClass(overlay, "raw-error").textContent, /事件 JSON 解析失败/);
  });

  it("无活跃会话 → notifyError，不挂 modal", () => {
    const h = harness({ runId: null });
    openStateEditor(h.deps);
    assert.equal(h.mounted.length, 0);
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0]!, /无活跃会话/);
  });

  it("runId 变化统一关闭：注册表 close 全部触发（挂 body 的 modal 不长存）", () => {
    const h = harness({ runId: "000001" });
    openStateEditor(h.deps);
    const overlay = h.mounted[0]!;
    assert.equal(overlay.isConnected, true);
    // 模拟 play.js closeSessionModals（runIdChanged 信号）
    for (const close of [...h.closers]) close();
    assert.equal(overlay.isConnected, false);
    assert.equal(h.closers.size, 0);
  });
});
