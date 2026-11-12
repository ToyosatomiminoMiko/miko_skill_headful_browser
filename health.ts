#!/usr/bin/env node
/**
 * 是什么:对一个已在跑的 chromium(给定 CDP 端口)做「渲染 + 截图」体检,输出 JSON。
 *
 * 用法:
 *   node health.ts <CDP端口> [标签] [--shots=<截图目录>]
 *
 * 为什么独立成一个入口:
 *   对照 wayland/x11 两种 ozone 平台(compare-ozone.ts)与手工排查时,都要能对
 *   「某个已经在跑的浏览器」单独出一份可复制的结论;判定逻辑本身在 lib/health.ts。
 *
 * 元信息:@dsh agent,2026-10-14
 */
import { flagStringOpt, parseArgs, positional } from './lib/args.ts';
import { checkHealth } from './lib/health.ts';
import { resolveRuntime } from './lib/paths.ts';

const args = parseArgs(process.argv.slice(2), { valueFlags: ['shots', 'runtime'] });
const paths = resolveRuntime({ runtime: flagStringOpt(args, 'runtime') });

const port = Number(positional(args, 0, 'health <CDP端口> [标签] [--shots=<目录>]'));
if (!Number.isFinite(port) || port <= 0) {
  console.error(`CDP 端口必须是正整数,收到:${args.positionals[0]}`);
  process.exit(1);
}
const tag = args.positionals[1] ?? `port-${port}`;
const shotsDir = flagStringOpt(args, 'shots') ?? paths.shotsDir;

try {
  const report = await checkHealth(port, tag, shotsDir);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
} catch (e) {
  // 连不上浏览器属于硬失败:照样输出 JSON(便于对照脚本解析),但退出码非 0。
  console.log(
    JSON.stringify({ tag, ok: false, why: `连接失败:${e instanceof Error ? e.message : String(e)}` }, null, 2),
  );
  process.exit(1);
}
