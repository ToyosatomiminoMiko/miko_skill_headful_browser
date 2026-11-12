#!/usr/bin/env node
/**
 * 是什么:对照实测 chromium 在 --ozone-platform=wayland 与 =x11 下能否渲染与截图。
 *
 * 为什么:
 *   此前只凭推理选了 x11(X11 抓屏工具齐全、无 DRI 时软件渲染路径更稳),
 *   需要用同一套判定逻辑实测纯 Wayland 是否同样可用 —— 判定逻辑在 lib/health.ts,
 *   本脚本只负责"起两个平台、收集结论、清理现场"。
 *
 * 注意:清理只能用 PID,绝不能用 `pkill -f <关键字>` ——
 *   执行本脚本的那条命令行本身也含这些关键字,pkill 会把自己一起杀掉(实测 exit 137 且无任何输出)。
 *
 * 用法:
 *   node compare-ozone.ts [--base-port=9351] [--bin=/usr/bin/chromium-browser] [--ready-timeout=20000]
 *
 * 元信息:@dsh agent,2026-10-14
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { flagNumber, flagString, flagStringOpt, parseArgs } from './lib/args.ts';
import { probeCdp } from './lib/cdp.ts';
import { checkHealth } from './lib/health.ts';
import { resolveRuntime } from './lib/paths.ts';

const args = parseArgs(process.argv.slice(2), {
  valueFlags: ['base-port', 'bin', 'runtime', 'ready-timeout'],
});
const paths = resolveRuntime({ runtime: flagStringOpt(args, 'runtime') });
const BIN = flagString(args, 'bin', '/usr/bin/chromium-browser');
const READY_TIMEOUT_MS = flagNumber(args, 'ready-timeout', 20_000);
const BASE_PORT = flagNumber(args, 'base-port', 9351);
const XDG_RUNTIME = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`;

/** 所有被本脚本拉起的 chromium;进程退出时无条件收尸,不留孤儿。 */
const spawned = new Set<ChildProcess>();
process.on('exit', () => {
  for (const child of spawned) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
});

function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // 真实 HOME 只读,必须整体重定向到运行时目录。
    HOME: paths.homeDir,
    XDG_CONFIG_HOME: path.join(paths.homeDir, '.config'),
    XDG_CACHE_HOME: path.join(paths.homeDir, '.cache'),
    XDG_RUNTIME_DIR: XDG_RUNTIME,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || 'wayland-0',
    DISPLAY: process.env.DISPLAY || ':0',
  };
}

function chromiumArgs(platform: string, port: number, profileDir: string): string[] {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,800',
    `--ozone-platform=${platform}`,
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--password-store=basic',
    `data:text/html,<h1 style='font:700 48px sans-serif'>RENDER-OK-${platform}</h1>`,
  ];
}

/** 只挑与显示/GPU 相关的日志行,避免把整份 chromium 日志灌进结论。 */
function interestingLogLines(logFile: string): string[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((l) => /wayland|ozone|x11|egl|angle|gpu|vulkan|dri/i.test(l))
    .slice(0, 6);
}

async function runOne(platform: string, port: number): Promise<void> {
  const profileDir = path.join(paths.tmpDir, `${platform}-profile`);
  const logFile = path.join(paths.tmpDir, `${platform}.log`);
  mkdirSync(paths.tmpDir, { recursive: true });
  mkdirSync(paths.homeDir, { recursive: true });
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });

  console.log(`=== --ozone-platform=${platform} (CDP :${port}) ===`);
  const out = openSync(logFile, 'w');
  const child = spawn(BIN, chromiumArgs(platform, port, profileDir), {
    env: childEnv(),
    stdio: ['ignore', out, out],
  });
  spawned.add(child);

  try {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      if (await probeCdp(port, 1000)) {
        ready = true;
        break;
      }
      await delay(500);
    }

    if (!ready) {
      console.log('  结果: 失败 —— CDP 端口未就绪,浏览器没起来');
    } else {
      const report = await checkHealth(port, platform, paths.shotsDir);
      console.log(JSON.stringify(report, null, 2).replace(/^/gm, '  '));
      const lines = interestingLogLines(logFile);
      if (lines.length > 0) {
        console.log('  -- 该平台日志中 GPU/显示相关行 --');
        for (const l of lines) console.log(`     ${l}`);
      }
    }
  } catch (e) {
    console.log(`  体检失败:${e instanceof Error ? e.message : String(e)}`);
  } finally {
    // 只用 PID 收尸,见文件头注释。
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
    await delay(1000);
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
    spawned.delete(child);
    rmSync(profileDir, { recursive: true, force: true });
    console.log('');
  }
}

await runOne('wayland', BASE_PORT);
await runOne('x11', BASE_PORT + 1);
console.log(`完成。截图与日志在 ${paths.runtimeDir}(shots/ 与 tmp/)`);
