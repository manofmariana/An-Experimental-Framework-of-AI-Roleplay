/** 角色页：世界包选择器 + 统一 manifest 字段与结构化 location 编辑。
 *  ResourceContext：打开即捕获不可变 ctx
 *  （GET/PUT 全程携带 ?set=——修复「无法编辑非默认包」）；切换包 = 重新捕获 ctx + 重载列表；
 *  保存写打开时捕获的同一 ctx，不重读 picker；界面上持续显示「正在编辑」的包名。 */
import { api, el } from "../app.js";
import { createResourceContext } from "../resource-context.js";

export async function renderCharacters(root) {
  root.appendChild(el("h2", null, "角色"));
  const { sets } = await api("/api/worlds");
  if (!sets || sets.length === 0) {
    root.appendChild(el("div", "muted", "（没有可用的世界设定集）"));
    return;
  }

  // 世界包选择器（数据源 = /api/worlds 列表端点）
  const bar = el("div", "world-set-bar");
  bar.appendChild(el("span", "muted", "世界包："));
  const setPicker = el("select");
  for (const s of sets) {
    const opt = el("option", null, s);
    opt.value = s;
    setPicker.appendChild(opt);
  }
  const editing = el("span", "muted");
  bar.append(setPicker, editing);
  const host = el("div");
  root.append(bar, host);

  const load = async (setId) => {
    const ctx = createResourceContext({ worldSetId: setId }); // 捕获即不可变
    editing.textContent = `　正在编辑：${ctx.worldSetId}`;
    host.textContent = "";
    await renderSetCharacters(host, ctx);
  };
  setPicker.onchange = () => {
    load(setPicker.value).catch((err) => {
      host.textContent = "";
      host.appendChild(el("div", "line-error", `加载失败：${err.message}`));
    });
  };
  await load(setPicker.value);
}

/** 指定包的角色列表 + 编辑表单；所有 URL 经捕获的 ctx 构造。 */
async function renderSetCharacters(host, ctx) {
  const list = await api(ctx.charactersUrl());
  if (list.length === 0) {
    host.appendChild(el("div", "muted", "（该世界包没有角色）"));
    return;
  }
  const picker = el("select");
  for (const item of list) { const option = el("option", null, `${item.manifest.name}（${item.id}）`); option.value = item.id; picker.appendChild(option); }
  host.appendChild(picker);
  const formHost = el("div"); host.appendChild(formHost);

  const renderForm = (id) => {
    const source = list.find((item) => item.id === id)?.manifest; formHost.textContent = ""; if (!source) return;
    const fields = {};
    const add = (key, label, multiline = false) => {
      const wrap = el("label", "field"); wrap.appendChild(el("span", null, label));
      const input = multiline ? el("textarea") : document.createElement("input"); if (!multiline) input.type = "text";
      const value = source[key]; input.value = Array.isArray(value) ? value.join("\n") : String(value ?? "");
      if (multiline) input.rows = 4; if (key === "id") input.disabled = true;
      wrap.appendChild(input); formHost.appendChild(wrap); fields[key] = input;
    };
    add("id", "ID"); add("name", "名字"); add("gender", "性别"); add("age", "年龄（字符串）"); add("personality", "性格（1-2句）", true);
    add("locationName", "初始地点名"); fields.locationName.value = source.location?.name ?? "";
    add("locationLevel", "地点等级"); fields.locationLevel.value = String(source.location?.level ?? 1);
    add("timer", "初始 timer 偏移（分钟；留空为 null）"); add("reaction", "反应"); add("level", "角色等级");
    add("attachtags", "固定标签（每行：名称 或 名称,等级）", true); add("initial_memories", "初始记忆（每行一条）", true);
    // 固有 TAG 读写 vars.attachtags（数组即末端值简写）；level 缺省/非法一律归 1
    fields.attachtags.value = (source.vars?.attachtags ?? []).map((t) => (t.level === 1 ? t.name : `${t.name},${t.level}`)).join("\n");
    const save = el("button", "act", "保存"); const status = el("span", "muted");
    save.onclick = async () => {
      const lines = (key) => fields[key].value.split("\n").map((value) => value.trim()).filter(Boolean);
      const attachtags = lines("attachtags").flatMap((line) => {
        const [name, lv] = line.split(",").map((s) => s.trim());
        if (!name) return [];
        const level = Number(lv);
        return [{ name, level: Number.isInteger(level) && level >= 1 && level <= 7 ? level : 1 }];
      });
      const { tags: _legacyTags, ...base } = source; // 顶层 tags 已废除，不进 payload
      const manifest = {
        ...base, id, name: fields.name.value.trim(), gender: fields.gender.value.trim(), age: fields.age.value.trim(),
        personality: fields.personality.value.trim(), location: { name: fields.locationName.value.trim(), level: Number(fields.locationLevel.value) || 1 },
        timer: fields.timer.value.trim() === "" ? null : Number(fields.timer.value), reaction: Number(fields.reaction.value) || 0,
        level: Number(fields.level.value) || 1, initial_memories: lines("initial_memories"), relations: source.relations ?? [],
        vars: { ...(source.vars ?? {}), attachtags },
      };
      try { const response = await api(ctx.characterUrl(id), "PUT", manifest); status.textContent = ` ${response.note}`; }
      catch (error) { status.textContent = ` 保存失败：${error.message}`; }
    };
    formHost.append(save, status);
  };
  picker.onchange = () => renderForm(picker.value); renderForm(list[0].id);
}
