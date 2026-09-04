# dsh-custom-permission 插件开发计划

本仓库用于开发一个独立的 DeepSeek Harness（下文简称 DSH）外部插件。插件提供三类用户可配置的策略：

1. **自动允许**：命中规则的工具调用（tool）与 shell 命令（command）不再弹审批、直接放行；
2. **自动拒绝**：命中规则的工具调用与 shell 命令直接失败，附带原因；
3. **沙箱外文件访问**：配置额外可写路径，使 DSH 的文件系统工具可以读写工作区之外指定路径下的文件。

约束：**不修改 DSH 仓库内任何源码或文档**；本插件作为 out-of-tree 插件，通过 profile 组合层（bundle patch / 用户 patch）挂载。

---

## 1. 背景与目标

DSH 的默认权限模型（`dsh-base` bundle）是：文件沙箱 `workspace-write`（只允许写会话工作区 + 平台临时目录）+ 审批策略 `ask`（敏感操作弹一次性允许/拒绝）。模型触发的审批提问（`approval/request`）由 Web 界面的审批卡片作答。该模型缺少三类用户想要的自定义能力：

- 某些工具/命令每次都要审批（或可能被 hook 拦下询问），用户希望直接放行；
- 某些工具/命令用户希望模型永远不要执行，而不是每次去拒绝；
- 工作区之外的一批文件（如数据目录、输出目录）用户希望模型可直接读写，而不必每次走沙箱升级审批。

本插件用 DSH 既有扩展点实现这三类能力，全部行为由一份插件配置（`cordis.yml` 中该插件的 `config`）驱动。

## 2. 调研结论：DSH 的插件机制与相关扩展点

以下结论来自对 DSH 仓库（`docs/` 与 `packages/`）的阅读，是设计的依据。

### 2.1 插件与组合模型

- DSH 基于 Cordis：一切（工具注册表、审批服务、沙箱、agent loop）都是插件，无特权核心；扩展 = 在旁边挂载一个插件，注册都是可逆 effect（`ctx.effect`/`ctx.on`）。
- 组合 = profile：`$DSH_HOME/profiles/<name>/` 下按序叠加 bundle 层 → profile 自己的 `cordis.patch.yml` → 全局 patch → `--patch`。patch 语义（`applyEntryPatches`）：按 `id` 定位行的**整体覆盖**（可写 `disabled: true`、替换 `config` 等），或 `insert` 新行；后层覆盖前层（last write wins）；命不中目标行只告警不致命。
- `dsh plugin --profile <name> add <pkg>`：把包装进 profile 依赖（pnpm），若该包 `package.json` 声明 `dsh.bundle.patch`，则自动加入该 profile 的 `dsh.profile.bundles`，成为一层 bundle。
- Cordis `ctx.provide(name)` 对**已注册的服务名会抛错**（`service "fs" has been registered at <fiber>`），因此运行时"再提供一次 `ctx.fs` / `ctx.sandbox`"不可行；服务替换只能在**组合层**完成（禁用旧行、插入新行）。
- 类插件：默认导出继承 `Service` 的类；Loader 激活时 `new Plugin(ctx, config)`，随后调用 `instance[Service.init]()`；`Service` 构造器自动 `ctx.provide(name, this)`。静态 `Config`（schemastery schema）负责配置校验与默认值。`static inject` 声明服务依赖，激活等依赖就绪。

### 2.2 工具执行管线与策略扩展点（`core/tools`）

执行顺序（详见 `docs/tool-execution-pipeline.md` 与 `packages/core/tools/src/index.ts`）：

```
tool/call（已记录参数）→ tools/pre-execute 瀑布 → （ask 时）ctx.approval 一次性审批
→ 单调 guards → tools/execute 瀑布（包裹工具体）→ tools/post-execute 瀑布 → tool/result
```

