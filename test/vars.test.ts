import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseVarsTags,
  parseVarsTemplate,
  resolveAttachTags,
  splitVarPath,
  type TerminalDecl,
  type VarsTemplate,
} from "../src/vars/template.js";
import {
  normalizeInstance,
  readTerminal,
  resolvePath,
  validateTagListWrite,
  validateTagNamesWrite,
  validateSystemTags,
  type InstanceNode,
  type TagMount,
} from "../src/vars/tree.js";
import { buildDerivedPlan, buildRootDerivedPlan, evalDerived, evalDerivedTarget, unionTerms } from "../src/vars/derived.js";

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

/** 合法模板原料：简写/完整形/结构化数组各一，character 根保留名齐。 */
const TEMPLATE_RAW = {
  world: {
    children: {
      location: "string",
      base: "number",
      danger: { valueType: "number", formula: { expr: "base * 2", binds: { base: "base" } } },
    },
  },
  character: {
    children: {
      attachtags: "string_list",
      tags: { valueType: "string_list", formula: { op: "union", terms: [{ attach: ["inventory"] }] } },
      hp: "number",
      inventory: {
        children: {
          weapon: { array: { type: "item" } },
          gold: "number",
        },
      },
    },
  },
  types: {
    item: {
      children: {
        name: "string",
        attachtags: "string_list",
      },
    },
  },
};

const TPL: VarsTemplate = parseVarsTemplate(TEMPLATE_RAW);

/** 合法 character 根（保留名齐；inv 容器供 union attach 项指）。 */
const VALID_CHARACTER = {
  children: {
    attachtags: "string_list",
    tags: { valueType: "string_list", formula: { op: "union", terms: [{ attach: ["inv"] }] } },
    inv: { children: { x: "number" } },
  },
};

function rawTemplate(overrides: { world?: unknown; character?: unknown; types?: unknown }): unknown {
  return {
    world: overrides.world ?? { children: { location: "string" } },
    character: overrides.character ?? VALID_CHARACTER,
    ...(overrides.types !== undefined ? { types: overrides.types } : {}),
  };
}

function terminal(path: string, root: "world" | "character" = "world"): TerminalDecl {
  const decl = TPL.resolve(root, path);
  assert.equal(decl.kind, "terminal");
  return decl as TerminalDecl;
}

// ---------------------------------------------------------------------------
// 路径标记化
// ---------------------------------------------------------------------------

describe("splitVarPath", () => {
  it("`键[数字]` / `键[*]` 拆为键 + 下标两段", () => {
    assert.deepEqual(splitVarPath("characters.C1001.items[0].name"), ["characters", "C1001", "items", "0", "name"]);
    assert.deepEqual(splitVarPath("items[*].name"), ["items", "*", "name"]);
    assert.deepEqual(splitVarPath("plain.key"), ["plain", "key"]);
  });

  it("裸括号/空键/非法下标 = 抛错", () => {
    assert.throws(() => splitVarPath("items[x]"), /非法段/);
    assert.throws(() => splitVarPath("items[0"), /非法段/);
    assert.throws(() => splitVarPath("[0].name"), /非法段/);
  });
});

// ---------------------------------------------------------------------------
// 模板解析
// ---------------------------------------------------------------------------

