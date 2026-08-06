/**
 * web/views/play-stream.js 玩家卡单元测试（unit 层）：
 * 无 jsdom——极简 fake element 桩（与 webStateEditor.test.ts 同型），覆盖玩家卡同构渲染：
 * - 结构化输入（DecisionPackage JSON）与 NPC 决策卡同一分节渲染
 *  （行动/台词/内心想法/人际关系更新；缺省节不显示），标记 chips 保留，标签"你"区分身份；
 * - 纯文本输入原样显示（player-card-text）；
 * - 寻址与编辑入口：seq > 0 的玩家卡带 data-kind="player"/data-seq 与 "..." 菜单
 *  （原始返回/编辑与 NPC 卡同一入口 edit_result，仅最新步可编辑；回滚同 NPC 语义），
 *  renderHistory 与 appendSelfCard 两条上卡路径均带寻址属性；
 * - onEditedResult 对 kind="player" 原地重渲：卡壳（"你"标签/菜单/#N 徽标）保留，
 *  内容区按编辑后决策包重渲（分节 + 标记 chips）。
 * - renderHistory 突发卡（incident 步）：标题"突发事件"，正文过 renderRefs 身份渲染，
 *  副信息 = 目标地点 + 良恶 + 程度取整；突发步同其他步可编辑/回滚/重 roll（菜单 + 寻址）。
 * - dropCardsFrom 重 roll 乐观清卡：移除 data-seq ≥ seq 的卡片（复合命令的合并
 *   Transition 到达前防新旧双卡并存）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPlayStream } from "../web/views/play-stream.js";

// ---------------------------------------------------------------------------
// 极简 fake element 桩（覆盖 playerCard/菜单/编辑模态/onEditedResult 用到的 DOM 面）
// ---------------------------------------------------------------------------

class FakeEl {
  readonly tag: string;
  className = "";
  dataset: Record<string, string> = {};
  hidden = false;
  disabled = false;
  title = "";
  value = "";
  readOnly = false;
  rows = 0;
  onclick: ((e?: any) => void) | null = null;
  parent: FakeEl | null = null;
  _cardState: any;
  private _text = "";
  readonly children: FakeEl[] = [];
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
    c.parent = this;
    this.children.push(c);
    return c;
  }
  append(...cs: FakeEl[]): void {
    for (const c of cs) c.parent = this;
    this.children.push(...cs);
  }
  replaceWith(node: FakeEl): void {
    const p = this.parent;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i < 0) return;
    node.parent = p;
    p.children[i] = node;
    this.parent = null;
  }
  focus(): void {}
  addEventListener(): void {}
  /** 从父节点摘除（view 的重 roll 乐观清卡用）。 */
  remove(): void {
    const p = this.parent;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    this.parent = null;
  }
  /** 仅支持本 view 使用的属性选择器形态：[data-kind="X"][data-seq="N"] */
  querySelector(selector: string): FakeEl | null {
    const m = /^\[data-kind="([^"]+)"\]\[data-seq="([^"]+)"\]$/.exec(selector);
    if (!m) return null;
    return walk(this).find((n) => n.dataset.kind === m[1] && n.dataset.seq === m[2]) ?? null;
  }
  /** 仅支持 [data-seq] 单属性选择器（view 的重 roll 乐观清卡用；返回静态副本同 DOM NodeList）。 */
  querySelectorAll(selector: string): FakeEl[] {
    if (selector !== "[data-seq]") return [];
    return walk(this).filter((n) => n.dataset.seq !== undefined);
  }
}

