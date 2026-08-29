import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parsePlaceholders,
  validatePlaceholders,
  type PlaceholderCatalog,
  type PlaceholderSegment,
} from "../src/compile/placeholders.js";
import { renderPrompt, type RenderHost, type SourceEntry, type VarsView } from "../src/compile/render.js";
import { parseTagRegistry, type TagRegistry } from "../src/tags/registry.js";
import { parseVarsTemplate, type VarsTemplate } from "../src/vars/template.js";
import { buildTagRegistryRaw } from "./builders/index.js";

// ---------------------------------------------------------------------------
// 声明式占位符引擎契约测试（unit：零 IO，模板/实例/注册表全内存构造）：
// 遍历序两选项、置后同轴机检、pass/fail 侧判定、分支精确匹配与缺省兜底、
// 路径到末端机检、最前差异点兼容、空模块丢弃、扁平源 {_content}/{_owner}、懒求值。
// ---------------------------------------------------------------------------

const TEMPLATE: VarsTemplate = parseVarsTemplate({
  world: { children: { omen: "number", region: { children: { name: "string" } } } },
  character: {
    children: {
      attachtags: "string_list",
      tags: { valueType: "string_list", formula: { op: "union", terms: [{ attach: [] as string[] }] } },
      hp: "number",
      note: "string",
      items: { array: { children: { name: "string", secret: "string" } } },
    },
  },
});

const REGISTRY: TagRegistry = parseTagRegistry({
  ...buildTagRegistryRaw(),
  秘密: { name: "秘密", description: "测试秘密 TAG" },
});

/** 测试实例：C1 两件装备（其一 secret 挂「秘密」），C2 一件装备且无 note 实例。 */
const CHARS: Record<string, unknown> = {
  C1: {
    attachtags: { value: ["旧闻"], tags: [] },
    hp: { value: 10, tags: [] },
    note: { value: "甲的笔记", tags: [] },
    items: [
      { name: { value: "剑", tags: [] }, secret: { value: "毒刃", tags: [{ name: "秘密", level: 1 }] } },
      { name: { value: "盾", tags: [] }, secret: { value: "无", tags: [] } },
    ],
  },
  C2: {
    attachtags: { value: [], tags: [] },
    hp: { value: 20, tags: [] },
    items: [{ name: { value: "杖", tags: [] }, secret: { value: "无", tags: [] } }],
  },
};

const WORLD: unknown = {
  omen: { value: 7, tags: [] },
  region: { name: { value: "白潭", tags: [] } },
};

/** vars 测试 host：读者 TAG 集/全知权重可配；扁平 entries 可配。 */
function makeHost(options?: {
  readerTags?: string[];
  weight?: number;
  force?: boolean;
  entries?: SourceEntry[];
  events?: unknown[];
  lores?: unknown[];
  onIdentity?: (text: string) => string;
}): RenderHost {
  const scope: VarsView["filter"]["scope"] = {
    tags: new Set([...(options?.readerTags ?? []), ...(options?.force === true ? ["强制全知"] : [])]),
    omniscienceWeight: options?.weight ?? 0,
    categoryInstances: { cid: new Set(Object.keys(CHARS)) },
  };
  return {
    reader: { kind: "character", cid: "C1" },
    readerLabel: "测试者",
    entries: () => options?.entries ?? [],
    vars: () => ({
      template: TEMPLATE,
      world: WORLD,
      characters: CHARS,
      events: options?.events ?? [],
      lores: options?.lores ?? [],
      filter: { scope, registry: REGISTRY },
    }),
    renderIdentity: (text) => options?.onIdentity?.(text) ?? text,
  };
}

function catalogOf(segments: PlaceholderSegment[], source?: string): PlaceholderCatalog {
  // source 二分类：组装源（封闭枚举）/ 落盘四根（缺省，路径首段即根）
  return parsePlaceholders({ p: { description: "测试", ...(source !== undefined ? { source } : {}), segments } });
}

