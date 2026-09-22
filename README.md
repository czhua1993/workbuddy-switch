# workbuddy-switch

WorkBuddy、CodeBuddy IDE、CodeBuddy CLI 与 VS Code CodeBuddy 插件账号切换桌面 App（Tauri），四者均支持国内版 / 国际版，并提供积分到期与 Token 用量监控。

<p align="center">
  <img src="public/icon-transparent.png" alt="WorkBuddy Switch 图标" width="128" />
</p>

多账号共享登录态，一键切换 WorkBuddy 登录账号。**会话复制**：把当前账号的会话以新 id 复制给目标账号，源账号数据不受影响，云端归属目标账号。

**在线演示**：[打开 GitHub Pages 演示](https://changexbc.github.io/workbuddy-switch/)（只读演示；账号、积分与请求记录均为虚构数据，所有业务操作均已禁用）

## 快速开始

### npm 安装（webui）

```bash
npm i -g workbuddy-switch
workbuddy-switch              # 启动本地服务 + 自动打开浏览器
workbuddy-switch status       # 终端查看当前账号
```

webui 界面与桌面 App 一致：WorkBuddy / CodeBuddy CLI / CodeBuddy IDE / VS Code CodeBuddy 插件账号切换、积分到期监控、自动签到、会话复制、Token 统计与 token 保活。

### 桌面 App

前往 [GitHub Releases](https://github.com/changexbc/workbuddy-switch/releases/latest) 下载对应平台的安装包：

| 平台 | 安装包 | 安装方式 |
| --- | --- | --- |
| macOS Apple Silicon（M 系列，arm64） | `workbuddy-switch_<版本>_aarch64.dmg` | 打开 DMG，将 `workbuddy-switch.app` 拖入「应用程序」 |
| macOS Intel（x86_64） | `workbuddy-switch_<版本>_x86_64.dmg` | 打开 DMG，将 `workbuddy-switch.app` 拖入「应用程序」 |
| Windows x64 | `workbuddy-switch_<版本>_x64-setup.exe` | 运行安装程序并按提示完成安装 |
| Linux x64 | `workbuddy-switch_<版本>_amd64.deb` / `workbuddy-switch_<版本>_amd64.AppImage` | Debian/Ubuntu 安装 `.deb`；其他发行版可给 AppImage 添加执行权限后直接运行 |

macOS 首次启动若提示无法验证开发者，先在 Finder 中按住 Control 点击应用并选择「打开」，或前往「系统设置 → 隐私与安全性」选择「仍要打开」。仅当安装包来自上述官方 Releases、且系统仍提示「已损坏」时，再执行：

```bash
xattr -rd com.apple.quarantine "/Applications/workbuddy-switch.app"
```

应用能启动但切换账号时提示无权限，请参阅下方 [macOS 权限说明](#macos-权限说明)。

另有 npm / webui 版本可在浏览器中使用，见文末 [npm / webui 版本](#npm--webui-版本)。

## 功能

| 模块 | 说明 |
| --- | --- |
| 账号管理 | OAuth 扫码登录、从本机导入、手动添加 token、删除账号 |
| 账号切换 | 备份认证文件 → 关闭 WorkBuddy → 写入目标账号 → 重启，切换过程实时进度反馈 |
| 会话复制 | 将当前账号勾选的会话以新 id 复制给目标账号（jsonl 正文 + `workbuddy.db` 索引 + edge-sync 注册） |
| 自动签到 | 默认开启；可设置签到时间段，窗口内随机时刻自动签到（需 App 在窗口附近运行）；一键全部签到；30 天签到日志 |
| Token 保活 | 惰性刷新（操作前不足阈值刷新）+ 每日保活（默认每天无条件刷新一次，阈值 >0 时仅刷新剩余不足该天数的账号），避免 refresh token 过期 |
| 积分到期查询 | 自动查询每个账号的 WorkBuddy 积分资源、剩余量和到期时间；7 天内到期高亮并按到期优先排序 |
| 积分统计 | 汇总 WorkBuddy 官方请求用量，展示每日趋势、模型分布、账号消耗和请求明细；官方数据不可用时明确回退到本地余额快照观察 |
| Token 统计 | 分别查看 WorkBuddy、CodeBuddy CLI 与 CodeBuddy IDE / VS Code CodeBuddy 插件的 Token 总览；输入、输出、缓存读写按 K/M/B 展示，趋势图同时呈现每日 Token 构成与调用次数，并提供构成占比、热力图、项目/模型 Top 10 和会话排行 |
| CodeBuddy CLI | 与 WorkBuddy 复用同一账号库，但默认账号独立；macOS/Linux 通过 `apiKeyHelper`，Windows 通过 `settings.json.env.CODEBUDDY_AUTH_TOKEN` 设置后续会话使用的账号；手动切换会先关闭正在运行的 CLI，因此**立即生效**（不再需要重启 CLI） |
| CodeBuddy CN IDE | 复用同一账号库，向 `CodeBuddy CN` 桌面客户端注入 Safe Storage 凭证（`state.vscdb` / `planning-genie.new.accessTokencn`）并重启 IDE；与 CodeBuddy CLI 无关 |
| VS Code CodeBuddy 插件 | 复用同一账号库，向 VS Code 内 `tencent-cloud.coding-copilot` 插件注入 Safe Storage 凭证（`state.vscdb` / `Tencent-Cloud.coding-copilot.new.accessToken`）；VS Code 正在运行时会自动关闭并在写入后重新打开（可关闭该行为改为手动退出） |
| VS Code CodeBuddy 插件会话复制 | 切换 VS Code CodeBuddy 插件账号时可勾选把「当前插件账号」的会话以**新 id** 复制到目标账号（加法，源账号不变）；仅复制 `history` 正文与索引，不含 diff / 文件树 / 待办；按工作区 hash 分组，Windows 已实测、macOS/Linux 未实测 |
| 自动轮换 | 后台定时把 CodeBuddy CLI 的后续启动账号设为积分最紧迫（最早到期）的账号；只在没有 CodeBuddy CLI 会话在运行时才切，被跳过时会（每日最多 5 次）提示 |
| 自动更新 | 配置 GitHub Releases 源检查新版本；整包更新经签名校验（tauri-updater） |
| 权限检测 | macOS 授权引导（App 管理 / 完全磁盘访问拖拽授权 + 自动检测） |

## 使用

1. **添加与导出账号**：账号页 →「OAuth 扫码登录」「导入本机账号」「导入备份」；「导出」可将勾选账号备份为 JSON
2. **切换账号**：账号卡片 →「切换」，可勾选复制当前会话
3. **自动签到**：账号页可直接开关；设置页可调整保活参数、立即签到并查看日志
4. **查看积分到期**：账号页会自动查询各账号积分资源；点击「刷新积分」可手动更新，临近到期的资源会高亮，并把快过期账号按最近到期时间排序，最前面的标记为「建议优先使用」
5. **查看积分统计**：侧栏进入「积分统计」，查看总览、近 30 天趋势、模型分类、账号消耗与请求明细；筛选账号或时间范围不会重复请求官方接口，点击「刷新统计」才会重新采集
6. **查看 Token 统计**：侧栏进入「Token 统计」，选择 WorkBuddy、CodeBuddy CLI 或 CodeBuddy IDE / VS Code CodeBuddy 插件，查看输入、输出、缓存读写和调用次数。图表使用 K/M/B 单位，趋势图将每日 Token 总量与构成、调用次数合并展示；项目、模型和会话排行默认显示 Top 10，不足 10 项时按实际数量展示。
7. **CodeBuddy CN IDE**：账号卡片可一键切换国内版桌面客户端（www.codebuddy.cn）。切换会关闭并重启 CodeBuddy CN，把所选账号写入本机 `~/Library/Application Support/CodeBuddy CN` 的登录态；首次使用前请先手动打开并登录一次以生成 Keychain Safe Storage。与下方 CLI 切换相互独立。
8. **VS Code CodeBuddy 插件**：账号卡片可切换到 VS Code 内的 CodeBuddy 插件（`tencent-cloud.coding-copilot`，与 CN IDE 同源 www.codebuddy.cn）。点击后打开弹窗，可勾选「复制会话到目标账号」把当前插件账号的会话一并带过去；确认后写入凭证。VS Code 正在运行时会先自动关闭编辑器、写入后再重新打开（也可关掉弹窗里的「自动关闭并重开」开关，改为自己完全退出后切换）。插件从未登录也可以直接切换，切换后打开 VS Code 即为目标账号。与 CodeBuddy CN IDE、CodeBuddy CLI 相互独立。
9. **CodeBuddy CLI**：账号页可一键接入/更新认证。macOS/Linux 使用 `apiKeyHelper`，Windows 使用 `~/.codebuddy/settings.json` 的 `env.CODEBUDDY_AUTH_TOKEN`（保留其他配置，不依赖 `.cmd` 跳板）。「切换 CodeBuddy CLI」会先二次确认：确认后**先关闭正在运行的 CodeBuddy CLI**（不含 IDE）再写入默认账号，因此切换立即生效——重新打开 CLI 后新账号即生效，当前会话会被中断。接口入参 `closeRunningCli` 已废弃（保留接受但忽略）。
10. **自动轮换**：设置 → CodeBuddy CLI 自动轮换，开启后后台按间隔检查，并把积分最紧迫的账号设为后续会话的默认账号（策略见下）。检测到有 CodeBuddy CLI 会话在运行时本次轮换会跳过，并在当日最多提示 5 次；重启 CLI 后新账号才会生效。
11. **更新**：应用会自动检查公开 GitHub Releases；发现新版本后可在左下角直接升级，也可从设置页打开 Release 页面手动下载。

### 切换 VS Code CodeBuddy 插件账号时复制会话

在账号卡片点击 VS Code CodeBuddy 插件目标会打开「切换 + 复制会话」弹窗：可开启「复制会话到目标账号」，按工作区分组勾选要带走的会话（仅列出含正文的历史）。VS Code 正在运行时，wb-switch 会先自动关闭编辑器（勾选复制时同样是先关闭、再复制、最后写入目标账号凭证），写入完成后重新打开。

- **编辑器会被自动关闭并重开**：VS Code 正在运行时，弹窗会说明将先关闭编辑器再写入凭证，随后自动重新打开（未保存内容由 VS Code 自身的保存提示保护；若弹出提示请先处理，最多等待 60 秒）。不想要自动操作时，可在弹窗里关掉「自动关闭并重开」，改为自己完全退出 VS Code 后切换。
- **复制会话要求编辑器处于退出状态**：会话文件由运行中的插件写入，复制动作本身仍必须在 VS Code 完全退出后进行。开启「自动关闭并重开」时由 wb-switch 先关闭编辑器再复制，不需要自己操作；关掉该开关时才需要先手动完全退出 VS Code。
- **加法不是移动**：复制会生成**全新的会话 id**，只写目标账号目录，**绝不修改或删除源账号数据**；对同一工作区重复复制只会新增副本。
- **复制范围**：仅 `history` 正文与索引；**不复制** diff / 文件树 / 待办（`check-point` / `file-tree` / `plan-task`）。
- **工作区分组**：目录名为 `md5(工作区)`，无法反解为路径，弹窗按「工作区 #N + hash 前 8 位」展示。
- **平台**：Windows 路径已实测；macOS / Linux 按同一相对布局 **best-effort 推导（未实测）**。
- 失败逐条隔离：单条失败只跳过该条并在结果中列出原因，其余条目继续；目标工作区索引在写入前会备份到 `~/.wb-switch/backups/vscode-sessions/<时间>/`。

## 界面预览

### 管理 WorkBuddy 与 CodeBuddy 账号

账号卡片集中展示登录状态、积分余额和到期资源，临期积分直接标注在对应卡片内，并按紧迫程度优先排列。

![账号管理页面（账号信息已脱敏）](docs/images/accounts-overview.png)

### 积分统计

积分统计页展示官方请求用量、每日趋势、模型分布、账号消耗和请求明细，数据来源与更新时间会明确显示。

![积分统计页面](docs/images/credit-statistics.png)

### Token 统计

Token 统计页按来源展示 Token 总览和每日趋势，覆盖 WorkBuddy、CodeBuddy CLI 与 CodeBuddy IDE / VS Code CodeBuddy 插件：输入、输出、缓存读写使用 K/M/B 紧凑单位，趋势图用堆叠柱表示每日 Token 总量与构成，用虚线表示调用次数；同时提供 Token 构成占比、活跃热力图、项目/模型 Top 10 和会话排行，帮助快速定位主要消耗来源。

![Token 统计页面](docs/images/token-statistics.png)

## macOS 权限说明

切换账号需要写入 WorkBuddy 认证文件，macOS 要求授权「App 管理」（或「完全磁盘访问」）：

1. 首次切换报「无权限」时，点「打开系统设置」
2. 优先在 **App 管理** 里打开 workbuddy-switch 开关；若没有，则去 **完全磁盘访问** 把 workbuddy-switch 拖进带箭头的框
3. 授权后重启本应用生效；设置页「权限检测」可随时验证

## npm / webui 版本

```bash
npm i -g workbuddy-switch
workbuddy-switch              # 启动本地服务 + 自动打开浏览器
workbuddy-switch status       # 终端查看当前账号
```

界面与桌面 App 一致，功能覆盖上方全部模块。webui 模式下的 macOS 权限由启动服务的终端进程决定；若终端已授权完全磁盘访问则无需额外操作。

## 致谢

感谢 [Linux.do](https://linux.do) 社区。

## 许可

[MIT](./LICENSE)
