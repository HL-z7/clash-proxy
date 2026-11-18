import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
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
/** 注入面板配置，并挂一个「订阅」浮层，把订阅管理收进同一个页面 */
function bootstrapHtml(html, token) {
  const boot = `<script>(function(){try{var b={uuid:'${token}',protocol:location.protocol.replace(':',''),host:location.hostname,port:location.port||(location.protocol==='https:'?'443':'80'),secondaryPath:'${PREFIX}/${token}/api',password:'',label:'JiuLi 临时面板',type:'clash'};localStorage.setItem('setup/api-list',JSON.stringify([b]));localStorage.setItem('setup/active-uuid',b.uuid)}catch(e){}
try{
  var base=location.pathname.replace(/index\\.html$/,'');if(!/\\/$/.test(base))base+='/';
  var style=document.createElement('style');
  style.textContent='#pp-subs-btn{position:fixed;right:18px;bottom:18px;z-index:9999;background:#4f8cff;color:#fff;border:0;border-radius:999px;padding:10px 18px;font:14px/1 system-ui;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.35);transition:transform .15s ease}#pp-subs-btn:hover{transform:translateY(-1px)}'
    +'#pp-subs-wrap{position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(8,10,14,.62);opacity:0;visibility:hidden;pointer-events:none;transition:opacity .18s ease,visibility .18s}'
    +'#pp-subs-wrap.on{opacity:1;visibility:visible;pointer-events:auto}'
    +'#pp-subs-frame{width:min(680px,92vw);height:min(560px,84vh);border:0;border-radius:14px;background:#0f1115;box-shadow:0 18px 60px rgba(0,0,0,.55);transform:translateY(14px) scale(.985);transition:transform .22s cubic-bezier(.2,.8,.3,1)}'
    +'#pp-subs-wrap.on #pp-subs-frame{transform:none}';
  document.head.appendChild(style);
  function overlay(){
    var w=document.getElementById('pp-subs-wrap');
    if(w)return w;
    w=document.createElement('div');w.id='pp-subs-wrap';
    w.innerHTML='<iframe id="pp-subs-frame" src="'+base+'manage" title="订阅管理"></iframe>';
    document.body.appendChild(w);
    w.addEventListener('click',function(e){if(e.target===w)w.classList.remove('on')});
    return w;
  }
  function mount(){
    var btn=document.createElement('button');
    btn.id='pp-subs-btn';btn.textContent='订阅';
    btn.onclick=function(){overlay().classList.add('on')};
    document.body.appendChild(btn);
  }
  if(document.body)mount();else document.addEventListener('DOMContentLoaded',mount);
  window.addEventListener('message',function(ev){if(ev.data==='pp-subs-close'){var w=document.getElementById('pp-subs-wrap');if(w)w.classList.remove('on')}});
}catch(e){}})();</script>`
  return html.replace('</head>', `${boot}</head>`)
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

const managePage = fileURLToPath(new URL('./manage.html', import.meta.url))

function readJson(req, limit = 8192) {
  /** 框架的 express.json() 已经把请求体解析好了，这时流里是空的 */
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body)
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 面板内自带的订阅管理页：zashboard 只管内核接口，订阅得回到插件这边写入配置，
 * 所以在同一 token 下加一层小接口，省得为了贴个订阅地址去开 QQ。
 *   GET  /pp/<token>/manage           页面
 *   GET  /pp/<token>/manage/subs      列表
 *   POST /pp/<token>/manage/subs      导入 { url }
 *   POST /pp/<token>/manage/subs/delete  删除 { key }
 */
async function manageRoute(req, res, rest) {
  const api = globalThis.__clashPanelResolvers?.subs
  const json = (code, data) => res.status(code).type('application/json').send(JSON.stringify(data))
  try {
    if (!rest) {
      res.type('text/html').set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' })
      return res.send(fs.readFileSync(managePage, 'utf8'))
    }
    if (!api) return json(503, { error: '订阅接口未就绪，等插件加载完再试' })
    if (rest === 'subs' && req.method === 'GET') return json(200, { subs: await api.list(), status: await api.status() })
    if (rest === 'subs' && req.method === 'POST') {
      const { url, label } = await readJson(req)
      if (!/^https?:\/\//i.test(String(url || ''))) return json(400, { error: '订阅地址要以 http:// 或 https:// 开头' })
      const entry = await api.add(String(url), { label })
      await api.reload()
      return json(200, { ok: true, entry, subs: await api.list(), status: await api.status() })
    }
    if (rest === 'subs/delete' && req.method === 'POST') {
      const { key } = await readJson(req)
      const removed = await api.remove(String(key || ''))
      if (!removed) return json(404, { error: '没有找到这条订阅' })
      await api.reload()
      return json(200, { ok: true, removed: removed.label || removed.name, subs: await api.list() })
    }
    if (rest === 'subs/rename' && req.method === 'POST') {
      const { key, label } = await readJson(req)
      const entry = await api.rename(String(key || ''), String(label || ''))
      if (!entry) return json(404, { error: '没有找到这条订阅' })
      return json(200, { ok: true, entry, subs: await api.list() })
    }
    if (rest === 'subs/update' && req.method === 'POST') {
      const { key } = await readJson(req)
      const target = String(key || '')
      const list = await api.list()
      const keys = target === 'all' ? list.map(i => i.name) : [target]
      if (!keys.length) return json(400, { error: '还没有订阅' })
      const failed = []
      for (const name of keys) {
        try {
          await api.update(name)
        } catch (err) {
          failed.push(`${name}：${err.message}`)
        }
      }
      await api.reload()
      return json(200, { ok: failed.length === 0, failed, subs: await api.list(), status: await api.status() })
    }
    if (rest === 'subs/switch' && req.method === 'POST') {
      const { key } = await readJson(req)
      const entry = await api.activate(String(key || ''))
      if (!entry) return json(404, { error: '没有找到这条订阅' })
      await api.reload()
      return json(200, { ok: true, entry, subs: await api.list(), status: await api.status() })
    }
    return json(404, { error: 'Not Found' })
  } catch (err) {
    return json(400, { error: err?.message || String(err) })
  }
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
  globalThis.__clashPanelResolvers = resolvers
  /**
   * 热重载会重新执行模块，但框架重载插件时会先把这个插件注册过的路由层删掉
   * （Bot.cleanupPluginResources），所以不能只看「挂过一次」的标记：
   * 标记还在、层已经被清了，就会出现所有 /pp 请求落到兜底 302。
   * 以路由层本身还在不在为准。
   */
  const stack = app.router?.stack || app._router?.stack || []
  const handler = globalThis.__clashPanelHandler
  if (handler && stack.some(layer => layer.handle === handler)) return

  const clientOf = () => globalThis.__clashPanelResolvers?.client?.() || null

  app.use(PREFIX, (globalThis.__clashPanelHandler = (req, res) => {
    const parsed = parsePath(req.originalUrl || req.url)
    if (!parsed) return res.status(404).type('text/plain').send('Not Found')
    if (!findSession(parsed.token)) return res.status(410).type('text/plain').send('链接已失效（临时面板过期，或已被 #代理下线 关闭）')
    const client = clientOf()
    if (!client) return res.status(503).type('text/plain').send('代理内核未运行')
    if (parsed.rest === 'manage' || parsed.rest.startsWith('manage/'))
      return manageRoute(req, res, parsed.rest.replace(/^manage\/?/, ''))
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
  }))

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
  /**
   * 框架在插件路由之前挂了 express.json()，请求体已经被读走并解析成 req.body，
   * 这时再 req.pipe() 只会发出空 body，但 content-length 还是原来的值，内核会一直等。
   * 切节点（PUT /proxies/{name}）就死在这上面。
   */
  const parsedBody = req.body && typeof req.body === 'object' && Object.keys(req.body).length ? Buffer.from(JSON.stringify(req.body)) : null
  if (parsedBody) {
    headers['content-length'] = String(parsedBody.length)
    delete headers['transfer-encoding']
  }
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
  if (parsedBody) upReq.end(parsedBody)
  else req.pipe(upReq)
}
