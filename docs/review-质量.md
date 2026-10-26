> 本文件是 2025-10 的开发记录，只是过程留档。文中提到的 /tmp 临时脚本已不随仓库分发；等价的可复跑断言现在在 `tools/selfcheck.mjs` 里。

# 质量审查 ·「工资跳板」Salary Flap（T6）

- 被审对象：`client.js`（1636 行，单文件；纯函数区在文件前部，React 组件在后）
- 判定基准：`docs/立项卡.md`（唯一事实源，§4 计算 / §5 交互 / §6 翻牌 / §7 视觉 / §9 验收）＞ `docs/架构.md`
- 审查人：reviewer-quality（只读；写面仅本文件）
- 审查日期：2026-10-26

## 0. 方法：所有结论都可复算，不采信实现者自报

| 手段 | 脚本 | 覆盖 |
|---|---|---|
| 抽取纯函数区 + 逐字节一致性校验 | `/tmp/sf-audit.mjs` | §4 全部计算用例、边界、非法输入 |
| 节拍/单调性模拟 | `/tmp/sf-audit2.mjs` | 2 秒格点、跨分钟、跨零点、夜班整天 |
| CSS 机械断言 + 组件真渲染 + 归一层 | `/tmp/sf-audit3.mjs` | §6 动画、§7 颜色、拖动夹紧、读盘污染 |
| 截断 vs 四舍五入、位数增长翻动 | `/tmp/sf-audit4.mjs` | §4 截断口径、§6 进位 |
| 真实几何量测（无头 Chrome 加载 client.js 原样 CSS） | `/tmp/sf-measure.html` | 卡片真实高度、牌宽、行宽 |

**抽取一致性（不是复制粘贴的等价物，而是逐字节子串）**

```
纯函数区行段: 34-806 | 逐字节子串 = true
组件区(SplitFlap+DigitRow) bytes = 3068 | sha256[:16] = e7e838ca505bf87b
```

即：`src.includes(body) === true`，脚本里跑的 `calc / trunc2 / fmtMoney / slotify / changedSlots / delayOf / clampPos / revive* / parseHHMM` 与 `client.js:34-806` 完全同一份源码；翻牌四层是**直接调用源码里的 `SplitFlap` / `DigitRow`** 渲染成元素树后断言的，不是看图说话。

运行环境：`node v26.10.0`，`TZ=Asia/Shanghai`。

---

## 1. 计算正确性（最重）— 6 项 ✅ / 1 项 ❌

### 1.1 日薪 / 时薪口径 ✅

证据：`client.js:540-541`

```js
const dailyWage = monthly / days                      // 日薪（收工后的封顶值）
const hourly = dailyWage / hours                      // 时薪（小字用）
```

真实输出（月薪 10000 / 8h / 22d / 09:00）：

```
dailyWage = 454.54545454545456     hourly = 56.81818181818182
```

判定依据：§4「日薪 = 月薪 / 每月工作天数；时薪 = 日薪 / 每日工作小时数」逐字一致，且每 2 秒进账 = 时薪/1800 = 时薪/3600×2 ✓（金额按"已过计薪秒数/总秒数"整体比例算，与逐格累加等价、且无累计误差，见 `client.js:542,567-573`）。

### 1.2 白班四点半：0.00 / 170.45 / 454.54 / 454.54 ✅

```
09:00:00 → ¥0.00   working  progress=0.000%
12:00:00 → ¥170.45 working  progress=37.500%
16:59:59 → ¥454.52 working  progress=99.997%
17:00:00 → ¥454.54 after    progress=100.000%
18:00:00 → ¥454.54 after    progress=100.000%
次日 08:00 → ¥0.00 before
```

判定依据：§4 三态取值 1/2/3 全部命中；`17:00:00` 封顶（是 `≥` 而非 `>`，见 `client.js:570` `raw >= totalMs`）；`18:00:00` 不再增长。12:00 的 37.5% 正是半天（4h/8h），170.45 = 454.5454×0.5 截断 ✓。

### 1.3 跨午夜班次：凌晨 02:00 → 227.27 ✅

```
夜班 22:00 起、8h：
22:00:00 → ¥0.00   working
23:59:59 → ¥113.62 working
次日 00:00:00 → ¥113.63 working   ← 跨零点连续，没有归零
次日 02:00:00 → ¥227.27 working   ← 立项卡 §4 用例
次日 05:59:58 → ¥454.51 working
次日 22:00:00 → ¥0.00   working   ← 新班次起点
```

判定依据：`client.js:545` 用「起点 + 总时长是否越过 24 点」判跨午夜，`559-562` 回退到昨天同一时刻作为班次起点，`567` 用未夹紧的 `raw` 算进度 —— 跨零点不丢进度、不重置 ✓。

### 1.4 ❌ P0 夜班下班当刻 06:00:00 金额从 ¥454.51 掉回 ¥0.00（立即修）

真实输出（夜班 22:00 起 8h，下班时刻 = 次日 06:00）：

```
05:59:50 → ¥454.38 working progress=99.965%
05:59:52 → ¥454.41 working progress=99.972%
05:59:54 → ¥454.45 working progress=99.979%
05:59:56 → ¥454.48 working progress=99.986%
05:59:58 → ¥454.51 working progress=99.993%
06:00:00 → ¥0.00   before  progress=0.000%   ← ❌ 金额跳回 + 状态文案错成「还没上班」
06:00:02 → ¥0.00   before  progress=0.000%
...
21:59:59 → ¥0.00   before                      ← 一直错到晚上 22:00
```

证据：`client.js:559-561`

```js
if (crossMidnight && nowMs < todayStart) {
  const prevStart = new Date(y, mo, da - 1, hh, mm, 0, 0).getTime()
  if (nowMs - prevStart >= 0 && nowMs - prevStart < totalMs) shiftStart = prevStart  // ← 病灶
}
```