function entry(pass: string, extra?: Record<string, unknown>): PlaceholderSegment {
  return { kind: "entry", pass: { template: pass }, ...extra } as PlaceholderSegment;
}

/** 渲染单占位符模板（{{p}} 唯一模块；空模块丢弃后无消息 = ""）。 */
function render(catalog: PlaceholderCatalog, host: RenderHost): string {
  const messages = renderPrompt({ id: "t", modules: [{ key: "m", role: "system", content: "{{p}}" }] }, catalog, host);
  return messages[0]?.content ?? "";
}

function check(catalog: PlaceholderCatalog): void {
  validatePlaceholders(catalog, { template: TEMPLATE, registry: REGISTRY });
}

// ---------------------------------------------------------------------------

describe("组装源：{<source>.content}/{<source>.owner} 命名路径、identity 后处理、空模块丢弃、静态段", () => {
  it("逐条目渲染并拼接；owner 命名路径暴露属主；无属主 = 空串", () => {
    const catalog = catalogOf([entry("{cast.owner}：{cast.content}")], "cast");
    const host = makeHost({
      entries: [
        { content: "林雾", owner: "C1" },
        { content: "周砚" },
      ],
    });
    assert.equal(render(catalog, host), "C1：林雾\n：周砚");
  });

  it("identity 条目注入值过身份替换后处理；未标记条目与静态文本不过", () => {
    const replaced: string[] = [];
    const catalog = catalogOf([entry("{cast.content}")], "cast");
    const host = makeHost({
      entries: [
        { content: "@C1 笑了", identity: "cid" },
        { content: "@C1 哭了" },
      ],
      onIdentity: (text) => {
        replaced.push(text);
        return text.replace("@C1", "我");
      },
    });
    assert.equal(render(catalog, host), "我 笑了\n@C1 哭了");
    assert.deepEqual(replaced, ["@C1 笑了"], "仅 identity 条目过后处理");
  });

  it("条目段 identity:false = 关闭身份过滤：组装源 identity 条目直出原文", () => {
    const replaced: string[] = [];
    const catalog = catalogOf([entry("{cast.content}", { identity: false })], "cast");
    const host = makeHost({
      entries: [{ content: "@C1 笑了", identity: "cid" }],
      onIdentity: (text) => {
        replaced.push(text);
        return text.replace("@C1", "我");
      },
    });
    assert.equal(render(catalog, host), "@C1 笑了");
    assert.deepEqual(replaced, [], "identity:false 段不过 renderIdentity");
  });

  it("渲染后 content 为空的模块整条丢弃；静态段原样输出", () => {
    const empty = catalogOf([entry("{contacts.content}")], "contacts");
    assert.equal(render(empty, makeHost()), "", "空条目集 → 空 → 模块丢弃");
    const withStatic = catalogOf([{ kind: "static", text: "固定文案" }], "clock");
    assert.equal(render(withStatic, makeHost()), "固定文案");
  });
});

