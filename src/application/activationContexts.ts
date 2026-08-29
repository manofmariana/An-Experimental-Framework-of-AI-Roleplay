/**
 * 内容源投影层（收编原 activation 上下文构建器）：
 * 三个无状态 activation 的全部注入内容在这里从**最新真相 + 派生投影现算**——
 * 每次渲染读 live stores 的只读数据（恒冻结保证不被误写），无任何跨调用缓存：
 * - cast 每次现建（动态改名/增角色后下一次渲染直接读到最新）；
 * - lore 逐次从 loreStore 档内副本读取（运行期可编辑，必须读到最新）。
 *
 * 投影 = RenderHost 实现（引擎只感知该接口）：占位符定义读者无关，取数范围由本层按
 * 读者供给，同一 source 跨对象复用。落盘四根（events/lores/characters/world）全量供给
 * （仅两处取数范围截取：prose 读者的事件滑窗 = 供给窗口截取，不是过滤；prose 读者的
 * lores = 本轮参与者触发集，保正文 lore 触发制语义），TAG 过滤统一收进引擎逐末端求值。
 * TAG 过滤上下文（四根/working_set 同一读者口径）：角色读者有效 TAG 集 =
 * 落盘池（vars tags 池纯名集）∪ 程序派生（自身 cid 恒在、当前地点名、当前频道编号、
 * 工具 AV 临时挂载）+ 全知权重（omniscience 系统字段），开放类别实例 = cid/channel/
 * location 三类（命中归一化为类别记号）；GM/正文 = 权重 6 + 持强制全知。characters 根
 * 全量遍历（一切读者同一取数范围；每角色 = 系统分支投影 + vars 树），world/characters
 * 两根供给前做 vars-tags 附加的读取期合并（cid 类按属主分发、不物化进实例值），对
 * appearance=false 角色的全部末端虚拟挂载
 * {fappear, 6 级}（不落盘、不污染 TAG 池）。working_set 源 = 抓取层同值批隔离 +
 * 逐条目 TAG 过滤（言行条目挂载按焊死映射渲染时派生；通知条目挂载随条目携带；
 * 自己的条目恒可见；指令条目不过本通道——god_directive/writing_directive 两组装源
 * 按读者轴直接供给：god 仅 GM、writing 仅正文、角色恒空，文本原样透传不过 TAG 求值）。
 * 身份替换 = 组装后处理统一出口（renderIdentity：角色 =
 * renderForReader/renderRefsForReader；GM = refs 渲染、事件保持 @ID 原文；正文 =
 * renderForGm 演员表渲染、refs 保持原文）；events 根 string 末端由引擎过 cid 模式。
 *
 * 旧 run 在途 activation 完成结果的丢弃（消息身份 runId/activationId/epoch）
 * 不在本文件范围，由 SessionCoordinator 会话隔离负责（见 sessionCoordinator.ts 注释）。
 */
import type { AssembledSource } from "../compile/placeholders.js";
import type {
  IdentityMode,
  RenderHost,
  ReaderRef,
  SourceEntry,
  VarsView,
} from "../compile/render.js";
import type { IncidentHit } from "../scheduler/incident.js";
import { groupLocation } from "../scheduler/simulator.js";
import { FAPPEAR_LEVEL, FAPPEAR_TAG, FORCE_OMNISCIENT_TAG, type TagCategory } from "../tags/registry.js";
import { evaluateTagFilter, MAX_OMNISCIENCE_WEIGHT, type ReaderScope } from "../tags/evaluate.js";
import type { CharacterState } from "../truth/charactersStore.js";
import {
  buildCastLines,
  renderForGm,
  renderForReader,
  renderRefsForGm,
  renderRefsForReader,
  type CastMember,
} from "../truth/identity.js";
import { snapshotCharacterState, snapshotCharacterStates } from "../truth/snapshot.js";
import type { TruthStores } from "../truth/stores.js";
import { parseSys, type ParsedSys } from "../truth/sysStore.js";
import {
  isDirectiveEntry,
  isNoticeEntry,
  renderEntryLines,
  renderNoticeText,
  speechEntryTagsOf,
  type WorkingSetEntry,
} from "../truth/workingSet.js";
import { minutesToText, type AdjudicationPackage } from "../types.js";
import { projectCharacterTree } from "../vars/systemChar.js";
import { readWorldTime, renderTimeHeader } from "../vars/systemWorld.js";
import { resolveAttachTags } from "../vars/template.js";
import { isTerminalInstance, mergeAttachMounts, readTerminal } from "../vars/tree.js";
import {
  lastProse,
  participantTags,
  proseWindow,
  proseWindowFor,
  proseWindowForRound,
} from "./historyProjection.js";
import { playableCharacters, simCharsOf } from "./scheduleEffects.js";

