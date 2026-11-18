import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { WebSocket } from 'ws'
import { panelDir, ensureDirs } from './settings.js'
import { fetchBuffer, extractZip } from './download.js'

/** 临时面板统一前缀，同时也是 WS 处理器在 Bot.wsf 里的 key */
export const PREFIX = '/pp'

/** 挂在 globalThis 上，插件热重载不会把已发出去的链接一起弄失效 */
const sessions = (globalThis.__clashPanelSessions ??= new Map())

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const same = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

/**
 * 新建一个临时会话。超过上限时踢掉最早的那个，避免有人连点刷爆内存。
 * token 只在内存里，进程重启即全部失效。
 */
export function createSession(ttlMinutes = 30, maxSessions = 5) {
  while (sessions.size >= Math.max(1, maxSessions)) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
    if (!oldest) break
    clearTimeout(oldest[1].timer)
    sessions.delete(oldest[0])
  }
  const token = crypto.randomBytes(24).toString('hex')
  const ttl = Math.max(1, ttlMinutes) * 60e3
  const session = { createdAt: Date.now(), expiresAt: Date.now() + ttl }
  session.timer = setTimeout(() => sessions.delete(token), ttl)
  session.timer.unref?.()
  sessions.set(token, session)
  return { token, expiresAt: session.expiresAt }
}

export function destroyAllSessions() {
  const count = sessions.size
  for (const [, s] of sessions) clearTimeout(s.timer)
  sessions.clear()
  return count
}

export function listSessions() {
  const now = Date.now()
  return [...sessions.values()].map(s => Math.max(0, s.expiresAt - now))
}

export function parsePath(url) {
  const pathname = String(url || '').split('?')[0]
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] !== 'pp' || parts.length < 2) return null
  return { token: parts[1], rest: parts.slice(2).join('/') }
}

function findSession(token) {
  if (!token) return null
  for (const [key, session] of sessions) {
    if (!same(key, token)) continue
    if (session.expiresAt < Date.now()) {
      clearTimeout(session.timer)
      sessions.delete(key)
      return null
    }
    return session
  }
  return null
}

/** 下载 zashboard 静态文件：它的构建产物用相对路径，能直接挂在子路径下 */
export async function ensureDashboard(cfg) {
  const indexFile = path.join(panelDir, 'index.html')
  if (fs.existsSync(indexFile)) return panelDir
  await ensureDirs()
  const tag = cfg.panel?.dashboardVersion || 'v3.30.0'
  const url = `https://github.com/Zephyruso/zashboard/releases/download/${tag}/dist-no-fonts.zip`
  const buffer = await fetchBuffer(url, { mirrors: cfg.download?.mirrors || [''] })
  const tmp = path.join(panelDir, 'dist.zip')
  await fsp.writeFile(tmp, buffer)
  const out = path.join(panelDir, 'extract')
  try {
    await extractZip(buffer, out)
    const inner = path.join(out, 'dist')
    const source = fs.existsSync(path.join(inner, 'index.html')) ? inner : out
    for (const name of await fsp.readdir(source)) await fsp.rename(path.join(source, name), path.join(panelDir, name))
    await fsp.rm(out, { recursive: true, force: true })
  } finally {
    await fsp.unlink(tmp).catch(() => {})
  }
  if (!fs.existsSync(indexFile)) throw new Error('面板文件解压后找不到 index.html')
  return panelDir
}

/** 注入后端配置，省得用户每次都在面板里手填地址和密码 */
function bootstrapHtml(html, token) {
  const script = `<script>(function(){try{var b={uuid:'${token}',protocol:location.protocol.replace(':',''),host:location.hostname,port:location.port||(location.protocol==='https:'?'443':'80'),secondaryPath:'${PREFIX}/${token}/api',password:'',label:'JiuLi 临时面板',type:'clash'};localStorage.setItem('setup/api-list',JSON.stringify([b]));localStorage.setItem('setup/active-uuid',b.uuid)}catch(e){}})();</script>`
  return html.replace('</head>', `${script}</head>`)
}

