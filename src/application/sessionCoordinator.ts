/**
 * 单一命令协调器（C4，docs/optimization-review.md §5「单一命令协调器」「会话切换与强制结束」）：
 * 取代 server/sessionManager.ts——所有会话 mutation（含 new/load）经 execute 进入唯一串行队列；
 * rollback_and_continue 复合命令在同一队列任务内顺序 rollback→continue（两步间不接受其他命令）。
 *
 * 阶段 D2「消息身份 + Snapshot/Transition + 一致 query + 会话切换隔离」（本片落地）：
 * - GameSession.onCommit → buildTransition → onTransition 广播（替代已删除的 onStateRefresh
 *   与散装 state/events/pipeline 广播）：每次提交一条 Transition；
 * - rollback_and_continue 只发一条合并 Transition（suppressTransitions 抑制中间 rollback
 *   提交，fromRevision = 命令开始前 revision → 终 revision）；
 * - query 重构为 snapshot/stats：snapshot 在同步函数内一次取 revision + 全部视图，
 *   末尾断言 revision 未变（防御性）——单 revision 一致快照；
 * - 会话切换隔离：new/load 入队前若旧会话在途 → 立即 dispose（abort 在途 LLM，
 *   commit 闸拒绝晚到提交）+ epoch 递增 + onCommit 钩子身份核对（旧会话晚到回调不广播）；
 * - stop 定向中止：runId 不符 → SessionSwitchedError；activationId 不符 → 幂等空成功。
 *
 * 资源修改生效规则（缓存铁律精神）：world/character 经 API 修改后只打"需重建"标记，
 * 运行中的会话前缀不被抽换；下次 new_session 生效。config 域例外：保存后立即热重载
 * 到运行中会话（reloadConfig，不入队），不打 stale 标记。
 */
import type { Display } from "../display.js";
import { systemIds, type IdPorts } from "../ports.js";
import { RevisionConflictError, SessionSwitchedError } from "../truth/validation/errors.js";
import type { CacheStat } from "../types.js";
import type { GameSession, PauseOptions } from "./gameSession.js";
import { buildHistory, type HistoryPayload } from "./historyProjection.js";
import { productionSessionFactory, type SessionFactory } from "./sessionFactory.js";
import {
  buildTransition,
  type CommitNotice,
  type SessionSnapshotData,
  type SessionTransition,
} from "./transitionProjection.js";

/** 状态栏直接编辑载荷（world/characters/events 三域整体替换）。 */
export interface DirectEditPayload {
  world?: unknown;
  characters?: unknown;
  events?: unknown;
}

/**
 * 会话命令（execute 的唯一入参）。baseRevision = 乐观并发闸：携带时与当前
 * session.revision 比对，不符抛 RevisionConflictError；缺省跳过校验。
 * runId 身份核对在 server 入站收敛处（controller）完成（pause_options/stop/query 等
 * 免 baseRevision 命令的口径见 contracts/protocol.ts）。
 */
export type SessionCommand =
  | { type: "player_input"; text: string; baseRevision?: number }
  | { type: "continue"; baseRevision?: number }
  | { type: "rollback"; targetSeq: number; baseRevision?: number }
  | { type: "rollback_and_continue"; targetSeq: number; baseRevision?: number }
  | { type: "edit_result"; text: string; baseRevision?: number }
  | { type: "direct_edit"; payload: DirectEditPayload; baseRevision?: number }
  | { type: "new_session"; worldSetId?: string | undefined }
  | { type: "load_session"; runId: string }
  | { type: "pause_options"; options: PauseOptions };

/** 命令 → 返回类型映射（execute 按命令类型给出类型化结果）。 */
export type SessionCommandResult<C extends SessionCommand> =
  C extends { type: "player_input" } ? string
    : C extends { type: "new_session" } ? string
      : C extends { type: "load_session" } ? { runId: string; history: HistoryPayload }
        : void;

/** 一致 query 返回映射（D2：旧 state/events 零散查询已删除，snapshot = 单 revision 一致快照）。 */
export interface QueryResultMap {
  snapshot: SessionSnapshotData;
  stats: CacheStat[];
}

/** 自动继续（缺省）：不停任何步。 */
const AUTO_CONTINUE: PauseOptions = { everyStep: false, beforeGm: false, afterGm: false, afterProse: false };

