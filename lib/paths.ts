/**
 * 是什么:技能目录(代码)与运行时目录(产物)的路径解析,所有入口共用。
 *
 * 为什么:
 *  - 技能目录用 import.meta.url 反推,而不是写死 `~/.dsh/skills/headful-browser`。
 *    技能可以被复制/安装到任意位置(项目级 .dsh/skills、.agents/skills、
 *    skill-filesystem 的 customSkillDirs),写死路径会让清理预览与安装提示指到不存在的地方。
 *    旧版 clean.mjs 正是写死的,一旦技能不在默认位置就显示错误信息。
 *  - 运行时目录默认 ~/.dsh/browser-runtime,**刻意与技能目录位置无关**:
 *    技能住在 ~/.dsh/skills/ 下,若默认取「上一级」,产物会堆进 ~/.dsh/
 *    与技能及其它 DSH 数据混居;而 profile/ 里的登录态必须在技能被复制/更新/覆盖时不丢。
 *
 * 元信息:@dsh agent,2026-10-14
 */
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 技能目录(只放代码,运行时绝不写入)。本文件在 lib/ 下,上一级就是技能根。 */
export const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export interface RuntimePaths {
  /** 技能目录:代码,只读 */
  skillDir: string;
  /** 产物根目录 */
  runtimeDir: string;
  /** 运行状态(CDP 端口、当前标签页、实际平台) */
  stateFile: string;
  /** ★ chromium 用户数据目录 —— 登录态/cookie/localStorage 都在这 */
  profileDir: string;
  /** 重定向后的 HOME(真实 HOME 被沙箱挂成只读) */
  homeDir: string;
  logsDir: string;
  shotsDir: string;
  /** compare-ozone 的平台对照临时 profile */
  tmpDir: string;
}

/**
 * 取第一个非空值。
 * 必须把空串和 undefined 一视同仁:命令行 `--runtime=` 与 `BROWSER_RUNTIME_ROOT=`
 * 都应该回落到默认值,而不是 path.resolve('') 得到当前工作目录。
 */
function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((v): v is string => v !== undefined && v !== '');
}

export interface ResolveOptions {
  /** `--runtime=` 的值 */
  runtime?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

/** 解析产物路径。优先级:`--runtime=` > `BROWSER_RUNTIME_ROOT` > `$DSH_HOME/browser-runtime` > `~/.dsh/browser-runtime`。 */
export function resolveRuntime(options: ResolveOptions = {}): RuntimePaths {
  const env = options.env ?? process.env;
  const dshHome = firstNonEmpty(env.DSH_HOME) ?? path.join(homedir(), '.dsh');
  const runtimeDir = path.resolve(
    firstNonEmpty(options.runtime, env.BROWSER_RUNTIME_ROOT) ??
      path.join(dshHome, 'browser-runtime'),
  );
  return {
    skillDir: SKILL_DIR,
    runtimeDir,
    stateFile: path.join(runtimeDir, 'state.json'),
    profileDir: path.join(runtimeDir, 'profile'),
    homeDir: path.join(runtimeDir, 'home'),
    logsDir: path.join(runtimeDir, 'logs'),
    shotsDir: path.join(runtimeDir, 'shots'),
    tmpDir: path.join(runtimeDir, 'tmp'),
  };
}
