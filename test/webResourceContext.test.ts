/**
 * web/resource-context.js 单元测试（unit 层，优化阶段 D5）：
 * URL 构造器携带 ?set=（编码）、身份捕获即不可变（冻结）、worldSetId 必填校验。
 * 零 IO：纯 URL 构造器直测。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createResourceContext, DEFAULT_USERNAME } from "../web/resource-context.js";

describe("createResourceContext：URL 构造器", () => {
  it("全部资源 URL 携带 ?set=（world/characters/单角色/单文件）", () => {
    const ctx = createResourceContext({ worldSetId: "baitan" });
    assert.equal(ctx.worldSetsUrl(), "/api/worlds"); // 列表端点跨包，不带 set
    assert.equal(ctx.worldUrl(), "/api/world?set=baitan");
    assert.equal(ctx.worldFileUrl("setting"), "/api/world/setting?set=baitan");
    assert.equal(ctx.worldFileUrl("tone-card"), "/api/world/tone-card?set=baitan");
    assert.equal(ctx.worldFileUrl("lorebook"), "/api/world/lorebook?set=baitan");
    assert.equal(ctx.charactersUrl(), "/api/characters?set=baitan");
    assert.equal(ctx.characterUrl("C1001"), "/api/characters/C1001?set=baitan");
  });

  it("set 与路径段经 encodeURIComponent 编码", () => {
    const ctx = createResourceContext({ worldSetId: "包 甲/乙" });
    assert.equal(ctx.worldUrl(), `/api/world?set=${encodeURIComponent("包 甲/乙")}`);
    assert.equal(ctx.characterUrl("C 1"), `/api/characters/C%201?set=${encodeURIComponent("包 甲/乙")}`);
  });

  it("默认 username = default_user，自定义保留", () => {
    assert.equal(createResourceContext({ worldSetId: "a" }).username, DEFAULT_USERNAME);
    assert.equal(createResourceContext({ username: "u2", worldSetId: "a" }).username, "u2");
  });

  it("worldSetId 必填：缺省/空串/空白即抛（无 set 的 URL 不允许漏带）", () => {
    assert.throws(() => createResourceContext(), /worldSetId 必填/);
    assert.throws(() => createResourceContext({}), /worldSetId 必填/);
    assert.throws(() => createResourceContext({ worldSetId: "" }), /worldSetId 必填/);
    assert.throws(() => createResourceContext({ worldSetId: "  " }), /worldSetId 必填/);
  });
});

describe("createResourceContext：捕获即不可变", () => {
  it("返回对象冻结：身份字段不可改写，URL 构造器不可替换", () => {
    const ctx = createResourceContext({ worldSetId: "baitan" });
    assert.equal(Object.isFrozen(ctx), true);
    assert.throws(() => {
      (ctx as { worldSetId: string }).worldSetId = "other";
    }, TypeError);
    // 冻结保证：反复构造 URL 恒为捕获时的 set（不随外部 picker 漂移）
    assert.equal(ctx.charactersUrl(), "/api/characters?set=baitan");
    assert.equal(ctx.charactersUrl(), "/api/characters?set=baitan");
  });

  it("两次捕获互不影响（打开 A 后切 B = 新 ctx，旧表单仍写 A）", () => {
    const a = createResourceContext({ worldSetId: "set-a" });
    const b = createResourceContext({ worldSetId: "set-b" });
    assert.equal(a.worldUrl(), "/api/world?set=set-a");
    assert.equal(b.worldUrl(), "/api/world?set=set-b");
  });
});