export class SessionCoordinator {
  private session: GameSession | null = null;
  private stale = true;
  private queue: Promise<unknown> = Promise.resolve();
  /** 暂停选项（内存态）：记住以便新会话/读档自动套用；自动继续 = 全 false。 */
  private pauseOptions: PauseOptions = AUTO_CONTINUE;
  /** 会话代际（D2 消息身份）：每次原子替换 active session 递增（晚到结果丢弃的判据之一）。 */
  private epoch = 0;
  /** rollback_and_continue 抑制窗口：中间提交只记账不广播，任务结束发一条合并 Transition。 */
  private suppressTransitions = false;
  private mergedFrom: CommitNotice | null = null;
  private mergedTo: CommitNotice | null = null;
  /** edit_result 命令上下文：onCommit 钩子据此给 Transition 附 editedResult。 */
  private editingResult = false;

  /** Transition 广播回调（server 挂接；每次提交一条，替代已删除的 onStateRefresh）。 */
  onTransition: ((transition: SessionTransition) => void) | null = null;

  constructor(
    /** Display 装配（绑定 runId：WebDisplay 的流式消息身份；CLI 实现忽略该参数）。 */
    public displayFactory: (runId: string) => Display,
    private ids: IdPorts = systemIds,
    private factory: SessionFactory = productionSessionFactory,
  ) {}

  /** 当前 runId（无会话为 null）。 */
  get currentRunId(): string | null {
    return this.session?.runId ?? null;
  }

  /** 当前 revision（无会话为 null）。 */
  get currentRevision(): number | null {
    return this.session?.revision ?? null;
  }

  /** 当前会话代际（消息身份用；每次会话切换递增）。 */
  get currentEpoch(): number {
    return this.epoch;
  }

  /** 是否有待生效的资源修改（前端提示用）。 */
  get needsReset(): boolean {
    return this.stale && this.session !== null;
  }

  /** 当前流水线状态（无会话为 null）。 */
  get pipelineInfo(): GameSession["pipelineInfo"] | null {
    return this.session?.pipelineInfo ?? null;
  }

  /** 当前真实轮次（无会话为 0）。 */
  get currentTurn(): number {
    return this.session?.turnCount ?? 0;
  }

  /** 当前会话的历史回显数据（快照组装/合并 Transition 用）。 */
  currentHistory(): HistoryPayload {
    const session = this.ensure();
    return buildHistory(session.getEvents(), session.getArchive(), session.getPipelineCurrent());
  }

  /** 取当前会话（无则创建；资源修改不触发自动重建，须显式 new_session）。 */
  ensure(): GameSession {
    if (!this.session) {
      this.reset(undefined);
    }
    if (!this.session) throw new Error("会话不可用");
    return this.session;
  }

  /** 资源被修改：标记需重建（不立即动运行中的会话，下次 new_session 生效）。 */
  markStale(): void {
    this.stale = true;
  }

  /** config 域专属：保存后立即热重载到运行中会话（不入队；无会话则 no-op，下次 new_session 自然读新配置）。 */
  reloadConfig(): void {
    this.session?.reloadConfig();
  }

  /**
   * 停止（队列外定向中止，D2 消息身份）：runId 携带且 ≠ 当前 → SessionSwitchedError；
   * activationId 携带且 ≠ 当前在途 → 幂等空成功（旧 activation 的迟到 stop 不动当前 activation）。
   */
  stop(identity?: { runId?: string; activationId?: string }): void {
    const session = this.session;
    if (session === null) {
      if (identity?.runId !== undefined) throw new SessionSwitchedError(identity.runId, null);
      return;
    }
    if (identity?.runId !== undefined && identity.runId !== session.runId) {
      throw new SessionSwitchedError(identity.runId, session.runId);
    }
    if (identity?.activationId !== undefined && identity.activationId !== session.currentActivationId) {
      return; // 幂等成功：目标 activation 已不在途
    }
    session.abortCurrent();
  }

  /**
   * 状态栏直接编辑（PUT /api/session/state）：走统一命令入口（direct_edit 入队，不置 busy——
   * 串行队列本身即空闲闸），api 层 await 同步等结果；校验失败由 GameSession 抛错
   * （HTTP 层映射 400 VALIDATION_ERROR；「LLM 运行中」409 仅剩 GameSession 直调防御路径）。
   * 广播 = commit 的 onCommit → Transition（onStateRefresh 已删除）。
   * baseRevision（D5 状态编辑器乐观并发闸）：携带时与当前 revision 比对，不符抛
   * RevisionConflictError（HTTP 层映射 409 REVISION_CONFLICT）；缺省跳过校验。
   */
  async applyDirectEdit(payload: DirectEditPayload, baseRevision?: number): Promise<void> {
    // exactOptionalPropertyTypes：undefined 不显式落字段（缺省 = 跳过校验）
    await this.execute({
      type: "direct_edit",
      payload,
      ...(baseRevision !== undefined ? { baseRevision } : {}),
    });
  }

