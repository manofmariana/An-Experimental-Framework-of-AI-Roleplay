/**
 * 「角色感知」全链契约测试（application 层，内存真相零 IO）：
 * vars-tags 附加（cid 类按属主分发）→ 投影层读取期合并 → characters 根全量遍历 →
 * 引擎逐末端 TAG 过滤 → matched 分支精确匹配（自 = [cid, 角色感知] / 他 = [角色感知]）。
 * 另钉：cid 系统末端建角物化（fromManifests/ensurePlayer）与只读（deltas 拒写）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePlaceholders, validatePlaceholders } from "../src/compile/placeholders.js";
import { renderPrompt } from "../src/compile/render.js";
import { ArchiveStore } from "../src/truth/archive.js";
import { CharactersStore } from "../src/truth/charactersStore.js";
import { EventsStore } from "../src/truth/events.js";
import { LoreStore } from "../src/truth/loreStore.js";
import { SysStore } from "../src/truth/sysStore.js";
import { parseSys } from "../src/truth/sysStore.js";
import { applyVarDeltas, varWriteDepsOf } from "../src/truth/varWrite.js";
import { WorldStore } from "../src/truth/worldStore.js";
import {
  buildCharacterState,
  buildManifest,
  buildPromptsStore,
  buildProjectionHost,
  buildSysFile,
  buildTagRegistryRaw,
  buildTagsPool,
  buildVarsTemplate,
  buildWorldTree,
} from "./builders/index.js";

// ---------------------------------------------------------------------------
// 夹具：包形注册表（system 条目 + 角色感知）+ vars-tags 附加（baitan 同构）
// ---------------------------------------------------------------------------

const REGISTRY_RAW = {
  ...buildTagRegistryRaw(),
  角色感知: { name: "角色感知", description: "感知在场角色的存在" },
};

/** baitan 同构附加：根级 {cid 类@1}（只见自身兜底）+ cid 末端 {角色感知@1, cid 类@2} + name/location {cid 类@1}。 */
const VARS_TAGS_RAW = {
  world: {},
  character: {
    tags: [{ category: "cid", level: 1 }],
    children: {
      cid: { tags: [{ name: "角色感知", level: 1 }, { category: "cid", level: 2 }] },
      name: { tags: [{ category: "cid", level: 1 }] },
      location: { tags: [{ category: "cid", level: 1 }] },
    },
  },
};

/** 持「角色感知」的角色状态（tags 池 = 附加名 ∪ cid/地点常驻项，程序消费角色 TAG 集唯一路径）。 */
function perceivedChar(cid: string, name: string, appearance: boolean) {
  return buildCharacterState({
    cid,
    name,
    location: { name: "灯塔", level: 1 },
    appearance,
    vars: {
      attachtags: { value: ["角色感知"], tags: [] },
      tags: buildTagsPool(["角色感知"], { cid, locationName: "灯塔", channel: null }),
    },
  });
}

function truth() {
  return {
    world: new WorldStore(buildWorldTree()),
    sys: new SysStore(buildSysFile({ tagRegistry: REGISTRY_RAW, varsTags: VARS_TAGS_RAW })),
    characters: new CharactersStore({
      C1001: perceivedChar("C1001", "林雾", true),
      C1002: perceivedChar("C1002", "周砚", true),
      C1003: perceivedChar("C1003", "丙", false), // 后台：fappear 虚拟挂载 → 权重 0 读者不可见
    }),
    events: new EventsStore(),
    archive: new ArchiveStore(),
    loreStore: LoreStore.initFrom([]),
    promptsStore: buildPromptsStore(),
  };
}

