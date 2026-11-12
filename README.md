# 有头 Chromium 控制台(TypeScript)

> 源码仓:<https://github.com/ToyosatomiminoMiko/miko_skill_headful_browser>(clone 到 `~/.dsh/skills/headful-browser/` 即为安装)

一个跑在本机的**有头(headful)Chromium**,通过 Chrome DevTools Protocol(CDP)被程序控制:
导航 / 截图 / 读屏 / 执行 JS / 点击输入 / 多标签页。

本目录是**技能本体**(安装到 `~/.dsh/skills/headful-browser/`);所有运行产物写在独立的
运行时目录(默认 `~/.dsh/browser-runtime/`,可用 `BROWSER_RUNTIME_ROOT` 覆盖):

| | 位置 | 内容 |
| --- | --- | --- |
| 技能目录 | `~/.dsh/skills/headful-browser/` | 仅代码。运行时绝不写入 |
| 运行时目录 | `~/.dsh/browser-runtime/` | `state.json` `profile/` `home/` `shots/` `logs/` |

两者**位置无关**:运行时目录默认值不取"技能目录上一级",否则技能住进 `~/.dsh/skills/`
后产物会堆进 `~/.dsh/`,与技能及其它 DSH 数据混居。

产物(尤其保留登录态的 `profile/`)独立存放,技能被复制、更新或覆盖时都不会丢。

## 为什么是 TypeScript,而且不编译成 JS

这套东西原先是一堆 `.mjs`。改写成 TS 的目的不是"用上新语法",而是**减少写错的空间**:

| 手段 | 挡掉的具体错误 |
| --- | --- |
| `strict` + `noUncheckedIndexedAccess` | `argv[i]` / `size[0]` / `entries[i-1]` 一律是 `T \| undefined`,必须显式处理"拿不到"的分支 |
| `verbatimModuleSyntax` | 类型导入必须写 `import type`,否则剥离后会留下一个真实 import 去加载只有类型的模块,运行时直接炸 |
| `erasableSyntaxOnly` | 禁掉 `enum` / `namespace` / 构造函数参数属性,保证 `node xxx.ts` 一定能跑(这是零构建的前提) |
| 手写 CDP 协议类型 | CDP 返回值在 JS 里全是 `any`,字段名写错只会得到 `undefined`。现在写错直接编译不过 |
| `npm run smoke` | 起真浏览器跑 17 项检查,覆盖"命令报成功但动作没发生"这类静默故障 |

**为什么不 `tsc` 编译出 `dist/`**:那会多出"源码与产物两份、忘了重新编译就在跑旧代码"的新不确定性,
正是本轮想消灭的东西。所以 `tsconfig.json` 是 `noEmit`,只当闸门;

```jsonc
"module": "NodeNext", "allowImportingTsExtensions": true, "noEmit": true
```

源码由 **Node 原生类型剥离**直接执行(要求 Node ≥ 22.18;本地实测 v24.18.0):

```
node serve.ts          # 就这么跑,没有构建步骤
npm run typecheck      # 唯一的编译期检查:tsc --noEmit
```

代价是必须遵守"可擦除语法"约定(不能写 `enum` 等),这由 `erasableSyntaxOnly` 强制,
写错会当场编译失败,而不是运行期才发现。

## 为什么必须是"托管后台作业"启动

本 harness 每次 `bash` 调用结束会回收该调用派生的所有进程(`bwrap --die-with-parent`),
所以 `nohup` / `setsid` 起的浏览器活不过一次工具调用。唯一能常驻的启动方式,
是把 `serve.ts` 作为 **harness 的托管后台作业**(`run_in_background`)以前台方式跑着:

```
# 在 DSH 里以后台作业启动(会一直活着,直到显式 kill)
cd ~/.dsh/skills/headful-browser && exec node serve.ts --url=https://github.com

# 默认就是原生 wayland;要强制回退 XWayland:
node serve.ts --platform=x11 --url=https://github.com
node serve.ts --no-fallback --url=https://github.com   # 禁止自动回滚
```

