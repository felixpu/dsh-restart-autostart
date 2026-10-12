# dsh-restart-autostart

给 DSH（DeepSeek Harness）网页版加入两处进程控制入口：

- **手动重启**：设置面板**标题栏**上的红色「重启」按钮（紧挨「打开配置文件」左侧）。
  任何设置分页都能点到它，不必滚动到「通用」页去找；重启后页面自动探测服务恢复。
- **跟随系统启动**：「设置 → 通用」里的勾选框，写入系统自启条目
  （macOS launchd / Linux systemd / Windows 服务），开机拉起，并在崩溃后自动重启

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

## 测试

```sh
DSH_RESTART_GUARD="$PWD/lib/guard/guard.js" bash test/guard-classify.test.sh
```

覆盖守护的失败分类逻辑：端口被占、起来了但非零退出、插件树加载失败、启动过慢、待命状态。

> 测试需指定 `DSH_RESTART_GUARD` 指到包内守护脚本；未指定时默认读
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
| `settings.general.item` | `dsh-restart-autostart/autostart` | 「设置 → 通用」里的「跟随系统启动」行 | `90` |

客户端 bundle 仅 `require` 平台种子表内的模块（`react`、`@deepseek-ai/dsh-client-ui-primitives`）。

## 许可证

MIT © felixpu

## 仓库

<https://github.com/felixpu/dsh-restart-autostart>
