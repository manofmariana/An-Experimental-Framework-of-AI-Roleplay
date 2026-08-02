/** 配置页：顶层 api_key/base_url/model/json_mode/reasoning_effort + 三个 agent 覆盖块；保存 PUT /api/config。 */
import { api, el } from "../app.js";

const AGENT_LABELS = { character: "角色", gm: "GM", prose: "正文" };
const TEXT_KEYS = ["api_key", "base_url", "model", "reasoning_effort"];

export async function renderConfig(root) {
  root.appendChild(el("h2", null, "配置"));
  root.appendChild(el("div", "muted", "保存后立即生效（无需新会话）。环境变量 DEEPSEEK_API_KEY 等优先于此处顶层配置。"));

  const config = await api("/api/config");
  const inputs = { top: {}, agents: {} };

  const field = (parent, store, key, label, isPassword) => {
    const wrap = el("label", "field");
    wrap.appendChild(el("span", null, label));
    const input = document.createElement("input");
    input.type = isPassword ? "password" : "text";
    input.value = store[key] ?? "";
    input.placeholder = isPassword ? "留空 = 回落顶层" : "留空 = 回落顶层/默认";
    wrap.appendChild(input);
    parent.appendChild(wrap);
    return input;
  };

  // json_mode 三态下拉：留空 = 回落顶层/默认 false；true/false = 显式覆盖
  const jsonModeField = (parent, value) => {
    const wrap = el("label", "field");
    wrap.appendChild(el("span", null, "json_mode（JSON 输出）"));
    const select = document.createElement("select");
    for (const [v, label] of [["", "留空 = 回落顶层/默认关"], ["true", "开"], ["false", "关"]]) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = label;
      select.appendChild(opt);
    }
    select.value = value === true ? "true" : value === false ? "false" : "";
    wrap.appendChild(select);
    parent.appendChild(wrap);
    return select;
  };

  root.appendChild(el("h3", null, "顶层（三个 agent 的公共默认）"));
  inputs.top.api_key = field(root, config, "api_key", "api_key", true);
  inputs.top.base_url = field(root, config, "base_url", "base_url");
  inputs.top.model = field(root, config, "model", "model");
  inputs.top.reasoning_effort = field(root, config, "reasoning_effort", "reasoning_effort（思考强度，如 low/medium/high）");
  inputs.top.json_mode = jsonModeField(root, config.json_mode);

  // GM 硬保险间隔（M2-b §5.1）：≥1 整数，留空 = 默认 3
  const gmIntervalWrap = el("label", "field");
  gmIntervalWrap.appendChild(el("span", null, "GM 强制间隔（行动周期数）"));
  const gmIntervalInput = document.createElement("input");
  gmIntervalInput.type = "number";
  gmIntervalInput.min = "1";
  gmIntervalInput.step = "1";
  gmIntervalInput.placeholder = "留空 = 默认 3";
  gmIntervalInput.value = config.gm_interval_cycles ?? "";
  gmIntervalWrap.appendChild(gmIntervalInput);
  root.appendChild(gmIntervalWrap);

  const agents = config.agents ?? {};
  for (const kind of ["character", "gm", "prose"]) {
    root.appendChild(el("h3", null, `${AGENT_LABELS[kind]}（agents.${kind}，可选覆盖）`));
    const block = agents[kind] ?? {};
    inputs.agents[kind] = {
      api_key: field(root, block, "api_key", "api_key", true),
      base_url: field(root, block, "base_url", "base_url"),
      model: field(root, block, "model", "model"),
      reasoning_effort: field(root, block, "reasoning_effort", "reasoning_effort"),
      json_mode: jsonModeField(root, block.json_mode),
    };
  }

  const save = el("button", "act", "保存配置");
  const status = el("span", "muted");
  save.onclick = async () => {
    status.textContent = "";
    // 保留原文件里的未知字段（如 _说明 注释）
    const next = { ...config };
    for (const key of TEXT_KEYS) {
      const v = inputs.top[key].value.trim();
      if (v) next[key] = v;
      else delete next[key];
    }
    // json_mode：三态下拉，留空 = 删除（回落默认 false）
    if (inputs.top.json_mode.value === "") delete next.json_mode;
    else next.json_mode = inputs.top.json_mode.value === "true";
    // gm_interval_cycles：留空删除（回落默认 3）；非法值直接拒绝，不发请求
    const gmInterval = gmIntervalInput.value.trim();
    if (gmInterval === "") {
      delete next.gm_interval_cycles;
    } else {
      const n = Number(gmInterval);
      if (!Number.isInteger(n) || n < 1) {
        status.textContent = " 保存失败：GM 强制间隔必须是 ≥1 的整数";
        return;
      }
      next.gm_interval_cycles = n;
    }
    const nextAgents = {};
    for (const kind of ["character", "gm", "prose"]) {
      const block = {};
      for (const key of TEXT_KEYS) {
        const v = inputs.agents[kind][key].value.trim();
        if (v) block[key] = v;
      }
      if (inputs.agents[kind].json_mode.value !== "") {
        block.json_mode = inputs.agents[kind].json_mode.value === "true";
      }
      if (Object.keys(block).length > 0) nextAgents[kind] = block;
    }
    if (Object.keys(nextAgents).length > 0) next.agents = nextAgents;
    else delete next.agents;
    try {
      const resp = await api("/api/config", "PUT", next);
      status.textContent = ` ${resp.note}`;
    } catch (err) {
      status.textContent = ` 保存失败：${err.message}`;
    }
  };
  root.append(el("div"), save, status);
}