describe("落盘根：遍历树归并与路径解析", () => {
  it("无轴单实例：world 路径与 characters.CID 字面量", () => {
    assert.equal(render(catalogOf([entry("{world.omen}")]), makeHost()), "7");
    assert.equal(render(catalogOf([entry("{world.region.name}")]), makeHost()), "白潭");
    assert.equal(render(catalogOf([entry("{characters.C2.hp}")]), makeHost()), "20");
  });

  it("前置遍历：条目轴独立滚完再进下一条目；有声明无实例 = 放行空内容", () => {
    assert.equal(render(catalogOf([entry("{characters[*].hp}")]), makeHost()), "10\n20");
    // C2 无 note 实例 → 放行侧空内容（不产生 matched）；空渲染实例在轴拼接处整条丢弃
    assert.equal(render(catalogOf([entry("{characters[*].note}")]), makeHost()), "甲的笔记");
  });

  it("嵌套轴：首位轴 separator、更深轴 merge（缺省 = separator）", () => {
    const catalog = catalogOf([entry("{characters[*].items[*].name}", { separator: "/", merge: "," })]);
    assert.equal(render(catalog, makeHost()), "剑,盾/杖");
    // merge 缺省 = separator
    const fallback = catalogOf([entry("{characters[*].items[*].name}", { separator: ";" })]);
    assert.equal(render(fallback, makeHost()), "剑;盾;杖");
  });

  it("公共前缀共享：同轴多路径一次遍历逐实例取多值", () => {
    const catalog = catalogOf([entry("{characters[*].note}（hp={characters[*].hp}）")]);
    assert.equal(render(catalog, makeHost()), "甲的笔记（hp=10）\n（hp=20）");
  });

  it("值 stringify：string_list/tag_list 顿号连接；.tags 选择子取 tag_list（过滤口径与 value 一致）", () => {
    assert.equal(render(catalogOf([entry("{characters.C1.attachtags}")]), makeHost()), "旧闻");
    // 末端 tags 选择子（items[0].secret 挂 秘密 level 1）：持 TAG 者见列表，不持者不放行给空
    assert.equal(render(catalogOf([entry("{characters.C1.items[0].secret.tags}")]), makeHost({ readerTags: ["秘密"] })), "秘密");
    assert.equal(render(catalogOf([entry("{characters.C1.items[0].secret.tags}")]), makeHost()), "");
    assert.equal(render(catalogOf([entry("{characters.C2.attachtags}")]), makeHost()), "");
  });
});

describe("落盘根：TAG 过滤、pass/fail 侧与分支精确匹配", () => {
  const SECRET = "{characters[*].items[*].secret}";

  it("pass/fail 侧判定：放行框全部路径放行 → 放行侧；任一不放行 → 不放行侧", () => {
    const catalog = catalogOf([
      entry(SECRET, { fail: { template: "（未知装备）" } }),
    ]);
    // 读者不持「秘密」：C1.item0 不放行、C1.item1/C2.item0 放行（无 TAG 恒通过）
    assert.equal(render(catalog, makeHost()), "（未知装备）,无,无".replace(/,/g, "\n"));
    // 读者持「秘密」：全部放行
    assert.equal(render(catalog, makeHost({ readerTags: ["秘密"] })), "毒刃\n无\n无");
    // GM 口径（权重 6 + 强制全知）：虚拟挂载全集可见
    assert.equal(render(catalog, makeHost({ weight: 6, force: true })), "毒刃\n无\n无");
  });

  it("不放行侧路径照常解析：放行的给值、未放行的给空", () => {
    const catalog = catalogOf([
      entry("{characters[*].items[*].secret}", {
        fail: { template: "secret=[{characters[*].items[*].secret}] name={characters[*].items[*].name}" },
      }),
    ]);
    // 侧选择逐实例判定：剑落不放行侧（fail 模板内放行路径照常给值、未放行给空），盾/杖落放行侧
    assert.equal(render(catalog, makeHost()), "secret=[] name=剑\n无\n无");
  });

  it("分支键 = matched 并集精确匹配：命中走分支模板，未命中走该侧缺省", () => {
    const catalog = catalogOf([
      entry(SECRET, {
        pass: {
          template: "{characters[*].items[*].secret}",
          branches: [
            { tokens: ["秘密"], template: "【识破】{characters[*].items[*].secret}" },
            { tokens: ["全知"], template: "【全知】{characters[*].items[*].secret}" },
          ],
        },
        fail: { template: "（未知装备）" },
      }),
    ]);
    // 持「秘密」：matched = [秘密] → 命中分支
    assert.equal(render(catalog, makeHost({ readerTags: ["秘密"] })), "【识破】毒刃\n无\n无");
    // 权重 6：matched = [全知]（虚拟挂载）→ 命中全知分支
    assert.equal(render(catalog, makeHost({ weight: 6, force: true })), "【全知】毒刃\n无\n无");
    // 不持有：该实例落不放行侧缺省
    assert.equal(render(catalog, makeHost()), "（未知装备）\n无\n无");
  });

  it("开放类别命中归一化为类别记号（cid）参与分支键", () => {
    const charsWithCidTag: Record<string, unknown> = {
      C1: { hp: { value: 10, tags: [{ name: "C1", level: 1 }] } },
    };
    const host: RenderHost = {
      reader: { kind: "character", cid: "C1" },
      readerLabel: "测试者",
      entries: () => [],
      vars: () => ({
        template: TEMPLATE,
        world: WORLD,
        characters: charsWithCidTag,
        events: [],
        lores: [],
        filter: {
          scope: { tags: new Set(["C1"]), omniscienceWeight: 0, categoryInstances: { cid: new Set(["C1"]) } },
          registry: REGISTRY,
        },
      }),
      renderIdentity: (text) => text,
    };
    const catalog = catalogOf([
      entry("{characters[*].hp}", {
        pass: {
          template: "缺省{characters[*].hp}",
          branches: [{ tokens: ["cid"], template: "自身{characters[*].hp}" }],
        },
      }),
    ]);
    assert.equal(render(catalog, host), "自身10");
  });
});

