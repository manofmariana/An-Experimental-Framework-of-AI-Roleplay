import { z } from "zod";
import { WorkingSetEntrySchema, type WorkingSetEntry } from "./workingSet.js";
import { SAVE_SCHEMA_VERSION } from "./saveSchema.js";
import { TimeAnchorSchema, minutesToWorldTime, worldTimeToMinutes, type TimeAnchor } from "./timeStore.js";
import { VarChangeSchema, deleteByPath, getByPath, makeVarChange, setByPath, type VarChange } from "./varChanges.js";

export type StateTree = Record<string, unknown>;

/** `_sys` 程序分支的文件 codec 形状（必需存在的对象；严格解析在装配层/写入层做）。 */
export const WorldSysSchema = z.record(z.string(), z.unknown());
export type WorldSys = z.infer<typeof WorldSysSchema>;

/**
 * 步骤变化分段（存档 v7）：
 * setup = 调度在该步执行前产生的变化（时钟跳转/周期计数/维护性 acted 清零/邀请激活 timer 弹出）；
 * effects = 本步 DecisionPackage/AdjudicationPackage 经效果规划器产生的变化。
 * 回滚倒序反转 effects 再倒序反转 setup。
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
 * 扁平化（先 setup 后 effects）：
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
  // phase 不落盘：派生量由消费方一律 phaseOf(deriveNext(...)) 现算
  seq: z.number(), working_set: z.array(WorkingSetEntrySchema), current: PipelineCurrentSchema.nullable(),
});
export type Pipeline = z.infer<typeof PipelineSchema>;

export const WorldStateSchema = z.object({ time: TimeAnchorSchema, _sys: WorldSysSchema }).catchall(z.unknown());
export type WorldState = z.infer<typeof WorldStateSchema>;
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

  /** 新档初始容器：world 变量树（time 锚 + _sys 程序分支）+ 空流水线。 */
  static initial(world: StateTree & { time: TimeAnchor }, sys: WorldSys): WorldStore {
    return new WorldStore({
      schema_version: SAVE_SCHEMA_VERSION,
      world: { ...world, _sys: sys },
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

  get world(): WorldState & StateTree { return this.data.world; }
  get clock(): number { return worldTimeToMinutes(this.data.world.time); }
  get pipeline(): Pipeline { return this.data.pipeline; }

  /**
   * 低层写入口（程序分支/varWrite 专用：调用方负责校验；path = world 树内点路径，
   * 值 = 该路径的整体新值）。产出真相根路径 VarChange（`world.…`）。
   */
  writeRaw(path: string, value: unknown): VarChange {
    const world = JSON.parse(JSON.stringify(this.data.world)) as WorldState & StateTree;
    const before = getByPath(world, path);
    setByPath(world, path, value);
    this.data = { ...this.data, world };
    return makeVarChange(`world.${path}`, before, value);
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
    const world = JSON.parse(JSON.stringify(this.data.world)) as WorldState;
    const dotted = change.path.slice("world.".length);
    if (change.before_exists === false) deleteByPath(world, dotted);
    else setByPath(world, dotted, change.before);
    this.data = { ...this.data, world };
  }

  setPipeline(patch: Partial<Pipeline>): void {
    this.data = { ...this.data, pipeline: { ...this.data.pipeline, ...patch } };
  }

  snapshot(): { world: WorldState } {
    return JSON.parse(JSON.stringify({ world: this.data.world })) as { world: WorldState };
  }

  restoreSnapshot(snapshot: { world: WorldState }): void {
    this.data = { ...this.data, world: JSON.parse(JSON.stringify(snapshot.world)) as WorldState };
  }

  /** 整体替换世界变量树（状态栏直接编辑用）：先校验（time 锚与 _sys 必须保留），失败抛错不变更。 */
  replaceWorld(world: unknown): void {
    const parsed = WorldStateSchema.parse(world);
    this.data = { ...this.data, world: parsed };
  }
}