启动后 `state.json` 会记录 CDP 端口与当前标签页,后续任何进程用 `browserctl.ts` 控制它。

> 如果你想让它脱离 DSH 长期存活,在你自己的终端里跑同样的命令即可
> (需要 `DISPLAY=:0`、`XDG_RUNTIME_DIR=/run/user/1000`)。

## 控制命令

```
node browserctl.ts tabs                          # 列标签页
node browserctl.ts open https://github.com       # 新标签页(有头窗口里会出现)
node browserctl.ts goto https://github.com       # 当前标签页导航
node browserctl.ts eval "document.title"         # 执行 JS
node browserctl.ts text "main"                   # 取可见文本(读屏)
node browserctl.ts links "a"                     # 枚举链接
node browserctl.ts screenshot a.png [--full]     # 只给文件名 → 存到运行时 shots/
node browserctl.ts click "a[href*='signup']"     # 真实鼠标事件
node browserctl.ts type "input[name=q]" "hello"  # 真实键盘输入
node browserctl.ts key Enter
node browserctl.ts scroll --dy=800
node browserctl.ts info | size | back | reload | use <id> | close [id]
node browserctl.ts tray                          # 把有头窗口跳到屏幕最前
```

所有命令都带硬超时,不会把调用挂死。

## 参数解析(本轮改写过,行为与旧版不同)

统一在 `lib/args.ts`,规则如下:

| 写法 | 行为 |
| --- | --- |
| `--dy=800` / `--dy 800` | 都支持(空格写法在声明为取值开关后生效) |
| 裸 `--dy`(取值开关不给值) | **报错**,不再静默用默认值 |
| `--timeout=abc` | **报错**,不再把 `NaN` 传进 `setTimeout`(NaN 会立刻触发,表现为"命令莫名秒失败") |
| `--` 之后 | 全部按字面位置参数处理,用于传以 `--` 开头的值:`eval -- "--count"` |
| `browserctl.ts` 的全局开关 | 可写在子命令前:`browserctl.ts --port=9333 info` |
| `serve.ts --url=X` 这类入口 | 第一个 token 就是普通 token,不会被误当成子命令吞掉 |

改动起因很具体:`--dy 500` 会被解析成「裸开关 `--dy` + 位置参数 `500`」,于是滚动距离是错的,
而且**命令照样报成功**。旧 `.mjs` 与我的初版 TS 都中招,只是错法不同:

| | `--dy 500` 实际滚了 |
| --- | --- |
| 旧 `.mjs` | **1px** —— `Number(flags.dy \|\| 600)` 里 `flags.dy` 是 `true`,`true \|\| 600` 得 `true`,`Number(true)` = 1 |
| 初版 TS(已被 smoke 抓到并修掉) | **600px** —— `flagNumber` 把裸开关当成"没给",回落到默认值 |
| 现在 | **500px** —— 空格写法被识别;若确实没给值则当场报错,不再回落 |

这类**静默错值**是本轮重点消灭的对象。

## 自测与类型闸门

```
npm run typecheck    # tsc --noEmit
npm run smoke        # 起真浏览器跑全流程;默认用 os.tmpdir() 下的临时运行时目录
```

`smoke.ts` 的 21 项检查(实测全绿):

1. serve 就绪、`state.json` 端口与启动参数一致、平台是 wayland/x11、已选中 page 标签
2. `eval` 拿到当前地址、页面内容正确
3. `type` 输入生效、`click` 触发真实事件(页面 `document.title` 被改写)
4. 截图落盘且非空
5. `scroll --dy 250` 空格写法生效(专门为上面那个 bug 留的回归项)
6. `open` / `tabs` / `close` 标签页生命周期
7. `state.json` 删除后按**正确端口**重建
8. `health.ts` 报告 `ok=true`
9. `clean.ts` 无参数时只预览不落手;浏览器在跑时拒绝删 `profile/`
10. `serve.ts` 响应 SIGTERM 退出

其中最后 4 项是**审计发现的静默故障的回归测试**,专门盯住"删掉登录态"这类不可逆后果:

