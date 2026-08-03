import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CHARACTER_PLACEHOLDERS,
  CharacterAgent,
  CharacterManifestSchema,
  type CharacterManifest,
} from "./agents/character.js";
import { GM_PLACEHOLDERS, GMAgent, validateAdjudicationRound } from "./agents/gm.js";
import { PROSE_PLACEHOLDERS, ProseAgent } from "./agents/prose.js";
import { loadTemplate } from "./compile/template.js";
import {
  AGENT_KINDS,
  DEFAULT_WORLD_SET,
  loadAgentConfigs,
  loadGmIntervalCycles,
  loadMemoryConfig,
  resolveWorldDir,
  runDir,
  type AgentKind,
  type LLMConfig,
  type MemoryConfig,
} from "./config.js";
import type { Display } from "./display.js";
import { LLMAbortedError, type ChatPort } from "./llm/chatPort.js";
import { OpenAIChatAdapter } from "./llm/openaiChatAdapter.js";
import { CallLogChatPort } from "./llm/callLog.js";
import { readCacheStats } from "./llm/cacheStats.js";
import { defaultDice, type DicePort } from "./ports.js";
import { ArchiveStore, buildArchiveEntry, type ArchiveEntry } from "./truth/archive.js";
import { CharactersStore, type CharacterState } from "./truth/charactersStore.js";
import { EventsStore } from "./truth/events.js";
import {
  renderForGm,
  renderRefsForGm,
  renderRefsForReader,
  normalizeCid,
  type CastMember,
} from "./truth/identity.js";
import { Lorebook } from "./truth/lorebook.js";
import { LoreStore } from "./truth/loreStore.js";
import { TimeStore, loadWorldTime, worldTimeToMinutes } from "./truth/timeStore.js";
import { INCOMPATIBLE_SAVE_MESSAGE, SAVE_SCHEMA_VERSION } from "./truth/saveSchema.js";
import { renderScene, renderSpeech, type WorkingSetEntry } from "./truth/workingSet.js";
import { WorldStore, type Pipeline, type PipelineCurrent, type PipelinePhase, type VarChange } from "./truth/worldStore.js";
import { diffStateTrees } from "./truth/varDiff.js";
import {
  groupLocation,
  initiativeBatches,
  nextDue,
  orderGroups,
  reconcileGroups,
  rerollInitiative,
  visibleEvents,
  type SimChar,
} from "./scheduler/simulator.js";
import { extractJson } from "./agents/json.js";
import {
  AdjudicationPackageSchema,
  DecisionPackageSchema,
  PLAYER_CID,
  knownByTag,
  spanToMinutes,
  type AdjudicationPackage,
  type CacheStat,
  type DecisionPackage,
  type Event,
  type Marker,
} from "./types.js";

function readText(file: string): string {
  return fs.readFileSync(file, "utf8").trim();
}

// ---------------------------------------------------------------------------
// 历史回显（载入存档后广播给前端；纯函数，可单测）
// ---------------------------------------------------------------------------

/** 一轮的一张角色卡（M2：一轮可有多张，NPC 独立轮没有玩家步）。 */
export interface HistoryCharacterCard {
  cid: string;
  /** 该角色步的 seq（卡片级回滚/重 roll/llm-recent 查询用） */
  seq: number;
  /** interrupted 步尚无合法决策包，仅保留 raw 供安全展示与编辑。 */
  decision?: DecisionPackage;
  interrupted?: boolean;
  /** 原始返回（历史卡"原始返回"视图数据源） */
  raw?: string;
}

export interface HistoryTurn {
  /** 本轮首步 seq */
  turn: number;
  /** 本轮玩家输入（NPC 独立轮无此字段） */
  playerInput?: string;
  /** 本轮各角色卡（按行动序） */
  characters: HistoryCharacterCard[];
  /** 各步 seq（卡片级回滚/重 roll 用） */
  seqs: { player?: number; gm?: number; prose?: number };
  /** gm/prose 步原始返回 */
  raws?: { gm?: string; prose?: string };
  adjudication?: AdjudicationPackage;
  prose?: string;
}

export interface HistorySimpleEvent {
  kind: string;
  payload: string;
}

export type HistoryPayload =
  | { mode: "full"; turns: HistoryTurn[] }
  | { mode: "simple"; events: HistorySimpleEvent[] };

interface StepLike {
  seq: number;
  kind: string;
  result?: unknown;
  var_changes?: VarChange[] | undefined;
}

/**
 * 组装历史（存档 v2）：archive.json + world.json 流水线 current（进行中的最后一步）。
 * 按"轮"分组：一轮 = 若干 player/character 步 + 一个 gm 步（+ 可选 prose 步），
 * 可无 player 步（NPC 独立轮）；gm 步闭合一轮；一轮内多个玩家步（无判定轮跨周期）
 * 各自成组——玩家卡按 seq 归位，不被同组后者覆盖。无归档（空档）→ 从事件集构建简化历史。
 */
export function buildHistory(
  events: Event[],
  archive: ArchiveEntry[],
  current: PipelineCurrent | null,
): HistoryPayload {
  const steps: StepLike[] = [...archive, ...(current !== null ? [current] : [])];
  if (steps.length === 0) {
    return {
      mode: "simple",
      events: events.map((e) => ({ kind: e.kind, payload: e.payload })),
    };
  }
  const turns: HistoryTurn[] = [];
  const openTurn = (seq: number): HistoryTurn => {
    const t: HistoryTurn = { turn: seq, characters: [], seqs: {} };
    turns.push(t);
    return t;
  };
  let cur: HistoryTurn | null = null;
  for (const step of steps) {
    if (step.kind === "player") {
      // gm 步闭合一轮：其后的 actor 步开启新一轮；
      // 一轮内多个玩家步（无判定轮跨周期）各自成组——玩家输入不被覆盖吞并
      if (cur === null || cur.seqs.gm !== undefined || cur.playerInput !== undefined) cur = openTurn(step.seq);
      const t: HistoryTurn = cur;
      t.seqs.player = step.seq;
      t.playerInput = (step.result as { input: string }).input;
    } else if (step.kind.startsWith("character:")) {
      if (cur === null || cur.seqs.gm !== undefined) cur = openTurn(step.seq);
      const t: HistoryTurn = cur;
      const result = step.result as { raw?: string; decision?: DecisionPackage };
      const card: HistoryCharacterCard = {
        cid: step.kind.slice("character:".length),
        seq: step.seq,
      };
      if (result.decision !== undefined) card.decision = result.decision;
      if ((step as PipelineCurrent).interrupted === true) card.interrupted = true;
      if (result.raw !== undefined) card.raw = result.raw;
      t.characters.push(card);
    } else if (step.kind === "gm") {
      if (cur === null || cur.seqs.gm !== undefined) cur = openTurn(step.seq);
      const t: HistoryTurn = cur;
      t.seqs.gm = step.seq;
      const result = step.result as { raw?: string; adjudication: AdjudicationPackage };
      t.adjudication = result.adjudication;
      if (result.raw !== undefined) (t.raws ??= {}).gm = result.raw;
    } else if (step.kind === "prose") {
      // prose 归属前一个 gm 闭合的那一轮（skip 无 prose；防御：无 gm 的 prose 自成一轮）
      if (cur === null || cur.seqs.gm === undefined || cur.seqs.prose !== undefined) {
        cur = openTurn(step.seq);
      }
      const t: HistoryTurn = cur;
      t.seqs.prose = step.seq;
      const result = step.result as { raw?: string; prose: string };
      t.prose = result.prose;
      if (result.raw !== undefined) (t.raws ??= {}).prose = result.raw;
    }
  }
  return { mode: "full", turns };
}

// ---------------------------------------------------------------------------
// 正文素材（从 archive.json 现取）
// ---------------------------------------------------------------------------

/** 正文归档结果：正文块携带该轮参与者及其行动时的连续场景 id。 */
export interface ArchivedProseResult {
  raw: string;
  prose: string;
  participants: string[];
  scenes: Record<string, number>;
}

/** 最近 n 轮已发布正文（原文块，无包装；仅供正文 agent 的全量连续文风输入）。 */
export function proseWindow(archive: ArchiveEntry[], n: number): string[] {
  if (n <= 0) return [];
  return archive
    .filter((e) => e.kind === "prose")
    .slice(-n)
    .map((e) => (e.result as ArchivedProseResult).prose);
}

/**
 * 角色正文滑窗：只取该 cid 亲身参与、且其当时所在组（连续场景 = 同一组编号存续期间，§6）
 * 与当前值一致的最近 n 块。存档不做旧格式兼容；participants/scenes 是连续场景过滤的必要归档契约。
 */
export function proseWindowFor(
  archive: ArchiveEntry[],
  cid: string,
  currentGroup: number,
  n: number,
): string[] {
  if (n <= 0) return [];
  return archive
    .filter((e) => {
      if (e.kind !== "prose") return false;
      const result = e.result as ArchivedProseResult;
      return result.participants.includes(cid) && result.scenes[cid] === currentGroup;
    })
    .slice(-n)
    .map((e) => (e.result as ArchivedProseResult).prose);
}

/** GM 正文滑窗：仅取本轮行动者仍处于同一连续场景的正文，禁止跨组注入。 */
export function proseWindowForRound(
  archive: ArchiveEntry[],
  scenes: Readonly<Record<string, number>>,
  n: number,
): string[] {
  if (n <= 0) return [];
  const cids = Object.keys(scenes);
  return archive
    .filter((e) => {
      if (e.kind !== "prose") return false;
      const result = e.result as ArchivedProseResult;
      return cids.some(
        (cid) => result.participants.includes(cid) && result.scenes[cid] === scenes[cid],
      );
    })
    .slice(-n)
    .map((e) => (e.result as ArchivedProseResult).prose);
}

/** 上一轮已发布正文（无则空串 → prose 模板模块丢弃）。 */
export function lastProse(archive: ArchiveEntry[]): string {
  return proseWindow(archive, 1)[0] ?? "";
}

/** 参与角色的固定标签并集（去重；正文 lore 触发制的输入，§10.1）。 */
export function participantTags(list: readonly { tags: string[] }[]): string[] {
  return [...new Set(list.flatMap((m) => m.tags))];
}

// ---------------------------------------------------------------------------
// 存档元数据（runs/{id}/meta.json：世界设定集选择，resume 按此加载）
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

function resolveSessionWorldDir(setId: string | undefined, worldsDir?: string): string {
  if (worldsDir === undefined) return resolveWorldDir(setId);
  const id = setId === undefined || setId === "" ? DEFAULT_WORLD_SET : setId;
  if (!/^[\w-]+$/.test(id)) throw new Error(`非法世界设定集名: ${JSON.stringify(id)}`);
  const dir = path.join(worldsDir, id);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`世界设定集不存在: ${id}`);
  return dir;
}

// ---------------------------------------------------------------------------
// 调度派生（M2：时间轴与轮状态全派生，无独立存储，§10.3）
// ---------------------------------------------------------------------------