`nowMs - prevStart < totalMs` 这个守卫本意是"只在还没结束时才认昨天那个窗口"，但它同时吃掉了 `raw === totalMs` 这一格：06:00:00 时 `raw = 8h`，守卫为假 → `shiftStart` 退回今天 22:00 → `raw = 06:00 - 22:00 < 0` → `phase = 'before'`、`elapsed` 夹到 0 → **¥0.00**。

判定依据（三条都指向 ❌）：

1. §4 第 3 条「现在 ≥ 下班时间 → 日薪（封顶）」——夜班的下班时间 = 次日 06:00，此刻应封顶 ¥454.54；实测 ¥0.00。
2. `docs/架构.md:340` 明确验收「跨午夜收工：夜班、次日 07:00 → ¥454.54、phase after」——实现给的是 ¥0.00 / before。
3. 后果不是一帧：夜班用户从 06:00 到 22:00 共 16 小时看到 ¥0.00 +「还没上班」。这是"算错"，不是观感问题。

实现者自报"照架构伪代码的严格 `<` 来的、未改"——伪代码那行是**窗口选择**条件，不是**相位判定**条件，两者被混成了一个判断，这就是缺陷本身。

**修法（已验证，改 1 处）**：把 `client.js:561` 的窗口上界去掉，只保留"起点不晚于现在"：

```js
// client.js:559-562 改为：
if (crossMidnight && nowMs < todayStart) {
  const prevStart = new Date(y, mo, da - 1, hh, mm, 0, 0).getTime()
  if (nowMs >= prevStart) shiftStart = prevStart      // 不再要求 raw < totalMs
}
```

补丁验证（把改后的 `calc` 源码替换进抽取区，命中且仅 1 处）：

```
夜班 05:59:58   现值 ¥454.51 /working → 打补丁后 ¥454.51 /working   （不变）
夜班 06:00:00   现值 ¥0.00   /before  → 打补丁后 ¥454.54 /after     ✅
夜班 07:00:00   现值 ¥0.00   /before  → 打补丁后 ¥454.54 /after     ✅
夜班 12:00:00   现值 ¥0.00   /before  → 打补丁后 ¥454.54 /after     ✅
夜班 21:59:59   现值 ¥0.00   /before  → 打补丁后 ¥454.54 /after     ✅
夜班 22:00:00   现值 ¥0.00   /working → 打补丁后 ¥0.00   /working   （新班次，不变）
夜班 02:00:00   现值 ¥227.27 /working → 打补丁后 ¥227.27 /working   （不变）
白班 17:00 / 12:00 / 08:59:59 / 次日 08:00 → 全部不变              ✅ 无回归
```

补丁后夜班整天扫描：掉值 0 次（除既有测试脚本用字符串比金额造成的假阳性）。

### 1.5 非法输入一律 ¥0.00 且不 NaN、不抛 ✅

13 组输入全部命中同一个空快照：月薪 0 / 工时 0 / 天数 0 / 时间串 `"abc"` / `"25:99"` / `null` / 月薪 `"abc"` / settings `null`/`undefined`/`"x"` / `Infinity` / 工时 30 / 天数 40，外加 `now = NaN`：

```
月薪0 → ¥0.00 before | 工时0 → ¥0.00 before | 天数0 → ¥0.00 before
时间"abc" → ¥0.00 before | 时间"25:99" → ¥0.00 before | 时间 null → ¥0.00 before
月薪"abc" → ¥0.00 before | settings null/undefined/"x"/∞ → ¥0.00 before
工时30 → ¥0.00 before | 天数40 → ¥0.00 before | now=NaN → ¥0.00 before
（无 NaN、无 throw）
```

证据：`client.js:531-534` 入口卫兵 + `538-539` 时间串非法退空 + `574-576` catch 兜底；`parseHHMM`（`606-616`）严格正则 + 范围双校验，实测 `"24:00"/"09:60"/"09:00:00"/"abc"/"9:5"/"09.00"` 全部 `null`，`"9:00"/" 09:00 "` 正常 540。

判定依据：§4「显示值必须截断，不出现 NaN」；且设置态还拦了一层（`SetupCard` 非法即 `disabled`，`client.js:1190`），属双保险。

### 1.6 两位小数是**截断**不是四舍五入 ✅

```
单位用例 1.999 → 截断 1.99 / 四舍五入 2.00 → fmtMoney = ¥1.99   ← 立项卡点名的用例
单位用例 1.15  → 截断 1.15              → fmtMoney = ¥1.15   ← 不被 1e-9 修正带偏
月薪 100 / 7 天 → 日薪 raw=14.285714… 截断 14.28 / 四舍五入 14.29 → ¥14.28
月薪 10000/22 天 → 日薪 454.5454… 截断 454.54 / 四舍五入 454.55 → ¥454.54
截断全表：2.675→2.67 | 1.995→1.99 | 1.994→1.99 | 0.005→0 | 0.009→0 | 0.01→0.01 | -0.004→0 | -1.15→-1.15
```

整日实证（白班 09:00→17:00，逐 2 秒采样 14401 点）：

```
采样 14401 点：显示值≠截断值 0 次；截断与四舍五入给出不同金额 7200 次
  t=09:00:08 显示¥0.12 若四舍五入会¥0.13
  t=09:00:20 显示¥0.31 若四舍五入会¥0.32
```

证据：`client.js:585-589` `trunc2`（`Math.floor(Math.abs(n)*100 + 1e-9)/100`，`-0` 归一）+ `595-599` `fmtMoney` 先 `trunc2` 再 `toFixed(2)`。`+1e-9` 是必要的：`1.15*100` 在 IEEE754 下是 `114.99999999999999`，不加就得 1.14。

