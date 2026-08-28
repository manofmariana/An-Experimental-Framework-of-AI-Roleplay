/**
 * world 内容根：纯变量树容器（纯内存，无 IO）。
 *
 * world.json = {world: 变量树}——变量树含系统声明分支 time（时间锚五末端 + periods
 * 时段表，见 vars/systemWorld）；程序分支（结构三件套/计数键/pipeline）在 sys 根
 * （sysStore），本根不持。时钟 = world.time 锚派生（worldTimeToMinutes）；setClock
 * 是时间推进的唯一写口（调度专用，保留各末端外壳 tags）。
 *
 * 每次变异只改内存；落盘由 GenerationRepository 在步边界整代提交（唯一写盘出口）。
 */
import { z } from "zod";
import {
  minutesToWorldTime,
  readWorldTime,
  worldTimeToMinutes,
} from "../vars/systemWorld.js";
import { VarChangeSchema, deleteByPath, getByPath, makeVarChange, setByPath, type VarChange } from "./varChanges.js";

export type StateTree = Record<string, unknown>;

/**
 * 步骤变化分段：
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

/** world.json 文件 codec（schema_version 单点化后本文件不再盖章；树结构校验在装配/直编的 normalize）。 */
export const WorldFileSchema = z.object({ world: z.record(z.string(), z.unknown()) });
export type WorldFile = z.infer<typeof WorldFileSchema>;

export class WorldStore {
  private data: StateTree;

  constructor(tree: StateTree) {
    this.data = JSON.parse(JSON.stringify(tree)) as StateTree;
  }

  /** 整代提交的写盘数据源（world.json 的 world 载荷）。 */
  saveData(): StateTree {
    return this.data;
  }

  /** 数据整体替换（错误再同步用：对象身份保持，内容回到指定 Generation）。 */
  restoreData(tree: StateTree): void {
    this.data = JSON.parse(JSON.stringify(tree)) as StateTree;
  }

  get world(): StateTree {
    return this.data;
  }

  /** 世界时钟（分钟标量）= world.time 锚派生。 */
  get clock(): number {
    return worldTimeToMinutes(readWorldTime(this.data).anchor);
  }

  /**
   * 低层写入口（varWrite/程序专用：调用方负责校验；path = world 树内点路径，
   * 值 = 该路径的整体新值）。产出真相根路径 VarChange（`world.…`）。
   */
  writeRaw(path: string, value: unknown): VarChange {
    const world = JSON.parse(JSON.stringify(this.data)) as StateTree;
    const before = getByPath(world, path);
    setByPath(world, path, value);
    this.data = world;
    return makeVarChange(`world.${path}`, before, value);
  }

  /** 时钟推进（调度专用写口）：改写 time 锚五末端的 value，外壳 tags 原样保留。 */
  setClock(to: number): VarChange {
    if (!Number.isFinite(to) || !Number.isInteger(to)) throw new Error(`clock 必须是有限整数分钟: ${to}`);
    const before = JSON.parse(JSON.stringify(this.data["time"])) as Record<string, unknown>;
    const anchor = minutesToWorldTime(to);
    const time = this.data["time"] as Record<string, unknown>;
    const next: Record<string, unknown> = { ...time };
    for (const key of ["y", "m", "d", "h", "min"] as const) {
      const shell = time[key] as { tags?: unknown };
      next[key] = { value: anchor[key], tags: shell.tags ?? [] };
    }
    this.data = { ...this.data, time: next };
    return { path: "world.time", before, after: JSON.parse(JSON.stringify(next)) };
  }

  revertChange(change: VarChange): void {
    if (!change.path.startsWith("world.")) throw new Error(`worldStore 无法反向的路径: ${change.path}`);
    const world = JSON.parse(JSON.stringify(this.data)) as StateTree;
    const dotted = change.path.slice("world.".length);
    if (change.before_exists === false) deleteByPath(world, dotted);
    else setByPath(world, dotted, change.before);
    this.data = world;
  }

  /** 整体替换世界变量树（状态直编用）：先校验（记录形状 + time 锚可回读），失败抛错不变更。 */
  replaceWorld(world: unknown): void {
    const parsed = z.record(z.string(), z.unknown()).parse(world);
    readWorldTime(parsed); // time 系统分支必备（缺失/畸形 = 拒写）
    this.data = parsed;
  }
}
