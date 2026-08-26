/**
 * 测试 builders：最小合法内存对象 + overrides 模式。不写盘、不依赖 fs。
 * 只收 3 处以上文件重复的构造；一次性字面量仍留在各测试本地。
 */
import type { CharacterManifest } from "../../src/agents/character.js";
import { TAG_CATEGORIES, SYSTEM_TAG_NAMES } from "../../src/tags/registry.js";
import type { CharacterState } from "../../src/truth/charactersStore.js";
import type { SaveSet } from "../../src/truth/generationRepository.js";
import { SAVE_SCHEMA_VERSION } from "../../src/truth/saveSchema.js";
import type { Event } from "../../src/types.js";
import { parseVarsTemplate, type VarsTemplate } from "../../src/vars/template.js";

/**
 * 测试变量模板原始形状：world 根 children 覆盖测试用到的世界变量
 * （region.fog/region.harbor.fog/omen/A/hp/fresh）；character 根 = attachtags
 * （固有 TAG 末端，string_list 纯名集合）+ tags（string_list 池，union_attach
 * 空 paths = 仅自身 attachtags）。
 */
export const TEST_VARS_TEMPLATE_RAW = {
  world: {
    children: {
      region: { children: { fog: "boolean", harbor: { children: { fog: "boolean" } } } },
      omen: "number",
      A: "number",
      hp: "number",
      fresh: "number",
    },
  },
  character: {
    children: {
      attachtags: "string_list",
      tags: { valueType: "string_list", formula: { op: "union_attach", paths: [] as string[] } },
    },
  },
};

/** 解析后的测试变量模板（fromManifests/ensurePlayer 的 character 根声明入参）。 */
export function buildVarsTemplate(): VarsTemplate {
  return parseVarsTemplate(TEST_VARS_TEMPLATE_RAW);
}

/** system 类别条目（cid/channel/location）的中文描述（世界包 tags.json 同文）。 */
const CATEGORY_ENTRY_DESCRIPTIONS: Record<string, string> = {
  cid: "角色 CID 开放类别（实例 = 现存角色 CID，实例合法性程序判定、不登记实例值）",
  channel: "频道开放类别（实例集运行期派生，写值时类别已声明即放行）",
  location: "地点开放类别（实例集运行期派生，写值时类别已声明即放行）",
};

/** system 条目的 TAG 注册表原始形状（与 SYSTEM_TAG_NAMES 双向一致；类别条目带同名 category）。 */
export function buildTagRegistryRaw(): Record<string, unknown> {
  return Object.fromEntries(
    SYSTEM_TAG_NAMES.map((name) => [
      name,
      (TAG_CATEGORIES as readonly string[]).includes(name)
        ? { name, system: true, category: name, description: CATEGORY_ENTRY_DESCRIPTIONS[name] }
        : { name, system: true },
    ]),
  );
}

/** 档内 `_sys` 程序分支原始形状（WorldStore.initial 入参；计数键初始 0/false/null）。 */
export function buildWorldSysRaw(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    tagRegistry: buildTagRegistryRaw(),
    varsTemplate: TEST_VARS_TEMPLATE_RAW,
    varsTags: { world: {}, character: {} },
    cycles_since_gm: 0,
    gm_trigger: false,
    gm_trigger_batch: null,
    ...overrides,
  };
}

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
    reaction: 5,
    timer: 0,
    group: 0,
    initiative: null,
    channel: null,
    acted: false,
    level: 1,
    omniscience: 0,
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
    reaction: 5,
    location: { name: "loc", level: 1 },
    timer: 100,
    group: 0,
    initiative: null,
    channel: null,
    acted: false,
    level: 1,
    omniscience: 0,
    isPlayer: false,
    relations: {},
    long_term_memory: [],
    systemTags: {},
    vars: {},
    ...overrides,
  };
}

/** 角色决策包（fake LLM 脚本队列的 JSON 形状；inner 必填，action/dialogue 至少其一）。 */
export function buildDecision(overrides?: Record<string, unknown>): Record<string, unknown> {
  return { action: "行动", inner: "内心", ...overrides };
}

/** GM 裁决包 v2（fake LLM gmQueue 的 JSON 形状；events/narrativity/deltas/durations/location 五键齐全）。 */
export function buildAdjudication(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    events: [{ text: "GM事件", tags: [] }],
    narrativity: "skip",
    deltas: [],
    durations: [],
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

const SAVE_SET_START = { y: 0, m: 1, d: 1, h: 6, min: 0 };

/**
 * 整代存档（Generation 六文件载荷）：缺省 = 刚建会话的空档（seq=0、无进行中步、仅玩家 C0），
 * 即可提交态基线；各违规用例用 overrides 精准打破一条。
 */
export function buildSaveSet(overrides?: Partial<SaveSet>): SaveSet {
  return {
    world: { time: SAVE_SET_START, _sys: buildWorldSysRaw() },
    pipeline: { seq: 0, working_set: [], current: null },
    characters: { C0: buildCharacterState({ isPlayer: true }) },
    events: [],
    archive: [],
    lore: { schema_version: SAVE_SCHEMA_VERSION, entries: [], changelog: [] },
    time: { schema_version: SAVE_SCHEMA_VERSION, start: SAVE_SET_START, periods: [{ key: "白天", from: 6, to: 18 }] },
    ...overrides,
  };
}
