# Nirvana-OS 引擎

[![version](https://img.shields.io/badge/version-0.1.60--beta-blue)](#license-authorship-and-status)
[![license](https://img.shields.io/badge/license-SUL-lightgrey)](./LICENSE)
[![npm](https://img.shields.io/badge/npm-%40nirvana--os%2Fcli-cb3837)](https://www.npmjs.com/package/@nirvana-os/cli)

**用你的语言阅读：** [English](./README.md) · [Português](./README.pt-BR.md) · [Español](./README.es.md) · [中文](./README.zh.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md)

---

## 用自然语言指挥一个公司的宇宙

你已经有了一个终端 agent。Claude Code、Codex、Gemini-CLI 或 Antigravity。它很锋利，而且它形单影只。

Nirvana-OS 把那个孤零零的 agent 变成一位指挥整个**公司**运转的乐团指挥。你用平实的散文描述你想要什么，系统就会组建起交付它所需的组织、专业团队和专家心智，其中许多同时开工，并为每一步开出一张凭据。

```bash
npx @nirvana-os/cli
```

一条命令。它会安装引擎、接入它找到的每一个 agent 运行时，并且可以随时安全地再次运行。没有别的东西需要配置。

而这一页会一节接一节不断印证的规则是：**你说话，你的 agent 执行命令。** 值得你亲手敲的那寥寥几条，恰好装得下一张简短的表格。

## 你不需要又一个聊天机器人。你需要一个真正干活的组织。

单个 agent 回答一条提示。真正的工作不是一条提示。它是一位研究员、一位写作者、一位审阅者和一位操作者朝不同方向发力，彼此协调，并留有书面记录。今天，你就是那层胶水：你一条接一条地手动运行提示，自己把碎片拼起来，却没有谁做了什么的记录。

Nirvana-OS 把你从胶水的位置上撤下来。你用散文陈述结果。引擎读懂它，查阅你已有的东西，派遣合适的公司与 squad 组合，让它们并行运行，在质量门后调和结果，并写下每一次派遣。你从操作者升级为总监：你陈述目标，检视结果。

## 这是为谁准备的

一个刻意划定的小而具体的受众：那些已经在运行终端 agent、并已察觉到瓶颈发生转移的开发者和操作者。如今，得到一个好答案很容易。而一整个组织级别的、协调一致的、附带谁做了什么之凭证的工作，仍然很难，这正是这个引擎要消除的问题。Nirvana-OS 不取代你的 agent。它提拔你的 agent。

## 一口气说清它是什么

Nirvana-OS 是一个 Bun 原生的多 agent 操作系统，用于创建、管理和运营一个集团：任意数量的公司和/或 squad，从任务简报一路编排到经过验证的交付物。它是**位于**你的终端 agent **之上**的编排层，而不是“一家造公司的公司”，它以三种材料工作，全部由自然语言塑形：

- **公司（businesses）：** 拥有员工组织架构的自治组织。每位员工都调用 squad。它们存放在 `~/businesses/`。
- **Squad：** 可移植的 agent 团队，运行真实的工作流（DAG、门、升级），并交付成品。它们存放在 `~/squads/`。
- **Mind-clone：** 分为 5 层的人格 DNA，注入员工体内，让他们以某位大师的方法思考和表达。它们存放在 `~/businesses/_library/dna/`。

一个请求可以同时调动其中许多个。编排器（`harness`）挑选阵容。你只需描述结果。

## 看它运转：一切都是一句话

这才是要紧的部分。你不写代码，不填表单，也不改配置。你在自己已经用惯的 AI 运行时里，通过点名来对系统讲话：**“use Nirvana-OS to…”**。它看起来是这样的。

### 1. 用描述来构建一家公司

用散文把层级和角色交给它。它会设计组织、写出每一位员工、接好工作流，并验证结果。

```text
Use Nirvana-OS to create a company called podcast-empire that produces, publishes,
and monetizes 3 podcasts at once. Each show has its own niche, an AI host, an
editorial calendar, and an independent monetization funnel. Around 7 employees.
```

系统会运行它的公司工厂：读取意图、领域调研、一份由你批准的组织蓝图，然后是员工、记忆和工作流，并对照 Business Protocol 完成验证。你最终会得到 `~/businesses/podcast-empire/`，配齐人手、随时可运行。

### 2. 或者让系统替你设计公司

还不知道正确的结构？那就问。这是最多人为之倾心的流程。

**第一步，请求设计方案：**

```text
Use Nirvana-OS: how would a complete, modern marketing agency be structured?
Give me the hierarchy, the key roles, and who the best specialists in the world
are for each seat.
```

系统会给你一张真实的组织架构图：一位创意总监、一位效果营销负责人、一位文案主管、一位内容负责人、一位策略师，以及每个席位应当效仿其方法的操盘手的名字。

**第二步，克隆这些专家：**

```text
Great. Clone those specialists into mind-clones I can hire.
```

它会运行 mind-clone 工厂，为每一位生成人格 DNA，也就是那一类操盘手的思维、启发式规则和口吻。

**第三步，用他们坐镇席位来构建公司：**

```text
Now build the agency, and put those clones in the matching roles as the
brains of each employee.
```

它会组装出这家公司，把每个 mind-clone 分派到对应的员工身上，并创建这家机构需要却尚未拥有的任何专业 squad。你用平实的英语问了三个问题，就得到了一家配齐人手的公司。

### 3. 用自然语言创建一个专业 squad

当一家公司需要某项现有团队都覆盖不了的能力时，就描述你想要的团队。

```text
Use Nirvana-OS to generate a squad for headless e-commerce automation, with
agents for catalog, checkout, inventory, and support. Validate it against the
Squad Protocol.
```

出来的便是 `~/squads/…/`，带有 agent、任务、工作流、schema、一份 harness 配置和一份 README，全部经过验证。

### 4. 用自然语言克隆一位专家

把任何人的公开作品集变成一位你的员工可以借用的顾问。

```text
Use Nirvana-OS to turn the public work of <author> into a complete AI mind-clone
through the genius factory.
```

工厂会提取一份 5 层 DNA（哲学、心智模型、启发式规则、框架、方法论），构建出人格，让它经过一个由其他心智组成的评审团，再交给你一位可以放进任何公司的顾问。

### 5. 一句话，多个团队同时开工

编排器乐于从单一简报中调动多家公司和多个 squad。

```text
Use Nirvana-OS to produce a launch package: market research, landing-page copy,
and a competitive teardown.
```

那一行字就能并行拉起一个研究 squad、一个文案 squad 和一家设计公司，每一个都由携带合适 mind-clone 的员工来承担，并在单一质量门后完成调和。你没有挑选其中任何一个。指挥挑了，而审计轨迹展示了它的选择。

> 整个界面就是散文加一张凭据。没有 API 调用，没有配置文件。描述结果，然后阅读那份证明发生了什么的审计轨迹。

这留下一个实际的问题。你要怎么把这些话说给*你的* agent 听？先安装吧；只要一分钟。

## 60 秒完成安装

在每个操作系统上都是同一个思路：安装一次 Bun，然后运行一条命令。

你需要什么：Bun 1.0 或更新版本能跑起一切。Node 18 或更新版本以及 `tar` 的存在只是为了让 `npx` 能用；大多数机器上早就有了。Python 3.10 或更新版本是可选的，仅在 `nrv export --pdf` 和 `--zip` 时才需要。

### macOS / Linux

```bash
curl -fsSL https://bun.sh/install | bash
exec $SHELL                # reload PATH, or just open a new terminal
npx @nirvana-os/cli        # installs the engine
```

### Windows（原生，无需 WSL）

整个系统运行在 Bun 之上，所以 Windows 只需要 Bun。在 **PowerShell** 中：

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
# open a NEW PowerShell window so PATH refreshes
npx @nirvana-os/cli
```

### 安装程序到底做了什么

它会在 `~/.nirvana/skills` 放下唯一一棵 skills 树，在找到 `~/.claude`、`~/.codex`、`~/.gemini` 和 `~/.antigravity` 的地方把它链接进去，并把 `nrv`、`nrv-gemini` 和 `nrv-hermes` 这几个二进制文件放进 `~/.local/bin`（Windows 上是 `%USERPROFILE%\.local\bin`），自动加入你的 PATH。它安装引擎，不安装任何内容。重复运行 `npx @nirvana-os/cli` 是幂等的，并且总会拉取最新的引擎。

要确认安装是否健康：

```bash
nrv doctor
```

然后打开你的 agent，说一句 **“use Nirvana-OS to…”**。下一节会精确展示这在每个运行时里是什么样子。

## 如何向你的 agent 提出请求，逐个运行时

没有一个叫 Nirvana-OS 的应用要打开。你对着自己已经在用的 agent 讲话，一句话就能唤醒系统：**“use Nirvana-OS to…”**。各种变体也管用：“via Nirvana”、“orchestrate through Nirvana”、“use my companies”、“use my squads”。这句话会触发 `harness` skill。那个 skill 就是指挥。

| 运行时 | 链接状态 | 你如何提出请求 |
|---|---|---|
| Claude Code | 始终已链接 | 在你的对话里用散文说。agent 会自己调用 harness。 |
| Codex | 存在则链接 | 一样：散文，进程内。 |
| Antigravity (`agy`) | 存在则链接 | 一样：散文，进程内。 |
| Hermes | 可选启用的桥接 | `hermes chat`，然后用散文说。或用 `hermes -z` 一次性完成。 |
| Gemini-CLI | 存在则链接 | 通过 `nrv dispatch` 走子进程（旧方式，正在退役）。 |

具体来说：

- **Claude Code、Codex、Antigravity（进程内）：** 你只写那句话，别的什么都不用。agent 会自己调用 `Skill("harness", "<your brief>")`，或者通过匹配 skill 的描述来激活它。你从不离开对话。
- **Hermes：** 运行 `hermes chat`，用散文提问。若要一次性完成，用 `hermes -z "use the nirvana-os skill: <brief>"`。桥接会替你调用 `nrv dispatch`。
- **Gemini-CLI（旧方式）：** 引擎通过 `nrv dispatch` 把它当作子进程来驱动。它能用，而且正在被淘汰。
- **任意项目目录：** 运行一次 `nrv init <dir>`。它会写入一份 `AGENTS.md` 契约，并附上字节完全相同的 `CLAUDE.md` 和 `GEMINI.md` 副本，这样任何打开该目录的 agent 都能自行发现 harness。

### 系统建议。你来决定。

你不需要背下自己装了什么。在默认的 agentic 模式下，指挥会基于三个注册表推理：公司、squad、mind-clone。干净匹配的会被派遣。含糊的简报会换来一个反问，附上最靠前的候选及其描述，让你带着上下文做选择。完全没有匹配的会换来一次拒绝，外加一条创建缺失能力的建议，绝不会有假装的尝试。

Mind-clone 的选择遵循固定顺序：先是被请求的，然后是被指派的，然后是搜索得到的，最后是默认的。而且每当系统挑中一个克隆，它也会把它略过的其他候选一并展示给你。

这引出了下一个显而易见的问题：到底基于*什么*来推理？自己去看看。

## 用 `nrv` 四处看看

这些发现命令都是只读的，随时都安全。

```bash
nrv glance            # read-only web cockpit: companies, squads, clones, audit, costs
nrv list-businesses   # organizations registered locally
nrv list-squads       # the agent teams
nrv list-clones       # persona DNA available to inject
nrv search "launch"   # find capabilities across all three registries
```

在全新安装上运行这些命令，你就会遇到对整套说辞的第一个诚实的质疑：一切返回都是空的。

好事。那是设计，不是缺陷。工厂装好了；货物没有。引擎出厂时带着创建与编排的全部能力，却零预置内容，所以那些注册表里的一切，都是你亲手构建或选择安装的。没有你没放进去的东西会自己冒出来。

那注册表里放的是什么？三类东西，也只有三类。

## 三大支柱

引擎创建和编排的一切都是三样东西之一。这就是完整的心智模型。

| 支柱 | 它是什么 | 存放在哪里 |
|---|---|---|
| **公司** | 自治组织，每一个都带有员工组织架构 | `~/businesses/` |
| **Squad** | 可移植的 agent 团队，运行工作流（DAG、门、升级） | `~/squads/` |
| **Mind-clone** | 注入员工体内、赋予其口吻和判断力的人格 DNA | `~/businesses/_library/dna/` |

一家公司编排员工。一位员工调用 squad。一个 squad 运行 agent。一个 mind-clone 让其中任何一个拥有更真实的声音。单一简报很少只需要其中一样。

它们是什么，说清了。而每一样是如何构成的，才是工程功力显露之处。

## 剖析：每根支柱是如何构成的

散文是界面，但底下没有一样东西是含糊的。每根支柱都是一个背后有协议的包，它的剖析值得你花两分钟。

### 一个 squad 是如何构成的（Squad Protocol v5）

一个 squad 是 `squad.yaml` 之下的可移植包，恰好由四类部件构成：

- **Agent：** 每个人格是一个 `.md` 文件，内含两个受众。YAML frontmatter 携带运行时配置，由机器读取；散文正文是系统提示，由模型读取。
- **任务（Tasks）：** 工作的单元。一个任务声明输入、步骤、输出，以及二元且可验证的验收标准：它要么通过，要么没通过。任务没有所有者。
- **工作流（Workflows）：** 把 agent 绑定到任务上、构成 DAG 的 YAML。处于同一层级的步骤组成一道并行波次。当某个运行时无法生成子 agent 时，工作流会优雅降级为顺序执行。
- **能力（Capabilities）：** v5 的发现层。每个能力都有一个带点号的层级式 id（`domain.subdomain.verb`）、一段描述、若干领域、带类型的输入和输出、示例、一份 `not_for` 列表，以及一个指向某个工作流、任务或 agent 的 `invoke` 契约。

把这一切维系在一起的规则是：能力是这个 squad 所承诺的东西，原子的、从外部看到的；工作流是怎么做；任务是里面的一个单元。

### 一家公司是如何构成的（Business Protocol v1）

一家公司是 `business.yaml` 之下的一个包，它是组织一致性的单元。内部有：

- **员工（Employees）：** 持久的专业 agent。每个都是一个 `.md` 文件，其 frontmatter 声明 `role`、`reports_to`、一个 `type`（`functional_specialist` 或 `mind_clone`），以及一份 `self_score_contract`；正文是系统提示。
- **一张组织架构图：** 真实的层级，不是装饰。与之并列的还有：路由与流程。
- **记忆：** 面向整个组织的永久记忆，外加每个项目各自隔离的记忆。
- **治理：** 预算、升级触发器、审批链，以及一份 `culture.md`。

一位员工不会亲手打造一切。在自己产出任何原子交付物之前，它会先问“有没有一个 squad 能干这个？”，调用一个或多个 squad（受一份 `squads_authorized` 白名单管辖；为空则表示全部允许），再把结果整合回来。工作在员工之间通过五种交接原语流转：提及（`@name`）、工单、升级（向上）、委派（向下）以及自动路由。

有一条结构性规则是带牙齿的：员工超过 5 人的公司需要一个对抗者，一个职责就是唱反调的席位。

### 一个 mind-clone 是如何构成的（5 层 DNA）

一个 mind-clone 是一位真实专家被提炼出来的方法，从其公开作品集中提取为 5 层：

1. **L1 哲学：** 信念与公理。
2. **L2 心智模型：** 这位专家如何构建问题。
3. **L3 启发式规则：** 快速的战术规则。
4. **L4 框架：** 有名字的系统。
5. **L5 方法论：** 一步步的流程。

每一条目都带有一个 `^[FONTE:file:section:excerpt]` 引用，回指到源材料，而每一次构建都会报告它的来源覆盖率（例如 94%）。这个包是具体的：`MANIFEST.yaml`，外加 `agent/AGENT.md`（第一人称的认知模拟）、`agent/SOUL.md`（价值观、恐惧、矛盾、影响）、`agent/DNA-CONFIG.yaml` 以及 `dna/dna-schema.md`（连同其来源的 5 层）。

在运行时，这份 DNA 会被整段注入一位员工的提示中，并附带一条恒定指令：这个克隆已被完全化入，所以要像这个克隆亲手产出这份作品那样交付。注入从不是无声的。它会发出一个 `mind_clone_injected` 审计事件，为每一个被注入的文件记录字节数和 sha256，这样你就能证明当时房间里是哪一个心智。目录里存有 503 个克隆，包括 David Ogilvy、Alex Hormozi、Seth Godin 和 Dan Kennedy。

## 你可以创造更多：元工具

引擎出厂自带三座工厂，而且它们彼此调用。这就是为什么你用一句话要来的公司，最终会是完整的。

- **Business Creator** 把一份散文简报变成一个完整的组织：员工、记忆、工作流，端到端地经过验证。当它需要某项没有 squad 覆盖的能力时，它会委派给 Squad Creator。
- **Squad Creator** 把一份散文简报变成一个经过验证的 squad：agent、任务、工作流、schema、harness 配置、README。
- **Genius Factory** 把一个人的公开作品变成一个 5 层的 mind-clone，然后交给你一位随时可雇的顾问。

元工具调用元工具，正是“设计这家机构、克隆那些专家、把它建起来”能作为三句平实的话生效的原因。

## 它是如何运作的

给 harness 一份简报，它会按顺序做五件事：

1. 读取简报。
2. 查阅三个注册表：公司、squad、mind-clone。
3. 派遣最佳组合，这可以是许多家公司和/或许多个 squad 并行。
4. 在质量门后调和结果。
5. 把审计轨迹写入 `~/.harness-logs/<date>/audit.jsonl`。

```
                       brief
                         │
                         ▼
                ┌───────────────────┐
                │ harness (maestro) │
                │ read · route ·    │
                │ dispatch          │
                └───────────────────┘
                         │
        consults the three registries
       (companies · squads · mind-clones)
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                 ▼
 ┌────────────┐   ┌────────────┐    ┌──────────────┐
 │  company A │   │  squad X   │    │  mind-clones │
 │ employees  │   │  workflow  │◀───│  injected as │
 │  → squads  │   │  DAG·gates │    │  persona DNA │
 └────────────┘   └────────────┘    └──────────────┘
        │                │
        └───── parallel dispatch ──────┘
                         │
                         ▼
                ┌───────────────────┐
                │   quality gate    │
                │ reconcile output  │
                └───────────────────┘
                         │
            ┌────────────┴────────────┐
            ▼                         ▼
       final result        ~/.harness-logs/<date>/audit.jsonl
                            (every dispatch, on the record)
```

并行是那把楔子：一份简报能在同一次运行中让多个团队开工，并在最后把它们的产出重聚起来。审计轨迹是那份信任：打开日志，就能追溯哪些 agent 运行了、跑的是哪份简报、以何种顺序、为了什么。agentic 工作不再是一个黑箱。

一张图是一个主张。三重保证在为它撑腰。

## 三重印记：可追溯、可验证、有契约

多 agent 系统有一个信任问题。一个编排器在它的最终消息里可以宣布任何东西。Nirvana-OS 用三重保证来回应，每一重背后都有一个你能在磁盘上打开来看的机制。

**可追溯。** 每一个动作都会成为 `audit.jsonl` 中一个只可追加的事件：`brief_received`、`dispatch_business`、`dispatch_squad`、`mind_clone_injected`、`gate_passed` 或 `gate_failed`、`verify_passed` 或 `verify_failed`。日志存放在 `~/.harness-logs/<date>/audit.jsonl`，并在 `nrv glance` 里可见。规则很直白：没有这些事件，任何完成消息都不诚实。界面就是散文加一张凭据。

**可验证。** 有两个程序横亘在一个主张与一份交付物之间。`verify-deliverable.ts` 比对磁盘上的事实：简报承诺了什么，对照磁盘上实际存在什么，把任何缺失或只是占位的东西标出来。`quality-gate.ts` 按文件类型运行评分标准，走一个评判、批评、修订的循环。没有一次 verify PASS，就没有正当的 `gate_passed`。Squad 还带有一份对照基准真值的保真度契约，而员工在每一次交接前都会自评。

**有契约。** 没有任何东西靠感觉就动起来。任务有二元验收标准。能力有带类型的输入和输出；id 就是契约，而实现始终隐藏。交接是至多 800 个 token 的结构化产物。绑定客户的产出要经过一条审批链：先是生产者，然后是审阅者，然后是批准者。预算是一道硬性上限，而升级触发器精确定义了人类必须何时介入循环。

可追溯告诉你发生了什么。可验证告诉你它是真的。有契约告诉你它是被允许的。三者合起来，正是“工作完成了”在这里有分量的原因。

## 开放内核：引擎免费，且永远免费

这个仓库里的引擎是免费的，没有阉割的层级，也没有把基础功能锁起来。它从零创建并编排公司、squad 和 mind-clone。如果你想从头搭建自己的集团，引擎就是你所需的一切，你什么也不欠。

这是刻意为之。引擎就是全部的能力，而把全部能力送出去正是建立信任的方式：在花任何钱之前，你都能验证这一页上的一切。

免费邀来一个公平的问题：它是开源的吗？这里要说准确。源代码已发布、可公开阅读，但许可证是源代码可得（source-available），并非 OSI 认可的开源，且某些商业用途需要一份单独的商业许可证。[许可证一节](#许可证作者与状态) 会把它讲清楚。

付费的那一层是**内容，不是能力**：经过策展、开箱即用的 squad、公司和 mind-clone 集合，通过 [squads.sh](https://squads.sh) 交付。

| | 免费引擎（本仓库） | 付费包（squads.sh） |
|---|---|---|
| 从零创建 | 是 | 是 |
| 并行编排 | 是 | 是 |
| 每次派遣都有审计轨迹 | 是 | 是 |
| 多运行时安装 | 是 | 是 |
| 预置的 squad、公司、mind-clone | 无，按设计为空 | 一个完整的集团，随时可运行 |
| 到一个可用集团所需的时间 | 你自己搭 | 第一天 |

这些包为你买来的差别是**时间，不是能力**。旗舰款 **Genesis Circle** 一次安装就落地 39 个生产级 squad、11 家公司和 159 个 mind-clone。包安装在引擎之上，并通过 `nrv update <pack>` 保持最新。[在 squads.sh 上查看这些包](https://squads.sh)。

## `nrv` 命令：大多数由你的 agent 执行

CLI 之所以存在，是为了让系统自己的 skill 和钩子能驱动引擎，也为了让你的 agent 能代你行事。在日常使用中，你说话，你的 agent 打字。真正需要人来的那寥寥几条：

| 你敲什么 | 它做什么 |
|---|---|
| `npx @nirvana-os/cli` | 安装或更新引擎（幂等） |
| `nrv glance` | 只读的 web 驾驶舱：公司、squad、克隆、审计、成本 |
| `nrv init <dir>` | 把 `AGENTS.md` 契约写入一个项目目录 |
| `nrv list-businesses` / `nrv list-squads` / `nrv list-clones` | 浏览三个注册表（只读） |
| `nrv search "<topic>"` | 跨全部三个注册表搜索能力 |
| `nrv update <pack>` | 更新一个已安装的包 |
| `nrv doctor` | 检查安装 |

其余的一切要么由 agent 执行，要么是进阶用法。`Skill("harness", …)` 是你的 agent 使用的进程内入口。`nrv dispatch`、`nrv run` 和 `nrv auto` 从 shell 驱动编排。`nrv ask <clone>` 在注入了 DNA 的情况下与单个 mind-clone 对话；`nrv revise` 在同一个运行时会话中对项目施加一处改动；`nrv audit-view` 走一遍某个项目的审计链；`nrv export` 打包一个项目的产出（仅 `--pdf` 和 `--zip` 需要 Python 3.10+）。

有两条命令值得一份降级通告。`nrv route` 和 `nrv find` 是有损的 BM25 诊断工具：拿来快速嗅一嗅关键词还行，绝不能当真理来源。agentic 指挥才是真理来源。

完整参考：[docs/CLI.md](./docs/CLI.md)。

## 常见问题

**我需要会写代码吗？** 不需要。你用平实的语言描述结果。系统来写代码、验证代码、运行代码。

**我必须学会这个 CLI 吗？** 不必。你的 agent 会替你运行大多数 `nrv` 命令。需要人来的那寥寥几条是安装、`nrv glance`、`nrv init`、`list-*` 三件套、`nrv search`、`nrv update` 和 `nrv doctor`。

**如果系统做不到我要求的事怎么办？** 它会直说。当一份简报在你的注册表里什么都匹配不上时，指挥会拒绝，并建议创建那项缺失的能力。当它含糊时，它会发问，附上最靠前的候选及其描述。

**它会取代我的 agent 吗？** 不会。它运行在 Claude Code、Codex、Gemini-CLI 或 Antigravity 之上，让你已有的那一个去编排许多个。

**我的工作存放在哪里？** 在你自己的机器上，位于 `~/businesses`、`~/squads` 和 `~/businesses/_library/dna` 之下。本地优先，回路中没有任何第三方云。

**引擎真的免费吗？** 是的。付费包是预置内容，为你省下时间。引擎从零构建出同样的东西，分文不取。

**Windows？** 原生支持，通过 Bun。无需 WSL。

## 许可证、作者与状态

作者：**Luiz Gustavo Vieira Rodrigues（gutomec / Prospecteezy）**。无共同作者。

许可证：Nirvana-OS 可持续使用许可证（SUL）v1.0。用平实的措辞说清，因为信任正是在这里赢得或失去的：源代码已发布、可公开阅读，引擎可免费使用。它是**源代码可得，而非 OSI 认可的开源许可证**，且某些商业用途需要一份单独的商业许可证。如果这一区别对你的情形要紧，在依赖任何摘要（包括这一条）之前，请先读 [LICENSE](./LICENSE)。

状态：beta（0.x，当前为 0.1.59）。引擎今天就能用，几分钟内即可安装。在到达 1.0 之前，接口预计还会持续变动。
