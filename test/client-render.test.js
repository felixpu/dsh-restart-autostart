/**
 * 客户端渲染冒烟测试 —— 只验「组件能跑出树、文案不缺、回调不炸」这三件事。
 *
 * 为什么要它：客户端 bundle 是 `window.__ModuleLoader__.load(...)` 包起来的工厂函数，
 * 在 Node 里既不能 import 也不能跑 JSX；以前那类 bug（`setOpen` 写成未定义变量、
 * 文案键删了但没删引用）在**只有真机点击**时才会暴露 —— 而真机验证要开浏览器、
 * 输 token、点进设置，重得没人愿意每次跑。这里用一套极简 React 桩把组件**真正执行**一遍，
 * 把「点了没反应 / 控制台报错」压到一次 `node test/client-render.test.js`。
 *
 * 不验什么：样式、布局、真实 hook 语义（桩里 useEffect 不跑、setState 不重渲染）。
 * 它只能证明「没有运行时异常、没有裸文案键」，这恰好是历史故障的全部成因。
 *
 * 跑法： node test/client-render.test.js
 */
import fs from "node:fs";
import path from "node:path";

/** 用极简桩把客户端 bundle 装载起来，返回它的导出与「最后一次注册的组件」。 */
function loadBundle() {
	const source = fs.readFileSync(path.join(import.meta.dirname, "..", "client", "client.js"), "utf8");
	let loaded = null;

	/**
	 * 桩的控制器。
	 *
	 * - `state`：注入 useUpgrade 的状态对象（第一个对象型 useState）。
	 * - `overrides`：按 **hook 调用序号** 覆盖某个 useState 的当前值（用来模拟
	 *   `busyUi === true`）。
	 * - `setCalls`：记录组件里每次 setXxx 的调用，用来验证「某个状态被主动清了」——
	 *   这类行为在渲染结果上看不出来（桩不会真的重渲染），只能看调用。
	 * - `refs`：按 hook 序号复用 ref 对象，跨多次渲染保持，模拟同一组件实例。
	 * - `headStyles` / `injected`：head 里的 style 标签与注入记录。
	 */
	const noop = () => {};
	const control = {
		state: null, overrides: {}, setCalls: [], refs: [],
		// 模拟 document.head 里的 style 标签：tagId → textContent。
		// 「隐藏平台版本行」要靠它读到官方 CSS Modules 的真实类名，故必须可注入。
		headStyles: new Map(),
		// 记录所有被插进 head 的 style，供断言「注入了什么」。
		injected: [],
	};

	const fakeHead = {
		appendChild: (tag) => {
			const id = tag !== null && tag.dataset ? tag.dataset.pluginCss : undefined;
			if (typeof id !== "string") return;
			const text = String(tag.textContent ?? "");
			control.headStyles.set(id, text);
			control.injected.push({ id, text });
		},
	};
	const fakeDocument = {
		// 只支持本插件用到的那一种选择器：style[data-plugin-css="<tagId>"]
		querySelector: (selector) => {
			const hit = /^style\[data-plugin-css="(.+)"\]$/.exec(String(selector));
			if (hit === null || !control.headStyles.has(hit[1])) return null;
			return { textContent: control.headStyles.get(hit[1]) };
		},
		createElement: () => ({ setAttribute: noop, appendChild: noop, textContent: "", dataset: {} }),
		head: fakeHead,
	};
	const fakeWindow = { __ModuleLoader__: { load: (options) => { loaded = options; } } };

	// 客户端 bundle 是普通脚本（非 ESM），直接用 Function 求值即可，无需打包器。
	new Function("window", "document", source)(fakeWindow, fakeDocument);
	if (loaded === null || typeof loaded.factory !== "function") {
		throw new Error("bundle 没有调用 window.__ModuleLoader__.load");
	}

	/**
	 * hook 调用序号。每次 render 前归零 —— `overrides` 里的序号据此稳定指向同一个 hook。
	 */
	let hookIndex = 0;

	const react = {
		createElement: (type, props, ...children) => ({
			type,
			props: props || {},
			children: children.length === 0 ? [] : (children.length === 1 ? children[0] : children),
		}),
		useState: (initial) => {
			const index = hookIndex++;
			const record = (value) => control.setCalls.push({ index, value });
			// useUpgrade 的状态对象是唯一「对象型初值」—— 其余都是 boolean/number/string/null。
			if (initial !== null && typeof initial === "object" && initial.loading === true) {
				return [control.state !== null ? control.state : initial, record];
			}
			const value = Object.prototype.hasOwnProperty.call(control.overrides, index)
				? control.overrides[index]
				: initial;
			return [value, record];
		},
		useEffect: (fn) => { fn(); },
		useCallback: (fn) => fn,
		useRef: (value) => {
			const index = hookIndex++;
			if (control.refs[index] === undefined) control.refs[index] = { current: value };
			return control.refs[index];
		},
		useMemo: (fn) => fn(),
	};

	const module = loaded.factory((name) => {
		if (name === "react") return react;
		// 平台基础件取不到时应优雅退化（插件里已 try/catch），这里故意抛以覆盖该分支。
		throw new Error(`unexpected require: ${name}`);
	});

	/** 渲染一次：重置 hook 序号，让 overrides 的序号每次都指向同一个 hook。 */
	const render = (component, t) => {
		hookIndex = 0;
		return component({ t });
	};

	return { module, control, render };
}

