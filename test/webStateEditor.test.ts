/**
 * web/views/state-editor.js 单元测试（unit 层，优化阶段 D5 竞态 4 状态编辑器切片）：
 * 无 jsdom——极简 fake element 桩（textContent/appendChild/append/isConnected/remove 级别）
 * 覆盖 modal 生命周期断言：
 * - 打开捕获 {runId, baseRevision}，保存 PUT 携带 baseRevision，成功后关闭并注销；
 * - 打开后切 run → 保存被拒（不写当前会话），编辑器内提示；
 * - 409 REVISION_CONFLICT → 编辑器内提示「状态已变化，请刷新」，不静默覆盖、不退出；
 * - JSON 解析失败 → 编辑器内报错，不发请求；
 * - 无会话 → notifyError，不挂 modal；
 * - trackModal 注册 → 模拟 runId 变化统一关闭（isConnected 变 false）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openStateEditor, type StateEditorState } from "../web/views/state-editor.js";

// ---------------------------------------------------------------------------
// 极简 fake element 桩（覆盖 state-editor 用到的 DOM 面）
// ---------------------------------------------------------------------------

class FakeEl {
  readonly tag: string;
  className = "";
  textContent = "";
  value = "";
  disabled = false;
  isConnected = false;
  readonly children: FakeEl[] = [];
  onclick: ((e?: unknown) => unknown) | null = null;
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
  const deps = {
    el: fakeEl,
    api: async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
      puts.push({ path, method, body: body as Record<string, unknown> });
      if (options.apiError) throw options.apiError;
      return { note: "已保存，立即生效" };
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
  };
  return { state, mounted, closers, puts, errors, deps };
}

describe("状态编辑器：打开捕获与保存语义", () => {
  it("打开捕获 {runId, baseRevision}；保存 PUT 携带 baseRevision，成功后关闭并注销", async () => {
    const h = harness({ runId: "000001", revision: 7 });
    openStateEditor(h.deps);
    assert.equal(h.mounted.length, 1);
    const overlay = h.mounted[0]!;
    assert.equal(overlay.isConnected, true);
    assert.equal(h.closers.size, 1); // 已注册进统一生命周期
    // 预填 = 打开时的 store 数据（变量两域 + 事件数组）
    const textareas = walk(overlay).filter((n) => n.tag === "textarea");
    assert.equal(textareas.length, 2);
    assert.deepEqual(JSON.parse(textareas[0]!.value), { world: { hp: 1 }, characters: { C1001: { name: "甲" } } });
    assert.deepEqual(JSON.parse(textareas[1]!.value), [{ id: "e1", seq: 1 }]);

    await findByText(overlay, "button", "保存").onclick!();
    assert.equal(h.puts.length, 1);
    assert.equal(h.puts[0]!.path, "/api/session/state");
    assert.equal(h.puts[0]!.method, "PUT");
    assert.equal(h.puts[0]!.body.baseRevision, 7); // 捕获的 baseRevision 上送
    assert.deepEqual(h.puts[0]!.body.world, { hp: 1 });
    assert.equal(overlay.isConnected, false); // 成功关闭
    assert.equal(h.closers.size, 0); // 已注销
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

  it("变量 JSON 非法 → 编辑器内报错，不发请求", async () => {
    const h = harness({ runId: "000001" });
    openStateEditor(h.deps);
    const overlay = h.mounted[0]!;
    walk(overlay).filter((n) => n.tag === "textarea")[0]!.value = "{ 非法";
    await findByText(overlay, "button", "保存").onclick!();
    assert.equal(h.puts.length, 0);
    assert.match(findByClass(overlay, "raw-error").textContent, /变量 JSON 解析失败/);
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
