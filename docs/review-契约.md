> 本文件是 2025-10 的开发记录，只是过程留档。文中提到的 /tmp 临时脚本已不随仓库分发；等价的可复跑断言现在在 `tools/selfcheck.mjs` 里。

# 契约审查报告 · 工资跳板（T5）

- 审查员：reviewer-contract（task-5）
- 审查对象：`/Users/joyfon620/Documents/deepseek-harness/default-workspace/dsh-salary-flap`（全部实现文件已落盘）
- 判定依据：`docs/立项卡.md`（唯一事实源，§3 交付形态 / §5 交互 / §6 翻牌动画 / §7 视觉 / §9 六条可机械验收）、`docs/架构.md`（架构依据；架构.md:3 自述「与立项卡冲突时以立项卡为准」）
- 审查方式：**纯静态 + 只读**。未安装插件、未跑 pnpm、未碰 profile、未跑 git、未改任何实现文件。
- 本报告是本次审查唯一写面。

---

## 0. 审查方法与环境证据

宿主侧契约不是靠猜的，以下三条来自本机 DSH 0.2.1-rc.3 的安装体（`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`，只读解包到 `/tmp`）：

| 事实 | 证据位置 |
|---|---|
| `dsh.client` 的合法字段与类型：`platform`(string)、`inject`/`external`(string[])、`immediately`(boolean) | `dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js:67`（`optionalStringArray(pkgName, "dsh.client.inject", decl.inject)`）及同文件 `parseDshClient` |
| 客户端入口必须由 `exports["./client"]` 指向 | 同文件 `clientExportOf` 分支 |
| `shell.overlay` 是**已声明槽位**：`kind: "list"`、`scope: "root"`，合法注册键为 `id`(required) / `order`(optional) / `label`(optional) | `dsh-client-ui-layout/lib/client.js:644-646`（`declaredBy: "root"`）+ `dsh-cordis-client-runner/lib/client.js` 的 `CLIENT_SLOT_API` 中 `key: "shell.overlay"` 条目 |
| 官方给 `shell.overlay` 的注册范例（含 `label`、含裸 `ctx.slots.inject`） | 同上 `example` 字段：`ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'my-entry', order: 100, label: 'My entry' }, () => React.createElement('div', null, 'hello')))` |
| `slots.register` / `slots.inject` 的回收由**调用方 fiber** 自动接管，不需要手写 `ctx.effect` | 同文件 `register` 方法文档：「This layer adds: disposal through the caller's ctx.effect (fiber unload = cascade)」；`inject` 文档：「The controller belongs to the caller's fiber, so plugin unload cancels a pending wait and removes any active contribution」 |
| `require('react')` 在 `inject: []` 下仍可用（react 是平台 seed 模块，不依赖 dsh.client.inject） | `dsh-web-frontend/dist/assets/index-BXV-oxvX.js` 的 seed 表 `function OZ(){ return { react: aC, "react-dom": gC, …, "@deepseek-ai/dsh-client-ui-slots": jI, … } }` |

> 这条结论修正了两个常见误判：① `apply` 不包 `ctx.effect` **不是**资源泄漏（宿主按 caller fiber 级联回收，官方范例同形）；② `label` 在 `shell.overlay` 上是**合法注册键**。下面第 2 项的判定完全基于立项卡 §3 的字面约束，而不是宿主不接受。

本次跑过的校验命令与真实输出：

```
$ node --check client.js
（无输出，exit 0）

$ node -e 'const p=require("./package.json");console.log(p.name,p.version);JSON.parse(fs.readFileSync("locale/zh.json"));JSON.parse(fs.readFileSync("locale/en.json"));console.log("locale JSON OK")'
@local/dsh-salary-flap 0.1.0
locale JSON OK

$ node -e '<files 数组逐个 fs.existsSync>'
缺失文件: []         （7/7 命中）

$ node -e '<两份 locale 扁平化键集合 双向差集>'
zh∩en 双向差集: zh-en= []   en-zh= []      （各 32 键）

$ node -e '<抽取 client.js 内联 MESSAGES 后与 locale 逐键、逐值比对>'
[zh] MESSAGES=32 locale=32 缺失=[] 多余=[] 值不一致=[]
[en] MESSAGES=32 locale=32 缺失=[] 多余=[] 值不一致=[]

$ xmllint --noout icon.svg
xmllint: OK        （icon.svg 1277 bytes）

$ grep -nE 'setTimeout|setInterval|clearTimeout|clearInterval|addEventListener|removeEventListener|requestAnimationFrame|ResizeObserver|MutationObserver' client.js
（全量 16 行，见下表）

$ grep -nE '#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(' client.js      → 0 命中（无写死颜色）
$ grep -n 'document\.body|iframe|appendChild' client.js            → 0 命中（工厂无 DOM 副作用）
$ grep -n "require('" client.js                                    → 仅 28 行 require('react')
```