判定依据：§4「必须**截断**（不是四舍五入）到两位小数，避免 0.005 被显示成 0.01」——半个工作日里 7200 个格点会因四舍五入差 1 分，实测一个都没差 ✓。

### 1.7 金额形态恒为 `¥` + 两位小数，无 `¥-0.00`/三位小数 ✅

`fmtMoney(-0) = ¥0.00`、`fmtMoney(NaN) = ¥0.00`、`fmtMoney(-1.005) = ¥-1.00`（`calc` 不可能产出负数：`540,568` 全为正路径）。§9.3 的三种坏形态都构造不出来。

---

## 2. 2 秒节奏 — 3 项 ✅

### 2.1 显示值只在 2000ms 格点跳，不是每帧滚 ✅

证据：`client.js:1366` `const now = useTick(hasSettings, period)`；`1367` `view = useMemo(() => calc(activeSettings, now), [activeSettings, now])`；定时器只有一个：`864` `timer = setInterval(() => setNow(Date.now()), period)`。全文无 `requestAnimationFrame`、无 `earned +=` 累加（`846` 注释也把"绝对时间重算"写成了硬约束）。

节拍模拟（挂载 09:00:00.317，tick = 挂载 + 2000k）：

```
+    0ms  → ¥0.00     + 6000ms  → ¥0.09
+ 2000ms  → ¥0.03     + 8000ms  → ¥0.13
+ 4000ms  → ¥0.06     +10000ms  → ¥0.16
10 秒内 tick 次数 = 5；显示值变化次数 = 5      ← §9.4「10 秒约跳 5 次」
```

判定依据：§4「显示值只在 2 秒格点上跳一次」+ §9.4。两次 tick 之间组件不重渲染，金额零抖动 ✓。

### 2.2 只有「上班中」才 2 秒跳；收工后降频、上班前不停表 ✅

证据：`client.js:1364-1366`

```js
const probe = calc(activeSettings, Date.now())
const period = probe.phase === 'after' ? IDLE_MS : SETTLE_MS   // 60000 : 2000
const now = useTick(hasSettings, period)
```

收工后 60s 一跳（金额已封顶，跳也还是同值）；上班前保持 2s 是为了"到点自动开始跳"（`1362-1363` 注释），设计正确 ✓。未配置（设置态）时 `useTick(false)` 不装表 ✓。

### 2.3 定时器起点未对齐整秒（✅ 行为合规，附注 P2 可选优化）

`864` 的 `setInterval` 从**挂载时刻**起算，不对齐墙钟整秒：挂载在 09:00:00.317 则每次 tick 落在 `.317`。因为每次 tick 都用 `Date.now()` 取绝对时间重算，所以**显示的金额始终对应真实时刻**（比对齐整秒更准），代价只是格点不复现、与"整 2 秒"最多差一个 tick 的进账（本例 ¥0.03）。

判定依据：§4 只要求"每 2 秒结算一次"，§9.4 用"10 秒约 5 次"验收，两条都满足 → 不算缺陷。可选打磨：首跳对齐 `setTimeout(start, period - Date.now() % period)`。

### 2.4 同一个工作日内金额单调不减 ✅ / ❌（夜班见 1.4）

数值口径扫描（用 `trunc2` 后的**数字**比大小，不用字符串——上一版用字符串把 `¥9.97 → ¥10.00` 误报成掉值）：

```
白班 09:00→17:00（纯上班窗口）: 掉值 0 次
白班 09:00→次日 09:00（含跨零点）: 掉值 1 次 → 454.54 → 0.00 @ Oct 27 00:00:00 phase=before
夜班 22:00→次日 22:00: 掉值 1 次 → 454.51 → 0.00 @ Oct 27 06:00:00 phase=before
```

白班那 1 次是**日切换**：§4 口径是"今日已赚"，零点后新的一天还没上班 → ¥0.00 +「还没上班」，符合定义，不算缺陷（跨分钟、跨小时、跨整点全部 0 次掉值 ✓）。夜班那 1 次是 1.4 的 P0，修完即消失（验证见 1.4 补丁表）。

---

## 3. 翻牌动画 — 6 项 ✅ / 1 项 ❌

### 3.1 真的两段式，不是淡入淡出 ✅

机械断言（样式文本直接取自 `client.js` 的 `CSS` 常量，全部命中）：

```
OK   @keyframes sf-fold 0 → -90deg
OK   @keyframes sf-unfold 90 → 0deg
OK   .sf-flip--top 铰链 bottom center
OK   .sf-flip--bottom 铰链 top center
OK   .sf-flip--bottom 起始 rotateX(90deg)
OK   下半页延迟 = 前半程（延迟一个 HALF_MS）
OK   牌容器 perspective
OK   backface-visibility: hidden
OK   -webkit-backface-visibility
```

证据：`client.js:263-276`（上翻 `transform-origin: bottom center` + `animation: sf-fold var(--sf-half) … var(--sf-delay)`；下翻 `transform-origin: top center` + 起始 `rotateX(90deg)` + `animation: sf-unfold … calc(var(--sf-delay) + var(--sf-half))`）、`277-284`（`sf-fold` 0°→-90° 并压暗到 `brightness(.62)`，`sf-unfold` 90°→0° 亮度复原）。

判定依据：§6「上半页沿底边向下翻到 -90°，紧接着新数字的下半页从 +90° 翻回 0°」——方向、铰链、相位延迟逐条对上；有 `rotateX` 有 `perspective` 有 `brightness`，不是 opacity 动画。

### 3.2 四层角色正确，翻完不会跳回旧值 ✅

把源码里的 `SplitFlap` 真调起来（`h()` 换成一个返回元素树的最小替身），上层参数 `¥12.33 → ¥12.34`：