11. `state.json` 的 `port` 被写成字符串时,`clean.ts` 仍拒绝删 `profile/`
12. 端口上只有一个"回 200 但非 JSON"的服务时,`clean.ts` 仍拒绝删 `profile/`
    —— profile 闸门必须偏保守,**宁可误拒不能误放**
13. `state.json` 损坏(JSON 解析失败)时硬失败 exit 2,且**不覆盖原文件**
    —— 否则 `info` 会把无头报成 `headful`、`tabId` 被重置成第一个 page
14. `BROWSER_CDP_PORT` 非法时报错退出,不静默回落 9222

`smoke.ts` 默认在自己新建的临时目录里跑,自带独立端口与 profile,**不碰**
`~/.dsh/browser-runtime` 里的真实登录态;结束时删掉临时目录(显式传 `--runtime=` 则保留)。

## 显示环境(实测结论)

宿主是 **KDE Plasma Wayland** 会话,GPU 是 NVIDIA RTX 4050:

- `:0` 是 **XWayland**,6720×2160(DP-1 物理 3840×2160 + 缩放)
- `/run/user/1000/wayland-0` **有真实合成器在监听**

据此用 `compare-ozone.ts` 对照测过两个平台,**结论是两者都可用**:

| | 纯 Wayland | X11 / XWayland |
| --- | --- | --- |
| CDP 渲染 + 截图 | ✅ 18.9KB / 1691ms | ✅ 14.9KB / 1101ms |
| 初始窗口位置 | 合成器决定(`left=1930`) | 客户端自定(`left=10`) |
| `Browser.setWindowBounds` | ✅ OK | ✅ OK |

(上表为 TS 版 `compare-ozone.ts` 的复测值,与旧 `.mjs` 版记录一致:18.9KB/1390ms 与 14.9KB/864ms。)

日志侧证据:Wayland 模式下 Chromium 加载了 `zwp_linux_dmabuf` 协议
(只有真正挂上合成器才会走到这一步),仅报 `drmGetDevices2() has not found any devices`。

**所以纯 Wayland 不是"不能",是"我没试"就先选了 X11。** 当时推理是"X11 抓屏工具齐全、
无 DRI 时软件渲染路径更稳",前半句在当时成立、后半句没有任何依据。

**当前默认已改为原生 Wayland**,并带**自动回滚**:
启动前先探测 `WAYLAND_DISPLAY` 的 unix socket 是否真能连上(文件存在但没人 listen 也算不可用),
连不上、或 CDP 端口 60s 不就绪、或 chromium 提前退出,都会自动改用 `--ozone-platform=x11` 重试一次。
回滚结果记录在 `state.json` 的 `platform` / `requestedPlatform` / `fellBack` 三个字段里。
`--no-fallback` 可禁止回滚,`--platform=x11` 可强制指定。

Wayland 下的实测(GitHub 首页,1408×771 原生分辨率):

![Wayland 下的 GitHub](~/.dsh/browser-runtime/shots/wayland-github.png)

**实测不可用的东西**:`import -window root` 在这套 ImageMagick 7.1 上**抓不了物理桌面**,
各种写法(输出路径/`png:` 前缀/`-silent`/`magick import`)都报
`missing an image filename`;系统也没有 `xwd`、`grim`、`slurp`。
所以"截真实桌面"这条路不通,截图只能走 CDP 的页面截图。

## 其他已知限制

- **网络是白名单制的**。实测:
  - 通:`github.com` `api.github.com` `bing.com` `registry.npmjs.org` `pypi.org`
    `cdn.jsdelivr.net` `unpkg.com` `deb.debian.org`
  - 不通:`example.com` `google.com` `wikipedia.org` `raw.githubusercontent.com`
    (被挡的站点,浏览器会渲染成 `chrome-error://chromewebdata/` 错误页)
  - **白名单会抖动**:同一站点实测出现过 415ms 通、也出现过 15s 超时。
    `netprobe.ts` 默认 5s 超时会把"慢"报成"不通",拿不准就 `--timeout=15` 重测;
    它的输出按输入顺序排列(旧 shell 版按完成顺序),两次探测可直接 diff。
