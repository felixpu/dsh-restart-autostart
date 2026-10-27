/**
 * 版本解析 —— 本地版本、GitHub 最新版、版本比较、检查结果缓存。
 *
 * 三条实测结论决定了这里的实现（2026-10-27 验证）：
 *
 * 1. **版本来源取 GitHub Releases，不取 npm dist-tags。**
 *    npm 上存在「只改版本号、代码零改动」的僵尸发布：0.2.1-rc.4 与 rc.3 的主包
 *    `lib/` shasum 完全相同（bd7b0b7a4d2aa6f7）、tarball 仅差 2 字节，唯一不同的
 *    文件是 package.json 里的版本号字符串。按 npm 的 next 标签升级，用户会看到
 *    「已是最新 rc.4」而实际代码一行没变，反而更难判断。
 *
 * 2. **不能用 `/releases/latest`** —— 该项目所有 release 都是 prerelease，
 *    该端点会直接跳过并返回 404。必须取 `/releases` 列表，过滤 draft 后按
 *    `published_at` 倒序取第一条。
 *
 * 3. **tag 前缀是 `dsh-v` 而不是 `v`**，形如 `dsh-v0.2.1-rc.3`。
 *
 * @module dsh-restart-autostart/upgrade/version
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 上游仓库（版本来源）。 */
const REPO = 'deepseek-ai/deepseek-harness';

/** npm 包名。 */
export const PKG = '@deepseek-ai/dsh';

/** release tag 前缀。 */
const TAG_PREFIX = 'dsh-v';

/** 配置根目录（与 guard/index.js 的 HOME_DIR 同一个位置）。 */
export const HOME_DIR = path.join(os.homedir(), '.dsh-restart-autostart');

/** 检查结果缓存文件。 */
const CACHE_FILE = path.join(HOME_DIR, 'upgrade-check.json');

/**
 * 缓存有效期。
 *
 * 取 6 小时是一个折中：GitHub 未认证 API 上限 60 次/小时，若每次打开设置面板都查，
 * 反复开关面板就会把配额烧光（触发 403）；而 6 小时内漏掉一次发布的代价很小 ——
 * 用户还可以点「重新检查」手动刷新。
 */
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * 全局安装前缀 —— 由**当前宿主进程的 node** 推导。
 *
 * 为什么不用 `npm root -g`：那取决于 shell 里先命中哪个 npm。本机同时装着
 * WorkBuddy 内置 node 与 nvm 两套，WorkBuddy 的 bin 排在 PATH 最前，于是
 * `npm root -g` 会稳定返回 `~/.workbuddy/binaries/node/.../lib/node_modules`，
 * 而 dsh 根本不在那儿。照那个前缀去装，就会出现「装成功了、版本没变」——
 * 新装一份在别处，守护照旧加载老的这份，是最难查的假成功。
 *
 * 宿主自己的 `process.execPath` 才是唯一可靠锚点：guard.js 的 locateDsh() 与
 * manual/restart.js 的 locateDsh() 用的是同一套推导，升级必须打到同一份上。
 *
 * @returns 全局前缀绝对路径，例如 `~/.nvm/versions/node/v22.22.0`。
 */
export function prefixDir() {
  return path.resolve(path.dirname(process.execPath), '..');
}

/**
 * dsh 主程序包目录。
 * @returns 形如 `<prefix>/lib/node_modules/@deepseek-ai/dsh`。
 */
export function dshPackageDir() {
  return path.join(prefixDir(), 'lib', 'node_modules', ...PKG.split('/'));
}

/**
 * 读取本地已安装版本。
 *
 * 直接读 package.json 而不是跑 `dsh --version`：后者要起一个 node 进程（约 200ms），
 * 而状态接口会被前端反复轮询；且升级前后都要读，读盘最不容易出错。
 * 读不到返回 null，由调用方决定如何呈现。
 * @returns 版本字符串或 null。
 */
export function localVersion() {
  try {
    const raw = fs.readFileSync(path.join(dshPackageDir(), 'package.json'), 'utf8');
    const version = JSON.parse(raw).version;
    return typeof version === 'string' && version !== '' ? version : null;
  } catch {
    return null;
  }
}

/**
 * 语义化版本比较，只处理 `x.y.z` 与 `x.y.z-pre.N` 两种形态（本项目的实际用法）。
 *
 * 不能直接用字符串比较：`0.2.1-rc.10` 字典序小于 `0.2.1-rc.9`，而语义上更大。
 * 也不能用 localeCompare：它对数字段的处理依赖 locale 与 numeric 选项，不稳定。
 *
 * @param a - 版本 A。
 * @param b - 版本 B。
 * @returns A > B 返回 1，相等 0，A < B 返回 -1。
 */
