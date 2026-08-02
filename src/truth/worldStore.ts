import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { runDir } from "../config.js";
import type { StateDelta } from "../types.js";
import { WorkingSetEntrySchema, type WorkingSetEntry } from "./workingSet.js";
import { SAVE_SCHEMA_VERSION, incompatibleSave } from "./saveSchema.js";
import { TimeAnchorSchema, minutesToWorldTime, worldTimeToMinutes, type TimeAnchor } from "./timeStore.js";

export type StateTree = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export const VarChangeSchema = z.object({
  path: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  before_exists: z.boolean().optional(),
  /** 信息性标记（直编删除路径时置 false）：反转只依赖 before/before_exists，不读 after 侧 */
  after_exists: z.boolean().optional(),
});
export type VarChange = z.infer<typeof VarChangeSchema>;

export function makeVarChange(path: string, before: unknown, after: unknown): VarChange {
  const change: VarChange = { path, before: before ?? null, after: after ?? null };
  if (before === undefined) change.before_exists = false;
  return change;
}

export function getByPath(root: unknown, dotted: string): unknown {
  let node = root;
  for (const segment of dotted.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment]; // 数组按数字字符串下标取值
  }
  return node;
}

export function setByPath(root: Record<string, unknown>, dotted: string, value: unknown): void {
  const segments = dotted.split(".");
  if (segments.length === 0 || segments.some((s) => s === "")) throw new Error(`invalid path: ${dotted}`);
  let node: Record<string, unknown> = root;
  for (const segment of segments.slice(0, -1)) {
    const child = node[segment];
    if (child === undefined) {
      const fresh: Record<string, unknown> = {};
      node[segment] = fresh;
      node = fresh;
    } else if (typeof child === "object" && child !== null) {
      node = child as Record<string, unknown>; // 数组同样按数字字符串下标穿透
    } else throw new Error(`path ${dotted} 穿过非对象节点: ${segment}`);
  }
  node[segments[segments.length - 1]!] = value;
}

export function deleteByPath(root: Record<string, unknown>, dotted: string, minDepth = 0): void {
  const segments = dotted.split(".");
  const stack: [Record<string, unknown>, string][] = [];
  let node: Record<string, unknown> = root;
  for (const segment of segments.slice(0, -1)) {
    const child = node[segment];
    if (typeof child !== "object" || child === null) return;
    stack.push([node, segment]);
    node = child as Record<string, unknown>;
  }
  const leafKey = segments[segments.length - 1]!;
  // 数组元素删除 = splice（before_exists=false 的反转：该下标原本不存在，删除后长度复原）；
  // 对象键删除 = delete
  if (Array.isArray(node)) node.splice(Number(leafKey), 1);
  else delete node[leafKey];
  for (let i = stack.length - 1; i >= minDepth; i--) {
    const [parent, segment] = stack[i]!;
    const child = parent[segment];
    if (isRecord(child) && Object.keys(child).length === 0) delete parent[segment];
    else break;
  }
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

export const PipelinePhaseSchema = z.enum(["await_player", "await_character", "await_gm", "await_prose"]);
export type PipelinePhase = z.infer<typeof PipelinePhaseSchema>;
export const PipelineCurrentSchema = z.object({
  seq: z.number(), kind: z.string(), result: z.unknown(),
  var_changes: z.array(VarChangeSchema).optional(), interrupted: z.boolean().optional(), edited: z.boolean().optional(),
});
export type PipelineCurrent = z.infer<typeof PipelineCurrentSchema>;
export const PipelineSchema = z.object({
  seq: z.number(), phase: PipelinePhaseSchema, working_set: z.array(WorkingSetEntrySchema), current: PipelineCurrentSchema.nullable(),
});
export type Pipeline = z.infer<typeof PipelineSchema>;

export const WorldStateSchema = z.object({ time: TimeAnchorSchema }).catchall(z.unknown());
export const WorldFileSchema = z.object({
  schema_version: z.literal(SAVE_SCHEMA_VERSION),
  world: WorldStateSchema,
  pipeline: PipelineSchema,
});
export type WorldFile = z.infer<typeof WorldFileSchema>;

const INITIAL_PIPELINE: Pipeline = { seq: 0, phase: "await_player", working_set: [], current: null };

export class WorldStore {
  private file: string;
  private data: WorldFile;

  constructor(runId: string, initial: { world: StateTree & { time: TimeAnchor } }, baseDir?: string) {
    const dir = path.join(baseDir ?? runDir(runId));
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "world.json");
    if (fs.existsSync(this.file)) {
      try { this.data = WorldFileSchema.parse(JSON.parse(fs.readFileSync(this.file, "utf8"))); }
      catch (error) { throw incompatibleSave(error); }
    } else {
      this.data = { schema_version: SAVE_SCHEMA_VERSION, world: initial.world, pipeline: { ...INITIAL_PIPELINE, working_set: [] } };
      this.persist();
    }
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
    this.persist();
    return changes;
  }

  setClock(to: number): VarChange {
    if (!Number.isFinite(to) || !Number.isInteger(to)) throw new Error(`clock 必须是有限整数分钟: ${to}`);
    const before = this.data.world.time;
    const after = minutesToWorldTime(to);
    this.data = { ...this.data, world: { ...this.data.world, time: after } };
    this.persist();
    return { path: "world.time", before, after };
  }

  revertChange(change: VarChange): void {
    if (!change.path.startsWith("world.")) throw new Error(`worldStore 无法反向的路径: ${change.path}`);
    const world = JSON.parse(JSON.stringify(this.data.world)) as StateTree & { time: TimeAnchor };
    const dotted = change.path.slice("world.".length);
    if (change.before_exists === false) deleteByPath(world, dotted);
    else setByPath(world, dotted, change.before);
    this.data = { ...this.data, world };
    this.persist();
  }

  setPipeline(patch: Partial<Pipeline>): void {
    this.data = { ...this.data, pipeline: { ...this.data.pipeline, ...patch } };
    this.persist();
  }

  snapshot(): { world: StateTree & { time: TimeAnchor } } {
    return JSON.parse(JSON.stringify({ world: this.data.world })) as { world: StateTree & { time: TimeAnchor } };
  }

  restoreSnapshot(snapshot: { world: StateTree & { time: TimeAnchor } }): void {
    this.data = { ...this.data, world: JSON.parse(JSON.stringify(snapshot.world)) as StateTree & { time: TimeAnchor } };
    this.persist();
  }

  /** 整体替换世界变量树（状态栏直接编辑用）：先校验（time 锚必须保留），失败抛错不落盘。 */
  replaceWorld(world: unknown): void {
    const parsed = WorldStateSchema.parse(world);
    this.data = { ...this.data, world: parsed };
    this.persist();
  }

  private persist(): void { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2) + "\n", "utf8"); }
}
