<div align="center">

<img src="./docs/assets/banner-week1.png" alt="Nirvana-OS：一句话进，成品出。并行的 agent 工作流经由质量门汇聚。" width="100%">

# Nirvana-OS

**开箱即用的智能体运营。** 一句话进。成品出。

[![npm downloads](https://img.shields.io/npm/dm/@nirvana-os/cli)](https://www.npmjs.com/package/@nirvana-os/cli)
[![GitHub stars](https://img.shields.io/github/stars/gutomec/nirvana-os-engine)](https://github.com/gutomec/nirvana-os-engine/stargazers)
[![version](https://img.shields.io/github/v/release/gutomec/nirvana-os-engine?label=version)](./CHANGELOG.md)
[![CI](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml/badge.svg)](https://github.com/gutomec/nirvana-os-engine/actions/workflows/smoke.yml)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)
[![npm](https://img.shields.io/npm/v/@nirvana-os/cli?label=npm)](https://www.npmjs.com/package/@nirvana-os/cli)

```bash
npx @nirvana-os/cli
```

一条命令即可安装引擎，并把它接入它找到的每一个终端 agent。随时可以安全地再次运行。

[文档](https://gutomec.github.io/nirvana-os-engine/) · [Packs](https://squads.sh/pt/packs) · [图解安装](https://gutomec.github.io/nirvana-os-engine/install.html) · [Changelog](./CHANGELOG.md)

**用你的语言阅读：** [English](./README.md) · [Português](./README.pt-BR.md) · [Español](./README.es.md) · [中文](./README.zh.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md)

</div>

---

## 你的 agent 很锋利。它也很孤单。

你已经在用一个终端 agent：Claude Code、Codex、Gemini-CLI 或 Antigravity。一个提示词换来一个好答案。真正的工作不是一个提示词。它是一位研究员、一位写手、一位审稿人和一位操作员朝同一个方向并行发力，并留下书面记录。今天，胶水是你。

Nirvana-OS 把这个单打独斗的 agent 提拔为能运转整个组织的指挥家。你用平实的散文描述结果。引擎读取简报，查阅你所拥有的东西，并行派遣公司、squad 和 mind-clone，在一道质量门之后调和一切，并为每一次派遣写下审计轨迹。你不再是操作员，而成为总监。

整个界面就是散文加一张凭据。你说话。你的 agent 运行命令。

## 它是什么

Nirvana-OS 是一个 Bun 原生、与运行时无关的多 agent 操作系统。它创建、管理并运营一个集团：任意数量的公司和 squad，从简报到经过验证的交付物全程编排。它是位于你的终端 agent 之上的编排层，而不是它的替代品。

默认是**零人工**：公司自主运行，人工介入需通过清单中的显式触发器主动开启。你陈述结果。引擎挑选阵容。

它创建的一切都属于三者之一：

| 支柱 | 它是什么 | 它在哪里 |
|---|---|---|
| **公司（businesses）** | 自治组织，拥有由持久员工组成的组织架构，员工负责调用 squad | `~/businesses/` |
| **Squads** | 可移植的 agent 团队，运行真正的工作流：DAG、质量门、升级 | `~/squads/` |
| **Mind-clones** | 分为 5 层的人格 DNA，注入员工体内，让他们以某位大师的方法思考和表达 | `~/businesses/_library/dna/` |

一家公司编排员工。一位员工调用 squad。一个 squad 运行 agent。一个 mind-clone 让其中任何一个拥有更真实的声音。一份简报就能同时调动它们当中的许多。

## 快速开始

你需要：[Bun](https://bun.sh) 1.0 或更新版本。Node 18+ 和 `tar` 只是为了让 `npx` 能跑起来，大多数机器上已经有了。

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
exec $SHELL
npx @nirvana-os/cli

# Windows（原生，无需 WSL），在 PowerShell 中
powershell -c "irm bun.sh/install.ps1 | iex"
# 打开一个新的 PowerShell 窗口，让 PATH 刷新
npx @nirvana-os/cli
```

安装器把单一的 skills 目录树放在 `~/.nirvana/skills`，在找到 `~/.claude`、`~/.codex`、`~/.gemini` 和 `~/.antigravity` 的地方把它链接进去，并把 `nrv` 二进制放到你的 PATH 上。它只安装引擎，不安装任何内容：你的注册表按设计从空开始，所以里面的一切都是你构建的或你选择安装的。再次运行安装器是幂等的，而且总会拉取最新的引擎。

确认安装状态良好：

```bash
nrv doctor
```

在 Windows 上，`nrv doctor` 还会检查用户 PATH 中是否残留了 0.8.0 及更早的引擎可能留下的临时 `nrv-*` 条目。`nrv install --repair-path` 只列出它们而不写入任何东西；`--apply` 恰好只删除这些条目，其余条目保持原样。

然后打开你的 agent，说 **“用 Nirvana-OS 来……”**。若要由 agent 驱动的设置，把你的运行时指向 [`AGENT-QUICKSTART.md`](./AGENT-QUICKSTART.md)。

## 90 秒演示

> **位置已预留。** 正式的 90 秒演练一经发布就会嵌入这里。在那之前，这是一条散文指令组装出一个集团的实况画面。

<div align="center">
  <img src="./docs/assets/nirvana-promo-en-readme.gif" alt="一条散文指令进，一整个 AI 集团组装完成并交付" width="100%">
</div>

<!-- DEMO-90s SLOT
     Canonical 90-second demo goes here when published (trace 75fbfbcc, phase X3).
     Replace the block above with:
     <a href="VIDEO_URL"><img src="THUMBNAIL_URL" alt="Nirvana-OS 90 秒速览" width="100%"></a>
-->

## 看它运行：一切都是一句话

**用描述来创建一家公司。** 系统设计组织、写出每一位员工、接好工作流，并对照 Business Protocol 验证结果。

```text
Use Nirvana-OS to create a company called podcast-empire that produces, publishes,
and monetizes 3 podcasts at once. Each show has its own niche, an AI host, an
editorial calendar, and an independent monetization funnel. Around 7 employees.
```

**用散文克隆一位专家。** 天才工厂从一个人的公开作品中提取 5 层 DNA（哲学、心智模型、启发法、框架、方法论），每一条都回溯引用到它的来源。

```text
Use Nirvana-OS to turn the public work of <author> into a complete AI mind-clone
through the genius factory.
```

**一句话，多个团队同时上。** 一份简报就能并行拉起一个研究 squad、一个文案 squad 和一家设计公司，在同一道质量门之后完成调和，审计轨迹展示指挥家做出的每一个选择。

```text
Use Nirvana-OS to produce a launch package: market research, landing-page copy,
and a competitive teardown.
```

更多流程，包括三个问题完成“设计机构、克隆专家、把它建起来”，都在[文档主页](https://gutomec.github.io/nirvana-os-engine/)，它在全部七个受支持的运行时中运行同一句话：Claude Code、Codex、Gemini、Antigravity、Grok、Kimi 和 Hermes。

## 为什么“工作已完成”在这里有分量

多 agent 系统有一个信任问题：编排器可以在最终消息里宣布任何事。Nirvana-OS 以三项保证作答，每一项背后都有一个你可以在磁盘上打开查看的机制。

- **可追溯。** 每个动作都成为 `~/.harness-logs/<date>/audit.jsonl` 中的一条只追加事件：收到简报、派遣、注入 mind-clone、质量门通过或失败。每一次 `--exec` 运行，无论是 `standard` 模式还是经由 Gauntlet，也都会在项目的 `.nirvana/run-kernel.sqlite` 中留下一条规范的 Run，这是一份 Glance 会读取的只追加日志。没有这些事件，任何完成消息都不诚实。
- **经过测试。** `verify-deliverable.ts` 把简报承诺的内容与磁盘上实际存在的内容进行比对。`quality-gate.ts` 在评判、批评、修订的循环中按文件类型运行评分标准。没有 verify 的 PASS，就没有合法的完成。
- **有契约。** Task 有二元的验收标准。Capability 有类型化的输入和输出。面向客户的输出要经过一条审批链：生产者，然后审阅者，然后批准者。预算是硬上限，升级触发器精确定义人类何时进入循环。

## 引擎免费，内容付费

这个仓库里的引擎是免费的，没有阉割的层级，也没有任何基础功能被锁起来。它从零开始创建并编排公司、squad 和 mind-clone。源码在 [Sustainable Use License](./LICENSE) 下公开发布、可公开阅读（source-available，非 OSI 批准；某些商业用途需要单独的许可）。

付费层是**内容，而非能力**：经过策划、随时可运行的合集，通过 [squads.sh](https://squads.sh) 交付。这些 pack 为你买到的差别是时间，而不是实力。在 **[squads.sh/pt/packs](https://squads.sh/pt/packs)** 浏览它们。旗舰产品 **[Genesis Circle](https://squads.sh/pt/nirvana-os)** 交付一个第一天就能运行的完整集团，并通过 `nrv update <pack>` 保持最新。

| | 免费引擎（本仓库） | Packs（[squads.sh/pt/packs](https://squads.sh/pt/packs)） |
|---|---|---|
| 从零创建 | 是 | 是 |
| 并行编排 | 是 | 是 |
| 每次派遣都有审计轨迹 | 是 | 是 |
| 预构建的 squad、公司、mind-clone | 无，按设计为空 | 第一天就有一个完整集团 |

## 少数几个值得你亲手敲的命令

| 你输入 | 它做什么 |
|---|---|
| `npx @nirvana-os/cli` | 安装或更新引擎（幂等） |
| `nrv glance` | Web 驾驶舱：公司、squad、clone、审计、成本。在已采用的项目中，聊天里的一条 Message 会在子进程中运行一次真正的派遣，带有实时时间线、取消以及重启后的恢复。`--read-only` 让它保持只读浏览 |
| `nrv list-businesses` / `nrv list-squads` / `nrv list-clones` | 浏览三个注册表 |
| `nrv search "<topic>"` | 在全部三个注册表中查找 capability |
| `nrv dispatch --business <slug> \| --squad <slug> \| --agent-x "<brief>" --exec` | 针对你指定的目标运行一份简报；从不咨询路由器 |
| `nrv run <business> "<brief>" --execution-mode=gauntlet --gauntlet-intensity=light\|balanced\|exhaustive` | 选择进入 Gauntlet：候选、评估和修订轮次，分三档强度（Business 目标需要 `NIRVANA_BUSINESS_GAUNTLET_ALLOWLIST`） |
| `nrv multi-target plan\|run\|status <plan.json>` | 在 Run Kernel 之上编译、执行或检视一份多目标计划（`NIRVANA_MULTI_TARGET_KILL_SWITCH=1` 关闭 `run`） |
| `nrv validate <squad\|business\|clone> <slug> [--fix]` | 单个实体的准入门；`--all` 检查已安装的全部，`--fix` 修好能修的部分，不凭空编造 |
| `nrv migrate <slug> --to 6 [--apply]` | 把一个 squad 转换到 Squad Protocol 6.0；默认只做 dry run，`--apply` 才写入并留下备份 |
| `nrv update <pack>` | 更新一个已安装的 pack |
| `nrv doctor` | 检查安装；在 Windows 上，`nrv install --repair-path` 会清理它警告过的用户 PATH 条目 |

其余一切都由你的 agent 来运行。完整参考：[docs/CLI.md](./docs/CLI.md)。

## 常见问题

**我需要会写代码吗？** 不需要。你用平实的语言描述结果；系统负责编写、验证并运行代码。

**它会取代我的 agent 吗？** 不会。它运行在 Claude Code、Codex、Gemini-CLI 或 Antigravity 之上，让你手头的那一个去编排许多个。

**我的工作存放在哪里？** 在你的机器上，位于 `~/businesses`、`~/squads` 和 `~/businesses/_library/dna` 之下。本地优先，没有任何第三方云参与其中。

**如果系统做不到我要求的事呢？** 它会直说。一份与任何东西都不匹配的简报会得到拒绝，外加一条创建缺失能力的建议。一份含糊的简报会得到一个反问，附上最佳候选。

**Windows？** 原生支持，通过 Bun。无需 WSL。

## 许可、作者与状态

作者：**Luiz Gustavo Vieira Rodrigues (gutomec / Prospecteezy)**。没有合著者。

许可：Nirvana-OS Sustainable Use License (SUL) v1.0。源码公开发布、可公开阅读，引擎可免费使用。它是 source-available，而非 OSI 批准的开源许可，某些商业用途需要单独的商业许可。在依赖任何摘要（包括这一段）之前，请先阅读 [LICENSE](./LICENSE)。

状态：beta（0.x，当前为 0.12.0）。引擎今天就能用，几分钟内即可安装。在 1.0 之前，预计接口表面会持续变动。
