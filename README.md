# dsh-custom-permission

DeepSeek Harness（DSH）的外部插件（out-of-tree plugin）。用户在插件配置里自定义三类权限策略：

1. **自动允许**：命中规则的工具调用（tool）与 shell 命令（command）不再弹审批、直接放行；
2. **自动拒绝**：命中规则的工具调用与 shell 命令直接失败，模型看到拒绝原因；
3. **沙箱外文件访问**：配置额外可写路径，DSH 的文件系统工具可以读写会话工作区之外的指定路径。

实现完全基于 DSH 的公开扩展点，不修改 DSH 仓库的任何源码或文档。

## 安装

```sh
dsh plugin --profile <name> add <本仓库路径>
```

插件在 `package.json` 中声明 `dsh.bundle`，安装后自动成为该 profile 的一层 bundle。bundle 的 `cordis.patch.yml` 会：

- 禁用 `dsh-base` 的 `fs-sandbox` 行（`@deepseek-ai/dsh-fs-sandbox`）；
- 插入本插件行（id `custom-permission`），成为唯一的 `ctx.fs` 提供者。

如果不用 bundle 而是手动组合：必须自行禁用 `dsh-fs-sandbox`，否则两个 `ctx.fs` 提供者会让启动 fail loud。

然后在 profile 的 `cordis.patch.yml`（home 级覆盖 profile 级）里写配置。配置是一张**命名预设表**，`default` 预设必填（四个字段都可以为空）：

```yaml
- id: custom-permission
  config:
    presets:
      default:                     # 必填，缺失即加载失败
        allowRules:
          - tool: 'bash'
            when:
              command: { regex: '^git (status|diff|log|push)' }
        denyRules:
          - tool: 'bash'
            when:
              command: { regex: 'rm -rf /' }
        allowApprovals: []
        extraWritableRoots:
          - 'E:\data\out'
      locked:                      # 其他预设：出错即抛错，绝不回退 default
        denyRules:
          - tool: 'bash'
          - tool: 'write'
        allowApprovals: []
        extraWritableRoots: []
```

`patchReload: live` 的 profile（默认的 web 等）下，改 patch 文件会热重载插件，预设表随重载生效。

## 预设切换

- 进程级切换：`/custom-permission preset <name>` 立即切换当前预设（下一条工具调用即按新预设判定）；`/custom-permission presets` 列出预设与当前激活项；裸 `/custom-permission` 显示当前预设的完整规则。
- 切换选择持久化到 `settings.yaml` 的 `custom-permission` 命名空间（热重载）：重启后保持上次选择；存储了未知预设名会使插件加载失败（fail loud，不静默回退）。
- 任何预设（含 `default`）校验/编译失败都抛错：加载时任一坏预设使插件加载失败并指名预设；切换目标不存在时报错、当前预设不变。

## 配置字段

每个预设包含四个字段（均默认 `[]`，可为空）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `allowRules` | `[]` | 自动允许规则；命中即放行（跳过 hook 类审批提问） |
| `denyRules` | `[]` | 自动拒绝规则；命中即失败，且在审批之后由单调守卫兜底，任何路径都绕不过 |
| `allowApprovals` | `[]` | 工具级自动放行名单：该工具的所有审批请求（**包括沙箱升级** `sandbox_permissions`）都自动 `allowed-once`。默认关闭 |
| `extraWritableRoots` | `[]` | 沙箱外额外可写路径（相对路径按后端 `cwd` 解析，加载时规范化为绝对路径） |

插件级（预设之外）：`cwd` / `diffBasisMaxBytes` 同 `dsh-fs-local`，语义与 `dsh-fs-sandbox` 一致。

### 规则匹配

每条规则 = 工具名模式 + 可选参数条件：

- `tool`：精确名（`bash`）、glob（`fs_*`，支持 `*` `**` `?` `[set]` `{a,b}`）、或 `regex:<pattern>`（JavaScript 正则）。
- `when`：按参数字段路径匹配（如 bash/pwsh 的 `command`、fs 工具的 `path`，支持 `a.b` 点路径）。每个字段的 Matcher 可组合（同一字段内 AND）：`regex`（正则在加载时校验）、`prefix`、`glob`、`contains`。多个字段之间 AND。字段缺失或非字符串时不匹配。
- 规则按配置顺序求值，**第一条命中生效**；自动拒绝优先于自动允许（deny > allow）。未命中的调用完整委托给其他策略（hook、审批卡片等）。