- **沙箱里没有 `/dev/dri`**,GPU 不可用,已固定 `--use-angle=swiftshader` 走软件渲染;
  实测 GitHub 这类重页面渲染正常、截图正常。
- **`HOME` 被挂成只读**,所以 `serve.ts` 把 `HOME`/XDG 目录重定向到运行时目录的 `home/`。
- **不要用 `pkill -f <关键字>` 清理浏览器**:脚本所在的那条 bash 命令行本身也含关键字,
  `pkill` 会把自己所在的 shell 杀掉(实测 exit 137 且无任何输出)。只能用 PID 清理;
  `compare-ozone.ts` 内部也遵循这条,只用 PID 收尸。

## 为什么不用 chrome-remote-interface

实测:当页面处于「导航挂起 / 网络错误页」状态时,它的连接与 Session 管理会整体卡死
(attach 既不返回也不报错)。原生 WebSocket 发一条 `Target.getTargets` 只要 7ms。
所以控制面零依赖,直接讲 CDP 协议,每个请求独立超时。

**依赖已移除**:旧 `package.json` 里挂着 `chrome-remote-interface`,但全仓库只有一句注释提到它,
没有任何 `import` —— 连"对照脚本用"这个说法也不成立(`health.mjs` 走的是原生 WebSocket)。
现在 `node_modules/` 只剩两个 devDependency:`typescript` 与 `@types/node`,运行技能时一个都不需要。

## 与旧 `.mjs` 版的差异(迁移备忘)

