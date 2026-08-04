/**
 * GameSession 会话内核（装配逻辑在 sessionFactory.ts，
 * 命令串行/会话切换在 sessionCoordinator.ts，历史展示在 historyProjection.ts）。
 *
 * 主循环（无判定轮与标记体系）。
 * 调度 = 扫描角色 timer 取最小（时钟只在弹出时跳转）；单活跃组不变量——同刻多组按
 * orderGroups 串行，组内行动顺序 = initiative 变量现排（行动顺序表，acted 角色变量）；
 * 周期完成 X+1（世界变量 cycles_since_gm），X 达 N 周期末 GM，任何 GM 激活后 X 清零；
 * 标记（gm_request/leave/recall/contact/confirm）程序即时执行，全部走 StepChanges。
 * 轮游标不存快照——deriveNext 从角色变量 + archive seq 序列现推（回溯零特例）；
 * phase 不落盘（v7）——pipelineInfo 一律 phaseOf(deriveNext(...)) 现算。
 * 每步：seq++ → 归档上一步（world.json 流水线 current → archive.json）→
 * 执行本步（效果统一经效果规划器：planActorDecision/planGmAdjudication）→
 * 结果 + StepChanges（setup/effects 分段）写流水线 current → 步边界整代提交
 * （存档 v7：六 Store 纯内存，提交经 CommitExecutor → GenerationRepository 一次写整
 * Generation，唯一写盘出口）。
 */
import { z } from "zod";
import { CharacterActivation } from "../agents/character.js";
import { GmActivation, validateAdjudicationRound } from "../agents/gm.js";
import { extractJson } from "../agents/json.js";
import { ProseActivation } from "../agents/prose.js";
import {
  AGENT_KINDS,
  DEFAULT_GM_INTERVAL_CYCLES,
  DEFAULT_PROSE_WINDOW_TURNS,
  type AgentKind,
  type LLMConfig,
} from "../config.js";
import type { UserSettings } from "../contracts/config.js";
import type { Display } from "../display.js";
import { readCacheStats } from "../llm/cacheStats.js";
import { LLMAbortedError } from "../llm/chatPort.js";
import { OpenAIChatAdapter } from "../llm/openaiChatAdapter.js";
import type { DicePort } from "../ports.js";
import {
  deriveNext,
  expectedGmDurationCids,
  phaseOf,
  selectFront,
  type DerivedPhase,
  type NextCommand,
  type SchedulerCharacter,
  type SchedulerSnapshot,
} from "../scheduler/derive.js";
import { InvitationProjection, type InvitationStepView } from "../scheduler/invitations.js";
import type { SimChar } from "../scheduler/simulator.js";
import { ArchiveStore, buildArchiveEntry, type ArchiveEntry } from "../truth/archive.js";
import { CharactersStore, type CharacterState } from "../truth/charactersStore.js";
import { CommitExecutor, type CommitReason } from "../truth/commitExecutor.js";
import { EventsStore, scanEventWatermark } from "../truth/events.js";
import type { GenerationRepository, SaveSet } from "../truth/generationRepository.js";
import { normalizeCid } from "../truth/identity.js";
import { LoreStore } from "../truth/loreStore.js";
import { SAVE_SCHEMA_VERSION } from "../truth/saveSchema.js";
import { deepFreeze, type DeepReadonly } from "../truth/snapshot.js";
import { adoptTruth, cloneTruth, collectSave, type TruthStores } from "../truth/stores.js";
import { TimeStore } from "../truth/timeStore.js";
import type { VarChange } from "../truth/varChanges.js";
import { diffStateTrees } from "../truth/varDiff.js";
import { DisposedSessionError } from "../truth/validation/errors.js";
import { renderScene, renderSpeech, type WorkingSetEntry } from "../truth/workingSet.js";
import {
  emptyStepChanges,
  flatChanges,
  WorldStore,
  type Pipeline,
  type PipelineCurrent,
  type StepChanges,
} from "../truth/worldStore.js";
import {
  AdjudicationPackageSchema,
  DecisionPackageSchema,
  type AdjudicationPackage,
  type CacheStat,
  type DecisionPackage,
  type Event,
} from "../types.js";
import { planActorDecision, type ActorInvitationContext } from "./actorEffects.js";
import { ActivationContextBuilder, remoteCidsOf, type ActivationStatics } from "./activationContexts.js";
import { planGmAdjudication } from "./gmEffects.js";
import {
  type ArchivedProseResult,
  type StepLike,
} from "./historyProjection.js";
import type { CommitNotice, TruthRoots } from "./transitionProjection.js";
import {
  prepareNextCommand as runPrepareNextCommand,
  type DeterministicRulePort,
  type PrepareResult,
} from "./prepareNextCommand.js";
import {
  applyScheduleSetup,
  cycleCountOf,
  playableCharacters,
  playerCidOf,
  rederiveGroups,
  simCharsOf,
} from "./scheduleEffects.js";
import { projectWorkingSet } from "./workingSetProjection.js";

// ---------------------------------------------------------------------------
// 调度派生：时间轴与轮状态全派生，无独立存储
// 派生逻辑在 scheduler/derive.ts（纯逻辑）；本层只负责快照构建与 setup 落账。
// ---------------------------------------------------------------------------

/** 玩家命令分支（stepPlayer 的调度上下文）。 */
type PlayerCommand = Extract<NextCommand, { type: "player" }>;
/** 角色命令分支（stepCharacter 的调度上下文）。 */
type CharacterCommand = Extract<NextCommand, { type: "character" }>;
/** GM 命令分支（stepGm 的调度上下文）。 */
type GmCommand = Extract<NextCommand, { type: "gm" }>;

/**
 * 暂停选项：自动继续 = 全部 false。
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

/**
 * 六真相 Store 成组视图 TruthStores + cloneTruth/adoptTruth/collectSave 已公共化至
 * src/truth/stores.ts（session 内核与效果规划器共用）；本类只保留 liveTruth() 视图。
 */

/** GameSession 注入式构造的全部依赖（装配 = sessionFactory.createGameSession）。 */
export interface GameSessionDeps {
  runId: string;
  /** 无状态角色 activation（单一实例服务全部 NPC，角色差异全在逐调用 Context）。 */
  character: CharacterActivation;
  gm: GmActivation;
  prose: ProseActivation;
  events: EventsStore;
  world: WorldStore;
  characters: CharactersStore;
  loreStore: LoreStore;
  timeStore: TimeStore;
  archive: ArchiveStore;
  /** 世界设定集静态文本（activation 上下文 builder 的静态部分）。 */
  statics: ActivationStatics;
  proseWindowTurns: number;
  gmIntervalCycles: number;
  rollDice: DicePort;
  repo: GenerationRepository;
  revision: number;
  /** 各 agent kind 的 OpenAI adapter（注入 fake 的 kind 无此项）：applyResolvedConfig 热更新目标。 */
  adapters: Partial<Record<AgentKind, OpenAIChatAdapter>>;
  display?: Display;
}
export class GameSession {
  readonly runId: string;
  private readonly character: CharacterActivation;
  private readonly gm: GmActivation;
  private readonly prose: ProseActivation;
  private readonly events: EventsStore;
  private readonly world: WorldStore;
  private readonly characters: CharactersStore;
  private readonly loreStore: LoreStore;
  private readonly timeStore: TimeStore;
  private readonly archive: ArchiveStore;
  /** activation 上下文构建器（激活点逐调用现算 Context，无 agent 侧缓存）。 */
  private readonly contexts: ActivationContextBuilder;
  private proseWindowTurns: number;
  private gmIntervalCycles: number;
  private readonly rollDice: DicePort;
  private readonly repo: GenerationRepository;
  private currentRevision: number;
  private readonly display: Display | undefined;
  /** 提交执行器（唯一提交入口；六条写盘路径全部经它，见 commitGeneration/commitTruth）。 */
  private readonly executor: CommitExecutor;
  /** 各 agent kind 的 OpenAI adapter（装配时建立，注入 fake 的 kind 无此项）：配置事务保存后经 applyResolvedConfig 热更新。 */
  private readonly adapters: Partial<Record<AgentKind, OpenAIChatAdapter>>;

