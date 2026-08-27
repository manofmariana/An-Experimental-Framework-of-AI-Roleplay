/**
 * 声明式渲染引擎（纯逻辑）：模板 × 占位符目录 × RenderHost（投影层实现）→ ChatMessage[]。
 *
 * 渲染规则：
 * - 静态段原样输出；渲染后 content 为空的模块整条丢弃；懒求值——未引用的占位符不取数
 *   （host.entries/host.vars 只在渲染到该占位符时调用）。
 * - 扁平源条目段：遍历投影层供给的条目集，逐条目渲染（{_content} = 条目扁平
 *   文本、{_owner} = 属主 CID），条目间按 separator（缺省 "\n"）拼接，空渲染条目
 *   整条丢弃。条目携带过滤结果（SourceEntry.filter，如 working_set 源）时按 status
 *   走放行/不放行侧、按 matched 精确匹配分支（不放行侧 {_content} 给空）；未携带 =
 *   恒放行侧、matched 空集。identity 条目的注入值过 host.renderIdentity 身份替换后
 *   处理（统一后处理出口；模板静态文本不过）。
 * - vars 源条目段：条目内全部路径的路由链归并为一棵遍历树（公共前缀共享、[*] 差异点
 *   产生子循环，轴序 = 首次出现序）。逐实例：pass 模板全部路径调用逐末端过
 *   evaluateTagFilter → 全部放行 = 放行侧、任一不放行 = 不放行侧；分支键 = pass+fail
 *   两缺省模板全部路径的 matched 并集（排序去重）精确匹配，未命中走该侧缺省模板；
 *   渲染选中模板时不放行路径给空串。首位轴实例间按 separator、更深轴按 merge
 *   （缺省 = separator）拼接。vars 路径值不做身份替换（变量内容非 @CID 载体）。
 * - 遍历序：前置（默认）= 条目轴独立滚完；置后（order=post）= 同一占位符内全部置后
 *   条目（机检已保证首位轴一致）融合为逐实例组——逐个首位轴实例，按段序渲染各置后
 *   条目、段间 "\n" 拼接，实例组间按首个置后条目的 separator 拼接；融合组输出在首个
 *   置后段的位置。单一置后段与前置渲染等价。
 * - 有声明无实例的路径 = 放行侧空内容（无 TAG 恒通过），不产生 matched。
 */
import type { ChatMessage } from "../llm/chatPort.js";
import { evaluateTagFilter, type FilterResult, type FilterStatus, type ReaderScope } from "../tags/evaluate.js";
import type { TagRegistry } from "../tags/registry.js";
import { isTerminalInstance, type TagMount } from "../vars/tree.js";
import type { VarsTemplate } from "../vars/template.js";
import {
  axesOfChain,
  extractPathCalls,
  parseRoutingChain,
  type ChainAxis,
  type PlaceholderCatalog,
  type PlaceholderEntry,
  type PlaceholderEntrySegment,
  type PlaceholderSource,
  type RoutingChain,
} from "./placeholders.js";
import type { PromptTemplate } from "./template.js";

// ---------------------------------------------------------------------------
// RenderHost（投影层供给接口；application 实现，agents 经本类型消费）
// ---------------------------------------------------------------------------

/** 读者（取数范围限定 + TAG 过滤对象侧的基准）。 */
export type ReaderRef = { kind: "character"; cid: string } | { kind: "gm" } | { kind: "prose" };

/** 身份替换模式：cid = 事件 @CID 体系；refs = 正文 [[称呼|@CID]] 指称体系。 */
export type IdentityMode = "cid" | "refs";

/** 扁平源条目（投影层已组装的扁平文本）。 */
export interface SourceEntry {
  /** 条目扁平文本（{_content}） */
  content: string;
  /** 属主 CID（{_owner}；无属主 = 空串） */
  owner?: string | undefined;
  /** 身份替换标记：注入值过 renderIdentity 后处理（缺省 = 不过） */
  identity?: IdentityMode | undefined;
  /**
   * 逐条目 TAG 过滤结果（投影层在抓取后求值并随条目供给；缺省 = 恒放行、matched 空集）。
   * 携带时引擎按 status 走放行/不放行侧、按 matched 精确匹配分支（与 vars 源同口径：
   * 不放行侧 {_content} 给空）。
   */
  filter?: { status: FilterStatus; matched: string[] } | undefined;
}