function serveFile(res, file, token) {
  if (path.basename(file) === 'index.html') {
    const html = fs.readFileSync(file, 'utf8')
    res
      .type('text/html')
      .set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' })
      .send(token ? bootstrapHtml(html, token) : html)
    return
  }
  const ext = path.extname(file).toLowerCase()
  res.set({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=600' })
  fs.createReadStream(file).pipe(res)
}

/**
 * 把临时面板挂到框架端口上：
 *   /pp/<token>/           静态文件
 *   /pp/<token>/api/*      反代 mihomo（注入 Bearer，控制器只监听 127.0.0.1）
 *   /pp/<token>/api/<ws>   WS 反代（traffic / logs / connections）
 * @param app Bot.express
 * @param resolvers { client(): { port, secret } | null }
 */
export function mountPanel(app, resolvers) {
  if (!app) return
  /** 热重载会重新执行模块，路由只挂一次，解析器换成新的 */
  if (globalThis.__clashPanelMounted) {
    globalThis.__clashPanelResolvers = resolvers
    return
  }
  globalThis.__clashPanelMounted = true
  globalThis.__clashPanelResolvers = resolvers

  const clientOf = () => globalThis.__clashPanelResolvers?.client?.() || null

  app.use(PREFIX, (req, res) => {
    const parsed = parsePath(req.originalUrl || req.url)
    if (!parsed) return res.status(404).type('text/plain').send('Not Found')
    if (!findSession(parsed.token)) return res.status(410).type('text/plain').send('链接已失效（临时面板过期，或已被 #代理下线 关闭）')
    const client = clientOf()
    if (!client) return res.status(503).type('text/plain').send('代理内核未运行')
    if (parsed.rest === 'api' || parsed.rest.startsWith('api/')) {
      return proxyHttp(req, res, { port: client.port, secret: client.secret, path: `/${parsed.rest.replace(/^api\/?/, '')}` })
    }
    const rel = decodeURIComponent(parsed.rest || '')
    const file = path.resolve(panelDir, rel)
    const inside = file === panelDir || file.startsWith(panelDir + path.sep)
    if (!inside) return res.status(403).type('text/plain').send('Forbidden')
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(res, file, parsed.token)
    /** 前端是 hash 路由，未知的目录路径回落到 index.html；带扩展名的一律 404 */
    if (/\.[a-z0-9]{1,8}$/i.test(rel)) return res.status(404).type('text/plain').send('Not Found')
    return serveFile(res, path.join(panelDir, 'index.html'), parsed.token)
  })

  app.public ??= []
  if (!app.public.includes(PREFIX)) app.public.push(PREFIX)

  /** 框架按 URL 第一段选 WS 处理器，所以只能整体注册到 /pp，再在里面校验 token */
  globalThis.Bot.wsf.pp = [
    (conn, req) => {
      const parsed = parsePath(req.url)
      if (!parsed || !findSession(parsed.token)) return conn.close(4001, '临时面板已失效')
      const client = clientOf()
      if (!client) return conn.close(4002, '代理内核未运行')
      const upstream = new WebSocket(`ws://127.0.0.1:${client.port}/${parsed.rest.replace(/^api\/?/, '')}`, {
        headers: { Authorization: `Bearer ${client.secret}` },
      })
      const queue = []
      conn.on('message', (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary })
        else if (upstream.readyState === WebSocket.CONNECTING) queue.push([data, isBinary])
      })
      upstream.on('open', () => {
        for (const [data, isBinary] of queue.splice(0)) upstream.send(data, { binary: isBinary })
      })
      upstream.on('message', (data, isBinary) => {
        if (conn.readyState === WebSocket.OPEN) conn.send(data, { binary: isBinary })
      })
      const close = code => {
        try {
          conn.close(code)
        } catch {}
        try {
          upstream.close()
        } catch {}
      }
      upstream.on('close', () => close(1000))
      upstream.on('error', () => close(1011))
      conn.on('close', () => {
        try {
          upstream.close()
        } catch {}
      })
    },
  ]
}

/** 流式反代，保留大响应体与请求体原样（/connections 能到几 MB） */
export function proxyHttp(req, res, { port, secret, path: upstreamPath }) {
  const url = new URL(req.originalUrl || req.url, 'http://127.0.0.1')
  const headers = { ...req.headers }
  headers.authorization = `Bearer ${secret}`
  headers.host = `127.0.0.1:${port}`
  const upReq = http.request(
    { host: '127.0.0.1', port, path: `${upstreamPath}${url.search}`, method: req.method, headers },
    upRes => {
      res.writeHead(upRes.statusCode || 502, upRes.headers)
      upRes.pipe(res)
    },
  )
  upReq.on('error', err => {
    if (!res.headersSent) res.status(502).type('text/plain').send(`内核接口不可用：${err.message}`)
  })
  req.pipe(upReq)
}