---

## 1. 包骨架与安装面（P0 区）

| # | 检查项 | 判定 | 证据 |
|---|---|---|---|
| 1.1 | `files` 数组与真实落盘一一对应 | ✅ | `package.json:14-22` 七项 `index.js / client.js / cordis.patch.yml / locale/zh.json / locale/en.json / icon.svg / README.md`，`fs.existsSync` 全命中；反向扫描「落盘有但 files 没列」仅 `package.json`（npm 自动收录，正常） |
| 1.2 | `name` / `version` / `private` / `type` 合 §3 | ✅ | `package.json:2-5` = `@local/dsh-salary-flap` / `0.1.0` / `true` / `module`，与立项卡 §3:19 逐字一致 |
| 1.3 | `exports` 覆盖 `./client` 入口 | ✅ | `package.json:9` `"./client": "./client.js"`；宿主 `clientExportOf` 要求的就是这个键 |
| 1.4 | `exports` 覆盖 locale 与 icon | ✅ | `package.json:10-11`；另含 `"."`→`index.js` 与 `"./package.json"` |
| 1.5 | `dsh.bundle.patch` 指向存在的 patch | ✅ | `package.json:24-26` → `./cordis.patch.yml`，文件在 `files` 内 |
| 1.6 | `dsh.client` 字段类型合法 | ✅ | `package.json:27-32`：`platform:"web"`、`inject:[]`、`external:[]`、`immediately:true`，四者类型均合规（`inject:[]` 语义见 § 4 偏离 3） |
| 1.7 | `cordis.patch.yml` 形状与参考插件同构 | ✅ | 全文 `- insert:` / `- id: salary-flap` / `- name: '@local/dsh-salary-flap'`；与已安装可用的 `dsh-sort-out-the-thoughts` patch 同形（`id` 与包名不同是 loader 常态，参考插件亦如此） |
| 1.8 | `index.js`（Host 半边）只导出 `apply` | ✅ | `index.js` = `export function apply() {}` + 注释；纯前端无 Host 服务，符合立项卡 §3:18 |
| 1.9 | `engines.dsh` 与在役版本相容 | ✅ | `package.json:43-45` `>=0.2.0-rc.1 <0.3.0-0`；在役 DSH = `0.2.1-rc.3`，落在区间内 |
| 1.10 | 无第三方依赖 | ✅ | 无 `dependencies`/`devDependencies` 段 |

**P0 结论：无。** 装不上的三类硬伤（缺文件、缺 `./client` 导出、`dsh.client` 类型错）逐条验证均不成立。

---

## 2. ModuleLoader 与注册区