describe("parseVarsTemplate", () => {
  it("接受简写/完整形/结构化数组", () => {
    assert.deepEqual(terminal("location").valueType, "string");
    assert.equal(terminal("danger").formula?.kind, "expr");
    // 数组层穿越：精确下标与 [*] 通配均可
    assert.equal(terminal("inventory.weapon[0].name", "character").valueType, "string");
    assert.equal(terminal("inventory.weapon[*].attachtags", "character").valueType, "string_list");
    assert.equal(TPL.types["item"]?.kind, "container");
    // 数组节点本体可解析（kind = array）
    assert.equal(TPL.resolve("character", "inventory.weapon").kind, "array");
  });

  it("数组层缺下标 = 抛错", () => {
    assert.throws(() => TPL.resolve("character", "inventory.weapon.name"), /需要 \[数字\] 或 \[\*\] 下标/);
  });

  it("world/character 根必须是容器", () => {
    assert.throws(() => parseVarsTemplate(rawTemplate({ world: "number" })), /world 根必须是容器/);
  });

  it("类型引用成环 = 拒绝（含自引用直接与间接递归）", () => {
    const cyc = {
      A: { children: { b: { array: { type: "B" } } } },
      B: { children: { a: { array: { type: "A" } } } },
    };
    assert.throws(() => parseVarsTemplate(rawTemplate({ types: cyc })), /类型引用成环/);
    const self = { L: { children: { next: { array: { type: "L" } } } } };
    assert.throws(() => parseVarsTemplate(rawTemplate({ types: self })), /类型引用成环/);
  });

  it("引用未声明类型 = 拒绝", () => {
    assert.throws(
      () => parseVarsTemplate(rawTemplate({ types: { A: { children: { g: { array: { type: "ghost" } } } } } })),
      /未声明的类型 "ghost"/,
    );
  });

  it("types 只能是 {children} 结构别名（数组/末端形态 = 拒装）", () => {
    assert.throws(
      () => parseVarsTemplate(rawTemplate({ types: { bad: { array: { children: { x: "number" } } } } })),
      /类型 "bad" 必须是 \{children\} 结构别名/,
    );
    assert.throws(
      () => parseVarsTemplate(rawTemplate({ types: { bad: "number" } })),
      /类型 "bad" 必须是 \{children\} 结构别名/,
    );
  });

  it("数组套数组 = 拒装（元素根不得又是数组）", () => {
    assert.throws(
      () =>
        parseVarsTemplate(
          rawTemplate({ world: { children: { bad: { array: { array: { children: {} } } } } } }),
        ),
    );
  });

  it("旧 {type} 容器形态 = 拒装", () => {
    assert.throws(() =>
      parseVarsTemplate(rawTemplate({ world: { children: { bag: { type: "item" } } }, types: { item: { children: {} } } })),
    );
  });

  it("容器子键保留名/下标括号 = 拒绝", () => {
    for (const key of ["value", "tags", "formula"]) {
      assert.throws(
        () => parseVarsTemplate(rawTemplate({ world: { children: { [key]: "number" } } })),
        /保留名/,
      );
    }
    assert.throws(
      () => parseVarsTemplate(rawTemplate({ world: { children: { "a[0]": "number" } } })),
      /不得含/,
    );
    assert.throws(
      () => parseVarsTemplate(rawTemplate({ world: { children: { "a.b": "number" } } })),
      /不得含/,
    );
  });

  it("binds 闭包校验：未声明标识符/路径不可解析/非 number 末端", () => {
    assert.throws(
      () =>
        parseVarsTemplate(
          rawTemplate({ world: { children: { a: { valueType: "number", formula: { expr: "x + 1" } } } } }),
        ),
      /未声明的标识符 "x"/,
    );
    assert.throws(
      () =>
        parseVarsTemplate(
          rawTemplate({
            world: {
              children: { a: { valueType: "number", formula: { expr: "x + 1", binds: { x: "nope" } } } },
            },
          }),
        ),
      /不可解析/,
    );
    assert.throws(
      () =>
        parseVarsTemplate(
          rawTemplate({
            world: {
              children: {
                s: "string",
                a: { valueType: "number", formula: { expr: "x + 1", binds: { x: "s" } } },
              },
            },
          }),
        ),
      /number 末端/,
    );
  });

  it("union attach 路径解析到末端 = 拒绝；指向数组 = 合法", () => {
    assert.throws(
      () =>
        parseVarsTemplate(
          rawTemplate({
            character: {
              children: {
                attachtags: "string_list",
                hp: "number",
                tags: { valueType: "string_list", formula: { op: "union", terms: [{ attach: ["hp"] }] } },
              },
            },
          }),
        ),
      /必须解析到容器\/数组声明/,
    );
    // 数组是合法 union attach 子树
    const tpl = parseVarsTemplate({
      world: { children: {} },
      character: {
        children: {
          attachtags: "string_list",
          bag: { array: { children: { attachtags: "string_list" } } },
          tags: { valueType: "string_list", formula: { op: "union", terms: [{ attach: ["bag"] }] } },
        },
      },
    });
    assert.equal(tpl.character.children["bag"]?.kind, "array");
  });

  it("union sys 项：world 根拒装；terms 内重复 sys 拒装；空 terms 拒装", () => {
    assert.throws(
      () =>
        parseVarsTemplate(
          rawTemplate({
            world: {
              children: {
                pool: { valueType: "string_list", formula: { op: "union", terms: [{ sys: "cid" }] } },
              },
            },
          }),
        ),
      /只允许出现在 character 根/,
    );
    assert.throws(
      () =>
        parseVarsTemplate(
          rawTemplate({
            character: {
              children: {
                attachtags: "string_list",
                tags: {
                  valueType: "string_list",
                  formula: { op: "union", terms: [{ sys: "cid" }, { sys: "location" }, { sys: "cid" }] },
                },
              },
            },
          }),
        ),
      /重复/,
    );
    assert.throws(
      () =>
        parseVarsTemplate(
          rawTemplate({
            character: {
              children: {
                attachtags: "string_list",
                tags: { valueType: "string_list", formula: { op: "union", terms: [] } },
              },
            },
          }),
        ),
    );
  });

  it("union 挂在非 string_list 末端 = 拒绝", () => {
    assert.throws(
      () =>
        parseVarsTemplate(
          rawTemplate({
            character: {
              children: {
                attachtags: "string_list",
                hp: { valueType: "number", formula: { op: "union", terms: [{ attach: [] }] } },
                tags: { valueType: "string_list", formula: { op: "union", terms: [{ attach: [] }] } },
              },
            },
          }),
        ),
      /只能挂在 string_list 末端/,
    );
  });

  it("expr 挂在非 number 末端 = 拒绝", () => {
    assert.throws(
      () =>
        parseVarsTemplate(
          rawTemplate({
            world: { children: { s: { valueType: "string", formula: { expr: "1" } } } },
          }),
        ),
      /只能挂在 number 末端/,
    );
  });

  it("character 根保留名缺/错 = 拒绝", () => {
    assert.throws(
      () => parseVarsTemplate(rawTemplate({ character: { children: { hp: "number" } } })),
      /attachtags/,
    );
    assert.throws(
      () =>
        parseVarsTemplate(
          rawTemplate({
            character: {
              children: {
                attachtags: { valueType: "string_list", formula: { op: "union", terms: [{ attach: ["inv"] }] } },
                tags: { valueType: "string_list", formula: { op: "union", terms: [{ attach: ["inv"] }] } },
                inv: { children: { x: "number" } },
              },
            },
          }),
        ),
      /attachtags 为无 formula 的 string_list 末端/,
    );
    assert.throws(
      () =>
        parseVarsTemplate(
          rawTemplate({ character: { children: { attachtags: "string_list", tags: "string_list" } } }),
        ),
      /tags 为 union 公式的 string_list 末端/,
    );
  });
});