/** 离开标记的"冻结"timer（未结算离开集合的判据：group=0 且 timer 为该值；调度视图视同无计时器）。 */
export const LEAVE_TIMER = Number.MAX_SAFE_INTEGER;
/** 无先攻值角色的触发批哨兵（任何真实投掷都取不到：批内无他人 → 批完成判定真空成立 → 立即 GM）。 */
const NO_INITIATIVE_BATCH = -Number.MAX_SAFE_INTEGER;

/** deriveNext 的输出：下一步该谁 + 轮首步所需的调度上下文。 */
export interface Derivation {
  phase: PipelinePhase;
  /** await_character 的目标角色 */
  cid?: string;
  /** 新一轮调度弹出时刻（轮首步 setClock 用；连续轮/无跳转 = undefined） */
  due?: number;
  /** 死锁防御：全员无计时器时停等玩家 */
  deadlock?: boolean;
  /** 维护性 acted 清零（后台成员 / 周期完成的前台全员），由下一步以 var_changes 落账 */
  actedClears?: string[];
  /** 周期完成：X+1（世界变量 cycles_since_gm，由下一步经 var_changes 落账） */
  cycleIncrement?: boolean;
  /** 邀请应答步：contact 步 seq（拒绝时还原 timer 的依据）+ 邀请者与频道（incoming_contact 注入用） */
  invitation?: { contactSeq: number; inviter: string; channel: string };
}

/**
 * 暂停选项（取代"默认自动继续"）：自动继续 = 全部 false。
 * 互斥（自动继续/每轮暂停各自排除其余）在前端保证；服务端按位生效、内存态不落盘。
 */
export interface PauseOptions {
  /** 每轮暂停：每步完成后停（冻结在下一步 phase，"继续"恢复） */
  everyStep: boolean;
  /** GM 前暂停：下一步该 GM 激活时停 */
  beforeGm: boolean;
  /** GM 后暂停：GM 步完成后停 */
  afterGm: boolean;
  /** 正文后暂停：正文步完成后停 */
  afterProse: boolean;
}

/** 自动继续（缺省）：不停任何步。 */
const AUTO_CONTINUE: PauseOptions = { everyStep: false, beforeGm: false, afterGm: false, afterProse: false };

/** 可配置注入点（测试用）：确定性骰子、fake ChatPort 与临时数据根。 */
export interface SessionOptions {  /** d20 骰子（默认 Math.random 实现；先攻投掷用） */
  rollDice?: DicePort;
  /**
   * 逐 agent kind 注入 ChatPort（测试 fake）：注入的 kind 跳过 OpenAIChatAdapter 构造
   * （无 API key 也能建会话）；未注入的 kind 走生产路径 CallLogChatPort(OpenAIChatAdapter)。
   */
  chatPorts?: Partial<Record<AgentKind, ChatPort>>;
  /** 存档文件目录；省略时使用 runs/{runId}。 */
  baseDir?: string;
  /** 世界设定集根目录；省略时使用 data/worlds。 */
  worldsDir?: string;
  /** 正文滑窗轮数；测试可注入以避免读取 config.json。 */
  proseWindowTurns?: number;
  /** GM 硬保险间隔（行动周期数）；测试可注入以避免读取 config.json。 */
  gmIntervalCycles?: number;
}

/**
 * 主循环（M2-b：无判定轮与标记体系，DESIGN-P1 §5）。
 * 调度 = 扫描角色 timer 取最小（时钟只在弹出时跳转）；单活跃组不变量——同刻多组按
 * orderGroups 串行，组内行动顺序 = initiative 变量现排（行动顺序表，acted 角色变量）；
 * 周期完成 X+1（世界变量 cycles_since_gm），X 达 N 周期末 GM，任何 GM 激活后 X 清零；
 * 标记（gm_request/leave/recall/contact/confirm）程序即时执行，全部走 var_changes。
 * phase 与轮游标不存快照——deriveNext 从角色变量 + archive seq 序列现推（回溯零特例）。
 * 每步：seq++ → 归档上一步（world.json 流水线 current → archive.json）→
 * 执行本步 → 结果写流水线 current；GM 步的事件立刻写 events.json。
 */
export class GameSession {
  private constructor(
    readonly runId: string,
    private charAgents: Map<string, CharacterAgent>,
    private gm: GMAgent,
    private prose: ProseAgent,
    private events: EventsStore,
    private world: WorldStore,
    private characters: CharactersStore,
    private loreStore: LoreStore,
    private timeStore: TimeStore,
    private archive: ArchiveStore,
    private cast: CastMember[],
    private manifests: CharacterManifest[],
    private proseWindowTurns: number,
    private gmIntervalCycles: number,
    private rollDice: DicePort,
    private display?: Display,
  ) {}

  private eventSeq = 0;
  private pauseOptions: PauseOptions = AUTO_CONTINUE;
  /** 各 agent kind 的 OpenAI adapter（create 时建立，注入 fake 的 kind 无此项）：设置页保存后经 reloadConfig 热更新。 */
  private adapters!: Partial<Record<AgentKind, OpenAIChatAdapter>>;
  /** 当前 activation 的 AbortController（每次 LLM activation 新建；stop 经 abortCurrent 中止它）。 */
  private activationController: AbortController | null = null;

  /**
   * 应用已解析配置到运行中会话（可注入，测试直测本方法）：
   * 各 OpenAI adapter 原地换配置（在途调用不受影响；注入 fake 的 kind 无 adapter，跳过），
   * 滑窗/GM 间隔字段立即生效。
   */
  applyResolvedConfigs(
    configs: Record<AgentKind, LLMConfig>,
    memory: MemoryConfig,
    gmIntervalCycles: number,
  ): void {
    for (const kind of AGENT_KINDS) this.adapters[kind]?.updateConfig(configs[kind]);
    this.proseWindowTurns = memory.proseWindowTurns;
    this.gmIntervalCycles = gmIntervalCycles;
  }

  /**
   * 热重载 config.json（设置页保存后立即生效，取代"新会话才生效"）。
   * 缺 API key（loadAgentConfigs 返回 null）时不打坏会话：保持旧配置并告警。
   */
  reloadConfig(): void {
    const configs = loadAgentConfigs();
    if (!configs) {
      console.warn("[GameSession] config.json 缺少 LLM API key，保持现有配置不变");
      return;
    }
    this.applyResolvedConfigs(configs, loadMemoryConfig(), loadGmIntervalCycles());
  }

  /** 设置暂停选项（内存态；sessionManager 经 WS 下发，续档/新会话由管理器重新套用）。 */
  setPauseOptions(options: PauseOptions): void {
    this.pauseOptions = { ...options };
  }

