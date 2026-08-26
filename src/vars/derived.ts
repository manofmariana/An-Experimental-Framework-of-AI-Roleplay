/**
 * 从动变量纯逻辑（禁 IO/LLM/server/truth/application，审计守护）。
 *
 * 从动末端 = 带 formula 的末端声明：expr = 数值公式（binds 逐键取值求值）；
 * union_attach = 内置算子（实例根部 attachtags 末端值 ∪ 各子树路径下所有名为
 * attachtags 的末端实例值——对象侧 TAG 纯名集合（string[]），按名去重——先取者胜：
 * 自身优先，子树按 paths 顺序）。
 *
 * buildDerivedPlan = 依赖图构建：expr 依赖 = binds 值路径（精确）；union_attach
 * 依赖 = paths（粗粒度：子树任意写入触发重算，即子树下每个从动末端都是被依赖项）。
 * 拓扑排序输出求值顺序供写时级联重算；成环 = 抛错（消息带环路径）。同根限定：
 * 依赖路径不得含 world./characters. 前缀（纯相对模板路径）。类型容器在静态计划
 * 中按通配段 "*" 展开一次（实例无关的依赖形状）。
 *
 * buildRootDerivedPlan = 写时级联用的根级计划：模板声明 formula ∪ 实例携带 formula
 * （实例覆盖同路径模板声明），拓扑排序后把 "*" 通配段按实例树枚举为实例名，输出
 * 实例侧求值目标序列。类型声明内部的 formula 的 binds/paths 以类型根为基准，并入
 * 计划时按挂载路径补齐前缀（"*" 段在求值时逐位替换为具体实例名）。
 *
 * evalDerived = 按声明的 formula 求值：expr 逐键经 scope.resolve 取 number 后走
 * 编译闭包；union_attach 走本模块算子（需要 scope.declRoot 做子树路径解析）。
 * evalDerivedTarget = 求值一个实例侧目标：expr 依赖末端无实例（取不到值）时返回
 * undefined（跳过重算，保持现值），不报错。
 */
import {
  resolveDeclPath,
  type ContainerDecl,
  type DeclNode,
  type FormulaDecl,
  type TerminalDecl,
} from "./template.js";
import { isTerminalInstance, readTerminal, type InstanceNode } from "./tree.js";

// ---------------------------------------------------------------------------
// union_attach 算子
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 取实例子树（仅按实例形状下行；缺段 = undefined）。 */
function instanceAtPath(instanceRoot: unknown, dottedPath: string): unknown {
  let node = instanceRoot;
  for (const seg of dottedPath.split(".")) {
    if (!isPlainObject(node)) return undefined;
    node = node[seg];
    if (node === undefined) return undefined;
  }
  return node;
}

/** 递归收集实例子树内所有名为 attachtags 的末端实例值（string[] 纯名集合）。 */
function collectAttachTags(node: unknown, sink: (items: readonly string[]) => void): void {
  if (!isPlainObject(node) || isTerminalInstance(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "attachtags" && isTerminalInstance(value) && Array.isArray(value.value)) {
      sink(value.value as string[]);
      continue;
    }
    collectAttachTags(value, sink);
  }
}

/**
 * union_attach 求值：实例根部 attachtags 末端值 ∪ 各子树路径下所有名为 attachtags
 * 的末端实例值；按名去重（先取者胜：自身 attachtags 优先，子树按 paths 顺序）。
 * 子树路径必须解析到容器声明；实例子树缺失按空集处理。
 */
