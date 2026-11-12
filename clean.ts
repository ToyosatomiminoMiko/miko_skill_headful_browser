#!/usr/bin/env node
/**
 * 是什么:清理运行时目录里可安全删除的产物。默认只做 dry-run,什么都不删。
 *
 * 为什么需要它:
 *   运行时目录里 profile/ 藏着登录态、cookie 与站点存储,误删代价高;
 *   而没有工具时,清理只能靠手写 rm,很容易把 profile/ 一起带走。
 *   所以把"哪些能删、哪些必须留"固化成代码,而不是靠人记文档。
 *
 * 安全设计:
 *   - 默认 dry-run:不加 --yes 只打印将要删除的内容,绝不落手。
 *   - 删除 profile/ 必须显式 --profile,且需要 --force;不加 --force 一律拒绝。
 *   - 删除 profile/ 前会探测 CDP 端口:浏览器还在跑就拒绝(运行中删 profile 会损坏它)。
 *     探测走 HTTP 端口而不是 pid,因为每次工具调用在独立 PID namespace 里看不到对方进程。
 *   - 无论删什么,技能目录都不在射程内:本脚本只处理运行时目录。
 *
 * 用法:
 *   node clean.ts                        # 预览:列出各项目大小与可删除性
 *   node clean.ts --shots --logs --yes   # 删截图与日志
 *   node clean.ts --all --yes            # 删除 profile 外的一切
 *   node clean.ts --profile --force --yes  # 连 profile 一起删(重置浏览器身份)
 *
 * 元信息:@dsh agent,2026-10-14
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { flagStringOpt, hasFlag, parseArgs } from './lib/args.ts';
import { resolveRuntime } from './lib/paths.ts';

const args = parseArgs(process.argv.slice(2), { valueFlags: ['runtime'] });
const paths = resolveRuntime({ runtime: flagStringOpt(args, 'runtime') });

interface CleanEntry {
  /** 能不能删 */
  safe: boolean;
  label: string;
  /** 为什么能删/不能删 —— 这段文字就是本脚本存在的主要意义 */
  why: string;
}

/** 条目顺序即预览输出顺序。 */
const ENTRIES: Record<string, CleanEntry> = {
  'state.json': {
    safe: true,
    label: '运行状态',
    why: '浏览器下次启动会重新生成;浏览器在跑时删它会断掉控制面,但 browserctl 能自动重建',
  },
  shots: { safe: true, label: '截图', why: 'screenshot 命令的产物,删掉后下次截图会自动重建目录' },
  logs: { safe: true, label: '日志', why: 'chromium/serve 日志,仅供排查,随时可删' },
  tmp: { safe: true, label: '临时目录', why: 'compare-ozone.ts 的平台对照临时 profile,用完即可删' },
  home: {
    safe: true,
    label: '重定向 HOME',
    why: '真实 HOME 只读所以重定向到这里;只含 Chromium 缓存配置,可删',
  },
  profile: {
    safe: false,
    label: '用户数据目录',
    why: '★ 登录态/cookie/localStorage 都在这。删掉 = 退出所有登录、清空站点数据',
  },
};

/** `--all` 覆盖的条目(不含 profile)。 */
const ALL_SAFE: readonly string[] = ['state.json', 'shots', 'logs', 'tmp', 'home'];

/** 单项开关名 → 目录条目名。显式列出,避免旧版 `name.replace('.json','')` 那种隐式约定。 */
const SELECTOR_FLAGS: ReadonlyMap<string, string> = new Map([
  ['state', 'state.json'],
  ['shots', 'shots'],
  ['logs', 'logs'],
  ['tmp', 'tmp'],
  ['home', 'home'],
  ['profile', 'profile'],
]);

function dirSize(p: string): number {
  let total = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) total += statSync(full).size;
    }
  };
  try {
    const st = statSync(p);
    if (st.isFile()) return st.size;
    walk(p);
  } catch {
    /* 无法访问则按 0 计 */
  }
  return total;
}

