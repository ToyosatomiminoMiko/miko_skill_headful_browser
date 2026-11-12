#!/usr/bin/env node
/**
 * 是什么:有头(headful)Chromium 的常驻启动器 —— 前台运行 Chromium 并开启 CDP 调试端口,
 *        配套 browserctl.ts 通过 CDP 完成导航/截图/读屏/点击输入。
 *
 * 目录约定(技能与产物严格分离):
 *   - 本脚本所在目录 = 技能目录,只放可复用代码,运行时不得写入。
 *   - 所有产物(state.json / profile/ / home/ / shots/ / logs/)一律写到运行时目录,
 *     默认 ~/.dsh/browser-runtime,可用 BROWSER_RUNTIME_ROOT 或 --runtime= 覆盖。
 *     ★ 这个默认值刻意不放在技能目录旁边:技能住在 ~/.dsh/skills/ 里,
 *       若默认"上一级",产物就会堆进 ~/.dsh/,与技能混居、也与其它 DSH 数据混居。
 *     这样技能被复制、更新或覆盖时,登录态(profile)与历史产物都不会丢。
 *
 * 为什么必须这样启动:
 *  1. 本 harness 每次 bash 调用结束后会回收该调用派生的所有进程(bwrap --die-with-parent),
 *     所以 `nohup/setsid ... &` 起的浏览器活不过一次调用。唯一常驻方式是把它作为
 *     harness 的「托管后台作业」运行(即本脚本以前台方式跑在后台作业里)。
 *  2. HOME 指向运行时目录:沙箱把真实 HOME 挂成只读,Chromium 无法在其中写配置。
 *  3. 沙箱内没有 /dev/dri,GPU 必然不可用,固定 SwiftShader 软件渲染。
 *
 * 平台与自动回滚:
 *   默认 --ozone-platform=wayland。启动前先探测 WAYLAND_DISPLAY 的 unix socket 是否真能连上
 *   (文件存在但没人 listen 也算不可用);连不上、或 CDP 端口不就绪、或 chromium 提前退出,
 *   都会自动改用 x11 重试一次。可用 --no-fallback 禁止回滚,或用 --platform=x11 直接指定。
 *
 * 用法:
 *   node serve.ts                                   # 有头 + wayland(默认)
 *   node serve.ts --platform=x11                    # 强制走 XWayland
 *   node serve.ts --headless                        # 无头兜底
 *   node serve.ts --url=<起始地址> --port=<CDP 端口> --runtime=<运行时目录>
 *
 * 元信息:@dsh agent,2026-10-14
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { flagNumber, flagString, flagStringOpt, hasFlag, parseArgs, parseWindowSize } from './lib/args.ts';
import { probeCdp, getTargetsHttp, type CdpVersion } from './lib/cdp.ts';
import { resolveRuntime } from './lib/paths.ts';
import { writeState, type BrowserState } from './lib/state.ts';

const args = parseArgs(process.argv.slice(2), {
  valueFlags: ['url', 'port', 'size', 'platform', 'bin', 'runtime'],
});

// ---- 技能目录(代码) vs 运行时目录(产物) ----
const paths = resolveRuntime({ runtime: flagStringOpt(args, 'runtime') });
const PORT = flagNumber(args, 'port', 9222);
const START_URL = flagString(args, 'url', 'about:blank');
// 尺寸在启动前就校验:非法值若拼进 --window-size 交给 chromium,只会得到一个
// "窗口尺寸怪怪的"结果,排查成本远高于当场报错。
const WINDOW_SIZE = parseWindowSize(flagString(args, 'size', '1440x900'));
const HEADLESS = hasFlag(args, 'headless');
const PLATFORM = flagString(args, 'platform', 'wayland');
const NO_FALLBACK = hasFlag(args, 'no-fallback');
const BIN = flagString(args, 'bin', '/usr/bin/chromium-browser');
// getuid 在非 POSIX 平台上不存在,@types/node 里它是可选方法 —— 这里显式兜一个默认值。
const RUNTIME_XDG = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`;
const WAYLAND_SOCKET = path.join(RUNTIME_XDG, process.env.WAYLAND_DISPLAY || 'wayland-0');

for (const d of [paths.runtimeDir, paths.profileDir, paths.homeDir, paths.logsDir]) {
  mkdirSync(d, { recursive: true });
}
// 每次启动都清掉旧状态:留着旧的端口/标签页比没有更危险(会连到上一次的进程上)。
if (existsSync(paths.stateFile)) rmSync(paths.stateFile);

console.log(`[serve] 技能目录(只读):${paths.skillDir}`);
console.log(`[serve] 运行时目录(产物):${paths.runtimeDir}`);

// 启动阶段任何未捕获异常都要留痕:否则进程只留下半截日志就静默死掉,极难定位。
const CRASH_LOG = path.join(paths.logsDir, 'startup-crash.log');
const recordCrash = (what: string) => (e: unknown) => {
  const detail = e instanceof Error ? e.stack ?? e.message : String(e);
  const line = `[${new Date().toISOString()}] ${what}: ${detail}\n`;
  try {
    writeFileSync(CRASH_LOG, line, { flag: 'a' });
  } catch {
    /* 日志都写不进去就只能走 stderr */
  }
  console.error(`[serve] ${what}:`, detail);
};
process.on('uncaughtException', recordCrash('uncaughtException'));
process.on('unhandledRejection', recordCrash('unhandledRejection'));