### 拒绝文案

默认拒绝文案为 `blocked by dsh-custom-permission rule #N (tool "<name>")`，作为工具错误进入模型上下文；规则可配置 `reason` 覆盖。

## 行为说明

- **自动允许的实现**：`tools/pre-execute` 瀑布（prepend）短路返回 `allow`，hook（如 Claude Code PreToolUse）不再弹问；`approval/request` 应答者（prepend）处理直达审批缝的请求——包括发生在工具体内部的沙箱升级 ask。命令级匹配在应答者里通过 `callId` 反查会话日志中已落盘的 `tool/call` 参数完成（`tool/call` 在工具体执行前落日志、审批发生在同一回合内，反查是确定性的）。
- **自动拒绝的实现**：同一监听器先查 deny（在弹审批之前短路），另有 `ctx.tools.guard()` 单调守卫在审批之后兜底——即使其他监听器或应答者放行，拒绝仍然生效。
- **审批策略 `never`**：`dsh-user-approval` 在应答链之前确定性拒绝，本插件无法绕过（也不绕过）；此时 `allowApprovals` 不生效。
- **沙箱外文件**：本插件替换 `ctx.fs` 后端，栅栏与 `dsh-fs-sandbox` 完全一致，唯一差异是 `workspace-write` 下放行集合 = 共享 `writableRoots(policy)`（会话工作区 + 平台临时目录）∪ `extraWritableRoots`。`read-only` 仍全拒、`danger-full-access` 仍不设防。拒绝渲染为熟悉的 `[sandbox: file access denied under <mode> mode]` 标记。
- **模型可见上下文**：配置了额外根时，`custom-permission:extra-roots` 运行时上下文（与 `sandbox:policy` 同一机制）让模型知道这些路径可写；未配置时贡献空文本。切换预设后下一条模型请求即看到新预设的额外路径。
- **`/custom-permission` 命令**：在具备命令注册表的组合（如 web profile）中注册——裸调用显示当前预设的规则与额外根，`presets` 列出全部预设，`preset <name>` 切换（进程级、持久化）。

## 手动测试

本仓库的开发机在 DSH 安装闭包之外，先把运行时依赖桥接进来（`@deepseek-ai/*` 裸导入按全局 dsh 安装的包解析；脚本自动定位全局安装，也可用 `DSH_CLOSURE` 覆盖）：

```sh
node scripts/link-closure-deps.mjs     # 幂等，可重复执行
pnpm exec tsc --build tsconfig.build.json    # 修改源码后重建 lib/
```

### 1. 创建独立测试 profile（不动线上 web profile）

```sh
dsh plugin --profile permtest add E:\deepseek-harness\dsh-custom-permission
```

该命令会新建 `$DSH_HOME/profiles/permtest`，bundles 自动带上 `@deepseek-ai/dsh-base` 与 `dsh-custom-permission`。要用 GUI 交互测试，再手动把 web-app 加进 bundles（编辑 `profiles/permtest/package.json`）：

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-custom-permission"] } }
```

### 2. 写测试配置（`profiles/permtest/cordis.patch.yml`，live 热重载）

Windows 上的 shell 工具是 `pwsh`（bash 仅在非 Windows）。示例（`default` 必填；`locked` 演示切换）：

```yaml
- id: custom-permission
  config:
    presets:
      default:
        allowRules:
          - tool: 'pwsh'
            when:
              command: { prefix: 'git status' }
        denyRules:
          - tool: 'pwsh'
            when:
              command: { contains: 'DANGER_MARKER' }
        allowApprovals:
          - 'write'
        extraWritableRoots:
          - 'C:\Users\31332\Documents\dsh-extra-test'
      locked:
        denyRules:
          - tool: 'pwsh'
          - tool: 'write'
        allowApprovals: []
        extraWritableRoots: []
```

### 3. 启动并验证

```sh
# 组合验证（无需启动应用）：fs-sandbox 应显示 disabled: true，并出现 custom-permission 行
dsh --profile permtest --dump-config | Select-String -Pattern 'custom-permission|fs-sandbox' -Context 0,3

