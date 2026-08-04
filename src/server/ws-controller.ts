/**
 * WS controller（优化阶段 D3 从 index.ts 搬出，docs/optimization-review.md §9
 * 「服务端职责边界」迁移顺序步 4）：parseClientCommand → Coordinator → 回复成形。
 *
 * 每命令 handle(cmd, socket) 统一形状（D2 定稿，本片不改线协议）：
 * 定向 command_result/command_error（requestId 关联）+ transition 广播（Coordinator
 * onTransition 钩子由组成根挂到 transport.broadcast）+ 会话切换/重连的 snapshot。
 */
import type { WebSocket } from "ws";
import type { SessionCoordinator } from "../application/sessionCoordinator.js";
import {
  parseClientCommand,
  ProtocolError,
  type ClientCommand,
} from "../contracts/protocol.js";
import {
  DisposedSessionError,
  RevisionConflictError,
  SessionSwitchedError,
} from "../truth/validation/errors.js";
import type {
  CommandErrorMessage,
  CommandResultMessage,
  ProtocolErrorCode,
  SnapshotMessage,
} from "./ws-protocol.js";
import type { WsTransport } from "./ws-transport.js";

export class WsController {
  constructor(
    private readonly coordinator: SessionCoordinator,
    private readonly transport: WsTransport,
  ) {}

  /** 新连接：有活跃会话则单播一条一致 snapshot（UI 从同一 revision 根整体恢复）。 */
  onConnect(ws: WebSocket): void {
    if (this.coordinator.currentRunId !== null) {
      this.transport.send(ws, this.snapshotMessage());
    }
  }

  /** 入站文本帧：协议解析 → 命令分发；两层错误都回 command_error。 */
  async onMessage(raw: string, ws: WebSocket): Promise<void> {
    let cmd: ClientCommand;
    try {
      cmd = parseClientCommand(raw);
    } catch (err) {
      this.sendError(ws, undefined, "?", err);
      return;
    }
    try {
      await this.handleCommand(cmd, ws);
    } catch (err) {
      this.sendError(ws, cmd.requestId, cmd.type, err);
    }
  }

  /** 一致快照消息（重连单播/会话切换广播/跳号恢复应答共用）。 */
  private snapshotMessage(requestId?: string): SnapshotMessage {
    return {
      ...this.coordinator.query("snapshot"),
      type: "snapshot",
      ...(requestId !== undefined ? { requestId } : {}),
    };
  }

  /** 新会话建成：向所有客户端广播 snapshot（会话切换隔离的同步起点）。 */
  private broadcastSnapshot(): void {
    this.transport.broadcast(this.snapshotMessage());
  }

  /** 定向成功应答（仅在命令携带 requestId 时发送）。 */
  private sendResult(ws: WebSocket, cmd: ClientCommand, data?: unknown): void {
    if (cmd.requestId === undefined) return;
    const msg: CommandResultMessage = {
      type: "command_result",
      requestId: cmd.requestId,
      command: cmd.type,
      runId: this.coordinator.currentRunId,
      revision: this.coordinator.currentRevision,
      ...(data !== undefined ? { data } : {}),
    };
    this.transport.send(ws, msg);
  }

  /** 定向失败应答（异常 → 稳定 code；REVISION_CONFLICT 附 details 双值）。 */
  private sendError(ws: WebSocket, requestId: string | undefined, command: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    let code: ProtocolErrorCode = "INTERNAL_ERROR";
    if (err instanceof ProtocolError) code = "PROTOCOL_ERROR";
    else if (err instanceof RevisionConflictError) code = "REVISION_CONFLICT";
    else if (err instanceof SessionSwitchedError || err instanceof DisposedSessionError) code = "SESSION_SWITCHED";
    else if (message.includes("LLM 运行中")) code = "SESSION_BUSY";
    else if (message.includes("不存在")) code = "NOT_FOUND";
    else if (/解析失败|校验|不合法|无效/.test(message)) code = "VALIDATION_ERROR";
    const msg: CommandErrorMessage = {
      type: "command_error",
      requestId: requestId ?? "",
      command,
      code,
      message,
      runId: this.coordinator.currentRunId,
      revision: this.coordinator.currentRevision,
      ...(err instanceof RevisionConflictError
        ? { details: { baseRevision: err.base, currentRevision: err.current } }
        : {}),
    };
    this.transport.send(ws, msg);
  }

