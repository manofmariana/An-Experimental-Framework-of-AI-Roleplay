import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildHistory,
  lastProse,
  participantTags,
  proseWindow,
  proseWindowFor,
  proseWindowForRound,
} from "../src/application/historyProjection.js";
import type { ArchiveEntry } from "../src/truth/archive.js";
import type { Event } from "../src/types.js";

const decision = {
  action: "打量来人",
  inner: "先观察来人的身份与目的。",
  dialogue: "雾大，路滑。",
};
const adjudication = {
  events: [{ text: "@C1001 打量 @C0，神色戒备", tags: ["known_by:C0", "known_by:C1001"], location: "灯塔" }],
  narrativity: "full" as const,
  deltas: [],
  durations: [
    { cid: "C0", span: { min: 5 } },
    { cid: "C1001", span: { min: 5 } },
  ],
  location: [],
};

function step(seq: number, kind: string, result: unknown): ArchiveEntry {
  return { seq, kind, result, changes: { setup: [], effects: [] } };
}

/** 含玩家的完整轮：player → character:C1001 → gm → prose。 */
function round(seq0: number, prose: string): ArchiveEntry[] {
  return [
    step(seq0, "player", { input: `输入${seq0}` }),
    step(seq0 + 1, "character:C1001", { raw: "…", decision }),
    step(seq0 + 2, "gm", { raw: "…", adjudication, round_scenes: { C0: 1, C1001: 1 } }),
    step(seq0 + 3, "prose", {
      raw: prose,
      prose,
      participants: ["C0", "C1001"],
      scenes: { C0: 1, C1001: 1 },
    }),
  ];
}

function evt(id: string, payload: string): Event {
  return { id, t: 0, seq: 1, kind: "world", tags: ["known_by:C0"], payload };
}

describe("buildHistory（按轮分组——一轮 = 若干 actor 步 + gm 步（+prose 步））", () => {
  it("完整轮：玩家输入/角色卡/裁决/正文按轮归位，turn = 本轮首步 seq", () => {
    const archive = [...round(1, "正文一"), ...round(5, "正文二")];
    const h = buildHistory([], archive, null);
    assert.equal(h.mode, "full");
    if (h.mode !== "full") return;
    assert.equal(h.turns.length, 2);
    assert.equal(h.turns[0]!.turn, 1);
    assert.equal(h.turns[1]!.turn, 5);
    assert.equal(h.turns[0]!.playerInput, "输入1");
    assert.equal(h.turns[1]!.prose, "正文二");
    assert.equal(h.turns[0]!.characters.length, 1);
    assert.equal(h.turns[0]!.characters[0]!.cid, "C1001");
    assert.equal(h.turns[0]!.characters[0]!.decision?.dialogue, "雾大，路滑。");
    assert.deepEqual(h.turns[0]!.seqs, { player: 1, gm: 3, prose: 4 });
  });

  it("NPC 独立轮：无玩家步也成一轮；一轮多角色卡按行动序排列", () => {
    const archive = [
      step(1, "character:C1001", { raw: "…", decision }),
      step(2, "character:C1002", { raw: "…", decision }),
      step(3, "gm", { raw: "…", adjudication }),
      step(4, "prose", { raw: "正文一", prose: "正文一" }),
    ];
    const h = buildHistory([], archive, null);
    assert.equal(h.mode, "full");
    if (h.mode !== "full") return;
    assert.equal(h.turns.length, 1);
    const t = h.turns[0]!;
    assert.equal(t.playerInput, undefined);
    assert.deepEqual(t.characters.map((c) => c.cid), ["C1001", "C1002"]);
    assert.deepEqual(t.seqs, { gm: 3, prose: 4 });
  });

  it("narrativity=skip（gm 后无 prose）：gm 步即闭合一轮", () => {
    const archive = [
      step(1, "player", { input: "输入1" }),
      step(2, "gm", { raw: "…", adjudication: { ...adjudication, narrativity: "skip" as const } }),
      step(3, "character:C1002", { raw: "…", decision }),
      step(4, "gm", { raw: "…", adjudication }),
    ];
    const h = buildHistory([], archive, null);
    assert.equal(h.mode, "full");
    if (h.mode !== "full") return;
    assert.equal(h.turns.length, 2);
    assert.equal(h.turns[0]!.turn, 1);
    assert.equal(h.turns[0]!.prose, undefined);
    assert.equal(h.turns[1]!.turn, 3);
  });

  it("进行中的步骤（current）并入最后一轮", () => {
    const archive = round(1, "正文一").slice(0, 3); // player/character/gm 已归档
    const current = { seq: 4, kind: "prose", result: { raw: "正文一", prose: "正文一" } };
    const h = buildHistory([], archive, current);
    assert.equal(h.mode, "full");
    if (h.mode !== "full") return;
    assert.equal(h.turns.length, 1);
    assert.equal(h.turns[0]!.prose, "正文一");
  });

  it("无判定轮跨周期：一轮内多个玩家步各自成组，玩家卡不被覆盖吞并", () => {
    const archive = [
      step(1, "character:C1001", { raw: "…", decision }),
      step(2, "player", { input: "输入2" }),
      step(3, "character:C1001", { raw: "…", decision }),
      step(4, "player", { input: "输入4" }),
      step(5, "character:C1001", { raw: "…", decision }),
    ];
    const h = buildHistory([], archive, null);
    assert.equal(h.mode, "full");
    if (h.mode !== "full") return;
    assert.equal(h.turns.length, 2, "第二个玩家步开启新组");
    assert.equal(h.turns[0]!.playerInput, "输入2");
    assert.equal(h.turns[0]!.seqs.player, 2);
    assert.deepEqual(h.turns[0]!.characters.map((c) => c.seq), [1, 3]);
    assert.equal(h.turns[1]!.playerInput, "输入4");
    assert.equal(h.turns[1]!.seqs.player, 4);
    assert.deepEqual(h.turns[1]!.characters.map((c) => c.seq), [5]);
  });

  it("无归档（空档）：从事件集构建简化历史", () => {
    const h = buildHistory([evt("e1", "@C1001 对 @C0 说：\"你好\"")], [], null);
    assert.equal(h.mode, "simple");
    if (h.mode !== "simple") return;
    assert.equal(h.events[0]!.payload, "@C1001 对 @C0 说：\"你好\"");
  });

  it("interrupted character 历史卡保留 raw 且不要求 decision", () => {
    const h = buildHistory([], [], {
      seq: 1,
      kind: "character:C1001",
      result: { raw: "半截 JSON" },
      interrupted: true,
      changes: { setup: [], effects: [] },
    });
    assert.equal(h.mode, "full");
    if (h.mode !== "full") return;
    assert.deepEqual(h.turns[0]!.characters[0], {
      cid: "C1001",
      seq: 1,
      raw: "半截 JSON",
      interrupted: true,
    });
  });

  it("Web 历史渲染对缺失 decision 的 interrupted character 使用安全占位", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.join(process.cwd(), "web/views/play-stream.js"), "utf8");
    assert.match(source, /if \(character\.decision\)[\s\S]*character\.interrupted/);
  });
});

