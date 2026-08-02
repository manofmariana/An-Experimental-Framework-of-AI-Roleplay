/** 会话页：runs 列表（别名/进行中标记）→ 回放 + 读取续玩 + 重命名 + 删除。 */
import { api, el, navigate } from "../app.js";
import { loadSession } from "./play.js";

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

  // 读取续玩
  const load = el("button", "act", "读取");
  load.onclick = () => {
    loadSession(run.id);
    navigate("play");
  };

  row.append(btn, rename, del, load);
  return row;
}

async function loadRun(id, detail) {
  detail.textContent = "";
  detail.appendChild(el("h3", null, `回放：${id}`));
  const [events, world, characters, archive, stats] = await Promise.all([
    api(`/api/sessions/${id}/events`),
    api(`/api/sessions/${id}/world`),
    api(`/api/sessions/${id}/characters`),
    api(`/api/sessions/${id}/archive`),
    api(`/api/sessions/${id}/stats`),
  ]);

  const eventList = events.events ?? [];
  detail.appendChild(el("h3", null, `事件时间线（${eventList.length}）`));
  const tl = el("div");
  for (const e of eventList) {
    tl.appendChild(el("div", "line-info", `[${e.id}] (seq ${e.seq}) ${e.payload}`));
  }
  detail.appendChild(tl);

  const pipeline = world.pipeline ?? {};
  const time = world.world?.time ?? {};
  const timeText = `${time.y ?? "?"}年${time.m ?? "?"}月${time.d ?? "?"}日 ${String(time.h ?? 0).padStart(2, "0")}:${String(time.min ?? 0).padStart(2, "0")}`;
  detail.appendChild(el("h3", null, "世界状态"));
  detail.appendChild(el("div", "line-info", `${timeText} · 流水线 seq ${pipeline.seq ?? 0} · phase ${pipeline.phase ?? "—"}`));
  detail.appendChild(el("pre", null, JSON.stringify(world.world ?? {}, null, 2)));
  detail.appendChild(el("h3", null, "流水线"));
  detail.appendChild(el("pre", null, JSON.stringify(pipeline, null, 2)));

  detail.appendChild(el("h3", null, "角色（characters.json）"));
  detail.appendChild(el("pre", null, JSON.stringify(characters.characters ?? {}, null, 2)));

  const archiveEntries = archive.entries ?? [];
  detail.appendChild(el("h3", null, `归档（${archiveEntries.length} 步）`));
  const al = el("div");
  for (const a of archiveEntries) {
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
