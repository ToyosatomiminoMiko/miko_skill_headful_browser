#!/usr/bin/env node
/**
 * 是什么:控制由 serve.ts 启动的有头 Chromium 的 CDP 控制台(零依赖,直接用原生 WebSocket)。
 *
 * 为什么不用 chrome-remote-interface:
 *   实测在「页面处于网络错误页/导航挂起」时,它的连接与 Session 管理会整体卡死
 *   (attach 后既不返回也不报错,原生命令 7ms 就通)。因此这里直接讲 CDP 协议,
 *   并且每个命令都带硬超时,保证永远不会把工具调用挂住。
 *
 * 为什么「当前标签页」要落盘 state.json:
 *   每次工具调用是独立进程,进程内状态无法跨调用保持,只能用文件传。
 *
 * 目录约定(技能与产物严格分离):
 *   state.json 与截图都写到运行时目录(默认 ~/.dsh/browser-runtime,
 *   可用 BROWSER_RUNTIME_ROOT 覆盖),技能目录只读、不落任何产物。
 *
 * 命令:
 *   info | tabs | open <url> | use <id> | close [id]
 *   goto <url> | back | reload
 *   eval <js> | text [css] | links [css] | html [css] | size
 *   screenshot <文件名|绝对路径> [--full]      # 相对名写入运行时 shots/
 *   click <css> | type <css> <text> [--append] | key <Enter|Tab|...> | scroll [--dy=N|--to=N]
 *
 * 元信息:@dsh agent,2026-10-14
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  flagNumber,
  flagString,
  flagStringOpt,
  hasFlag,
  parseSubcommandArgs,
  parseWindowSize,
  positional,
  type ParsedArgs,
} from './lib/args.ts';
import {
  CdpClient,
  type CdpAttachResult,
  type CdpCreateTargetResult,
  type CdpEvaluateResult,
  type CdpLayoutMetrics,
  type CdpNavigateResult,
  type CdpNavigationHistory,
  type CdpScreenshot,
  type CdpTargetInfoList,
  type CdpWindowForTarget,
} from './lib/cdp.ts';
import { resolveRuntime, type RuntimePaths } from './lib/paths.ts';
import { readState, rebuildState, stateFileStatus, writeState, type BrowserState } from './lib/state.ts';

// ---------- 参数解析 ----------
const args: ParsedArgs = parseSubcommandArgs(process.argv.slice(2), {
  valueFlags: ['runtime', 'port', 'timeout', 'limit', 'size', 'to', 'dx', 'dy'],
});
const paths: RuntimePaths = resolveRuntime({ runtime: flagStringOpt(args, 'runtime') });

/**
 * 状态文件缺失时的兜底端口:先看 --port=,再看 BROWSER_CDP_PORT,最后 9222。
 *
 * ★ 环境变量给了非法值时必须报错,不能回落 9222:
 *   回落会让人在**另一个浏览器**上继续干活,还一切报成功,并把 state.json 覆盖成那个浏览器的
 *   端口与标签页。宁可停下来让人确认。旧版这里是 NaN → 探测失败 → 硬失败,所以这也算恢复对齐。
 */
function fallbackPort(): number {
  if (args.flags.has('port')) return flagNumber(args, 'port', 9222);
  const raw = process.env.BROWSER_CDP_PORT;
  if (raw === undefined || raw === '') return 9222;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`BROWSER_CDP_PORT 不是合法端口:${raw}`);
    process.exit(2);
  }
  return n;
}

/**
 * 读取运行状态。state.json 缺失时不再直接失败:
 * 浏览器可能仍在运行(例如 state.json 被 clean.ts 清掉),所以退一步探测默认端口,
 * 探到了就把状态重建回 state.json —— 否则会出现"浏览器活着但控制台彻底失联"的死局。
 */
