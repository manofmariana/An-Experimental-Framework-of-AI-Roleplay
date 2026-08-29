import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadPackPlaceholders, loadPackPrompts } from "../src/application/sessionFactory.js";
import { renderPrompt, type RenderHost } from "../src/compile/render.js";
import { resolveWorldDir } from "../src/config.js";
import type { CharacterState } from "../src/truth/charactersStore.js";
import { buildProjectionHost, buildTruthStores } from "./builders/index.js";

/** 出厂世界包目录（data/assets/baitan/）。 */
const FACTORY_WORLD_DIR = resolveWorldDir();

function state(name: string, cid = "C0"): CharacterState { return { cid, name, gender: "女", age: "26", personality: `${name}性格`, reaction: 5, location: { name: "灯塔", level: 1 }, timer: 10, group: 1, initiative: null, channel: null, acted: false, level: 1, omniscience: 0, isPlayer: false, relations: [], appearance: false, long_term_memory: [`${name}记忆`], systemTags: {}, vars: { hp: 10 } }; }
const states = { C1001: state("林雾", "C1001"), C1002: state("周砚", "C1002") };
const charHost = (selfCid: string, s: Record<string, CharacterState> = states): RenderHost =>
  buildProjectionHost({ kind: "character", cid: selfCid }, buildTruthStores({ characters: s }));

describe("角色快照隔离", () => {
  it("world_snapshot 仅 world JSON；snapshot 仅自己完整状态", () => {
    const host = charHost("C1001");
    const worldSnap = JSON.parse(host.entries("world_snapshot")[0]!.content) as Record<string, unknown>;
    assert.ok("time" in worldSnap && !("C1001" in worldSnap), "world_snapshot 是世界内容 JSON");
    const own = host.entries("snapshot")[0]!.content;
    assert.ok(own.includes("林雾") && own.includes('"hp":10'));
    assert.ok(!own.includes("周砚"));
  });
  it("模板无 persona/voice/cast，固定示例含 action/inner 键", () => {
    const catalog = loadPackPlaceholders(FACTORY_WORLD_DIR);
    const template = loadPackPrompts(FACTORY_WORLD_DIR, catalog).find((tpl) => tpl.id === "character.decision")!;
    const text = renderPrompt(template, catalog, charHost("C1001")).map((message) => message.content).join("\n");
    assert.ok(text.includes('"action"') && text.includes('"inner"'));
    assert.ok(!text.includes("voice_anchor") && !text.includes("演员表"));
    assert.equal("persona" in states.C1001, false);
  });
  it("未知 cid 抛错", () => assert.throws(() => charHost("C9999"), /未知角色/));
});

describe("离场通知与被联系通知占位符（投影层取数）", () => {
  const member = (name: string, overrides: Partial<CharacterState>): CharacterState => ({
    ...state(name), ...overrides,
  });
  const noticeStates: Record<string, CharacterState> = {
    C1001: member("林雾", { group: 0, timer: null, initiative: { value: 25, group: 1 } }), // 本组未结算离开者
    C1002: member("周砚", { group: 1, timer: 0, initiative: { value: 20, group: 1 } }), // 自己（留在组内）
    C1003: member("丙", { group: 0, timer: null, initiative: { value: 9, group: 2 } }), // 别组离开者
    C1004: member("丁", { group: 1, timer: 0, initiative: { value: 10, group: 1 } }), // 普通在组成员
  };
  const noticeHost = (
    s: Record<string, CharacterState> = noticeStates,
    input?: { invitation: { inviter: string; channel: string } },
  ): RenderHost =>
    buildProjectionHost({ kind: "character", cid: "C1002" }, buildTruthStores({ characters: s }), input);

  it("departure_notices：只列本组已离开且未结算的成员，含 recall 提示；无离场成员返回空集", () => {
    const entries = noticeHost().entries("departure_notices");
    const text = entries.map((entry) => entry.content).join("\n");
    assert.ok(
      text.includes('@C1001 离开了当前场景，如果不希望他离开，你可以使用 {"type":"recall","target":"C1001"} 标记召回'),
      `离场通知形如预期：${text}`,
    );
    assert.ok(!text.includes("C1003"), "别组离开者不在本组通知内");
    assert.ok(!text.includes("C1004") && !text.includes("C1002"), "在组成员不出现在离场通知内");
    assert.equal(entries[0]!.owner, "C1001", "条目属主 = 离场成员 CID");
    // 无离场成员 → 空集（模板模块被渲染器丢弃）
    const quiet: Record<string, CharacterState> = {
      C1002: member("周砚", { group: 1, timer: 0 }),
      C1004: member("丁", { group: 1, timer: 0 }),
    };
    assert.deepEqual(noticeHost(quiet).entries("departure_notices"), []);
    // 自己不在组内（单人组）→ 空集
    assert.deepEqual(
      noticeHost({ ...noticeStates, C1002: member("周砚", { group: 0, timer: 0, initiative: null }) }).entries("departure_notices"),
      [],
    );
  });

  it("incoming_contact：待答邀请时给出邀请者与接受/拒绝方式；无待答邀请返回空集", () => {
    const entries = noticeHost(noticeStates, { invitation: { inviter: "C1001", channel: "电话" } }).entries("incoming_contact");
    assert.equal(
      entries[0]!.content,
      '@C1001 正在通过「电话」联系你。接受：输出 {"type":"confirm"} 标记（本轮输出即你的首轮回复）；拒绝：不立标记，在 dialogue 或 action 中说明理由',
    );
    assert.deepEqual(noticeHost().entries("incoming_contact"), []);
  });
});