| # | 检查项 | 判定 | 证据 |
|---|---|---|---|
| 2.1 | `window.__ModuleLoader__.load({ id })` 的 id = 包名 | ✅ | `client.js:23-25` `id: '@local/dsh-salary-flap'` 与 `package.json:2` 逐字相等 |
| 2.2 | `factory: (require) => …` 形状正确 | ✅ | `client.js:25`；`module.exports` 在 `client.js:1631` 返回 |
| 2.3 | factory 内 `require` 只有 `'react'` | ✅ | 全文 `require('` 仅 `client.js:28` 一处；无 `react-dom`、无任何 `@deepseek-ai/*` Client 包（合立项卡 §8:71-72） |
| 2.4 | `apply` / `inject` 是对外契约名 | ✅ | `client.js:1632-1633` `exports.apply = apply` / `exports.inject = ['slots']` |
| 2.5 | `inject` 是静态字符串数组 | ✅ | 同上，字面量数组 `['slots']`（宿主扫描期即读取，不能是变量/函数） |
| 2.6 | 槽位名 = `shell.overlay` | ✅ | `client.js:1624` `ctx.slots.inject('shell.overlay', …)`（register 调用 `client.js:1625`）；该槽位在宿主 `CLIENT_SLOT_API` 中已声明（`kind: "list"`, `scope: "root"`） |
| 2.7 | 注册 id = `salary-flap` | ✅ | `client.js:1626` `id: 'salary-flap'`，与立项卡 §3:17 逐字一致 |
| 2.8 | `order` 为数字且不撞 peak-scheduler | ✅ | `client.js:1626` `order: 12`；架构.md:245 指定 12（peak-scheduler 用 50） |
| 2.9 | 注册参数键集合 vs 立项卡 §3「只填这三个」 | ❌ | `client.js:1626` 实为 `{ name, id, order, label }` 四项 —— 详见 § 4 ❌1 |
| 2.10 | 第二个参数是 `(slotProps) => ReactElement` 而非组件本身 | ✅ | `client.js:1627` `() => h(SalaryFlap, { runtime: ctx })`；与宿主官方 example 的 `() => React.createElement(...)` 完全同形（架构.md:245 的这条提醒已兑现） |
| 2.11 | `apply` 无 `throw` 风险 | ✅ | `client.js:1623` 先 `if (!ctx || !ctx.slots || typeof ctx.slots.register !== 'function') return` 静默降级 |
| 2.12 | 注册回收（是否需要 `ctx.effect`） | ✅ | 宿主文档：`register` 走 caller `ctx.effect`、`inject` 归 caller fiber，卸载即级联回收；裸写与官方 example 一致，**不构成泄漏** |

---

## 3. 资源成对性（逐条贴行号）

`client.js` 全量定时器/监听/捕获，与回收点一一对应，无孤儿：

| 申请 | 回收 | 载体 | 判定 |
|---|---|---|---|
| `setInterval(…, period)` — `client.js:864` | `clearInterval(timer)` — `client.js:858`（`stop()`），由 `useEffect` cleanup `client.js:894` 调用 | `useTick`，deps `[active, period]`（`client.js:903`） | ✅ 成对且 deps 正确（`SETTLE_MS`→`IDLE_MS` 切换会重装表） |
| `document.addEventListener('visibilitychange', onVisibility)` — `client.js:887` | `document.removeEventListener('visibilitychange', onVisibility)` — `client.js:897` | 同一 `useEffect` cleanup | ✅ 成对，同一函数引用 |
| `mql.addEventListener('change', onChange)` — `client.js:967` | `mql.removeEventListener('change', onChange)` — `client.js:979` | `useReducedMotion`，deps `[]`（`client.js:987`） | ✅ 成对 |
| `mql.addListener(onChange)`（老 Safari 分支）— `client.js:969` | `mql.removeListener(onChange)` — `client.js:981` | 同上 | ✅ 两分支互斥且各自回收 |
| `setTimeout(setRise(false), RISE_MS+20)` — `client.js:1389` | `clearTimeout(tRise)` — `client.js:1392` | `useEffect` cleanup | ✅ 成对 |
| `setTimeout(setPrevMoney(...), FLAP_MS+…)` — `client.js:1390` | `clearTimeout(tFlap)` — `client.js:1393` | 同一 cleanup | ✅ 成对 |
| `setPointerCapture` — `client.js:1530` | `releasePointerCapture` — `client.js:1577`（正常抬起）、`client.js:1590`（cancel 分支） | 拖动 hook | ✅ 两条出口均释放 |

补充：**全文没有 `window.addEventListener`**（`grep` 0 命中），拖动走 pointer capture 而非 window 级监听，从根上避免了「抬手忘了摘 window 监听」这类泄漏。可见性暂停逻辑 `client.js:866-880`：隐藏时 `stop()`、回前台先补一帧再 `start()`，与立项卡 §5/文档注释一致。

---

## 4. 偏离项与说明项

### ❌1（必须改，一行）注册参数多出第四键 `label`

