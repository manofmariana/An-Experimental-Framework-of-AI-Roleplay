# Agent-AIRP

多 Agent 架构的 AI 角色扮演系统，取代 SillyTavern 式单上下文结构。核心：**一个 GM 导演 + 拥有私域上下文的角色 Subagent + 受约束的正文渲染器**，真相存于结构化事件日志而非聊天文本。

**架构唯一基准是 `DESIGN.md`**——任何架构性修改必须先读它并与之对齐；修改架构必须同步更新它。P1 阶段细化（多角色与事件记录体系）见 `DESIGN-P1.md`；领域词汇表见 `CONTEXT.md`（术语含义与冲突消解以此为准），架构决策记录见 `docs/adr/`。

## 技术栈

TypeScript ESM（Node.js，无构建步骤，`tsx` 直接跑 TS）。依赖极少：`openai`（LLM 客户端）、`ws`（WebSocket）、`zod`（契约校验）；前端是无构建的 Vanilla 单页应用。包管理用 npm，无打包/发布流程——本项目是本地运行的私有应用（`private: true`）。

## 常用命令

```bash
npm run dev        # CLI 游玩（tsx src/cli.ts，readline REPL）
npm run serve      # WebUI 服务（tsx src/server/index.ts，默认 http://127.0.0.1:8787）
npm test           # node --import tsx --test test/**/*.test.ts
npm run typecheck  # tsc --noEmit（改动后必须通过）
```

启动器：`Agent-AIRP.bat`（CLI）、`Agent-AIRP-WebUI.bat`（WebUI + 自动开浏览器）。

