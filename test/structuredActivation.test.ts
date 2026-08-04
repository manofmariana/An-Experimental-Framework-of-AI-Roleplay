import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runStructuredActivation } from "../src/agents/structuredActivation.js";
import type { Display } from "../src/display.js";
import { LLMAbortedError, type ChatPort, type ChatRequest, type ChatResult } from "../src/llm/chatPort.js";

class ScriptedChatPort implements ChatPort {
  calls: ChatRequest[] = [];
  constructor(private script: Array<ChatResult | Error>) {}
  async chat(request: ChatRequest): Promise<ChatResult> {
    this.calls.push(request);
    const next = this.script.shift();
    if (next === undefined) throw new Error("脚本耗尽");
    if (next instanceof Error) throw next;
    return next;
  }
}
const result = (text: string): ChatResult => ({ text, reasoning: "", usage: { hit: 0, miss: 0, output: 0 } });
const messages = [{ role: "user" as const, content: "hi" }];
const signal = new AbortController().signal;

function makeDisplay() {
  const retries: Array<[string, number, string]> = [];
  const deltas: string[] = [];
  const reasoningDeltas: string[] = [];
  const display: Display = {
    agentStart() {}, delta(_agent, text) { deltas.push(text); }, reasoningDelta(_agent, text) { reasoningDeltas.push(text); },
    agentEnd() {}, summary() {}, retry(agent, attempt, reason) { retries.push([agent, attempt, reason]); },
  };
  return { display, retries, deltas, reasoningDeltas };
}

describe("runStructuredActivation", () => {
  it("解析成功：一次调用返回 raw + pkg", async () => {
    const port = new ScriptedChatPort([result("ok")]);
    const { raw, pkg } = await runStructuredActivation<number>({
      port, agentName: "gm", seq: 3, messages, signal,
      parse: (text) => { assert.equal(text, "ok"); return 42; },
      failureLabel: "X 解析失败",
    });
    assert.equal(raw, "ok"); assert.equal(pkg, 42); assert.equal(port.calls.length, 1);
  });

  it("解析失败→display.retry 通知→重试成功", async () => {
    const port = new ScriptedChatPort([result("bad"), result("good")]);
    const { display, retries } = makeDisplay();
    const { raw, pkg } = await runStructuredActivation<string>({
      port, agentName: "character:C1001", seq: 1, messages, signal, display,
      parse: (text) => { if (text === "bad") throw new Error("schema 不符"); return text; },
      failureLabel: "X 解析失败",
    });
    assert.equal(raw, "good"); assert.equal(pkg, "good"); assert.equal(port.calls.length, 2);
    assert.deepEqual(retries, [["character:C1001", 1, "schema 不符"]]);
  });

  it("两次都失败→抛带 failureLabel 的错误（含原文与 cause），不再第三次调用", async () => {
    const port = new ScriptedChatPort([result("bad1"), result("bad2")]);
    const { display, retries } = makeDisplay();
    await assert.rejects(
      runStructuredActivation<string>({
        port, agentName: "gm", seq: 2, messages, signal, display,
        parse: () => { throw new Error("语义校验失败"); },
        failureLabel: "GM 裁决包解析失败",
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.startsWith("GM 裁决包解析失败（重试后仍失败）。原文：\nbad2"));
        assert.ok(error.cause instanceof Error && error.cause.message === "语义校验失败");
        return true;
      },
    );
    assert.equal(port.calls.length, 2);
    assert.equal(retries.length, 1);
  });

  it("LLMAbortedError（chat 抛出）→不重试直接上抛", async () => {
    const aborted = new LLMAbortedError("部分文本", "");
    const port = new ScriptedChatPort([aborted]);
    const { display, retries } = makeDisplay();
    await assert.rejects(
      runStructuredActivation<string>({
        port, agentName: "gm", seq: 1, messages, signal, display,
        parse: (text) => text, failureLabel: "X",
      }),
      (error: unknown) => error === aborted,
    );
    assert.equal(port.calls.length, 1);
    assert.equal(retries.length, 0);
  });

  it("parse 抛出 LLMAbortedError 同样不重试直接上抛", async () => {
    const aborted = new LLMAbortedError("", "");
    const port = new ScriptedChatPort([result("x")]);
    await assert.rejects(
      runStructuredActivation<string>({
        port, agentName: "gm", seq: 1, messages, signal,
        parse: () => { throw aborted; }, failureLabel: "X",
      }),
      (error: unknown) => error === aborted,
    );
    assert.equal(port.calls.length, 1);
  });

  it("流式回调透传：有 display 时注入 onDelta/onReasoningDelta；无 display 时不注入", async () => {
    const port = new ScriptedChatPort([result("ok")]);
    const { display } = makeDisplay();
    await runStructuredActivation<string>({
      port, agentName: "prose", seq: 1, messages, signal, display,
      parse: (text) => text, failureLabel: "X",
    });
    const withDisplay = port.calls[0]!;
    assert.equal(typeof withDisplay.onDelta, "function");
    assert.equal(typeof withDisplay.onReasoningDelta, "function");

    const quiet = new ScriptedChatPort([result("ok")]);
    await runStructuredActivation<string>({
      port: quiet, agentName: "prose", seq: 1, messages, signal,
      parse: (text) => text, failureLabel: "X",
    });
    const withoutDisplay = quiet.calls[0]!;
    assert.equal("onDelta" in withoutDisplay, false);
    assert.equal("onReasoningDelta" in withoutDisplay, false);
  });

  it("重试携带首次校验错误：第二次调用 messages 尾部追加错误 + 重新输出指引（首次 messages 不变）", async () => {
    const port = new ScriptedChatPort([result("bad"), result("good")]);
    const { pkg } = await runStructuredActivation<string>({
      port, agentName: "gm", seq: 1, messages, signal,
      parse: (text) => { if (text === "bad") throw new Error("timer cid 必须精确覆盖"); return text; },
      failureLabel: "X 解析失败",
    });
    assert.equal(pkg, "good");
    assert.equal(port.calls.length, 2);
    assert.equal(port.calls[0]!.messages, messages, "首次调用 messages 原样（同引用，无追加）");
    const retryMessages = port.calls[1]!.messages;
    assert.notEqual(retryMessages, messages, "重试不突变入参数组");
    assert.equal(retryMessages.length, messages.length + 1);
    assert.deepEqual(retryMessages.slice(0, messages.length), messages, "重试保留原 messages 前缀");
    const tail = retryMessages[retryMessages.length - 1]!;
    assert.equal(tail.role, "user");
    assert.ok(tail.content.includes("timer cid 必须精确覆盖"), "尾部消息携带首次校验错误");
    assert.ok(tail.content.includes("重新输出"), "尾部消息含重新输出指引");
  });

  it("agent/seq/messages 原样透传给 ChatPort", async () => {
    const port = new ScriptedChatPort([result("ok")]);
    await runStructuredActivation<string>({
      port, agentName: "character:C1002", seq: 7, messages, signal,
      parse: (text) => text, failureLabel: "X",
    });
    assert.equal(port.calls[0]!.agent, "character:C1002");
    assert.equal(port.calls[0]!.seq, 7);
    assert.equal(port.calls[0]!.messages, messages);
  });
});
