# dsh-custom-permission

DeepSeek Harness（DSH）的**外部权限插件**：以「命名预设」为单位，为工具调用与 shell 命令配置自动允许 / 自动拒绝规则、为文件系统工具配置沙箱之外的额外可写路径，并提供 Web 面板可视化地查看、切换、新建、编辑与删除预设。

## 介绍

插件把权限整理成一张**预设表**：每个预设是一整套权限，**同一时刻只有一个预设生效（进程级，对所有会话一致）**，默认激活名为 `default` 的预设。每个预设可配置四类内容：

1. **自动允许（allowRules）**：命中规则的工具调用（tool）与命令（如 bash/pwsh 的 command）不再弹审批、直接放行；
2. **自动拒绝（denyRules）**：命中规则的工具调用与命令直接失败，模型看到拒绝原因；优先级高于允许；
3. **自动放行审批工具（allowApprovals）**：名单内工具的审批请求（含文件系统的沙箱升级审批）自动通过；
4. **额外可写路径（extraWritableRoots）**：`workspace-write` 沙箱下允许文件系统工具读写会话工作区之外的指定路径（只影响文件系统工具，不影响 shell 进程沙箱）。

安装即自带一份**空的 `default`**（零拦截：无规则、无自动放行、无额外路径），保证**全新 profile 装完不写配置也能启动**；面板里的改动与切换会持久化到 `settings.yaml`（`custom-permission` 命名空间），重启后保留。

## 安装方法

前置：已安装 `dsh` CLI（建议 npm 最新发布版，本插件按其适配）。

```sh
# 方式一：本地目录 / npm tarball / 已发布的包
dsh plugin --profile <name> add <插件包路径或包名>

# 方式二：从 git 直接安装（GitHub 用户/组织与仓库）
dsh plugin --profile <name> add github:Pepper256/dsh-custom-permission
```

- 首次使用会初始化 profile（自动带上 `@deepseek-ai/dsh-base`），并把插件加进 bundles；该插件是 bundle：它**禁用 base 的沙箱文件系统后端（`fs-sandbox`），并作为唯一的 `ctx.fs` 提供者**，再挂载上面的权限策略。
- **从 git 安装**：git 拿到的是源码，安装时会执行包内的 `prepare` 脚本自包含构建产物；pnpm ≥10 首次会拒绝执行，按提示把打印出的包 key 加入该 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`（例如 `dsh-custom-permission@…: true`）后重跑 `add`。该白名单等于授权包源码在安装时执行，请只信任来源并建议固定 commit（`add github:Pepper256/dsh-custom-permission#<sha>`）。

### 自定义预设（可选）

想替换/修改默认规则，在 profile 的 `cordis.patch.yml`（home 级覆盖 profile 级）写一条 `custom-permission` 行即可——**该行会整行替换 bundle 自带的 config**（层叠按 id 后写胜出，不做 key 合并；写了本行后 `presets.default` 仍必填）：

```yaml
- id: custom-permission
  config:
    presets:
      default: {}                      # 必填；空对象 = 零拦截
      locked:                           # 其他预设，可随时切换
        denyRules:
          - tool: 'pwsh'
```

卸载：`dsh plugin --profile <name> remove dsh-custom-permission`。

## 使用说明

两个入口，操作互通：

- **Web 面板（推荐）**：聊天输入框右侧的 ⚙ 按钮——列出预设（当前项有标记）、点预设名即切换、点 ✎ 编辑、点 🗑 两步删除、点底部「＋ 快捷添加」新建。详细逐步操作见 [docs/UI-使用说明.md](docs/UI-使用说明.md)。
- **命令**：`/custom-permission presets` 查看预设列表；`/custom-permission preset <名字>` 切换；裸 `/custom-permission` 显示当前预设的全部规则。

### 预设规则里各字段的含义

面板与 YAML 一一对应。自动允许 / 自动拒绝的每条规则 = **工具模式** + 可选的**条件**（针对工具参数）：