- `tools/pre-execute` 是 waterfall：监听器返回 `PreToolDecision` = `{kind:'allow'} | {kind:'deny', reason} | {kind:'ask', reason?}`；默认 `allow`。**不调用 `next()` 即短路**，后续监听器不再执行——策略监听器"own the decision"的官方用法。`{ prepend: true }` 注册可排到最前（如 hooks 之前）。
- `ctx.tools.guard(guard)`：注册**单调守卫**，在 pre-execute + 审批**之后**运行；返回 `string` 即拒绝（deny-only，任何监听器/审批都不能覆盖），返回 `undefined` 放行。官方定位：`owner policy that must not be reordered remains a registered guard`——不可被重排/绕过的策略应放这里。
- 监听器可见 `ToolExecution`：`name`、`arguments`（已深冻结的解析后 JSON，含 bash 的 `command` 字段）、`agent`（可取其 `session`）、`callId`、`signal`。
- 注意：PTC 模式下被 `run_code` 折叠的工具调用在策略管线之前就确定拒绝，策略监听器不会看到（也不会误放行）。

### 2.3 审批机制（`interaction/user-approval`）

- `ctx.approval.request(req)` 是唯一问询入口；结果 `allowed-once | rejected | cancelled | unavailable`，非 `allowed-once` 一律失败关闭。
- 应答者是 `approval/request` waterfall 监听器：返回一个 outcome 即认领该请求，或 `next()` 交给下家；第一个认领者决定结果。UI 审批卡片即应答者之一。
- `ApprovalRequest` 只携带 `{ agent, toolName, callId?, reason?, signal? }` —— **刻意不含工具参数**（避免第二份会漂移的渲染副本）。因此应答者按工具名匹配，看不到 bash 的 `command` 文本。
- 会话策略 `ask`（默认）委派应答链；`never` 在**应答链之前**确定性拒绝，prepend 应答者也无法绕过。
- bash/pwsh 的沙箱升级（`sandbox_permissions` + `justification`）发生在**工具体内部**（`tool-bash`/`tool-pwsh` 的 execute 里），走同一个 `ctx.approval.request`——pre-execute 监听器无法拦截它，只能靠应答者处理。
- `tool/call` 会话事件携带 `arguments`（JSON 字符串，含 `command`），且在工具体执行前已落日志；审批请求带 `callId`，因此应答者**可以**用 `callId` 反查会话日志里的 `tool/call` 拿到本次调用参数（这是对"请求不含参数"设计的变通，见 4.3 的取舍说明）。

### 2.4 沙箱与文件系统策略

- `ctx.sandboxPolicy.resolve()` 返回每个调用的一次性 `SandboxExecutionPolicy { mode, workspaceRoot }`；`mode ∈ read-only | workspace-write | danger-full-access`。会话级切换以日志事件 `sandbox/mode` 存储。
- 文件系统后端 `dsh-fs-sandbox`（`SandboxedFileSystem extends LocalFileSystem`）只对 `writeText`/`editText` 做栅栏：`read-only` 全拒；`workspace-write` 仅当目标规范路径处于 `writableRoots(policy)`（= 会话工作区根 + 平台临时目录，由 `@deepseek-ai/dsh-sandbox` 导出的共享 helper 派生）之下才放行；`danger-full-access` 不设防。拒绝抛结构化 `FS_SANDBOX_DENIED`，工具层渲染为 `[sandbox: file access denied under <mode> mode]`。
- **官方明确限制**：`SandboxExecutionPolicy` 只有一个工作区根，**没有"额外可写根"字段**（`docs/subsystems/sandbox.md` 的 Known Limitations）；进程沙箱（bash/pwsh）的 bwrap/landlock/seatbelt/windows-acl 写集合同样固定派生，无扩展点。
- 因此"沙箱外文件"只能在**文件系统后端层**实现（自定义 `ctx.fs` 后端 + 组合层替换），进程沙箱不可扩展（见第 7 节限制）。

### 2.5 模型可见上下文

- 插件可注册动态运行时上下文：`ctx.systemPrompt.context({ name, order, text })`（`PromptContext`），与 `dsh-sandbox-policy` 的 `sandbox:policy` 贡献同一机制，缓存安全、随运行时上下文快照进入模型输入。
- 工具结果（含 deny 原因、沙箱拒绝标记）是模型可见的；`approval/*` 审计事件仅日志。