export function unionAttach(
  instanceRoot: InstanceNode,
  declRoot: DeclNode,
  subtreePaths: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const pushAll = (items: readonly string[]): void => {
    for (const item of items) {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  };
  pushAll((readTerminal(instanceRoot, declRoot, "attachtags") as string[] | undefined) ?? []);
  for (const p of subtreePaths) {
    const decl = resolveDeclPath(declRoot, p);
    if (decl.kind === "terminal") {
      throw new Error(`union_attach 子树路径 "${p}" 必须解析到容器声明`);
    }
    collectAttachTags(instanceAtPath(instanceRoot, p), pushAll);
  }
  return out;
}

/**
 * character 根 tags 池求值：按根 tags 末端声明的 union_attach paths 求 unionAttach
 * （模板解析已保证该末端存在且为 union_attach 从动末端）。
 */
export function evalTagsPool(instanceRoot: InstanceNode, characterDecl: ContainerDecl): string[] {
  const tagsDecl = characterDecl.children["tags"] as TerminalDecl;
  const formula = tagsDecl.formula;
  if (formula?.kind !== "unionAttach") {
    throw new Error("character 根 tags 末端必须是 union_attach 从动末端");
  }
  return unionAttach(instanceRoot, characterDecl, formula.paths);
}

// ---------------------------------------------------------------------------
// 依赖图与拓扑排序
// ---------------------------------------------------------------------------

export interface DerivedPlan {
  /** 从动末端路径按求值顺序排列（被依赖者在前） */
  order: string[];
  /** 每个从动末端的直接依赖路径（expr = binds 值；union_attach = paths） */
  deps: Readonly<Record<string, readonly string[]>>;
}

/** 同根限定：依赖路径不得含 world./characters. 前缀。 */
function checkRelativePath(path: string, atPath: string): void {
  const head = path.split(".")[0];
  if (head === "world" || head === "characters") {
    throw new Error(`从动依赖路径 "${path}" 必须是同根相对路径（${atPath}）`);
  }
}

/** 提取 formula 的直接依赖路径（expr = binds 值；union_attach = paths）并做同根限定。 */
function formulaDeps(path: string, f: FormulaDecl): readonly string[] {
  const list = f.kind === "expr" ? Object.values(f.binds) : [...f.paths];
  for (const p of list) checkRelativePath(p, path);
  return list;
}

/** 收集根下全部带 formula 的末端声明（类型容器按 "*" 通配段展开一次）。 */
function collectDerived(decl: DeclNode, path: string, out: Array<{ path: string; decl: TerminalDecl }>): void {
  if (decl.kind === "terminal") {
    if (decl.formula !== undefined) out.push({ path, decl });
    return;
  }
  if (decl.kind === "typeContainer") {
    collectDerived(decl.decl, `${path}.*`, out);
    return;
  }
  for (const [key, child] of Object.entries(decl.children)) {
    collectDerived(child, path === "" ? key : `${path}.${key}`, out);
  }
}

/** 计划节点：path 可含 "*" 通配段（类型容器层）或为实例侧具体路径。 */
interface PlanNode {
  path: string;
  deps: readonly string[];
}

/** 依赖匹配：dep 是 nodePath 的段级前缀（任一侧的 "*" 段与任意段互配）。 */
function depMatches(nodePath: string, dep: string): boolean {
  const nodeSegs = nodePath.split(".");
  const depSegs = dep.split(".");
  if (depSegs.length > nodeSegs.length) return false;
  return depSegs.every((s, i) => s === "*" || nodeSegs[i] === "*" || s === nodeSegs[i]);
}

/** Kahn 拓扑排序（按收集顺序取零入度节点，确定性输出）；成环 = 抛错（消息带环路径）。 */
function topoSortDerived(nodes: readonly PlanNode[]): PlanNode[] {
  const paths = nodes.map((n) => n.path);
  // 边：被依赖从动末端 -> 依赖方（拓扑序中被依赖者在前）
  const edges = new Map<string, Set<string>>();
  for (const p of paths) edges.set(p, new Set());
  for (const node of nodes) {
    for (const dep of node.deps) {
      for (const other of paths) {
        if (other === node.path) continue;
        if (depMatches(other, dep)) edges.get(other)!.add(node.path);
      }
    }
  }
  const indegree = new Map<string, number>();
  for (const p of paths) indegree.set(p, 0);
  for (const targets of edges.values()) {
    for (const t of targets) indegree.set(t, (indegree.get(t) ?? 0) + 1);
  }
  const queue = paths.filter((p) => indegree.get(p) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const p = queue.shift()!;
    order.push(p);
    for (const t of edges.get(p)!) {
      const d = indegree.get(t)! - 1;
      indegree.set(t, d);
      if (d === 0) queue.push(t);
    }
  }
  if (order.length !== paths.length) {
    const cyclic = paths.filter((p) => (indegree.get(p) ?? 0) > 0);
    throw new Error(`从动变量依赖成环：${cyclic.join(" -> ")}`);
  }
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  return order.map((p) => byPath.get(p)!);
}

/**
 * 构建从动依赖图并拓扑排序：expr 依赖 = binds 值路径（精确匹配从动末端建边）；
 * union_attach 依赖 = paths（粗粒度：子树下每个从动末端都建边）。成环 = 抛错
 * （消息带环路径）。
 */
export function buildDerivedPlan(declRoot: DeclNode): DerivedPlan {
  const derived: Array<{ path: string; decl: TerminalDecl }> = [];
  collectDerived(declRoot, "", derived);
  const deps: Record<string, readonly string[]> = {};
  const nodes: PlanNode[] = [];
  for (const { path, decl } of derived) {
    const list = formulaDeps(path, decl.formula!);
    deps[path] = list;
    nodes.push({ path, deps: list });
  }
  const ordered = topoSortDerived(nodes);
  return { order: ordered.map((n) => n.path), deps };
}

// ---------------------------------------------------------------------------
// 求值
// ---------------------------------------------------------------------------

export interface DerivedScope {
  /** 按同根相对路径取值（expr 公式 binds 用） */
  resolve: (path: string) => unknown;
  /** 同根声明树（union_attach 子树路径解析用；expr 公式可不传） */
  declRoot?: DeclNode | undefined;
}

/** 按声明的 formula 求值：expr = binds 逐键 resolve 取 number；union_attach 走算子。 */
export function evalDerived(
  declNode: TerminalDecl,
  instanceRoot: InstanceNode,
  scope: DerivedScope,
): unknown {
  const f = declNode.formula;
  if (f === undefined) {
    throw new Error("evalDerived 要求末端声明带 formula");
  }
  if (f.kind === "expr") {
    const values: Record<string, number> = {};
    for (const [key, p] of Object.entries(f.binds)) {
      const v = scope.resolve(p);
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(`从动公式绑定 "${key}"（路径 "${p}"）取不到有限数值`);
      }
      values[key] = v;
    }
    return f.compiled.evaluate(values);
  }
  if (scope.declRoot === undefined) {
    throw new Error("union_attach 求值需要 scope.declRoot");
  }
  return unionAttach(instanceRoot, scope.declRoot, f.paths);
}