/** 收集树里所有字符串节点。 */
function texts(node, out = []) {
	if (node === null || node === undefined || node === false) return out;
	if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
	if (Array.isArray(node)) { for (const child of node) texts(child, out); return out; }
	if (typeof node === "object") texts(node.children, out);
	return out;
}

/** 找到第一个文本匹配的按钮。 */
function findButton(node, label) {
	if (node === null || typeof node !== "object") return null;
	if (Array.isArray(node)) {
		for (const child of node) {
			const hit = findButton(child, label);
			if (hit !== null) return hit;
		}
		return null;
	}
	if (node.type === "button" && texts(node.children).join("") === label) return node;
	return findButton(node.children, label);
}

/** 把 createElement 的 children（可能是单对象、数组或 undefined）统一成数组。 */
function childList(node) {
	if (node === null || node === undefined) return [];
	const children = node.children;
	if (children === undefined || children === null || children === false) return [];
	return Array.isArray(children) ? children.filter((c) => c !== null && c !== undefined) : [children];
}

/** 找到第一个指定 type 的元素。 */
function findByType(node, type) {
	if (node === null || typeof node !== "object") return null;
	if (Array.isArray(node)) {
		for (const child of node) {
			const hit = findByType(child, type);
			if (hit !== null) return hit;
		}
		return null;
	}
	if (node.type === type) return node;
	return findByType(node.children, type);
}

/** 让挂起的 promise 落地（桩里的 useEffect 是同步执行的，异步回调要等一轮宏任务）。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

/** 从 ctx 桩里取出指定的插槽组件。 */
function grabComponent(exports, slotName, idSuffix) {
	const registered = new Map();
	const ctx = {
		effect: (fn) => fn(),
		locale: { register: () => {}, bind: () => dictT },
		slots: {
			inject: (_name, fn) => fn(),
			register: (config, component) => { registered.set(config.id, { config, component }); return config; },
		},
	};
	exports.apply(ctx);
	const key = [...registered.keys()].find((id) => id.endsWith(idSuffix));
	if (key === undefined) throw new Error(`没有注册插槽 ${slotName} / ${idSuffix}`);
	return registered.get(key);
}

/** 从已注册的字典里取文案：查不到就原样返回键名（裸键会在断言里被抓出来）。 */
let dictT = (key) => key;

function installDictT(exports, control) {
	// apply() 里会 ctx.locale.register(NS, { zh, en })；借它把 zh 字典捞出来。
	const ctx = {
		effect: (fn) => fn(),
		locale: {
			register: (_ns, dicts) => { dictZh = dicts.zh || {}; },
			bind: () => (key) => dictZh[key] !== undefined ? dictZh[key] : key,
		},
		slots: { inject: () => {}, register: () => ({}) },
	};
	exports.apply(ctx);
	dictT = ctx.locale.bind();
}

let dictZh = {};
let pass = 0;
let fail = 0;

function check(name, condition, detail) {
	if (condition) { console.log(`PASS  ${name}`); pass += 1; return; }
	console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
	fail += 1;
}

const baseState = {
	loading: false,
	current: "0.2.1-rc.3",
	latest: "0.2.1-rc.4",
	hasUpdate: true,
	phase: "idle",
	error: "",
	busy: false,
	last: null,
	pending: null,
	safeMode: null,
};