- 位置：`client.js:1626`
- 事实源：立项卡 §3:17 —— 「注册参数：`{ name: 'shell.overlay', id: 'salary-flap', order: <数字> }`，**只填这三个**」
- 现状：`{ name: 'shell.overlay', id: 'salary-flap', order: 12, label: '工资跳板' }`
- 定性：宿主侧**合法**（`CLIENT_SLOT_API` 里 `shell.overlay` 的 `registerOptions` 明确含 `label`，官方 example 也带 label），所以不是运行时缺陷；但立项卡是唯一事实源且 §3 是「硬约束」，字面上多了一键。
- 修法（二选一，默认前者）：
  1. 删掉该键：`client.js:1626` 改为 `{ name: 'shell.overlay', id: 'salary-flap', order: 12 }`，同时把 `client.js:1617` 注释「参数就是 name / id / order / label 四项」改为「name / id / order 三项」。
  2. 若团队决定保留（利于 `cordis_inspect_query` 里辨认），则须同步改立项卡 §3:17 的措辞，并在架构.md:234 已写 label 的前提下补一句「label 为可选展示键」，否则下次审查还会判同一处。
- 影响面：不影响安装、不影响 §9.2 的 `registrant` 识别（registrant 是宿主自动盖章，与 label 无关）。

### ❌2（必须改，一行）`CARD_W` 与架构常量表不一致，且注释自述为 260

- 位置：`client.js:72` `const CARD_W = 280`
- 事实源：`docs/架构.md:72` `const CARD_W = 260 // 面板宽（立项卡 §7）`；立项卡 §7:64 「宽度 260px 左右」
- 现状：值 280，而其上一行注释 `client.js:71` 写的是「宽 260px 左右（立项卡 §7）」—— 注释与取值自相矛盾。
- 修法：`client.js:72` 改成 `const CARD_W = 260`。若刻意要 280，则必须改 `docs/架构.md:72` 与立项卡 §7 的数值，三处保持同源，不能只留注释。
- 影响面：纯几何，`clampPos` 与默认右下角换算都读这个常量，改回 260 不影响任何逻辑。

### ⚠1（非缺陷，建议对齐）`dsh.client.inject` 为 `[]`，与架构.md:17 的写法不同

- 位置：`package.json:29`
- `docs/架构.md:17` 写的是 `inject: ["@deepseek-ai/dsh-client-ui-renderer"]`；两个参考插件也都填了实际包名（`dsh-Reading` → `["@deepseek-ai/dsh-client-ui-slots"]`，`dsh-sort-out-the-thoughts` → `["@deepseek-ai/dsh-client-ui-renderer"]`）。
- 为什么不算失败：`inject` 只是模块装载顺序提示（`optionalStringArray`，可空）；本插件 factory 只 `require('react')`（平台 seed 模块），而 `apply` 需要的 `slots` 服务由 cordis 的 `exports.inject = ['slots']` 兜底等待，服务不在就延迟 apply，不会静默退役。
- 建议：若要和两份文档/参考实现对齐，改 `package.json:29` 为 `"inject": ["@deepseek-ai/dsh-client-ui-slots"]`。**不阻塞。**

### ⚠2（规范内在矛盾，非实现问题）「文案全部走 Client locale 服务」未照字面实现

- 立项卡 §7:66 要求「文案全部走 Client locale 服务」；`docs/架构.md:50` 又明令「不写 sessions/workspaces/locale —— 宿主没有该服务时整块不 apply」。
- 实现选择：两份 `locale/*.json` 齐备（供宿主的插件列表 / meta 用），组件内再用 `MESSAGES` 内联镜像同一批键值（`client.js:380-487`，注释已说明 ModuleLoader 只允许 `require('react')`，无法 `require` JSON）。
- 实测两条链路**完全一致**：`[zh] MESSAGES=32 locale=32 缺失=[] 多余=[] 值不一致=[]`，`[en]` 同。这是当前宿主约束下能做到的最优解，**不计入失败**；若要彻底满足 §7 字面，需要宿主开放 locale 读取能力，属上游议题。

---

## 5. locale 双语表（逐键核对）

