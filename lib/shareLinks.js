/**
 * 订阅链接解析：把 vmess/vless/trojan/ss/hysteria2/tuic 分享链接转成 mihomo 的 proxies 条目。
 * 只做常用字段，识别不了的一律跳过（调用方按数量对比提示）。
 */

const b64 = s => {
  const fixed = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = fixed + '='.repeat((4 - (fixed.length % 4)) % 4)
  return Buffer.from(pad, 'base64').toString('utf8')
}

const decodeMaybe = s => {
  const t = String(s || '').trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t
  try {
    const out = b64(t)
    return /^[a-z][a-z0-9+.-]*:\/\//im.test(out) ? out : t
  } catch {
    return t
  }
}

const num = v => (v === undefined || v === null || v === '' ? undefined : Number(v))
const bool = v => v === true || v === '1' || v === 'true' || v === 'yes'

function nameOf(u, fallback) {
  const raw = u.hash ? u.hash.slice(1) : ''
  return raw ? decodeURIComponent(raw) : fallback
}

function wsOpts(params, host, pathname) {
  const opts = {}
  const hostHeader = params.get('host') || host
  if (hostHeader) opts.headers = { Host: hostHeader }
  opts.path = params.get('path') || pathname || '/'
  return opts
}

function tlsOpts(params, server) {
  const security = params.get('security') || ''
  const tls = ['tls', 'reality', 'xtls'].includes(security) || params.get('tls') === '1'
  const sni = params.get('sni') || params.get('peer') || server
  return { tls, servername: tls ? sni : undefined, 'skip-cert-verify': bool(params.get('allowInsecure') || params.get('insecure')) }
}

function grpcOpts(params) {
  return { 'grpc-opts': { 'grpc-service-name': params.get('serviceName') || params.get('service') || '' } }
}

function parseVmess(link) {
  const payload = link.slice('vmess://'.length)
  const json = JSON.parse(b64(payload))
  const server = json.add
  const port = num(json.port)
  if (!server || !port || !json.id) return null
  const network = json.net || 'tcp'
  const proxy = {
    name: json.ps || `${server}:${port}`,
    type: 'vmess',
    server,
    port,
    uuid: json.id,
    alterId: num(json.aid) || 0,
    cipher: json.scy || 'auto',
    udp: true,
  }
  if (json.tls === 'tls') {
    proxy.tls = true
    proxy.servername = json.sni || json.host || server
    if (bool(json.allowInsecure)) proxy['skip-cert-verify'] = true
  }
  proxy.network = network
  if (network === 'ws') {
    proxy['ws-opts'] = {}
    if (json.host) proxy['ws-opts'].headers = { Host: json.host }
    proxy['ws-opts'].path = json.path || '/'
  } else if (network === 'grpc') {
    proxy['grpc-opts'] = { 'grpc-service-name': json.path || '' }
  }
  return proxy
}

function parseVless(link) {
  const u = new URL(link)
  const server = u.hostname
  const port = num(u.port) || 443
  const id = decodeURIComponent(u.username)
  if (!id) return null
  const proxy = { name: nameOf(u, `${server}:${port}`), type: 'vless', server, port, uuid: id, udp: true }
  const { tls, servername, ...rest } = tlsOpts(u.searchParams, server)
  if (tls) Object.assign(proxy, { tls: true, servername, flow: u.searchParams.get('flow') || undefined }, rest)
  if (u.searchParams.get('encryption') === 'none') proxy.encryption = 'none'
  const network = u.searchParams.get('type') || 'tcp'
  proxy.network = network
  if (network === 'ws') proxy['ws-opts'] = wsOpts(u.searchParams, server)
  else if (network === 'grpc') proxy.network = 'grpc', Object.assign(proxy, grpcOpts(u.searchParams))
  else if (network === 'http') proxy.network = 'http'
  const fp = u.searchParams.get('fp')
  if (fp) proxy['client-fingerprint'] = fp
  return proxy
}

function parseTrojan(link) {
  const u = new URL(link)
  const server = u.hostname
  const port = num(u.port) || 443
  const password = decodeURIComponent(u.password || u.username || '')
  if (!password) return null
  const proxy = { name: nameOf(u, `${server}:${port}`), type: 'trojan', server, port, password, udp: true }
  const { tls, servername, ...rest } = tlsOpts(u.searchParams, server)
  Object.assign(proxy, { sni: servername || server }, rest)
  const network = u.searchParams.get('type') || 'tcp'
  proxy.network = network
  if (network === 'ws') proxy['ws-opts'] = wsOpts(u.searchParams, server)
  else if (network === 'grpc') proxy.network = 'grpc', Object.assign(proxy, grpcOpts(u.searchParams))
  return proxy
}

