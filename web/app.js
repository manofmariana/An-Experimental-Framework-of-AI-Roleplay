/**
 * Agent-AIRP WebUI 入口：页签路由 + 共用 fetch 助手。
 * 「游玩」页常驻（DOM 不销毁，流式追加不中断），其余页签每次激活重渲染。
 */
import { renderPlay } from "./pages/play.js";
import { renderSessions } from "./pages/sessions.js";
import { renderCharacters } from "./pages/characters.js";
import { renderWorld } from "./pages/world.js";
import { renderPrompts } from "./pages/prompts.js";
import { renderConfig } from "./pages/config.js";

/** GET/PUT JSON 助手：解包 D3 envelope——成功返回 data，失败抛 Error（带 .code 稳定错误码）。
 *  D4：支持 AbortSignal（第 4 参或 options.signal）；信号只停止无用工作，最终正确性靠
 *  调用方的 epoch/身份检查（navigate 已带路由 epoch）。 */
export async function api(path, method = "GET", body, options = {}) {
  const resp = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: options.signal,
  });
  const payload = await resp.json();
  if (!resp.ok || (payload && typeof payload === "object" && payload.ok === false)) {
    const err = new Error(payload?.error?.message ?? `HTTP ${resp.status}`);
    err.code = payload?.error?.code;
    throw err;
  }
  return payload?.data;
}

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const renderers = {
  play: renderPlay,
  sessions: renderSessions,
  characters: renderCharacters,
  world: renderWorld,
  prompts: renderPrompts,
  config: renderConfig,
};

const content = document.getElementById("content");
let playContainer = null; // 游玩页常驻
/** 路由 epoch（D4）：每次导航 ++epoch；renderer await 完成后 epoch 不符 → 结果丢弃，
 *  快速切页时旧页的晚到渲染/错误不落到新页容器。 */
let routeEpoch = 0;

/** 页签切换（页内跳转用，如会话页「读取」后跳游玩页）。 */
export async function navigate(name) {
  const epoch = ++routeEpoch;
  for (const btn of document.querySelectorAll("#side button")) {
    btn.classList.toggle("active", btn.dataset.page === name);
  }
  content.textContent = "";
  if (name === "play") {
    if (!playContainer) playContainer = renderPlay();
    content.appendChild(playContainer);
    return;
  }
  const container = el("div");
  content.appendChild(container);
  try {
    await renderers[name](container);
  } catch (err) {
    if (routeEpoch !== epoch) return; // 旧导航的晚到错误不显示为新页错误
    container.appendChild(el("div", "line-error", `加载失败：${err.message}`));
  }
}

document.getElementById("side").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-page]");
  if (btn) navigate(btn.dataset.page);
});

navigate("play");
