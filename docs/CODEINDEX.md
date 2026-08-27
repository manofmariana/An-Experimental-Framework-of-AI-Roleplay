# 改动指向地图

新文件必须先在此登记（路径 / 职责 / IO / 依赖方向），再写码。职责变化时同步更新本表。顶层目录布局见 AGENTS.md 目录结构段；依赖禁止边由 `scripts/check-dependencies.ts` 机械守护（`npm run test:arch`）。

## src/

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `types.ts` | 全部契约（zod schema）：Event/DecisionPackage（含 `visibility` 可见域字段：A = 只对同频道 / B = 只对同地，缺省 = 组内全体）/AdjudicationPackage/IncidentPackage/Span/Location 等；TagMountRefSchema（内容侧 TAG 挂载 {name, level 1-7}：Event/AdjudicationEvent/LoreEntry 的 tags 形状） | 无 | 不依赖 src 内模块 |
| `config.ts` | 路径常量（经 userDirectories 派生）、世界设定集定位、LLMConfig/AgentKind + 运行设置缺省常量（DEFAULT_PROSE_WINDOW_TURNS/DEFAULT_GM_INTERVAL_CYCLES）；旧版 config.json 分层解析的对拍基准在 `test/harness/legacyConfigResolver.ts` | 读 data/assets | → resources |
| `configResolver.ts` | 配置解析纯函数：resolveEffectiveAgentConfigs（settings+presets+secrets+env → 三 activation ResolvedAgentConfig；优先级：preset 显式 secretId > env > 该 kind active secret）+ mapLegacyConfig（旧版 config.json → secrets/presets/settings 迁移映射） | 无 | → contracts |
| `cli.ts` | CLI 入口（readline REPL；经 SessionCoordinator 发 player_input/continue/rollback/rollback_and_continue 命令；启动经 configService.loadConfigState 读配置——迁移闸对 CLI 同样生效） | 终端 | → application(sessionCoordinator/configService)/config/resources |
| `serverConfig.ts` | server.json 加载与 env 合成：resolveServerConfig 纯函数（listen/host白名单/IP白名单/allowKeysExposure；OFAIR_HOST/OFAIR_PORT 优先于 listen；缺文件=全默认 loopback 放开）+ loadServerConfig IO 壳（basicAuth/SSL/proxy/broadcast 接受但逐块 warn 未实现忽略） | 读 server.json | → contracts/config(PROJECT_ROOT) |
| `ports.ts` | 运行时端口：Clock / IdPorts / DicePort（单骰 (face)=>1..face）+ rollDice 统一投掷出口（dice 求和 × times 次取高/低，keep: high/low）及系统默认实现 | 墙钟 | 不依赖 src 内模块 |
| `display.ts` | Display 接口（UI 协议层）：CLI 与 WebUI 各一实现；agentStart 带可选第 4 参 activationId | 无 | → types |

## src/application/（应用层：统一效果规划器 + 调度派生收口 + 会话内核/装配/协调器；禁依赖 server）

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `actorEffects.ts` | 角色决策规划器 planActorDecision（玩家/NPC/编辑重放统一入口）：working set 追加（言行条目 + 标记派生的系统通知条目，noticesOfMarkers/appendNotices 纯函数镜像）/relations/acted/邀请应答（confirm 入组·拒绝还原）/五标记；入组（远程 confirm 按组籍/召回）在场位置 true、离组（leave）置 false；只变异 draft 并返回 StepChanges.effects 段 | 无（纯内存变异） | → truth/stores/scheduler/types/ports |
| `gmEffects.ts` | GM 裁决规划器 planGmAdjudication（正常与编辑统一）：deltas/durations/location/复位/acted/组派生/事件 commit（空 tags 程序补全本轮行动者 cid 类 TAG 一级）/结算成员在场位置 false/工作集清算 | 无（同上） | 同上 |
| `activationContexts.ts` | **内容源投影层**：三个无状态 activation 的全部注入内容从最新真相 + 派生投影**逐调用现算**为 RenderHost（ProjectionBuilder.for(reader, input)；cast 现建、lore 逐调用渲染档内副本、可见事件/正文滑窗/当前场景/被联系通知/fortune 透传）——占位符定义读者无关，取数范围按读者供给（角色事件/lore 经 TAG 过滤取可见集，GM/正文 = 全量）；**TAG 过滤上下文各源同一口径**（characterScope：有效 TAG 集 = tags 池纯名集 ∪ 程序派生（自身 cid/当前地点名/当前频道编号/工具 AV 临时挂载——频道持有者及其同地成员持 A/V 纯名）+ 全知权重，开放类别实例 = cid/channel/location 三类；GM/正文 = 权重 6 + 持强制全知）；**working_set 源 = 抓取层同值批隔离（batchIsolatedWorkingSet）+ 逐条目 TAG 过滤**（言行条目挂载按焊死映射渲染时派生 speechEntryTagsOf、通知条目挂载随条目携带、自己的条目恒可见；过滤结果随 SourceEntry.filter 供给引擎）；vars 源全量遍历（无专门抓取），对 appearance=false 角色的全部末端虚拟挂载 {fappear, 6 级}（withBackgroundMount，不落盘；属主 = 读者的子树自豁免不挂载）；身份替换后处理统一出口 renderIdentity（角色 = renderForReader/renderRefsForReader、GM = 事件 @ID 原文 + refs 渲染、正文 = renderForGm + refs 原文）；未裁决突发派生（pendingIncidentText：末 gm 边界后的 incident 步 → 角色与常规 GM 两侧当前场景前缀，GM 结算覆盖即自动消解）；持有世界集静态文本（setting/toneCard）；remoteCidsOf 纯派生 | 无（纯读取组装） | → compile(render/placeholders)/tags/truth/scheduler/historyProjection/scheduleEffects/vars |
| `scheduleEffects.ts` | 调度效应：applyScheduleSetup（轮首 setup 段落账：时钟/周期计数/acted 清零/前台组成员在场位置位）/rederiveGroups/cleanupChannels（离场处理含在场位复位）/setAppearance（在场位唯一写口：writeRaw 白名单通道随 changes 落账，未知角色/值已到位 = 空）+ 调度视图小工具（simChars/playerCid/cycleCount）；loop 与两个规划器共用 | 无（同上） | 同上 |
| `workingSetProjection.ts` | projectWorkingSet 纯函数：末个 gm/prose 边界后的 player/character 步（回滚/GM 编辑/普通切片由调用方传入）；言行条目 {cid, decision} 与落账同形，标记派生的通知条目经同一纯函数再生（重建与落账逐字节一致） | 无 | → truth/workingSet/types |
| `prepareNextCommand.ts` | 执行入口统一收口（确定性计算层）：空 rules 短路直接 deriveNext；有 rules 时 draft 上跑固定规则至固定点（状态签名重复/超迭代上限 → 弃稿报错）→ 一次 commit → 重建投影 → deriveNext；投骰不进本层 | 无（commit 经注入回调） | → truth(stores/varChanges)/scheduler(derive) |
| `gameSession.ts` | GameSession 会话内核：DES 调度步编排（stepPlayer/stepCharacter/stepGm/stepProse/runPipeline）、**突发命中评估编排**（常规 GM 步 narrativity=skip 后及其正文步后：sleepingGroups 现组 → scheduler evaluateIncident → stepIncident（slim 突发包 + 目标组 timer 对齐时钟立即到期，归档 kind=incident 调度透明步；incident 步后不评估）；良恶/程度 fortune 现投现注入所有 GM 激活）、commit/adopt（commitGeneration/commitTruth/draft 机制）、pause 闸门、abortCurrent、applyResolvedConfig（配置热应用入口：adapter 原地换配置 + 滑窗/GM 间隔）、查询出口、editResult/rollbackTo/applyDirectEdit；**注入式构造**（GameSessionDeps，装配归 sessionFactory；构造尾新档开局组派生 + 初始前台组在场位置位——init 初始状态的一部分，不产生变更记录）；无独立 reroll（重 roll = Coordinator 复合命令）；onCommit 提交通知钩子（CommitNotice = prev/next 根引用，committedRoots 为差分基准）、activationId（`${runId}:act:${++seq}` 会话内单调计数器，三个 activation 点生成并经 Display.agentStart 可选第 4 参传出，currentActivationId getter 供 stop 核对）、dispose()（旗标 + abort 在途；commit 闸/runPipeline 开步抛 DisposedSessionError，已销毁会话的 agentEnd 晚到收尾不广播） | 经 CommitExecutor 整代落盘 | → agents/truth/scheduler/compile（间接）/llm/config/contracts/ports/application 内部 |
| `sessionFactory.ts` | 会话装配（configs/runId/options/worldSetId → GameSession）：ChatPort/adapter 装配、提示词档内副本装载（新档读世界包 prompts/ 四份模板 + placeholders.json 占位符目录——loadPackPrompts/loadPackPlaceholders 导出，逐份按目录键集校验、缺文件/校验失败即拒装，validatePlaceholders 语义机检对档内模板与注册表（新档/续档同口径）——拷入 PromptsStore 随 init 提交落 Generation 1；续档从档内 prompts.json 恢复，不再读世界包）、**incident.json 突发公式配置与变量体系三文件（tags.json/vars-template.json/vars-tags.json）读取**（缺文件即拒装；新会话解析校验后拷入 `world._sys`，续档从档内 `_sys` 读并对 world/characters 变量树幂等 normalize（按 characterVars 作者子树）+ systemTags 侧车校验 + 整根从动级联）、世界设定集读取、存档 meta.json（world_set）读写、七 Store 初始/续档装载、无状态 activation 装配（三个 activation 各持对应 kind 的 ChatPort + 同一档内 PromptsStore）；`SessionFactory` 端口 + `productionSessionFactory`（经 configService.loadConfigState 读配置（含迁移闸）+ save/ 存在性校验；settings 的滑窗/GM 间隔经 SessionOptions 固化进装配） | 读 data/assets、save/{runId}/meta.json | → gameSession/configService/agents/truth/compile/llm/config/resources/shared/ports |
| `sessionCoordinator.ts` | **单一命令协调器**：SessionCommand 分发 + 唯一串行队列（含 new/load）+ busy 闸 + baseRevision 乐观并发校验（RevisionConflictError）+ rollback_and_continue 复合命令（单任务内 rollback→continue，**只发一条合并 Transition**——suppressTransitions 抑制中间 rollback 提交）+ stale/pauseOptions 记忆/applyResolvedConfig 转发（配置事务热应用回调，同一份 resolved 对象，无会话 no-op）；onCommit → buildTransition → onTransition 广播；query = snapshot/stats（QueryResultMap；snapshot = 同步函数内单 revision 一致快照 + 末尾 revision 未变断言）；activeWorld() = 活跃会话当前 world 冻结视图（含 `_sys`，HTTP 结构编辑档内模式取数用，无会话 null）；activePrompts() = 档内提示词模板冻结视图（HTTP 提示词编辑档内模式取数用，无会话 null）；stop 定向中止（runId 不符 → SessionSwitchedError；activationId 不符 → 幂等空成功）；new/load 入队前 dispose 在途旧会话（强制切换）+ epoch 递增 + 旧会话晚到 onCommit 不广播 | 无直接网络/磁盘（装配委托 factory） | → gameSession/historyProjection/sessionFactory/transitionProjection/truth(errors)/ports/display |
| `historyProjection.ts` | 历史回显与正文素材投影：buildHistory（HistoryTurn/HistoryPayload；incident 步归入新一轮挂 incidents——interrupted 突发步跳过）+ proseWindow/proseWindowFor/proseWindowForRound/lastProse/participantTags（入参 = 各角色 tags 池 name 集的数组）；纯展示，零 IO | 无 | → truth(archive/worldStore/snapshot)/types |
| `transitionProjection.ts` | 提交 → 增量同步投影（纯函数零 IO）：CommitNotice（prev/next 根引用，恒冻结零拷贝）→ buildTransition **引用比较求差**（引用变再落 JSON 值比较兜底——draft 深拷贝引用必变）：world 根变 → 完整 world 视图；characters 逐 CID（变化 → 当前视图，消失 → null）；events 前缀比对（appendedEvents 尾切片 / truncateEventsAfterSeq + 尾部重放）；historyPatch 恒 `{type:"replace",history}`；edit_result 附 editedResult。另持 PipelineView/StateView/SessionSnapshotData/SessionTransition 下行载荷类型（application 不得依赖 server，信封 type 在 server/ws-protocol.ts 加） | 无 | → truth（类型）/scheduler(derive 的 DerivedPhase)/historyProjection/types |
| `configService.ts` | **配置事务唯一编排口**：loadConfigState（幂等迁移闸：config.json 存在且 secrets.json 不存在 → mapLegacyConfig 迁移 + 原子写三资源 + config.json 改名 .migrated.bak）→ resolved + 脱敏视图 + configRevision；applyConfigMutation（SecretMutation/PresetMutation/SettingsPatch 判别联合 + baseConfigRevision 校验 409 → 草稿应用 → resolveEffectiveAgentConfigs 解析三 activation（失败 400 零落盘）→ 原子保存 → 同一 resolved 对象热应用（注入回调；失败回写旧资源 + CONFIG_APPLY_FAILED 500）→ configRevision+1） | 读写 data/users/{user}/{secrets.json,api-presets/,settings.json} | → resources/configResolver/contracts |