/** 投影输入（truth 之外的全部逐次渲染变量；四 Context 接口重叠字段归并为单一接口）。 */
export interface ProjectionInput {
  truth: TruthStores;
  proseWindowTurns: number;
  /** 邀请应答激活的待答邀请（incoming_contact 注入；character 读者；常规激活省略） */
  invitation?: { inviter: string; channel: string } | undefined;
  /** 本轮待裁决言行（GM 读者 working_set；无读者过滤 renderScene 产出） */
  sceneText?: string | undefined;
  /** 本轮行动者 → 行动时所在组（GM 读者 prose_window 连续场景滑窗过滤输入） */
  roundScenes?: Record<string, number> | undefined;
  /** 良恶/程度判定（机械渲染；现投现算，由 session 内核注入；GM 读者） */
  fortune?: string | undefined;
  /** 突发命中结果（incident_target 目标组渲染输入；突发 GM） */
  hit?: IncidentHit | undefined;
  /** 本轮 GM 裁决包（gm_event 注入 = events + narrativity；prose 读者） */
  adjudication?: AdjudicationPackage | undefined;
  /** 本轮各角色台词+内心（renderSpeech 产出；prose 读者 working_set） */
  currentScene?: string | undefined;
  /** 本轮参与者 cid（prose 读者 lores 根供给截取 = 参与者触发集输入） */
  participantCids?: string[] | undefined;
}

/**
 * 演员表现建：唯一真相 = characters 档内副本的 name（C0 与 NPC 同规），按 CID 排序（确定性）。
 * 不维护任何长期 cast 状态——改名/增角色后下一次渲染直接反映。
 */
export function buildCast(truth: TruthStores): CastMember[] {
  return Object.entries(truth.characters.all())
    .map(([cid, state]) => ({ cid, name: state.name }))
    .sort((a, b) => a.cid.localeCompare(b.cid));
}

/** 远程成员集：位置 ≠ 组位置（组位置 = 组内先攻最高者的 location，派生不落盘）。 */
export function remoteCidsOf(truth: TruthStores): Set<string> {
  const sim = simCharsOf(truth);
  const out = new Set<string>();
  for (const [cid, s] of Object.entries(playableCharacters(truth))) {
    if (s.group === 0) continue;
    const gl = groupLocation(sim, s.group);
    if (gl !== null && s.location.name !== gl) out.add(cid);
  }
  return out;
}

/**
 * 本轮 #当前场景抓取层（角色视角）：同值批次注入隔离——
 * 与行动者同组且先攻同值的他人本轮言行条目不可见（同时性的迷雾；从角色变量派生，续档安全）。
 * 自己的条目恒可见；未结算离开者（group=0 + timer=null）的条目产生时仍在组内，
 * 对原组成员保持可见；系统通知条目无先攻批次，隔离不适用（可见性归其后的逐条目 TAG 过滤）。
 */
export function batchIsolatedWorkingSet(truth: TruthStores, cid: string): WorkingSetEntry[] {
  const initiative = truth.characters.get(cid).initiative;
  return truth.sys.pipeline.working_set.filter((e) => {
    // 通知条目无先攻批次（隔离不适用）；指令条目不过本通道（角色读者恒不见，workingSetEntriesFor 跳过）
    if (isNoticeEntry(e) || isDirectiveEntry(e)) return true;
    if (e.cid === cid) return true; // 自己的过往言行可见（同值批隔离只对他人条目生效）
    const otherState = truth.characters.get(e.cid);
    // 未结算离开者：同值批隔离不适用（其条目是在组内时产生的，继续对原组成员可见）
    if (otherState.group === 0 && otherState.timer === null) return true;
    if (initiative === null) return true;
    const other = otherState.initiative;
    return other === null || other.group !== initiative.group || other.value !== initiative.value;
  });
}

