/**
 * 「工资跳板」Host 半边。
 *
 * 原来这里是空的（纯前端插件，计算/持久化/渲染全在浏览器里）。现在多了一样
 * Host 才能做的事：**开一个真窗口**。浏览器里的看板永远被 DSH 的页面框住，
 * 想让它脱离窗口浮在桌面上，必须由 Host 进程去要一个 BrowserWindow。
 *
 * 所以本文件只干三件事，别的一概不碰：
 *   1. 建一个窗口管理器（窗口的唯一宿主）；
 *   2. 把 4 条本机 HTTP 路由挂到 webServer 上，让浏览器半边能通过 HTTP 指挥这个窗口；
 *   3. 注册在 ctx.effect 里 —— 插件停用 / 重载时路由和窗口必须一起收掉，
 *      否则会留下一条指向死管理器的路由和一个关不掉的浮动窗口。
 *
 * 失败策略：整段 apply 里没有任何会让进程崩的东西。webServer 拿不到就只记一条 warn
 * （插件其余部分照常，主看板仍然是纯前端可用的）；路由注册失败在各条内部兜底。
 */
import { createWindowManager } from './lib/window.js'
import { registerRoutes } from './lib/routes.js'

/** 只声明需要 webServer；拿不到这个服务时 Cordis 会跳过 apply，而不是让插件挂掉。 */
export const inject = ['webServer']

/**
 * @param {import('cordis').Context} ctx
 */
export function apply(ctx) {
  const manager = createWindowManager({ logger: console })

  // 包一层 try/catch：注册路由是「有则更好」的增量能力，
  // 万一这台机器上的 webServer 形态不对（比如未来接口改名），
  // 也只有弹窗不可用，主看板不该跟着坏。
  try {
    ctx.effect(
      () => {
        const disposeRoutes = registerRoutes(ctx.webServer, manager)
        // 返回组合 disposer：先摘路由（不再接新请求），再关窗口、停定时器
        return () => {
          try {
            disposeRoutes()
          } catch {
            /* ignore */
          }
          try {
            manager.dispose()
          } catch {
            /* ignore */
          }
        }
      },
      'salary-flap: 本机路由 + 独立窗口',
    )
  } catch (error) {
    try {
      console.warn('[salary-flap] 路由挂载失败，弹窗功能不可用：' + (error && error.message ? error.message : 'unknown'))
    } catch {
      /* ignore */
    }
  }
}
