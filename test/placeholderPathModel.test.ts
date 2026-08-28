// web 占位符引用寻路与 chip 序列化单测（零 IO 纯逻辑，unit 层）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRefMenu,
  deriveEntrySource,
  expandArray,
  joinPathTokens,
  splitPathCalls,
  type RefMenuArray,
  type RefMenuBranch,
  type RefMenuEndpoint,
  type RefMenuNode,
} from "../web/views/placeholder-path-model.js";

const TEMPLATE = {
  world: {
    children: {
      regions: { array: { children: { name: "string", danger: "number" } } },
      note: "string",
    },
  },
  character: {
    children: {
      attachtags: "string_list",
      tags: { valueType: "string_list", formula: { op: "union_attach", paths: [] } },
      items: { array: { children: { name: "string", count: "number" } } },
      traits: { array: { type: "trait" } },
    },
  },
  types: {
    trait: { children: { label: "string", marks: "tag_list" } },
  },
};

function endpointsOf(nodes: RefMenuNode[]): string[] {
  return nodes.filter((n): n is RefMenuEndpoint => n.kind === "endpoint").map((n) => n.path);
}

test("splitPathCalls/joinPathTokens 往返恒等", () => {
  const cases = [
    "",
    "纯文本无调用",
    "{events[*].content}",
    "前{events[*].content}中{characters.*.name}后",
    "{working_set.content}{working_set.owner}",
    "含空格 { not-a-path } 与双花 {{x}} 原样保留",
    "{world.time.periods[*].key}\n{characters.C1001.items[0].name}",
    "{world.regions[*].marks.tags}",
  ];
  for (const text of cases) {
    assert.deepEqual(joinPathTokens(splitPathCalls(text)), text);
  }
});

test("splitPathCalls 提取路径（去花括号、按出现顺序）", () => {
  const tokens = splitPathCalls("a{events[*].content}b{lores[*].id}c");
  assert.deepEqual(tokens, [
    { type: "text", value: "a" },
    { type: "path", value: "events[*].content" },
    { type: "text", value: "b" },
    { type: "path", value: "lores[*].id" },
    { type: "text", value: "c" },
  ]);
});

const SOURCES = ["working_set", "cast"] as const;

/** 顶层两大类：「路径」= 落盘四根逐级树；「程序」= 组装源 → content/owner。 */
function diskItems(roots: RefMenuNode[]): RefMenuNode[] {
  const disk = roots[0] as RefMenuBranch;
  assert.equal(disk.kind, "branch");
  assert.equal(disk.label, "路径");
  return disk.children;
}

test("buildRefMenu：顶层 = 路径/程序两大类；程序 = 组装源列表 → content/owner 两末端", () => {
  const roots = buildRefMenu(TEMPLATE, SOURCES);
  assert.deepEqual(roots.map((n) => n.label), ["路径", "程序"]);
  const program = roots[1] as RefMenuBranch;
  assert.deepEqual(program.children.map((n) => n.label), ["working_set", "cast"]);
  const ws = program.children[0] as RefMenuBranch;
  assert.deepEqual(endpointsOf(ws.children), ["working_set.content", "working_set.owner"]);
});

test("buildRefMenu：路径类 = 落盘四根，events/lores 镜像结构逐级到末端", () => {
  const roots = diskItems(buildRefMenu(TEMPLATE, SOURCES));
  assert.equal(roots.length, 4);
  const events = roots[0] as RefMenuArray;
  assert.equal(events.kind, "array");
  assert.equal(events.axis, "index");
  const eventChildren = expandArray(events, "*");
  assert.deepEqual(endpointsOf(eventChildren), [
    "events[*].id",
    "events[*].t",
    "events[*].seq",
    "events[*].kind",
    "events[*].location",
    "events[*].content",
  ]);
  const lores = roots[1] as RefMenuArray;
  assert.deepEqual(endpointsOf(expandArray(lores, "*")), [
    "lores[*].id",
    "lores[*].content",
    "lores[*].enabled",
  ]);
});

test("expandArray：数字下标与 characters 根 cid 轴", () => {
  const roots = diskItems(buildRefMenu(TEMPLATE, SOURCES));
  const events = roots[0] as RefMenuArray;
  assert.deepEqual(endpointsOf(expandArray(events, "3")).at(-1), "events[3].content");

  const chars = roots[2] as RefMenuArray;
  assert.equal(chars.join, "dot");
  assert.equal(chars.axis, "cid");
  const star = expandArray(chars, "*");
  // 系统声明分支并入（cid/name 等）+ 作者子树（items/traits/attachtags/tags）
  assert.ok(endpointsOf(star).includes("characters.*.cid"));
  assert.ok(endpointsOf(star).includes("characters.*.name"));
  const cid = expandArray(chars, "C1001");
  assert.ok(endpointsOf(cid).includes("characters.C1001.name"));
  const items = star.find((n) => n.kind === "array" && n.prefix === "characters.*.items") as RefMenuArray;
  assert.deepEqual(endpointsOf(expandArray(items, "*")), [
    "characters.*.items[*].name",
    "characters.*.items[*].count",
  ]);
});

