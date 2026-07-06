# Nirvana-OS engine

[![version](https://img.shields.io/badge/version-0.1.24--beta-blue)](#license-authorship-and-status)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)
[![npm](https://img.shields.io/badge/npm-%40nirvana--os%2Fcli-cb3837)](https://www.npmjs.com/package/@nirvana-os/cli)

**用你的语言阅读：** [English](./README.md) · [Português](./README.pt-BR.md) · [Español](./README.es.md) · [中文](./README.zh.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md)

---

## 用大白话指挥一整个公司宇宙

你已经有了一个终端智能体。可能是 Claude Code、Codex、Gemini-CLI 或 Antigravity。它很犀利，但它是孤军奋战。

Nirvana-OS 把那个单打独斗的智能体变成一位指挥家，让它去运营**一整家又一整家公司**。你用平实的语言描述想要什么，系统就会搭建起组织、专家团队和专业头脑去交付，往往是多者同时开工，并为每一步留下凭证。

```bash
npx @nirvana-os/cli
```

一条命令。它安装引擎，连入它找到的每一个智能体运行时，并且随时可以再跑一遍也很安全。其余什么都不用配。

## 你需要的不是又一个聊天机器人，而是一个真正干活的组织

单个智能体回应一条提示。真正的工作不是一条提示能搞定的。它需要一位研究员、一位写手、一位审校和一位执行者朝着不同方向发力，被协调起来，并留下完整记录。今天你就是那块黏合剂：你一条接一条地手动跑提示，再亲手把碎片拼起来，谁做了什么却毫无记录。

Nirvana-OS 把你从黏合剂的位置上解放出来。你用散文写下想要的结果。引擎读懂它，盘点你手头已有的资源，调度公司与 squads 的最佳组合，并行运行它们，在质量门后整合结果，并把每一次调度都记下来。你从操作员升格为总监：你陈述目标，检视结果。

## 一句话说清它是什么

Nirvana-OS 是位于终端智能体**之上**的编排层。它创建并运行三类东西，而且全部都从自然语言出发：

- **公司（businesses）** — 拥有员工组织架构的自治组织。每位员工都会调用 squads。
- **Squads** — 可移植的智能体团队，运行真实的工作流（DAG、质量门、升级机制），交付成品。
- **Mind-clones** — 注入到员工体内的人格 DNA（5 层），让他们以某位大师的方法去思考和表达。

一个请求就能同时动员其中许多个。编排器（即 `harness`）负责挑选阵容。你只需描述结果。

## 看它怎么运转：一切皆为一句话

这才是关键所在。你不写代码、不填表单、不改配置。你在自己本就在用的 AI 运行时里，通过点名的方式和系统对话：**“用 Nirvana-OS 来……”**。看起来就是下面这样。

### 1. 用描述搭建一家公司

把层级和角色用散文交给它。它会设计组织、写出每一位员工、接好工作流，并验证结果。

```text
用 Nirvana-OS 创建一家名为 podcast-empire 的公司，同时制作、发布并变现 3 档播客。
每档节目有自己的细分领域、一位 AI 主持人、一份内容日历，以及一条独立的变现漏斗。
大约 7 位员工。
```

系统会跑它的商业工厂：读取意图、研究领域、给出一份待你批准的组织蓝图，然后生成员工、记忆和工作流，并对照 Business Protocol 进行验证。最终你会得到 `~/businesses/podcast-empire/`，配齐人手、随时可跑。

### 2. 或者让系统替你设计这家公司

还不知道该用什么结构？那就问。这正是大多数人会爱上的流程。

**第一步，先要一份设计：**

```text
用 Nirvana-OS：一家完整、现代的营销代理公司该如何搭建？
给我层级架构、关键角色，以及每个席位上全世界最顶尖的专家分别是谁。
```

系统会给出一份真实的组织架构图：一位创意总监、一位效果营销负责人、一位文案主管、一位内容负责人、一位策略师，以及每个席位应当效法其方法的那些操盘手的名字。

**第二步，克隆这些专家：**

```text
很好。把这些专家克隆成我可以雇用的 mind-clones。
```

它会跑 mind-clone 工厂，为每一位生成人格 DNA，也就是那一类操盘手的思维、启发法和声音。

**第三步，让他们各就各位地建起公司：**

```text
现在把这家代理公司建起来，把那些克隆体放进相应的角色，
作为每位员工的大脑。
```

它会组装好这家公司，把每个 mind-clone 指派给对的员工，并创建出这家代理公司需要却还没有的任何专家 squad。你用平实的英文问了三个问题，得到了一家配齐人手的公司。

### 3. 用散文创建一个专家 squad

当一家公司需要某项现有团队都覆盖不到的能力时，描述你想要的那支团队。

```text
用 Nirvana-OS 生成一个用于 headless 电商自动化的 squad，
配上负责商品目录、结账、库存和客服的智能体。对照 Squad Protocol 验证它。
```

出来的就是 `~/squads/…/`，含智能体、任务、工作流、schemas、一份 harness 配置和一份 README，全部经过验证。

### 4. 用散文克隆一位专家

把任何人公开的全部作品，变成你的员工可以使用的顾问。

```text
用 Nirvana-OS，通过 genius factory 把 <author> 的公开作品
变成一个完整的 AI mind-clone。
```

工厂会提取一份 5 层 DNA（哲学、心智模型、启发法、框架、方法论），构建人格，让它通过一个由其他头脑组成的专家组评审，然后交给你一位可以放进任何公司的顾问。

### 5. 一句话，多支团队同时上阵

编排器乐于从单一简报中动员多家公司和多个 squads。

```text
用 Nirvana-OS 做一份发布套件：市场调研、落地页文案，
以及一份竞品拆解。
```

这一行就能并行拉动一个研究 squad、一个文案 squad 和一家设计公司，每一个都由携带恰当 mind-clones 的员工配齐人手，并在同一道质量门后整合。你也可以从 CLI 强制指定一条通道：`nrv use-businesses "…"` 或 `nrv use-squads "…"`。

> 整个界面就是散文加一张凭证。没有 API 调用，没有配置文件。只管描述结果，再读那条证明发生了什么的审计轨迹。

## 60 秒完成安装

每个操作系统的思路都一样：先装一次 Bun，然后跑一条命令。你还需要 Node.js 来运行 `npx`（大多数机器上已经有了；若没有，见 [nodejs.org](https://nodejs.org)）。

### macOS / Linux

```bash
curl -fsSL https://bun.sh/install | bash
exec $SHELL                # 重新加载 PATH，或者直接打开一个新终端
npx @nirvana-os/cli        # 安装引擎
```

### Windows（原生，无需 WSL）

整个系统跑在 Bun 上，所以 Windows 只需要 Bun。在 **PowerShell** 里：

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
# 打开一个新的 PowerShell 窗口，让 PATH 刷新
npx @nirvana-os/cli
```

安装器会把 `nrv` 命令放进 `~/.local/bin`（Windows 上是 `%USERPROFILE%\.local\bin`），并自动加入你的 PATH。打开一个新终端并确认：

```bash
nrv --help
```

重复运行 `npx @nirvana-os/cli` 是幂等的，而且总会拉取最新的引擎。

## 用 `nrv` 四处看看

这些发现类命令都是只读的，随时跑都安全。

```bash
nrv glance            # 一屏看全你拥有的东西
nrv list-businesses   # 本地注册的组织
nrv list-squads       # 智能体团队
nrv list-clones       # 可注入的人格 DNA
nrv search "launch"   # 跨三个注册表查找能力
```

全新的引擎在这里返回的是空的，而这正是重点。工厂装好了，货物还没进来。

## 三大支柱

引擎创建和编排的一切，都是这三样东西之一。这就是全部的心智模型。

| 支柱 | 它是什么 | 它住在哪里 |
|---|---|---|
| **公司** | 自治组织，每家都有一张员工组织架构图 | `~/businesses/` |
| **Squads** | 可移植的智能体团队，运行工作流（DAG、质量门、升级机制） | `~/squads/` |
| **Mind-clones** | 注入员工体内、赋予其声音与判断的人格 DNA | `~/businesses/_library/dna/` |

公司编排员工。员工调用 squads。squad 运行智能体。mind-clone 让其中任何一方拥有更真实的声音。单一简报很少只需要其中一样。

## 一切都可以造更多：元工具

引擎自带三座工厂，而且它们彼此互相调用。这就是为什么你用一句话要来的公司，最终会是完整的。

- **Business Creator** 把一份散文简报变成一个完整的组织：员工、记忆、工作流，端到端验证。当它需要某项没有 squad 覆盖的能力时，就委派给 Squad Creator。
- **Squad Creator** 把一份散文简报变成一个经过验证的 squad：智能体、任务、工作流、schemas、harness 配置、README。
- **Genius Factory** 通过一条 5 阶段流水线，把一个人的公开作品变成一个 mind-clone，然后把一位随时可雇的顾问交到你手上。

元工具调用元工具，正是“设计这家代理公司、克隆那些专家、把它建起来”能作为三句平实的句子奏效的原因。

## 它是怎么运作的

把一份简报交给 harness，它会按顺序做五件事：

1. 读取简报。
2. 盘点三个注册表：公司、squads、mind-clones。
3. 调度最佳组合，可以是许多家公司和/或 squads 并行。
4. 在质量门后整合结果。
5. 把审计轨迹写入 `~/.harness-logs/<date>/audit.jsonl`。

```
                       brief
                         │
                         ▼
                ┌───────────────────┐
                │  harness（指挥家） │
                │ 读取 · 路由 ·     │
                │ 调度              │
                └───────────────────┘
                         │
                 盘点三个注册表
        （公司 · squads · mind-clones）
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                 ▼
 ┌────────────┐   ┌────────────┐    ┌──────────────┐
 │  公司 A    │   │  squad X   │    │  mind-clones │
 │  员工      │   │  工作流    │◀───│  注入为      │
 │ → squads   │   │ DAG·质量门 │    │  人格 DNA    │
 └────────────┘   └────────────┘    └──────────────┘
        │                │
        └───── 并行调度 ──────┘
                         │
                         ▼
                ┌───────────────────┐
                │     质量门        │
                │   整合输出        │
                └───────────────────┘
                         │
            ┌────────────┴────────────┐
            ▼                         ▼
        最终结果           ~/.harness-logs/<date>/audit.jsonl
                           （每一次调度，皆有记录）
```

并行就是那个突破口：一份简报能在同一次运行里让数支团队同时开工，并在最后把它们的产出重新汇拢。审计轨迹就是那份信任：打开日志，便能追溯哪些智能体跑过、针对哪份简报、以什么顺序、为了什么。智能体的工作不再是黑箱。

## 一次安装，覆盖每个运行时

`~/.nirvana/skills` 里只有一棵 skills 树，它被链接进安装器检测到的每一个运行时。Nirvana-OS 不要求你更换智能体。它升级你手上已有的那个。

| 运行时 | 状态 |
|---|---|
| Claude Code | 始终链接 |
| Codex | 检测到则链接 |
| Gemini-CLI | 检测到则链接 |
| Antigravity (`agy`) | 检测到则链接 |
| Hermes | 可选接入的桥接 |

## 开放内核：引擎免费，而且一直免费

本仓库里的引擎是免费的，没有阉割版本，也没有把基础功能锁起来。它从零开始创建并编排公司、squads 和 mind-clones。如果你想白手起家建起自己的集团，引擎就是你所需要的全部，你一分钱都不欠。

付费层是**内容，而非能力**：经过精挑细选、开箱即用的 squads、公司和 mind-clones 合集，通过 [squads.sh](https://squads.sh) 交付。

| | 免费引擎（本仓库） | 付费包（squads.sh） |
|---|---|---|
| 从零创建 | 是 | 是 |
| 并行编排 | 是 | 是 |
| 每次调度都有审计轨迹 | 是 | 是 |
| 多运行时安装 | 是 | 是 |
| 预制的 squads、公司、mind-clones | 无，设计上就是空的 | 一整个集团，开箱即跑 |
| 跑通一个可用集团所需的时间 | 你自己搭 | 第一天 |

付费包买给你的差别是**时间，而非能力**。旗舰包 **Genesis Circle** 一次安装就落地 39 个生产级 squads、11 家公司和 159 个 mind-clones。包是覆盖在引擎之上的：买下它，运行 `bun setup.ts`，再用 `nrv update <slug>` 保持更新。[在 squads.sh 上看这些包](https://squads.sh)。

## `nrv` 命令

| 命令 | 它做什么 |
|---|---|
| `nrv route "<brief>"` | 把一份散文简报交给指挥家 |
| `nrv use-businesses "<brief>"` | 路由一份简报，公司优先 |
| `nrv use-squads "<brief>"` | 路由一份简报，squad 优先 |
| `nrv glance` | 一屏看全你的配置 |
| `nrv list-businesses` / `list-squads` / `list-clones` | 浏览注册表（只读） |
| `nrv search "<topic>"` | 跨三个注册表搜索能力 |
| `nrv init <path>` | 初始化一个新项目 |
| `nrv update <slug>` | 更新已安装的包 |
| `nrv --help` | 完整命令参考 |

完整参考：[docs/CLI.md](./docs/CLI.md)。

## 常见问题

**我需要会写代码吗？** 不需要。你用平实的语言描述结果。系统来写、验证并运行代码。

**它会取代我的智能体吗？** 不会。它运行在 Claude Code、Codex、Gemini-CLI 或 Antigravity 之上，让你手上那个去编排许多个。

**我的工作成果存在哪里？** 在你自己的机器上，位于 `~/businesses`、`~/squads` 和 `~/businesses/_library/dna` 之下。本地优先，回路里没有任何第三方云。

**引擎真的免费吗？** 是的。付费包是预制内容，帮你省时间。引擎能从零免费造出同样的东西。

**Windows 呢？** 原生支持，通过 Bun。无需 WSL。

## 许可、署名与状态

作者：**Luiz Gustavo Vieira Rodrigues (Prospecteezy)**。无共同作者。

许可：Nirvana-OS Sustainable Use License（SUL）。源码以开放、源可见的方式发布。它不是 OSI 认可的开源许可，某些商业用途需要单独的商业许可。在依赖任何摘要之前，请阅读 [LICENSE](./LICENSE) 中的完整条款。

状态：beta（0.x）。引擎今天就能用，几分钟内即可安装完成。在抵达 1.0 之前，预计接口仍会持续变动。