## src/agents/

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `character.ts` | 无状态角色 activation：RenderHost（逐调用由投影层现算传入）→ DecisionPackage；单一实例服务全部 NPC；构造注入档内 PromptsStore（每轮激活读档内模板副本 + 占位符目录，validateTemplate 对目录键集后 renderPrompt 渲染，编辑通道更新后下一轮即生效） | 经 ChatPort | → compile/truth(类型)/llm/chatPort（禁 openaiChatAdapter/callLog） |
| `gm.ts` | 无状态 GM activation：RenderHost → AdjudicationPackage（重裁决 + @ID 转写；validateAdjudicationRound 语义校验 + 事件 tags 名称校验（eventTagScope 注入 = 档内注册表类别化口径，不合法走解析失败重试通道））；**突发变体**：同一 host 换 gm-incident 提示词组 → IncidentPackage（"同一身份 × 不同功能 = 不同提示词组"首个实例；slim 契约独立轻校验，不复用 durations 覆盖校验）；fortune 占位符（良恶/程度判定，所有 GM 激活前注入）；PromptsStore 注入同上 | 同上 | 同上 |
| `prose.ts` | 无状态正文 activation：RenderHost → text，无工具纯渲染器；PromptsStore 注入同上 | 同上 | 同上 |
| `json.ts` | 模型输出 JSON 提取/修复工具 | 无 | 纯函数 |
| `structuredActivation.ts` | 结构化 activation 统一控制流：ChatPort 调用（流式透传）→ parse → retry 通知重试一次（**重试 messages 尾部追加首次校验错误 + 重新输出指引**，首次 messages 不变）→ 带 failureLabel 抛错；LLMAbortedError 不重试直接上抛；character/gm 共用，prose 不同构不用 | 经 ChatPort | → llm/chatPort/display |

## src/compile/

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `template.ts` | 模板 schema/加载/占位符校验（合法键集 = 档内 placeholders 目录键集，调用方传入）；目录参数必填（调用方传入包内 prompts/ 路径，无全局默认模板目录） | 读 data/assets/{包}/prompts | 纯逻辑 + fs |
| `placeholders.ts` | 占位符目录契约与编辑期机检：zod schema（条目 = {description, source, segments[]}；source 封闭枚举；段 = 静态段/条目段（pass/fail 两侧 + 精确匹配分支 + order/separator/merge））+ parsePlaceholders + validatePlaceholders（置后条目首位轴一致 / vars 路径必须解析到末端（tag_list 原子即止）/ 多路径路由链最前差异点兼容 / branches 记号合法性（注册表名 ∪ 全知 ∪ 强制全知）/ 扁平源仅 {_content}/{_owner} 伪路径、vars 源仅路由链路径） | 无 | → vars(template)/tags(registry)（合法边，审计守护） |
| `render.ts` | 声明式渲染引擎：模板 × 占位符目录 × RenderHost（投影层实现）→ ChatMessage[]——静态段原样；扁平源逐条目（{_content}/{_owner}，identity 条目注入值过身份替换后处理；条目携带 SourceEntry.filter 时按 status 走放行/不放行侧 + matched 精确匹配分支、不放行侧 {_content} 给空，未携带 = 恒放行侧；空渲染条目整条丢弃）；vars 源路由链差异点归并遍历（公共前缀共享、[ * ] 差异点产子循环）+ 逐末端 TAG 过滤（evaluateTagFilter）→ 放行/不放行侧判定 → matched 并集精确匹配分支/缺省兜底 → separator/merge 拼装；遍历序前置（条目轴独立滚完）/置后（同首位轴融合为逐实例组）；渲染后空模块整条丢弃；懒求值（未引用占位符不取数） | 无 | → template/placeholders/tags(evaluate)/vars(tree·template)/llm/chatPort（仅 ChatMessage 类型，compiler 同例） |