// ---------------------------------------------------------------------------
// TAG 附加文件
// ---------------------------------------------------------------------------

describe("parseVarsTags / resolveAttachTags", () => {
  it("同构校验：路径不存在/末端带 children/数组元素结构不符/数组缺 array 键 = 拒绝", () => {
    assert.throws(() => parseVarsTags({ children: { ghost: {} } }, TPL.world), /不存在/);
    assert.throws(
      () => parseVarsTags({ children: { location: { children: { x: {} } } } }, TPL.world),
      /在模板中为末端/,
    );
    assert.throws(
      () =>
        parseVarsTags(
          { children: { inventory: { children: { weapon: { array: "other" } } } } },
          TPL.character,
        ),
      /array "other" 与模板元素结构 "item" 不符/,
    );
    assert.throws(
      () =>
        parseVarsTags({ children: { inventory: { children: { weapon: { tags: [{ name: "x", level: 1 }] } } } } }, TPL.character),
      /整型挂载须带 array 键/,
    );
  });

  it("节点级条目扇出到全部后代末端；末端级只挂本末端", () => {
    const tags = parseVarsTags(
      {
        tags: [{ name: "暗", level: 2 }],
        children: { base: { tags: [{ name: "险", level: 3 }] } },
      },
      TPL.world,
    );
    const resolved = resolveAttachTags(tags, TPL.world, { categories: new Set() });
    // 节点级：全部末端都有 暗
    for (const p of ["location", "base", "danger"]) {
      assert.deepEqual(
        resolved.get(p)?.find((m) => m.name === "暗"),
        { name: "暗", level: 2 },
      );
    }
    // 末端级：险 只挂 base
    assert.deepEqual(resolved.get("base"), [
      { name: "暗", level: 2 },
      { name: "险", level: 3 },
    ]);
    assert.equal(resolved.get("location")?.some((m) => m.name === "险"), false);
  });

  it("数组整型挂载扇出到元素结构全部末端（路径该层以 [*] 占位，元素自身无挂载位）", () => {
    const tags = parseVarsTags(
      { children: { inventory: { children: { weapon: { tags: [{ name: "利", level: 4 }], array: "item" } } } } },
      TPL.character,
    );
    const resolved = resolveAttachTags(tags, TPL.character, { categories: new Set() });
    assert.deepEqual(resolved.get("inventory.weapon[*].name"), [{ name: "利", level: 4 }]);
    assert.deepEqual(resolved.get("inventory.weapon[*].attachtags"), [{ name: "利", level: 4 }]);
    // 数组节点与元素对象自身没有挂载位
    assert.equal(resolved.get("inventory.weapon"), undefined);
    assert.equal(resolved.get("inventory.weapon[*]"), undefined);
  });

  it("cid 类按属主分发；world 根遇 cid = 报错；未知类别 = 拒绝", () => {
    const charTags = parseVarsTags({ tags: [{ category: "cid", level: 1 }] }, TPL.character);
    const resolved = resolveAttachTags(charTags, TPL.character, {
      categories: new Set(["cid"]),
      ownerCid: "c1",
    });
    assert.deepEqual(resolved.get("hp"), [{ name: "c1", level: 1 }]);
    // 无 ownerCid = 报错
    assert.throws(
      () => resolveAttachTags(charTags, TPL.character, { categories: new Set(["cid"]) }),
      /属主 cid/,
    );
    // world 根：调用方不传 ownerCid，遇 cid 条目报错
    const worldTags = parseVarsTags({ tags: [{ category: "cid", level: 1 }] }, TPL.world);
    assert.throws(
      () => resolveAttachTags(worldTags, TPL.world, { categories: new Set(["cid"]) }),
      /属主 cid/,
    );
    // 未知类别
    const bad = parseVarsTags({ tags: [{ category: "nope", level: 1 }] }, TPL.world);
    assert.throws(
      () => resolveAttachTags(bad, TPL.world, { categories: new Set(["cid"]) }),
      /未知 TAG 类别 "nope"/,
    );
  });
});

