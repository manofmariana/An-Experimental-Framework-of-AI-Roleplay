/**
 * 测试 builders：最小合法内存对象 + overrides 模式。不写盘、不依赖 fs。
 * 只收 3 处以上文件重复的构造；一次性字面量仍留在各测试本地。
 */
import type { CharacterManifest } from "../../src/agents/character.js";
import { ProjectionBuilder, type ProjectionInput } from "../../src/application/activationContexts.js";
import type { ReaderRef, RenderHost } from "../../src/compile/render.js";
import { TAG_CATEGORIES, SYSTEM_TAG_NAMES } from "../../src/tags/registry.js";
import { ArchiveStore } from "../../src/truth/archive.js";
import { CharactersStore, type CharacterState } from "../../src/truth/charactersStore.js";
import { EventsStore } from "../../src/truth/events.js";
import type { SaveSet } from "../../src/truth/generationRepository.js";
import { LoreStore } from "../../src/truth/loreStore.js";
import { PromptsStore, type PromptsFile } from "../../src/truth/promptsStore.js";
import { SAVE_SCHEMA_VERSION } from "../../src/truth/saveSchema.js";
import type { TruthStores } from "../../src/truth/stores.js";
import { SysStore, type SysFile } from "../../src/truth/sysStore.js";
import { WorldStore } from "../../src/truth/worldStore.js";
import type { Event, LoreEntry } from "../../src/types.js";
import { defaultWorldTimeInstance } from "../../src/vars/systemWorld.js";
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

/** sys 根结构三件套原始形状（SysStore.initial 入参）。 */
export function buildSysStructsRaw(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    tagRegistry: buildTagRegistryRaw(),
    varsTemplate: TEST_VARS_TEMPLATE_RAW,
    varsTags: { world: {}, character: {} },
    ...overrides,
  };
}

/** sys.json 信封（Generation 载荷形状；pipeline 缺省空、计数键归零，overrides 精准覆盖）。 */
export function buildSysFile(overrides?: Record<string, unknown>): SysFile {
  return {
    schema_version: SAVE_SCHEMA_VERSION,
    ...buildSysStructsRaw(),
    cycles_since_gm: 0,
    gm_trigger: false,
    gm_trigger_batch: null,
    pipeline: { seq: 0, working_set: [], current: null },
    ...overrides,
  } as unknown as SysFile;
}

/** world 变量树（纯内容根；缺省 = 仅 time 系统分支代码缺省实例，periods/anchor 可覆盖）。 */
export function buildWorldTree(
  periods?: { key: string; from: number; to: number }[],
  anchor?: { y: number; m: number; d: number; h: number; min: number },
): Record<string, unknown> {
  const tree = defaultWorldTimeInstance();
  if (anchor !== undefined) {
    for (const key of ["y", "m", "d", "h", "min"] as const) {
      (tree as Record<string, unknown>)[key] = { value: anchor[key], tags: [] };
    }
  }
  if (periods !== undefined) {
    (tree as Record<string, unknown>)["periods"] = periods.map((p) => ({
      key: { value: p.key, tags: [] },
      from: { value: p.from, tags: [] },
      to: { value: p.to, tags: [] },
    }));
  }
  return { time: tree };
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
    relations: [],
    vars: {},
    ...overrides,
  };
}

/** 运行时角色状态（characters.json 条目形状；long_term_memory 为状态专有字段）。 */
export function buildCharacterState(overrides?: Partial<CharacterState>): CharacterState {
  return {
    cid: "C0",
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
    relations: [],
    appearance: false,
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

/** 事件（events.json 条目：全字段末端外壳）；id 必填，content 缺省 = `payload-{id}`。 */
export function buildEvent(overrides: { id: string; t?: number; seq?: number; content?: string; tags?: { name: string; level: number }[] }): Event {
  const shell = <T extends string | number>(value: T, tags: { name: string; level: number }[] = []): { value: T; tags: { name: string; level: number }[] } => ({ value, tags });
  return {
    id: shell(overrides.id),
    t: shell(overrides.t ?? 0),
    seq: shell(overrides.seq ?? 1),
    kind: shell("world" as const),
    content: shell(overrides.content ?? `payload-${overrides.id}`, overrides.tags ?? []),
  };
}

/** lore 条目（lores.json 元素：全末端外壳；TAG 挂载全部落在 content 末端）。 */
export function buildLoreEntry(id: string, content: string, tags: { name: string; level: number }[] = []): LoreEntry {
  return { id: { value: id, tags: [] }, content: { value: content, tags } };
}

/** 全内存五根真相 Store（投影层/activation 直构造测试用；characters 缺省 = 仅玩家 C0）。 */
export function buildTruthStores(overrides?: {
  characters?: Record<string, CharacterState>;
  events?: Event[];
  lores?: LoreEntry[];
}): TruthStores {
  const world = new WorldStore(buildWorldTree([{ key: "白天", from: 0, to: 24 }]));
  const sys = new SysStore(buildSysFile());
  const characters = new CharactersStore(overrides?.characters ?? { C0: buildCharacterState({ isPlayer: true }) });
  const events = new EventsStore();
  for (const event of overrides?.events ?? []) events.append(event);
  const archive = new ArchiveStore();
  const loreStore = LoreStore.initFrom(overrides?.lores ?? []);
  const promptsStore = buildPromptsStore();
  return { world, sys, characters, events, archive, loreStore, promptsStore };
}

/** 投影层 RenderHost（activation 渲染/投影取数断言用；input 覆盖合并进 ProjectionInput）。 */
export function buildProjectionHost(
  reader: ReaderRef,
  truth: TruthStores,
  input?: Partial<ProjectionInput>,
): RenderHost {
  return new ProjectionBuilder().for(reader, {
    truth,
    proseWindowTurns: 5,
    ...input,
  });
}

/** 档内提示词文件（prompts.json 载荷形状）：四键齐备、id 与键名一致（空模块列表 + 空占位符目录 = 最小合法）。 */
export function buildPromptsFile(): PromptsFile {
  return {
    templates: {
      character: { id: "character", modules: [] },
      gm: { id: "gm", modules: [] },
      prose: { id: "prose", modules: [] },
      "gm-incident": { id: "gm-incident", modules: [] },
    },
    placeholders: {},
  };
}

/** 最小合法内存 PromptsStore（TruthStores 字面量测试用；不写盘）。 */
export function buildPromptsStore(): PromptsStore {
  return new PromptsStore(buildPromptsFile());
}

/**
 * 整代存档（Generation 七文件载荷）：缺省 = 刚建会话的空档（seq=0、无进行中步、仅玩家 C0），
 * 即可提交态基线；各违规用例用 overrides 精准打破一条。
 */
export function buildSaveSet(overrides?: Partial<SaveSet>): SaveSet {
  return {
    world: buildWorldTree(),
    sys: buildSysFile(),
    characters: { C0: buildCharacterState({ isPlayer: true }) },
    events: [],
    archive: [],
    lores: { entries: [], changelog: [] },
    prompts: buildPromptsFile(),
    ...overrides,
  };
}
