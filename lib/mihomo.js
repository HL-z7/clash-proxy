import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn, execFileSync } from 'node:child_process'
import YAML from 'yaml'
import {
  binDir,
  configPath,
  coreSecret,
  dataDir,
  ensureDirs,
  logPath,
  pidPath,
  providerDir,
  releaseCachePath,
  subsPath,
} from './settings.js'

const RELEASES_API = 'https://api.github.com/repos/MetaCubeX/mihomo/releases'

export class ClashError extends Error {}

/** mihomo 的 RESTful 客户端（external-controller） */
export class Client {
  constructor({ port, secret }) {
    this.base = `http://127.0.0.1:${port}`
    this.secret = secret || ''
  }

  async request(url, { method = 'GET', body, timeout = 15000 } = {}) {
    const headers = { Authorization: `Bearer ${this.secret}` }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(this.base + url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    })
    const text = await res.text()
    if (!res.ok) throw new ClashError(`${method} ${url} 返回 ${res.status} ${text.slice(0, 200)}`)
    return text ? JSON.parse(text) : null
  }

  version() {
    return this.request('/version', { timeout: 3000 })
  }

  configs() {
    return this.request('/configs')
  }

  setMode(mode) {
    return this.request('/configs', { method: 'PATCH', body: { mode } })
  }

  proxies() {
    return this.request('/proxies')
  }

  /** delay 单位毫秒；失败时抛错（节点不通） */
  delay(name, { url = 'http://www.gstatic.com/generate_204', timeout = 5000 } = {}) {
    const query = `?timeout=${timeout}&url=${encodeURIComponent(url)}`
    return this.request(`/proxies/${encodeURIComponent(name)}/delay${query}`, { timeout: timeout + 3000 })
  }

  select(group, name) {
    return this.request(`/proxies/${encodeURIComponent(group)}`, { method: 'PUT', body: { name } })
  }

  reload(payloadPath = configPath) {
    return this.request('/configs?force=true', { method: 'PUT', body: { path: payloadPath } })
  }

  updateProvider(name) {
    return this.request(`/providers/proxies/${encodeURIComponent(name)}`, { method: 'PUT' })
  }

  connections() {
    return this.request('/connections')
  }

  memory() {
    return this.request('/memory', { timeout: 5000 })
  }

  /** 最近 2 秒上传/下载与连接数，用来做状态展示 */
  async traffic() {
    const data = await this.connections()
    return {
      upload: data?.uploadTotal || 0,
      download: data?.downloadTotal || 0,
      count: (data?.connections || []).length,
    }
  }
}

const GROUP_MAIN = '🚀 代理'
const GROUP_AUTO = '♻️ 自动'

export { GROUP_MAIN, GROUP_AUTO }

function platformBinary() {
  const os = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform]
  const arch = { x64: 'amd64', arm64: 'arm64', arm: 'armv7' }[process.arch]
  if (!os || !arch) throw new ClashError(`不支持在当前平台运行：${process.platform}/${process.arch}`)
  const name = os === 'windows' ? 'mihomo.exe' : 'mihomo'
  return { os, arch, name }
}

/** 拉一次 release 元数据并缓存，避免频繁撞 GitHub API 限流 */
async function releaseInfo(cfg) {
  const fixed = cfg.core.version && cfg.core.version !== 'latest'
  try {
    const cached = JSON.parse(await fsp.readFile(releaseCachePath, 'utf8'))
    if (cached?.assets?.length && Date.now() - cached.at < 6 * 3600e3 && (!fixed || cached.tag === fixed)) return cached
  } catch {}
  const url = fixed ? `${RELEASES_API}/tags/${fixed}` : `${RELEASES_API}/latest`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'jiuli-clash-proxy', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new ClashError(`获取 mihomo 版本失败：HTTP ${res.status}（可用 core.version 指定固定版本绕过）`)
  const json = await res.json()
  const info = {
    tag: json.tag_name,
    at: Date.now(),
    assets: (json.assets || []).map(a => ({ name: a.name, url: a.browser_download_url })),
  }
  await fsp.writeFile(releaseCachePath, JSON.stringify(info)).catch(() => {})
  return info
}

async function download(url, mirror) {
  const target = mirror ? `${mirror}${url}` : url
  const res = await fetch(target, { signal: AbortSignal.timeout(120000), redirect: 'follow' })
  if (!res.ok) throw new ClashError(`下载失败 ${res.status} ${target}`)
  return Buffer.from(await res.arrayBuffer())
}

const GEO_BASE = 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest'

/** 低于这个大小说明是被截断的半个文件，内核会判成 MMDB invalid */
const GEO_FILES = { 'geoip.metadb': 8_000_000, 'geosite.dat': 3_000_000 }

