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

	const noop = () => {};
	const fakeDocument = {
		querySelector: () => null,
		createElement: () => ({ setAttribute: noop, appendChild: noop, textContent: "", dataset: {} }),
		head: { appendChild: noop },
	};
	const fakeWindow = { __ModuleLoader__: { load: (options) => { loaded = options; } } };

	// 客户端 bundle 是普通脚本（非 ESM），直接用 Function 求值即可，无需打包器。
	new Function("window", "document", source)(fakeWindow, fakeDocument);
	if (loaded === null || typeof loaded.factory !== "function") {
		throw new Error("bundle 没有调用 window.__ModuleLoader__.load");
	}

	/**
	 * 桩的控制器。
	 *
	 * - `state`：注入 useUpgrade 的状态对象（第一个对象型 useState）。
	 * - `overrides`：按 **hook 调用序号** 覆盖某个 useState 的当前值（用来模拟
	 *   `busyUi === true`）。
	 * - `setCalls`：记录组件里每次 setXxx 的调用，用来验证「某个状态被主动清了」——
	 *   这类行为在渲染结果上看不出来（桩不会真的重渲染），只能看调用。
	 * - `refs`：按 hook 序号复用 ref 对象，跨多次渲染保持，模拟同一组件实例。
	 */
	const control = { state: null, overrides: {}, setCalls: [], refs: [] };
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
	// 版本号由平台在正上方那行「当前版本：x.y.z」负责，本行**不再重复印一遍**。
	// 以前两行紧挨着写同一个数字，看着像渲染错了（用户就是在截图里指的这一处）。
	check("no-dup   行内不再重复印当前版本", !flat.includes("0.2.1-rc.3"), flat);
	const rawKeys = texts(tree).filter((text) => /^upgrade[A-Z]/.test(text));
	check("keys     没有裸文案键（字典不缺键）", rawKeys.length === 0, rawKeys.join("、"));
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

// ── ④ 「上次升级…」的保鲜期：一天内播报，过期静默 ─────────────────────────
{
	const { module, control } = loadBundle();
	installDictT(module, control);
	const recent = {
		phase: "done", from: "0.2.1-rc.2", to: "0.2.1-rc.3",
		at: new Date(Date.now() - 3600 * 1000).toISOString(),
	};
	control.state = { ...baseState, hasUpdate: false, last: recent };
	const entry = grabComponent(module, "settings.general.item", "/upgrade");
	const flat = texts(entry.component({ t: dictT })).join("|");
	check("last     一天内的升级结果会播报", flat.includes("上次升级成功"), flat);

	const stale = { ...recent, at: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString() };
	control.state = { ...baseState, hasUpdate: false, last: stale };
	const tree = grabComponent(module, "settings.general.item", "/upgrade").component({ t: dictT });
	const flatOld = texts(tree).join("|");
	check("last     超过一天就不再显示（长期噪声）", !flatOld.includes("上次升级成功"), flatOld);
	check("last     但回滚按钮仍在（那是动作，不是播报）",
		findButton(tree, "回滚到 0.2.1-rc.2") !== null);
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
	const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

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

console.log("----------------------------------------");
console.log(`${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
