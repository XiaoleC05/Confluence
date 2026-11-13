# Confluence / 汇流

> **同一工作区的会话，共享同一份记忆。** / **Your sessions remember together.**

**状态：v0.1.0 已实现——宿主插件 + 只读 Web 面板；离线单元测试与集成测试通过。该 bundle 尚未安装进任何
DSH profile，面板渲染也尚未经过可视化验证。** 本 README 明确区分"已执行"与"仍待执行"。

Confluence（中文名 **汇流**，"众流汇合之处"）是一个**完全离线**的 DeepSeek Harness（DSH）插件，让同一
工作区内的会话共享彼此学到的东西：提示词中的被动脉冲、持久共享看板，以及对早前会话的显式、有界回溯。
运行时不联网、不启动服务器、不新增监听端口、不启动子进程、不调用模型。

- 目标宿主：DSH Desktop **0.2.2-rc.1**（声明的最低要求 `>=0.2.2-rc.1`），profile `desktop`。
- 包：`dsh-confluence` **v0.1.0**，`private: true`，MIT，无运行时依赖。
- 仓库：[https://github.com/XiaoleC05/Confluence](https://github.com/XiaoleC05/Confluence)

---

## 问题

DSH 的每个会话都是相互隔离的语言上下文。两个在同一目录下启动的会话并不知道彼此共享同一工作区，于是
同样的排查被重复、窗口之间的决策丢失。目前只有手工绕行：`@` 提及另一个会话（用户触发、有界快照）、
启用实验性的会话搜索工具（默认关闭、由模型触发），或者让一个 Agent 写文件、另一个去读。

Confluence 把"工作区记忆"变成环境能力：同一项目中的每个会话都自动看到同伴共享了什么、还有什么未解决、
最近发生了什么——本地、离线、有界。

---

## v0.1.0 实现了什么

| 支柱 | v0.1.0 实现 |
|---|---|
| **脉动（Pulse）** — 被动感知 | 一个全局 `confluence:pulse` `ctx.systemPrompt.context()` 贡献：字节稳定、有界的摘要，包含未读标题、未解决问题/交接、在线同伴和工作区名称。只有文本变化时 Agent 循环才提交新的运行期上下文快照，因此不变的脉动不消耗新 token。由 `lib/pulse.js` 与日志推导的水位 `lib/watermark.js` 实现。 |
| **看板（Board）** — 共享记忆 | 仅追加、按工作区隔离的 JSONL 日志（每个进程一个写入者分片），支持类型化笔记（`finding`、`decision`、`gotcha`、`question`、`handoff`、`warning`）、线程、解决与墓碑。由 `lib/store.js` + `lib/board.js` + `lib/facade.js` 实现。 |
| **账本 + 回溯** | 仅元数据的实时会话账本与 presence 心跳（不含提示词/工具文本），以及对同一工作区早前会话日志的显式字面回溯（通过 `ctx.sessionQuery` 精确读取）。由 `lib/ledger.js`、`lib/presence.js`、`lib/recall.js` 实现。 |
| **六个模型工具** | `confluence_board`、`confluence_post`、`confluence_read`、`confluence_search`、`confluence_reply`、`confluence_recall`（`lib/tools.js`）。 |
| **只读 Web 面板** | 左侧栏入口 + 带 key 的 main 页面（`client.js`），包含看板时间线、搜索/筛选、条目详情、未完成项、已读标记与退出开关。数据来自注册在现有 DSH Web 服务器上的四个只读同源路由（`lib/hostui.js`）——文档化的 route 回退方案；不使用 `host.call`、无 iframe、无推送通道。 |

对用户的承诺：**"同一工作区的会话，共享同一份记忆。"**

---

## 工作方式（架构）

```text
┌───────────────────────────── DSH Desktop（每个应用实例一个 Host）──────────────────────────────┐
│                                                                                                │
│   会话 A — 工作区 W                            会话 B — 工作区 W                                │
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
│   │ presence · watermark · pulse · recall · tools · hostui · facade · util                  │  │
│   └──────────────────────────────────────┬──────────────────────────────────────────────────┘  │
│                                          │ 仅追加 JSONL 分片 + presence 心跳                    │
│                 $DSH_HOME/storages/confluence/v1/workspaces/<wsKey>/                          │
│                 ├─ journal.<writerId>.v1.jsonl     ├─ presence/<writerId>.json                 │
│                 └─ MANIFEST.v1.json（M4）          └─ snapshot.<gen>.v1.jsonl（M4）          │
│                                                                                                │
│   Web 面板（client.js）：现有 Web 服务器上的只读同源 GET；不新增端口                           │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

关键边界：

- **工作区 = 同意边界。** 键 = 规范化后的会话 `header.cwd`（`fs.realpath`，Windows 下小写折叠），每个
  会话冻结一次。跨工作区不共享；回溯只读取规范化 `cwd` 与调用方工作区一致的会话。
- **存储在 profile 内。** 按写入者分片的仅追加 JSONL 位于 `$DSH_HOME/storages/confluence/v1/`；读取端
  合并分片、容忍尾部残行，并以轮询作为新鲜度契约（`fs.watch` 只是优化）。
- **会话日志仍是唯一事实来源。** 水位（`digestSeq`、`boardReadSeq`）通过 `sessionProjections` 单元从
  已提交的会话事件推导；插件状态只是派生缓存。
- **共享内容是"不可信数据"。** 固定警告、转义框架字符（`<`、`&`、U+2028/2029）、不执行其中指令、处处
  有界、尽力做密钥脱敏、账本仅存元数据。
- **离线是结构性的。** Host 半身没有 `fetch`、没有网络模块、没有 socket、没有子进程；面板唯一的请求是
  发往宿主现有 Web 服务器的相对同源 GET。

---

## v0.1.0 明确不做的事

- 不做持续的全量对话索引、不做 LLM 抽取、不做向量/嵌入检索；
- 不做服务器、不联网、不额外监听端口、不引入外部数据库、不启动子进程、不调用模型；
- 不跨工作区读取或共享；
- 不做远程/LAN 协作、不做 Liveshare、不做 git 自动化；
- v0.1.0 不做看板编辑/删除界面（墓碑为 M4）；不做 composer、不做自定义工具卡片、不做每会话未读徽标
  （推迟到 v0.1.1）；
- 不替代 `@` 提及快照或原始会话搜索——它与它们并存。

---

## 实现现状（本仓库今天有什么）

| 声明 | 现状 |
|---|---|
| 宿主插件（15 个 `lib/*.js` 模块 + `index.js` 装配） | **已实现** |
| Web 面板（`client.js`，Dynamic ModuleLoader id `dsh-confluence`） | **已实现，未做可视化验证** |
| 六个模型工具、脉动、看板、账本/presence、回溯、存储 | **已实现**；每个模块有单元测试 |
| 离线单元 + 集成测试 | **离线通过** —— `node --test --test-force-exit "test/*.test.js"` |
| 打包契约（清单/patch/locale/图标/入口） | **通过** —— `node scripts/check.mjs` |
| 安装进临时 profile | **未执行**（流程见 [docs/install.md](docs/install.md)） |
| 安装进真实 desktop profile | **未执行**（由 Lead 负责） |
| 在真实 GUI 中渲染面板 | **未执行**（本轮无浏览器控制） |
| M0 探针 / E2E harness 运行 | **未执行**（仅有规格与脚手架） |
| npm pack / 发布 | **已执行 pack dry-run**；无 tarball、无 release、无发布 |

仓库**不**宣称插件已安装、已激活或已通过可视化验证。这些检查在下方以及 [docs/install.md](docs/install.md)
中列为待执行。

---

## 仓库结构

```text
D:\05_Code\Confluence\
  index.js                   宿主入口：把 15 个 lib 模块装配到 Cordis 上下文
  client.js                  Web 面板：纯 Dynamic ModuleLoader 模块（id 'dsh-confluence'）
  lib/                       宿主模块（纯 ESM，仅 Node 内置模块）：
    util.js config.js workspace.js redact.js store.js board.js watermark.js pulse.js
    ledger.js presence.js recall.js tools.js hostui.js facade.js
  package.json               bundle 清单：dsh-confluence v0.1.0，private，MIT，无依赖
  cordis.patch.yml           插入唯一的 `confluence` 行及完整默认配置
  locale/en.json, zh.json    显示元数据 + 85 条面板文案（中英对齐）
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

- [ADR 0001 — Confluence / 汇流 架构](docs/adr/0001-confluence-architecture.md)
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

- [实现接口（约束性）](docs/plan/implementation-interfaces.md) —— 模块契约、导出、归属、测试约定。
- [实现状态（实时）](docs/plan/implementation-status.md) —— 里程碑/WP 状态、已执行 vs 未执行、阻塞项。
- [执行计划](docs/plan/execution-plan.md) · [M0 探针](docs/plan/m0-spikes.md)（规格；结果待填）
- 设计文档：[架构](docs/design/architecture.md) · [数据模型](docs/design/data-model.md) ·
  [存储格式](docs/design/store-format.md) · [工具 API](docs/design/tool-api.md) ·
  [脉动](docs/design/pulse.md) · [账本与回溯](docs/design/ledger-recall.md) ·
  [面板](docs/design/ui.md) · [配置](docs/design/config.md) ·
  [安全与隐私](docs/design/security-privacy.md) · [测试](docs/design/testing.md) ·
  [solo-bench 集成](docs/design/solo-bench-integration.md)
- 测试：`test/*.test.js`（模块 + 打包）与 `test/integration.test.js`（宿主装配、工具、脉动、存储、面板路由）。

**打包与运维**

- [安装与验证指南](docs/install.md)
- [发布与版本流程](docs/publishing.md)

---

## 离线与隐私保证

- Host 半身没有 `fetch`、出站 socket、网络模块、子进程或模型调用；
- 不额外监听端口、不启动服务器；面板仅通过相对同源 GET 使用现有 DSH Web 服务器；
- 不使用外部数据库——只使用 `$DSH_HOME/storages/confluence/v1/` 下的 profile 本地文件；
- 不做遥测、不做崩溃上报、不做更新检查。

隐私模型：

- **工作区是同意边界。** 看板笔记与元数据默认在*同一工作区内*共享；跨工作区不共享。
- **元数据优先。** 账本保存标题、会话 id、时间戳、轮次数、状态以及最多 8 个工作区相对路径；不保存
  提示词、助手文本、工具输出或命令行。早前会话日志只在模型显式调用 `confluence_recall` 时读取，且只
  返回有界摘录。
- **尽力脱敏**：API key、token、私钥、密码类模式，可配置拒绝路径与自定义规则，并支持按会话/按工作区
  退出。
- **共享笔记是不可信数据。** 脉动与工具结果携带固定警告与转义框架；共享内容不能自行触发工具调用。

这些保证由静态契约检查与隐私单元测试执行（见下方验证表）；它们不代表已对真实宿主做过审计。

---

## 安装状态

> **尚未安装。** 本轮没有修改任何 DSH profile。v0.1.0 已实现且离线测试通过，但安装与激活仍待执行。

流程记录在 [docs/install.md](docs/install.md)：

1. **临时 profile（先）：** `dsh plugin --profile <scratch> add <绝对路径>`，再用 `--dump-config` 确认
   `confluence` 行可以组合——**未执行**。
2. **真实 desktop profile：** 通过 Plugin Manager `install_bundle` 从仓库绝对路径安装——**未执行 / 由
   Lead 负责**。

安装验证仍需证明：bundle 行以完整默认配置组合、六个工具出现、脉动有界且字节稳定、存储文件出现在
`$DSH_HOME/storages/confluence/v1/` 下、面板可打开且只读、且没有网络/端口/子进程出现。

回滚：从 profile 移除 bundle（`dsh plugin --profile <name> remove dsh-confluence`）或删除临时
`DSH_HOME` 目录；插件数据可单独删除。

---

## 开发

要求：**Node.js ≥ 22.19.0**；后续真实激活需要 DSH Desktop **0.2.2-rc.1**。无依赖、无构建步骤。

```powershell
# 在仓库根目录
node --test --test-force-exit "test/*.test.js"   # 全部离线测试（单元 + 集成 + 打包）
node scripts/check.mjs                            # 独立打包检查（零依赖）
npm pack --dry-run --json                         # 检查随包文件清单（离线）
```

`npm pack --dry-run` 目前报告 **24 个文件**：`package.json`、两个 README、`LICENSE`、`index.js`、
`client.js`、15 个 `lib/*.js` 模块、`cordis.patch.yml`、两个 locale 文件与 `icon.svg`。不会打包
`test/`、`docs/`、`examples/` 或 `scripts/` 中的内容。

### 开发、验证与发布辅助脚本

| 脚本 | 用途 |
|---|---|
| `node scripts/check.mjs` | 零依赖打包/契约检查（12 项）。 |
| `node scripts/m0-smoke.mjs` | M0 证据套件：ULID、脱敏语料、脉动上限、日志追加/断尾/双写者、原生 lease、离线扫描。 |
| `pwsh -File scripts/e2e-dsh.ps1` | 离线临时 profile E2E：全新 `DSH_HOME` + headless profile + 本地 Messages-API mock，同一工作区两个真实会话，断言跨会话脉动。 |
| `node scripts/export-memories.mjs --dsh-home <dir> --workspace <path>` | 显式启用的导出生产端：在 `<workspace>/.confluence/export/` 下写确定性的 `memories.v1.jsonl` + `manifest.json`。 |
| `node --test --test-force-exit "test/*.test.js"` | 全部离线测试（单元、集成、打包契约）。 |

---

## 路线图

| 里程碑 | 范围 | 状态 |
|---|---|---|
| **M0 — 探针** | 运行期上下文去重、projection 标记折叠、PTC 呈现、Windows 日志、多窗口拓扑、宿主数据通道、atomic-write 导入 | 规格已有；S1/S2/S4/S7 **已执行**（`scripts/m0-smoke.mjs`，14 通过 / 1 阻塞）、宿主通道走同源路由回退（S6）；PTC 分发形态（S3）与多窗口拓扑（S5）仍**未验证** |
| **M1 — 核心** | 存储、工作区解析、看板、看板工具、脉动 + 欢迎摘要、projection 水位 | **v0.1.0 已实现并经过单元 + 离线 E2E 验证** |
| **M2 — 协作** | 账本/presence、reply/search/recall、脱敏与上限、私有退出、临时 profile 离线 E2E | **已实现**；临时 profile 离线 E2E **已执行**（8/8 项 harness 检查通过） |
| **M3 — 面板** | 只读 UI、locale、通道、标记已读/退出、无出网测试、安装验证 | **已实现**；真实 desktop profile 的安装与激活**已执行**；面板渲染/可视化**未执行**（需刷新页面） |
| **M4 — 加固** | 压缩/导出 + manifest、发布验证、浸泡/并发测试、solo-bench 集成 | 导出生产端 + solo-bench Go 消费端**已实现并测试**；压缩/浸泡与正式发布**未执行** |
| **v0.1.1（后续）** | 每会话未读徽标、自定义工具卡片、composer/reply UI | 已签署推迟 |

---

## 验证状态

本代码树上已执行（2026-11-13，Windows 11，Node 22.19.0，DSH 0.2.2-rc.1）：

| 检查项 | 结果 |
|---|---|
| 离线测试套件（`node --test --test-force-exit "test/*.test.js"`） | **256/256 通过**（单元、集成、打包契约） |
| 独立打包检查（`node scripts/check.mjs`） | **12/12 项检查通过** |
| `npm pack --dry-run --json` 文件清单（离线） | **已执行**——24 个文件，无开发目录内容；未生成 tarball |
| M0 冒烟（`node scripts/m0-smoke.mjs`） | **14 通过 / 0 失败 / 1 阻塞**——`@deepseek-ai/dsh-atomic-write` 无法从仓库上下文解析；实际采用原生 lease 路径 |
| 临时 profile 离线 E2E（`pwsh -File scripts/e2e-dsh.ps1`） | **8/8 项检查、7/7 条断言通过**——临时 `DSH_HOME`、本地 Messages-API mock、同一工作区的两个真实 headless 会话：会话 1 用 `confluence_post` 发布，会话 2 从被动脉动中收到；落盘日志、已提交脉动快照、且无 Confluence inbox splice；证据保存在 `.tmp/e2e/run-*/` |
| 真实 desktop profile 安装（Plugin Manager `install_bundle`） | **已执行**——`application: applied`；profile 依赖 `dsh-confluence: link:D:/05_Code/Confluence` 且 bundle 已选中；实时 Host 可见六个工具；本会话运行期上下文出现脉动；`confluence_board` 执行并返回带 untrusted 包装的看板结果；真实 `~/.dsh/storages/confluence/v1/` 下已创建存储 |
| 导出生产端 CLI（`node scripts/export-memories.mjs`） | **已执行**（对 E2E 临时存储）——`manifest.json` + `memories.v1.jsonl` 合法、哈希可复现、`--dry-run` 不写文件 |
| `solo-bench` Go 消费端（`internal/confluenceexport`） | **已执行**——`go test ./...`、`go vet ./...`、`gofmt -l .` 全部通过；仅消费导出文件，不做实时 IPC |
| 静态离线/无出网扫描、locale 对齐、图标校验 | **由契约检查执行** |

尚未执行：

| 检查项 | 状态 |
|---|---|
| 面板渲染 / 可视化验证 | **未执行**——客户端 bundle 需下次页面渲染才加载；Host 路由已注册且受鉴权保护（静态客户端契约测试通过） |
| PTC 预设（`run_code`）工具可达性 | **未执行**——M0-S3 探针仍开放 |
| 多窗口实时新鲜度实测 | **未执行**——轮询是已实现的契约；两进程合并已有测试覆盖 |
| 浸泡/压缩压力、长期保留 | **未执行** |
| 构建 tarball + SHA-256、发布/release | **未执行——未发布任何东西** |

---

## 许可证

[MIT](LICENSE) © 2026 XiaoleC05 与 Confluence / 汇流 贡献者。

## 链接

- GitHub: [https://github.com/XiaoleC05/Confluence](https://github.com/XiaoleC05/Confluence)
- Crisp——本打包遵循的本地插件先例：`D:\05_Code\Crisp\integrations\dsh-plugin-crisp`
