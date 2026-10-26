// 工资跳板自检：一条命令跑完计算口径、locale 一致性、牌面几何与弹窗一致性。
//
//   node tools/selfcheck.mjs
//
// 设计原则：全部断言都从**源码文本**里取，不维护第二份实现。
// 计算部分是拿 client.js 里 SF-PURE 标记之间的真代码跑（new Function 求值），
// 所以这里测的就是插件实际会跑的那段函数。

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(join(ROOT, f), 'utf8')

const CLIENT = read('client.js')
const WINDOW_HTML = read('window.html')
const PKG = JSON.parse(read('package.json'))

let pass = 0
const fails = []
const ok = (name, cond, detail) => {
  if (cond) pass += 1
  else fails.push(detail ? `${name}（${detail}）` : name)
}
const eq = (name, actual, expected) =>
  ok(name, Object.is(actual, expected), `实际 ${String(actual)}，期望 ${String(expected)}`)

/* ---------- 1. 从源码抽出纯函数区 ---------- */

const BEGIN = '// SF-PURE-BEGIN'
const END = '// SF-PURE-END'
const b = CLIENT.indexOf(BEGIN)
const e = CLIENT.indexOf(END)
if (b < 0 || e < 0) {
  console.error('找不到 SF-PURE 标记，抽不出纯函数区')
  process.exit(1)
}
let region = CLIENT.slice(b, e)

// CSS 模板字符串里有 ${HALF_MS} 这类插值，在 new Function 里求值会撞上暂时性死区。
// 自检不需要那份 CSS 的求值结果（样式断言直接对文本做），所以先把它替换成空串。
const cssStart = region.indexOf('const CSS = `')
if (cssStart >= 0) {
  const cssEnd = region.indexOf('`\n', cssStart + 'const CSS = `'.length)
  region = region.slice(0, cssStart) + 'const CSS = ""\n' + region.slice(cssEnd + 2)
}

const exportNames = [
  'SETTLE_MS', 'FLAP_MS', 'HALF_MS', 'SLOT_COUNT', 'INT_SLOT_COUNT', 'CARD_W',
  'DEFAULT_SETTINGS', 'DEFAULT_THEME', 'THEMES',
  'MESSAGES', 'calc', 'trunc2', 'fmtMoney', 'parseHHMM', 'moneySlots', 'changedSlots',
  'delayOf', 'makeT', 'validateSettings', 'reviveSettings', 'clampPos',
  'themeOf', 'themeVars',
]
const PURE = new Function(`${region}\nreturn { ${exportNames.join(', ')} }`)()

/* ---------- 2. 计算口径 ---------- */

const S = { monthly: 17600, hours: 8, days: 22, start: '09:00', end: '17:00' } // 日薪 800 / 时薪 100
const at = (h, m = 0, s = 0, day = 26) => new Date(2026, 9, day, h, m, s, 0)

const c1 = PURE.calc(S, at(8, 59, 59))
eq('上班前 1 秒金额归零', PURE.fmtMoney(c1.earned), '¥0.00')
eq('上班前 1 秒相位 before', c1.phase, 'before')

const c2 = PURE.calc(S, at(9, 0, 0))
eq('整点开工还是 ¥0.00', PURE.fmtMoney(c2.earned), '¥0.00')
eq('整点开工相位 working', c2.phase, 'working')

const c3 = PURE.calc(S, at(12, 0, 0))
eq('三小时后 ¥300.00', PURE.fmtMoney(c3.earned), '¥300.00')

const c4 = PURE.calc(S, at(17, 0, 0))
eq('下班当刻封顶 ¥800.00', PURE.fmtMoney(c4.earned), '¥800.00')
eq('下班当刻相位 after', c4.phase, 'after')

const c5 = PURE.calc(S, at(23, 30, 0))
eq('收工后不再增长', PURE.fmtMoney(c5.earned), '¥800.00')

const N = { monthly: 17600, hours: 8, days: 22, start: '22:00', end: '06:00' } // 跨午夜
const n1 = PURE.calc(N, at(2, 0, 0))
eq('夜班 02:00 已赚一半 ¥400.00', PURE.fmtMoney(n1.earned), '¥400.00')
eq('夜班 02:00 相位 working', n1.phase, 'working')

const n2 = PURE.calc(N, at(6, 0, 0))
eq('夜班下班当刻 ¥800.00', PURE.fmtMoney(n2.earned), '¥800.00')
eq('夜班下班当刻相位 after', n2.phase, 'after')

const n3 = PURE.calc(N, at(12, 0, 0))
eq('夜班收工后整天不掉回 0', PURE.fmtMoney(n3.earned), '¥800.00')