/**
 * 未裁决突发派生：末个 gm 步（结算边界）之后的 incident 步中、目标涉及 cids 的突发文本。
 * 突发内容不落 Event（未裁决素材，地位同工作集）；GM 结算覆盖该组时由 GM 转写为真正
 * Event，本派生随边界前移自动消解。注入位置 = 目标组角色的 #当前场景 开头与
 * 常规 GM 的 ##当前场景 开头（同一派生，两侧复用）。
 */
export function pendingIncidentText(truth: TruthStores, cids: readonly string[]): string {
  const current = truth.sys.pipeline.current;
  const steps = [...truth.archive.readAll(), ...(current !== null ? [current] : [])];
  let boundary = -1;
  steps.forEach((s, i) => {
    if (s.kind === "gm") boundary = i;
  });
  const texts: string[] = [];
  for (const s of steps.slice(boundary + 1)) {
    if (s.kind !== "incident") continue;
    const result = s.result as { target?: { cids?: string[] }; incident?: { text?: string } } | null;
    const text = result?.incident?.text;
    if (typeof text === "string" && (result?.target?.cids ?? []).some((cid) => cids.includes(cid))) {
      texts.push(text);
    }
  }
  return texts.map((t) => `【突发事件】${t}`).join("\n");
}

/** 当前场景加突发前缀（无未裁决突发 = 原文）。 */
function withIncidentPrefix(truth: TruthStores, cids: readonly string[], scene: string): string {
  const prefix = pendingIncidentText(truth, cids);
  if (prefix === "") return scene;
  return scene === "" ? prefix : `${prefix}\n\n${scene}`;
}

/** 突发 GM 的目标组机械渲染（成员/地点/level/剩余休眠时长/错位度）。 */
function renderIncidentTarget(truth: TruthStores, hit: IncidentHit): string {
  const members = hit.group.cids
    .map((cid) => {
      const state = truth.characters.get(cid);
      return `- @${cid}（${state.name}，level ${state.level}）`;
    })
    .join("\n");
  return [
    `地点：${hit.group.locationName}（level ${hit.group.locationLevel}）；错位度 D=${hit.D.toFixed(1)}；已休眠 ${minutesToText(hit.group.remainingMinutes)}`,
    `成员：`,
    members,
  ].join("\n");
}

/** 扁平条目构造（无属主、不身份替换的缺省形态）。 */
function e(content: string, extra?: { owner?: string; identity?: IdentityMode }): SourceEntry {
  return { content, ...(extra?.owner !== undefined ? { owner: extra.owner } : {}), ...(extra?.identity !== undefined ? { identity: extra.identity } : {}) };
}

/**
 * 后台角色变量树的虚拟挂载变换（不落盘、不污染 TAG 池）：
 * appearance=false 角色的全部末端追加 {fappear, 6 级} 内容侧挂载——权重 6 全知
 * （GM/正文）虚拟全知覆盖六级组恒见；权重 0-5 读者须持 fappear 纯名（escape hatch）
 * 否则不可见。fappear 等级是代码焊死常量。调用方对属主 = 读者的子树跳过本变换（自豁免）。
 */
function withBackgroundMount(node: unknown): unknown {
  // tags 数组护栏：initiative 等系统容器带 value 子键，会被外壳判定误中——按容器递归下行
  if (isTerminalInstance(node) && Array.isArray(node.tags)) {
    return { ...node, tags: [...node.tags, { name: FAPPEAR_TAG, level: FAPPEAR_LEVEL }] };
  }
  if (Array.isArray(node)) return node.map((item) => withBackgroundMount(item));
  if (typeof node === "object" && node !== null) {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, withBackgroundMount(value)]));
  }
  return node;
}

/**
 * 内容源投影（RenderHost 实现）：reader 限定取数范围，input/statics 逐次渲染现算。
 * 方法均为纯读取组装（不写真相、不做 IO）。
 */
