/**
 * 路由层的纯函数：本机来源守卫、JSON 收发、请求体归一。
 *
 * 为什么单独成一个文件：这些函数不碰 electron、不碰 webServer，只吃 req/res 和普通对象，
 * 所以可以在本机 node 里直接 import 跑自测（/tmp 里的路由自测就是这么用的）。
 * 带副作用的东西（开窗、写位置文件）一律不放这里。
 *
 * 归一规则的唯一来源是 client.js 的「2. 纯函数区」：月薪 > 0、工时 0 < h ≤ 24、
 * 天数 1 ≤ d ≤ 31、上班时间必须是严格 HH:MM。浏览器半边已经拦过一遍，这里再拦一遍，
 * 因为 HTTP 是公开给本机任何进程调的，不能假设调用方一定守规矩。
 */

/** 六套配色的 id。窗口页用 data-theme 切 CSS 变量，顺序与立项卡给的清单一致。 */
export const THEME_IDS = ['mono', 'green', 'wood', 'sky', 'night', 'sakura']

/** 主题缺失 / 不在白名单时的兜底：mono 是六套里最中性、亮暗都不会失礼的一套。 */
export const DEFAULT_THEME = 'mono'

/** 请求体上限：我们的 body 只有几百字节，64KiB 足够，也顺手挡住误发的巨大 payload。 */
const MAX_BODY = 64 * 1024

/**
 * 只服务本机回环。
 * 这个插件没有账号体系，也没有任何跨机需求，边界就是「只认 127.0.0.1 / ::1」。
 * 注意 ::ffff:127.0.0.1 这种 IPv4-mapped 形式，剥掉前缀再判。
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || !address) return false
  const text = address.startsWith('::ffff:') ? address.slice(7) : address
  return text === '::1' || text === '127.0.0.1' || /^127\./.test(text)
}

/** Host 头也得是本机名：挡住「用 DNS 重绑定把 127.0.0.1 伪装成别的域名」这一类。 */
export function isLocalHostHeader(host) {
  if (typeof host !== 'string' || !host) return false
  const name = host.replace(/:\d+$/, '').toLowerCase()
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

/**
 * 回 JSON。**这个函数自己绝不抛**：响应头可能已经发过（比如 handler 半路出错），
 * 那就只补一个 end()，别在错误处理路径上再炸一次。
 */
export function sendJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload === undefined ? {} : payload)
    if (!res || typeof res.writeHead !== 'function') return
    if (res.writableEnded || res.destroyed) return
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store', // 状态一直在变，绝不能被任何一层缓存住
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    try {
      if (res && !res.writableEnded) res.end()
    } catch {
      /* 连 end 都失败，只能放弃这一条连接 */
    }
  }
}

/**
 * 读 JSON 请求体。
 * 上抛的错误只有两种 message：'body-too-large' / 'bad-json'，调用方据此回 413 / 400，
 * 不需要分辨 node 的底层错误。
 */
export async function readJson(req) {
  return await new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body-too-large'))
        try {
          req.destroy()
        } catch {
          /* 已断开 */
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        // null / 数组 / 字符串都是合法 JSON，但不是我们想要的对象，统一退成空对象。
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
      } catch {
        reject(new Error('bad-json'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 'HH:mm' -> 当天 0 点起的分钟数；非法返回 null。
 * 严格正则 + 范围双校验，不让 Date 去猜（猜错就是「悄悄变成 0 点」，凭空算出一笔钱）。
 */
export function parseHHMM(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hh = Number(match[1])
  const mm = Number(match[2])
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
  return hh * 60 + mm
}

/** 分钟数 -> 'HH:mm'。用于把 '9:00' 这种省略前导零的写法归一，窗口页只认统一形态。 */
function fmtHHMM(minutes) {
  const hh = Math.floor(minutes / 60)
  const mm = minutes % 60
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0')
}

/**
 * 校验并归一 settings。
 * @returns {{monthly:number,hours:number,days:number,start:string}|null} null = 不可用
 */
export function normalizeSettings(raw) {
  if (!raw || typeof raw !== 'object') return null
  const monthly = Number(raw.monthly)
  const hours = Number(raw.hours)
  const days = Number(raw.days)
  const startMinutes = parseHHMM(raw.start)
  if (!Number.isFinite(monthly) || monthly <= 0) return null
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return null
  if (!Number.isFinite(days) || days < 1 || days > 31) return null
  if (startMinutes === null) return null
  return {
    monthly,
    hours,
    days,
    start: fmtHHMM(startMinutes),
  }
}

/**
 * 归一整个 /open /update 的 body：`{ settings, theme, lang }`。
 * settings 不合法就整包判 null（宁可让用户看到「参数无效」重填，也不弹一个算错钱的窗）；
 * theme / lang 不合法则**降级而不是失败**——它们只影响观感，没必要拦。
 *
 * @returns {{settings:{monthly:number,hours:number,days:number,start:string},theme:string,lang:'zh'|'en'}|null}
 */
export function normalizePayload(raw) {
  if (!raw || typeof raw !== 'object') return null
  const settings = normalizeSettings(raw.settings)
  if (!settings) return null
  const theme = THEME_IDS.indexOf(raw.theme) >= 0 ? raw.theme : DEFAULT_THEME
  const lang = raw.lang === 'en' ? 'en' : 'zh'
  return { settings, theme, lang }
}
