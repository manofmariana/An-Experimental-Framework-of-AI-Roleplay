import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planGmAdjudication } from "../src/application/gmEffects.js";
import type { PlaceholderCatalog } from "../src/compile/placeholders.js";
import { renderPrompt } from "../src/compile/render.js";
import type { PromptTemplate } from "../src/compile/template.js";
import { FORCE_OMNISCIENT_TAG } from "../src/tags/registry.js";
import type { TruthStores } from "../src/truth/stores.js";
import {
  appendDirectives,
  directiveEntryOf,
  isDirectiveEntry,
  renderScene,
  renderSpeech,
  WorkingSetEntrySchema,
  type WorkingSetEntry,
} from "../src/truth/workingSet.js";
import { buildAdjudication, buildCharacterState, buildProjectionHost, buildTruthStores } from "./builders/index.js";
import { SessionHarness } from "./harness/session.js";

// ---------------------------------------------------------------------------
// 指令条目（上帝/写作指令，P2-4 出口）：
// 工作集第三条目种类 {id: directive:{mode}, author: 主控 cid, directive:{mode,text},
// tags:[强制全知@7]}；同 mode 固定 ID 复用（后来者居上）；场景/台词渲染跳过；
// 投影读者轴供给（god_directive 仅 GM / writing_directive 仅正文 / 角色恒空，不过 TAG 求值）；
// 当轮一次性：豁免 GM 清算（narrativity ≠ skip），skip 全清，正文步提交清除残留。
// ---------------------------------------------------------------------------

function makeTruth(): TruthStores {
  return buildTruthStores({
    characters: {
      C0: buildCharacterState({ isPlayer: true, appearance: true, vars: { tags: { value: ["aud", "vis"], tags: [] } } }),
      C1001: buildCharacterState({ appearance: true, vars: { tags: { value: ["aud", "vis"], tags: [] } } }),
    },
  });
}

/** 工作集装入一条言行条目 + 两条指令条目（god/writing）。 */
function seedWorkingSet(truth: TruthStores): void {
  truth.sys.setPipeline({
    working_set: appendDirectives(
      [{ cid: "C1001", input: "言行素材" }],
      [directiveEntryOf("god", "上帝指令α", "C0"), directiveEntryOf("writing", "写作指令β", "C0")],
    ),
  });
}

function planGm(truth: TruthStores, narrativity: "full" | "brief" | "skip"): void {
  let n = 0;
  planGmAdjudication(truth, {
    seq: 1,
    pkg: {
      events: [],
      narrativity,
      deltas: [],
      durations: [{ cid: "C1001", span: { min: 5 } }],
      location: [],
    },
    roundCids: ["C1001"],
    allocateEventId: () => `evt_${String((n += 1)).padStart(4, "0")}`,
    rollDice: () => 1,
  });
}

describe("指令条目 schema 与同 mode 固定 ID 复用", () => {
  it("directiveEntryOf：id = directive:{mode}，tags = 强制全知 7 级；schema 接受", () => {
    const entry = directiveEntryOf("god", "起雾", "C0");
    assert.deepEqual(entry, {
      id: "directive:god",
      author: "C0",
      directive: { mode: "god", text: "起雾" },
      tags: [{ name: FORCE_OMNISCIENT_TAG, level: 7 }],
    });
    assert.deepEqual(WorkingSetEntrySchema.parse(entry), entry);
  });

  it("appendDirectives：同 mode 后来者居上，异 mode 互不覆盖，言行/通知条目不受影响", () => {
    const base = appendDirectives(
      [{ cid: "C1001", input: "言行" }],
      [directiveEntryOf("god", "旧上帝", "C0"), directiveEntryOf("writing", "写作", "C0")],
    );
    const merged = appendDirectives(base, [directiveEntryOf("god", "新上帝", "C0")]);
    const directives = merged.filter(isDirectiveEntry);
    assert.equal(directives.length, 2, "god 复用固定 ID，writing 不动");
    assert.equal(directives.find((d) => d.directive.mode === "god")!.directive.text, "新上帝");
    assert.equal(merged.length, 3, "言行条目保留");
    assert.ok(isDirectiveEntry(merged[2]!) && merged[2]!.id === "directive:god", "先摘后附：复用条目落尾部");
  });

  it("场景/台词渲染跳过指令条目（上帝指令不泄进 sceneText/正文取材）", () => {
    const truth = makeTruth();
    seedWorkingSet(truth);
    const entries = truth.sys.pipeline.working_set;
    assert.ok(renderScene(entries).includes("言行素材"));
    assert.ok(!renderScene(entries).includes("指令"), "renderScene 跳过指令条目");
    assert.ok(renderSpeech(entries).includes("言行素材"));
    assert.ok(!renderSpeech(entries).includes("指令"), "renderSpeech 跳过指令条目");
  });
});