test("tag_list 末端出 值/.tags 两末端项；类型引用内联；world 系统分支并入", () => {
  const roots = diskItems(buildRefMenu(TEMPLATE, SOURCES));
  const chars = roots[2] as RefMenuArray;
  const star = expandArray(chars, "*");
  const traits = star.find((n) => n.kind === "array" && n.prefix === "characters.*.traits") as RefMenuArray;
  // {type:"trait"} 内联：label 末端 + marks tag_list 双末端
  assert.deepEqual(endpointsOf(expandArray(traits, "*")), [
    "characters.*.traits[*].label",
    "characters.*.traits[*].marks",
    "characters.*.traits[*].marks.tags",
  ]);

  const world = roots[3] as RefMenuBranch;
  assert.equal(world.kind, "branch");
  const time = world.children.find((n) => n.kind === "branch" && n.label === "time") as RefMenuBranch;
  assert.ok(endpointsOf(time.children).includes("world.time.y"));
  const regions = world.children.find((n) => n.kind === "array") as RefMenuArray;
  assert.deepEqual(endpointsOf(expandArray(regions, "*")), [
    "world.regions[*].name",
    "world.regions[*].danger",
  ]);
});

test("varsTemplate 缺失降级：events/lores 与系统分支仍可展开", () => {
  const roots = diskItems(buildRefMenu(null, SOURCES));
  const chars = roots[2] as RefMenuArray;
  assert.ok(endpointsOf(expandArray(chars, "*")).includes("characters.*.name"));
  const world = roots[3] as RefMenuBranch;
  const time = world.children.find((n) => n.kind === "branch" && n.label === "time") as RefMenuBranch;
  assert.ok(endpointsOf(time.children).includes("world.time.min"));
});

test("类型引用成环护断：循环类型展开为空", () => {
  const cyclic = {
    world: { children: {} },
    character: {
      children: {
        attachtags: "string_list",
        tags: { valueType: "string_list", formula: { op: "union_attach", paths: [] } },
        links: { array: { type: "node" } },
      },
    },
    types: { node: { children: { next: { array: { type: "node" } }, label: "string" } } },
  };
  const roots = diskItems(buildRefMenu(cyclic, SOURCES));
  const chars = roots[2] as RefMenuArray;
  const star = expandArray(chars, "*");
  const links = star.find((n) => n.kind === "array" && n.prefix === "characters.*.links") as RefMenuArray;
  const level1 = expandArray(links, "*");
  assert.ok(endpointsOf(level1).includes("characters.*.links[*].label"));
  const next = level1.find((n) => n.kind === "array") as RefMenuArray;
  assert.deepEqual(expandArray(next, "*"), []); // 循环类型不再展开
});

// ---------------------------------------------------------------------------
// deriveEntrySource（保存时 source 推导）
// ---------------------------------------------------------------------------

const entrySeg = (pass: string, extra?: Record<string, unknown>): Record<string, unknown> => ({
  kind: "entry",
  pass: { template: pass },
  ...extra,
});

test("deriveEntrySource：纯落盘根路径/纯静态/无路径 = undefined（source 省略）", () => {
  assert.equal(deriveEntrySource([entrySeg("{events[*].content}")], SOURCES), undefined);
  assert.equal(deriveEntrySource([entrySeg("{characters[*].cid} 与 {world.time.y}")], SOURCES), undefined);
  assert.equal(deriveEntrySource([{ kind: "static", text: "纯文本" }], SOURCES), undefined);
  assert.equal(deriveEntrySource([entrySeg("无路径文本")], SOURCES), undefined);
  // 无法归类的路径（首段既非组装源也非落盘四根）不在此判非法，留给服务端机检
  assert.equal(deriveEntrySource([entrySeg("{foo.bar}")], SOURCES), undefined);
});

test("deriveEntrySource：组装类路径全同一 source（含分支模板扫描）→ 推得该 source", () => {
  assert.equal(deriveEntrySource([entrySeg("{working_set.content}")], SOURCES), "working_set");
  const seg = entrySeg("{cast.content}", {
    fail: { template: "", branches: [{ tokens: ["x"], template: "{cast.owner}" }] },
  });
  assert.equal(deriveEntrySource([seg], SOURCES), "cast");
});

test("deriveEntrySource：混多个组装源 / 组装源混落盘根 = 抛错不提交", () => {
  assert.throws(
    () => deriveEntrySource([entrySeg("{cast.content}"), entrySeg("{working_set.content}")], SOURCES),
    /混用多个组装源/,
  );
  assert.throws(() => deriveEntrySource([entrySeg("{cast.content}{events[*].content}")], SOURCES), /混用组装源/);
});