async function loadState(): Promise<BrowserState> {
  const status = stateFileStatus(paths.stateFile);
  if (status === 'corrupt') {
    // 损坏 ≠ 缺失:缺失可以按端口重建接回浏览器,损坏则会把文件覆盖成一份残缺状态,
    // 静默丢掉 headless/平台/startUrl,并把当前标签页换成"第一个 page"。
    // 这条路径必须硬失败,交给人决定修还是删。
    console.error(`状态文件已损坏(JSON 解析失败):${paths.stateFile}`);
    console.error('为避免丢失当前标签页/平台等信息,不会自动重建覆盖它。请二选一:');
    console.error('  1) 打开该文件修复内容;');
    console.error(`  2) 删掉它后重试(浏览器在跑时会按端口重建):rm ${paths.stateFile}`);
    process.exit(2);
  }
  if (status === 'ok') {
    const existing = readState(paths.stateFile);
    if (existing) return existing;
  }

  const port = fallbackPort();
  const rebuilt = await rebuildState(paths.stateFile, port);
  if (!rebuilt) {
    console.error(`没有 state.json,且 ${port} 端口上没有运行中的浏览器。`);
    console.error(`请先确认浏览器在跑;它若不在 ${port} 端口上,请显式传 --port=<端口>。`);
    console.error('启动方式(必须以托管后台作业运行):cd <技能目录> && exec node serve.ts');
    process.exit(2);
  }
  // ★ 这里的端口是"猜"的(--port / BROWSER_CDP_PORT / 默认 9222)。
  // 猜错会连到另一个浏览器上,还照样报成功,所以必须把这件事说清楚。
  console.error(
    `[browserctl] state.json 缺失,已在 ${port} 端口找到运行中的浏览器并重建状态。` +
      `该端口取自 --port/BROWSER_CDP_PORT(默认 9222);浏览器不在这个端口上时必须显式传 --port=。`,
  );
  return rebuilt;
}