```
slat aria-hidden = true | 层数 = 4
   ① sf-half sf-half--top     | glyph = "4"   ← 静止上 = 新值
   ② sf-half sf-half--bottom  | glyph = "3"   ← 静止下 = 旧值（翻动期露出）
   ③ sf-flip sf-flip--top     | glyph = "3" | delay = "--sf-delay:0ms"   ← 翻动上 = 旧值
   ④ sf-flip sf-flip--bottom  | glyph = "4" | delay = "--sf-delay:0ms"   ← 翻动下 = 新值
   角色判定 = OK
静止位层数 = 2（期望 2，无翻动层）   reduced 下 flipping=true 传入时层数 = 2（期望 2）
```

证据：`client.js:1015`（①=ch）、`1016-1020`（②=`flipping ? prevCh : ch`）、`1025-1035`（③=prevCh）、`1036-1046`（④=ch）；`1024` 注释说明翻动层 key 带 (旧值,新值) 才能重播。翻完由父层定时器把 `prevText` 推平成新值（`1390`），翻动层卸载、露出静默态，不会"翻完又跳回旧值" ✓。

### 3.3 只翻变化的位，进位从右往左 ✅

```
¥12.33 → ¥12.34: 翻动位=[8(0ms)]                                  ← 只有个位翻
¥454.51 → ¥454.54: 翻动位=[8(0ms)]                                ← 只有个位翻
¥454.54 → ¥454.54: 翻动位=[]                                      ← 值没变，一位都不翻
¥20.00 → ¥19.99: 翻动位=[4(90ms) 5(60ms) 7(30ms) 8(0ms)]          ← 进位/退位从右往左
¥454.54 → ¥454.57: 翻动位=[8(0ms)]
```

证据：`client.js:646-654` `changedSlots`（`prev[i]!==next[i] && isDigit(next[i])`，所以 `¥`、`.`、补位空格永不翻）、`661-668` `delayOf`（右边还有几个数字位 × `STAGGER_MS`=30ms，上限 4 步 = 120ms）、`1067-1077` 逐格组装。判定依据：§6「只有变化的位才翻（十进制进位时从右往左逐位翻）」✓。

### 3.4 时长 / 缓动 / 定宽 ✅

```
时长: HALF_MS = 110ms × 2 = 220ms（要求 180–260ms）→ true
cubic-bezier(.3, 0, .2, 1)            → OK（上翻、下翻、上浮动效三处同一条曲线）
tabular-nums                          → OK（.sf-row 与 .sf-glyph 都设了，另有 font-feature-settings:"tnum"）
牌宽 --sf-w = .62em，牌高 --sf-h = 1.14em   → 定宽，位数变化不改牌宽
实测 牌宽 SLAT_W=21.08 SLAT_H=38.75；9 格行宽 ROW9_W=250.00（= 卡片内容宽，不溢出）
```

证据：`client.js:43-51`（`SETTLE_MS`/`FLAP_MS`/`HALF_MS`/`RISE_MS`/`STAGGER_MS`）、`180-194`、`207-219`。判定依据：§6 时长 180–260ms ✓、曲线 ✓、tabular-nums ✓。

### 3.5 reduced-motion 降级真的生效（双保险）✅

```
OK   @media (prefers-reduced-motion: reduce)
OK   reduced-motion 里 .sf-flip display:none
¥12.33 → ¥12.34 [reduced]: 格数=9 翻动位=[]        ← JS 侧也拦掉了
```

证据：CSS `366-371`（`.sf-flip{display:none!important}` + `.sf-slat{perspective:none}` + `.sf-row{transition:none}`）+ JS `1011-1012`（`props.reduced !== true` 才算 flipping）+ `1064`（`reduced` 时 `changed = []`）+ `1065`（`rise` 在 reduced 下不加 class）。判定依据：§6「必须尊重 prefers-reduced-motion：直接跳值不翻牌」✓，且是 CSS+JS 双保险（宿主 CSS 被覆盖也拦得住）。

### 3.6 牌面裁切正确，翻到一半不透出反面数字 ✅

证据：`client.js:220-231`（`.sf-half/.sf-flip` `position:absolute; height:50%; overflow:hidden` + `backface-visibility:hidden` + `translateZ(0)` 修 Safari）、`242-260`（`.sf-glyph` `height:200%` + 上半 `top:0` / 下半 `bottom:0`，上下半各裁一半、拼起来是完整字形）、`262`（`.sf-flip{z-index:2}` 盖在静止层上）。

判定依据：`overflow:hidden` 保证半页只显示自己那一半；翻过 90° 后 `backface-visibility:hidden` 令其消失；此时下方静止层是**不透明**的 `color-mix(...bg-layer-2 78%, black)`，不会透出后面内容 ✓。

### 3.7 ❌ P2 位数增长时「整行平移」+「¥」瞬移一格，与 §6「只有变化的位才翻」的观感不符

```
¥9.99   → ¥10.00:   翻动位=4 [4(¥→1,90ms) 5(9→0,60ms) 7(9→0,30ms) 8(9→0,0ms)]
                    ¥ 所在格：4 → 3   ← ¥ 会平移一格（不参与翻动，瞬移）
¥99.99  → ¥100.00:  翻动位=5 [3,4,5,7,8]，¥ 所在格：3 → 2
¥999.99 → ¥1000.00: 翻动位=6 [2,3,4,5,7,8]，¥ 所在格：2 → 1
```

证据：`client.js:628-638` `slotify` 用**前导** `\u00a0` 补到 `SLOT_COUNT=9`（`69`），于是整串在 9 格里右端对齐、位数一多就往左长一格；`¥` 不是数字（`641-643` `isDigit`），不进 `changedSlots` → 它不翻牌，直接"瞬移"到左边一格，同时 4–6 位一起翻。

