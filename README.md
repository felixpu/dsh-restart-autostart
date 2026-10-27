# dsh-restart-autostart

给 DSH（DeepSeek Harness）网页版加入三处进程控制入口：

- **手动重启**：设置面板**标题栏**上的红色「重启」按钮（紧挨「打开配置文件」左侧）。
  任何设置分页都能点到它，不必滚动到「通用」页去找；重启后页面自动探测服务恢复。
- **跟随系统启动**：「设置 → 通用」里的勾选框，写入系统自启条目
  （macOS launchd / Linux systemd / Windows 服务），开机拉起，并在崩溃后自动重启
- **一键升级 dsh 主程序**：「设置 → 通用」最下面（版本号之后）的版本行，检查到新版即可
  备份 → 安装 → 校验 → 重启；升级后起不来时守护**先隔离第三方插件**（安全模式），
  仍不行才回滚主程序

> **关于包名**：本包是 `dsh-restart` 的重命名版本 —— npm 上 `dsh-restart`
> 已被第三方占用（维护者 anweat），故更名为 `dsh-restart-autostart` 发布。

## 安装

```sh
dsh plugin --profile web add github:felixpu/dsh-restart-autostart
```

安装后重启宿主进程。

## 使用

### 手动重启

1. 打开**设置**（任意分页都可以）。
2. 点标题栏右侧、**「打开配置文件」左边**的红色「重启」按钮。
3. 二次确认后开始重启：按钮下方出现进度浮层（正在停止旧服务 → 正在启动新服务 → 已恢复）。

前端会轮询 `GET /dsh-restart-autostart/health` 判断服务是否恢复，因此重启过程无需手动刷新。

> 按钮用 danger 配色是刻意的：重启会中断所有正在进行的会话与后台任务。
> 失败或超时也会在同一个浮层里显示原因，并保持显示直到你手动关闭。

### 跟随系统启动

设置 → 通用 → 勾选「跟随系统启动」。

> 重启按钮搬到标题栏后，通用页这一行只剩自启开关，标题也随之改成「跟随系统启动」。

勾选后会向当前平台注册自启条目：

| 平台 | 机制 | 条目名 |
|---|---|---|
| macOS | launchd | `com.dsh.restartautostart.<port>` |
| Linux | systemd 用户级服务 | `dsh-restart-autostart-<port>.service` |
| Windows | 系统服务 | `dsh-restart-autostart-<port>` |

守护默认作用于**当前宿主进程所使用的端口**，因此不会与既有 3080 生产守护冲突。

> Linux 上依赖 systemd 用户实例的 **linger** 才能在无人登录时拉起；非 systemd 发行版（如 Alpine 用 OpenRC）不可用。

### 一键升级 dsh 主程序

1. 打开**设置 → 通用**，滚到最下面：「当前版本 x.y.z」之后多出一行 **「DSH 主程序版本」**。
2. 有新版本时这一行直接显示「有新版本 x.y.z」，右侧按钮是「升级并重启」；没有新版时按钮是「重新检查」，可手动查一次。
3. 点「升级并重启」并二次确认。行下方立刻出现阶段说明与进度条：备份 → 安装（几十秒）→ 校验 → 重启；重启完成后面板随页面一起刷新恢复。

> 进度条是**不确定进度**的扫光条，不是百分比 —— 备份/安装/校验的真实进度拿不到（npm 不吐百分比，宿主也没有阶段性回调），钉一个假的 30% 看上去就是「卡死了」。旁边那行「正在安装新版本… · 已等待 12s」才是可信信息，秒数取自**服务端记录的起点**，所以中途刷新页面也不会从 0 重来。
>
> 这一行**不重复显示当前版本**：平台就在它正上方显示「当前版本：x.y.z」。同理「上次升级成功…」只在 24 小时内播报，过期静默（历史在 `logs/upgrade.log`），否则会永久占据面板。

> 入口不在标题栏：平台本来就在通用页底部显示「当前版本」，升级贴着版本号放，语义上是一件事；标题栏只留「重启」一个动作。进度**内联**在这一行下方而不是浮层——点下去就必须立刻有可见变化，否则容易误以为「点了没反应」。

版本来源是 **GitHub Releases**（`dsh-v*` tag），不是 npm dist-tags —— npm 上存在「只改版本号、代码零改动」的僵尸发布，按它升级会出现「显示已是最新、实际代码没变」的假象。检查结果缓存 6 小时（未认证的 GitHub API 上限 60 次/小时），随时可点「重新检查」强制刷新。