describe("遍历序置后（order=post）：同首位轴融合为逐实例组", () => {
  it("两个置后条目同首位轴：逐实例组内段序渲染、组间 separator 拼接", () => {
    const catalog = catalogOf([
      entry("{characters[*].hp}", { order: "post" }),
      entry("{characters[*].note}", { order: "post" }),
    ]);
    check(catalog);
    assert.equal(render(catalog, makeHost()), "10\n甲的笔记\n20\n");
  });

  it("前置与置后混排：前置段独立滚完，融合组输出在首个置后段位置", () => {
    const catalog = catalogOf([
      entry("{characters[*].hp}"),
      { kind: "static", text: "|" },
      entry("{characters[*].note}", { order: "post" }),
    ]);
    check(catalog);
    assert.equal(render(catalog, makeHost()), "10\n20|甲的笔记\n");
  });

  it("扁平源置后：逐条目融合多个置后段", () => {
    const catalog = catalogOf(
      [
        entry("{cast.content}", { order: "post" }),
        entry("（属主 {cast.owner}）", { order: "post" }),
      ],
      "cast",
    );
    check(catalog);
    const host = makeHost({ entries: [{ content: "林雾", owner: "C1" }, { content: "周砚", owner: "C2" }] });
    assert.equal(render(catalog, host), "林雾\n（属主 C1）\n周砚\n（属主 C2）");
  });

  it("机检：同一占位符内置后条目首位轴必须一致", () => {
    const bad = catalogOf([
      entry("{characters[*].hp}", { order: "post" }),
      entry("{world.omen}", { order: "post" }),
    ]);
    assert.throws(() => check(bad), /首位轴必须一致/);
    // 同首位轴（含共享轴下的更深分叉）合法
    check(
      catalogOf([
        entry("{characters[*].hp}", { order: "post" }),
        entry("{characters[*].items[*].name}", { order: "post" }),
      ]),
    );
  });
});

