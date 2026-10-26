> 本文件是 2025-10 的开发记录，只是过程留档。文中提到的 /tmp 临时脚本已不随仓库分发；等价的可复跑断言现在在 `tools/selfcheck.mjs` 里。

# T7 修复闭环表 ·「工资跳板」Salary Flap

修复人：maker-client（T4/T7 实现者）。任务板 `task-7`。
输入：`docs/review-质量.md`（FAIL 6 项：1 P0 + 2 P1 + 3 P2）、`docs/review-契约.md`（FAIL 2 项，无 P0）。
改动文件：**只有 `client.js`**（本表除外）。`docs/` 其余文件由主控自行修订，未碰。

当前 `client.js` 1742 行。行号均指本轮修复后的文件。

## 闭环表

| 缺陷编号 | 来源报告 | 是否修复 | 改动位置（文件:行号） | 验证方式 |
| --- | --- | --- | --- | --- |
| **P0-1** 夜班下班当刻金额跳回 ¥0.00 + 误判 before | `docs/review-质量.md` §1.4 / 必修清单 P0-1 | **已修** | `client.js:566-579`（calc ⑤ 窗口选择，病灶行在 `:579`：`if (nowMs >= prevStart) shiftStart = prevStart`，已删 `< totalMs` 上界；`:588` 相位仍走未夹紧 `raw`） | 纯函数单测 `[1b]` 六时刻：夜班 22:00+8h 的次日 **06:00:00 / 07:00 / 12:00 / 21:59:59 → ¥454.54 + after（4/4 通过）**；**22:00 新班次 → ¥0.00 + working**；**02:00 → ¥227.27 + working**；白班 09:00 全天零回归（08:59:59 before / 09:00 ¥0.00 working / 12:00 ¥170.45 / 16:59:59 working / 17:00 after ¥454.54） |
| **P1-2** 拖过一次后齿轮 ⚙ 与折叠「–」永久点不动 | `docs/review-质量.md` §5.2 / 必修 P1-2 | **已修** | `client.js:1290-1301`（齿轮）、`client.js:1308-1318`（折叠键）：两处 `onPointerDown` 里 `stopPropagation()` 后补 `drag.reset()`；两处 `onClick` **删掉** `wasDragged()` 早退；`client.js:1699-1712` 新增 `useDrag().reset`（复位 `movedRef`），`:1716` 导出 | 静态：`grep wasDragged` 只剩 `client.js:1374`（折叠条，按主控要求**保留**）+ 定义/注释；`drag.reset` 调用点 1296 / 1314。烟测 4/4 不回归 |
| **P1-3** 三个高度常量与实测不符（168/236/34 vs 132/247/36）→ 首配后跳位、右下距 96px 变 133px | `docs/review-质量.md` §5.5 / 必修 P1-3 | **已修** | `client.js:1433-1466`：`fallbackH`（常量降级为兜底）+ `cardRef` + `useState(measuredH)` + `ResizeObserver` 量 `offsetHeight`，`:1466` `cardH = measuredH > 0 ? measuredH : fallbackH` 喂 `useDrag({size})`（`:1467`）与 `defaultPos`（`:1493`）/`clampPos`（`:1508`）；`:1554` 挂 `ref: cardRef`；RO 在 cleanup 里 `disconnect()`（`:1459`）；常量注释降级为「兜底值」（`:82-85`） | 静态：`grep ResizeObserver` → 1445/1451 创建与 observe、1459 disconnect（成对）；烟测 4/4（无 ResizeObserver 环境走兜底不抛） |
| **P2-4** 折叠条多一行「点一下展开」，违反 §5「只显示金额」 | `docs/review-质量.md` §4.4 / 必修 P2-4 | **已修** | `client.js:1361-1378`：删 `span.sf-collapsed-hint`，提示降级为 `title`（`:1366`）+ `aria-label`（`:1368`，含当前金额）；顺带删掉已无人使用的 `.sf-collapsed-hint` 样式 | 烟测折叠态：节点 **6 → 5**，文本只剩 `¥0.00`（原先含「点一下展开」） |
| **P2-5** 设置态没有拖动把手，首次配置挪不动 | `docs/review-质量.md` §4.6 / 必修 P2-5 | **已修** | `client.js:1199-1214`：标题行改成 `.sf-setup-title.sf-handle` 并挂 `onPointerDown/Move/Up/Cancel`；`:305-306` 加 `.sf-setup .sf-setup-title.sf-handle` 负 margin 贴边 + 圆角；`:1528` 根组件把 `dragHandlers: drag` 传给 `SetupCard`；`SetupCard:1139` 取 `props.dragHandlers` | 静态：`client.js:1204` className 含 `sf-handle`；`:1528` 根组件确实传 `dragHandlers: drag`；拖动/clamp 复用运行态同一套 `useDrag`（`clampPos` `:822`）。烟测设置态 21 元素不回归 |
| **P2-6** ¥9.99→¥10.00 时 `¥` 瞬移一格、整行横移 | `docs/review-质量.md` §3.7 / 必修 P2-6 | **已修** | `client.js:643-661` 新增 `moneySlots()`：`¥` 固定 0 号格、整数位固定 **5** 格右对齐（`INT_SLOT_COUNT`，`:74`）、`.` 固定 6 号格、小数 2 格，共 9 格（`SLOT_COUNT`）；`:1087-1088` 空槽标 `is-blank`；`:230-234` 空槽不画牌面；DigitRow `:1100-1106`、根组件 `:1481-1482` 改用 `moneySlots`；`slotify` 保留作超宽兜底（`:651`） | 单测：模板格 **恒 9 格**；`¥` 恒在 0 号格、`.` 恒在 6 号格；整数位不足 → 4 个空槽；`¥12345.67` 恰好 9 格；`¥9.99→¥10.00` 只翻 `[4,5,7,8]`（进位延迟 90/60/30/0ms） |
| **契约 ❌1** 注册参数第四键 `label: '工资跳板'` | `docs/review-契约.md` §4 | **文档侧解决，代码不动**（主控裁决 `:m00252`：`label` 是 `shell.overlay` 合法键且便于核验） | `client.js:1732` 保持 `{ name, id, order, label }` | 主控改 `docs/立项卡.md:17`：`id`/`order` 必填、`label` 可选（纯展示元信息）→ spec 放宽 |
| **契约 ❌2** `CARD_W = 280` 与文档 260 不符 | `docs/review-契约.md` §4 | **文档侧解决，代码保持 280**（P2-6 要固定列才容得下 `¥12345.67`，280 才够） | `client.js:77` `CARD_W = 280`；`:76` 自述注释同步改成「280px（立项卡 §7 的 260–280，取 280）」 | 主控改 `docs/立项卡.md:64`（260–280，实现取 280）与 `docs/架构.md:72`（CARD_W = 280） |

