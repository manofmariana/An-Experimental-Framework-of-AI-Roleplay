/**
 * CommitExecutor（docs/optimization-review.md §1/§12）：**一次命令一个提交**的唯一落地入口。
 *
 * GameSession 全部写盘路径（init/step/gm/rollback/admin_edit）收敛为
 * 「构造 CommitPlan → executor.commit」一种形态；executor 职责刻意保持薄：
 *   baseRevision 乐观并发校验（经 repo 闸）→ validateSaveSet（repo 提交内钩子）
 *   → repo.commit（原子 Generation 切换）。
 * plan 本身不落盘——archive 的 StepChanges 已是回滚依据，plan 只给本次提交一个
 * 类型化边界（事务 id / 基线 revision / 原因 / 与该步归档同一份的变更记录）。
 */
import type { GenerationRepository, SaveSet } from "./generationRepository.js";
import type { VarChange } from "./varChanges.js";

/** 提交原因：init=建档首提交 / step=常规步 / gm=GM 裁决步 / rollback=回溯 / admin_edit=编辑与状态直编。 */
export type CommitReason = "init" | "step" | "gm" | "rollback" | "admin_edit";

export interface CommitPlan {
  /** `tx-{nextRevision}`：确定性派生，不引墙钟。 */
  transactionId: string;
  /** 乐观并发基线：必须等于当前 revision（repo 闸复核）。 */
  baseRevision: number;
  reason: CommitReason;
  /** 与该步归档 StepChanges（扁平 = 先 setup 后 effects）同一份记录（rollback/init 为空）。 */
  changes: VarChange[];
}

export class CommitExecutor {
  constructor(private repo: GenerationRepository) {}

  /** 执行一次提交：plan 一致性复核 → repo 原子提交。返回新 revision。 */
  commit(plan: CommitPlan, next: SaveSet): number {
    const expectedTx = `tx-${plan.baseRevision + 1}`;
    if (plan.transactionId !== expectedTx) {
      throw new Error(`CommitPlan transactionId 不符确定性约定：期望 ${expectedTx}，实得 ${plan.transactionId}`);
    }
    return this.repo.commit(plan.baseRevision, next);
  }
}