  /** 暂停选项下发（WS pause_options 消息，camelCase 直收，协议权威 = contracts/protocol.ts）：立即应用到当前会话并记住。 */
  setPauseOptions(options: PauseOptions): void {
    this.applyPauseOptions(options);
  }

  /**
   * 一致快照 query（D2「一致快照 query」）：不产生 Generation、不入 mutation 队列，
   * 但在同一个同步函数内一次取 revision + state/events/history/pipeline，末尾断言
   * revision 未变（防御性——同步代码内不可触发，触发即 bug）。
   */
  query<K extends keyof QueryResultMap>(kind: K, expectedRunId?: string): QueryResultMap[K] {
    const session = this.ensure();
    if (expectedRunId !== undefined && expectedRunId !== session.runId) {
      throw new SessionSwitchedError(expectedRunId, session.runId);
    }
    if (kind === "stats") return session.getStats() as QueryResultMap[K];
    const revision = session.revision;
    const snapshot: SessionSnapshotData = {
      runId: session.runId,
      revision,
      state: session.getState(),
      events: session.getEvents(),
      history: this.currentHistory(),
      pipeline: session.pipelineInfo,
    };
    if (session.revision !== revision) {
      throw new Error(`一致性断言失败：快照组装期间 revision 变化（${revision} → ${session.revision}）`);
    }
    return snapshot as QueryResultMap[K];
  }

  /**
   * 唯一串行 mutation 入口（含 new/load）：命令入队依次执行；abort/错误经 catch 自愈，
   * 错误只传给本命令的调用方。pause_options 是内存态标志，即时生效不入队。
   * new/load 入队前：旧会话在途 → 立即 dispose（强制切换——串行队列下等任务开头
   * 再 dispose 必然太晚：旧任务已随队列排空完成，在途 LLM 永远不会被中止）。
   */
  execute<C extends SessionCommand>(cmd: C): Promise<SessionCommandResult<C>> {
    type R = SessionCommandResult<C>;
    switch (cmd.type) {
      case "pause_options":
        this.applyPauseOptions(cmd.options);
        return Promise.resolve(undefined as R);
      case "new_session":
        this.disposeCurrentIfBusy();
        return this.enqueue(() => {
          const runId = this.reset(cmd.worldSetId);
          return runId as R;
        });
      case "load_session":
        this.disposeCurrentIfBusy();
        return this.enqueue(() => this.load(cmd.runId) as R);
      case "player_input":
        return this.runOnSession(cmd, (s) => s.handlePlayerInput(cmd.text)) as Promise<R>;
      case "continue":
        return this.runOnSession(cmd, async (s) => {
          await s.continuePipeline();
        }) as Promise<R>;
      case "rollback":
        return this.runOnSession(cmd, (s) => {
          s.rollbackTo(cmd.targetSeq);
        }) as Promise<R>;
      case "rollback_and_continue":
        // 原子重 roll：回滚与续跑同处一个队列任务，两步间不接受其他命令（取代已删除的 GameSession.reroll）；
        // 中间 rollback 提交不广播——任务结束只发一条合并 Transition（fromRevision→终 revision）
        return this.runOnSession(cmd, async (s) => {
          if (!Number.isInteger(cmd.targetSeq) || cmd.targetSeq <= 1) {
            throw new Error(`无效的重 roll 轮次: ${cmd.targetSeq}`);
          }
          this.suppressTransitions = true;
          this.mergedFrom = null;
          this.mergedTo = null;
          try {
            s.rollbackTo(cmd.targetSeq - 1);
            await s.continuePipeline();
          } finally {
            this.suppressTransitions = false;
            this.flushMergedTransition(s);
          }
        }) as Promise<R>;
      case "edit_result":
        return this.runOnSession(cmd, (s) => {
          this.editingResult = true;
          try {
            s.editResult(cmd.text);
          } finally {
            this.editingResult = false;
          }
        }) as Promise<R>;
      case "direct_edit":
        // 直编不调 LLM：串行队列本身即是空闲闸（轮到本任务时前序任务已排空，必无 LLM 在途），
        // 不得走 runOnSession 的 setBusy 包装——GameSession.applyDirectEdit 见 llmBusy 即拒，
        // 包上 busy 会自锁（修复前 PUT /api/session/state 经协调器必然报「LLM 运行中」）。
        return this.enqueue(() => {
          const session = this.ensure();
          this.checkRevision(session, cmd.baseRevision);
          session.applyDirectEdit(cmd.payload);
        }) as Promise<R>;
    }
  }