const human = (n: number): string =>
  n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}M` : n > 1024 ? `${(n / 1024).toFixed(0)}K` : `${n}B`;

/**
 * 浏览器是否在跑:走 CDP HTTP 端口,跨 PID namespace 也能判定。
 *
 * ★ 这里刻意用「保守口径」,不用 lib/cdp.ts 的 probeCdp:
 *   probeCdp 要求端口返回**合法 JSON**,而本函数是删除 profile 的最后一道闸。
 *   若端口上占着一个"返回 200 但不是 CDP"的东西(或 state.json 的 port 被人写成了字符串),
 *   probeCdp 会判"没在跑" → 于是浏览器还在跑却真把 profile 删了,登录态全丢。
 *   对安全闸来说,唯一正确的失效方向是**误拒**,不是误放:
 *   只要该端口上有 HTTP 响应,就当作"可能还在跑"。
 */
async function browserRunning(): Promise<boolean> {
  if (!existsSync(paths.stateFile)) return false;
  let port: number;
  try {
    const parsed = JSON.parse(readFileSync(paths.stateFile, 'utf8')) as { port?: unknown };
    // 端口归一化:手改或外部工具写成字符串 "9222" 也要认。
    const n = Number(parsed.port);
    if (!Number.isFinite(n) || n <= 0) return false;
    port = n;
  } catch {
    return false;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 清掉原子写可能残留的 `state.json.tmp-<pid>`(被 SIGKILL 时会留下)。 */
function sweepStateTemps(): number {
  let removed = 0;
  try {
    for (const e of readdirSync(paths.runtimeDir)) {
      if (e.startsWith('state.json.tmp-')) {
        rmSync(path.join(paths.runtimeDir, e), { force: true });
        removed++;
      }
    }
  } catch {
    /* 目录读不了就算了 */
  }
  return removed;
}

const selected: string[] = [];
if (hasFlag(args, 'all')) selected.push(...ALL_SAFE);
for (const [flag, entry] of SELECTOR_FLAGS) {
  if (hasFlag(args, flag)) selected.push(entry);
}

// ---- 预览 ----
console.log(`运行时目录:${paths.runtimeDir}`);
console.log(`技能目录  :${paths.skillDir}  (不在清理范围)\n`);
console.log('条目            大小   可删  说明');
for (const [name, meta] of Object.entries(ENTRIES)) {
  const p = path.join(paths.runtimeDir, name);
  const size = existsSync(p) ? human(dirSize(p)) : '(不存在)';
  console.log(`${name.padEnd(15)} ${size.padStart(8)}  ${meta.safe ? '✅' : '❌'}   ${meta.label} —— ${meta.why}`);
}

if (selected.length === 0) {
  console.log('\n未指定要删除的项。加上 --shots / --logs / --all 等,并配 --yes 才会真正删除。');
  process.exit(0);
}

const targets = [...new Set(selected)];
if (targets.includes('profile')) {
  if (!hasFlag(args, 'force')) {
    console.error('\n拒绝:删除 profile/ 会清空登录态与站点数据,必须显式加 --force 确认。');
    process.exit(2);
  }
  if (await browserRunning()) {
    console.error('\n拒绝:浏览器正在运行。运行中删除 profile/ 会导致会话损坏。请先停掉浏览器再重试。');
    process.exit(2);
  }
}

console.log(`\n将删除:${targets.join(', ')}`);
if (!hasFlag(args, 'yes')) {
  console.log('这是 dry-run(没有 --yes)。确认无误后加上 --yes 再跑一次。');
  process.exit(0);
}

for (const name of targets) {
  const p = path.join(paths.runtimeDir, name);
  if (!existsSync(p)) {
    console.log(`跳过 ${name}(不存在)`);
    continue;
  }
  rmSync(p, { recursive: true, force: true });
  console.log(`已删除 ${name}`);
  if (name === 'state.json') {
    const swept = sweepStateTemps();
    if (swept > 0) console.log(`已清理 state.json.tmp-* 残留 ${swept} 个`);
  }
}
console.log('\n完成。技能目录未被触碰。');