/** TAG 过滤上下文（读者唯一，全源共用）。 */
export interface VarsFilter {
  scope: ReaderScope;
  registry: TagRegistry;
}

/** vars 源视图（读者范围内的变量树实例 + 声明 + 过滤上下文）。 */
export interface VarsView {
  /** 档内变量模板（声明侧解析基准；机检已过） */
  template: VarsTemplate;
  /** 世界变量树实例根（作者子树；time/_sys 已剔除） */
  world: unknown;
  /** 读者范围内的角色变量树（cid → vars 实例根；键序 = 渲染序，调用方排序） */
  characters: Readonly<Record<string, unknown>>;
  filter: VarsFilter;
}

/** 投影层供给接口（逐调用现算；引擎只感知本接口）。 */
export interface RenderHost {
  readonly reader: ReaderRef;
  /** 读者展示名（activation 错误标签用；character = 角色名） */
  readonly readerLabel: string;
  /** 扁平源条目集（按 source 懒取） */
  entries(source: PlaceholderSource): SourceEntry[];
  /** vars 源视图（仅 source=vars 的占位符被引用时调用） */
  vars(): VarsView;
  /** 身份替换后处理（组装层统一出口；仅 identity 条目注入值经过） */
  renderIdentity(text: string, mode: IdentityMode): string;
}

// ---------------------------------------------------------------------------
// 入口：模板 × 目录 × host → ChatMessage[]
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

/** 渲染模板为消息数组（每模块一条；空模块整条丢弃；未知占位符由 validateTemplate 拦截）。 */
export function renderPrompt(
  template: PromptTemplate,
  catalog: PlaceholderCatalog,
  host: RenderHost,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const mod of template.modules) {
    const content = mod.content.replace(PLACEHOLDER_RE, (match: string, name: string) => {
      const entry = catalog[name];
      if (entry === undefined) return match; // 模板加载/保存校验已拦截，防御保留原文
      return renderPlaceholder(entry, host);
    });
    if (content.trim().length === 0) continue; // 空模块整条丢弃
    messages.push({ role: mod.role, content });
  }
  return messages;
}

/** 渲染一个占位符：段序输出；置后段在首个置后段位置融合输出一次。 */
function renderPlaceholder(entry: PlaceholderEntry, host: RenderHost): string {
  const parts: string[] = [];
  let postRendered = false;
  for (const segment of entry.segments) {
    if (segment.kind === "static") {
      parts.push(segment.text);
      continue;
    }
    if (segment.order === "post") {
      if (!postRendered) {
        parts.push(renderPostGroup(entry, host));
        postRendered = true;
      }
      continue;
    }
    parts.push(renderEntrySegment(entry.source, segment, host));
  }
  return parts.join("");
}

function renderEntrySegment(
  source: PlaceholderSource,
  segment: PlaceholderEntrySegment,
  host: RenderHost,
): string {
  if (source === "vars") return renderVarsSegment(segment, host.vars());
  return renderFlatSegment(segment, host.entries(source), host);
}

// ---------------------------------------------------------------------------
// 扁平源
// ---------------------------------------------------------------------------

function renderFlatSegment(
  segment: PlaceholderEntrySegment,
  entries: readonly SourceEntry[],
  host: RenderHost,
): string {
  // 空渲染条目（不放行侧缺省空模板等）整条丢弃，不留下悬空的拼接符
  return entries
    .map((entry) => renderFlatEntry(segment, entry, host))
    .filter((text) => text.trim().length > 0)
    .join(segment.separator ?? "\n");
}

function renderFlatEntry(
  segment: PlaceholderEntrySegment,
  entry: SourceEntry,
  host: RenderHost,
): string {
  // 条目携带过滤结果时按 status 选侧、按 matched 精确匹配分支（与 vars 源同一判定形）；
  // 未携带 = 恒放行侧、matched 空集 → 仅空记号集分支可命中
  const side = entry.filter?.status === "fail" ? "fail" : "pass";
  const matched = entry.filter?.matched ?? [];
  const sideSpec = side === "pass" ? segment.pass : segment.fail;
  const branch = (sideSpec?.branches ?? []).find(
    (b) => b.tokens.length === matched.length && b.tokens.every((t, i) => t === matched[i]),
  );
  const text = branch?.template ?? sideSpec?.template ?? "";
  return text.replace(/\{(_content|_owner)\}/g, (_m, path: string) => {
    if (path === "_owner") return entry.owner ?? "";
    // 不放行侧路径调用给空（与 vars 源同口径）
    if (side === "fail") return "";
    return entry.identity !== undefined ? host.renderIdentity(entry.content, entry.identity) : entry.content;
  });
}

