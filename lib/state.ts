/**
 * 是什么:运行状态 state.json 的读写与「丢失后从 CDP 端口重建」。
 *
 * 为什么需要这个文件:
 *  每次工具调用都是独立进程,进程内状态无法跨调用保持,所以「当前标签页/端口」只能落盘。
 *  而 state.json 又可能被 clean.ts 删掉 —— 若此时直接失败,就会出现
 *  「浏览器明明活着、控制台却彻底失联」的死局。重建逻辑就是为堵这个洞写的。
 *
 * 为什么落盘要原子写:
 *  state.json 会被 serve.ts 与任意多个 browserctl 进程同时读写。
 *  直接 writeFileSync 若在写入过程中被 kill,会留下半截 JSON,下一次谁读谁崩。
 *  同目录 rename 在同一文件系统上是原子的:读到的永远是完整旧版或完整新版。
 *
 * 元信息:@dsh agent,2026-10-14
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { getTargetsHttp, probeCdp, type CdpVersion } from './cdp.ts';

export interface BrowserState {
  /** chromium 主进程 pid;跨 PID namespace 不一定可见,所以判断「在不在跑」一律走端口 */
  pid?: number;
  /** CDP 调试端口 */
  port: number;
  /** 实际生效的 ozone 平台 */
  platform: string;
  /** 命令行请求的平台,用于判断是否发生过回滚 */
  requestedPlatform?: string;
  fellBack?: boolean;
  headless?: boolean;
  startUrl?: string;
  /** 当前标签页的 targetId;null 表示启动时还没选到 page 目标 */
  tabId: string | null;
  runtimeDir?: string;
  skillDir?: string;
  browser?: CdpVersion;
  startedAt?: string;
  /** 以下两个字段只在 state.json 丢失、由 browserctl 从端口重建时出现 */
  recovered?: boolean;
  recoveredAt?: string;
}

/** 读状态。文件不存在或内容不可解析都返回 null,由调用方结合 stateFileStatus 决定怎么处理。 */
export function readState(file: string): BrowserState | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as BrowserState;
  } catch {
    return null;
  }
}

/**
 * 状态文件处于哪种状态。
 *
 * ★ 为什么必须把「损坏」与「缺失」分开:
 *   缺失时可以安全地按端口重建 —— 浏览器只是丢了控制面文件,重建能把它接回来。
 *   损坏(JSON 解析失败)则完全不同:内容已不可信,若照缺失处理就会把它覆盖成一份
 *   **字段残缺**的状态(只有 recovered/port/tabId/browser),后果是静默的:
 *     - `info` 会把无头浏览器报成 `mode: headful`(headless 字段丢了)
 *     - 平台变成未知、requestedPlatform/fellBack/startUrl 全丢
 *     - tabId 被重置成"第一个 page 目标",你之前 `use` 选的标签页被悄悄换掉,
 *       后续 click/eval 全打在**另一个页面**上却一切报成功
 *   所以损坏一律硬失败,交给人来决定修还是删。
 */
export type StateFileStatus = 'ok' | 'missing' | 'corrupt';

export function stateFileStatus(file: string): StateFileStatus {
  if (!existsSync(file)) return 'missing';
  return readState(file) === null ? 'corrupt' : 'ok';
}

/**
 * 原子落盘:先写同目录临时文件,再 rename 覆盖。
 * 同一文件系统上的 rename 是原子的:读到的永远是完整旧版或完整新版,不会半截 JSON。
 * 失败时清掉临时文件,避免留下 `state.json.tmp-<pid>` 垃圾。
 */
export function writeState(file: string, state: BrowserState): void {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 清不掉也没别的办法 */
    }
    throw e;
  }
}

/**
 * 从运行中的 CDP 端口重建 state.json。
 * 探不到浏览器就返回 null(调用方据此报「浏览器没在跑」)。
 */
export async function rebuildState(file: string, port: number): Promise<BrowserState | null> {
  const browser = await probeCdp(port, 2000);
  if (!browser) return null;
  // ★ 这里必须用 /json/list 的 `id` 字段,不是 CDP 的 `targetId`(见 lib/cdp.ts 顶部说明)。
  const targets = await getTargetsHttp(port, 2000).catch(() => []);
  const rebuilt: BrowserState = {
    recovered: true,
    port,
    platform: '(未知,重启 serve.ts 可补全)',
    tabId: targets.find((t) => t.type === 'page')?.id ?? null,
    browser,
    recoveredAt: new Date().toISOString(),
  };
  writeState(file, rebuilt);
  return rebuilt;
}