判定依据：`slotify` 注释（`629`）自称"定宽是「¥9.99 → ¥10.00 时整行不抖」的唯一保证"，但实测整行仍抖了一格；§6 的意图是"没变的位保持静止"，而 `¥` 的位置变化既没动画也没预留。影响面：每个工作日在跨 ¥10 / ¥100 / ¥1000 时各出现一次（本例约 10:45 一次），持续 220ms。

**修法**：把金额渲染改成固定模板而不是整体右对齐——`¥` 固定在 0 号格、整数部分用 4 个固定格（1–4）右对齐、`.` 固定 5 号格、小数 2 格（6–7），共 8 格（`SLOT_COUNT` 改 8 或留 1 格余量）。具体做法：新增 `moneySlots(text)` 取代 `slotify(text)` 用于 `DigitRow`，内部先 `splitDigits`，按"小数点 + 两位小数"从右往左写入固定列，整数位不足补 `\u00a0`；`changedSlots` 不动。这样 `¥`/`.` 恒在同一格，永不瞬移，跨位数时也只有真正变化的位翻。

---

## 4. 三态交互 — 4 项 ✅ / 2 项 ❌

### 4.1 首次出现就是设置态，不用先点齿轮 ✅

证据：`client.js:1428-1434` `if (!hasSettings || editing) body = h(SetupCard, …)`，而 `hasSettings = settings !== null`（`1359`）、`LS_SETTINGS` 未写过就是 `null`（`919-941` 读盘回落 `initial=null`，且 `value===null` 时不写盘，`936`）→ 首次打开必然是 4 个输入框 + 打开始按钮，没有齿轮前置。字段齐全（月薪/工时/天数/上班时间，默认 `09:00`，`1098-1103`、`1162`），另有现算的时薪/日薪预览（`1165-1177`）。判定依据：§5「首次出现 = 设置态…不要做成必须点齿轮才能进的设置页」✓。

### 4.2 改参数即时生效，取消不留痕 ✅

证据：`1418-1425` `onSubmit = (next) => { setSettings(next); setEditing(false) }`；`1419` 一改 `activeSettings` 立刻进 `1367` 的 `useMemo` → 本帧重算（不等 2 秒）。`可关`：编辑态渲染「保存 / 取消」（`1182-1194`），`onCancel`（`1425`）只是 `setEditing(false)`，`SetupCard` 随之卸载、局部草稿丢弃，再次打开时用新的 `initial`（`1430`）重新挂载 ✓。判定依据：§5「改完即时生效」+ 审查清单「面板能不能关」✓。

### 4.3 非法输入不放行 ✅

证据：`1106` `check = validateSettings({…})`、`1190` `disabled: !check.ok`、`1178` 行内 `⚠` 提示（仅 `touched` 后出现）、`1108-1116` 提交前再判一次并 try/catch。判定依据：§4 不能把非法配置放进运行态 ✓。

### 4.4 ❌ P2 折叠态不是「只显示金额」，多了一行「点一下展开」

证据：`client.js:1316-1317`

```js
h('span', { className: 'sf-collapsed-money' }, fmtMoney(view.earned)),
h('span', { className: 'sf-collapsed-hint' }, t('collapsed.hint')),   // ← 「点一下展开」
```

实测 `HINT_visible = true`（`/tmp/sf-measure.html`：`.sf-collapsed-hint` 有实际宽度），`358-363` 给了它 `margin-left:auto`，视觉上贴着右边缘。

判定依据：§5「右上角一个「—」收起成一条小横条（**只显示金额**）」。提示文案本身是善意（可发现性），但违反了明文形态；且 `collapsed.hint` 是 `MESSAGES`/locale 里唯一一个 SOT 没要求的可见文案。

**修法**（保留可发现性但不越界）：删掉 `1317` 那个 `span`，把提示降级为不可见的无障碍/悬浮提示 —— 已有 `title: t('button.expand')`（`1306`）足够鼠标用户发现；再补 `aria-label: t('button.expand')` 到 `1304-1306` 的元素上供读屏。若一定要可见，改为"首次折叠后显示 3 秒再淡出"，并同步在立项卡登记该文案。

### 4.5 折叠 ↔ 展开、齿轮 ↔ 保存路径闭环 ✅（但受 5.2 的 P1 阻断）

`onCollapse`/`onExpand`（`1416-1417`）都是 `setCollapsed(bool)`，`usePersisted`（`919-941`）落盘 ✓；`isCollapsedView = hasSettings && collapsed === true && !editing`（`1370`）保证"编辑态不显示折叠条"。折叠条点击展开前判 `wasDragged()`（`1311-1314`），拖完不误触 ✓。

### 4.6 ❌ P2 设置态没有拖动把手，首次配置时板子挪不动

证据：`SetupCard` 整棵子树（`1095-1197`）没有 `.sf-handle`，也没挂 `drag.onPointerDown`；`RunningCard:1216-1225` 与 `CollapsedBar:1307-1310` 才挂。`CARD_TOP_H=34` 的把手样式（`128-141`）只属于运行态。

判定依据：§5「可拖动：按住板子顶部拖动位置」。设置态板子高 246px（实测），首次打开就压在右下角（距下 96px），若正盖住用户要点的界面元素，必须先把参数填完才能挪 —— 与"首次出现就能用"的意图相悖。

**修法**：把 `SetupCard` 的标题行（`1157` 的 `.sf-setup-title`）包进 `<div className="sf-handle">` 并把 `dragHandlers` 传进去（`SetupCard` 已能从 props 收；根组件 `1429-1434` 补 `dragHandlers: drag`），或在 `174` 的 `.sf-body` 上加 `onPointerDown={drag.onPointerDown}` 等四个事件。前者只需 +2 行且复用既有样式。

---

## 5. 遮挡与拖动 — 3 项 ✅ / 2 项 ❌

### 5.1 外层 none / 内层 auto，且没有写反 ✅

```
OK   .sf-layer 整层 pointer-events: none
OK   .sf-card 本体 pointer-events: auto
```

