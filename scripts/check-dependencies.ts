/**
 * 架构依赖审计。
 *
 * 用项目已有 typescript Compiler API 建 src/** 模块依赖图（静态 import、动态 import、
 * export ... from），检查：① 禁止边；② 传递依赖违规（按可达性，不只是直接 import）；
 * ③ import 循环（强连通分量，仅按运行时边计算，type-only 边在编译后即擦除，不构成循环）。
 *
 * test/** 不入图（禁止边检查无意义，循环检测亦无意义）。
 * 规则与迁移期例外集中在下方 RULES / EXCEPTIONS 两个数据结构维护。
 * 有违规、循环或失效例外时 process.exit(1)。
 */
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// 规则：from 匹配到的文件（含其传递可达的文件）不得依赖 forbid 匹配到的目标。
// 模式约定：以 "/" 结尾 = 目录前缀；"node:" = 任意 node 内建模块；其余 = 精确匹配。
// ---------------------------------------------------------------------------
interface Rule {
  from: string;
  forbid: string[];
  reason: string;
}

const RULES: Rule[] = [
  {
    from: "src/scheduler/",
    forbid: ["node:", "openai", "ws", "src/llm/", "src/server/", "src/truth/", "src/application/"],
    reason: "scheduler 必须保持纯逻辑（无 IO/LLM/server/truth/application 依赖，含传递依赖）",
  },
  {
    from: "src/tags/",
    forbid: ["node:", "openai", "ws", "src/llm/", "src/server/", "src/truth/", "src/application/"],
    reason: "tags 必须保持纯逻辑（无 IO/LLM/server/truth/application 依赖，含传递依赖）；变量值一律由调用方 scope 注入",
  },
  {
    from: "src/vars/",
    forbid: [
      "node:",
      "openai",
      "ws",
      "src/llm/",
      "src/server/",
      "src/truth/",
      "src/application/",
      "src/agents/",
      "src/scheduler/",
    ],
    reason: "vars 必须保持纯逻辑（无 IO/LLM/server/truth/application/agents/scheduler 依赖，含传递依赖）；变量值与注册名集合一律由调用方注入",
  },
  {
    from: "src/compile/",
    forbid: ["src/server/", "src/truth/", "src/llm/", "src/application/"],
    reason: "compiler 是纯渲染器，不依赖 server / truth Store 实现 / llm client / application",
  },
  {
    from: "src/truth/",
    forbid: ["src/agents/", "src/server/", "src/llm/", "src/application/"],
    reason: "真相层不依赖 agents / server / llm / application",
  },
  {
    from: "src/application/",
    forbid: ["src/server/"],
    reason: "application（效果规划器/调度派生收口/会话内核与协调器）不依赖 server（传输层反向依赖它）",
  },
  {
    from: "src/llm/",
    forbid: ["src/server/", "src/application/", "src/agents/"],
    reason: "llm 客户端层不反向依赖 server / application / agents",
  },
  {
    from: "src/agents/",
    forbid: ["src/llm/openaiChatAdapter.ts", "src/llm/callLog.ts", "openai"],
    reason: "agents 只依赖 ChatPort 端口类型（chatPort.ts），不得 import OpenAI adapter / 记录 decorator / SDK 具体类",
  },
  {
    from: "src/shared/",
    forbid: ["src/"],
    reason: "shared 是跨层基础工具（safeSegment 等），不依赖 src 内任何模块",
  },
  {
    from: "src/contracts/",
    forbid: ["src/truth/", "src/agents/", "src/server/", "src/llm/", "src/application/"],
    reason: "contracts 是共享契约层，不依赖 truth / agents / server / llm / application",
  },
  {
    from: "src/resources/",
    forbid: [
      "src/truth/",
      "src/agents/",
      "src/server/",
      "src/llm/",
      "src/compile/",
      "src/scheduler/",
      "src/config.ts",
    ],
    reason: "resources 只允许依赖 shared / contracts / types（依赖方向：config → resources，不得反向）",
  },
];

// ---------------------------------------------------------------------------
// 迁移期例外：具体 from→to 边。例外必须带原因与退出事项，不得永久静默放行。
// 例外边在传递依赖判定中视为叶子（不再深入），保证例外保持窄口径。
// 例外边若从代码中消失（已迁移），此处会报「失效例外」并要求删除条目。
// ---------------------------------------------------------------------------
interface Exception {
  from: string;
  to: string;
  reason: string;
  exit: string;
}

const EXCEPTIONS: Exception[] = [
  {
    from: "src/compile/render.ts",
    to: "src/llm/chatPort.ts",
    reason: "render 仅 type-import ChatMessage（编译期依赖，无运行时边）",
    exit: "阶段 B/C 将 PromptMessage/ChatMessage 契约迁往 contracts/ 后移除此例外",
  },
  {
    from: "src/truth/charactersStore.ts",
    to: "src/agents/character.ts",
    reason: "charactersStore 仅 type-import CharacterManifest（编译期依赖，无运行时边）",
    exit: "阶段 B/C 将 CharacterManifest 契约迁往 contracts/ 后移除此例外",
  },
];

// ---------------------------------------------------------------------------
// 建图
// ---------------------------------------------------------------------------
interface Edge {
  to: string;
  typeOnly: boolean;
}

const BARE_BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith("node:")));

function toRel(absPath: string): string {
  return path.relative(ROOT, absPath).split(path.sep).join("/");
}

