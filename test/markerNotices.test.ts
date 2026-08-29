import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planActorDecision } from "../src/application/actorEffects.js";
import { planGmAdjudication } from "../src/application/gmEffects.js";
import { projectWorkingSet } from "../src/application/workingSetProjection.js";
import type { PlaceholderCatalog } from "../src/compile/placeholders.js";
import { renderPrompt } from "../src/compile/render.js";
import type { PromptTemplate } from "../src/compile/template.js";
import type { TruthStores } from "../src/truth/stores.js";
import {
  isNoticeEntry,
  renderScene,
  type WorkingSetNoticeEntry,
  type WorkingSetSpeechEntry,
} from "../src/truth/workingSet.js";
import { DecisionPackageSchema, type DecisionPackage } from "../src/types.js";
import { buildCharacterState, buildDecision, buildProjectionHost, buildTagsPool, buildTruthStores } from "./builders/index.js";

// ---------------------------------------------------------------------------
// 标记通知注入集成测试（P2-3 出口）：
// gm_request/leave/recall/contact 在标记消费点生成系统通知条目入工作集
// （载荷纯结构化参数、无文本；confirm 是应答本身不生成）；按条目 tags 过滤注入；
// 同 type 固定 ID 复用（后来者居上）；GM 清算即消亡；GM 恒见。
// ---------------------------------------------------------------------------

function decision(overrides?: Record<string, unknown>): DecisionPackage {
  return DecisionPackageSchema.parse(buildDecision(overrides));
}

/** 池 = 附加名 ∪ cid/地点/频道常驻项（与测试模板 union terms 同口径；C1002 异地 loc_B）。 */
function makeTruth(c0Attach: string[] = ["aud", "vis"]): TruthStores {
  return buildTruthStores({
    characters: {
      C0: buildCharacterState({
        isPlayer: true,
        appearance: true,
        vars: { tags: buildTagsPool(c0Attach, { cid: "C0", locationName: "loc", channel: null }) },
      }),
      C1001: buildCharacterState({
        appearance: true,
        vars: { tags: buildTagsPool(["aud", "vis"], { cid: "C1001", locationName: "loc", channel: null }) },
      }),
      C1002: buildCharacterState({
        appearance: true,
        location: { name: "loc_B", level: 1 },
        vars: { tags: buildTagsPool(["aud", "vis"], { cid: "C1002", locationName: "loc_B", channel: null }) },
      }),
    },
  });
}

function noticesOf(truth: TruthStores): WorkingSetNoticeEntry[] {
  return truth.sys.pipeline.working_set.filter(isNoticeEntry);
}

function speechOf(truth: TruthStores): WorkingSetSpeechEntry[] {
  return truth.sys.pipeline.working_set.filter((e): e is WorkingSetSpeechEntry => !isNoticeEntry(e));
}

describe("标记 → 通知条目（消费点生成，载荷纯参数无文本）", () => {
  it("leave：言行条目 + 通知条目（{vis@1}）入工作集；confirm 不生成", () => {
    const truth = makeTruth();
    planActorDecision(truth, { cid: "C1001", pkg: decision({ markers: [{ type: "leave" }] }), rollDice: () => 1 });
    assert.deepEqual(speechOf(truth).map((e) => e.cid), ["C1001"]);
    const notices = noticesOf(truth);
    assert.equal(notices.length, 1);
    assert.deepEqual(notices[0], {
      id: "notice:leave",
      author: "system",
      notice: { type: "leave", actor: "C1001", targets: [] },
      tags: [{ name: "vis", level: 1 }],
    });
    // 载荷纯结构化参数：无文本字段（schema strict 机检 + 键集断言）
    assert.deepEqual(Object.keys(notices[0]!.notice).sort(), ["actor", "targets", "type"]);

    planActorDecision(truth, { cid: "C1002", pkg: decision({ markers: [{ type: "confirm" }] }), rollDice: () => 1 });
    assert.equal(noticesOf(truth).length, 1, "confirm 是应答本身，不生成通知条目");
  });

  it("recall/contact：目标归一化入载荷；contact = 感知 1 级 + 目标 cid 2 级 + 手段 A/V 3 级", () => {
    const truth = makeTruth();
    planActorDecision(truth, {
      cid: "C1001",
      pkg: decision({ markers: [{ type: "recall", target: "@C1002" }] }),
      rollDice: () => 1,
    });
    const recall = noticesOf(truth).find((n) => n.notice.type === "recall")!;
    assert.deepEqual(recall.notice, { type: "recall", actor: "C1001", targets: ["C1002"] });
    assert.deepEqual(recall.tags, [{ name: "vis", level: 1 }]);

    planActorDecision(truth, {
      cid: "C1001",
      pkg: decision({ markers: [{ type: "contact", channel: "电话", targets: ["@C1002"] }] }),
      rollDice: () => 1,
    });
    const contact = noticesOf(truth).find((n) => n.notice.type === "contact")!;
    assert.deepEqual(contact.notice, { type: "contact", actor: "C1001", means: "电话", targets: ["C1002"] });
    assert.deepEqual(contact.tags, [
      { name: "aud", level: 1 },
      { name: "vis", level: 1 },
      { name: "C1002", level: 2 },
      { name: "A", level: 3 },
      { name: "V", level: 3 },
    ]);
  });

  it("同 type 固定 ID 复用：后来者居上（同类型实例复用，昙花一现）", () => {
    const truth = makeTruth();
    planActorDecision(truth, { cid: "C1001", pkg: decision({ markers: [{ type: "leave" }] }), rollDice: () => 1 });
    planActorDecision(truth, { cid: "C1002", pkg: decision({ markers: [{ type: "leave" }] }), rollDice: () => 1 });
    const leaves = noticesOf(truth).filter((n) => n.notice.type === "leave");
    assert.equal(leaves.length, 1, "同 type 通知条目复用固定 ID，只存最新实例");
    assert.equal(leaves[0]!.notice.actor, "C1002");
  });

  it("投影重建（回滚/GM 编辑切片）再生同一批通知条目（与落账逐字节一致）", () => {
    const truth = makeTruth();
    planActorDecision(truth, {
      cid: "C1001",
      pkg: decision({ markers: [{ type: "contact", channel: "电话", targets: ["C1002"] }] }),
      rollDice: () => 1,
    });
    planActorDecision(truth, { cid: "C1002", pkg: decision({ markers: [{ type: "leave" }] }), rollDice: () => 1 });
    const materialized = truth.sys.pipeline.working_set;

    // 同一批步（archive 形态）投影重建
    const steps = [
      {
        kind: "character:C1001",
        result: { decision: decision({ markers: [{ type: "contact", channel: "电话", targets: ["C1002"] }] }) },
      },
      { kind: "character:C1002", result: { decision: decision({ markers: [{ type: "leave" }] }) } },
    ];
    assert.deepEqual(projectWorkingSet(steps, "C0"), materialized);
  });
});

