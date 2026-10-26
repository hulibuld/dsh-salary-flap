/**
 * 独立窗口的生命周期：拿 electron、开窗、改内容、关窗、记位置。
 *
 * 这一整个文件都在做「可能失败」的事，所以三条纪律：
 *   1. 任何一处都 try/catch，失败只回 {ok:false, reason}，绝不让异常冒到 DSH 主进程；
 *   2. electron 拿不到是**正常状态**（Host 未来可能跑在非 Electron 进程里），
 *      缓存成 null 后 /open 直接回 no-electron，其余路由照常工作；
 *   3. 窗口是本插件唯一的宿主资源，插件被停用/DSH 退出时必须关掉，不留孤儿窗口。
 *
 * electron 为什么两种路径都试：
 *   - 桌面版 DSH 的 Host 跑在 Electron 主进程里，Electron ≥ 28 支持主进程 ESM，
 *     所以 `import('electron')` 大概率能直接拿到内置模块；
 *   - 老版本 / 某些打包形态只有 CJS 通道，`createRequire` 兜底；
 *   - 还有一种坑：非 Electron 进程里如果装了 npm 的 electron 包，require 出来的
 *     只是一个可执行文件路径字符串，`BrowserWindow` 不存在 —— 所以必须校验
 *     `typeof BrowserWindow === 'function'`，不能只看「模块拿到了」。
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

/** window.html 与本文件同包，用 URL 相对解析，走符号链接安装也不会指错。 */
const WINDOW_HTML = fileURLToPath(new URL('../window.html', import.meta.url))

/** 窗口尺寸：与任务书的规格一致（280×176），也是主看板的卡片宽度。 */
const WINDOW_WIDTH = 280
const WINDOW_HEIGHT = 176

/** 位置文件只存两个数，写在 userData 下；读失败一律当没存过。 */
const POSITION_FILE = 'salary-flap-window.json'

/** electron 解析结果缓存：拿到就一直是它，拿不到就一直 null（本进程内不重试，避免每次调用都白试两遍）。 */
let electronProbe = null

/** 只认真的能用 BrowserWindow 的模块。 */
function usableElectron(mod) {
  return mod && typeof mod.BrowserWindow === 'function' ? mod : null
}

/**
 * 解析 electron。返回 null 表示「这个进程里没有 Electron，开不了真窗口」。
 * 结果缓存进 electronProbe，后续调用直接复用同一个 Promise。
 */
async function resolveElectron() {
  if (electronProbe) return electronProbe
  electronProbe = (async () => {
    // ① ESM：Electron 主进程内置模块
    try {
      const mod = await import('electron')
      const found = usableElectron(mod) || usableElectron(mod && mod.default)
      if (found) return found
    } catch {
      /* 非 Electron 进程里 import 会失败，属预期 */
    }
    // ② CJS：老版本 / 只有 require 通道时兜底
    try {
      const requireCjs = createRequire(import.meta.url)
      const found = usableElectron(requireCjs('electron'))
      if (found) return found
    } catch {
      /* 没有 electron 包，同样是预期 */
    }
    return null
  })()
  return electronProbe
}

/**
 * 建一个窗口管理器。整个插件只建一个，路由层只跟它打交道。
 *
 * @param {{ logger?: {warn?:Function, info?:Function} }} [options]
 */
