import { z } from "zod";

/**
 * VarChange 路径引擎（真相根路径）：var_changes 记录的统一契约与
 * 点路径 get/set/delete 通用工具。路径以真相文件为根：
 * world 域 `world.time`、`world.region.harbor.fog`；
 * characters 域 `characters.C1001.timer`、`characters.C1001.relations.C1002`
 * （数组按数字字符串下标，如 `characters.C1001.long_term_memory.3`）。
 *
 * 纯逻辑：无 IO、不依赖 truth 内其他模块；各 Store 的 apply/revertChange
 * 负责剥自己域的根前缀（`world.` / `characters.CID`）后调用本模块工具。
 */
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
