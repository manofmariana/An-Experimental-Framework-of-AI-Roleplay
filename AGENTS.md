# Ofair（Open Framework of AI Roleplay）

多 Agent 架构的 AI 角色扮演系统：**一个 GM 导演 + 拥有私域上下文的角色 activation + 受约束的正文渲染器**，真相存于结构化事件日志而非聊天文本。

## 文档体系

文档只有两类：**现在**（当前状态）与**规划**（未来计划）；ADR 记录难逆决策的理由。除本文件外全部文档在 `docs/` 下。

| 文档 | 类 | 职责 |
|---|---|---|
| `docs/DESIGN.md` | 现在 | 架构基准：现行机制的唯一设计出处；架构性修改必须先读并对齐，修改后同步更新 |
| `docs/ROADMAP.md` | 规划 | 未来计划；规划项落地即移入 DESIGN.md 并从此处删除 |
| `docs/CONTEXT.md` | 现在 | 领域词汇表：术语定义与冲突消解的唯一口径 |
| `docs/CODEINDEX.md` | 现在 | 改动指向地图：逐文件职责/IO/依赖方向；新文件必须先登记再写码 |
| `docs/adr/` | 决策记录 | 难逆且理由不显然的取舍 |
| `docs/BUGS.md` | 现在 | 未解决、难复现 bug 登记 |

治理纪律：

1. **单一出处**：同一内容只在一个文档出现一次，他处只给指针，不重复维护。
2. **只记现状**：已完成的改动只写改后的状态，不写"从 A 改成 B"；已移除的机制视作从未存在。代码注释同此纪律。
3. **注释不引文档**：代码注释只说功能，不引用文档名与章节号。
4. **规划落地即迁移**：规划项完成时把内容从规划移入"现在"文档，规划处不留记录。
5. **写入触发**：改代码 → 同步 CODEINDEX.md；改机制 → 同步 DESIGN.md 与 CONTEXT.md；难逆取舍 → ADR。文档间发现矛盾 → 以代码现状为准，当场修正文档。

## 技术栈

TypeScript ESM（Node.js，无构建步骤，`tsx` 直接跑 TS）。依赖极少：`openai`（LLM 客户端）、`ws`（WebSocket）、`zod`（契约校验）；前端是无构建的 Vanilla 单页应用。包管理用 npm，无打包/发布流程——本项目是本地运行的私有应用（`private: true`）。

## 常用命令

```bash
npm run dev        # CLI 游玩（tsx src/cli.ts，readline REPL）
npm run serve      # WebUI 服务（tsx src/server/index.ts，默认 http://127.0.0.1:8787）
npm test           # node --import tsx --test test/**/*.test.ts
npm run typecheck  # tsc --noEmit（改动后必须通过）
npm run test:arch  # 依赖审计（scripts/check-dependencies.ts：禁止边 + 传递依赖 + import 循环）
npm run test:fast  # = test:unit（纯单测套件：严格零 IO，scripts/test-suites.json 的 unit 清单）
npm run test:unit / test:contract / test:application / test:integration
                   # 四层套件（判据见 scripts/run-suite.ts 头部注释：unit 零 IO 纯逻辑；
                   # contract 外部格式/文件 codec + truth Store 文件系统语义；
                   # application GameSession 级 fake ChatPort；integration 真实 HTTP/WS）
npm run check      # 日常门禁 = typecheck + test:arch + test:fast
```

启动器：`Ofair-WebUI.bat`（WebUI + 自动开浏览器）。

## 目录结构

逐文件职责/IO/依赖方向的唯一出处是 `docs/CODEINDEX.md`；新文件必须先登记再写码。顶层布局：

- `src/` — 后端源码：`types.ts`（zod 契约）/ `scheduler/`（纯逻辑调度派生）/ `compile/`（模板渲染）/ `truth/`（真相层与存档）/ `llm/`（ChatPort 与 OpenAI adapter）/ `agents/`（无状态 activation）/ `application/`（会话内核与协调器）/ `server/`（HTTP+WS 后端）/ `contracts/` `resources/` `shared/`
- `web/` — 无构建 Vanilla 单页前端：`pages/*.js` 六页签（游玩/会话/角色/世界/提示词/配置）+ `views/` + store/transport/protocol 三件套
- `test/` — node:test 测试（`builders/` `fakes/` `harness/` 测试基建）
- `scripts/` — 依赖审计与四层套件 runner
- `docs/` — 全部项目文档（见「文档体系」）
- `data/assets/{setId}/` — 世界包：`setting.md` / `tone-card.md` / `lorebook.json` / `time.json` / `incident.json`（突发公式配置，参数唯一出处）/ `player.json` / `characters/*.json` / `prompts/*.prompt.json`（四份：character/gm/prose + gm-incident 突发变体；示例包 `baitan`，新会话可选）
- `data/users/{username}/` — 用户资源：`secrets.json` / `api-presets/` / `settings.json` / `save/{runId}/` 存档（Generation 布局：`CURRENT` + `generations/{revision}/` 六真相文件，旁路产物留 run 根）