describe("编辑期机检（validatePlaceholders）", () => {
  it("路径必须解析到末端：容器/数组/穿越末端一律拒绝", () => {
    for (const path of ["{world.region}", "{characters[*].items}", "{characters[*].items[*].name.x}", "{characters[*].attachtags[0]}"]) {
      assert.throws(() => check(catalogOf([entry(path)])), new RegExp("末端|穿越"), path);
    }
    // tag_list/string_list 原子即止：末端本身合法
    check(catalogOf([entry("{characters[*].attachtags}")]));
    check(catalogOf([entry("{characters[*].items[*].secret.tags}")]));
  });

  it("最前差异点规则：差异不在 [*] 轴上的路径组合拒绝", () => {
    assert.throws(() => check(catalogOf([entry("{world.omen} 与 {characters[*].hp}")])), /最前差异点/);
    assert.throws(() => check(catalogOf([entry("{characters[*].hp} 与 {world.omen}")])), /最前差异点/);
    // 同轴分叉与字面量/通配混合 = 合法
    check(catalogOf([entry("{characters[*].hp} 与 {characters[*].note}")]));
    check(catalogOf([entry("{characters[*].hp} 与 {characters.C1.note}")]));
  });

  it("组装源只允许 {<source>.content}/{<source>.owner} 命名路径；落盘四根条目至少一条路由链", () => {
    assert.throws(() => check(catalogOf([entry("{world.omen}")], "cast")), /命名路径/);
    assert.throws(() => check(catalogOf([entry("{cast.owner}")], "timers")), /命名路径/); // 命名路径首段必须 = 条目 source
    assert.throws(() => check(catalogOf([entry("{_content}")])), /路由链/); // {_content} 伪路径已弃用
    assert.throws(() => check(catalogOf([entry("纯文本无路径")])), /路由链/);
    // 落盘根非法首段拒绝
    assert.throws(() => check(catalogOf([entry("{vars.hp}")])), /根必须是|路由链/);
  });

  it("branches 记号必须命中注册表条目名（含全知/强制全知/开放类别同名条目）", () => {
    assert.throws(
      () =>
        check(
          catalogOf([
            { kind: "entry", pass: { template: "{characters[*].hp}", branches: [{ tokens: ["不存在"], template: "b" }] } } as PlaceholderSegment,
          ]),
        ),
      /未登记记号/,
    );
    check(
      catalogOf([
        { kind: "entry", pass: { template: "{characters[*].hp}", branches: [{ tokens: ["全知"], template: "b" }] } } as PlaceholderSegment,
      ]),
    );
    check(
      catalogOf([
        { kind: "entry", pass: { template: "{characters[*].hp}", branches: [{ tokens: ["强制全知", "cid"], template: "b" }] } } as PlaceholderSegment,
      ]),
    );
  });

  it("分支记号集规范化后重复的分支键拒装（parsePlaceholders）", () => {
    assert.throws(
      () =>
        parsePlaceholders({
          p: {
            description: "d",
            segments: [
              {
                kind: "entry",
                pass: {
                  template: "{world.omen}",
                  branches: [
                    { tokens: ["aud", "vis"], template: "b1" },
                    { tokens: ["vis", "aud"], template: "b2" },
                  ],
                },
              },
            ],
          },
        }),
      /重复分支键/,
    );
  });
});

// ---------------------------------------------------------------------------
// 落盘四根同构契约（events/lores = 系统固定元素结构；逐末端过滤 + 分支与 vars 同口径）
// ---------------------------------------------------------------------------

/** 外壳简写。 */
const sh = <T extends string | number>(value: T, tags: { name: string; level: number }[] = []): { value: T; tags: { name: string; level: number }[] } => ({ value, tags });

function eventOf(id: string, content: string, tags: { name: string; level: number }[] = []): unknown {
  return { id: sh(id), t: sh(0), seq: sh(1), kind: sh("world"), content: { value: content, tags } };
}

const NL = "\n";