const safeState = {
	...baseState,
	hasUpdate: false,
	safeMode: {
		at: "2026-10-27T04:30:00.000Z",
		from: "0.2.1-rc.2",
		to: "0.2.1-rc.3",
		removed: ["dsh-better-sidebar", "@tr1v3r/dsh-ltm"],
		originalBundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-better-sidebar"],
		suspects: ["dsh-better-sidebar"],
		diagnostic: "simulated",
	},
};

// ── ① 普通状态：能出树、版本号在、无裸文案键 ───────────────────────────────
{
	const { module, control } = loadBundle();
	installDictT(module, control);
	control.state = baseState;
	const entry = grabComponent(module, "settings.general.item", "/upgrade");
	let tree = null;
	try {
		tree = entry.component({ t: dictT });
		check("render   普通状态能渲染出元素树", tree !== null && typeof tree === "object");
	} catch (error) {
		check("render   普通状态能渲染出元素树", false, `抛出：${error && error.message}`);
	}
	const flat = texts(tree).join("|");
	// 版本号**并进状态那一行**：单独占一行时，它和平台上方的「当前版本：x.y.z」
	// 紧挨着写同样的数字，看着像渲染错了（用户就是在截图里指的这一处）；
	// 完全去掉又不行 —— 回滚、对比新版都要拿它对。所以「当前版本 x · 说明」合成一行。
	check("no-dup   当前版本只印一次（不再另起一行重复）",
		flat.split("0.2.1-rc.3").length - 1 === 1, flat);
	check("status   版本号与状态说明在同一行",
		flat.includes("当前版本 0.2.1-rc.3 · 有新版本 0.2.1-rc.4，可一键升级。"), flat);
	const rawKeys = texts(tree).filter((text) => /^upgrade[A-Z]/.test(text));
	check("keys     没有裸文案键（字典不缺键）", rawKeys.length === 0, rawKeys.join("、"));

	// 用户的原话是「上面的当前版本就放到已是最新版本这个说明这里」——
	// 没有新版时，版本号必须和「已是最新版本」合并成一句，而不是两行。
	control.state = { ...baseState, latest: "0.2.1-rc.3", hasUpdate: false };
	const upToDate = texts(entry.component({ t: dictT })).join("|");
	check("status   「已是最新版本」那行带着当前版本",
		upToDate.includes("当前版本 0.2.1-rc.3 · 已是最新版本。"), upToDate);
}

// ── ② 安全模式：告警块、被摘插件、恢复按钮 ──────────────────────────────────
{
	const { module, control } = loadBundle();
	installDictT(module, control);
	control.state = safeState;
	const entry = grabComponent(module, "settings.general.item", "/upgrade");
	let tree = null;
	try {
		tree = entry.component({ t: dictT });
		check("safe     安全模式状态能渲染出元素树", tree !== null && typeof tree === "object");
	} catch (error) {
		check("safe     安全模式状态能渲染出元素树", false, `抛出：${error && error.message}`);
	}
	const flat = texts(tree).join("|");
	check("safe     显示了安全模式标题", flat.includes("已进入安全模式"), flat.slice(0, 200));
	check("safe     列出了被摘掉的插件", flat.includes("dsh-better-sidebar") && flat.includes("@tr1v3r/dsh-ltm"));
	check("safe     标出了疑似肇事插件", flat.includes("疑似涉事插件"));
	check("safe     给了恢复入口", findButton(tree, "恢复插件") !== null);
	const rawKeys = texts(tree).filter((text) => /^upgrade[A-Z]/.test(text));
	check("safe     没有裸文案键", rawKeys.length === 0, rawKeys.join("、"));

	// 这一条针对历史 bug：按钮 onClick 里引用了作用域外的变量，点下去抛 ReferenceError，
	// React 随即中断更新 —— 用户看到的就是「点了没反应」。
	const button = findButton(tree, "恢复插件");
	let clickError = null;
	try { button.props.onClick(); } catch (error) { clickError = error; }
	check("click    点「恢复插件」不抛异常", clickError === null, clickError && clickError.message);

	// 点了之后应出现确认弹窗（setConfirming("restore") 被桩吞掉，故只验不抛）。
	check("click    按钮是可用状态", button.props.disabled !== true);
}