/** baitan present_cid / self_name / self_location 同构目录。 */
const CATALOG = parsePlaceholders({
  present: {
    description: "在场角色 CID 表",
    segments: [
      { kind: "static", text: "##在场角色：" },
      {
        kind: "entry",
        identity: false,
        pass: {
          template: "{characters[*].cid}",
          branches: [{ tokens: ["cid", "角色感知"], template: "{characters[*].cid}←这是你自己" }],
        },
        separator: ",",
      },
    ],
  },
  self_name: {
    description: "自己的角色名",
    segments: [{ kind: "entry", pass: { template: "{characters[*].name}" } }],
  },
  self_location: {
    description: "自己的当前地点名",
    segments: [{ kind: "entry", pass: { template: "{characters[*].location.name}" } }],
  },
});

function renderOne(key: string, reader: { kind: "character"; cid: string } | { kind: "gm" }): string {
  const host = buildProjectionHost(reader, truth());
  const messages = renderPrompt({ id: "t", modules: [{ key: "m", role: "system", content: `{{${key}}}` }] }, CATALOG, host);
  return messages[0]?.content ?? "";
}

describe("角色感知：vars-tags 附加 + 全量遍历 + 引擎过滤全链", () => {
  it("目录过语义机检（机检上下文 = 同包 sys 解析产物）", () => {
    const sys = parseSys(truth().sys.saveData());
    validatePlaceholders(CATALOG, { template: sys.template, registry: sys.tagRegistry });
  });

  it("角色读者：全体在场者 cid 平列，自己经 matched=[cid,角色感知] 分支标注；后台角色不可见", () => {
    assert.equal(renderOne("present", { kind: "character", cid: "C1001" }), "##在场角色：C1001←这是你自己,C1002");
    assert.equal(renderOne("present", { kind: "character", cid: "C1002" }), "##在场角色：C1001,C1002←这是你自己");
  });

  it("GM 读者（权重 6）：全量含后台、无自我标注分支", () => {
    assert.equal(renderOne("present", { kind: "gm" }), "##在场角色：C1001,C1002,C1003");
  });

  it("name/location 末端 {cid 类@1} 附加 = 只见自身（保住 cast 保护：名字靠剧情获得）", () => {
    assert.equal(renderOne("self_name", { kind: "character", cid: "C1001" }), "林雾");
    assert.equal(renderOne("self_location", { kind: "character", cid: "C1002" }), "灯塔");
    // GM 权重 6 全量可见
    assert.equal(renderOne("self_name", { kind: "gm" }), "林雾\n周砚\n丙");
  });
});

describe("cid 系统末端：建角物化与只读", () => {
  it("fromManifests/ensurePlayer 物化 cid = manifest.id / C0", () => {
    const decl = buildVarsTemplate().characterVars;
    const store = CharactersStore.fromManifests([buildManifest({ id: "C1001", name: "林雾" })], 0, decl);
    assert.equal(store.get("C1001").cid, "C1001");
    store.ensurePlayer(buildManifest({ id: "C0", name: "玩家", isPlayer: true }), 0, decl);
    assert.equal(store.get("C0").cid, "C0");
  });

  it("deltas/varWrite 拒写：characters.{cid}.cid 走系统字段白名单口径，vars.cid 命中系统分支拒写", () => {
    const t = truth();
    const sys = parseSys(t.sys.saveData());
    const deps = varWriteDepsOf(sys, new Set(Object.keys(t.characters.all())));
    assert.throws(
      () => applyVarDeltas(t, [{ path: "characters.C1001.cid", op: "=", value: "C9999" }], deps),
      /系统字段走白名单专用通道/,
    );
    assert.throws(
      () => applyVarDeltas(t, [{ path: "characters.C1001.vars.cid", op: "=", value: "C9999" }], deps),
      /系统字段走白名单专用通道/,
    );
  });

  it("投影层 cid 末端值 = 记录键（characters 根路径调用可读）", () => {
    const host = buildProjectionHost({ kind: "gm" }, truth());
    const view = host.vars();
    const tree = view.characters["C1001"] as Record<string, { value: unknown }>;
    assert.equal(tree["cid"]!.value, "C1001");
  });
});
