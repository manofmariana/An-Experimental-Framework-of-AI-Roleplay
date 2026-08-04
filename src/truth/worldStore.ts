import { z } from "zod";
import type { StateDelta } from "../types.js";
import { WorkingSetEntrySchema, type WorkingSetEntry } from "./workingSet.js";
import { SAVE_SCHEMA_VERSION } from "./saveSchema.js";
import { TimeAnchorSchema, minutesToWorldTime, worldTimeToMinutes, type TimeAnchor } from "./timeStore.js";
import { VarChangeSchema, deleteByPath, getByPath, makeVarChange, setByPath, type VarChange } from "./varChanges.js";

export type StateTree = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function applyDeltas(state: StateTree, deltas: StateDelta[]): StateTree {
  const next = JSON.parse(JSON.stringify(state)) as StateTree;
  for (const delta of deltas) {
    const segments = delta.path.split(".");
    if (segments.length === 0 || segments.some((s) => s === "")) throw new Error(`invalid delta path: ${delta.path}`);
    const key = segments[segments.length - 1]!;
    let node: Record<string, unknown> = next;
    for (const segment of segments.slice(0, -1)) {
      const child = node[segment];
      if (child === undefined) {
        const fresh: Record<string, unknown> = {};
        node[segment] = fresh;
        node = fresh;
      } else if (isRecord(child)) node = child;
      else throw new Error(`delta path ${delta.path} 穿过非对象节点: ${segment}`);
    }
    const current = node[key];
    if (delta.op === "=") node[key] = delta.value;
    else if (typeof current === "number" && typeof delta.value === "number") {
      node[key] = delta.op === "+=" ? current + delta.value : current - delta.value;
    } else if (current === undefined && typeof delta.value === "number") {
      node[key] = delta.op === "+=" ? delta.value : -delta.value;
    } else throw new Error(`${delta.op} 需要数值: ${delta.path} (当前 ${JSON.stringify(current)})`);
  }
  return next;
}

/**
 * 步骤变化分段（存档 v7，docs/optimization-review.md §3「步骤变化分段」）：
 * setup = 调度在该步执行前产生的变化（时钟跳转/周期计数/维护性 acted 清零/邀请激活 timer 弹出）；
 * effects = 本步 DecisionPackage/AdjudicationPackage 经效果规划器产生的变化。
 * 取代数组下标定位（effects_from/markers_from）；回滚倒序反转 effects 再倒序反转 setup。
 */
export const StepChangesSchema = z.object({
  setup: z.array(VarChangeSchema),
  effects: z.array(VarChangeSchema),
});
export type StepChanges = z.infer<typeof StepChangesSchema>;

/** 空分段（每次调用新建，防共享数组被改写）。 */
export function emptyStepChanges(): StepChanges {
  return { setup: [], effects: [] };
}

/**
 * 扁平化（先 setup 后 effects，与旧扁平 var_changes 同序）：
 * 倒序反转该序列 ≡ 先倒序 effects 再倒序 setup——回滚/CommitPlan/测试断言共用一个出口。
 */
export function flatChanges(changes: StepChanges | undefined): VarChange[] {
  return [...(changes?.setup ?? []), ...(changes?.effects ?? [])];
}

export const PipelineCurrentSchema = z.object({
  seq: z.number(), kind: z.string(), result: z.unknown(),
  changes: StepChangesSchema.optional(), interrupted: z.boolean().optional(), edited: z.boolean().optional(),
});
export type PipelineCurrent = z.infer<typeof PipelineCurrentSchema>;
export const PipelineSchema = z.object({
  // phase 已删除（v7）：派生量不落盘，消费方一律 phaseOf(deriveNext(...)) 现算
  seq: z.number(), working_set: z.array(WorkingSetEntrySchema), current: PipelineCurrentSchema.nullable(),
});
export type Pipeline = z.infer<typeof PipelineSchema>;

export const WorldStateSchema = z.object({ time: TimeAnchorSchema }).catchall(z.unknown());
export const WorldFileSchema = z.object({
  schema_version: z.literal(SAVE_SCHEMA_VERSION),
  world: WorldStateSchema,
  pipeline: PipelineSchema,
});
export type WorldFile = z.infer<typeof WorldFileSchema>;

