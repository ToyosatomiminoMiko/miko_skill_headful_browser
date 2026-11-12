/**
 * 是什么:极简 CDP(Chrome DevTools Protocol)客户端 + 本技能用到的协议类型 + HTTP 端点小工具。
 *
 * 为什么不用 chrome-remote-interface:
 *   实测页面处于「导航挂起 / 网络错误页」状态时,它的连接与 Session 管理会整体卡死
 *   (attach 后既不返回也不报错),而原生 WebSocket 发一条 Target.getTargets 只要 7ms。
 *   所以这里零依赖、直接讲协议,并且每个请求都带独立硬超时 ——
 *   保证永远不会把工具调用挂住。
 *
 * 为什么要把协议类型写全(本轮 TS 化的主要收益):
 *   CDP 的返回值在 JS 里全是 any:字段名写错只会得到 undefined,错误会一路漂到很远的地方
 *   才以「莫名其妙的行为」暴露。下面每个 interface 只覆盖本技能真正用到的字段,
 *   写错字段名直接编译不过。
 *
 * ★ 一个真实存在的坑(本文件用两个不同类型把它钉死):
 *   HTTP 端点 `/json/list` 返回的字段是 `id`,
 *   而 WebSocket 的 `Target.getTargets` 返回的字段是 `targetId`。
 *   两者长得几乎一样、类型都是字符串,JS 里混用不会报错,只会静默拿到 undefined。
 *   所以这里刻意分成 CdpHttpTarget 与 CdpTargetInfo 两个 interface。
 *
 * 元信息:@dsh agent,2026-10-14
 */

// ---------------- HTTP 端点 ----------------

/** `/json/version` 的返回形状。 */
export interface CdpVersion {
  Browser: string;
  'Protocol-Version': string;
  'User-Agent': string;
  'V8-Version': string;
  'WebKit-Version': string;
  webSocketDebuggerUrl: string;
}

/** `/json/list` 的返回形状。注意字段是 `id`! */
export interface CdpHttpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
}

/** `Target.getTargets` 的返回形状。注意字段是 `targetId`! */
export interface CdpTargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  openerId?: string;
}

export interface CdpTargetInfoList {
  targetInfos: CdpTargetInfo[];
}

/** 默认硬超时;可用 CDP_TIMEOUT_MS 覆盖(非数字一律忽略,不制造 NaN)。 */
export const DEFAULT_TIMEOUT_MS: number = (() => {
  const raw = Number(process.env.CDP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 25_000;
})();

/** 带超时的 JSON GET,非 2xx 直接抛错(而不是把错误页当数据解析)。 */
export async function fetchJson<T>(url: string, timeoutMs = 4000): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} :: ${url}`);
  return (await res.json()) as T;
}

export function getVersion(port: number, timeoutMs = 4000): Promise<CdpVersion> {
  return fetchJson<CdpVersion>(`http://127.0.0.1:${port}/json/version`, timeoutMs);
}

export function getTargetsHttp(port: number, timeoutMs = 4000): Promise<CdpHttpTarget[]> {
  return fetchJson<CdpHttpTarget[]>(`http://127.0.0.1:${port}/json/list`, timeoutMs);
}

/** 探测某端口上是否有活着的浏览器;没有就返回 null(不抛错),调用方据此决定回滚或报错。 */
export async function probeCdp(port: number, timeoutMs = 1500): Promise<CdpVersion | null> {
  try {
    return await getVersion(port, timeoutMs);
  } catch {
    return null;
  }
}

// ---------------- 协议返回类型(只覆盖本技能用到的字段) ----------------

export interface CdpRemoteObject {
  type: string;
  value?: unknown;
  description?: string;
}

export interface CdpExceptionDetails {
  text: string;
  exception?: { description?: string };
}

export interface CdpEvaluateResult {
  result: CdpRemoteObject;
  exceptionDetails?: CdpExceptionDetails;
}

export interface CdpLayoutMetrics {
  cssLayoutViewport: { clientWidth: number; clientHeight: number };
  cssContentSize: { width: number; height: number };
}

export interface CdpNavigateResult {
  frameId: string;
  loaderId?: string;
  /** 导航被拒时由浏览器填(例如被网络策略拦截);正常导航为 undefined */
  errorText?: string;
}

export interface CdpNavigationEntry {
  id: number;
  url: string;
  title?: string;
}

export interface CdpNavigationHistory {
  currentIndex: number;
  entries: CdpNavigationEntry[];
}

export interface CdpWindowBounds {
  windowId?: number;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  windowState?: string;
}