/** 预下地理库：内核自己下是直连 GitHub，国内首次启动会卡在“Can't find MMDB” */
async function ensureGeoData(cfg) {
  for (const [name, minSize] of Object.entries(GEO_FILES)) {
    const target = path.join(dataDir, name)
    try {
      if (fs.statSync(target).size >= minSize) continue
    } catch {}
    let lastErr
    for (const mirror of cfg.download.mirrors) {
      try {
        const buffer = await download(`${GEO_BASE}/${name}`, mirror)
        if (buffer.length < minSize) throw new ClashError(`文件不完整（${buffer.length} 字节）`)
        await fsp.writeFile(`${target}.tmp`, buffer)
        await fsp.rename(`${target}.tmp`, target)
        lastErr = null
        break
      } catch (err) {
        lastErr = err
      }
    }
    if (lastErr) throw lastErr
  }
}

/** 按平台选 release 资产，形如 mihomo-linux-amd64-v1.19.34.gz */
function pickAsset(assets, { os, arch }, tag) {
  const ext = os === 'windows' ? '.zip' : '.gz'
  const wanted = [`mihomo-${os}-${arch}-${tag}${ext}`, `mihomo-${os}-${arch}-compatible-${tag}${ext}`]
  for (const name of wanted) {
    const hit = assets.find(a => a.name === name)
    if (hit) return hit
  }
  const fuzzy = assets.find(a => a.name.startsWith(`mihomo-${os}-${arch}-v`) && a.name.endsWith(ext) && !/go1|softfloat|^mihomo-\w+-\w+-v[0-9]-/.test(a.name.replace(`${tag}${ext}`, '')))
  if (!fuzzy) throw new ClashError(`找不到 ${os}/${arch} 的 mihomo 资产（${tag}）`)
  return fuzzy
}

async function extractZip(buffer, dir) {
  const tmp = path.join(dir, `mihomo-${Date.now()}.zip`)
  await fsp.writeFile(tmp, buffer)
  try {
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${tmp}' -DestinationPath '${dir}' -Force`], { stdio: 'ignore' })
    } else {
      execFileSync('unzip', ['-o', '-q', tmp, '-d', dir], { stdio: 'ignore' })
    }
  } finally {
    await fsp.unlink(tmp).catch(() => {})
  }
}

/** 读各订阅落盘的节点文件拼成内联列表；重名节点加后缀，mihomo 不接受重复 name */
async function collectProxies(subs = []) {
  const proxies = []
  const used = new Set()
  for (const sub of subs) {
    let doc
    try {
      doc = YAML.parse(await fsp.readFile(path.join(providerDir, sub.file), 'utf8'))
    } catch {
      continue
    }
    for (const item of Array.isArray(doc?.proxies) ? doc.proxies : []) {
      if (!item?.name || !item.type || !item.server || !item.port) continue
      let name = String(item.name)
      for (let i = 2; used.has(name); i++) name = `${item.name} #${i}`
      used.add(name)
      proxies.push({ ...item, name })
    }
  }
  return proxies
}

export class Kernel {
  constructor(cfg) {
    this.cfg = cfg
    this.client = new Client({ port: cfg.core.controllerPort, secret: '' })
  }

  async secret() {
    this.client.secret = await coreSecret(this.cfg)
    return this.client.secret
  }

  get binaryPath() {
    if (this.cfg.core.path) return path.resolve(this.cfg.core.path)
    return path.join(binDir, platformBinary().name)
  }

  get pid() {
    try {
      return Number(fs.readFileSync(pidPath, 'utf8').trim()) || 0
    } catch {
      return 0
    }
  }

  async running() {
    await this.secret()
    try {
      return await this.client.version()
    } catch {
      return null
    }
  }

  async ensureBinary() {
    const target = this.binaryPath
    if (fs.existsSync(target)) return target
    if (this.cfg.core.path) throw new ClashError(`core.path 指向的文件不存在：${target}`)
    await ensureDirs()
    const { os, arch, name } = platformBinary()
    const info = await releaseInfo(this.cfg)
    const asset = pickAsset(info.assets, { os, arch }, info.tag)
    let lastErr
    for (const mirror of this.cfg.download.mirrors) {
      try {
        const buf = await download(asset.url, mirror)
        if (os === 'windows') {
          await extractZip(buf, binDir)
          const found = (await fsp.readdir(binDir)).find(f => f.toLowerCase().endsWith('.exe'))
          if (!found) throw new ClashError('压缩包里没有找到 mihomo.exe')
          await fsp.rename(path.join(binDir, found), target)
        } else {
          await fsp.writeFile(target, zlib.gunzipSync(buf))
          await fsp.chmod(target, 0o755)
        }
        return target
      } catch (err) {
        lastErr = err
      }
    }
    throw new ClashError(`下载 mihomo 失败：${lastErr?.message || '未知错误'}`)
  }