**升级为什么不会把服务搞挂**，靠三道闸：

| 阶段 | 动作 | 失败后的处理 |
|---|---|---|
| 升级前 | 备份主程序**代码**（120KB，跳过 849MB 的 `node_modules`）+ 记录版本 | — |
| 安装后 | `npm i -g --prefix <宿主前缀>` 后立刻 `dsh --version` 校验版本 | 立刻回滚，**不重启**（旧进程还在跑，用户几乎无感） |
| 重启时 | 写「待验证」状态再重启；新宿主若能加载到本插件 ⇒ 升级成功，清除状态 | 宿主连续起不来 ⇒ 先进入**安全模式**隔离第三方插件；仍失败才**守护自动回滚**到旧版本 |

最后一条是关键：判据是「服务真的起来了」，而不是「npm 说装好了」。插件在重启那一刻已经随旧宿主消失，只有守护还能救场，所以回滚逻辑在 `lib/guard/guard.js` 里（`~/.dsh-restart-autostart/upgrade-pending.json` 是两者之间的唯一约定）。

> 升级只替换主程序，`~/.dsh/profiles/<name>` 里的插件文件一个字节都不会动。但新版本可能与某个第三方插件存在 API 不兼容 —— 那种情况下宿主起不来：先由守护进入安全模式把插件隔离掉，仍不行才自动回滚；如果宿主能起、只是某个插件功能异常，可在面板里手动「回滚」。

### 升级后起不来怎么办：安全模式

dsh 的启动容错只对**非核心条目**生效（详见 `dsh-app-boot` 的 `auditStartupEntries`）：
某个插件 patch 坏了核心条目，整棵插件树就会 fail-loud，宿主直接起不来。此时「回滚主程序」
虽然能救回服务，但肇事插件还在，下次升级必然再撞一次 —— 用户会被永久钉在旧版本上。

所以守护按**代价从小到大**逐级降级：

```
连续失败 3 次
   ├─ ① 进入安全模式：摘掉第三方 bundle，只剩官方包 + 本插件，保住新版本
   │     └─ 起来了 ⇒ 写入 safe-mode.json，界面上显示告警与「恢复插件」
   └─ ② 安全模式救不了（或已在安全模式又失败）⇒ 回滚 dsh 主程序
         └─ 仍不行 ⇒ 放弃自动拉起（退出码 0），留人工现场
```

隔离方式是把 profile 的 `dsh.profile.bundles` 砍到「官方包 + 本插件」——**不是**在 patch 里
写 `disabled: true`（那要精确命中条目 id 与父级路径，第三方插件树各不相同，写一次错一次），
也不是「只留官方两项」：

> **本插件自己必须在保留名单里。** 它也是 profile 里的一项第三方 bundle（`dsh-plugin-suite`）。
> 若被一起摘掉，`safe-mode.json` 就没有任何界面能读到，「恢复插件」这个按钮根本不存在
> —— 恢复手段必须能在它要恢复的故障里活下来（和守护放在磁盘上、不依赖宿主加载同理）。

界面上（设置 → 通用 → 版本行）会显示一条告警：被临时停用了几个插件、分别是哪些、
日志里解析出的疑似肇事插件、以及进入时间。两个动作：

- **恢复插件**：把 `dsh.profile.bundles` 按**进入前的原始顺序整份写回**并重启。
  用整份快照而不是「逐个插回」，是因为 bundles 是**有序**的（顺序决定 patch 层叠），
  按名字插回会静默改变覆盖关系 —— 服务起得来，但行为已经不对了。
  若肇事插件仍在、服务又起不来，守护会再次判定并重新进入安全模式，不会让人失去服务。
- **回滚到 x.y.z**：连主程序也退回去（安全模式下依然可用）。

升级**成功但在安全模式下启动**时，升级流水账会额外记一行「N 个第三方插件被临时停用」——
「升级成功」这句话在这种情形下只说了一半。

## 启动互斥：为什么两个实例不会抢端口

**手动重启**与**守护**是两条独立通道，都能拉起宿主。宿主被 kill 后到新宿主 `listen`
之间约有 **10 秒空窗**（新宿主在加载整棵插件树），这段空窗里端口是空的 —— 两个通道
会双双认定「现在就我，我上」，各自加载一遍插件树，最后只有一个能绑上端口，另一方报
`EADDRINUSE` 退出。日志里看着像随机故障，其实是必然。

