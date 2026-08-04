/**
 * web/views/play-input.js 单元测试（unit 层）：
 * 无 jsdom——极简 fake element 桩（与 webStateEditor.test.ts 同型），覆盖关系记录区：
 * - 「记录关系…」小表单添加条目（目标选择复用 CID 下拉模式）→ buildPayload 组装进 relations；
 * - name/impression 皆空 → buildPayload 返回 null（契约：至少其一）；
 * - 删除条目 → 不再进包；clearAfterSend 清空条目。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPlayInput } from "../web/views/play-input.js";

// ---------------------------------------------------------------------------
// 极简 fake element 桩（覆盖 play-input 用到的 DOM 面）
// ---------------------------------------------------------------------------

class FakeEl {
  readonly tag: string;
  id = "";
  className = "";
  private _text = "";
  value = "";
  type = "";
  placeholder = "";
  title = "";
  disabled = false;
  readonly children: FakeEl[] = [];
  onclick: ((e?: unknown) => unknown) | null = null;
  oninput: (() => unknown) | null = null;
  onkeydown: ((e?: unknown) => unknown) | null = null;
  constructor(tag: string) {
    this.tag = tag;
  }
  // DOM 语义：读 = 自身文本 + 子孙文本聚合；写 = 清空子节点
  get textContent(): string {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.children.length = 0;
    this._text = v;
  }
  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }
  append(...cs: FakeEl[]): void {
    this.children.push(...cs);
  }
}

function fakeEl(tag: string, className?: string | null, text?: string): FakeEl {
  const node = new FakeEl(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// pauseBar 用 document.createTextNode：桩为 #text 节点
(globalThis as { document?: unknown }).document = {
  createTextNode: (t: string) => {
    const n = new FakeEl("#text");
    n.textContent = t;
    return n;
  },
};

function walk(node: FakeEl): FakeEl[] {
  return [node, ...node.children.flatMap(walk)];
}

function findByText(root: FakeEl, text: string): FakeEl {
  const hit = walk(root).find((n) => n.textContent === text);
  assert.ok(hit, `未找到「${text}」`);
  return hit;
}

function findByPlaceholder(root: FakeEl, placeholder: string): FakeEl {
  const hit = walk(root).find((n) => n.placeholder === placeholder);
  assert.ok(hit, `未找到 placeholder=${placeholder}`);
  return hit;
}

// ---------------------------------------------------------------------------

function makeView() {
  const view = createPlayInput({
    el: fakeEl,
    api: async () => [],
    getCharsIdentity: () => ({ runId: null, worldSetId: "w" }),
    onInputChange: () => {},
    onEnter: () => {},
    onPauseChanged: () => {},
  });
  const root = view.mount() as FakeEl;
  return { view, root };
}

/** 填三块输入使 payload 合法（inner + dialogue），返回 buildPayload 解析结果。 */
function fillBlocks(root: FakeEl): void {
  const dialogue = findByPlaceholder(root, "说出的话…");
  dialogue.value = "你好";
  const inner = findByPlaceholder(root, "内心想法与意图（必填）");
  inner.value = "想打个招呼";
}

/** 经「记录关系…」小表单添加一条目标为 cid 的条目。 */
function addRelation(root: FakeEl, cid: string): void {
  findByText(root, "记录关系…").onclick!();
  const form = walk(root).find((n) => n.className === "marker-form")!;
  const sel = walk(form).find((n) => n.tag === "select")!;
  sel.value = cid;
  findByText(form, "添加").onclick!();
}

describe("play-input 关系记录区（relations 组装进决策包）", () => {
  it("添加条目并填 name/impression → buildPayload 组装 relations（与 NPC 输出契约同构）", () => {
    const { view, root } = makeView();
    fillBlocks(root);
    addRelation(root, "C1001");
    const name = findByPlaceholder(root, "名字（可选）");
    name.value = "林凡";
    name.oninput!();
    const impression = findByPlaceholder(root, "印象（可选）");
    impression.value = "鞋上有青苔的男人";
    impression.oninput!();

    const pkg = JSON.parse(view.buildPayload()!) as {
      inner: string;
      dialogue: string;
      relations?: { target: string; name?: string; impression?: string }[];
    };
    assert.equal(pkg.dialogue, "你好");
    assert.deepEqual(pkg.relations, [{ target: "C1001", name: "林凡", impression: "鞋上有青苔的男人" }]);
  });

  it("条目 name/impression 皆空 → buildPayload 返回 null（挡发送）；删除后恢复合法", () => {
    const { view, root } = makeView();
    fillBlocks(root);
    addRelation(root, "C1001");
    assert.equal(view.buildPayload(), null, "relation 至少需要 name 或 impression");

    // 只填其一即合法
    const impression = findByPlaceholder(root, "印象（可选）");
    impression.value = "沉默的人";
    impression.oninput!();
    const pkg = JSON.parse(view.buildPayload()!) as { relations?: { target: string; impression?: string }[] };
    assert.deepEqual(pkg.relations, [{ target: "C1001", impression: "沉默的人" }]);

    // 删除条目 → 不再进包
    walk(root).find((n) => n.title === "移除关系记录")!.onclick!();
    const pkg2 = JSON.parse(view.buildPayload()!) as { relations?: unknown };
    assert.equal(pkg2.relations, undefined);
  });

  it("clearAfterSend 清空关系记录条目", () => {
    const { view, root } = makeView();
    fillBlocks(root);
    addRelation(root, "C1001");
    const name = findByPlaceholder(root, "名字（可选）");
    name.value = "林凡";
    name.oninput!();
    view.clearAfterSend();
    assert.equal(walk(root).filter((n) => n.className === "relation-row").length, 0);
    fillBlocks(root);
    const pkg = JSON.parse(view.buildPayload()!) as { relations?: unknown };
    assert.equal(pkg.relations, undefined);
  });
});