  /**
   * 注入式构造：依赖全部由 sessionFactory 组装。
   * 构造尾完成开局序列：新档开局组派生 + 首组先攻投掷（revision 0 判据；初始状态的一部分，
   * 不产生变更记录——它在 seq 1 之前，回溯永不越过）→ 断点恢复（邀请投影重建）→
   * 新档首次写盘（整代 Generation 1，唯一写盘出口；续档不写）→ 恒冻结
   * （续档无首次提交，这里统一冻结一次；新档由 commitGeneration 冻过，幂等）。
   */
  constructor(deps: GameSessionDeps) {
    this.runId = deps.runId;
    this.character = deps.character;
    this.gm = deps.gm;
    this.prose = deps.prose;
    this.events = deps.events;
    this.world = deps.world;
    this.characters = deps.characters;
    this.loreStore = deps.loreStore;
    this.timeStore = deps.timeStore;
    this.archive = deps.archive;
    this.contexts = new ActivationContextBuilder(deps.statics);
    this.proseWindowTurns = deps.proseWindowTurns;
    this.gmIntervalCycles = deps.gmIntervalCycles;
    this.rollDice = deps.rollDice;
    this.repo = deps.repo;
    this.currentRevision = deps.revision;
    this.display = deps.display;
    this.adapters = deps.adapters;
    this.executor = new CommitExecutor(deps.repo);
    this.committedRoots = this.currentRoots();
    const isNew = this.currentRevision === 0;
    if (isNew) this.rederiveGroups(this.liveTruth(), false);
    this.restoreFromDisk();
    if (isNew) this.commitGeneration("init", []);
    this.freezeTruth();
  }

  private eventSeq = 0;
  private pauseOptions: PauseOptions = AUTO_CONTINUE;
  /** 当前 activation 的 AbortController（每次 LLM activation 新建；stop 经 abortCurrent 中止它）。 */
  private activationController: AbortController | null = null;
  /**
   * 提交通知钩子（消息身份/增量同步）：每次提交（commitGeneration/commitTruth）成功后
   * 同步回调一次，携带 prev/next 根引用（恒冻结 → 零拷贝）。由 SessionCoordinator 挂接
   * （装配发生在构造之后，构造期的 init 提交不触发广播——会话建立走 snapshot）。
   */
  onCommit: ((notice: CommitNotice) => void) | null = null;
  /** 最近一次提交后的三域根引用（下一次提交的 prev；引用差分基准）。 */
  private committedRoots: TruthRoots;
  /** activationId 会话内单调计数器（`${runId}:act:${n}`，确定性，不扩 IdPorts）。 */
  private activationSeq = 0;
  /** 当前在途 activation 的 ID（stop 的定向中止核对用；无在途为 null）。 */
  private activeActivationId: string | null = null;
  /** 已销毁旗标（强制切换兜底）：dispose 后任何提交/新步启动抛 DisposedSessionError。 */
  private disposedFlag = false;

  /**
   * 热应用已解析配置（配置事务的唯一热更新入口；由 configService 事务在保存成功后
   * 经 SessionCoordinator.applyResolvedConfig 转发——**同一份 resolved 对象**，会话不再
   * 自读配置文件）：各 OpenAI adapter 原地换配置（在途调用不受影响；注入 fake 的 kind
   * 无 adapter，跳过），滑窗/GM 间隔立即生效（settings 缺省字段回落默认值）。
   */
  applyResolvedConfig(configs: Record<AgentKind, LLMConfig>, settings: UserSettings): void {
    for (const kind of AGENT_KINDS) this.adapters[kind]?.updateConfig(configs[kind]);
    this.proseWindowTurns = settings.proseWindowTurns ?? DEFAULT_PROSE_WINDOW_TURNS;
    this.gmIntervalCycles = settings.gmIntervalCycles ?? DEFAULT_GM_INTERVAL_CYCLES;
  }

  /** 设置暂停选项（内存态；SessionCoordinator 经 WS 下发，续档/新会话由协调器重新套用）。 */
  setPauseOptions(options: PauseOptions): void {
    this.pauseOptions = { ...options };
  }


  /** live 六 Store 的 TruthStores 视图（正常步路径的显式 truth 实参）。 */
  private liveTruth(): TruthStores {
    return {
      world: this.world,
      characters: this.characters,
      events: this.events,
      archive: this.archive,
      loreStore: this.loreStore,
      timeStore: this.timeStore,
    };
  }

  /** live 真相数据递归冻结（恒冻结策略：越界写入在测试中立刻抛 TypeError）。幂等。 */
  private freezeTruth(): void {
    deepFreeze(this.world.saveData());
    deepFreeze(this.characters.saveData());
    deepFreeze(this.events.saveData());
    deepFreeze(this.archive.saveData());
    deepFreeze(this.loreStore.saveData());
    deepFreeze(this.timeStore.saveData());
  }

  /** 当前三域根引用（提交差分的 next；恒冻结后引用即不可变快照）。 */
  private currentRoots(): TruthRoots {
    return {
      world: this.world.world,
      characters: this.characters.all(),
      events: this.events.saveData(),
    };
  }

  /** 提交成功后通知（引用差分基准前移 + onCommit 回调；回调异常不破坏已完成的提交）。 */
  private notifyCommit(reason: CommitReason, fromRevision: number): void {
    const prev = this.committedRoots;
    const next = this.currentRoots();
    this.committedRoots = next;
    if (this.onCommit === null) return;
    try {
      this.onCommit({ reason, fromRevision, revision: this.currentRevision, prev, next });
    } catch (err) {
      console.warn(`[GameSession] onCommit 回调异常（提交已完成，不受影响）：${(err as Error).message}`);
    }
  }

  /** 销毁闸（强制切换）：dispose 后旧任务的任何提交一律拒绝（晚到结果不得落真相/触发广播）。 */
  private assertAlive(): void {
    if (this.disposedFlag) throw new DisposedSessionError(this.runId);
  }

  /**
   * 步边界整代提交（存档 v7 唯一写盘出口，live 路径）：六 Store 内存态 →
   * CommitPlan → CommitExecutor → 新 Generation + CURRENT 前移 → live 数据冻结。
   * 调用点：finishStep 尾 / handleStepError interrupted 分支 / create 新档首次（init）。
   * 编辑/回溯/直编不走这里——它们在 draft 上操作后经 commitTruth 提交（失败零副作用）。
   */
  private commitGeneration(reason: CommitReason, changes: VarChange[]): void {
    this.assertAlive();
    const fromRevision = this.currentRevision;
    this.currentRevision = this.executor.commit(
      { transactionId: `tx-${this.currentRevision + 1}`, baseRevision: this.currentRevision, reason, changes },
      collectSave(this.liveTruth()),
    );
    this.freezeTruth();
    this.notifyCommit(reason, fromRevision);
  }

