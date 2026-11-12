/**
 * 是什么:命令行参数解析,技能内所有入口共用一份。
 *
 * 为什么集中成一份:
 *  1. 旧版 serve.mjs / clean.mjs / browserctl.mjs 各抄了一份 arg()/has(),三处行为迟早分叉。
 *  2. 旧版 `Number(flags.timeout || 15000)` 这类写法遇到垃圾输入会静默变成 NaN,
 *     而 NaN 传给 setTimeout 会立刻触发 —— 表现为「命令莫名其妙秒失败」,极难查。
 *     这里把解析与校验合并:非法值当场抛出可读错误,绝不留下静默 NaN。
 *
 * 为什么区分 parseArgs 与 parseSubcommandArgs:
 *  只有 browserctl 是「子命令式」入口(第一个 token 是子命令)。
 *  其余入口(serve / clean / health / compare-ozone / netprobe)的第一个 token 就是开关本身,
 *  例如 `node clean.ts --all --yes`。若对这种入口也把首个 token 当子命令吞掉,
 *  `--all` 会凭空消失,清理变成「未指定任何项」—— 一个不报错但什么也没干的静默错误。
 *
 * 元信息:@dsh agent,2026-10-14
 */

export interface ParsedArgs {
  /** 子命令名;仅 parseSubcommandArgs 会填,其余入口恒为 undefined */
  command: string | undefined;
  /** 非开关 token,顺序保留 */
  positionals: string[];
  /** `--k=v` / `--k v` → string;裸 `--k` → true */
  flags: Map<string, string | true>;
}

export interface ParseOptions {
  /**
   * 需要取值的开关名。
   *
   * 为什么需要这份名单:本技能历史上只支持 `--k=v`。有人(实测就是我自己)写成 `--dy 500` 时,
   * `--dy` 被当成裸开关、`500` 悄悄变成位置参数,而 flagNumber 又回落默认值 ——
   * 命令"成功"了,实际滚了 600px 而不是 500px。这种静默错值是最难查的一类不确定性。
   * 声明之后:`--k v` 空格写法可用,且取值缺失直接报错,不再有静默回落。
   */
  valueFlags?: readonly string[];
}

/** 底层:把 token 序列拆成位置参数与开关,不识别子命令。 */
function collect(
  tokens: readonly string[],
  options: ParseOptions,
): { positionals: string[]; flags: Map<string, string | true> } {
  const valueFlags = new Set(options.valueFlags ?? []);
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  let literal = false;
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (a === undefined) continue;
    if (literal) {
      positionals.push(a);
      continue;
    }
    if (a === '--') {
      // `--` 之后的全部内容按字面处理:需要传以 `--` 开头的值时这是唯一不歧义的写法。
      literal = true;
      continue;
    }
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq !== -1) {
      flags.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const name = a.slice(2);
    if (valueFlags.has(name)) {
      const next = tokens[i + 1];
      // 值不能以 `--` 开头,否则 `--url --headless` 会把下一个开关吃掉。
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(name, next);
        i++;
        continue;
      }
    }
    flags.set(name, true);
  }
  return { positionals, flags };
}

/** 解析「无子命令」入口。第一个 token 就是普通 token,不会被当成子命令吃掉。 */
export function parseArgs(argv: readonly string[], options: ParseOptions = {}): ParsedArgs {
  const { positionals, flags } = collect(argv, options);
  return { command: undefined, positionals, flags };
}

/**
 * 解析「子命令式」入口(browserctl),并允许全局开关写在子命令前面。
 * `browserctl --runtime=/x info` 若按「第一个 token 就是子命令」处理,
 * 会报「未知命令: --runtime=/x」这种把人引向错误方向的提示,所以先扫出子命令。
 */
