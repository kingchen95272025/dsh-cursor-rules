# dsh-cursor-rules

> 让 DeepSeek Harness 具备 Cursor 的**mdc 规则加载机制**：把 `.cursor/rules/**/*.mdc` 按 Cursor 的四类
> 规则语义载入 Agent 上下文，并在 Web GUI 提供「Cursor 规则」按钮与设置页。

[English](README.md)

---

## 结论先行

- **一句话**：装上本插件后，DSH 会像 Cursor 一样读取 `.cursor/rules` 下的 `.mdc` 规则并遵守它们，不必再在提示词里手动 @ 规则文件。
- **语义完全对齐 Cursor**：`alwaysApply` / `globs` / `description` 三要素决定一条规则何时进入上下文，文件名不参与判断。
- **两处 UI**：左栏导航的「Cursor 规则」行（占满主面板的整页）与设置面板里的「Cursor 规则」分节，可查看每条规则的 frontmatter、正文与开关状态。
- **零第三方依赖**：frontmatter 解析与 glob 匹配都在插件内自实现，bundle 自洽运行，无构建步骤。

## 规则语义（与 Cursor 一致）

| 类型 | frontmatter | 何时进入 Agent 上下文 |
| --- | --- | --- |
| **Always** | `alwaysApply: true` | 会话开始即注入完整正文 |
| **Auto Attached** | `alwaysApply: false` + `globs: [...]` | 本会话「已触达文件」命中任一 glob 时追加 |
| **Agent Requested** | `alwaysApply: false` + `description` | 只登记进「按需目录」，Agent 判断相关时自行 `read` 该文件 |
| **Manual** | 其余 | 只登记进「按需目录」 |

其他约定：

- **来源与顺序**：用户级目录在前（默认 `~/.dsh/rules/**` 与 `~/.cursor/rules/**`，按 `userRuleDirs` 给定顺序扫描），项目根（由 `.git` 等 marker 判定）到会话 cwd 的各层 `.cursor/rules/**` 在后；项目层内部同名 id 以更具体（更靠后）的一份为准。
  > 用户级规则的 id 形如 `~/<相对 homedir 的路径>`，**目录名包含在 id 内**，因此 `~/.dsh/rules/x.mdc` 与 `~/.cursor/rules/x.mdc` 是两条独立规则、都会注入，**不存在跨目录覆盖**；`userRuleDirs` 只决定扫描顺序。
- **frontmatter 形态**：`globs` 支持 YAML 块列表、行内数组与 Cursor 的逗号分隔字符串；`alwaysApply` 支持布尔与 `"true"`/`"false"`。
- **增量投递**：首次投递完整基线；之后只在「规则集合或其内容发生变化」时投递增量（新增/更新规则正文，或规则退出的移除通知），避免把几百 KB 规则反复塞进历史。
- **预算**：单次注入不超过 `maxBytes`（默认 131072 字节）；超预算的规则被省略，并在注入内容里明确列出省略清单。
- **框边界**：规则正文里的 `</system-reminder>` 会被转义，仓库内容无法突破插件自有的 `<system-reminder>` 框。

## 安装

在 DSH 插件市场搜索「Cursor 规则」安装 bundle；或在命令行从仓库安装：

```sh
dsh plugin add github:kingchen95272025/dsh-cursor-rules   # 非默认 profile 加 --profile <名称>
```

本包是标准 bundle：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 插入 `dsh-cursor-rules` 行；宿主半边是包主入口，`dsh.client` 声明让 Web 端加载 `./client` 作为浏览器半边。无构建、无安装脚本。

> 从旧版手工安装迁移：先删掉 profile `cordis.patch.yml` 里手写的 `cursor-rules` 行，以及 `<profileDir>/node_modules/` 下的旧拷贝，否则规则会被注册两次。

## 配置

行内 `config`（每个键都可省略）：