### 2.6 其他

- `ctx.commands.register(...)` 可注册斜杠命令（人类发起，不经过模型回合）；本插件可选提供 `/custom-permission` 查看当前规则。
- 配置文件即插件 `config`（schemastery 校验）；`patchReload: live` 的 profile 下，改 patch 文件会热重载插件，规则随重载生效。

## 3. 总体设计

### 3.1 术语约定

- **工具（tool）**：工具注册表中的一个名字，如 `bash`、`read`、`write`、`web_search`。
- **命令（command）**：shell 工具（`bash`/`pwsh`）调用参数里的 `command` 字符串。DSH 中斜杠命令（slash command）由人类直接发起、不涉及审批，不在本插件范围。

### 3.2 功能 → 机制映射

| 功能 | 实现机制 | 说明 |
|---|---|---|
| 自动允许：工具 | `approval/request` 应答者（prepend） | 覆盖所有到达审批缝的 ask（含工具体内的沙箱升级 ask），按工具名匹配 |
| 自动允许：命令 | `tools/pre-execute` 监听器（prepend）+ 应答者（可选 callId 反查） | 覆盖 hook 类 ask（PreToolUse）与工具体 ask；见 4.3 |
| 自动拒绝：工具/命令 | `tools/pre-execute` 监听器（先拒绝，避免弹审批）+ `ctx.tools.guard()`（最终裁决） | deny 优先于 allow；guard 在审批之后运行，任何路径都绕不过 |
| 沙箱外文件访问 | 自定义 `ctx.fs` 后端（`extraWritableRoots`）+ bundle patch 替换 `fs-sandbox` 行 | 只影响文件系统工具；bash 进程沙箱不可扩展（见第 7 节） |
| 模型可见的额外路径提示 | `ctx.systemPrompt.context(...)` | 让模型知道这些路径可写 |

### 3.3 优先级与失败关闭原则

1. **deny > allow**：pre-execute 阶段先查 deny 再查 allow；guard 永远兜底 deny（即便某处 allow 了，guard 仍可拒）。
2. **先匹配先生效**：规则按配置顺序求值，第一条命中生效。
3. **未命中必须委托**：pre-execute 监听器未命中时调用 `next()`；应答者未命中时调用 `next()`；guard 未命中返回 `undefined`。绝不吞掉别的策略。
4. **不弱化既有安全面**：`never` 策略、PTC 折叠拒绝、`FS_SANDBOX_DENIED`（read-only 等）保持原行为；自动允许只作用于"本会触发审批"的调用，不改变默认放行语义。
5. **安全默认**：`allowApprovals`（工具级应答自动放行，含升级 ask）默认空数组；需要用户显式开启。

## 4. 详细设计

### 4.1 配置 Schema（schemastery）

```yaml
- id: custom-permission
  name: dsh-custom-permission
  config:
    # 自动允许：命中则不弹审批。匹配到 allow 规则时短路 pre-execute；
    # 对工具体内 ask（如沙箱升级）由应答者按工具名兜底。
    allowRules:
      - tool: 'bash'                    # 工具名，支持精确名 / glob / regex
        when:
          command: { regex: '^git (status|diff|log|push)' }   # 对 command 字段匹配
      - tool: 'fs_write'
        when:
          path: { prefix: 'E:\\data\\out' }
    # 自动拒绝：命中即失败。guard 兜底，任何路径不可绕过。
    denyRules:
      - tool: 'bash'
        when:
          command: { regex: 'rm -rf /|format .*:' }
      - tool: 'write'
        when:
          path: { glob: '/etc/**' }
    # 工具级应答自动放行（含该工具的沙箱升级 ask）。默认空。
    # 开启即意味着该工具的所有 ask（包括升级到 danger-full-access 的单次授权）都自动通过。
    allowApprovals:
      - 'bash'
    # 沙箱外可写路径（供自定义 fs 后端使用；相对路径按 cwd 解析为绝对路径）。
    extraWritableRoots:
      - 'E:\\data\\out'
      - 'C:\\Users\\me\\Documents'
```