| 类别 | 变化 |
| --- | --- |
| 文件 | `serve/browserctl/clean/health/compare-ozone/netprobe` 由 `.mjs`/`.sh` 全部改为 `.ts`,`node xxx.mjs` → `node xxx.ts` |
| 新增 | `lib/`(args、paths、state、cdp、health 五个共享模块)、`smoke.ts`、`tsconfig.json` |
| 参数 | 见上文「参数解析」;新增空格写法、取值缺失报错、`--` 字面量、browserctl 全局开关前置 |
| 参数 | **修掉**:初版 TS 解析器会把首个 token 当子命令吞掉(`clean.ts --all --yes` 里的 `--all` 会消失,变成"什么都没删"的静默错误)。这是重写过程中自己引入的回归,由 `smoke.ts` 抓到;旧 `.mjs` 用「扫全 argv」的 `arg()/has()`,反而没有这个问题。旧版真正的问题是 browserctl 里全局开关写在子命令前(`browserctl.mjs --port=abc info` → 报"未知命令") |
| 安全 | `clean.ts` 判定"浏览器在不在跑"改用**保守口径**:端口上只要有 HTTP 响应就拒绝删 profile(旧 `.mjs` 是 `res.ok` 即算在跑,同样是保守的;我初版用严格 JSON 校验反而把闸门放松了,审计发现后已改回) |
| 安全 | **`state.json` 损坏不再等同于缺失**:损坏时硬失败(exit 2)并保留原文件,不会把它覆盖成一份残缺状态。否则 `info` 会把无头报成 `headful`、平台变未知,`tabId` 被重置成第一个 page —— 你 `use` 选的页面被悄悄换掉 |
| 安全 | `BROWSER_CDP_PORT` 给了非法值时**报错**,不再静默回落 9222(否则会在另一个浏览器上继续干活还报成功) |
| 体验 | 各入口的参数错误统一成一行 `参数错误:…` + exit 1,不再甩出整段 Node 堆栈 |
| 体验 | `--size` 校验 `宽x高` 格式(旧 `tray --size=abc` 会把 NaN 送进 `setWindowBounds` 并被 `.catch` 静默吞掉) |
| 体验 | 连不上浏览器时报 `连不上 CDP 端口 N:…`,而不是光秃秃的 `fetch failed` |
| 健壮性 | `writeState` 失败时清掉临时文件;`clean.ts --state` 顺带清扫 `state.json.tmp-*` 残留 |
| 健壮性 | `smoke.ts` 注册了 `process.on('exit')` 兜底收尸,中途抛异常也不会留下 serve/chromium 子进程 |
| 安全 | `state.json` 改为原子写(临时文件 + rename),不再可能留下半截 JSON(旧版直接 `writeFileSync`,被 kill 时会留半截) |
| 安全 | `state.json` 重建时**明确告知端口是猜的**(`--port` → `BROWSER_CDP_PORT` → 9222),避免连到另一个浏览器还报成功 |
| 健壮性 | `waitEvent` 在 settle 后摘掉监听器(旧版每次泄漏一个);WebSocket 断开时立刻 reject 所有在途请求,不再空等到超时 |
| 健壮性 | 技能目录改用 `import.meta.url` 反推(旧版 `clean.mjs` 把技能路径写死,技能装在别处就显示错误信息) |
| 体验 | `health.ts` 连不上浏览器时输出 JSON 并给非 0 退出码(旧版会崩出未捕获异常) |
| 体验 | `netprobe.ts` 按输入顺序输出并附耗时(旧版按完成顺序、无耗时) |
| 行为等价 | 命令集(20 个子命令逐一对照)、CDP 交互、`clean` 的两道安全闸门、`serve` 的回滚条件、`state.json` 字段、环境变量(`DSH_HOME` `BROWSER_RUNTIME_ROOT` `CDP_TIMEOUT_MS` `BROWSER_CDP_PORT` `XDG_RUNTIME_DIR` `DISPLAY` `WAYLAND_DISPLAY`)均一致 |
| 退出码 | **不是全部一致**,差异如下(均为"更响亮"方向):`browserctl --port=abc info` 旧 2 → 新 1;`netprobe.ts` 无参数 旧 exit 0 空输出 → 新 usage + exit 1;`browserctl --port 9222`(值把子命令吃掉)新旧都 exit 1,但新版给出明确提示;`state.json` 损坏旧 1 抛 SyntaxError → 新 2 带可操作提示 |
| 诊断口径 | `CDP_TIMEOUT_MS` 现在对**所有**入口生效,含 `health.ts` / `compare-ozone.ts`(旧 `health.mjs` 的 send 无超时会一直等)。设了很小的值时,体检会更快报超时 |
| 诊断口径 | `netprobe.ts` 由 curl 换成 Node `fetch`:后者**默认不读代理环境变量**、用自带 CA。需要代理时请设 `NODE_USE_ENV_PROXY=1`,程序检测到代理变量也会警告。另外 `TIMEOUT=0` 在旧 curl 语义里是"不超时",现在回落 5s |

## 安装 / 启用为 skill

本技能位于 `~/.dsh/skills/headful-browser/`,DSH 的用户级技能根目录,
会被自动发现(`dsh-skill-filesystem` 的实现)。

**技能本体就在这里**,`~/.dsh/skills/headful-browser/` 下的就是全部源码(.ts 即运行代码,无编译产物)。
要改就直接改这个目录,改完 `npm run typecheck && npm run smoke` 自检。

下面是从**别处**(另一台机器、另一个 checkout、或备份)覆盖安装的写法:

```bash
# ⚠️ 备份必须放在 ~/.dsh/skills/ 之外。那里每个"含 SKILL.md 的子目录"都会被当成一个技能,
#    备份目录放进去会让技能列表里多出一个重复的 headful-browser。
tar -czf ~/.dsh/headful-browser-backup-$(date +%Y%m%d-%H%M).tar.gz -C ~/.dsh/skills headful-browser

# 覆盖安装:--delete 会清掉旧 .mjs / .sh;运行时目录 ~/.dsh/browser-runtime 不受影响、登录态不丢
rsync -a --delete <TS 版所在目录>/ ~/.dsh/skills/headful-browser/
```

装完自检(在技能目录里跑,用临时运行时目录,不碰你的登录态):

```bash
cd ~/.dsh/skills/headful-browser && npm run typecheck && npm run smoke
```

若目标环境 `/home` 只读(`npm install` 默认 cache 在 `~/.npm`),安装 devDependency 时把 cache 指到可写目录:

