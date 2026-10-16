<div align="center">

<img src="./docs/assets/banner-week1.png" alt="Nirvana-OS：一句话进，成品出。并行的 agent 工作流经由质量门汇聚。" width="100%">

# Nirvana-OS

**开箱即用的智能体运营。** 一句话进。成品出。

[![GitHub stars](https://img.shields.io/github/stars/gutomec/nirvana-os-engine)](https://github.com/gutomec/nirvana-os-engine/stargazers)
[![version](https://img.shields.io/github/v/release/gutomec/nirvana-os-engine?label=version)](./CHANGELOG.md)
[![CI](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml/badge.svg)](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)

**macOS、Linux 和 WSL**

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
```

[文档](https://gutomec.github.io/nirvana-os-engine/) · [Packs](https://squads.sh/pt/packs) · [图解安装](https://gutomec.github.io/nirvana-os-engine/install.html) · [Beta 版](https://gutomec.github.io/nirvana-os-engine/beta.html) · [Changelog](./CHANGELOG.md)

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
| **公司（businesses）** | 拥有组织架构的组织。被派遣的公司作为一个 agent 运行，由它扮演各个岗位，通过 squad 的卡片使用 squad，并引导 mind-clone | `~/businesses/` |
| **Squads** | 可移植的 agent 团队，包含 agent、task 和工作流，被派遣的 agent 把它们当作自己的方法来遵循 | `~/squads/` |
| **Mind-clones** | 分为五层的人格 DNA，让 agent 以某位特定专家的方法思考和写作 | `~/businesses/_library/dna/` |

引擎发布时不带任何内容。你可以让你的 agent 创建公司、squad 和 clone，也可以从 [squads.sh](https://squads.sh/pt/packs) 安装一个 pack。

## 安装

本 README 描述的是 0.15 beta，`v0.15.0-beta.10`。本页顶部的一行命令安装的是最新的**稳定版**（0.14.11）；要安装这个 beta，请使用 [Beta 版](#beta-版)一节中的命令。不需要 Node。如果缺少 [Bun](https://bun.sh)，两个安装器都会在不使用 sudo、也不需要管理员权限的情况下把它装进你的用户目录（`~/.bun`），然后继续。

运行之前：

- **macOS：** 无需准备。
- **Windows（PowerShell）：** 无需准备，也不需要管理员权限。
- **Linux（Ubuntu）：** `sudo apt update && sudo apt install -y curl unzip`。
- **Windows + WSL（Ubuntu）：** 在以管理员身份打开的 PowerShell 中运行 `wsl --install`，重启，打开 Ubuntu 应用并创建你的 Linux 用户。然后像在 Linux 上一样安装 `curl` 和 `unzip`，并在 Ubuntu 里运行 `bash` 命令。你的 AI agent（Claude Code、Codex、Antigravity）也必须安装在 Ubuntu 里，你的项目应放在 `~`，不要放在 `/mnt/c` 下，那里很慢。

它在你的机器上改动的内容：

- 引擎，位于 `~/.nirvana/skills`；
- `nirvana` skill，链接到它找到的每一个 agent 运行时：`~/.claude/skills`、`~/.codex/skills`、`~/.gemini/config/skills`（Antigravity）、`~/.pi/agent/skills` 和 `~/.agents/skills`（OpenClaw）；
- `~/.local/bin` 中的 `nrv` 和 `nrv-hermes`，外加你 shell 配置文件中的一行 PATH（在 Windows 上是用户 PATH）；
- Claude Code、Antigravity 和 Codex 中的审计 hook；
- 空的内容文件夹 `~/squads`、`~/businesses` 和 `~/businesses/_library/dna`。

再次运行是安全的。**关闭终端并打开一个新终端**，让 `nrv` 出现在你的 PATH 上，然后用 `nrv --version` 检查；这个 beta 会显示 `0.15.0-beta.10`。接着对你的 agent 说：*“检查 Nirvana-OS 是否安装正确。”* 它会运行 `nrv doctor`。退出码 1 表示只有警告；退出码 2 会列出失败的项目。

通过 `curl | bash` 运行时，安装器不会提问。要在安装时选择性能档位，把它传进去：把末尾的 `bash` 换成 `bash -s -- --profile=balanced`。你也可以之后让你的 agent 来设置（见[设置](#设置)）。

各个系统的分步指南在[文档网站](https://gutomec.github.io/nirvana-os-engine/install.html)（葡萄牙语）上，另有一个 [beta 页面](https://gutomec.github.io/nirvana-os-engine/beta.html)；[INSTALL.md](./INSTALL.md) 中也有，其他安装途径也在那里（通过 skills.sh 安装 `nirvana` skill、从克隆安装）。

## 开始一个项目

打开你想工作的文件夹，在那里启动你的 agent，然后说：*“把这个文件夹设置成一个 Nirvana-OS 项目。”* agent 会运行 `nrv init .`，它会写入 `.nirvana/project.yaml`，并在 `AGENTS.md`、`CLAUDE.md` 和 `GEMINI.md` 中写一段简短说明。交付物落在项目内的 `outputs/` 中。

这段说明让你的 agent 照常工作。只有当你的请求需要时，它才使用 Nirvana：

- 你点名提到它（“用 Nirvana 来……”、“通过 nirvana”）；
- 你点名或指向你的某家公司、某个 squad 或某个 mind-clone（“我的发布公司”、“文案 squad”、“用 Hormozi 的口吻”），包括 pack 的名字；
- 你要求整个工作或其中一部分在另一个运行时上运行（“用 Codex 来审查”）。

如果你想让 Nirvana 编排一个项目中的每一项交付物，就说 *“在这个项目里用 Nirvana 编排一切”*。agent 会运行 `nrv init . --orchestrators=always`。打开一个新会话，让这项改动生效。稳定版 0.14.11 正好相反：完整契约是它的默认值，只有当你自己在一个已经有这些文件之一的文件夹中运行 `nrv init .` 时，它才会询问。

从那以后，你用平实的语言和你的 agent 对话，由它使用 Nirvana-OS。你日常不需要输入命令。

## 可以对你的 agent 说什么

| 你说 | 你的 agent 运行 |
|---|---|
| “我有哪些公司 / squad / mind-clone？” | `nrv list-businesses`、`nrv list-squads`、`nrv list-clones` |
| “用 Nirvana 为 X 写发布文案。” | harness：挑选公司，写一份简报，`nrv dispatch … --exec` |
| “把这个交给文案 squad，在 Codex 上跑。” | `nrv dispatch --squad <slug> … --exec --runtime codex` |
| “停掉那次运行。” | `nrv run-track stop <run>` |
| “改一下你交付内容里的标题。” | `nrv revise <project> "<change>"` |
| “给我看看那次运行做了什么。” | `nrv audit-view <project>` |
| “安装我所有 squad 的依赖。” | `nrv activate --all` |
| “更新 Nirvana-OS。” | `nrv update` |
| “更新我的 Genesis Circle pack。” | `nrv update genesis-circle` |
| “把 Nirvana 切到经济模式。” | `nrv config set execution.profile economy --global` |

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

agent 负责编排，从不亲自撰写交付物。它挑选的每一家公司都会得到自己的简报和自己的运行，各部分相互独立时并行进行。

<div align="center">
  <img src="./docs/assets/nirvana-promo-en-readme.gif" alt="一条散文指令进，一整个 AI 集团组装完成并交付" width="100%">
</div>

## Packs

Pack 是在 [squads.sh](https://squads.sh/pt/packs) 上出售的精选公司、squad 和 mind-clone。旗舰是 [Genesis Circle](https://squads.sh/pt/nirvana-os)。

1. 在 squads.sh 购买 pack，并从你的控制台下载它的 zip。
2. 解压整个压缩包，并在包含 `setup.sh` 的文件夹中打开终端：
   - macOS：双击 zip，在“终端”中输入 `cd `（带空格），把文件夹拖到窗口上，按回车；
   - Windows：右键点击 zip，选择**全部解压缩**，打开文件夹，在空白处右键并选择**在终端中打开**；
   - Linux 和 WSL：`cd ~/Downloads && unzip <文件>.zip -d <文件夹> && cd <文件夹>`。在 WSL 上，先把 zip 从 `/mnt/c/Users/<用户>/Downloads` 复制到 `~/Downloads`。
3. 运行 setup：
   - macOS、Linux 和 WSL：`bash setup.sh`
   - Windows：`powershell -ExecutionPolicy Bypass -File setup.ps1`

   setup 会在需要时安装 Bun，安装或更新引擎，把内容复制到 `~/squads`、`~/businesses` 和 `~/businesses/_library/dna`，重建索引，并把 pack 的许可存放到 `~/.nirvana-license/packs/<pack>/`。它从不会把引擎换成更旧的版本，所以 beta 仍然是 beta。
4. 和你的 agent 对话：*“用 Nirvana 列出 Genesis Circle pack 给了我什么”*，然后点名一家公司、一个 squad 或这个 pack 来请求工作。

**激活 squad。** squad 的依赖会在它第一次运行时按需安装，装在它自己的环境 `~/.nirvana/envs/<squad>` 中。要一次性提前准备好所有依赖，就对你的 agent 说：*“激活我所有的 Nirvana squad。”* 它会运行 `nrv activate --all`，涵盖 Node 和 Python 包、系统程序、API 密钥和环境变量、MCP 服务器以及模型。agent 会拿到失败清单，每一项都附有修复它的确切命令；在执行任何用到 `brew`、`sudo` 或 `winget` 的操作之前，以及需要任何 API 密钥时，它都会先征得你的许可。在大型 pack 上第一次运行需要几分钟。

**更新 pack。** 让你的 agent 更新它，或者运行 `nrv update <pack-slug>`，例如 `nrv update genesis-circle`。在更新替换它们之前，你编辑过的组件会备份到 `~/.nirvana/backups/packs/<pack>/`。如果更新因许可错误而失败，就从 squads.sh 重新下载这个 pack，再运行一次它的 setup；这也会刷新许可。

## 更新引擎

让你的 agent 更新 Nirvana-OS，或者运行 `nrv update`。它会先备份 `~/.nirvana/skills`，并保留你的设置和内容。`nrv update --check` 会说出它将安装哪个版本，但不做任何改动。

更新永远不会把引擎降到更旧的版本。稳定版引擎只会升到更新的稳定版。beta 版会升到最新的更高版本，无论是 beta 还是稳定版，所以 0.15 的 beta 会在 0.15.0 发布时变成 0.15.0。引擎更新后，`nrv update` 还会检查每一个带许可的已安装 pack，并在有新版本时告诉你。

## Beta 版

Beta 版是 GitHub 上的预发布版本，而本 README 就是 beta 版的：`v0.15.0-beta.10`。顶部的一行命令安装的是最新稳定版，所以 beta 需要固定它的 tarball 来安装。标签以 `v` 开头；少了它，下载会返回 404。要安装更新的 beta，把这个标签换成[发布列表](https://github.com/gutomec/nirvana-os-engine/releases)中的标签。

macOS、Linux 和 WSL：

```bash
curl -fsSL https://gutomec.github.io/nirvana-os-engine/install.sh | NIRVANA_ENGINE_URL=https://github.com/gutomec/nirvana-os-engine/releases/download/v0.15.0-beta.10/nirvana-os-engine.tar.gz bash
```

Windows（PowerShell），写成一行：

```powershell
$env:NIRVANA_ENGINE_URL='https://github.com/gutomec/nirvana-os-engine/releases/download/v0.15.0-beta.10/nirvana-os-engine.tar.gz'; irm https://gutomec.github.io/nirvana-os-engine/install.ps1 | iex
```

之后，如果窗口还开着，运行 `Remove-Item Env:NIRVANA_ENGINE_URL`：只要这个变量还在，`nrv update` 就会重新安装固定的 tarball。Windows 命令使用单引号，是因为粘贴时丢失的双引号会让 PowerShell 停在 `>>` 提示符上等待。

进入 beta 之后，`nrv update` 和每一次 pack setup 都会让你留在 beta 通道：先是更新的 beta，0.15.0 发布后就是 0.15.0。在 0.14.11 上设置的项目会保留完整契约，直到你在 beta 上运行 `nrv init .`，它会就地把契约换成按需说明（`--orchestrators=always` 则保留完整契约）；你写在 Nirvana 区块之上的内容会保留。

**回到稳定版。** 在 Windows 上，先打开一个新的 PowerShell 并运行 `Remove-Item Env:NIRVANA_ENGINE_URL`；提示它不存在的错误可以忽略。运行本页顶部的普通一行命令。它会在 beta 之上安装最新稳定版，并保留你的内容、pack 和设置。确认 `nrv --version` 不再显示 `beta`，然后在每个用 beta 用过的项目中删掉 beta 写入 `AGENTS.md`、`CLAUDE.md` 和 `GEMINI.md` 的区块，再重新运行 `nrv init .`（[详情](./INSTALL.md#back-to-stable-from-a-beta)）。

## 设置

设置在你开口时才会改变。说 *“把 Nirvana 切到经济模式”*、*“最高质量”* 或 *“现在配置了什么？”* 就够了；你的 agent 会运行 `nrv config`，并告诉你改了什么。

一个档位会同时调整多项设置：

| 档位 | 推理投入 | 每个 worker 的上下文上限 | 评审 | worker 的视觉检查 |
|---|---|---|---|---|
| `max` | xhigh | 无（运行时默认） | 每次交付，最多两轮 | 开启 |
| `balanced` | high | 400k tokens | 规则要求时 | 关闭 |
| `economy` | medium | 200k tokens | 仅在请求时 | 关闭 |

档位从不挑选模型；那由你的运行时自己的配置决定。你显式更改的设置优先于档位。`nrv config list` 会显示每一项设置、它的值以及它的来源。完整参考见 [docs/configuration.md](./docs/configuration.md)。档位只从 0.15 起才有。

**按项目设置。** `nrv config set briefing.altitude <outcome|guided|prescriptive> --project` 决定一份 brief 承载多少内容：默认的 `outcome` 说明结果、约束和完成标准；`guided` 再加上作者建议的结构；`prescriptive` 再加上逐项标准、产物清单和方法。`nrv config get briefing.altitude` 显示当前生效的值。自由文本形式的规则写在项目的 `CLAUDE.md`、`AGENTS.md` 或 `GEMINI.md` 中，放在 `nrv init` 会重写的 Nirvana 区块之上；你的 agent 会读取它们，并把它们带进它写的 brief。直接提出即可：*“在这个项目里使用 guided brief”*、*“在这个项目的 CLAUDE.md 里加上：所有交付物都用巴西葡萄牙语”*。

## 为什么“工作已完成”在这里有分量

编排器可以在最终消息里宣布任何事。Nirvana-OS 用你能在磁盘上打开查看的东西为每一次交付作证。

- **审计轨迹。** 每一次派遣、质量门裁决和交付都是 `~/.harness-logs/<date>/audit.jsonl` 中的一条只追加事件。每一次 `--exec` 运行还会在项目的 `.nirvana/run-kernel.sqlite` 中留下一条记录。`nrv audit-view <project>` 会展示这条链。
- **在磁盘上核验。** `verify-deliverable` 把简报承诺的内容与实际存在的文件进行比对，质量门按文件类型运行评分标准，失败时进行修正轮次。严重问题在修正后仍然存在的运行会被扣下，不予交付。
- **带标准的简报。** 每份简报都逐字携带用户的请求，以及可观察的“完成条件”；标记为 `(blocking)` 的那些决定交付能否通过。
- **花费由你掌控。** 除非你要求，否则不会设置成本上限（*“每次运行最多花 US$ 5”* 会设置 `budget.default_max_cost_usd`）。

## 命令参考

面向 agent 和高级用户。`nrv help` 列出全部命令；`nrv <command> --help` 给出每个命令的选项。完整参考：[docs/CLI.md](./docs/CLI.md)。

| 命令 | 它做什么 |
|---|---|
| `nrv doctor` | 健康检查：运行时、hook、skills 链接、依赖、注册表、许可 |
| `nrv init <dir>` | 把一个文件夹变成 Nirvana 项目（`--orchestrators=always`、`--scope=project\|merge\|global`） |
| `nrv list-businesses` / `list-squads` / `list-clones` | 浏览三个注册表 |
| `nrv find "<need>"` / `nrv search "<topic>"` | 针对一个请求的排序候选 / 跨库关键词搜索 |
| `nrv brief template\|check\|decide` | 编排器为一家公司撰写的六段式简报 |
| `nrv dispatch <business> --brief-file <file> --exec` | 让一家公司按一份简报运行；`--squad <slug>[:<capability>]`、`--agent-x` 或 `--auto` 指定其他目标。没有 `--exec` 时拒绝执行 |
| `nrv run-track status\|stop <run>` | 读取一次运行的状态，或干净地停止它 |
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

**它会取代我的 agent 吗？** 不会。它运行在你的 agent 之上。被派遣的工作在你会话所用的运行时上运行，除非你指定另一个：Claude Code、Codex、Antigravity、Pi、Kimi、Grok、Qwen Code 或 OpenCode。

**我的工作存放在哪里？** 在你的机器上：内容在 `~/businesses`、`~/squads` 和 `~/businesses/_library/dna`，交付物在每个项目的 `outputs/`。整个流程中没有任何 Nirvana 云。

**如果我的库里没有合适的呢？** 请求照样会运行，交给通才 `agent-x`。你也可以让你的 agent 创建缺少的公司或 squad。

**Windows？** 原生支持，通过 Bun，无需 WSL。如果你更喜欢 WSL，就把所有东西都装在 Ubuntu 里，包括你的 agent。

## 故障排查

- **PowerShell 显示 `>>` 并一直等待。** 粘贴时有一个引号没有闭合。按 Ctrl+C 或打开一个新窗口，然后重新粘贴那一整行。
- **关闭“终端”后 macOS 显示 “Saving session… [Processo concluído]”。** 这是“终端”在关闭 shell，不是错误。
- **安装返回 404。** 标签缺少开头的 `v`，或者该版本不存在。
- **pack 更新因许可错误而失败。** 从 squads.sh 重新下载 pack，并运行它的 setup。
- **其他问题。** `nrv doctor` 检查整个安装，`nrv install --check` 检查 hook 和 PATH。更多内容见 [INSTALL.md](./INSTALL.md#troubleshooting)。

## 许可、作者与状态

作者：**Luiz Gustavo Vieira Rodrigues (gutomec / Prospecteezy)**。没有合著者。

许可：Nirvana-OS Sustainable Use License (SUL) v1.0。源码公开发布、可公开阅读，引擎可免费使用。它是 source-available，而非 OSI 批准的开源许可，某些商业用途需要单独的商业许可。在依赖任何摘要（包括这一段）之前，请先阅读 [LICENSE](./LICENSE)。

状态：beta（0.x，当前为 0.15.0-beta.10）。引擎今天就能用，几分钟内即可安装。在 1.0 之前，预计接口表面会持续变动。