// ── ③ 升级中：不能出现「可点的升级按钮」，进度条要在 ───────────────────────
{
	const { module, control } = loadBundle();
	installDictT(module, control);
	control.state = { ...baseState, phase: "install", busy: true, startedAt: Date.now() - 12000 };
	const entry = grabComponent(module, "settings.general.item", "/upgrade");
	const tree = entry.component({ t: dictT });
	const flat = texts(tree).join("|");
	check("busy    升级中显示了阶段文案", flat.includes("正在安装新版本"));
	check("busy    阶段文案只出现一次（不再重复印）",
		flat.split("正在安装新版本").length - 1 === 1, flat);
	check("busy    带上了服务端起算的已等待秒数", /已等待 \d+s/.test(flat), flat);
	const button = findButton(tree, "升级中…");
	check("busy    升级中按钮禁用并改文案", button !== null && button.props.disabled === true);
}

// ── ④ 回滚可以选版本：入口、弹窗、本地 / 已发布两个分组 ──────────────────────
//
// 旧实现把目标版本写死在按钮文案里（「回滚到 0.2.1-rc.2」）—— 只能退最近一档，
// 想再退一档就没有路。现在点「回滚…」打开版本选择：本地备份里的任意一版（免下载）
// 加上联网查到的已发布版本。同时「上次升级成功：x → y」那条播报已按用户要求删掉。
{
	const { module, control, render } = loadBundle();
	installDictT(module, control);
	const entry = grabComponent(module, "settings.general.item", "/upgrade");

	const rollbacks = [
		{ version: "0.2.1-rc.2", source: "backup", backupDir: "/tmp/backups/rc2" },
		{ version: "0.2.1-rc.1", source: "record", backupDir: null },
	];
	const last = {
		phase: "done", from: "0.2.1-rc.2", to: "0.2.1-rc.3",
		at: new Date(Date.now() - 3600 * 1000).toISOString(),
	};
	control.state = { ...baseState, latest: "0.2.1-rc.3", hasUpdate: false, rollbacks, last };

	let tree = render(entry.component, dictT);
	check("rollback 有可回滚版本时给出「回滚…」入口", findButton(tree, "回滚…") !== null);
	check("rollback 入口不再把目标版本写死在文案里",
		findButton(tree, "回滚到 0.2.1-rc.2") === null);

	// 这一条对应用户「这个提示我认为没有必要」那一句：无论 last 多新，都不该再播报。
	check("rollback 「上次升级成功」播报已移除",
		!texts(tree).join("|").includes("上次升级"), texts(tree).join("|"));

	// 点开 → 默认选中最近的一版（rollbacks[0]，已按版本号倒序）
	const mark = control.setCalls.length;
	let clickError = null;
	try { findButton(tree, "回滚…").props.onClick(); } catch (error) { clickError = error; }
	check("rollback 点「回滚…」不抛异常", clickError === null, clickError && clickError.message);
	const opened = control.setCalls.slice(mark);
	check("rollback 打开时默认选中最近的一版",
		opened.some((call) => call.value === "0.2.1-rc.2"), JSON.stringify(opened));

	// 桩不会重渲染，所以把三个状态按 hook 序号覆盖回去，再渲染一次得到弹窗本体。
	// 序号从 setCalls 里反查，不写死 —— 写死会随组件里 hook 增减而悄悄失效。
	const idxOf = (predicate) => opened.find(predicate)?.index;
	const pickingHook = idxOf((call) => call.value === true);
	const pickHook = idxOf((call) => call.value === "0.2.1-rc.2");
	const publishedHook = idxOf((call) => call.value === null);
	check("rollback 三个状态钩子都定位到了",
		[pickingHook, pickHook, publishedHook].every((i) => typeof i === "number"),
		JSON.stringify(opened));

	// 弹窗第一态：只有本地备份，published 仍是 null（还没联网查过）。
	control.overrides[pickingHook] = true;
	control.overrides[pickHook] = "0.2.1-rc.2";
	const panel = render(entry.component, dictT);
	const select = findByType(panel, "select");
	check("rollback 弹窗里有版本下拉", select !== null);
	const localOnly = select === null ? [] : childList(select).filter((child) => child.type === "optgroup");
	check("rollback 默认只给出「本地备份」分组（联网那份按需再查）",
		localOnly.length === 1 && localOnly[0].props.label === "本地备份（免下载，秒级）",
		localOnly.map((group) => group.props.label).join("、"));
	if (select !== null) {
		check("rollback 下拉默认值就是刚才选中的版本", select.props.value === "0.2.1-rc.2",
			String(select.props.value));
	}
	const go = findButton(panel, "回滚到此版本");
	check("rollback 选中版本后「回滚到此版本」可用", go !== null && go.props.disabled !== true);

	// 「查看更多已发布版本」要真的打到 /upgrade/versions（那是联网路由，默认不查）
	const realFetch = globalThis.fetch;
	const hits = [];
	globalThis.fetch = async (url) => {
		hits.push(String(url));
		return { ok: true, json: async () => ({ ok: true, versions: [{ version: "0.2.1-alpha.4" }] }) };
	};
	try {
		const load = findButton(panel, "查看更多已发布版本");
		check("rollback 弹窗里有「联网查更多版本」入口", load !== null);
		const tick = control.setCalls.length;
		if (load !== null) load.props.onClick();
		await flush();
		check("rollback 查版本打的是 /upgrade/versions",
			hits.some((url) => url.endsWith("/upgrade/versions")), hits.join(","));
		check("rollback 查回来的版本进了下拉",
			control.setCalls.slice(tick).some((call) => Array.isArray(call.value)
				&& call.value.some((item) => item.version === "0.2.1-alpha.4")),
			JSON.stringify(control.setCalls.slice(tick)));
	} finally {
		globalThis.fetch = realFetch;
	}

	// 弹窗第二态：已发布清单到位。本地已有 / 当前运行中的版本必须被滤掉，否则
	// 同一个版本号会在下拉里出现两次（分属两个分组），选哪个都说不清。
	control.overrides[publishedHook] = [
		{ version: "0.2.1-rc.3", current: true },
		{ version: "0.2.1-rc.2" },
		{ version: "0.2.1-alpha.5", publishedAt: "2026-10-01T08:00:00Z" },
	];
	const loaded = findByType(render(entry.component, dictT), "select");
	const groups = loaded === null ? [] : childList(loaded).filter((child) => child.type === "optgroup");
	const labels = groups.map((group) => group.props.label);
	check("rollback 两个分组都在", labels.includes("本地备份（免下载，秒级）")
		&& labels.includes("已发布版本（需联网下载）"), labels.join("、"));
	const values = groups.flatMap((group) => childList(group)).map((option) => option.props.value);
	check("rollback 本地已有和当前版本不会重复列出",
		values.filter((value) => value === "0.2.1-rc.2").length === 1 && !values.includes("0.2.1-rc.3"),
		values.join(","));
	check("rollback 能选到本地已没有的旧版本", values.includes("0.2.1-alpha.5"), values.join(","));
	check("rollback 查到清单后「联网查更多」入口收起",
		findButton(loaded, "查看更多已发布版本") === null);
	check("rollback 弹窗关闭后不留遮罩",
		findByType(tree, "select") === null && texts(tree).join("|").includes("已是最新版本"));
}

