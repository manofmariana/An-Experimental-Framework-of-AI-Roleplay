/**
 * 会话装配工厂：
 * 给定 configs/runId/options/worldSetId → 装配好的 GameSession 内核实例。
 * 职责 = ChatPort/adapter 装配、提示词模板启动校验、世界设定集读取、存档
 * meta.json（world_set）读写、六真相 Store 初始/续档装载、无状态 activation 装配
 * （三个 activation 各持对应 kind 的 ChatPort；上下文由 builder 逐调用现算）。
 * 命令串行/会话切换在 sessionCoordinator.ts；内核步编排在 gameSession.ts。
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CHARACTER_PLACEHOLDERS,
  CharacterActivation,
  CharacterManifestSchema,
  type CharacterManifest,
} from "../agents/character.js";
import { GM_PLACEHOLDERS, GmActivation } from "../agents/gm.js";
import { PROSE_PLACEHOLDERS, ProseActivation } from "../agents/prose.js";
import { loadTemplate } from "../compile/template.js";
import {
  AGENT_KINDS,
  CONFIG_FILE,
  DEFAULT_GM_INTERVAL_CYCLES,
  DEFAULT_PROSE_WINDOW_TURNS,
  DEFAULT_WORLD_SET,
  SAVE_DIR,
  resolveWorldDir,
  runDir,
  type AgentKind,
  type LLMConfig,
} from "../config.js";
import type { UserSettings } from "../contracts/config.js";
import type { Display } from "../display.js";
import { CallLogChatPort } from "../llm/callLog.js";
import type { ChatPort } from "../llm/chatPort.js";
import { OpenAIChatAdapter } from "../llm/openaiChatAdapter.js";
import { defaultDice, type DicePort } from "../ports.js";
import { resolveUserDirectories } from "../resources/userDirectories.js";
import { packPromptsDir } from "../resources/worldRepository.js";
import { safeSegment } from "../shared/safeSegment.js";
import { ArchiveStore } from "../truth/archive.js";
import { CharactersStore } from "../truth/charactersStore.js";
import { EventsStore } from "../truth/events.js";
import { GenerationRepository } from "../truth/generationRepository.js";
import { Lorebook } from "../truth/lorebook.js";
import { LoreStore } from "../truth/loreStore.js";
import { SAVE_SCHEMA_VERSION } from "../truth/saveSchema.js";
import { loadWorldTime, TimeStore, worldTimeToMinutes } from "../truth/timeStore.js";
import { WorldStore } from "../truth/worldStore.js";
import { GameSession } from "./gameSession.js";
import { loadConfigState, type ConfigServiceDeps } from "./configService.js";

function readText(file: string): string {
  return fs.readFileSync(file, "utf8").trim();
}

// ---------------------------------------------------------------------------
// 存档元数据（save/{runId}/meta.json：世界设定集选择，resume 按此加载）
// ---------------------------------------------------------------------------

const SaveMetaSchema = z.object({ world_set: z.string() });

/** 世界设定集提供的 C0 完整角色 manifest。 */
function loadPlayerInitial(worldDir: string): CharacterManifest {
  const file = path.join(worldDir, "player.json");
  if (!fs.existsSync(file)) throw new Error(`世界设定集缺少玩家开局配置: ${file}`);
  return CharacterManifestSchema.parse(JSON.parse(readText(file)));
}

function readWorldSet(runId: string, baseDir?: string): string {
  const file = path.join(baseDir ?? runDir(runId), "meta.json");
  if (!fs.existsSync(file)) return DEFAULT_WORLD_SET;
  return SaveMetaSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))).world_set;
}

function writeWorldSet(runId: string, worldSet: string, baseDir?: string): void {
  const dir = baseDir ?? runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ world_set: worldSet }, null, 2) + "\n",
    "utf8",
  );
}

function resolveSessionWorldDir(setId: string | undefined, assetsDir?: string): string {
  if (assetsDir === undefined) return resolveWorldDir(setId);
  const id = setId === undefined || setId === "" ? DEFAULT_WORLD_SET : setId;
  if (!/^[\w-]+$/.test(id)) throw new Error(`非法世界设定集名: ${JSON.stringify(id)}`);
  const dir = path.join(assetsDir, id);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`世界设定集不存在: ${id}`);
  return dir;
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