class Projection implements RenderHost {
  readonly readerLabel: string;
  /** cast 懒缓存（一次渲染内复用；不跨渲染持有） */
  private castCache: CastMember[] | null = null;
  /** sys 根严格解析懒缓存（四根视图与过滤上下文共用） */
  private sysCache: ParsedSys | null = null;

  constructor(
    readonly reader: ReaderRef,
    private readonly input: ProjectionInput,
  ) {
    this.readerLabel =
      reader.kind === "character" ? input.truth.characters.get(reader.cid).name : reader.kind === "gm" ? "GM" : "正文";
  }

  private get truth(): TruthStores {
    return this.input.truth;
  }

  private self(): CharacterState {
    if (this.reader.kind !== "character") throw new Error("非角色读者无自身状态");
    return this.truth.characters.get(this.reader.cid);
  }

  private cast(): CastMember[] {
    this.castCache ??= buildCast(this.truth);
    return this.castCache;
  }

  private sys(): ParsedSys {
    this.sysCache ??= parseSys(this.truth.sys.saveData());
    return this.sysCache;
  }

  /** 全体角色（cid 排序，确定性渲染序）。 */
  private sortedStates(): [string, CharacterState][] {
    return Object.entries(this.truth.characters.all()).sort(([a], [b]) => a.localeCompare(b));
  }

  /** 开放类别实例集（cid = 现存角色 / channel = 活跃频道编号 / location = 各角色当前地点名；懒缓存，一次渲染内复用）。 */
  private instancesCache: Partial<Record<TagCategory, ReadonlySet<string>>> | null = null;
  private categoryInstances(): Partial<Record<TagCategory, ReadonlySet<string>>> {
    if (this.instancesCache === null) {
      const all = Object.values(this.truth.characters.all());
      this.instancesCache = {
        cid: new Set(Object.keys(this.truth.characters.all())),
        channel: new Set(all.flatMap((s) => (s.channel === null ? [] : [String(s.channel)]))),
        location: new Set(all.map((s) => s.location.name)),
      };
    }
    return this.instancesCache;
  }

  /**
   * 工具 AV 临时挂载判定（组装时并入读者有效 TAG 集、不常驻变量，防 TAG 池膨胀）：
   * 频道持有者及其同地成员持 {A, V}——频道建立即对发送端同地全员临时挂载
   * （双向对称：任何频道持有者的同地成员同理；不要求同地人人持有联系方式）。
   */
  private holdsChannelToolAv(state: CharacterState): boolean {
    if (state.channel !== null) return true;
    return Object.values(this.truth.characters.all()).some(
      (s) => s.channel !== null && s.location.name === state.location.name,
    );
  }

  /**
   * 角色读者的 TAG 过滤上下文（事件/lore/vars/working_set 同一口径）：
   * 有效 TAG 集 = 落盘池（tagNames；自身 cid、当前地点名、当前频道号经 union sys 项
   * 常驻池内）∪ 程序派生（工具 AV 临时挂载）；全知权重 = omniscience 系统字段；
   * 开放类别实例集 = cid/channel/location 三类（命中归一化为类别记号）；
   * condition 按读者变量树求真（fail-closed）。
   */
  private characterScope(cid: string): ReaderScope {
    const state = this.truth.characters.get(cid);
    const tags = new Set(this.truth.characters.tagNames(cid));
    if (this.holdsChannelToolAv(state)) {
      tags.add("A");
      tags.add("V");
    }
    return {
      tags,
      omniscienceWeight: state.omniscience,
      categoryInstances: this.categoryInstances(),
      varReader: (path: string): unknown => {
        try {
          return readTerminal(state.vars, this.sys().template.character, path);
        } catch {
          return undefined;
        }
      },
    };
  }

  /** GM/正文读者的过滤上下文：权重 6 + 持强制全知（全集可见）。 */
  private omniscientScope(): ReaderScope {
    return { tags: new Set([FORCE_OMNISCIENT_TAG]), omniscienceWeight: MAX_OMNISCIENCE_WEIGHT };
  }