// ── ⑤ 状态收敛：宿主换版本后，「升级中」必须自己让位 ────────────────────────
//
// 这是用户截图里那个「服务早就装完、面板还写着升级中…」的直接回归测试。
// 关键点：升级成功后是**全新宿主进程**，它的状态机从 idle 开始，phase 永远不会
// 变成 done —— 所以判据只能是「宿主版本变了」。桩不重渲染，故直接看 setBusyUi 的调用。
{
	const { module, control, render } = loadBundle();
	installDictT(module, control);
	const entry = grabComponent(module, "settings.general.item", "/upgrade");

	// busyUi 是 useUpgrade 里第 4 个 useState（state / checking / failure / busyUi）。
	const BUSY_UI_HOOK = 3;

	const realFetch = globalThis.fetch;
	let scripted = null;
	globalThis.fetch = async () => ({ ok: true, json: async () => scripted });

	try {
		// ① 宿主还是 rc.2，安装进行中
		scripted = {
			ok: true, current: "0.2.1-rc.2", latest: "0.2.1-rc.3", hasUpdate: true,
			phase: "install", busy: true, startedAt: Date.now(), last: null, pending: null, safeMode: null,
		};
		control.state = {
			...baseState, current: "0.2.1-rc.2", latest: "0.2.1-rc.3", hasUpdate: true,
			phase: "install", busy: true, startedAt: Date.now(),
		};
		control.overrides[BUSY_UI_HOOK] = true; // 本页点过升级
		render(entry.component, dictT);
		await flush();
		const before = control.setCalls.filter((call) => call.index === BUSY_UI_HOOK).length;
		const clearedEarly = control.setCalls.some((c) => c.index === BUSY_UI_HOOK && c.value === false);
		check("converge 同一版本安装中不会误清「升级中」", !clearedEarly, JSON.stringify(control.setCalls));

		// ② 新宿主起来了：rc.3、idle、不忙 —— 版本变了，本地的「升级中」必须作废
		scripted = {
			ok: true, current: "0.2.1-rc.3", latest: "0.2.1-rc.3", hasUpdate: false,
			phase: "idle", busy: false, startedAt: null,
			last: { phase: "done", from: "0.2.1-rc.2", to: "0.2.1-rc.3", at: new Date().toISOString() },
			pending: null, safeMode: null,
		};
		control.state = {
			...baseState, current: "0.2.1-rc.3", latest: "0.2.1-rc.3", hasUpdate: false,
			phase: "idle", busy: false,
		};
		render(entry.component, dictT);
		await flush();
		const cleared = control.setCalls
			.slice(before)
			.some((call) => call.index === BUSY_UI_HOOK && call.value === false);
		check("converge 宿主版本变了就清掉本地的「升级中」", cleared, JSON.stringify(control.setCalls.slice(before)));
	} finally {
		globalThis.fetch = realFetch;
	}
}