const INITIAL_PIPELINE: Pipeline = { seq: 0, working_set: [], current: null };

/**
 * world/pipeline 状态容器（纯内存，无 IO）：每次变异只改内存；
 * 落盘由 GenerationRepository 在步边界整代提交（存档 v7，唯一写盘出口）。
 */
export class WorldStore {
  private data: WorldFile;

  constructor(data: WorldFile) {
    this.data = JSON.parse(JSON.stringify(data)) as WorldFile;
  }

  /** 新档初始容器：world 变量树 + 空流水线。 */
  static initial(world: StateTree & { time: TimeAnchor }): WorldStore {
    return new WorldStore({
      schema_version: SAVE_SCHEMA_VERSION,
      world,
      pipeline: { ...INITIAL_PIPELINE, working_set: [] },
    });
  }

  /** 整代提交的写盘数据源（world.json 信封）。 */
  saveData(): WorldFile {
    return this.data;
  }

  /** 数据整体替换（错误再同步用：对象身份保持，内容回到指定 Generation）。 */
  restoreData(data: WorldFile): void {
    this.data = JSON.parse(JSON.stringify(data)) as WorldFile;
  }

  get world(): StateTree & { time: TimeAnchor } { return this.data.world; }
  get clock(): number { return worldTimeToMinutes(this.data.world.time); }
  get pipeline(): Pipeline { return this.data.pipeline; }

  apply(deltas: StateDelta[]): VarChange[] {
    for (const delta of deltas) {
      if (delta.path === "time" || delta.path.startsWith("time.")) throw new Error("GM deltas 不得修改 world.time；时间只能由调度器推进");
    }
    let nextWorld = JSON.parse(JSON.stringify(this.data.world)) as StateTree & { time: TimeAnchor };
    const changes: VarChange[] = [];
    for (const delta of deltas) {
      const before = getByPath(nextWorld, delta.path);
      nextWorld = applyDeltas(nextWorld, [delta]) as StateTree & { time: TimeAnchor };
      changes.push(makeVarChange(`world.${delta.path}`, before, getByPath(nextWorld, delta.path)));
    }
    this.data = { ...this.data, world: nextWorld };
    return changes;
  }

  setClock(to: number): VarChange {
    if (!Number.isFinite(to) || !Number.isInteger(to)) throw new Error(`clock 必须是有限整数分钟: ${to}`);
    const before = this.data.world.time;
    const after = minutesToWorldTime(to);
    this.data = { ...this.data, world: { ...this.data.world, time: after } };
    return { path: "world.time", before, after };
  }

  revertChange(change: VarChange): void {
    if (!change.path.startsWith("world.")) throw new Error(`worldStore 无法反向的路径: ${change.path}`);
    const world = JSON.parse(JSON.stringify(this.data.world)) as StateTree & { time: TimeAnchor };
    const dotted = change.path.slice("world.".length);
    if (change.before_exists === false) deleteByPath(world, dotted);
    else setByPath(world, dotted, change.before);
    this.data = { ...this.data, world };
  }

  setPipeline(patch: Partial<Pipeline>): void {
    this.data = { ...this.data, pipeline: { ...this.data.pipeline, ...patch } };
  }

  snapshot(): { world: StateTree & { time: TimeAnchor } } {
    return JSON.parse(JSON.stringify({ world: this.data.world })) as { world: StateTree & { time: TimeAnchor } };
  }

  restoreSnapshot(snapshot: { world: StateTree & { time: TimeAnchor } }): void {
    this.data = { ...this.data, world: JSON.parse(JSON.stringify(snapshot.world)) as StateTree & { time: TimeAnchor } };
  }

  /** 整体替换世界变量树（状态栏直接编辑用）：先校验（time 锚必须保留），失败抛错不变更。 */
  replaceWorld(world: unknown): void {
    const parsed = WorldStateSchema.parse(world);
    this.data = { ...this.data, world: parsed };
  }
}