export function parseSubcommandArgs(argv: readonly string[], options: ParseOptions = {}): ParsedArgs {
  const valueFlags = new Set(options.valueFlags ?? []);
  let command: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (command === undefined && a.startsWith('--') && a !== '--') {
      rest.push(a);
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq === -1 && valueFlags.has(name)) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          rest.push(next);
          i++;
        }
      }
      continue;
    }
    if (command === undefined && a !== '--') {
      command = a;
      continue;
    }
    rest.push(a);
  }
  const { positionals, flags } = collect(rest, options);
  return { command, positionals, flags };
}

/** 裸开关是否存在。 */
export function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

/**
 * 参数错误的统一出口:打印一行可读错误并退出(exit 1)。
 *
 * 为什么不抛异常:参数解析都发生在各入口的**模块求值阶段**(顶层 const),
 * 抛出去会变成 unhandledRejection,Node 会打印一整段堆栈 ——
 * 堆栈把"你把 --dy 写成了裸开关"这种一句话就能说清的事埋掉了。
 * 审计实测:`node health.ts`、`clean.ts --runtime`、`serve.ts --port=abc`
 * 等在旧实现下都会甩出堆栈,所以这里统一收口。
 */
export function argFail(message: string): never {
  console.error(`参数错误:${message}`);
  process.exit(1);
}

/** 取值开关只给了名字没给值时的统一报错文案。 */
function missingValue(name: string, hint?: string): string {
  const example = hint ? `,例如 --${name}=${hint}` : '';
  return `--${name} 缺少取值:写成 --${name}=<值> 或 --${name} <值>${example}`;
}

/** 取字符串开关;没给、或给了空值(`--k=`)一律回落 def。 */
export function flagString(args: ParsedArgs, name: string, def: string): string {
  const raw = args.flags.get(name);
  if (raw === undefined) return def;
  if (raw === true) argFail(missingValue(name));
  return raw === '' ? def : raw;
}

/** 取可选字符串开关;没给或空值都返回 undefined。 */
export function flagStringOpt(args: ParsedArgs, name: string): string | undefined {
  const raw = args.flags.get(name);
  if (raw === undefined) return undefined;
  if (raw === true) argFail(missingValue(name));
  return raw === '' ? undefined : raw;
}

/**
 * 取数字开关。
 * 取不到值、或拿到非数字都直接报错退出,而不是回落到默认值 ——
 * 静默回落会让 `--timeout=abc` 这类笔误伪装成「命令正常但行为古怪」。
 */
export function flagNumber(args: ParsedArgs, name: string, def: number): number {
  const raw = args.flags.get(name);
  if (raw === undefined) return def;
  if (raw === true) argFail(missingValue(name, '500'));
  if (raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) argFail(`--${name} 需要数字,收到:${raw}`);
  return n;
}

/**
 * 取第 index 个位置参数,缺失时报错退出。
 * noUncheckedIndexedAccess 让 positionals[i] 的类型是 `string | undefined`,
 * 这个函数是唯一出口 —— 想蒙混过关拿 undefined 当 string 用会直接编译不过。
 */
export function positional(args: ParsedArgs, index: number, usage: string): string {
  const v = args.positionals[index];
  if (v === undefined) argFail(`缺少参数。用法:${usage}`);
  return v;
}

/**
 * 解析窗口尺寸(`1440x900` 或 `1440,900`)。
 *
 * 为什么单独抽出来:旧实现是裸 `.split('x').map(Number)`,写 `--size=abc` 会得到
 * `NaN`,再被送进 `Browser.setWindowBounds` —— 而那里是 `.catch(() => {})`,
 * 于是"改窗口"静默失败、命令照样报成功。这里把非法尺寸挡在发请求之前。
 */
export function parseWindowSize(value: string, usage = '--size=<宽>x<高>'): { width: number; height: number } {
  const m = /^(\d+)\s*[x,×]\s*(\d+)$/.exec(value.trim());
  if (!m) argFail(`尺寸格式不对:收到 "${value}",应为 ${usage},例如 1440x900`);
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width <= 0 || height <= 0) argFail(`尺寸必须为正数:收到 "${value}"`);
  return { width, height };
}
