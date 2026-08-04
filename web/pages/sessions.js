/** 会话页：runs 列表（别名/进行中标记）→ 回放 + 读取续玩 + 重命名 + 删除。
 *  竞态收口：
 *  - 竞态 1（详情 A/B 晚到互写）：loadRun 模块级 epoch 守卫 + AbortSignal——
 *    每次进入 begin() 作废旧请求，每个 await 后 isCurrent 核验，不符即弃写；
 *    取数与渲染分离（可测纯逻辑在 web/async-guards.js 的 fetchRunDetail）；
 *  - 竞态 3（WS 未连接读档仍导航）：「读取」改 async——load_session 的 command_result
 *    （按 requestId 匹配）成功才 navigate("play")；失败（含未连接立即 reject）原页报错不导航。 */
import { api, el, navigate } from "../app.js";
import { createEpochGuard, fetchRunDetail, loadSessionThenNavigate } from "../async-guards.js";
import { sendSessionCommand } from "./play.js";

/** 详情容器请求 epoch（模块级）：快速点击 A/B 时，A 的晚到响应不得写入 B 的容器。 */
const detailGuard = createEpochGuard();
/** 详情请求 AbortController（只停无用工作；最终正确性靠 epoch 核验）。 */
let detailAbort = null;

export async function renderSessions(root) {
  root.id = "sessions";
  root.appendChild(el("h2", null, "会话"));

  const list = el("div", "list");
  const detail = el("div");
  root.append(list, detail);

  const { active, runs } = await api("/api/sessions");
  if (runs.length === 0) {
    list.appendChild(el("div", "muted", "（还没有历史会话）"));
    return;
  }
  for (const run of runs) {
    list.appendChild(makeRunRow(run, active, detail, root));
  }
}

function makeRunRow(run, activeId, detail, root) {
  const refresh = async () => {
    root.textContent = "";
    await renderSessions(root);
  };
  const row = el("div", "run-row");
  const time = new Date(run.mtimeMs).toLocaleString("zh-CN");
  const name = run.alias ?? run.id;
  const isActive = run.id === activeId;

  const btn = el("button", null, `${name} · ${time}${isActive ? " · 进行中" : ""}`);
  btn.onclick = () => loadRun(run.id, detail);

  // 重命名（行内输入）
  const rename = el("button", "act", "重命名");
  rename.onclick = () => {
    const input = document.createElement("input");
    input.type = "text";
    input.value = run.alias ?? "";
    input.placeholder = run.id;
    const ok = el("button", "act", "确定");
    const cancel = el("button", "act", "取消");
    const done = async (save) => {
      if (save) {
        try {
          await api(`/api/sessions/${run.id}/rename`, "POST", { alias: input.value.trim() || run.id });
        } catch (err) {
          alert(`重命名失败：${err.message}`);
        }
      }
      await refresh();
    };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    input.onkeydown = (e) => { if (e.key === "Enter") done(true); };
    row.textContent = "";
    row.append(input, ok, cancel);
    input.focus();
  };

  // 删除（二次确认）
  const del = el("button", "act danger", "删除");
  if (isActive) {
    del.disabled = true;
    del.title = "进行中的会话不能删除";
  }
  del.onclick = async () => {
    if (!confirm(`确定删除存档「${name}」？此操作不可恢复。`)) return;
    try {
      await api(`/api/sessions/${run.id}`, "DELETE");
      detail.textContent = "";
      await refresh();
    } catch (err) {
      alert(`删除失败：${err.message}`);
    }
  };

  // 读取续玩（竞态 3：command_result 成功才导航；失败原页报错不导航）
  const load = el("button", "act", "读取");
  load.onclick = async () => {
    load.disabled = true;
    try {
      await loadSessionThenNavigate({ sendCommand: sendSessionCommand, navigate }, run.id);
    } catch (err) {
      alert(`读取失败：${err.message}`);
    } finally {
      load.disabled = false;
    }
  };

  row.append(btn, rename, del, load);
  return row;
}

async function loadRun(id, detail) {
  const token = detailGuard.begin();
  detailAbort?.abort(); // 停掉上一请求的剩余 IO（正确性由 epoch 保证）
  const controller = new AbortController();
  detailAbort = controller;
  const apiWithSignal = (path) => api(path, "GET", undefined, { signal: controller.signal });

  detail.textContent = "";
  detail.appendChild(el("h3", null, `回放：${id}`));
  let data;
  try {
    data = await fetchRunDetail(apiWithSignal, id);
  } catch (err) {
    if (!detailGuard.isCurrent(token)) return; // 已被更新的点击接管（含 abort），弃写
    // 服务端对旧平铺档返回 404 LEGACY_RUN_UNSUPPORTED → 明确提示
    const msg =
      err.code === "LEGACY_RUN_UNSUPPORTED"
        ? "旧版存档不可回放（存档格式过旧，不迁移；请新建会话）"
        : `回放加载失败：${err.message}`;
    detail.appendChild(el("div", "line-error", msg));
    return;
  }
  if (!detailGuard.isCurrent(token)) return; // A 晚到：B 已接管容器，弃写
  renderRunDetail(detail, data);
}

/** 详情渲染（数据获取在 async-guards.fetchRunDetail，此处只画 DOM）。 */
function renderRunDetail(detail, data) {
  const { events, world, pipeline, characters, archive, stats } = data;

  detail.appendChild(el("h3", null, `事件时间线（${events.length}）`));
  const tl = el("div");
  for (const e of events) {
    tl.appendChild(el("div", "line-info", `[${e.id}] (seq ${e.seq}) ${e.payload}`));
  }
  detail.appendChild(tl);

  const time = world.time ?? {};
  const timeText = `${time.y ?? "?"}年${time.m ?? "?"}月${time.d ?? "?"}日 ${String(time.h ?? 0).padStart(2, "0")}:${String(time.min ?? 0).padStart(2, "0")}`;
  detail.appendChild(el("h3", null, "世界状态"));
  detail.appendChild(el("div", "line-info", `${timeText} · 流水线 seq ${pipeline.seq ?? 0} · phase ${pipeline.phase ?? "—"}`));
  detail.appendChild(el("pre", null, JSON.stringify(world, null, 2)));
  detail.appendChild(el("h3", null, "流水线"));
  detail.appendChild(el("pre", null, JSON.stringify(pipeline, null, 2)));

  detail.appendChild(el("h3", null, "角色（characters.json）"));
  detail.appendChild(el("pre", null, JSON.stringify(characters, null, 2)));

  detail.appendChild(el("h3", null, `归档（${archive.length} 步）`));
  const al = el("div");
  for (const a of archive) {
    al.appendChild(el("div", "line-info", `seq ${a.seq} · ${a.kind}${a.edited ? " · 已编辑" : ""}`));
  }
  detail.appendChild(al);

  detail.appendChild(el("h3", null, `缓存统计（${stats.length} 次调用）`));
  if (stats.length > 0) {
    const table = el("table");
    table.innerHTML = "<tr><th>轮</th><th>agent</th><th>hit</th><th>miss</th><th>命中率</th><th>output</th></tr>";
    for (const s of stats) {
      const total = s.hit + s.miss;
      const ratio = total > 0 ? ((s.hit / total) * 100).toFixed(1) + "%" : "—";
      const tr = el("tr");
      for (const cell of [s.turn, s.agent, s.hit, s.miss, ratio, s.output]) {
        tr.appendChild(el("td", null, String(cell)));
      }
      table.appendChild(tr);
    }
    detail.appendChild(table);
  }
}