  /**
   * working_set 源（角色读者）：抓取层同值批隔离（batchIsolatedWorkingSet）→ 逐条目
   * TAG 过滤（言行条目挂载按焊死映射渲染时派生——频道/地点取当前真相；通知条目挂载
   * 随条目携带）。自己的言行条目恒可见（不过滤）。未裁决突发文本 = 头部恒放行条目。
   * 过滤结果随条目供给（SourceEntry.filter），放行/不放行两侧与降级文案归占位符模板。
   */
  private workingSetEntriesFor(cid: string): SourceEntry[] {
    const { truth } = this;
    const scope = this.characterScope(cid);
    const registry = this.sys().tagRegistry;
    const remote = remoteCidsOf(truth);
    const out: SourceEntry[] = [];
    const incident = pendingIncidentText(truth, [cid]);
    if (incident !== "") out.push(e(incident));
    for (const entry of batchIsolatedWorkingSet(truth, cid)) {
      if (isDirectiveEntry(entry)) continue; // 指令条目：角色读者恒不见（第四面墙 = 读者维度）
      if (isNoticeEntry(entry)) {
        const { status, matched } = evaluateTagFilter({ content: null, tags: entry.tags }, scope, registry);
        out.push({ content: renderNoticeText(entry.notice), filter: { status, matched } });
        continue;
      }
      const content = renderEntryLines(entry, cid, remote).join("\n");
      if (entry.cid === cid) {
        out.push(e(content));
        continue;
      }
      const tags = speechEntryTagsOf(entry, truth.characters.get(entry.cid));
      const { status, matched } = evaluateTagFilter({ content: null, tags }, scope, registry);
      out.push({ content, filter: { status, matched } });
    }
    return out;
  }

