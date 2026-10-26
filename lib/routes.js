/**
 * 给浏览器半边调的 4 条本机 HTTP 路由。
 *
 * 前缀 `/plugins/dsh-salary-flap`，路由之间互不相交：
 *   POST /open   正文 {settings,theme,lang} → {ok:true} | {ok:false, reason}
 *   POST /close                              → {ok:true}
 *   POST /update 正文同 /open                → {ok:true, reason?}
 *   GET  /state                              → {open:boolean}
 *
 * 三条硬约束：
 *   1. **全部带 loopback guard**：插件没有账号体系，边界就是「只服务本机 GUI」；
 *   2. **返回值一律 JSON + cache-control: no-store**：状态一直在变，被缓存住就是「点了没反应」；
 *   3. **handler 里绝不抛**：任何异常都变成 {ok:false, reason}，让浏览器半边能给出人话提示，
 *      而不是一个 500 加空响应体（IT 小白看到的就是「坏了」）。
 *
 * 形状照抄 dsh-sort-out-the-thoughts/lib/routes.js（同槽位、实测可用的 Host 路由范式）。
 */
import { isLocalHostHeader, isLoopbackAddress, normalizePayload, readJson, sendJson } from './shared.js'

export const PREFIX = '/plugins/dsh-salary-flap'

/** 读 body：把两种底层错误翻成调用方能直接回给前端的原因码。 */
async function readBody(req) {
  try {
    return { ok: true, value: await readJson(req) }
  } catch (error) {
    const message = error && error.message
    return { ok: false, reason: message === 'body-too-large' ? 'body-too-large' : 'bad-json' }
  }
}

/** 取 Host 自己的 origin；取不到就空串（窗口页据此放弃 fetch 兜底，不影响关窗）。 */
function originOf(webServer) {
  try {
    const origin = webServer.getOrigin()
    return typeof origin === 'string' ? origin : ''
  } catch {
    return ''
  }
}

/**
 * 注册全部路由，返回一个 disposer 给 ctx.effect 收尾。
 *
 * @param {{register:Function, getOrigin?:Function}} webServer  Host 的 webServer 服务
 * @param {ReturnType<import('./window.js').createWindowManager>} manager  窗口管理器
 * @returns {() => void} 注销全部路由
 */
export function registerRoutes(webServer, manager) {
  const disposers = []

  const warn = (message) => {
    try {
      console.warn('[salary-flap] ' + message)
    } catch {
      /* ignore */
    }
  }

  /**
   * 注册一条路由。
   * 每条外面都包 try/catch：重复的 (kind,path) 会 throw，那是配置错误，
   * 但不该连累另外三条路由一起消失（三条能用总比四条全没强）。
   */
  const route = (pathSuffix, handler) => {
    try {
      const dispose = webServer.register({
        kind: 'exact',
        path: PREFIX + pathSuffix,
        handler: async (req, res) => {
          // ① 来源守卫：不是本机回环就直接 403，连 body 都不读
          if (!isLoopbackAddress(req.socket && req.socket.remoteAddress) || !isLocalHostHeader(req.headers.host)) {
            return sendJson(res, 403, { ok: false, reason: 'local-only' })
          }
          // ② 业务异常兜成 JSON，绝不把异常抛回 webServer
          try {
            await handler(req, res)
          } catch (error) {
            warn('路由 ' + pathSuffix + ' 处理失败：' + (error && error.message ? error.message : 'unknown'))
            sendJson(res, 500, { ok: false, reason: 'internal' })
          }
        },
      })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      warn('路由注册失败 ' + pathSuffix + '：' + (error && error.message ? error.message : 'unknown'))
    }
  }

  // ---- 弹窗 ----
  route('/open', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, reason: 'method' })
    const body = await readBody(req)
    if (!body.ok) return sendJson(res, body.reason === 'body-too-large' ? 413 : 400, { ok: false, reason: body.reason })
    const payload = normalizePayload(body.value)
    // 参数不合法就不弹窗：弹一个算错钱的窗，比不弹更糟
    if (!payload) return sendJson(res, 200, { ok: false, reason: 'bad-settings' })
    const result = await manager.open(payload, originOf(webServer))
    return sendJson(res, 200, result)
  })

  route('/close', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, reason: 'method' })
    const result = await manager.close()
    return sendJson(res, 200, result)
  })

  route('/update', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, reason: 'method' })
    const body = await readBody(req)
    if (!body.ok) return sendJson(res, body.reason === 'body-too-large' ? 413 : 400, { ok: false, reason: body.reason })
    const payload = normalizePayload(body.value)
    // 契约里 /update 的坏参数也是 ok:true + reason：主看板改设置时窗口不该因为一次坏输入就报错
    if (!payload) return sendJson(res, 200, { ok: true, reason: 'bad-settings' })
    const result = await manager.update(payload, originOf(webServer))
    return sendJson(res, 200, result)
  })

  // ---- 状态 ----
  // 契约写的是 GET /state；也接受 POST，因为「关窗后刷新一下」的调用方可能懒得区分方法。
  route('/state', async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, reason: 'method' })
    return sendJson(res, 200, manager.state())
  })

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 重复 dispose 不该炸 */
      }
    }
    disposers.length = 0
  }
}
