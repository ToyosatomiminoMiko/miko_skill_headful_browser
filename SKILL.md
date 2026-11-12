---
name: headful-browser
description: 启动并控制一个有头(headful)Chromium 浏览器,可导航、截图、读屏、执行 JS、点击输入、多标签页。当需要看到真实网页、在真实浏览器里操作页面、或需要驱动浏览器完成多步任务时使用。
---

# 有头浏览器控制台(TypeScript)

在本机拉起一个**有头 Chromium**(窗口真的出现在屏幕上),并通过 Chrome DevTools Protocol
由程序驱动。无需 Selenium / chromedriver。

- **零构建**:源码就是 `.ts`,靠 Node 原生类型剥离直接运行(`node serve.ts`),
  没有 `dist/`、也不存在"改了源码忘了重新编译"这类事。
- **零运行时依赖**:控制面只用原生 WebSocket。
- **两道闸门**:`npm run typecheck`(tsc --noEmit,strict)与 `npm run smoke`(真起浏览器跑全流程)。
- **要求 Node ≥ 22.18**(类型剥离默认开启;实测 24.18.0)。

## 铁律:启动必须是「托管后台作业」

本 harness 每次 `bash` 调用结束会回收该调用派生的所有进程(`bwrap --die-with-parent`),
`nohup` / `setsid ... &` 起的浏览器**活不过一次工具调用**。唯一常驻方式:

```
cd ~/.dsh/skills/headful-browser && exec node serve.ts --url=<起始地址>
```
以 `run_in_background: true` 运行(即以前台方式占住后台作业)。启动后 `state.json`
记录 CDP 端口与当前标签页,后续任意调用都可用 `browserctl.ts` 控制它。

## 目录约定:技能与产物严格分离

| | 位置 | 内容 |
| --- | --- | --- |
| 技能目录 | `~/.dsh/skills/headful-browser/` | 仅代码:`.ts` / `.json` / `.md` / `node_modules`。**运行时绝不写入** |
| 运行时目录 | 默认 `~/.dsh/browser-runtime/`,可用 `BROWSER_RUNTIME_ROOT` 或 `--runtime=` 覆盖 | 全部产物:`state.json` `profile/` `home/` `shots/` `logs/` |

运行时目录默认值**刻意与技能目录位置无关**:技能住在 `~/.dsh/skills/` 下,
若默认取"技能目录上一级",产物就会堆进 `~/.dsh/` 与技能及其它 DSH 数据混居。

产物(尤其保留登录态的 `profile/`)独立存放,技能被复制、更新或覆盖时都不会丢。
技能目录本身也不再写死路径,而是由 `lib/paths.ts` 从 `import.meta.url` 反推。

## 常用命令

```
node browserctl.ts info                      # 端口 / 平台 / 标签页 / 是否回滚
node browserctl.ts goto https://github.com   # 导航
node browserctl.ts eval "document.title"     # 执行 JS
node browserctl.ts text "main"               # 读屏(取可见文本)
node browserctl.ts links "a"                 # 枚举链接,便于决定点哪
node browserctl.ts screenshot a.png          # 只给文件名 → 存到运行时 shots/
node browserctl.ts click "<css>"             # 真实鼠标事件
node browserctl.ts type "<css>" "文本"        # 真实键盘输入
node browserctl.ts scroll --dy=800
node browserctl.ts tray                      # 把有头窗口跳到屏幕最前
```

全部命令带硬超时,不会挂住工具调用。

## 参数写法(与旧版不同,别再踩)

- `--dy=800` 与 `--dy 800` **两种写法都支持**。
- 取值开关(如 `--dy` `--url` `--port` `--timeout`)只写名字不给值 → **直接报错**,
  不再静默回落到默认值。旧版写 `--dy 500` 会滚错距离还报成功(旧 `.mjs` 实际滚 1px)。
- 非数字取值(如 `--timeout=abc`)→ 直接报错,不会把 `NaN` 拼进 JS 表达式或 `setTimeout`。
- 需要传以 `--` 开头的值(例如 `eval` 的表达式)→ 用 `--` 分隔:`eval -- "--count"`。
- `browserctl.ts` 是子命令式入口,**全局开关可以写在子命令前面**:
  `node browserctl.ts --port=9333 info`。

