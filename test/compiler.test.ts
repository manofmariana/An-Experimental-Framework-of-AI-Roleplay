import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compilePrompt,
  placeholderCatalog,
  type PlaceholderRegistry,
} from "../src/compile/compiler.js";
import type { PromptTemplate } from "../src/compile/template.js";

interface Ctx {
  name: string;
  events: string[];
}

const registry: PlaceholderRegistry<Ctx> = {
  name: { description: "名字", provide: (c) => c.name },
  events: { description: "事件行", provide: (c) => c.events.join("\n") },
  empty: { description: "恒空", provide: () => "" },
};

const ctx: Ctx = { name: "林雾", events: ["事件一", "事件二"] };

function tpl(modules: PromptTemplate["modules"]): PromptTemplate {
  return { id: "test", modules };
}

describe("compilePrompt（纯渲染器：模板 × 注册表 × 上下文 → 消息数组）", () => {
  it("按模块顺序渲染，每模块一条消息并带模块的 role", () => {
    const messages = compilePrompt(
      tpl([
        { key: "a", role: "system", content: "协议 {{name}}" },
        { key: "b", role: "system", content: "{{events}}" },
        { key: "c", role: "user", content: "收尾" },
      ]),
      registry,
      ctx,
    );
    assert.deepEqual(messages, [
      { role: "system", content: "协议 林雾" },
      { role: "system", content: "事件一\n事件二" },
      { role: "user", content: "收尾" },
    ]);
  });

  it("渲染后 content 为空的模块整条丢弃", () => {
    const messages = compilePrompt(
      tpl([
        { key: "a", role: "system", content: "{{empty}}" },
        { key: "b", role: "user", content: "  \n " },
        { key: "c", role: "system", content: "留下 {{name}}" },
      ]),
      registry,
      ctx,
    );
    assert.deepEqual(messages, [{ role: "system", content: "留下 林雾" }]);
  });

  it("时间戳/轮次等内容不再被拦截（禁令已取消，时间地点经占位符注入）", () => {
    const messages = compilePrompt(
      tpl([{ key: "a", role: "system", content: "时间：世界时间 T=42" }]),
      registry,
      ctx,
    );
    assert.equal(messages[0]!.content, "时间：世界时间 T=42");
  });

  it("单花括号 JSON 示例不被当作占位符", () => {
    const messages = compilePrompt(
      tpl([{ key: "a", role: "user", content: '{"dialogue": "..."} 与 {{name}}' }]),
      registry,
      ctx,
    );
    assert.equal(messages[0]!.content, '{"dialogue": "..."} 与 林雾');
  });
});

describe("placeholderCatalog（注册表 → 占位符目录）", () => {
  it("导出 key + description", () => {
    assert.deepEqual(placeholderCatalog(registry), [
      { key: "name", description: "名字" },
      { key: "events", description: "事件行" },
      { key: "empty", description: "恒空" },
    ]);
  });
});
