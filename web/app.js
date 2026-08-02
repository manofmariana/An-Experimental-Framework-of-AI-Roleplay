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

/** GET/PUT JSON 助手；服务端返回 {error} 时抛错。 */
export async function api(path, method = "GET", body) {
  const resp = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json();
  if (!resp.ok || (data && typeof data === "object" && "error" in data)) {
    throw new Error(data?.error ?? `HTTP ${resp.status}`);
  }
  return data;
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

/** 页签切换（页内跳转用，如会话页「读取」后跳游玩页）。 */
export async function navigate(name) {
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
    container.appendChild(el("div", "line-error", `加载失败：${err.message}`));
  }
}

document.getElementById("side").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-page]");
  if (btn) navigate(btn.dataset.page);
});

navigate("play");