// ---------------------------------------------------------------------------
// 实例树
// ---------------------------------------------------------------------------

describe("normalizeInstance", () => {
  it("原始值/扁平数组简写展开为外壳", () => {
    const inst = normalizeInstance({ hp: 5, attachtags: ["a"] }, TPL.characterVars, "character");
    assert.deepEqual(inst, {
      hp: { value: 5, tags: [] },
      attachtags: { value: ["a"], tags: [] },
    });
  });

  it("外壳形合法；非法键/缺 value = 拒绝", () => {
    const inst = normalizeInstance({ hp: { value: 3, tags: [{ name: "重伤", level: 2 }] } }, TPL.characterVars, "c");
    assert.deepEqual(inst, { hp: { value: 3, tags: [{ name: "重伤", level: 2 }] } });
    assert.throws(() => normalizeInstance({ hp: { value: 3, foo: 1 } }, TPL.characterVars, "c"), /非法键 "foo"/);
    assert.throws(() => normalizeInstance({ hp: { tags: [] } }, TPL.characterVars, "c"), /缺 value/);
  });

  it("无声明有实例 = 拒绝（消息带路径）；有声明无实例 = 合法", () => {
    assert.throws(
      () => normalizeInstance({ ghost: 1 }, TPL.characterVars, "character"),
      /未声明的键（路径 "character.ghost"）/,
    );
    assert.deepEqual(normalizeInstance({}, TPL.characterVars, "character"), {});
  });

  it("值类型错配 = 拒绝", () => {
    assert.throws(() => normalizeInstance({ hp: "x" }, TPL.characterVars, "c"), /类型错配/);
    assert.throws(() => normalizeInstance({ hp: Number.NaN }, TPL.characterVars, "c"), /类型错配/);
  });

  it("外壳 tags（内容侧挂载）level 越界 = 拒绝", () => {
    assert.throws(
      () => normalizeInstance({ hp: { value: 1, tags: [{ name: "a", level: 0 }] } }, TPL.characterVars, "c"),
      /形状非法/,
    );
    assert.throws(
      () => normalizeInstance({ hp: { value: 1, tags: [{ name: "a", level: 8 }] } }, TPL.characterVars, "c"),
      /形状非法/,
    );
  });

  it("结构化数组逐元素按元素结构展开；实例必须是数组", () => {
    const inst = normalizeInstance(
      { inventory: { weapon: [{ name: "铁剑", attachtags: [] }] } },
      TPL.character,
      "c",
    );
    assert.deepEqual(inst, {
      inventory: {
        weapon: [
          {
            name: { value: "铁剑", tags: [] },
            attachtags: { value: [], tags: [] },
          },
        ],
      },
    });
    assert.throws(
      () => normalizeInstance({ inventory: { weapon: { 铁剑: { name: "x" } } } }, TPL.character, "c"),
      /必须是数组/,
    );
  });

  it("数组元素结构校验：错型/未声明键/元素自身挂 tags = 拒绝", () => {
    assert.throws(
      () => normalizeInstance({ inventory: { weapon: [{ name: 1 }] } }, TPL.character, "c"),
      /类型错配（路径 "c.inventory.weapon\[0\].name"/,
    );
    assert.throws(
      () => normalizeInstance({ inventory: { weapon: [{ ghost: 1 }] } }, TPL.character, "c"),
      /未声明的键（路径 "c.inventory.weapon\[0\].ghost"）/,
    );
    // 元素对象自身没有 tags 挂载位：stray tags 键 = 未声明
    assert.throws(
      () => normalizeInstance({ inventory: { weapon: [{ name: "x", tags: [] }] } }, TPL.character, "c"),
      /未声明的键（路径 "c.inventory.weapon\[0\].tags"）/,
    );
  });

  it("实例外壳 formula 与模板侧同规则校验", () => {
    assert.throws(
      () => normalizeInstance({ hp: { value: 1, formula: { expr: "z + 1" } } }, TPL.characterVars, "c"),
      /未声明的标识符 "z"/,
    );
  });
});

