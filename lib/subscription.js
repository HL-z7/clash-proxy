import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import YAML from 'yaml'
import { providerDir, ensureDirs } from './settings.js'
import { readSubscriptions, writeSubscriptions } from './mihomo.js'
import { parseShareLinks } from './shareLinks.js'

export async function fetchText(url, { ua = 'clash.meta', timeout = 20000 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': ua },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  })
  if (!res.ok) throw new Error(`订阅拉取失败：HTTP ${res.status}`)
  return res.text()
}

/** Clash 格式订阅直接取 proxies；其余交给分享链接解析 */
export function parseSubscription(text) {
  try {
    const doc = YAML.parse(text)
    if (doc && Array.isArray(doc.proxies) && doc.proxies.length) return { kind: 'clash', proxies: doc.proxies, skipped: 0 }
  } catch {}
  const { proxies, skipped } = parseShareLinks(text)
  return { kind: 'links', proxies, skipped }
}

export function subscriptionName(url, label) {
  if (label) return label.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 32)
  try {
    const { hostname, port } = new URL(url)
    const host = hostname.replace(/^www\./, '')
    /** IP 或单段主机名没法当名字用，带上端口区分 */
    if (/^[\d.]+$/.test(host) || !host.includes('.')) return `${host}-${port || 'sub'}`.slice(0, 32)
    return host.split('.')[0].slice(0, 24) || 'sub'
  } catch {
    return 'sub'
  }
}

/** 导入或更新一条订阅：写 providers/<slug>.yaml，并把列表存回 subscriptions.json */
export async function importSubscription(url, { label, ua = 'clash.meta' } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error('订阅地址要以 http:// 或 https:// 开头')
  const text = await fetchText(url, { ua })
  const { kind, proxies, skipped } = parseSubscription(text)
  if (!proxies.length) throw new Error('订阅里没有解析出节点（既不是 Clash 配置，也不是常见分享链接）')
  await ensureDirs()
  const list = await readSubscriptions()
  const name = subscriptionName(url)
  const slug = crypto.createHash('sha1').update(url).digest('hex').slice(0, 8)
  const file = `${name}-${slug}.yaml`
  await fsp.writeFile(path.join(providerDir, file), YAML.stringify({ proxies }, { lineWidth: 0 }))
  const entry = { name, url, file, kind, count: proxies.length, updatedAt: Date.now() }
  if (label) entry.label = String(label).trim().slice(0, 32)
  const old = list.findIndex(i => i.url === url)
  if (old >= 0) {
    entry.active = list[old].active
    /** 换过文件名就清掉旧的，别留孤儿 */
    if (list[old].file !== file) await fsp.unlink(path.join(providerDir, list[old].file)).catch(() => {})
    list[old] = entry
  } else {
    list.push(entry)
  }
  await writeSubscriptions(list)
  return { ...entry, skipped }
}

export async function removeSubscription(key) {
  const list = await readSubscriptions()
  const target = findEntry(list, String(key))
  if (!target) return null
  list.splice(list.indexOf(target), 1)
  await writeSubscriptions(list)
  await fsp.unlink(path.join(providerDir, target.file)).catch(() => {})
  return target
}

/** autoUpdateHours 到期的订阅重新拉一遍；节点是内联进配置的，所以拉完还要 reload 才生效 */
export async function refreshSubscriptions(cfg) {
  const hours = Number(cfg.subscription?.autoUpdateHours) || 0
  const list = await readSubscriptions()
  if (!hours) return { updated: 0, total: list.length }
  let updated = 0
  for (const sub of list) {
    if (Date.now() - (sub.updatedAt || 0) < hours * 3600e3) continue
    try {
      await importSubscription(sub.url, { label: sub.label, ua: cfg.subscription?.userAgent })
      updated++
    } catch (err) {
      globalThis.logger?.warn?.(`[clash-proxy] 订阅 ${sub.name} 更新失败：${err.message}`)
    }
  }
  return { updated, total: list.length }
}

/** 列表里显示的名字：自定义备注优先，没有就用导入时生成的名字 */
export function displayName(sub) {
  return sub?.label || sub?.name || ''
}

function findEntry(list, key) {
  if (/^\d+$/.test(key)) return list[Number(key) - 1]
  return list.find(i => i.name === key || i.label === key || i.url === key)
}

/** 改备注名；name 是文件与索引用的稳定键，不动它 */
export async function renameSubscription(key, label) {
  const list = await readSubscriptions()
  const entry = findEntry(list, String(key))
  if (!entry) return null
  const text = String(label || '').trim().slice(0, 32)
  if (text) entry.label = text
  else delete entry.label
  await writeSubscriptions(list)
  return entry
}

/** 重新拉一条订阅，覆盖 providers 里的节点文件 */
export async function updateSubscription(key, ua = 'clash.meta') {
  const list = await readSubscriptions()
  const entry = findEntry(list, String(key))
  if (!entry) return null
  const text = await fetchText(entry.url, { ua })
  const { kind, proxies, skipped } = parseSubscription(text)
  if (!proxies.length) throw new Error(`${displayName(entry)} 没有解析出节点`)
  await fsp.writeFile(path.join(providerDir, entry.file), YAML.stringify({ proxies }, { lineWidth: 0 }))
  entry.kind = kind
  entry.count = proxies.length
  entry.updatedAt = Date.now()
  await writeSubscriptions(list)
  return { ...entry, skipped }
}

/** 切换：同一时间只启用一条，其它置为停用；节点只取启用的那些 */
export async function activateSubscription(key) {
  const list = await readSubscriptions()
  const entry = findEntry(list, String(key))
  if (!entry) return null
  for (const item of list) item.active = item === entry
  await writeSubscriptions(list)
  return entry
}

export function isActive(sub) {
  return sub?.active !== false
}