describe("落盘四根同构：events/lores 路由与逐末端过滤", () => {
  const EVENTS = [
    eventOf("evt_1", "@C1 进了灯塔", [{ name: "C1", level: 1 }]),
    eventOf("evt_2", "@C2 的低语", [{ name: "C2", level: 1 }]),
    eventOf("evt_3", "钟声响起"), // 空 tags = 广播恒通过
    eventOf("evt_4", "密谋", [
      { name: "C1", level: 1 },
      { name: "秘密", level: 2 },
    ]), // 跨级 = 与
  ];

  it("{events[*].content} 逐末端 TAG 过滤：命中读者有效 TAG 集即可见；跨级 = 与；广播恒过", () => {
    const catalog = catalogOf([entry("{events[*].content}")]);
    check(catalog);
    assert.equal(render(catalog, makeHost({ readerTags: ["C1"], events: EVENTS })), ["@C1 进了灯塔", "钟声响起"].join(NL));
    assert.equal(
      render(catalog, makeHost({ readerTags: ["C1", "秘密"], events: EVENTS })),
      ["@C1 进了灯塔", "钟声响起", "密谋"].join(NL),
    );
    assert.equal(render(catalog, makeHost({ events: EVENTS })), "钟声响起");
    // 权重 6 = 全量（GM/正文口径）
    assert.equal(
      render(catalog, makeHost({ weight: 6, force: true, events: EVENTS })),
      ["@C1 进了灯塔", "@C2 的低语", "钟声响起", "密谋"].join(NL),
    );
  });

  it("events 根 string 末端过 renderIdentity 身份替换后处理（cid 模式）；其余根不过", () => {
    const replaced: string[] = [];
    const catalog = catalogOf([entry("{events[*].content}")]);
    const host = makeHost({
      events: [eventOf("evt_1", "@C1 笑了")],
      onIdentity: (text) => {
        replaced.push(text);
        return text.replace("@C1", "我");
      },
    });
    assert.equal(render(catalog, host), "我 笑了");
    assert.deepEqual(replaced, ["@C1 笑了"]);
  });

  it("events 根条目段 identity:false = 直出 @CID 原文（不过 renderIdentity）", () => {
    const replaced: string[] = [];
    const catalog = catalogOf([entry("{events[*].content}", { identity: false })]);
    check(catalog);
    const host = makeHost({
      events: [eventOf("evt_1", "@C1 笑了")],
      onIdentity: (text) => {
        replaced.push(text);
        return text.replace("@C1", "我");
      },
    });
    assert.equal(render(catalog, host), "@C1 笑了");
    assert.deepEqual(replaced, []);
  });

  it("{lores[*].id} + {lores[*].content} 同构遍历；content 过滤失败整条落不放行侧", () => {
    const LORES = [
      { id: sh("lore_a"), content: { value: "灯塔旧事", tags: [{ name: "旧闻", level: 1 }] } },
      { id: sh("lore_b"), content: { value: "公开常识", tags: [] } },
    ];
    const catalog = catalogOf([entry("[{lores[*].id}] {lores[*].content}")]);
    check(catalog);
    assert.equal(render(catalog, makeHost({ lores: LORES })), "[lore_b] 公开常识");
    assert.equal(
      render(catalog, makeHost({ readerTags: ["旧闻"], lores: LORES })),
      ["[lore_a] 灯塔旧事", "[lore_b] 公开常识"].join(NL),
    );
  });

  it("events 根分支精确匹配：matched 并集命中分支模板", () => {
    const catalog = catalogOf([
      entry("{events[*].content}", {
        pass: {
          template: "{events[*].content}",
          branches: [{ tokens: ["cid"], template: "【亲历】{events[*].content}" }],
        },
      }),
    ]);
    check(catalog);
    const host = makeHost({ readerTags: ["C1"], events: [eventOf("evt_1", "事", [{ name: "C1", level: 1 }])] });
    assert.equal(render(catalog, host), "【亲历】事");
  });

  it("机检四根路径：非法首段 / 不到末端 / 穿越末端一律拒", () => {
    assert.throws(() => check(catalogOf([entry("{events[*]}")])), /末端/); // 元素 = 容器
    assert.throws(() => check(catalogOf([entry("{events[*].content.x}")])), /穿越|不可解析/);
    assert.throws(() => check(catalogOf([entry("{lores[*].tags}")])), /末端/); // .tags 选择子剥落后停在数组元素（容器）
    assert.throws(() => check(catalogOf([entry("{sys.pipeline}")])), /根必须是|路由链/);
    // {events[*].content.tags} 选择子与 location/t 末端合法
    check(catalogOf([entry("{events[*].content.tags}")]));
    check(catalogOf([entry("{events[*].location} {events[*].t}")]));
  });
});