  static create(
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

    // 提示词模板：create 时加载一次做启动校验（运行期每轮激活前热加载，见各 agent）
    loadTemplate("character", Object.keys(CHARACTER_PLACEHOLDERS));
    loadTemplate("gm", Object.keys(GM_PLACEHOLDERS));
    loadTemplate("prose", Object.keys(PROSE_PLACEHOLDERS));

    // 数据层：世界设定集（data/worlds/{setId}/），选择记入存档 meta.json
    const worldDir = resolveSessionWorldDir(worldSetId, options?.worldsDir);
    const worldSet = worldSetId === undefined || worldSetId === "" ? DEFAULT_WORLD_SET : worldSetId;
    const dir = options?.baseDir ?? runDir(runId);
    writeWorldSet(runId, worldSet, dir);

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

    // 所有核心文件使用统一 schema_version；任一旧版或混合版本均明确拒绝，不迁移。
    const coreFiles = ["world.json", "events.json", "characters.json", "lore.json", "time.json", "archive.json"];
    const present = coreFiles.filter((file) => fs.existsSync(path.join(dir, file)));
    if (present.length > 0 && present.length !== coreFiles.length) throw new Error(INCOMPATIBLE_SAVE_MESSAGE);
    if (present.length === coreFiles.length) {
      for (const file of coreFiles) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as { schema_version?: unknown };
          if (parsed.schema_version !== SAVE_SCHEMA_VERSION) throw new Error(INCOMPATIBLE_SAVE_MESSAGE);
        } catch (error) {
          if (error instanceof Error && error.message === INCOMPATIBLE_SAVE_MESSAGE) throw error;
          throw new Error(INCOMPATIBLE_SAVE_MESSAGE, { cause: error });
        }
      }
    }
    const worldTime = loadWorldTime(worldDir);
    const startMinutes = worldTimeToMinutes(worldTime.start);
    const world = new WorldStore(runId, { world: { time: worldTime.start } }, dir);
    const events = new EventsStore(runId, dir);
    const charactersExist = fs.existsSync(path.join(dir, "characters.json"));
    const characters = charactersExist
      ? CharactersStore.load(runId, dir)
      : CharactersStore.initFrom(runId, manifests, startMinutes, dir);
    characters.ensurePlayer(playerInitial, startMinutes);

    // 演员表（@CID ↔ 显示名）：唯一真相是 characters 档内副本的 name（C0 与 NPC 同规）；
    // manifest 仅在建档时初始拷入，不维护单独的 cast 状态。按 CID 排序（确定性）。
    const cast: CastMember[] = [
      { cid: PLAYER_CID, name: characters.get(PLAYER_CID).name },
      ...manifests.map((m) => ({ cid: m.id, name: characters.get(m.id).name })),
    ].sort((a, b) => a.cid.localeCompare(b.cid));
    const loreStore = fs.existsSync(path.join(dir, "lore.json"))
      ? LoreStore.load(runId, dir)
      : LoreStore.initFrom(runId, worldLoreEntries, dir);
    const timeStore = fs.existsSync(path.join(dir, "time.json"))
      ? TimeStore.load(runId, dir)
      : TimeStore.initFrom(runId, worldTime, dir);
    const archive = new ArchiveStore(runId, dir);

    // 每 NPC 一个 CharacterAgent（私域上下文；固定标签自动激活 lore 注入 L1，读档内副本）
    const charAgents = new Map<string, CharacterAgent>();
    for (const m of manifests) {
      const activatedLore = Lorebook.render(
        loreStore.book().getByTags(characters.get(m.id).tags),
      );
      charAgents.set(m.id, new CharacterAgent(m, ports.character, characters, cast, activatedLore));
    }
    const gm = new GMAgent(ports.gm, setting, loreStore.book(), cast, characters);
    const prose = new ProseAgent(ports.prose, toneCard, setting, cast);

    const session = new GameSession(
      runId,
      charAgents,
      gm,
      prose,
      events,
      world,
      characters,
      loreStore,
      timeStore,
      archive,
      cast,
      manifests,
      options?.proseWindowTurns ?? loadMemoryConfig().proseWindowTurns,
      options?.gmIntervalCycles ?? loadGmIntervalCycles(),
      options?.rollDice ?? defaultDice,
      display,
    );
    // 开局组派生 + 首组先攻投掷（仅新档：初始状态的一部分，不产生 var_changes——
    // 它在 seq 1 之前，回溯永不越过）
    if (!charactersExist) session.rederiveGroups(false);
    session.adapters = adapters;
    session.restoreFromDisk();
    return session;
  }

  /**
   * 续档：从 runs/{runId}/ 的落盘数据重建会话运行态（世界设定集按 meta.json）。
   * 各 Store 构造时即读盘；本方法重建 agent 侧状态。不触发任何 LLM 调用（纯数据操作）。
   */
  static resume(
    configs: Record<AgentKind, LLMConfig>,
    runId: string,
    display?: Display,
    options?: SessionOptions,
  ): GameSession {
    return GameSession.create(configs, runId, display, readWorldSet(runId, options?.baseDir), options);
  }

  private restoreFromDisk(): void {
    const events = this.events.readAll();
    this.eventSeq = events.length;

    if (events.length > 0) {
      // 角色：各自回放可见事件（身份替换渲染；relations 在 characters.json 档内副本）
      for (const [cid, agent] of this.charAgents) {
        agent.restore(this.events.readVisibleTo(cid, this.world.clock));
      }
      // GM：全部已 commit 事件（@ID 原文）
      this.gm.observe(events);
    }

    // 流水线断点（工作集未清/有未归档步骤）：提示，按 phase 继续
    const p = this.world.pipeline;
    if (p.working_set.length > 0 || p.current !== null) {
      this.display?.summary(
        "session",
        `流水线断点恢复：seq=${p.seq} phase=${p.phase}（未裁决言行 ${p.working_set.length} 条将并入后续裁决）`,
      );
    }
    // 存储的 phase 只是展示态：统一按当前数据重推一次（开局/续档一致）
    this.world.setPipeline({ phase: this.deriveNext().phase });
  }

  // TODO(阶段 B)：eventSeq 续档/回溯时从 events.length 重推（见 restoreFromDisk/rollbackTo/applyDirectEdit），
  // 调用者不应从数组长度推导 ID——随 GenerationRepository 一并改为显式 ID 端口。
  private nextEventId(): string {
    this.eventSeq += 1;
    return `evt_${String(this.eventSeq).padStart(4, "0")}`;
  }

  /** 全部角色同构条目（characters.json 不再存 GM 伪角色）。 */
  private playable(): Record<string, CharacterState> {
    return { ...this.characters.all() };
  }

  /** 玩家操控角色 cid（await_player 一律按 isPlayer 判定，不硬编码 C0；缺省回落 C0）。 */
  private playerCid(): string {
    for (const [cid, s] of Object.entries(this.playable())) {
      if (s.isPlayer) return cid;
    }
    return PLAYER_CID;
  }

  /** 调度视图（SimChar）：timer=LEAVE_TIMER 的未结算离开者视同无计时器（永不弹出）。 */
  private simChars(): Record<string, SimChar> {
    return Object.fromEntries(
      Object.entries(this.playable()).map(([cid, s]) => [
        cid,
        {
          timer: s.timer === null || s.timer >= LEAVE_TIMER ? null : s.timer,
          group: s.group,
          location: s.location,
          isPlayer: s.isPlayer,
          initiative: s.initiative,
          channel: s.channel,
        },
      ]),
    );
  }

  /** 周期计数 X（世界变量 cycles_since_gm；缺省 0）。 */
  private cycleCount(): number {
    const v: unknown = this.world.world["cycles_since_gm"];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  }

  /**
   * 邀请派生（§5.3：pending 从 archive 现推——contact 步之后无对应应答/激活记录即为 pending）。
   * 应答步的自标记特征：受邀者本人 actor 步且其 var_changes 含 `${cid}.timer` after=0（激活落账）。
   * 返回当前应应答的受邀者（邀请者随前台组弹出、邀请已结算、目标未应答且未入组）。
   */
  private derivePendingInvitee(
    steps: StepLike[],
    front: string[],
  ): { cid: string; contactSeq: number; inviter: string; channel: string } | null {
    const chars = this.playable();
    const actorOf = (s: StepLike): string | null =>
      s.kind === "player"
        ? this.playerCid()
        : s.kind.startsWith("character:")
          ? s.kind.slice("character:".length)
          : null;
    interface Invitation {
      seq: number;
      inviter: string;
      channel: string;
      targets: string[];
      armed: boolean;
    }
    const invitations: Invitation[] = [];
    for (const s of steps) {
      if (s.kind === "gm") {
        for (const inv of invitations) inv.armed = true; // contact 触发 GM 立即结算 → 其后邀请生效待激活
        continue;
      }
      const actor = actorOf(s);
      if (actor === null) continue;
      const decision = (s.result as { decision?: DecisionPackage } | undefined)?.decision;
      for (const m of decision?.markers ?? []) {
        if (m.type === "contact") {
          invitations.push({
            seq: s.seq,
            inviter: actor,
            channel: m.channel,
            targets: m.targets.map(normalizeCid),
            armed: false,
          });
        }
      }
    }
    for (const inv of invitations) {
      if (!inv.armed) continue;
      const inviter = chars[inv.inviter];
      if (inviter === undefined || !front.includes(inv.inviter)) continue;
      const pending = inv.targets
        .filter((t) => t !== inv.inviter && chars[t] !== undefined)
        .filter((t) => inviter.group === 0 || chars[t]!.group !== inviter.group)
        .filter(
          (t) =>
            !steps.some(
              (s) =>
                s.seq > inv.seq &&
                actorOf(s) === t &&
                (s.var_changes ?? []).some((c) => c.path === `${t}.timer` && c.after === 0),
            ),
        );
      if (pending.length === 0) continue;
      // 异组受邀者按原有先攻按序应答（同值比 CID 升序）
      pending.sort(
        (a, b) =>
          (chars[b]!.initiative?.value ?? Number.NEGATIVE_INFINITY) -
            (chars[a]!.initiative?.value ?? Number.NEGATIVE_INFINITY) || a.localeCompare(b),
      );
      return { cid: pending[0]!, contactSeq: inv.seq, inviter: inv.inviter, channel: inv.channel };
    }
    return null;
  }

  /**
   * 调度派生（纯读取，§5/§10.4：游标与 phase ← 角色变量 + archive seq 序列推断）：
   * 运行时续跑、回溯恢复、handlePlayerInput 权限校验共用同一出口。
   * 单活跃组 + 行动顺序表：nextDue 弹出 → orderGroups 串行取首组 → initiativeBatches 现排
   * → 第一个 acted=false 者行动；全员 acted → 周期完成（X+1 或周期末 GM）。
   */
  private deriveNext(): Derivation {
    const current = this.world.pipeline.current;
    const steps: StepLike[] = [...this.archive.readAll(), ...(current !== null ? [current] : [])];
    const chars = this.playable();
    const clock = this.world.clock;
    const actorPhase = (cid: string): Derivation =>
      chars[cid]?.isPlayer === true ? { phase: "await_player" } : { phase: "await_character", cid };

    // 1. GM 步刚闭合：narrativity≠skip → 正文（interrupted 的 gm 步无解析包，此分支只作展示态）
    const last = steps[steps.length - 1];
    if (last?.kind === "gm") {
      const pkg = (last.result as { adjudication?: AdjudicationPackage } | undefined)?.adjudication;
      if (pkg === undefined || pkg.narrativity !== "skip") return { phase: "await_prose" };
    }

    // 2. 调度：nextDue 弹出最近到期者 → 同刻多组按 orderGroups 串行（首组先跑，其余等待）
    const sim = this.simChars();
    const nd = nextDue(sim);
    if (nd === null) return { phase: "await_player", deadlock: true };
    const effClock = Math.max(clock, nd.due); // timer=0 的应答/新入组成员 ≤ 当前时钟，时钟不倒退
    const due = nd.due > clock ? nd.due : undefined;
    const firstUnit = orderGroups(sim, nd.cids)[0]!;
    const frontGroup = chars[firstUnit[0]!]!.group;
    // 前台组成员 = 同组编号且 timer 已成熟（≤ effClock；timer=0 的新入组成员随组行动）
    const front =
      frontGroup !== 0
        ? Object.keys(chars)
            .filter((c) => chars[c]!.group === frontGroup && chars[c]!.timer !== null && chars[c]!.timer! <= effClock)
            .sort()
        : firstUnit;

    // 维护：组进后台 ⇒ 成员 acted 清零（var_changes 归下一步；中途 GM 无特例——
    // 前台组成员不在清除列，已行动状态随周期补完保留）
    const actedClears = Object.keys(chars).filter((c) => chars[c]!.acted && !front.includes(c)).sort();
    const withContext = (d: Derivation): Derivation => {
      const clears = [...actedClears, ...(d.actedClears ?? []).filter((c) => !actedClears.includes(c))];
      return {
        ...d,
        ...(clears.length > 0 ? { actedClears: clears } : {}),
        ...(due !== undefined ? { due } : {}),
      };
    };

    // 3. 邀请应答：contact 经 GM 立即结算后，邀请者组下次弹出时异组受邀者按原有先攻逐个应答
    const invitee = this.derivePendingInvitee(steps, front);
    if (invitee !== null) return withContext({ ...actorPhase(invitee.cid), invitation: invitee });

    // 4. 标记触发：gm_request/contact 立标 → 同先攻批全员行动完 → GM 立即激活
    if (this.world.world["gm_trigger"] === true) {
      const rawBatch: unknown = this.world.world["gm_trigger_batch"];
      const batch = typeof rawBatch === "number" ? rawBatch : NO_INITIATIVE_BATCH;
      const batchMembers = front.filter((c) => (chars[c]!.initiative?.value ?? NO_INITIATIVE_BATCH) === batch);
      if (batchMembers.every((c) => chars[c]!.acted)) return withContext({ phase: "await_gm" });
    }

    // 5. 行动顺序表：顺序 = initiative 变量现排，下一个行动者 = 第一个 acted=false 的成员
    const order = initiativeBatches(
      front.map((c) => ({ cid: c, initiative: chars[c]!.initiative })),
    ).flatMap((b) => b.cids);
    const next = order.find((c) => !chars[c]!.acted);
    if (next !== undefined) return withContext(actorPhase(next));

    // 6. 周期完成：X+1 达 N → 周期末 GM（X 由 GM 激活清零）；否则 X+1 + 清全员 acted 进下一周期
    if (this.cycleCount() + 1 >= this.gmIntervalCycles) return withContext({ phase: "await_gm" });
    return withContext({ ...actorPhase(order[0]!), cycleIncrement: true, actedClears: front });
  }

  /**
   * 开步（归档写入时机）：seq++，把上一步（流水线 current，含其 var_changes）
   * 写入 archive.json，然后进入本步。phase 由 deriveNext 在步间统一重推落盘。
   */
  private startStep(): number {
    const seq = this.world.pipeline.seq + 1;
    const entry = buildArchiveEntry(this.world.pipeline.current);
    if (entry !== null) this.archive.append(entry);
    this.world.setPipeline({ seq, current: null });
    return seq;
  }

  /** 收步：本步结果 + 逐条变量变更暂存流水线 current（下一步启动时归档）。 */
  private finishStep(seq: number, kind: string, result: unknown, varChanges: VarChange[]): void {
    this.world.setPipeline({ current: { seq, kind, result, var_changes: varChanges } });
  }

  /**
   * 轮首步的调度落账：时钟跳转到弹出时刻 + 维护性变更（周期计数 X+1、后台/周期完成
   * acted 清零）——全部经 var_changes 归首步，回溯天然可逆。
   */
  private applyScheduleSetup(d: Derivation): VarChange[] {
    const changes: VarChange[] = [];
    if (d.due !== undefined) {
      const to = Math.max(d.due, this.world.clock); // 防御：时钟不倒退
      if (to > this.world.clock) changes.push(this.world.setClock(to));
    }
    if (d.cycleIncrement === true) {
      changes.push(...this.world.apply([{ path: "cycles_since_gm", op: "=", value: this.cycleCount() + 1 }]));
    }
    for (const cid of d.actedClears ?? []) changes.push(...this.characters.setVars(cid, { acted: false }));
    return changes;
  }

  /** 立 GM 立即激活触发（gm_request/contact 共用）：记录触发批（角色先攻值；批完成判定见 deriveNext）。 */
  private setGmTrigger(cid: string): VarChange[] {
    const batch = this.characters.get(cid).initiative?.value ?? NO_INITIATIVE_BATCH;
    return this.world.apply([
      { path: "gm_trigger", op: "=", value: true },
      { path: "gm_trigger_batch", op: "=", value: batch },
    ]);
  }

  /**
   * 标记执行（§5.2：程序即时作用，全部 var_changes；标记不进工作集、不进任何注入）。
   * confirm 不在此处理——它只在邀请应答步生效（applyInvitationAnswer），游离 confirm 忽略。
   */
  private applyMarkers(cid: string, markers: Marker[]): VarChange[] {
    const changes: VarChange[] = [];
    for (const marker of markers) {
      switch (marker.type) {
        case "gm_request":
          changes.push(...this.setGmTrigger(cid));
          break;
        case "leave":
          // 离开标记对所有角色（含玩家）统一程序化：组归 0 + 超大 timer 冻结 + 清频道，绝不触发 GM
          changes.push(...this.characters.setVars(cid, { group: 0, timer: LEAVE_TIMER, channel: null }));
          break;
        case "recall": {
          const target = normalizeCid(marker.target);
          const state = this.characters.all()[target];
          if (state === undefined) {
            console.warn(`召回标记指向未知角色 ${target}，已忽略`);
            break;
          }
          // 未结算离开集合：group=0 且 timer=LEAVE_TIMER；timer 归当前 clock（组原到期时刻）、按进组规则归组
          if (state.group === 0 && state.timer === LEAVE_TIMER) {
            changes.push(...this.characters.setVars(target, { timer: this.world.clock }));
            changes.push(...this.rederiveGroups());
          } else {
            console.warn(`召回标记目标 ${target} 不在未结算离开集合，已忽略`);
          }
          break;
        }
        case "contact": {
          // 邀请者与各目标分配同一频道 id（现有最大 channel+1，无则 1）；触发 GM 立即激活
          const id = Math.max(0, ...Object.values(this.characters.all()).map((s) => s.channel ?? 0)) + 1;
          changes.push(...this.characters.setVars(cid, { channel: id }));
          for (const raw of marker.targets) {
            const target = normalizeCid(raw);
            if (target === cid) continue;
            if (this.characters.all()[target] === undefined) {
              console.warn(`联系标记指向未知角色 ${target}，已忽略`);
              continue;
            }
            changes.push(...this.characters.setVars(target, { channel: id }));
          }
          changes.push(...this.setGmTrigger(cid));
          break;
        }
        case "confirm":
          break; // 仅在邀请应答步生效（applyInvitationAnswer）
      }
    }
    return changes;
  }

  /** 邀请应答分派：有 confirm 标记 → 接受入组；否则拒绝（timer 还原 + 清频道）。 */
  private applyInvitationAnswer(
    cid: string,
    pkg: DecisionPackage,
    contactSeq: number,
    preTimer: number | null,
  ): VarChange[] {
    const accepted = (pkg.markers ?? []).some((m) => m.type === "confirm");
    return accepted ? this.applyConfirm(cid, contactSeq) : this.applyReject(cid, preTimer);
  }

  /** 拒绝：timer 自动还原为邀请前值（应答步 setup 的 before）+ 失去频道；全体持有者因此同地 → 频道自动清除。 */
  private applyReject(cid: string, preTimer: number | null): VarChange[] {
    const changes = this.characters.setVars(cid, { timer: preTimer, channel: null });
    changes.push(...this.cleanupChannels());
    return changes;
  }

  /**
   * 接受（confirm + 首轮回复）：并入邀请者组（邀请者单人则配对成新组并补投），
   * 先攻 = 已存值组编号对上则复用、否则单独补投；位置 ≠ 组位置 → 先攻 -1；
   * timer 归 0 待 GM 重设；首轮回复计入已行动（acted=true）。
   */
  private applyConfirm(cid: string, contactSeq: number): VarChange[] {
    const current = this.world.pipeline.current;
    const steps: StepLike[] = [...this.archive.readAll(), ...(current !== null ? [current] : [])];
    const contactStep = steps.find((s) => s.seq === contactSeq);
    if (contactStep === undefined) {
      console.warn(`confirm 找不到对应 contact 步（seq ${contactSeq}），已忽略`);
      return [];
    }
    const inviter =
      contactStep.kind === "player" ? this.playerCid() : contactStep.kind.slice("character:".length);
    const changes: VarChange[] = [];
    let g = this.characters.get(inviter).group;
    if (g === 0) {
      // 邀请者单人：配对成新组（全新组合 → 未用过的新 id；邀请者补投先攻）
      g = Math.max(0, ...Object.values(this.characters.all()).map((s) => s.group)) + 1;
      changes.push(...this.characters.setVars(inviter, { group: g }));
      const inviterInit = this.characters.get(inviter).initiative;
      if (inviterInit === null || inviterInit.group !== g) {
        changes.push(
          ...this.characters.setVars(inviter, {
            initiative: { value: this.rollDice() + this.characters.get(inviter).reaction, group: g },
          }),
        );
      }
    }
    changes.push(...this.characters.setVars(cid, { group: g }));
    const existing = this.characters.get(cid).initiative;
    let value =
      existing !== null && existing.group === g ? existing.value : this.rollDice() + this.characters.get(cid).reaction;
    // 入组位置 ≠ 组位置 → 先攻 -1（远程参与的劣后）
    const gl = groupLocation(this.simChars(), g);
    if (gl !== null && this.characters.get(cid).location.name !== gl) value -= 1;
    changes.push(...this.characters.setVars(cid, { initiative: { value, group: g }, timer: 0, acted: true }));
    return changes;
  }

  /**
   * 频道清理 pass（§5.3 生命周期）：全部持有者 location 相同 → 频道变量全清，
   * 仍非组位置的持有者按 leave 处理（组归 0 + 超大 timer，等待下一次 GM 结算）。
   */
  private cleanupChannels(): VarChange[] {
    const all = this.characters.all();
    const holders = Object.keys(all).filter((cid) => all[cid]!.channel !== null).sort();
    if (holders.length === 0) return [];
    const locations = new Set(holders.map((cid) => all[cid]!.location.name));
    if (locations.size > 1) return [];
    const changes: VarChange[] = [];
    for (const cid of holders) changes.push(...this.characters.setVars(cid, { channel: null }));
    const sim = this.simChars();
    for (const cid of holders) {
      const g = this.characters.get(cid).group;
      if (g === 0) continue;
      const gl = groupLocation(sim, g);
      if (gl !== null && this.characters.get(cid).location.name !== gl) {
        changes.push(...this.characters.setVars(cid, { group: 0, timer: LEAVE_TIMER }));
      }
    }
    return changes;
  }

  /**
   * 玩家输入尝试解析为结构化决策包（三块输入的 JSON 路径）。
   * 纯文本回退保留：无法解析时由 stepPlayer 映射为 { inner, dialogue }（纯文本视为台词）。
   */
  private parsePlayerInput(input: string): DecisionPackage | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      return DecisionPackageSchema.parse(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }

  /** 玩家轮：输入进工作集（玩家输入即其本轮行动；纯文本回退映射为台词，与 NPC 同构处理标记）。 */
  private stepPlayer(input: string, d: Derivation): void {
    const cid = this.playerCid();
    const seq = this.startStep();
    const preInviteTimer = d.invitation !== undefined ? this.characters.get(cid).timer : null;
    const setup = this.applyScheduleSetup(d);
    if (d.invitation !== undefined) setup.push(...this.characters.setVars(cid, { timer: 0 }));
    const pkg = this.parsePlayerInput(input) ?? { inner: input, dialogue: input };
    const changes = [...setup];
    this.world.setPipeline({
      working_set: [...this.world.pipeline.working_set, { cid, decision: pkg }],
    });
    if (pkg.relations?.length) changes.push(...this.characters.updateRelations(cid, pkg.relations));
    if (d.invitation === undefined) changes.push(...this.characters.setVars(cid, { acted: true }));
    else changes.push(...this.applyInvitationAnswer(cid, pkg, d.invitation.contactSeq, preInviteTimer));
    changes.push(...this.applyMarkers(cid, pkg.markers ?? []));
    this.finishStep(seq, "player", { input, decision: pkg }, changes);
  }

  /**
   * 角色轮完成效应：relations 落盘 + 决策入工作集 + acted 置位（行动顺序表；
   * 邀请应答步不置位——接受由 confirm 效应置位、拒绝不计入已行动）+ 标记执行。
   * 标记变更单独返回（编辑重放时按 var_changes 尾段定位反向，见 editResult）。
   */
  private applyCharacterEffects(
    cid: string,
    pkg: DecisionPackage,
    d: Derivation,
    preInviteTimer: number | null,
  ): { changes: VarChange[]; markerChanges: VarChange[] } {
    const changes = pkg.relations?.length
      ? this.characters.updateRelations(cid, pkg.relations)
      : [];
    this.world.setPipeline({
      working_set: [...this.world.pipeline.working_set, { cid, decision: pkg }],
    });
    if (d.invitation === undefined) changes.push(...this.characters.setVars(cid, { acted: true }));
    else changes.push(...this.applyInvitationAnswer(cid, pkg, d.invitation.contactSeq, preInviteTimer));
    const markerChanges = this.applyMarkers(cid, pkg.markers ?? []);
    return { changes, markerChanges };
  }

  /**
   * 组派生 + 先攻补投回写（GM 步/开局/召回共用）：reconcileGroups 保稳指派 group
   * （var_changes 通道），rerollInitiative 只为 initiative 为空或组编号不符的成员
   * 单独补投插入既有顺序（已存值对上即复用，不重投）——行动顺序由此派生还原。
   * 入组位置 ≠ 组位置的新成员先攻 -1。
   * 频道不在此清理：组 id 随 GM 结算 churn（拆散/重并）是常态，频道生命周期归
   * leave 标记（退组清除）/ 拒绝 / 同地清理 pass 管。
   * record=false 时丢弃 var_changes（仅开局初始分组用：seq 1 之前，回溯不越过）。
   */
  private rederiveGroups(record = true): VarChange[] {
    const chars = this.playable();
    const prev = Object.fromEntries(Object.entries(chars).map(([cid, s]) => [cid, s.group]));
    const { group } = reconcileGroups(chars, prev);
    const changes: VarChange[] = [];
    for (const cid of Object.keys(group)) {
      if (group[cid]! !== (prev[cid] ?? 0)) {
        changes.push(...this.characters.setVars(cid, { group: group[cid]! }));
      }
    }
    const groups = new Map<number, string[]>();
    for (const [cid, g] of Object.entries(group)) {
      if (g === 0) continue;
      const bucket = groups.get(g);
      if (bucket === undefined) groups.set(g, [cid]);
      else bucket.push(cid);
    }
    for (const [id, cids] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      const rolled = rerollInitiative(
        cids.map((c) => ({
          cid: c,
          reaction: this.characters.get(c).reaction,
          initiative: this.characters.get(c).initiative,
        })),
        id,
        this.rollDice,
      );
      if (rolled.length === 0) continue;
      for (const r of rolled) changes.push(...this.characters.setVars(r.cid, { initiative: r.initiative }));
      // 入组位置 ≠ 组位置 → 先攻 -1（按补投后的原始值先定组位置）
      const gl = groupLocation(this.simChars(), id);
      for (const r of rolled) {
        if (gl !== null && this.characters.get(r.cid).location.name !== gl) {
          changes.push(
            ...this.characters.setVars(r.cid, {
              initiative: { value: r.initiative.value - 1, group: id },
            }),
          );
        }
      }
    }
    return record ? changes : [];
  }

  /**
   * GM 轮完成效应（裁决包 v2）：deltas 落库 + timer（相对偏移 → 绝对到期时刻）/location
   * 应用 + 周期计数/触发复位 + 结算成员 acted 清零 + reconcileGroups 回写 group 与先攻补投 +
   * 频道清理 pass + 事件逐条 commit + 各 agent 感知 + 无 timer 校验 + **工作集清算**
   * （GM 转写后言行已入事件库；narrativity=skip 无正文步，工作集不能挂账）。返回逐条变更。
   */
  private applyGmEffects(seq: number, pkg: AdjudicationPackage, roundCids: string[]): VarChange[] {
    const changes = this.world.apply(pkg.deltas);
    const known = this.characters.all();
    // timer：相对偏移 → 绝对到期时刻（due = clock + spanToMinutes(span)，契约保证非 0）
    for (const t of pkg.timer) {
      if (!(t.cid in known)) {
        console.warn(`GM 裁决包 timer 指向未知角色 ${t.cid}，已跳过`);
        continue;
      }
      changes.push(...this.characters.setVars(t.cid, { timer: this.world.clock + spanToMinutes(t.span) }));
    }
    // location：GM 只设变量，分组（group）由程序派生
    for (const l of pkg.location) {
      if (!(l.cid in known)) {
        console.warn(`GM 裁决包 location 指向未知角色 ${l.cid}，已跳过`);
        continue;
      }
      changes.push(...this.characters.setVars(l.cid, { location: l.location }));
    }
    // 任何 GM 激活后：周期计数 X 清零 + 立即触发标记复位
    changes.push(
      ...this.world.apply([
        { path: "cycles_since_gm", op: "=", value: 0 },
        { path: "gm_trigger", op: "=", value: false },
      ]),
    );
    // 本轮被结算的成员转入后台：acted 清零（先攻值不重投，回前台时行动状态已重置）
    for (const t of pkg.timer) {
      if (t.cid in known) changes.push(...this.characters.setVars(t.cid, { acted: false }));
    }
    // 组派生 + 先攻补投（location/timer 是分组判据；组 id 保稳，缺投者单独补投）
    changes.push(...this.rederiveGroups());
    // 频道清理 pass：全部持有者同地 → 全清 + 非组位置持有者按 leave 处理
    changes.push(...this.cleanupChannels());
    // 事件逐条 commit（事件数 = GM 计划的新组划分；tags 缺省 = 本轮全部行动者可见）
    const committed: Event[] = [];
    for (const ev of pkg.events) {
      const event: Event = {
        id: this.nextEventId(),
        t: this.world.clock,
        seq,
        kind: "world",
        ...(ev.location !== undefined ? { location: ev.location } : {}),
        tags: ev.tags.length > 0 ? ev.tags : roundCids.map(knownByTag),
        payload: ev.text,
      };
      this.events.append(event);
      committed.push(event);
    }
    this.gm.observe(committed);
    // 感知过滤 = known_by 唯一通道（ADR 0002，无地点成分）
    for (const [cid, agent] of this.charAgents) {
      agent.perceive(visibleEvents(committed, cid));
    }
    // 校验：存在无 timer 的角色 → 警告（防 GM 漏设沉底）
    for (const [cid, s] of Object.entries(this.playable())) {
      if (s.timer === null) {
        console.warn(`GM 裁决后 ${cid} 无计时器（timer 须覆盖本轮全部行动者）`);
      }
    }
    // 工作集清算（改到 GM 步，不再等正文步）
    this.world.setPipeline({ working_set: [] });
    return changes;
  }

  /** 停止处理：LLMAbortedError → 冻结当前步并保留步前已落账元数据；其他错误继续抛。 */
  private handleStepError(
    seq: number,
    kind: string,
    err: unknown,
    options?: { varChanges?: VarChange[]; result?: Record<string, unknown> },
  ): void {
    if (err instanceof LLMAbortedError) {
      const current: PipelineCurrent = {
        seq,
        kind,
        result: { ...(options?.result ?? {}), raw: err.partialText },
        interrupted: true,
      };
      if (options?.varChanges !== undefined) current.var_changes = options.varChanges;
      this.world.setPipeline({ current });
      this.display?.summary(kind, "（已停止：可编辑补全或回溯）");
      return;
    }
    throw err;
  }

  /**
   * 本轮 #当前场景（角色视角）：同值批次注入隔离——
   * 与行动者同组且先攻同值的他人本轮条目不可见（同时性的迷雾；从角色变量派生，续档安全）。
   * 自己的条目恒可见（工作集跨周期累积，自上次 GM 清算以来的全体言行都注入，直到 GM 清算）。
   * 未结算离开者（group=0 + timer=LEAVE_TIMER）的条目产生时仍在组内，对原组成员保持可见，
   * 不因 group=0 而从注入中消失（直到 GM 清算）；他人 inner 隐藏规则不变（renderScene 视角过滤）。
   * 位置 ≠ 组位置的成员标注"远程"（§5.3 注入标注）。
   */
  private sceneFor(cid: string): string {
    const initiative = this.characters.get(cid).initiative;
    const entries = this.world.pipeline.working_set.filter((e) => {
      if (e.cid === cid) return true; // 自己的过往言行可见（同值批隔离只对他人条目生效）
      const otherState = this.characters.get(e.cid);
      // 未结算离开者：同值批隔离不适用（其条目是在组内时产生的，继续对原组成员可见）
      if (otherState.group === 0 && otherState.timer !== null && otherState.timer >= LEAVE_TIMER) return true;
      if (initiative === null) return true;
      const other = otherState.initiative;
      return other === null || other.group !== initiative.group || other.value !== initiative.value;
    });
    return renderScene(entries, cid, this.remoteCids());
  }

  /** 远程成员集：位置 ≠ 组位置（组位置 = 组内先攻最高者的 location，派生不落盘）。 */
  private remoteCids(): Set<string> {
    const sim = this.simChars();
    const out = new Set<string>();
    for (const [cid, s] of Object.entries(this.playable())) {
      if (s.group === 0) continue;
      const gl = groupLocation(sim, s.group);
      if (gl !== null && s.location.name !== gl) out.add(cid);
    }
    return out;
  }

  /** 角色轮。 */
  private async stepCharacter(cid: string, d: Derivation): Promise<void> {
    const agent = this.charAgents.get(cid);
    if (agent === undefined) throw new Error(`无角色 agent: ${cid}`);
    const seq = this.startStep();
    const preInviteTimer = d.invitation !== undefined ? this.characters.get(cid).timer : null;
    const setup = this.applyScheduleSetup(d);
    // 邀请应答激活：timer 置 0 弹出（var_changes 的 before = 邀请前值，拒绝时据此还原）
    if (d.invitation !== undefined) setup.push(...this.characters.setVars(cid, { timer: 0 }));
    const kind = `character:${cid}`;
    agent.updateWindow(
      proseWindowFor(
        this.archive.readAll(),
        cid,
        this.characters.get(cid).group,
        this.proseWindowTurns,
      ).map((block) => renderRefsForReader(block, this.characters.get(cid).relations)),
    );
    agent.updateScene(this.sceneFor(cid));
    agent.updateSituation(this.timeStore.render(this.world.world.time), this.world.world, this.world.clock);
    // 被联系通知（incoming_contact 占位符）：仅邀请应答步注入，其余激活清空
    agent.updateIncomingContact(
      d.invitation !== undefined ? { inviter: d.invitation.inviter, channel: d.invitation.channel } : null,
    );
    const name = this.manifests.find((m) => m.id === cid)?.name ?? cid;
    this.display?.agentStart(agent.agentName, `── 角色·${name} 决策 ──`, seq);
    const controller = new AbortController();
    this.activationController = controller;
    try {
      const { raw, pkg } = await agent.decide(seq, controller.signal, this.display);
      const effects = this.applyCharacterEffects(cid, pkg, d, preInviteTimer);
      const varChanges = [...setup, ...effects.changes, ...effects.markerChanges];
      // effects_from = setup 之后效应（relations/邀请应答或 acted/标记）在 var_changes 中的起始下标，
      // markers_from = 标记变更起始下标（编辑重放据此反向旧效应，见 editResult）；
      // 邀请应答步另记邀请上下文（contactSeq/inviter/channel/preInviteTimer）供编辑重放应答效应
      this.finishStep(
        seq,
        kind,
        {
          raw,
          decision: pkg,
          effects_from: setup.length,
          markers_from: varChanges.length - effects.markerChanges.length,
          ...(d.invitation !== undefined
            ? {
                invitation: {
                  contactSeq: d.invitation.contactSeq,
                  inviter: d.invitation.inviter,
                  channel: d.invitation.channel,
                  preInviteTimer,
                },
              }
            : {}),
        },
        varChanges,
      );
      this.display?.decision?.(agent.agentName, pkg, seq);
      this.display?.summary(
        agent.agentName,
        `${pkg.action !== undefined ? `行动：${pkg.action}` : "（无行动）"}${pkg.dialogue ? `；台词：${pkg.dialogue}` : ""}${pkg.relations?.length ? `（人际关系更新 ${pkg.relations.length} 条）` : ""}`,
      );
    } catch (err) {
      this.handleStepError(seq, kind, err, { varChanges: setup });
    } finally {
      this.activationController = null;
      this.display?.agentEnd(agent.agentName);
    }
  }

  /** 最后一个 gm 步所闭合那轮的 actor 步（本轮台词+内心的取材范围）。 */
  private roundSteps(): StepLike[] {
    const current = this.world.pipeline.current;
    const steps: StepLike[] = [...this.archive.readAll(), ...(current !== null ? [current] : [])];
    let lastGm = -1;
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i]!.kind === "gm") {
        lastGm = i;
        break;
      }
    }
    if (lastGm < 0) return [];
    let before = -1;
    for (let i = lastGm - 1; i >= 0; i--) {
      if (steps[i]!.kind === "gm" || steps[i]!.kind === "prose") {
        before = i;
        break;
      }
    }
    return steps
      .slice(before + 1, lastGm)
      .filter((s) => s.kind === "player" || s.kind.startsWith("character:"));
  }

  /** GM 激活闸：工作集非空且本轮行动者都有计时器（timer 覆盖由 GM 契约 validateAdjudicationRound 强校验）。 */
  private validateWorkingSetRound(roundCids: string[]): void {
    if (roundCids.length === 0) throw new Error("GM 激活前工作集为空");
    for (const cid of roundCids) {
      if (this.characters.get(cid).timer === null) {
        throw new Error(`GM 激活前校验失败：${cid} 无计时器`);
      }
    }
  }

  /**
   * GM 裁决包 timer 必须精确覆盖的 cid 集（去重排序）：
   * 全体同步组成员（行动者所在非零组的全体成员，以组成员身份为准、无论其 timer 值——
   * 组成员 timer 本就同步；timer 为 null 者同样包含，GM 给其设 timer 无害）
   * ∪ 刚从同步组离开的成员（已由 roundCids 覆盖：leave 标记必随其主人的行动产生，
   * 言行已进工作集，无需另设集合）。
   * 周期序列是组自身的状态（acted 三规则），与 timer 无关；覆盖未行动成员是为了让其
   * span 与已行动者一致、保住周期补完——不设才会使他们 span 掉队、被 reconcileGroups
   * 编入别组、打乱周期。周期末 GM（全员已行动）时该集合 == 行动者集合，与旧契约等价。
   */
  private expectedGmTimerCids(roundCids: string[]): string[] {
    const groups = new Set(
      roundCids.map((cid) => this.characters.get(cid).group).filter((group) => group !== 0),
    );
    const expected = new Set(roundCids);
    for (const [cid, state] of Object.entries(this.playable())) {
      if (state.group !== 0 && groups.has(state.group)) {
        expected.add(cid);
      }
    }
    return [...expected].sort((a, b) => a.localeCompare(b));
  }

  /** GM 轮。 */
  private async stepGm(d: Derivation): Promise<void> {
    const workingSet = this.world.pipeline.working_set;
    const roundCids = [...new Set(workingSet.map((e) => e.cid))];
    this.validateWorkingSetRound(roundCids);
    // roundCids（工作集行动者）语义不变；timer 契约基准另算（中途 GM 含同步组全体未行动成员）
    const timerCids = this.expectedGmTimerCids(roundCids);
    const seq = this.startStep();
    const setup = this.applyScheduleSetup(d);
    const roundScenes = Object.fromEntries(
      roundCids.map((cid) => [cid, this.characters.get(cid).group]),
    );
    this.gm.updateWindow(
      proseWindowForRound(this.archive.readAll(), roundScenes, this.proseWindowTurns).map((block) =>
        renderRefsForGm(block),
      ),
    );
    this.gm.updateSituation(this.world.clock, this.timeStore.render(this.world.world.time));
    this.display?.agentStart(this.gm.agentName, `── GM 裁决 ──`, seq);
    const controller = new AbortController();
    this.activationController = controller;
    try {
      const { raw, pkg } = await this.gm.adjudicate(
        seq,
        renderScene(workingSet, undefined, this.remoteCids()),
        this.world.world,
        timerCids,
        controller.signal,
        this.display,
      );
      const varChanges = [...setup, ...this.applyGmEffects(seq, pkg, roundCids)];
      this.finishStep(
        seq,
        "gm",
        { raw, adjudication: pkg, round_scenes: roundScenes },
        varChanges,
      );
      this.display?.adjudication?.(this.gm.agentName, pkg, seq);
      this.display?.summary(
        this.gm.agentName,
        `narrativity ${pkg.narrativity} · 事件 ${pkg.events.length} 条 · delta ${pkg.deltas.length} 条`,
      );
    } catch (err) {
      this.handleStepError(seq, "gm", err, { result: { round_scenes: roundScenes } });
    } finally {
      this.activationController = null;
      this.display?.agentEnd(this.gm.agentName);
    }
  }

  /** 正文轮。 */
  private async stepProse(): Promise<string> {
    const seq = this.startStep();
    // 本轮各角色台词+内心（不含行为意图）：从 archive 本轮角色步现取（这些步已归档）
    const round = this.roundSteps();
    const speech = renderSpeech(
      round.map((s): WorkingSetEntry => {
        if (s.kind === "player") {
          return { cid: this.playerCid(), input: (s.result as { input: string }).input };
        }
        return {
          cid: s.kind.slice("character:".length),
          decision: (s.result as { decision: DecisionPackage }).decision,
        };
      }),
    );
    const roundCids = [...new Set(round.map((s) => (s.kind === "player" ? this.playerCid() : s.kind.slice("character:".length))))];
    const gmStep = [...this.archive.readAll()].reverse().find((e) => e.kind === "gm");
    if (gmStep === undefined) throw new Error("正文轮找不到本轮 GM 场景元数据");
    const scenes = (gmStep.result as { round_scenes: Record<string, number> }).round_scenes;
    const triggeredLore = Lorebook.render(
      this.loreStore
        .book()
        .getByTags(participantTags(roundCids.map((cid) => this.characters.get(cid)))),
    );
    const recentEvents = this.events
      .readWindow(this.proseWindowTurns)
      .map((e) => renderForGm(e.payload, this.cast));
    this.display?.agentStart(this.prose.agentName, `── 正文 ──`, seq);
    const controller = new AbortController();
    this.activationController = controller;
    try {
      const proseText = await this.prose.render(
        seq,
        this.currentAdjudication(),
        speech,
        { recentEvents, triggeredLore, lastProse: lastProse(this.archive.readAll()) },
        controller.signal,
        this.display,
      );
      const result: ArchivedProseResult = {
        raw: proseText,
        prose: proseText,
        participants: roundCids,
        scenes,
      };
      this.finishStep(seq, "prose", result, []);
      return proseText;
    } catch (err) {
      this.handleStepError(seq, "prose", err, {
        varChanges: [],
        result: { participants: roundCids, scenes },
      });
      return "";
    } finally {
      this.activationController = null;
      this.display?.agentEnd(this.prose.agentName);
    }
  }

  /** 本轮 GM 裁决包（正文轮输入；从工作集所在轮的 gm 步取——通常即 current）。 */
  private currentAdjudication(): AdjudicationPackage {
    const current = this.world.pipeline.current;
    if (current?.kind === "gm") {
      return (current.result as { adjudication: AdjudicationPackage }).adjudication;
    }
    // 续跑场景：gm 步已归档（防御）
    const last = [...this.archive.readAll()].reverse().find((e) => e.kind === "gm");
    if (!last) throw new Error("正文轮找不到本轮 GM 裁决包");
    return (last.result as { adjudication: AdjudicationPackage }).adjudication;
  }

  /**
   * 按派生状态续跑直到 await_player、撞上 interrupted 步或命中暂停选项（内部；
   * 入口校验见 continuePipeline）。暂停 = 一次性闸门：只在本次续跑已执行过步后生效
   * （lastKind 记录本次已完成的步 kind；玩家输入步由 handlePlayerInput 预置 "player"），
   * 停 = 冻结在当前派生 phase，点"继续"走 continuePipeline 原路恢复。
   */
  private async runPipeline(lastKind: string | null = null): Promise<string> {
    let prose = "";
    for (;;) {
      if (this.world.pipeline.current?.interrupted === true) return prose; // 冻结在暂停态
      const d = this.deriveNext();
      this.world.setPipeline({ phase: d.phase });
      if (d.phase === "await_player") {
        if (d.deadlock === true) {
          console.warn("调度死锁防御：全员无计时器，停等玩家输入（请检查 GM 是否漏设 timer）");
        }
        return prose;
      }
      if (lastKind !== null) {
        const pause = this.pauseOptions;
        if (pause.everyStep) return prose; // 每轮暂停：每步完成后停
        if (d.phase === "await_gm" && pause.beforeGm) return prose; // GM 前暂停
        if (lastKind === "gm" && pause.afterGm) return prose; // GM 后暂停
        if (lastKind === "prose" && pause.afterProse) return prose; // 正文后暂停
      }
      if (d.phase === "await_character") await this.stepCharacter(d.cid!, d);
      else if (d.phase === "await_gm") await this.stepGm(d);
      else prose = await this.stepProse();
      lastKind = this.world.pipeline.current?.kind ?? null;
    }
  }

  /**
   * 继续：按派生状态自动接着跑。
   * 当前步标记 interrupted 时拒绝——必须先回溯或编辑（B 步暂停态权限框架）。
   */
  async continuePipeline(): Promise<void> {
    if (this.world.pipeline.current?.interrupted === true) {
      throw new Error("当前步已被停止：请先回溯或编辑补全");
    }
    await this.runPipeline();
  }

  /** 玩家输入：仅在派生 phase = await_player 时接受（暂停态权限框架）；输入即其本轮行动。 */
  async handlePlayerInput(input: string): Promise<string> {
    if (this.world.pipeline.current?.interrupted === true) {
      throw new Error("当前步已被停止：请先回溯或编辑补全");
    }
    const d = this.deriveNext();
    if (d.phase !== "await_player") {
      // 指明当前在等谁（直编调度变量后 phase 可能刚变，模糊措辞会误导玩家反复输入）
      const waiting =
        d.phase === "await_character"
          ? `角色 ${this.characters.get(d.cid!).name}（${d.cid}）行动`
          : d.phase === "await_gm"
            ? "GM 裁决"
            : "正文渲染";
      throw new Error(`现在不是玩家回合：正在等待${waiting}。请先继续、回溯或编辑`);
    }
    this.world.setPipeline({ phase: d.phase });
    this.stepPlayer(input, d);
    // 玩家步已完成：预置 lastKind 让暂停选项对本次续跑生效（如 GM 前暂停拦在玩家步之后的 GM）
    return this.runPipeline("player");
  }

  /**
   * 回溯到 targetSeq（= 回到第 targetSeq 步刚完成的位置）：
   * **倒序反向执行变量变更**——先反向当前步（若 current.seq > targetSeq），
   * 再逐条弹出 archive 中 seq > targetSeq 的条目并反向其 var_changes（before 写回），
   * 直到 current = 第 targetSeq 条、archive ≤ targetSeq-1（不变量：
   * 归档只到上一步、current = 最新步）。回滚后变量与第 targetSeq 步结束时逐字节一致。
   * events 截到 seq ≤ targetSeq；lore 按 changelog 反向回滚（均不留底）；
   * phase 由 deriveNext 重推（不存快照）；llm-recent 不动。
   */
  rollbackTo(targetSeq: number): void {
    if (!Number.isInteger(targetSeq) || targetSeq < 1) {
      throw new Error(`无效的目标轮次: ${targetSeq}`);
    }
    const p = this.world.pipeline;
    if (targetSeq === p.seq && p.current !== null) return; // 已在该步之后

    // 1. 目标校验（先于任何反向执行，避免无效目标破坏状态）
    const archive = this.archive.readAll();
    const popped = archive.find((e) => e.seq === targetSeq);
    if (!popped) {
      throw new Error(`目标轮次 ${targetSeq} 不存在（归档范围外或已是当前步）`);
    }
    const toRevert = archive
      .filter((e) => e.seq > targetSeq)
      .sort((a, b) => b.seq - a.seq);
    for (const e of toRevert) {
      if (e.var_changes === undefined) {
        throw new Error(`归档第 ${e.seq} 步无变更记录（旧格式存档），无法回滚变量`);
      }
    }

    // 2. 反向当前步（它就是要被回滚掉的最新步）
    if (p.current !== null && p.current.seq > targetSeq) {
      this.revertVarChanges(p.current.var_changes ?? []);
    }

    // 3. 逐条弹出 archive 中 seq > targetSeq 的条目并反向（倒序）
    for (const e of toRevert) {
      this.revertVarChanges(e.var_changes!);
    }

    // 3. 截断/回滚各文件
    this.archive.truncateToSeq(targetSeq - 1);
    this.events.truncateToSeq(targetSeq);
    this.loreStore.rollbackToSeq(targetSeq);
    this.eventSeq = this.events.readAll().length;

    // 4. 流水线：current = 弹出步（丢弃原 current——那正是被回溯掉的内容）
    const current: PipelineCurrent = {
      seq: popped.seq,
      kind: popped.kind,
      result: popped.result,
      ...(popped.var_changes !== undefined ? { var_changes: popped.var_changes } : {}),
      ...(popped.edited === true ? { edited: true } : {}),
    };
    this.world.setPipeline({
      seq: targetSeq,
      current,
      working_set: this.rebuildWorkingSet(this.archive.readAll(), popped),
    });
    // phase 派生恢复（M2：从角色变量 + 截断后 archive seq 序列重推，不存快照）
    this.world.setPipeline({ phase: this.deriveNext().phase });

    // 5. agent 内存态按截断后的事件集重建
    for (const [cid, agent] of this.charAgents) {
      agent.restore(this.events.readVisibleTo(cid, this.world.clock));
    }
    this.gm.restore(this.events.readAll());
  }

  /** 倒序反向执行一组变量变更（world.* → world；C*.* → characters）。 */
  private revertVarChanges(changes: VarChange[]): void {
    for (const c of [...changes].reverse()) {
      if (c.path.startsWith("world.")) this.world.revertChange(c);
      else if (/^C(?:0|[1-9]\d*)\./.test(c.path)) this.characters.revertChange(c);
      else throw new Error(`无法分发反向变量路径: ${c.path}`);
    }
  }

  /**
   * 重 roll = rollbackTo(seq - 1) + continuePipeline（回到该步之前重跑该步及后续）。
   * 调用方负责确认（会丢弃该步及之后的内容）。
   */
  async reroll(seq: number): Promise<void> {
    if (!Number.isInteger(seq) || seq <= 1) throw new Error(`无效的重 roll 轮次: ${seq}`);
    this.rollbackTo(seq - 1);
    await this.continuePipeline();
  }

  /** 当前轮工作集重建（回溯用）：最后一个 gm/prose 边界之后的 player/character 步。 */
  private rebuildWorkingSet(archive: ArchiveEntry[], current: ArchiveEntry): WorkingSetEntry[] {
    if (current.kind === "prose" || current.kind === "gm") return []; // GM 步已清算工作集
    const steps = [...archive, current];
    let boundary = -1;
    steps.forEach((s, i) => {
      if (s.kind === "gm" || s.kind === "prose") boundary = i;
    });
    const out: WorkingSetEntry[] = [];
    for (const s of steps.slice(boundary + 1)) {
      if (s.kind === "player") {
        out.push({ cid: this.playerCid(), input: (s.result as { input: string }).input });
      } else if (s.kind.startsWith("character:")) {
        out.push({
          cid: s.kind.slice("character:".length),
          decision: (s.result as { decision: DecisionPackage }).decision,
        });
      }
    }
    return out;
  }

  /** GM 步之前的工作集（已完成 GM 步编辑用）：上一个 gm/prose 边界之后的 player/character 步。 */
  private preGmWorkingSet(): WorkingSetEntry[] {
    const steps = this.archive.readAll();
    let boundary = -1;
    steps.forEach((s, i) => {
      if (s.kind === "gm" || s.kind === "prose") boundary = i;
    });
    const out: WorkingSetEntry[] = [];
    for (const s of steps.slice(boundary + 1)) {
      if (s.kind === "player") {
        out.push({ cid: this.playerCid(), input: (s.result as { input: string }).input });
      } else if (s.kind.startsWith("character:")) {
        out.push({
          cid: s.kind.slice("character:".length),
          decision: (s.result as { decision: DecisionPackage }).decision,
        });
      }
    }
    return out;
  }

  /**
   * 手动编辑当前步原始返回（编辑-继续合并）：
   * zod 校验（角色决策包/GM 裁决包必须合法 JSON；正文纯文本直接过）→
   * 写回 pipeline.current.result 并置 edited、清 interrupted。
   * interrupted 步额外补做该步完成效应（角色=工作集+relations+标记执行；
   * GM=deltas/timer/location/deriveGroups/事件 commit/工作集清算；正文=无副作用），之后可正常继续。
   * 已完成角色步编辑 = 程序重新读一遍整个输出并完整处理：setup 之后的全部旧效应
   * （relations/邀请应答或 acted/标记，var_changes 尾段，effects_from 定位）整段倒序反向，
   * 再按编辑包重放 relations + 邀请应答（或 acted）+ applyMarkers——标记与普通路径同语义；
   * 编辑包无标记则只反掉旧效应。旧步（无 effects_from）退化为 markers_from 尾段 + relations 路径过滤。
   * 已完成 GM 步（含回滚到 GM 步）可编辑：旧效应先整体反向（变量倒序+事件截断），
   * 再按编辑包重新应用——事件替换提交，各 agent 内存态按新事件集重建。
   * 解析失败抛错，不落盘。玩家轮不可编辑。
   */
  editResult(text: string): void {
    const current = this.world.pipeline.current;
    if (current === null) throw new Error("没有可编辑的当前步");
    if (current.kind === "player") throw new Error("玩家轮不支持编辑");
    const wasInterrupted = current.interrupted === true;
    const edited: PipelineCurrent = { seq: current.seq, kind: current.kind, result: null, edited: true };

    if (current.kind.startsWith("character:")) {
      const cid = current.kind.slice("character:".length);
      const pkg = this.parseJsonField<DecisionPackage>(text, DecisionPackageSchema, "决策包");
      const allChanges = current.var_changes ?? [];
      // 新步落账带 effects_from（setup 之后效应起始下标）；邀请应答步另带 invitation 上下文
      const prior = current.result as {
        effects_from?: number;
        markers_from?: number;
        invitation?: { contactSeq: number; inviter: string; channel: string; preInviteTimer: number | null };
      } | null;
      const effectsFrom = wasInterrupted ? undefined : prior?.effects_from;
      const isRelations = (change: VarChange) =>
        change.path === `${cid}.relations` || change.path.startsWith(`${cid}.relations.`);

      let setupChanges: VarChange[];
      if (wasInterrupted) {
        // 暂停态：效应从未应用——setup 原样保留，relations/标记按编辑包补做
        setupChanges = allChanges.filter((change) => !isRelations(change));
      } else if (effectsFrom !== undefined) {
        // 已完成新步：编辑 = 程序重读整个输出并完整处理——
        // setup 之后的全部旧效应（relations/邀请应答或 acted/标记，含对他角色的改动）整段倒序反向
        setupChanges = allChanges.slice(0, effectsFrom);
        this.revertVarChanges(allChanges.slice(effectsFrom));
      } else {
        // 旧步回退（无 effects_from）：标记效应尾段（markers_from 定位；旧步无此字段按无标记处理）
        // + relations 按路径过滤反向
        const markersFrom = prior?.markers_from ?? allChanges.length;
        setupChanges = allChanges.slice(0, markersFrom).filter((change) => !isRelations(change));
        this.revertVarChanges(allChanges.slice(markersFrom));
        for (const change of [...allChanges.slice(0, markersFrom)].reverse()) {
          if (isRelations(change)) this.characters.revertChange(change);
        }
      }

      const relationChanges = pkg.relations?.length ? this.characters.updateRelations(cid, pkg.relations) : [];
      // 新路径重放应答/行动效应：邀请应答步按原邀请上下文重放（confirm 入组 / 拒绝还原 timer+清频道），
      // 普通步重放 acted 置位；暂停态与旧步回退不补（保持原语义）
      let answerChanges: VarChange[] = [];
      if (effectsFrom !== undefined) {
        answerChanges = prior?.invitation !== undefined
          ? this.applyInvitationAnswer(cid, pkg, prior.invitation.contactSeq, prior.invitation.preInviteTimer)
          : this.characters.setVars(cid, { acted: true });
      }
      // 编辑包标记与普通路径同语义：程序即时执行（leave/recall/contact/gm_request 等，全走 var_changes）
      const markerChanges = this.applyMarkers(cid, pkg.markers ?? []);
      const workingSet = this.world.pipeline.working_set.filter((entry) => entry.cid !== cid);
      this.world.setPipeline({ working_set: [...workingSet, { cid, decision: pkg }] });
      edited.result =
        effectsFrom !== undefined
          ? {
              raw: text,
              decision: pkg,
              effects_from: setupChanges.length,
              markers_from: setupChanges.length + relationChanges.length + answerChanges.length,
              ...(prior?.invitation !== undefined ? { invitation: prior.invitation } : {}),
            }
          : { raw: text, decision: pkg, markers_from: setupChanges.length + relationChanges.length };
      edited.var_changes = [...setupChanges, ...relationChanges, ...answerChanges, ...markerChanges];
    } else if (current.kind === "gm") {
      const pkg = this.parseJsonField<AdjudicationPackage>(text, AdjudicationPackageSchema, "裁决包");
      const previous = current.result as { round_scenes?: Record<string, number> } | null;
      if (wasInterrupted) {
        // 暂停态：效应从未应用——直接按编辑包补做（工作集仍是 GM 前的完整轮）
        const roundCids = [...new Set(this.world.pipeline.working_set.map((e) => e.cid))];
        validateAdjudicationRound(pkg, this.expectedGmTimerCids(roundCids));
        const roundScenes = previous?.round_scenes ?? Object.fromEntries(roundCids.map((cid) => [cid, this.characters.get(cid).group]));
        const effectChanges = this.applyGmEffects(current.seq, pkg, roundCids);
        edited.result = { raw: text, adjudication: pkg, round_scenes: roundScenes };
        edited.var_changes = [...(current.var_changes ?? []), ...effectChanges];
      } else {
        // 已完成 GM 步（含回滚到 GM 步）：旧效应已应用——
        // 先整体反向（变量倒序 + 事件按 seq 截断），再按编辑包重新应用，事件替换提交。
        const preSet = this.preGmWorkingSet();
        const roundCids = [...new Set(preSet.map((e) => e.cid))];
        // 变量反向先行：状态回到 GM 前后才能按 GM 前视角派生 timer 覆盖契约
        // （注意：此后编辑包校验失败会留下已反向的旧效应，需再次编辑或回溯修复）
        this.revertVarChanges(current.var_changes ?? []);
        validateAdjudicationRound(pkg, this.expectedGmTimerCids(roundCids));
        this.events.truncateToSeq(current.seq - 1);
        this.eventSeq = this.events.readAll().length;
        const roundScenes = previous?.round_scenes ?? Object.fromEntries(roundCids.map((cid) => [cid, this.characters.get(cid).group]));
        this.world.setPipeline({ working_set: preSet });
        const effectChanges = this.applyGmEffects(current.seq, pkg, roundCids);
        // 事件集已被替换：各 agent 内存态按新事件集重建（与回溯同一通道）
        for (const [cid, agent] of this.charAgents) {
          agent.restore(this.events.readVisibleTo(cid, this.world.clock));
        }
        this.gm.restore(this.events.readAll());
        edited.result = { raw: text, adjudication: pkg, round_scenes: roundScenes };
        edited.var_changes = effectChanges;
      }
    } else {
      // prose 编辑只替换正文文本，参与者与行动时场景必须原样保留。
      const previous = current.result as Partial<ArchivedProseResult> | null;
      if (!previous?.participants || !previous.scenes) throw new Error("正文归档缺少 participants/scenes，请新建会话/重启服务");
      edited.result = { raw: text, prose: text, participants: previous.participants, scenes: previous.scenes };
      if (current.var_changes !== undefined) edited.var_changes = current.var_changes;
    }
    this.world.setPipeline({ current: edited });
  }

  private parseJsonField<T>(text: string, schema: z.ZodType<T>, label: string): T {
    try {
      return schema.parse(extractJson(text));
    } catch (err) {
      throw new Error(`${label}解析失败：${(err as Error).message.slice(0, 300)}`, { cause: err });
    }
  }

  /** 中止当前在途 LLM 调用（停止按钮；步内捕获 LLMAbortedError 后冻结）。 */
  abortCurrent(): void {
    this.activationController?.abort();
  }

  /** 当前总轮次 seq（缓存埋点标记/测试观测用）。 */
  get turnCount(): number {
    return this.world.pipeline.seq;
  }

  /** 各角色 agent 全名（character:<id>，llm-recent 文件 slug 来源），按 cid 排序。 */
  get characterAgentNames(): string[] {
    return [...this.charAgents.keys()].sort().map((cid) => `character:${cid}`);
  }

  /** 当前世界时钟（分钟标量，测试观测用）。 */
  get worldTime(): number {
    return this.world.clock;
  }

  getState(): Record<string, unknown> {
    return { world: this.world.world, characters: this.characters.all() };
  }

  getEvents(): Event[] {
    return this.events.readAll();
  }

  getArchive(): ArchiveEntry[] {
    return this.archive.readAll();
  }

  getPipelineCurrent(): PipelineCurrent | null {
    return this.world.pipeline.current;
  }

  /** 流水线状态（WS 广播：输入权限/继续按钮/暂停态/当前步 kind）。 */
  get pipelineInfo(): { seq: number; phase: string; interrupted: boolean; kind: string | null } {
    const p: Pipeline = this.world.pipeline;
    return {
      seq: p.seq,
      phase: p.phase,
      interrupted: p.current?.interrupted === true,
      kind: p.current?.kind ?? null,
    };
  }

  getStats(): CacheStat[] {
    return readCacheStats(this.runId);
  }

  // -------------------------------------------------------------------------
  // 状态栏直接编辑（不经过裁决；world/characters 变量差异净额并入当前步 var_changes，
  // 回溯随该步一并还原；events 域不走变更记录——回溯本来按 seq 截断事件）
  // -------------------------------------------------------------------------

  /** LLM 在途标记（sessionManager 在串行任务首尾维护；含步间循环在途）。 */
  private llmBusy = false;

  /** 标记 LLM 在途/空闲（由 sessionManager 的串行队列包装调用；直接编辑空闲闸的判据）。 */
  setBusy(busy: boolean): void {
    this.llmBusy = busy;
  }

  /** LLM 是否在途（含步间循环；直接编辑在途即拒）。 */
  get isBusy(): boolean {
    return this.llmBusy;
  }

  /**
   * 直接编辑真相层（状态栏编辑）：整体替换 world 变量树 / characters 全表 / events 全表。
   * 纪律：不经过 GM 裁决。两个变量域（world/characters）的编辑差异经 diffStateTrees
   * 净额并入当前步 var_changes（手动编辑不是独立变更，而是该步窗口内的又一次改写：
   * 同路径改写末条 after，新路径尾部追加），回溯随该步一并还原——语义见前端警告；
   * events 域维持 replaceAll、不进 var_changes（回溯本来按 seq 截断事件，两域口径不同）。
   * 闸与原子性：LLM 在途拒绝；任一域校验失败整体还原已应用的域并抛错（等价不落盘）。
   * 角色集合必须与当前一致（只改内容，不增删角色——charAgents/cast 与 cid 一一对应）。
   * 应用后按回溯同款通道重建：cast 同步新角色表、各角色 agent 回放可见事件、
   * GM 回放全部事件、phase 由 deriveNext 重推落盘。
   */
  applyDirectEdit(payload: { world?: unknown; characters?: unknown; events?: unknown }): void {
    if (this.llmBusy) throw new Error("LLM 运行中：请等待当前生成结束后再直接编辑");
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new Error("直接编辑载荷必须是对象");
    }

    // 角色集合一致性预检（charAgents/cast 与 cid 一一对应，直接编辑不增删角色）
    if (payload.characters !== undefined) {
      if (typeof payload.characters !== "object" || payload.characters === null || Array.isArray(payload.characters)) {
        throw new Error("characters 必须是 {cid: 角色状态} 对象");
      }
      const currentKeys = Object.keys(this.characters.all()).sort();
      const nextKeys = Object.keys(payload.characters as Record<string, unknown>).sort();
      if (JSON.stringify(currentKeys) !== JSON.stringify(nextKeys)) {
        throw new Error("角色集合必须与当前一致（直接编辑只改内容，不增删角色）");
      }
    }

    // 应用（各 store 先校验后落盘；任一失败整体还原——等价校验失败不落盘）
    const worldSnap = this.world.snapshot();
    const charsSnap = this.characters.snapshot();
    const eventsSnap = this.events.readAll();
    try {
      if (payload.world !== undefined) this.world.replaceWorld(payload.world);
      if (payload.characters !== undefined) {
        this.characters.restoreSnapshot({
          schema_version: SAVE_SCHEMA_VERSION,
          characters: payload.characters as Record<string, CharacterState>,
        });
      }
      if (payload.events !== undefined) this.events.replaceAll(payload.events);
    } catch (err) {
      this.world.restoreSnapshot(worldSnap);
      this.characters.restoreSnapshot(charsSnap);
      this.events.replaceAll(eventsSnap);
      throw err;
    }
    this.eventSeq = this.events.readAll().length;

    // 变量域差异并入当前步 var_changes（以替换后的落盘状态为 newTree——
    // 被 schema 剥离的键不产生幻觉差异；world.time 锚强制保留由 replaceWorld 校验）
    const editChanges: VarChange[] = [];
    if (payload.world !== undefined) {
      editChanges.push(...diffStateTrees(worldSnap.world, this.world.world, "world"));
    }
    if (payload.characters !== undefined) {
      editChanges.push(...diffStateTrees(charsSnap.characters, this.characters.all(), ""));
    }
    this.mergeDirectEditChanges(editChanges);

    // 重建（与回溯同款通道）
    if (payload.characters !== undefined) {
      // cast 唯一真相 = characters 档内副本的 name：角色表被替换后同步重建
      this.cast = [
        { cid: PLAYER_CID, name: this.characters.get(PLAYER_CID).name },
        ...this.manifests.map((m) => ({ cid: m.id, name: this.characters.get(m.id).name })),
      ].sort((a, b) => a.cid.localeCompare(b.cid));
    }
    for (const [cid, agent] of this.charAgents) {
      agent.restore(this.events.readVisibleTo(cid, this.world.clock));
    }
    this.gm.restore(this.events.readAll());
    this.world.setPipeline({ phase: this.deriveNext().phase });
  }

  /**
   * 直编差异净额并入 pipeline.current.var_changes：
   * - 同路径已有记录 → 改写**最后一条**的 after（及 after_exists），不新增条目——
   *   链条净效果 = first.before → 新值（如 0→100 被直编改写为 0→50），
   *   倒序反转后回到 first.before，语义正确；
   * - 无记录 → 末尾追加；
   * - current === null（首步之前）→ 不并入：编辑即初始基线（回溯本来就越不过 seq 1）。
   * 索引安全：effects_from/markers_from 是 var_changes 的下标，因此只做末条 after 改写
   * 与尾部追加，绝不删除/重排已有条目。追加项落在 markers_from 之后——后续 editResult
   * 反转该步效应（slice(effects_from/markers_from) 尾段）会连带反掉这些追加项，可接受。
   */
  private mergeDirectEditChanges(changes: VarChange[]): void {
    if (changes.length === 0) return;
    const current = this.world.pipeline.current;
    if (current === null) return;
    const merged = [...(current.var_changes ?? [])];
    for (const change of changes) {
      let lastIdx = -1;
      for (let i = merged.length - 1; i >= 0; i--) {
        if (merged[i]!.path === change.path) lastIdx = i;
        if (lastIdx >= 0) break;
      }
      if (lastIdx >= 0) {
        const next: VarChange = { ...merged[lastIdx]!, after: change.after };
        if (change.after_exists === false) next.after_exists = false;
        else delete next.after_exists;
        merged[lastIdx] = next;
      } else {
        merged.push(change);
      }
    }
    this.world.setPipeline({ current: { ...current, var_changes: merged } });
  }
}