证据：`client.js:103-108`（`.sf-layer{position:fixed;inset:0;pointer-events:none;z-index:30}`）+ `112`（`.sf-card{pointer-events:auto}`）+ 内联兜底 `1462` `pointerEvents:'auto'`。根节点上没挂任何 `onClick`/`onContextMenu`（全文 `onContextMenu` 0 命中），透明区域不吃点击 ✓。判定依据：§5「板子外层 none、内层 auto」+ §3「click-through，条目自己 opt-in」——这是"写反就废掉整个界面"的 P0 项，实测写对了。

（立项卡 §5 同一句里"容器自己 `pointer-events: auto`"与外层 none 自相矛盾，实现选了后者；后者与 §3、与"透明区域不能吃掉点击"的硬要求一致，判定以可测的那条为准。建议顺手把立项卡这句改掉，别让后来的实现者踩。）

### 5.2 ❌ P1 拖过一次之后，齿轮 ⚙ 与折叠 – **永久点不动**（误触防护过度）

证据链：

- `client.js:1237` / `1253` 两个按钮的 `onPointerDown` 都 `e.stopPropagation()`（本意：齿轮不启动拖动）→ 事件永远到不了把手；
- `client.js:1526` `movedRef.current = false` **只在把手的 `onPointerDown` 里**发生；
- `client.js:1602` `wasDragged = () => movedRef.current === true`；
- `client.js:1239-1241` / `1255-1257` 两个 `onClick` 都以 `if (drag.wasDragged && drag.wasDragged()) return` 开头；
- `client.js:1555-1572` `finish()` 里**没有**把 `movedRef` 复位。

于是：拖动一次 → `movedRef=true` → 之后每次点齿轮/折叠键，`pointerdown` 被 stopPropagation、`movedRef` 保持 `true`、`onClick` 直接 return → 按钮永远无效，直到用户碰巧点一下把手里的标题区（那里会走 `onPointerDown` 把标志清零）。

判定依据：用户视角 = "拖完板子，齿轮和折叠按钮就坏了"。属体验硬伤（不崩、不算错）→ P1。

**修法**（两步都要，一步治标一步治本）：

1. 两个按钮的 `onPointerDown` 里顺手复位：`onPointerDown: (e) => { e.stopPropagation(); if (drag.reset) drag.reset() }`，并在 `useDrag` 返回值里加 `reset: () => { movedRef.current = false }`（`1604-1612`）。
2. 更干净的做法：**删掉**两个按钮 `onClick` 里的 `wasDragged()` 判断（`1240`、`1256`）。按钮自己的 `pointerdown` 已经 stopPropagation，拖动根本不可能从按钮开始；而"从把手按下、抬在按钮上"也不会产生指向按钮的 click（click 只发给按下与抬起的共同祖先）。这个判断在按钮上是纯负担。

`CollapsedBar`（`1311-1314`）那处**要保留**：横条本身就是拖动面，`movedRef` 会在它自己的 `pointerdown`（`1526`）里复位，逻辑正确 ✓。

### 5.3 拖动 clamp 到视口内，拖出去也能拖回来 ✅

```
默认视口(1280×800) 右下角   → x=976 y=536
拖到右下角外面 x=99999      → x=988 y=620     ← 夹回 maxX/maxY
拖到左上角外面 x=-9999      → x=12  y=12      ← 夹到 EDGE
NaN 污点 (-, undefined)     → x=988 y=620     ← 不产生 NaN 坐标
小视口 400×300 右下越界     → x=108 y=120
视口比卡片还小 200×150      → x=12  y=12      ← max(EDGE, …) 兜住，仍可抓
```

证据：`client.js:786-804`（`maxX = Math.max(EDGE, vw - cw - EDGE)`、拿不到视口退 1280×800）、`1413`（渲染前再 `clampPos` 一次，窗口 resize 后自动拉回）、`1547`（拖动中每次 move 都夹）。判定依据：审查清单「拖动是否 clamp 到视口内，拖到屏幕外还能拖回来」——因为一直在视口内夹紧，所以**根本拖不出去**，等价满足 ✓。

`setPointerCapture`（`1529-1531`）+ 抬手才落盘（`1563-1569`）+ `pointercancel` 也落盘（`1597`）都正确，不留 window 级监听 ✓。

### 5.4 拖动不误触发点击 ✅（折叠条）；点按 < 3px 当点击 ✅

`DRAG_THRESHOLD=3`（`56`）、`1544-1545`（位移超 3px 才算拖动，否则不更新 draft）。

### 5.5 ❌ P1 `H_SETUP/H_RUNNING/H_COLLAPSED` 三个常量与真实卡片高度不符 → 首次配置完成后板子跳位、默认右下距变成 133px

无头 Chrome 加载 `client.js` 原样 CSS 实测（`/tmp/sf-measure.html`）：

```
RUNNING_H=131.09375            ← 常量 H_RUNNING = 168（差 -36.9）
RUNNING_H_with_state=148.9375
SETUP_H=246.53125              ← 常量 H_SETUP   = 236（差 +10.5）
COLLAPSED_H=36                 ← 常量 H_COLLAPSED = 34（差 +2，卡片 1px 边框×2）
```

证据：`client.js:77-79` 三个常量 → `1371` `cardH` → `1398-1410` `defaultPos`（`y = vh - cardH - 96`）与 `1413` `clampPos`；而 `.sf-card` 没有显式高度（`109-127`），高度由内容撑开。

后果（视口 800 高）：点「开始跳」瞬间 `cardH` 236→168，`defaultPos.y` 从 468 变 536 —— 卡片**顶边下跳 68px**、底边同时上收 47px（246.5 → 131）；静止后的右下角间隙是 `vh-133` 而不是 §7 要求的 `vh-96`（偏高 37px）。同理，折叠态按 34 夹紧而真实 36，拖到最底会贴边 2px。