配置：根目录 `config.json`（已 gitignore，模板 `config.example.json`）。顶层 `api_key/base_url/model` 为公共默认，`agents.{character|gm|prose}` 块可逐 agent 覆盖；`json_mode`（默认 false）与 `reasoning_effort`（原样透传不锁枚举）同样支持顶层 + 逐 agent 覆盖；`memory.prose_window_turns` 为正文滑窗大小（默认 5）；环境变量 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` 优先于顶层字段。设置页保存**立即热生效**（PUT /api/config → GameSession.reloadConfig 原地更新三个 LLMClient 与滑窗/GM 间隔，不走 markStale）；world/character 域仍是新会话生效。服务端绑定地址可用 `AIRP_HOST` / `AIRP_PORT` 覆盖。

## 目录结构

**逐文件职责/IO/依赖方向见 `docs/architecture.md`（改动指向地图；新文件必须先登记再写码）。**

- `src/types.ts` — 全部契约（zod schema）：Event（@ID 占位 + 统一 known_by tags）/ DecisionPackage（**inner 必填**（内心与意图，intent 已并入）；action/dialogue 至少其一；relations/markers 可选——markers = 五标记结构化数组 gm_request/leave/recall/contact/confirm，gm_request 与 leave 互斥）/ AdjudicationPackage v2（events 数组 + narrativity + deltas + timer + location）/ Span·Location（时间偏移与结构化地点）；玩家固定 `C0`，角色 ID 为 C+编号
- `src/scheduler/` — `simulator.ts`（**纯逻辑派生函数集**：nextDue / reconcileGroups（timer+location 并组 + id 保稳继承：精确>增员>减员>人少并入人多）/ groupLocation（组位置 = 先攻最高者 location）/ orderGroups（同刻多组串行）/ visibleEvents（known_by 唯一通道）/ rollInitiative·initiativeBatches·rerollInitiative（d20+reaction，同值同批，{value,group} 结构，补投不波及全组）；禁 IO import，`test/simulator.test.ts` 有元测试守护）
- `src/compile/` — `template.ts`（模板 schema/加载/占位符校验）+ `compiler.ts`（**纯渲染器**：模板 × 占位符注册表 × 注入上下文 → ChatMessage[]；占位符注册表 = 唯一出口，新占位符 = 注册新 provider）
- `src/truth/` — **统一版本存档核心文件**：events/lore/world/characters/archive/time 均带同一 `schema_version`（saveSchema.ts 校验，旧版或混合版本明确拒绝且不迁移）；`world.json={schema_version,world:{time:{y,m,d,h,min},...},pipeline}`（clock 由 world.time 派生，不落盘）；characters 单文件仅含同构 C* 角色（name/gender/age/personality + 调度变量 + relations/长期记忆/vars；无 gm key、无 persona/voice_anchor）；archive 正文结果持久化 `participants+scenes`（正文滑窗按 CID+连续场景过滤的数据源）；timeStore（time.json 档内副本 + 结构化时间渲染）；snapshot（注入层状态序列化：timer 分钟标量 → {y,m,d,h,min} 结构化，LEAVE_TIMER → "已离开待结算"）；另有 lorebook/identity/workingSet
- `src/llm/` — client（OpenAI 兼容）/ cacheStats（埋点）/ recent（llm-recent/{agent}.json 最近 5 轮滚动窗）
- `src/agents/` — character（私域上下文+人际关系库自维护）/ gm（重裁决+@ID 转写，**红线：不替主要角色决策**，写在 `data/prompts/gm.prompt.json` 的裁决协议模块里）/ prose（**无工具纯渲染器**）；各自导出占位符注册表 `*_PLACEHOLDERS`
- `data/prompts/{character,gm,prose}.prompt.json` — 模块化提示词模板（模块 = {key, role, content}，content 内 `{{placeholder}}`；Web 可编辑，**每轮激活前热加载**，保存后下一轮即生效；旧的 `src/prompts/` md 已废除）
- `src/server/` — WebUI 后端（http + ws）：WebDisplay / sessionManager / 管理 API；`PUT /api/session/state` 状态直编（LLM 在途拒绝；world/characters/events 整体替换 + agent 重建；变量域经 varDiff 净额并入当前步 var_changes——可回溯，事件域按 seq 截断口径）；state/events 逐轮广播（turn_done/rollback/edit_result/会话建立/重连后推送，前端侧栏实时重渲 + 直编预填缓存保鲜）
- `src/loop.ts` — 主循环 GameSession（M2 计时器 DES：deriveNext 派生"下一步该谁"（无快照，回溯零特例）、单活跃组 + 同刻多组串行、行动顺序 = initiative 现排、已行动位 = 角色 acted 变量、周期计数 X = world 变量、无判定轮（GM 标记立即激活/硬保险 N 周期末激活）+ 五标记即时执行 + 邀请延迟生效 + 频道变量、GM 多事件裁决（timer 必非 0 + 精确覆盖全体同步组成员与刚离组者契约）+ 工作集清算、分步流水线）；`src/cli.ts` / `src/display.ts` — CLI 与显示层接口
- `web/` — Vanilla 单页前端（无构建），六页签：游玩/会话/角色/世界/提示词/配置（`web/pages/*.js` 一页一文件）；游玩历史一轮可显示多张角色卡
- `data/worlds/{setId}/` — 世界设定集（setting.md / tone-card.md / lorebook.json / time.json / player.json / characters/*.json）；示例集 `baitan` 含 C0 开局配置与 C1001–C1003 三名 NPC，新会话可选
- `runs/{runId}/` — 存档（统一 `schema_version`，当前 v3）：events.json / lore.json / world.json / characters.json / archive.json / time.json（档内副本）/ llm-recent/{agent}.json / meta.json（世界设定集选择）/ cache-stats.jsonl（**版本不符即拒绝加载，须新建会话，旧档永不迁移**；turns.jsonl、prompts/、agents/ 目录均已废除）

## 不可违反的架构纪律

1. **真相层唯一写入者 = GM**（经裁决包 commit，@ID 占位 + 统一 tags）；玩家/角色言行先进当前轮工作集，GM 转写才成事件；任何 agent 不读 GM 进行中状态；正文只是视图，不得反向污染真相。
2. **缓存友好是模板编辑约定**（动态内容——近期事件/正文滑窗/#当前场景——放尾部模块）：compiler 是纯渲染器，不做逐字节/append-only 断言；时间戳/轮次禁令已取消（时间、地点经占位符注入）。新注入内容必须经过占位符注册表（provider），不得在组装代码里散落硬编码拼接；**provider 纯净化——只输出数据本身，标题/节名/包装前缀一律写在模板静态文案里**。
3. **simulator.ts 必须保持纯逻辑**（无 IO/LLM import，元测试断言守护）。
4. **正文 agent 永不加工具/检索权**；GM 不得替主要角色决策、事件写作为**摘要制**（不完整转述台词、禁人称代词、保言行顺序、只记已发生）、写 events 用 @CID 占位（红线写进 `data/prompts/gm.prompt.json`）。
5. 每次激活 = 全新调用，无对话历史；连续性靠编译器从真相层+记忆结构化注入。

## 开发约定

- TypeScript ESM strict（`noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`）；target/module ES2022，`moduleResolution: bundler`，`noEmit`（运行靠 tsx，无编译产物）。
- 测试用 Node 内置 `node:test`，不加测试框架；测试文件在 `test/*.test.ts`，与源码模块大致一一对应（含 config/compiler/各 truth store/server API/回溯等）。
- Display 接口（`src/display.ts`）是 UI 协议层：CLI 与 WebUI 各是一个实现，GameSession 不感知前端。
- **提示词模板热加载，但代码不热重载**——改代码后必须重启服务再新建会话验证（存档版本不符会拒绝加载，这是防"旧代码+新模板"混合态的设计，不是故障）。
- GM 事件写作纪律（@CID 占位、known_by 谁感知标谁）是**提示词协议层**约束，不做程序强校验；提示词模板示例禁用真实 CID（用 `<CID_甲>` 抽象占位）。
- 改动后必须 `npm run typecheck` 干净 + `npm test` 全绿。

## 安全注意

- `config.json` 含 LLM API key，已 gitignore，**绝不提交**；对外只发 `config.example.json` 模板。
- WebUI 默认只绑 loopback（`127.0.0.1:8787`）；`AIRP_HOST` 绑非 loopback 地址时服务端会打印公网暴露警告——这是有意设计，不要绕过。
- 读档内副本原则：新会话把世界 lorebook 拷入 `runs/{id}/lore.json`，运行期增删改只动副本，不污染 `data/` 原始设定集。

## 当前阶段

P1-M1 已完成（事件记录体系 + 存档 v2 + 回溯/停止/编辑/继续/重 roll，DESIGN-P1 §10.1/§10.2）。**M2-a 已完成**：计时器 DES 异步多角色核心、存档 v3、快照注入、GM 裁决包 v2、白滩镇开局。**M2-b 已实现（DESIGN-P1 §5/§10.4，ADR-0004）**：无判定轮与五标记体系（gm_request/leave/recall/contact/confirm，结构化 markers 数组，不进工作集不进注入）、GM 按需激活（标记立即/硬保险 N 周期末，N = `gm_interval_cycles` 默认 3）、inScene/inTalk 合并为单 group 变量（组位置派生、入组位置不同先攻 -1）、initiative 结构化 {value,group}、行动顺序表（顺序派生 + acted 角色变量 + X 世界变量）、邀请延迟生效与频道变量、玩家三块输入（台词/行动/内心（含意图））+ 标记按钮 + 暂停选项（自动继续/每轮/GM 前/GM 后/正文后）、契约简化（inner 必填、action/dialogue 至少其一）、存档 v5（旧档拒绝）。编辑语义：角色步编辑 = 重读整个输出完整重放（`effects_from` 整段反向旧效应 → relations/邀请应答/标记重放，步落账另记 invitation 上下文）。遗留：标记注入渲染与远程成员标注的提示词组装细化（与 P2 TAG 过滤一并做）、§6 GM 正文滑窗的连续判定细粒度、突发鉴定触发流程（仅数据结构就绪）。