```yaml
- insert:
    - id: dsh-cursor-rules
      name: dsh-cursor-rules
      config:
        enabled: true            # 总开关；false 时宿主半边完全不注册
        includeUserRules: true   # 是否加载用户级规则目录
        userRuleDirs:            # 用户级规则目录（按扫描顺序）
          - ~/.dsh/rules         # DSH 自有全局规则位
          - ~/.cursor/rules      # Cursor 兼容位
        maxBytes: 131072         # 单次注入的字节预算
        trackTouches: true       # 是否按「已触达文件」自动附加 globs 规则
        projectRootMarkers:      # 项目根标记
          - .git
        httpPath: /cursor-rules  # 面板使用的 HTTP 前缀路由
        stateFile: cursor-rules.json  # 开关状态文件名，落在 $DSH_HOME 下
```

> `config` 在 DSH 的 patch 语义里是**整体替换**而非深合并：覆写这一行时必须把要保留的键一并写出。

开关状态持久化在 `$DSH_HOME/cursor-rules.json`：

```json
{
  "version": 1,
  "disabled": [".cursor/rules/global.mdc"]
}
```

## 使用

### 1. 自动遵守规则（宿主半边）

无需任何手动操作。首个请求会把生效规则作为一条 `<system-reminder>` 用户消息折进上下文，例如：

```markdown
<system-reminder>
The following Cursor rules (.cursor/rules) may be relevant to your work. Use them as guidance when applicable.
More specific rules take precedence over broader ones. They do not override system, developer, or direct user instructions.

Cursor rule: .cursor/rules/global.mdc (alwaysApply)

<规则正文>

The following Cursor rules are available on demand. Read the rule file when the task touches its area:

- .cursor/rules/consumer-conventions.mdc (auto: app/Domain/**/Console/Consumers/**/*.php)
- .cursor/rules/import-conventions.mdc (agent-requested) — 导入层规范…
</system-reminder>
```

当 Agent 通过 `read` / `write` / `edit` 触达到某个文件时，命中该文件 glob 的 Auto Attached 规则会在**下一步**以增量形式追加进来；规则退出时投递移除通知。

### 2. 面板（浏览器半边）

- **左栏导航 → Cursor 规则**：`sidebar.panellist` 的行（同一 id 寻址 `main` 座位的整页），列出全部规则、类型标签、globs、描述与开关。
- **设置面板 → Cursor 规则**：同一套列表以分节形式复用。
- 点「查看」在该行下方就地展开完整正文（渲染 Markdown，再点「收起」收回），不打断当前浏览位置。
- 关闭某条规则后，它不再进入注入集合（Always 与 Auto 都受影响）。

## 验证

```sh
npm test          # 48 项断言：frontmatter、glob、发现、选择、注入计划、开关
```

测试自己在系统临时目录里搭一份 `.cursor/rules` fixture，因此在任何机器上都能跑通，不依赖真实仓库。

宿主半边（对着运行中的 profile）：

```sh
curl -s "http://127.0.0.1:<端口>/cursor-rules/rules?sessionId=<sessionId>" | head -c 400
```

返回 JSON 即挂载成功，`version` 字段是插件代码版本——**用它判断当前进程跑的是哪一版代码**。1.1.0 上该路由返回 `200`，本会话正在遵守的用户级规则会出现在返回的规则列表里。

`dsh web` 启动时会打印 URL（默认端口 19387），桌面版应用用的是另一个端口。

浏览器半边：桌面版 GUI 的页面源是自定义协议 `dsh-app://app`，`curl http://127.0.0.1:<端口>/` 只会返回
`401 dsh web authentication required`，**不能用 curl 判断浏览器半边是否加载**。可在「设置 → 插件管理」里
直接看这两处座位，或用平台暴露的实况槽位树（`cordis_inspect_query`，`provider: "Slots"`、`method: "listSubTree"`）核对：

```
input={"root": "settings.section"}   # 期望 {"id":"cursor-rules","order":30,"active":true}
input={"root": "sidebar.panellist"}   # 期望 {"id":"cursor-rules","order":30,"active":true}
input={"root": "main"}                # 期望注册了 "cursor-rules" 这个 key
```

