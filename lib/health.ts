/**
 * 是什么:对「一个已在跑的 chromium(给定 CDP 端口)」做渲染 + 截图体检,返回结构化报告。
 *
 * 为什么抽成 lib 而不是留在 health.ts 里:
 *   compare-ozone.ts 对照 wayland/x11 两个平台时必须用同一套判定逻辑,
 *   两边各写一份迟早出现"结论不可比";所以判定只有一份实现,两个入口共用。
 *
 * 元信息:@dsh agent,2026-10-14
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CdpClient,
  type CdpAttachResult,
  type CdpEvaluateResult,
  type CdpScreenshot,
  type CdpTargetInfoList,
} from './cdp.ts';

export interface HealthReport {
  tag: string;
  ok: boolean;
  /** ok=false 时的原因 */
  why?: string;
  url?: string;
  h1?: string | null;
  host?: string;
  screenshotBytes?: number;
  screenshotMs?: number;
  /** 没有 page 目标时,列出实际存在的目标类型,便于判断是不是启动参数写错了 */
  targets?: string[];
}

/**
 * 体检。
 * 约定:除了「连不上浏览器」这种情况直接抛错,其余问题一律转成 ok=false 的报告 ——
 * 对照场景下需要的是每个平台的完整结论,而不是中途崩掉。
 */
export async function checkHealth(port: number, tag: string, shotsDir: string): Promise<HealthReport> {
  const cdp = await CdpClient.connect(port, null, 10_000);
  try {
    const { targetInfos } = await cdp.send<CdpTargetInfoList>('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    if (!page) {
      return { tag, ok: false, why: '没有 page 目标', targets: targetInfos.map((t) => t.type) };
    }

    const { sessionId } = await cdp.send<CdpAttachResult>('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    });
    cdp.sessionId = sessionId;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const ev = async (expression: string): Promise<unknown> => {
      const r = await cdp.send<CdpEvaluateResult>('Runtime.evaluate', { expression, returnByValue: true });
      if (r.exceptionDetails) return `ERR:${r.exceptionDetails.text}`;
      return r.result.value;
    };

    const url = await ev('location.href');
    const h1 = await ev('document.querySelector("h1")?.innerText ?? null');
    const host = await ev('navigator.userAgentData ? "ua-ok" : "ua-n/a"');

    const t0 = Date.now();
    let shot: CdpScreenshot | null = null;
    try {
      shot = await cdp.send<CdpScreenshot>('Page.captureScreenshot', { format: 'png' }, 15_000);
    } catch {
      shot = null;
    }
    const screenshotMs = Date.now() - t0;
    const bytes = shot ? Buffer.from(shot.data, 'base64').length : 0;
    if (shot) {
      mkdirSync(shotsDir, { recursive: true });
      writeFileSync(path.join(shotsDir, `platform-${tag}.png`), Buffer.from(shot.data, 'base64'));
    }

    return {
      tag,
      ok: bytes > 0,
      url: typeof url === 'string' ? url : String(url),
      h1: (h1 ?? null) as string | null,
      host: typeof host === 'string' ? host : String(host),
      screenshotBytes: bytes,
      screenshotMs,
    };
  } finally {
    cdp.close();
  }
}
