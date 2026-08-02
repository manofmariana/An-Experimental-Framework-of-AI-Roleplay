import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCastLines,
  normalizeCid,
  renderForGm,
  renderForReader,
  renderRefsDisplay,
  renderRefsForGm,
  renderRefsForReader,
} from "../src/truth/identity.js";

const CAST = [
  { cid: "C0", name: "旅人（玩家）" },
  { cid: "C1001", name: "林雾" },
];

describe("renderForReader（身份替换，§1）", () => {
  it("自己 → 我；不认识 → 陌生人", () => {
    assert.equal(
      renderForReader("@C1001打量@C0，神色戒备", "C1001", {}),
      "我打量陌生人，神色戒备",
    );
  });

  it("relations 有 name → 真名", () => {
    assert.equal(
      renderForReader("@C0推门进来", "C1001", { C0: { name: "阿青" } }),
      "阿青推门进来",
    );
  });

  it("只有 impression → 印象称谓", () => {
    assert.equal(
      renderForReader("@C0推门进来", "C1001", { C0: { impression: "鞋上有青苔的男人" } }),
      "鞋上有青苔的男人推门进来",
    );
  });

  it("name 优先于 impression；空串按缺省处理", () => {
    assert.equal(
      renderForReader("@C0坐下", "C1001", { C0: { name: "阿青", impression: "旅人" } }),
      "阿青坐下",
    );
    assert.equal(renderForReader("@C0坐下", "C1001", { C0: { name: "" } }), "陌生人坐下");
  });

  it("同一文本多个占位符全部替换（含读者不是自己时的视角）", () => {
    assert.equal(
      renderForReader('@C1001对@C0说："你好"', "C0", {}),
      '陌生人对我说："你好"',
    );
  });

  it("无占位符文本原样返回", () => {
    assert.equal(renderForReader("门外传来脚步声", "C1001", {}), "门外传来脚步声");
  });
});

describe("renderForGm（演员表视角）", () => {
  it("@CID → 演员表真名；表外 CID 保留原文", () => {
    assert.equal(
      renderForGm('@C1001对@C0说："你好"', CAST),
      '林雾对旅人（玩家）说："你好"',
    );
    assert.equal(renderForGm("@C9999路过", CAST), "@C9999路过");
  });
});

describe("renderRefs*（正文指称占位符 [[称呼|@CID]]）", () => {
  it("display 视图：去占位只留称呼", () => {
    assert.equal(renderRefsDisplay("[[林雾|@C1001]]推门进来，[[旅人|@C0]]跟上"), "林雾推门进来，旅人跟上");
  });

  it("reader 视图：relations 有 name → 真名", () => {
    assert.equal(
      renderRefsForReader("[[旅人|@C0]]推门进来", { C0: { name: "阿青" } }),
      "阿青推门进来",
    );
  });

  it("reader 视图：只有 impression → 印象称谓兜底", () => {
    assert.equal(
      renderRefsForReader("[[旅人|@C0]]推门进来", { C0: { impression: "鞋上有青苔的男人" } }),
      "鞋上有青苔的男人推门进来",
    );
    assert.equal(
      renderRefsForReader("[[旅人|@C0]]坐下", { C0: { name: "", impression: "旅人" } }),
      "旅人坐下",
    );
  });

  it("reader 视图：都不认识 → 保留 @CID 原样（补回 @ 前缀）", () => {
    assert.equal(renderRefsForReader("[[林雾|@C1001]]路过", {}), "@C1001路过");
    assert.equal(renderRefsForReader("[[林雾|C1001]]路过", {}), "@C1001路过");
  });

  it("缺 @ 的占位也识别", () => {
    assert.equal(renderRefsDisplay("[[林雾|C1001]]路过"), "林雾路过");
    assert.equal(renderRefsForGm("[[林雾|C1001]]路过"), "林雾（@C1001）路过");
  });

  it("gm 视图：称呼（@CID）", () => {
    assert.equal(
      renderRefsForGm("[[林雾|@C1001]]对[[旅人|@C0]]说"),
      "林雾（@C1001）对旅人（@C0）说",
    );
  });

  it("畸形/未闭合占位原样保留", () => {
    assert.equal(renderRefsDisplay("[[林雾|@C1001路过"), "[[林雾|@C1001路过");
    assert.equal(renderRefsDisplay("[[林雾]]路过"), "[[林雾]]路过");
    assert.equal(renderRefsForGm("[[|@C1001]]路过"), "[[|@C1001]]路过");
    assert.equal(renderRefsForReader("[[林雾|@1001]]路过", {}), "[[林雾|@1001]]路过");
  });
});

describe("buildCastLines / normalizeCid", () => {
  it("演员表行；selfCid 标 我", () => {
    assert.deepEqual(buildCastLines(CAST, "C1001"), [
      "- @C0 = 旅人（玩家）",
      "- @C1001 = 我（林雾）",
    ]);
  });

  it("normalizeCid 去 @", () => {
    assert.equal(normalizeCid("@C0"), "C0");
    assert.equal(normalizeCid("C1001"), "C1001");
  });
});