字段说明：

- `allowRules` / `denyRules`：`Array<{ tool: string; when?: { <字段路径>: Matcher } }>`。
  - `tool`：精确名、glob（`fs_*`）、或 regex（`^/...`）。解析顺序：先精确、再 glob、再 regex。
  - `when`：可选，对 `arguments` 的指定字段做匹配；`command` 对 bash/pwsh 的 `command` 字段，`path` 对 fs 工具的 `path` 字段，也可用任意字段路径（如 `{ 'workdir': { prefix: ... } }`）。
  - `Matcher`：`{ regex } | { prefix } | { glob } | { contains }`，可多个并列（同一字段的多个条件为 AND）。
  - 一个规则可带多个字段条件（AND）。
- `allowApprovals`：`string[]`，工具级；同时作用于 `approval/request` 应答者（含升级 ask）。
- `extraWritableRoots`：`string[]`，加载时规范化为绝对路径并去重。

### 4.2 规则匹配引擎（独立模块，纯函数，便于单测）

- 输入：`{ toolName, arguments }`；输出：`'allow' | 'deny' | undefined`。
- 实现 `src/rules.ts`：
  - `matchTool(name, pattern)`：精确/glob/regex 三档；
  - `matchArguments(args, when)`：按字段路径取值（`command`、`path` 等），逐条件匹配；
  - `evaluate(rules, toolName, args)`：按序求值，返回第一条命中的规则动作。
- 与工具执行上下文解耦，保证 pre-execute、guard、应答者三处使用**同一套规则与同一份配置**，行为一致。

### 4.3 自动允许的实现

**（a）`tools/pre-execute` 监听器（`{ prepend: true }`）**

```
ctx.on('tools/pre-execute', async (exec, next) => {
  const hit = rules.evaluate(allowRules, exec.name, exec.arguments)
  if (hit) return { kind: 'allow' }
  // deny 也在此短路（先于 ask/hook），见 4.4
  ...
  return next()
}, { prepend: true })
```

命中 allow 时短路 → 后续 hook（如 Claude Code PreToolUse）不再产生 ask。能直接看到 `command`/`path` 参数，命令级匹配在这里完成。

**（b）`approval/request` 应答者（`{ prepend: true }`）**

```
ctx.on('approval/request', async (req, next) => {
  if (req.toolName 命中 allowApprovals) return 'allowed-once'
  const args = await argsByCallId(req)        // 可选：callId → tool/call 日志反查
  if (args && rules.evaluate(allowRules, req.toolName, args)) return 'allowed-once'
  return next()
}, { prepend: true })
```

- 覆盖工具体内部的 ask（bash/pwsh 沙箱升级）。
- `argsByCallId(req)`：在 `req.agent.session` 的事件流里按 `req.callId` 找 `tool/call`，`JSON.parse(data.arguments)` 取回参数。这是对"请求不含参数"的变通：`tool/call` 在工具体执行前已落日志、审批在同一 turn 内发起，事件必然已提交，可确定性反查；无 `callId` 或反查失败则回退到工具级规则（`allowApprovals`）或 `next()`。
- **取舍说明**：反查依赖 `tool/call` 的 `arguments` 字段（`core/session` 的稳定事件契约），并且是应答者只读日志、不产生新事件；作为 P1 可选实现，若觉得过于取巧，可降级为纯工具级 `allowApprovals`（代价是命令级自动允许无法覆盖升级 ask）。

### 4.4 自动拒绝的实现

**（a）`tools/pre-execute` 监听器**：命中 deny 直接返回 `{ kind: 'deny', reason }`（`reason` 形如 `blocked by dsh-custom-permission: <rule>`），在 ask/hook 之前短路，避免白白弹审批。

**（b）`ctx.tools.guard()` 兜底**：