export interface CdpWindowForTarget {
  windowId: number;
  bounds: CdpWindowBounds;
}

export interface CdpScreenshot {
  /** base64 编码的 PNG */
  data: string;
}

export interface CdpAttachResult {
  sessionId: string;
}

export interface CdpCreateTargetResult {
  targetId: string;
}

// ---------------- WebSocket 传输 ----------------

interface CdpInbound {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type EventListener = (params: unknown) => void;

/**
 * 等事件的两种结局。
 * 旧版用 `{ __timeout: true }` 这个魔法对象表示超时,调用方必须记得检查;
 * 现在用可辨识联合,配合 noUncheckedIndexedAccess 之类的严格开关,
 * 忘了分支就编译不过。
 */
export type CdpEventOutcome<P> = { timedOut: false; params: P } | { timedOut: true };

/**
 * 一个浏览器级(或页面级,取决于 sessionId)CDP 连接。
 * 每个 send 独立超时;连接断开时把所有在途请求立刻 reject,
 * 不留下"等到超时才报错"的空转。
 */
export class CdpClient {
  private readonly ws: WebSocket;
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Map<string, EventListener[]>();
  /** 非空表示该连接已挂到某个 target(sessionId 会随每条消息发出) */
  sessionId: string | null;

  constructor(ws: WebSocket, sessionId: string | null = null) {
    this.ws = ws;
    this.sessionId = sessionId;
    ws.addEventListener('message', (ev) => {
      this.onMessage(ev.data);
    });
    ws.addEventListener('close', () => {
      this.failAllPending(new Error('WebSocket 已关闭'));
    });
    ws.addEventListener('error', () => {
      this.failAllPending(new Error('WebSocket 出错'));
    });
  }

  static async connect(port: number, sessionId: string | null, timeoutMs = 8000): Promise<CdpClient> {
    // 拿版本信息这一步最常失败(state.json 是旧的、浏览器已经被 kill),而底层的
    // "fetch failed" 完全看不出是端口问题。这里把端口和原因一起报出来。
    let version: CdpVersion;
    try {
      version = await getVersion(port, Math.min(timeoutMs, 4000));
    } catch (e) {
      throw new Error(`连不上 CDP 端口 ${port}:${e instanceof Error ? e.message : String(e)}`);
    }
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WebSocket 连接超时 ${timeoutMs}ms`)), timeoutMs);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('WebSocket 连接失败'));
        },
        { once: true },
      );
    });
    return new CdpClient(ws, sessionId);
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== 'string') return; // CDP 只发文本帧,二进制帧按协议错误忽略
    let msg: CdpInbound;
    try {
      msg = JSON.parse(raw) as CdpInbound;
    } catch {
      return; // 半截帧/非法 JSON 不该拖垮整个命令
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method !== undefined) {
      const fns = this.listeners.get(msg.method);
      if (fns) for (const fn of [...fns]) fn(msg.params);
    }
  }

  private failAllPending(error: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(error);
    }
  }

  /** 发一条 CDP 命令。timeoutMs 到点就 reject,绝不无限等。 */
  send<R>(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<R> {
    const id = ++this.nextId;
    const payload: Record<string, unknown> = { id, method, params };
    if (this.sessionId) payload.sessionId = this.sessionId;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (e) {
      const p = this.pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(e instanceof Error ? e : new Error(String(e)));
      }
    }
    return promise.then((v) => v as R);
  }

  on(method: string, fn: EventListener): void {
    const list = this.listeners.get(method) ?? [];
    list.push(fn);
    this.listeners.set(method, list);
  }

  off(method: string, fn: EventListener): void {
    const list = this.listeners.get(method);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  /**
   * 等一个 CDP 事件,超时就返回 timedOut。
   * 与旧版的关键差别:监听器在 settle 后会被摘掉 ——
   * 旧版每个 waitEvent 都往数组里塞一个永不回收的监听器(单进程 CLI 里没炸,
   * 但属于"靠调用次数少才没出事")。
   */
  waitEvent<P>(method: string, timeoutMs = 15_000): Promise<CdpEventOutcome<P>> {
    return new Promise<CdpEventOutcome<P>>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const handler: EventListener = (params) => {
        if (timer) clearTimeout(timer);
        this.off(method, handler);
        resolve({ timedOut: false, params: params as P });
      };
      this.on(method, handler);
      timer = setTimeout(() => {
        this.off(method, handler);
        resolve({ timedOut: true });
      }, timeoutMs);
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* 已经关了 */
    }
  }
}