```bash
cd ~/.dsh/skills/headful-browser && npm install --cache /tmp/npm-cache
```

不带 `node_modules` 也能跑技能本身(运行时零依赖),只有 `npm run typecheck` 需要它。

发现根目录一览,供以后迁移参考:

| 来源 | 路径 | 布局 |
| --- | --- | --- |
| 项目 | `<项目根>/.dsh/skills`、`<项目根>/.agents/skills` | 每个技能一个子目录,内含 `SKILL.md`;或根目录直接放 `*.md` |
| 用户 | `~/.dsh/skills` | 同上 |
| 自定义 | `skill-filesystem` 插件的 `customSkillDirs` 配置 | 同上 |

要装到别的项目里,把它放进该项目根的 `.dsh/skills/`(或 `.agents/skills/`)即可。

## 运行时目录默认值

产物根目录默认是 **`~/.dsh/browser-runtime/`**,与技能目录位置**无关**
(`lib/paths.ts` 一处定义,`serve.ts` / `browserctl.ts` / `clean.ts` / `health.ts` 共用)。
这样技能被复制、移动或更新时,产物与登录态都不会跟着乱跑;
也避免了"产物堆进 `~/.dsh/` 与技能及其它 DSH 数据混居"。
需要换位置时设 `BROWSER_RUNTIME_ROOT`(或各入口的 `--runtime=`)。

## 文件

### 技能目录(代码,可复用、可提交)

| 文件 | 作用 |
| --- | --- |
| `SKILL.md` | 技能入口:触发条件、铁律、常用命令、参数写法、清理清单、环境限制 |
| `serve.ts` | 有头启动器:前台常驻 + 平台自动回滚 + 原子落盘 `state.json` |
| `browserctl.ts` | CDP 控制台(零依赖);`state.json` 缺失时按端口重建 |
| `clean.ts` | 清理运行时产物;默认 dry-run,删 `profile/` 需 `--force` 且浏览器须已停 |
| `health.ts` | 单浏览器体检:渲染 + 截图,输出 JSON |
| `smoke.ts` | 端到端自测:起真浏览器跑 17 项检查(`npm run smoke`) |
| `compare-ozone.ts` | 对照 wayland/x11 两个平台的可用性 |
| `netprobe.ts` | 并发探测 URL 可达性,用于摸白名单 |
| `lib/args.ts` | 参数解析与校验(取值开关声明、`--k v` 支持、拒绝静默 NaN) |
| `lib/paths.ts` | 技能目录与运行时目录解析(两者位置无关) |
| `lib/state.ts` | `state.json` 原子读写与「丢失后按端口重建」 |
| `lib/cdp.ts` | 极简 CDP 客户端 + 协议类型 + HTTP 端点小工具 |
| `lib/health.ts` | 体检判定逻辑(`health.ts` 与 `compare-ozone.ts` 共用一份) |
| `tsconfig.json` / `package.json` | 类型闸门与脚本(`typecheck` / `smoke`) |
| `node_modules/` | 仅 `typescript` + `@types/node` 两个 devDependency,运行技能不需要 |

### 运行时目录(产物,不进技能)

清理统一用 `node clean.ts`(默认 dry-run);`profile/` 是整个目录里唯一不能随便删的东西。

| 路径 | 可删 | 作用 |
| --- | --- | --- |
| `state.json` | ✅ | CDP 端口、当前标签页、实际/请求平台、是否回滚。被删后 `browserctl` 会按端口重建 |
| `profile/` | ❌ | Chromium 用户数据目录 —— **登录态在这里,默认拒绝删除** |
| `home/` | ✅ | 重定向后的 `HOME`(真实 HOME 只读) |
| `shots/` | ✅ | 截图输出 |
| `logs/serve.log`、`logs/chromium-*.log` | ✅ | 启动与浏览器日志 |
| `logs/startup-crash.log` | ✅ | 启动阶段未捕获异常留痕(仅出错时生成) |
| `tmp/` | ✅ | `compare-ozone.ts` 的对照临时 profile |
