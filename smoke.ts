#!/usr/bin/env node
/**
 * 是什么:本技能的自测脚本 —— 起一个真浏览器,把 browserctl / health / clean 的关键路径全跑一遍。
 *
 * 为什么需要它:
 *   这个技能的失败方式大多是「静默」的:参数被吞掉、命令报成功但动作没发生、
 *   状态文件坏掉后控制台失联。这类问题靠读代码看不出来,只能真跑一遍。
 *   把跑法固化成一条命令(`npm run smoke`),后续任何改动都能立刻知道有没有踩坏东西。
 *
 * 隔离原则:
 *   默认在 os.tmpdir() 下新建临时运行时目录,自带独立 port 与 profile,
 *   绝不碰 ~/.dsh/browser-runtime 里的真实登录态;测试结束(默认)连临时目录一起删掉。
 *
 * 用法:
 *   node smoke.ts [--port=9333] [--runtime=<目录>] [--headless] [--keep]
 *
 * 元信息:@dsh agent,2026-10-14
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { flagNumber, flagStringOpt, hasFlag, parseArgs } from './lib/args.ts';
import { SKILL_DIR } from './lib/paths.ts';

const args = parseArgs(process.argv.slice(2), { valueFlags: ['runtime', 'port'] });
const PORT = flagNumber(args, 'port', 9333);
const HEADLESS = hasFlag(args, 'headless');
const KEEP = hasFlag(args, 'keep');
const explicitRuntime = flagStringOpt(args, 'runtime');
const RUNTIME = explicitRuntime ?? mkdtempSync(path.join(os.tmpdir(), 'headful-browser-smoke-'));
/** 只有"自己新建的临时目录"才在结束时删掉;用户显式指定的目录一律保留。 */
const OWNS_RUNTIME = explicitRuntime === undefined;

const skills = (file: string): string => path.join(SKILL_DIR, file);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(argv: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawn(process.execPath, [...argv], {
      env: { ...process.env, BROWSER_RUNTIME_ROOT: RUNTIME, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: `${stderr}${e.message}` }));
  });
}

const ctl = (...argv: string[]): Promise<RunResult> =>
  // ★ 必须把 --port 一路带上:state.json 丢失后 browserctl 只能靠 --port/BROWSER_CDP_PORT
  // 猜端口(默认 9222)。不传的话,它会去探默认端口上"另一个"浏览器,还能误报成功。
  run([skills('browserctl.ts'), '--port', String(PORT), ...argv]);

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function log(text: string): void {
  console.log(`\n== ${text}`);
}

// ---------- 准备隔离环境 ----------
const fixture = path.join(RUNTIME, 'smoke.html');
writeFileSync(
  fixture,
  `<!doctype html><html><head><meta charset="utf-8"><title>SMOKE</title></head>
<body style="font:16px sans-serif;margin:24px">
<h1>SMOKE-PAGE</h1><input id="q" value=""><button id="b" onclick="document.title='CLICKED'">GO</button>
<!-- 必须有一个高于视口的元素,否则 scroll 无路可走,断言会假失败 -->
<p style="height:3000px">底部</p>
</body></html>`,
);
const fixtureUrl = pathToFileURL(fixture).href;
const stateFile = path.join(RUNTIME, 'state.json');

console.log(`运行时目录:${RUNTIME}`);
console.log(`CDP 端口  :${PORT}`);
console.log(`模式      :${HEADLESS ? 'headless' : 'headful'}`);

// ---------- 起浏览器(子进程方式;本脚本退出时一并收尸) ----------
const serve = spawn(
  process.execPath,
  [skills('serve.ts'), `--port=${PORT}`, `--url=${fixtureUrl}`, ...(HEADLESS ? ['--headless'] : [])],
  { env: { ...process.env, BROWSER_RUNTIME_ROOT: RUNTIME }, stdio: ['ignore', 'pipe', 'pipe'] },
);
// 兜底:无论脚本怎么退出(包括中途抛异常、被 kill),都不留 serve/chromium 子进程。
process.on('exit', () => {
  try {
    serve.kill('SIGKILL');
  } catch {
    /* 已退出 */
  }
});
let serveLog = '';
serve.stdout.on('data', (d: Buffer) => {
  serveLog += d.toString();
});
serve.stderr.on('data', (d: Buffer) => {
  serveLog += d.toString();
});

