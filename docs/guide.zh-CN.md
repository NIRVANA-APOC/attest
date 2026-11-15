# Attest 使用指南

[← 返回总览](../README.md) · [English](guide.md) · [Jev 审计](jev-audit.zh-CN.md)

[安装](#安装与第一次运行) · [案件](#案件) · [计划格式](#计划格式) · [命令](#命令参考) · [面板](#面板) · [适配器](#agent-适配器) · [文件位置](#文件放在哪) · [限制](#已知限制) · [开发](#开发与检查)

Attest 把"一个人 + 一段需求描述"变成一个经过计划、构建、审查与审计的案件。
编排者 agent 和你一起写计划；随后每个角色都是真实的 Claude Code 或 Codex 会话，
在自己的 tmux 窗口、git worktree 与分支里工作；编排者旁边的面板显示进度，并在
关卡处停下等你。本文覆盖已实现的 0.1.0：计划格式、全部命令与选项、面板、适配器、
文件位置，以及这个工具不做什么。

## 安装与第一次运行

需要：**macOS、Linux 或 WSL2**、**tmux**、**Node.js 20+**、**git**，以及已安装
并登录的 **Claude Code 和/或 Codex**。角色就是交互式终端；Attest 不包装也不替换
这些 agent。

```sh
git clone <repo> && cd Attest
npm ci && npm run build && npm link   # 0.1.0 尚未发布到 npm，从源码构建
attest setup
```

`attest setup` 会为检测到的 harness 安装 `attest-case` 工作流技能
（`~/.claude/skills/attest-case` 和/或 `~/.agents/skills/attest-case`）。它拒绝
覆盖或删除不是自己安装的目录（安装时会打标记），所以已有的技能目录不会被碰。
`attest setup --remove` 只移除带标记的安装。

在**要修改的仓库里、tmux 中**打开 Claude Code 或 Codex，以"案件"的方式提出工作。
技能描述会匹配"attest case""把这件事作为 attest 案件来做""拆成几个角色并行"
"开几个 agent 并行做"之类的说法。agent 会写计划并打开面板。

也可以直接从终端开始：

```sh
attest up -m <case> --orch claude     # 创建案件、启动编排者与面板
```

`attest up` 需要 tmux，且所选 harness 在 `PATH` 上；如果该 harness 缺少技能会先
安装，然后创建案件 worktree、在其中打开编排者，并在旁边打开面板。若你当前不在
tmux 里，它会附加到新会话。用 `--orch codex` 可以启动 Codex 编排者。

## 案件

**案件（case）** 是一个被编排的工作单元。它有自己的分支 `case/<case>` 和
worktree（位于仓库的 `.attest/` 下），所以你原来的 checkout 仍停在自己的分支上。
同一个仓库、甚至跨仓库都可以同时跑多个案件。

```sh
attest case new auth-refresh            # worktree + 计划模板，并绑定当前 pane
attest check -m auth-refresh            # 校验计划与适配器
attest gate plan "批准这个拆分吗？"       # 在面板里向人提问
attest approve -m auth-refresh          # 或在面板里按 `a`
attest stage build
attest dispatch api
```

计划模板写到案件 worktree 的 `docs/cases/<case>/plan.md`，其中 `base:` 已经设为
案件分支：每个角色的 worktree 在派发时从它切出，所以角色能看到此前已合入的内容。
编排者最终合并到案件分支；该分支会被推送用于 MR，清理时也会保留。案件的运行日志
与审计账本放在 git common dir 旁边，不进 git（见[文件放在哪](#文件放在哪)）。

案件在"有 `case/<name>` 分支的 worktree 或运行日志，且没有 `teardown` 事件"期间
算**打开**。显式 `-m` 也能访问已完成的案件（例如重复一次安全的清理，会报告没有
剩余内容）。

## 计划格式

`plan.md` 是一个围栏 YAML 块外面的 Markdown。Markdown 部分是人在计划关卡读的；
YAML 部分是 Attest 强制执行的内容。

### Markdown 部分

| 章节 | 用途 |
| --- | --- |
| `# <case>: <title>` | 案件标题（面板与报告会使用） |
| `## Intent` | 人想要什么、为什么；附 issue 链接 |
| `## Done when` | 可逐条核对的一行完成标准；审查者会报告哪些已通过 |
| `## Out of scope` | 这个案件刻意不做的事 |
| `## Decisions for you` | 带 `**Recommended: <option>**` 的编号问题；批准即采纳推荐项 |
| `## How the work is split` | 拆分的理由（散文，不解析） |
| `## Role: <name>` | 当角色没有 `text:` 引用时，它的指令正文 |

计划关卡会显示目标、原因、完成标准、角色、决策与"不做的事"；PLAN 页渲染整份
计划。若 `## Role:` 章节的名字在 YAML 里不存在，会被记为计划问题。

### YAML 块

```yaml
attest: 1
goal: "刷新令牌每次使用都轮换，被重复使用的一律拒绝"
why: "今天被盗的刷新令牌还有 30 天有效期（issue #212）"
workflow: attest-case
base: case/auth-refresh
profiles:
  claude-build:
    agent: claude
    model: opus
    effort: high
    flags: [--permission-mode, acceptEdits]
    text: workflow:builder
  codex-build:
    agent: codex
    model: gpt-6.1-sol
    effort: high
    flags: [-a, on-request, -s, workspace-write]
    text: workflow:builder
audit:
  mode: shadow
  provider: heuristic
  questions: [plan.risk, plan.clarity, role.boundary, result.fidelity, merge.risk, teardown.safety]
roles:
  api:
    use: codex-build
    goal: "刷新时轮换令牌；拒绝被重复使用的那一个"
    touches: [src/api/]
  web:
    use: claude-build
    model: sonnet
    goal: "刷新被拒绝时让用户登出"
    touches: [web/src/]
    depends_on: [api]
  review:
    use: claude-build
    goal: "分支随到随审"
    touches: []
    reviews: [api, web]
    text: workflow:reviewer
```

| 键 | 含义 |
| --- | --- |
| `attest` | 格式版本；出现时必须为 `1` |
| `goal` | 一句话概述案件（显示在面板右上角） |
| `why` | 一行说明为什么现在做 |
| `workflow` | 工作流技能名（默认 `attest-case`），决定 `stages.yaml` 与 `workflow:` 角色文本 |
| `base` | 派发时切出角色、编排者最终合入的分支。`case new` 会写入 `case/<case>` |
| `profiles` | 具名角色设置组合；角色自己的字段优先；profile 不能再 `use` 别的 profile |
| `audit` | 可选的 Jev 审计配置（见下） |
| `roles` | 每个角色一项：一个窗口、一个 worktree、一个分支 |

角色字段：

| 键 | 含义 |
| --- | --- |
| `use` | 从哪个 profile 继承设置 |
| `agent` | `claude`、`codex`，或 `.attest/agents/` 下的适配器名 |
| `model` | 原样传给 agent（Claude Code：`--model`；Codex：`-m`） |
| `effort` | 原样传递（Claude Code：`--effort`；Codex：`-c model_reasoning_effort=…`） |
| `flags` | agent 自己的参数。必须**固定其权限**，权限绝不继承 |
| `goal` | 一行说明这个角色交付什么 |
| `touches` | 这个角色可以改的文件或目录；结尾 `/` 表示整个目录。`[]` 表示不改文件 |
| `depends_on` | 必须 `done` 之后才允许派发的前置角色 |
| `reviews` | 这个角色审查谁的分支（供审查者角色与流程图使用） |
| `text` | `workflow:<name>`（技能里的 `roles/<name>.md`）或仓库路径，追加到角色 brief；没有 `text` 时使用 `## Role:` 章节正文 |
| `skills` | 给角色 brief 的额外技能名（由工作流定义） |
| `group` | 角色所属的阶段分组；默认 `build`，若既不改文件又审查别人则为 `review`；`group: audit` 让角色归入审计阶段 |

`attest check` 会逐条拒绝：

- 未知 agent，或 `flags` 没有覆盖适配器的某个权限组（Claude Code：
  `--permission-mode`；Codex：`-a` 与 `-s`）；
- 既没有 `text` 也没有 `## Role:` 章节的角色；
- 未知的 `depends_on`、`reviews` 或 profile；
- 依赖成环；
- 两个角色的 `touches` 可能命中同一个文件，而彼此又没有依赖关系；
- 角色文本文件缺失、YAML 读不出来、计划或角色里有未知键，或角色名不是小写字母、
  数字与 `-`。

`model` 与 `effort` 原样传递，不会根据它们推断任何东西。

### 审计配置块

```yaml
audit:
  mode: shadow          # shadow | enforce
  provider: heuristic   # heuristic | typesafe | off
  questions: [plan.risk, plan.clarity, role.boundary, result.fidelity, merge.risk, teardown.safety]
```

省略字段时默认 `shadow`、`heuristic` 与全部决策 id；显式 `questions: []` 表示
什么都不记录。非法值会回到安全默认值而不是让计划失败，问题由
`attest audit report` 报出。`ATTEST_JEV_MODE` 与 `ATTEST_JEV_PROVIDER` 可覆盖配置
做实验；远程提供方用 `ATTEST_JEV_API_KEY`、`ATTEST_JEV_BASE_URL`、
`ATTEST_JEV_MODEL` 与 `ATTEST_JEV_TIMEOUT_MS` 配置。决策、信任边界与校准的完整
说明见 [Jev 审计](jev-audit.zh-CN.md)。

## 命令参考

所有命令都接受 `-m, --case <name>`。解析顺序：显式 `-m`；当前 pane 绑定的案件；
其面板把当前 pane 记为编排者的案件；当前所在目录检出的 `case/<name>` 分支。没有
解析出案件时，命令会列出打开的案件及其 worktree，而不是猜一个。`-m` 可以从任意
位置读取案件 worktree 里的计划，但拒绝指向与当前 pane 绑定不同的案件。

退出码是接口的一部分：**0** 成功，**1** 被拒绝（会打印原因），**2** 用法错误
（消息与 usage 打到 stderr）。

| 命令 | 选项 | 作用 |
| --- | --- | --- |
| `setup` | `--remove` | 为检测到的 harness 安装（或移除）`attest-case` 技能；只动带标记的安装 |
| `case new <name>` | `--base <ref>` | 从 `HEAD` 或 `--base` 创建 `case/<name>` 的 worktree，写计划模板，绑定当前 pane，打开面板；当前 pane 已在跑别的案件时拒绝 |
| `open` | `--planning`、`-m` | 在 agent 旁边显示案件面板，一案一面板。`--planning` 打开等待 `case new` 的面板；未绑定的 pane 用 `open -m` 可以接管编排者 pane 已消失的案件 |
| `up` | `-m <case>`、`--orch claude\|codex` | 创建案件，在 worktree 里启动编排者，打开面板；不在 tmux 里时自动附加 |
| `check` | 位置参数 `[case\|folder\|plan]`、`-m` | 校验计划与适配器；输出 `clean (N roles: …)` 或问题列表 |
| `approve` | `-m` | 打印计划摘要、列出问题、询问 `y/N`；要求 stdin 与 stdout 都是终端，且提示期间计划被改动会拒绝 |
| `gate <id>` | `"question"`、`--no-wait`、`-m` | 追加 gate-open 事件并在面板里向人提问；打印 `approve` 或 `change: <text>`；`--no-wait` 立即返回 |
| `stage <id>` | `-m` | 移动阶段条；id 来自工作流的 `stages.yaml`；未知 id 会列出可选值并拒绝 |
| `dispatch <role>` | `-m` | 要求当前计划已批准、依赖都 `done`；创建 worktree 与分支、写 brief、开窗口、记录派发 |
| `status` | `--json`、`--watch`、`-m` | 每个角色的状态、agent、分支、提交、改动文件、超出 `touches` 的文件、结果摘要与问题；没有案件时列出打开的案件 |
| `send <role> <text…>` | 省略文本时从 stdin 读、`-m` | 仅在角色报告就绪时向窗口输入；先把旧结果移走；等待/工作中/未知时拒绝，并提示用 `wait --ready` |
| `wait` | `--role <r> [--ready]`、`--gate <id>`、`--timeout <秒>`、`-m` | 等角色结果（`done` 退出 0，`blocked`/`failed` 退出 1）、等就绪、或等关卡回答（`approve` 或 `change: …`）；Ctrl-C 干净取消；日志有坏行时拒绝不可靠的等待 |
| `close <role>` | `--all`、`-m` | 关闭 attest 打开的 pane；worktree 与分支保留 |
| `teardown` | `--force`、`-m` | 工作流的关卡都批准后：关闭角色 pane 与案件面板，移除角色 worktree、角色分支、案件 worktree 与临时 brief/结果；保留案件分支与日志。有脏/未跟踪改动、未合并进 `base` 的提交、未推送的案件分支时拒绝（除非 `--force`）；带其他 owner 标记的 pane 会被跳过；已完成的案件必须显式 `-m`，重复清理会报告没有剩余内容 |
| `panel` | `--once`、`--plain`、`--no-anim`、`--width N`、`--height N`、`-m` | 实时面板；`--once` 打印一帧后退出（适合脚本）；`--plain` 去掉颜色；`--no-anim` 关闭动效；面板至少需要 40x10 |
| `audit verify` | `--json`、`-m` | 校验哈希链：`OK <n> records`（成功的非空校验会追加一条 `audit-verify`）、空账本 `OK 0 records`、尾部撕裂时 `OK <n> records (incomplete final line ignored)`（后两者不追加），或 `BROKEN at record <n>: <原因>` 并退出 1 |
| `audit report` | `--json`、`--write`、`-m` | 案件审计摘要：链、模式/提供方、计数、风险、一句话结论、决策表、结果、校准。模式、提供方与结论来自已记录的动作（计划/环境配置只在账本为空时用于标注）。`--write` 写出 `docs/cases/<case>/audit.md` 并打印 `Wrote <path>`；此时 `--json` 给出 `written`（绝对路径）；断链时给出 `writeRefused`——断链退出 1，且绝不会发布为报告 |
| `audit show <n>` | `--json`、`-m` | 按账本序号或决策 id（最近一条）查看单条决策：原因、状态摘要、答案与耗时 |
| `audit outcome <id\|seq>` | `<allow\|ask\|block\|defect\|pass>`、`--note`、`--json`、`-m` | 追加人的判定供校准；`expected` 是记录的动作，`observed` 是你的判定 |
| `audit calibrate` | `--json`、`-m` | Brier 分数、可靠性分箱与建议性阈值；可用结果少于 5 条时报告 `insufficient outcomes` 并退出 0。重校准映射至少需要 12 条结果，且留出集上的 Brier 分数确实改善 |

`attest stage audit` 是工作流里的审计阶段：校验链、为每个已派发且写了结果的
角色记录一条 `result.fidelity` 决策、写出报告，然后移动阶段。断链或 enforce
模式下的 block 会让阶段停在原地。面板的 AUDIT 页读取同一份账本（见[面板](#面板)）。

Attest 还会为它给 Claude Code 角色安装的生命周期钩子与状态栏安装两个内部辅助入口。
它们不属于受支持的 CLI 表面，也不会出现在 `attest --help` 里。

## 面板

自己运行 `attest panel`，或让 `case new`、`open`、`up` 打开它。面板是真正的终端
UI：占满窗口、只重绘变化的单元格，至少需要 40 列 x 10 行。

页面（`1`–`6`，`Tab` 循环，`d` 跳到所选角色的 diff，`v` 跳到计划）：

| 页面 | 内容 |
| --- | --- |
| **1 CASE 任务** | 顶部是待你处理条（打开的关卡显示为盒子，每个等你的角色一行）；左侧是 ROLES、STAGES、ACTIVITY；右侧是 FLOW 与所选角色的详情和实时窗口。右侧放不下时可滚动。 |
| **2 ROLES 角色** | 每个角色一张卡片：状态、强度、harness 上报时的上下文与 token、agent 与模型、分支、`touches`、已提交与改动文件、超出 `touches` 的文件、结果摘要。 |
| **3 PLAN 计划** | 渲染后的计划与其问题；`f` 切换全文；摘要视图就是关卡使用的那一份。 |
| **4 LOG 日志** | 全部运行日志事件，最旧在前，默认跟随最新直到你向上滚动；`Enter` 展开事件字段。 |
| **5 DIFF 改动** | 每个角色的改动文件树、所选文件的提交与 hunk、缩略图。 |
| **6 AUDIT 审计** | 账本：链状态、模式与提供方、风险结论、分级计数、决策列表（最新在前）、所选决策的原因与状态摘要、校准条。 |

按键：

| 键 | 动作 |
| --- | --- |
| `↑↓`、`j k` | 选择角色（CASE/ROLES）、事件（LOG）、文件（DIFF）、决策（AUDIT） |
| `Enter` | 打开所选详情；LOG 上展开字段；AUDIT 上展开原因全文 |
| `1`–`6`、`Tab` | 切换页面 |
| `o` | 打开所选角色的 tmux 窗口 |
| `s` | 给所选角色发消息（它正在等你时禁用：先回应它） |
| `d` / `v` | 跳到所选角色的 diff / 计划 |
| `a` / `c` | 批准打开的关卡 / 输入修改 |
| `f` | PLAN 页切换全文 |
| `L` 或 `中/EN` 开关 | 切换面板语言 |
| `PgUp`/`PgDn`、滚轮 | 滚动；`G`/`End` 重新跟随最新日志 |
| `n` / `N` | DIFF 上切换文件 |
| `?` | 帮助；`q` 或 Ctrl-C 退出 |

关卡。计划关卡是每个工作流都有的第一道关卡；派发要求"当前这份计划"（计划字节
加上它引用的每份角色文本）已批准，任何改动都会让批准失效。批准即采纳
`Decisions for you` 里的推荐项。其他关卡来自工作流的 `stages.yaml`（默认工作流里
是 `mr-ok`、`merged`）；编排者用 `attest gate` 打开，面板显示。关卡回答会追加到
运行日志。

语言。`中/EN`（或 `L`）在英文和中文之间切换。选择保存在
`~/.config/attest/settings.json`；在你做出选择之前，`zh` locale 会让面板以中文
启动。它同时决定 agent 为你书写的语言（计划正文、关卡问题、结果）；之后派发的
角色会在 brief 里得到它，案件进行中切换时编排者也会被告知。已经写好的内容保持
原样，Attest 要读回来的内容（标题、YAML、`status:`、CLI 输出）保持英文。

tmux 传递鼠标事件时（`set -g mouse on`），点击也有效。

## Agent 适配器

内置：`claude` 与 `codex`。新增或覆盖适配器放到
`~/.config/attest/agents/<name>.yaml` 或 `<repo>/.attest/agents/<name>.yaml`；
仓库里的优先，且文件会完整替换该适配器。

| 字段 | 含义 |
| --- | --- |
| `command` | 要运行的可执行文件 |
| `model` | 模型值的 argv 模板，例如 `["--model", "{model}"]` |
| `effort` | 强度值的 argv 模板 |
| `permission` | 权限参数组；每组必须被角色声明的至少一个 flag 覆盖 |
| `prompt` | 必须是 `last-arg`：首个提示是最后一个参数 |
| `screen.waits` / `screen.working` / `screen.ready` | 从 pane 最后 15 行非空文本读取的正则列表 |
| `paste` | 必须是 `bracketed`：消息用 bracketed paste 输入 |
| `badge.glyph` / `badge.tone` | 占一个单元格的徽标与面板色调 |
| `usage` | 当 Attest 能读取 agent 自己的回合/上下文信号时设为 `claude` 或 `codex`；省略则只依赖屏幕 |

内置 Claude Code 角色启动时带 `--settings`，其中包含生命周期钩子
（`UserPromptSubmit`、`PermissionRequest`、`PostToolBatch`、`Stop`、
`Notification`）和状态栏。钩子会写角色 worktree 里的 `.attest/activity.json`：
它们决定一个回合何时就绪、何时在等人（审批或提问），因此 Attest 不会往对话框里
输入文字。状态栏把真实上下文窗口记到 `.attest/context.json`，然后继续运行你自己的
状态栏命令，所以你原来的状态栏照常显示。Codex 角色则读它自己的会话日志
（`task_started`、`task_complete`、`turn_aborted`）。

Codex 的两个细节：角色启动时带
`-c projects=…trust_level="trusted"`（针对主 checkout），所以不会弹
"Trust this folder?"；你的 `~/.codex/config.toml` 不会被修改。使用
`-s workspace-write` 的角色会得到 `--add-dir` 授权，覆盖它自己的 git worktree
元数据、共享 objects，以及案件的 loose refs/reflogs——足够提交，但不是写主分支的
权限。审批与沙箱参数本身仍然来自计划。

`attest check` 会报告适配器问题（字段错误、非法正则、非法徽标），直到修好为止；
适配器加载不了的计划，CLI 一律拒绝执行。

## 文件放在哪

目标仓库内的路径：

| 内容 | 位置 | 进 git 吗 |
| --- | --- | --- |
| 案件 worktree | `.attest/cases/<case>`，分支 `case/<case>` | 否 |
| 计划 | 案件 worktree 的 `docs/cases/<case>/plan.md` | 是 |
| 审计报告 | 案件 worktree 的 `docs/cases/<case>/audit.md` | 写出时是 |
| 运行日志 | `<git-common-dir>/attest/<case>/log.jsonl` | 否 |
| 审计账本 | `<git-common-dir>/attest/<case>/audit.jsonl` | 否 |
| 角色 worktree | `.attest/worktrees/<case>/<role>` | 否 |
| 角色 brief | `<worktree>/.attest/brief.md`（同时归档为日志旁的 `brief-<role>.md`） | 否 |
| 角色结果 | `<worktree>/.attest/result.md` | 否 |
| 角色活动 / 上下文 | `<worktree>/.attest/activity.json`、`context.json` | 否 |
| 审查记录 | `<worktree>/.attest/reviews/<role>.md` | 否 |
| agent 适配器 | `~/.config/attest/agents/*.yaml`、`<repo>/.attest/agents/*.yaml` | 仓库里的进 |
| 面板语言 | `~/.config/attest/settings.json` | 否 |

**运行日志**只存事实：`gate-open`、`gate-answer`、`stage`、`dispatch`（pane、
worktree、分支、argv、agent）、`send`、`close`、`up`、`teardown`、`orchestrator`
（agent 会话与要通知的 pane）、`notice`（输入编排者的话）以及 `lang`。实时状态
（工作中、等待、空闲、提交、diff）每次轮询都从 tmux、git 与角色自己的文件重新
读取。日志和任何文件一样只是提示：它能拦住健忘的派发，拦不住刻意手改的模型。

角色通过写 worktree 里的 `.attest/result.md` 结束，格式为 front matter：

```markdown
---
status: done            # done | blocked | failed
summary: "面板与 status 显示的一行"
done_when: ['1', '2']   # 可选，审查者：这次审查认为已通过的完成标准编号
---
```

审查者已有旧结果时，会先把旧结果移走（归档为日志旁的
`result-<role>-<uuid>.md`），所以对它的 `attest send` 会开始一个新结果，而不是
复用旧的。

## 已知限制

- **运行日志只是提示。** Attest 读的是事实，不审计 agent 的过程。手改日志的模型
  可以干扰派发记录，但无法在不被账本与报告看见的情况下绕过计划批准或关卡回答。
- **读屏只是回退。** 内置角色的回合由 agent 自己的信号决定，不由屏幕决定。屏幕
  模式取自英文界面的 Claude Code 2.1.310 与 Codex 0.162.1；它们只用于判断运行中
  的回合是否在等人。无法识别的画面记为 `unknown`，绝不会被输入文字。
- **Codex 不记录审批请求。** 等审批的 Codex 角色只有屏幕匹配时才显示为等待；无论
  如何它都不算就绪，而且它的回答不会汇报给编排者。
- **上下文能读则读。** Claude Code 通过安装的状态栏上报窗口；Codex 有自己的日志。
  第一次上报之前，面板假设 200k，上下文超过 200k 后按 1M 处理。
- **审计是信号层。** 账本可发现篡改但不是不可篡改；离线启发式如实标注，并需要
  记录的结果来校准；远程提供方可能被对抗性状态操纵。若要依赖它做重要决定，请先读
  [Jev 审计](jev-audit.zh-CN.md)。
- **一台机器、一个用户。** 角色共享案件的 git refs 与 objects，所以能提交；这不是
  角色之间的隔离。边界是 tmux 加 git worktree，不是沙箱。角色按计划里的权限运行，
  Attest 不额外加自己的沙箱。
- **设计上必须有人参与。** CLI 不会替你推送 MR、合并分支或批准关卡。
  `attest approve` 与面板的 `a` 都需要终端。

## 开发与检查

从源码：

```sh
npm ci
npm run build        # tsc + dist/cli.js
npm run check        # tsc --noEmit、身份扫描、构建与完整测试
```

`./check.sh` 是唯一的检查入口：类型检查、身份扫描、构建，以及在纯 Node 下跑全部
测试，包括面板 golden 与真实 tmux 集成测试（没有 tmux 时跳过）。CI 在 Linux 和
macOS 上用 Node 20 与 22 跑，并额外在空 locale 下跑一次，以捕捉 locale 相关的输出
差异。

- **面板 golden。** `tests/draw.node.mjs` 比较纯文本帧。有意改动视觉后运行
  `UPDATE_GOLDENS=1 node --test tests/draw.node.mjs`，并在提交前阅读 diff。
- **身份扫描。** `scripts/check-names.mjs` 拒绝仓库里出现旧项目身份；
  `npm run check` 会运行它。
- **截图。** `docs/media/*.png` 是 tmux 里真实 `attest panel` 帧，用 Pillow 渲染。
  流程与依赖见 [tools/screenshot](../tools/screenshot/README.md)。
- **文档契约。** `tests/docs-contract.node.mjs` 检查文档里出现的命令确实存在于
  `attest --help`、每个本地图片引用都存在，以及两个 README 引用同一组截图。

`src/` 很小，是不带框架的普通 TypeScript。按关注点分：计划（`plan.ts`、
`yaml.ts`、`touches.ts`、`check.ts`）、案件与 pane（`cases.ts`、`panes.ts`、
`role-commands.ts`、`orchestrator.ts`、`notices.ts`、`setup.ts`）、实时读取与日志
（`state.ts`、`log.ts`、`usage.ts`、`diff.ts`、`screen.ts`、`statusline.ts`、
`agents.ts`）、面板（`model.ts`、`draw.ts`、`canvas.ts`、`motion.ts`、`panel.ts`、
`panel-input.ts`、`panel-model.ts`、`i18n.ts`）以及审计子系统（`src/jev/**`）。
模块边界与数据格式的协作契约在 `docs/dev/contracts.md`。
