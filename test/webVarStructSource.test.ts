/**
 * web/views/var-struct-source.js 单元测试（unit 层）：
 * 世界页「变量结构」双模式数据源纯逻辑——
 * - 模式判定：NO_ACTIVE_SESSION 错误码 = 包基线模式（其余错误/无错误码 = false，原样上抛）；
 * - 档内模式保存载荷：sys 两份文件整体提交 + baseRevision 乐观闸（形状钉死）；
 * - 保存成功 baseRevision 推进：应答带非负整数 revision 取之，缺省/非法保持现值。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  STRUCT_MODE_HINT,
  buildSysSaveBody,
  isNoActiveSession,
  savedRevision,
} from "../web/views/var-struct-source.js";

describe("变量结构双模式数据源（var-struct-source）", () => {
  it("模式提示行文案：两模式各一句（常显）", () => {
    assert.match(STRUCT_MODE_HINT.session, /当前会话存档.*立即生效/);
    assert.match(STRUCT_MODE_HINT.pack, /世界包基线.*新会话生效/);
  });

  it("isNoActiveSession：NO_ACTIVE_SESSION = true，其余错误码/非对象 = false", () => {
    const err = new Error("当前无活跃会话") as Error & { code?: string };
    err.code = "NO_ACTIVE_SESSION";
    assert.equal(isNoActiveSession(err), true);
    const other = new Error("x") as Error & { code?: string };
    other.code = "VALIDATION_ERROR";
    assert.equal(isNoActiveSession(other), false);
    assert.equal(isNoActiveSession(new Error("裸错误")), false);
    assert.equal(isNoActiveSession(null), false);
    assert.equal(isNoActiveSession("NO_ACTIVE_SESSION"), false);
  });

  it("buildSysSaveBody：sys 两份整体上送 + baseRevision（形状钉死）", () => {
    const body = buildSysSaveBody({
      varsTemplate: { world: { children: {} } },
      varsTags: { world: {}, character: {} },
      baseRevision: 12,
    });
    assert.deepEqual(body, {
      sys: {
        varsTemplate: { world: { children: {} } },
        varsTags: { world: {}, character: {} },
      },
      baseRevision: 12,
    });
  });

  it("savedRevision：应答非负整数 revision 取之；缺省/非法保持现值", () => {
    assert.equal(savedRevision({ note: "ok", revision: 9 }, 7), 9);
    assert.equal(savedRevision({ note: "ok", revision: 0 }, 7), 0);
    assert.equal(savedRevision({ note: "ok" }, 7), 7); // 无 revision 字段
    assert.equal(savedRevision(null, 7), 7);
    assert.equal(savedRevision({ revision: -1 }, 7), 7); // 负数非法
    assert.equal(savedRevision({ revision: 1.5 }, 7), 7); // 非整数非法
    assert.equal(savedRevision({ revision: "9" }, 7), 7); // 非数字非法
  });
});