解法是一把**「正在启动」跨进程锁**（`logs/starting-<port>.lock`，内容为纯十进制 pid）：

1. 手动重启脚本在**动手 kill 之前**先把自己写进锁；
2. 拉起新宿主后，立刻把锁改写成**新宿主的 pid**（脚本随即退出，新宿主才活得够久）；
3. **守护自己拉起宿主时也做同一件事** —— 否则这把锁只覆盖了插件这条通道，
   像 `~/.dsh/start.sh` 这样的第三方看不到「守护正在启动」，照旧会插进来抢；
4. 守护每次启动前读锁：**持有者进程还活着**就让路，等对方出结果；
   持有者已不存在 → 孤儿锁，随手清掉，自己接管启动。

判据是「锁里记的 pid 还活着没有」，**不是等待时长** —— 进程一死锁即失效，永远不会
留下需要人工清理的残锁，也不需要「等满 N 秒就假定安全」这类靠不住的启发式。

> 两条通道各自「正确执行」却互相踩踏，是这类故障最难查的地方：没有谁写错了代码。
> 让它们对同一件事（谁在启动）有共同认知，比在任一方加延迟或重试都可靠。
>
> 第三方重建了同一份判据也没问题 —— 关键是**持有者身份的约定**（pid 存 `logs/starting-<port>.lock`）
> 要对所有拉起路径统一，任何一方自己发明一套都会重新打开这个缺口。

## 数据落盘位置

全部落在 `~/.dsh-restart-autostart/`，与 `~/.dsh/` 完全分离：

| 路径 | 用途 |
|---|---|
| `~/.dsh-restart-autostart/guard.mjs` | 守护运行体（稳定落点） |
| `~/.dsh-restart-autostart/logs/` | 日志与计数 |
| `~/.dsh-restart-autostart/logs/starting-<port>.lock` | 启动互斥锁（持有者为存活进程时有效，自动失效无需清理） |
| `~/.dsh-restart-autostart/logs/upgrade.log` | 升级流水账（长期保留，供事后追查） |
| `~/.dsh-restart-autostart/upgrade-check.json` | 版本检查缓存（6 小时 TTL） |
| `~/.dsh-restart-autostart/upgrade-pending.json` | 「升级待验证」状态，插件与守护之间的唯一约定 |
| `~/.dsh-restart-autostart/upgrade-last.json` | 上次升级结果（重启后仍能告诉用户成没成） |
| `~/.dsh-restart-autostart/safe-mode.json` | 安全模式状态（守护写、插件读与解除）：被摘掉的 bundle、原始顺序快照、疑似肇事插件、诊断片段 |
| `~/.dsh-restart-autostart/backups/dsh-<版本>-<时间>/` | 主程序代码备份，保留最近 3 份 |
| `~/.dsh/profiles/web/package.json.bak-before-safe-mode` | 进入安全模式前的 profile 原文件（供手工恢复） |

守护脚本被安装到 `~/.dsh-restart-autostart/guard.mjs` 而非包内路径 —— 因为包目录会随 pnpm 重装、换 profile、`link:` realpath 而漂移。

## ⚠️ 从旧名 `dsh-restart` 升级

本包从旧版升级时，**运行时标识全部改名**，旧数据**不会自动迁移**：

| 项目 | 旧 | 新 |
|---|---|---|
| 配置目录 | `~/.dsh-restart/` | `~/.dsh-restart-autostart/` |
| 路由 | `/dsh-restart/*` | `/dsh-restart-autostart/*` |
| launchd Label | `com.dsh.restart.<port>` | `com.dsh.restartautostart.<port>` |
| systemd unit | `dsh-restart-<port>.service` | `dsh-restart-autostart-<port>.service` |

**升级步骤**：

1. 移除旧包（`dsh plugin --profile web remove dsh-restart`）
2. 安装新包并重启
3. 重新勾选一次「跟随系统启动」
4. **手动清理旧条目与旧目录**，否则可能残留两个守护进程抢同一端口

```sh
# macOS 示例
launchctl bootout gui/$(id -u)/com.dsh.restart.3080 2>/dev/null
rm -f ~/Library/LaunchAgents/com.dsh.restart.*.plist
rm -rf ~/.dsh-restart
```