describe("resolvePath / readTerminal", () => {
  const WORLD_INST = normalizeInstance({ location: "白滩", base: 3 }, TPL.world, "world");
  const CHAR_INST = normalizeInstance(
    {
      attachtags: { value: ["自身"], tags: [{ name: "挂载", level: 2 }] },
      inventory: { weapon: [{ name: "铁剑", attachtags: [] }] },
    },
    TPL.character,
    "character",
  );

  it("resolvePath 解析声明；不存在/穿越末端 = 抛错", () => {
    assert.equal(resolvePath(TPL.world, "location").kind, "terminal");
    assert.throws(() => resolvePath(TPL.world, "nope"), /不可解析/);
    assert.throws(() => resolvePath(TPL.world, "location.x"), /穿越末端/);
  });

  it("裸路径取 value；.tags 后缀与显式选择子取外壳 tags 字段", () => {
    assert.equal(readTerminal(WORLD_INST, TPL.world, "location"), "白滩");
    assert.deepEqual(readTerminal(WORLD_INST, TPL.world, "location.tags"), []);
    // string_list 末端：裸路径取 value（纯名集合本体），选择子取外壳 tags 字段
    assert.deepEqual(readTerminal(CHAR_INST, TPL.character, "attachtags"), ["自身"]);
    assert.deepEqual(readTerminal(CHAR_INST, TPL.character, "attachtags.tags"), [{ name: "挂载", level: 2 }]);
    assert.deepEqual(readTerminal(CHAR_INST, TPL.character, "attachtags", "tags"), [
      { name: "挂载", level: 2 },
    ]);
  });

  it("[数字] 精确下标读取数组元素末端", () => {
    assert.equal(readTerminal(CHAR_INST, TPL.character, "inventory.weapon[0].name"), "铁剑");
    // 点分数字下标同效（内部归一形态）
    assert.equal(readTerminal(CHAR_INST, TPL.character, "inventory.weapon.0.name"), "铁剑");
    // 下标越界 = 有声明无实例
    assert.equal(readTerminal(CHAR_INST, TPL.character, "inventory.weapon[5].name"), undefined);
  });

  it("穿越末端 = 抛错；解析到容器/数组 = 抛错", () => {
    assert.throws(() => readTerminal(WORLD_INST, TPL.world, "location.x"), /穿越末端/);
    assert.throws(() => readTerminal(CHAR_INST, TPL.character, "inventory"), /必须解析到末端/);
    assert.throws(() => readTerminal(CHAR_INST, TPL.character, "inventory.weapon"), /必须解析到末端/);
    assert.throws(() => readTerminal(CHAR_INST, TPL.character, "inventory.weapon[0]"), /必须解析到末端/);
  });

  it("有声明无实例 = 返回 undefined", () => {
    assert.equal(readTerminal(WORLD_INST, TPL.world, "danger"), undefined);
    assert.equal(readTerminal(normalizeInstance({}, TPL.world, "w"), TPL.world, "base"), undefined);
  });
});

