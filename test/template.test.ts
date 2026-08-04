import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHARACTER_PLACEHOLDERS } from "../src/agents/character.js";
import { GM_PLACEHOLDERS } from "../src/agents/gm.js";
import { PROSE_PLACEHOLDERS } from "../src/agents/prose.js";
import {
  extractPlaceholders,
  loadTemplate,
  validateTemplate,
} from "../src/compile/template.js";
import { resolveWorldDir } from "../src/config.js";
import { packPromptsDir } from "../src/resources/worldRepository.js";

/** 出厂模板目录 = 默认世界包内 prompts/。 */
const FACTORY_PROMPTS_DIR = packPromptsDir(resolveWorldDir());

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

describe("出厂模板 × 注册表（data/assets/{包}/prompts/*.prompt.json）", () => {
  const cases = [
    ["character", CHARACTER_PLACEHOLDERS],
    ["gm", GM_PLACEHOLDERS],
    ["prose", PROSE_PLACEHOLDERS],
  ] as const;

  for (const [agent, reg] of cases) {
    it(`${agent}：模板可加载，占位符全部在注册表内`, () => {
      const t = loadTemplate(agent, Object.keys(reg), FACTORY_PROMPTS_DIR);
      assert.equal(t.id, agent);
      assert.ok(t.modules.length >= 2);
      // 尾部模块是动态内容（编辑约定：动态置尾）
      const used = new Set(t.modules.flatMap((m) => extractPlaceholders(m.content)));
      for (const key of used) assert.ok(key in reg, `{{${key}}} 应在注册表内`);
    });
  }

  it("模板 id 与文件名不一致时报错", () => {
    // gm 的注册表不含 character 专有占位符，交叉加载必失败
    assert.throws(() => loadTemplate("character", Object.keys(GM_PLACEHOLDERS), FACTORY_PROMPTS_DIR));
  });
});
