<div align="center">

<img src="./docs/assets/banner-week1.png" alt="Nirvana-OS：一句话进，成品出。并行的 agent 工作流经由质量门汇聚。" width="100%">

# Nirvana-OS

**开箱即用的智能体运营。** 一句话进。成品出。

[![GitHub stars](https://img.shields.io/github/stars/gutomec/nirvana-os-engine)](https://github.com/gutomec/nirvana-os-engine/stargazers)
[![version](https://img.shields.io/github/v/release/gutomec/nirvana-os-engine?label=version)](./CHANGELOG.md)
[![CI](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml/badge.svg)](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)

**macOS / Linux**

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
```

[文档](https://gutomec.github.io/nirvana-os-engine/) · [Packs](https://squads.sh/pt/packs) · [图解安装](https://gutomec.github.io/nirvana-os-engine/install.html) · [Changelog](./CHANGELOG.md)

**用你的语言阅读：** [English](./README.md) · [Português](./README.pt-BR.md) · [Español](./README.es.md) · [中文](./README.zh.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md)

</div>

---

## 你和你的 agent 对话。你的 agent 运行 Nirvana。

你已经在用一个终端 agent：Claude Code、Codex、Antigravity、Pi、Grok 或其他。一个提示词换来一个好答案。真正的工作需要一位研究员、一位写手、一位审稿人和一位操作员，还要记录谁做了什么。

Nirvana-OS 给你的 agent 提供这样的组织。你用平实的语言提出要求，agent 就用 Nirvana 挑选合适的公司、squad 和 mind-clone，派遣它们，检查返回的结果，并把凭据拿给你看。你不用学新的界面，日常也不用敲命令。下面的命令是你的 agent 使用的参考，你想用的时候它们也在那里。

## 它是什么

Nirvana-OS 是一个 Bun 原生、与运行时无关的多 agent 系统。它运行在你已经在用的 agent 之上，从不取代它。它处理三类内容，全都是你机器上的文件夹：

| 支柱 | 它是什么 | 它在哪里 |
|---|---|---|
| **公司（businesses）** | 拥有由员工（岗位）组成的组织架构的组织。被派遣的公司运行它的各个岗位，岗位调用 squad 并引导 mind-clone | `~/businesses/` |
| **Squads** | 可移植的 agent 团队，包含 agent、task 和工作流，被派遣的 agent 把它们当作自己的方法来遵循 | `~/squads/` |
| **Mind-clones** | 分为五层的人格 DNA，让 agent 以某位特定专家的方法思考和写作 | `~/businesses/_library/dna/` |

引擎发布时不带任何内容。你可以让你的 agent 创建公司、squad 和 clone，也可以从 [squads.sh](https://squads.sh/pt/packs) 安装一个 pack。

## 安装

运行本页顶部的一行命令。它需要 `curl`（或 `wget`）和 `tar`，macOS、Linux 和 Windows 10+ 都已自带。不需要 Node。如果缺少 [Bun](https://bun.sh)，安装器会在不使用 sudo 的情况下把它装进你的用户目录（`~/.bun`），然后继续。

它在你的机器上改动的内容：

- 引擎，位于 `~/.nirvana/skills`；
- `nirvana` skill，链接到它找到的每一个 agent 运行时：`~/.claude/skills`、`~/.codex/skills`、`~/.gemini/config/skills`（Antigravity）、`~/.pi/agent/skills` 和 `~/.agents/skills`（OpenClaw）；
- `~/.local/bin` 中的 `nrv` 和 `nrv-hermes`，外加你 shell 配置文件中的一行 PATH（在 Windows 上是用户 PATH）；
- Claude Code、Antigravity 和 Codex 中的审计 hook；
- 空的内容文件夹 `~/squads`、`~/businesses` 和 `~/businesses/_library/dna`。

再次运行是安全的。之后打开一个新终端，让 `nrv` 出现在你的 PATH 上，然后对你的 agent 说：*“检查 Nirvana-OS 是否安装正确。”* 它会运行 `nrv doctor`。退出码 1 表示只有警告；退出码 2 会列出失败的项目。

其他途径（通过 skills.sh 安装 `nirvana` skill、从克隆的仓库安装）见 [INSTALL.md](./INSTALL.md)。

## 开始一个项目

打开你想工作的文件夹，在那里启动你的 agent，然后说：*“把这个文件夹设置成一个 Nirvana-OS 项目。”* agent 会运行 `nrv init .`，它会写入 `.nirvana/project.yaml`、一个包含项目库范围的 `.env`，以及写在 `AGENTS.md`、`CLAUDE.md` 和 `GEMINI.md` 中的项目契约。交付物落在项目内的 `outputs/` 中。

默认情况下，这份契约让 Nirvana 成为项目中每一项具体交付物的编排器：你要一份报告、一个页面或一次营销活动，你的 agent 就把它交给 Nirvana。如果你只想在点名要求时才用 Nirvana，就在设置项目时说明（*“把这个文件夹设置成 Nirvana 项目，仅按需使用”*）。agent 会运行 `nrv init . --orchestrators=on-demand`，它写入的是一段简短说明，而不是完整的契约。

## 可以对你的 agent 说什么

| 你说 | 你的 agent 运行 |
|---|---|
| “我有哪些公司 / squad / mind-clone？” | `nrv list-businesses`、`nrv list-squads`、`nrv list-clones` |
| “用 Nirvana 为 X 写发布文案。” | harness：挑选公司和 squad，为它们写简报并派遣它们 |
| “把这个交给文案 squad，在 Codex 上跑。” | `nrv dispatch --squad <slug> … --exec --runtime codex` |
| “改一下你交付内容里的标题。” | `nrv revise <project> "<change>"` |
| “给我看看那次运行做了什么。” | `nrv audit-view <project>` |
| “安装我所有 squad 的依赖。” | `nrv activate --all` |
| “更新 Nirvana-OS。” | `nrv update` |
| “更新我的 Genesis Circle pack。” | `nrv update genesis-circle` |
| “每次运行最多花 US$ 5。” | `nrv config set budget.default_max_cost_usd 5 --global` |

更大的请求也是同样的方式：

```text
用 Nirvana-OS 创建一家名为 podcast-empire 的公司，同时制作、发布并变现 3 档播客。
每档节目都有自己的细分领域、一位 AI 主持人、一份编辑日历和一条独立的变现漏斗。
大约 7 名员工。
```

```text
用 Nirvana-OS 把 <author> 的公开作品变成一个完整的 AI mind-clone。
```

```text
用 Nirvana-OS 制作一套发布方案：市场调研、落地页文案和一份竞品拆解。
```

agent 负责编排，从不亲自撰写交付物。它挑选公司和 squad，为每一个写一份充实的简报并派遣它们，各部分相互独立时并行进行。

<div align="center">
  <img src="./docs/assets/nirvana-promo-en-readme.gif" alt="一条散文指令进，一整个 AI 集团组装完成并交付" width="100%">
</div>

## Packs

Pack 是在 [squads.sh](https://squads.sh/pt/packs) 上出售的、经过策划的公司、squad 和 mind-clone。旗舰产品是 [Genesis Circle](https://squads.sh/pt/nirvana-os)。

1. 在 squads.sh 购买 pack，并从你的控制面板下载它的 zip。
2. 把整个压缩包解压到一个文件夹，在那里打开终端并运行 setup：
   - macOS / Linux：`bash setup.sh`
   - Windows：`powershell -ExecutionPolicy Bypass -File setup.ps1`

   Setup 会在需要时安装 Bun，安装或更新引擎，把内容复制到 `~/squads`、`~/businesses` 和 `~/businesses/_library/dna`，重建索引，并把 pack 的许可存放在 `~/.nirvana-license/packs/<pack>/`。
3. 和你的 agent 对话：*“用 Nirvana 列出 Genesis Circle pack 给了我什么”*，然后点名一家公司、一个 squad 或这个 pack 来布置工作。

Squad 的依赖会在该 squad 第一次运行时按需安装。要提前把它们全部准备好，就让你的 agent 安装每个 squad 的依赖（`nrv activate --all`）。

**更新 pack。** 让你的 agent 更新它，或者运行 `nrv update <pack>`。在更新替换它们之前，你编辑过的组件会备份到 `~/.nirvana/backups/packs/<pack>/`。如果更新因许可错误而失败，就从 squads.sh 重新下载这个 pack，再运行一次它的 setup；这也会刷新许可。

## 更新引擎

让你的 agent 更新 Nirvana-OS，或者运行 `nrv update`。它会先备份 `~/.nirvana/skills`，并保留你的设置和内容。`nrv update --check` 会说出它将要安装的版本，而不做任何改动。

更新从不会把引擎移到更旧的版本。稳定版引擎只会升到更新的稳定版。beta 会升到最新的更高版本，无论是 beta 还是稳定版，所以 0.15 的 beta 会在 0.15.0 发布时变成 0.15.0。引擎更新之后，`nrv update` 还会检查每一个带许可的已安装 pack，并在有更新版本时告诉你。

## Beta 版

Beta 版是 GitHub 上的 prerelease。这行命令安装的是最新稳定版，所以要安装 beta，就得固定它的 tarball：

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | NIRVANA_ENGINE_URL=https://github.com/gutomec/nirvana-os-engine/releases/download/v<version>/nirvana-os-engine.tar.gz bash
```

```powershell
$env:NIRVANA_ENGINE_URL = "https://github.com/gutomec/nirvana-os-engine/releases/download/v<version>/nirvana-os-engine.tar.gz"
irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
Remove-Item Env:NIRVANA_ENGINE_URL
```

把 `<version>` 换成具体版本，例如 `0.15.0-beta.5`。tag 以 `v` 开头；没有它，下载会返回 404。版本列表在 [GitHub](https://github.com/gutomec/nirvana-os-engine/releases) 上。在 PowerShell 中，这个变量在整个窗口里都有效，所以最后一行会删除它：只要它还在，`nrv update` 就会重新安装被固定的 tarball。

一旦用上 beta，`nrv update` 和每个 pack 的 setup 都会让你留在 beta 通道。要回到稳定版，运行本页顶部那行普通命令：它会在 beta 之上安装最新稳定版，你的内容和设置都会保留。

## 设置

设置在你开口时才会改变。说 *“现在配置了什么？”*、*“每次运行最多花 US$ 5”* 或 *“关掉 AI 评判”* 就够了；你的 agent 会运行 `nrv config`，并告诉你改了什么。`nrv config list` 会显示每一项设置、它的值以及它的来源：环境变量、项目的 `.nirvana/config.yaml`、你的 `~/.nirvana/config.yaml`、引擎或默认值。你的全局文件在每次更新后都会保留。

默认不设置任何模型，也不设置推理投入，所以每个运行时都使用它自己的配置。完整参考见 [docs/configuration.md](./docs/configuration.md)。

## 为什么“工作已完成”在这里有分量

编排器可以在最终消息里宣布任何事。Nirvana-OS 用你能在磁盘上打开查看的东西为每一次交付作证。

- **审计轨迹。** 每一次派遣、质量门裁决和交付都是 `~/.harness-logs/<date>/audit.jsonl` 中的一条只追加事件。每一次 `--exec` 运行还会在项目的 `.nirvana/run-kernel.sqlite` 中留下一条记录。`nrv audit-view <project>` 会展示这条链。
- **在磁盘上核验。** `verify-deliverable` 把简报承诺的内容与实际存在的文件进行比对，质量门按文件类型运行评分标准，失败时进行修正轮次。严重问题在修正后仍然存在的运行会被扣下，不予交付。
- **对照简报评分。** 质量门把简报交给它的评判，所以交付物要符合当初的要求，而不只是一份通用的评分标准。
- **花费由你掌控。** 除非你要求，否则不会设置成本上限（*“每次运行最多花 US$ 5”* 会设置 `budget.default_max_cost_usd`）。

## 命令参考

面向 agent 和高级用户。`nrv help` 列出全部命令；`nrv <command> --help` 给出每个命令的选项。完整参考：[docs/CLI.md](./docs/CLI.md)。

| 命令 | 它做什么 |
|---|---|
| `nrv doctor` | 健康检查：运行时、hook、skills 链接、依赖、注册表、许可 |
| `nrv init <dir>` | 把一个文件夹变成 Nirvana 项目（`--orchestrators=on-demand\|always`、`--scope=project\|merge`） |
| `nrv list-businesses` / `list-squads` / `list-clones` | 浏览三个注册表 |
| `nrv find "<need>"` / `nrv search "<topic>"` | 针对一个请求的排序候选 / 跨库关键词搜索 |
| `nrv dispatch <business> "<brief>" --exec` | 让一家公司按一份简报运行；`--squad <slug>`、`--agent-x` 或 `--auto` 指定其他目标。没有 `--exec` 时只生成脚手架 |
| `nrv run-track status\|wait <run>` | 读取一次运行的状态，或等待它结束 |
| `nrv revise <project> "<change>"` | 在同一个运行时会话中修改一次交付 |
| `nrv audit-view <project>` | 一次运行的审计链 |
| `nrv activate <squad>\|--all` | 提前在 `~/.nirvana/envs/<squad>` 中准备一个 squad 的环境 |
| `nrv config list\|get\|set\|unset\|explain` | 设置，配合 `--global` 或 `--project` |
| `nrv update [--check]` / `nrv update <pack>` | 更新引擎 / 一个 pack |
| `nrv validate <squad\|business\|clone> <slug> [--fix]` | 单个实体的准入门 |
| `nrv glance` | Web 驾驶舱（`--read-only` 仅浏览） |
| `nrv uninstall --engine` | 移除引擎并保留你的内容 |

## 常见问题

**我需要会写代码吗？** 不需要。你用平实的语言描述结果；你的 agent 运行 Nirvana，公司和 squad 负责撰写、检查和交付。

**它会取代我的 agent 吗？** 不会。它运行在你的 agent 之上。被派遣的工作在你会话所用的运行时上运行，除非你指定另一个：Claude Code、Codex、Antigravity、Pi、Kimi 或 Grok。

**我的工作存放在哪里？** 在你的机器上：内容在 `~/businesses`、`~/squads` 和 `~/businesses/_library/dna`，交付物在每个项目的 `outputs/`。整个流程中没有任何 Nirvana 云。

**如果我的库里没有合适的呢？** 请求照样会运行，交给通才 `agent-x`。你也可以让你的 agent 创建缺少的公司或 squad。

**Windows？** 原生支持，通过 Bun。无需 WSL。

## 许可、作者与状态

作者：**Luiz Gustavo Vieira Rodrigues (gutomec / Prospecteezy)**。没有合著者。

许可：Nirvana-OS Sustainable Use License (SUL) v1.0。源码公开发布、可公开阅读，引擎可免费使用。它是 source-available，而非 OSI 批准的开源许可，某些商业用途需要单独的商业许可。在依赖任何摘要（包括这一段）之前，请先阅读 [LICENSE](./LICENSE)。

状态：beta（0.x，当前为 0.14.11）。引擎今天就能用，几分钟内即可安装。在 1.0 之前，预计接口表面会持续变动。