// ---------------------------------------------------------------------------
// 写时级联：根级计划（模板声明 ∪ 实例 formula）与实例侧目标求值
// ---------------------------------------------------------------------------

/** 从动求值目标：实例侧具体路径（类型容器层已枚举为实例名）+ 生效 formula。 */
export interface DerivedTarget {
  path: string;
  formula: FormulaDecl;
}

/** 实例侧具体路径 → 模板侧路径（类型容器层以 "*" 占位；按声明树下行，不可下行时原样返回）。 */
function patternPathOf(declRoot: DeclNode, concretePath: string): string {
  let node = declRoot;
  const out: string[] = [];
  for (const seg of concretePath.split(".")) {
    if (node.kind === "terminal") return concretePath;
    if (node.kind === "typeContainer") {
      out.push("*");
      node = node.decl;
      continue;
    }
    const child = node.children[seg];
    if (child === undefined) return concretePath;
    out.push(seg);
    node = child;
  }
  return out.join(".");
}

/**
 * 模板侧路径按实例树把 "*" 通配段枚举为实例名（无实例的类型容器 = 零展开；
 * 普通段实例缺失不截断——从动末端允许有声明无实例，求值时再判定）。
 */
function expandWildcard(instanceRoot: unknown, patternPath: string): string[] {
  let fronts: Array<{ node: unknown; segs: string[] }> = [{ node: instanceRoot, segs: [] }];
  for (const seg of patternPath.split(".")) {
    const next: Array<{ node: unknown; segs: string[] }> = [];
    for (const f of fronts) {
      const container = isPlainObject(f.node) && !isTerminalInstance(f.node) ? f.node : undefined;
      if (seg === "*") {
        for (const key of Object.keys(container ?? {})) {
          next.push({ node: (container as Record<string, unknown>)[key], segs: [...f.segs, key] });
        }
      } else {
        next.push({ node: container?.[seg], segs: [...f.segs, seg] });
      }
    }
    fronts = next;
  }
  return fronts.map((f) => f.segs.join("."));
}

/** 按声明树下行收集实例携带的 formula（实例侧具体路径；声明外实例不感知）。 */
function collectInstanceFormulas(
  decl: DeclNode,
  inst: unknown,
  path: string,
  out: Array<{ path: string; formula: FormulaDecl }>,
): void {
  if (decl.kind === "terminal") {
    if (isTerminalInstance(inst) && inst.formula !== undefined) out.push({ path, formula: inst.formula });
    return;
  }
  if (!isPlainObject(inst) || isTerminalInstance(inst)) return;
  if (decl.kind === "typeContainer") {
    for (const [key, value] of Object.entries(inst)) {
      collectInstanceFormulas(decl.decl, value, `${path}.${key}`, out);
    }
    return;
  }
  for (const [key, child] of Object.entries(decl.children)) {
    collectInstanceFormulas(child, inst[key], path === "" ? key : `${path}.${key}`, out);
  }
}

