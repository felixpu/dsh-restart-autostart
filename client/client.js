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
	try {
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		Tooltip = typeof primitives.Tooltip === "function" ? primitives.Tooltip : null;
	} catch {
		Tooltip = null;
	}

	/**
	 * dsh-restart-autostart 浏览器半身 —— 「设置 → 通用」里的一行。
	 *
	 * 由 dsh-restart-autostart-button 与 dsh-autostart 合并而来（现名 dsh-restart-autostart），仍是两条独立功能线：
	 *   ① 手动重启     —— 同源 POST /dsh-restart-autostart/restart
	 *   ② 重启守护     —— /dsh-restart-autostart/autostart/{status,enable,disable}
	 *
	 * 两者**合占一行**：自启开关挂在「重启服务」标题行的右端。它们同属「服务生命周期」，
	 * 而合并的直接动机是省高度 —— 原先各占一行，自启那行光「说明 + 状态」就吃掉两行文字。
	 * 之所以必须合并而不是调 CSS：`settings.general.item` 是**单列 flex、每项一棵独立
	 * DOM 子树**，两个注册永远并不到一行。
	 *
	 * 说明与状态改由 tooltip 承载；只有**失败信息**仍内联显示 —— 操作失败往往要人动手
	 * （例如 launchctl 不在登录域、要被叫去终端执行命令），藏进 tooltip 等于藏起来。
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
	 * 行样式：与通用设置其它行一致的排版。
	 *
	 * 前缀 rstb- 同时服务两行（重启 + 自启），故只注入一份样式表；
	 * 两行的差异通过 mod 类区分（竖排 vs 标题右侧控件）。
	 */
	const CSS = ".rstb-row{display:flex;flex-direction:column;gap:4px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-secondary,#e5e5e5)}" +
		".rstb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}" +
		".rstb-rowText{display:flex;flex-direction:column;gap:2px;min-width:0}" +
		".rstb-title{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-text-primary,inherit)}" +
		".rstb-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-text-tertiary,#8a8a8a)}" +
		".rstb-controls{display:flex;align-items:center;gap:8px;margin-top:8px}" +
		".rstb-btn{height:28px;padding:0 14px;border-radius:6px;border:1px solid transparent;font-size:12px;font-weight:600;line-height:18px;cursor:pointer;background:var(--dsw-alias-button-primary,#4f6ef7);color:#fff}" +
		".rstb-btn:hover:not(:disabled){filter:brightness(1.08)}" +
		".rstb-btn:disabled{opacity:.55;cursor:default}" +
		".rstb-btnGhost{background:transparent;color:var(--dsw-alias-text-secondary,inherit);border-color:var(--dsw-alias-border-secondary,#e5e5e5)}" +
		".rstb-btnGhost:hover:not(:disabled){background:var(--dsw-alias-bg-hover,#0000000d)}" +
		".rstb-status{font-size:12px;line-height:18px;color:var(--dsw-alias-text-tertiary,#8a8a8a)}" +
		".rstb-progress{display:flex;flex-direction:column;gap:6px;margin-top:10px}" +
		".rstb-progressHead{display:flex;align-items:baseline;justify-content:space-between;gap:8px}" +
		".rstb-progressLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-text-secondary,inherit)}" +
		".rstb-progressTime{font-size:11px;line-height:16px;color:var(--dsw-alias-text-tertiary,#8a8a8a);font-variant-numeric:tabular-nums}" +
		".rstb-track{height:4px;border-radius:2px;background:var(--dsw-alias-bg-hover,#00000014);overflow:hidden}" +
		".rstb-bar{height:100%;border-radius:2px;background:var(--dsw-alias-button-primary,#4f6ef7);transition:width .3s ease}" +
		".rstb-barDone{background:var(--dsw-alias-state-success-primary,#1a7f37)}" +
		".rstb-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#d1242f)}" +
		".rstb-overlay{position:fixed;inset:0;z-index:999;display:flex;align-items:center;justify-content:center;background:#00000061}" +
		".rstb-modal{width:440px;max-width:calc(100vw - 32px);background:var(--dsw-alias-bg-primary,#fff);border:1px solid var(--dsw-alias-border-secondary,#e5e5e5);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:10px;box-shadow:0 12px 40px #0000003d}" +
		".rstb-modalTitle{font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-text-primary,inherit)}" +
		".rstb-modalBody{font-size:12px;line-height:18px;color:var(--dsw-alias-text-secondary,inherit)}" +
		".rstb-modalActions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}" +
		".rstb-switch{flex:none;display:flex;align-items:center;gap:8px}" +
		".rstb-switchLabel{font-size:13px;line-height:20px;color:var(--dsw-alias-text-secondary,inherit);white-space:nowrap;user-select:none;cursor:default}" +
		".rstb-box{width:16px;height:16px;accent-color:var(--dsw-alias-button-primary,#4f6ef7);cursor:pointer}" +
		".rstb-box:disabled{cursor:default;opacity:.55}";

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
	 * ① 「重启服务」设置行。
	 *
	 * 三个状态：idle（可点击）→ confirming（二次确认）→ restarting（等待服务恢复）。
	 * 重启会切断本页与宿主的连接，所以不能依赖重启请求本身的回包判断成功，
	 * 只能轮询 /health 直到服务重新响应。
	 *
	 * 行内还挂着右端的「跟随系统启动」开关（见 {@link useAutostart}）—— 两者同属
	 * 服务生命周期，合成一行可省掉整行高度。
	 * @param props - 插槽 props：`t` 文案函数。
	 * @returns 行元素树。
	 */
	function RestartRow({ t }) {
		const [confirming, setConfirming] = react.useState(false);
		const [restarting, setRestarting] = react.useState(false);
		const [status, setStatus] = react.useState("");
		const [error, setError] = react.useState("");
		// 重启进度：phase 为 stopping/starting/done，elapsed 为已等待毫秒数。
		// 两者只服务于「让用户看见进度」，不参与成功与否的判定。
		const [phase, setPhase] = react.useState("");
		const [elapsed, setElapsed] = react.useState(0);
		// 组件卸载后停止轮询，避免对已消失的页面继续写 state。
		const alive = react.useRef(true);
		react.useEffect(() => () => { alive.current = false; }, []);

		/** 右端自启开关的状态与动作（排版在本组件，逻辑在 hook 里）。 */
		const auto = useAutostart(t);

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
			setStatus(t("restarting"));
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
					setStatus("");
					setError(t("failed") + "HTTP " + response.status);
					return;
				}
			} catch {
				// 连接可能在重启启动瞬间就断了，属预期路径，继续等待恢复。
			}
			setStatus(t("waiting"));
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
				setStatus(t("restored"));
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
			setStatus("");
			setError(t("timeout"));
		}, [t, waitForRestore]);

		/**
		 * 进度条：把「后台正在做什么」画在设置行里，取代控制台报错。
		 *
		 * 进度值不追求精确，只求单调推进且阶段正确：
		 *  - stopping：旧进程正在退出，进度 0→35%；
		 *  - starting：新进程正在启动，进度 35→95%，按 12s 估算爬升；
		 *  - done：已完成，100%。
		 * @returns 进度条元素，未在重启时为 null。
		 */
		const progress = (() => {
			if (!restarting) return null;
			let percent = 0;
			if (phase === "done") percent = 100;
			else if (phase === "stopping") percent = 35;
			else if (phase === "starting") {
				percent = 35 + Math.min(60, Math.round((elapsed / 12000) * 60));
			}
			const label = phase === "done" ? t("restored")
				: phase === "starting" ? t("starting")
				: t("stopping");
			const seconds = (elapsed / 1000).toFixed(1);
			return react.createElement("div", { className: "rstb-progress", key: "progress" }, [
				react.createElement("div", { className: "rstb-progressHead", key: "head" }, [
					react.createElement("span", { className: "rstb-progressLabel", key: "l" }, label),
					react.createElement("span", { className: "rstb-progressTime", key: "t" }, seconds + "s")
				]),
				react.createElement("div", { className: "rstb-track", key: "track" },
					react.createElement("div", {
						className: "rstb-bar" + (phase === "done" ? " rstb-barDone" : ""),
						style: { width: percent + "%" }
					}))
			]);
		})();

		/**
		 * 右端自启开关。
		 *
		 * 位置：文字在左、勾选框贴最右 —— 勾选框因此停在它独占一行时的**同一个 x 位置**，
		 * 改完视觉跳动最小。
		 *
		 * 只有勾选框可点：文字只负责触发 tooltip。勾选会**真的写入/移除系统自启条目**，
		 * 而鼠标要停在文字上看说明，若文字也是点击区，看一眼就会误改系统配置。
		 *
		 * 说明与状态走 tooltip（平台气泡，`position:fixed` 不会被面板裁切）；
		 * 多行靠 `\n` —— 气泡是 `white-space:pre-line`。
		 */
		const autoSwitch = (() => {
			const group = react.createElement("span", { className: "rstb-switch", key: "auto" }, [
				react.createElement("span", { className: "rstb-switchLabel", key: "label" }, t("autoTitle")),
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

		const children = [
			react.createElement("div", { className: "rstb-head", key: "head" }, [
				react.createElement("div", { className: "rstb-rowText", key: "text" }, [
					react.createElement("div", { className: "rstb-title", key: "title" }, t("title")),
					react.createElement("div", { className: "rstb-desc", key: "desc" }, t("description"))
				]),
				autoSwitch
			]),
			// 自启操作失败：必须可见（例如 launchctl 不在登录域，要人去终端补一条命令）。
			auto.error !== ""
				? react.createElement("div", { className: "rstb-error", key: "autoError" }, auto.error)
				: null,
			react.createElement("div", { className: "rstb-controls", key: "controls" }, [
				react.createElement("button", {
					key: "btn",
					type: "button",
					className: "rstb-btn",
					disabled: restarting,
					onClick: () => { setConfirming(true); }
				}, restarting ? t("restarting") : t("button")),
				status !== "" && progress === null
					? react.createElement("span", { className: "rstb-status", key: "status" }, status)
					: null,
				error !== "" ? react.createElement("span", { className: "rstb-error", key: "error" }, error) : null
			])
		].filter((child) => child !== null);

		if (progress !== null) children.push(progress);

		if (confirming) {
			children.push(react.createElement("div", { className: "rstb-overlay", key: "overlay" },
				react.createElement("div", { className: "rstb-modal" }, [
					react.createElement("div", { className: "rstb-modalTitle", key: "mt" }, t("confirmTitle")),
					react.createElement("div", { className: "rstb-modalBody", key: "mb" }, t("confirmBody")),
					react.createElement("div", { className: "rstb-modalActions", key: "ma" }, [
						react.createElement("button", {
							key: "cancel",
							type: "button",
							className: "rstb-btn rstb-btnGhost",
							onClick: () => { setConfirming(false); }
						}, t("cancel")),
						react.createElement("button", {
							key: "ok",
							type: "button",
							className: "rstb-btn",
							onClick: () => { void doRestart(); }
						}, t("confirm"))
					])
				])));
		}

		return react.createElement("div", { className: "rstb-row" }, children);
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
	 * 之所以抽成 hook 而不是自己渲染一整行：它现在只是「重启服务」那一行右端的子控件，
	 * 布局归 {@link RestartRow}；而 error 必须由调用方内联渲染（不能塞进 tooltip）。
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
	 * 客户端插件入口：注册中英文字典，并把这一行挂进通用设置。
	 *
	 * **只有一次注册** —— 自启开关是 RestartRow 的右端子控件，不再单独注册。
	 * 代价是两者同生共死（前者渲染异常会连带后者一起消失），换来的是省掉整行高度；
	 * 这是刻意的取舍，理由见文件头。
	 * @param ctx - cordis 客户端上下文。
	 */
	function apply(ctx) {
		installStyles();
		ctx.effect(() => ctx.locale.register(NS, { zh, en }), NS + ": dictionaries");
		const t = ctx.locale.bind(NS);

		// 「语言」(0)、「外观」(10/11) 之后就是这一行。
		ctx.slots.inject("settings.general.item", () => ctx.slots.register({
			name: "settings.general.item",
			id: NS + "/restart",
			order: 90,
			locale: NS,
			inject: () => ({ t })
		}, RestartRow));
	}

	exports.apply = apply;
	exports.inject = inject;
	exports.name = name;
	return module.exports;
}});