describe("投影读者轴供给（第四面墙 = 读者维度，不过 TAG 求值）", () => {
  const CATALOG: PlaceholderCatalog = {
    god: {
      description: "上帝指令",
      source: "god_directive",
      segments: [{ kind: "entry", identity: false, pass: { template: "{god_directive.content}" } }],
    },
    writing: {
      description: "写作指令",
      source: "writing_directive",
      segments: [{ kind: "entry", identity: false, pass: { template: "{writing_directive.content}" } }],
    },
  };
  const TEMPLATE: PromptTemplate = {
    id: "t",
    modules: [
      { key: "g", role: "user", content: "G:{{god}}" },
      { key: "w", role: "user", content: "W:{{writing}}" },
    ],
  };

  function render(reader: Parameters<typeof buildProjectionHost>[0], truth: TruthStores): string {
    return renderPrompt(TEMPLATE, CATALOG, buildProjectionHost(reader, truth))
      .map((m) => m.content)
      .join("\n");
  }

  it("GM 见上帝指令不见写作指令；正文见写作指令不见上帝指令；角色两者皆无", () => {
    const truth = makeTruth();
    seedWorkingSet(truth);
    const gm = render({ kind: "gm" }, truth);
    assert.ok(gm.includes("上帝指令α"));
    assert.ok(!gm.includes("写作指令β"));
    const prose = render({ kind: "prose" }, truth);
    assert.ok(prose.includes("写作指令β"));
    assert.ok(!prose.includes("上帝指令α"));
    const character = render({ kind: "character", cid: "C1001" }, truth);
    assert.ok(!character.includes("指令"), "角色读者恒空（空渲染模块整条丢弃）");
  });
});

describe("指令条目生命周期（当轮一次性）", () => {
  it("GM 清算豁免：narrativity ≠ skip 时保留指令条目、清空言行/通知条目", () => {
    const truth = makeTruth();
    seedWorkingSet(truth);
    planGm(truth, "brief");
    const rest = truth.sys.pipeline.working_set;
    assert.equal(rest.length, 2);
    assert.ok(rest.every(isDirectiveEntry), "指令条目豁免 GM 清算");
  });

  it("narrativity = skip（无正文步）：指令条目随工作集全清", () => {
    const truth = makeTruth();
    seedWorkingSet(truth);
    planGm(truth, "skip");
    assert.deepEqual(truth.sys.pipeline.working_set, []);
  });
});

// ---------------------------------------------------------------------------
// 全链（SessionHarness + fake ChatPort）：一轮内三指令注入位置
// ---------------------------------------------------------------------------

describe("三指令注入位置全链（fake ChatPort 逐 agent 捕获 messages）", () => {
  it("GM 含玩家言行与上帝指令、不含写作指令；正文含玩家言行与写作指令、不含上帝指令；角色两者皆无；正文步提交后指令条目已清除", async () => {
    const h = new SessionHarness();
    const worldId = `w-directive-${process.pid}`;
    h.setupWorld(worldId, [
      { id: "C0", name: "玩家", location: "loc_A", timer: 0, isPlayer: true },
      { id: "C1001", name: "甲", location: "loc_A", timer: 0 },
    ]);
    // 骰子：先攻 2（C0=5、C1001=20 → C1001 先动）→ GM 前良恶/程度 4 → 正文后突发评估 1（100 = 恒不命中）
    const runId = `run-directive-${process.pid}`;
    const session = h.makeSession(runId, worldId, {
      dice: [5, 20, 50, 50, 50, 50, 100, 100],
      gmIntervalCycles: 2,
      gm: [
        buildAdjudication({
          narrativity: "full",
          durations: [
            { cid: "C0", span: { min: 5 } },
            { cid: "C1001", span: { min: 5 } },
          ],
        }),
      ],
    });

    // 周期 1：C1001 行动（seq1）→ 停等玩家
    await session.continuePipeline();
    assert.equal(session.pipelineInfo.phase, "await_player");

    // 指令提交（等玩家位受理）：上帝 + 写作
    session.submitDirective("god", "上帝指令α");
    session.submitDirective("writing", "写作指令β");

    // 玩家行动（seq2）→ X=1 未达阈值 → C1001 第二周期（seq3，指令条目仍在工作集）→ 停等
    await session.handlePlayerInput("玩家发言一");
    const charCall = h.callsText("character:C1001", 3);
    assert.ok(!charCall.includes("上帝指令α") && !charCall.includes("写作指令β"), "角色 activation 两者皆无");

    // 玩家行动（seq4）→ X=2 达阈值 → GM（seq5）→ 正文（seq6）
    await session.handlePlayerInput("玩家发言二");
    const gmCall = h.callsText("gm", 5);
    assert.ok(gmCall.includes("玩家发言"), "GM 见玩家言行");
    assert.ok(gmCall.includes("上帝指令α"), "GM 见上帝指令");
    assert.ok(!gmCall.includes("写作指令β"), "GM 不见写作指令");
    const proseCall = h.callsText("prose", 6);
    assert.ok(proseCall.includes("玩家发言"), "正文见玩家言行（台词+内心）");
    assert.ok(proseCall.includes("写作指令β"), "正文见写作指令");
    assert.ok(!proseCall.includes("上帝指令α"), "正文不见上帝指令");

    // 正文步提交后：工作集指令条目已清除（本轮言行已清算；续跑新周期 C1001 的言行条目是下一轮素材）
    const ws = JSON.parse(JSON.stringify(session.snapshot().sys.pipeline.working_set)) as WorkingSetEntry[];
    assert.equal(ws.filter(isDirectiveEntry).length, 0, "正文步提交后指令条目已清除");
    assert.ok(!ws.some((e) => !isDirectiveEntry(e) && "cid" in e && e.cid === "C0"), "本轮玩家言行已随 GM 清算");
  });
});