describe("proseWindow / lastProse（从 archive.json 现取）", () => {
  const archive = [...round(1, "正文一"), ...round(5, "正文二"), ...round(9, "正文三")];

  it("最近 n 轮已发布正文（原文，无包装）", () => {
    assert.deepEqual(proseWindow(archive, 2), ["正文二", "正文三"]);
    assert.deepEqual(proseWindow(archive, 0), []);
  });

  it("lastProse：上一轮正文；空档为空串", () => {
    assert.equal(lastProse(archive), "正文三");
    assert.equal(lastProse([]), "");
  });

  it("角色滑窗按参与者与连续场景过滤，GM 同样不接收其他组正文", () => {
    const mixed: ArchiveEntry[] = [
      step(1, "prose", {
        raw: "灯塔正文",
        prose: "灯塔正文",
        participants: ["C0", "C1001"],
        scenes: { C0: 1, C1001: 1 },
      }),
      step(2, "prose", {
        raw: "酒馆正文",
        prose: "酒馆正文",
        participants: ["C1002"],
        scenes: { C1002: 0 },
      }),
      step(3, "prose", {
        raw: "周砚上一轮正文",
        prose: "周砚上一轮正文",
        participants: ["C1002"],
        scenes: { C1002: 0 },
      }),
    ];
    assert.deepEqual(proseWindowFor(mixed, "C1002", 0, 5), ["酒馆正文", "周砚上一轮正文"]);
    assert.deepEqual(proseWindowFor(mixed, "C1002", 2, 5), []);
    assert.deepEqual(proseWindowForRound(mixed, { C1002: 0 }, 5), ["酒馆正文", "周砚上一轮正文"]);
  });
});

describe("participantTags（lore 触发制输入）", () => {
  it("并集去重", () => {
    assert.deepEqual(
      participantTags([{ tags: ["a", "b"] }, { tags: ["b", "c"] }]).sort(),
      ["a", "b", "c"],
    );
  });
});