  /** runId 身份核对（mutation/stop/query；携带且 ≠ 当前 → SESSION_SWITCHED）。 */
  private checkRunIdentity(runId: string | undefined): void {
    if (runId === undefined) return;
    const current = this.coordinator.currentRunId;
    if (current === null || current !== runId) throw new SessionSwitchedError(runId, current);
  }

  /** 命令统一处理：定向应答 + 广播副作用（transition 由 onCommit 钩子自动发出）。 */
  private async handleCommand(cmd: ClientCommand, ws: WebSocket): Promise<void> {
    const coordinator = this.coordinator;
    const base = "baseRevision" in cmd && cmd.baseRevision !== undefined ? { baseRevision: cmd.baseRevision } : {};
    switch (cmd.type) {
      case "player_input": {
        // runId 可省略（首次输入自动建会话）；携带则核对身份
        if (cmd.runId !== undefined && coordinator.currentRunId !== null) this.checkRunIdentity(cmd.runId);
        const isAutoCreate = coordinator.currentRunId === null;
        if (isAutoCreate) {
          // 先建会话并广播 snapshot：流式消息带 runId，前端须先拿到身份再接收增量
          coordinator.ensure();
          this.broadcastSnapshot();
        }
        await coordinator.execute({ type: "player_input", text: cmd.text, ...base });
        this.sendResult(ws, cmd);
        return;
      }
      case "continue":
        this.checkRunIdentity(cmd.runId);
        await coordinator.execute({ type: "continue", ...base });
        this.sendResult(ws, cmd);
        return;
      case "rollback":
        this.checkRunIdentity(cmd.runId);
        await coordinator.execute({ type: "rollback", targetSeq: cmd.targetSeq, ...base });
        this.sendResult(ws, cmd);
        return;
      case "rollback_and_continue":
        this.checkRunIdentity(cmd.runId);
        await coordinator.execute({ type: "rollback_and_continue", targetSeq: cmd.targetSeq, ...base });
        this.sendResult(ws, cmd);
        return;
      case "edit_result":
        this.checkRunIdentity(cmd.runId);
        await coordinator.execute({ type: "edit_result", text: cmd.text, ...base });
        this.sendResult(ws, cmd);
        return;
      case "new_session":
        await coordinator.execute({ type: "new_session", worldSetId: cmd.worldSetId });
        this.broadcastSnapshot();
        this.sendResult(ws, cmd);
        return;
      case "load_session":
        await coordinator.execute({ type: "load_session", runId: cmd.runId });
        this.broadcastSnapshot();
        this.sendResult(ws, cmd);
        return;
      case "pause_options":
        if (cmd.runId !== undefined && coordinator.currentRunId !== null) this.checkRunIdentity(cmd.runId);
        coordinator.setPauseOptions(cmd.options);
        this.sendResult(ws, cmd);
        return;
      case "stop":
        // 队列外定向中止：runId 不符 → SESSION_SWITCHED；activationId 不符 → 幂等空成功
        coordinator.stop({ ...(cmd.runId !== undefined ? { runId: cmd.runId } : {}), ...(cmd.activationId !== undefined ? { activationId: cmd.activationId } : {}) });
        this.sendResult(ws, cmd);
        return;
      case "query":
        if (cmd.query === "stats") {
          this.sendResult(ws, cmd, coordinator.query("stats", cmd.runId));
        } else {
          // 一致快照：单 revision 根派生；以 snapshot 消息定向回复（跳号恢复同形）
          this.transport.send(ws, this.snapshotMessage(cmd.requestId));
        }
        return;
    }
  }
}
