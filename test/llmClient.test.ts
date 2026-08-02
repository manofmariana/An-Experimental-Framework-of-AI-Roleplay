import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRequestParams, extractReasoningContent, type ChatMessage } from "../src/llm/client.js";

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "s" },
  { role: "user", content: "u" },
];

describe("buildRequestParams（请求参数组装，纯函数）", () => {
  it("jsonMode off 且无 reasoningEffort：只有基础字段", () => {
    const params = buildRequestParams(
      { model: "deepseek-chat", jsonMode: false },
      MESSAGES,
      false,
    );
    assert.deepEqual(params, {
      model: "deepseek-chat",
      messages: MESSAGES,
      temperature: 0.7,
    });
  });

  it("jsonMode on：注入 response_format json_object", () => {
    const params = buildRequestParams(
      { model: "deepseek-chat", jsonMode: true },
      MESSAGES,
      false,
    );
    assert.deepEqual(params.response_format, { type: "json_object" });
  });

  it("reasoningEffort 有值时原样透传（不锁枚举）", () => {
    const params = buildRequestParams(
      { model: "deepseek-reasoner", jsonMode: false, reasoningEffort: "minimal" },
      MESSAGES,
      false,
    );
    assert.equal(params.reasoning_effort, "minimal");
  });

  it("stream=true：带 stream 与 stream_options.include_usage；stream=false 两者都不出现", () => {
    const streaming = buildRequestParams(
      { model: "m", jsonMode: false },
      MESSAGES,
      true,
    );
    assert.equal(streaming.stream, true);
    assert.deepEqual(streaming.stream_options, { include_usage: true });

    const once = buildRequestParams({ model: "m", jsonMode: false }, MESSAGES, false);
    assert.equal("stream" in once, false);
    assert.equal("stream_options" in once, false);
  });
});

describe("extractReasoningContent（思维链字段安全提取）", () => {
  it("delta/message 含 reasoning_content 字符串时读出", () => {
    assert.equal(extractReasoningContent({ reasoning_content: "让我想想……" }), "让我想想……");
    assert.equal(
      extractReasoningContent({ content: "正文", reasoning_content: "思考" }),
      "思考",
    );
  });

  it("非推理模型（无该字段 / null / 非字符串）一律得空串，不报错", () => {
    assert.equal(extractReasoningContent({ content: "正文" }), "");
    assert.equal(extractReasoningContent({ reasoning_content: null }), "");
    assert.equal(extractReasoningContent({ reasoning_content: 42 }), "");
    assert.equal(extractReasoningContent(undefined), "");
    assert.equal(extractReasoningContent(null), "");
    assert.equal(extractReasoningContent("raw string"), "");
  });
});