## src/llm/

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `chatPort.ts` | ChatPort 端口契约：ChatRequest/ChatResult/ChatMessage/LLMAbortedError | 无 | 不依赖 src 内模块 |
| `openaiChatAdapter.ts` | OpenAI 兼容协议 adapter（流式/非流式/usage 提取/请求参数组装） | 网络 | → chatPort/config（禁 server/loop/agents） |
| `callLog.ts` | 记录 decorator：recent/cacheStats 落盘（失败只告警） | 写 save 旁路 | → chatPort/cacheStats/recent |
| `cacheStats.ts` | 缓存埋点（cache-stats.jsonl） | 写 save 旁路 | → config |
| `recent.ts` | llm-recent/{agent}.json 最近 5 轮滚动窗 | 写 save 旁路 | → config |

## src/scheduler/

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `simulator.ts` | 纯逻辑派生函数集：nextDue/reconcileGroups/orderGroups/visibleEvents（TAG 过滤：ReaderScope + 注册表经参数注入）/initiative 系列 | 禁 IO/LLM/server/truth（审计守护） | 纯逻辑（→ tags 合法边） |
| `derive.ts` | 调度派生：SchedulerSnapshot → NextCommand（deriveNext/selectFront/phaseOf/expectedGmDurationCids；ScheduleSetup 含 foreground = 弹出前台组成员，轮首在场位置位的输入）；组合 simulator 算法，不读 Store/archive/LLM | 禁 IO/LLM/server/truth（审计守护） | → scheduler/simulator |
| `invitations.ts` | 邀请历史解释：InvitationProjection（增量 applyStep / 全量 rebuild / nextPending 输出 PendingInvitationView）；派生缓存，不进 Generation/CommitPlan | 禁 IO/LLM/server/truth（审计守护） | → scheduler/derive（仅类型） |
| `incident.ts` | 突发事件配置契约与求值编排：IncidentConfig schema + compileIncidentConfig（编译世界包表达式 + 变量闭包校验）+ mismatchD/hitF/hitG/hitProbability/malignPercent/rollFortune/evaluateIncident（按编译后公式求值，骰子经 DicePort 注入）；公式结构与参数唯一出处 = 世界包 incident.json | 禁 IO/LLM/server/truth（审计守护） | → ports/shared/formula |

## src/tags/

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `registry.ts` | TAG 注册表契约与校验：条目 schema（名称即键；{name, description?, condition?, category?, system?}，category = 封闭枚举 {cid, channel, location}；condition = {path, op, value}）；system 条目与代码常量一致性校验（任何层不得占用同名；三个开放类别各有一条同名 system 类别条目——system + category 同现，缺一条即拒装）；程序化 TAG 常量（SYSTEM_TAG_NAMES 双向一致基准 + 全知/强制全知/fappear 记号与 fappear 焊死等级 6） | 禁 IO/LLM/server/truth（审计守护） | 纯逻辑 |
| `evaluate.ts` | 等级表达式求值器：T =（一级组 ∨）∧ … ∧（七级组 ∨），空等级组无约束、无 TAG 恒通过（等级 1-7 越界拒绝）；全知 = 全知权重（0-6，ReaderScope 注入、唯一语义来源）+ 虚拟挂载——权重 N 覆盖 ≤N 级非空组（虚拟"全知"），强制全知只覆盖七级组、仅 GM 持有；匹配扁平——matched = 双侧共同持有记号集（含虚拟挂载；cid/channel/location 命中归一化为类别记号）；condition 经注入 varReader 按读者变量树求真（被虚拟挂载覆盖的组跳过）；逐末端返回 {status, content, matched}；对象有效 TAG 集（落盘 ∪ 派生）由调用方注入，合并不在本层 | 禁 IO/LLM/server/truth（审计守护） | → tags/registry |