describe("validateTagListWrite", () => {
  it("形状非法 = 拒绝", () => {
    assert.throws(() => validateTagListWrite([{ name: "a", level: 9 }]), /形状非法/);
    assert.throws(() => validateTagListWrite("x"), /形状非法/);
  });

  it("提供注册名集合时逐条命中校验", () => {
    const value: TagMount[] = [{ name: "a", level: 1 }];
    assert.deepEqual(validateTagListWrite(value, { registeredNames: new Set(["a"]) }), value);
    assert.throws(() => validateTagListWrite(value, { registeredNames: new Set(["b"]) }), /未注册 TAG 名 "a"/);
  });
});

// ---------------------------------------------------------------------------
// TAG 写值名称校验类别化（三函数同口径：注册名 ∪ 开放类别）
// ---------------------------------------------------------------------------

describe("TAG 写值校验类别化", () => {
  /** 三类别全声明（cid 实例集 = {C1001}）+ 注册名 a。 */
  const scope = {
    registeredNames: new Set(["a"]),
    categories: { cid: new Set(["C1001"]), channel: new Set<string>(), location: new Set<string>() },
  };
  /** 只声明 cid 类别（channel/location 未声明 → 任意名不放行，未知 CID 可拒）。 */
  const cidOnly = { registeredNames: new Set(["a"]), categories: { cid: new Set(["C1001"]) } };

  it("cid 类别已声明：现存角色 CID 实例名放行；未知 CID（CID 形态名）拒绝", () => {
    const mounts: TagMount[] = [{ name: "C1001", level: 2 }];
    assert.deepEqual(validateTagListWrite(mounts, scope), mounts);
    assert.deepEqual(validateTagNamesWrite(["C1001"], scope), ["C1001"]);
    // CID 形态名按 cid 类别判定：未知 CID = 手误，channel/location 放行不兜底
    assert.throws(() => validateTagListWrite([{ name: "C9999", level: 1 }], scope), /未注册 TAG 名 "C9999"/);
    assert.throws(() => validateTagNamesWrite(["C9999"], scope), /未注册 TAG 名 "C9999"/);
  });

  it("channel/location 类别已声明即放行（实例集运行期派生，不做写时校验）", () => {
    assert.deepEqual(validateTagNamesWrite(["任意频道", "任意地点"], scope), ["任意频道", "任意地点"]);
    assert.deepEqual(validateTagListWrite([{ name: "任意频道", level: 1 }], scope), [{ name: "任意频道", level: 1 }]);
  });

  it("类别未声明 = 实例名不放行（仅注册名合法）", () => {
    const noCats = { registeredNames: new Set(["a"]), categories: {} };
    assert.throws(() => validateTagNamesWrite(["C1001"], noCats), /未注册 TAG 名/);
    assert.throws(() => validateTagNamesWrite(["任意频道"], cidOnly), /未注册 TAG 名/);
  });

  it("validateSystemTags 侧车同口径：cid 实例名放行、未知 CID 拒绝", () => {
    const ok = { name: [{ name: "C1001", level: 1 }] };
    assert.deepEqual(validateSystemTags(ok, TPL.character, scope), ok);
    assert.throws(
      () => validateSystemTags({ name: [{ name: "C9999", level: 1 }] }, TPL.character, scope),
      /未注册 TAG 名 "C9999"/,
    );
  });
});

// ---------------------------------------------------------------------------
// 从动变量
// ---------------------------------------------------------------------------

/** 含 attachtags 子树的角色实例：自身 attachtags 与子树有同名条目（去重优先级用）。 */
const DERIVED_CHAR_INST: InstanceNode = normalizeInstance(
  {
    attachtags: ["自身", "共"],
    inventory: {
      weapon: [
        {
          name: "铁剑",
          attachtags: ["共", "剑"],
        },
      ],
    },
  },
  TPL.characterVars,
  "character",
);

