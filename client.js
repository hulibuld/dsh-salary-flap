/**
 * 「工资跳板」浏览器半边 —— 实现（T4）。
 *
 * 一块挂在 `shell.overlay` 上的分片翻牌看板：填月薪 / 每日工时 / 每月工作天数 / 上班时间，
 * 每 `SETTLE_MS`(2000ms) 结算一次「今天已经赚了多少钱」，两位小数截断，数字按
 * 「上半页下翻 + 下半页翻出」两段式逐位跳。
 *
 * 事实源：docs/立项卡.md（§4 计算 / §5 交互 / §6 翻牌 / §7 视觉 / §9 验收）。
 * 分区与函数签名：docs/架构.md（六个分区，逐段对齐，不许自己发明形状）。
 * 翻牌 DOM/CSS 与逐位错开算法：docs/对标-网络.md §4.3 / §4.4（整段照抄）。
 * 工厂形状照抄 dsh-peak-scheduler（lib/client.js:1155-1169，同槽位、实测可用）。
 *
 * 四条铁律（违反任一条，宿主会把整条 overlay entry 退役或挡住整个界面）：
 *   1. 工厂内只 `require('react')`，不做 I/O、不碰 DOM；
 *   2. 组件渲染路径不许抛错（localStorage / JSON.parse / 数字 / 时间串全部先校验）；
 *   3. hooks 全部无条件调用，三态只是 return 里的分支；
 *   4. 外层容器 pointer-events:none，卡片本体 pointer-events:auto。
 *
 * 纯函数区（分区 2）不依赖 React、不碰 DOM，可以整段抠出来在 node 里跑单测：
 * 见 tools/selfcheck.mjs（用 SF-PURE-BEGIN / SF-PURE-END 标记抽取）。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-salary-flap',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    // ======================================================================
    // SF-PURE-BEGIN   ↓↓↓ 单测抽取区起点（常量区 + 纯函数区，无 React/DOM 依赖）
    // ======================================================================

    // ==========================================================================
    // 1. 常量区
    //    时间常数、localStorage 键名、默认参数、面板几何、内联文案表。
    //    全是模块级常量，不读 DOM、不读 localStorage（读盘只在 hook 里做）。
    // ==========================================================================

    /** 结算节拍：每 2 秒跳一次，绝不每帧重渲染。 */
    const SETTLE_MS = 2000
    /** 单片翻牌总时长 = HALF_MS × 2（420ms：慢到能看清上下两页交接，又不拖进下一拍 2 秒）。 */
    const FLAP_MS = 420
    /** 半程：前半程上半页下翻 0 → -90°，后半程下半页 +90° → 0°。 */
    const HALF_MS = 210
    /** 每次结算整行上浮 1–2px 的时长，比 FLAP_MS 短一点，收尾更干净。 */
    const RISE_MS = 160
    /** 进位错开：按「右边还有几个数字位」× 30ms，最多 4 步（120ms）。 */
    const STAGGER_MS = 30
    const MAX_STAGGER_STEPS = 4
    /** 收工后不需要 2 秒一跳：降到 60 秒一次，只用来「跨天醒来」。 */
    const IDLE_MS = 60000
    /** 拖动判定阈值：位移超过 3px 才算拖动，否则当成点击（齿轮/折叠键才点得动）。 */
    const DRAG_THRESHOLD = 3

    /** localStorage 键名统一前缀，几个键分开存，互不牵连。 */
    const LS_PREFIX = 'dsh.salary-flap.v1.'
    const LS_SETTINGS = LS_PREFIX + 'settings'
    const LS_POS = LS_PREFIX + 'pos'
    /** 看板驻留位置：浮在看板上（board，默认）还是缩进右上角顶栏（dock）。 */
    const LS_VIEW = LS_PREFIX + 'view'
    const VIEW_BOARD = 'board'
    const VIEW_DOCK = 'dock'

    /** 首次出现的默认参数：09:00 上班、8 小时、22 天、月薪 12000。 */
    const DEFAULT_SETTINGS = { monthly: 12000, hours: 8, days: 22, start: '09:00' }
    const MINUTES_PER_DAY = 1440

    /**
     * 定宽槽位：`¥` + INT_SLOT_COUNT 个整数位 + `.` + 2 位小数 = 8 格，模板固定，
     * 位数不足补空槽（不补前导字符），整行宽度恒定。
     */
    const SLOT_COUNT = 8
    /** 整数位槽数：日薪按 4 位数封顶（¥9999.99），再多就退化成右对齐。 */
    const INT_SLOT_COUNT = 4

    /** 面板几何：宽 280px（立项卡 §7 的 260–280，取 280 才容得下 ¥12345.67）、默认落右下角（距右 24、距下 96），与视口边缘至少留 12px。 */
    const CARD_W = 280
    const CARD_TOP_H = 34
    const EDGE = 12
    const DEFAULT_INSET = { right: 24, bottom: 96 }
    /**
     * 三态各自的高度**兜底值**（T7 P1 #3）：真实高度由 cardRef + ResizeObserver 量的 offsetHeight 决定，
     * 常量只在 ResizeObserver 不可用 / 首帧未测量时顶上。测不准会让「距下 96px」偏掉，所以不许再当尺子用。
     */
    const H_SETUP = 236
    const H_RUNNING = 200



    const LS_THEME = LS_PREFIX + 'theme'
    const LS_LANG = LS_PREFIX + 'lang'

    /**
     * 六套配色。每套六个键：卡片底 bg / 翻牌格 slat / 数字 text / 强调 accent / 描边 border / 次文字 muted。
     *
     * 为什么是字面色值、而不是 --dsw-alias token：翻牌器要像一块**实体小牌**，得跟身后的界面
     * 明显区分开；token 表达的是界面层级与语义，拿来做牌面只会糊成一片。这些颜色只出现在这一张
     * 牌上（含它弹出的独立窗口），不溢出到宿主 UI。
     * ⚠ window.html（弹出的独立窗口）里另存了一份同样的色值，改色必须两处一起改。
     */
    const THEMES = [
      { id: 'mono', bg: '#17181a', slat: '#24262a', text: '#f3f4f6', accent: '#8b9198', border: '#313438', muted: '#9aa0a6' },
      { id: 'green', bg: '#14251a', slat: '#1d3325', text: '#d8f2dd', accent: '#6ecf8d', border: '#2a4233', muted: '#8fb99c' },
      { id: 'wood', bg: '#26201a', slat: '#352c23', text: '#f5e6cd', accent: '#d9a86c', border: '#463a2d', muted: '#b8a488' },
      { id: 'sky', bg: '#eaf2fa', slat: '#ffffff', text: '#22374d', accent: '#4a90d9', border: '#cfe0f0', muted: '#6b8399' },
      { id: 'night', bg: '#0b0c0e', slat: '#16181c', text: '#eef0f3', accent: '#4a5560', border: '#23262b', muted: '#7c848d' },
      { id: 'sakura', bg: '#2a1f22', slat: '#3a2b30', text: '#fbe9ee', accent: '#f2a0b5', border: '#4a363c', muted: '#c3a0aa' },
    ]
    const DEFAULT_THEME = 'mono'

    /** 主题 id → 主题对象。认不出的 id 一律回默认，绝不让 undefined 漏进样式。 */
    function themeOf(id) {
      for (let i = 0; i < THEMES.length; i += 1) {
        if (THEMES[i].id === id) return THEMES[i]
      }
      return THEMES[0]
    }

    /** 主题对象 → 六个 CSS 变量，内联挂到卡片上，整棵子树都吃它。 */
    function themeVars(th) {
      const x = th || THEMES[0]
      return {
        '--sf-bg': x.bg,
        '--sf-slat': x.slat,
        '--sf-text': x.text,
        '--sf-accent': x.accent,
        '--sf-border': x.border,
        '--sf-muted': x.muted,
      }
    }

    /**
     * 组件内 <style> 的样式文本。
     *
     * 为什么是组件内 <style> 而不是全局 CSS：立项卡 §8 不许写全局 CSS，也不许往 document.body
     * 追加节点。React 把 <style> 渲染在我们自己的子树里，卸载即随 DOM 一起移除；样式的作用域
     * 靠统一 `.sf-` 类名前缀 + `sf-` keyframes 前缀保证，不和别的插件撞名。
     *
     * 颜色全部走 `--dsw-alias-*` token；翻牌的明暗过渡用 `color-mix(in oklab, <token> …)` 在
     * token 上加深，`black` / `transparent` 只作为混合用色出现，不做前景/边框/背景的实色。
     */
    const CSS = `
      /* 六套配色只落在这一张牌上：变量由 themeVars() 用内联 style 注入，下面一律 var(--sf-*, 兜底)。 */
      .sf-layer {
        position: fixed;
        inset: 0;
        pointer-events: none;            /* 整层 click-through：绝不吃掉下面界面的点击 */
        z-index: 30;
      }
      .sf-card {
        --sf-bg: #17181a;
        --sf-slat: #24262a;
        --sf-text: #f3f4f6;
        --sf-accent: #8b9198;
        --sf-border: #313438;
        --sf-muted: #9aa0a6;
        position: absolute;
        box-sizing: border-box;
        pointer-events: auto;            /* 只有卡片本体接指针事件 */
        border-radius: 15px;
        overflow: hidden;
        color: var(--sf-text);
        background: var(--sf-bg);
        border: 1px solid var(--sf-border);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, .07),
          0 18px 40px rgba(0, 0, 0, .42);
        font-size: 13px;
        line-height: 1.35;
        touch-action: none;              /* 触屏拖动不滚页面 */
      }
      .sf-handle {
        display: flex;
        align-items: center;
        gap: 6px;
        height: ${CARD_TOP_H}px;
        padding: 0 8px 0 12px;
        cursor: grab;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        background: color-mix(in oklab, var(--sf-slat) 62%, var(--sf-bg));
        border-bottom: 1px solid var(--sf-border);
      }
      .sf-handle:active { cursor: grabbing; }
      .sf-title {
        flex: 1 1 auto;
        min-width: 0;
        font-size: 11px;
        letter-spacing: .04em;
        color: var(--sf-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sf-tools { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }
      .sf-iconbtn {
        width: 22px;
        height: 22px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid transparent;
        border-radius: 6px;
        background: transparent;
        color: var(--sf-muted);
        font: inherit;
        font-size: 12px;
        line-height: 1;
        cursor: pointer;
      }
      .sf-iconbtn:hover {
        color: var(--sf-text);
        background: color-mix(in oklab, var(--sf-slat) 80%, var(--sf-bg));
        border-color: var(--sf-border);
      }
      .sf-body { padding: 8px 13px 10px; }
      .sf-caption {
        font-size: 10px;
        letter-spacing: .06em;
        color: var(--sf-muted);
      }
      /* 牌面：一整块凹陷的翻牌窗。八格数字全部坐在这一格里，边框 + 内阴影做出机械面板的厚度 */
      .sf-board {
        margin: 6px 0 7px;
        padding: 7px 7px 8px;
        border-radius: 10px;
        background: color-mix(in oklab, var(--sf-bg) 62%, #000);
        box-shadow:
          inset 0 2px 7px rgba(0, 0, 0, .62),
          inset 0 -1px 0 rgba(255, 255, 255, .06),
          0 1px 0 rgba(255, 255, 255, .05);
      }
      .sf-row {
        display: flex;
        align-items: center;
        gap: .04em;
        margin: 0;
        font-size: 40px;
        line-height: 1;
        color: var(--sf-text);
        font-variant-numeric: tabular-nums;
        font-feature-settings: "tnum" 1;
        transform: translateY(0);
        transition: transform ${RISE_MS}ms cubic-bezier(.3, 0, .2, 1);
        will-change: transform;
      }
      .sf-row.is-rise { transform: translateY(-2px); }   /* 每次结算的 1–2px 轻微上浮 */
      .sf-line {
        font-size: 11px;
        color: var(--sf-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-variant-numeric: tabular-nums;
      }
      .sf-state { margin-top: 3px; font-size: 11px; color: var(--sf-muted); }
      .sf-state.is-after { color: color-mix(in oklab, var(--sf-accent) 45%, #34d399); }
      .sf-toast { margin-top: 7px; font-size: 11px; color: var(--sf-muted); }

      /* ---------- 配色与语言选择（一排圆点 / 两颗小药丸，不弹菜单） ---------- */
      .sf-swabs { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
      .sf-swab {
        width: 14px;
        height: 14px;
        padding: 0;
        border-radius: 50%;
        border: 1px solid rgba(0, 0, 0, .35);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, .35);
        cursor: pointer;
      }
      .sf-swab.is-active { outline: 2px solid var(--sf-text); outline-offset: 2px; }
      /* 顶栏那排要更小：标题行只有 34px 高，14px 的圆点会顶满整条 */
      .sf-handle .sf-swabs { gap: 5px; flex: 0 0 auto; flex-wrap: nowrap; }
      .sf-handle .sf-swab { width: 11px; height: 11px; }
      .sf-handle .sf-swab.is-active { outline-width: 1.5px; outline-offset: 1.5px; }
      .sf-langs { display: flex; gap: 6px; }
      .sf-lang {
        height: 20px;
        padding: 0 9px;
        border-radius: 999px;
        border: 1px solid var(--sf-border);
        background: transparent;
        color: var(--sf-muted);
        font: inherit;
        font-size: 10px;
        cursor: pointer;
      }
      .sf-lang.is-active { color: var(--sf-bg); background: var(--sf-text); border-color: transparent; }

      /* ---------- 分片翻牌：四层叠放（层角色见 SplitFlap 注释，方向错了会「翻完跳回旧值」） ---------- */
      .sf-slat {
        --sf-w: .78em;                  /* 牌宽写死：tabular-nums 只管字形，管不了「位数变化」 */
        --sf-h: 1.22em;
        --sf-half: ${HALF_MS}ms;        /* 单片总长 = HALF_MS × 2 = 420ms */
        display: inline-block;
        position: relative;
        flex: 0 0 auto;
        width: var(--sf-w);
        height: var(--sf-h);
        border-radius: 4px;
        perspective: 420px;             /* 必须打在牌容器上，不是每一半；拉远一点，翻转时形变不夸张 */
        vertical-align: baseline;
        box-shadow: 0 1px 2px rgba(0, 0, 0, .45);
      }
      /* ¥ 与小数点不用数字那么宽的格子 */
      .sf-slat.is-tight { --sf-w: .46em; }
      /* 中缝：翻牌器真正的那道横线。没有它，上下两半看起来只是两块拼色。 */
      .sf-slat::after {
        content: '';
        position: absolute;
        left: 0;
        right: 0;
        top: 50%;
        height: 2px;
        margin-top: -1px;
        z-index: 3;
        pointer-events: none;
        background: rgba(0, 0, 0, .62);
        box-shadow: 0 -1px 0 rgba(255, 255, 255, .1);   /* 铰链上沿的反光：没有它，中缝只是一条黑线 */
      }
      /* 空槽：模板格里「位数不足」的位只占宽度、不画牌面 —— 整行宽度恒定，¥ 与小数点不动 */
      .sf-slat.is-blank .sf-half,
      .sf-slat.is-blank .sf-flip {
        background: transparent;
        box-shadow: none;
        border-color: transparent;
      }
      .sf-slat.is-blank::after { display: none; }
      .sf-slat.is-blank { box-shadow: none; }
      .sf-half,
      .sf-flip {
        position: absolute;
        left: 0;
        right: 0;
        height: 50%;
        overflow: hidden;               /* 半页裁切：同一个字形被切成上下两半 */
        backface-visibility: hidden;
        -webkit-backface-visibility: hidden;
        transform: translateZ(0);       /* 独立合成层：修 Safari 上 backface 失效 */
        background: var(--sf-slat);
      }
      .sf-half--top {
        top: 0;
        border-radius: 4px 4px 0 0;
        box-shadow: inset 0 -1px 0 rgba(0, 0, 0, .55);
        /* 光从上面来：上半页亮一档、下半页压一档，牌面才有厚度 */
        background-image: linear-gradient(rgba(255, 255, 255, .07), rgba(255, 255, 255, 0));
      }
      .sf-half--bottom {
        bottom: 0;
        border-radius: 0 0 4px 4px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, .14);
        background-image: linear-gradient(rgba(0, 0, 0, .18), rgba(0, 0, 0, 0));
      }
      .sf-glyph {
        position: absolute;
        left: 0;
        right: 0;
        height: 200%;                   /* = 半页的 2 倍 = 整张牌，居中后由上下半页各裁一半 */
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: .9em;
        line-height: 1;
        color: inherit;
        font-variant-numeric: tabular-nums;
        -webkit-user-select: none;
        user-select: none;
      }
      .sf-half--top .sf-glyph,
      .sf-flip--top .sf-glyph    { top: 0; }
      .sf-half--bottom .sf-glyph,
      .sf-flip--bottom .sf-glyph { bottom: 0; }

      .sf-flip { z-index: 2; will-change: transform; }
      .sf-flip--top {
        top: 0;
        border-radius: 4px 4px 0 0;
        transform-origin: bottom center;                       /* 铰链 = 中缝 */
        box-shadow: inset 0 -1px 0 rgba(0, 0, 0, .6);
        background-image: linear-gradient(rgba(255, 255, 255, .07), rgba(255, 255, 255, 0));
        /* 前半程加速下落：脱手后越落越快，像被重力拉着 */
        animation: sf-fold var(--sf-half) cubic-bezier(.45, 0, .9, .45) var(--sf-delay, 0ms) forwards;
      }
      .sf-flip--bottom {
        bottom: 0;
        border-radius: 0 0 4px 4px;
        transform-origin: top center;
        transform: rotateX(90deg);                             /* 起始侧立，看不见 */
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, .14);
        background-image: linear-gradient(rgba(0, 0, 0, .18), rgba(0, 0, 0, 0));
        /* 延迟前半程 = 两段式；末段 -6° 回弹是机械感的来源 */
        animation: sf-unfold var(--sf-half) cubic-bezier(.2, .9, .3, 1)
                   calc(var(--sf-delay, 0ms) + var(--sf-half)) forwards;
      }
      /* 翻动中的牌比静止时暗：两段之间没有亮度差，看着就只是换了一张图 */
      @keyframes sf-fold {
        from { transform: rotateX(0deg);   filter: brightness(1); }
        to   { transform: rotateX(-90deg); filter: brightness(.45); }
      }
      @keyframes sf-unfold {
        0%   { transform: rotateX(90deg); filter: brightness(.45); }
        78%  { transform: rotateX(-6deg); filter: brightness(.95); }
        100% { transform: rotateX(0deg);  filter: brightness(1); }
      }

      /* ---------- 设置态 ---------- */
      .sf-setup { padding: 10px 13px 12px; }
      .sf-setup-title { margin-bottom: 8px; font-size: 12px; color: var(--sf-muted); }
      /* 设置态标题栏兼作拖动把手：负 margin 把它顶到卡片边缘，与运行态标题栏同款 */
      .sf-setup .sf-setup-title.sf-handle { margin: -10px -13px 8px; border-radius: 15px 15px 0 0; }
      .sf-field { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
      .sf-field > label {
        flex: 0 0 92px;
        font-size: 11px;
        color: var(--sf-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sf-input {
        flex: 1 1 auto;
        min-width: 0;
        height: 26px;
        box-sizing: border-box;
        padding: 0 8px;
        border-radius: 7px;
        border: 1px solid var(--sf-border);
        background: color-mix(in oklab, var(--sf-slat) 55%, var(--sf-bg));
        color: var(--sf-text);
        font: inherit;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        outline: none;
        touch-action: auto;
      }
      .sf-input:focus { border-color: var(--sf-accent); }
      .sf-note { margin-top: 2px; font-size: 11px; color: var(--sf-text); opacity: .92; }
      .sf-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 9px; }
      .sf-btn {
        height: 26px;
        padding: 0 11px;
        border-radius: 7px;
        border: 1px solid var(--sf-border);
        background: color-mix(in oklab, var(--sf-slat) 55%, var(--sf-bg));
        color: var(--sf-text);
        font: inherit;
        font-size: 11px;
        cursor: pointer;
        touch-action: auto;
      }
      .sf-btn:hover { border-color: var(--sf-accent); }
      .sf-btn--primary { border-color: transparent; background: var(--sf-text); color: var(--sf-bg); font-weight: 600; }
      .sf-btn:disabled { opacity: .45; cursor: not-allowed; }

      /* ---------- 顶栏小胶囊（dock 态：看板缩进右上角会话工具条） ---------- */
      .sf-chipwrap { display: contents; }        /* 外壳不参与布局，胶囊就是槽位里的一颗药丸 */
      .sf-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 24px;
        padding: 0 9px;
        border-radius: 999px;
        border: 1px solid color-mix(in oklab, var(--dsw-alias-border-l1) 78%, transparent);
        background: color-mix(in oklab, var(--dsw-alias-bg-layer-2) 72%, transparent);
        color: var(--dsw-alias-label-primary);
        font: inherit;
        font-size: 12px;
        line-height: 1;
        cursor: pointer;
      }
      .sf-chip:hover { border-color: color-mix(in oklab, var(--dsw-alias-brand-primary) 55%, transparent); }
      .sf-chip-money {
        font-variant-numeric: tabular-nums;
        font-feature-settings: "tnum" 1;
        white-space: nowrap;
      }
      .sf-chip-dot {
        width: 6px;
        height: 6px;
        flex: 0 0 auto;
        border-radius: 50%;
        background: var(--dsw-alias-state-idle-primary);
      }
      /* 活着的呼吸灯：节拍就是结算节拍，静着也能看出这块表在走 */
      .sf-chip-dot.is-live {
        background: var(--dsw-alias-state-success-primary);
        animation: sf-beat ${SETTLE_MS}ms ease-in-out infinite;
      }
      @keyframes sf-beat { 0%, 100% { opacity: 1; } 50% { opacity: .32; } }
      /* 兜底胶囊：没打开会话时顶栏槽位没人渲染，它就浮在右上角，保证看板找得回来 */
      .sf-chip--floating { position: fixed; top: 8px; right: 12px; z-index: 1; pointer-events: auto; }

      /* ---------- 降级：系统开启「减弱动态效果」时直接跳值 ---------- */
      @media (prefers-reduced-motion: reduce) {
        .sf-flip { display: none !important; }
        .sf-slat { perspective: none; }
        .sf-row { transition: none; }
        .sf-row.is-rise { transform: none; }
        .sf-chip-dot.is-live { animation: none; }
      }
    `

    /**
     * 文案表 —— locale/zh.json、locale/en.json 的逐字镜像（键名一一对应）。
     *
     * 为什么要在 client.js 里再放一份：ModuleLoader 只允许 require('react')，factory 里不许做
     * I/O，读不到包内的 locale/*.json，所以浏览器侧只能自带一份；两份由 T5 对拍键集合。
     */
    const MESSAGES = {
      zh: {
        meta: {
          title: '工资跳板',
          description:
            '挂在界面右下的翻牌看板：填月薪、每日工时、每月工作天数与上班时间，每 2 秒结算一次今天已经赚了多少钱。',
        },
        app: {
          title: '工资跳板',
          subtitle: '每 2 秒结算一次，只算今天',
          earnedLabel: '今日已赚',
          hourlyLabel: '时薪',
          dailyLabel: '日薪',
          progressLabel: '今日进度',
          dragHint: '按住顶部可拖动',
        },
        line: {
          summary: '时薪 {hourly} · 今日进度 {progress}%',
        },
        status: {
          before: '还没上班',
          beforeEta: '还没上班 · 还有 {eta}开工',
          working: '正在赚',
          after: '今天收工了',
          afterEta: '今天收工了 · {eta}后开工',
        },
        eta: {
          minutes: '{n} 分钟',
          hourOnly: '{n} 小时',
          hours: '{n} 小时 {m} 分',
        },
        setup: {
          title: '填一下你的工资参数',
          monthlyLabel: '月薪',
          hoursLabel: '每天工作',
          daysLabel: '每月工作天数',
          startLabel: '上班时间',
        },
        unit: {
          yuan: '元',
          hour: '小时',
          day: '天',
          percent: '%',
        },
        button: {
          start: '开始跳',
          save: '保存',
          apply: '应用',
          cancel: '取消',
          settings: '设置',
          popout: '弹到桌面',
          theme: '配色',
          lang: '语言',
          dock: '收到顶栏',
          undock: '展开工资跳板',
        },
        theme: {
          mono: '黑白灰',
          green: '护眼绿',
          wood: '原木黄',
          sky: '天空浅蓝',
          night: '暗夜黑',
          sakura: '樱雾粉',
        },
        toast: {
          popped: '已弹到桌面，可拖到任何地方',
          noElectron: '这个环境弹不出独立窗口',
        },
        error: {
          invalidNumber: '请输入大于 0 的数字',
          invalidTime: '时间格式不对，应形如 09:00',
        },
      },
      en: {
        meta: {
          title: 'Salary Flap',
          description:
            "A split-flap board pinned to the bottom-right of the UI: enter your monthly salary, daily hours, working days per month and start time to see today's earnings settle every 2 seconds.",
        },
        app: {
          title: 'Salary Flap',
          subtitle: 'Settles every 2 seconds, today only',
          earnedLabel: 'Earned today',
          hourlyLabel: 'Hourly',
          dailyLabel: 'Daily',
          progressLabel: "Today's progress",
          dragHint: 'Drag the top edge to move',
        },
        line: {
          summary: '¥{hourly}/h · {progress}% of today',
        },
        status: {
          before: 'Not started yet',
          beforeEta: 'Not started · starts in {eta}',
          working: 'Earning now',
          after: 'Done for today',
          afterEta: 'Done for today · next shift in {eta}',
        },
        eta: {
          minutes: '{n} min',
          hourOnly: '{n} h',
          hours: '{n} h {m} min',
        },
        setup: {
          title: 'Set up your pay',
          monthlyLabel: 'Monthly salary',
          hoursLabel: 'Hours per day',
          daysLabel: 'Working days per month',
          startLabel: 'Start time',
        },
        unit: {
          yuan: 'CNY',
          hour: 'h',
          day: 'd',
          percent: '%',
        },
        button: {
          start: 'Start ticking',
          save: 'Save',
          apply: 'Apply',
          cancel: 'Cancel',
          settings: 'Settings',
          popout: 'Pop out to desktop',
          theme: 'Theme',
          lang: 'Language',
          dock: 'Minimize to top bar',
          undock: 'Show the board',
        },
        theme: {
          mono: 'Mono',
          green: 'Reading green',
          wood: 'Wood',
          sky: 'Sky',
          night: 'Night',
          sakura: 'Sakura',
        },
        toast: {
          popped: 'Popped out — drag it anywhere',
          noElectron: 'This environment cannot open a window',
        },
        error: {
          invalidNumber: 'Enter a number greater than 0',
          invalidTime: 'Time must look like 09:00',
        },
      },
    }

    // ==========================================================================
    // 2. 纯函数区
    //    不依赖 React、不碰 DOM、不读 localStorage —— 这些函数必须能在 node 里
    //    单独抠出来跑（T4 单测、T6 计算审查都从这里进）。
    //    共同契约：**一个都不许抛**，非法输入返回安全值。
    // ==========================================================================

    /** 数值夹紧；NaN / 非有限值一律退 lo（绝不让 NaN 漏进渲染）。 */
    function clampNum(v, lo, hi) {
      const n = Number(v)
      const low = Number.isFinite(lo) ? lo : 0
      const high = Number.isFinite(hi) ? hi : low
      if (!Number.isFinite(n)) return low
      if (n < low) return low
      if (n > high) return high
      return n
    }

    /**
     * 算今天赚了多少。三态：上班前 0 / 上班中按进度 / 下班后封顶；跨午夜归一。
     *
     * 口径（立项卡 §4）：日薪 = 月薪 / 每月工作天数；时薪 = 日薪 / 每日工时；
     * 今日已赚 = 日薪 × 进度，进度 = 已过计薪时长 / 当日总计薪时长。
     * **三个分支全部由一次 clamp 推出**，不写「现在是否在上下班之间」的时刻比较——
     * 那种写法就是 SalaryTick 的真 bug（docs/对标-网络.md §1.3：白班 progress 恒为 1）。
     *
     * @param {{ monthly:number, hours:number, days:number, start:string }} settings
     * @param {number} now  本机本地时间的 epoch 毫秒（Date.now()）
     * @returns {{ earned:number, dailyWage:number, hourly:number, progress:number,
     *            phase:'before'|'working'|'after', nextStart:number }}
     *          earned 是未截断的浮点；截断只发生在 fmtMoney 里，别在 calc 里提前取整。
     *          nextStart 是**下一次开工**的绝对时刻（epoch ms），0 = 算不出来（非法输入）。
     *          它只给「还没上班 / 今天收工了」两态算倒计时，不参与金额。
     */
    function calc(settings, now) {
      const empty = { earned: 0, dailyWage: 0, hourly: 0, progress: 0, phase: 'before', nextStart: 0 }
      try {
        // ① 入口卫兵：任何一项不合法都退成「还没上班」的空快照，绝不 throw、绝不 NaN。
        //    月薪 0 在设置态就被拦住、根本跑不到这里；这里是哑防御（`Number.isFinite` 拦住
        //    空串转 0、NaN、Infinity；`<= 0` 拦住 0 与负数，顺带干掉所有除零）。
        const monthly = Number(settings && settings.monthly)
        const hours = Number(settings && settings.hours)
        const days = Number(settings && settings.days)
        const nowMs = Number(now)
        if (!Number.isFinite(monthly) || monthly <= 0) return empty
        if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return empty
        if (!Number.isFinite(days) || days < 1 || days > 31) return empty
        if (!Number.isFinite(nowMs)) return empty

        // ② 基本量。时间串非法 → 整体退 0（**不猜一个默认 9 点**：猜就会凭空算出一笔钱，
        //    T4 新增验收「时间串 "abc" → 全部 0.00」要的就是这个）。
        const start = parseHHMM(settings && settings.start)
        if (start === null) return empty
        const dailyWage = monthly / days                      // 日薪（收工后的封顶值）
        const hourly = dailyWage / hours                      // 时薪（小字用）
        const totalMs = hours * 3600 * 1000                   // 当日总计薪毫秒

        // ③ 先判班次形状：跨午夜的唯一判据是「起点 + 总时长」越过了当天 24 点。
        const crossMidnight = start * 60000 + totalMs > MINUTES_PER_DAY * 60000

        // ④ 今天这个上班时刻的绝对时间戳（用本地 Date 构造，跨月/跨年/夏令时交给引擎归一）。
        const d = new Date(nowMs)
        const y = d.getFullYear()
        const mo = d.getMonth()
        const da = d.getDate()
        const hh = Math.floor(start / 60)
        const mm = start % 60
        const todayStart = new Date(y, mo, da, hh, mm, 0, 0).getTime()

        // ⑤ 归一到「班次起点」：**只有跨午夜班次**才可能还处在昨天开始的那个窗口里。
        //    白班永远走 todayStart——这正是 SalaryTick 缺的那一步（它比时刻、把窗口挪到昨天）。
        //
        //    这里只做「窗口选择」（认不认昨天那个班次），**不加 `raw < totalMs` 上界**（T7 P0）：
        //    加了上界就会把 `raw === totalMs`（下班当刻）连同之后整段一起挡掉，
        //    夜班 06:00:00 起 16 小时显示 ¥0.00 +「还没上班」。
        //    旧班次结束到新班次开始之间保持封顶，靠的是 ⑥ 里 `raw >= totalMs` 自然落 after，
        //    不是靠窗口上界；相位判定与窗口选择是两件事，不能混写。
        let shiftStart = todayStart
        if (crossMidnight && nowMs < todayStart) {
          const prevStart = new Date(y, mo, da - 1, hh, mm, 0, 0).getTime() // da-1 由 Date 自动借位
          if (nowMs >= prevStart) shiftStart = prevStart
        }

        // ⑥ 钱走夹紧、状态走未夹紧的原始偏移（立项卡 §4「上班时间 ≤ 现在 < 下班时间 → 按进度」，
        //    架构师 00:25 裁决）：raw === 0（整点）算 **working**、金额 ¥0.00；raw === totalMs 算
        //    after、金额封顶。用 elapsed 判态会在 -0 / 整点上歧义（-0 <= 0 与 0 <= 0 同真）。
        const raw = nowMs - shiftStart
        const elapsed = clampNum(raw, 0, totalMs)             // 只有金额走夹紧
        const progress = elapsed / totalMs
        const phase = raw < 0 ? 'before' : raw >= totalMs ? 'after' : 'working'

        // ⑦ 下一次开工的绝对时刻：今天这个上班点还没到就用今天，否则顺延到明天同一时刻。
        //    取「今天的构造值」而不是 shiftStart + 24h，跨午夜班次收工后（06:00）才能得到
        //    「今天 22:00 再开工」而不是「昨天 22:00 + 1 天」那种还要再判一次的写法。
        let nextStart = todayStart
        if (!(nextStart > nowMs)) nextStart = new Date(y, mo, da + 1, hh, mm, 0, 0).getTime()

        // ⑧ 不取整：截断只发生在 fmtMoney，进度计算全程保留浮点。
        return { earned: dailyWage * progress, dailyWage, hourly, progress, phase, nextStart }
      } catch (err) {
        return empty
      }
    }

    /**
     * 截断到两位小数（不是四舍五入），带 1e-9 修正；非有限值返回 0；保留符号但绝不出 -0。
     *
     * 为什么必须 +1e-9：`1.15 * 100` 在 IEEE754 下是 `114.99999999999999`，
     * 直接 Math.floor 会得到 1.14（比四舍五入还难看，且少一分钱）。
     */
    function trunc2(n) {
      if (!Number.isFinite(n)) return 0
      const v = Math.floor(Math.abs(n) * 100 + 1e-9) / 100
      return n < 0 && v !== 0 ? -v : v // -0 归一成 +0：绝不出 '¥-0.00'
    }

    /**
     * 金额显示：截断到两位小数，形态固定 `¥12.34`。
     * 非有限值 / -0 归成 '¥0.00'，绝不出现 'NaN' / '¥-0.00' / 三位小数。
     */
    function fmtMoney(n) {
      const v = trunc2(n)
      const safe = v === 0 ? 0 : v
      return '¥' + safe.toFixed(2)
    }

    /**
     * 'HH:mm' -> 当天 0 点起的分钟数。非法输入返回 null（由调用方退默认值）。
     * 只认严格正则 + 范围双校验，绝不让 Date 去猜（猜错就是「悄悄变成 0 点」）。
     * @returns {number|null}  '09:00' -> 540
     */
    function parseHHMM(s) {
      if (typeof s !== 'string') return null
      const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
      if (!m) return null
      const hh = Number(m[1])
      const mm = Number(m[2])
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null
      if (hh < 0 || hh > 23) return null
      if (mm < 0 || mm > 59) return null
      return hh * 60 + mm
    }

    /**
     * 把 '¥12.34' 拆成逐格数组，翻牌组件一格里放一个字符。
     * @returns {string[]}  ['¥','1','2','.','3','4']
     */
    function splitDigits(str) {
      if (str === null || str === undefined) return []
      return Array.from(String(str))
    }

    /**
     * 金额模板格（T7 P2 #6）：`¥` 与小数点各占固定列，整数位固定 INT_SLOT_COUNT 列右对齐，
     * 位数不足时左侧补**空槽**（' '，外壳也是空的）。这样 ¥9.99 → ¥10.00 时 `¥` 不会瞬移、
     * 整行宽度恒定，只有真正变的数字位才翻。整数位超宽的极端金额退化为 slotify（右对齐、不丢字符）。
     * @returns {string[]}  ['¥',' ',' ',' ','4','5','.','5','4']  长度恒为 SLOT_COUNT
     */
    function moneySlots(text) {
      const chars = splitDigits(text)
      const dot = chars.lastIndexOf('.')
      const intCount = dot < 0 ? Math.max(chars.length - 1, 0) : Math.max(dot - 1, 0) // 扣掉前导 ¥
      if (intCount > INT_SLOT_COUNT) return slotify(text)
      const out = [chars[0] || '¥']
      for (let i = 0; i < INT_SLOT_COUNT - intCount; i += 1) out.push(' ')
      for (let i = 1; i < chars.length; i += 1) out.push(chars[i])
      while (out.length < SLOT_COUNT) out.push(' ')
      return out
    }

    /**
     * 定宽槽位：不足 SLOT_COUNT 用 U+00A0 前导补齐；超长不裁（宁可整行宽一点，也不丢 ¥ 和小数点）。
     * 定宽是「¥9.99 → ¥10.00 时整行不抖」的唯一保证：tabular-nums 只管字形宽，管不了位数。
     * @returns {string[]}  长度恒为 SLOT_COUNT（极端金额除外）
     */
    function slotify(text) {
      const chars = splitDigits(text)
      if (chars.length >= SLOT_COUNT) return chars
      const pad = []
      for (let i = 0; i < SLOT_COUNT - chars.length; i += 1) pad.push('\u00a0')
      return pad.concat(chars)
    }

    /** 数字字符判定：翻牌只翻数字，¥ 和 . 永远静止。 */
    function isDigit(ch) {
      return typeof ch === 'string' && ch.length === 1 && ch >= '0' && ch <= '9'
    }

    /** 只挑真正变了、且新的那位是数字的槽位。没变的位置绝不重挂 DOM（脏区最小）。 */
    function changedSlots(prevSlots, nextSlots) {
      const out = []
      if (!Array.isArray(nextSlots)) return out
      const prev = Array.isArray(prevSlots) ? prevSlots : []
      for (let i = 0; i < nextSlots.length; i += 1) {
        if (prev[i] !== nextSlots[i] && isDigit(nextSlots[i])) out.push(i)
      }
      return out
    }

    /**
     * 进位错开毫秒数：这一位右边还有几个数字位 × STAGGER_MS，最多 MAX_STAGGER_STEPS 步。
     * ¥19.99 → ¥20.00 时个位先翻、十位次之、百位最后，形成「连翻」的级联感；
     * 非进位的单点变化（¥12.33 → ¥12.34）只有一位变，延迟天然是 0。
     */
    function delayOf(index, nextSlots) {
      if (!Number.isFinite(index) || !Array.isArray(nextSlots)) return 0
      let rightDigits = 0
      for (let i = index + 1; i < nextSlots.length; i += 1) {
        if (isDigit(nextSlots[i])) rightDigits += 1
      }
      return Math.min(rightDigits, MAX_STAGGER_STEPS) * STAGGER_MS
    }

    /**
     * 取文案。按 'line.summary' 点号逐层取；缺键回退到 key 本身，绝不让界面出现 undefined。
     * 占位符写成 {hourly} / {progress}，替换时不做 HTML 转义（纯文本节点）。
     * @returns {(key:string, vars?:Record<string,string|number>) => string}
     */
    function makeT(lang) {
      const table = (MESSAGES && (MESSAGES[lang] || MESSAGES.zh)) || {}
      return function t(key, vars) {
        try {
          const path = String(key === null || key === undefined ? '' : key).split('.')
          let node = table
          for (let i = 0; i < path.length; i += 1) {
            if (node === null || typeof node !== 'object') {
              node = undefined
              break
            }
            node = node[path[i]]
          }
          let out = typeof node === 'string' ? node : String(key)
          if (vars && typeof vars === 'object') {
            out = out.replace(/\{(\w+)\}/g, (whole, name) => {
              const v = vars[name]
              return v === null || v === undefined ? whole : String(v)
            })
          }
          return out
        } catch (err) {
          return String(key)
        }
      }
    }

    /** 数字输入宽容解析：容忍千分位、空格、全角空格；空串/非法一律 NaN（由调用方判定）。 */
    function toNum(v) {
      if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
      const s = String(v === null || v === undefined ? '' : v)
        .replace(/[,\uff0c\s]/g, '')
      if (s === '') return NaN
      const n = Number(s)
      return Number.isFinite(n) ? n : NaN
    }

    /**
     * 设置项校验：返回 null 表示全合法，否则返回错误文案的 key。
     * 设置态用它拦非法配置，绝不让月薪 0 / 工时 0 / 天数 0 / 非法时间进运行态。
     * @returns {{ ok:boolean, reason:string, value:{monthly:number,hours:number,days:number,start:string} }}
     */
    function validateSettings(raw) {
      const monthly = toNum(raw && raw.monthly)
      const hours = toNum(raw && raw.hours)
      const days = toNum(raw && raw.days)
      const start = raw && raw.start
      if (!Number.isFinite(monthly) || monthly <= 0) {
        return { ok: false, reason: 'error.invalidNumber', value: DEFAULT_SETTINGS }
      }
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
        return { ok: false, reason: 'error.invalidNumber', value: DEFAULT_SETTINGS }
      }
      if (!Number.isFinite(days) || days < 1 || days > 31) {
        return { ok: false, reason: 'error.invalidNumber', value: DEFAULT_SETTINGS }
      }
      if (parseHHMM(start) === null) {
        return { ok: false, reason: 'error.invalidTime', value: DEFAULT_SETTINGS }
      }
      return { ok: true, reason: '', value: { monthly, hours, days, start } }
    }

    /**
     * 读盘归一层：localStorage 里的 settings 可能是任何东西（别的插件、手改、旧版本）。
     * 逐字段校验、坏字段各自回默认值、整体不是对象就返回 null（= 无配置 → 设置态）。
     * 绝不抛。
     */
    function reviveSettings(parsed) {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      const monthly = toNum(parsed.monthly)
      const hours = toNum(parsed.hours)
      const days = toNum(parsed.days)
      const startOk = parseHHMM(parsed.start) !== null
      const out = {
        monthly: Number.isFinite(monthly) && monthly > 0 ? monthly : DEFAULT_SETTINGS.monthly,
        hours: Number.isFinite(hours) && hours > 0 && hours <= 24 ? hours : DEFAULT_SETTINGS.hours,
        days: Number.isFinite(days) && days >= 1 && days <= 31 ? days : DEFAULT_SETTINGS.days,
        start: startOk ? parsed.start : DEFAULT_SETTINGS.start,
      }
      return out
    }

    /** 读盘归一层：pos 只有「两个有限数」才采纳，其余退 null（= 用默认右下角）。 */
    function revivePos(parsed) {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      const x = Number(parsed.x)
      const y = Number(parsed.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null
      return { x, y }
    }

    /** 读盘归一层：collapsed 只认真正的 true。 */
    function reviveBool(parsed) {
      return parsed === true
    }

    /**
     * 把坐标夹回视口内，保证整块看板永远拖得回来（拖到屏幕外追不回来是最恶心的 bug）。
     * @returns {{ x:number, y:number }}  EDGE <= x <= innerWidth - w - EDGE（视口比卡片窄时退 EDGE）
     */
    function clampPos(x, y, w, h) {
      let vw = 1280
      let vh = 800
      try {
        if (typeof window !== 'undefined') {
          if (Number.isFinite(window.innerWidth)) vw = window.innerWidth
          if (Number.isFinite(window.innerHeight)) vh = window.innerHeight
        }
      } catch (err) {
        /* 拿不到视口就按默认值夹，不许抛 */
      }
      const cw = Number.isFinite(w) && w > 0 ? w : CARD_W
      const ch = Number.isFinite(h) && h > 0 ? h : H_RUNNING
      const maxX = Math.max(EDGE, vw - cw - EDGE)
      const maxY = Math.max(EDGE, vh - ch - EDGE)
      const nx = Number.isFinite(x) ? Math.min(Math.max(x, EDGE), maxX) : maxX
      const ny = Number.isFinite(y) ? Math.min(Math.max(y, EDGE), maxY) : maxY
      return { x: nx, y: ny }
    }

    // ======================================================================
    // SF-PURE-END   ↑↑↑ 单测抽取区终点
    // ======================================================================

    // ==========================================================================
    // 3. hook 区
    //    三个 hook 都必须成对回收：注册了什么，卸载前清掉什么。
    // ==========================================================================

    /** 安全地读 window.localStorage；隐私模式下**访问属性本身**都可能抛，所以整段包住。 */
    function readRaw(key) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return null
        return window.localStorage.getItem(key)
      } catch (err) {
        return null
      }
    }

    /** 安全地写 window.localStorage；配额满 / 隐私模式会抛，抛了只影响持久化，绝不能崩看板。 */
    function writeRaw(key, value) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch (err) {
        /* 忽略：存不下就存不下，界面照常 */
      }
    }

    /**
     * 2 秒结算时钟。返回当前时间戳（epoch ms），每 periodMs 变一次。
     *
     * @param {boolean} active     false 时完全停表（没有配置 / 设置态，不烧 CPU）
     * @param {number} [periodMs]  结算周期，默认 SETTLE_MS；收工后传 IDLE_MS 低频「跨天醒来」
     * @returns {number}
     *
     * 三条都不能省：
     *   1. 可见性暂停：document.visibilityState === 'hidden' 时 clearInterval；
     *      visibilitychange 回前台**立刻补一次 tick** 再重装表，否则用户切回来要干等最多 2 秒。
     *   2. 卸载必清：useEffect 的 cleanup 里 clearInterval + removeEventListener，一个都不能少。
     *   3. 绝对时间重算：每次 tick 读 Date.now() 重新 calc，绝不 earned += 时薪/1800 累加。
     */
    function useTick(active, periodMs) {
      const period = Number.isFinite(periodMs) && periodMs >= 250 ? periodMs : SETTLE_MS
      const [now, setNow] = useState(() => Date.now())

      useEffect(() => {
        if (!active) return undefined
        let timer = null

        const stop = () => {
          if (timer !== null) {
            clearInterval(timer)
            timer = null
          }
        }
        const start = () => {
          stop()
          timer = setInterval(() => setNow(Date.now()), period)
        }
        const hidden = () => {
          try {
            return typeof document !== 'undefined' && document.visibilityState === 'hidden'
          } catch (err) {
            return false
          }
        }
        const onVisibility = () => {
          if (hidden()) {
            stop()
          } else {
            setNow(Date.now()) // 回前台先补一帧，别让用户干等
            start()
          }
        }

        setNow(Date.now()) // 装上表先对齐一次，避免第一跳延迟 2 秒
        if (!hidden()) start()

        try {
          if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', onVisibility)
          }
        } catch (err) {
          /* 挂不上监听也照跑 */
        }

        return () => {
          stop() // ← 与 setInterval 成对
          try {
            if (typeof document !== 'undefined') {
              document.removeEventListener('visibilitychange', onVisibility)
            }
          } catch (err) {
            /* 已卸载环境，忽略 */
          }
        }
      }, [active, period])

      return now
    }

    /**
     * 一个键一份持久化。初值 lazy 读盘（只读一次），写盘在 effect 里；读写都 try/catch。
     *
     * @param {string} key       必须 LS_PREFIX 开头的键名
     * @param {T} initial        读不到 / 解析失败 / 类型不对时的兜底
     * @param {(parsed:any)=>T} [revive]  归一层；返回 initial 即「视为无值」
     * @returns {[T, (next:T|((prev:T)=>T)) => void]}
     *
     * 约定：`value === null/undefined` 时**不写盘**。这样 settings/pos 在用户没配置过、没拖动过
     * 的时候不会凭空造出一个键出来（首次判定靠「键不存在」，写脏了就再也判不出首次）。
     */
    function usePersisted(key, initial, revive) {
      const [value, setValue] = useState(() => {
        try {
          const raw = readRaw(key)
          if (raw === null || raw === undefined) return initial
          const parsed = JSON.parse(raw)
          if (typeof revive === 'function') {
            const revived = revive(parsed)
            return revived === undefined ? initial : revived
          }
          return parsed === undefined ? initial : parsed
        } catch (err) {
          return initial // 坏 JSON / 隐私模式 → 一律回落兜底值，绝不抛
        }
      })

      useEffect(() => {
        if (value === null || value === undefined) return
        writeRaw(key, value)
      }, [key, value])

      return [value, setValue]
    }

    /**
     * 极简订阅容器：get / set / subscribe。
     *
     * 为什么不用 React state 直接共享：看板本体在 `shell.overlay`，顶栏胶囊在
     * `conversation.session.header.utilities` —— 两个互不相干的组件子树，props 传不过去，
     * 只有模块作用域能共享。factory 每个页面只跑一次，所以这里就是「跨槽位的唯一真相」。
     */
    function makeStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get() {
          return value
        },
        set(next) {
          const v = typeof next === 'function' ? next(value) : next
          if (v === value) return
          value = v
          listeners.forEach((fn) => {
            try {
              fn()
            } catch (err) {
              /* 一个订阅者炸了不能连累另一个 */
            }
          })
        },
        subscribe(fn) {
          listeners.add(fn)
          return () => {
            listeners.delete(fn) // 成对：卸载即退订
          }
        },
      }
    }

    /** 订阅容器 → React state（首帧直接取容器值，不会先闪一帧空的设置态）。 */
    function useStore(store) {
      const [value, setValue] = useState(() => store.get())
      useEffect(() => store.subscribe(() => setValue(() => store.get())), [store])
      return value
    }

    /**
     * 跨槽位共享状态（懒初始化，第一次渲染读一次盘）：
     *   settings  —— 看板与顶栏胶囊必须看到同一份配置，不能各存各的
     *   where     —— 'board'（浮层）| 'dock'（缩进右上角顶栏），落盘记忆
     *   dockReady —— 顶栏胶囊是否已挂载（给浮层的兜底胶囊让位）
     */
    let SHARED = null
    function getShared() {
      if (SHARED) return SHARED

      let settings = null
      try {
        const raw = readRaw(LS_SETTINGS)
        if (raw !== null && raw !== undefined) settings = reviveSettings(JSON.parse(raw))
      } catch (err) {
        settings = null
      }

      let where = VIEW_BOARD
      try {
        const rawView = readRaw(LS_VIEW)
        if (rawView !== null && rawView !== undefined && JSON.parse(rawView) === VIEW_DOCK) where = VIEW_DOCK
      } catch (err) {
        where = VIEW_BOARD
      }

      SHARED = {
        store: makeStore({ settings, where, dockReady: false }),
        /** 写配置：先更内存（两个槽位立即同步），再落盘（空值不落盘，与 usePersisted 约定一致）。 */
        setSettings(next) {
          SHARED.store.set((prev) => ({ settings: next, where: prev.where, dockReady: prev.dockReady }))
          if (next !== null && next !== undefined) writeRaw(LS_SETTINGS, next)
        },
        setWhere(next) {
          const target = next === VIEW_DOCK ? VIEW_DOCK : VIEW_BOARD
          SHARED.store.set((prev) => ({ settings: prev.settings, where: target, dockReady: prev.dockReady }))
          writeRaw(LS_VIEW, target)
        },
        setDockReady(next) {
          const flag = next === true
          if (SHARED.store.get().dockReady === flag) return
          SHARED.store.set((prev) => ({ settings: prev.settings, where: prev.where, dockReady: flag }))
        },
      }
      return SHARED
    }

    /**
     * 语言：**默认中文**，不跟随宿主 locale。
     *
     * 为什么不再猜宿主语言：这块牌子是给人每天盯的，宿主 locale 是 en-US 时整块变英文，
     * 用户看不懂也切不回来。现在默认 zh，需要英文的人在设置里点一下，选择存 localStorage。
     * @returns {{ lang:'zh'|'en', setLang:(next:'zh'|'en')=>void }}
     */
    function useLang() {
      const [lang, setLang] = usePersisted(LS_LANG, 'zh', (v) => (v === 'zh' || v === 'en' ? v : 'zh'))
      return useMemo(() => ({ lang, setLang }), [lang, setLang])
    }

    /** prefers-reduced-motion: reduce 是否生效（随系统设置变化重算；拿不到就当 false）。 */
    function useReducedMotion() {
      const [reduced, setReduced] = useState(() => {
        try {
          if (typeof window === 'undefined' || !window.matchMedia) return false
          return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
        } catch (err) {
          return false
        }
      })

      useEffect(() => {
        let mql = null
        const onChange = () => {
          try {
            setReduced(mql ? mql.matches === true : false)
          } catch (err) {
            /* 忽略 */
          }
        }
        try {
          if (typeof window !== 'undefined' && window.matchMedia) {
            mql = window.matchMedia('(prefers-reduced-motion: reduce)')
            if (mql && typeof mql.addEventListener === 'function') {
              mql.addEventListener('change', onChange)
            } else if (mql && typeof mql.addListener === 'function') {
              mql.addListener(onChange) // 老 Safari
            }
          }
        } catch (err) {
          mql = null
        }
        return () => {
          try {
            if (!mql) return
            if (typeof mql.removeEventListener === 'function') {
              mql.removeEventListener('change', onChange) // ← 与 addEventListener 成对
            } else if (typeof mql.removeListener === 'function') {
              mql.removeListener(onChange)
            }
          } catch (err) {
            /* 已卸载环境，忽略 */
          }
        }
      }, [])

      return reduced
    }

    // ==========================================================================
    // 4. 组件区
    //    渲染顺序：SalaryFlap（根）→ CollapsedBar / RunningCard / SetupCard → DigitRow → SplitFlap。
    // ==========================================================================

    /**
     * 一张单片翻牌，四层叠放。**层角色最容易搞反，照抄这张表**：
     *   ① 静止上半 .sf-half--top    = 新值 ch      （一直在，翻动期被 ③ 盖住）
     *   ② 静止下半 .sf-half--bottom = 旧值 prevCh  （静默期露出）
     *   ③ 翻动上半 .sf-flip--top    = 旧值 prevCh  ，0 → -90°，铰链 bottom center
     *   ④ 翻动下半 .sf-flip--bottom = 新值 ch      ，+90° → 0°，铰链 top center，延迟一个 HALF_MS
     * 把 ① 和 ② 弄反，症状是「翻完之后又跳回旧值一次」。
     *
     * @param {{ ch:string, prevCh:string, flipping:boolean, delayMs:number, reduced:boolean }} props
     */
    function SplitFlap(props) {
      const ch = typeof props.ch === 'string' ? props.ch : ''
      const prevCh = typeof props.prevCh === 'string' ? props.prevCh : ch
      const delayMs = Number.isFinite(props.delayMs) ? Math.max(0, props.delayMs) : 0
      const flipping =
        props.flipping === true && props.reduced !== true && isDigit(ch) && prevCh !== ch

      const glyph = (text) => h('span', { className: 'sf-glyph' }, text)
      const topHalf = h('span', { className: 'sf-half sf-half--top' }, glyph(ch)) // ① 新值
      const bottomHalf = h(
        'span',
        { className: 'sf-half sf-half--bottom' },
        glyph(flipping ? prevCh : ch), // ② 翻动期放旧值（被 ④ 慢慢盖住），静默期就是当前值
      )

      const layers = [topHalf, bottomHalf]
      if (flipping) {
        // 翻动层的 key 必须随 (旧值, 新值) 变：8 → 9 之后又回 8，靠 key 才能重播 animation。
        layers.push(
          h(
            'span',
            {
              key: 'fold-' + prevCh + '-' + ch,
              className: 'sf-flip sf-flip--top',
              style: { '--sf-delay': delayMs + 'ms' },
            },
            glyph(prevCh), // ③ 旧值：上半页沿底边下翻
          ),
        )
        layers.push(
          h(
            'span',
            {
              key: 'unfold-' + prevCh + '-' + ch,
              className: 'sf-flip sf-flip--bottom',
              style: { '--sf-delay': delayMs + 'ms' }, // CSS 里再 + HALF_MS，构成两段式
            },
            glyph(ch), // ④ 新值：下半页从侧立翻回
          ),
        )
      }

      // 空槽（T7 P2 #6）：模板格里「位数不足」的位（' ' / U+00A0 / 空串）只占宽度、不画牌面，
      // 于是 ¥9.99 → ¥10.00 时 `¥` 与小数点位置不动，整行也不横移。
      const blank = ch === '' || ch === ' ' || ch === '\u00a0'
      const cls = 'sf-slat' + (blank ? ' is-blank' : '') + (props.tight === true ? ' is-tight' : '')
      return h('span', { className: cls, 'aria-hidden': 'true' }, layers)
    }

    /**
     * 一整行金额：slotify 成定宽格子，只有 changedSlots 里的位翻；其余位保持静止。
     *
     * @param {{ text:string, prevText:string, reduced:boolean, rise:boolean }} props
     *        prevText 由父层持有「上一帧的金额文本」，翻完由父层的定时器把 prevText 推平成 text
     *        （那样翻动层自然卸载，露出静默态），所以本组件自己不需要任何定时器。
     */
    function DigitRow(props) {
      const text = typeof props.text === 'string' ? props.text : '¥0.00'
      const reduced = props.reduced === true
      const prevText = typeof props.prevText === 'string' ? props.prevText : text
      // 固定模板格（T7 P2 #6）：¥ / 整数位 / . / 小数位各占固定列，位数不足补空槽，
      // 所以整行宽度恒定、`¥` 不会随位数瞬移，只有 moneySlots 里真正变的数字位才翻。
      const nextSlots = moneySlots(text)
      const prevSlots = moneySlots(prevText)
      const changed = reduced || prevText === text ? [] : changedSlots(prevSlots, nextSlots)
      const rowClass = 'sf-row' + (props.rise === true && !reduced ? ' is-rise' : '')

      const cells = nextSlots.map((ch, i) => {
        const flipping = changed.indexOf(i) >= 0
        return h(SplitFlap, {
          key: 'slat-' + i + '-' + ch,
          ch,
          // 0 号是 ¥、整数位之后那格是小数点：都占窄格
          tight: i === 0 || i === INT_SLOT_COUNT + 1,
          prevCh: flipping ? prevSlots[i] || '' : ch,
          flipping,
          delayMs: flipping ? delayOf(i, nextSlots) : 0,
          reduced,
        })
      })

      return h('div', { className: rowClass }, cells)
    }

    /**
     * 让 Host 半边把看板弹成一个**真窗口**（能拖到 DSH 外面、置顶在别的应用上）。
     *
     * 客户端渲染层没有开窗权限（主窗口 setWindowOpenHandler 直接 deny），所以这条路由是
     * 由 Host 半边用 Electron BrowserWindow 实现的。这里只发请求：
     * 拿不到接口 / 不是 Electron / 报错，一律降级成一句提示，绝不让界面卡住或抛出去。
     * @returns {Promise<{ok:boolean, reason?:string}|null>} null = 连请求都没发出去
     */
    function postHost(path, body) {
      try {
        const res = fetch('/plugins/dsh-salary-flap/' + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
        if (!res || typeof res.then !== 'function') return Promise.resolve(null)
        return res.then((r) => r.json()).catch(() => null)
      } catch (err) {
        return Promise.resolve(null)
      }
    }

    /**
     * 配色选择：六颗圆点，点一下立刻换色。
     * 不弹菜单、不占地方 —— 用户要的是「能改颜色」，不是「配置面板」。
     * 圆点填充 = 那套配色的强调色，描边 = 它的边框色，一眼能认出是哪套。
     */
    function ThemePick(props) {
      const t = props.t
      return h(
        'div',
        { className: 'sf-swabs', role: 'group', 'aria-label': t('button.theme') },
        THEMES.map((th) =>
          h('button', {
            key: th.id,
            type: 'button',
            className: 'sf-swab' + (props.theme === th.id ? ' is-active' : ''),
            style: { background: th.accent, borderColor: th.border },
            title: t('theme.' + th.id),
            'aria-label': t('theme.' + th.id),
            'aria-pressed': props.theme === th.id,
            onPointerDown: (e) => e.stopPropagation(),
            onClick: (e) => {
              e.stopPropagation()
              if (typeof props.onTheme === 'function') props.onTheme(th.id)
            },
          }),
        ),
      )
    }

    /** 语言二选一。只在设置态出现：平时不该被误碰。 */
    function LangPick(props) {
      const t = props.t
      const one = (id) =>
        h(
          'button',
          {
            key: id,
            type: 'button',
            className: 'sf-lang' + (props.lang === id ? ' is-active' : ''),
            'aria-pressed': props.lang === id,
            onClick: (e) => {
              e.stopPropagation()
              if (typeof props.onLang === 'function') props.onLang(id)
            },
          },
          id === 'zh' ? '中文' : 'EN',
        )
      return h('div', { className: 'sf-langs', role: 'group', 'aria-label': t('button.lang') }, one('zh'), one('en'))
    }

    /**
     * 设置态卡片（首次出现就是它，不用先点齿轮）。
     *
     * 要点：三个数字输入 + 上班时间 + 配色 + 语言 + 「开始跳」；非法输入行内报错并禁用按钮，
     * 不许把非法配置放行到运行态（月薪 0 / 工时 0 / 天数 0 / 时间串非法）。
     */
    function SetupCard(props) {
      const t = props.t
      const drag = props.dragHandlers || {}
      const initial = props.initial || DEFAULT_SETTINGS
      const [monthly, setMonthly] = useState(() => String(initial.monthly))
      const [hours, setHours] = useState(() => String(initial.hours))
      const [days, setDays] = useState(() => String(initial.days))
      const [start, setStart] = useState(() =>
        parseHHMM(initial.start) === null ? DEFAULT_SETTINGS.start : initial.start,
      )
      const [touched, setTouched] = useState(false)

      const check = validateSettings({ monthly, hours, days, start })

      const submit = () => {
        setTouched(true)
        if (!check.ok) return
        try {
          if (typeof props.onSubmit === 'function') props.onSubmit(check.value)
        } catch (err) {
          /* 提交回调抛了也不能让渲染树倒掉 */
        }
      }
      const cancel = () => {
        try {
          if (typeof props.onCancel === 'function') props.onCancel()
        } catch (err) {
          /* 同上 */
        }
      }
      const onKeyDown = (e) => {
        if (e && e.key === 'Enter') {
          e.preventDefault()
          submit()
        }
      }
      const field = (id, label, value, setValue, extra) =>
        h(
          'div',
          { className: 'sf-field' },
          h('label', { htmlFor: id }, label),
          h(
            'input',
            Object.assign(
              {
                id,
                className: 'sf-input',
                type: 'text',
                inputMode: 'decimal',
                autoComplete: 'off',
                spellCheck: false,
                value,
                onChange: (e) => setValue(e.target.value),
                onKeyDown,
              },
              extra || {},
            ),
          ),
        )

      return h(
        'div',
        { className: 'sf-setup' },
        // 设置态也要能挪：标题行就是把手，复用与运行态同一套 pointer 事件 + clamp。
        h(
          'div',
          {
            className: 'sf-setup-title sf-handle',
            title: t('app.dragHint'),
            onPointerDown: drag.onPointerDown,
            onPointerMove: drag.onPointerMove,
            onPointerUp: drag.onPointerUp,
            onPointerCancel: drag.onPointerCancel,
          },
          h('span', { className: 'sf-title' }, t('setup.title')),
          h(ThemePick, { theme: props.theme, onTheme: props.onTheme, t }),
        ),
        h('div', { className: 'sf-caption', style: { marginBottom: '7px' } }, t('app.subtitle')),
        field('sf-monthly', t('setup.monthlyLabel') + '(' + t('unit.yuan') + ')', monthly, setMonthly),
        field('sf-hours', t('setup.hoursLabel') + '(' + t('unit.hour') + ')', hours, setHours),
        field('sf-days', t('setup.daysLabel') + '(' + t('unit.day') + ')', days, setDays),
        field('sf-start', t('setup.startLabel'), start, setStart, { type: 'time', inputMode: 'text' }),
        // 折算预览：三个数字一填就能看到时薪 / 日薪，免得盲填。
        // 只取 hourly / dailyWage 两个与 phase 无关的量，所以两次 Date.now() 取值不同也不会抖动。
        check.ok
          ? h(
              'div',
              { className: 'sf-line' },
              t('app.hourlyLabel') +
                ' ' +
                fmtMoney(calc(check.value, Date.now()).hourly) +
                ' · ' +
                t('app.dailyLabel') +
                ' ' +
                fmtMoney(calc(check.value, Date.now()).dailyWage),
            )
          : null,
        touched && !check.ok ? h('div', { className: 'sf-note' }, '⚠ ' + t(check.reason)) : null,
        h('div', { className: 'sf-field', style: { marginTop: '8px' } }, h('label', null, t('button.lang')), h(LangPick, {
          lang: props.lang,
          onLang: props.onLang,
          t,
        })),
        h(
          'div',
          { className: 'sf-actions' },
          props.onCancel
            ? h('button', { type: 'button', className: 'sf-btn', onClick: cancel }, t('button.cancel'))
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'sf-btn sf-btn--primary',
              disabled: !check.ok,
              onClick: submit,
            },
            props.onCancel ? t('button.save') : t('button.start'),
          ),
        ),
      )
    }

    /**
     * 倒计时的人类形态：不足 1 小时只给分钟，整小时不带「0 分」。
     * 单位全部走文案表（eta.*），不在代码里拼「分钟」「min」。
     */
    function fmtEta(ms, t) {
      const total = Math.max(0, Math.ceil(Number(ms) / 60000))
      if (!Number.isFinite(total)) return ''
      if (total < 60) return t('eta.minutes', { n: total })
      const hh = Math.floor(total / 60)
      const mm = total % 60
      return mm > 0 ? t('eta.hours', { n: hh, m: mm }) : t('eta.hourOnly', { n: hh })
    }

    /**
     * 「还没上班 / 今天收工了」两态的文案，带倒计时。
     *
     * 为什么必须带倒计时：这两态的金额按口径本来就不动（立项卡 §4），但用户盯着一串不动的
     * ¥0.00 只会以为坏了。倒计时每 2 秒刷新一次，看得见这块表还在走、几点开始赚。
     */
    function statusText(phase, view, now, t) {
      const isAfter = phase === 'after'
      const base = t(isAfter ? 'status.after' : 'status.before')
      const nextStart = Number(view && view.nextStart)
      const nowMs = Number(now)
      if (!Number.isFinite(nextStart) || nextStart <= 0 || !Number.isFinite(nowMs)) return base
      return t(isAfter ? 'status.afterEta' : 'status.beforeEta', { eta: fmtEta(nextStart - nowMs, t) })
    }

    /**
     * 运行态卡片：大号翻牌金额 + 「时薪 ¥xx.xx · 今日进度 xx%」+ 一排配色圆点 + 三个工具键。
     *
     * 要点：phase 只驱动文案与配色（before → 灰字提示、after → 绿字）。2 秒节拍由根组件的
     * useTick 负责，这里纯展示。工具键 = 设置 / 弹到桌面 / 收到顶栏。
     */
    function RunningCard(props) {
      const t = props.t
      const view = props.view || { earned: 0, hourly: 0, progress: 0, phase: 'before' }
      const drag = props.dragHandlers || {}
      const pct = Math.round(clampNum(view.progress, 0, 1) * 100)
      const phase = view.phase === 'after' ? 'after' : view.phase === 'working' ? 'working' : 'before'

      // 工具键统一一处：按下就 stopPropagation（把手收不到 pointerdown），并把 movedRef 复位
      // —— 否则上一次拖动留下的 true 会永久拦掉 onClick（T7 P1 的教训）。
      const tool = (glyph, label, onClick) =>
        h(
          'button',
          {
            type: 'button',
            className: 'sf-iconbtn',
            title: label,
            'aria-label': label,
            onPointerDown: (e) => {
              e.stopPropagation()
              if (drag.reset) drag.reset()
            },
            onClick: (e) => {
              e.stopPropagation()
              if (typeof onClick === 'function') onClick()
            },
          },
          glyph,
        )

      return h(
        'div',
        { className: 'sf-card__inner' },
        h(
          'div',
          {
            className: 'sf-handle',
            title: t('app.dragHint'),
            onPointerDown: drag.onPointerDown,
            onPointerMove: drag.onPointerMove,
            onPointerUp: drag.onPointerUp,
            onPointerCancel: drag.onPointerCancel,
          },
          h('span', { className: 'sf-title' }, t('app.title')),
          // 配色圆点就在最上面：标题右边、工具键左边，点一下即时换色（不用进设置）
          h(ThemePick, { theme: props.theme, onTheme: props.onTheme, t }),
          h(
            'span',
            { className: 'sf-tools' },
            tool('\u2699', t('button.settings'), props.onSettings),
            // 弹到桌面（\u29c9）暂时不挂：当前宿主环境弹不出独立 Electron 窗口，
            // 挂一个点了就报错的按钮不如不挂。Host 侧路由（/plugins/dsh-salary-flap/open）
            // 与 postHost() 都还在，环境支持了把这一行加回来即可。
            tool('\u00d7', t('button.dock'), props.onDock),
          ),
        ),
        h(
          'div',
          { className: 'sf-body' },
          h('div', { className: 'sf-caption' }, t('app.earnedLabel')),
          h(
            'div',
            { className: 'sf-board' },
            h(DigitRow, {
              text: props.money,
              prevText: props.prevText,
              reduced: props.reduced === true,
              rise: props.rise === true,
            }),
          ),
          h(
            'div',
            {
              className: 'sf-line',
              // 无障碍：翻牌数字是 aria-hidden 的图形，进度与单位由这一行的 aria-label 补上
              'aria-label': t('app.progressLabel') + ' ' + pct + t('unit.percent'),
            },
            t('line.summary', { hourly: fmtMoney(view.hourly), progress: pct }),
          ),
          phase === 'before' || phase === 'after'
            ? h(
                'div',
                { className: 'sf-state' + (phase === 'after' ? ' is-after' : '') },
                statusText(phase, view, props.now, t),
              )
            : null,
          props.toast ? h('div', { className: 'sf-toast' }, props.toast) : null,
        ),
      )
    }

    /**
     * 顶栏胶囊（dock 态）：右上角会话工具条里的一颗小药丸，一颗呼吸灯 + 金额。
     * 点它就回浮层原位。`floating` 用于「顶栏槽位没人渲染」时的兜底胶囊。
     */
    function DockChip(props) {
      const t = props.t
      const view = props.view || { earned: 0, phase: 'before' }
      const money = fmtMoney(view.earned)
      const live = view.phase === 'working'
      return h(
        'button',
        {
          type: 'button',
          className: 'sf-chip' + (props.floating === true ? ' sf-chip--floating' : ''),
          title: t('button.undock'),
          'aria-label': t('button.undock') + ' ' + money,
          onClick: props.onUndock,
        },
        // 呼吸灯的节拍 = 结算节拍：上班中是绿点一闪一闪，静止态是灰点长亮。
        h('span', { className: 'sf-chip-dot' + (live ? ' is-live' : '') }),
        h('span', { className: 'sf-chip-money' }, money),
      )
    }

    /**
     * 顶栏槽位宿主（`conversation.session.header.utilities`，session 作用域的 list 槽位）。
     *
     * 只做三件事：非 dock 态返回 null 不占位；dock 态渲染胶囊；自己带一份 2 秒节拍
     * （看板收起后它才是唯一在结算的那个人）。
     */
    function DockSlotHost(props) {
      const shared = getShared()
      const snap = useStore(shared.store)
      const { lang } = useLang()
      const t = useMemo(() => makeT(lang), [lang])

      const hasSettings = snap.settings !== null && snap.settings !== undefined
      const activeSettings = hasSettings ? snap.settings : DEFAULT_SETTINGS
      const docked = snap.where === VIEW_DOCK

      const probe = calc(activeSettings, Date.now())
      const period = probe.phase === 'after' ? IDLE_MS : SETTLE_MS
      const now = useTick(hasSettings && docked, period)
      const view = useMemo(() => calc(activeSettings, now), [activeSettings, now])
      const onUndock = useCallback(() => shared.setWhere(VIEW_BOARD), [shared])

      // 挂载即登记「顶栏有人渲染」，浮层那边的兜底胶囊让位；卸载撤销。
      useEffect(() => {
        shared.setDockReady(true)
        return () => shared.setDockReady(false)
      }, [shared])

      if (!docked || !hasSettings) return null
      return h('span', { className: 'sf-chipwrap' }, h('style', { key: 'sf-css' }, CSS), h(DockChip, { view, onUndock, t }))
    }

    /**
     * 根组件：持有全部状态，决定两态渲染（设置 / 运行），挂 <style>，挂拖动，持配色与语言。
     *
     * ⚠ 两态必须是**同一棵树里的条件分支**，不能按状态换顶层组件：hook 一旦条件调用，
     * React 顺序错位，整块 overlay entry 会被宿主退役、看板静默消失。
     */
    function SalaryFlap(props) {
      // —— hooks 全部无条件调用（顺序固定，两态只是 return 里的分支）——
      const reduced = useReducedMotion()

      // 跨槽位共享（settings / where）：顶栏胶囊与这块看板必须看到同一份配置。
      const shared = getShared()
      const sharedSnap = useStore(shared.store)
      const settings = sharedSnap.settings
      const setSettings = shared.setSettings
      const docked = sharedSnap.where === VIEW_DOCK

      const [pos, setPos] = usePersisted(LS_POS, null, revivePos)
      const [themeId, setThemeId] = usePersisted(LS_THEME, DEFAULT_THEME, (v) =>
        typeof v === 'string' ? themeOf(v).id : DEFAULT_THEME,
      )
      const { lang, setLang } = useLang()
      const t = useMemo(() => makeT(lang), [lang])
      const theme = themeOf(themeId)

      const [editing, setEditing] = useState(false)
      const [toast, setToast] = useState('')
      const toastTimer = useRef(null)

      const hasSettings = settings !== null && settings !== undefined
      const activeSettings = hasSettings ? settings : DEFAULT_SETTINGS

      // 节拍：收工后降到 60s 只为「跨天醒来」；其余（上班前 / 上班中）保持 2s。
      // 为什么上班前不停表：停表就永远发现不了「到点了，该开始跳了」（倒计时也靠它刷新）。
      const probe = calc(activeSettings, Date.now())
      const period = probe.phase === 'after' ? IDLE_MS : SETTLE_MS
      // dock 态看板本体不渲染，节拍交给顶栏胶囊，这里停表（不多烧一个 2 秒定时器）。
      const now = useTick(hasSettings && !docked, period)
      const view = useMemo(() => calc(activeSettings, now), [activeSettings, now])

      // dock 兜底：缩进顶栏后若顶栏胶囊 500ms 内没挂载（会话没打开 → 会话作用域槽位不渲染），
      // 就在右上角浮一颗小胶囊，保证看板永远点得回来，不会「点没了」。
      const [rescue, setRescue] = useState(false)
      useEffect(() => {
        if (!docked || sharedSnap.dockReady === true) {
          setRescue(false)
          return undefined
        }
        const timer = setTimeout(() => setRescue(true), 500)
        return () => clearTimeout(timer) // ← 与 setTimeout 成对
      }, [docked, sharedSnap.dockReady])

      // 一句提示（弹窗成功 / 不支持），2.6 秒后自己消失；卸载时把定时器收掉。
      const say = useCallback((msg) => {
        setToast(msg)
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(''), 2600)
      }, [])
      useEffect(
        () => () => {
          if (toastTimer.current) clearTimeout(toastTimer.current)
        },
        [],
      )

      // 拖动：draft 只在拖动中出现；落盘只在 pointerup 做一次（不在 pointermove 里写盘）。
      const fallbackH = !hasSettings || editing ? H_SETUP : H_RUNNING

      // 真实高度：两个常量只是兜底，实测值来自 cardRef + ResizeObserver 的 offsetHeight。
      // 态切换会让高度变（约 246.5 → 131），只认常量就会把「距下 96px」算成 133px，并在
      // 点「开始跳」的瞬间让板子跳位。RO 必须成对 disconnect，不留观察者。
      const cardRef = useRef(null)
      const [measuredH, setMeasuredH] = useState(0)

      useEffect(() => {
        let ro = null
        try {
          const el = cardRef.current
          if (!el || typeof window === 'undefined' || typeof window.ResizeObserver !== 'function') return undefined
          const read = () => {
            const hh = el.offsetHeight
            if (Number.isFinite(hh) && hh > 0) setMeasuredH(hh)
          }
          read() // RO 首帧回调之前先同步量一次，别用兜底值算错位的右下角
          ro = new window.ResizeObserver(read)
          ro.observe(el)
        } catch (err) {
          ro = null
        }
        return () => {
          if (!ro) return
          try {
            ro.disconnect() // ← 与 observe 成对
          } catch (err) {
            /* 忽略 */
          }
        }
      }, [])

      const cardH = measuredH > 0 ? measuredH : fallbackH
      const drag = useDrag({ pos, setPos, size: { w: CARD_W, h: cardH } })

      // —— 金额翻牌窗口：父层记「上一帧的金额文本」，到点推平，翻动层自然卸载 ——
      const moneyText = fmtMoney(view.earned)
      const prevMoneyRef = useRef(moneyText)
      const [prevMoney, setPrevMoney] = useState(moneyText)
      const [rise, setRise] = useState(false)

      useEffect(() => {
        const from = prevMoneyRef.current
        prevMoneyRef.current = moneyText
        if (from === moneyText) return undefined
        setPrevMoney(from) // 旧值 → 两层翻动的内容
        setRise(!reduced)
        const nextSlots = moneySlots(moneyText)
        const changed = changedSlots(moneySlots(from), nextSlots)
        const maxDelay = changed.reduce((m, i) => Math.max(m, delayOf(i, nextSlots)), 0)
        const tRise = setTimeout(() => setRise(false), RISE_MS + 20)
        const tFlap = setTimeout(() => setPrevMoney(moneyText), FLAP_MS + maxDelay + 30)
        return () => {
          clearTimeout(tRise) // ← 与 setTimeout 成对
          clearTimeout(tFlap)
        }
      }, [moneyText, reduced])

      // 位置：memo 出来的默认右下角，再夹一遍（resize 之后也能拉回来，且不回写）。
      const defaultPos = useMemo(() => {
        let vw = 1280
        let vh = 800
        try {
          if (typeof window !== 'undefined') {
            vw = Number.isFinite(window.innerWidth) ? window.innerWidth : vw
            vh = Number.isFinite(window.innerHeight) ? window.innerHeight : vh
          }
        } catch (err) {
          /* 忽略 */
        }
        return { x: vw - CARD_W - DEFAULT_INSET.right, y: vh - cardH - DEFAULT_INSET.bottom }
      }, [cardH])

      const base = drag.draft || pos || defaultPos
      const safe = clampPos(base.x, base.y, CARD_W, cardH)

      const onSettings = useCallback(() => setEditing(true), [])
      const onSubmit = useCallback(
        (next) => {
          setSettings(next)
          setEditing(false)
        },
        [setSettings],
      )
      const onCancel = useCallback(() => setEditing(false), [])
      const onDock = useCallback(() => shared.setWhere(VIEW_DOCK), [shared])
      const onUndock = useCallback(() => shared.setWhere(VIEW_BOARD), [shared])
      const onTheme = useCallback((id) => setThemeId(themeOf(id).id), [setThemeId])
      const onLang = useCallback((id) => setLang(id === 'en' ? 'en' : 'zh'), [setLang])

      // 弹到桌面：Host 半边开一个真窗口。成功给一句提示，不支持也明说，不装死。
      const onPopout = useCallback(() => {
        if (!hasSettings) return
        postHost('open', { settings: activeSettings, theme: themeId, lang })
          .then((d) => say(d && d.ok === true ? t('toast.popped') : t('toast.noElectron')))
          .catch(() => say(t('toast.noElectron')))
      }, [hasSettings, activeSettings, themeId, lang, t, say])

      // 缩进顶栏：看板本体整块不渲染（节拍已停），只留样式与（必要时）兜底胶囊。
      if (docked) {
        return h(
          'div',
          { className: 'sf-layer' },
          h('style', { key: 'sf-css' }, CSS),
          rescue ? h(DockChip, { view, onUndock, t, floating: true }) : null,
        )
      }

      const body =
        !hasSettings || editing
          ? h(SetupCard, {
              initial: hasSettings ? settings : DEFAULT_SETTINGS,
              onSubmit,
              onCancel: hasSettings ? onCancel : null,
              dragHandlers: drag, // 设置态标题栏也是把手
              theme: themeId,
              onTheme,
              lang,
              onLang,
              t,
            })
          : h(RunningCard, {
              view,
              now,
              money: moneyText,
              prevText: prevMoney,
              reduced,
              rise,
              dragHandlers: drag,
              onSettings,
              onPopout,
              onDock,
              theme: themeId,
              onTheme,
              toast,
              t,
            })

      return h(
        'div',
        { className: 'sf-layer' },
        h('style', { key: 'sf-css' }, CSS),
        h(
          'div',
          {
            className: 'sf-card',
            ref: cardRef, // ResizeObserver 量它的 offsetHeight
            style: Object.assign(
              {
                left: safe.x + 'px',
                top: safe.y + 'px',
                width: CARD_W + 'px',
                pointerEvents: 'auto',
              },
              themeVars(theme), // 六套配色从这里进 CSS 变量
            ),
          },
          body,
        ),
      )
    }

    // ==========================================================================
    // 5. 交互区
    //    拖动（pointerdown/move/up + clamp 到视口内）。
    //    用 pointer 事件而不是 mouse 事件，触控板/触屏一套代码；用 setPointerCapture
    //    把 move/up 留在把手自己身上，抬手/取消/卸载都不留 window 级监听，天然不泄漏。
    // ==========================================================================

    /**
     * 拖动：按下记住起点与卡片当前渲染位置，移动只更新 draft（不写盘、不每帧读 DOM），
     * 抬起才 setPos 落盘。
     *
     * @param {{ pos:{x:number,y:number}|null, setPos:(next:{x:number,y:number})=>void,
     *           size:{w:number,h:number} }} params
     * @returns {{
     *   onPointerDown:Function, onPointerMove:Function, onPointerUp:Function,
     *   onPointerCancel:Function, dragging:boolean,
     *   draft:{x:number,y:number}|null, wasDragged:()=>boolean, reset:()=>void
     * }}
     *   draft —— 拖动中的实时位置（null = 没在拖）
     *   wasDragged —— 刚刚这次按下是否真的移动过（给 click 用，避免拖完误触发点击）
     */
    function useDrag(params) {
      const setPos = params && typeof params.setPos === 'function' ? params.setPos : null
      const [draft, setDraft] = useState(null)
      const dragRef = useRef(null)
      const movedRef = useRef(false)
      const lastRef = useRef(null)
      const sizeRef = useRef((params && params.size) || { w: CARD_W, h: H_RUNNING })
      const posRef = useRef((params && params.pos) || null)

      // 每次渲染同步最新尺寸 / 落盘位置，供事件回调读（回调是 useCallback 的，不重建也能读到新值）
      sizeRef.current = (params && params.size) || sizeRef.current
      posRef.current = (params && params.pos) || null

      const onPointerDown = useCallback((e) => {
        try {
          if (!e || typeof e.clientX !== 'number' || typeof e.clientY !== 'number') return
          if (typeof e.button === 'number' && e.button > 0) return // 只认主键
          const host =
            e.currentTarget && typeof e.currentTarget.closest === 'function'
              ? e.currentTarget.closest('.sf-card')
              : null
          const rect = host && typeof host.getBoundingClientRect === 'function'
            ? host.getBoundingClientRect()
            : null
          const originX = rect && Number.isFinite(rect.left)
            ? rect.left
            : posRef.current && Number.isFinite(posRef.current.x)
              ? posRef.current.x
              : EDGE
          const originY = rect && Number.isFinite(rect.top)
            ? rect.top
            : posRef.current && Number.isFinite(posRef.current.y)
              ? posRef.current.y
              : EDGE
          dragRef.current = { startX: e.clientX, startY: e.clientY, originX, originY }
          movedRef.current = false
          lastRef.current = { x: originX, y: originY }
          setDraft({ x: originX, y: originY })
          if (e.currentTarget && typeof e.currentTarget.setPointerCapture === 'function' && e.pointerId != null) {
            e.currentTarget.setPointerCapture(e.pointerId) // move/up 之后都回到这个把手
          }
        } catch (err) {
          /* 拖动失败不能影响渲染 */
        }
      }, [])

      const onPointerMove = useCallback((e) => {
        const d = dragRef.current
        if (!d || !e) return
        try {
          if (typeof e.clientX !== 'number' || typeof e.clientY !== 'number') return
          const dx = e.clientX - d.startX
          const dy = e.clientY - d.startY
          if (!movedRef.current && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) movedRef.current = true
          if (!movedRef.current) return // 3px 内当点击，别让齿轮/折叠键点不动
          const size = sizeRef.current || { w: CARD_W, h: H_RUNNING }
          const next = clampPos(d.originX + dx, d.originY + dy, size.w, size.h)
          lastRef.current = next
          setDraft(next)
        } catch (err) {
          /* 忽略 */
        }
      }, [])

      const finish = useCallback(
        (commit) => {
          const d = dragRef.current
          if (!d) return
          dragRef.current = null
          const wasMoved = movedRef.current
          const last = lastRef.current
          setDraft(null)
          if (commit && wasMoved && last && setPos) {
            try {
              setPos({ x: last.x, y: last.y }) // 抬手才写一次盘
            } catch (err) {
              /* 忽略 */
            }
          }
        },
        [setPos],
      )

      const onPointerUp = useCallback(
        (e) => {
          try {
            if (e && e.currentTarget && typeof e.currentTarget.releasePointerCapture === 'function' && e.pointerId != null) {
              e.currentTarget.releasePointerCapture(e.pointerId)
            }
          } catch (err) {
            /* 忽略 */
          }
          finish(true)
        },
        [finish],
      )

      const onPointerCancel = useCallback(
        (e) => {
          try {
            if (e && e.currentTarget && typeof e.currentTarget.releasePointerCapture === 'function' && e.pointerId != null) {
              e.currentTarget.releasePointerCapture(e.pointerId)
            }
          } catch (err) {
            /* 忽略 */
          }
          finish(true) // 取消也算落盘：至少别把卡片留在半途位置
        },
        [finish],
      )

      const wasDragged = useCallback(() => movedRef.current === true, [])

      /**
       * 复位「刚才拖动过」标记（T7 P1 #2）：齿轮 / 折叠键在自己的 pointerdown 里 stopPropagation，
       * 把手拿不到 pointerdown，就没人把它复位；拖过一次后 wasDragged() 会恒真，那些键从此点不动。
       */
      const reset = useCallback(() => {
        movedRef.current = false
      }, [])

      return {
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
        dragging: draft !== null,
        draft,
        wasDragged,
        reset,
      }
    }

    // ==========================================================================
    // 6. 注册区
    //    只注册一个槽位：shell.overlay，参数就是 name / id / order / label 四项。
    //    register 的第二个参数是 (slotProps) => ReactElement，**不是组件本身** ——
    //    直接传 SalaryFlap 会让宿主按组件签名调用它，看板要么不出现要么拿不到 ctx。
    // ==========================================================================

    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.register !== 'function') return

      // ① 浮层看板本体：shell.overlay（整帧 click-through，卡片自己 opt-in pointer-events）
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: 'salary-flap', order: 12, label: '工资跳板' },
          () => h(SalaryFlap, { runtime: ctx }),
        ),
      )

      // ② 右上角顶栏胶囊：conversation.session.header.utilities（session 作用域 list 槽位，
      //    注册键只有 id / order / label；order 30 排在 better-sidebar 的 10 / 20 右侧）
      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          { name: 'conversation.session.header.utilities', id: 'salary-flap-dock', order: 30, label: '工资跳板' },
          () => h(DockSlotHost, { runtime: ctx }),
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