/** 模板侧路径的类型挂载前缀（formula 的 binds/paths 解析基准）：含 "*" = 截至末个 "*" 段；否则根。 */
function mountPrefixOf(patternPath: string): string {
  const segs = patternPath.split(".");
  const last = segs.lastIndexOf("*");
  return last < 0 ? "" : segs.slice(0, last + 1).join(".");
}

/** 类型声明内部的 formula 改写到挂载路径基准（binds/paths 补前缀；"*" 段求值时替换为实例名）。 */
function rebaseFormula(f: FormulaDecl, mount: string): FormulaDecl {
  if (mount === "") return f;
  if (f.kind === "expr") {
    const binds: Record<string, string> = {};
    for (const [key, p] of Object.entries(f.binds)) binds[key] = `${mount}.${p}`;
    return { ...f, binds };
  }
  return { kind: "unionAttach", paths: f.paths.map((p) => `${mount}.${p}`) };
}

/**
 * 根级从动计划（写时级联用）：模板声明 formula ∪ 实例携带 formula（实例覆盖同路径
 * 模板声明），依赖图拓扑排序（成环 = 抛错）后把 "*" 通配段按实例树枚举为实例名。
 * 输出 = 按求值顺序排列的实例侧求值目标。类型声明内部的 formula 的依赖以类型根为
 * 基准，并入计划时按挂载路径补齐前缀。
 */
export function buildRootDerivedPlan(declRoot: DeclNode, instanceRoot: InstanceNode): DerivedTarget[] {
  const tplDerived: Array<{ path: string; decl: TerminalDecl }> = [];
  collectDerived(declRoot, "", tplDerived);
  const tplPaths = new Set(tplDerived.map((d) => d.path));

  const instFormulas: Array<{ path: string; formula: FormulaDecl }> = [];
  collectInstanceFormulas(declRoot, instanceRoot, "", instFormulas);

  const nodes: PlanNode[] = [];
  const tplFormulaByPath = new Map<string, FormulaDecl>();
  for (const { path, decl } of tplDerived) {
    const formula = rebaseFormula(decl.formula!, mountPrefixOf(path));
    tplFormulaByPath.set(path, formula);
    nodes.push({ path, deps: formulaDeps(path, formula) });
  }
  // 实例 formula：模板同路径已有声明 = 展开阶段覆盖；否则 = 独立从动节点（实例侧具体路径）
  for (const { path, formula } of instFormulas) {
    if (tplPaths.has(patternPathOf(declRoot, path))) continue;
    nodes.push({ path, deps: formulaDeps(path, formula) });
  }

  const ordered = topoSortDerived(nodes);
  const instFormulaByPath = new Map(instFormulas.map((d) => [d.path, d.formula]));
  const targets: DerivedTarget[] = [];
  for (const node of ordered) {
    const tplFormula = tplFormulaByPath.get(node.path);
    if (tplFormula === undefined) {
      targets.push({ path: node.path, formula: instFormulaByPath.get(node.path)! });
      continue;
    }
    for (const concrete of expandWildcard(instanceRoot, node.path)) {
      targets.push({ path: concrete, formula: instFormulaByPath.get(concrete) ?? tplFormula });
    }
  }
  return targets;
}

/**
 * 求值一个实例侧从动目标：expr = binds 逐键 readTerminal 取值（路径中的 "*" 段按
 * 目标具体路径逐位替换为实例名），任一依赖末端无实例（取不到值）= 返回 undefined
 * （跳过重算，保持现值，不报错）；union_attach = 内置算子（子树缺失按空集）。
 */
export function evalDerivedTarget(
  target: DerivedTarget,
  declRoot: DeclNode,
  instanceRoot: InstanceNode,
): unknown {
  const segs = target.path.split(".");
  const subst = (p: string): string =>
    p
      .split(".")
      .map((s, i) => (s === "*" ? (segs[i] ?? s) : s))
      .join(".");
  const f = target.formula;
  if (f.kind === "expr") {
    for (const p of Object.values(f.binds)) {
      if (readTerminal(instanceRoot, declRoot, subst(p), "value") === undefined) return undefined;
    }
    const decl: TerminalDecl = { kind: "terminal", valueType: "number", formula: f };
    return evalDerived(decl, instanceRoot, {
      resolve: (p) => readTerminal(instanceRoot, declRoot, subst(p), "value"),
    });
  }
  const decl: TerminalDecl = {
    kind: "terminal",
    valueType: "string_list",
    formula: { kind: "unionAttach", paths: f.paths.map(subst) },
  };
  return evalDerived(decl, instanceRoot, { resolve: () => undefined, declRoot });
}