# 一键「重建 lib + 重启 GUI」：改源码后重跑即可（无需重装；DSH_HOME 默认隔离在 %USERPROFILE%\.dsh-dev）
pwsh -File scripts\dev-loop.ps1          # 等价于下面的手动启动，且会先杀掉旧实例
dsh --profile permtest --port 0 --no-open   # 或手动启动（--port 0 自动选空闲端口）
```

### 4. 交互用例（在 permtest 的 GUI 会话里）

1. **自动拒绝命令**：让模型运行 `pwsh` 且命令里带 `DANGER_MARKER`（如 `echo DANGER_MARKER`）→ 工具结果应为 `Error: blocked by dsh-custom-permission rule #1 (tool "pwsh")`，且没有审批卡片。
2. **自动允许（审批路径）**：在 `/permission` 里把会话沙箱切到 `read-only`，让模型在 `extraWritableRoots` 之外建文件 → 它会收到沙箱拒绝并升级（`sandbox_permissions` + justification）→ 因 `allowApprovals: ['write']`（或命令级 allow 规则命中），升级 ask 被自动放行、不再弹卡片。
3. **沙箱外文件**：让模型直接写 `extraWritableRoots` 下的文件（如 `C:\...\dsh-extra-test\a.txt`）→ 直接成功；模型上下文里会出现 `also writable` 的额外路径说明。对比：不配置额外根时，同样的写会被 `[sandbox: file access denied under workspace-write mode]` 拒绝。
4. **预设切换**：输入 `/custom-permission presets` 查看预设列表；`/custom-permission preset locked` 切换 → 再让模型写文件，`write` 工具会被拒（locked 预设禁用了它）；`/custom-permission preset default` 切回。切换持久化在 `settings.yaml`，重启后保持。
5. **`/custom-permission`**：裸调用展示当前预设的完整规则与额外根。
6. 改 `cordis.patch.yml` 里的预设后无需重启（live 热重载）。

### 5. 回滚

```sh
dsh plugin --profile permtest remove dsh-custom-permission   # 从 bundles/依赖移除；删除整个测试 profile 目录亦可
```

## 开发

本仓库是独立 git 仓库，不在 DSH 的 pnpm workspace 内；开发/测试复用 DSH checkout 的工具链与源码映射（`tsconfig.base.json` 的 paths + project references）：

```sh
# 在 DSH 仓库根目录执行（用 DSH checkout 的 tsc / vitest）：
pnpm exec tsc -p dsh-custom-permission/tsconfig.json        # 类型检查（src + tests）
pnpm exec tsc --build dsh-custom-permission/tsconfig.build.json   # 构建 lib/types
pnpm exec vitest run --config dsh-custom-permission/vitest.config.ts   # 运行测试
```

测试覆盖：规则引擎单测（`tests/rules.spec.ts`）、后端栅栏测试（`tests/fs-backend.spec.ts`）、经 Loader 启动真实 cordis.yml 的组合测试（`tests/policy.real.spec.ts`，断言模型可见/持久化行为）。

运行时依赖（`@deepseek-ai/*`）在真实部署中按 DSH 安装闭包解析：插件目录位于安装闭包内（如直接装入全局 dsh）时天然可解析；位于闭包外时先运行 `node scripts/link-closure-deps.mjs` 桥接（见"手动测试"）。本插件 `package.json` 不声明对它们的依赖。

## 限制

- **bash/pwsh 进程沙箱不可扩展**：额外可写根只作用于文件系统工具；bwrap/Landlock/Seatbelt/Windows ACL 的写集合固定派生自 `writableRoots(policy)`，无外部扩展点。进程沙箱侧需要自定义 `ctx.sandbox` 提供者（逐平台重实现 runner 剖面）。
- **无 `callId` 的审批请求无法做命令级匹配**：退化为工具级规则（`allowApprovals`）或委托给下家。PTC 模式下子调用落盘为 `tool/code-dispatch` 而非 `tool/call`，同样无法反查。
- **`allowApprovals` 语义宽**：覆盖该工具的升级 ask（单次授权到 `danger-full-access`），请只在信任工具上开启。
- **挂载约束**：插件提供 `ctx.fs`，依赖 `ctx.sandboxPolicy`（与 `dsh-fs-sandbox` 相同），守卫注册依赖 `ctx.tools`，上下文贡献依赖 `ctx.systemPrompt`；base-backed profile 均具备。
- **切换是进程级**：`/custom-permission preset <name>` 切的是整个进程（所有会话），不做按会话粒度；会话事件持久化对外部插件不可用（DSH 的已知事件类型白名单），因此选择持久化在 settings 文档而非会话日志。切换的额外根上下文随下一条模型请求生效；正在执行中的调用按切换前规则完成。