type Probe = { ok: true } | { ok: false; why: string };

/** 探测 wayland socket 是否真有合成器在监听(文件存在但没人 listen 也算不可用)。 */
function probeWaylandSocket(socketPath: string, timeoutMs = 1500): Promise<Probe> {
  return new Promise<Probe>((resolve) => {
    if (!existsSync(socketPath)) {
      resolve({ ok: false, why: `${socketPath} 不存在` });
      return;
    }
    const sock = connect(socketPath);
    let settled = false;
    const done = (r: Probe): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, why: '连接超时' }), timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      done({ ok: true });
    });
    sock.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      done({ ok: false, why: `${e.code ?? ''} ${e.message}` });
    });
  });
}

function buildArgs(platform: string): string[] {
  return [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${paths.profileDir}`,
    `--window-size=${WINDOW_SIZE.width},${WINDOW_SIZE.height}`,
    '--window-position=0,0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--disable-infobars',
    '--password-store=basic',
    // 沙箱内没有 /dev/dri,GL 初始化必然失败;显式让 GL 落到软件实现,避免 GPU 进程反复重启刷日志。
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    `--ozone-platform=${platform}`,
    ...(HEADLESS ? ['--headless=new'] : []),
  ];
}

const CHILD_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  // 沙箱把真实 HOME 挂成只读,必须整体重定向到运行时目录。
  HOME: paths.homeDir,
  XDG_CONFIG_HOME: path.join(paths.homeDir, '.config'),
  XDG_CACHE_HOME: path.join(paths.homeDir, '.cache'),
  XDG_RUNTIME_DIR: RUNTIME_XDG,
  DISPLAY: process.env.DISPLAY || ':0',
  WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || 'wayland-0',
};

type AttemptResult =
  | { ok: true; child: ChildProcess; version: CdpVersion; platform: string }
  | { ok: false; child: ChildProcess | null; why: string };

/**
 * 尝试用某个平台拉起浏览器并等 CDP 就绪。
 * chromium 的输出落运行时目录下的日志文件,而不是继承本进程 stdout:
 * 后台作业的 stdout 在进程被 kill 时会丢掉缓冲内容,落文件才留得住现场。
 */
async function attempt(platform: string): Promise<AttemptResult> {
  console.log(`[serve] 尝试 --ozone-platform=${platform}`);
  const out = openSync(path.join(paths.logsDir, `chromium-${platform}.log`), 'a');
  const child = spawn(BIN, [...buildArgs(platform), START_URL], {
    env: CHILD_ENV,
    stdio: ['ignore', out, out],
  });

  // 用「容器对象」而不是裸变量接住退出信息:
  // 赋值发生在 exit 回调里,TS 的控制流分析看不到,裸变量会被收窄成 never。
  const exited: { info: { code: number | null; sig: NodeJS.Signals | null } | null } = { info: null };
  child.once('exit', (code, sig) => {
    exited.info = { code, sig };
  });

  const deadline = Date.now() + 60_000;
  let version: CdpVersion | null = null;
  while (Date.now() < deadline) {
    const info = exited.info;
    if (info) {
      return { ok: false, child, why: `chromium 提前退出 code=${info.code} signal=${info.sig}` };
    }
    version = await probeCdp(PORT, 1500);
    if (version) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!version) return { ok: false, child, why: `CDP ${PORT} 端口 60s 内未就绪` };
  return { ok: true, child, version, platform };
}

/** 结束一个还没用上的 chromium;kill 本身失败(进程已退出)不算错误。 */
function killQuietly(child: ChildProcess | null, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (!child) return;
  try {
    child.kill(signal);
  } catch {
    /* 已退出 */
  }
}

// ---- 选择平台并启动(必要时自动回滚) ----
let result: AttemptResult;
if (PLATFORM === 'wayland') {
  const probe = await probeWaylandSocket(WAYLAND_SOCKET);
  if (probe.ok) {
    console.log(`[serve] wayland socket 可用:${WAYLAND_SOCKET}`);
    result = await attempt('wayland');
  } else {
    console.log(`[serve] wayland socket 不可用(${probe.why})`);
    result = { ok: false, child: null, why: `wayland socket 不可用:${probe.why}` };
  }
} else {
  result = await attempt(PLATFORM);
}

if (!result.ok && !NO_FALLBACK && PLATFORM !== 'x11') {
  console.log(`[serve] ${PLATFORM} 启动失败(${result.why}),回滚到 --ozone-platform=x11`);
  killQuietly(result.child);
  await new Promise((r) => setTimeout(r, 1200));
  result = await attempt('x11');
}

if (!result.ok) {
  console.error(`[serve] 启动失败:${result.why}`);
  killQuietly(result.child);
  process.exit(1);
}

const { child, version } = result;

let shuttingDown = false;
const shutdown = (sig: NodeJS.Signals): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[serve] 收到 ${sig},关闭浏览器…`);
  killQuietly(child, 'SIGTERM');
  setTimeout(() => killQuietly(child, 'SIGKILL'), 4000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
child.on('exit', (code, sig) => {
  console.log(`[serve] chromium 退出 code=${code} signal=${sig}`);
  process.exit(0);
});

// 选中第一个 page 目标,避免后续命令误连 service_worker 等非页面目标。
// ★ 这里走 HTTP /json/list,字段名是 `id`(不是 CDP 的 targetId),见 lib/cdp.ts 顶部说明。
let tabId: string | null = null;
for (let i = 0; i < 40 && !tabId; i++) {
  const list = await getTargetsHttp(PORT).catch(() => []);
  tabId = list.find((t) => t.type === 'page')?.id ?? null;
  if (!tabId) await new Promise((r) => setTimeout(r, 300));
}

if (!tabId) {
  console.warn(
    '[serve] 警告:/json/list 连续 40 次都没取到 page 目标,state.json 的 tabId 为 null。' +
      '浏览器本身没问题,browserctl 首次使用时会自动重选标签页。',
  );
}

const state: BrowserState = {
  pid: child.pid,
  port: PORT,
  platform: result.platform,
  requestedPlatform: PLATFORM,
  fellBack: result.platform !== PLATFORM,
  headless: HEADLESS,
  startUrl: START_URL,
  tabId,
  runtimeDir: paths.runtimeDir,
  skillDir: paths.skillDir,
  browser: version,
  startedAt: new Date().toISOString(),
};
writeState(paths.stateFile, state);

console.log(
  `[serve] 就绪 pid=${child.pid} port=${PORT} platform=${result.platform}` +
    `${result.platform !== PLATFORM ? `(已从 ${PLATFORM} 回滚)` : ''} ` +
    `mode=${HEADLESS ? 'headless' : 'headful'} tab=${tabId} ${version.Browser}`,
);
console.log(`[serve] 运行日志目录:${paths.logsDir}`);
console.log(`[serve] 状态文件:${paths.stateFile}`);

// 前台保持存活:这是后台作业常驻的关键。
await new Promise<never>(() => {});