## 可选打磨（不计入 FAIL）

| 项 | 状态 | 理由 |
| --- | --- | --- |
| 定时器起点对齐整秒（原 `client.js:864` 附近） | **未修** | 立项卡 §4/§5 无此要求；改 tick 起算点会牵动 2 秒不变量与单测时序，收益只是「首跳落点更整齐」。留作后续 |
| 多标签页 `storage` 事件实时同步 | **未修** | 契约与立项卡均未要求；现状后写覆盖、不打架不报错（质量报告 §6.4 已判 ✅） |
| `CARD_W` 280 → 262 | **不采纳** | 主控裁决保持 280（契约 ❌2 走文档侧）；280 才能装下 `¥12345.67` 的 9 格模板 |
| 顺手修 `架构.md` / `立项卡.md` 文档错 | **不做（非我写面）** | 主控已自行修订（架构.md 伪代码上界与两行用例、立项卡 §5 pointer-events 句） |

## 本轮验证摘要（真实输出）

```
1) node --check client.js  OK
2) package.json / locale/*.json 解析 OK  name=@local/dsh-salary-flap version=0.1.0
3) locale 键集合: zh=32 en=32 只在zh=[] 只在en=[] => EQUAL ✅
4) files 数组 7 项, 缺失: [] => ALL EXIST ✅
   files: index.js, client.js, cordis.patch.yml, locale/zh.json, locale/en.json, icon.svg, README.md
5) 纯函数单测（/tmp/sf-calc-test.mjs，从 client.js 的 SF-PURE 标记区整段抽出）  合计: 通过 50 / 失败 0
6) 渲染烟测（/tmp/sf-render-smoke.mjs，React 桩跑 factory + 三态）               通过 4 / 4
   设置态 21 元素 / 运行态 59 元素（含四层翻牌）/ 折叠态 5 元素 / 脏 localStorage 回设置态不抛
7) locale ↔ 内联 MESSAGES 双向对拍（/tmp/sf-locale-diff.mjs）                    PASS（两侧差集均为空集）
```

## 与立项卡的偏离

无口径偏离。计算链仍为：日薪 = 月薪 / 每月工作天数；时薪 = 日薪 / 每日工时；`elapsed = clamp(now - shiftStart, 0, totalMs)`；`earned = dailyWage × elapsed / totalMs`；两位小数**截断**（`trunc2` 带 1e-9 修正）。P0 只改「窗口选择」条件，未动相位判定（`raw < 0 → before`、`raw >= totalMs → after`、其余含 `raw === 0` → working）。