// ---------------------------------------------------------------------------
// 置后融合组（同首位轴的全部 order=post 条目段合并为逐实例组）
// ---------------------------------------------------------------------------

function renderPostGroup(entry: PlaceholderEntry, host: RenderHost): string {
  const posts = entry.segments.filter(
    (s): s is PlaceholderEntrySegment => s.kind === "entry" && s.order === "post",
  );
  const first = posts[0]!;
  const separator = first.separator ?? "\n";
  if (entry.source !== "vars") {
    // 扁平源：首位轴 = 条目轴，逐条目融合
    return host
      .entries(entry.source)
      .map((e) => posts.map((seg) => renderFlatEntry(seg, e, host)).join("\n"))
      .join(separator);
  }
  const view = host.vars();
  const firstAxis = firstAxisOfSegments(posts);
  if (firstAxis === null) {
    // 无轴：各段独立渲染一次，段间 "\n"
    return posts.map((seg) => renderVarsSegment(seg, view)).join("\n");
  }
  // vars 源：枚举首位轴实例，逐实例融合（各段渲染时首位轴预绑定）
  return enumerateAxis(firstAxis, {}, view)
    .map((value) =>
      posts.map((seg) => renderVarsSegment(seg, view, { axisId: firstAxis.id, value })).join("\n"),
    )
    .join(separator);
}

/** 置后段集的首位轴（机检已保证一致；取首个含轴段的首位轴；全部无轴 = null）。 */
function firstAxisOfSegments(segments: readonly PlaceholderEntrySegment[]): ChainAxis | null {
  for (const segment of segments) {
    for (const chain of chainsOfSegment(segment)) {
      const axes = axesOfChain(chain);
      if (axes.length > 0) return axes[0]!;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// vars 源：遍历树归并 + 逐末端 TAG 过滤
// ---------------------------------------------------------------------------

interface VarsRenderCtx {
  segment: PlaceholderEntrySegment;
  view: VarsView;
  separator: string;
  merge: string;
}

/** 收集条目段全部路由链（pass/fail 缺省模板 + 各侧分支模板；按出现序去重）。 */
function chainsOfSegment(segment: PlaceholderEntrySegment): RoutingChain[] {
  const texts = [segment.pass.template, segment.fail?.template ?? ""];
  for (const side of [segment.pass, segment.fail] as const) {
    for (const branch of side?.branches ?? []) texts.push(branch.template);
  }
  const paths = [...new Set(texts.flatMap(extractPathCalls))];
  return paths.map(parseRoutingChain);
}

/** 归并轴序（全部链的 [*] 轴按首次出现序去重——公共前缀共享、差异点产子循环）。 */
function mergedAxes(chains: readonly RoutingChain[]): ChainAxis[] {
  const out: ChainAxis[] = [];
  const seen = new Set<string>();
  for (const chain of chains) {
    for (const axis of axesOfChain(chain)) {
      if (seen.has(axis.id)) continue;
      seen.add(axis.id);
      out.push(axis);
    }
  }
  return out;
}

/**
 * 渲染 vars 条目段：prebound 给出时首位轴已绑定（置后融合组的逐实例渲染），
 * 剩余轴按原次序枚举（组内段的最外层实例仍按 separator 拼接）。
 */
function renderVarsSegment(
  segment: PlaceholderEntrySegment,
  view: VarsView,
  prebound?: { axisId: string; value: string },
): string {
  const chains = chainsOfSegment(segment);
  let axes = mergedAxes(chains);
  const binding: Record<string, string> = {};
  if (prebound !== undefined) {
    binding[prebound.axisId] = prebound.value;
    axes = axes.filter((a) => a.id !== prebound.axisId);
  }
  const separator = segment.separator ?? "\n";
  const ctx: VarsRenderCtx = { segment, view, separator, merge: segment.merge ?? separator };
  return renderLevel(0, axes, binding, ctx);
}

function renderLevel(
  index: number,
  axes: readonly ChainAxis[],
  binding: Record<string, string>,
  ctx: VarsRenderCtx,
): string {
  if (index === axes.length) return renderInstance(binding, ctx);
  const axis = axes[index]!;
  const parts = enumerateAxis(axis, binding, ctx.view).map((value) =>
    renderLevel(index + 1, axes, { ...binding, [axis.id]: value }, ctx),
  );
  return parts.join(index === 0 ? ctx.separator : ctx.merge);
}

/** 链段具体化：把已绑定轴位的 "*" 替换为实例值。 */
function concreteSegs(segs: readonly string[], root: "world" | "characters", binding: Record<string, string>): string[] {
  return segs.map((seg, i) => (seg === "*" ? binding[`${root}:${segs.slice(0, i + 1).join(".")}`]! : seg));
}

/** 实例侧下行（声明侧机检已保证到末端；实例缺失/穿越末端外壳 = undefined）。 */
function walkInstance(view: VarsView, root: "world" | "characters", concrete: readonly string[]): unknown {
  let inst: unknown;
  let rest: readonly string[];
  if (root === "world") {
    inst = view.world;
    rest = concrete.slice(1);
  } else {
    inst = view.characters[concrete[1]!];
    rest = concrete.slice(2);
  }
  for (const seg of rest) {
    if (typeof inst !== "object" || inst === null || isTerminalInstance(inst)) return undefined;
    inst = (inst as Record<string, unknown>)[seg];
  }
  return inst;
}

/** 枚举轴实例值：characters 记录层 = 键集；数组层 = 下标（实例缺失/非数组 = 空枚举）。 */
function enumerateAxis(axis: ChainAxis, binding: Record<string, string>, view: VarsView): string[] {
  if (axis.root === "characters" && axis.prefix.length === 2) {
    return Object.keys(view.characters);
  }
  const parent = concreteSegs(axis.prefix.slice(0, -1), axis.root, binding);
  const inst = walkInstance(view, axis.root, parent);
  if (!Array.isArray(inst)) return [];
  return inst.map((_el, i) => String(i));
}

/** 单条路径的逐末端过滤结果（有声明无实例 = 放行侧空内容）。 */
interface PathResult extends FilterResult {
  /** 放行侧的末端值（stringify 前；无实例 = undefined） */
  terminal: unknown;
}

function resolvePathResult(chain: RoutingChain, binding: Record<string, string>, view: VarsView): PathResult {
  const inst = walkInstance(view, chain.root, concreteSegs(chain.segs, chain.root, binding));
  if (!isTerminalInstance(inst)) {
    return { status: "pass", content: null, matched: [], terminal: undefined };
  }
  const result = evaluateTagFilter(
    { content: chain.tagsSelector ? inst.tags : inst.value, tags: inst.tags },
    view.filter.scope,
    view.filter.registry,
  );
  return { ...result, terminal: result.status === "pass" ? result.content : undefined };
}

/** 末端值 → 注入文本（string 原样；number/boolean String()；string_list/tag_list 顿号连接取 name）。 */
function stringifyTerminal(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "object" && item !== null ? (item as TagMount).name : String(item)))
      .join("、");
  }
  return "";
}