function fakeEl(tag: string, className?: string | null, text?: string): FakeEl {
  const node = new FakeEl(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function walk(node: FakeEl): FakeEl[] {
  return [node, ...node.children.flatMap(walk)];
}

/** 卡片内某分节标题对应的内容节点文本（card-title 的兄弟节点）。 */
function sectionTexts(card: FakeEl, title: string): string[] {
  return walk(card)
    .filter((n) => n.className === "card-section" && n.children[0]?.textContent === title)
    .map((n) => n.children[1]?.textContent ?? "");
}

/** 卡片 "..." 菜单的项标签序列。 */
function menuLabels(card: FakeEl): string[] {
  return walk(card)
    .filter((n) => n.className === "menu-item")
    .map((n) => n.textContent);
}

interface StreamOpts {
  pipeline?: { seq: number; kind: string | null };
  sent?: { type: string; fields?: any }[];
}

function makeStream(opts: StreamOpts = {}) {
  const sentCommands = opts.sent ?? [];
  const view = createPlayStream({
    el: fakeEl,
    api: async () => ({}),
    getState: () => ({
      runId: null,
      streaming: null,
      pipeline: opts.pipeline ?? { seq: 0, kind: null },
    }),
    sendCmd: (type: string, fields?: object) => {
      sentCommands.push({ type, fields });
    },
    sendCommand: async (type: string, fields?: object) => {
      sentCommands.push({ type, fields });
      return {};
    },
    trackModal: () => () => {},
    confirm: () => true,
  });
  return { view, sentCommands };
}

const PKG_TEXT = JSON.stringify({
  action: "走向门口",
  dialogue: "等等我。",
  inner: "想跟上甲",
  relations: [{ target: "C1001", name: "林凡", impression: "鞋上有青苔的男人" }],
  markers: [{ type: "leave" }],
});

describe("play-stream 玩家卡（与 NPC 决策卡同一分节渲染）", () => {
  it("结构化输入按决策包分节渲染（行动/台词/内心想法/人际关系更新）+ 标记 chips", () => {
    const { view } = makeStream();
    const card = view.playerCard(PKG_TEXT, 7) as FakeEl;

    assert.equal(card.className, "player-card");
    assert.ok(walk(card).some((n) => n.className === "player-card-label" && n.textContent === "你"));
    assert.deepEqual(sectionTexts(card, "行动"), ["走向门口"]);
    assert.deepEqual(sectionTexts(card, "台词"), ["等等我。"]);
    assert.deepEqual(sectionTexts(card, "内心想法"), ["想跟上甲"]);
    assert.deepEqual(sectionTexts(card, "人际关系更新"), ["C1001 → 名字：林凡 · 印象：鞋上有青苔的男人"]);
    assert.ok(walk(card).some((n) => n.className === "marker-chip" && n.textContent === "离开"));
    assert.ok(walk(card).some((n) => n.className === "seq-badge" && n.textContent === "#7"));
  });

  it("缺省节不显示（无 action/relations 时只有台词与内心）", () => {
    const { view } = makeStream();
    const card = view.playerCard(JSON.stringify({ dialogue: "嗯。", inner: "应付一下" })) as FakeEl;
    assert.deepEqual(sectionTexts(card, "台词"), ["嗯。"]);
    assert.deepEqual(sectionTexts(card, "内心想法"), ["应付一下"]);
    assert.deepEqual(sectionTexts(card, "行动"), []);
    assert.deepEqual(sectionTexts(card, "人际关系更新"), []);
  });

  it("纯文本输入原样显示（player-card-text）", () => {
    const { view } = makeStream();
    const card = view.playerCard("随便说点什么") as FakeEl;
    assert.ok(walk(card).some((n) => n.className === "player-card-text" && n.textContent === "随便说点什么"));
    assert.equal(walk(card).filter((n) => n.className === "card-section").length, 0);
  });
});

describe("play-stream 玩家卡寻址与编辑入口", () => {
  it("seq > 0 的玩家卡带 data-kind=player/data-seq 与 \"...\" 菜单（原始返回/回滚）", () => {
    const { view } = makeStream();
    const card = view.playerCard(PKG_TEXT, 7) as FakeEl;
    assert.equal(card.dataset.kind, "player");
    assert.equal(card.dataset.seq, "7");
    assert.deepEqual(menuLabels(card), ["原始返回", "回滚"]);
  });

  it("无 seq 的玩家卡不带寻址属性与菜单（纯展示）", () => {
    const { view } = makeStream();
    const card = view.playerCard(PKG_TEXT) as FakeEl;
    assert.equal(card.dataset.kind, undefined);
    assert.equal(menuLabels(card).length, 0);
  });

  it("renderHistory 玩家分支带寻址属性与菜单", () => {
    const { view } = makeStream();
    const stream = view.mount() as FakeEl;
    view.renderHistory({
      mode: "full",
      turns: [{ turn: 7, playerInput: PKG_TEXT, characters: [], seqs: { player: 7 } }],
    });
    const card = stream.querySelector('[data-kind="player"][data-seq="7"]');
    assert.ok(card);
    assert.deepEqual(menuLabels(card!), ["原始返回", "回滚"]);
    assert.ok(walk(card!).some((n) => n.className === "seq-badge" && n.textContent === "#7"));
  });

  it("appendSelfCard 即时上卡带寻址属性（seq = 已提交步 + 1）", () => {
    const { view } = makeStream({ pipeline: { seq: 3, kind: "prose" } });
    const stream = view.mount() as FakeEl;
    view.appendSelfCard(PKG_TEXT);
    const card = stream.querySelector('[data-kind="player"][data-seq="4"]');
    assert.ok(card);
    assert.ok(menuLabels(card!).includes("原始返回"));
  });

  it("回滚菜单项发送 rollback 命令（与 NPC 卡同语义）", () => {
    const sent: { type: string; fields?: any }[] = [];
    const { view } = makeStream({ sent });
    const card = view.playerCard(PKG_TEXT, 7) as FakeEl;
    const rollbackItem = walk(card).find((n) => n.className === "menu-item" && n.textContent === "回滚")!;
    rollbackItem.onclick!({ stopPropagation() {} });
    assert.deepEqual(sent, [{ type: "rollback", fields: { targetSeq: 7 } }]);
  });

  it("编辑入口：原始返回模态仅最新步可编辑，保存发送 edit_result", async () => {
    (globalThis as any).document = { body: new FakeEl("body"), querySelectorAll: () => [] };
    try {
      const sent: { type: string; fields?: any }[] = [];
      const { view } = makeStream({ pipeline: { seq: 7, kind: "player" }, sent });
      const card = view.playerCard(PKG_TEXT, 7) as FakeEl;
      const rawItem = walk(card).find((n) => n.className === "menu-item" && n.textContent === "原始返回")!;
      rawItem.onclick!({ stopPropagation() {} });
      const overlay = ((globalThis as any).document.body as FakeEl).children[0]!;
      const editBtn = walk(overlay).find((n) => n.tag === "button" && n.textContent === "编辑")!;
      assert.equal(editBtn.disabled, false); // pipeline 当前步 = 本卡（seq+kind 匹配）
      editBtn.onclick!({ stopPropagation() {} });
      const ta = walk(overlay).find((n) => n.className === "raw-editor")!;
      assert.equal(ta.value, PKG_TEXT); // 编辑种子 = 组装的决策包 JSON
      const saveBtn = walk(overlay).find((n) => n.tag === "button" && n.textContent === "保存")!;
      saveBtn.onclick!({ stopPropagation() {} });
      assert.deepEqual(sent, [{ type: "edit_result", fields: { text: PKG_TEXT } }]);
    } finally {
      delete (globalThis as any).document;
    }
  });

  it("编辑入口：非最新步禁用编辑按钮", () => {
    (globalThis as any).document = { body: new FakeEl("body"), querySelectorAll: () => [] };
    try {
      const { view } = makeStream({ pipeline: { seq: 9, kind: "gm" } });
      const card = view.playerCard(PKG_TEXT, 7) as FakeEl;
      const rawItem = walk(card).find((n) => n.className === "menu-item" && n.textContent === "原始返回")!;
      rawItem.onclick!({ stopPropagation() {} });
      const overlay = ((globalThis as any).document.body as FakeEl).children[0]!;
      const editBtn = walk(overlay).find((n) => n.tag === "button" && n.textContent === "编辑")!;
      assert.equal(editBtn.disabled, true);
    } finally {
      delete (globalThis as any).document;
    }
  });
});

describe("play-stream onEditedResult 玩家步原地重渲", () => {
  const editedPkg = {
    action: "改为坐下",
    dialogue: "你先走。",
    inner: "改主意了",
    markers: [{ type: "confirm" }],
  };
  const editedRaw = JSON.stringify(editedPkg);

  function mountWithHistory() {
    const { view } = makeStream();
    const stream = view.mount() as FakeEl;
    view.renderHistory({
      mode: "full",
      turns: [{ turn: 7, playerInput: PKG_TEXT, characters: [], seqs: { player: 7 } }],
    });
    return { view, stream };
  }

  it("按 data-kind=player/data-seq 寻址并原地重渲（卡壳保留，内容换为编辑后决策包）", () => {
    const { view, stream } = mountWithHistory();
    const before = stream.querySelector('[data-kind="player"][data-seq="7"]')!;
    assert.ok(before);

    view.onEditedResult({ seq: 7, kind: "player", result: { raw: editedRaw, decision: editedPkg } });

    // 同一卡壳原地重渲（不换根节点）："你"标签/菜单/#N 徽标保留
    const after = stream.querySelector('[data-kind="player"][data-seq="7"]')!;
    assert.equal(after, before);
    assert.ok(walk(after).some((n) => n.className === "player-card-label" && n.textContent === "你"));
    assert.ok(walk(after).some((n) => n.className === "seq-badge" && n.textContent === "#7"));
    assert.deepEqual(menuLabels(after), ["原始返回", "回滚"]);
    // 内容区 = 编辑后决策包分节 + 标记 chips（旧内容被替换）
    assert.deepEqual(sectionTexts(after, "行动"), ["改为坐下"]);
    assert.deepEqual(sectionTexts(after, "台词"), ["你先走。"]);
    assert.deepEqual(sectionTexts(after, "内心想法"), ["改主意了"]);
    assert.ok(walk(after).some((n) => n.className === "marker-chip" && n.textContent === "确认"));
    assert.ok(!walk(after).some((n) => n.className === "marker-chip" && n.textContent === "离开"));
    // 卡态 text 同步为编辑后 raw（再次打开编辑模态的种子）
    assert.equal(after._cardState.text, editedRaw);
  });

  it("寻址未命中（无该 seq 玩家卡）静默跳过", () => {
    const { view, stream } = mountWithHistory();
    view.onEditedResult({ seq: 99, kind: "player", result: { raw: editedRaw, decision: editedPkg } });
    const card = stream.querySelector('[data-kind="player"][data-seq="7"]')!;
    assert.deepEqual(sectionTexts(card, "行动"), ["走向门口"]); // 原内容未动
  });
});

describe("play-stream renderHistory 突发卡（incident 步）", () => {
  const incident = {
    seq: 5,
    text: "塔外传来巨响，[[守灯人|@C1001]] 被惊醒",
    location: "灯塔外",
    malignant: true,
    severity: 3.6,
  };

  it("渲染突发卡：标题/正文（renderRefs 身份渲染）/副信息/#N 徽标 + 编辑回滚重 roll 菜单", () => {
    const { view } = makeStream();
    const stream = view.mount() as FakeEl;
    view.renderHistory({
      mode: "full",
      turns: [{ turn: 5, characters: [], seqs: {}, incidents: [incident] }],
    });
    const card = walk(stream).find((n) => n.className === "agent-panel panel-incident");
    assert.ok(card, "突发卡存在");
    assert.ok(walk(card!).some((n) => n.className === "panel-title" && n.textContent === "突发事件"));
    // 正文过 renderRefs：[[守灯人|@C1001]] → 守灯人
    assert.ok(
      walk(card!).some(
        (n) => n.className === "card-action" && n.textContent === "塔外传来巨响，守灯人 被惊醒",
      ),
    );
    // 副信息一行：目标地点 + 良恶 + 程度取整
    assert.ok(
      walk(card!).some(
        (n) => n.className === "card-meta" && n.textContent === "灯塔外 · 恶性 · 程度 4",
      ),
    );
    assert.ok(walk(card!).some((n) => n.className === "seq-badge" && n.textContent === "#5"));
    // 突发步同其他步可编辑/回滚/重 roll：菜单齐全 + editedResult 寻址
    assert.deepEqual(menuLabels(card!), ["原始返回", "回滚", "重 roll"]);
    assert.equal(card!.dataset.kind, "incident");
    assert.equal(card!.dataset.seq, "5");
  });

  it("editedResult 按 data-kind=incident 寻址原地重渲突发文本与 raw 缓存", () => {
    const { view } = makeStream();
    const stream = view.mount() as FakeEl;
    view.renderHistory({
      mode: "full",
      turns: [{ turn: 5, characters: [], seqs: {}, incidents: [incident] }],
    });
    const before = stream.querySelector('[data-kind="incident"][data-seq="5"]')!;
    assert.ok(before);

    view.onEditedResult({
      seq: 5,
      kind: "incident",
      result: { raw: "编辑后 raw", incident: { text: "改后的突发 [[守灯人|@C1001]]", deltas: [] } },
    });

    // 同一卡壳原地重渲：菜单/#N 徽标/副信息保留，事件文本替换（renderRefs 同渲染）
    const after = stream.querySelector('[data-kind="incident"][data-seq="5"]')!;
    assert.equal(after, before);
    assert.ok(
      walk(after).some((n) => n.className === "card-action" && n.textContent === "改后的突发 守灯人"),
    );
    assert.ok(walk(after).some((n) => n.className === "seq-badge" && n.textContent === "#5"));
    assert.equal(after._cardState.raw, "编辑后 raw", "卡态 raw 同步为编辑后（再次打开编辑模态的种子）");
  });

  it("dropCardsFrom 乐观清卡：移除 data-seq ≥ seq 的卡片，其余保留", () => {
    const { view } = makeStream();
    const stream = view.mount() as FakeEl;
    view.renderHistory({
      mode: "full",
      turns: [
        { turn: 4, characters: [], seqs: {}, incidents: [{ ...incident, seq: 4 }] },
        { turn: 5, characters: [], seqs: {}, incidents: [incident] },
      ],
    });
    assert.equal(walk(stream).filter((n) => n.className === "agent-panel panel-incident").length, 2);

    // 重 roll #5：被重 roll 的旧卡立即清除（合并 Transition 到达前不与新流式卡并存）
    view.dropCardsFrom(5);
    const remaining = walk(stream).filter((n) => n.className === "agent-panel panel-incident");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.dataset.seq, "4", "seq < 5 的卡保留");
  });

  it("良性突发标注「良性」；无 incidents 的轮不渲染突发卡", () => {
    const { view } = makeStream();
    const stream = view.mount() as FakeEl;
    view.renderHistory({
      mode: "full",
      turns: [
        { turn: 1, playerInput: "看看四周", characters: [], seqs: { player: 1 } },
        { turn: 5, characters: [], seqs: {}, incidents: [{ ...incident, malignant: false, severity: 1.2 }] },
      ],
    });
    const cards = walk(stream).filter((n) => n.className === "agent-panel panel-incident");
    assert.equal(cards.length, 1);
    assert.ok(
      walk(cards[0]!).some(
        (n) => n.className === "card-meta" && n.textContent === "灯塔外 · 良性 · 程度 1",
      ),
    );
  });
});