  /** 组装源取数：同一 source 按读者限定取数范围（定义读者无关，取数读者有关）。 */
  entries(source: AssembledSource): SourceEntry[] {
    const { truth, input } = this;
    const reader = this.reader;
    switch (source) {
      case "working_set": {
        if (reader.kind === "character") {
          return this.workingSetEntriesFor(reader.cid);
        }
        if (reader.kind === "gm") {
          return [e(withIncidentPrefix(truth, Object.keys(input.roundScenes ?? {}), input.sceneText ?? ""))];
        }
        return [e(input.currentScene ?? "")];
      }
      case "prose_window": {
        const archive = truth.archive.readAll();
        if (reader.kind === "character") {
          return proseWindowFor(archive, reader.cid, this.self().group, input.proseWindowTurns).map((block) =>
            e(block, { identity: "refs" }),
          );
        }
        if (reader.kind === "gm") {
          return proseWindowForRound(archive, input.roundScenes ?? {}, input.proseWindowTurns).map((block) =>
            e(block, { identity: "refs" }),
          );
        }
        // 正文读者 = 全量连续文风输入（refs 指称保持原文）
        return proseWindow(archive, input.proseWindowTurns).map((block) => e(block));
      }
      case "last_prose":
        return [e(lastProse(truth.archive.readAll()))];
      case "clock": {
        const { anchor, periods } = readWorldTime(truth.world.world);
        return [e(renderTimeHeader(anchor, periods))];
      }
      case "cast": {
        const selfCid = reader.kind === "character" ? reader.cid : undefined;
        return this.cast().map((member) => e(buildCastLines([member], selfCid)[0]!, { owner: member.cid }));
      }
      case "contacts": {
        // 频道持有者防重入（已在通话中不可被重复邀请）；角色侧整体闸：自身持频道或待答邀请 = 名单不可见
        if (reader.kind === "prose") return [];
        if (reader.kind === "character") {
          if (this.self().channel !== null || input.invitation != null) return [];
          return this.sortedStates()
            .filter(
              ([cid, state]) =>
                cid !== reader.cid && state.channel === null && (state.timer === null || state.timer > truth.world.clock),
            )
            .map(([cid]) => e(`- @${cid}`, { owner: cid }));
        }
        return this.sortedStates()
          .filter(([, state]) => state.channel === null && (state.timer === null || state.timer > truth.world.clock))
          .map(([cid, state]) => e(`- @${cid}（${state.name}）：${state.location.name}`, { owner: cid }));
      }
      case "departure_notices": {
        if (reader.kind !== "character") return [];
        const group = this.self().group;
        if (group === 0) return [];
        // 本组中已离开且未结算的成员（timer=null 且 initiative.group 仍指向本组）
        return this.sortedStates()
          .filter(([cid, state]) => cid !== reader.cid && state.timer === null && state.initiative?.group === group)
          .map(([cid]) =>
            e(`@${cid} 离开了当前场景，如果不希望他离开，你可以使用 {"type":"recall","target":"${cid}"} 标记召回`, {
              owner: cid,
            }),
          );
      }
      case "incoming_contact": {
        if (reader.kind !== "character" || input.invitation == null) return [];
        return [
          e(
            `@${input.invitation.inviter} 正在通过「${input.invitation.channel}」联系你。接受：输出 {"type":"confirm"} 标记（本轮输出即你的首轮回复）；拒绝：不立标记，在 dialogue 或 action 中说明理由`,
          ),
        ];
      }
      case "timers": {
        if (reader.kind !== "gm") return [];
        const clock = truth.world.clock;
        return this.sortedStates().map(([cid, state]) =>
          e(
            state.timer === null
              ? `- @${cid}：无计时器`
              : state.timer <= clock
                ? `- @${cid}：已到期（${state.acted ? "已行动" : "未行动"}）`
                : `- @${cid}：${minutesToText(state.timer - clock)}后到期`,
            { owner: cid },
          ),
        );
      }
      case "fortune":
        return reader.kind === "gm" ? [e(input.fortune ?? "")] : [];
      case "gm_event": {
        if (reader.kind !== "prose" || input.adjudication === undefined) return [];
        return [
          e(JSON.stringify({ events: input.adjudication.events, narrativity: input.adjudication.narrativity })),
        ];
      }
      case "incident_target":
        return reader.kind === "gm" && input.hit !== undefined ? [e(renderIncidentTarget(truth, input.hit))] : [];
      case "world_snapshot":
        return [e(JSON.stringify(truth.world.world))];
      case "snapshot": {
        if (reader.kind === "character") return [e(JSON.stringify(snapshotCharacterState(this.self())))];
        if (reader.kind === "gm") return [e(JSON.stringify(snapshotCharacterStates(truth.characters.all())))];
        return [];
      }
      case "group_members": {
        if (reader.kind !== "character") return [];
        const group = this.self().group;
        if (group === 0) return [];
        return this.sortedStates()
          .filter(([, state]) => state.group === group)
          .map(([cid, state]) =>
            e(`- @${cid} ${state.name}（${state.location.name}）${cid === reader.cid ? "（你）" : ""}`, { owner: cid }),
          );
      }
      case "long_term_memory":
        return reader.kind === "character" ? this.self().long_term_memory.map((item) => e(`- ${item}`)) : [];
      // 指令条目两源：读者轴供给本身就是第四面墙（god 仅 GM、writing 仅正文、角色恒空），
      // 条目不过 TAG 求值（恒放行 e() 缺省）；文本原样透传（出厂基线条目段 identity:false）
      case "god_directive": {
        if (reader.kind !== "gm") return [];
        return truth.sys.pipeline.working_set
          .filter(isDirectiveEntry)
          .filter((d) => d.directive.mode === "god")
          .map((d) => e(d.directive.text, { owner: d.author }));
      }
      case "writing_directive": {
        if (reader.kind !== "prose") return [];
        return truth.sys.pipeline.working_set
          .filter(isDirectiveEntry)
          .filter((d) => d.directive.mode === "writing")
          .map((d) => e(d.directive.text, { owner: d.author }));
      }
    }
  }

