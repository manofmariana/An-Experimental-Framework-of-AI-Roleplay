/**
 * 类型化存档加载错误。
 *
 * 调用方按 kind 判别恢复路径——
 * version 提示新建会话；corrupt/incomplete/invariant 可尝试上一 Generation（loadCurrent 灾备回退）；
 * io 展示路径与系统错误，不误导用户放弃存档；invariant 由 validateSaveSet（validation/saveSet.ts）产出。
 *
 * 分类口径：
 * - not_found：runId 或目标 Generation 不存在；
 * - incomplete：文件集合、CURRENT 或 Generation 内容不完整（缺文件/CURRENT 缺失或不可解析）；
 * - version：明确的 schema 版本不受支持（含旧平铺档与版本混合）；
 * - corrupt：JSON 截断或当前版本单文件结构损坏；
 * - invariant：文件各自合法但组合后矛盾（validateSaveSet 跨文件校验产出，见 validation/saveSet.ts）；
 * - io：权限、占用、磁盘等系统错误（EACCES/EPERM/ENOSPC/EBUSY …）。
 */
export type SaveLoadErrorKind = "not_found" | "incomplete" | "version" | "corrupt" | "invariant" | "io";

export class SaveLoadError extends Error {
  constructor(
    readonly kind: SaveLoadErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SaveLoadError";
  }
}

/** 乐观并发闸：commit 的 baseRevision 与当前 revision 不一致（并发写入或过期调用方）。 */
export class RevisionConflictError extends Error {
  constructor(
    readonly base: number,
    readonly current: number,
  ) {
    super(`存档 revision 冲突：提交基于 base=${base}，当前已是 current=${current}（存在并发写入或过期调用方）`);
    this.name = "RevisionConflictError";
  }
}

/**
 * 会话已销毁：new/load 强制切换时 dispose 旧会话，
 * 其后旧任务的任何提交/新步启动一律抛它——旧 run 晚到结果不得提交真相或触发广播。
 */
export class DisposedSessionError extends Error {
  constructor(readonly runId: string) {
    super(`会话已销毁（强制切换）：${runId} 的后续提交被拒绝`);
    this.name = "DisposedSessionError";
  }
}

/** 消息身份不符：命令携带的 runId ≠ 当前活跃会话。 */
export class SessionSwitchedError extends Error {
  constructor(
    readonly expected: string,
    readonly current: string | null,
  ) {
    super(`会话已切换：命令针对 runId=${expected}，当前活跃会话为 ${current ?? "（无）"}`);
    this.name = "SessionSwitchedError";
  }
}