export function cmpVersion(a, b) {
  if (a === b) return 0;
  const parse = (value) => {
    const matched = String(value).match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.?(\d+)?)?/i);
    if (!matched) return null;
    return {
      nums: [Number(matched[1]), Number(matched[2]), Number(matched[3])],
      pre: matched[4] ? matched[4].toLowerCase() : '',
      preNo: matched[5] ? Number(matched[5]) : 0,
    };
  };
  const left = parse(a);
  const right = parse(b);
  // 解析不出来就退回字符串比较，至少给出稳定结果（不抛异常）。
  if (left === null || right === null) return a > b ? 1 : -1;

  for (let index = 0; index < 3; index += 1) {
    if (left.nums[index] !== right.nums[index]) return left.nums[index] > right.nums[index] ? 1 : -1;
  }
  if (left.pre === right.pre) {
    if (left.preNo === right.preNo) return 0;
    return left.preNo > right.preNo ? 1 : -1;
  }
  // 有预发布标识的版本低于同号正式版：1.0.0-rc.1 < 1.0.0。
  if (left.pre === '') return 1;
  if (right.pre === '') return -1;
  return left.pre > right.pre ? 1 : -1;
}

/**
 * 读检查缓存。读不到或格式不对都返回 null —— 缓存坏了只该导致「重新查一次」。
 * @returns `{ latest, tag, publishedAt, checkedAt }` 或 null。
 */
export function readCache() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (typeof data.latest !== 'string' || data.latest === '') return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * 写检查缓存；失败就放弃（缓存只是省配额，写不进去不影响功能）。
 * @param info - 待缓存的对象。
 */
function writeCache(info) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  } catch {
    // 忽略：下次会重新查。
  }
}

/**
 * 从 release tag 解析出版本号（`dsh-v0.2.1-rc.3` → `0.2.1-rc.3`）。
 * @param tag - release 的 tag_name。
 * @returns 版本字符串；无法解析时返回空串。
 */
function versionFromTag(tag) {
  const raw = typeof tag === 'string' ? tag : '';
  return raw.startsWith(TAG_PREFIX) ? raw.slice(TAG_PREFIX.length)
    : raw.startsWith('v') ? raw.slice(1) : raw;
}

/**
 * 拉取 release 列表（已过滤 draft、按发布时间倒序、带解析后的版本号）。
 *
 * 抽出来是因为「最新版」和「回滚时可选的已发布版本」用的是同一个请求：
 * 两份各自 fetch 既浪费 GitHub 的 60 次/小时配额，也会出现两边结论不一致。
 *
 * @returns `[{ version, tag, publishedAt }]`，最新在前。
 */
async function fetchReleaseList() {
  const api = `https://api.github.com/repos/${REPO}/releases?per_page=20`;
  const response = await fetch(api, {
    headers: {
      // GitHub API 要求带 User-Agent，否则直接 403。
      'user-agent': 'dsh-restart-autostart',
      accept: 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const hint = response.status === 403
      ? '（可能触发速率限制：未认证 60 次/小时）'
      : response.status === 404 ? '（仓库或接口不可见）' : '';
    throw new Error(`GitHub API ${response.status} ${response.statusText}${hint}`);
  }

  const list = await response.json();
  return (Array.isArray(list) ? list : [])
    .filter((item) => item && item.draft !== true)
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
    .map((item) => ({
      version: versionFromTag(item.tag_name),
      tag: typeof item.tag_name === 'string' ? item.tag_name : '',
      publishedAt: typeof item.published_at === 'string' ? item.published_at : '',
    }))
    .filter((item) => item.version !== '');
}

/**
 * 查询 GitHub 最新 release。
 *
 * @param force - true 时忽略缓存强制联网。
 * @returns `{ latest, tag, publishedAt, checkedAt, cached }`；失败时抛出带原因的 Error。
 */
export async function latestRelease({ force = false } = {}) {
  const cached = readCache();
  const fresh = cached !== null && Date.now() - Date.parse(cached.checkedAt) < CACHE_TTL_MS;
  if (!force && fresh) return { ...cached, cached: true };

  const list = await fetchReleaseList();
  if (list.length === 0) throw new Error('GitHub 上没有任何可用 release');

  const info = {
    latest: list[0].version,
    tag: list[0].tag,
    publishedAt: list[0].publishedAt,
    checkedAt: new Date().toISOString(),
  };
  writeCache(info);
  return { ...info, cached: false };
}

/**
 * 已发布版本列表（供「回滚到指定版本」挑选）。
 *
 * 每次调用都联网，由调用方决定缓存策略 —— 回滚是低频操作，且用户点开菜单时
 * 最该看到的是**此刻真实存在**的版本，而不是几小时前的缓存。
 *
 * @param options - `{ limit }`，默认最多 12 条。
 * @returns `{ ok, versions, error? }`；失败不抛异常，把原因放进 `error`。
 */
export async function publishedVersions({ limit = 12 } = {}) {
  try {
    const list = await fetchReleaseList();
    return { ok: true, versions: list.slice(0, limit) };
  } catch (error) {
    return {
      ok: false,
      versions: [],
      error: error && error.message ? error.message : String(error),
    };
  }
}