## 配置

用户资源三件（`data/users/{username}/` 下）：`secrets.json`（密钥，同 kind 至多一条 active，公共视图只出末 4 位掩码）、`api-presets/{id}.json`（base_url/model/json_mode/reasoning_effort，引用 secret 不复制 key）、`settings.json`（proseWindowTurns 滑窗默认 5 / gmIntervalCycles / agentPresets 三 activation→preset 绑定 / configRevision 配置版本）。根目录旧版 `config.json` 存在且 secrets.json 不存在时，首次读取自动迁移为三资源并改名 `config.json.migrated.bak`（幂等闸）。环境变量 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL`（及 OPENAI_*）为部署级覆盖。全部修改走**配置事务**（`src/application/configService.ts`：baseConfigRevision 乐观并发闸（409）→ 草稿 → 解析三 activation（失败 400 零落盘）→ 原子保存（configRevision+1，与游戏 revision 分离）→ 同一份 resolved 热应用运行中会话（原地更新三个 adapter 与滑窗/GM 间隔；失败回滚资源文件报 500））；world/character 域新会话生效。

服务端部署配置为 `server.json`（项目根，已 gitignore，模板 `server.json.example`）：listen/hostWhitelist/ipWhitelist/allowKeysExposure；`OFAIR_HOST` / `OFAIR_PORT` 优先于 listen 块；缺文件 = 全默认 loopback 放开；basicAuth/ssl/proxy/broadcast 四块接受配置但加载时 warn「已配置但未实现，忽略」（不做半成品假安全）。HTTP 与 WS upgrade 入口统一过 `src/server/accessControl.ts` 纯判定（Host 白名单——loopback 默认放行 localhost/127.*/[::1]；WS Origin 须匹配 Host；ipWhitelist 非空必命中），拒绝 → 403 FORBIDDEN。

## 工程纪律

1. **高内聚**：功能模块化，深模块优于浅模块，反对上帝模块。一个模块一个明确职责，接口窄、实现深；新功能优先落进已有模块的职责边界，装不下才开新文件，开新文件必须先登记 `docs/CODEINDEX.md` 再写码。
2. **低耦合**：多复用已有，少建立专线；重复逻辑公共化。新能力优先走既有的唯一通道——注入经占位符注册表、写盘经 CommitExecutor、mutation 经 SessionCoordinator 队列；层间依赖方向由 `npm run test:arch` 机械守护，禁边不得新增。
3. **重审核**：所有改动动手前先汇报——改动对象、影响范围、能否利用已有内容实现；确认后才动手；范围超出汇报即停下来重新汇报；改完必跑门禁并汇报实测结果。

## 开发约定

- TypeScript ESM strict（`noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`）；target/module ES2022，`moduleResolution: bundler`，`noEmit`（运行靠 tsx，无编译产物）。
- 测试用 Node 内置 `node:test`，不加测试框架；测试文件在 `test/*.test.ts`，与源码模块大致一一对应（含 config/compiler/各 truth store/server API/回溯等）。
- Display 接口（`src/display.ts`）是 UI 协议层：CLI 与 WebUI 各是一个实现，GameSession 不感知前端。
- **提示词模板热加载，但代码不热重载**——改代码后必须重启服务再新建会话验证（存档版本不符会拒绝加载，这是防"旧代码+新模板"混合态的设计，不是故障）。
- 改动后必须 `npm run typecheck` 干净 + `npm test` 全绿。

## 安全注意

- `config.json` 与 `server.json` 已 gitignore，**绝不提交**（含 LLM API key / 部署配置）；对外配置模板只有 `server.json.example`（用户三资源经 WebUI 配置页维护）。
- WebUI 默认绑 loopback（`127.0.0.1:8787`）；`OFAIR_HOST` 绑非 loopback 地址时服务端会打印公网暴露警告——这是有意设计，不要绕过。
- 读档内副本原则：新会话把世界 lorebook 拷入存档 `save/{runId}/lore.json`，运行期增删改只动副本，不污染 `data/assets/` 原始世界包。
