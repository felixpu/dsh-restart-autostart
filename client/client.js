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
	 * dsh-restart-autostart 浏览器半身 —— 设置面板标题栏的动作 + 「设置 → 通用」里的一行。
	 *
	 * 由 dsh-restart-autostart-button 与 dsh-autostart 合并而来（现名 dsh-restart-autostart），仍是两条独立功能线：
	 *   ① 手动重启     —— 标题栏按钮 + 确认弹窗，同源 POST /dsh-restart-autostart/restart
	 *   ② 重启守护     —— 通用页那一行的勾选框，/dsh-restart-autostart/autostart/{status,enable,disable}
	 *
	 * 两者现在**分处两地**：
	 *   ① 手动重启 —— 挂进设置面板的**全局标题栏**（槽 `settings.action`），
	 *      紧挨官方「打开配置文件」左侧，位于关闭按钮之前。任何设置分页都能点它，
	 *      不必再滚动「通用」页去找（这正是本次改动要解决的问题）。
	 *   ② 自启开关 —— 留在「设置 → 通用」的那一行，标题改成它自己的名字。
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
		".rstb-flyoutClose:hover{background:var(--dsw-alias-interactive-bg-hover,#0000000d)}";

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

		/**
		 * 等待服务恢复，并在过程中回报进度。
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
		 * @param onTick - 每轮回报进度：`{ elapsed, phase }`。
		 * @returns 服务是否在超时前恢复。
		 */
		const waitForRestore = react.useCallback(async (onTick) => {
			const startedAt = Date.now();
			const deadline = startedAt + POLL_TIMEOUT_MS;

			// ① 静默窗口：不探测，只推进进度条。
			while (Date.now() - startedAt < INITIAL_GRACE_MS) {
				if (!alive.current) return false;
				await new Promise((resolve) => setTimeout(resolve, 200));
				onTick({ elapsed: Date.now() - startedAt, phase: "stopping" });
			}

			// ② 探测阶段：两条判据都满足才算恢复。
			let healthReady = false;
			while (Date.now() < deadline) {
				if (!alive.current) return false;
				await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
				if (!alive.current) return false;
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
		}, []);

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
	 * 客户端插件入口：注册中英文字典，并挂两处渲染点。
	 *
	 * 两处各注册一次、互不依赖：标题栏按钮（重启）与通用页行（自启）。
	 * 之所以拆开，是因为重启要从「通用页深处」搬到「全局标题栏」；
	 * 而自启开关属于系统配置，留在通用页更自然。
	 * @param ctx - cordis 客户端上下文。
	 */
	function apply(ctx) {
		installStyles();
		ctx.effect(() => ctx.locale.register(NS, { zh, en }), NS + ": dictionaries");
		const t = ctx.locale.bind(NS);

		// ① 设置面板标题栏（所有分页共用）：order 为负，落在官方「打开配置文件」(order 0) 左侧。
		ctx.slots.inject("settings.action", () => ctx.slots.register({
			name: "settings.action",
			id: NS + "/restart",
			order: -10,
			locale: NS,
			inject: () => ({ t })
		}, HeaderRestart));

		// ② 「语言」(0)、「外观」(10/11) 之后就是自启这一行。
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