/** 可配置注入点（测试用）：确定性骰子、fake ChatPort 与临时数据根。 */
export interface SessionOptions {  /** d20 骰子（默认 Math.random 实现；先攻投掷用） */
  rollDice?: DicePort;
  /**
   * 逐 agent kind 注入 ChatPort（测试 fake）：注入的 kind 跳过 OpenAIChatAdapter 构造
   * （无 API key 也能建会话）；未注入的 kind 走生产路径 CallLogChatPort(OpenAIChatAdapter)。
   */
  chatPorts?: Partial<Record<AgentKind, ChatPort>>;
  /** 存档文件目录；省略时使用 save/{runId}。 */
  baseDir?: string;
  /** 世界资产根目录；省略时使用 data/assets。 */
  assetsDir?: string;
  /** 正文滑窗轮数；缺省 = DEFAULT_PROSE_WINDOW_TURNS（生产路径由 settings 传入）。 */
  proseWindowTurns?: number;
  /** GM 硬保险间隔（行动周期数）；缺省 = DEFAULT_GM_INTERVAL_CYCLES（生产路径由 settings 传入）。 */
  gmIntervalCycles?: number;
}

/**
 * 装配会话内核（新档或续档；repo 已存在即续档，否则以世界设定集开局）。
 * 存档 v6+：Generation 布局（CURRENT + generations/{rev}/）；
 * 旧平铺档（run 根有六平铺文件之一但无 CURRENT）明确拒绝，不迁移。
 */
export function createGameSession(
  configs: Record<AgentKind, LLMConfig>,
  runId: string,
  display?: Display,
  worldSetId?: string,
  options?: SessionOptions,
): GameSession {
  // 每个 agent kind 独立的 OpenAI adapter（api_key/base_url/model 可分别配置，缓存埋点按 agent 名分开统计）；
  // 注入 fake ChatPort 的 kind 不建 adapter（测试无需 API key）；recordRecent/cacheStats 走 CallLog decorator。
  const adapters: Partial<Record<AgentKind, OpenAIChatAdapter>> = {};
  const ports = {} as Record<AgentKind, ChatPort>;
  for (const kind of AGENT_KINDS) {
    const injected = options?.chatPorts?.[kind];
    if (injected !== undefined) {
      ports[kind] = injected;
      continue;
    }
    const adapter = new OpenAIChatAdapter(configs[kind]);
    adapters[kind] = adapter;
    ports[kind] = new CallLogChatPort(adapter, runId);
  }

  // 数据层：世界设定集（data/assets/{setId}/ 世界包），选择记入存档 meta.json
  const worldDir = resolveSessionWorldDir(worldSetId, options?.assetsDir);
  const worldSet = worldSetId === undefined || worldSetId === "" ? DEFAULT_WORLD_SET : worldSetId;
  const dir = options?.baseDir ?? runDir(runId);
  writeWorldSet(runId, worldSet, dir);

  // 提示词模板：包内 prompts/（每世界包一份完整副本，续档与新会话同一口径——
  // 都按本会话世界包解析）；装配时加载一次做启动校验，运行期每轮激活前热加载（见各 agent）
  const promptsDir = packPromptsDir(worldDir);
  loadTemplate("character", Object.keys(CHARACTER_PLACEHOLDERS), promptsDir);
  loadTemplate("gm", Object.keys(GM_PLACEHOLDERS), promptsDir);
  loadTemplate("prose", Object.keys(PROSE_PLACEHOLDERS), promptsDir);

  const setting = readText(path.join(worldDir, "setting.md"));
  const toneCard = readText(path.join(worldDir, "tone-card.md"));
  const worldLoreEntries = Lorebook.load(path.join(worldDir, "lorebook.json")).all();
  const playerInitial = loadPlayerInitial(worldDir);
  const charDir = path.join(worldDir, "characters");
  const manifests = fs
    .readdirSync(charDir)
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => CharacterManifestSchema.parse(JSON.parse(readText(path.join(charDir, f)))));
  if (manifests.length === 0) throw new Error(`世界设定集 ${worldSet} 没有角色 manifest`);

  const repo = new GenerationRepository(dir);
  const worldTime = loadWorldTime(worldDir);
  const startMinutes = worldTimeToMinutes(worldTime.start);
  let revision: number;
  let world: WorldStore;
  let events: EventsStore;
  let characters: CharactersStore;
  let loreStore: LoreStore;
  let timeStore: TimeStore;
  let archive: ArchiveStore;
  if (repo.exists()) {
    // 续档：loadCurrent 逐文件 parse（类型化 SaveLoadError；当前代损坏自动回退上一代）
    const loaded = repo.loadCurrent();
    revision = loaded.revision;
    const save = loaded.save;
    world = new WorldStore({ schema_version: SAVE_SCHEMA_VERSION, world: save.world, pipeline: save.pipeline });
    events = new EventsStore(save.events);
    characters = new CharactersStore(save.characters);
    loreStore = new LoreStore(save.lore);
    timeStore = new TimeStore(save.time);
    archive = new ArchiveStore(save.archive);
  } else {
    // 新档：内存组装初始状态（首次写盘 = GameSession 构造尾的 init 提交 → Generation 1）
    repo.assertNoLegacyFlat();
    revision = 0;
    world = WorldStore.initial({ time: worldTime.start });
    events = new EventsStore();
    characters = CharactersStore.fromManifests(manifests, startMinutes);
    loreStore = LoreStore.initFrom(worldLoreEntries);
    timeStore = new TimeStore({ schema_version: SAVE_SCHEMA_VERSION, start: worldTime.start, periods: worldTime.periods });
    archive = new ArchiveStore();
  }
  characters.ensurePlayer(playerInitial, startMinutes);

  // 无状态 activation：三个调用规则各持对应 kind 的 ChatPort，单一 CharacterActivation
  // 服务全部 NPC；cast/lore/事件等上下文由 ActivationContextBuilder 逐调用从真相现算，
  // 不在装配期固化（动态改名/lore 编辑下一次调用即生效）。
  const character = new CharacterActivation(ports.character, promptsDir);
  const gm = new GmActivation(ports.gm, promptsDir);
  const prose = new ProseActivation(ports.prose, promptsDir);

  return new GameSession({
    runId,
    character,
    gm,
    prose,
    events,
    world,
    characters,
    loreStore,
    timeStore,
    archive,
    statics: { setting, toneCard },
    proseWindowTurns: options?.proseWindowTurns ?? DEFAULT_PROSE_WINDOW_TURNS,
    gmIntervalCycles: options?.gmIntervalCycles ?? DEFAULT_GM_INTERVAL_CYCLES,
    rollDice: options?.rollDice ?? defaultDice,
    repo,
    revision,
    adapters,
    ...(display !== undefined ? { display } : {}),
  });
}

