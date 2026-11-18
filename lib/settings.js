import path from 'node:path'
import fs from 'node:fs/promises'

/** 首次运行写进 config/clash-proxy.yaml 的默认值 */
export const defaults = {
  core: {
    /** 留空则自动下载到 data/clash-proxy/bin，可填已有 mihomo 可执行文件路径 */
    path: '',
    /** latest 或 v1.19.34 这类具体版本 */
    version: 'latest',
    mixedPort: 7890,
    controllerPort: 9090,
    /** 留空则首次启动生成并保存到 data/clash-proxy/secret */
    secret: '',
    mode: 'rule',
    /** 需要 root，且会自动接管本机全部流量；默认关 */
    tun: false,
    allowLan: false,
    auth: [],
    logLevel: 'info',
  },
  panel: {
    ttlMinutes: 30,
    maxSessions: 5,
    /** 留空用 Bot.url（server.url），形如 http://1.2.3.4:1721 */
    baseUrl: '',
    dashboardVersion: 'v3.30.0',
  },
  /** 下载镜像前缀，按顺序尝试，空串表示直连 GitHub */
  download: { mirrors: ['https://gh-proxy.com/', 'https://ghfast.top/', ''] },
  subscription: { userAgent: 'clash.meta', autoUpdateHours: 0 },
}

export const root = process.cwd()
export const dataDir = path.join(root, 'data', 'clash-proxy')
export const binDir = path.join(dataDir, 'bin')
export const providerDir = path.join(dataDir, 'providers')
export const panelDir = path.join(dataDir, 'panel')
export const configPath = path.join(dataDir, 'config.yaml')
export const secretPath = path.join(dataDir, 'secret')
export const pidPath = path.join(dataDir, 'mihomo.pid')
export const logPath = path.join(dataDir, 'mihomo.log')
export const subsPath = path.join(dataDir, 'subscriptions.json')
export const releaseCachePath = path.join(dataDir, 'release.json')

export async function ensureDirs() {
  for (const dir of [dataDir, binDir, providerDir, panelDir]) await fs.mkdir(dir, { recursive: true })
}

let pending

/** useConfig 的句柄：{ config, configSave, configFile }，配置本体和保存方法都从这里拿 */
export function settingsHandle(plugin) {
  pending ??= plugin.useConfig(defaults, { name: 'clash-proxy' }).catch(err => {
    pending = undefined
    throw err
  })
  return pending
}

/** 插件配置单例：每个事件都会 new 一次插件实例，配置只解析一次 */
export async function settings(plugin) {
  return (await settingsHandle(plugin)).config
}

/** 改过 cfg 之后落盘到 config/<name>.yaml */
export async function saveSettings(plugin) {
  const handle = await settingsHandle(plugin)
  await handle.configSave?.()
}

export function coreSecret(cfg) {
  if (cfg.core.secret) return cfg.core.secret
  return fs
    .readFile(secretPath, 'utf8')
    .then(s => s.trim())
    .catch(async () => {
      const { randomBytes } = await import('node:crypto')
      const s = randomBytes(16).toString('hex')
      await fs.writeFile(secretPath, s, { mode: 0o600 }).catch(() => {})
      return s
    })
}
