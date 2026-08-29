/**
 * 会话装配工厂：
 * 给定 configs/runId/options/worldSetId → 装配好的 GameSession 内核实例。
 * 职责 = ChatPort/adapter 装配、提示词模板档内副本装载（新档拷自世界包、续档读档）、
 * 存档 meta.json（world_set）读写、五根真相 Store 初始/续档装载、无状态 activation
 * 装配（三个 activation 各持对应 kind 的 ChatPort；上下文由投影层逐调用现算）。
 * 命令串行/会话切换在 sessionCoordinator.ts；内核步编排在 gameSession.ts。
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CharacterActivation,
  CharacterManifestSchema,
  type CharacterManifest,
} from "../agents/character.js";
import { GmActivation } from "../agents/gm.js";
import { ProseActivation } from "../agents/prose.js";
import {
  parsePlaceholders,
  validatePlaceholders,
  type PlaceholderCatalog,
} from "../compile/placeholders.js";
import { loadTemplate, type PromptTemplate } from "../compile/template.js";
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
import { compileIncidentConfig, type IncidentConfig } from "../scheduler/incident.js";
import { safeSegment } from "../shared/safeSegment.js";
import { ArchiveStore } from "../truth/archive.js";
import { CharactersStore, type CharacterState } from "../truth/charactersStore.js";
import { EventsStore } from "../truth/events.js";
import { GenerationRepository } from "../truth/generationRepository.js";
import { Lorebook } from "../truth/lorebook.js";
import { LoreStore } from "../truth/loreStore.js";
import { PROMPT_TEMPLATE_IDS, PromptsStore } from "../truth/promptsStore.js";
import { parseSys, SysStore, type ParsedSys, type SysStructs } from "../truth/sysStore.js";
import { cascadeDerived, varWriteDepsOf } from "../truth/varWrite.js";
import { WorldStore } from "../truth/worldStore.js";
import {
  defaultWorldTimeInstance,
  readWorldTime,
  worldTimeToMinutes,
} from "../vars/systemWorld.js";
import { normalizeInstance, validateSystemTags } from "../vars/tree.js";
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

/** 突发公式配置（世界包 incident.json；缺文件/损坏即拒装——公式结构与参数唯一出处，无代码内缺省）。 */
function loadIncidentConfig(worldDir: string): IncidentConfig {
  const file = path.join(worldDir, "incident.json");
  if (!fs.existsSync(file)) throw new Error(`世界设定集缺少突发公式配置: ${file}`);
  return compileIncidentConfig(JSON.parse(readText(file)));
}

/** 变量体系三文件原始内容（世界包 tags.json / vars-template.json / vars-tags.json；缺文件即拒装，incident.json 先例）。 */
function loadVarsPackFiles(worldDir: string): SysStructs {
  const read = (name: string): unknown => {
    const file = path.join(worldDir, name);
    if (!fs.existsSync(file)) throw new Error(`世界设定集缺少变量体系文件: ${file}`);
    return JSON.parse(readText(file));
  };
  return {
    tagRegistry: read("tags.json"),
    varsTemplate: read("vars-template.json"),
    varsTags: read("vars-tags.json") as { world: unknown; character: unknown },
  };
}

/**
 * 世界包占位符目录（prompts/placeholders.json）：缺文件/校验失败即拒装
 * （loadVarsPackFiles 先例）；zod 形状 + 分支记号集规范化在 parsePlaceholders，
 * 语义机检（vars 路径/置后同轴/分支记号）在装配点经 validatePlaceholders 对档内模板与注册表。
 */
export function loadPackPlaceholders(worldDir: string): PlaceholderCatalog {
  const file = path.join(packPromptsDir(worldDir), "placeholders.json");
  if (!fs.existsSync(file)) throw new Error(`世界设定集缺少占位符目录: ${file}`);
  return parsePlaceholders(JSON.parse(readText(file)));
}

/**
 * 世界包提示词模板（prompts/{object}.{function}.prompt.json，键集 = PROMPT_TEMPLATE_IDS 矩阵扁平键）：
 * 缺文件即拒装（loadVarsPackFiles 先例）；逐份按占位符目录键集过 validateTemplate
 * + id 与文件名一致校验（loadTemplate），新会话拷入档内 PromptsStore。
 */