const bad = [
  { monthly: 0 }, { monthly: -1 }, { hours: 0 }, { hours: 25 }, { days: 0 },
  { days: 32 }, { start: '25:99' }, { start: '' }, { start: null }, { start: 'abc' },
]
for (const patch of bad) {
  const r = PURE.calc({ ...S, ...patch }, at(12))
  ok(`非法输入 ${JSON.stringify(patch)} 一律 ¥0.00`, PURE.fmtMoney(r.earned) === '¥0.00')
}

const p1 = PURE.validateSettings({ ...S, start: '9:00' })
ok('9:00 这种单位数小时也认', p1.ok === true, JSON.stringify(p1))
const p2 = PURE.validateSettings({ ...S, start: '25:00' })
ok('25:00 判非法', p2.ok === false && p2.reason === 'error.invalidTime', JSON.stringify(p2))

/* 截断不四舍五入：全天逐 2 秒扫一遍，显示值必须等于截断值 */
{
  const total = 8 * 3600
  let drift = 0
  for (let t = 0; t <= total; t += 2) {
    const d = new Date(2026, 9, 26, 9, 0, 0, 0)
    d.setSeconds(t)
    const r = PURE.calc(S, d)
    const shown = Number(PURE.fmtMoney(r.earned).slice(1))
    if (!Object.is(shown, PURE.trunc2(r.earned))) drift += 1
  }
  eq('全天 14401 个格点显示值都等于截断值', drift, 0)
}
eq('0.999 截断成 0.99', PURE.fmtMoney(0.999), '¥0.99')
eq('1.005 截断成 1.00（不进位）', PURE.fmtMoney(1.005), '¥1.00')
// ¥9.99 → ¥10.00：9→1、9→0，第三位从空槽变 0，末位 9→0
eq('¥9.99 → ¥10.00 只翻变化位', JSON.stringify(PURE.changedSlots(PURE.moneySlots('¥9.99'), PURE.moneySlots('¥10.00'))), '[3,4,6,7]')

/* ---------- 3. 牌面几何 ---------- */

const slots = PURE.moneySlots('¥1234.56')
eq('金额固定 8 格', slots.length, 8)
eq('0 号格是 ¥', slots[0], '¥')
eq('5 号格是小数点', slots[5], '.')
eq('模板格里位数不足补空槽', JSON.stringify(PURE.moneySlots('¥9.99')), '["¥"," "," "," ","9",".","9","9"]')
eq('SLOT_COUNT 是 8', PURE.SLOT_COUNT, 8)
eq('INT_SLOT_COUNT 是 4', PURE.INT_SLOT_COUNT, 4)
eq('2 秒结算一次的常量', PURE.SETTLE_MS, 2000)
eq('翻页全程 420ms', PURE.FLAP_MS, 420)
eq('半程 210ms', PURE.HALF_MS, 210)

/* ---------- 4. CSS 断言（对源码文本） ---------- */