// 初始化阶段的错误(典型:--port 给了非数字)要打印成人能看的一行,
// 而不是让 top-level await 抛出一整段未捕获堆栈 —— 堆栈会把真正的原因埋掉。
let state: BrowserState;
try {
  state = await loadState();
} catch (e) {
  console.error(`初始化失败:${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
const PORT: number = state.port;
const save = (): void => writeState(paths.stateFile, state);

/** 输出:字符串原样打印,其余走格式化 JSON。 */
const emit = (value: unknown): void => {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

// ---------- 页面会话 ----------
interface PageSession {
  cdp: CdpClient;
  targetId: string;
}

/** 打开浏览器级连接 + 挂到目标页,统一处理标签失效回退。 */
async function attachPage(): Promise<PageSession> {
  const cdp = await CdpClient.connect(PORT, null);
  const { targetInfos } = await cdp.send<CdpTargetInfoList>('Target.getTargets');
  const pages = targetInfos.filter((t) => t.type === 'page');
  let id: string | null = state.tabId;
  if (!id || !pages.some((t) => t.targetId === id)) {
    id = pages[0]?.targetId ?? null;
    if (!id) {
      const created = await cdp.send<CdpCreateTargetResult>('Target.createTarget', { url: 'about:blank' });
      id = created.targetId;
    }
    state.tabId = id;
    save();
  }
  const { sessionId } = await cdp.send<CdpAttachResult>('Target.attachToTarget', { targetId: id, flatten: true });
  cdp.sessionId = sessionId;
  await Promise.all([
    cdp.send('Page.enable'),
    cdp.send('Runtime.enable'),
    cdp.send('DOM.enable').catch(() => undefined),
  ]);
  return { cdp, targetId: id };
}

async function evaluateValue(cdp: CdpClient, expression: string, awaitPromise = true): Promise<unknown> {
  const r = await cdp.send<CdpEvaluateResult>('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

/** 结果已知形状时用这个,省掉每处 `as`。 */
async function evaluateJson<T>(cdp: CdpClient, expression: string): Promise<T> {
  return (await evaluateValue(cdp, expression)) as T;
}

/** 等待加载完成;SPA 或导航失败时超时返回,绝不阻塞。 */
async function waitLoad(cdp: CdpClient, timeoutMs = 12_000): Promise<boolean> {
  const evt = await cdp.waitEvent('Page.loadEventFired', timeoutMs);
  return !evt.timedOut;
}

interface ElementBox {
  x: number;
  y: number;
  w: number;
  h: number;
  tag: string;
  text: string;
}

const scrollIntoView = (sel: string): string => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: Math.round(r.width), h: Math.round(r.height),
           tag: el.tagName, text: (el.innerText || el.value || '').trim().slice(0, 120) };
})()`;

/** 定位元素并返回其中心点;找不到就报错退出,不留下半个动作。 */
async function locate(cdp: CdpClient, sel: string): Promise<ElementBox> {
  const box = await evaluateJson<ElementBox | null>(cdp, scrollIntoView(sel));
  if (!box) {
    console.error(`未找到元素:${sel}`);
    process.exit(1);
  }
  return box;
}

interface KeySpec {
  key: string;
  code: string;
  windowsVirtualKeyCode?: number;
  text?: string;
}

const KEY_TABLE: Record<string, KeySpec> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
};

type Command = () => Promise<void>;

const commands: Record<string, Command> = {
  async info(): Promise<void> {
    const cdp = await CdpClient.connect(PORT, null);
    const { targetInfos } = await cdp.send<CdpTargetInfoList>('Target.getTargets');
    emit({
      port: PORT,
      mode: state.headless === undefined ? '(未知,重启 serve.ts 可补全)' : state.headless ? 'headless' : 'headful',
      platform: state.platform,
      requestedPlatform: state.requestedPlatform ?? null,
      fellBack: state.fellBack ?? false,
      currentTab: state.tabId,
      startedAt: state.startedAt ?? null,
      recovered: state.recovered ?? false,
      runtimeDir: paths.runtimeDir,
      skillDir: paths.skillDir,
      targets: targetInfos.map((t) => ({ id: t.targetId, type: t.type, title: t.title, url: t.url })),
    });
    cdp.close();
  },

  async tabs(): Promise<void> {
    const cdp = await CdpClient.connect(PORT, null);
    const { targetInfos } = await cdp.send<CdpTargetInfoList>('Target.getTargets');
    for (const t of targetInfos) {
      const mark = t.targetId === state.tabId ? '*' : ' ';
      console.log(`${mark} ${t.type.padEnd(11)} ${t.title || '(无标题)'}\n    ${t.url}\n    id=${t.targetId}`);
    }
    cdp.close();
  },

  async open(): Promise<void> {
    const url = args.positionals[0] ?? 'about:blank';
    const cdp = await CdpClient.connect(PORT, null);
    const { targetId } = await cdp.send<CdpCreateTargetResult>('Target.createTarget', { url });
    state.tabId = targetId;
    save();
    console.log(`已打开新标签页(有头窗口里应能看到新标签)\n  id  = ${targetId}\n  url = ${url}`);
    cdp.close();
  },

  async use(): Promise<void> {
    const key = positional(args, 0, 'use <标签页 id 或前缀>');
    const cdp = await CdpClient.connect(PORT, null);
    const { targetInfos } = await cdp.send<CdpTargetInfoList>('Target.getTargets');
    const t = targetInfos.find((x) => x.targetId === key || x.targetId.startsWith(key));
    if (!t) {
      console.error(`找不到标签页 ${key}`);
      process.exit(1);
    }
    state.tabId = t.targetId;
    save();
    await cdp.send('Target.activateTarget', { targetId: t.targetId }).catch(() => undefined);
    console.log(`已切换并置于最前:${t.title} ${t.url}`);
    cdp.close();
  },

  async close(): Promise<void> {
    const id = args.positionals[0] ?? state.tabId;
    if (!id) {
      console.error('没有可关闭的标签页(也没有指定 id)');
      process.exit(1);
    }
    const cdp = await CdpClient.connect(PORT, null);
    await cdp.send('Target.closeTarget', { targetId: id });
    // 关掉的正是当前标签时把 tabId 置空(旧版是 delete 掉这个键);下次 attachPage 会自动重选。
    if (id === state.tabId) state.tabId = null;
    save();
    console.log(`已关闭标签页 ${id}`);
    cdp.close();
  },

  async goto(): Promise<void> {
    const url = positional(args, 0, 'goto <url>');
    const { cdp } = await attachPage();
    const waiter = waitLoad(cdp, flagNumber(args, 'timeout', 15_000));
    const r = await cdp.send<CdpNavigateResult>('Page.navigate', { url });
    const loaded = await waiter;
    const info = await evaluateValue(
      cdp,
      '[location.href, document.title, document.readyState, document.body ? document.body.innerText.length : -1]',
    );
    await cdp.send('Target.activateTarget', { targetId: state.tabId }).catch(() => undefined);
    emit({ requested: url, frameId: r.frameId, navigationError: r.errorText ?? null, loadedEvent: loaded, result: info });
    cdp.close();
  },

  async reload(): Promise<void> {
    const { cdp } = await attachPage();
    const waiter = waitLoad(cdp);
    await cdp.send('Page.reload');
    await waiter;
    emit({ url: await evaluateValue(cdp, 'location.href') });
    cdp.close();
  },

  async back(): Promise<void> {
    const { cdp } = await attachPage();
    const waiter = waitLoad(cdp, 10_000);
    const h = await cdp.send<CdpNavigationHistory>('Page.getNavigationHistory');
    const prev = h.currentIndex > 0 ? h.entries[h.currentIndex - 1] : undefined;
    if (prev) await cdp.send('Page.navigateToHistoryEntry', { entryId: prev.id });
    await waiter;
    emit({ url: await evaluateValue(cdp, 'location.href'), entries: h.entries.length });
    cdp.close();
  },

  async eval(): Promise<void> {
    const { cdp } = await attachPage();
    emit(await evaluateValue(cdp, args.positionals.join(' ')));
    cdp.close();
  },

  async text(): Promise<void> {
    const sel = args.positionals[0] ?? 'body';
    const { cdp } = await attachPage();
    const v = await evaluateJson<string | null>(
      cdp,
      `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.innerText : null })()`,
    );
    console.log(v ?? `(未找到 ${sel})`);
    cdp.close();
  },

  async html(): Promise<void> {
    const sel = args.positionals[0] ?? 'body';
    const limit = flagNumber(args, 'limit', 4000);
    const { cdp } = await attachPage();
    const v = await evaluateJson<string | null>(
      cdp,
      `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.outerHTML : null })()`,
    );
    console.log(v ? v.slice(0, limit) : `(未找到 ${sel})`);
    cdp.close();
  },

  async links(): Promise<void> {
    const sel = args.positionals[0] ?? 'a';
    const { cdp } = await attachPage();
    emit(
      await evaluateJson<unknown[]>(
        cdp,
        `Array.from(document.querySelectorAll(${JSON.stringify(sel)})).slice(0, 100).map((e, i) => ({
      i, tag: e.tagName, text: (e.innerText || e.value || '').trim().slice(0, 70), href: e.href || null }))`,
      ),
    );
    cdp.close();
  },

  async screenshot(): Promise<void> {
    const name = positional(args, 0, 'screenshot <文件名|绝对路径> [--full]');
    // 只给文件名时落到运行时的 shots/,避免产物散进技能目录或当前工作目录。
    const file = path.isAbsolute(name)
      ? name
      : path.join(name.includes('/') ? process.cwd() : paths.shotsDir, name);
    const { cdp } = await attachPage();
    const shot = await cdp.send<CdpScreenshot>(
      'Page.captureScreenshot',
      { format: 'png', fromSurface: true, captureBeyondViewport: hasFlag(args, 'full') },
      20_000,
    );
    const buf = Buffer.from(shot.data, 'base64');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, buf);
    const m = await cdp.send<CdpLayoutMetrics>('Page.getLayoutMetrics').catch(() => null);
    emit({
      saved: file,
      bytes: buf.length,
      viewport: m ? { w: m.cssLayoutViewport.clientWidth, h: m.cssLayoutViewport.clientHeight } : null,
    });
    cdp.close();
  },

  async click(): Promise<void> {
    const sel = positional(args, 0, 'click <css 选择器>');
    const { cdp } = await attachPage();
    const box = await locate(cdp, sel);
    const x = Math.round(box.x);
    const y = Math.round(box.y);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await delay(400);
    emit({
      clicked: sel,
      at: { x, y },
      element: box.tag,
      wasText: box.text,
      urlNow: await evaluateValue(cdp, 'location.href'),
    });
    cdp.close();
  },

  async type(): Promise<void> {
    const sel = positional(args, 0, 'type <css 选择器> <文本> [--append]');
    const value = positional(args, 1, 'type <css 选择器> <文本> [--append]');
    const { cdp } = await attachPage();
    const box = await locate(cdp, sel);
    const x = Math.round(box.x);
    const y = Math.round(box.y);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    if (!hasFlag(args, 'append')) {
      // Ctrl+A 全选,让 type 语义是「覆盖输入」而不是「追加」。
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    }
    for (const ch of value) await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
    emit({
      typed: value,
      into: sel,
      element: box.tag,
      valueNow: await evaluateValue(cdp, `document.querySelector(${JSON.stringify(sel)}).value`),
    });
    cdp.close();
  },

  async key(): Promise<void> {
    const name = positional(args, 0, 'key <Enter|Tab|Escape|Backspace|ArrowUp|ArrowDown|PageUp|PageDown|...>');
    const spec: KeySpec = KEY_TABLE[name] ?? { key: name, code: name };
    const { cdp } = await attachPage();
    const waiter = waitLoad(cdp, 6000);
    const { text, ...down } = spec;
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...down });
    if (text) await cdp.send('Input.dispatchKeyEvent', { type: 'char', text });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...down });
    await waiter;
    emit({ pressed: name, urlNow: await evaluateValue(cdp, 'location.href') });
    cdp.close();
  },

  async scroll(): Promise<void> {
    const { cdp } = await attachPage();
    const before = await evaluateValue(cdp, 'scrollY');
    const to = flagNumber(args, 'to', Number.NaN);
    if (Number.isFinite(to)) {
      await evaluateValue(cdp, `scrollTo(0, ${to})`);
    } else {
      const dx = flagNumber(args, 'dx', 0);
      const dy = flagNumber(args, 'dy', 600);
      await evaluateValue(cdp, `scrollBy(${dx}, ${dy})`);
    }
    await delay(300);
    emit({
      before,
      after: await evaluateValue(cdp, 'scrollY'),
      pageHeight: await evaluateValue(cdp, 'document.body.scrollHeight'),
    });
    cdp.close();
  },

  async size(): Promise<void> {
    const { cdp } = await attachPage();
    const m = await cdp.send<CdpLayoutMetrics>('Page.getLayoutMetrics');
    emit({
      inner: await evaluateValue(cdp, '[innerWidth, innerHeight]'),
      dpr: await evaluateValue(cdp, 'devicePixelRatio'),
      viewport: { w: m.cssLayoutViewport.clientWidth, h: m.cssLayoutViewport.clientHeight },
      page: { w: m.cssContentSize.width, h: m.cssContentSize.height },
    });
    cdp.close();
  },

  /**
   * 把有头窗口"跳"到屏幕最前:
   * 先把窗口缩到 100x100 挪到屏幕外再恢复原尺寸,借此触发窗口管理器的置顶/聚焦,
   * 最后 activateTarget 让该标签页成为活动标签。用于确认"窗口确实在屏幕上"。
   */
  async tray(): Promise<void> {
    // 尺寸先校验再连浏览器:参数写错时应该直接告诉你参数错,而不是先抛一个连接错误。
    const { width: w, height: h } = parseWindowSize(flagString(args, 'size', '1440x900'));
    const cdp = await CdpClient.connect(PORT, null);
    const before = await cdp
      .send<CdpWindowForTarget>('Browser.getWindowForTarget', { targetId: state.tabId })
      .catch(() => null);
    const windowId = before?.windowId ?? 1;
    await cdp
      .send('Browser.setWindowBounds', { windowId, bounds: { left: -300, top: -300, width: 100, height: 100 } })
      .catch(() => undefined);
    await delay(400);
    await cdp
      .send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: w, height: h } })
      .catch(() => undefined);
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => undefined);
    await cdp.send('Target.activateTarget', { targetId: state.tabId }).catch(() => undefined);
    emit({ bounced: true, windowBefore: before, targetId: state.tabId });
    cdp.close();
  },

  async help(): Promise<void> {
    console.log(helpText());
  },
};