## src/vars/（变量树纯逻辑：模板/实例/从动；变量值与注册表均由调用方注入）

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `template.ts` | 变量模板与 TAG 附加文件契约：{world, character, types} 声明树 schema（容器/结构化数组/末端按字段判别——数组 = {array: {type} 引用结构别名 | {array: {children}} 内联元素结构，元素根不得又是数组；types = 纯 {children} 结构别名注册表；valueType 封闭集、字符串简写）、类型引用解析与成环拒绝（直接/间接递归都拒）、路径标记化 splitVarPath（`键[数字]` 精确下标 / `键[*]` 通配）、character 根保留名校验（attachtags 普通 string_list 末端 + tags union_attach string_list 从动末端——对象侧 TAG 纯名集合）、公式声明 schema（expr+binds / union_attach 仅 string_list 末端）；**系统声明分支并入**（systemChar.ts 常量：character 根 + relation 系统类型，与世界作者声明同名 = 拒装；模板出 character（并入后完整根）与 characterVars（作者子树，实例 normalize 用）双视图）；TAG 附加文件同构校验（根节点自身可挂条目）+ 节点级条目级联解析为 模板末端路径 → tag_list 映射（cid 类按属主分发，开放类别集合由调用方注入）；EMPTY_VARS_TEMPLATE（最小保留名空模板）/ EMPTY_VARS_TAGS（空双根附加）= 世界包缺文件时 GET 缺省空结构的唯一出处 | 无 | → shared/formula/systemChar（禁 IO/LLM/server/truth/application，审计守护） |
| `tree.ts` | 实例树：末端外壳 {value, tags, formula?} schema 与简写展开、结构化数组实例（元素对象数组，逐元素按元素结构对拍，元素自身无 tags 挂载位）、模板对拍校验（无声明有实例 = 拒绝、有声明无实例 = 合法空行为）、值类型校验、tag_list 写值校验（validateTagListWrite：内容侧挂载 {name, level 1-7}[]）与纯名集合写值校验（validateTagNamesWrite：attachtags 等 string_list 保留名末端 string[]）、validateSystemTags（系统末端 tags 侧车：系统分支末端路径 + 名称校验）——三函数共用 TagWriteScope 类别化口径（注册名 ∪ cid 现存 CID 实例 ∪ channel/location 声明即放行；CID 形态名按 cid 判定，未知 CID 拒绝；上下文调用方注入）、normalizeInstance 可选 scope 透传外壳 tags 名称校验（直编/容器整体写入通道）、TagMountSchema（truth 层 zod 契约复用）、路径解析（裸路径 = value、.tags 字段选择子、数组层按 `键[数字]` 下标穿越、不得穿越末端） | 无 | → template/systemChar/tags(registry 类型)（同上禁边） |
| `derived.ts` | 从动变量纯逻辑：expr 公式编译与变量闭包校验（binds 标识符 ↔ 同根模板路径）、union_attach 算子求值（自身 attachtags ∪ 显式子树路径下的全部 attachtags，string[] 按名去重）、依赖图构建与成环拒绝（拓扑序供写时级联重算）、根级从动计划（buildRootDerivedPlan：模板声明 ∪ 实例 formula 覆盖，`*` 通配段按实例树枚举——结构化数组枚举元素下标、cid 键控记录枚举键；数组元素结构内 formula 依赖按挂载路径补前缀）与实例侧目标求值（evalDerivedTarget：expr 依赖末端无实例 = 跳过） | 无 | → template/shared/formula（同上禁边） |
| `systemChar.ts` | 角色系统声明分支（代码持有常量，不进世界包模板文件）：name 等顶层字段与调度字段（acted/group/channel/timer/isPlayer/appearance，system 元数据）的声明子树 + 系统类型 relation（{cid, name, impression}，relations = 结构化数组，消费侧按元素 cid 匹配）；SYSTEM_CHAR_KEYS 分支键集；projectCharacterTree（类型化字段 + vars 树 → 单棵实例树投影，timer/channel null 原样呈现、initiative null = 无实例、relations 数组按下标投影（侧车键 = `relations[i].字段`），系统末端外壳 tags 取自 systemTags 侧车）。对 template/tree 仅 type-import（零运行时出边，template 解析期并入本模块常量，反向会成环） | 无 | 无运行时依赖（type-only → template/tree；同上禁边） |

## src/truth/

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `worldStore.ts` | world/pipeline 状态容器（纯内存）+ `_sys` 文件 codec（WorldSysSchema：必需对象，严格解析在 varWrite）+ 低层写入口 writeRaw（程序分支/varWrite 专用，产出 `world.…` VarChange）+ **StepChanges 分段契约**（setup/effects；flatChanges 扁平化出口；phase 不落盘、一律现算） | 无（落盘归 generationRepository） | → types/config（禁 agents/server/llm/application） |
| `stores.ts` | **TruthStores 七 Store 成组视图 + cloneTruth/adoptTruth/collectSave**（loop 与 application 规划器共用；纯内存，draft 失败即弃零副作用） | 无 | → truth 各 Store/generationRepository（SaveSet 类型） |
| `varChanges.ts` | VarChange 契约 + 真相根路径引擎（get/set/deleteByPath、makeVarChange；路径口径 `world.*` / `characters.CID.*`） | 无 | 纯逻辑（不依赖 truth 内其他模块） |
| `varWrite.ts` | 双根 deltas 应用编排：`world.…` / `characters.{cid}.…` 路由（路径支持 `键[数字]` 下标语法、落账归一为点分数字下标，`[*]` 通配写路径拒；系统分支/time/pipeline 拒写——vars 下首段命中系统声明分支键即拒，系统字段走白名单专用通道；系统末端 tags 侧车不开放 GM 写通道）、模板校验（无声明路径拒绝，角色域按 characterVars 解析）、attachtags 写值校验（validateTagNamesWrite 纯名集合）与 tag_list 写值校验（validateTagListWrite）——名称校验类别化（TagWriteScope：注册名 ∪ cid 现存 CID 实例 ∪ channel/location 声明即放行）、容器/数组整体写值经 normalizeInstance（同口径透传）、从动末端拒写（带 formula）；写落后整根从动级联（cascadeDerived：拓扑序全量重算该根全部从动末端，值变写回并追加 VarChange）；`_sys` 严格解析唯一出口（parseWorldSys：形状闸 + registry/template/varsTags 三套 parse + 从动依赖成环闸）+ varWriteDepsOf（categories 从注册表类别条目构建，cid 实例集 = 调用方注入的现存角色 CID 集合） | 无（纯内存变异） | → vars/tags(registry)/varChanges/worldStore/charactersStore（禁 agents/server/llm/application） |
| `charactersStore.ts` | 角色状态容器（纯内存）+ relations（{cid, name?, impression?}[] 数组，updateRelations 按 cid 匹配、VarChange 路径 = `relations.{下标}`）/长期记忆 VarChange + tagNames（vars.tags 池 string[] 纯名集）+ writeRaw 低层写入口（varWrite 与在场位写通道专用）；CharacterState 含 **appearance 在场位**（程序维护，默认 false）与 **systemTags 侧车**（系统分支末端路径 → {name, level}[]，只经直编修改，zod default {}，存档版本不变）；fromManifests/ensurePlayer 按 characterVars 声明 normalize vars 并物化初始 tags 池 | 无（同上） | 同上（CharacterManifest type-import 为例外，待契约迁移） |
| `events.ts` | 事件日志容器（纯内存；append/截断/TAG 过滤——readVisibleTo 注入 ReaderScope + 档内注册表逐事件求值）+ scanEventWatermark（事件 ID 水位，纯函数） | 无（同上） | 同上（→ tags 合法边） |
| `archive.ts` | 正文结果持久化 participants+scenes；步骤归档（纯内存） | 无（同上） | 同上 |
| `loreStore.ts` | lore 条目 + changelog（纯内存） | 无（同上） | 同上 |
| `promptsStore.ts` | 档内提示词副本（prompts.json = {schema_version, templates, placeholders}：templates 四键 character/gm/prose/gm-incident 齐备、缺键/多键/id 与键名不符拒装；placeholders = 全对象共享的声明式占位符目录，缺键拒装、分支记号集随 codec 规范化）+ PromptsStore（纯内存）：按 id 取模板 / placeholders() 目录 / replaceTemplate 单份整体替换 / replacePlaceholders 目录整份替换（编辑通道写接口）/ restoreData；activation 每轮激活读本 Store（编辑通道更新后下一轮即生效） | 无（同上） | → compile(template·placeholders schema)/saveSchema |
| `timeStore.ts` | time.json 档内副本（纯内存）+ 结构化时间渲染 | 无（同上；loadWorldTime 读 data/assets 例外） | 同上 |
| `generationRepository.ts` | **存档唯一写盘出口**：Generation 布局（CURRENT + generations/{rev}/ 七文件）、SaveSet 信封读写、**原子提交**（临时目录 → 重读 codec + validateSaveSet（默认 = validation/saveSet.ts，可注入替换）→ rename → CURRENT.tmp rename 切换；保留 current+previous，更旧 best-effort 清理；构造清理 .tmp 残留）、**灾备回退**（loadCurrent 对 corrupt/incomplete/invariant 回退上一代 + recoveredFrom；loadPrevious 显式灾备读取；加载与提交同一校验口径）、**类型化 SaveLoadError 错误分类**、baseRevision 乐观并发闸（RevisionConflictError）、无 CURRENT 的平铺档拒载 | 读写 data/users/{user}/save/{runId} | → truth 内部/types（runDir + RepoIo/validator 注入，禁 config/agents/server/llm） |
| `validation/errors.ts` | 类型化存档错误：SaveLoadError（kind = not_found/incomplete/version/corrupt/invariant/io）+ RevisionConflictError（base/current 双值） | 无 | 纯类型（不依赖 truth 内其他模块） |
| `validation/saveSet.ts` | **两级校验第二级**：validateSaveSet 整档跨文件不变量（pipeline/archive/events 边界与对应、事件 id 唯一、working_set 言行条目 cid 与通知条目 actor/archive 角色步引用闭包、CID 键形、lore id 唯一与 changelog seq 整数；只校验可提交态，多个 isPlayer 合法），失败抛 invariant | 无 | → generationRepository（SaveSet 仅 type-import）/workingSet/errors |
| `validation/fileSchemas.ts` | 七个 File schema 汇聚出口（两级校验第一级 = 文件 codec；本体留各 Store 文件，本文件仅 re-export） | 无 | → truth 各 Store |
| `commitExecutor.ts` | **一次命令一个提交的唯一落地入口**：CommitPlan（transactionId=`tx-{next}` 确定性 / baseRevision / reason=init·step·gm·rollback·admin_edit / changes=与归档 changes 同一份；plan 不落盘）→ baseRevision 校验（经 repo 闸）→ validateSaveSet（repo 钩子）→ repo.commit；GameSession 写盘路径全经它 | 经 generationRepository | → generationRepository/varChanges（禁 agents/server/llm） |
| `workingSet.ts` | 工作集（当前轮未清算言行）：条目并集 = 言行条目 {cid, input?, decision?} | 系统通知条目 {id, author:"system", notice, tags}——schema（封闭 type 枚举 gm_request/leave/recall/contact）、标记 → 通知条目纯函数（noticesOfMarkers/appendNotices，同 type 固定 ID 复用）、言行条目焊死映射挂载派生（speechEntryTagsOf：发言 {aud@1,vis@1} / 行为 {vis@1}；字段 A 追加频道@2 + {A@3,V@3}、字段 B 追加地点@2；extraMounts = 世界性安插预留入口）、机械文案（renderNoticeText）与渲染（renderScene/renderSpeech——正文取材跳过通知条目） | 无 | → types/truth(identity) |
| `saveSchema.ts` | SAVE_SCHEMA_VERSION 常量 + version 类错误统一措辞（INCOMPATIBLE_SAVE_MESSAGE；schema_version 不符/平铺档拒绝，判别走 SaveLoadError.kind="version"） | 无 | 无依赖 |
| `snapshot.ts` | 注入层状态序列化（timer 结构化渲染等）+ **DeepReadonly/deepFreeze**（恒冻结策略：repo.loadGeneration 返回前 + GameSession 每次 commit/adopt 后递归 Object.freeze，查询出口返回 DeepReadonly，越界写入测试期立刻爆炸） | 无 | → truth 查询 |
| `varDiff.ts` | 状态直编 diff：净额并入当步 changes；末端外壳（{value, tags?, formula?}）= 原子叶（与 varWrite 末端级 VarChange 同粒度） | 无 | 纯逻辑 |
| `identity.ts` | @CID 占位渲染/姓名替换（relations = {cid, name?, impression?}[] 数组，按元素 cid 字段扫描匹配） | 无 | 纯逻辑 |
| `lorebook.ts` | 世界书条目模型与匹配（getByTags = 逐条目 evaluateTagFilter，ReaderScope + 注册表注入；无挂载条目 = 广播恒过） | 读 data/assets | → config/tags |

## src/contracts/（禁依赖 truth/agents/server/llm/application）

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `config.ts` | 配置契约：ServerConfig/UserSettings/ApiPreset/ResolvedAgentConfig/**ConfigStateView**（GET /api/config 脱敏视图）+ **配置事务 mutation 契约**（PresetMutation/SettingsPatch/ConfigPutBody/ConfigMutation 判别联合）+ **FileConfigSchema/validateFileConfig**（旧版 config.json 文件形状唯一出处，唯一消费方 = configService 迁移闸） | 无 | zod + contracts/secrets |
| `secrets.ts` | 密钥契约：SecretKind/Record/File/State/Mutation + 掩码 | 无 | zod |
| `protocol.ts` | **WS 入站协议唯一权威**：ClientCommandSchema（zod discriminated union，.strict() 分支）+ parseClientCommand（非法 JSON/null/数组/未知 type/字段错误 → ProtocolError 稳定 message）+ PauseOptionsSchema；消息身份字段（全部可选）：mutation 带 requestId/runId/baseRevision，pause_options·stop·query·new_session·load_session 免 baseRevision，player_input 的 runId 可省略（首次输入自动建会话），new_session 无 runId，stop 另带可选 activationId；重 roll = rollback_and_continue 复合命令 | 无 | zod |

## src/resources/（只允许依赖 shared/contracts + types；禁反向依赖 config）

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `userDirectories.ts` | 用户目录解析：data/assets/{世界包}/（设定集 + incident.json 突发公式配置 + 包内 prompts/ 完整提示词副本：三 activation + gm-incident）+ data/users/{username}/（secrets.json / api-presets/ / settings.json / save/ 存档家目录）；default_user 唯一出处；config.ts 路径常量由此派生 | 无（纯路径计算） | → shared |
| `secretsRepository.ts` | 密钥仓储：secrets.json 原子读写（.tmp→rename；缺文件=空；损坏 → 类型化错误）+ applySecretMutation 纯变换（write/delete/activate/rotate/rename；delete active 后取剩余首条继任）+ toSecretState 掩码投影 | 读写 data/users/{user}/secrets.json | → shared/contracts(secrets) |
| `presetsRepository.ts` | API 预设仓储：api-presets/{id}.json 逐文件 CRUD/duplicate（id 经 safeSegment；ApiPresetSchema 校验） | 读写 data/users/{user}/api-presets/ | → shared/contracts(config) |
| `settingsRepository.ts` | 用户设置仓储：settings.json（UserSettings + configRevision）读写；缺文件=默认 | 读写 data/users/{user}/settings.json | → contracts(config) |
| `runRepository.ts` | 存档仓储：listRuns/别名读写/deleteRun/readRunArtifact；RunRepositoryError 稳定码（RUN_NOT_FOUND/LEGACY_RUN_UNSUPPORTED/RUN_CORRUPT/SESSION_ACTIVE/INVALID_ALIAS）；无 CURRENT → LEGACY_RUN_UNSUPPORTED；产物缺失 → RUN_NOT_FOUND；JSON 损坏 → RUN_CORRUPT | 读写 data/users/{user}/save/ | → shared/types(zod) |
| `worldRepository.ts` | 世界仓储：listWorldSets/resolveWorldDir（canonical 实现，config.ts 委托于此）+ 世界三文件读写 + 变量体系文件读写（tags.json 注册表只读 + vars-template.json/vars-tags.json 可写，缺文件读 → null 由路由层给缺省空结构，写即创建）+ 角色 manifest 路径/读写 + **包内提示词文件读写（{packDir}/prompts/{agent}.prompt.json 四份模板 + placeholders.json 占位符目录读写）** + validateLorebookPayload；WorldRepositoryError（WORLD_SET_NOT_FOUND/CHARACTER_NOT_FOUND/INVALID_WORLD_SET）；结构校验（CharacterManifest/PromptTemplate/PlaceholderCatalog schema 属 agents/compile、parseVarsTemplate/parseVarsTags 属 vars）留在 server 路由层 | 读写 data/assets/{包}/ | → shared/types(zod) |

## src/shared/（禁依赖 src 内任何模块）

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `safeSegment.ts` | 路径段安全校验（防目录穿越） | 无 | 纯函数 |
| `formula.ts` | 世界包公式求值器：小型数学表达式语言（数字/标识符/+ − * / ^/括号/一元负号/函数 ln·exp·sqrt·abs·tanh·sigmoid·clamp·min·max/骰子项 NdM）编译为可复用闭包；解析期报语法/未知函数错，未知变量求值期报错；骰子经结构化 `(face)=>number` 注入（不 import ports） | 无 | 纯函数 |

## src/server/

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `index.ts` | **组成根**：只装配依赖并启动——WsTransport + WsController + createApiHandler + serveStatic；Coordinator 的 displayFactory/onTransition 重绑到本服 transport 广播；loadServerConfig → 接入边界（HTTP handler/WS upgrade 入口过 accessControl，拒绝 → 403）+ allowKeysExposure 注入 ApiDeps；startServer(options?: {host, port, coordinator, dirs, configFile, serverConfigFile, serverConfig}) 可注入（测试基建：临时资源目录 + fake factory，缺省走 env/生产现状） | 网络 | → server 内部/application(sessionCoordinator)/resources/config/serverConfig |
| `static.ts` | 静态文件服务（伺服 web/，拒目录穿越） | 读 web/ | → config(PROJECT_ROOT) |
| `ws-transport.ts` | WS transport：upgrade（只认 /ws；attach 接受 checkUpgrade 注入——接入边界判定在 accessControl，拒绝 → 403 响应后 destroy）/连接集/序列化/单播/广播；onConnect/onMessage 回调注入——不认识 ClientCommand | 网络 | → ws-protocol（类型） |
| `ws-controller.ts` | WS controller（线协议不变）：parseClientCommand → Coordinator → 定向 command_result/command_error（requestId 关联，异常 → 稳定 code：REVISION_CONFLICT 附 details 双值）；runId 身份核对（不符 → SESSION_SWITCHED）；重连单播/会话切换广播/query 跳号恢复的一致 snapshot | 网络（经 transport） | → application(sessionCoordinator)/contracts/truth(errors)/ws-transport |
| `ws-protocol.ts` | WS 下行 ServerMessage 类型唯一出口：command_result/command_error（ProtocolErrorCode 七值）/transition/snapshot（载荷类型来自 application/transitionProjection.ts）/流式七种（agent_start·delta·reasoning·agent_end·retry·decision·adjudication，全部带 runId+activationId） | 无 | → application(transitionProjection 类型)/types |
| `display.ts` | WebDisplay（Display 接口的 WebUI 实现；构造绑定 runId，agentStart 记录 activationId，全部流式消息盖 {runId, activationId}，agentEnd 清空） | ws 推送 | → display 接口/ws-protocol |
| `http/response.ts` | HTTP envelope：成功 {ok:true,data} / 失败 {ok:false,error:{code,message,details?}}；sendJson/sendOk/sendFailure + readBody/parseJsonBody（非法 JSON → 400 BAD_JSON）/requireStringField | 网络 | → errors |
| `http/errors.ts` | ApiError{status,code,details?} + toApiError 收敛（ZodError→400；RunRepositoryError/WorldRepositoryError/配置三仓储按码映射；ConfigServiceError→400/409/500（CONFIG_INVALID/CONFIG_REVISION_CONFLICT·PRESET_IN_USE/CONFIG_APPLY_FAILED）；RevisionConflictError→409 附双值；「LLM 运行中」→409 SESSION_BUSY；未预期→500 INTERNAL_ERROR）+ validate() 校验段包装；403 FORBIDDEN（secrets view 未开 allowKeysExposure）；401 留码位未启用 | 无 | → application(configService)/resources/truth(errors)/zod |
| `http/router.ts` | {method,pattern,handler} 轻量路由表 + :param 段匹配；路径无匹配 → 404 UNKNOWN_ENDPOINT，路径匹配方法不符 → 405 + Allow；createApiHandler 组装八个分域 routes（唯一收口）；ApiDeps.config = ConfigServiceDeps（配置事务注入位）+ allowKeysExposure（由组成根从 server.json 注入） | 网络 | → routes/*/errors/response |
| `http/routes/config.ts` | GET/PUT /api/config（GET 返回 ConfigStateView 脱敏视图；PUT = settings/agent 绑定 patch，带 baseConfigRevision，走 configService 事务） | 经 configService | → application(configService)/contracts/config/errors/response |
| `http/routes/secrets.ts` | /api/secrets/*：GET state / POST write / activate / rename / DELETE / view（allowKeysExposure=false → 403 FORBIDDEN） | 经 configService | → application(configService)/errors/response |
| `http/routes/presets.ts` | /api/presets CRUD + duplicate（被任一 agent 绑定引用的 preset 拒删 → 409 PRESET_IN_USE） | 经 configService | → application(configService)/errors/response |
| `http/routes/worlds.ts` | GET /api/worlds、GET /api/world、GET/PUT /api/world/:name（?set=；name ∈ 三文件 + vars-template/vars-tags 可写、tags 注册表只读 GET；缺文件 GET 回缺省空结构/空注册表、PUT 创建；PUT vars-template 过 parseVarsTemplate、vars-tags 过 parseVarsTags 对拍同包模板，失败 400 零落盘；PUT markStale 新会话生效） | 经 worldRepository | → resources/config(DEFAULT_WORLD_SET)/vars(template)/errors/response |
| `http/routes/characters.ts` | GET /api/characters[/:id]（?set=）+ PUT（validateCharacterManifestForPath：schema + 路径 id 对拍，C0 唯一 isPlayer；markStale） | 经 worldRepository | → agents(character schema)/resources/errors/response |
| `http/routes/prompts.ts` | GET /api/prompts[/placeholders] + PUT /api/prompts/:agent + PUT /api/prompts/placeholders（模板键 = 封闭四值 character/gm/prose/gm-incident；**双模式**：有活跃会话 → 读写档内副本（PUT 经 Coordinator direct_edit 入队 + CommitExecutor，下一轮激活生效，应答附 revision）；无会话 → 读写世界包基线（?set= 定位包，缺省 DEFAULT_WORLD_SET，新会话生效）；validatePromptPayload：结构 + 占位符合法性对当前模式占位符目录键集；placeholders GET = 平铺目录（条目名 + description + source + 段列全文）+ source 封闭枚举清单，PUT = 整份提交——parse + validatePlaceholders 语义机检（档内 = 档内 `_sys` 模板与注册表，包基线 = 该包变量体系文件，缺文件 = 包损坏），失败 400 零落盘，包基线写后 markStale；包选择器界面未做） | 档内经 Coordinator；包基线经 worldRepository | → compile(placeholders/template)/resources/truth(promptsStore 键集/varWrite)/tags(registry)/vars(template)/errors/response |
| `http/routes/sessions.ts` | GET /api/sessions、GET /api/sessions/:id/:kind（回放产物）、GET llm-recent/:slug、POST rename、DELETE（拒删活跃 409） | 经 runRepository/llm(recent) | → resources/llm/shared/errors/response |
| `http/routes/activeSession.ts` | PUT /api/session/state 直编（Coordinator direct_edit 入队；busy → 409 SESSION_BUSY，域校验失败 → 400；commit → transition 广播；body 可选 baseRevision 乐观并发闸 → 409 REVISION_CONFLICT；body 可选 sys {varsTemplate?, varsTags?} = 结构编辑档内副本——服务端取当前 world 替换 `_sys` 对应键后走同一直编通道，sys 与 world 互斥 400，无会话 404 NO_ACTIVE_SESSION；成功应答附 revision）+ GET /api/session/state/sys（档内结构编辑源：`_sys` 的 varsTemplate/varsTags/tagRegistry + baseRevision；无会话 404 NO_ACTIVE_SESSION） | 无直接 IO | → application(errors/response) |
| `accessControl.ts` | HTTP/WS 接入边界纯判定：checkHttpAccess/checkWsUpgrade——Host 头须等于监听地址或命中 hostWhitelist（loopback 默认放行 localhost/127.*/[::1]）；WS Origin 存在时其 host 须匹配 Host；ipWhitelist 非空时 remoteAddress 须命中（::ffff: 归一）；拒绝 → 403 | 无 | → serverConfig(类型) |

## web/（无构建 Vanilla ESM 前端）

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `protocol.js` | 浏览器唯一协议适配器：buildCommand（字段白名单，未知字段抛错）+ serialize；`createProtocol({transport, store, onStreaming, onUncorrelated})`——sendCommand 自动附加消息身份（requestId 随机 + 从 store 读 runId/revision，未连接立即 reject）并返回 Promise（pending Map 按 requestId 关联 command_result/command_error）；handleMessage 路由：result/error→pending、snapshot/transition→store（needsResync 自动补 snapshot query）、流式七种→store 身份槽校验后直通 onStreaming；纯 ESM 零 DOM 零 socket 构造（node:test 可直接 import；`protocol.d.ts` 供 TS 契约测试） | 无 | → session-store/session-transport（仅类型，运行时装配注入；与 contracts/protocol.ts 契约测试对拍） |
| `session-store.js` | 会话状态 store：服务端权威状态唯一前端持有者（runId/revision/connection/world/characters/events/history/pipeline/streaming 槽/needsResync）；纯 reducer（dispatch snapshot/transition/流式/connection 内部消息）+ subscribe（meta 带 runIdChanged 信号/changed 域）；transition 仅 runId 匹配且 fromRevision 连续才应用否则置 needsResync；selectBusy = streaming 非空 \|\| phase ≠ await_player（输入权限唯一数据源，busy 语义单测锁死）；零 DOM 零网络（`session-store.d.ts` 供 TS 测试） | 无 | 无依赖 |
| `session-transport.js` | WebSocket 传输层：独占唯一 socket——connect/send/reconnect/dispose + getState；connection generation 守卫（每次 connect ++gen，旧 gen 回调一律丢弃）；单一 reconnect timer（先清后挂）+ 指数退避 1s→2s→4s 封顶 10s（open 复位）；send 未连接返回 false；dispose 后无重连；WebSocket 构造器/url/时钟全部注入（测试 fake；`session-transport.d.ts` 供 TS 测试） | WebSocket | 无依赖 |
| `resource-context.js` | 资源上下文：世界/角色等用户资源 URL 唯一构造口——`createResourceContext({username, worldSetId})` 捕获即不可变（冻结），worldUrl/worldFileUrl/charactersUrl/characterUrl 全携带 `?set=`（worldSetId 必填即抛）；编辑表单打开时捕获、保存写同一 ctx，不随 picker 漂移；纯 ESM 零 DOM 零网络（`resource-context.d.ts` 供 TS 测试） | 无 | 无依赖 |
| `async-guards.js` | 四个竞态的可测纯逻辑（零 DOM 零网络，fake 注入驱动单测）：createEpochGuard（会话详情 epoch 守卫）/ fetchRunDetail（回放五端点取数归一，数据与渲染分离）/ fetchKnownChars + sameCharsIdentity（CID 取数与晚到写闸）/ isModalLive（modal runId 身份 + isConnected 双核验）/ loadSessionThenNavigate（command_result 成功才导航）（`async-guards.d.ts` 供 TS 测试） | 无 | 无依赖 |
| `views/play-stream.js` | 游玩页流区 view：流式卡片（三 agent 同构 panel + 突发 incident 轻量卡（无菜单不可编辑）+ 思维链/原始返回/提示词模态 + 回滚/重 roll/编辑菜单）/ 决策分节渲染 decisionSections（NPC 卡与玩家卡共用，玩家卡带"你"标签、菜单含原始返回编辑/回滚、data-kind/seq 寻址 + onEditedResult 原地重渲）/ panels 卡片 Map / renderHistory / 钉底滚动；会话 modal 打开捕获 runId、await 后 isModalLive 核验，全部经注入的 trackModal 进统一生命周期；el/api/getState/命令通道/confirm 全注入（import 期零副作用；fake element 桩可测，`play-stream.d.ts` 供 TS 测试） | 无（DOM 经注入 el） | → async-guards |
| `views/play-input.js` | 游玩页输入区 view：三块输入（台词/行动/内心）+ 五标记区（chips + 召回/联系参数表单）+ relations 记录条（复用联系标记目标选择模式，name/impression 至少其一，缺 target 或全空即禁发送）+ 暂停选项行（localStorage 持久化）；持有 transient UI 态（markers/relations/knownChars/blockEls/pauseState）；refreshCids 捕获 {runId, worldSetId} 晚到核验弃写；el/api/身份读取/回调全注入（fake element 桩可测，`play-input.d.ts` 供 TS 测试） | 无（DOM 经注入 el） | → async-guards |
| `views/state-editor.js` | 直编 modal view：「变量 / 事件」两标签页（一次只显示一个，display 切换）——变量页挂 var-tree-editor（状态编辑，注入 scrollHost=modal 滚动容器保持 scrollTop + onEdit 脏标记），事件页维持 raw JSON；打开捕获 {runId, baseRevision} + 深拷贝 store world/characters 为工作副本；保存 PUT /api/session/state 带 baseRevision——**成功不关窗**（行内「已保存」短提示 + baseRevision 用应答 revision 与同 runId store revision 取大推进 + 清脏），409 REVISION_CONFLICT → 编辑器内提示「状态已变化，请刷新」不静默覆盖，域校验 400 原样展示；取消/点遮罩有未保存修改先 confirm（注入）确认；保存前核验 store runId（切 run 拒写）；overlay 经 trackModal 注册；el/api/getState/trackModal/mountModal/confirm 全注入（fake element 桩可测，`state-editor.d.ts` 供 TS 测试） | 无（DOM 经注入 el） | → var-tree-model/var-tree-editor |
| `views/system-char-decl.js` | 角色系统声明分支的 web 侧共享镜像（纯常量，零 DOM 零网络，node:test 可直接 import）：SYSTEM_CHAR_DECLS（character 根系统声明子树——name 等顶层字段 + 调度字段 acted/group/channel/timer/isPlayer/appearance，原始声明形态：字符串简写末端/{children} 容器/{array} 结构化数组；键序 = 界面呈现序，位于作者声明之前）+ SYSTEM_CHAR_TYPES（系统类型 relation = {cid, name, impression}，relations 数组元素结构引用）+ SYSTEM_CHAR_KEYS 分支键集。**src/vars/systemChar.ts 的镜像，变更需两侧同步**；代码常量不进世界包模板文件——声明树编辑器只读展示、绝不写回保存载荷（`system-char-decl.d.ts` 供 TS 测试） | 无 | 无依赖 |
| `views/var-tree-model.js` | 树状变量编辑器数据核心（纯逻辑，零 DOM 零网络，node:test 可直接 import）：**只做实例状态编辑**（游玩页直编 modal；声明树结构编辑在世界页 var-decl-model）。持有 world/characters 工作副本，按 `_sys.varsTemplate` 原始声明树构建视图模型（世界树滤掉 time/`_sys`；从动末端 = 声明带 formula 或实例带 formula，值只读并出结构化 formula 只读标注；实例简写读出容错；未声明键 unknown 呈现）；角色树 = **系统声明分支投影（系统声明镜像取自 system-char-decl.js：值从类型化字段读出，timer/channel null 原样、initiative null = 容器无实例、relations = 结构化数组按下标投影）+ vars 实例树，同一棵树不分区**；系统只读收窄为 {acted, group, channel, timer, isPlayer, appearance}（徽记「系统」）；操作 = 末端写值（系统路径回写类型化字段：omniscience 前端钳制 0-6、initiative null 两值齐全整体写回、relations 元素字段（`relations[i].字段`）、long_term_memory；vars 路径物化外壳，沿途按声明补建容器/数组）/ 外壳 tags 编辑（全部末端可编——系统末端写 systemTags 侧车（数组层键 = `键[下标]`，relations 元素删除顺带重映射）、vars 末端写外壳）/ relations 条目增删（addRelationEntry 按 cid 追加 / 元素删除按下标）/ 结构化数组元素增删（按元素结构物化空白，只动实例不动模板）；**附加来源 tags 只读合并显示**：每末端 attachTags = `_sys.varsTags` 读取期合并结果（resolveAttachTagsMirror = src/vars/template.ts resolveAttachTags 的镜像，变更需同步：节点级扇出/末端级单挂/数组整型挂载 `[*]` 占位按下标匹配/cid 类别按当前 scope 角色 CID 分发，world 域无属主遇 cid 条目跳过；与实例 tags 按名去重实例优先）——**只作显示，绝不写进实例值**（工作副本/getPayload/normalize 输入/侧车零泄漏，测试钉死）；getPayload 出 {world, characters} 保存载荷（`_sys.varsTemplate` 原样随 world 上送；`var-tree-model.d.ts` 供 TS 测试） | 无 | → var-decl-model（声明树共享原语：VALUE_TYPES/classifyRawDecl/defaultValueFor/validateBaseName/formulaViewOf/isPlainObject/splitVarPath/isIndexSegment）/system-char-decl（系统声明分支镜像） |
| `views/var-tree-editor.js` | 树状变量编辑器 DOM 层（直编 modal 变量区，只做状态编辑）：渲染 var-tree-model 视图模型——世界作用域 =「世界变量」、角色作用域 =「角色变量」单区块（系统分支投影 + vars 树同一棵树，不分区）；树形缩进（.vte-kids 左侧参考线）+ 容器折叠箭头（默认展开，按 scope\|path 持有）+ 行 hover 浮现小型操作钮（结构化数组元素 +/×（+ 直接追加空白元素，relations 开行内 CID 表单）、tags）；外壳 tags = chip 胶囊（名称 + 等级小字 + ×，行尾小型添加，名称 datalist 来自 `_sys.tagRegistry` 可自由输入 + level 1-7；全部末端含系统字段可编；附加来源 attachTags 以「附加」徽记只读 chip 并入同一 chips 区——无 ×、不出添加控件，tags 钮计数 n+m）；attachtags/tags 池 = string_list 纯名集合（名称 chips 无等级列，池只读从动）；系统调度字段只读值 + 系统徽记；从动末端只读值 + formula 只读标注 + 从动徽记；initiative null 两值齐全整体写回；模型操作报错落编辑器内错误行；可选注入 scrollHost（整树重渲保持其 scrollTop 不跳顶）与 onEdit（操作成功回调 = 外层脏标记）；el/model 注入，import 期零副作用 | 无（DOM 经注入 el） | → var-tree-model |
| `views/var-decl-model.js` | 变量模板声明树结构编辑数据核心（纯逻辑，零 DOM 零网络，node:test 可直接 import；世界页「变量模板」子区）：持有 vars-template 原始声明树工作副本 {world, character, types?}，纯声明编辑无实例列——视图 = declTerminal/declContainer/declArray（结构化数组：引用类型不展开、内联元素结构经 `[*]` 路径递归编辑）+ 类型区（typeRoot/typeDecl*，含 typeDeclArray），character 根必需声明 attachtags/tags 保护性拒删（补齐豁免保留名）；**character 根视图并入系统声明分支显示（镜像取自 system-char-decl.js，系统节点 system 标记 + canDelete=false 全操作禁，作者子树原序随后；系统路径一切写操作抛错，保存载荷仍是原始作者模板）**，formula 校验的根内路径解析同样并入系统分支（作者公式可绑系统 number 末端，与服务端并入后解析口径一致）；操作 = addDecl/deleteDecl（扁平末端五 valueType 简写/结构体/结构化数组（引用类型/内联元素结构）；character 根与系统分支键同名 = 已存在拒绝）/ 类型区（新建、字段增删只摘声明、删除类型预检引用含数组元素 {type} 引用）/ setDeclFormula（声明层 expr+binds/union_attach（仅 string_list 末端）校验 + character 根契约保护）/ setTypeDeclFormula（类型声明内末端 formula 编辑：binds/paths 以类型根为基准校验，引用类型数组元素内末端不开放）；同时是声明树共享原语唯一出处（var-tree-model/vars-tags-model 复用）；getTemplate 出保存载荷（`var-decl-model.d.ts` 供 TS 测试） | 无 | → system-char-decl（系统声明分支镜像） |
| `views/vars-tags-model.js` | TAG 附加文件编辑数据核心（纯逻辑，零 DOM 零网络；世界页「TAG 附加」子区）：按 vars-template 声明树投影编辑视图（无实例列；**character 根投影并入系统声明分支——镜像取自 system-char-decl.js，系统节点同样可挂附加条目，与服务端 parseVarsTags 按并入后根校验口径一致；类型解析回退系统类型 relation**），节点（含根节点自身，rootEntries）挂附加条目（{name/category, level 1-7} 恰居其一；根挂 = 级联到该根全部末端，character 根可挂 cid 类别按属主分发）；setNodeTags 整条目表替换——路径对拍模板（数组不穿越）、沿途物化稀疏节点、空条目回剪（空壳 children 一并摘）；结构化数组整型挂载（{tags, array} 形式，array = 元素类型名/内联为 "*"，扇出到元素结构全部末端），children 旧形态存在即拒整型覆盖（不丢数据）；getPayload 出保存载荷（`vars-tags-model.d.ts` 供 TS 测试） | 无 | → var-decl-model（classifyRawDecl/isPlainObject）/system-char-decl（系统声明分支镜像） |
| `views/var-decl-editor.js` | 世界页「变量结构」DOM 层：createVarDeclEditor（声明树编辑——根切换 世界/角色共享模板 + 声明树区 + 类型区；**系统声明分支节点带「系统」徽记、全部结构操作（+/×/ƒ）不渲染**；容器「+」行内设定表单（名称 + 种类：五 valueType 扁平末端/结构体/结构化数组（引用类型或内联结构），纯声明无初始值）、× 删声明/类型/字段、ƒ formula 行内表单（expr+binds / union_attach paths / 选「无」清空；类型声明内末端同表单，提示「类型内公式路径以类型为根」））+ createVarsTagsEditor（附加条目 chips：根节点自身条目行 + 树下各节点；添加下拉选「名称」（datalist 来自当前模式注册表可自由输入）或「cid 类别」（按属主分发）+ level 1-7；结构化数组整型挂载、children 旧形态只读提示）；复用 .vte 样式；模型操作报错落编辑器内错误行；el/model 注入，import 期零副作用 | 无（DOM 经注入 el） | → var-decl-model/vars-tags-model（仅类型，运行时装配注入） |
| `views/var-struct-source.js` | 世界页「变量结构」双模式数据源纯逻辑（零 DOM 零网络，node:test 可直接 import）：模式判定（GET sys 端点 404 NO_ACTIVE_SESSION = 包基线模式）+ 模式提示行文案 + 档内模式保存载荷构造（sys 两份文件整体提交 + baseRevision 乐观闸）+ 保存成功后 baseRevision 推进（取应答 revision，缺省保持）（`var-struct-source.d.ts` 供 TS 测试） | 无 | 无依赖 |
| `pages/play.js` | 游玩页编排层：装配 store←transport→protocol + 两个 view；store.subscribe → 侧栏/权限/runId 行重渲 + snapshot 整段重渲历史 + runId 变化 transient reset（inputView.resetTransient + closeSessionModals 统一关 modal）；onStreaming 直通 streamView；busy/权限全部从 store 派生；sendSessionCommand 供会话页读档 | WebSocket（经 transport）+ fetch（api） | → app/protocol/session-store/session-transport/views/* |
| `pages/sessions.js` | 会话页：loadRun 模块级 epoch 守卫 + AbortSignal（快速点击晚到弃写；取数 = async-guards.fetchRunDetail，渲染分离）；「读取」改 async——load_session 成功才 navigate("play")，失败（含 WS 未连接）原页报错不导航 | fetch（api） | → app/async-guards/play（sendSessionCommand） |
| `pages/world.js` | 世界页（ResourceContext 接线）：世界包选择器（/api/worlds）+ setting/tone-card 编辑器 + lorebook 表格（tags = {name, level} 结构，编辑文本形态 "名称:等级" 逗号分隔、等级省略 = 1）+ 变量结构区（变量模板声明树编辑 + TAG 附加编辑，**双模式**：打开探 GET /api/session/state/sys——有活跃会话 = 档内模式（数据源 = 应答 _sys 三键 + baseRevision，保存 = PUT /api/session/state 带 sys 两份整体上送 + 乐观闸，立即生效，409 提示重取），404 NO_ACTIVE_SESSION = 包基线模式（PUT 包文件，400 原样展示，新会话生效）；模式指示行常显，编辑器本体复用，TAG 附加按打开时加载的模板对拍）；打开即捕获不可变 ctx（GET/PUT 全程 ?set=），切包 = 重新捕获 + 重载表单，界面常显「正在编辑」包名 | fetch（api） | → app/resource-context/views(var-decl-editor/var-decl-model/vars-tags-model/var-struct-source) |
| `pages/characters.js` | 角色页（ResourceContext 接线）：世界包选择器 + manifest 表单；同 world 页口径（ctx 捕获 + ?set= 全程 + 切包重载） | fetch（api） | → app/resource-context |
| `pages/prompts.js` | 提示词页：四页签模板模块列表编辑（增删/排序/key/role/content，保存 = PUT 整体替换 modules）+ 第五页签「占位符」= 占位符目录结构化编辑器（条目增删/key/description/source 下拉（候选 = GET 应答 sources 封闭枚举）+ 段列编辑——静态段文本、条目段 pass/fail 模板 + 分支动态行（记号集输入 datalist 候选 = 当前模式 TAG 注册表名集：档内 GET /api/session/state/sys、无会话 GET /api/world/tags，拉不到则纯文本输入）+ order 下拉 + separator/merge；保存 = PUT /api/prompts/placeholders 整份提交，机检 400 原文回显）+ 右侧平铺目录侧栏；双模式与生效口径由服务端透明处理（页首提示行常显） | fetch（api） | → app |
| `pages/config.js` | 配置页：密钥（增/激活/重命名/删/查看明文 403 提示）+ API 预设（增删改/复制，409 PRESET_IN_USE 提示）+ Agent 绑定 + 运行设置四区；页面持有 configRevision，全部 mutation 携带 baseConfigRevision，成功用返回 {configRevision, view} 原地更新不重取，409 CONFIG_REVISION_CONFLICT → 提示并重取；请求体构造全走 views/config-form.js（密钥值绝不回填） | fetch（api） | → app/views/config-form |
| `views/config-form.js` | 配置页请求体构造纯逻辑（零 DOM 零网络）：留空=保持不变 patch 语义、掩码值出现即拒构造防呆、preset 表单→payload | 无 | 无依赖 |

## scripts/

| 路径 | 职责 | IO | 依赖方向 |
|---|---|---|---|
| `check-dependencies.ts` | 依赖审计：禁边/传递依赖/import 循环（TS Compiler API） | 读 src | 独立脚本 |
| `run-suite.ts` | 测试套件 runner（读 test-suites.json，spawn node --test） | 进程 | 独立脚本 |
| `test-suites.json` | 四层套件清单：unit/contract/application/integration | 无 | — |

## test/

| 路径 | 职责 |
|---|---|
| `builders/index.ts` | 最小合法内存对象 + overrides（不写盘）；buildTruthStores/buildProjectionHost（投影层/activation 直构造测试的全内存七 Store 与 RenderHost） |
| `fakes/chatPort.ts` | ScriptedChatPort / FakeChatScript（替代 LLM prototype patch） |
| `fakes/deferredChatPort.ts` | DeferredChatPort（集成测试）：chat() 挂起由测试手动 resolve/reject，abort → LLMAbortedError；auto 非空走脚本化快速应答 |
| `harness/tempDir.ts` | 统一临时目录 + 自动清理（Windows rm 重试） |
| `harness/session.ts` | SessionHarness：临时 save/assets（世界包含包内 prompts/ 四份模板 + placeholders.json 拷贝 + incident.json 突发公式默认配置 + 变量体系三文件：tags.json system 条目（含 cid/channel/location 三类别）/vars-template 测试模板（setupWorld 可覆盖）/vars-tags 空结构；CharSpec.vars 注入 manifest 初始变量树，缺省 attachtags [aud, vis] 感知基线）+ fake LLM + 队列骰子装配 |
| `harness/server.ts` | serverHarness：tempDir + fake SessionFactory（真实 GameSession + DeferredChatPort）+ startServer 注入（port 0 + 临时 UserDirectories/configFile，不触碰真实用户数据）+ 真实 ws 客户端 helper（消息全录 + waitFor 谓词等待） |
| `harness/legacyConfigResolver.ts` | 旧版 config.json 分层解析（resolveAgentConfigs）对拍基准（纯函数零 IO，仅迁移等价性测试消费） |
| `incident.test.ts` | 突发公式单测：D 双算法/f(D)/g(T) 锚点、p恶性 clamp、程度区间、evaluateIncident 逐组投骰与多组取高 |
| `formula.test.ts` | 公式求值器单测：优先级/^右结合/一元负号/函数库/骰子项顺序消费/语法与未知变量报错 |
| `varTreeModel.test.ts` | web 树状变量编辑器数据核心单测：视图模型（_sys/time 过滤、系统分支投影（relations = 结构化数组按下标投影）、系统调度字段只读、从动判定）、系统末端写值（clamp/initiative 整体写回/relations 元素字段/long_term_memory）、末端写值/tags 编辑（含 `键[下标]` 路径与侧车重映射）、结构化数组元素增删、附加来源 tags 合并显示（`[*]` 通配）与零泄漏红线、保存载荷 |
| `incidentFlow.test.ts` | 突发管线集成（SessionHarness）：命中 → incident 步归档 → 目标组 timer 对齐 → 角色/GM 两侧当前场景注入 → GM 转写后注入消解 → 回溯复活重评 |
| `presence.test.ts` | 在场性 TAG 化契约（全内存）：appearance 程序维护四时点（弹出/结算/入组含远程按组籍/离组 + 回溯还原）+ vars 源全量遍历与 fappear 虚拟挂载四档可见性（权重 0 不见后台/权重 6 恒见/持 fappear 纯名可见/权重 5 全知不见、不落盘不污染前台） |
| `perceptionDegrade.test.ts` | 失聪降级集成（P2-3 出口，测试夹具占位符）：内容挂 aud 1 级 + vis 2 级，读者全持/只持 vis/皆无 → 三档文案，matched 并集精确匹配分支 |
| `workingSetVisibility.test.ts` | 频道三档可见域集成（P2-3 出口，测试夹具占位符）：字段 A/B/默认 × 频道内（持频道 + 工具 AV）/同地不在频道（字段 A 不放行侧保底）/失聪读者（发言 OR 放行、matched=[vis] 降级分支、内容不泄露） |
| `markerNotices.test.ts` | 标记通知注入集成（P2-3 出口）：leave/recall/contact 消费点生成通知条目（载荷纯参数无文本、tags 焊死映射、confirm 不生成）、同 type 固定 ID 复用、投影重建逐字节一致、按 tags 过滤注入（持 vis 者见/目标归属命中）、GM 清算即消亡、GM 恒见 |
| `derivedCascade.test.ts` | 从动级联集成（SessionHarness）：装备穿脱 tags 池同步 + 数组内从动末端元素枚举、GM delta `键[数字]` 下标写元素末端、expr 公式同 commit 重算（VarChange 齐）、直编回归计算值、回溯随 changes 反转还原、模板依赖成环拒装 |
| `httpEnvelope.test.ts` | HTTP envelope 集成测试：真实 HTTP 逐端点 envelope 形状 + 状态码矩阵（400/404/405+Allow/409/500 故障注入）+ HTTP mutation 成功恰一条 transition/失败无广播 |