  /** 生成 config.yaml：端口/控制器/密码 + 内联节点 + 分组 + 规则 */
  async writeConfig(subs = []) {
    const { core } = this.cfg
    const proxies = await collectProxies(subs)
    const names = proxies.map(p => p.name)
    const groupAuto = {
      name: GROUP_AUTO,
      type: 'url-test',
      url: 'http://www.gstatic.com/generate_204',
      interval: 300,
      tolerance: 50,
      proxies: names.length ? names : ['DIRECT'],
    }
    /** 主分组也要能直接选具体节点，否则 #代理节点 只能选自动/直连 */
    const groupMain = { name: GROUP_MAIN, type: 'select', proxies: [GROUP_AUTO, 'DIRECT', ...names] }

    const config = {
      'mixed-port': core.mixedPort,
      // 公网机器上开 allow-lan 等于开无鉴权代理，默认关，要给别人用就配好认证再开
      'allow-lan': !!core.allowLan,
      ...(core.allowLan && Array.isArray(core.auth) && core.auth.length ? { authentication: core.auth } : {}),
      mode: core.mode || 'rule',
      'log-level': core.logLevel || 'info',
      ipv6: false,
      'external-controller': `127.0.0.1:${core.controllerPort}`,
      secret: await this.secret(),
      'unified-delay': true,
      'tcp-concurrent': true,
      profile: { 'store-selected': true, 'store-fake-ip': true },
      dns: {
        enable: true,
        ipv6: false,
        'enhanced-mode': 'fake-ip',
        'fake-ip-range': '198.18.0.1/16',
        'default-nameserver': ['223.5.5.5', '119.29.29.29'],
        nameserver: ['https://dns.alidns.com/dns-query', 'https://doh.pub/dns-query'],
        fallback: ['https://1.1.1.1/dns-query', 'https://dns.google/dns-query'],
        'fallback-filter': { geoip: true, 'geoip-code': 'CN' },
      },
      proxies,
      'proxy-groups': [groupMain, groupAuto],
      rules: ['GEOIP,LAN,DIRECT,no-resolve', 'GEOIP,CN,DIRECT', `MATCH,${GROUP_MAIN}`],
    }
    if (core.tun) {
      config.tun = {
        enable: true,
        stack: 'system',
        'auto-route': true,
        'auto-detect-interface': true,
        'dns-hijack': ['any:53'],
      }
    }
    await ensureDirs()
    await fsp.writeFile(configPath, YAML.stringify(config, { lineWidth: 0 }))
    return configPath
  }

  async start() {
    const running = await this.running()
    if (running) return { already: true, version: running.meta ? running.version : running }
    const bin = await this.ensureBinary()
    const subs = await readSubscriptions()
    await this.writeConfig(subs)
    await ensureDirs()
    await ensureGeoData(this.cfg).catch(err => globalThis.logger?.warn?.(`[clash-proxy] 地理库预下载失败，交给内核自己下：${err.message}`))
    const out = fs.openSync(logPath, 'a')
    const child = spawn(bin, ['-d', dataDir, '-f', configPath], {
      cwd: dataDir,
      detached: process.platform !== 'win32',
      stdio: ['ignore', out, out],
    })
    child.unref()
    await fsp.writeFile(pidPath, String(child.pid))
    /** 首次启动要下地理库，国内直连 GitHub 可能十几秒，给足时间 */
    const deadline = Date.now() + 60000
    let lastErr
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 300))
      try {
        const info = await this.client.version()
        return { pid: child.pid, version: info.version || info.meta }
      } catch (err) {
        lastErr = err
      }
    }
    throw new ClashError(`mihomo 启动后 60 秒内没有响应接口：${lastErr?.message || ''}\n看日志：${logPath}`)
  }

  async stop() {
    const pid = this.pid
    if (!pid) return { stopped: false, reason: '没有记录内核 pid，可能不是本插件启动的' }
    try {
      process.kill(pid, 'SIGTERM')
    } catch (err) {
      if (err.code !== 'ESRCH') throw err
    }
    await fsp.unlink(pidPath).catch(() => {})
    return { stopped: true, pid }
  }

  async reload() {
    const subs = await readSubscriptions()
    await this.writeConfig(subs)
    await this.client.reload()
  }
}

export async function readSubscriptions() {
  try {
    const list = JSON.parse(await fsp.readFile(subsPath, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export async function writeSubscriptions(list) {
  await ensureDirs()
  await fsp.writeFile(subsPath, JSON.stringify(list, null, 2))
}

export { providerDir }