```
ctx.tools.guard(exec => {
  const hit = rules.evaluate(denyRules, exec.name, exec.arguments)
  return hit ? `blocked by dsh-custom-permission: ${hit.ruleId}` : undefined
})
```

guard 在 pre-execute + 审批之后运行，即便其他监听器 allow 或应答者已放行，guard 仍拒绝——自动拒绝不可被绕过（`prepareExecution` 中守卫只在决策为 allow 后求值，是审批后的最终裁决）。拒绝结果以 `Error: <reason>` 进入 `tool/result`，模型可见。守卫通过 `ctx.tools.guard()` 注册（该服务在 `static inject` 中声明，保证激活顺序）。

### 4.5 沙箱外文件访问：自定义 `ctx.fs` 后端

模板直接取自 `dsh-fs-sandbox`（同样的 `extends LocalFileSystem` + 栅栏模式），只把"允许写集合"扩为 `writableRoots(policy) ∪ extraWritableRoots`：

```
class CustomPermissionFileSystem extends LocalFileSystem {
  static inject = ['sandboxPolicy']
  static Config = z.intersect([LocalFileSystem.Config, z.object({
    extraWritableRoots: z.array(z.string()).default([]),
  })])
  constructor(ctx, config) { super(ctx, config); /* 规范化 extraWritableRoots */ }

  [Service.init]() {
    // 注册 4.3 / 4.4 的策略监听器、应答者、systemPrompt.context（4.6）、可选命令（4.7）
  }

  override get sandboxMode() { return this.ctx.sandboxPolicy.defaultMode }

  override async writeText(target, content, expected, signal, sandboxPolicy) {
    return super.writeText(await this.checkedTarget(target, sandboxPolicy), content, expected, signal)
  }
  override async editText(...) { /* 同上 */ }

  private async checkedTarget(target, sandboxPolicy) {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    // read-only → 抛 FS_SANDBOX_DENIED（保持原样）
    // danger-full-access → 原样返回
    // workspace-write → 重新 resolve 目标（防 TOCTOU），
    //   允许 iff 规范路径在 writableRoots(policy) ∪ extraWritableRoots 之下
  }
}
```

- 行为与 `dsh-fs-sandbox` 完全一致，唯一差异是放行集合多了配置的额外根；`read-only`/`danger-full-access` 语义不变。
- `dsh-tool-fs`、`fs-observation-policy` 等上层不动（它们只消费 `ctx.fs` 与 `fs/*` 事件）。
- **组合层替换**（bundle patch，见 5 节）：禁用基础 bundle 的 `fs-sandbox` 行（`id: fs-sandbox`，`disabled: true`），插入本插件的行。这样 `ctx.fs` 只有一个提供者，避免 `ctx.provide` 冲突。若用户不用 bundle 而是手动挂载，必须自行禁用/不装 `dsh-fs-sandbox`，否则启动时冲突报错（fail loud，符合预期）。

### 4.6 模型上下文贡献

```
ctx.systemPrompt.context({
  name: 'custom-permission:extra-roots',
  order: <与 sandbox:policy 相邻的合适值>,
  text: () => extraWritableRoots.length
    ? `Custom permission: the following paths outside the session workspace are also writable: ${list}.`
    : '',   // 空文本不贡献任何内容
})
```

与 `sandbox:policy` 同一机制：模型在每次请求前看到完整快照；只在配置了额外根时贡献文本，避免空噪音。文案英文、稳定、可快照（遵循 DSH 模型可见文本须固定的约定）。

### 4.7 可选：`/custom-permission` 命令

`ctx.commands.register({ name: 'custom-permission', description: 'Show active allow/deny rules and extra writable roots', handler })`——只读展示当前生效规则与额外根，方便用户核对。不提供运行时改规则（规则 = 插件配置，live profile 下改 patch 文件即热重载）。

## 5. 插件包结构

