#!/usr/bin/env node
/**
 * 是什么:并发探测一批 URL 的可达性,用于摸清沙箱网络白名单范围。
 *
 * 为什么:
 *  探测点较多且需要短超时,串行会让单次工具调用过慢,所以固定并发池。
 *  与旧版 curl 脚本的差别:结果按输入顺序输出(而不是完成顺序),
 *  两次探测可以直接 diff;并且带上了耗时,便于区分"被拦"与"只是慢"。
 *
 * 用法:
 *   node netprobe.ts [--timeout=5] [--concurrency=12] <url...>
 *
 * 元信息:@dsh agent,2026-10-14
 */
import { flagNumber, parseArgs } from './lib/args.ts';

const args = parseArgs(process.argv.slice(2), { valueFlags: ['timeout', 'concurrency'] });
const urls = args.positionals;
if (urls.length === 0) {
  console.error('用法:node netprobe.ts [--timeout=5] [--concurrency=12] <url...>');
  process.exit(1);
}

const envTimeoutSec = Number(process.env.TIMEOUT);
const timeoutSec = flagNumber(
  args,
  'timeout',
  Number.isFinite(envTimeoutSec) && envTimeoutSec > 0 ? envTimeoutSec : 5,
);
const concurrency = Math.max(1, Math.floor(flagNumber(args, 'concurrency', 12)));

interface ProbeResult {
  url: string;
  /** HTTP 状态码;连不上/超时统一记 '000'(与 curl 的 %{http_code} 口径一致) */
  status: string;
  ms: number;
}

async function probe(url: string): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutSec * 1000) });
    // 只要状态码,不要正文(等价于 curl -o /dev/null);不取消的话大页面会一直往内存里灌。
    if (res.body) await res.body.cancel().catch(() => undefined);
    return { url, status: String(res.status), ms: Date.now() - t0 };
  } catch {
    return { url, status: '000', ms: Date.now() - t0 };
  }
}

// Node 的 fetch **不会**默认读取 http_proxy 之类环境变量(需要 NODE_USE_ENV_PROXY=1)。
// 需要代理才能出网的环境里,所有请求都会变成 000,看起来像"被白名单拦" —— 这是错误结论。
// 这种情况必须显式提醒,不能让诊断工具静默给出反向答案。
const PROXY_VARS = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'];
const proxyVarsSet = PROXY_VARS.filter((v) => (process.env[v] ?? '') !== '');
if (proxyVarsSet.length > 0 && !process.env.NODE_USE_ENV_PROXY) {
  console.error(
    `[netprobe] 警告:检测到代理环境变量 ${proxyVarsSet.join(', ')},但 Node fetch 默认不读它们,` +
      '结果可能全是 000(会被误读成"被沙箱拦")。需要走代理请加 NODE_USE_ENV_PROXY=1,' +
      '或直接用 curl 复核。',
  );
}

const results: ProbeResult[] = new Array<ProbeResult>(urls.length);
let cursor = 0;
async function worker(): Promise<void> {
  for (;;) {
    const i = cursor++;
    const url = urls[i];
    if (url === undefined) return;
    results[i] = await probe(url);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));
for (const r of results) {
  console.log(`${r.url.padEnd(45)} ${r.status.padStart(3)}  ${r.ms}ms`);
}