function parseSs(link) {
  const body = link.slice('ss://'.length).split('#')[0]
  const query = link.includes('?') ? new URLSearchParams(link.slice(link.indexOf('?') + 1).split('#')[0]) : new URLSearchParams()
  let method, password, server, port
  if (body.includes('@')) {
    const [auth, hostport] = body.split('@')
    const decoded = auth.includes(':') ? auth : b64(auth)
    ;[method, password] = decoded.split(':')
    ;[server, port] = hostport.replace(/\/.*$/, '').split(':')
  } else {
    const plain = b64(body.split('#')[0])
    const [auth, hostport] = plain.split('@')
    ;[method, password] = auth.split(':')
    ;[server, port] = hostport.split(':')
  }
  const p = num(port)
  if (!server || !p || !method) return null
  const proxy = { name: nameOf(new URL(link), `${server}:${p}`), type: 'ss', server, port: p, cipher: method.toLowerCase(), password, udp: true }
  const plugin = query.get('plugin')
  if (plugin) {
    const [pluginName, ...raw] = plugin.split(';')
    const opts = {}
    for (const item of raw) {
      if (item.includes('=')) {
        const [k, v] = item.split('=')
        opts[k] = v
      } else if (item) opts[item] = true
    }
    if (pluginName.startsWith('obfs')) {
      proxy.plugin = 'obfs'
      proxy['plugin-opts'] = { mode: opts.obfs || 'http', host: opts.obfs_host || opts.host }
    } else if (pluginName.startsWith('v2ray')) {
      proxy.plugin = 'v2ray-plugin'
      proxy['plugin-opts'] = { mode: 'websocket', host: opts.host, path: opts.path, tls: !!opts.tls }
    }
  }
  return proxy
}

function parseHysteria2(link) {
  const u = new URL(link.replace(/^hy2:\/\//i, 'hysteria2://'))
  const server = u.hostname
  const port = num(u.port) || 443
  const password = decodeURIComponent(u.password || u.username || '')
  if (!password) return null
  const proxy = {
    name: nameOf(u, `${server}:${port}`),
    type: 'hysteria2',
    server,
    port,
    password,
    sni: u.searchParams.get('sni') || server,
    'skip-cert-verify': bool(u.searchParams.get('insecure')),
    up: u.searchParams.get('up') || undefined,
    down: u.searchParams.get('down') || undefined,
  }
  const obfs = u.searchParams.get('obfs')
  if (obfs) {
    proxy.obfs = obfs
    const pwd = u.searchParams.get('obfs-password')
    if (pwd) proxy['obfs-password'] = pwd
  }
  return proxy
}

function parseTuic(link) {
  const u = new URL(link)
  const server = u.hostname
  const port = num(u.port) || 443
  const uuid = decodeURIComponent(u.username)
  const password = decodeURIComponent(u.password || '')
  if (!uuid || !password) return null
  return {
    name: nameOf(u, `${server}:${port}`),
    type: 'tuic',
    server,
    port,
    uuid,
    password,
    sni: u.searchParams.get('sni') || server,
    'alpn': u.searchParams.get('alpn') ? u.searchParams.get('alpn').split(',') : undefined,
    'skip-cert-verify': bool(u.searchParams.get('insecure')),
  }
}

const PARSERS = {
  'vmess://': parseVmess,
  'vless://': parseVless,
  'trojan://': parseTrojan,
  'ss://': parseSs,
  'hysteria2://': parseHysteria2,
  'hy2://': parseHysteria2,
  'tuic://': parseTuic,
}

/** 从一段「每行一个链接」的文本里解析节点；返回 { proxies, skipped } */
export function parseShareLinks(text) {
  const decoded = decodeMaybe(text)
  const proxies = []
  let skipped = 0
  for (const line of decoded.split(/\r?\n/)) {
    const link = line.trim()
    if (!link || link.startsWith('#')) continue
    const prefix = Object.keys(PARSERS).find(p => link.toLowerCase().startsWith(p))
    if (!prefix) {
      skipped++
      continue
    }
    try {
      const proxy = PARSERS[prefix](link)
      if (proxy) proxies.push(proxy)
      else skipped++
    } catch {
      skipped++
    }
  }
  return { proxies, skipped }
}