判定依据：§7「右下角默认位置（距右 24px、距下 96px）」+ 审查清单「拖动 clamp 是否正确」——常量当尺子用，尺子不准，默认位与夹紧就都不准。属体验硬伤（明显跳一下），P1。

**修法**：别用常量当尺子，改实测。给卡片加 ref，用一次 `ResizeObserver` 把 `offsetHeight` 存进 state，喂给 `useDrag({size})` 与 `defaultPos`：

```js
const cardRef = useRef(null)
const [cardH, setCardH] = useState(H_RUNNING)
useEffect(() => {
  const el = cardRef.current
  if (!el || typeof ResizeObserver !== 'function') return undefined
  const ro = new ResizeObserver(() => setCardH(el.offsetHeight || H_RUNNING))
  ro.observe(el); return () => ro.disconnect()
}, [])
// 卡片上补 ref: cardRef；H_* 三常量降级为 ResizeObserver 不可用时的兜底
```

---

## 6. 鲁棒性 — 4 项 ✅

### 6.1 localStorage 被污染不炸、自动回落设置态 ✅

```
invalid JSON 文本                          → null（JSON.parse 在 catch 里回落 initial）
"abc"（合法 JSON 字符串）                  → null → 设置态
[]（数组）                                 → null
{monthly:"abc",hours:null,days:[],start:"zz"} → {monthly:12000,hours:8,days:22,start:"09:00"}
{monthly:0,hours:-1,days:99,start:"25:00"} → {monthly:12000,hours:8,days:22,start:"09:00"}
{monthly:"8,000",hours:"8",days:"22"}      → {monthly:8000,…}      ← 千分位也认
revivePos({x:"a",y:1}) → null      revivePos({x:1e7,y:1e7}) → 原值（渲染时再 clampPos 夹回）
reviveBool("true") → false  |  reviveBool(true) → true
```

证据：`client.js:919-941`（读盘 try/catch + 归一层）、`816-833`（`readRaw/writeRaw` 各自 try/catch）、`728-746`（`validateSettings`）、`753-766`（对象即返回、全坏字段退默认）、`769-780`。判定依据：审查清单「localStorage 读取被污染（存了非法 JSON）」✓，且"坏值退默认"不会卡死在半坏状态。

### 6.2 刷新后配置与位置都在 ✅

`LS_SETTINGS`/`LS_POS`/`LS_COLLAPSED`（`59-62`）+ `usePersisted`（`919-941`）读一次、变更即写（`935-938`），位置只在抬手写一次（`1563-1569`）。`value===null` 不写盘（`936`）保住"首次判定"。判定依据：§9.5 ✓。

### 6.3 页面隐藏再切回立刻重算 ✅

证据：`client.js:866-883` —— 隐藏时 `stop()` 清表；`visibilitychange` 回前台先 `setNow(Date.now())`（补一帧，不干等 2 秒）再 `start()`。加上每次 tick 都用绝对时间重算（`864`），后台挂两小时回来也不会算错 ✓。

### 6.4 多标签页不会互相写坏 ✅（无实时同步，属可选）

两个标签各自持有一份内存状态、只在自身状态变化时写盘（`935-938`），同键冲突是"后写覆盖"，不会写坏 JSON，也不会因为 tick 而反复写盘（tick 不改持久化 state）。缺的是 `storage` 事件监听：A 标签拖了位置，B 标签刷新前看不到。
判定依据：审查清单只问"会不会互相打架"——不会，✅。可选打磨（P2）：`usePersisted` 里加 `window.addEventListener('storage', …)` 同步。

---

## 7. 视觉 — 3 项 ✅

### 7.1 颜色全走 `--dsw-alias-*`，没有写死主题色 ✅

```
写死颜色 (hex/rgb/hsl) 命中数 = 0
使用的 --dsw-alias-* token: 7
  var(--dsw-alias-label-primary)  var(--dsw-alias-bg-overlay)      var(--dsw-alias-border-l1)
  var(--dsw-alias-brand-primary)  var(--dsw-alias-bg-layer-2)      var(--dsw-alias-label-secondary)
  var(--dsw-alias-state-success-primary)
```

证据：`client.js:102-372` 全量 CSS 扫描 0 命中；正文（非 CSS）扫描同样 0 命中。`black` 只作为 `color-mix()` 的加深色出现在 `121`（卡片外阴影）、`230`（翻牌底）、`235`（半页内描边），落在 §7 明确允许的"翻牌卡片明暗过渡可用 `color-mix()` 在 token 基础上加深"范围内，没有用在文字/边框/背景的实色上 ✓。7 个 token 与 §7 点名清单一一对应 ✓。

### 7.2 深色翻牌机质感、圆角、默认位置 ✅（宽度 +20px，在「左右」容差内）

`113` 圆角 16px ✓、`116` 半透明 `bg-overlay` 84% + `122-123` `backdrop-filter: blur(12px)` 内阴影质感 ✓、`75` 右下 `{right:24, bottom:96}` ✓、`72` `CARD_W=280` 对 §7「宽度 260px 左右」（+7.7%，"左右"可接受，若求严可改 262）。判定依据：§7 ✓（唯一要留意的是 5.5 里 `cardH` 偏差把"距下 96px"变成了 133px —— 那条已单列 P1）。

### 7.3 亮暗主题都可读（推理成立，未做像素级对比）✅

全部前景/边框/背景都取自 token（7.1），宿主换主题时 token 值随之变化，无硬编码色 → 结构上不可能"深色主题白字白底"。`336` 次要按钮 `opacity:.45` 的 disabled 态在亮色主题下对比度偏低，但属常规做法。**诚实声明**：我用无头 Chrome 量的是几何（高度/宽度/行宽），主题 token 值是本地近似注入的，真实 Harness 亮色主题下的观感未做像素级验证。