/**
 * 续档：从 save/{runId}/ 的落盘数据重建会话运行态（世界设定集按 meta.json）。
 * 数据经 GenerationRepository.loadCurrent 一次读入六 Store；本方法只转发 createGameSession。
 * 不触发任何 LLM 调用（纯数据操作）。
 */
export function resumeGameSession(
  configs: Record<AgentKind, LLMConfig>,
  runId: string,
  display?: Display,
  options?: SessionOptions,
): GameSession {
  return createGameSession(configs, runId, display, readWorldSet(runId, options?.baseDir), options);
}

// ---------------------------------------------------------------------------
// SessionCoordinator 的装配端口（测试注入 fake；生产实现 = productionSessionFactory）
// ---------------------------------------------------------------------------

/** Coordinator 的会话装配端口：configs 读取与存档存在性校验由实现负责。 */
export interface SessionFactory {
  /** 新会话（worldSetId 省略 = 缺省世界设定集）。 */
  create(runId: string, worldSetId: string | undefined, display?: Display): GameSession;
  /** 续档（存档不存在/缺 API key 抛错；runId 先过 safeSegment 防目录穿越）。 */
  resume(runId: string, display?: Display): GameSession;
}

/**
 * 生产配置源：经 configService.loadConfigState 读三资源（含 config.json 一次性
 * 迁移闸——旧档首次进入自动迁移为 secrets/presets/settings）。resolved = null 即
 * 三个 activation 任一解析不出有效配置（未绑定 preset / 缺 key 且无 env 兜底）。
 */
function productionConfigDeps(): ConfigServiceDeps {
  return { dirs: resolveUserDirectories(), env: process.env, legacyConfigFile: CONFIG_FILE };
}

function requireConfigState(): { configs: Record<AgentKind, LLMConfig>; settings: UserSettings } {
  const state = loadConfigState(productionConfigDeps());
  if (!state.resolved) {
    throw new Error("未找到 LLM API Key：请在「配置」页写入密钥并绑定 API 预设，或设置 DEEPSEEK_API_KEY 环境变量。");
  }
  return { configs: state.resolved, settings: state.view.settings };
}

/** settings → SessionOptions（滑窗/GM 间隔随会话装配固化；运行中修改走配置事务热应用）。 */
function sessionOptionsFromSettings(settings: UserSettings): SessionOptions {
  return {
    proseWindowTurns: settings.proseWindowTurns ?? DEFAULT_PROSE_WINDOW_TURNS,
    gmIntervalCycles: settings.gmIntervalCycles ?? DEFAULT_GM_INTERVAL_CYCLES,
  };
}

/** 生产装配：configService 配置状态读取 + save/ 存档存在性校验 + createGameSession/resumeGameSession。 */
export const productionSessionFactory: SessionFactory = {
  create(runId, worldSetId, display) {
    const { configs, settings } = requireConfigState();
    return createGameSession(configs, runId, display, worldSetId, sessionOptionsFromSettings(settings));
  },
  resume(runId, display) {
    const id = safeSegment(runId); // 路径安全：防目录穿越
    if (!fs.existsSync(path.join(SAVE_DIR, id))) {
      throw new Error(`存档不存在: ${id}`);
    }
    const { configs, settings } = requireConfigState();
    return resumeGameSession(configs, id, display, sessionOptionsFromSettings(settings));
  },
};
