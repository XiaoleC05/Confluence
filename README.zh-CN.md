# Confluence / 汇流

> **同一工作区的会话，共享同一份记忆。** / **Your sessions remember together.**

**状态：设计已完成，实现从里程碑 M1 开始。** 本仓库目前包含完整的设计、DeepSeek Harness
（DSH）插件的打包骨架，以及零依赖的契约测试。插件入口是刻意留空的：**现在安装这个 bundle
不会产生任何用户可见的效果。** 没有看板、没有脉动、没有回溯、没有界面，也不会写入任何数据。

Confluence（中文名 **汇流**，"众流汇合之处"）是一个**完全离线**的 DeepSeek Harness 插件，目标是把
同一工作区中会话之间的信息共享从"请把这件事写到文档里"的手工动作变成自动能力。当前目标运行时为
DSH Desktop **0.2.2-rc.1**、`desktop` profile，后续将并入 `solo-bench` 离线工作台。

本 README 如实说明现状：这里没有基准测试、没有截图、没有演示；项目尚未安装进任何 profile。

---

## 问题

DSH 的每个会话都是相互隔离的语言上下文。两个在同一目录下启动的会话并不知道彼此在同一工作区里：

- 会话 A 已经定位到 Windows `EPERM` 重试问题的根因，会话 B 却从头再查一遍；
- 会话 A 决定"依赖统一锁在 0.2.x"，会话 B 却选了 0.3.x；
- 会话 A 的数据库迁移做到一半，会话 B 在同一个库上又开了一次迁移；
- 用户整天在两个聊天窗口之间复制粘贴同一段结论。

目前只有手工的绕行办法：

| 绕行办法 | 不足之处 |
|---|---|
| 让 Agent 写一个文件，再让另一个 Agent 读它 | 你自己成了消息总线；文件不是持久的共享记忆 |
| `@` 提及另一个会话（`@deepseek-ai/dsh-session-reference`） | 需要用户触发、按消息进行、是有界且不可变的快照；它不会告诉模型"现在有什么新的、什么还没解决" |
| 启用实验性的 `session_*` 搜索工具 | 出厂**默认关闭且隐藏**；全文检索，由模型主动调用，不构成被动感知 |
| 看板/洞察类插件（例如 `dsh-context`） | 面向人的只读洞察，不会在会话之间共享任何内容 |

缺的那一层是**环境式工作区记忆**：会话不应该被"告知"同伴学到了什么，它应该自然知道这个工作区
共享了什么、还有什么未解决、最近发生了什么——本地、离线、有界。

---

## Confluence v1 将提供什么

v1 架构是三条支柱的混合体，决策记录见
[ADR 0001](docs/adr/0001-confluence-architecture.md) §2：

### 1. 脉动（Pulse）—— 被动感知

通过一个全局 `ctx.systemPrompt.context()` 贡献，在每个 Agent 步骤渲染一段**字节稳定、有界**的摘要：
最多 3 条新看板标题、未解决的问题与待接手的交接、在线同伴会话，以及工作区名称。当有新笔记导致
文本变化时，Agent 循环会提交一个新的运行期上下文快照；没有变化时，脉动**不消耗任何新 token**，
也不产生新消息。不唤醒 Agent、不定时器、不轮询 Agent。

### 2. 看板（Board）—— 显式共享记忆

一个持久、仅追加、按工作区隔离的看板，存放 Agent（或用户）发布的短类型笔记：
`finding`、`decision`、`gotcha`、`question`、`handoff`、`warning`。笔记可用 `reply_to` 组成线程；
问题与交接可以被解决。内容不做原地编辑——修正就是新笔记或解决动作。六个面向模型的工具
（`confluence_board`、`confluence_post`、`confluence_read`、`confluence_search`、
`confluence_reply`、`confluence_recall`）就是协作动词。

### 3. 账本 + 回溯（Ledger + recall）—— 按需历史