| 检查项 | 判定 | 证据 |
|---|---|---|
| 两份 locale 键集合完全相等 | ✅ | 各 32 键，`zh-en=[]`、`en-zh=[]` |
| `meta.title` 存在 | ✅ | `locale/zh.json:3` 「工资跳板」；`locale/en.json:3` 「Salary Flap」 |
| `meta.description` 存在 | ✅ | `locale/zh.json:4`；`locale/en.json:4`（均为完整句，非占位） |
| 内联 `MESSAGES` 每个键在 locale 有对应 | ✅ | `MESSAGES` 顶层为 `{ zh, en }`，各自 32 键，与对应 locale 双向差集为空、且**值逐字相等** |
| 键面覆盖三态与全部按钮 | ✅ | `status.before/working/after`、`button.settings/collapse/expand/start/save/cancel/apply`、`setup.monthlyLabel/hoursLabel/daysLabel/startLabel`、`error.invalidNumber/invalidTime`、`unit.yuan/hour/day/percent`、`app.title/subtitle/earnedLabel/hourlyLabel/progressLabel/dailyLabel/dragHint`、`line.summary`、`collapsed.hint` |
| 无硬编码中文串进 JSX（抽查） | ✅ | 组件文案均走 `t(...)`；仅 `label: '工资跳板'`（见 ❌1）与注释为字面量 |

实现者声称的「32 键双向差集为空」**复验成立**，未采信口供。

---

## 6. 功能兑现追踪（立项卡 §5 / §6 / §7 → 实现行号）

| 条目 | 判定 | 落点 |
|---|---|---|
| §5 首次出现=设置态（三输入框 + 上班时间默认 09:00 + 开始跳） | ✅ | `SetupCard`（`client.js:1095-1203`）；`hasSettings===null` 时直接渲染设置态 |
| §5 运行态：大号翻牌 + 「时薪 · 今日进度」小字 + 右上极小齿轮 | ✅ | `RunningCard`（`client.js:1205-1297`；齿轮 `client.js:1234-1241`、折叠 `client.js:1250-1257`） |
| §5 齿轮/右键可改参数、即时生效 | ✅ | 齿轮按钮 `client.js:1234-1241`；改完回调直写 settings |
| §5 可拖动、位置存 localStorage | ✅ | `useDrag`（`client.js:1491-1615`）、`clampPos`（`client.js:786-804`）、`LS_POS` 落盘 |
| §5 可折叠成一条小横条（只显示金额） | ✅ | `CollapsedBar`（`client.js:1298-1325`） |
| §5 外层 `pointer-events:none`、内层卡片 `auto` | ✅ | CSS `client.js:106` / `client.js:112`，内联 `client.js:1462` |
| §6 上下两半分片翻牌（上半 0→-90°，下半 +90°→0°） | ✅ | `SplitFlap`（`client.js:1007-1058`）+ `@keyframes sf-fold/sf-unfold`（`client.js:277-292`） |
| §6 180–260ms 且 `cubic-bezier(0.3,0,0.2,1)` | ✅ | `FLAP_MS=220` = `HALF_MS=110`×2（`client.js:45-47`）；曲线出现在 `client.js:191/267/274` |
| §6 `perspective` + `backface-visibility:hidden` | ✅ | `client.js:217`（`perspective:240px` 打在 `.sf-slat` 容器上）、`client.js:227-228` |
| §6 只有变化位翻，进位从右往左逐位 | ✅ | `changedSlots` + `delayOf`（`STAGGER_MS=30`, `MAX_STAGGER_STEPS=4`，`client.js:50-52`） |
| §6 翻动层 key 带 `(from,to)`（8→9→8 可重播） | ✅ | `client.js:1029` `key: 'fold-' + prevCh + '-' + ch`、`client.js:1040` `key: 'unfold-' + prevCh + '-' + ch` |
| §6 每次结算 1–2px 上浮、不抖 | ✅ | `.sf-row.is-rise{transform:translateY(-2px)}`（`client.js:194`），`RISE_MS=160` |
| §6 `prefers-reduced-motion` JS+CSS 双层降级 | ✅ | CSS `client.js:366-371`（翻动层 `display:none`）；JS `client.js:1012`（`SplitFlap` 的 `reduced !== true` 门）、`client.js:1063-1065`（`DigitRow` 的 changed 与 is-rise 门）、`useReducedMotion`（`client.js:946-990`） |
| §6 等宽数字 `tabular-nums` | ✅ | `client.js:188-189/201/253/310/354` |
| §7 只用主题 token | ✅ | `TOKEN`（`client.js:82-90`）八个 token 名；`grep` 写死颜色 0 命中；`color-mix()` 仅在 token 基础上加深（如 `client.js:116-121`；`black` 只作为混合加深端出现在 `client.js:121/230/235`，代码注释 `client.js:100` 已说明这一取舍，合 §7:65 |
| §7 圆角 16px、宽 260、默认右下 (24, 96) | ⚠ | 圆角 `client.js:113` ✅；`DEFAULT_INSET={right:24,bottom:96}`（`client.js:75`）✅；宽度 280 → 见 ❌2 |
| §7 文案双语 + meta | ✅ | 见 § 5 |
| §8 不往 `document.body` 追加、不写全局 CSS | ✅ | 无 `appendChild`/`document.body`；`<style>` 在组件内渲染（`client.js:1453`，外层 layer `client.js:1450-1452`，卡片 `client.js:1454-1464`），选择器全部 `.sf-*` 前缀（`grep` 无 `body`/`*`/`:root` 裸选择器） |
| §4 截断（非四舍五入）两位、`¥12.34`、不出 `¥-0.00`/`NaN` | ✅ | `trunc2`（`client.js:585-589`，含 `1e-9` 修正与 `-0` 归一）、`fmtMoney`（`client.js:595-599`） |
| §4 三态由未夹紧 `raw` 判、金额走 clamp | ✅ | `client.js:567-570`（`raw = 567`、`elapsed` 夹紧仅用于金额 `568`、`phase` 用未夹紧 `raw` 判 `570`：`raw < 0`→before、`raw >= totalMs`→after） |
| §4 只有「正在上班」每 2 秒跳；收工降频 | ✅ | `SETTLE_MS=2000` / `IDLE_MS=60000`（`client.js:43-54`），按 `phase` 选周期 |