补充实测（顺带验证 tabular 与不溢出）：

```
ROW9_W=250.00（= 卡片内容宽 250 = 280 − 2 边框 − 28 内边距）→ 9 格恰好铺满，不溢出
SLAT_W=21.08  SLAT_H=38.75    LINE_overflow=false（「时薪 ¥56.82 · 今日进度 42%」不省略）
```

---

## 8. 与文档的冲突（不是代码缺陷，需架构师改文档）

| 文档 | 说法 | 实测 | 处置 |
|---|---|---|---|
| `docs/架构.md:338` | 白班「次日 08:00 仍 ¥454.54」 | ¥0.00 / before | 按 §4「今日已赚」，零点即归零、次日上班前应 0.00 → **文档错**，请 architect 改 |
| `docs/架构.md:342` | 非法时间串 `'25:99'`/`''`/`null` → 走 09:00 兜底 | 全部 ¥0.00 / before | §4 没规定；实现选了"退 0 不猜"，且 T4 验收里已写明要 0.00 → **文档错**，请 architect 改 |
| `docs/架构.md:340` | 夜班次日 07:00 → ¥454.54 / after | ¥0.00 / before | **代码错**（见 1.4 的 P0），文档是对的，照文档修代码 |
| `docs/立项卡.md` §5 | 同一句里既说"容器自己 pointer-events: auto"又说"外层 none" | 实现取外层 none | 文档自相矛盾，建议删掉前半句（见 5.1） |
| `docs/架构.md:376` | 「根容器上**不要**挂 onClick/onContextMenu」 | 未挂 ✓ | 一致 |

---

## 结论

**FAIL(6 项)** —— 1 项 P0 + 2 项 P1 + 3 项 P2。

算得对这条主线是扎实的：§4 点名的全部计算用例（日薪/时薪 454.5454…/56.8181…、0.00/170.45/454.54、夜班 02:00=227.27、非法输入全 0、截断不是四舍五入）逐条真跑通过，整日 14401 个格点零误差、零 NaN、零 `¥-0.00`；2 秒节奏、绝对时间重算、visibilitychange 补帧、读盘容错、拖动夹紧、四层翻牌角色、reduced-motion 双保险、token 颜色（0 处写死）全部到位。

但有一条**边界算错**（FAIL 成立的理由）：夜班下班当刻 `06:00:00` 金额从 ¥454.51 掉回 ¥0.00 并显示「还没上班」，且此后 16 小时都是错值 —— 违反 §4 第 3 条「现在 ≥ 下班时间 → 封顶」与 `架构.md:340`。这是可观察、可复现、可一行修好的算错，不能放行。

另外两处 P1 都不是"能不能跑"的问题，而是"用户会不会觉得坏了"：拖完板子齿轮/折叠键永久失效（误触防护没有复位点）；三个高度常量当尺子，首次配置完成瞬间整块板子跳 68px、右下距从 96px 变 133px。

## 必修清单

### P0 算错（必须修，修完才算 PASS）

1. **夜班下班当刻金额跳回 0.00、状态误判 before** — `client.js:561` 的窗口守卫 `nowMs - prevStart < totalMs` 吃掉了 `raw === totalMs`。改法：`if (nowMs >= prevStart) shiftStart = prevStart`（删掉上界）。已验证：夜班 06:00/07:00/12:00/21:59:59 → ¥454.54/after，22:00 新班次仍 ¥0.00/working，白班全天与 02:00=227.27 无回归。

### P1 体验硬伤

2. **拖动一次后齿轮 ⚙ 与折叠 – 永久点不动** — `client.js:1237,1253` 的 `stopPropagation` 让 `movedRef`（`1526` 只在此复位）再也清不掉，`1239/1255` 的 `wasDragged()` 于是恒真。改法：删掉两个按钮 `onClick` 里的 `wasDragged()` 判断（`1240`、`1256`），或在其 `onPointerDown` 里调 `movedRef` 复位。`CollapsedBar:1311-1314` 的那处**保留**。
3. **三个高度常量与真实卡高不符（168/236/34 vs 132/247/36）→ 首次配置后板子跳位、右下距 96px 变 133px** — `client.js:77-79` → `1371` → `1398-1410`。改法：用 `ref` + `ResizeObserver` 实测 `offsetHeight` 喂给 `useDrag({size})` 与 `defaultPos`，常量降级为兜底。

### P2 打磨

4. **折叠条多了一行「点一下展开」，§5 要求只显示金额** — `client.js:1317`。改法：删掉该 `span`，把提示降为 `title`（`1306` 已有）+ `aria-label`。
5. **设置态没有拖动把手，首次配置时挪不动板子** — `SetupCard`（`1095-1197`）无 `.sf-handle`。改法：把 `.sf-setup-title`（`1157`）包进 `.sf-handle` 并把 `dragHandlers` 传进去（根组件 `1429-1434` 补一个 prop）。
6. **位数增长时 ¥ 瞬移一格、4–6 位同时翻** — `client.js:632-638` 前导补位导致整串右端对齐。改法：改用固定模板格（`¥` 固定 0 号格、整数 4 格右对齐、`.` 固定、小数 2 格），跨 ¥10/¥100 时不再整行平移。

### 可选打磨（不计入 FAIL）

- 定时器起点对齐整秒（`864`）：首跳用 `setTimeout(start, period - Date.now() % period)`，让格点落在整 2 秒上。
- 多标签页实时同步：`usePersisted` 加 `storage` 事件监听（当前后写覆盖，不打架也不冲突）。
- `CARD_W` 280 → 262 可更贴近 §7 的「260px 左右」。
- 顺手修文档：`架构.md:338/342` 两条与 §4 冲突，`立项卡.md` §5 的 pointer-events 自相矛盾句。