## 宿主路由

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/dsh-restart-autostart/health` | 存活探针（前端轮询判断恢复） |
| `POST` | `/dsh-restart-autostart/restart` | 手动重启 |
| `GET` | `/dsh-restart-autostart/autostart/status` | 读取自启状态 |
| `POST` | `/dsh-restart-autostart/autostart/enable` | 启用自启 |
| `POST` | `/dsh-restart-autostart/autostart/disable` | 停用自启 |
| `GET` | `/dsh-restart-autostart/upgrade/status` | 读取升级状态（前端轮询进度，只读不联网） |
| `POST` | `/dsh-restart-autostart/upgrade/check` | 强制查一次 GitHub 最新版（绕开缓存） |
| `POST` | `/dsh-restart-autostart/upgrade/start` | 发起升级（异步执行，立即返回 `202`） |
| `POST` | `/dsh-restart-autostart/upgrade/rollback` | 回滚到上次升级前版本 |
| `POST` | `/dsh-restart-autostart/upgrade/safe-mode/clear` | 退出安全模式（装回被隔离的插件并重启；`{"restart":false}` 可只恢复不重启） |

## 测试

```sh
# 守护的失败分类（约 90s，其中一条要等 65s 的慢启动）
DSH_RESTART_GUARD="$PWD/lib/guard/guard.js" bash test/guard-classify.test.sh

# 安全模式：隔离范围、放弃策略、恢复顺序（秒级，全在临时假 HOME 里跑）
bash test/guard-safe-mode.test.sh

# 客户端组件渲染冒烟（秒级，不需要浏览器）
node test/client-render.test.js
```

- `guard-classify` 覆盖守护的失败分类：端口被占、起来了但非零退出、插件树加载失败、
  启动过慢、待命状态。
- `guard-safe-mode` 覆盖降级链：进入安全模式（只摘第三方、保留本插件与顺序）、
  已在安全模式再连败则放弃拉起、`clearSafeMode()` 按原始顺序整份写回。
  **全程使用临时假 HOME**，不碰真 `~/.dsh`、不碰真 profile。
- `client-render` 用极简 React 桩**真正执行** `UpdateRow` 组件，抓「裸文案键」与
  「onClick 抛异常」这两类历史故障（后者曾表现为「点了更新没反应、控制台报错」）。

> 守护测试需指定 `DSH_RESTART_GUARD` 指到包内守护脚本；未指定时默认读
> `~/.dsh-restart-autostart/guard.mjs`（需先在设置里启用过一次自启）。

## 展示元数据（locale）

`locale/en.json` 与 `locale/zh.json` 提供**插件展示元数据**（`meta.title` / `meta.description`），
Plugin Manager 与设置页**无需激活插件**即可读取，用于显示本地化的插件名与说明。
这与运行时 UI 文案（客户端 `ctx.locale.register`）是两套东西。

```json
{ "meta": { "title": "…", "description": "…" } }
```

⚠️ 两个容易漏的点（漏任一个都会**静默失效**，不报错）：

1. **必须在 `package.json` 的 `exports` 里导出 `./locale/*.json`** —— 宿主经 Node 模块解析器
   读取该资源，未导出的子路径会得到 `ERR_PACKAGE_PATH_NOT_EXPORTED`，被当作「没有 locale」跳过。
2. **`files` 需包含 `locale`** —— 否则 `pnpm pack` / `npm publish` 的产物里不会带上它。

`icon.svg` 走顶层 `icon` 字段（相对路径），**不需要** `exports`。

## 客户端挂载点

| 槽位 | 注册 id | 用途 | 排序 |
|---|---|---|---|---|
| `settings.action` | `dsh-restart-autostart/restart` | 设置面板标题栏的重启按钮（所有分页共用） | `-10`（官方「打开配置文件」为 `0`，故排在它左侧）|
| `settings.general.item` | `dsh-restart-autostart/upgrade` | 「设置 → 通用」最下面的「DSH 主程序版本」行（含安全模式告警） | `10000`（排在平台版本行之后）|
| `settings.general.item` | `dsh-restart-autostart/autostart` | 「设置 → 通用」里的「跟随系统启动」行 | `90` |

客户端 bundle 仅 `require` 平台种子表内的模块（`react`、`@deepseek-ai/dsh-client-ui-primitives`）。

## 许可证

MIT © felixpu

## 仓库

<https://github.com/felixpu/dsh-restart-autostart>