function helpText(): string {
  return `命令:
  info | tabs | open <url> | use <id> | close [id]
  goto <url> | back | reload
  eval <js> | text [css] | html [css] | links [css] | size
  screenshot <文件名|绝对路径> [--full]      # 只给文件名则写入运行时 shots/
  click <css> | type <css> <文本> [--append] | key <Enter|Tab|...> | scroll [--dy=N] [--to=N]
  tray [--size=1440x900]   把有头窗口跳到屏幕最前`;
}

const cmd: string | undefined = args.command;
if (cmd === undefined) {
  // 完全没带参数 = 想看帮助,退出码 0。
  if (process.argv.length <= 2) {
    console.log(helpText());
    process.exit(0);
  }
  // 带了参数却没解析出子命令:几乎一定是取值开关把子命令吃掉了,
  // 典型 `--port 9222 info` 里 info 被当成 --port 的值。退出 0 会让人以为命令成功过。
  console.error('缺少子命令。注意空格写法 `--port 9222` 会把后面的 token 当成取值;请写成 `--port=9222`,或把子命令放在最前面。');
  console.log(helpText());
  process.exit(1);
}
const run: Command | undefined = commands[cmd];
if (!run) {
  console.error(`未知命令: ${cmd}`);
  console.log(helpText());
  process.exit(1);
}
try {
  await run();
  process.exit(0);
} catch (e) {
  console.error(`命令失败: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
