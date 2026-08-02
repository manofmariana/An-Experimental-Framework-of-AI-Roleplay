import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHARACTER_PLACEHOLDERS, type CharacterContext } from "../src/agents/character.js";
import { compilePrompt } from "../src/compile/compiler.js";
import { loadTemplate } from "../src/compile/template.js";
import type { CharacterState } from "../src/truth/charactersStore.js";

function state(name: string): CharacterState { return { name, gender: "女", age: "26", personality: `${name}性格`, tags: [], reaction: 5, location: { name: "灯塔", level: 1 }, timer: 10, group: 1, initiative: null, channel: null, acted: false, level: 1, isPlayer: false, relations: {}, long_term_memory: [`${name}记忆`], vars: { hp: 10 } }; }
const states = { C1001: state("林雾"), C1002: state("周砚") };
const ctx = (selfCid: string): CharacterContext => ({ selfCid, states, cast: [], worldSnapshot: '{"time":{"y":3}}', activatedLore: "lore", recentEvents: [], proseWindow: [], currentScene: "##@C0", timeHeader: "3年1月1日", clock: 0 });

describe("角色快照隔离", () => {
  it("world_snapshot 仅 world JSON；character_snapshot 仅自己完整状态", () => {
    assert.equal(CHARACTER_PLACEHOLDERS.world_snapshot!.provide(ctx("C1001")), '{"time":{"y":3}}');
    const own = CHARACTER_PLACEHOLDERS.character_snapshot!.provide(ctx("C1001"));
    assert.ok(own.includes("林雾") && own.includes('"hp":10')); assert.ok(!own.includes("周砚"));
  });
  it("模板无 persona/voice/cast，固定示例含 action/inner 键", () => {
    const template = loadTemplate("character", Object.keys(CHARACTER_PLACEHOLDERS)); const text = compilePrompt(template, CHARACTER_PLACEHOLDERS, ctx("C1001")).map((message) => message.content).join("\n");
    assert.ok(text.includes('"action"') && text.includes('"inner"'));
    assert.ok(!text.includes("voice_anchor") && !text.includes("演员表"));
    assert.equal("persona" in states.C1001, false);
  });
  it("未知 cid 抛错", () => assert.throws(() => CHARACTER_PLACEHOLDERS.character_snapshot!.provide(ctx("C9999")), /未知角色/));
});

describe("离场通知与被联系通知占位符", () => {
  const LEAVE_TIMER = Number.MAX_SAFE_INTEGER;
  const member = (name: string, overrides: Partial<CharacterState>): CharacterState => ({
    ...state(name), ...overrides,
  });
  const noticeStates: Record<string, CharacterState> = {
    C1001: member("林雾", { group: 0, timer: LEAVE_TIMER, initiative: { value: 25, group: 1 } }), // 本组未结算离开者
    C1002: member("周砚", { group: 1, timer: 0, initiative: { value: 20, group: 1 } }), // 自己（留在组内）
    C1003: member("丙", { group: 0, timer: LEAVE_TIMER, initiative: { value: 9, group: 2 } }), // 别组离开者
    C1004: member("丁", { group: 1, timer: 0, initiative: { value: 10, group: 1 } }), // 普通在组成员
  };
  const noticeCtx = (overrides: Partial<CharacterContext>): CharacterContext => ({
    selfCid: "C1002", states: noticeStates, cast: [], worldSnapshot: "{}", activatedLore: "",
    recentEvents: [], proseWindow: [], currentScene: "", timeHeader: "", clock: 0, ...overrides,
  });

  it("departure_notices：只列本组已离开且未结算的成员，含 recall 提示；无离场成员返回空串", () => {
    const text = CHARACTER_PLACEHOLDERS.departure_notices!.provide(noticeCtx({}));
    assert.ok(
      text.includes('@C1001 离开了当前场景，如果不希望他离开，你可以使用 {"type":"recall","target":"C1001"} 标记召回'),
      `离场通知形如预期：${text}`,
    );
    assert.ok(!text.includes("C1003"), "别组离开者不在本组通知内");
    assert.ok(!text.includes("C1004") && !text.includes("C1002"), "在组成员不出现在离场通知内");
    // 无离场成员 → 空串（模板模块被编译器丢弃）
    const quiet: Record<string, CharacterState> = {
      C1002: member("周砚", { group: 1, timer: 0 }),
      C1004: member("丁", { group: 1, timer: 0 }),
    };
    assert.equal(CHARACTER_PLACEHOLDERS.departure_notices!.provide(noticeCtx({ states: quiet })), "");
    // 自己不在组内（单人组）→ 空串
    assert.equal(
      CHARACTER_PLACEHOLDERS.departure_notices!.provide(noticeCtx({ states: { ...noticeStates, C1002: member("周砚", { group: 0, timer: 0, initiative: null }) } })),
      "",
    );
  });

  it("incoming_contact：待答邀请时给出邀请者与接受/拒绝方式；无待答邀请返回空串", () => {
    const text = CHARACTER_PLACEHOLDERS.incoming_contact!.provide(
      noticeCtx({ incomingContact: { inviter: "C1001", channel: "电话" } }),
    );
    assert.equal(
      text,
      '@C1001 正在通过「电话」联系你。接受：输出 {"type":"confirm"} 标记（本轮输出即你的首轮回复）；拒绝：不立标记，在 dialogue 或 action 中说明理由',
    );
    assert.equal(CHARACTER_PLACEHOLDERS.incoming_contact!.provide(noticeCtx({ incomingContact: null })), "");
    assert.equal(CHARACTER_PLACEHOLDERS.incoming_contact!.provide(noticeCtx({})), "");
  });
});