  /**
   * draft 提交总出口（editResult/rollbackTo/applyDirectEdit）：
   * 收集 draft → executor.commit（含 baseRevision 校验 + validateSaveSet，失败即抛）→
   * adoptTruth → 冻结。**commit 成功前 live 内存/CURRENT/磁盘 Generation 三不变**；
   * 失败后 draft 直接丢弃，连内存都不动（比旧 try/catch 快照还原更强）。
   */
  private commitTruth(draft: TruthStores, reason: CommitReason, changes: VarChange[]): void {
    this.assertAlive();
    const fromRevision = this.currentRevision;
    this.currentRevision = this.executor.commit(
      { transactionId: `tx-${this.currentRevision + 1}`, baseRevision: this.currentRevision, reason, changes },
      collectSave(draft),
    );
    adoptTruth(this.liveTruth(), draft);
    this.freezeTruth();
    this.notifyCommit(reason, fromRevision);
  }

  /**
   * 错误再同步（步内非 abort 失败 → 内存可能已偏离磁盘）：
   * 从 CURRENT Generation 重建六 Store 数据（**对象身份保持**——GameSession 持有
   * Store 引用，用数据替换而非换新实例）。activation 无状态，无缓存需重建。
   */
  private rehydrate(): void {
    const loaded = this.repo.loadCurrent();
    this.currentRevision = loaded.revision;
    const save = loaded.save;
    this.world.restoreData({ schema_version: SAVE_SCHEMA_VERSION, world: save.world, pipeline: save.pipeline });
    this.characters.restoreSnapshot({ schema_version: SAVE_SCHEMA_VERSION, characters: save.characters });
    this.events.restoreData(save.events);
    this.archive.restoreData(save.archive);
    this.loreStore.restoreData(save.lore);
    this.timeStore.restoreData(save.time);
    this.eventSeq = scanEventWatermark(this.events.readAll());
    // 邀请投影重建（派生缓存：内存可能已偏离磁盘，与六 Store 同步重推）
    this.invitations = this.rebuildInvitationProjection();
    this.freezeTruth();
  }

  private restoreFromDisk(): void {
    const events = this.events.readAll();
    this.eventSeq = scanEventWatermark(events);

    // 流水线断点（工作集未清/有未归档步骤）：提示，按现算 phase 继续
    const p = this.world.pipeline;
    if (p.working_set.length > 0 || p.current !== null) {
      this.display?.summary(
        "session",
        `流水线断点恢复：seq=${p.seq} phase=${phaseOf(this.deriveCommand(this.liveTruth()))}（未裁决言行 ${p.working_set.length} 条将并入后续裁决）`,
      );
    }
    // 邀请投影全量重建（读档：从 archive + current 重推；派生缓存不落盘）
    this.invitations = this.rebuildInvitationProjection();
  }

  // eventSeq 是 ID 水位（scanEventWatermark 扫 evt_(\d+) 最大后缀），不是事件数：
  // 删中段/直编事件表后新 ID 仍不与现存冲突（续档/回溯/直编五处重推点均走水位）。
  /**
   * 事件 ID 分配器（闭包）：draft 安全——只在局部计数器上推进，
   * this.eventSeq 由调用方在 commit 成功后一次性推进（commit 失败水位不动）。
   */
  private eventIdAllocator(startFrom: number): { allocate: () => string; watermark: () => number } {
    let current = startFrom;
    return {
      allocate: () => {
        current += 1;
        return `evt_${String(current).padStart(4, "0")}`;
      },
      watermark: () => current,
    };
  }

  /** 全部角色同构条目（characters.json 不再存 GM 伪角色）。 */
  private playable(truth: TruthStores): Record<string, CharacterState> {
    return playableCharacters(truth);
  }

  /** 玩家操控角色 cid（await_player 一律按 isPlayer 判定，不硬编码 C0；缺省回落 C0）。 */
  private playerCid(truth: TruthStores): string {
    return playerCidOf(truth);
  }

  /** 调度视图（SimChar；委托 scheduleEffects.simCharsOf，timer 直传存储原值）。 */
  private simChars(truth: TruthStores): Record<string, SimChar> {
    return simCharsOf(truth);
  }

  /** 周期计数 X（世界变量 cycles_since_gm；缺省 0）。 */
  private cycleCount(truth: TruthStores): number {
    return cycleCountOf(truth);
  }

  /**
   * 邀请投影（派生缓存：不进 Generation/CommitPlan）。
   * 正常推进：finishStep 的 commitGeneration 成功后 applyStep 增量一步；
   * 读档/rehydrate/回滚/编辑/直编后一律 rebuildInvitationProjection 全量重建（成本低）。
   */
  private invitations = new InvitationProjection();

  /**
   * 提交步 → 邀请投影步视图（kind/seq/decision.markers/invitation.accepted 显式构造）。
   * player 步转写为 character:<playerCid>（投影无 player 概念）；
   * accepted = decision.markers 有无 confirm。
   */
  private invitationStepView(truth: TruthStores, seq: number, kind: string, result: unknown): InvitationStepView {
    const r = result as { decision?: DecisionPackage; invitation?: { contactSeq: number } } | null;
    const view: InvitationStepView = {
      seq,
      kind: kind === "player" ? `character:${this.playerCid(truth)}` : kind,
    };
    const markers = r?.decision?.markers;
    if (markers !== undefined && markers.length > 0) {
      // contact 目标归一化（CID_PATTERN 允许 @ 前缀，落库一律去 @；与原 derivePendingInvitee 同口径）
      view.decisionMarkers = markers.map((m) =>
        m.type === "contact" ? { type: m.type, channel: m.channel, targets: m.targets.map(normalizeCid) } : m,
      );
    }
    if (r?.invitation !== undefined) {
      view.invitation = {
        contactSeq: r.invitation.contactSeq,
        accepted: (markers ?? []).some((m) => m.type === "confirm"),
      };
    }
    return view;
  }

  /** 从 archive + current 全量重建邀请投影（读档/回滚/编辑/直编后；不判断是否影响邀请语义）。 */
  private rebuildInvitationProjection(): InvitationProjection {
    const truth = this.liveTruth();
    const current = truth.world.pipeline.current;
    const steps: StepLike[] = [...truth.archive.readAll(), ...(current !== null ? [current] : [])];
    return InvitationProjection.rebuild(
      steps.map((s) => this.invitationStepView(truth, s.seq, s.kind, s.result)),
    );
  }

  /** 调度视图（SchedulerCharacter = SimChar + acted）：timer 直传存储原值。 */
  private schedulerChars(truth: TruthStores): Record<string, SchedulerCharacter> {
    const sim = this.simChars(truth);
    return Object.fromEntries(
      Object.entries(this.playable(truth)).map(([cid, s]) => [cid, { ...sim[cid]!, acted: s.acted }]),
    );
  }

