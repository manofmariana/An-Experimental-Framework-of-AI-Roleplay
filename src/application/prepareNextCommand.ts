/**
 * 执行入口统一收口 + 确定性计算层端口（优化阶段 C3，docs/optimization-review.md §3
 * 「确定性计算层与执行入口」）。
 *
 * 玩家输入权限检查、手动继续、自动继续、编辑/直编/回滚后的派生态刷新共用同一入口
 * prepareNextCommand：先在不可见事务草稿上把固定规则跑到固定点（只累积一份 changes，
 * 不产生中间 Generation），有变化才一次原子提交并重建投影，最后 deriveNext 返回
 * NextCommand——随后才允许玩家输入或执行 NPC/GM/prose。
 *
 * 边界（本阶段固定）：
 * - 本阶段 rules 默认空，不填任何 P2 规则；空 rules 走性能短路（不建 draft），
 *   语义与直接 deriveNext 完全等价。
 * - 投骰不进入本层：先攻补投在效果规划器（actorEffects/gmEffects/scheduleEffects）内，
 *   属该步骤的 effects，随步骤落账可回溯；本层规则必须是确定性的固定点计算。
 * - 收敛保护：每轮记录状态签名（稳定 JSON 序列化的 SHA-256），签名重复或超过
 * 迭代上限即丢弃整个 draft 明确报错，禁止无限循环。
 */
import { createHash } from "node:crypto";
import { deriveNext, type NextCommand, type SchedulerSnapshot } from "../scheduler/derive.js";
import { collectSave, type TruthStores } from "../truth/stores.js";
import type { VarChange } from "../truth/varChanges.js";

/** 固定点最大迭代轮数（一轮 = 全部规则各跑一次 runPass）。 */
export const DEFAULT_MAX_ITERATIONS = 16;

/** 确定性规则端口（P2 固定规则/从动变量规则的接入点；本阶段不实现任何具体规则）。 */
export interface DeterministicRulePort {
  readonly id: string;
  /** 在 draft 上跑一轮固定规则；返回本轮产生的 changes（空 = 该规则已达固定点） */
  runPass(draft: TruthStores): VarChange[];
}

export interface PrepareResult {
  command: NextCommand;
  /** 本次是否产生了真相提交（规则收敛出变化 → 一次 commit） */
  committed: boolean;
}

/** 注入式依赖（不 import loop：会话内核按此形状装配）。 */
export interface PrepareNextCommandDeps {
  /** 当前已提交的 live 真相视图（只读使用；commit 经 adopt 后同实例反映新态） */
  liveTruth: TruthStores;
  /** 建立事务草稿（与 live 完全隔离的工作副本） */
  cloneTruth(live: TruthStores): TruthStores;
  /** 草稿一次原子提交（单 Generation，reason 由注入方固定为 "step"）；失败抛错，draft 由调用方丢弃 */
  commit(draft: TruthStores, changes: VarChange[]): void;
  /** 提交成功后重建受影响派生投影（邀请投影等） */
  rebuildProjections(): void;
  /** 从真相视图构建最小调度快照（deriveNext 的输入面） */
  buildSnapshot(truth: TruthStores): SchedulerSnapshot;
  /** 确定性规则端口集（本阶段默认 []） */
  rules: readonly DeterministicRulePort[];
  /** 固定点最大迭代轮数（默认 16） */
  maxIterations?: number;
}

/** 键序稳定的 JSON 序列化（状态签名底料；对象键排序，数组保序）。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

/** draft 全量状态签名（变化检测与循环检测共用同一口径：整代 SaveSet）。 */
function stateSignature(draft: TruthStores): string {
  return createHash("sha256").update(stableStringify(collectSave(draft))).digest("hex").slice(0, 16);
}

/**
 * 准备下一命令（同步）：规则收敛 → （有变化才）提交 + 重建投影 → 派生。
 * 规则无法达到固定点时丢弃整个 draft、明确报错并停止，live 零变化。
 */
export function prepareNextCommand(deps: PrepareNextCommandDeps): PrepareResult {
  const { liveTruth, rules } = deps;

  // 性能短路（不是语义分支）：无规则时草稿恒等于 live、commit 恒不发生，
  // 直接 deriveNext 与走完全流程的结果逐字节一致。
  if (rules.length === 0) {
    return { command: deriveNext(deps.buildSnapshot(liveTruth)), committed: false };
  }

  const maxIterations = deps.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const draft = deps.cloneTruth(liveTruth);
  const allChanges: VarChange[] = [];
  const signatures = new Set<string>([stateSignature(draft)]);
  let iterations = 0;
  let activeIds = rules.map((r) => r.id);

  for (;;) {
    const passChanges: VarChange[] = [];
    activeIds = [];
    for (const rule of rules) {
      const produced = rule.runPass(draft);
      if (produced.length > 0) {
        activeIds.push(rule.id);
        passChanges.push(...produced);
      }
    }
    if (passChanges.length === 0) break; // 全部规则返回空 = 固定点
    iterations += 1;
    if (iterations > maxIterations) {
      throw new Error(
        `确定性计算层超过最大迭代次数 ${maxIterations} 仍未收敛` +
          `（规则 ${activeIds.join(", ")}，签名 ${stateSignature(draft)}）；草稿已丢弃`,
      );
    }
    allChanges.push(...passChanges);
    const sig = stateSignature(draft);
    if (signatures.has(sig)) {
      throw new Error(
        `确定性计算层未收敛：状态签名重复（规则 ${activeIds.join(", ")}，签名 ${sig}）；草稿已丢弃`,
      );
    }
    signatures.add(sig);
  }

  // 草稿相对当前状态有变化 → 一次原子提交（单 Generation）→ 重建受影响投影
  let committed = false;
  if (allChanges.length > 0) {
    deps.commit(draft, allChanges);
    deps.rebuildProjections();
    committed = true;
  }
  return { command: deriveNext(deps.buildSnapshot(liveTruth)), committed };
}