  /** 显式重建会话（new_session 命令；worldSetId 省略 = 缺省设定集）。返回新 runId。 */
  private reset(worldSetId: string | undefined): string {
    const runId = this.ids.newRunId();
    const session = this.factory.create(runId, worldSetId, this.displayFactory(runId));
    this.session = session;
    this.wireSession(session);
    this.epoch += 1; // 原子替换 active session 后递增代际
    session.setPauseOptions(this.pauseOptions);
    this.stale = false;
    return session.runId;
  }

  /** 读取历史存档继续游玩（load_session 命令）。返回 runId 与历史回显数据。 */
  private load(runId: string): { runId: string; history: HistoryPayload } {
    const session = this.factory.resume(runId, this.displayFactory(runId));
    this.session = session;
    this.wireSession(session);
    this.epoch += 1;
    session.setPauseOptions(this.pauseOptions);
    this.stale = false;
    return { runId: session.runId, history: this.currentHistory() };
  }

  /** 旧会话在途 → 强制结束（D2 会话切换）：dispose 置旗标 + abort 在途 LLM；commit 闸拒绝晚到提交。 */
  private disposeCurrentIfBusy(): void {
    if (this.session !== null && this.session.isBusy) {
      this.session.dispose();
    }
  }

  /** 挂接会话的提交通知（每次会话建立/读档一次）。 */
  private wireSession(session: GameSession): void {
    session.onCommit = (notice) => {
      // 代际防御：旧会话（已切换走）的晚到提交不广播（dispose commit 闸之外的第二道）
      if (this.session !== session || session.disposed) return;
      this.handleCommitNotice(session, notice);
    };
  }

  /** 提交通知分发：抑制窗口内记账（合并 Transition），否则立即投影广播。 */
  private handleCommitNotice(session: GameSession, notice: CommitNotice): void {
    if (this.suppressTransitions) {
      if (this.mergedFrom === null) this.mergedFrom = notice;
      this.mergedTo = notice;
      return;
    }
    this.emitTransition(session, notice);
  }

  /** 抑制窗口关闭：发出 rollback_and_continue 的合并 Transition（无提交则不发）。 */
  private flushMergedTransition(session: GameSession): void {
    const from = this.mergedFrom;
    const to = this.mergedTo;
    this.mergedFrom = null;
    this.mergedTo = null;
    if (from === null || to === null) return;
    this.emitTransition(session, {
      reason: "rollback",
      fromRevision: from.fromRevision,
      revision: to.revision,
      prev: from.prev,
      next: to.next,
    });
  }

  /** 提交 → Transition 投影 + 广播（history/pipeline 在提交点现算，与 notice 同一真相根）。 */
  private emitTransition(session: GameSession, notice: CommitNotice): void {
    if (this.onTransition === null) return;
    const editedResult = this.editingResult ? this.currentEditedResult(session) : undefined;
    this.onTransition(
      buildTransition(notice, session.runId, {
        history: this.currentHistory(),
        pipeline: session.pipelineInfo,
        ...(editedResult !== undefined ? { editedResult } : {}),
      }),
    );
  }

  /** edit_result 的被编辑步视图（seq+kind+解析后结果；前端按 data 属性寻址原地重渲该卡）。 */
  private currentEditedResult(session: GameSession): { seq: number; kind: string; result: unknown } | undefined {
    const current = session.getPipelineCurrent();
    if (current === null) return undefined;
    return { seq: current.seq, kind: current.kind, result: current.result };
  }

  private applyPauseOptions(options: PauseOptions): void {
    this.pauseOptions = { ...options };
    this.session?.setPauseOptions(this.pauseOptions);
  }

  /** baseRevision 乐观并发闸：携带时与当前 revision 比对；缺省跳过。 */
  private checkRevision(session: GameSession, baseRevision: number | undefined): void {
    if (baseRevision !== undefined && baseRevision !== session.revision) {
      throw new RevisionConflictError(baseRevision, session.revision);
    }
  }

  /**
   * 会话绑定命令的串行执行：baseRevision 校验 → busy 位（任务全程含 LLM 在途与步间循环，
   * 直接编辑的空闲闸）→ 派发到 GameSession。
   */
  private runOnSession<T>(cmd: SessionCommand, fn: (session: GameSession) => Promise<T> | T): Promise<T> {
    return this.enqueue(async () => {
      const session = this.ensure(); // 提前 ensure：自动建会话也落在 busy 窗口内
      this.checkRevision(session, "baseRevision" in cmd ? cmd.baseRevision : undefined);
      session.setBusy(true);
      try {
        return await fn(session);
      } finally {
        session.setBusy(false);
      }
    });
  }

  /** 通用串行队列：abort/错误经 catch 自愈，错误只传给本任务的调用方。 */
  private enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(() => task());
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