const css = CLIENT.slice(CLIENT.indexOf('const CSS = `'), CLIENT.indexOf('`\n', CLIENT.indexOf('const CSS = `') + 20))
ok('整块凹陷翻牌窗 .sf-board', /\.sf-board\s*\{[\s\S]{0,240}inset 0 2px 7px rgba\(0, 0, 0, \.62\)/.test(css))
ok('牌面 40px', /font-size:\s*40px/.test(css))
ok('数字位宽 .78em', /--sf-w:\s*\.78em/.test(css))
ok('窄格 .46em', /\.sf-slat\.is-tight\s*\{\s*--sf-w:\s*\.46em;?\s*\}/.test(css))
ok('透视 420px', /perspective:\s*420px/.test(css))
ok('中缝 2px + 上沿反光', /top:\s*50%;\s*height:\s*2px;[\s\S]{0,320}rgba\(255, 255, 255, \.1\)/.test(css))
ok('上半页铰链在下沿', /\.sf-flip--top\s*\{[^}]*transform-origin:\s*bottom center/.test(css))
ok('下半页铰链在上沿', /\.sf-flip--bottom\s*\{[^}]*transform-origin:\s*top center/.test(css))
ok('翻上去 -90°', /sf-fold[\s\S]{0,160}rotateX\(-90deg\)/.test(css))
ok('落定 -6° 回弹', /78%\s*\{\s*transform:\s*rotateX\(-6deg\)/.test(css))
ok('翻动压暗到 .45', /brightness\(\.45\)/.test(css))
ok('前半程曲线 .45,0,.9,.45', /sf-fold[^;]*cubic-bezier\(\.45,\s*0,\s*\.9,\s*\.45\)/.test(css))
ok('后半程曲线 .2,.9,.3,1', /sf-unfold[^;]*cubic-bezier\(\.2,\s*\.9,\s*\.3,\s*1\)/.test(css))
ok('空槽不画牌面', /\.sf-slat\.is-blank\s*\{[\s\S]{0,80}box-shadow:\s*none/.test(css))
ok('尊重 prefers-reduced-motion', /prefers-reduced-motion:\s*reduce/.test(css) && /\.sf-flip\s*\{\s*display:\s*none\s*!important/.test(css))
ok('整层 click-through、只有卡片接指针', /pointer-events:\s*none/.test(css) && /pointer-events:\s*auto/.test(css))

/* ---------- 5. 弹窗与看板一致 ---------- */

const win = WINDOW_HTML
const smooth = (src) =>
  /cubic-bezier\(\s*\.45,\s*0,\s*\.9,\s*\.45\s*\)/.test(src) &&
  /cubic-bezier\(\s*\.2,\s*\.9,\s*\.3,\s*1\s*\)/.test(src)
ok('弹窗 8 格', /var INT_SLOT_COUNT = 4;/.test(win))
ok('弹窗同时长', /var FLAP_MS = 420;/.test(win) && /var HALF_MS = 210;/.test(win))
ok('弹窗同款牌面尺寸', /--sf-w: \.78em;/.test(win) && /--sf-h: 1\.22em;/.test(win))
ok('弹窗同曲线', smooth(win) && smooth(css))
ok('弹窗同窄格与中缝', /is-tight \{ --sf-w: \.46em; \}/.test(win) && /height: 2px/.test(win))
ok('弹窗同回弹与压暗', /rotateX\(-6deg\)/.test(win) && /brightness\(\.45\)/.test(win))
ok('弹窗空槽不画牌面（含渐变）', /is-blank \.sf-half::after, \.sf-slat\.is-blank \.sf-flip::after \{ display: none; \}/.test(win))

/* ---------- 6. 包与本地化 ---------- */

const flat = (obj, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out)
    else out[key] = v
  }
  return out
}
const zhFile = flat(JSON.parse(read('locale/zh.json')))
const enFile = flat(JSON.parse(read('locale/en.json')))
const zhIn2 = flat(PURE.MESSAGES.zh)
const enIn2 = flat(PURE.MESSAGES.en)
eq('中文 locale 与内联表键数一致', Object.keys(zhFile).length, Object.keys(zhIn2).length)
eq('英文 locale 与内联表键数一致', Object.keys(enFile).length, Object.keys(enIn2).length)
const diff = (a, b2) => Object.keys(a).filter((k) => !(k in b2))
eq('zh 文件里没有内联表缺的键', diff(zhFile, zhIn2).join(','), '')
eq('zh 内联表里没有文件缺的键', diff(zhIn2, zhFile).join(','), '')
eq('en 文件里没有内联表缺的键', diff(enFile, enIn2).join(','), '')
eq('en 内联表里没有文件缺的键', diff(enIn2, enFile).join(','), '')
ok('两种语言键集一致', diff(zhFile, enFile).join(',') === '' && diff(enFile, zhFile).join(',') === '')
ok('meta.title 有中文标题', typeof zhIn2['meta.title'] === 'string' && zhIn2['meta.title'].length > 0)

ok('package.json 不再是 private', PKG.private !== true)
ok('包名不再带 @local 前缀', !String(PKG.name).startsWith('@local'))
ok('有 author', typeof PKG.author === 'string' && PKG.author.length > 0)
ok('有 license 字段', typeof PKG.license === 'string' && PKG.license.length > 0)
ok('有 LICENSE 文件', existsSync(join(ROOT, 'LICENSE')))
ok('有 repository', typeof PKG.repository === 'object' || typeof PKG.repository === 'string')
ok('dsh.bundle.patch 指向存在的文件', existsSync(join(ROOT, PKG.dsh.bundle.patch)))
ok('client.inject 是静态数组', Array.isArray(PKG.dsh.client.inject))
for (const f of PKG.files) {
  if (f.includes('*')) continue
  ok(`files 里的 ${f} 存在`, existsSync(join(ROOT, f)))
}
ok('locale 目录里只有 zh/en', readdirSync(join(ROOT, 'locale')).every((f) => f === 'zh.json' || f === 'en.json'))
for (const name of ['index.js', 'client.js', 'window.html', 'lib/routes.js', 'lib/window.js', 'lib/shared.js']) {
  ok(`${name} 不含 require('@deepseek-ai`, !read(name).includes("require('@deepseek-ai"))
}
ok('不往 document.body 追加节点', !/document\.body\s*\.\s*(append|insert)/.test(CLIENT))
ok('不用 iframe', !/<iframe/i.test(CLIENT))
ok('host 路由前缀存在', read('lib/routes.js').includes('/plugins/dsh-salary-flap'))

/* ---------- 汇总 ---------- */

const total = pass + fails.length
if (fails.length) {
  console.log(`==== 自检没全过：${pass}/${total} ====`)
  for (const f of fails) console.log('  ❌ ' + f)
  process.exit(1)
}
console.log(`==== 自检 ${pass}/${total} 全绿 ====`)