  /**
   * 落盘四根视图：events/lores/characters/world 同构供给 + 统一 TAG 过滤上下文。
   * 取数范围按读者供给（过滤在引擎逐末端求值）：
   * - events：character/GM = 全量；prose = 正文滑窗截取（取数范围，不是过滤）；
   * - lores：character/GM = 全量；prose = 本轮参与者触发集（参与者有效 TAG 名并集按
   *   权重 0 对 content.tags 求值——保正文 lore 触发制语义；enabled 是元数据不参与）；
   * - characters：全量遍历（一切读者同一取数范围），每角色 = 系统分支投影
   *   （projectCharacterTree：cid/name/location 等类型化字段呈标准末端，tags 取自
   *   systemTags 侧车）+ vars 树；对 appearance=false 角色的全部末端虚拟挂载
   *   {fappear, 6 级}（见 withBackgroundMount）——权重 6 全知（GM/正文）恒见，
   *   权重 0-5 读者须持 fappear 纯名方可见后台角色变量。自豁免：属主 = 读者的子树不挂载
   *  （自己的变量自己恒见——邀请应答时受邀者仍在后台，是后台读者的唯一场景）；
   * - world：整棵变量树（含 time 系统分支）。
   * world/characters 两根在供给前做 TAG 附加读取期合并（resolveAttachTags 按属主分发 +
   * mergeAttachMounts 并入末端 tags，不物化进实例值；events/lores 无附加通道）。
   * 角色读者上下文 = characterScope；GM/正文 = omniscientScope。
   */
  vars(): VarsView {
    const { truth, input } = this;
    const sys = this.sys();
    const selfCid = this.reader.kind === "character" ? this.reader.cid : null;
    // vars-tags {category} 条目合法性基准 = 注册表声明的开放类别集合
    const categories = new Set(
      Object.values(sys.tagRegistry).flatMap((entry) => (entry.category !== undefined ? [entry.category] : [])),
    );
    const worldAttach = resolveAttachTags(sys.varsTags.world, sys.template.world, { categories });
    const characters = Object.fromEntries(
      this.sortedStates().map(([cid, state]) => {
        const attach = resolveAttachTags(sys.varsTags.character, sys.template.character, { categories, ownerCid: cid });
        const tree = mergeAttachMounts(projectCharacterTree(state), attach);
        return [cid, state.appearance || cid === selfCid ? tree : withBackgroundMount(tree)];
      }),
    );
    const scope =
      this.reader.kind === "character" ? this.characterScope(this.reader.cid) : this.omniscientScope();
    const events =
      this.reader.kind === "prose" ? truth.events.readWindow(input.proseWindowTurns) : truth.events.readAll();
    let lores = truth.loreStore.book().all();
    if (this.reader.kind === "prose") {
      const participantScope: ReaderScope = {
        tags: new Set(
          participantTags((input.participantCids ?? []).map((cid) => [...truth.characters.tagNames(cid), cid])),
        ),
        omniscienceWeight: 0,
      };
      lores = lores.filter(
        (entry) =>
          evaluateTagFilter({ content: null, tags: entry.content.tags }, participantScope, sys.tagRegistry).status ===
          "pass",
      );
    }
    return {
      template: sys.template,
      world: mergeAttachMounts(truth.world.world, worldAttach),
      characters,
      events,
      lores,
      filter: { scope, registry: sys.tagRegistry },
    };
  }

  /**
   * 身份替换后处理（组装层统一出口）：
   * 角色 = @CID 按 relations 替换（cid 模式）/ 指称按 relations 过滤（refs 模式）；
   * GM = 事件保持 @ID 原文（cid 模式不动），指称渲染为 称呼（@CID）（refs 模式）；
   * 正文 = @CID 按演员表真名替换（cid 模式），指称保持原文（refs 模式——正文作者需见占位语法）。
   */
  renderIdentity(text: string, mode: IdentityMode): string {
    if (this.reader.kind === "character") {
      const relations = this.self().relations;
      return mode === "cid" ? renderForReader(text, this.reader.cid, relations) : renderRefsForReader(text, relations);
    }
    if (this.reader.kind === "gm") {
      return mode === "cid" ? text : renderRefsForGm(text);
    }
    return mode === "cid" ? renderForGm(text, this.cast()) : text;
  }
}

/**
 * 投影装配器：全部内容逐次渲染现算。
 * 每次激活经 for() 建一份 Projection（RenderHost），交给 activation 渲染当轮模板。
 */
export class ProjectionBuilder {
  /** 按读者建投影（纯读取组装，不写真相、不做 IO）。 */
  for(reader: ReaderRef, input: ProjectionInput): RenderHost {
    return new Projection(reader, input);
  }
}