  /**
   * 最小调度快照（scheduler/derive.ts deriveNext 的输入面）：
   * 角色调度变量 + 时钟 + 周期/触发变量 + 末步 kind/narrativity + 邀请 pending 视图。
   * pendingInvitation 两阶段得出（front 是派生量：先 selectFront，再交投影 nextPending）。
   */
  private buildSnapshot(truth: TruthStores): SchedulerSnapshot {
    const chars = this.schedulerChars(truth);
    const clock = truth.world.clock;
    const current = truth.world.pipeline.current;
    const archive = truth.archive.readAll();
    const last = current ?? archive[archive.length - 1];
    const sel = selectFront(chars, clock);
    const gmBatch: unknown = truth.world.world["gm_trigger_batch"];
    const lastGmPkg =
      last?.kind === "gm"
        ? (last.result as { adjudication?: AdjudicationPackage } | undefined)?.adjudication
        : undefined;
    return {
      chars,
      clock,
      cycleCount: this.cycleCount(truth),
      gmIntervalCycles: this.gmIntervalCycles,
      gmTrigger: truth.world.world["gm_trigger"] === true,
      gmTriggerBatch: typeof gmBatch === "number" ? gmBatch : null,
      lastStepKind: last?.kind ?? null,
      lastGmNarrativity: lastGmPkg?.narrativity ?? null,
      pendingInvitation: sel === null ? null : this.invitations.nextPending(sel.front, chars),
    };
  }

  /**
   * 下一步派生（scheduler/derive.ts 纯函数出口；只读查询（pipelineInfo.phase 现算、
   * 断点恢复提示）用本适配器；执行入口一律走 prepareNextCommand（统一收口）。
   */
  private deriveCommand(truth: TruthStores): NextCommand {
    return deriveNext(this.buildSnapshot(truth));
  }

  /**
   * 确定性规则端口集（确定性计算层）：
   * 当前为空——固定规则/从动变量规则经此接入；投骰不属于本层
   * （先攻补投在效果规划器内，属该步骤的 effects）。
   */
  private readonly deterministicRules: readonly DeterministicRulePort[] = [];

  /**
   * 执行入口统一收口：玩家输入权限检查 /
   * 手动与自动继续（runPipeline 每步）/ 编辑·直编·回滚后的派生态刷新共用。
   * 当前 rules 为空 → 恒走短路（不建 draft，直接 deriveNext）。
   */
  private prepareNextCommand(): PrepareResult {
    return runPrepareNextCommand({
      liveTruth: this.liveTruth(),
      cloneTruth,
      commit: (draft, changes) => this.commitTruth(draft, "step", changes),
      rebuildProjections: () => {
        this.invitations = this.rebuildInvitationProjection();
      },
      buildSnapshot: (truth) => this.buildSnapshot(truth),
      rules: this.deterministicRules,
    });
  }

  /**
   * 开步（归档写入时机）：seq++，把上一步（流水线 current，含其 StepChanges）
   * 写入 archive.json，然后进入本步。
   */
  private startStep(): number {
    const seq = this.world.pipeline.seq + 1;
    const entry = buildArchiveEntry(this.world.pipeline.current);
    if (entry !== null) this.archive.append(entry);
    this.world.setPipeline({ seq, current: null });
    return seq;
  }

  /** 收步：本步结果 + StepChanges（setup/effects 分段）暂存流水线 current（下一步启动时归档），随后整代提交。 */
  private finishStep(seq: number, kind: string, result: unknown, changes: StepChanges): void {
    this.world.setPipeline({ current: { seq, kind, result, changes } });
    const truth = this.liveTruth();
    const stepView = this.invitationStepView(truth, seq, kind, result);
    this.commitGeneration(kind === "gm" ? "gm" : "step", flatChanges(changes));
    // 真相已提交：邀请投影正式增量。失败 → 丢弃投影并从已提交历史重建，不得反向撤销真相
    try {
      this.invitations.applyStep(stepView);
    } catch (err) {
      console.warn(`[GameSession] 邀请投影增量失败，已从已提交历史重建：${(err as Error).message}`);
      this.invitations = this.rebuildInvitationProjection();
    }
  }

