# Confluence / 高级记忆

> **本机所有会话，共享同一份记忆。** / **One shared memory for every session on this machine.**

**状态：v0.2.1——通用共享记忆，中文名「高级记忆」。** v0.2.1 仅把中文名从「汇流」改为「高级记忆」；
记忆作用域、存储格式、工具 API 与导出契约均与 v0.2.0 相同。作用域变更由
[ADR 0007](docs/adr/0007-universal-memory-scope.md) 决定：**记忆边界是 DSH profile，而不是工作区**，
因此无论会话在哪个目录运行，都读写同一份共享记忆。
v0.2.0 最终代码树（含独立评审修复）上的离线套件 **291/291 通过**、打包契约 **17/17 通过**，离线
临时 profile 的 **跨目录 E2E 已全绿：15/15 项 PowerShell 检查 + 12/12 项断言检查，退出码 0**（修复后
运行目录 `.tmp/e2e/run-20261116-203730`，2026-11-16；完整证据见
[docs/discussion/v0.2-e2e-evidence.md](docs/discussion/v0.2-e2e-evidence.md) 与
[实现状态](docs/plan/implementation-status.md)）。真实 profile 的重装/重启仍未执行，面板可视化检查
仍待执行。下方 v0.1.0 的"已执行"证据属于历史，对该版本仍然成立。面板渲染**仍未经过
可视化验证**（两个版本都是），也尚未发布任何东西。

Confluence（中文名 **高级记忆**，即 advanced memory）是一个**完全离线**的 DeepSeek Harness（DSH）插件，为
profile 内的每个会话提供同一份长对话共享记忆：提示词中的被动脉冲、持久共享看板，以及对早前会话的显式、
有界回溯。运行时不联网、不启动服务器、不新增监听端口、不启动子进程、不调用模型。