一份**仅含元数据**的会话语账本（标题、状态、轮次数、最后活动时间、工具调用中出现过的最多 8 个
工作区相对路径）维持对在线同伴的感知。`confluence_recall` **只在模型调用时**，通过
`ctx.sessionQuery` 的精确读取，检索同一工作区早前会话的日志：字面匹配、有上限、有超时、只读。
回溯不会在提示词提供者里运行，也从不自动注入。

对用户的承诺：**"同一工作区的会话，共享同一份记忆。"**

文档会如实把 v1 描述为*感知 + 按需字面检索*，而不是自动的"追溯式"全量索引（那可能是 v2 的一步，
需要以评估为门槛；见 ADR §11）。

---

## 工作方式（架构）

```text
┌───────────────────────────── DSH Desktop（每个应用实例一个 Host）─────────────────────────────┐
│                                                                                              │
│   会话 A — 工作区 W                            会话 B — 工作区 W                              │
│   ┌────────────────────────────┐               ┌────────────────────────────┐                 │
│   │ Agent 步骤                 │               │ Agent 步骤                 │                 │
│   │ 提示词组装                 │               │ 提示词组装                 │                 │
│   │  └─ confluence:pulse ──────┼── 字节稳定 ───┼─► 同一段渲染文本           │                 │
│   │ 工具：confluence_*         │   摘要        │ 工具：confluence_*         │                 │
│   └─────────────┬──────────────┘               └─────────────┬──────────────┘                 │
│                 │                                            │                               │
│                 ▼                                            ▼                               │
│   ┌──────────────────── Confluence 宿主插件（纯 ESM，仅 Node 内置模块）────────────────────┐   │
│   │ WorkspaceResolver │ BoardService │ SessionLedger │ PulseProvider │ Watermark │ Recall  │   │
│   └──────────────────────────────────────┬────────────────────────────────────────────────┘   │
│                                          │ 仅追加 JSONL 分片、presence 心跳                   │
│                 $DSH_HOME/storages/confluence/v1/workspaces/<wsKey>/                          │
│                 ├─ journal.<writerId>.v1.jsonl     ├─ presence/<writerId>.json                │
│                 └─ MANIFEST.v1.json（M4）          └─ snapshot.<gen>.v1.jsonl（M4）          │
│                                                                                              │
│   可选（M3）：通过 sidebar.panellist + 带 key 的 main 提供只读面板（不监听端口、不联网）      │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

关键边界（完整细节见[设计文档索引](docs/README.md)）：

- **工作区 = 同意边界。** 键 = 规范化后的会话 `header.cwd`（`fs.realpath`，Windows 下小写折叠），
  每个会话冻结一次。跨工作区不共享任何内容；无法解析工作区的会话既没有脉动，也没有 Confluence 工具。
- **存储在 profile 内，不污染工作区。** 按写入者分片的仅追加 JSONL 位于
  `$DSH_HOME/storages/confluence/v1/`；读取端合并分片、容忍尾部残行，以 3–5 秒轮询作为新鲜度契约
  （`fs.watch` 只是优化）。
- **会话日志仍是唯一事实来源。** 水位（`digestSeq`、`boardReadSeq`）通过 `sessionProjections` 单元
  从已提交的会话事件推导，因此 resume/replay/fork 会随日志复制自然继承；插件状态只是派生缓存。
- **共享内容是"不可信数据"。** 固定警告、转义框架字符（`<`、`&`、U+2028/2029）、不执行其中指令、
  处处有界、尽力做密钥脱敏、账本仅存元数据。

---

## v1 明确不做的事

先写清楚，避免误解：

- 不做持续的全量对话索引、不做 LLM 抽取、不做向量/嵌入检索；
- 不做服务器、不联网、不额外监听端口、不引入外部数据库、不启动子进程、不调用模型；
- 不跨工作区读取或共享；
- 不做远程/LAN 协作、不做 Liveshare、不做 git 自动化；
- 不做看板编辑/删除界面，不做账号与权限体系；
- 不替代 `@` 提及快照或原始会话搜索——它是与它们并存的补充。

---

## 设计阶段的真实情况（本仓库今天有什么）

| 声明 | 今天的实际情况 |
|---|---|
| 插件 bundle 清单与 patch | **已有**：`package.json`、`cordis.patch.yml` |
| 宿主入口 | **已有但按设计留空**：`index.js` 只解析配置、记录一条警告、不注册任何东西 |
| Locale 元数据与图标 | **已有**：`locale/en.json`、`locale/zh.json`、`icon.svg` |
| 契约测试 | **已有且离线可跑**：`node --test "test/*.test.js"` |
| 设计文档 | **已有**——研究、第 1–2 轮、ADR-0001–0006 与完整设计文档集 |
| 脉动 / 看板 / 账本 / 回溯 / 工具 | **未实现**——M1–M2 |
| 面板 / 客户端半身 | **未实现**——M3 |
| 已安装并激活到任何 DSH profile | **没有**——本阶段未执行 |

脚手架会记录恰好一条激活警告，确保"装了但为空"的 bundle 不会被误当成可用插件。

---

## 仓库结构

```text
D:\05_Code\Confluence\
  README.md                  本文件（英文）
  README.zh-CN.md            中文 README
  LICENSE                    MIT
  package.json               bundle 清单：dsh-confluence，private v0.1.0
  cordis.patch.yml           插入唯一的 `confluence` 行及完整默认配置
  index.js                   宿主入口（仅设计阶段脚手架）
  locale/en.json, zh.json    显示元数据 + 未来面板文案
  icon.svg                   原创图标：三条水流汇入一条通道
  examples/profile-patch.yml 用户覆盖示例（隐私优先/低噪音/调试）
  scripts/check.mjs          独立契约检查脚本
  test/contract.test.js      零依赖 node:test 契约测试
  docs/                      设计、研究、决策、计划、安装/发布指南