describe("unionTerms", () => {
  it("attach 项：自身 attachtags ∪ 子树 attachtags（含数组元素递归），按名去重（先取者胜）", () => {
    const out = unionTerms(DERIVED_CHAR_INST, TPL.character, [{ kind: "attach", paths: ["inventory"] }]);
    assert.deepEqual(out, ["自身", "共", "剑"]);
  });

  it("attach 子树路径解析到末端 = 抛错；实例子树缺失按空集", () => {
    assert.throws(
      () => unionTerms(DERIVED_CHAR_INST, TPL.character, [{ kind: "attach", paths: ["hp"] }]),
      /容器\/数组声明/,
    );
    assert.deepEqual(
      unionTerms(normalizeInstance({}, TPL.characterVars, "c"), TPL.character, [{ kind: "attach", paths: ["inventory"] }]),
      [],
    );
  });

  it("sys 项：cid/location/channel 读属主系统字段（channel null = 空集）", () => {
    const terms = [{ kind: "attach", paths: [] }, { kind: "sys", sys: "cid" }, { kind: "sys", sys: "location" }, { kind: "sys", sys: "channel" }] as const;
    assert.deepEqual(
      unionTerms(DERIVED_CHAR_INST, TPL.character, terms, { cid: "C7", locationName: "白滩", channel: 3 }),
      ["自身", "共", "C7", "白滩", "3"],
    );
    assert.deepEqual(
      unionTerms(DERIVED_CHAR_INST, TPL.character, terms, { cid: "C7", locationName: "白滩", channel: null }),
      ["自身", "共", "C7", "白滩"],
    );
  });

  it("terms 按序并集、先取者胜（sys 在前压过 attach 同名）", () => {
    const out = unionTerms(
      DERIVED_CHAR_INST,
      TPL.character,
      [{ kind: "sys", sys: "location" }, { kind: "attach", paths: [] }],
      { cid: "C7", locationName: "自身", channel: null },
    );
    assert.deepEqual(out, ["自身", "共"]);
  });

  it("sys 项缺 sysValues = 抛错", () => {
    assert.throws(
      () => unionTerms(DERIVED_CHAR_INST, TPL.character, [{ kind: "sys", sys: "cid" }]),
      /sysValues/,
    );
  });
});

describe("buildDerivedPlan", () => {
  it("拓扑排序：被依赖从动末端在前", () => {
    const tpl = parseVarsTemplate(
      rawTemplate({
        world: {
          children: {
            a: { valueType: "number", formula: { expr: "1" } },
            b: { valueType: "number", formula: { expr: "a + 1", binds: { a: "a" } } },
            c: { valueType: "number", formula: { expr: "x + 1", binds: { x: "b" } } },
          },
        },
      }),
    );
    const plan = buildDerivedPlan(tpl.world);
    assert.deepEqual(plan.order, ["a", "b", "c"]);
    assert.deepEqual(plan.deps["b"], ["a"]);
  });

  it("union 粗粒度依赖：attach 子树下从动末端触发重算；sys 项不产生图边", () => {
    const tpl = parseVarsTemplate(
      rawTemplate({
        character: {
          children: {
            attachtags: "string_list",
            inv: {
              children: {
                gold: { valueType: "number", formula: { expr: "1" } },
              },
            },
            tags: {
              valueType: "string_list",
              formula: { op: "union", terms: [{ attach: ["inv"] }, { sys: "cid" }] },
            },
          },
        },
      }),
    );
    const plan = buildDerivedPlan(tpl.character);
    assert.ok(plan.order.indexOf("inv.gold") < plan.order.indexOf("tags"));
    assert.deepEqual(plan.deps["tags"], ["inv"]);
  });

  it("依赖成环 = 抛错（消息带环路径）", () => {
    const tpl = parseVarsTemplate(
      rawTemplate({
        world: {
          children: {
            a: { valueType: "number", formula: { expr: "x + 1", binds: { x: "b" } } },
            b: { valueType: "number", formula: { expr: "y + 1", binds: { y: "a" } } },
          },
        },
      }),
    );
    assert.throws(() => buildDerivedPlan(tpl.world), /从动变量依赖成环/);
  });

  it("依赖路径含 world./characters. 前缀 = 拒绝", () => {
    const tpl = parseVarsTemplate(
      rawTemplate({
        world: {
          children: {
            world: { children: { base: "number" } },
            a: { valueType: "number", formula: { expr: "x + 1", binds: { x: "world.base" } } },
          },
        },
      }),
    );
    assert.throws(() => buildDerivedPlan(tpl.world), /同根相对路径/);
  });
});

describe("evalDerived", () => {
  it("expr 公式：binds 逐键 resolve 取 number", () => {
    const decl = terminal("danger");
    assert.equal(
      evalDerived(decl, {}, { resolve: (p) => (p === "base" ? 4 : undefined) }),
      8,
    );
    assert.throws(
      () => evalDerived(decl, {}, { resolve: () => "x" }),
      /取不到有限数值/,
    );
  });

  it("union 公式：走算子（需 scope.declRoot）", () => {
    const decl = terminal("tags", "character");
    const out = evalDerived(decl, DERIVED_CHAR_INST, {
      resolve: () => undefined,
      declRoot: TPL.character,
    });
    assert.deepEqual(out, ["自身", "共", "剑"]);
    assert.throws(
      () => evalDerived(decl, DERIVED_CHAR_INST, { resolve: () => undefined }),
      /scope\.declRoot/,
    );
  });

  it("无 formula 的末端 = 抛错", () => {
    assert.throws(() => evalDerived(terminal("base"), {}, { resolve: () => 1 }), /带 formula/);
  });
});