// ── ⑥ 让平台的「当前版本」行让位（它和本插件的状态行写着同一个数字）──────────
//
// 平台那行由内置插件 `@deepseek-ai/dsh-client-ui-settings-general` 的 `CurrentVersionRow`
// 渲染，类名是 CSS Modules 的 `<hash>_row`（本轮在真机上看到的是 `yIbyla_row`，但哈希
// 随官方构建而变）。写死哈希等于埋一个「某次 dsh 升级后它又冒出来」的静默失效，
// 所以实现是「读官方自己注入的那张 style 表 → 解析出真实类名 → 补一条 display:none」。
{
	const OFFICIAL = "@deepseek-ai/dsh-client-ui-settings-general/CurrentVersionRow.module.css";

	// ① 正常情形：官方表已在 head 里。故意用一个「不是 yIbyla」的哈希，证明没写死。
	const { module, control } = loadBundle();
	control.headStyles.set(OFFICIAL,
		".q7Zk3p_row{color:var(--dsw-alias-label-primary);padding:16px 0;font-size:14px}");
	installDictT(module, control);
	const hides = () => control.injected.filter((item) => item.id.endsWith("/hide-official-version.css"));
	check("hide     注入了隐藏规则", hides().length === 1,
		JSON.stringify(control.injected.map((item) => item.id)));
	check("hide     用的是官方真实类名（哈希没被写死）",
		hides()[0]?.text === ".q7Zk3p_row{display:none}", hides()[0]?.text);
	check("hide     本插件自己的样式表不受影响",
		control.injected.some((item) => item.id.endsWith("/row.css")));

	// 重复挂载（HMR、来回切设置分页）不能叠加出第二张表
	installDictT(module, control);
	check("hide     重复挂载不会叠加注入", hides().length === 1, String(hides().length));

	// ② 官方改了命名（解析不出 `_row` 结尾的类）：什么都不做 ——
	//    同一个包里还有 DeveloperToolsRow 等 `_row` 类，宁可留着那一行也不能误伤。
	const other = loadBundle();
	other.control.headStyles.set(OFFICIAL, ".v9x_developerRow{display:flex;gap:24px}");
	installDictT(other.module, other.control);
	check("hide     解析不出类名时保持克制",
		other.control.injected.every((item) => !item.id.endsWith("/hide-official-version.css")),
		JSON.stringify(other.control.injected.map((item) => item.id)));

	// ③ 官方 bundle 比本插件晚执行：不抛异常，也不留半截状态
	const late = loadBundle();
	installDictT(late.module, late.control);
	check("hide     官方表还没出现时不抛异常，也不注入",
		late.control.injected.every((item) => !item.id.endsWith("/hide-official-version.css")));
}

console.log("----------------------------------------");
console.log(`${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
