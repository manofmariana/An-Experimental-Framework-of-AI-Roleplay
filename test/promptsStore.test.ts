import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PromptTemplate } from "../src/compile/template.js";
import {
  PROMPT_TEMPLATE_IDS,
  PromptsFileSchema,
  PromptsStore,
  type PromptsFile,
} from "../src/truth/promptsStore.js";
import { SAVE_SCHEMA_VERSION } from "../src/truth/saveSchema.js";

const t = (id: string, content = `${id}内容`): PromptTemplate => ({
  id,
  modules: [{ key: "m", role: "system", content }],
});

function sampleFile(): PromptsFile {
  return {
    schema_version: SAVE_SCHEMA_VERSION,
    templates: {
      character: t("character"),
      gm: t("gm"),
      prose: t("prose"),
      "gm-incident": t("gm-incident"),
    },
    placeholders: {},
  };
}

describe("PromptsFileSchema（prompts.json 文件 codec）", () => {
  it("合法文件解析通过；往返序列化一致", () => {
    const file = sampleFile();
    const parsed = PromptsFileSchema.parse(JSON.parse(JSON.stringify(file)));
    assert.deepEqual(parsed, file);
  });

  it("缺键 / 多键拒装", () => {
    const missing = sampleFile();
    delete (missing.templates as Record<string, unknown>)["gm-incident"];
    assert.throws(() => PromptsFileSchema.parse(missing));

    const extra = JSON.parse(JSON.stringify(sampleFile())) as PromptsFile;
    (extra.templates as Record<string, unknown>)["npc"] = t("npc");
    assert.throws(() => PromptsFileSchema.parse(extra));

    // placeholders 键缺失同样拒装（信封 = {schema_version, templates, placeholders}）
    const noCatalog = JSON.parse(JSON.stringify(sampleFile())) as Record<string, unknown>;
    delete noCatalog["placeholders"];
    assert.throws(() => PromptsFileSchema.parse(noCatalog));
  });

  it("placeholders 分支记号集随 codec 规范化（排序去重），重复分支键拒装", () => {
    const file = JSON.parse(JSON.stringify(sampleFile())) as PromptsFile;
    file.placeholders = {
      p: {
        description: "d",
        source: "vars",
        segments: [
          {
            kind: "entry",
            pass: { template: "{world.hp}", branches: [{ tokens: ["vis", "aud", "vis"], template: "b" }] },
          },
        ],
      },
    };
    const parsed = PromptsFileSchema.parse(JSON.parse(JSON.stringify(file)));
    const side = parsed.placeholders["p"]!.segments[0]!;
    assert.ok(side.kind === "entry");
    assert.deepEqual(side.pass.branches![0]!.tokens, ["aud", "vis"], "分支记号集排序去重");

    const dup = JSON.parse(JSON.stringify(file)) as PromptsFile;
    const dupSide = dup.placeholders["p"]!.segments[0]!;
    assert.ok(dupSide.kind === "entry");
    dupSide.pass.branches = [
      { tokens: ["aud", "vis"], template: "b1" },
      { tokens: ["vis", "aud"], template: "b2" },
    ];
    assert.throws(() => PromptsFileSchema.parse(JSON.parse(JSON.stringify(dup))), /重复分支键/);
  });

  it("模板 id 与键名不符拒装", () => {
    const file = sampleFile();
    file.templates.gm = t("character");
    assert.throws(() => PromptsFileSchema.parse(file), /与键名/);
  });

  it("schema_version 不符拒装（literal 校验）", () => {
    const file = JSON.parse(JSON.stringify(sampleFile())) as { schema_version: number };
    file.schema_version = SAVE_SCHEMA_VERSION - 1;
    assert.throws(() => PromptsFileSchema.parse(file));
  });
});

describe("PromptsStore（档内副本；纯内存容器）", () => {
  it("initFrom 拷入四份模板（只动副本），按 id 取模板", () => {
    const source = [t("character"), t("gm"), t("prose"), t("gm-incident")];
    const store = PromptsStore.initFrom(source, {});
    for (const id of PROMPT_TEMPLATE_IDS) {
      assert.equal(store.template(id).id, id);
    }
    // 档内变更不影响传入对象
    store.replaceTemplate(t("gm", "gm改后"));
    assert.equal(source[1]!.modules[0]!.content, "gm内容");
  });

  it("initFrom 缺份即拒（四键齐备口径与 codec 一致）", () => {
    assert.throws(() => PromptsStore.initFrom([t("character"), t("gm"), t("prose")], {}));
  });

  it("replaceTemplate 按 id 整体替换单份；未知 id 拒绝", () => {
    const store = new PromptsStore(sampleFile());
    store.replaceTemplate(t("prose", "prose改后"));
    assert.equal(store.template("prose").modules[0]!.content, "prose改后");
    assert.equal(store.template("gm").modules[0]!.content, "gm内容", "其余模板不动");
    assert.throws(() => store.replaceTemplate(t("npc")), /未知模板 id/);
    assert.throws(() => store.replaceTemplate({ id: "gm" }), "结构非法拒绝");
  });

  it("replacePlaceholders 整份替换目录（分支记号集随写入规范化）；结构非法拒绝且原目录不动", () => {
    const store = new PromptsStore(sampleFile());
    store.replacePlaceholders({
      p: {
        description: "d",
        source: "events",
        segments: [
          {
            kind: "entry",
            pass: { template: "{_content}", branches: [{ tokens: ["vis", "aud", "vis"], template: "b" }] },
          },
        ],
      },
    });
    const catalog = store.placeholders();
    assert.deepEqual(Object.keys(catalog), ["p"]);
    const segment = catalog["p"]!.segments[0]!;
    assert.equal(segment.kind, "entry");
    if (segment.kind === "entry") {
      assert.deepEqual(segment.pass.branches![0]!.tokens, ["aud", "vis"], "记号集排序去重");
    }
    assert.throws(
      () => store.replacePlaceholders({ bad: { description: "d", source: "nope", segments: [] } }),
      "结构非法拒绝",
    );
    assert.deepEqual(Object.keys(store.placeholders()), ["p"], "写入失败原目录不动");
  });

  it("clone 语义：构造深拷贝（改源数据不影响 Store），saveData/restoreData 回环", () => {
    const file = sampleFile();
    const store = new PromptsStore(file);
    file.templates.gm = t("gm", "源改后");
    assert.equal(store.template("gm").modules[0]!.content, "gm内容", "构造已深拷贝");

    const restored = new PromptsStore(sampleFile());
    restored.replaceTemplate(t("gm", "gm改后"));
    restored.restoreData(store.saveData());
    assert.equal(restored.template("gm").modules[0]!.content, "gm内容", "restoreData 内容替换");
    assert.deepEqual(new PromptsStore(restored.saveData()).saveData(), store.saveData(), "saveData 回环");
  });
});
