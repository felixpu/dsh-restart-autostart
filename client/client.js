window.__ModuleLoader__.load({ id: "dsh-restart-autostart", factory: (require) => {
	var module = { exports: {} };
	var exports = module.exports;
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

	// 客户端 bundle 由宿主模块加载器装载：React 通过工厂注入的 require 取得，
	// 不能用 ESM import（加载器不转换，也没有打包器）。
	// 只 require 平台 seed 表内的模块 —— 本插件仅用 react，把白屏风险降到最低。
	var react = require("react");

	/**
	 * 平台 UI 基础件：只取 Tooltip（与聊天界面同一个气泡）。
	 *
	 * 可取范围由应用的种子表决定（应用包里的 `staticModules`），其中含
	 * `@deepseek-ai/dsh-client-ui-primitives`，它导出 Tooltip / Switch / Tag / Toast 等。
	 * 用平台自带的气泡而不是自写 CSS，关键理由是它 `position:fixed` —— 不会被设置面板的
	 * 滚动容器裁切（自写的会被 overflow 吃掉，而本控件正贴在最右边缘）；
	 * 另外它自带 hover + focus 触发，多行文案写 `\n` 即可（气泡是 white-space:pre-line）。
	 *
	 * ⚠️ 该包是 dsh 自家包的**构建期**依赖，磁盘上没有这个目录 ⇒ 绝不能写进 package.json
	 * （会让 pnpm install 去 registry 拉一个不存在的包而失败），只能像这样运行时 require。
	 * try/catch 是防御：种子表若哪天变了，退化成「没有 tooltip」，而不是这一行白屏。
	 */
	let Tooltip = null;
	let Button = null;
	try {
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		Tooltip = typeof primitives.Tooltip === "function" ? primitives.Tooltip : null;
		// 标题栏按钮要与官方「打开配置文件」同款（同一组件、同一尺寸、同一圆角），
		// 只把颜色换成 danger。取不到就退化成自写 button（见 HeaderRestart）。
		Button = typeof primitives.Button === "object" || typeof primitives.Button === "function"
			? primitives.Button
			: null;
	} catch {
		Tooltip = null;
		Button = null;
	}

	/**
	 * dsh-restart-autostart 浏览器半身 —— 设置面板标题栏的两个动作 + 「设置 → 通用」里的一行。
	 *
	 * 三条功能线：
	 *   ① 手动重启     —— 标题栏按钮 + 确认弹窗，同源 POST /dsh-restart-autostart/restart
	 *   ② 重启守护     —— 通用页那一行的勾选框，/dsh-restart-autostart/autostart/{status,enable,disable}
	 *   ③ 一键升级     —— 「通用」页最下面的版本行，/dsh-restart-autostart/upgrade/{status,check,start,rollback}
	 *
	 * 布局上分两处：重启留在设置面板标题栏（全局共用，免滚动）；升级与自启都在
	 * 「设置 → 通用」—— 升级贴着平台那行「当前版本」放在最下面，自启是系统配置。
	 *
	 * 之所以不放回 `settings.general.item` 并排：该槽是**单列 flex、每项一棵独立
	 * DOM 子树**，两个注册永远并不到一行；而标题栏那一行是全局共用、位置固定的。
	 *
	 * 进度与错误改由标题栏按钮下方的浮层承载 —— 标题栏只有 54px 高，放不下行内文本。
	 * 错误仍**必须可见**（例如 launchctl 不在登录域、要被叫去终端执行命令），
	 * 藏进 tooltip 等于藏起来，故浮层在失败时保持显示、由用户手动关闭。
	 */

	/** 命名空间：文案与 locale 字典注册键，同时是模块加载器的 bundle id。 */
	const NS = "dsh-restart-autostart";

	/** 插件名（cordis 条目名）。 */
	const name = NS;

	/** 声明的注入：插槽注册 + 多语言。 */
	const inject = ["slots", "locale"];

	/** 等待服务恢复的最长时间（毫秒），超过则提示手动刷新。 */
	const POLL_TIMEOUT_MS = 90000;

	/**
	 * 「隐藏平台版本行」那张样式表的 tagId。
	 *
	 * 单独一张表而不是并进主 CSS：主 CSS 是静态的，这张的内容要等官方 style 表出现后
	 * 才能算出类名；混在一起就得整表重写，且去重键会对不上。
	 */
	const HIDE_ID = NS + "/hide-official-version.css";

	/**
	 * 首次探测前的静默等待（毫秒）。
	 *
	 * 这段时间是「必然会失败」的窗口：旧进程正在优雅关闭、新进程还没 bind，
	 * 此刻探测 100% 得到 ERR_CONNECTION_REFUSED。
	 *
	 * 关键点：浏览器会把每一次网络层失败（ERR_CONNECTION_REFUSED / Failed to
	 * fetch）无条件打进控制台，**try/catch 拦不住** —— 那是网络栈的日志，不是
	 * 未捕获异常。所以「消除报错」唯一可行的办法，就是从源头减少注定失败的请求：
	 * 与其每秒盲探、连刷几十条红字，不如先把这段已知的停机窗口等过去。
	 *
	 * 实测旧进程 SIGTERM 到端口释放约 0.5~1.5s，新进程 bind + 路由挂载再加
	 * 约 1~2s，2500ms 能覆盖绝大多数情况；万一提前恢复，也不过是晚一点开始探测。
	 */
	const INITIAL_GRACE_MS = 2500;

	/**
	 * 探测之间的静默间隔（毫秒）。恢复后此处不再有失败请求，故间隔取小值即可。
	 */
	const PROBE_INTERVAL_MS = 1200;

	const zh = {
		// ① 重启服务
		title: "重启服务",
		description: "重启 DSH 服务以应用插件安装、卸载或配置变更。",
		button: "重启",
		confirmTitle: "确认重启 DSH 服务？",
		confirmBody: "重启会中断正在进行的会话与后台任务，并短暂断开本页面连接。重启完成后页面会自动恢复。",
		confirm: "确认重启",
		cancel: "取消",
		restarting: "正在重启…",
		waiting: "等待服务恢复…",
		restored: "服务已恢复，正在刷新…",
		stopping: "正在停止旧服务…",
		starting: "正在启动新服务…",
		failed: "重启请求失败：",
		failedTip: "重启未能完成",
		timeout: "服务未在预期时间内恢复，请手动刷新页面或检查终端日志。",
		// ② 跟随系统启动
		autoTitle: "跟随系统启动",
		autoDesc: "开机自动运行，意外退出后自动重启。",
		autoLoading: "正在读取…",
		autoOn: "已启用，下次开机生效",
		autoOff: "未启用",
		autoEnabling: "正在写入…",
		autoDisabling: "正在移除…",
		autoUnsupported: "当前平台暂不支持自动配置，请手动设置。",
		autoUnverified: "当前平台的自动配置尚未经过真机验证，如遇问题请手动检查自启条目。",
		autoFailed: "操作失败：",
		autoLoadFailed: "读取自启状态失败",
		// ③ 一键升级（「设置 → 通用」最下面的版本行）
		upgradeRowTitle: "DSH 主程序版本",
		upgradeHasNew: "有新版本 {latest}，可一键升级。",
		upgradeLoading: "读取中…",
		upgradeChecking: "检查中…",
		upgradeRecheck: "重新检查",
		upgradeUnknown: "还没有版本信息，点「重新检查」查一次。",
		upgradeUpToDate: "已是最新版本。",
		upgradeRisk: "升级只替换主程序，插件文件不会丢。若新版本与某个插件不兼容导致起不来，守护会自动回滚。",
		upgradeAction: "升级并重启",
		upgradeRunning: "升级中…",
		upgradeRollback: "回滚…",
		upgradeCurrentPfx: "当前版本 {v}",
		upgradeRollbackTitle: "回滚到指定版本",
		upgradeRollbackHint: "当前运行中的主程序是 {current}。回滚会替换主程序并重启服务，期间会话会中断。",
		upgradeRollbackLocal: "本地备份（免下载，秒级）",
		upgradeRollbackPublished: "已发布版本（需联网下载）",
		upgradeRollbackNeedNet: "（需联网重装）",
		upgradeRollbackGo: "回滚到此版本",
		upgradeVersionsLoad: "查看更多已发布版本",
		upgradeVersionsLoading: "查询中…",
		upgradeVersionsFailed: "查询已发布版本失败，可只用本地备份回滚。",
		upgradeConfirmTitle: "升级到 {latest}？",
		upgradeConfirmBody: "会先备份当前主程序，安装后重启服务做验证。若新版本起不来，守护会自动回滚到当前版本。升级期间会话会短暂中断。",
		upgradeConfirm: "开始升级",
		upgradeTimeout: "服务未在预期时间内恢复，请查看日志或手动重启。",
		upgradeStageBackup: "正在备份主程序…",
		upgradeStageInstall: "正在安装新版本（需要几十秒）…",
		upgradeStageVerify: "正在校验新版本…",
		upgradeStageRestart: "正在重启服务…",
		upgradeStageElapsed: "已等待 {s}s",
		// ④ 安全模式 —— guard 在新版本起不来时把第三方 bundle 摘掉后的状态展示
		upgradeSafeModeTitle: "已进入安全模式",
		upgradeSafeModeStatus: "安全模式：{count} 个第三方插件被临时停用。",
		upgradeSafeModeBody: "新版本启动失败，守护已把 {count} 个第三方插件临时摘出，改用官方最小配置启动。服务现在是正常的，这些插件的功能暂时不可用。",
		upgradeSafeModeSuspects: "疑似涉事插件：{list}",
		upgradeSafeModeAt: "进入时间：{at}",
		upgradeSafeModeRestore: "恢复插件",
		upgradeSafeModeRestoring: "正在恢复插件并重启…",
		upgradeSafeModeRestoreTitle: "装回 {count} 个插件？",
		upgradeSafeModeRestoreBody: "会把这些插件重新加入启动列表并重启服务。如果其中仍有不兼容的，服务可能再次起不来 —— 那时守护会再次进入安全模式，不会让你失去服务。",
	};

	const en = {
		// ① 重启服务
		title: "Restart service",
		description: "Restart the DSH service to apply plugin installs, removals, or configuration changes.",
		button: "Restart",
		confirmTitle: "Restart the DSH service?",
		confirmBody: "Restarting interrupts in-progress sessions and background tasks, and briefly disconnects this page. It recovers automatically once the service is back.",
		confirm: "Restart now",
		cancel: "Cancel",
		restarting: "Restarting…",
		waiting: "Waiting for the service to come back…",
		restored: "Service restored — reloading…",
		stopping: "Stopping the old service…",
		starting: "Starting the new service…",
		failed: "Restart request failed: ",
		failedTip: "Restart did not complete",
		timeout: "The service did not come back in time. Refresh the page or check the terminal log.",
		// ② 跟随系统启动
		autoTitle: "Launch at system startup",
		autoDesc: "Start automatically on boot, and restart if it exits unexpectedly.",
		autoLoading: "Reading…",
		autoOn: "Enabled — takes effect on next boot",
		autoOff: "Disabled",
		autoEnabling: "Writing…",
		autoDisabling: "Removing…",
		autoUnsupported: "Automatic setup is not supported on this platform; please configure it manually.",
		autoUnverified: "Automatic setup on this platform has not been verified on real hardware. Check the autostart entry manually if something looks wrong.",
		autoFailed: "Operation failed: ",
		autoLoadFailed: "Failed to read autostart status",
		// ③ One-click upgrade (the version row at the bottom of Settings → General)
		upgradeRowTitle: "DSH host version",
		upgradeHasNew: "Version {latest} is available — upgrade in one click.",
		upgradeLoading: "Reading…",
		upgradeChecking: "Checking…",
		upgradeRecheck: "Check again",
		upgradeUnknown: "No version information yet — try \"Check again\".",
		upgradeUpToDate: "Already up to date.",
		upgradeRisk: "Only the host is replaced; plugin files are kept. If the new version cannot start because of an incompatible plugin, the guard rolls back automatically.",
		upgradeAction: "Upgrade and restart",
		upgradeRunning: "Upgrading…",
		upgradeRollback: "Roll back…",
		upgradeCurrentPfx: "Current {v}",
		upgradeRollbackTitle: "Roll back to a version",
		upgradeRollbackHint: "The running host is {current}. Rolling back replaces it and restarts the service; sessions are interrupted.",
		upgradeRollbackLocal: "Local backup (instant, no download)",
		upgradeRollbackPublished: "Published versions (needs download)",
		upgradeRollbackNeedNet: " (needs download)",
		upgradeRollbackGo: "Roll back to this version",
		upgradeVersionsLoad: "Show published versions",
		upgradeVersionsLoading: "Loading…",
		upgradeVersionsFailed: "Could not load published versions; local backups still work.",
		upgradeConfirmTitle: "Upgrade to {latest}?",
		upgradeConfirmBody: "The current host is backed up first; the service then restarts to verify the new version. If it cannot start, the guard rolls back automatically. Sessions are briefly interrupted.",
		upgradeConfirm: "Start upgrade",
		upgradeTimeout: "The service did not come back in time. Check the log or restart manually.",
		upgradeStageBackup: "Backing up the host…",
		upgradeStageInstall: "Installing the new version (this takes a while)…",
		upgradeStageVerify: "Verifying the new version…",
		upgradeStageRestart: "Restarting the service…",
		upgradeStageElapsed: "waited {s}s",
		// ④ Safe mode — shown after the guard removed third-party bundles to boot
		upgradeSafeModeTitle: "Safe mode is active",
		upgradeSafeModeStatus: "Safe mode: {count} third-party plugin(s) temporarily disabled.",
		upgradeSafeModeBody: "The new version failed to start, so the guard removed {count} third-party plugin(s) and booted with the official minimal set. The service works; those plugin features are unavailable for now.",
		upgradeSafeModeSuspects: "Likely culprit: {list}",
		upgradeSafeModeAt: "Entered at: {at}",
		upgradeSafeModeRestore: "Restore plugins",
		upgradeSafeModeRestoring: "Restoring plugins and restarting…",
		upgradeSafeModeRestoreTitle: "Restore {count} plugin(s)?",
		upgradeSafeModeRestoreBody: "They will be added back to the startup list and the service will restart. If any of them is still incompatible the service may fail again — the guard will then re-enter safe mode, so you will not lose the service.",
	};

	/**
	 * 行样式：与通用设置其它行一致的排版，外加标题栏动作与进度浮层。
	 *
	 * 前缀 rstb- 同时服务两处渲染（标题栏按钮 + 通用页自启行），故只注入一份样式表。
	 *
	 * ⚠️ 所有颜色/圆角/阴影一律走主题 token，且必须是【实报名单】里的名字
	 * （用 cordis_inspect_query 的 client/Theme listTokens 核对过）——
	 * 例如文字色是 --dsw-alias-label-primary 而不是 --dsw-alias-text-primary，
	 * 后者根本不存在，只能靠 fallback 蒙对。写明 fallback 是为了主题缺失时仍可用。
	 */
	const CSS = ".rstb-row{display:flex;flex-direction:column;gap:4px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2,#e5e5e5)}" +
		".rstb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}" +
		".rstb-rowText{display:flex;flex-direction:column;gap:2px;min-width:0}" +
		".rstb-title{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary,inherit)}" +
		".rstb-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}" +
		".rstb-btn{height:28px;padding:0 14px;border-radius:6px;border:1px solid transparent;font-size:12px;font-weight:600;line-height:18px;cursor:pointer;background:var(--dsw-alias-button-primary-fill,#4f6ef7);color:#fff}" +
		".rstb-btn:hover:not(:disabled){filter:brightness(1.08)}" +
		".rstb-btn:disabled{opacity:.55;cursor:default}" +
		".rstb-btnGhost{background:transparent;color:var(--dsw-alias-label-secondary,inherit);border-color:var(--dsw-alias-border-l2,#e5e5e5)}" +
		".rstb-btnGhost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#0000000d)}" +
		".rstb-btnSolidDanger{background:var(--dsw-alias-state-error-primary,#d1242f);color:var(--dsw-alias-label-primary-foreground,#fff)}" +
		".rstb-btnSolidDanger:hover:not(:disabled){filter:brightness(1.08)}" +
		".rstb-track{height:4px;border-radius:2px;background:var(--dsw-alias-interactive-bg-hover,#00000014);overflow:hidden}" +
		".rstb-bar{height:100%;border-radius:2px;background:var(--dsw-alias-button-primary-fill,#4f6ef7);transition:width .3s ease}" +
		// 不确定进度：备份/安装/校验的真实进度**拿不到**（npm 不吐百分比，宿主也没阶段性回调）。
		// 与其钉一个假的 30% 让用户以为卡住了，不如老实做「还在动」的扫光 ——
		// 它要传达的信息只有一条：进程活着。真实信息交给旁边的文字与秒数。
		".rstb-barBusy{width:34%;animation:rstbSweep 1.15s ease-in-out infinite}" +
		"@keyframes rstbSweep{0%{transform:translateX(-105%)}100%{transform:translateX(305%)}}" +
		".rstb-barDone{background:var(--dsw-alias-state-success-primary,#1a7f37)}" +
		".rstb-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#d1242f)}" +
		".rstb-overlay{position:fixed;inset:0;z-index:999;display:flex;align-items:center;justify-content:center;background:#00000061}" +
		".rstb-modal{width:440px;max-width:calc(100vw - 32px);background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e5e5);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:10px;box-shadow:0 12px 40px #0000003d}" +
		".rstb-modalTitle{font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary,inherit)}" +
		".rstb-modalBody{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit)}" +
		".rstb-modalActions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}" +
		".rstb-switch{flex:none;display:flex;align-items:center;gap:8px}" +
		".rstb-box{width:16px;height:16px;accent-color:var(--dsw-alias-button-primary-fill,#4f6ef7);cursor:pointer}" +
		".rstb-box:disabled{cursor:default;opacity:.55}" +
		// ── 标题栏动作（重启按钮 + 进度浮层）────────────────────────────
		// 双类选择器（.rstb-btnDanger.rstb-btnDanger）是为了压过平台 Button 的
		// .outline 单类样式 —— 两份 CSS 的插入顺序不确定，只能靠特异性取胜。
		".rstb-headerAction{position:relative;display:flex;align-items:center}" +
		".rstb-btnDanger.rstb-btnDanger{color:var(--dsw-alias-state-error-primary,#d1242f);border-color:var(--dsw-alias-state-error-primary,#d1242f)}" +
		".rstb-btnDanger.rstb-btnDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,#d1242f1a)}" +
		".rstb-btnDanger.rstb-btnDanger:disabled{color:var(--dsw-alias-state-error-primary,#d1242f);opacity:.55;cursor:default}" +
		".rstb-flyout{position:absolute;top:calc(100% + 8px);right:0;z-index:5;width:240px;box-sizing:border-box;padding:10px 12px;border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2,#fff));border:1px solid var(--dsw-alias-border-l1,#e5e5e5);box-shadow:var(--dsw-elevation-panel,0 8px 24px #00000026);display:flex;flex-direction:column;gap:6px}" +
		".rstb-flyoutHead{display:flex;align-items:baseline;justify-content:space-between;gap:8px}" +
		".rstb-flyoutLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit)}" +
		".rstb-flyoutTime{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-variant-numeric:tabular-nums}" +
		".rstb-flyoutError{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#d1242f);word-break:break-word}" +
		".rstb-flyoutClose{flex:none;height:18px;padding:0 4px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:12px;line-height:18px;cursor:pointer;font-family:inherit}" +
		".rstb-flyoutClose:hover{background:var(--dsw-alias-interactive-bg-hover,#0000000d)}" +
		// ── 一键升级（通用页版本行）────────────────────────────────────
		// 行内的小字说明与右侧按钮组。进度条复用上面的 .rstb-track/.rstb-bar。
		".rstb-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a8a8a);word-break:break-word}" +
		".rstb-actions{display:flex;flex:none;align-items:center;gap:8px}" +
		// 安全模式告警块：这是「你的插件被摘掉了」这种事，必须比普通小字显眼。
		// 用 warning 色描边 + 浅底，而不是红色：服务是好的，只是功能少了几个。
		".rstb-safe{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:6px;border:1px solid var(--dsw-alias-state-warning-primary,#bf8700);background:var(--dsw-alias-state-warning-bg,#bf870014)}" +
		".rstb-safeTitle{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-state-warning-primary,#bf8700)}" +
		".rstb-safeItem{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,inherit);word-break:break-word}" +
		".rstb-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all}" +
		".rstb-select{width:100%;box-sizing:border-box;height:30px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#e5e5e5);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,inherit);font-size:12px;font-family:inherit}" +
		".rstb-rowGroup{display:block}";

	/** 注入一次本插件样式（按 tagId 去重，避免重复挂载时叠加）。 */
	function installStyles() {
		const tagId = NS + "/row.css";
		if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
		const tag = document.createElement("style");
		tag.dataset.plugin = NS;
		tag.dataset.pluginCss = tagId;
		tag.textContent = CSS;
		document.head.appendChild(tag);
	}

	/**
	 * 让平台自带的「当前版本：x.y.z」那一行让位。
	 *
	 * 为什么由本插件来删：版本号已经并进本插件那行的状态说明（「当前版本 x.y.z · 已是最新版本。」），
	 * 而平台那行（`@deepseek-ai/dsh-client-ui-settings-general` 的 `CurrentVersionRow`）就在正上方，
	 * 两行写同一个数字，看着像渲染错了 —— 用户指着截图说的就是这一处。
	 * 它是官方内置插件渲染的 `div`，我们改不了它的源码（升级 dsh 会整包覆盖），只能从样式上让它不显示。
	 *
	 * 为什么不写死 `.yIbyla_row`：那是 CSS Modules 的构建哈希（`<hash>_row`），官方包一重新构建就变，
	 * 写死等于埋一个「某次升级后它又冒出来」的静默失效 —— 而且不会有任何报错提醒。
	 * 这里改为**读官方自己注入的那张 style 表**（`data-plugin-css="…/CurrentVersionRow.module.css"`），
	 * 从中解析出真实的类名再补一条 `display:none`，哈希怎么变都跟得上。
	 *
	 * 官方若哪天不再渲染这一行（标签不存在、或里面没有 `_row` 类），这里什么都不做 ——
	 * 宁可留着那一行，也不能误伤别的行（同一个包里还有 `DeveloperToolsRow` 等 `_row` 类）。
	 *
	 * @returns 无返回值；失败静默，不影响其余 UI。
	 */
	function hideOfficialVersionRow() {
		if (typeof document === "undefined" || document.head === null) return;
		try {
			const cssId = "@deepseek-ai/dsh-client-ui-settings-general/CurrentVersionRow.module.css";
			const selector = "style[data-plugin-css=" + JSON.stringify(cssId) + "]";
			const installed = () => document.querySelector("style[data-plugin-css=" + JSON.stringify(HIDE_ID) + "]") !== null;

			/** 从官方 style 表里取出真实类名并注入隐藏规则；取不到返回 false。 */
			const hideFrom = (node) => {
				if (installed()) return true;
				const text = node !== null && typeof node.textContent === "string" ? node.textContent : "";
				const found = /\.([A-Za-z0-9_-]+_row)\s*\{/.exec(text);
				if (found === null) return false;
				const tag = document.createElement("style");
				tag.dataset.plugin = NS;
				tag.dataset.pluginCss = HIDE_ID;
				tag.textContent = "." + found[1] + "{display:none}";
				document.head.appendChild(tag);
				return true;
			};

			// 常见情形：官方 bundle 先执行（我们要挂在它的 slot 里，它必然已加载）。
			if (hideFrom(document.querySelector(selector))) return;

			// 兜底：两个 bundle 的执行顺序没有约定，官方晚到时再补一次。
			// 只观察 head 的新增节点，命中即断开 —— 不做定时轮询，也不永久占着观察者。
			if (typeof MutationObserver !== "function") return;
			const observer = new MutationObserver(() => {
				if (hideFrom(document.querySelector(selector))) observer.disconnect();
			});
			observer.observe(document.head, { childList: true });
		} catch {
			// 这里只为「少一行重复的版本号」，任何意外都不该影响插件其余部分。
		}
	}

	/**
	 * 等待宿主恢复，并在过程中回报进度 —— 重启与升级共用。
	 *
	 * 设计要点（为了「控制台无报错」）：
	 *  1. 先静默等待 INITIAL_GRACE_MS，跳过「必然失败」的停机窗口 —— 这是
	 *     减少失败请求、进而消除控制台红字的主要手段。
	 *  2. 探测用 fetch 而不是靠 setTimeout 猜时间，保证「确实活了」才跳转。
	 *
	 * 判据必须同时满足两条（曾经只用 /health 单条，导致跳转撞 401）：
	 *  a. /dsh-restart-autostart/health 返回 200 + application/json
	 *     —— 证明新宿主已 bind、且插件行已挂载。
	 *  b. / 返回 200 或 401 —— 证明宿主根路由与鉴权中间件已就绪。
	 *     裸访问 / 在无 cookie 时返回 401 + text/plain，这是【鉴权已装好】
	 *     的正常表现（用户浏览器持有 30 天有效的签名 cookie，会直接 200）；
	 *     而根路由尚未挂载时返回 404，那才是"还没好"。
	 *     绝不能笼统判断 status < 500 —— 404 会被误判为就绪。
	 *
	 * 提到模块级是为了让「一键升级」复用同一套判据：升级的最后一步也是重启宿主，
	 * 若两边各写一份，迟早会在某次改动后只修好一边。
	 *
	 * @param aliveRef - 组件存活标记的 ref；组件卸载后立即停止探测。
	 * @param onTick - 每轮回报进度：`{ elapsed, phase }`。
	 * @returns 服务是否在超时前恢复。
	 */
	async function waitForService(aliveRef, onTick) {
		const startedAt = Date.now();
		const deadline = startedAt + POLL_TIMEOUT_MS;

		// ① 静默窗口：不探测，只推进进度条。
		while (Date.now() - startedAt < INITIAL_GRACE_MS) {
			if (!aliveRef.current) return false;
			await new Promise((resolve) => setTimeout(resolve, 200));
			onTick({ elapsed: Date.now() - startedAt, phase: "stopping" });
		}

		// ② 探测阶段：两条判据都满足才算恢复。
		let healthReady = false;
		while (Date.now() < deadline) {
			if (!aliveRef.current) return false;
			await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
			if (!aliveRef.current) return false;
			try {
				if (!healthReady) {
					const probe = await fetch("/dsh-restart-autostart/health", { cache: "no-store" });
					// 新进程 bind 之后、插件路由挂载之前，请求会命中宿主兜底
					// 页（200 + HTML），故必须校验 content-type 而非只看 ok。
					const type = probe.headers.get("content-type") ?? "";
					healthReady = probe.ok && type.indexOf("application/json") !== -1;
				}
				if (healthReady) {
					// 再确认宿主根路由已就绪。判定必须精确到状态码：
					//   200      -> 已有 cookie，直接可用；
					//   401      -> 鉴权中间件已装好（只是本次请求没带 cookie），
					//               跳过去时浏览器会带上签名 cookie，正常放行；
					//   404      -> 根路由【尚未挂载】，此时跳转会看到
					//               "找不到网页 / HTTP ERROR 404"，必须继续等；
					//   5xx      -> 服务异常，继续等。
					const root = await fetch("/", { cache: "no-store", redirect: "manual" });
					if (root.status < 400 || root.status === 401) return true;
				}
			} catch {
				// 服务尚未恢复 —— 预期路径。浏览器仍会打印一条网络错误，
				// 已用 grace 把这类日志压到最少。
				healthReady = false;
			}
			onTick({ elapsed: Date.now() - startedAt, phase: "starting" });
		}
		return false;
	}

	/**
	 * 重启的状态机 —— 纯逻辑，不管排版。
	 *
	 * 三个状态：idle（可点击）→ confirming（二次确认）→ restarting（等待服务恢复）。
	 * 重启会切断本页与宿主的连接，所以不能依赖重启请求本身的回包判断成功，
	 * 只能轮询 /health 直到服务重新响应。
	 *
	 * 从原来的 RestartRow 整体搬出来（逻辑逐字未改），只因渲染位置从「通用设置行」
	 * 换到了「设置面板标题栏」—— 逻辑与排版分开后，两处渲染都好写。
	 * @param t - 文案函数。
	 * @returns 状态与动作；`request()` 打开确认弹窗，`confirm()` 真正发起重启。
	 */
	function useRestart(t) {
		const [confirming, setConfirming] = react.useState(false);
		const [restarting, setRestarting] = react.useState(false);
		const [error, setError] = react.useState("");
		// 重启进度：phase 为 stopping/starting/done，elapsed 为已等待毫秒数。
		// 两者只服务于「让用户看见进度」，不参与成功与否的判定。
		const [phase, setPhase] = react.useState("");
		const [elapsed, setElapsed] = react.useState(0);
		// 组件卸载后停止轮询，避免对已消失的页面继续写 state。
		const alive = react.useRef(true);
		react.useEffect(() => () => { alive.current = false; }, []);

		// 等待逻辑见模块级的 waitForService：升级流程复用同一套判据。
		const waitForRestore = react.useCallback((onTick) => waitForService(alive, onTick), []);

		/** 发起重启：POST 端点，然后等待服务恢复并刷新页面。 */
		const doRestart = react.useCallback(async () => {
			setConfirming(false);
			setError("");
			setPhase("stopping");
			setElapsed(0);
			setRestarting(true);
			try {
				const response = await fetch("/dsh-restart-autostart/restart", {
					method: "POST",
					headers: { "content-type": "application/json" }
				});
				if (!response.ok) {
					// 先关进度条再报错：渲染守卫是 restarting，故必须置 false，
					// 否则 phase 清空后进度条仍会以 stopping 文案停留。
					setRestarting(false);
					setPhase("");
					setElapsed(0);
					setError(t("failed") + "HTTP " + response.status);
					return;
				}
			} catch {
				// 连接可能在重启启动瞬间就断了，属预期路径，继续等待恢复。
			}
			// 进度回报纯属 UI 展示：节流到 100ms 一次，避免每 200ms 触发一轮渲染。
			let lastPaint = 0;
			const restored = await waitForRestore((tick) => {
				const now = Date.now();
				if (now - lastPaint < 100) return;
				lastPaint = now;
				setElapsed(tick.elapsed);
				setPhase(tick.phase);
			});
			if (!alive.current) return;
			if (restored) {
				setPhase("done");
				// 必须跳到干净的 "/"，不能用 reload()：
				// reload() 会重放当前 URL。当前地址栏是「本次进程启动时打印的」
				// 那条带 ?token=<旧进程 token> 的 URL，而 token 每次进程启动都重新
				// 生成，新进程比对旧 token 必然失败 → 401 authentication required。
				// 签名 cookie 则持久在 credentials 里、跨重启有效（绑定 authority
				// 而非进程），所以不带 token 访问 "/" 反而能被 cookie 直接放行。
				window.location.replace("/");
				return;
			}
			// 超时：先收掉进度条（守卫是 restarting），再显示错误。
			setRestarting(false);
			setPhase("");
			setElapsed(0);
			setError(t("timeout"));
		}, [t, waitForRestore]);

		return { confirming, setConfirming, restarting, error, phase, elapsed, doRestart };
	}

	/** 升级过程中轮询状态的间隔（毫秒）。 */
	const UPGRADE_POLL_MS = 800;

	/**
	 * 面板「空转轮询」的间隔（毫秒）。
	 *
	 * 比 UPGRADE_POLL_MS 粗得多：那条是本页亲手发起升级时的贴身跟踪，慢 0.8s 就会
	 * 错过重启窗口；这条只是让**旁观中的页面**（刷新过的、或别的页签在升级）跟上服务端，
	 * 2 秒足够，也不至于让设置页一直发请求。
	 */
	const UI_POLL_MS = 2000;


	/** 升级全过程的最长等待（毫秒）—— 装 849MB 依赖要几十秒，失败重试也要时间。 */
	const UPGRADE_DEADLINE_MS = 10 * 60 * 1000;

	/**
	 * 一键升级的状态与动作 —— 只给值，不管排版。
	 *
	 * 流程与阶段完全由服务端主导（见 lib/upgrade/index.js 的状态机），前端只做两件事：
	 *   1. 轮询 /upgrade/status 把阶段显示出来；
	 *   2. 察觉到宿主开始重启后，**复用重启用同一套 waitForService** 等待恢复并刷新页面。
	 *
	 * 为什么第 2 步不能省：升级的最后一步是重启宿主，那一刻本页会与宿主断开，
	 * 之后「到底成没成」只能靠 probe —— 而 probe 的判据必须和重启一致，否则会出现
	 * 「升级成功但页面卡在旧内容」这类假象。
	 *
	 * @param t - 文案函数。
	 * @returns 状态、动作与是否展开面板。
	 */
	function useUpgrade(t) {
		const [state, setState] = react.useState({
			loading: true,
			current: null,
			latest: null,
			hasUpdate: null,
			phase: "idle",
			error: "",
			busy: false,
			// 本轮升级的服务端起止时间：用它算「已等待 Ns」，刷新页面也不会从 0 重来。
			startedAt: null,
			last: null,
			pending: null,
			// 可回滚的本地版本（备份目录 + 上次升级记录）。为空时界面不显示「回滚」入口。
			rollbacks: [],
			// 安全模式状态：非 null 表示 guard 在「新版本起不来」时把第三方 bundle 摘掉了。
			// 它由 guard 写盘、由本页解除，是唯一一条「用户看不见就必须靠猜」的状态。
			safeMode: null,
		});
		const [checking, setChecking] = react.useState(false);
		const [failure, setFailure] = react.useState("");
		const [busyUi, setBusyUi] = react.useState(false);
		const [elapsed, setElapsed] = react.useState(0);
		const [waitPhase, setWaitPhase] = react.useState("");
		const alive = react.useRef(true);
		react.useEffect(() => () => { alive.current = false; }, []);
		// 上一次看到的宿主版本 —— 用来识别「宿主已经换了版本」，见 merge 里的说明。
		const seenVersion = react.useRef(null);

		/** 把服务端返回的状态合并进本地 state。 */
		const merge = react.useCallback((data) => {
			if (!alive.current) return;
			const phase = typeof data.phase === "string" ? data.phase : "idle";
			const busy = data.busy === true;
			const nextCurrent = typeof data.current === "string" ? data.current : null;
			setState({
				loading: false,
				current: nextCurrent,
				latest: typeof data.latest === "string" ? data.latest : null,
				hasUpdate: data.hasUpdate === true ? true : data.hasUpdate === false ? false : null,
				phase,
				error: typeof data.error === "string" ? data.error : "",
				busy,
				startedAt: typeof data.startedAt === "number" && data.startedAt > 0 ? data.startedAt : null,
				last: data.last ?? null,
				pending: data.pending ?? null,
				rollbacks: Array.isArray(data.rollbacks) ? data.rollbacks : [],
				safeMode: data.safeMode !== null && typeof data.safeMode === "object" ? data.safeMode : null,
			});
			// 服务端已到终态时，本地那个「我这一页点过升级」的 busyUi 必须让位。
			// 它只是本页签的乐观状态，管不了「另一个页签发起的升级已经结束」—— 不清它，
			// 面板就会永远停在「升级中…」，而服务端其实早已收工（实测踩到过）。
			if (!busy && (phase === "done" || phase === "failed" || phase === "rolled-back")) {
				setBusyUi(false);
				setWaitPhase("");
			}
			// 但升级**成功**的情形靠上面这条抓不住：重启后是**全新宿主进程**，
			// 它的内存状态机从 idle 开始（`last` 才是 done），phase 永远不会经过 done。
			// 于是「宿主版本变了」才是升级成功的唯一外部证据 —— 本页看着 rc.2 变 rc.3，
			// 就说明那次升级已经有结论，本地的「升级中」必须作废。
			if (seenVersion.current !== null && nextCurrent !== null && nextCurrent !== seenVersion.current) {
				setBusyUi(false);
				setWaitPhase("");
			}
			seenVersion.current = nextCurrent;
		}, []);

		const refresh = react.useCallback(async () => {
			try {
				const response = await fetch("/dsh-restart-autostart/upgrade/status", { cache: "no-store" });
				if (!response.ok) throw new Error("HTTP " + response.status);
				merge(await response.json());
			} catch {
				// 宿主可能正在重启：保留现有状态，别把面板清空。
				if (alive.current) setState((prev) => ({ ...prev, loading: false }));
			}
		}, [merge]);

		react.useEffect(() => { void refresh(); }, [refresh]);

		// 升级进行中时持续轮询。
		//
		// 只查一次（挂载时）会造成一个很具体的假象：升级是**在别处**发生的
		// （另一个页签、或本页在安装途中被手动刷新），这一页之后再没有任何事件能唤醒它，
		// 于是「服务端早就装完并验证通过，面板还停在正在安装新版本…」—— 用户只能靠
		// 反复手动刷新自救。这里补上「只要还在忙就每 2 秒看一眼」。
		//
		// 上限沿用 UPGRADE_DEADLINE_MS：宿主真的挂了的话，无限轮询只会白烧电池，
		// 而「宿主挂了」自有 guard 与 waitForService 负责，不归这个轮询管。
		react.useEffect(() => {
			if (!state.busy) return undefined;
			const deadline = Date.now() + UPGRADE_DEADLINE_MS;
			const timer = setInterval(() => {
				if (Date.now() > deadline) {
					clearInterval(timer);
					return;
				}
				void refresh();
			}, UI_POLL_MS);
			return () => clearInterval(timer);
		}, [state.busy, refresh]);

		/** 手动检查更新（强制联网，绕开 6 小时缓存）。 */
		const checkNow = react.useCallback(async () => {
			setChecking(true);
			setFailure("");
			try {
				const response = await fetch("/dsh-restart-autostart/upgrade/check", {
					method: "POST",
					headers: { "content-type": "application/json" },
				});
				const data = await response.json().catch(() => ({}));
				if (data.status) merge(data.status);
				if (data.ok === false) setFailure(data.error || ("HTTP " + response.status));
			} catch (err) {
				if (alive.current) setFailure(String(err && err.message ? err.message : err));
			} finally {
				if (alive.current) setChecking(false);
			}
		}, [merge]);

		/** 发起升级，然后盯到宿主重启并恢复。 */
		const start = react.useCallback(async () => {
			setFailure("");
			setElapsed(0);
			setWaitPhase("");
			setBusyUi(true);
			try {
				const response = await fetch("/dsh-restart-autostart/upgrade/start", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				});
				const data = await response.json().catch(() => ({}));
				if (data.status) merge(data.status);
				if (!response.ok || data.ok === false) {
					if (alive.current) {
						setBusyUi(false);
						setFailure(data.error || ("HTTP " + response.status));
					}
					return;
				}
			} catch (err) {
				if (alive.current) {
					setBusyUi(false);
					setFailure(String(err && err.message ? err.message : err));
				}
				return;
			}

			// ① 盯阶段：备份 → 安装 → 校验 → 重启中。
			const deadline = Date.now() + UPGRADE_DEADLINE_MS;
			let leaving = false;
			while (Date.now() < deadline && alive.current) {
				await new Promise((resolve) => setTimeout(resolve, UPGRADE_POLL_MS));
				if (!alive.current) return;
				let data = null;
				try {
					const response = await fetch("/dsh-restart-autostart/upgrade/status", { cache: "no-store" });
					if (response.ok) data = await response.json();
				} catch {
					// 宿主已经在下线：立刻转入等待恢复，别继续打卡。
				}
				if (data === null || data.phase === "restarting") { leaving = true; break; }
				merge(data);
				if (data.phase === "failed" || data.phase === "rolled-back") {
					// 失败时宿主还活着（根本没重启），停在这里把原因显示出来。
					if (alive.current) setBusyUi(false);
					return;
				}
			}
			if (!leaving) {
				if (alive.current) {
					setBusyUi(false);
					setFailure(t("upgradeTimeout"));
				}
				return;
			}

			// ② 等新宿主回来 —— 与重启完全相同的判据。
			let lastPaint = 0;
			const restored = await waitForService(alive, (tick) => {
				const now = Date.now();
				if (now - lastPaint < 100) return;
				lastPaint = now;
				if (!alive.current) return;
				setElapsed(tick.elapsed);
				setWaitPhase(tick.phase);
			});
			if (!alive.current) return;
			if (restored) {
				// 用 replace("/") 而不是 reload()：地址栏里那条 URL 带的是旧进程的
				// ?token=，新进程必定拒绝（详见 useRestart 里的同一处说明）。
				window.location.replace("/");
				return;
			}
			setBusyUi(false);
			setFailure(t("upgradeTimeout"));
		}, [merge, t]);

		/**
		 * 回滚到指定版本（不传则回到上一版）。
		 *
		 * @param version - 目标版本号；由界面上的版本选择给出。
		 */
		const rollback = react.useCallback(async (version = "") => {
			setFailure("");
			setBusyUi(true);
			try {
				const response = await fetch("/dsh-restart-autostart/upgrade/rollback", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(version === "" ? {} : { version }),
				});
				const data = await response.json().catch(() => ({}));
				if (data.status) merge(data.status);
				if (!response.ok || data.ok === false) {
					setFailure(data.error || data.detail || ("HTTP " + response.status));
					return;
				}
				// 回滚只换文件，进程还是旧的 → 必须重启才生效。
				await fetch("/dsh-restart-autostart/restart", {
					method: "POST",
					headers: { "content-type": "application/json" },
				}).catch(() => {});
				let lastPaint = 0;
				const restored = await waitForService(alive, (tick) => {
					const now = Date.now();
					if (now - lastPaint < 100) return;
					lastPaint = now;
					if (!alive.current) return;
					setElapsed(tick.elapsed);
					setWaitPhase(tick.phase);
				});
				if (restored && alive.current) window.location.replace("/");
			} catch (err) {
				if (alive.current) setFailure(String(err && err.message ? err.message : err));
			} finally {
				if (alive.current) setBusyUi(false);
			}
		}, [merge]);

		/**
		 * 拉「已发布版本」列表，供回滚时挑一个更老的版本。
		 *
		 * 只在用户点开版本选择时才调 —— 它要联网查 GitHub（未认证 60 次/小时），
		 * 而绝大多数时候用户只是看一眼面板，不需要这份清单。
		 *
		 * @returns `{ ok, versions, error? }`；失败不抛异常。
		 */
		const loadVersions = react.useCallback(async () => {
			try {
				const response = await fetch("/dsh-restart-autostart/upgrade/versions", { cache: "no-store" });
				if (!response.ok) throw new Error("HTTP " + response.status);
				return await response.json();
			} catch (err) {
				return { ok: false, versions: [], error: String(err && err.message ? err.message : err) };
			}
		}, []);

		/**
		 * 退出安全模式：把被隔离的第三方插件装回去。
		 *
		 * 路由本身会顺手重启（恢复 bundles 只有重启才生效），所以这里只做两件事：
		 * 发请求、盯服务回来。**不额外调 /restart** —— 那会触发第二次重启，
		 * 而且第二发的宿主可能刚好落在第一发刚恢复的窗口里，徒增竞态。
		 *
		 * @returns Promise，始终 resolve；失败写进 failure。
		 */
		const clearSafe = react.useCallback(async () => {
			setFailure("");
			setBusyUi(true);
			try {
				const response = await fetch("/dsh-restart-autostart/upgrade/safe-mode/clear", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				});
				const data = await response.json().catch(() => ({}));
				if (data.status) merge(data.status);
				if (!response.ok || data.ok === false) {
					setFailure(data.detail || data.error || ("HTTP " + response.status));
					return;
				}
				if (data.restarting !== true) return;
				let lastPaint = 0;
				const restored = await waitForService(alive, (tick) => {
					const now = Date.now();
					if (now - lastPaint < 100) return;
					lastPaint = now;
					if (!alive.current) return;
					setElapsed(tick.elapsed);
					setWaitPhase(tick.phase);
				});
				if (restored && alive.current) window.location.replace("/");
			} catch (err) {
				if (alive.current) setFailure(String(err && err.message ? err.message : err));
			} finally {
				if (alive.current) setBusyUi(false);
			}
		}, [merge]);

		return { ...state, checking, failure, busyUi, elapsed, waitPhase, refresh, checkNow, start, rollback, clearSafe, loadVersions };
	}

	/**
	 * 「DSH 主程序版本」设置行 —— 放在「设置 → 通用」的最下面。
	 *
	 * 位置动机：通用页底部本来就有「当前版本 x.y.z」，升级入口贴着版本号放，两件事
	 * 在语义上是一回事；标题栏也不再挤第三个按钮（那里只留「重启」）。
	 * order 取 10000，确保落在平台那行版本信息之后。
	 *
	 * 进度**内联**在这一行下方，不用浮层：通用页是纵向流式布局，行可以自然长高；
	 * 而浮层贴在标题栏下沿时会被滚动容器裁掉。更关键的是——点下去必须**立刻**有可见
	 * 变化（按钮变成「升级中…」＋出现进度条），否则会有「点了没反应」的错觉。
	 * @param props - 插槽 props：`t` 文案函数。
	 * @returns 行元素树（升级确认弹窗也挂在这里）。
	 */
	function UpdateRow({ t }) {
		const u = useUpgrade(t);
		// 弹窗类型："" 关着，"upgrade" 升级确认，"restore" 恢复插件确认。
		// 两者共用同一个遮罩，但文案与后果完全不同，不能合并成一个「确定」。
		const [confirming, setConfirming] = react.useState("");
		// 秒级心跳：只用于刷新「已等待 Ns」，不参与任何判断。
		const [nowTick, setNowTick] = react.useState(Date.now());
		// 组件是否还挂着：异步回调落地时先看它，避免在已卸载的组件上 setState。
		const aliveRef = react.useRef(true);
		react.useEffect(() => () => { aliveRef.current = false; }, []);

		// 回滚版本选择：picking 控制弹窗，pick 是当前选中的版本。
		// published 为 null 表示「还没查过已发布版本」—— 查它要联网，默认不查。
		const [picking, setPicking] = react.useState(false);
		const [pick, setPick] = react.useState("");
		const [published, setPublished] = react.useState(null);
		const [loadingVersions, setLoadingVersions] = react.useState(false);
		const [versionsError, setVersionsError] = react.useState("");

		/** 打开版本选择：默认选中最近的一个可回滚版本。 */
		const openPicker = () => {
			const candidates = Array.isArray(u.rollbacks) ? u.rollbacks : [];
			setPick(candidates.length > 0 ? candidates[0].version : "");
			setPublished(null);
			setVersionsError("");
			setPicking(true);
		};

		/** 联网拉「已发布版本」，填进同一个下拉的第二个分组。 */
		const loadPublished = async () => {
			setLoadingVersions(true);
			setVersionsError("");
			const data = await u.loadVersions();
			if (!aliveRef.current) return;
			setLoadingVersions(false);
			if (data.ok === false) {
				setVersionsError(data.error || t("upgradeVersionsFailed"));
				setPublished([]);
				return;
			}
			setPublished(Array.isArray(data.versions) ? data.versions : []);
		};

		// 安全模式：宿主是被 guard 用官方最小 bundle 拉起来的，第三方插件暂不在场。
		const safe = u.safeMode;
		const inSafe = safe !== null && typeof safe === "object";
		const removed = inSafe && Array.isArray(safe.removed) ? safe.removed : [];
		const suspects = inSafe && Array.isArray(safe.suspects) ? safe.suspects : [];

		// 升级中：按钮禁用并显示当前阶段，避免重复点击。
		const running = u.busyUi || u.busy;
		const restoring = inSafe && u.busyUi;
		const stageKey = restoring ? "upgradeSafeModeRestoring"
			: running
				? (u.phase === "install" ? "upgradeStageInstall"
					: u.phase === "verify" ? "upgradeStageVerify"
						// phase 仍是 idle 却在忙 ⇒ 本页刚点了恢复插件 / 回滚，正在等宿主重启。
						: u.phase === "restarting" || u.waitPhase !== "" || (u.busyUi && u.phase === "idle")
							? "upgradeStageRestart"
							: "upgradeStageBackup")
				: "";

		// 升级期间的 1s 心跳。只有升级中才挂，避免设置页空转重渲染。
		// 顺带记下「本页何时看到忙碌开始」—— 恢复插件、回滚重启这两条路径不经过
		// 服务端状态机（phase 仍是 idle），拿不到 startedAt，只能本地起算。
		const localStart = react.useRef(0);
		react.useEffect(() => {
			if (!running) { localStart.current = 0; return undefined; }
			if (localStart.current === 0) localStart.current = Date.now();
			const timer = setInterval(() => setNowTick(Date.now()), 1000);
			return () => clearInterval(timer);
		}, [running]);

		// 「已等待 Ns」：优先用**服务端记录的起点**，所以中途刷新页面也不会从 0 重来；
		// 只在服务端确实在跑升级流程时采信它（否则那份时间戳可能是几小时前那次升级的）。
		const serverActive = u.phase === "backup" || u.phase === "install"
			|| u.phase === "verify" || u.phase === "restarting";
		const stageBase = running
			? (serverActive && typeof u.startedAt === "number" && u.startedAt > 0 ? u.startedAt : localStart.current)
			: 0;
		const stageSeconds = stageBase > 0 ? Math.max(0, Math.round((nowTick - stageBase) / 1000)) : 0;

		// 第二行：**一行说清状态**。三种「没有新版」的成因必须分开说，否则
		// 「还没查过」会被误读成「已是最新」；升级中则把阶段与秒数并进同一行 ——
		// 以前阶段文案在状态行和进度条下面各印一遍，是纯粹的重复。
		const stateText = running
			? (stageSeconds > 0
				? t(stageKey) + " · " + t("upgradeStageElapsed").replace("{s}", String(stageSeconds))
				: t(stageKey))
			: inSafe ? t("upgradeSafeModeStatus").replace("{count}", String(removed.length))
				: u.loading ? t("upgradeLoading")
					: u.checking ? t("upgradeChecking")
						: u.hasUpdate === true ? t("upgradeHasNew").replace("{latest}", u.latest ?? "?")
							: u.hasUpdate === false ? t("upgradeUpToDate")
								: t("upgradeUnknown");

		// 版本号并进这一行，而不是单独占一行：单独一行时它和平台上方的
		// 「当前版本：x.y.z」挨着写同样的数字，看着像渲染错了；但完全去掉又不行 ——
		// 回滚、对比新版都要拿它对。并成「当前版本 x · 说明」同时满足两件事。
		// 升级中不加前缀：那行已经有阶段和秒数，再加版本会把人挤走。
		const statusText = !running && typeof u.current === "string" && u.current !== ""
			? t("upgradeCurrentPfx").replace("{v}", u.current) + " · " + stateText
			: stateText;

		// 回滚：只有真的存在可回滚的版本才给入口（本地备份或上次升级记录）。
		// 以前按钮写死「回滚到 {上次的版本}」—— 只能回最近一次，想再退一档就没有路；
		// 现在改成打开版本选择，可选本地备份里任意一版，也能联网挑更老的已发布版本。
		const rollbacks = Array.isArray(u.rollbacks) ? u.rollbacks : [];
		const canRollback = !running && rollbacks.length > 0;
		const action = inSafe
			? { label: t("upgradeSafeModeRestore"), kind: "solid", disabled: running, onClick: () => { setConfirming("restore"); } }
			: u.hasUpdate === true
				? { label: t("upgradeAction"), kind: "solid", disabled: running, onClick: () => { setConfirming("upgrade"); } }
				: { label: u.checking ? t("upgradeChecking") : t("upgradeRecheck"), kind: "ghost", disabled: u.checking || running, onClick: () => { void u.checkNow(); } };

		const buttons = [
			canRollback
				? react.createElement("button", {
					key: "rollback",
					type: "button",
					className: "rstb-btn rstb-btnGhost",
					onClick: () => { openPicker(); },
				}, t("upgradeRollback"))
				: null,
			react.createElement("button", {
				key: "action",
				type: "button",
				className: "rstb-btn" + (action.kind === "ghost" ? " rstb-btnGhost" : ""),
				disabled: action.disabled,
				onClick: action.onClick,
			}, running ? t(restoring ? "upgradeSafeModeRestoring" : "upgradeRunning") : action.label),
		].filter((child) => child !== null);

		const message = u.failure !== "" ? u.failure : (u.error !== "" ? u.error : "");

		const body = [
			react.createElement("div", { className: "rstb-head", key: "head" }, [
				react.createElement("div", { className: "rstb-rowText", key: "text" }, [
					react.createElement("div", { className: "rstb-title", key: "title" }, t("upgradeRowTitle")),
					// 版本号**不在这里重复**：平台就在这一行的正上方显示「当前版本：x.y.z」。
					// 以前又印一遍「当前版本 x.y.z」，紧挨着的两行同样的字，看着像渲染错了。
					react.createElement("div", { className: "rstb-note", key: "status" }, statusText),
				]),
				react.createElement("div", { className: "rstb-actions", key: "actions" }, buttons),
			]),
		];

		// 安全模式告警：必须说清「服务是好的、插件被摘了、谁可疑」三件事。
		// 缺任何一件，用户都会以为是自己手滑删了插件。
		if (inSafe) {
			const items = [
				react.createElement("div", { className: "rstb-safeItem", key: "why" },
					t("upgradeSafeModeBody").replace("{count}", String(removed.length))),
			];
			if (removed.length > 0) {
				items.push(react.createElement("div", { className: "rstb-safeItem rstb-code", key: "removed" },
					removed.join("、")));
			}
			if (suspects.length > 0) {
				items.push(react.createElement("div", { className: "rstb-safeItem", key: "sus" },
					t("upgradeSafeModeSuspects").replace("{list}", suspects.join("、"))));
			}
			if (typeof safe.at === "string" && safe.at !== "") {
				items.push(react.createElement("div", { className: "rstb-note", key: "at" },
					t("upgradeSafeModeAt").replace("{at}", safe.at)));
			}
			body.push(react.createElement("div", { className: "rstb-safe", key: "safe" }, [
				react.createElement("div", { className: "rstb-safeTitle", key: "t" }, t("upgradeSafeModeTitle")),
				...items,
			]));
		}

		if (running) {
			// 只留一条**扫光**进度条，不再在它下面重复印一遍阶段文案 —— 阶段已经并进
			// 上面那行状态了。不确定进度就不能画成一个钉住的固定百分比（以前是 30%），
			// 那条静止的黑条看上去就是「卡死了」。
			body.push(react.createElement("div", { className: "rstb-track", key: "track" },
				react.createElement("div", { className: "rstb-bar rstb-barBusy" })));
		}

		if (!running && !inSafe && u.hasUpdate === true) {
			body.push(react.createElement("div", { className: "rstb-note", key: "risk" }, t("upgradeRisk")));
		}

		if (message !== "") {
			body.push(react.createElement("div", { className: "rstb-error", key: "err" }, message));
		}

		const node = react.createElement("div", { className: "rstb-row" }, body);

		// 回滚版本选择弹窗
		if (picking) {
			const options = [];
			if (rollbacks.length > 0) {
				options.push(react.createElement("optgroup", { label: t("upgradeRollbackLocal"), key: "local" },
					rollbacks.map((item) => react.createElement("option", {
						key: item.version,
						value: item.version,
					}, item.version + (item.source === "backup" ? "" : t("upgradeRollbackNeedNet"))))));
			}
			if (Array.isArray(published)) {
				// 本地已有的版本不再重复列出（它们是同一个版本号，选了也只是走本地那条路径）。
				const localSet = new Set(rollbacks.map((item) => item.version));
				const extra = published.filter((item) => !localSet.has(item.version) && item.current !== true);
				if (extra.length > 0) {
					options.push(react.createElement("optgroup", { label: t("upgradeRollbackPublished"), key: "remote" },
						extra.map((item) => react.createElement("option", {
							key: item.version,
							value: item.version,
						}, item.version + (item.publishedAt ? " · " + item.publishedAt.slice(0, 10) : "")))));
				}
			}

			const pickerBody = [
				react.createElement("div", { className: "rstb-modalTitle", key: "t" }, t("upgradeRollbackTitle")),
				react.createElement("div", { className: "rstb-modalBody", key: "hint" },
					t("upgradeRollbackHint").replace("{current}", u.current ?? "?")),
			];
			if (options.length > 0) {
				pickerBody.push(react.createElement("select", {
					className: "rstb-select",
					key: "select",
					value: pick,
					onChange: (event) => { setPick(event.target.value); },
				}, options));
			}
			if (published === null) {
				pickerBody.push(react.createElement("div", { className: "rstb-modalBody", key: "more" }, [
					react.createElement("button", {
						key: "load",
						type: "button",
						className: "rstb-btn rstb-btnGhost",
						disabled: loadingVersions,
						onClick: () => { void loadPublished(); },
					}, loadingVersions ? t("upgradeVersionsLoading") : t("upgradeVersionsLoad")),
				]));
			}
			if (versionsError !== "") {
				pickerBody.push(react.createElement("div", { className: "rstb-error", key: "verr" }, versionsError));
			}
			pickerBody.push(react.createElement("div", { className: "rstb-modalActions", key: "ma" }, [
				react.createElement("button", {
					key: "cancel",
					type: "button",
					className: "rstb-btn rstb-btnGhost",
					onClick: () => { setPicking(false); },
				}, t("cancel")),
				react.createElement("button", {
					key: "ok",
					type: "button",
					className: "rstb-btn",
					disabled: pick === "",
					onClick: () => { setPicking(false); if (pick !== "") void u.rollback(pick); },
				}, t("upgradeRollbackGo")),
			]));

			return react.createElement("div", { className: "rstb-rowGroup" }, [
				node,
				react.createElement("div", { className: "rstb-overlay", key: "overlay" },
					react.createElement("div", { className: "rstb-modal" }, pickerBody)),
			]);
		}

		if (confirming === "") return node;
		const isRestore = confirming === "restore";
		return react.createElement("div", { className: "rstb-rowGroup" }, [
			node,
			react.createElement("div", { className: "rstb-overlay", key: "overlay" },
				react.createElement("div", { className: "rstb-modal" }, [
					react.createElement("div", { className: "rstb-modalTitle", key: "mt" },
						isRestore
							? t("upgradeSafeModeRestoreTitle").replace("{count}", String(removed.length))
							: t("upgradeConfirmTitle").replace("{latest}", u.latest ?? "?")),
					react.createElement("div", { className: "rstb-modalBody", key: "mb" },
						isRestore ? t("upgradeSafeModeRestoreBody") : t("upgradeConfirmBody")),
					react.createElement("div", { className: "rstb-modalActions", key: "ma" }, [
						react.createElement("button", {
							key: "cancel",
							type: "button",
							className: "rstb-btn rstb-btnGhost",
							onClick: () => { setConfirming(""); },
						}, t("cancel")),
						react.createElement("button", {
							key: "ok",
							type: "button",
							className: "rstb-btn",
							onClick: () => {
								setConfirming("");
								if (isRestore) void u.clearSafe();
								else void u.start();
							},
						}, isRestore ? t("upgradeSafeModeRestore") : t("upgradeConfirm")),
					]),
				]))
		]);
	}

	/**
	 * ① 「重启」按钮 —— 挂在设置面板的全局标题栏，紧挨官方「打开配置文件」左侧。
	 *
	 * 位置动机：原先它在「设置 → 通用」页里，而通用页内容越堆越长，每次都要滚动才找得到；
	 * 标题栏是**所有设置分页共用**的一行，放这里点开设置就能看到，彻底免去滚动。
	 *
	 * 外观刻意与官方「打开配置文件」一致（同一个 Button 组件、同样的 outline/sm），
	 * 只把颜色换成 danger —— 重启会中断所有会话与后台任务，视觉上必须先给出警告信号。
	 *
	 * 进度与结果用小浮层贴在按钮下方：标题栏高度只有 54px，行内塞不下文字，
	 * 也不能把标题栏撑高（会顶动整个设置面板的布局）。
	 * @param props - 插槽 props：`t` 文案函数。
	 * @returns 按钮与（重启中/失败时的）浮层。
	 */
	function HeaderRestart({ t }) {
		const r = useRestart(t);
		// 浮层关闭：仅用于「失败后用户手动收起」；重启中不允许关，否则看不到进度。
		const [dismissed, setDismissed] = react.useState(false);
		// 每次重新发起重启，都要让上一次的「已收起」失效。
		react.useEffect(() => {
			if (r.restarting) setDismissed(false);
		}, [r.restarting]);

		const button = Button !== null
			? react.createElement(Button, {
				key: "btn",
				type: "button",
				variant: "outline",
				size: "sm",
				className: "rstb-btnDanger",
				disabled: r.restarting,
				onClick: () => { r.setConfirming(true); },
			}, r.restarting ? t("restarting") : t("button"))
			: react.createElement("button", {
				key: "btn",
				type: "button",
				className: "rstb-btn rstb-btnGhost rstb-btnDanger",
				disabled: r.restarting,
				onClick: () => { r.setConfirming(true); },
			}, r.restarting ? t("restarting") : t("button"));

		// 说明走平台气泡（hover 才出现），按钮本身保持与「打开配置文件」同宽同级。
		const trigger = Tooltip === null ? button : react.createElement(Tooltip, {
			key: "tip",
			label: t("title") + "\n" + t("description"),
			side: "bottom",
			delayMs: 500,
			maxWidth: 260,
		}, button);

		/**
		 * 按钮下方的浮层：重启中显示阶段 + 秒数 + 进度条，失败/超时显示红字。
		 * 成功时页面马上 replace 到 "/"，无需展示。
		 */
		const flyout = (() => {
			if (dismissed) return null;
			if (!r.restarting && r.error === "") return null;
			let percent = 0;
			if (r.phase === "done") percent = 100;
			else if (r.phase === "stopping") percent = 35;
			else if (r.phase === "starting") {
				percent = 35 + Math.min(60, Math.round((r.elapsed / 12000) * 60));
			}
			const label = r.error !== ""
				? t("failedTip")
				: r.phase === "done" ? t("restored")
				: r.phase === "starting" ? t("starting")
				: t("stopping");
			const children = [
				react.createElement("div", { className: "rstb-flyoutHead", key: "head" }, [
					react.createElement("span", { className: "rstb-flyoutLabel", key: "l" }, label),
					r.error !== ""
						? react.createElement("button", {
							key: "x",
							type: "button",
							className: "rstb-flyoutClose",
							onClick: () => { setDismissed(true); },
						}, "×")
						: react.createElement("span", { className: "rstb-flyoutTime", key: "t" },
							(r.elapsed / 1000).toFixed(1) + "s")
				])
			];
			if (r.error !== "") {
				children.push(react.createElement("div", { className: "rstb-flyoutError", key: "err" }, r.error));
			} else {
				children.push(react.createElement("div", { className: "rstb-track", key: "track" },
					react.createElement("div", {
						className: "rstb-bar" + (r.phase === "done" ? " rstb-barDone" : ""),
						style: { width: percent + "%" }
					})));
			}
			return react.createElement("div", { className: "rstb-flyout", key: "flyout" }, children);
		})();

		const node = react.createElement("div", { className: "rstb-headerAction" }, [trigger, flyout]);

		if (!r.confirming) return node;
		return react.createElement("div", { className: "rstb-headerAction" }, [
			node,
			react.createElement("div", { className: "rstb-overlay", key: "overlay" },
				react.createElement("div", { className: "rstb-modal" }, [
					react.createElement("div", { className: "rstb-modalTitle", key: "mt" }, t("confirmTitle")),
					react.createElement("div", { className: "rstb-modalBody", key: "mb" }, t("confirmBody")),
					react.createElement("div", { className: "rstb-modalActions", key: "ma" }, [
						react.createElement("button", {
							key: "cancel",
							type: "button",
							className: "rstb-btn rstb-btnGhost",
							onClick: () => { r.setConfirming(false); }
						}, t("cancel")),
						react.createElement("button", {
							key: "ok",
							type: "button",
							className: "rstb-btn rstb-btnSolidDanger",
							onClick: () => { void r.doRestart(); }
						}, t("confirm"))
					])
				]))
		]);
	}

	/**
	 * ② 「跟随系统启动」设置行 —— 留在「设置 → 通用」。
	 *
	 * 重启按钮搬去标题栏后，这一行只剩自启开关，故标题也换成它自己的名字，
	 * 不再顶着「重启服务」的标题（否则会让人以为按钮丢了）。
	 *
	 * 只有勾选框可点：文字只负责触发 tooltip。勾选会**真的写入/移除系统自启条目**，
	 * 而鼠标要停在文字上看说明，若文字也是点击区，看一眼就会误改系统配置。
	 * @param props - 插槽 props：`t` 文案函数。
	 * @returns 行元素树。
	 */
	function AutostartRow({ t }) {
		const auto = useAutostart(t);

		const switchCell = (() => {
			const group = react.createElement("span", { className: "rstb-switch", key: "auto" }, [
				react.createElement("input", {
					key: "box",
					type: "checkbox",
					className: "rstb-box",
					checked: auto.enabled,
					disabled: auto.busy || auto.loading || !auto.supported,
					"aria-label": t("autoTitle"),
					onChange: (event) => { void auto.toggle(event.target.checked); },
				}),
			]);
			if (Tooltip === null) return group;
			// 三行封顶：说明 / 当前状态 / 平台提示（后者只在真出现时才加）。
			const lines = [t("autoDesc"), auto.statusText];
			if (!auto.loading && !auto.supported) lines.push(t("autoUnsupported"));
			else if (!auto.loading && auto.supported && !auto.verified) lines.push(t("autoUnverified"));
			return react.createElement(Tooltip, {
				key: "auto",
				label: lines.join("\n"),
				side: "bottom",
				// 与平台其它贴边控件一致（dockkit 那几个按钮也是 500）：扫过时不出气泡。
				delayMs: 500,
				maxWidth: 260,
			}, group);
		})();

		return react.createElement("div", { className: "rstb-row" }, [
			react.createElement("div", { className: "rstb-head", key: "head" }, [
				react.createElement("div", { className: "rstb-rowText", key: "text" }, [
					react.createElement("div", { className: "rstb-title", key: "title" }, t("autoTitle")),
					react.createElement("div", { className: "rstb-desc", key: "desc" }, t("autoDesc"))
				]),
				switchCell
			]),
			// 自启操作失败：必须可见（例如 launchctl 不在登录域，要人去终端补一条命令）。
			auto.error !== ""
				? react.createElement("div", { className: "rstb-error", key: "autoError" }, auto.error)
				: null
		].filter((child) => child !== null));
	}

	/**
	 * ② 「跟随系统启动」的状态与动作 —— 只给值，不管排版。
	 *
	 * 勾选 = 立刻把自启条目写入本机（macOS launchd / Linux systemd / Windows 服务），
	 * 下次系统启动时 DSH 随之启动，并由系统机制守护进程。
	 * 取消勾选 = 移除条目。
	 *
	 * 文案说「下次开机生效」，与实现一致：写入是本机的持久配置，
	 * 真正的可见效果要等下一次开机。
	 *
	 * 状态机：loading（首次读取）→ idle（可切换）→ busy（写入中）。
	 *
	 * 之所以抽成 hook 而不是自己渲染一整行：它只是自启行右端的子控件，
	 * 布局归 {@link AutostartRow}；而 error 必须由调用方内联渲染（不能塞进 tooltip）。
	 * @param t - 文案函数。
	 * @returns 供右端开关使用的状态与动作；`error` 需由调用方渲染成可见的一行。
	 */
	function useAutostart(t) {
		const [state, setState] = react.useState({
			loading: true,
			enabled: false,
			supported: true,
			verified: true,
		});
		const [busy, setBusy] = react.useState(false);
		const [error, setError] = react.useState("");
		// 组件卸载后停止写 state，避免对已消失的页面继续渲染。
		const alive = react.useRef(true);
		react.useEffect(() => () => { alive.current = false; }, []);

		/** 读取当前自启状态。 */
		const refresh = react.useCallback(async () => {
			try {
				const response = await fetch("/dsh-restart-autostart/autostart/status", { cache: "no-store" });
				if (!response.ok) throw new Error("HTTP " + response.status);
				const data = await response.json();
				if (!alive.current) return;
				setState({
					loading: false,
					enabled: data.enabled === true,
					supported: data.supported !== false,
					verified: data.verified !== false,
				});
			} catch {
				if (!alive.current) return;
				setState((prev) => ({ ...prev, loading: false }));
				setError(t("autoLoadFailed"));
			}
		}, [t]);

		react.useEffect(() => { void refresh(); }, [refresh]);

		/**
		 * 切换自启状态。
		 * @param next - 目标状态（true = 启用）。
		 */
		const toggle = react.useCallback(async (next) => {
			setBusy(true);
			setError("");
			try {
				const response = await fetch(
					next ? "/dsh-restart-autostart/autostart/enable" : "/dsh-restart-autostart/autostart/disable",
					{ method: "POST", headers: { "content-type": "application/json" } },
				);
				const data = await response.json().catch(() => ({}));
				if (!response.ok || data.ok === false) {
					if (!alive.current) return;
					setError(t("autoFailed") + (data.detail || ("HTTP " + response.status)));
					// 即便失败也重新拉一次真实状态，避免勾选框与磁盘不符。
					await refresh();
					return;
				}
				if (!alive.current) return;
				setState({
					loading: false,
					enabled: data.enabled === true,
					supported: data.supported !== false,
					verified: data.verified !== false,
				});
			} catch (err) {
				if (!alive.current) return;
				setError(t("autoFailed") + String(err && err.message ? err.message : err));
				await refresh();
			} finally {
				if (alive.current) setBusy(false);
			}
		}, [refresh, t]);

		const statusText = state.loading
			? t("autoLoading")
			: busy
				? (state.enabled ? t("autoDisabling") : t("autoEnabling"))
				: state.enabled ? t("autoOn") : t("autoOff");

		return { ...state, busy, error, statusText, toggle };
	}

	/**
	 * 客户端插件入口：注册中英文字典，并挂三处渲染点。
	 *
	 * 三处各注册一次、互不依赖：标题栏「更新」、标题栏「重启」、通用页「自启」行。
	 * 标题栏两项用 order 拉开顺序（-20 在 -10 左侧），都要落在官方
	 * 「打开配置文件」(order 0) 之前。
	 * @param ctx - cordis 客户端上下文。
	 */
	function apply(ctx) {
		installStyles();
		hideOfficialVersionRow();
		ctx.effect(() => ctx.locale.register(NS, { zh, en }), NS + ": dictionaries");
		const t = ctx.locale.bind(NS);

		// ① 重启：设置面板标题栏（所有分页共用），落在官方「打开配置文件」(order 0) 左侧。
		ctx.slots.inject("settings.action", () => ctx.slots.register({
			name: "settings.action",
			id: NS + "/restart",
			order: -10,
			locale: NS,
			inject: () => ({ t })
		}, HeaderRestart));

		// ② 「语言」(0)、「外观」(10/11)、自启(90) 之后就是平台的版本行；
		// 升级入口贴着版本号放在最下面（order 10000 确保排在版本行之后）。
		ctx.slots.inject("settings.general.item", () => ctx.slots.register({
			name: "settings.general.item",
			id: NS + "/upgrade",
			order: 10000,
			locale: NS,
			inject: () => ({ t })
		}, UpdateRow));

		// ③ 自启开关：留在「设置 → 通用」，属于系统配置。
		ctx.slots.inject("settings.general.item", () => ctx.slots.register({
			name: "settings.general.item",
			id: NS + "/autostart",
			order: 90,
			locale: NS,
			inject: () => ({ t })
		}, AutostartRow));
	}

	exports.apply = apply;
	exports.inject = inject;
	exports.name = name;
	return module.exports;
}});
