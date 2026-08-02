import fs from "node:fs";
import path from "node:path";
import { loadAgentConfigs, RUNS_DIR } from "../config.js";
import type { Display } from "../display.js";
import { buildHistory, GameSession, type HistoryPayload, type PauseOptions } from "../loop.js";
import { safeSegment } from "./api.js";

function newRunId(): string {
  return `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * 会话管理器：持有当前活跃 GameSession。
 * 资源修改生效规则（缓存铁律精神）：world/character 经 API 修改后
 * 只打"需重建"标记，运行中的会话前缀不被抽换；下次 new_session 生效。
 * config 域例外：保存后立即热重载到运行中会话（reloadConfig），不打 stale 标记。
 * 玩家输入经 enqueue 串行化，避免并发轮次。
 */
export class SessionManager {
  private session: GameSession | null = null;
  private stale = true;
  private queue: Promise<unknown> = Promise.resolve();
  /** 暂停选项（内存即可）：记住以便新会话/读档自动套用；自动继续 = 全 false。 */
  private pauseOptions: PauseOptions = { everyStep: false, beforeGm: false, afterGm: false, afterProse: false };

  constructor(private displayFactory: () => Display) {}

  /** 暂停选项下发（pause_options 消息）：立即应用到当前会话并记住。 */
  setPauseOptions(msg: { every_step: boolean; before_gm: boolean; after_gm: boolean; after_prose: boolean }): void {
    this.pauseOptions = {
      everyStep: msg.every_step,
      beforeGm: msg.before_gm,
      afterGm: msg.after_gm,
      afterProse: msg.after_prose,
    };
    this.session?.setPauseOptions(this.pauseOptions);
  }

  /** 资源被修改：标记需重建（不立即动运行中的会话，下次 new_session 生效）。 */
  markStale(): void {
    this.stale = true;
  }

  /** config 域专属：保存后立即热重载到运行中会话（无会话则 no-op，下次 new_session 自然读新配置）。 */
  reloadConfig(): void {
    this.session?.reloadConfig();
  }

  /** 是否有待生效的资源修改（前端提示用）。 */
  get needsReset(): boolean {
    return this.stale && this.session !== null;
  }

  /** 当前 runId（无会话为 null）。 */
  get currentRunId(): string | null {
    return this.session?.runId ?? null;
  }

  /** 当前流水线状态（无会话为 null）。 */
  get pipelineInfo(): { seq: number; phase: string; interrupted: boolean; kind: string | null } | null {
    return this.session?.pipelineInfo ?? null;
  }

  /** 当前会话的历史回显数据（回溯后重新广播用）。 */
  currentHistory(): HistoryPayload {
    const session = this.ensure();
    return buildHistory(session.getEvents(), session.getArchive(), session.getPipelineCurrent());
  }

  /** 当前真实轮次（无会话为 0）。 */
  get currentTurn(): number {
    return this.session?.turnCount ?? 0;
  }

  /** 显式重建会话（new_session 消息；worldSetId 省略 = 缺省设定集）。返回新 runId。 */
  reset(worldSetId?: string): string {
    this.session = this.create(worldSetId);
    this.session.setPauseOptions(this.pauseOptions);
    this.stale = false;
    return this.session.runId;
  }

  /** 读取历史存档继续游玩（load_session 消息）。返回 runId 与历史回显数据。 */
  load(runId: string): { runId: string; history: HistoryPayload } {
    const id = safeSegment(runId); // 路径安全：防目录穿越
    if (!fs.existsSync(path.join(RUNS_DIR, id))) {
      throw new Error(`存档不存在: ${id}`);
    }
    const configs = loadAgentConfigs();
    if (!configs) {
      throw new Error("未找到 LLM API Key：请在「配置」页填入 api_key，或设置 DEEPSEEK_API_KEY 环境变量。");
    }
    this.session = GameSession.resume(configs, id, this.displayFactory());
    this.session.setPauseOptions(this.pauseOptions);
    this.stale = false;
    return { runId: id, history: this.currentHistory() };
  }

  private create(worldSetId?: string): GameSession {
    const configs = loadAgentConfigs();
    if (!configs) {
      throw new Error("未找到 LLM API Key：请在「配置」页填入 api_key，或设置 DEEPSEEK_API_KEY 环境变量。");
    }
    return GameSession.create(configs, newRunId(), this.displayFactory(), worldSetId);
  }

  /** 取当前会话（无则创建；资源修改不触发自动重建，须显式 new_session）。 */
  ensure(): GameSession {
    if (!this.session) {
      this.reset();
    }
    if (!this.session) throw new Error("会话不可用");
    return this.session;
  }

  /** 串行执行一轮玩家输入。 */
  enqueueInput(text: string): Promise<void> {
    return this.enqueue(async () => {
      await this.ensure().handlePlayerInput(text);
    });
  }

  /** 串行执行继续（按 phase 续跑）。 */
  enqueueContinue(): Promise<void> {
    return this.enqueue(async () => {
      await this.ensure().continuePipeline();
    });
  }

  /** 回溯（纯数据操作；经队列与在途任务串行，防止与流式轮次竞争）。 */
  enqueueRollback(seq: number): Promise<void> {
    return this.enqueue(() => {
      this.ensure().rollbackTo(seq);
      return Promise.resolve();
    });
  }

  /** 原子重 roll（回滚与续跑同处一个队列任务，禁止其他消息插队）。 */
  enqueueReroll(seq: number): Promise<void> {
    return this.enqueue(async () => {
      await this.ensure().reroll(seq);
    });
  }

  /** 编辑当前步原始返回（纯数据操作；经队列串行）。 */
  enqueueEditResult(text: string): Promise<void> {
    return this.enqueue(() => {
      this.ensure().editResult(text);
      return Promise.resolve();
    });
  }

  /** 停止：中止在途 LLM 调用（步内捕获后冻结为 interrupted；队列自愈）。 */
  stop(): void {
    this.session?.abortCurrent();
  }

  /** 通用串行队列：abort/错误经 catch 自愈，错误只传给本任务的调用方。
   *  任务全程（含 LLM 在途与步间循环）置会话 busy 位——直接编辑的空闲闸。 */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(async () => {
      const session = this.ensure(); // 提前 ensure：自动建会话也落在 busy 窗口内
      session.setBusy(true);
      try {
        await task();
      } finally {
        session.setBusy(false);
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  /** 直接编辑后的刷新广播（server/index 挂接广播 state/events；无广播环境为 no-op）。 */
  onStateRefresh: ((state: unknown, events: unknown) => void) | null = null;

  /**
   * 状态栏直接编辑（PUT /api/session/state）：转发 GameSession.applyDirectEdit。
   * 同步纯数据操作；LLM 在途/校验失败由 GameSession 抛错（api 层转 400）。
   */
  applyDirectEdit(payload: { world?: unknown; characters?: unknown; events?: unknown }): void {
    const session = this.ensure();
    session.applyDirectEdit(payload);
    this.onStateRefresh?.(session.getState(), session.getEvents());
  }

  /** 查询当前会话数据（state/events/stats）。 */
  query(kind: "state" | "events" | "stats"): unknown {
    const session = this.ensure();
    if (kind === "state") return session.getState();
    if (kind === "events") return session.getEvents();
    return session.getStats();
  }
}