/** 逐实例渲染：pass 判定 → 侧选择 → matched 并集分支精确匹配 → 缺省兜底 → 路径值替换。 */
function renderInstance(binding: Record<string, string>, ctx: VarsRenderCtx): string {
  const { segment, view } = ctx;
  const cache = new Map<string, PathResult>();
  const resolve = (raw: string): PathResult => {
    const hit = cache.get(raw);
    if (hit !== undefined) return hit;
    const result = resolvePathResult(parseRoutingChain(raw), binding, view);
    cache.set(raw, result);
    return result;
  };

  const passPaths = extractPathCalls(segment.pass.template);
  const failPaths = extractPathCalls(segment.fail?.template ?? "");
  const passResults = passPaths.map(resolve);
  const side = passResults.every((r) => r.status === "pass") ? "pass" : "fail";
  // 分支键 = pass+fail 两缺省模板全部路径的 matched 并集（排序去重）
  const matched = [...new Set([...passResults, ...failPaths.map(resolve)].flatMap((r) => r.matched))].sort();

  const sideSpec = side === "pass" ? segment.pass : segment.fail;
  const branch = (sideSpec?.branches ?? []).find(
    (b) => b.tokens.length === matched.length && b.tokens.every((t, i) => t === matched[i]),
  );
  const text = branch?.template ?? sideSpec?.template ?? "";

  let out = text;
  for (const path of extractPathCalls(text)) {
    const result = resolve(path);
    out = out.split(`{${path}}`).join(result.status === "pass" ? stringifyTerminal(result.terminal) : "");
  }
  return out;
}