```

目前没有 `lib/`、没有 `client.js`、没有构建步骤：v1 宿主计划使用纯 ESM JavaScript 且只依赖 Node
内置模块，客户端半身在 M3 才加入。空的 `src/` 目录为后续实现预留，不属于今天的 bundle。

---

## 文档

完整文档地图与阅读顺序见[文档索引](docs/README.md)。

**决策与背景**

- [ADR 0001 — Confluence / 汇流 架构](docs/adr/0001-confluence-architecture.md)：约束性 v1 架构、
  配置、里程碑、被否决的替代方案。
- [第 1 轮 — 研究发现与候选设计](docs/discussion/round-1.md)
- [第 2 轮 — 交叉评审与架构决策](docs/discussion/round-2.md)
- [立场 A](docs/discussion/position-a.md) · [立场 B](docs/discussion/position-b.md)
- [团队简报](docs/planning/team-brief.md)

**研究**

- [DSH 内部机制（0.2.2-rc.1）](docs/research/dsh-internals.md)：已验证的 API、事件、存储行为与并发风险。
- [DSH 生态既有实现](docs/research/prior-art.md)：已经存在什么、该与什么组合、不要重复什么。
- [外部模式调研](docs/research/external-patterns.md)：离线安全的模式调查与适用性矩阵。

**第 3 轮设计文档（本轮完成）**

- [架构](docs/design/architecture.md)：组件、边界、生命周期、归属。
- [数据模型](docs/design/data-model.md)：看板/账本记录模型与不变量。
- [存储格式](docs/design/store-format.md)：日志格式、分片、读取合并、压缩、导出。
- [工具 API](docs/design/tool-api.md)：六个工具的 schema 与结果渲染。
- [脉动](docs/design/pulse.md)：摘要模板、预算拆分、转义、水位机制。
- [账本与回溯](docs/design/ledger-recall.md)：元数据账本与按需回溯。
- [面板设计](docs/design/ui.md)：只读面板、插槽、locale、数据通道。
- [配置](docs/design/config.md)：每个配置字段与默认值。
- [安全与隐私](docs/design/security-privacy.md)：信任模型、脱敏、退出机制、无出网保证。
- [测试计划](docs/design/testing.md)：验收标准与验证计划。
- [solo-bench 集成](docs/design/solo-bench-integration.md)：导出契约与合并路径。
- [执行计划](docs/plan/execution-plan.md)：里程碑计划与归属。
- [M0 探针](docs/plan/m0-spikes.md)：M0 探针清单与结果。
- ADR [0002 — 存储格式](docs/adr/0002-store-format-and-concurrency.md)、
  [0003 — 脉动与水位](docs/adr/0003-pulse-and-watermarks.md)、
  [0004 — 隐私](docs/adr/0004-privacy-and-consent.md)、[0005 — UI 通道](docs/adr/0005-ui-transport.md)、
  [0006 — solo-bench 集成](docs/adr/0006-solo-bench-integration.md)。

**打包与运维**

- [安装与验证指南（未来 / M3 验证）](docs/install.md)
- [发布与版本流程](docs/publishing.md)

---

## 离线与隐私保证

Confluence 的设计目标是**完全不联网**：

- 插件运行时不使用 `fetch`、不建立出站 socket、不启动子进程、不调用模型；
- 不额外监听端口、不启动服务器；安装只是一次本地包操作；
- 不使用外部数据库——只使用 `$DSH_HOME/storages/confluence/v1/` 下的 profile 本地文件；
- 不做遥测、不做崩溃上报、不做更新检查。

隐私模型（ADR §11）：

- **工作区是同意边界。** 看板笔记与元数据默认在*同一工作区内*共享；跨工作区不共享。
- **如实说明"存了什么"与"按需读什么"。** 存储保存看板笔记、标题、会话元数据、工作区相对路径与
  计数。早前会话日志只在模型显式调用 `confluence_recall` 时读取，且只返回有界摘录。
- **元数据优先。** 不保存提示词、助手文本、工具输出或命令行；文件提示默认不进脉动
  （`ledger.fileHintsInPulse: false`）。
- **尽力脱敏**：API key、token、私钥、密码类模式，可配置拒绝路径模式，并支持按会话/按工作区退出。
- **共享笔记是不可信数据**，不是指令——脉动与看板结果携带固定警告、转义框架字符，且不能自行触发
  任何工具调用。

这些是设计承诺；无出网测试与字段白名单测试会随实现（M1–M4）落地。当前脚手架本身不含任何网络或
子进程代码（由 `test/contract.test.js` 检查）。

---

## 安装（未来 / M3 验证）

> **本阶段未执行。今天安装这个 bundle 请不要期待任何行为。** 制作本仓库期间没有修改任何 profile。
> 文档化的验证目标是 **M3**，完整流程见 [docs/install.md](docs/install.md)。

两条文档化路径（沿用 DSH 随附指引与 Crisp 集成的先例）：

1. **Plugin Manager `install_bundle`**：从仓库绝对路径安装 bundle；包安装与 bundle 选择由管理器完成。
2. **CLI 装入临时 profile**：`dsh plugin --profile <scratch-name> add <绝对路径>`，再用
   `dsh --profile <scratch-name> --dump-config` 确认 `confluence` 行能正确组合，然后才考虑真实 profile。

设计阶段的预期激活行为：宿主日志中恰好出现**一条警告**，说明该插件是设计阶段脚手架、尚无任何能力。
没有工具、没有提示词文本、没有 UI、没有文件。

回滚：从 profile 移除 bundle（`dsh plugin --profile <name> remove dsh-confluence`）或删除对应行；
本地链接安装不会留下任何状态。

---

## 开发

要求：**Node.js ≥ 22.19.0**；后续真实激活需要 **DSH ≥ 0.2.2-rc.1**。没有依赖需要安装，也没有构建步骤。

```powershell
# 在仓库根目录
node --test "test/*.test.js"     # 契约测试（离线、零依赖）
node scripts/check.mjs          # 同样的检查，独立脚本并输出汇总
```

当前测试覆盖：bundle 清单结构、patch 行与默认配置、locale 元数据与中英 key 对齐、图标的合法性与
自包含性、宿主入口的导入/apply 契约（一条警告、不注册任何东西、坏配置不崩溃）、宿主入口不含
网络/子进程/DSH 静态导入、README 的诚实性标记与行数预算、文档索引链接可解析、安装/发布指南章节。
它们刻意只测**打包契约**，不测尚未实现的行为。

---

## 路线图

| 里程碑 | 范围 | 状态 |
|---|---|---|
| **M0 — 探针** | 验证运行期上下文去重、projection 标记折叠、PTC 工具呈现、Windows 日志追加/残行、多窗口拓扑、宿主数据通道、可选 atomic-write 导入。 | 计划中（1 天） |
| **M1 — 核心** | Journal store、工作区解析、看板记录、`confluence_board`/`post`/`read`、脉动 + 欢迎摘要、projection 水位、单元测试。 | 计划中（4 天） |
| **M2 — 协作** | 实时账本 + presence、`reply`/`search`/`recall`、脱敏与上限、私有/退出、临时 profile 离线 E2E。 | 计划中（3.5 天） |
| **M3 — 面板** | 只读 UI、locale、数据通道决策、标记已读/退出、无出网测试；**安装验证**。 | 计划中（2.5 天） |
| **M4 — 加固** | 压缩/导出 + manifest、文档/发布验证、浸泡与并发测试、徽标/自定义卡片、solo-bench 集成文档。 | 计划中（2 天） |

v1 总规模约 **13 工程师日**（±30%），见 [ADR §14](docs/adr/0001-confluence-architecture.md)。
v2（可选）：以精确率/召回率评估为门槛的确定性"轻量捕获"信号——不属于 v1。

---

## 验证状态

本设计阶段已执行：

| 检查项 | 结果 |
|---|---|
| 设计文档撰写（研究、第 1–2 轮、ADR-0001） | 已执行 |
| 打包骨架撰写（清单、patch、入口、locale、图标、示例） | 已执行 |
| 契约测试撰写并离线运行（`node --test`，Node 22） | 已执行——见下方报告 |
| 独立契约检查脚本撰写并运行（`node scripts/check.mjs`） | 已执行 |
| `npm pack --dry-run` 文件清单检查（离线，不生成 tarball） | 已执行——9 个文件，无意外内容 |
| 宿主入口静态离线检查（无网络/子进程/DSH 导入） | 已由契约测试执行 |
| 图标结构校验（SVG、无脚本/文本/外链、< 256 KiB） | 已由契约测试执行 |

本设计阶段未执行：

| 检查项 | 状态 |
|---|---|
| 将 bundle 安装进任何 DSH profile | **未执行** |
| 在真实 DSH 宿主中激活并观察那一条警告 | **未执行** |
| 脉动注入、看板工具、回溯、面板渲染 | **未实现、未执行** |
| 多窗口/多进程并发行为 | **未执行**（仅有设计与探针计划） |
| 构建/计算 tarball 校验和（`npm pack`）、`npm publish --dry-run` | **未执行**（已执行 dry-run 清单） |
| 发布到 npm 或创建 GitHub Release | **未执行——未发布任何东西** |
| 合并进 `solo-bench` | **未执行**（仅记录合并路径） |

本仓库不宣称任何基准测试、截图、用户数或性能数字；文中出现的数字（token 预算、上限、存储大小）
都是**设计目标**。

---

## 贡献

本仓库是设计阶段产物。改动需保持离线/无服务器约束、版本化存储格式与上述验证诚实性。新增能力时，
请在同一改动中加入相应的契约测试或行为测试。

## 许可证

[MIT](LICENSE) © 2026 XiaoleC05 与 Confluence / 汇流 贡献者。

## 链接

- GitHub: [https://github.com/XiaoleC05/Confluence](https://github.com/XiaoleC05/Confluence)
- DeepSeek Harness: [https://www.deepseek.com/harness/](https://www.deepseek.com/harness/)
- Crisp——本打包遵循的本地插件先例：`D:\05_Code\Crisp\integrations\dsh-plugin-crisp`