---

## 7. 未核项（原因）

| 项 | 状态 | 原因 |
|---|---|---|
| §9.1 `plugin_manager install_bundle` 装进 `desktop` profile 且 `application: applied` | **未核** | 任务纪律禁止安装插件 / 跑插件管理器；静态面已逐项对齐（`files`/`exports`/`dsh.client`/patch 形状），是否 `applied` 只能实机验 |
| §9.2 `cordis_inspect_query`（client / Slots / `listSubTree`, root=`shell.overlay`）看到 `registrant` 为包名的 `salary-flap` 条目且 `active:true` | **未核** | 同上，需装后实机查；注册面（槽位名、id、order、静态 inject）已静态确认合法 |
| §9.4 「连续观察 10 秒金额跳 5 次左右」 | **未核** | 需运行；机制侧已确认：`useTick` 周期 2000ms、deps 含 `period`（`client.js:852-903`），绝对时间重算（`client.js:846`），无累加误差 |
| §9.5 「拖动/折叠/改参数后刷新仍在」 | **未核** | 需运行；代码侧读写均在 `try/catch` 内（`client.js:815-831`）且键名分三份（`LS_SETTINGS`/`LS_POS`/…） |

以上四项计入结论的「未核」计数，不计为失败；建议 T7 修复后由装了插件的一方补跑 §9.1/§9.2 两条实机验收。

---

## 结论

**FAIL(2 项)** —— 2 项均为一行可改的字面偏离，**无 P0**（`files` 7/7 命中、`exports["./client"]` 齐备、`dsh.client` 类型合法、`__ModuleLoader__.load` id 与包名一致、`shell.overlay` 已声明、factory 只 `require('react')`）；locale 32 键双向差集为空且内联 `MESSAGES` 与 locale 值逐字一致；定时器/监听/指针捕获 7 组全部成对。

- ❌1 `client.js:1626` 注册参数多出第四键 `label`（立项卡 §3:17「只填这三个」）→ 删掉 `label: '工资跳板', `，并把 `client.js:1617` 注释的「四项」改成「三项」。
- ❌2 `client.js:72` `CARD_W = 280` 与 `docs/架构.md:72` 的 260、立项卡 §7:64「260px 左右」不一致（且 `client.js:71` 注释自述 260）→ 改为 `const CARD_W = 260`。
- ⚠（不计入）`package.json:29` `inject: []` 与 `docs/架构.md:17` 的写法不同，功能安全，建议对齐；立项卡 §7:66「走 Client locale 服务」与 `架构.md:50` 内在矛盾，现实现（locale 文件 + 内联镜像、两侧同值）为约束下最优解。
- 未核 4 项：§9.1 / §9.2 / §9.4 / §9.5（需装后实机跑，本审查纪律禁止安装）。