  /** 组派生 + 先攻补投（application/scheduleEffects 的薄委托：开局（record=false）与规划器外部调用点用）。 */
  private rederiveGroups(truth: TruthStores, record = true): VarChange[] {
    return rederiveGroups(truth, this.rollDice, record);
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

  /** 邀请上下文（应答步激活）：planner 输入与 result 留存（编辑重放输入）共用同一份。 */
  private invitationCtx(
    truth: TruthStores,
    cid: string,
    invitation: { contactSeq: number; inviter: string; channel: string } | undefined,
  ): ActorInvitationContext | undefined {
    if (invitation === undefined) return undefined;
    return {
      contactSeq: invitation.contactSeq,
      inviter: invitation.inviter,
      channel: invitation.channel,
      preInviteTimer: truth.characters.get(cid).timer,
    };
  }

  /** 玩家轮：输入进工作集（玩家输入即其本轮行动；纯文本回退映射为台词，与 NPC 同一 planActorDecision）。 */
  private stepPlayer(input: string, cmd: PlayerCommand): void {
    const truth = this.liveTruth();
    const cid = this.playerCid(truth);
    const seq = this.startStep();
    const invitation = this.invitationCtx(truth, cid, cmd.invitation);
    const setup = applyScheduleSetup(truth, cmd.setup);
    // 邀请应答激活：timer 置当前时钟弹出（立即到期；setup 段 before = 邀请前值，拒绝时据此还原）
    if (invitation !== undefined) setup.push(...truth.characters.setVars(cid, { timer: truth.world.clock }));
    const pkg = this.parsePlayerInput(input) ?? { inner: input, dialogue: input };
    const effects = planActorDecision(truth, { cid, pkg, ...(invitation !== undefined ? { invitation } : {}), rollDice: this.rollDice });
    // 邀请应答步记邀请上下文（与角色步同形）：邀请投影增量/重建的应答判据（显式 contactSeq + accepted）
    this.finishStep(
      seq,
      "player",
      {
        input,
        decision: pkg,
        ...(invitation !== undefined ? { invitation } : {}),
      },
      { setup, effects: effects.changes },
    );
  }

  /** 停止处理：LLMAbortedError → 冻结当前步并整代提交；其他错误先 rehydrate 回磁盘态再抛。 */
  private handleStepError(
    seq: number,
    kind: string,
    err: unknown,
    options?: { changes?: StepChanges; result?: Record<string, unknown> },
  ): void {
    if (err instanceof LLMAbortedError) {
      const current: PipelineCurrent = {
        seq,
        kind,
        result: { ...(options?.result ?? {}), raw: err.partialText },
        interrupted: true,
      };
      if (options?.changes !== undefined) current.changes = options.changes;
      this.world.setPipeline({ current });
      this.commitGeneration(kind === "gm" ? "gm" : "step", flatChanges(options?.changes));
      this.display?.summary(kind, "（已停止：可编辑补全或回溯）");
      return;
    }
    // 写盘屏障后步内变异只改了内存：先回到磁盘上的上一 Generation，防内存/磁盘分叉
    try {
      this.rehydrate();
    } catch (syncError) {
      console.warn(`[GameSession] 错误再同步失败（内存可能已偏离磁盘）：${(syncError as Error).message}`);
    }
    throw err;
  }

  /**
   * 本轮 #当前场景（角色视角）与远程成员集：纯派生逻辑已迁至 activationContexts.ts
   * （sceneForCid/remoteCidsOf，truth 显式入参），角色/GM 上下文逐调用现算。
   */

  /** 角色轮。 */
  private async stepCharacter(cid: string, cmd: CharacterCommand): Promise<void> {
    const truth = this.liveTruth();
    const seq = this.startStep();
    const invitation = this.invitationCtx(truth, cid, cmd.invitation);
    const setup = applyScheduleSetup(truth, cmd.setup);
    // 邀请应答激活：timer 置当前时钟弹出（立即到期；setup 段 before = 邀请前值，拒绝时据此还原）
    if (invitation !== undefined) setup.push(...truth.characters.setVars(cid, { timer: truth.world.clock }));
    const kind = `character:${cid}`;
    // 无状态 activation：全量上下文逐调用现算（含被联系通知——仅邀请应答步注入）
    const context = this.contexts.character({
      truth,
      cid,
      proseWindowTurns: this.proseWindowTurns,
      ...(invitation !== undefined
        ? { invitation: { inviter: invitation.inviter, channel: invitation.channel } }
        : {}),
    });
    const name = truth.characters.get(cid).name;
    const activationId = `${this.runId}:act:${++this.activationSeq}`;
    this.activeActivationId = activationId;
    this.display?.agentStart(kind, `── 角色·${name} 决策 ──`, seq, activationId);
    const controller = new AbortController();
    this.activationController = controller;
    try {
      const { raw, pkg } = await this.character.decide(context, seq, controller.signal, this.display);
      // 统一效果规划器（与玩家步/编辑重放同一入口）：relations + 工作集 + acted/邀请应答 + 标记
      const effects = planActorDecision(truth, { cid, pkg, ...(invitation !== undefined ? { invitation } : {}), rollDice: this.rollDice });
      // 邀请应答步另记邀请上下文（contactSeq/inviter/channel/preInviteTimer）——编辑重放的应答输入
      this.finishStep(
        seq,
        kind,
        {
          raw,
          decision: pkg,
          ...(invitation !== undefined ? { invitation } : {}),
        },
        { setup, effects: effects.changes },
      );
      this.display?.decision?.(kind, pkg, seq);
      this.display?.summary(
        kind,
        `${pkg.action !== undefined ? `行动：${pkg.action}` : "（无行动）"}${pkg.dialogue ? `；台词：${pkg.dialogue}` : ""}${pkg.relations?.length ? `（人际关系更新 ${pkg.relations.length} 条）` : ""}`,
      );
    } catch (err) {
      // 邀请应答步被停止：邀请上下文随 interrupted 结果留存（编辑补全后投影重建仍按已应答处理——
      // setup 已落账 timer = 当前时钟）；
      // 中止未应用业务输出：effects 空段（setup 保留）
      this.handleStepError(seq, kind, err, {
        changes: { setup, effects: [] },
        ...(invitation !== undefined ? { result: { invitation } } : {}),
      });
    } finally {
      this.activationController = null;
      this.activeActivationId = null;
      if (!this.disposedFlag) this.display?.agentEnd(kind); // 已销毁会话的晚到收尾不广播（旧 runId 隔离）
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

  /** GM 激活闸：工作集非空且本轮行动者都有计时器；未结算离开者（group=0 + timer=null）豁免，其 durations 覆盖由 GM 契约 validateAdjudicationRound 强校验。 */
  private validateWorkingSetRound(roundCids: string[]): void {
    if (roundCids.length === 0) throw new Error("GM 激活前工作集为空");
    for (const cid of roundCids) {
      const state = this.characters.get(cid);
      if (state.timer === null && state.group !== 0) {
        throw new Error(`GM 激活前校验失败：${cid} 无计时器`);
      }
    }
  }

  /**
   * GM 裁决包 durations 必须精确覆盖的 cid 集（去重排序）。
   * 逻辑在 scheduler/derive.ts（纯函数）；本方法仅为薄委托——gmDurationCoverage 行为保护网直测本方法。
   * 语义：全体同步组成员（行动者所在非零组的全体成员，以组成员身份为准、无论其 timer 值）
   * ∪ 刚从同步组离开的成员（已由 roundCids 覆盖）。
   */
  private expectedGmDurationCids(truth: TruthStores, roundCids: string[]): string[] {
    return expectedGmDurationCids(this.schedulerChars(truth), roundCids);
  }

  /** GM 轮。 */
  private async stepGm(cmd: GmCommand): Promise<void> {
    const truth = this.liveTruth();
    const workingSet = truth.world.pipeline.working_set;
    const roundCids = [...new Set(workingSet.map((e) => e.cid))];
    this.validateWorkingSetRound(roundCids);
    // roundCids（工作集行动者）语义不变；durations 契约基准另算（中途 GM 含同步组全体未行动成员）
    const durationCids = this.expectedGmDurationCids(truth, roundCids);
    const seq = this.startStep();
    const setup = applyScheduleSetup(truth, cmd.setup);
    const roundScenes = Object.fromEntries(
      roundCids.map((cid) => [cid, truth.characters.get(cid).group]),
    );
    // 无状态 activation：GM 上下文逐调用现算（lore 档内副本逐调用渲染）
    const context = this.contexts.gm({
      truth,
      proseWindowTurns: this.proseWindowTurns,
      sceneText: renderScene(workingSet, undefined, remoteCidsOf(truth)),
      roundScenes,
    });
    const gmActivationId = `${this.runId}:act:${++this.activationSeq}`;
    this.activeActivationId = gmActivationId;
    this.display?.agentStart(this.gm.agentName, `── GM 裁决 ──`, seq, gmActivationId);
    const controller = new AbortController();
    this.activationController = controller;
    try {
      const { raw, pkg } = await this.gm.adjudicate(
        context,
        seq,
        durationCids,
        controller.signal,
        this.display,
      );
      // 真相段：统一规划器（含事件 ID 闭包分配）→ finishStep 提交 → 成功后才推进水位
      const allocator = this.eventIdAllocator(this.eventSeq);
      const effects = planGmAdjudication(truth, {
        seq,
        pkg,
        roundCids,
        allocateEventId: allocator.allocate,
        rollDice: this.rollDice,
      });
      this.finishStep(
        seq,
        "gm",
        { raw, adjudication: pkg, round_scenes: roundScenes },
        { setup, effects: effects.changes },
      );
      this.eventSeq = allocator.watermark();
      this.display?.adjudication?.(this.gm.agentName, pkg, seq);
      this.display?.summary(
        this.gm.agentName,
        `narrativity ${pkg.narrativity} · 事件 ${pkg.events.length} 条 · delta ${pkg.deltas.length} 条`,
      );
    } catch (err) {
      this.handleStepError(seq, "gm", err, { result: { round_scenes: roundScenes } });
    } finally {
      this.activationController = null;
      this.activeActivationId = null;
      if (!this.disposedFlag) this.display?.agentEnd(this.gm.agentName);
    }
  }

  /** 正文轮。 */
  private async stepProse(): Promise<string> {
    const truth = this.liveTruth();
    const seq = this.startStep();
    // 本轮各角色台词+内心（不含行为意图）：从 archive 本轮角色步现取（这些步已归档）
    const round = this.roundSteps();
    const speech = renderSpeech(
      round.map((s): WorkingSetEntry => {
        if (s.kind === "player") {
          return { cid: this.playerCid(truth), input: (s.result as { input: string }).input };
        }
        return {
          cid: s.kind.slice("character:".length),
          decision: (s.result as { decision: DecisionPackage }).decision,
        };
      }),
    );
    const roundCids = [...new Set(round.map((s) => (s.kind === "player" ? this.playerCid(truth) : s.kind.slice("character:".length))))];
    const gmStep = [...this.archive.readAll()].reverse().find((e) => e.kind === "gm");
    if (gmStep === undefined) throw new Error("正文轮找不到本轮 GM 场景元数据");
    const scenes = (gmStep.result as { round_scenes: Record<string, number> }).round_scenes;
    // 无状态 activation：正文上下文（近期事件/触发 lore/上轮正文/演员表）逐调用现算
    const context = this.contexts.prose({
      truth,
      proseWindowTurns: this.proseWindowTurns,
      adjudication: this.currentAdjudication(),
      currentScene: speech,
      participantCids: roundCids,
    });
    const proseActivationId = `${this.runId}:act:${++this.activationSeq}`;
    this.activeActivationId = proseActivationId;
    this.display?.agentStart(this.prose.agentName, `── 正文 ──`, seq, proseActivationId);
    const controller = new AbortController();
    this.activationController = controller;
    try {
      const proseText = await this.prose.render(context, seq, controller.signal, this.display);
      const result: ArchivedProseResult = {
        raw: proseText,
        prose: proseText,
        participants: roundCids,
        scenes,
      };
      this.finishStep(seq, "prose", result, emptyStepChanges());
      return proseText;
    } catch (err) {
      this.handleStepError(seq, "prose", err, {
        changes: emptyStepChanges(),
        result: { participants: roundCids, scenes },
      });
      return "";
    } finally {
      this.activationController = null;
      this.activeActivationId = null;
      if (!this.disposedFlag) this.display?.agentEnd(this.prose.agentName);
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
      this.assertAlive(); // 强制切换兜底：已销毁会话不得再开新步（在途 LLM 由 abort 中止）
      if (this.world.pipeline.current?.interrupted === true) return prose; // 冻结在暂停态
      const cmd = this.prepareNextCommand().command;
      if (cmd.type === "player") {
        if (cmd.reason === "deadlock") {
          console.warn("调度死锁防御：全员无计时器，停等玩家输入（请检查 GM 是否漏设 timer）");
        }
        return prose;
      }
      if (lastKind !== null) {
        const pause = this.pauseOptions;
        if (pause.everyStep) return prose; // 每轮暂停：每步完成后停
        if (cmd.type === "gm" && pause.beforeGm) return prose; // GM 前暂停
        if (lastKind === "gm" && pause.afterGm) return prose; // GM 后暂停
        if (lastKind === "prose" && pause.afterProse) return prose; // 正文后暂停
      }
      if (cmd.type === "character") await this.stepCharacter(cmd.cid, cmd);
      else if (cmd.type === "gm") await this.stepGm(cmd);
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

  /** 玩家输入：仅在派生命令 = player 时接受（暂停态权限框架）；输入即其本轮行动。 */
  async handlePlayerInput(input: string): Promise<string> {
    if (this.world.pipeline.current?.interrupted === true) {
      throw new Error("当前步已被停止：请先回溯或编辑补全");
    }
    const cmd = this.prepareNextCommand().command; // 权限检查走统一入口
    if (cmd.type !== "player") {
      // 指明当前在等谁（直编调度变量后 phase 可能刚变，模糊措辞会误导玩家反复输入）
      const waiting =
        cmd.type === "character"
          ? `角色 ${this.characters.get(cmd.cid).name}（${cmd.cid}）行动`
          : cmd.type === "gm"
            ? "GM 裁决"
            : "正文渲染";
      throw new Error(`现在不是玩家回合：正在等待${waiting}。请先继续、回溯或编辑`);
    }
    this.stepPlayer(input, cmd);
    // 玩家步已完成：预置 lastKind 让暂停选项对本次续跑生效（如 GM 前暂停拦在玩家步之后的 GM）
    return this.runPipeline("player");
  }

  /**
   * 回溯到 targetSeq（= 回到第 targetSeq 步刚完成的位置）：
   * **倒序反向执行变量变更**——先反向当前步（若 current.seq > targetSeq），
   * 再逐条弹出 archive 中 seq > targetSeq 的条目并反向其 StepChanges
   * （倒序 effects 再倒序 setup ≡ 扁平倒序；只消费记录的 before，
   * 不重新解析旧输出、不调规划器、不重投骰），直到 current = 第 targetSeq 条、
   * archive ≤ targetSeq-1（不变量：归档只到上一步、current = 最新步）。
   * 回滚后变量与第 targetSeq 步结束时逐字节一致。
   * events 截到 seq ≤ targetSeq；lore 按 changelog 反向回滚（均不留底）；
   * phase 不落盘（pipelineInfo 现算）；llm-recent 不动。
   * 全程在 draft 上执行，一次 commitTruth（reason="rollback"）后 adopt——
   * revision 递增、seq 回退；commit 失败则 live 零变化。
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
      if (e.changes === undefined) {
        throw new Error(`归档第 ${e.seq} 步无变更记录，无法回滚变量`);
      }
    }

    // 2. draft：反向当前步（它就是要被回滚掉的最新步）+ 逐条弹出反向（倒序）
    const draft = cloneTruth(this.liveTruth());
    const dp = draft.world.pipeline;
    if (dp.current !== null && dp.current.seq > targetSeq) {
      this.revertVarChanges(draft, flatChanges(dp.current.changes));
    }
    for (const e of toRevert) {
      this.revertVarChanges(draft, flatChanges(e.changes));
    }

    // 3. 截断/回滚各文件
    draft.archive.truncateToSeq(targetSeq - 1);
    draft.events.truncateToSeq(targetSeq);
    draft.loreStore.rollbackToSeq(targetSeq);

    // 4. 流水线：current = 弹出步（丢弃原 current——那正是被回溯掉的内容）；
    // 工作集投影：切片 = 截断后 archive + 目标 current（目标本身是 gm/prose 时自然为空）
    const current: PipelineCurrent = {
      seq: popped.seq,
      kind: popped.kind,
      result: popped.result,
      ...(popped.changes !== undefined ? { changes: popped.changes } : {}),
      ...(popped.edited === true ? { edited: true } : {}),
    };
    draft.world.setPipeline({
      seq: targetSeq,
      current,
      working_set: projectWorkingSet([...draft.archive.readAll(), current], this.playerCid(draft)),
    });

    // 5. 一次提交（回滚结果 = 新 Generation）→ adopt；commit 成功后才推进水位
    this.commitTruth(draft, "rollback", []);
    this.eventSeq = scanEventWatermark(this.events.readAll());
    // 邀请投影全量重建（commit 后 live == draft，统一走重建出口）
    this.invitations = this.rebuildInvitationProjection();
    // commit 后立即经统一入口刷新派生态（下一次权限检查必须立即得到新顺序；短路路径成本可忽略）
    this.prepareNextCommand();
  }

  /** 倒序反向执行一组变量变更（world.* → world；characters.C*.* → characters）。 */
  private revertVarChanges(truth: TruthStores, changes: readonly VarChange[]): void {
    for (const c of [...changes].reverse()) {
      if (c.path.startsWith("world.")) truth.world.revertChange(c);
      else if (/^characters\.C(?:0|[1-9]\d*)\./.test(c.path)) truth.characters.revertChange(c);
      else throw new Error(`无法分发反向变量路径: ${c.path}`);
    }
  }

  /**
   * 手动编辑当前步原始返回（编辑-继续合并）：
   * zod 校验（决策包/GM 裁决包必须合法 JSON；正文纯文本直接过）→
   * 写回 pipeline.current.result 并置 edited、清 interrupted。
   * 编辑 = 该步的一次新输出：setup 段原样保留，draft 上倒序反转旧 effects 段后，
   * 用**与正常路径同一效果规划器**（planActorDecision/planGmAdjudication）生成新
   * effects 段（relations/工作集/acted/邀请应答/标记/GM 效应全部同规则，无手工复制）；
   * invitation 上下文保留在 result（重放输入，非下标）。
   * 已完成 GM 步（含回滚到 GM 步）可编辑：旧 effects 先整体反向（变量倒序+事件截断），
   * 再按编辑包重新裁决——事件替换提交（activation 无状态，无缓存需重建）。
   * **draft 机制**：解析在任何变异之前（失败抛错，draft 直接丢弃，内存零变化）；
   * 全部变异以 draft 为靶（GM 分支同样在 draft 上先反转旧效应、后 validateAdjudicationRound——
   * 校验失败 draft 丢弃，不再留下"已反转状态"），一次 commitTruth 提交后 adopt。
   * 玩家步与角色步同一路径可编辑：cid 取玩家操控角色，编辑文本必须是合法决策包 JSON。
   */
  editResult(text: string): void {
    const current = this.world.pipeline.current;
    if (current === null) throw new Error("没有可编辑的当前步");
    const edited: PipelineCurrent = { seq: current.seq, kind: current.kind, result: null, edited: true };

    if (current.kind === "player" || current.kind.startsWith("character:")) {
      // 解析失败在任何变异前抛（此时 draft 尚未建立，live 内存零变化）
      const pkg = this.parseJsonField<DecisionPackage>(text, DecisionPackageSchema, "决策包");
      const draft = cloneTruth(this.liveTruth());
      const cid = current.kind === "player" ? this.playerCid(draft) : current.kind.slice("character:".length);
      const prior = current.result as {
        invitation?: ActorInvitationContext;
      } | null;
      // setup 段原样保留；旧 effects 段整段倒序反向（revertVarChanges 内部倒序，传正序；
      // interrupted 步 effects 为空段，反向为无操作）
      const setup = [...(current.changes?.setup ?? [])];
      this.revertVarChanges(draft, current.changes?.effects ?? []);
      // 编辑 = 重读整个输出完整重放：旧工作集条目移除后与正常路径同一 planner（追加同位置语义）
      draft.world.setPipeline({
        working_set: draft.world.pipeline.working_set.filter((entry) => entry.cid !== cid),
      });
      const effects = planActorDecision(draft, {
        cid,
        pkg,
        ...(prior?.invitation !== undefined ? { invitation: prior.invitation } : {}),
        rollDice: this.rollDice,
      });
      edited.result = {
        raw: text,
        decision: pkg,
        // 玩家步保留 input：历史投影与正文工作集渲染按该字段取玩家言行
        ...(current.kind === "player" ? { input: text } : {}),
        // 邀请上下文原样保留（再次编辑的重放输入；投影重建按已应答处理）
        ...(prior?.invitation !== undefined ? { invitation: prior.invitation } : {}),
      };
      edited.changes = { setup, effects: effects.changes };
      draft.world.setPipeline({ current: edited });
      this.commitTruth(draft, "admin_edit", flatChanges(edited.changes));
    } else if (current.kind === "gm") {
      // 解析失败在任何变异前抛（draft 尚未建立，live 内存零变化）
      const pkg = this.parseJsonField<AdjudicationPackage>(text, AdjudicationPackageSchema, "裁决包");
      const draft = cloneTruth(this.liveTruth());
      const previous = current.result as { round_scenes?: Record<string, number> } | null;
      const setup = [...(current.changes?.setup ?? [])];
      if (current.interrupted === true) {
        // 暂停态：效应从未应用（effects 空段）——直接按编辑包补做（工作集仍是 GM 前的完整轮）
        const roundCids = [...new Set(draft.world.pipeline.working_set.map((e) => e.cid))];
        validateAdjudicationRound(pkg, this.expectedGmDurationCids(draft, roundCids));
        const roundScenes = previous?.round_scenes ?? Object.fromEntries(roundCids.map((cid) => [cid, draft.characters.get(cid).group]));
        const allocator = this.eventIdAllocator(scanEventWatermark(draft.events.readAll()));
        const effects = planGmAdjudication(draft, {
          seq: current.seq,
          pkg,
          roundCids,
          allocateEventId: allocator.allocate,
          rollDice: this.rollDice,
        });
        edited.result = { raw: text, adjudication: pkg, round_scenes: roundScenes };
        edited.changes = { setup, effects: effects.changes };
      } else {
        // 已完成 GM 步（含回滚到 GM 步）：旧 effects 已应用——
        // draft 上先整体反向（变量倒序 + 事件按 seq 截断）、后校验编辑包：
        // 校验失败 → draft 整体丢弃，live 内存/CURRENT/磁盘三不变。
        const preSet = projectWorkingSet(draft.archive.readAll(), this.playerCid(draft));
        const roundCids = [...new Set(preSet.map((e) => e.cid))];
        // 变量反向先行（setup 保留：编辑不触碰调度落账）：状态回到 GM 前后才能按 GM 前视角派生 durations 覆盖契约
        this.revertVarChanges(draft, current.changes?.effects ?? []);
        validateAdjudicationRound(pkg, this.expectedGmDurationCids(draft, roundCids));
        draft.events.truncateToSeq(current.seq - 1);
        const roundScenes = previous?.round_scenes ?? Object.fromEntries(roundCids.map((cid) => [cid, draft.characters.get(cid).group]));
        draft.world.setPipeline({ working_set: preSet });
        const allocator = this.eventIdAllocator(scanEventWatermark(draft.events.readAll()));
        const effects = planGmAdjudication(draft, {
          seq: current.seq,
          pkg,
          roundCids,
          allocateEventId: allocator.allocate,
          rollDice: this.rollDice,
        });
        edited.result = { raw: text, adjudication: pkg, round_scenes: roundScenes };
        edited.changes = { setup, effects: effects.changes };
      }
      draft.world.setPipeline({ current: edited });
      this.commitTruth(draft, "admin_edit", flatChanges(edited.changes));
      this.eventSeq = scanEventWatermark(this.events.readAll());
    } else {
      // prose 编辑只替换正文文本，参与者与行动时场景必须原样保留（无真相变异，走统一出口）。
      const previous = current.result as Partial<ArchivedProseResult> | null;
      if (!previous?.participants || !previous.scenes) throw new Error("正文归档缺少 participants/scenes，请新建会话/重启服务");
      edited.result = { raw: text, prose: text, participants: previous.participants, scenes: previous.scenes };
      if (current.changes !== undefined) edited.changes = current.changes;
      const draft = cloneTruth(this.liveTruth());
      draft.world.setPipeline({ current: edited });
      this.commitTruth(draft, "admin_edit", flatChanges(edited.changes));
    }

    // 邀请投影全量重建（编辑可能改变 contact/confirm 语义；成本低，不判断影响面）
    this.invitations = this.rebuildInvitationProjection();
    // commit 后立即经统一入口刷新派生态（下一次权限检查必须立即得到新顺序；短路路径成本可忽略）
    this.prepareNextCommand();
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

  /**
   * 销毁会话（会话切换与强制结束）：置旗标 + 中止在途 activation。
   * 其后 commit 闸（commitGeneration/commitTruth）与 runPipeline 开步一律抛
   * DisposedSessionError——旧 run 晚到结果不得提交真相、不得触发 onCommit 广播。
   * 已知简化：中止超时强制失效计时器不实现，本旗标即兜底。
   */
  dispose(): void {
    this.disposedFlag = true;
    this.abortCurrent();
  }

  /** 是否已销毁（Coordinator 切换会话后旧会话晚到提交防御）。 */
  get disposed(): boolean {
    return this.disposedFlag;
  }

  /** 当前在途 activation 的 ID（`${runId}:act:${n}`；无在途为 null；stop 定向中止核对用）。 */
  get currentActivationId(): string | null {
    return this.activeActivationId;
  }

  /** 当前存档 revision（SessionCoordinator 的 baseRevision 乐观并发校验基准）。 */
  get revision(): number {
    return this.currentRevision;
  }

  /** 当前总轮次 seq（缓存埋点标记/测试观测用）。 */
  get turnCount(): number {
    return this.world.pipeline.seq;
  }

  /** 当前世界时钟（分钟标量，测试观测用）。 */
  get worldTime(): number {
    return this.world.clock;
  }

  /**
   * 当前真相只读快照：六 Store 数据视图，commit 后恒冻结。
   * 查询/注入/广播共享同一 revision 根；写入会在运行期抛 TypeError（编译期由 DeepReadonly 挡）。
   */
  snapshot(): DeepReadonly<SaveSet> {
    return collectSave(this.liveTruth());
  }

  getState(): DeepReadonly<Pick<SaveSet, "world" | "characters">> {
    return { world: this.world.world, characters: this.characters.all() };
  }

  getEvents(): DeepReadonly<Event[]> {
    return this.events.readAll();
  }

  getArchive(): DeepReadonly<ArchiveEntry[]> {
    return this.archive.readAll();
  }

  getPipelineCurrent(): DeepReadonly<PipelineCurrent> | null {
    return this.world.pipeline.current;
  }

  /** 流水线状态（WS 广播：输入权限/继续按钮/暂停态/当前步 kind）。
   * phase 不落盘（v7）：协议字段名不变，值由 phaseOf(deriveCommand(...)) 现算（收窄为派生枚举）。 */
  get pipelineInfo(): { seq: number; phase: DerivedPhase; interrupted: boolean; kind: string | null } {
    const p: Pipeline = this.world.pipeline;
    return {
      seq: p.seq,
      phase: phaseOf(this.deriveCommand(this.liveTruth())),
      interrupted: p.current?.interrupted === true,
      kind: p.current?.kind ?? null,
    };
  }

  getStats(): CacheStat[] {
    return readCacheStats(this.runId);
  }

  // -------------------------------------------------------------------------
  // 状态栏直接编辑（不经过裁决；world/characters 变量差异净额并入当前步 StepChanges.effects，
  // 回溯随该步一并还原；events 域不走变更记录——回溯本来按 seq 截断事件）
  // -------------------------------------------------------------------------

  /** LLM 在途标记（SessionCoordinator 在串行任务首尾维护；含步间循环在途）。 */
  private llmBusy = false;

  /** 标记 LLM 在途/空闲（由 SessionCoordinator 的串行队列包装调用；直接编辑空闲闸的判据）。 */
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
   * 净额并入当前步 StepChanges.effects 段（手动编辑不是独立变更，而是该步窗口内的又一次改写：
   * 同路径改写末条 after，新路径尾部追加），回溯随该步一并还原——语义见前端警告；
   * events 域维持 replaceAll、不进变更记录（回溯本来按 seq 截断事件，两域口径不同）。
   * 闸与原子性：LLM 在途拒绝；**draft 机制**——任一域校验失败 draft 直接丢弃，
   * live 内存/CURRENT/磁盘 Generation 三不变（连内存都不动）。
   * 角色集合必须与当前一致（只改内容，不增删角色——cast 由 builder 逐调用现建，无需同步）。
   * 提交前对 draft 重派生编组（rederiveGroups：直编对齐 timer 后立即并组，组未变则零变更），
   * 派生变更与直编差异并入同一次 commit（回溯随该步一并还原）。
   * commit 成功后重建派生态：邀请投影全量重建 + prepareNextCommand 刷新；
   * phase 不落盘（pipelineInfo 现算，直编改调度变量后下一次查询即反映）。
   */
  applyDirectEdit(payload: { world?: unknown; characters?: unknown; events?: unknown }): void {
    if (this.llmBusy) throw new Error("LLM 运行中：请等待当前生成结束后再直接编辑");
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new Error("直接编辑载荷必须是对象");
    }

    // 角色集合一致性预检（直接编辑不增删角色）
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

    // draft 上整体替换（各 store 先校验后落地；任一失败 draft 丢弃，live 零变化）
    const draft = cloneTruth(this.liveTruth());
    if (payload.world !== undefined) draft.world.replaceWorld(payload.world);
    if (payload.characters !== undefined) {
      draft.characters.restoreSnapshot({
        schema_version: SAVE_SCHEMA_VERSION,
        characters: payload.characters as Record<string, CharacterState>,
      });
    }
    if (payload.events !== undefined) draft.events.replaceAll(payload.events);

    // 变量域差异（live vs draft）并入当前步 effects 段（以替换后的落盘状态为 newTree——
    // 被 schema 剥离的键不产生幻觉差异；world.time 锚强制保留由 replaceWorld 校验）
    const editChanges: VarChange[] = [];
    if (payload.world !== undefined) {
      editChanges.push(...diffStateTrees(this.world.world, draft.world.world, "world"));
    }
    if (payload.characters !== undefined) {
      editChanges.push(...diffStateTrees(this.characters.all(), draft.characters.all(), "characters"));
    }
    // 直编只改变量不跑组派生：提交前对 draft 重派生编组（与 GM 步/开局/召回同一通道，
    // 保稳幂等——组未变则零变更零补投），直编对齐 timer 后立即并组；派生变更并入同一次 commit
    editChanges.push(...rederiveGroups(draft, this.rollDice));
    this.mergeDirectEditChanges(draft, editChanges);
    this.commitTruth(draft, "admin_edit", editChanges);

    // commit 成功后才推进水位（cast 现建、activation 无状态，无其他重建动作）
    this.eventSeq = scanEventWatermark(this.events.readAll());
    // 邀请投影全量重建（直编可改 isPlayer/group 等投影过滤输入；成本低，统一重建）
    this.invitations = this.rebuildInvitationProjection();
    // commit 后立即经统一入口刷新派生态（直编改 initiative/timer 后旧 await_player 不得放行）
    this.prepareNextCommand();
  }

  /**
   * 直编差异净额并入 pipeline.current.changes.effects 段：
   * - 同路径已有记录 → 改写**最后一条**的 after（及 after_exists），不新增条目——
   *   链条净效果 = first.before → 新值（如 0→100 被直编改写为 0→50），
   *   倒序反转后回到 first.before，语义正确；
   * - 无记录 → 末尾追加；
   * - current === null（首步之前）→ 不并入：编辑即初始基线（回溯本来就越不过 seq 1）。
   * 分段安全：只做末条 after 改写与尾部追加，绝不删除/重排已有条目——setup 段不受影响；
   * 追加项落在 effects 尾部，后续 editResult 反转该步 effects 段会连带反掉这些追加项，可接受。
   */
  private mergeDirectEditChanges(truth: TruthStores, changes: VarChange[]): void {
    if (changes.length === 0) return;
    const current = truth.world.pipeline.current;
    if (current === null) return;
    const merged = [...(current.changes?.effects ?? [])];
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
    truth.world.setPipeline({
      current: { ...current, changes: { setup: [...(current.changes?.setup ?? [])], effects: merged } },
    });
  }
}
