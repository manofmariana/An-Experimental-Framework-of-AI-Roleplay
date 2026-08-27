import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadPackPlaceholders, loadPackPrompts } from "../src/application/sessionFactory.js";
import { validatePlaceholders } from "../src/compile/placeholders.js";
import {
  extractPlaceholders,
  loadTemplate,
  validateTemplate,
} from "../src/compile/template.js";
import { resolveWorldDir } from "../src/config.js";
import { packPromptsDir } from "../src/resources/worldRepository.js";
import { parseWorldSys } from "../src/truth/varWrite.js";
import { buildWorldSysRaw } from "./builders/index.js";

/** 出厂世界包目录与其内 prompts/。 */
const FACTORY_WORLD_DIR = resolveWorldDir();
const FACTORY_PROMPTS_DIR = packPromptsDir(FACTORY_WORLD_DIR);

describe("extractPlaceholders", () => {
  it("按出现顺序去重提取", () => {
    assert.deepEqual(
      extractPlaceholders("{{a}} x {{b}} y {{a}} {{c_d}}"),
      ["a", "b", "c_d"],
    );
    assert.deepEqual(extractPlaceholders("无占位符 {\"json\": 1}"), []);
  });
});

describe("validateTemplate（结构 + 占位符合法性）", () => {
  it("合法模板通过", () => {
    const t = validateTemplate(
      {
        id: "x",
        modules: [{ key: "m", role: "system", content: "你好 {{name}}" }],
      },
      ["name"],
    );
    assert.equal(t.id, "x");
  });

  it("未知占位符报错并列出模块 key 与占位符名", () => {
    assert.throws(
      () =>
        validateTemplate(
          {
            id: "x",
            modules: [
              { key: "head", role: "system", content: "{{known}}" },
              { key: "tail", role: "user", content: "{{ghost_a}} 与 {{ghost_b}}" },
            ],
          },
          ["known"],
        ),
      (err: Error) =>
        err.message.includes("tail") &&
        err.message.includes("ghost_a") &&
        err.message.includes("ghost_b") &&
        !err.message.includes("known"),
    );
  });

  it("非法结构抛错（缺字段/非法 role）", () => {
    assert.throws(() => validateTemplate({ id: "x" }, []));
    assert.throws(() =>
      validateTemplate({ id: "x", modules: [{ key: "m", role: "god", content: "" }] }, []),
    );
  });
});

describe("出厂模板 × 占位符目录（data/assets/{包}/prompts/）", () => {
  const catalog = loadPackPlaceholders(FACTORY_WORLD_DIR);

  for (const agent of ["character", "gm", "prose", "gm-incident"] as const) {
    it(`${agent}：模板可加载，占位符全部在目录内`, () => {
      const t = loadTemplate(agent, Object.keys(catalog), FACTORY_PROMPTS_DIR);
      assert.equal(t.id, agent);
      assert.ok(t.modules.length >= 2);
      // 尾部模块是动态内容（编辑约定：动态置尾）
      const used = new Set(t.modules.flatMap((m) => extractPlaceholders(m.content)));
      for (const key of used) assert.ok(key in catalog, `{{${key}}} 应在占位符目录内`);
    });
  }

  it("loadPackPrompts 四份齐备（含 gm-incident）；目录语义机检通过", () => {
    const templates = loadPackPrompts(FACTORY_WORLD_DIR, catalog);
    assert.deepEqual(templates.map((tpl) => tpl.id), ["character", "gm", "prose", "gm-incident"]);
    // 与装配同一口径的语义机检（vars 路径/置后同轴/分支记号；出厂目录当前无 vars 源条目）
    const sys = parseWorldSys(buildWorldSysRaw());
    validatePlaceholders(catalog, { template: sys.template, registry: sys.tagRegistry });
  });
});