路由注册用 `ctx.inject(['webServer'], …)` 而不是一次性 `ctx.get('webServer')`：冷启动时 `apply` 可能早于
`webServer` 就绪，一次性写法会静默跳过注册，表现为重启后 404。改动这段代码时请保留该写法。

## 实现结构

| 文件 | 职责 |
| --- | --- |
| `lib/rules.js` | 规则引擎（纯逻辑、零依赖）：frontmatter 解析、glob 编译与匹配、规则发现、四类规则选择、增量注入计划与渲染 |
| `lib/index.js` | 宿主半边（Cordis 插件）：`agent/pre-step` 注入、`tools/result` 与 `fs/observed` 触达采集、`ctx.webServer` 上的面板 JSON 接口、开关状态持久化 |
| `lib/client.js` | 浏览器半边（手写、无构建）：`window.__ModuleLoader__.load({ id, factory })`，注册 `sidebar.panellist` 行、配套的 `main` 面板与 `settings.section` 分节 |
| `cordis.patch.yml` | bundle patch：插入 `dsh-cursor-rules` 行 |
| `locale/{en,zh}.json` | Plugin Manager 的标题、描述与详情文档 |
| `test/smoke.mjs` | 自带 fixture 的可移植冒烟测试（48 项断言） |

### 宿主侧注入时序

```
agent/pre-step (waterfall)
   └─ next() 拿到本轮 entering 批次 decision
      ├─ collectRules(cwd)            # 用户级 + 项目级 .mdc 发现与解析
      ├─ selectRules(rules, touched)  # Always / Auto Attached / 按需目录
      ├─ planInjection(previous)      # 与上次投递状态做差 → 增量
      └─ 把 createUserMessage(...) 插到最后一条「被认领消息」之后
```

`source` 使用插件自有的 `kind: 'cursor-rules'`，并携带 `entries`（全量 id+指纹）与 `catalogDigest`，因此：

- **会话恢复**时可从历史消息重建「已投递状态」，不会重复注入；
- **压缩（compaction）**后历史里不再有本插件消息时，会重新投递完整基线；
- 同一轮内 `pre-step` 重复执行时，内存态兜底抑制重复投递。

## 已知取舍

- **触达来源**是 `read`/`write`/`edit` 的 `file_path` 与 `fs/observed` 的 `displayPath`，不解析任意 shell 命令的副作用——和 `dsh-agent-instructions` 的取舍一致。
- **Auto Attached 依赖「已触达」而非「将要修改」**：Cursor 也会参考你在对话里 @ 的文件，本插件只用文件系统触达信号，因此附加时机略保守（下一步而非同一步）。
- **面板接口无鉴权**：桌面版 web shell 本身要求 `dsh web` token（`GET /` 返回 401），但本插件注册的是 `webServer` 的**命名前缀路由**，会在 token 闸门之前命中，因此该接口对本机任何进程开放。暴露面已压到最小——接口只会读取 `*.cursor/rules/**/*.mdc`，不接受任意路径读取；且 `webServer` 默认仅绑定 `127.0.0.1`。如需彻底关闭，把 `config.enabled` 设为 `false` 或卸载插件。
- **插件模块不热重载**：`dsh-base` 给 `hmr` 的配置是 `root: []`，即 profile 只监听 `cordis.patch.yml` / `package.json`，不监听插件模块；默认 `ignored` 又含 `**/node_modules`。因此改 **patch/config** 会自动热挂载，改 **`lib/*.js`** 必须重启 DSH（Node 的 ESM 模块缓存会让「重挂载」复用旧模块实例）。判断依据就是响应里的 `version` 字段。

## 参考实现

- `@deepseek-ai/dsh-agent-instructions` —— 同为工作区指令注入器，本插件沿用其「source 自有 + 正文逐字 + 框标签转义 + 增量投递」约定。
- `@deepseek-ai/dsh-client-ui-skill` / `@deepseek-ai/dsh-client-ui-cordis` —— 客户端半边手写 bundle、`ctx.slots.inject` 座位注册与侧边栏入口的范例。

## 许可

[MIT](LICENSE)