- 目标宿主：DSH Desktop **0.2.2-rc.1**（声明的最低要求 `>=0.2.2-rc.1`），profile `desktop`。
- 包：`dsh-confluence` **v0.2.0**，`private: true`，MIT，无运行时依赖。
- 仓库：[https://github.com/XiaoleC05/Confluence](https://github.com/XiaoleC05/Confluence)
- 从 v0.1.0 升级？先读 [docs/upgrade-v0.2.md](docs/upgrade-v0.2.md)——两个配置项有变，且本地链接的
  bundle 需要重启 DSH。

---

## 问题

DSH 的每个会话都是相互隔离的语言上下文。新开始的对话不知道二十分钟前、在另一个窗口或另一个目录里，你
和 Agent 已经定下了表结构、踩过 Windows 重命名那个坑、或者约好了依赖版本。于是同样的排查被重复，决策
丢失。

v0.1.0 把记忆**按工作区**（`header.cwd`）隔离。那是对最初需求的一种字面实现，结果让插件像"项目工具"：
记忆被目录切碎，在另一个目录里开始的新对话看不到隔壁目录里刚形成的记忆。用户澄清了产品意图——Confluence
是一个**通用的**长对话与便捷共享记忆插件：

> "这个插件更像是一个长对话和便捷共享记忆插件，这个是通用的，而不是单独给某一个工作区设置的。"

v0.2.0 实现了这一点：**每个 profile 一个记忆空间。** 目录和会话只是记忆条目上的*来源*标注，而不再是分区、
过滤条件或权限边界。

---

## v0.2.0 实现了什么

| 支柱 | v0.2.0 实现 |
|---|---|
| **脉动（Pulse）** — 被动感知 | 一个全局 `confluence:pulse` `ctx.systemPrompt.context()` 贡献：字节稳定、有界的 `<confluence-memory scope="global" …>` 摘要，包含来自**任意**会话的未读笔记、未解决问题/交接，以及全部在线同伴。只有文本变化时 Agent 循环才提交新的运行期上下文快照，因此不变的脉动不消耗新 token。由 `lib/pulse.js` 与日志推导的水位 `lib/watermark.js` 实现；旧的 `<confluence-workspace …>` 快照仍可解析。 |
| **看板（Board）** — 共享记忆 | 在**单一全局作用域**（`ws_0000000000000000`，名称 "All sessions"）内的仅追加 JSONL 日志，支持类型化笔记（`finding`、`decision`、`gotcha`、`question`、`handoff`、`warning`）、线程、解决与墓碑。每个条目带可选的 `origin`（写入时所在工作区的名称）作为来源标注。由 `lib/store.js` + `lib/board.js` + `lib/facade.js` 实现。 |
| **账本 + 回溯** | 仅元数据的实时会话账本与 presence 心跳，覆盖 profile 内**所有**会话（不含提示词/工具文本），以及对本机任意早前会话的显式字面回溯（通过 `ctx.sessionQuery` 精确读取）。`privacy.privateSessions` 仍能把某个会话完全排除。由 `lib/ledger.js`、`lib/presence.js`、`lib/recall.js` 实现。 |
| **六个模型工具** | `confluence_board`、`confluence_post`、`confluence_read`、`confluence_search`、`confluence_reply`、`confluence_recall`（`lib/tools.js`）。文案已统一：没有任何工具再说"this workspace"；回溯描述为"本机所有早前会话"。 |
| **只读 Web 面板** | 左侧栏入口 + 带 key 的 main 页面（`client.js`），标题 **"高级记忆 / Confluence memory"**：单一全局时间线、类型/标签筛选、搜索、含线程的条目详情、未完成项、在线同伴，以及显示条目来源工作区名称的 provenance 芯片。**没有工作区切换器。** 数据来自注册在现有 DSH Web 服务器上的只读同源路由（`lib/hostui.js`）——`ping`、`overview`、`entry`；不使用 `host.call`、无 iframe、无推送通道。 |
| **导出（需显式启用）** | 消费端契约 `confluence.memories/v1` 不变：manifest 增加 `scope:"global"` 并报告全局 `wsKey`/名称，每条记录使用全局键，新增可加字段 `origin` 承载来源。CLI 去掉 `--workspace`。 |

对用户的承诺：**"你的会话一起记住。"**

---

## 工作方式（架构）

```text
┌───────────────────────────── DSH Desktop（每个应用实例一个 Host）──────────────────────────────┐
│                                                                                                │
│   会话 A — 目录 X                              会话 B — 目录 Y                                  │
│   ┌────────────────────────────┐               ┌────────────────────────────┐                  │
│   │ Agent 步骤                 │               │ Agent 步骤                 │                  │
│   │ 提示词组装                 │               │ 提示词组装                 │                  │
│   │  └─ confluence:pulse ──────┼── 字节稳定 ───┼─► 同一段渲染文本           │                  │
│   │ 工具：confluence_*         │   摘要        │ 工具：confluence_*         │                  │
│   └─────────────┬──────────────┘               └─────────────┬──────────────┘                  │
│                 │                                            │                                 │
│                 ▼                                            ▼                                 │
│   ┌──────────────── Confluence 宿主插件（纯 ESM，仅 Node 内置模块）──────────────────────────┐  │
│   │ index.js（facade 装配）→ lib/：config · workspace · redact · store · board · ledger      │  │
│   │ presence · watermark · pulse · recall · tools · hostui · facade · export · util          │  │
│   └──────────────────────────────────────┬──────────────────────────────────────────────────┘  │
│              仅追加 JSONL 分片 + presence 心跳（只写全局作用域）                                │
│         $DSH_HOME/storages/confluence/v1/workspaces/ws_0000000000000000/                       │
│         ├─ journal.<writerId>.v1.jsonl     ├─ presence/<writerId>.json                         │
│         └─ MANIFEST.v1.json                └─ snapshot.<gen>.v1.jsonl                          │
│         （旧 workspaces/ws_<16hex>/ 日志保留在磁盘上，只读合并进所有视图）                       │
│                                                                                                │
│   Web 面板（client.js）：现有 Web 服务器上的只读同源 GET；不新增端口                             │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

关键边界：

- **profile/本机 = 共享边界。** 只有一个逻辑作用域 `global`（`GLOBAL_SCOPE_KEY =
  ws_0000000000000000`，名称 "All sessions"／「全部会话」）。profile 内每个会话都读写它；`lib/workspace.js` 被缩减为
  **来源解析器**，只用于 provenance（`origin: { workspaceKey, workspaceLabel }`）。任何工具、脉动、回溯、
  面板调用或导出都不再以工作区键为条件。
- **存储在 profile 内。** 按写入者分片的仅追加 JSONL 位于 `$DSH_HOME/storages/confluence/v1/`；新写入只
  进入保留的全局作用域。旧的按工作区日志从不修改、不做迁移——它们以只读方式合并进看板、脉动、面板与导出，
  并用其 manifest 中的名称作为来源标注。
- **会话日志仍是唯一事实来源。** 水位（`digestSeq`、`boardReadSeq`）通过 `sessionProjections` 单元从
  已提交的会话事件推导；插件状态只是派生缓存。
- **共享内容是"不可信数据"。** 固定警告、转义框架字符（`<`、`&`、U+2028/2029）、不执行其中指令、处处
  有界、尽力做密钥脱敏、账本仅存元数据。
- **离线是结构性的。** Host 半身没有 `fetch`、没有网络模块、没有 socket、没有子进程；面板唯一的请求是
  发往宿主现有 Web 服务器的相对同源 GET。

---

## v0.2.0 明确不做的事

- 不做持续的全量对话索引、不做 LLM 抽取、不做向量/嵌入检索；
- 不做服务器、不联网、不额外监听端口、不引入外部数据库、不启动子进程、不调用模型；
- 没有按工作区隔离的模式，也没有作用域开关——通用就是产品本身（ADR 0007 §5）；
- 不跨 profile、跨操作系统用户或跨机器共享；边界就是本机这个 DSH profile；
- 不做远程/LAN 协作、不做 Liveshare、不做 git 自动化；
- 暂不做看板编辑/删除界面（墓碑为 M4）；不做 composer、不做自定义工具卡片、不做每会话未读徽标（已推迟）；
- 不替代 `@` 提及快照或原始会话搜索——它与它们并存。

---

## 实现现状（本仓库今天有什么）

| 声明 | 现状 |
|---|---|
| 宿主插件（15 个 `lib/*.js` 模块 + `index.js` 装配） | **已实现**；v0.2.0 通用记忆重构已在本代码树完成（套件 291/291） |
| Web 面板（`client.js`，Dynamic ModuleLoader id `dsh-confluence`） | **已实现，未做可视化验证** |
| 六个模型工具、脉动、看板、账本/presence、回溯、存储、导出 | **已实现**；每个模块有单元测试 |
| 离线单元 + 集成测试 | v0.1.0：**离线通过**（`node --test --test-force-exit "test/*.test.js"`），256/256。v0.2.0 最终树：**291/291 通过**（2026-11-16） |
| 打包契约（清单/patch/locale/图标/入口） | v0.1.0：**通过**（`node scripts/check.mjs`），12/12。v0.2.0 最终树：**17/17 项检查通过** |
| 跨工作区验收（会话 A 目录 X、会话 B 目录 Y、同一 profile） | v0.2.0 **已执行**——离线临时 profile E2E 运行 `20261116-203730`：**15/15 项 harness 检查、12/12 条断言**；见[设计/测试](docs/design/testing.md)与[证据记录](docs/discussion/v0.2-e2e-evidence.md) |
| 安装进临时 profile | **已由离线 E2E 执行**（一次性 `DSH_HOME`，`dsh plugin add` + `--dump-config`，2026-11-16）；该证据不需要长期保留的手工临时 profile |
| 安装进真实 desktop profile | v0.1.0 **已执行**（Plugin Manager `install_bundle` → applied）；v0.2.0 重装/重启**未执行** |
| 旧数据只读合并在临时 profile 中观察 | **E2E 已执行**——预置的 v0.1.0 日志带来源合并，文件字节不变（sha256），未迁移任何记录 |
| 在真实 GUI 中渲染面板 | **未执行**（本轮无浏览器控制） |
| npm pack / 发布 | **已执行 pack dry-run**；无 tarball、无 release、无发布 |

仓库**不**宣称插件已安装进用户的 desktop profile，也不宣称 v0.2.0 已通过面板可视化验证。激活、六个
工具、脉动、全局存储与旧数据合并，只在那次一次性 E2E 临时 profile 中被观察到。

---

## 仓库结构

```text
D:\05_Code\Confluence\
  index.js                   宿主入口：把 15 个 lib 模块装配到 Cordis 上下文
  client.js                  Web 面板：纯 Dynamic ModuleLoader 模块（id 'dsh-confluence'）
  lib/                       宿主模块（纯 ESM，仅 Node 内置模块）：
    util.js config.js workspace.js redact.js store.js board.js watermark.js pulse.js
    ledger.js presence.js recall.js tools.js hostui.js facade.js export.js
  package.json               bundle 清单：dsh-confluence v0.2.0，private，MIT，无依赖
  cordis.patch.yml           插入唯一的 `confluence` 行及完整默认配置
  locale/en.json, zh.json    显示元数据 + 面板文案（中英对齐）
  icon.svg                   原创图标：三条水流汇入一条通道
  examples/profile-patch.yml 用户覆盖示例（隐私优先/低噪音/调试）
  scripts/check.mjs          独立打包检查（零依赖）
  test/                      每模块单元测试、集成测试、e2e 脚手架、fixtures
  docs/                      设计、研究、决策、计划、状态、安装/发布指南
```

没有构建步骤：宿主半身是纯 ESM，面板是纯浏览器模块。

---

## 文档

完整文档地图与阅读顺序见[文档索引](docs/README.md)。

**决策与背景**

- [ADR 0001 — Confluence / 高级记忆 架构](docs/adr/0001-confluence-architecture.md)
- [ADR 0007 — 通用记忆作用域](docs/adr/0007-universal-memory-scope.md)——**v0.2.0 的约束性决策**：
  profile 是记忆边界；取代 ADR 0001 中与工作区作用域相关的部分
- [ADR 0002 — 存储格式与并发](docs/adr/0002-store-format-and-concurrency.md) ·
  [ADR 0003 — 脉动与水位](docs/adr/0003-pulse-and-watermarks.md) ·
  [ADR 0004 — 隐私与同意](docs/adr/0004-privacy-and-consent.md) ·
  [ADR 0005 — UI 通道](docs/adr/0005-ui-transport.md) ·
  [ADR 0006 — solo-bench 集成](docs/adr/0006-solo-bench-integration.md)（提议中）
- [第 1 轮](docs/discussion/round-1.md) · [第 2 轮](docs/discussion/round-2.md) ·
  [立场 A](docs/discussion/position-a.md) · [立场 B](docs/discussion/position-b.md)

**研究**

- [DSH 内部机制](docs/research/dsh-internals.md) · [既有实现](docs/research/prior-art.md) ·
  [外部模式](docs/research/external-patterns.md)

**实现**

- [作用域重构增量（约束性）](docs/plan/scope-refactor-delta.md)——v0.2.0 接口契约：名称/常量、
  逐模块接口变更、验收标准。
- [实现接口（约束性）](docs/plan/implementation-interfaces.md)——模块契约、导出、归属、测试约定
  （v0.1.0 基线；增量文档在其之上覆盖）。
- [实现状态（实时）](docs/plan/implementation-status.md)——里程碑/WP 状态、已执行 vs 未执行、阻塞项。
- [执行计划](docs/plan/execution-plan.md) · [M0 探针](docs/plan/m0-spikes.md)（规格；结果见 §10）
- 设计文档：[架构](docs/design/architecture.md) · [数据模型](docs/design/data-model.md) ·
  [存储格式](docs/design/store-format.md) · [工具 API](docs/design/tool-api.md) ·
  [脉动](docs/design/pulse.md) · [账本与回溯](docs/design/ledger-recall.md) ·
  [面板](docs/design/ui.md) · [配置](docs/design/config.md) ·
  [安全与隐私](docs/design/security-privacy.md) · [测试](docs/design/testing.md) ·
  [solo-bench 集成](docs/design/solo-bench-integration.md)——每篇都带指向 ADR 0007 的
  "v0.2.0 修订"说明。
- 测试：`test/*.test.js`（模块 + 打包）与 `test/integration.test.js`（宿主装配、工具、脉动、存储、
  面板路由）。

**打包与运维**

- [安装与验证指南](docs/install.md)
- [发布与版本流程](docs/publishing.md)
- [升级到 v0.2.0（通用记忆）](docs/upgrade-v0.2.md)——配置迁移、旧数据、重启、回滚。

---

## 离线与隐私保证

- Host 半身没有 `fetch`、出站 socket、网络模块、子进程或模型调用；
- 不额外监听端口、不启动服务器；面板仅通过相对同源 GET 使用现有 DSH Web 服务器；
- 不使用外部数据库——只使用 `$DSH_HOME/storages/confluence/v1/` 下的 profile 本地文件；
- 不做遥测、不做崩溃上报、不做更新检查。

隐私模型——因为边界变了，这里说清楚：

- **本机的这个 profile 就是共享边界。** Confluence 是单用户本地工作台：profile 内任何会话写入的共享
  记忆，按设计对同一 profile 内的其他所有会话可读。这就是产品本身，不是缺陷。数据不会跨 profile、
  跨操作系统用户或跨机器。
- **工作区不再是边界。** v0.1.0 提供按工作区的退出开关（`privacy.disabledWorkspaces`）；v0.2.0 删除它，
  因为已经不存在可禁用的工作区边界。针对"让这段对话不进入共享记忆"这一窄需求，替代方案是
  **`privacy.privateSessions`**：私密会话没有脉动、没有账本行、没有 presence、也没有 Confluence 工具
  ——在被设为私密期间它对共享记忆不可见。
- **元数据优先。** 账本保存标题、会话 id、时间戳、轮次数、状态以及最多 8 个工作区相对路径；不保存提示词、
  助手文本、工具输出或命令行。早前会话日志只在模型显式调用 `confluence_recall` 时读取，且只返回有界摘录。
- **尽力脱敏**：API key、token、私钥、密码类模式，可配置拒绝路径与自定义规则，并支持按会话退出。
- **共享笔记是不可信数据。** 脉动与工具结果携带固定警告与转义框架；共享内容不能自行触发工具调用。
- **导出保持显式启用、已脱敏**，且从不包含绝对路径。

这些保证由静态契约检查与隐私单元测试执行；它们不代表已对真实宿主做过审计，也无法防御同一 profile 内
其他工具的行为。

---

## 从 v0.1.0 升级

两个配置项有变；其余照旧，旧记忆不会丢失。完整指南：**[docs/upgrade-v0.2.md](docs/upgrade-v0.2.md)**。

- **已删除：** `privacy.disabledWorkspaces`——设置过它的 v0.1.0 profile 会得到激活警告
  （`CONFIG_DEPRECATED privacy.disabledWorkspaces`），其值被忽略。请改用 `privacy.privateSessions`。
- **已重命名：** `ledger.maxSessionsPerWorkspace` → `ledger.maxSessions`（默认 200，范围 20–1000）。
  旧键不再读取；如果你自定义过，请设置新键。
- **未变：** `store.maxEntriesPerWorkspace` 保留名称，现在限制唯一的全局看板。没有作用域开关——
  `memory.scope` 不存在。
- **需要重启：** 已安装 bundle 是本地链接，必须重启 DSH（或切换该 bundle 行）才能加载新的 Host 模块
  代际。仅改配置只会重载插件行，不会重载模块代码。
- **旧数据：** v0.1.0 的按工作区日志以只读方式合并进全局视图，不被重写、移动或删除；新笔记只写入全局
  作用域。

---

## 安装状态

> **v0.2.0 尚未重新安装进真实 desktop profile。** v0.1.0 曾安装到那里；v0.2.0 的升级（重装 + 重启
> DSH + 真实环境重新验证）尚未执行。但**离线临时 profile E2E 已执行**（2026-11-16）：一次性
> `DSH_HOME`、`dsh plugin add`、`--dump-config`、五个 headless 会话与断言（15/15 + 12/12，运行目录
> `20261116-203730`）。

流程记录在 [docs/install.md](docs/install.md)：

1. **临时 profile：** 已由离线 E2E 执行——在 `.tmp/e2e/run-20261116-203730/dsh-home` 中
   `dsh plugin --profile <scratch> add <绝对路径>` 并 `--dump-config`；`confluence` 行以完整默认配置
   成功组合（E2E-00a/b/c）。
2. **真实 desktop profile：** 通过 Plugin Manager `install_bundle` 从仓库绝对路径安装，然后重启 DSH
   ——**未执行 / 由 Lead 负责**。仅改配置不会加载新的 Host 模块，本地链接的 bundle 必须重启 DSH。

安装验证仍需证明：bundle 行以完整默认配置组合（不含 `disabledWorkspaces`、含 `ledger.maxSessions`）、
六个工具出现、脉动有界且字节稳定并使用 `<confluence-memory>` 标签、存储文件出现在**全局**作用域目录下、
面板打开后是全局时间线且没有工作区切换器，且没有网络/端口/子进程出现。

回滚：从 profile 移除 bundle（`dsh plugin --profile <name> remove dsh-confluence`）并重启 DSH；插件数据
可单独删除。

---

## 开发

要求：**Node.js ≥ 22.19.0**；后续真实激活需要 DSH Desktop **0.2.2-rc.1**。无依赖、无构建步骤。

```powershell
# 在仓库根目录
node --test --test-force-exit "test/*.test.js"   # 全部离线测试（单元 + 集成 + 打包）
node scripts/check.mjs                            # 独立打包检查（零依赖）
npm pack --dry-run --json                         # 检查随包文件清单（离线）
```

v0.1.0 代码树的 `npm pack --dry-run` 报告 **24 个文件**：`package.json`、两个 README、`LICENSE`、
`index.js`、`client.js`、15 个 `lib/*.js` 模块（含 `export.js`）、`cordis.patch.yml`、两个 locale 文件与
`icon.svg`。不会打包 `test/`、`docs/`、`examples/` 或 `scripts/` 中的内容。下个发布检查点需重跑并重新
记录该清单。

### 开发、验证与发布辅助脚本

| 脚本 | 用途 |
|---|---|
| `node scripts/check.mjs` | 零依赖打包/契约检查。 |
| `node scripts/m0-smoke.mjs` | M0 证据套件：ULID、脱敏语料、脉动上限、日志追加/断尾/双写者、原生 lease、离线扫描。 |
| `pwsh -File scripts/e2e-dsh.ps1` | 离线临时 profile E2E：全新 `DSH_HOME` + headless profile + 本地 Messages-API mock。v0.2.0 **已执行**（`20261116-203730`）：会话 A 在 `workspace-a`，B–E 在 `workspace-b`，同一 profile → **15/15 项检查 + 12/12 条断言**。 |
| `node scripts/export-memories.mjs --dsh-home <dir> [--out <dir>] [--json] [--dry-run]` | 显式启用的导出生产端。默认输出 `<dsh-home>/storages/confluence-exports/<UTC 时间戳>/`。不再有 `--workspace` 参数。 |
| `node --test --test-force-exit "test/*.test.js"` | 全部离线测试（单元、集成、打包契约）。 |

---

## 路线图

| 里程碑 | 范围 | 状态 |
|---|---|---|
| **M0 — 探针** | 运行期上下文去重、projection 标记折叠、PTC 呈现、Windows 日志、多窗口拓扑、宿主数据通道、atomic-write 导入 | 规格已有；S1/S2/S4/S7 **已执行**（`scripts/m0-smoke.mjs`，14 通过 / 1 阻塞）、宿主通道走同源路由回退（S6）；PTC 分发形态（S3）与多窗口拓扑（S5）仍**未验证** |
| **M1 — 核心** | 存储、**来源解析器**（v0.2.0）、看板、看板工具、脉动 + 欢迎摘要、projection 水位 | **已实现并验证**；v0.2.0 全局作用域改写已落地，离线套件 291/291 |
| **M2 — 协作** | 账本/presence、reply/search/recall、脱敏与上限、私有退出、临时 profile 离线 E2E | **已实现并完成端到端验证**——临时 profile 跨目录 E2E **15/15 + 12/12**（2026-11-16） |
| **M3 — 面板** | 只读 UI、locale、通道、标记已读/退出、无出网测试、安装验证 | **已实现**；全局面板（无工作区切换器、来源芯片）通过契约测试；可视化**未执行** |
| **M4 — 加固** | 压缩/导出 + manifest、发布验证、浸泡/并发测试、solo-bench 集成 | 导出生产端 + solo-bench Go 消费端**已实现并测试**；全局导出格式在本轮更新；压缩/浸泡与正式发布**未执行** |
| **v0.2.x（后续）** | 每会话未读徽标、自定义工具卡片、composer/reply UI | 已签署推迟 |

---

## 验证状态

**v0.1.0（历史，2026-11-13 执行，Windows 11，Node 22.19.0，DSH 0.2.2-rc.1）：**

| 检查项 | 结果 |
|---|---|
| 离线测试套件（`node --test --test-force-exit "test/*.test.js"`） | **256/256 通过**（单元、集成、打包契约） |
| 独立打包检查（`node scripts/check.mjs`） | **12/12 项检查通过** |
| `npm pack --dry-run --json` 文件清单（离线） | **已执行**——24 个文件，无开发目录内容；未生成 tarball |
| M0 冒烟（`node scripts/m0-smoke.mjs`） | **14 通过 / 0 失败 / 1 阻塞**——`@deepseek-ai/dsh-atomic-write` 无法从仓库上下文解析；实际采用原生 lease 路径 |
| 临时 profile 离线 E2E（`pwsh -File scripts/e2e-dsh.ps1`） | v0.1.0：**8/8 项检查、7/7 条断言**——同一工作区的两个真实 headless 会话，跨会话脉动生效 |
| 真实 desktop profile 安装（Plugin Manager `install_bundle`） | **已执行**——`application: applied`；六个工具可见；脉动渲染；`confluence_board` 执行成功；`~/.dsh/storages/confluence/v1/` 下已创建存储 |
| 导出生产端 CLI + `solo-bench` Go 消费端 | **已执行**——manifest/哈希可复现，`go test ./...` 通过 |
| 静态离线/无出网扫描、locale 对齐、图标校验 | **由契约检查执行** |

**v0.2.0（通用记忆）——本轮，2026-11-16 执行：**

| 检查项 | 状态 |
|---|---|
| 最终代码树上的离线套件（`node --test --test-force-exit "test/*.test.js"`） | **已执行——291/291 通过**（模块、集成、打包契约） |
| 打包契约（`node scripts/check.mjs`） | **已执行——17/17 项检查通过**，含 v0.2.0 常量、路由、弃用警告与全局存储布局 |
| M0 冒烟（`node scripts/m0-smoke.mjs`） | **已执行——14 通过 / 0 失败 / 1 阻塞**——阻塞项是可选的 `@deepseek-ai/dsh-atomic-write` 探针；实际采用原生 lease |
| 离线临时 profile 跨目录 E2E（`pwsh -NoProfile -File scripts/e2e-dsh.ps1`） | **已执行——15/15 项 PowerShell 检查、0 失败、退出码 0；`assert-e2e.mjs` 12/12 项检查通过**——运行目录 `.tmp/e2e/run-20261116-203730`（`summary.json`、`mock-*.jsonl`、会话日志均保留） |
| 跨目录记忆（A 在 `workspace-a`；B/C/D/E 在 `workspace-b`，同一 profile） | **E2E 已执行**——B 的已提交脉动包含 A 的笔记；C 列出 A 的笔记 + 旧笔记；D 返回 A 的笔记正文；E 的 `confluence_recall` 从另一目录找回 A 的会话文本 |
| 全局存储 + 旧数据只读合并 | **E2E 已执行**——新写入只落在 `storages/confluence/v1/workspaces/ws_0000000000000000/`；预置的 `ws_1a2b3c4d5e6f7081` 文件字节不变（sha256），未迁移任何记录 |
| 水位 + 冷启动激活 | **E2E 已执行**——看板/读取后 `boardReadSeq` 前进，仅发帖/仅脉动会话保持 `null`；冷启动首个请求头已包含全部六个工具 + 脉动 |
| Locale 对齐（86 键，中英一致）与通用文案 | **由契约检查执行** |
| 工具描述 / 面板路由 / patch 键 | **由契约检查执行**（不再出现 "this workspace"；仅 ping/overview/entry；`ledger.maxSessions`、无 `disabledWorkspaces`） |
| 全局面板（`overview`/`entry`、无 `/workspaces` 路由、来源芯片） | 已实现且通过契约测试；**渲染仍未可视化验证** |
| 真实 profile 重装 + 重启到 v0.2.0 | **未执行**（由 Lead 负责；本地链接的 bundle 必须重启 DSH） |

完整 v0.2.0 E2E 证据：[docs/discussion/v0.2-e2e-evidence.md](docs/discussion/v0.2-e2e-evidence.md)。

两个版本都尚未执行：

| 检查项 | 状态 |
|---|---|
| 面板渲染 / 可视化验证 | **未执行**——客户端 bundle 需下次页面渲染才加载；Host 路由已注册且受鉴权保护 |
| PTC 预设（`run_code`）工具可达性 | **未执行**——M0-S3 探针仍开放 |
| 多窗口实时新鲜度实测 | **未执行**——轮询是已实现的契约 |
| 浸泡/压缩压力、长期保留 | **未执行** |
| 构建 tarball + SHA-256、发布/release | **未执行——未发布任何东西** |

v0.2.0 还额外未执行：真实 desktop profile 的重装/重启，以及任何真实 profile 的在线冒烟。E2E 刻意
只使用一次性 `DSH_HOME`，从未写入用户的真实 profile。

---

## 许可证

[MIT](LICENSE) © 2026 XiaoleC05 与 Confluence / 高级记忆 贡献者。

## 链接

- GitHub: [https://github.com/XiaoleC05/Confluence](https://github.com/XiaoleC05/Confluence)
- Crisp——本打包遵循的本地插件先例：`D:\05_Code\Crisp\integrations\dsh-plugin-crisp`
