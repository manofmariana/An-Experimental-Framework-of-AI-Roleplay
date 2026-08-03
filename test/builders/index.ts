/**
 * 测试 builders：最小合法内存对象 + overrides 模式。不写盘、不依赖 fs。
 * 只收 3 处以上文件重复的构造；一次性字面量仍留在各测试本地。
 */
import type { CharacterManifest } from "../../src/agents/character.js";
import type { CharacterState } from "../../src/truth/charactersStore.js";
import type { Event } from "../../src/types.js";

/**
 * 角色 manifest（世界设定集 characters/*.json 与 player.json 的统一形状）。
 * id 必填；name 缺省 = id；personality 缺省 "谨慎。"。
 */
export function buildManifest(overrides: Partial<CharacterManifest> & { id: string }): CharacterManifest {
  return {
    name: overrides.id,
    gender: "未设定",
    age: "未设定",
    personality: "谨慎。",
    initial_memories: [],
    location: { name: "loc_A", level: 1 },
    tags: [],
    reaction: 5,
    timer: 0,
    group: 0,
    initiative: null,
    channel: null,
    acted: false,
    level: 1,
    isPlayer: false,
    relations: {},
    vars: {},
    ...overrides,
  };
}

/** 运行时角色状态（characters.json 条目形状；long_term_memory 为状态专有字段）。 */
export function buildCharacterState(overrides?: Partial<CharacterState>): CharacterState {
  return {
    name: "某人",
    gender: "未设定",
    age: "未设定",
    personality: "谨慎。",
    tags: [],
    reaction: 5,
    location: { name: "loc", level: 1 },
    timer: 100,
    group: 0,
    initiative: null,
    channel: null,
    acted: false,
    level: 1,
    isPlayer: false,
    relations: {},
    long_term_memory: [],
    vars: {},
    ...overrides,
  };
}

/** 角色决策包（fake LLM 脚本队列的 JSON 形状；inner 必填，action/dialogue 至少其一）。 */
export function buildDecision(overrides?: Record<string, unknown>): Record<string, unknown> {
  return { action: "行动", inner: "内心", ...overrides };
}

/** GM 裁决包 v2（fake LLM gmQueue 的 JSON 形状；events/narrativity/deltas/timer/location 五键齐全）。 */
export function buildAdjudication(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    events: [{ text: "GM事件", tags: [] }],
    narrativity: "skip",
    deltas: [],
    timer: [],
    location: [],
    ...overrides,
  };
}

/** 事件（events.json 条目）；id 必填，payload 缺省 = `payload-{id}`。 */
export function buildEvent(overrides: Partial<Event> & { id: string }): Event {
  return {
    t: 0,
    seq: 1,
    kind: "world",
    tags: [],
    payload: `payload-${overrides.id}`,
    ...overrides,
  };
}