```
dsh-custom-permission/
  package.json          # dsh.bundle → cordis.patch.yml；exports 指向 lib
  cordis.patch.yml      # bundle patch：禁用 fs-sandbox 行 + 插入插件行（默认配置可留空，用户 patch 覆盖）
  tsconfig.json         # extends DSH tsconfig.base.json（rootDir src, outDir lib/types）
  src/
    index.ts            # 默认导出 CustomPermissionFileSystem（Service 类插件，见 4.5）
    rules.ts            # 规则匹配引擎（纯函数，4.2）
    answerer.ts         # approval/request 应答者 + callId 反查（4.3b）
    context.ts          # systemPrompt.context 贡献（4.6）
    command.ts          # /custom-permission 命令（4.7，可选）
  tests/
    rules.spec.ts       # 匹配引擎单测
    policy.real.spec.ts # Loader 真实组合测试（见 8）
    fs-backend.spec.ts  # 额外根栅栏测试
  README.md             # 用法、配置、限制
```

`package.json` 关键字段：

```json
{
  "name": "dsh-custom-permission",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": { ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" } },
  "dependencies": {
    "@deepseek-ai/cordis": "workspace:*",
    "@deepseek-ai/schemastery": "workspace:*",
    "@deepseek-ai/dsh-fs": "workspace:*",
    "@deepseek-ai/dsh-fs-local": "workspace:*",
    "@deepseek-ai/dsh-sandbox": "workspace:*",
    "@deepseek-ai/dsh-sandbox-policy": "workspace:*"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

（依赖解析：`dsh plugin add <本地路径>` 时装进 profile 依赖闭包；开发期也可在 DSH 仓库内用 `file:` 引用。）

`cordis.patch.yml`（bundle 层，加载顺序在 `dsh-base` 之后）：

```yaml
# 替换基础 bundle 的沙箱文件系统后端：禁用原 fs-sandbox 行，插入本插件（提供 ctx.fs + 策略）。
- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
  disabled: true
- insert:
    - id: custom-permission
      name: 'dsh-custom-permission'
      config: {}    # 默认空；用户在自己的 cordis.patch.yml 里覆盖整行 config