export function loadPackPrompts(worldDir: string, catalog: PlaceholderCatalog): PromptTemplate[] {
  const dir = packPromptsDir(worldDir);
  const keys = Object.keys(catalog);
  return PROMPT_TEMPLATE_IDS.map((id) => {
    const file = path.join(dir, `${id}.prompt.json`);
    if (!fs.existsSync(file)) throw new Error(`世界设定集缺少提示词模板: ${file}`);
    return loadTemplate(id, keys, dir);
  });
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
export interface SessionOptions {  /** 单骰端口（默认 defaultDice；先攻投掷用，经 rollDice 投 d20） */
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

  const worldLoreEntries = Lorebook.load(path.join(worldDir, "lores.json")).all();
  const incidentConfig = loadIncidentConfig(worldDir);
  const playerInitial = loadPlayerInitial(worldDir);
  const charDir = path.join(worldDir, "characters");
  const manifests = fs
    .readdirSync(charDir)
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => CharacterManifestSchema.parse(JSON.parse(readText(path.join(charDir, f)))));
  if (manifests.length === 0) throw new Error(`世界设定集 ${worldSet} 没有角色 manifest`);

  const repo = new GenerationRepository(dir);
  // 初始时间 = world 变量树 time 锚（新档 = 代码缺省实例，世界作者经状态直编调整）
  const startMinutes = worldTimeToMinutes(readWorldTime({ time: defaultWorldTimeInstance() }).anchor);
  // 变量体系三文件（tags/vars-template/vars-tags）：装配时读取（缺文件即拒装）；
  // 新会话解析校验后拷入 sys 第五根，续档改从档内 sys.json 读（校验同理）
  const packVars = loadVarsPackFiles(worldDir);
  // 占位符目录 + 四份模板（缺文件/校验失败即拒装；语义机检在 sys 解析后）
  const packPlaceholders = loadPackPlaceholders(worldDir);
  const packTemplates = loadPackPrompts(worldDir, packPlaceholders);
  let parsedSys: ParsedSys;
  let revision: number;
  let world: WorldStore;
  let sysStore: SysStore;
  let events: EventsStore;
  let characters: CharactersStore;
  let loreStore: LoreStore;
  let archive: ArchiveStore;
  let promptsStore: PromptsStore;
  if (repo.exists()) {
    // 续档：loadCurrent 逐文件 parse（类型化 SaveLoadError；当前代损坏自动回退上一代）
    const loaded = repo.loadCurrent();
    revision = loaded.revision;
    const save = loaded.save;
    parsedSys = parseSys(save.sys);
    // 续档同样过一遍 normalize（幂等：已 normalize 数据再 normalize 结果相同）
    const normalizedWorld = normalizeInstance(save.world, parsedSys.template.world, "world") as Record<string, unknown>;
    readWorldTime(normalizedWorld); // time 系统分支必备回读校验
    world = new WorldStore(normalizedWorld);
    sysStore = new SysStore(save.sys);
    events = new EventsStore(save.events);
    const normalizedChars: Record<string, CharacterState> = {};
    // 侧车校验与级联共用同一份写值依赖（cid 类别实例集 = 档内角色表键集）
    const resumeDeps = varWriteDepsOf(parsedSys, new Set(Object.keys(save.characters)));
    for (const [cid, state] of Object.entries(save.characters)) {
      normalizedChars[cid] = {
        ...state,
        systemTags: validateSystemTags(state.systemTags, parsedSys.template.character, resumeDeps),
        vars: normalizeInstance(state.vars, parsedSys.template.characterVars, cid, undefined, true) as Record<string, unknown>,
      };
    }
    characters = new CharactersStore(normalizedChars, parsedSys.template.characterVars);
    // 续档整根从动级联（值变才写回；tags 池与 fromManifest 的初始物化同一算子）
    cascadeDerived({ world, characters }, { kind: "world" }, resumeDeps);
    for (const cid of Object.keys(normalizedChars)) {
      cascadeDerived({ world, characters }, { kind: "character", cid }, resumeDeps);
    }
    loreStore = new LoreStore(save.lores);
    archive = new ArchiveStore(save.archive);
    // 续档：提示词模板与占位符目录从档内副本恢复（不再读世界包）+ 语义机检（同新档口径）
    promptsStore = new PromptsStore(save.prompts);
    validatePlaceholders(promptsStore.placeholders(), { template: parsedSys.template, registry: parsedSys.tagRegistry });
  } else {
    // 新档：内存组装初始状态（首次写盘 = GameSession 构造尾的 init 提交 → Generation 1）
    repo.assertNoLegacyFlat();
    revision = 0;
    parsedSys = parseSys(packVars);
    world = new WorldStore({ time: defaultWorldTimeInstance() });
    sysStore = SysStore.initial(packVars);
    events = new EventsStore();
    characters = CharactersStore.fromManifests(manifests, startMinutes, parsedSys.template.characterVars);
    loreStore = LoreStore.initFrom(worldLoreEntries);
    archive = new ArchiveStore();
    // 新档：世界包四份模板 + 占位符目录（缺文件/校验失败即拒装）拷入档内副本，随 init 提交落 Generation 1
    validatePlaceholders(packPlaceholders, { template: parsedSys.template, registry: parsedSys.tagRegistry });
    promptsStore = PromptsStore.initFrom(packTemplates, packPlaceholders);
  }
  characters.ensurePlayer(playerInitial, startMinutes, parsedSys.template.characterVars);

  // 无状态 activation：三个调用规则各持对应 kind 的 ChatPort + 档内 PromptsStore（每轮
  // 激活读档内模板副本与占位符目录），单一 CharacterActivation
  // 服务全部 NPC；cast/lore/事件等注入内容由投影层（activationContexts.ts）逐调用从真相现算，
  // 不在装配期固化（动态改名/lore 编辑下一次调用即生效）。
  const character = new CharacterActivation(ports.character, promptsStore);
  const gm = new GmActivation(ports.gm, promptsStore);
  const prose = new ProseActivation(ports.prose, promptsStore);

  return new GameSession({
    runId,
    character,
    gm,
    prose,
    events,
    world,
    sysStore,
    characters,
    loreStore,
    archive,
    promptsStore,
    proseWindowTurns: options?.proseWindowTurns ?? DEFAULT_PROSE_WINDOW_TURNS,
    gmIntervalCycles: options?.gmIntervalCycles ?? DEFAULT_GM_INTERVAL_CYCLES,
    rollDice: options?.rollDice ?? defaultDice,
    incidentConfig,
    repo,
    revision,
    adapters,
    ...(display !== undefined ? { display } : {}),
  });
}

/**
 * 续档：从 save/{runId}/ 的落盘数据重建会话运行态（世界设定集按 meta.json）。
 * 数据经 GenerationRepository.loadCurrent 一次读入七 Store；本方法只转发 createGameSession。
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