## 读屏工作法

先 `eval` 或 `text` 拿到页面内容再决定动作,不要凭猜测点选择器。
`links` 会返回每个元素的 `href` 和文本,选目标最省事。
`click` / `type` 走 CDP `Input` 域的真实事件(非 JS 伪造),页面行为与真人操作一致。

## 平台与自动回滚

默认 `--ozone-platform=wayland`;启动前探测 `WAYLAND_DISPLAY` 的 unix socket 是否真能连上,
连不上或 CDP 不就绪或 chromium 提前退出,都会自动改用 `x11` 重试一次。
`state.json` 的 `platform` / `requestedPlatform` / `fellBack` 记录实际结果。
`--platform=x11` 强制指定,`--no-fallback` 禁止回滚。

## 自测与类型闸门

```
npm run typecheck    # tsc --noEmit,strict + erasableSyntaxOnly + verbatimModuleSyntax
npm run smoke        # 起真浏览器,跑完 21 项检查;默认用临时目录,不碰你的登录态
npm run smoke -- --headless    # 无显示环境用
npm run smoke -- --keep        # 保留临时运行时目录以便排查
```

改完代码先跑这两条,再去做真实任务。`smoke.ts` 会验证:`--dy 250` 空格写法真的生效、
`click`/`type` 真的触发事件、state.json 丢失后能按正确端口重建、
浏览器在跑时 `clean.ts` 拒绝删 `profile/`(含"port 是字符串"与"端口回 200 非 JSON"两种保守场景)、
state.json 损坏时硬失败不覆盖、`BROWSER_CDP_PORT` 非法时报错。

> `node_modules/` 里只有 `typescript` 与 `@types/node` 两个 **devDependency**,仅供 typecheck。
> 运行技能本身不需要任何依赖。若环境只读导致 `npm install` 失败,把 cache 指到可写目录:
> `npm install --cache /tmp/npm-cache`。

## 清理:什么能删、什么绝对不能删

清理统一走 `clean.ts`,**不要手写 `rm`** —— 运行时目录里 `profile/` 与其它项混放,
手删很容易把登录态一起带走。

```
node clean.ts                          # 预览:列出各项大小与可删除性(默认 dry-run,不落手)
node clean.ts --shots --logs --yes     # 删截图与日志
node clean.ts --all --yes              # 删除 profile 之外的一切
node clean.ts --profile --force --yes  # 连 profile 一起删(重置浏览器身份)
```

| 条目 | 能删? | 说明 |
| --- | --- | --- |
| `state.json` | ✅ | 浏览器下次启动会重新生成。**浏览器在跑时删它会断掉控制面**;`browserctl` 会自动从 CDP 端口重建它,不用重启 |
| `shots/` | ✅ | 截图产物,下次截图自动重建 |
| `logs/` | ✅ | `chromium-*.log` 仅供排查 |
| `tmp/` | ✅ | `compare-ozone.ts` 的平台对照临时 profile |
| `home/` | ✅ | 真实 HOME 只读所以重定向到这里,只含 Chromium 缓存配置 |
| `profile/` | ❌ **默认拒绝** | ★ **登录态 / cookie / localStorage 全在这**。删掉 = 退出所有登录、清空站点数据 |

删除 `profile/` 有两道闸:必须显式 `--profile` + `--force` 才动手;
且会先探测 CDP 端口,**浏览器还在跑就拒绝**(运行中删 profile 会损坏会话)。
无论删什么,技能目录都不在射程内。

> 实测教训:`--all --yes` 会连 `state.json` 一起删掉。浏览器进程不受影响、仍在运行,
> 但此前 `browserctl` 会因为读不到端口而彻底失联,只能重启 `serve.ts`。
> 现在 `browserctl` 会在 `state.json` 缺失时探测 CDP 端口并自动重建状态文件,这个死局已经堵上。
>
> ⚠️ **重建时端口是"猜"的**:取 `--port=` → `BROWSER_CDP_PORT` → 默认 `9222`。
> 浏览器不在该端口上时,它会去探另一个浏览器、还可能报"成功"。所以非默认端口务必显式传
> `--port=<端口>`,否则 `--all --yes` 之后你连的可能是另一个浏览器。