```

挂载方式（用户侧，写进 README）：

```sh
dsh plugin --profile <name> add <本仓库路径或包名>
```

然后在该 profile 的 `cordis.patch.yml`（home 级覆盖 profile 级，最后写赢）里写 `- id: custom-permission ... config: {...}`。web/headless 等 base-backed profile 均适用；`sdk-minimal` 无 `fs-sandbox` 行，patch 的禁用项只告警不致命，插件仍可挂（若该组合不需要 fs 后端，可只用策略功能）。

## 6. 模型体验（摘要）

- 自动拒绝：`tool/result` 里的 `Error: blocked by dsh-custom-permission: <rule>`，模型直接可见。
- 自动允许：审批卡片不出现，`approval/asked`/`approval/decided` 审计对仍完整落日志（允许行为在日志中可重建）。
- 额外路径：`custom-permission:extra-roots` 运行时上下文使模型知道哪些工作区外路径可写；fs 工具写入被拒时仍渲染 `[sandbox: file access denied under workspace-write mode]` 标记（与原生一致）。
- 文案固定英文、可快照；KV 缓存友好（上下文追加在保留历史之后，不重写稳定前缀）。

## 7. 边界与限制（v1）

- **bash/pwsh 进程沙箱不可扩展**：bwrap/landlock/seatbelt/windows-acl 的写集合固定派生自 `writableRoots(policy)`，无外部扩展点；v1 只把"沙箱外文件"扩展到文件系统工具（read/write/edit）。进程沙箱侧扩展需要自定义 `ctx.sandbox` 提供者（逐平台重实现 runner 剖面），列为后续候选（见第 10 节）。
- **`never` 策略优先**：审批策略为 `never` 时应答者不运行，`allowApprovals` 失效（但 guard 拒绝与 pre-execute 拒绝仍生效）。
- **命令级自动允许不覆盖无 callId 的 ask**：升级 ask 一般带 callId（可反查）；无 callId 时回退工具级规则或交给下家。
- **工具级 `allowApprovals` 语义宽**：对该工具的所有 ask 自动放行，包括升级到 `danger-full-access` 的单次授权；默认关闭，文档要醒目提示。
- **配置为进程级**：规则随插件生命周期固定；live profile 下改 patch 文件可热重载（重新激活插件）。不支持运行时逐条增删（v1 不做持久化规则存储）。
- **挂载方式约束**：不使用 bundle 而是手动组合时，必须禁用 `dsh-fs-sandbox`，否则 `ctx.fs` 重复提供、启动 fail loud。
- **服务依赖**：插件（提供 `ctx.fs`）依赖 `ctx.sandboxPolicy`（与 `dsh-fs-sandbox` 相同）；guard 注册依赖 `ctx.tools`（工具注册表）。base-backed profile 均具备；没有这些服务的组合中插件不激活（fail loud 或策略不生效），不属于 v1 支持面。
- 沙箱模式 `read-only` 下自定义后端仍全拒写（与 `dsh-fs-sandbox` 一致）；`danger-full-access` 下额外根无意义（本来就不设防）。

## 8. 测试与验证

按 DSH 测试政策（`docs/testing.md`、`packages/AGENTS.md`）：产品可见插件必须有**真实组合测试**（经 Loader 启动测试 cordis.yml，而不是手工 `ctx.plugin(...)`）。

1. **`tests/rules.spec.ts`**（单元）：工具名三档匹配、字段条件 AND/OR、先匹配先生效、deny 优先、空规则。
2. **`tests/policy.real.spec.ts`**（真实组合，经 Loader boot）：
   - 组装：`dsh-sandbox-policy` + 本插件（禁用 `fs-sandbox`）+ `dsh-tools` + 一个会产生 `ask` 的测试监听器 + `dsh-user-approval`；
   - 断言（模型可见/持久化输出）：
     - 命中 deny 的调用 → `tool/result` 为 `Error: blocked by dsh-custom-permission: ...`，`approval/asked` 不出现；
     - 命中 allow 的调用 → 执行成功，且**没有**审批 ask（hook 的 ask 被短路）；
     - `allowApprovals` 命中 → 应答者返回 `allowed-once`（`approval/decided` 为 allowed-once）；
     - 未命中 → 委托给测试应答者（模拟 UI），返回其决定；
     - guard 兜底：即使 pre-execute 被另一个 prepend 监听器 allow，guard 仍拒绝。
   - 附带 HMR 安全测试：dispose 插件 fiber 后监听器/守卫/应答者全部移除（注册都是 effect）。
3. **`tests/fs-backend.spec.ts`**（真实组合或后端级）：
   - workspace 内写成功；`extraWritableRoots` 内写成功；两者之外写 → `FS_SANDBOX_DENIED`（渲染标记一致）；
   - `read-only` 全拒、`danger-full-access` 不设防；路径规范化（`..`、symlink）与临时目录仍可写；
   - `static Config` 校验：非法 extraWritableRoots（非字符串/空数组）fail loud。
4. **手动验证**（README 步骤）：在本地 profile 挂载后 `dsh --profile <name> --dump-config` 确认 `fs-sandbox` 被禁用、插件行生效；跑一个会话观察审批卡片不出现/拒绝信息正确。
5. 若后续纳入 DSH 仓库（可选），再补 keyless 录制会话快照；v1 在独立仓库内以真实组合测试为准。

## 9. 实施步骤（里程碑）

- **M1 骨架**：仓库初始化（package.json、tsconfig、exports、cordis.patch.yml）；`rules.ts` 匹配引擎 + 单测。
- **M2 策略三件套**：pre-execute 监听器（allow/deny 短路）、guard 兜底、应答者（先工具级，再 callId 反查）；真实组合测试通过。
- **M3 自定义 fs 后端**：`CustomPermissionFileSystem` + `extraWritableRoots` 栅栏 + `systemPrompt.context`；后端测试通过。
- **M4 收尾**：README（安装、配置、限制）、`/custom-permission` 命令（可选）、真实 profile 手动验证、仓库内提交。
- 每个里程碑跑 `tsc`（`strict`）与相关测试；不触碰 DSH 仓库任何文件。

## 10. 风险与备选方案

- **风险：callId 反查依赖 `tool/call.arguments` 契约**。备选：只做工具级 `allowApprovals`（v1 可先只交付该档）；或未来把"审批请求携带参数"作为 DSH 内改进建议（但本仓库不实现）。
- **风险：升级 ask 自动放行语义过宽**。备选：`allowApprovals` 细分 `{ tool, escalate: 'never' | 'allowed-once' }`；默认不允许升级类 ask 自动通过。
- **风险：组合层替换 fs 后端与用户其他自定义冲突**（如用户自己已换 fs 后端）。bundle patch 的 `name` 校验会告警；README 说明如何只启用策略功能（把 bundle patch 中 fs 相关两行去掉）。
- **备选：沙箱外访问走"自动批准升级"而不换后端**：应答者自动 `allowed-once` 放行 fs 工具的升级 ask，模型每次越界写都自动升级 `danger-full-access`。优点是零组合改动；缺点是单次授权粒度、且权限范围是"全部"，不如自定义后端精确。若 v1 时间紧，可先交付此档，M3 再换自定义后端。
- **候选（非 v1）：自定义 `ctx.sandbox` 提供者**让 bash 也获得额外可写根；需要按平台重实现 runner 剖面（bwrap binds / landlock grants / seatbelt SBPL / windows ACL），依赖 `dsh-sandbox-local` 内部的私有 profile 构造，工作量大，单独评估。

## 11. 待确认问题

> 以下问题已随实现（README.md 记录为准）按计划默认值落定：命令 = shell 命令（bash/pwsh 的 `command` 参数）；v1 沙箱外文件仅覆盖文件系统工具；`allowApprovals` 默认关闭、语义含升级 ask。

1. **“命令”的界定**：按 shell 命令（bash/pwsh 的 `command` 参数）实现；斜杠命令无审批流程，不在范围。
2. **沙箱外文件是否需要 bash 侧**：v1 只覆盖文件系统工具；进程沙箱扩展需要自定义 `ctx.sandbox` 提供者，保持为非 v1 候选。
3. **`allowApprovals` 是否允许覆盖升级 ask**：实现为覆盖（含升级 ask），默认空数组、README 显著提示。
4. 目标 profile：web / headless 等 base-backed profile 均支持（经 `dsh plugin add` 安装）。

## 12. 增补：运行期预设管理（Web 快捷添加 / 编辑 / 删除）

> 按用户需求新增（README.md「预设切换与管理」为准），相对原始设计的语义变化：

- **种子模型**：composition（cordis.patch.yml）的预设表是种子；settings 文档的 `custom-permission` 命名空间无用户预设表时以其为准，第一次运行期写入（Web 或命令）把整张表拷入设置文档，此后设置文档全权管理（patch 改动被覆盖；删除/改名才能被表达）。
- **写入方式**：整段 `replace`（不是 `update` 合并）——settings 的递归合并写无法表达 key 删除，`update` 会让被删的预设每次重启复活（真实组合测试暴露并锁定）。
- **settings 文档形态**：`{ preset: string, presets?: Record<string, Preset> }`；schema `z.dict(Preset)` 校验存储表结构、编译与激活名校验在 attach 时 fail loud。
- **Remote 端点扩展**：`customPermission` 命名空间新增 `get`（结构化 spec 回填编辑器）、`create`（校验+编译+持久化并激活）、`update`（改规则/改名，激活项改名跟随）、`delete`（守卫：不能删激活项/最后一个）。客户端全部 strict zod codec。
- **编辑器 UI**：四类权限分别录入；允许/拒绝规则行 = 工具模式 + 条件行（字段 × contains/regex/prefix/glob）+ 可选 reason；保存前客户端预检（空名/空白/重名），宿主端权威校验（名称、可编译性）失败即报错不落盘。
- 守卫与 fail-loud 语义全部沿用；改名/删除经整表替换持久化（见上）。
