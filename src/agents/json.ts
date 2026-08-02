/**
 * 从 LLM 输出中提取 JSON 对象（容忍 ```json 围栏与前后杂谈）。
 * 找不到对象时抛错，由调用方走重试。
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1]! : text;

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`LLM 输出中找不到 JSON 对象: ${text.slice(0, 200)}`);
  }
  return JSON.parse(candidate.slice(start, end + 1));
}