## 环境限制(实测,别再重新踩)

- **网络是白名单制**:`github.com` `api.github.com` `bing.com` `registry.npmjs.org`
  `pypi.org` `cdn.jsdelivr.net` `unpkg.com` `deb.debian.org` 通;
  `example.com` `google.com` `wikipedia.org` `raw.githubusercontent.com` 不通
  (被挡的站点会渲染成 `chrome-error://chromewebdata/` 错误页)。
  白名单本身会抖动:同一站点可能一次 415ms、一次 15s 超时;`netprobe.ts` 默认 5s 超时会把"慢"报成"不通",
  拿不准就加 `--timeout=15` 重测。
- **无 `/dev/dri`**:GPU 不可用,固定 SwiftShader 软件渲染;实测重页面渲染与截图正常。
- **真实 HOME 只读**:`HOME`/XDG 已重定向到运行时目录。
- **不要用 `pkill -f <关键字>` 清理**:脚本所在的那条 bash 命令行也含关键字,`pkill`
  会把执行它的 shell 一起杀掉(实测 exit 137 且零输出)。只用 PID 清理。
- **抓不了物理桌面**:`import -window root` 在这套 ImageMagick 7.1 上不可用,
  也没有 `xwd` / `grim` / `slurp`。截图只能走 CDP 页面截图。

## 排查

- 命令报「没有 state.json,且 N 端口上没有运行中的浏览器」→ 浏览器没在跑,
  或它不在你传的端口上(非默认端口必须 `--port=`)。
- 命令打印「state.json 缺失,已在 N 端口找到…并重建状态」→ 状态文件被删过。
  若那个 N 不是你要的浏览器,立刻重启 `serve.ts` 重建正确状态。
- 命令报「状态文件已损坏(JSON 解析失败)」→ **不会自动重建**(以免丢掉当前标签页与平台信息)。
  打开修,或删掉它再重试。
- 窗口没出现 → 跑 `node browserctl.ts tray`;仍不行就查运行时目录的 `logs/`。
- 启动阶段静默死掉 → 看运行时目录 `logs/startup-crash.log`。
- 类型/接口不确定 → `npm run typecheck`;行为不确定 → `npm run smoke`。
- 判断「静默卡死」不要信重定向到文件的后台输出:后台 node 的 stdout 缓冲会在进程被 kill 时
  连同尾部输出一起丢掉,要前台直跑一次。

更详细的背景、实测数据与设计取舍见 [README.md](README.md)。

## 自我演进(每次使用后)

本技能是独立 git 仓库:`https://github.com/ToyosatomiminoMiko/miko_skill_headful_browser`(分支 `main`)。
每次用它完成一个任务后,花一分钟复盘,把这次学到的东西沉淀回技能仓,让它比上次更强:

1. **复盘**:本次哪些步骤是临时摸索出来的?哪些坑下次还会踩?哪些参数、用法或验收口径值得写下来?
2. **沉淀**:只把**可复用**的成果落盘(`lib/` 与入口脚本的通用化、`SKILL.md` 的流程与排障、
   `README.md` 的设计取舍与实测数据);运行时产物(`state.json` `shots/` `logs/` `profile/`)不进仓。
3. **自检**:`npm run typecheck`;改了启动流程或控制面行为再跑 `npm run smoke`(会真起浏览器)。
   不通过先修,别把坏状态提交。
4. **提交并推送**:`bash scripts/git_sync.sh "<feat|fix|docs|example>: 一句话"`。
   工作区干净时脚本自动跳过;推送失败会保留本地提交并打印重试命令(代理
   `127.0.0.1:7897` 未启动时脚本自动直连重试)。
5. **边界**:不改变技能的对外契约(命令名、参数、`state.json` 字段、目录约定),除非本次任务明确要求;
   一类改动一个提交,提交信息写清"为什么"。

没有产生可复用改进就不提交:要自我迭代,但不要为提交而提交。

> 注:`~/.dsh/skills/` 在 DSH 默认的 workspace-write 沙箱下是只读的;写不进去时向用户申请
> 一次提权(或把改动内容交给用户执行),不要静默放弃。