log('启动 serve.ts');
let started = false;
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  if (existsSync(stateFile)) {
    started = true;
    break;
  }
  if (serve.exitCode !== null) break;
  await delay(300);
}
check('浏览器就绪(state.json 已落盘)', started, started ? '' : 'serve.ts 90s 内未写出 state.json');
if (!started) {
  console.log('--- serve.ts 输出 ---');
  console.log(serveLog.trim() || '(无输出)');
}

interface State {
  port: number;
  platform: string;
  requestedPlatform?: string;
  fellBack?: boolean;
  tabId: string | null;
  recovered?: boolean;
}

function readStateFile(): State | null {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8')) as State;
  } catch {
    return null;
  }
}

if (started) {
  const state = readStateFile();
  check('state.json 端口与启动参数一致', state?.port === PORT, `port=${state?.port}`);
  check(
    '平台是 wayland 或 x11',
    state?.platform === 'wayland' || state?.platform === 'x11',
    `platform=${state?.platform}${state?.fellBack ? `(已从 ${state?.requestedPlatform} 回滚)` : ''}`,
  );
  check('已选中一个 page 标签页', typeof state?.tabId === 'string' && state.tabId.length > 0);

  log('browserctl:读页面');
  const href = await ctl('eval', 'location.href');
  check('eval 能拿到当前地址', href.code === 0 && href.stdout.includes('smoke.html'), href.stdout.trim().slice(0, 80));
  const h1 = await ctl('eval', 'document.querySelector("h1").innerText');
  check('页面内容正确', h1.stdout.trim() === 'SMOKE-PAGE', h1.stdout.trim());

  log('browserctl:真实点击与输入');
  const typed = await ctl('type', '#q', 'smoke-input');
  check('type 输入生效', typed.stdout.includes('"valueNow": "smoke-input"'), typed.stdout.trim().replace(/\s+/g, ' ').slice(0, 100));
  const clicked = await ctl('click', '#b');
  const title = await ctl('eval', 'document.title');
  check('click 触发了真实事件', clicked.code === 0 && title.stdout.trim() === 'CLICKED', title.stdout.trim());

  log('browserctl:截图');
  const shot = await ctl('screenshot', 'smoke.png');
  const shotPath = path.join(RUNTIME, 'shots', 'smoke.png');
  const shotOk = existsSync(shotPath) && statSync(shotPath).size > 1000;
  check('截图落盘且非空', shotOk, shotOk ? `${statSync(shotPath).size}B` : shot.stderr.trim());

  log('browserctl:滚动参数(空格写法必须生效)');
  const scrolled = await ctl('scroll', '--dy', '250');
  check('scroll --dy 250 生效', scrolled.stdout.includes('"after": 250'), scrolled.stdout.replace(/\s+/g, ' ').trim().slice(0, 80));

  log('browserctl:标签页生命周期');
  const opened = await ctl('open', 'about:blank');
  const tabs = await ctl('tabs');
  check('open 新标签可见', opened.code === 0 && (tabs.stdout.match(/^[* ] page\b/gm) ?? []).length >= 2);
  const closed = await ctl('close');
  check('close 关闭当前标签', closed.code === 0, closed.stdout.trim().slice(0, 60));

  log('browserctl:state.json 丢失后自动重建');
  rmSync(stateFile, { force: true });
  const recovered = await ctl('eval', 'location.href');
  const rebuilt = readStateFile();
  check(
    'state.json 缺失时从 CDP 端口重建(且端口没猜错)',
    recovered.code === 0 && rebuilt?.recovered === true && rebuilt.port === PORT,
    `recovered=${rebuilt?.recovered} port=${rebuilt?.port}`,
  );

  log('health.ts');
  const health = await run([skills('health.ts'), String(PORT), 'smoke']);
  check('health 报告 ok=true', health.stdout.includes('"ok": true'), health.stdout.replace(/\s+/g, ' ').trim().slice(0, 120));

  log('clean.ts');
  const cleanDry = await run([skills('clean.ts'), '--runtime', RUNTIME]);
  check(
    'clean 无参数时只预览、不落手',
    cleanDry.code === 0 && cleanDry.stdout.includes('未指定要删除的项') && existsSync(path.join(RUNTIME, 'profile')),
  );
  const cleanProfile = await run([skills('clean.ts'), '--runtime', RUNTIME, '--profile', '--force', '--yes']);
  check('浏览器在跑时拒绝删 profile', cleanProfile.code === 2 && cleanProfile.stderr.includes('浏览器正在运行'));

  // ---- 以下 4 项是审计发现的静默故障的回归测试,别再让它们悄悄回来 ----
  const goodState = readFileSync(stateFile, 'utf8');
  const asObject = (): Record<string, unknown> => JSON.parse(goodState) as Record<string, unknown>;

  log('回归:clean 的 profile 闸门必须偏保守(宁可误拒)');
  // (a) port 被写成字符串:旧实现只认 number,会把"浏览器在跑"判成"没在跑"然后真删 profile
  writeFileSync(stateFile, JSON.stringify({ ...asObject(), port: String(PORT) }, null, 2));
  const strPort = await run([skills('clean.ts'), '--runtime', RUNTIME, '--profile', '--force', '--yes']);
  check(
    'state.json 的 port 是字符串时仍拒绝删 profile',
    strPort.code === 2,
    (strPort.stderr.trim().split('\n')[0] ?? '').slice(0, 60),
  );

  // (b) 端口上是"200 但非 JSON"的服务:只要端口有响应就必须当作可能在跑
  const fakePort = PORT + 1;
  const fake = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('not a cdp endpoint');
  });
  await new Promise<void>((resolve) => fake.listen(fakePort, '127.0.0.1', () => resolve()));
  writeFileSync(stateFile, JSON.stringify({ ...asObject(), port: fakePort }, null, 2));
  const fakeGate = await run([skills('clean.ts'), '--runtime', RUNTIME, '--profile', '--force', '--yes']);
  check('端口只回 200 非 JSON 时也拒绝删 profile', fakeGate.code === 2, `exit=${fakeGate.code}`);
  await new Promise<void>((resolve) => fake.close(() => resolve()));

  log('回归:state.json 损坏 ≠ 缺失');
  writeFileSync(stateFile, '{ 这不是 JSON');
  const corrupt = await ctl('info');
  check(
    'state.json 损坏时硬失败(exit 2)且不覆盖原文件',
    corrupt.code === 2 && readFileSync(stateFile, 'utf8') === '{ 这不是 JSON',
    `exit=${corrupt.code}`,
  );
  writeFileSync(stateFile, goodState);

  log('回归:BROWSER_CDP_PORT 非法不得静默回落 9222');
  rmSync(stateFile, { force: true });
  const badEnv = await run([skills('browserctl.ts'), 'info'], { BROWSER_CDP_PORT: 'abc' });
  check(
    'BROWSER_CDP_PORT 非法时报错退出',
    badEnv.code === 2 && badEnv.stderr.includes('BROWSER_CDP_PORT'),
    (badEnv.stderr.trim().split('\n')[0] ?? '').slice(0, 60),
  );
  writeFileSync(stateFile, goodState);
}

// ---------- 收尸 ----------
log('清理');
serve.kill('SIGTERM');
const stopDeadline = Date.now() + 8000;
while (serve.exitCode === null && Date.now() < stopDeadline) await delay(200);
if (serve.exitCode === null) serve.kill('SIGKILL');
const down = serve.exitCode !== null;
check('serve.ts 响应 SIGTERM 退出', down, `exitCode=${serve.exitCode}`);
if (OWNS_RUNTIME && !KEEP) rmSync(RUNTIME, { recursive: true, force: true });
else console.log(`保留运行时目录:${RUNTIME}`);

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