describe("buildRootDerivedPlan / evalDerivedTarget", () => {
  const ROOT_TPL = parseVarsTemplate({
    world: { children: {} },
    character: {
      children: {
        attachtags: "string_list",
        tags: { valueType: "string_list", formula: { op: "union", terms: [{ attach: [] }] } },
        armor: { array: { type: "item" } },
      },
    },
    types: {
      item: {
        children: {
          weight: "number",
          load: { valueType: "number", formula: { expr: "weight * 2", binds: { weight: "weight" } } },
        },
      },
    },
  });

  it("结构化数组按下标枚举展开（元素结构内 binds 以元素结构根为基准）；实例 formula 覆盖同路径模板声明", () => {
    const inst = normalizeInstance(
      {
        armor: [
          { weight: 3 },
          // 实例 formula 的 binds 以 character 根为基准（normalize 校验口径）
          { weight: 5, load: { value: 0, formula: { expr: "weight * 3", binds: { weight: "armor[1].weight" } } } },
        ],
      },
      ROOT_TPL.character,
      "c",
    ) as InstanceNode;
    const plan = buildRootDerivedPlan(ROOT_TPL.character, inst);
    const loads = plan.filter((t) => t.path !== "tags");
    assert.deepEqual(
      loads.map((t) => t.path),
      ["armor.0.load", "armor.1.load"],
    );
    assert.equal(evalDerivedTarget(loads[0]!, ROOT_TPL.character, inst), 6, "模板声明 formula（weight*2）");
    assert.equal(evalDerivedTarget(loads[1]!, ROOT_TPL.character, inst), 15, "实例 formula 覆盖（weight*3）");
  });

  it("expr 依赖末端无实例 = 跳过重算（undefined，不报错）", () => {
    const plan = buildRootDerivedPlan(TPL.world, {});
    const danger = plan.find((t) => t.path === "danger");
    assert.ok(danger);
    assert.equal(evalDerivedTarget(danger, TPL.world, {}), undefined);
    // 依赖就位后正常求值
    const inst = normalizeInstance({ base: 4 }, TPL.world, "w") as InstanceNode;
    assert.equal(evalDerivedTarget(danger, TPL.world, inst), 8);
  });

  it("元素结构内从动链：拓扑序被依赖者在前（含下标枚举后顺序保持）", () => {
    const tpl = parseVarsTemplate({
      world: { children: {} },
      character: {
        children: {
          attachtags: "string_list",
          tags: { valueType: "string_list", formula: { op: "union", terms: [{ attach: [] }] } },
          bag: { array: { type: "box" } },
        },
      },
      types: {
        box: {
          children: {
            a: { valueType: "number", formula: { expr: "1" } },
            b: { valueType: "number", formula: { expr: "a + 1", binds: { a: "a" } } },
          },
        },
      },
    });
    const inst = normalizeInstance({ bag: [{}] }, tpl.character, "c") as InstanceNode;
    const plan = buildRootDerivedPlan(tpl.character, inst);
    assert.ok(plan.findIndex((t) => t.path === "bag.0.a") < plan.findIndex((t) => t.path === "bag.0.b"));
    assert.equal(evalDerivedTarget(plan.find((t) => t.path === "bag.0.b")!, tpl.character, inst), undefined, "a 未物化 = b 跳过");
  });

  it("内联元素结构：formula 以元素结构根为基准，挂载路径补齐前缀", () => {
    const tpl = parseVarsTemplate({
      world: { children: {} },
      character: {
        children: {
          attachtags: "string_list",
          tags: { valueType: "string_list", formula: { op: "union", terms: [{ attach: [] }] } },
          bag: {
            array: {
              children: {
                w: "number",
                d: { valueType: "number", formula: { expr: "w * 2", binds: { w: "w" } } },
              },
            },
          },
        },
      },
    });
    const inst = normalizeInstance({ bag: [{ w: 4 }] }, tpl.character, "c") as InstanceNode;
    const plan = buildRootDerivedPlan(tpl.character, inst);
    const d = plan.find((t) => t.path === "bag.0.d");
    assert.ok(d, "内联元素从动末端按下标枚举");
    assert.equal(evalDerivedTarget(d!, tpl.character, inst), 8);
  });
});