export function createWindowManager(options = {}) {
  const logger = options && options.logger

  /** 当前窗口；null = 没开。 */
  let win = null
  /** 上一次成功推给窗口的内容指纹，内容没变就不重新加载（否则每 2 秒的 /update 都会白闪一次）。 */
  let lastKey = ''
  /** 最近一次收到的状态；窗口没开时只记下来，等 /open 或将来重开时用。 */
  let lastPayload = null
  /** Host 自身的 origin（如 http://127.0.0.1:49202），给窗口页的关窗兜底请求用。 */
  let origin = ''
  /** 解析出来的 electron，保存一份给「保存位置」这类同步小动作复用。 */
  let electronRef = null
  /** 位置写盘的防抖句柄；窗口拖动时 'moved' 会连发，不防抖会疯狂写盘。 */
  let saveTimer = null

  function log(kind, message) {
    try {
      const fn = logger && typeof logger[kind] === 'function' ? logger[kind] : null
      if (fn) fn.call(logger, '[salary-flap] %s', message)
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  function isOpen() {
    try {
      return !!win && !win.isDestroyed()
    } catch {
      return false
    }
  }

  /** 内容指纹：settings / theme / lang 三者决定窗口里显示什么，origin 用于关窗兜底。 */
  function stateKey(payload) {
    try {
      return JSON.stringify({
        settings: payload && payload.settings,
        theme: payload && payload.theme,
        lang: payload && payload.lang,
        origin,
      })
    } catch {
      return ''
    }
  }

  /** 喂给窗口页的完整状态（写进 location.hash）。 */
  function hashPayload(payload) {
    return encodeURIComponent(
      JSON.stringify({
        settings: payload && payload.settings,
        theme: payload && payload.theme,
        lang: payload && payload.lang,
        origin,
      }),
    )
  }

  /** 位置文件路径；app 还没 ready / 取不到一律返回 ''（表示这次就不落盘了）。 */
  function positionPath(electron) {
    try {
      const app = electron && electron.app
      if (!app || typeof app.getPath !== 'function') return ''
      const dir = app.getPath('userData')
      if (typeof dir !== 'string' || !dir) return ''
      return path.join(dir, POSITION_FILE)
    } catch {
      return ''
    }
  }

  /**
   * 把记下来的位置夹回可见区域。
   * 场景：上次把窗口拖到外接屏，这次只接着内屏 —— 不夹的话窗口会开在看不见的地方，
   * 对 IT 小白来说等于「点了没反应」。拿不到 screen 就原样返回，不猜。
   */
  function clampToVisible(electron, point) {
    try {
      const screen = electron && electron.screen
      if (!screen || typeof screen.getDisplayNearestPoint !== 'function') return point
      const area = screen.getDisplayNearestPoint(point).workArea
      if (!area) return point
      const maxX = area.x + Math.max(area.width - WINDOW_WIDTH, 0)
      const maxY = area.y + Math.max(area.height - WINDOW_HEIGHT, 0)
      return {
        x: Math.round(Math.min(Math.max(point.x, area.x), maxX)),
        y: Math.round(Math.min(Math.max(point.y, area.y), maxY)),
      }
    } catch {
      return point
    }
  }

  /** 读上次的位置；任何异常都当没存过（例如用户手改坏了 json）。 */
  function readPosition(electron) {
    try {
      const file = positionPath(electron)
      if (!file) return null
      const text = fs.readFileSync(file, 'utf8')
      const parsed = JSON.parse(text)
      const x = Number(parsed && parsed.x)
      const y = Number(parsed && parsed.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null
      return clampToVisible(electron, { x: Math.round(x), y: Math.round(y) })
    } catch {
      return null
    }
  }

  /** 立即把当前窗口位置写盘。失败只记一条 warn，不影响任何用户可见行为。 */
  function savePositionNow() {
    try {
      if (!isOpen() || !electronRef) return
      const [x, y] = win.getPosition()
      if (!Number.isFinite(x) || !Number.isFinite(y)) return
      const file = positionPath(electronRef)
      if (!file) return
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ x, y }), 'utf8')
    } catch (error) {
      log('warn', '位置写盘失败（不影响使用）：' + (error && error.message ? error.message : 'unknown'))
    }
  }

  function scheduleSavePosition() {
    try {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        saveTimer = null
        savePositionNow()
      }, 400)
    } catch {
      /* 定时器都建不起来就不记位置，不影响窗口 */
    }
  }

  /** 把内容推进窗口：内容没变就只前置，变了才重新加载（hash 变化由窗口页 hashchange 接住）。 */
  async function pushState(payload, shouldFocus) {
    if (!isOpen()) return
    const key = stateKey(payload)
    try {
      if (key !== lastKey) {
        lastKey = key
        await win.loadFile(WINDOW_HTML, { hash: hashPayload(payload) })
      }
      if (shouldFocus) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
    } catch (error) {
      // 加载失败不该让 /open 变成 500：窗口还在，下次 /update 会再试
      log('warn', '窗口内容更新失败：' + (error && error.message ? error.message : 'unknown'))
      throw error
    }
  }

  /** 新建窗口。失败时清干净已经建了一半的窗口，再往上抛，由 open() 兜成 {ok:false}。 */
  async function createWindow(electron, payload) {
    const position = readPosition(electron)
    const windowOptions = {
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: true,
      // 先别显示，等页面画好再 show：透明窗口先显示会闪一下白底
      show: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // 这块表每 2 秒跳一次。默认的后台节流会把「被遮住/失焦」的窗口定时器压到分钟级，
        // 那样金额就不是 2 秒结算了，所以这里必须关掉节流。
        backgroundThrottling: false,
      },
    }
    if (position) {
      windowOptions.x = position.x
      windowOptions.y = position.y
    }

    const created = new electron.BrowserWindow(windowOptions)
    win = created
    electronRef = electron
    lastKey = stateKey(payload)

    try {
      // 'floating' 层级：浮在普通窗口之上，但不像 'screen-saver' 那样抢全屏内容
      created.setAlwaysOnTop(true, 'floating')
    } catch {
      /* 老版本/非 mac 上第二个参数可能不认，ignore */
    }

    // 页面不许自己开新窗口（窗口页是我们自写的静态文件，这条只是保险）
    try {
      created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    } catch {
      /* ignore */
    }

    created.once('ready-to-show', () => {
      try {
        if (!created.isDestroyed()) {
          created.show()
          created.focus()
        }
      } catch (error) {
        log('warn', '窗口显示失败：' + (error && error.message ? error.message : 'unknown'))
      }
    })

    created.on('moved', scheduleSavePosition)

    created.on('closed', () => {
      // 用户点 ×、或系统销毁窗口都会走到这里：把内存态清干净，/state 才会老实报 open:false
      if (win === created) {
        win = null
        lastKey = ''
      }
      savePositionNow()
      log('info', '独立窗口已关闭')
    })

    await created.loadFile(WINDOW_HTML, { hash: hashPayload(payload) })
    return created
  }

  /** 销毁窗口（插件停用、或建窗失败收尾）。不抛。 */
  function destroyWindow() {
    try {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
    } catch {
      /* ignore */
    }
    savePositionNow()
    try {
      if (win && !win.isDestroyed()) {
        win.removeAllListeners('closed')
        win.destroy()
      }
    } catch {
      /* 已经没了 */
    }
    win = null
    lastKey = ''
  }

  return {
    /**
     * POST /open：开窗；已开着就换内容并前置。
     * @returns {Promise<{ok:boolean, reason?:string}>}
     */
    async open(payload, nextOrigin) {
      lastPayload = payload
      if (typeof nextOrigin === 'string' && nextOrigin) origin = nextOrigin

      const electron = await resolveElectron()
      if (!electron) return { ok: false, reason: 'no-electron' }
      electronRef = electron

      try {
        if (isOpen()) {
          await pushState(payload, true)
          return { ok: true }
        }
        await createWindow(electron, payload)
        log('info', '独立窗口已打开')
        return { ok: true }
      } catch (error) {
        log('warn', '开窗失败：' + (error && error.message ? error.message : 'unknown'))
        destroyWindow()
        return { ok: false, reason: 'create-failed' }
      }
    },

    /**
     * POST /update：只改内容。窗口没开就只记状态（契约要求这种情况也回 ok:true）。
     * @returns {Promise<{ok:boolean, reason?:string}>}
     */
    async update(payload, nextOrigin) {
      lastPayload = payload
      if (typeof nextOrigin === 'string' && nextOrigin) origin = nextOrigin
      if (!isOpen()) return { ok: true }
      const electron = electronRef || (await resolveElectron())
      if (!electron) return { ok: true, reason: 'no-electron' }
      electronRef = electron
      try {
        await pushState(payload, false)
        return { ok: true }
      } catch (error) {
        return { ok: true, reason: 'update-failed' }
      }
    },

    /** POST /close：关窗。本来就没开也回 ok:true（幂等，调用方不用先查 /state）。 */
    async close() {
      try {
        if (isOpen()) {
          savePositionNow()
          win.close()
        }
      } catch (error) {
        log('warn', '关窗失败，改为强拆：' + (error && error.message ? error.message : 'unknown'))
        destroyWindow()
      }
      return { ok: true }
    },

    /** GET /state：只报开没开。 */
    state() {
      return { open: isOpen() }
    },

    /** 插件卸载时收尾：关窗 + 停定时器。 */
    dispose() {
      destroyWindow()
      lastPayload = null
      origin = ''
    },

    /** 最近一次状态（给将来可能的重开/调试用，路由层目前不读）。 */
    lastState() {
      return lastPayload
    },
  }
}
