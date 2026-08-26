import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SYSTEM_CHAR_KEYS,
  projectCharacterTree,
  type CharacterProjectionInput,
} from "../src/vars/systemChar.js";
import { parseVarsTags, parseVarsTemplate, resolveAttachTags, type TerminalDecl } from "../src/vars/template.js";
import { normalizeInstance, validateSystemTags, isTerminalInstance } from "../src/vars/tree.js";

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

const TEMPLATE_RAW = {
  world: { children: {} },
  character: {
    children: {
      attachtags: "string_list",
      tags: { valueType: "string_list", formula: { op: "union_attach", paths: [] as string[] } },
      hp: "number",
    },
  },
};

const TPL = parseVarsTemplate(TEMPLATE_RAW);

function state(overrides?: Partial<CharacterProjectionInput>): CharacterProjectionInput {
  return {
    name: "林雾",
    gender: "女",
    age: "26",
    personality: "谨慎。",
    reaction: 5,
    level: 1,
    omniscience: 0,
    location: { name: "灯塔", level: 2 },
    initiative: null,
    relations: [{ cid: "C1002", name: "周砚", impression: "可信" }],
    long_term_memory: ["记忆一"],
    acted: false,
    group: 0,
    channel: null,
    timer: null,
    isPlayer: false,
    vars: { hp: { value: 10, tags: [] } },
    systemTags: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 系统声明分支并入
// ---------------------------------------------------------------------------

describe("系统声明分支并入", () => {
  it("character 根并入系统子树；characterVars 只含世界作者声明；types 并入 relation", () => {
    for (const key of SYSTEM_CHAR_KEYS) {
      assert.ok(Object.hasOwn(TPL.character.children, key), `character 根缺系统键 ${key}`);
      assert.equal(Object.hasOwn(TPL.characterVars.children, key), false, `characterVars 不应含系统键 ${key}`);
    }
    assert.ok(Object.hasOwn(TPL.characterVars.children, "hp"));
    assert.equal(TPL.types["relation"]?.kind, "container");
    // relation 元素结构含 cid 字段（消费侧按 cid 匹配）
    assert.deepEqual(Object.keys(TPL.types["relation"]!.children), ["cid", "name", "impression"]);
    // 系统路径可解析（投影视角）：location 容器 / relations 结构化数组按下标穿越
    assert.equal(TPL.resolve("character", "location.name").kind, "terminal");
    assert.equal(TPL.resolve("character", "relations").kind, "array");
    assert.equal(TPL.resolve("character", "relations[0].impression").kind, "terminal");
    assert.equal(TPL.resolve("character", "relations[*].cid").kind, "terminal");
  });

  it("五调度字段带 system 元数据；其余系统末端不带", () => {
    for (const key of ["acted", "group", "channel", "timer", "isPlayer"]) {
      assert.equal((TPL.character.children[key] as TerminalDecl).system, true, key);
    }
    for (const key of ["name", "reaction", "level", "omniscience", "long_term_memory"]) {
      assert.equal((TPL.character.children[key] as TerminalDecl).system, undefined, key);
    }
  });

  it("世界作者声明与系统分支同名 = 拒装（冲突报错带名）", () => {
    assert.throws(
      () =>
        parseVarsTemplate({
          world: { children: {} },
          character: {
            children: {
              attachtags: "string_list",
              tags: { valueType: "string_list", formula: { op: "union_attach", paths: [] } },
              name: "string",
            },
          },
        }),
      /"name" 与系统声明分支同名冲突/,
    );
    assert.throws(
      () =>
        parseVarsTemplate({
          world: { children: {} },
          character: {
            children: {
              attachtags: "string_list",
              tags: { valueType: "string_list", formula: { op: "union_attach", paths: [] } },
            },
          },
          types: { relation: { children: { x: "number" } } },
        }),
      /类型 "relation" 与系统声明分支类型同名冲突/,
    );
  });

  it("实例 normalize 走 characterVars：系统分支键无实例（拒收）", () => {
    assert.throws(
      () => normalizeInstance({ name: "冒名" }, TPL.characterVars, "c"),
      /未声明的键/,
    );
    assert.deepEqual(normalizeInstance({ hp: 3 }, TPL.characterVars, "c"), { hp: { value: 3, tags: [] } });
  });

  it("character 根挂条目级联到系统分支全部末端（cid 类别按属主分发；数组层 [*] 占位）", () => {
    const tags = parseVarsTags({ tags: [{ category: "cid", level: 1 }] }, TPL.character);
    const resolved = resolveAttachTags(tags, TPL.character, {
      categories: new Set(["cid"]),
      ownerCid: "C1001",
    });
    assert.deepEqual(resolved.get("name"), [{ name: "C1001", level: 1 }]);
    assert.deepEqual(resolved.get("location.name"), [{ name: "C1001", level: 1 }]);
    assert.deepEqual(resolved.get("relations[*].impression"), [{ name: "C1001", level: 1 }]);
    assert.deepEqual(resolved.get("timer"), [{ name: "C1001", level: 1 }]);
    assert.deepEqual(resolved.get("hp"), [{ name: "C1001", level: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// 投影
// ---------------------------------------------------------------------------

describe("projectCharacterTree", () => {
  it("系统分支值从类型化字段读出为标准末端外壳；relations 数组按下标投影；vars 树原样并入", () => {
    const tree = projectCharacterTree(state()) as Record<string, unknown>;
    assert.deepEqual(tree["name"], { value: "林雾", tags: [] });
    assert.deepEqual(tree["reaction"], { value: 5, tags: [] });
    assert.deepEqual(tree["location"], {
      name: { value: "灯塔", tags: [] },
      level: { value: 2, tags: [] },
    });
    assert.deepEqual(tree["relations"], [
      {
        cid: { value: "C1002", tags: [] },
        name: { value: "周砚", tags: [] },
        impression: { value: "可信", tags: [] },
      },
    ]);
    assert.deepEqual(tree["long_term_memory"], { value: ["记忆一"], tags: [] });
    assert.deepEqual(tree["hp"], { value: 10, tags: [] });
  });

  it("timer/channel null 原样呈现（不走 valueType 校验）；initiative null = 容器无实例", () => {
    const tree = projectCharacterTree(state()) as Record<string, unknown>;
    assert.deepEqual(tree["timer"], { value: null, tags: [] });
    assert.deepEqual(tree["channel"], { value: null, tags: [] });
    assert.equal(Object.hasOwn(tree, "initiative"), false, "initiative null = 键不出现");
    const withInit = projectCharacterTree(state({ initiative: { value: 25, group: 1 }, timer: 100 })) as Record<
      string,
      unknown
    >;
    assert.deepEqual(withInit["initiative"], {
      value: { value: 25, tags: [] },
      group: { value: 1, tags: [] },
    });
    assert.deepEqual(withInit["timer"], { value: 100, tags: [] });
  });

  it("系统末端外壳 tags 取自 systemTags 侧车（数组层键 = `键[下标]` 路径）", () => {
    const tree = projectCharacterTree(
      state({ systemTags: { name: [{ name: "闻名", level: 3 }], "relations[0].name": [{ name: "旧识", level: 1 }] } }),
    ) as Record<string, unknown>;
    assert.deepEqual(tree["name"], { value: "林雾", tags: [{ name: "闻名", level: 3 }] });
    const rel = (tree["relations"] as Record<string, unknown>[])[0]!;
    assert.deepEqual(rel, {
      cid: { value: "C1002", tags: [] },
      name: { value: "周砚", tags: [{ name: "旧识", level: 1 }] },
      impression: { value: "可信", tags: [] },
    });
    assert.ok(isTerminalInstance(tree["name"]));
  });
});

// ---------------------------------------------------------------------------
// systemTags 侧车校验
// ---------------------------------------------------------------------------

describe("validateSystemTags", () => {
  it("合法侧车原样返回（含 relations 数组下标路径）", () => {
    const sidecar = { name: [{ name: "闻名", level: 3 }], "relations[0].impression": [{ name: "旧识", level: 1 }] };
    assert.deepEqual(validateSystemTags(sidecar, TPL.character), sidecar);
  });

  it("系统分支外路径 / 不可解析 / 解析到容器或数组 = 拒绝", () => {
    assert.throws(() => validateSystemTags({ hp: [] }, TPL.character), /不在系统分支内/);
    assert.throws(() => validateSystemTags({ "location.nope": [] }, TPL.character), /不可解析/);
    assert.throws(() => validateSystemTags({ location: [] }, TPL.character), /必须解析到末端/);
    assert.throws(() => validateSystemTags({ relations: [] }, TPL.character), /必须解析到末端/);
    assert.throws(() => validateSystemTags({ "relations[0]": [] }, TPL.character), /必须解析到末端/);
    assert.throws(() => validateSystemTags({ "relations[0].ghost": [] }, TPL.character), /不可解析/);
  });

  it("level 1-7 越界 / 未注册名 = 拒绝", () => {
    assert.throws(
      () => validateSystemTags({ name: [{ name: "a", level: 8 }] }, TPL.character),
      /形状非法/,
    );
    assert.throws(
      () => validateSystemTags({ name: [{ name: "a", level: 1 }] }, TPL.character, { registeredNames: new Set(["b"]) }),
      /未注册 TAG 名 "a"/,
    );
  });
});