describe("通知条目注入与生命周期", () => {
  const CATALOG: PlaceholderCatalog = {
    scene: {
      description: "当前场景（通知条目注入）",
      source: "working_set",
      segments: [{ kind: "entry", pass: { template: "{working_set.content}" } }],
    },
  };
  const TEMPLATE: PromptTemplate = { id: "t", modules: [{ key: "m", role: "user", content: "{{scene}}" }] };

  function render(cid: string, truth: TruthStores): string {
    const host = buildProjectionHost({ kind: "character", cid }, truth);
    return renderPrompt(TEMPLATE, CATALOG, host)
      .map((message) => message.content)
      .join("\n");
  }

  it("leave 通知按 tags 过滤注入：持 vis 者见、不持者不见；GM 恒见（无读者过滤）", () => {
    const truth = makeTruth();
    planActorDecision(truth, { cid: "C1001", pkg: decision({ markers: [{ type: "leave" }] }), rollDice: () => 1 });
    assert.ok(render("C0", truth).includes("【系统通知】@C1001 离开了当前场景"));
    // 不持 vis 的读者：不放行侧缺省空模板 → 整条丢弃
    const blind = makeTruth([]);
    planActorDecision(blind, { cid: "C1001", pkg: decision({ markers: [{ type: "leave" }] }), rollDice: () => 1 });
    assert.ok(!render("C0", blind).includes("系统通知"));
    // GM 恒见（权重 6 恒过，无需特例）
    assert.ok(renderScene(truth.sys.pipeline.working_set).includes("【系统通知】@C1001 离开了当前场景"));
  });

  it("contact 通知：目标（持频道 + 工具 AV + 自身 cid 归属）见，非同地非目标不见", () => {
    const truth = makeTruth();
    planActorDecision(truth, {
      cid: "C1001",
      pkg: decision({ markers: [{ type: "contact", channel: "电话", targets: ["C1002"] }] }),
      rollDice: () => 1,
    });
    const text = "【系统通知】@C1001 通过「电话」联系 @C1002";
    assert.ok(render("C1002", truth).includes(text), "目标持有频道 → 工具 AV 临时挂载 + cid 归属命中");
    assert.ok(!render("C0", truth).includes(text), "非目标：归属级（目标 cid@2）不满足 → 不放行");
  });

  it("GM 清算即消亡：裁决后工作集（含通知条目）清空", () => {
    const truth = makeTruth();
    planActorDecision(truth, { cid: "C1001", pkg: decision({ markers: [{ type: "leave" }] }), rollDice: () => 1 });
    assert.equal(noticesOf(truth).length, 1);
    let n = 0;
    planGmAdjudication(truth, {
      seq: 1,
      pkg: {
        events: [],
        narrativity: "skip",
        deltas: [],
        durations: [{ cid: "C1001", span: { min: 5 } }],
        location: [],
      },
      roundCids: ["C1001"],
      allocateEventId: () => `evt_${String((n += 1)).padStart(4, "0")}`,
      rollDice: () => 1,
    });
    assert.deepEqual(truth.sys.pipeline.working_set, []);
  });
});
