import { makeVarChange, type VarChange } from "./varChanges.js";

/**
 * 状态树叶级 diff（状态直编并入当前步 StepChanges.effects 用）：对比替换前后的两棵变量树，
 * 产出与 StepChanges 相同路径约定的变更记录（characters 域 `characters.C1001.timer`、
 * world 域 `world.region.harbor.fog`；数组按索引，如 `long_term_memory.3`）。
 *
 * 三类差异：
 * - 值变化：{path, before, after}；
 * - 路径新增：before=null + before_exists=false（反转 = 删除该路径并 prune 空父层）；
 * - 路径删除：before 保留原值 + after=null + after_exists=false
 *   （after_exists 是信息性标记——反转只依赖 before/before_exists，
 *   worldStore/charactersStore.revertChange 据此写回原值，不需要 after 侧）。
 *
 * 删除/新增以"差异子树的根"为粒度（整条子树一条记录，反转整体写回/删除）；
 * 数组长度差在尾部逐索引产出新增/删除记录。遍历顺序确定性
 * （先旧树键序、后新树新增键；数组按下标升序），保证可测。
 * 纯函数：无 IO、不改入参。
 */
export function diffStateTrees(oldTree: unknown, newTree: unknown, prefix: string): VarChange[] {
  const changes: VarChange[] = [];
  walk(oldTree, newTree, prefix, changes);
  return changes;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 叶值相等（JSON 树只含可序列化值；undefined 防御性归一到 null）。 */
function leafEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function joinPath(prefix: string, key: string): string {
  return prefix === "" ? key : `${prefix}.${key}`;
}

function addChange(path: string, value: unknown): VarChange {
  return makeVarChange(path, undefined, value); // before=null + before_exists=false
}

function deleteChange(path: string, value: unknown): VarChange {
  const change = makeVarChange(path, value, null);
  change.after_exists = false; // 信息性标记：after 侧不存在（反转不依赖它）
  return change;
}

function walk(oldNode: unknown, newNode: unknown, path: string, out: VarChange[]): void {
  if (isRecord(oldNode) && isRecord(newNode)) {
    for (const key of Object.keys(oldNode)) {
      const childPath = joinPath(path, key);
      if (!(key in newNode)) out.push(deleteChange(childPath, oldNode[key]));
      else walk(oldNode[key], newNode[key], childPath, out);
    }
    for (const key of Object.keys(newNode)) {
      if (!(key in oldNode)) out.push(addChange(joinPath(path, key), newNode[key]));
    }
    return;
  }
  if (Array.isArray(oldNode) && Array.isArray(newNode)) {
    const common = Math.min(oldNode.length, newNode.length);
    for (let i = 0; i < common; i++) walk(oldNode[i], newNode[i], joinPath(path, String(i)), out);
    for (let i = common; i < oldNode.length; i++) out.push(deleteChange(joinPath(path, String(i)), oldNode[i]));
    for (let i = common; i < newNode.length; i++) out.push(addChange(joinPath(path, String(i)), newNode[i]));
    return;
  }
  // 叶值变化（含记录/数组 ↔ 标量的类型替换：整体一条记录，反转整体写回）
  if (!leafEqual(oldNode, newNode)) out.push(makeVarChange(path, oldNode, newNode));
}
