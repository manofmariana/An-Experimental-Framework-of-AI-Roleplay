/**
 * 提示词页：三个模板（character/gm/prose）切换 + 模块列表编辑
 * （新增/删除/上下排序/key/role 下拉/content 多行）+ 右侧可用占位符目录。
 * 保存 = PUT 整体替换 modules；未知占位符由 API 400 返回并展示。
 */
import { api, el } from "../app.js";

const AGENT_LABELS = { character: "角色", gm: "GM", prose: "正文" };
const ROLES = ["system", "user", "assistant"];

export async function renderPrompts(root) {
  root.id = "prompts";
  root.appendChild(el("h2", null, "提示词模板"));
  root.appendChild(
    el("div", "muted", "保存后下一轮对话生效（模板每轮激活前热加载）。动态内容（事件/场景/正文窗）建议放尾部模块——缓存友好是编辑约定。"),
  );

  const [templates, catalog] = await Promise.all([
    api("/api/prompts"),
    api("/api/prompts/placeholders"),
  ]);

  const tabs = el("div", "prompt-tabs");
  const layout = el("div", "prompt-editor");
  const listEl = el("div", "module-list");
  const side = el("div", "placeholder-side");
  layout.append(listEl, side);
  root.append(tabs, layout);

  let currentAgent = "character";

  const renderSide = (agent) => {
    side.textContent = "";
    side.appendChild(el("h3", null, "可用占位符"));
    const entry = catalog.find((c) => c.agent === agent);
    for (const p of entry?.placeholders ?? []) {
      const row = el("div", "placeholder-row");
      row.appendChild(el("code", null, `{{${p.key}}}`));
      row.appendChild(el("span", "muted", p.description));
      side.appendChild(row);
    }
  };

  /** DOM → modules 数据（排序/删除/保存前先同步一次） */
  const readRows = () => {
    const modules = [];
    for (const row of listEl.querySelectorAll(".module-row")) {
      modules.push({
        key: row.querySelector(".mod-key").value.trim(),
        role: row.querySelector(".mod-role").value,
        content: row.querySelector(".mod-content").value,
      });
    }
    return modules;
  };

  const renderList = (modules) => {
    listEl.textContent = "";
    modules.forEach((mod, i) => {
      const row = el("div", "module-row");

      const head = el("div", "module-head");
      const keyIn = document.createElement("input");
      keyIn.className = "mod-key";
      keyIn.type = "text";
      keyIn.value = mod.key;
      keyIn.placeholder = "模块 key";
      const roleSel = document.createElement("select");
      roleSel.className = "mod-role";
      for (const r of ROLES) {
        const opt = el("option", null, r);
        opt.value = r;
        if (r === mod.role) opt.selected = true;
        roleSel.appendChild(opt);
      }
      const up = el("button", "act", "↑");
      up.disabled = i === 0;
      up.title = "上移";
      up.onclick = () => {
        const m = readRows();
        [m[i - 1], m[i]] = [m[i], m[i - 1]];
        renderList(m);
      };
      const down = el("button", "act", "↓");
      down.disabled = i === modules.length - 1;
      down.title = "下移";
      down.onclick = () => {
        const m = readRows();
        [m[i], m[i + 1]] = [m[i + 1], m[i]];
        renderList(m);
      };
      const del = el("button", "act danger", "删");
      del.onclick = () => {
        const m = readRows();
        m.splice(i, 1);
        renderList(m);
      };
      head.append(keyIn, roleSel, up, down, del);

      const ta = el("textarea", "mod-content");
      ta.rows = 8;
      ta.value = mod.content;

      row.append(head, ta);
      listEl.appendChild(row);
    });

    const addBtn = el("button", "act", "新增模块");
    addBtn.onclick = () => {
      const m = readRows();
      m.push({ key: "new_module", role: "system", content: "" });
      renderList(m);
    };
    const saveBtn = el("button", "act", "保存模板");
    const status = el("span", "muted");
    saveBtn.onclick = async () => {
      status.textContent = "";
      status.className = "muted";
      try {
        const resp = await api(`/api/prompts/${currentAgent}`, "PUT", {
          id: currentAgent,
          modules: readRows(),
        });
        status.textContent = ` ${resp.note}`;
      } catch (err) {
        status.className = "line-error";
        status.textContent = ` 保存失败：${err.message}`;
      }
    };
    listEl.append(el("div", "module-actions"), addBtn, saveBtn, status);
  };

  const switchAgent = (agent) => {
    currentAgent = agent;
    for (const b of tabs.querySelectorAll("button")) {
      b.classList.toggle("active", b.dataset.agent === agent);
    }
    const t = templates.find((tpl) => tpl.id === agent);
    renderList(structuredClone(t.modules));
    renderSide(agent);
  };

  for (const agent of ["character", "gm", "prose"]) {
    const b = el("button", null, AGENT_LABELS[agent] ?? agent);
    b.dataset.agent = agent;
    b.onclick = () => switchAgent(agent);
    tabs.appendChild(b);
  }
  switchAgent("character");
}