- **工具模式**（YAML 的 `tool`）：匹配哪个工具，支持三种写法——

| 写法 | 说明 | 示例 |
|---|---|---|
| 精确名 | 只有同名工具命中（大小写敏感） | `bash`、`write`、`web_search` |
| glob | 含通配符按 glob 匹配（`*` 不跨 `/`，`**` 可跨，另支持 `?` `[set]` `{a,b}`） | `fs_*`、`{read,write}_*` |
| 正则 | 以 `regex:` 开头，后接 JavaScript 正则 | `regex:^web_` |

- **条件**（YAML 的 `when`）进一步限定"什么样的参数才命中"，三要素：
  - **字段**：要检查的工具参数名，用点路径访问嵌套值（shell 命令填 `command`、文件系统目标填 `path`，其他工具填其参数名如 `url`）；参数整个字符串参与比较，参数缺失或非字符串则该条件不命中。
  - **类型**：字段值按哪种规则比较——

| 类型 | 含义 | 示例（字段 `command`） |
|---|---|---|
| contains | 值作为子串出现即可 | `DANGER_MARKER` |
| regex | JavaScript 正则（不自动锚定，全串匹配请用 `^…$`；保存时做语法校验） | `^git ` |
| prefix | 字段值以该文本开头 | `git status` |
| glob | 字段整个值按 glob 匹配 | `git *` |

  - **值**：比较文本；留空的行保存时丢弃。多条条件之间是 **AND**（都命中才算命中）。

- **拒绝原因**（仅自动拒绝规则，YAML 的 `reason`）：可选，命中时作为工具错误展示给模型，覆盖默认的 `blocked by dsh-custom-permission rule #N (tool "...")`。
- 规则按列表顺序求值、**第一条命中生效**；同一预设内 deny 优先于 allow；未命中的调用完整委托给 DSH 原有策略（hook、审批卡片等）。
- 预设名规则：非空、不含空白、≤64 字符、不与其他预设重名。

**其他两类**：

- **自动放行审批工具**：每行一个**精确工具名**（`fetch`、`write`；不支持通配符/正则）。审批请求（含沙箱升级）自动通过，请只在信任的工具上开启。
- **额外可写路径**：每行一个绝对路径（相对路径按后端 `cwd` 解析）；配置后模型上下文会提示这些路径"also writable"。

### 一条完整示例

想"拒绝 pwsh 里执行带 `rm -rf /` 的命令并给出原因"：

```
面板：＋ 快捷添加 → 预设名 demo → 「自动拒绝」＋ 添加规则
      工具模式: pwsh
      ＋ 添加条件: 字段 command | 类型 contains | 值 rm -rf /
      拒绝原因: 禁止递归删除
      → 创建并启用
```

等价 YAML：

```yaml
- id: custom-permission
  config:
    presets:
      default:
        allowRules: []
        denyRules:
          - tool: 'pwsh'
            when: { command: { contains: 'rm -rf /' } }
            reason: '禁止递归删除'
        allowApprovals: []
        extraWritableRoots: []
```

### 持久化与注意点

- 未在界面改过预设时，面板显示的是配置里的预设；一旦在界面新建/编辑/删除过，整张预设表会存入 `settings.yaml`（`custom-permission` 命名空间）并以其为准（之后改配置文件不再自动合并；想回到配置文件请清掉该命名空间的 `presets`）。
- 删除预设不能删当前激活项或最后一个；切换目标、写入的规则或名称非法时会报错并保留原状态，绝不静默回退。
- 默认自带的 `default` 是**空预设（零拦截）**：只保证开箱可启动，不自动放行或拒绝任何调用；需要策略时按"自定义预设"写入自己的规则。
- 提醒：「自动允许」只让命中的调用免于自身审批，**不改变 dsh 自己的沙箱/审批配置**。dsh 审批设为 read-only 时，普通写入会被沙箱围栏直接拒绝（不产生审批）；要让 agent 能写入，请把工具加入「自动放行审批」——带 `sandbox_permissions` 的升级写入审批会自动通过。