function resolveSpecifier(spec: string, fromFile: string, options: ts.CompilerOptions): string {
  if (spec.startsWith("node:")) return spec;
  if (BARE_BUILTINS.has(spec)) return `node:${spec}`;
  if (!spec.startsWith(".")) return spec; // 裸包名（zod/openai/ws/typescript 等）
  const resolved = ts.resolveModuleName(spec, fromFile, options, ts.sys).resolvedModule;
  if (!resolved) return spec; // 解析失败按原样保留（会在图中成为悬空外部节点）
  if (resolved.isExternalLibraryImport || resolved.resolvedFileName.includes("node_modules")) {
    return spec;
  }
  return toRel(resolved.resolvedFileName);
}

function buildGraph(): { graph: Map<string, Edge[]>; edgeCount: number } {
  const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("未找到 tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, ROOT);
  const graph = new Map<string, Edge[]>();
  let edgeCount = 0;
  for (const fileName of parsed.fileNames) {
    const rel = toRel(fileName);
    if (!rel.startsWith("src/")) continue; // test/** 不入图
    const text = ts.sys.readFile(fileName);
    if (text === undefined) continue;
    const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
    const edges: Edge[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        edges.push({
          to: resolveSpecifier(node.moduleSpecifier.text, fileName, parsed.options),
          typeOnly: node.importClause?.isTypeOnly ?? false,
        });
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        edges.push({
          to: resolveSpecifier(node.moduleSpecifier.text, fileName, parsed.options),
          typeOnly: node.isTypeOnly,
        });
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0]!)
      ) {
        edges.push({ to: resolveSpecifier(node.arguments[0].text, fileName, parsed.options), typeOnly: false });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    edgeCount += edges.length;
    graph.set(rel, edges);
  }
  return { graph, edgeCount };
}

// ---------------------------------------------------------------------------
// 模式匹配
// ---------------------------------------------------------------------------
function matchesPattern(pattern: string, target: string): boolean {
  if (pattern === "node:") return target.startsWith("node:");
  if (pattern.endsWith("/")) return target.startsWith(pattern);
  return target === pattern;
}

// ---------------------------------------------------------------------------
// 检查
// ---------------------------------------------------------------------------
interface Violation {
  rule: Rule;
  source: string;
  path: string[];
}

function checkForbidden(graph: Map<string, Edge[]>): Violation[] {
  const exceptionKeys = new Set(EXCEPTIONS.map((e) => `${e.from} -> ${e.to}`));
  const violations: Violation[] = [];
  for (const rule of RULES) {
    for (const file of graph.keys()) {
      if (!matchesPattern(rule.from, file)) continue;
      // BFS 可达性：从 rule 管辖文件出发，经项目内边能触达 forbid 目标即违规
      const visited = new Set<string>([file]);
      const queue: string[][] = [[file]];
      while (queue.length > 0) {
        const chain = queue.shift()!;
        const current = chain[chain.length - 1]!;
        for (const edge of graph.get(current) ?? []) {
          if (exceptionKeys.has(`${current} -> ${edge.to}`)) continue; // 例外：放行且不再深入
          if (rule.forbid.some((p) => matchesPattern(p, edge.to))) {
            violations.push({ rule, source: file, path: [...chain, edge.to] });
            continue;
          }
          if (graph.has(edge.to) && !visited.has(edge.to)) {
            visited.add(edge.to);
            queue.push([...chain, edge.to]);
          }
        }
      }
    }
  }
  return violations;
}

/** 强连通分量（Tarjan），仅按运行时边（type-only 边编译后擦除，不构成循环）。 */
function findCycles(graph: Map<string, Edge[]>): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  const strongconnect = (v: string): void => {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const edge of graph.get(v) ?? []) {
      if (edge.typeOnly || !graph.has(edge.to)) continue;
      const w = edge.to;
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) sccs.push(scc);
    }
  };

  for (const v of graph.keys()) {
    if (!index.has(v)) strongconnect(v);
  }
  return sccs;
}

/** 例外边必须真实存在，否则例外条目已失效（完成迁移后应删除条目）。 */
function findStaleExceptions(graph: Map<string, Edge[]>): Exception[] {
  return EXCEPTIONS.filter(
    (e) => !(graph.get(e.from) ?? []).some((edge) => edge.to === e.to),
  );
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const { graph, edgeCount } = buildGraph();
const violations = checkForbidden(graph);
const cycles = findCycles(graph);
const stale = findStaleExceptions(graph);

console.log(`[arch] 检查文件 ${graph.size} 个，依赖边 ${edgeCount} 条，规则 ${RULES.length} 条，例外 ${EXCEPTIONS.length} 条`);

if (EXCEPTIONS.length > 0) {
  console.log(`[arch] 迁移期例外（放行但登记，不得永久存在）：`);
  for (const e of EXCEPTIONS) {
    console.log(`  - ${e.from} -> ${e.to}`);
    console.log(`    原因: ${e.reason}`);
    console.log(`    退出: ${e.exit}`);
  }
}

let failed = false;

if (violations.length > 0) {
  failed = true;
  console.error(`\n[arch] 依赖违规 ${violations.length} 处：`);
  for (const v of violations) {
    const label = v.path.length > 2 ? "传递依赖" : "直接依赖";
    console.error(`  - [${v.rule.from}] ${v.source}（${label}）`);
    console.error(`    路径: ${v.path.join(" -> ")}`);
    console.error(`    规则: ${v.rule.reason}`);
  }
}

if (cycles.length > 0) {
  failed = true;
  console.error(`\n[arch] import 循环 ${cycles.length} 处：`);
  for (const scc of cycles) {
    console.error(`  - ${scc.join(" <-> ")}`);
  }
}

if (stale.length > 0) {
  failed = true;
  console.error(`\n[arch] 失效例外 ${stale.length} 处（代码中已不存在该边，请删除例外条目）：`);
  for (const e of stale) {
    console.error(`  - ${e.from} -> ${e.to}`);
  }
}

if (failed) {
  process.exit(1);
}
console.log(`[arch] 通过：无违规、无 import 循环`);
