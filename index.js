import { settings, saveSettings } from './lib/settings.js'
import { Kernel, GROUP_MAIN, ClashError, readSubscriptions } from './lib/mihomo.js'
import {
  importSubscription,
  removeSubscription,
  refreshSubscriptions,
  displayName,
  renameSubscription,
  updateSubscription,
  activateSubscription,
} from './lib/subscription.js'
import { createSession, destroyAllSessions, listSessions, mountPanel, ensureDashboard, PREFIX } from './lib/panel.js'

const MODES = { 规则: 'rule', 全局: 'global', 直连: 'direct', rule: 'rule', global: 'global', direct: 'direct' }
const MODE_TEXT = { rule: '规则', global: '全局', direct: '直连' }
const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay'])
const BUILTIN = new Set(['DIRECT', 'REJECT', 'PASS', 'COMPATIBLE', 'GLOBAL'])

let kernel = null
/** 内核就绪时缓存 {port, secret}，面板反代每次请求都要用，不能每次都去探活 */
let active = null
/** 面板的订阅接口要拿配置，而 settings() 需要插件实例；模块级保存一份最近的 */
let pluginRef = null

function getKernel(cfg) {
  kernel ??= new Kernel(cfg)
  return kernel
}

async function refresh(cfg) {
  const k = getKernel(cfg)
  const info = await k.running().catch(() => null)
  active = info ? { port: k.cfg.core.controllerPort, secret: k.client.secret } : null
  return info
}

async function requireRunning(cfg) {
  const k = getKernel(cfg)
  const info = await refresh(cfg)
  if (!info) throw new ClashError('代理内核没在运行，先发 #代理部署 或 #代理开')
  return k
}

function panelBase(cfg) {
  const raw = String(cfg.panel?.baseUrl || globalThis.Bot?.url || '').trim()
  return raw.replace(/\/+$/, '')
}

async function sendPrivate(e, text) {
  const Bot = globalThis.Bot
  try {
    if (e.bot?.sendFriendMsg) return await e.bot.sendFriendMsg(e.user_id, text)
  } catch (err) {
    globalThis.logger?.warn?.(`[clash-proxy] 用当前账号私聊失败：${err.message}`)
  }
  return Bot.pickFriend(e.user_id).sendMsg(text)
}

/** 把异常翻成一条回复，别让用户对着日志里的 ERROR 猜 */
async function safe(e, run) {
  try {
    return await run()
  } catch (err) {
    if (!(err instanceof ClashError)) globalThis.logger?.error?.(`[clash-proxy] ${err.stack || err.message}`)
    return e.reply(`❌ ${err.message}`)
  }
}

function fmtBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i ? 1 : 0)}${units[i]}`
}

function fmtLeft(ms) {
  const min = Math.ceil(ms / 60000)
  return min >= 1 ? `${min} 分钟` : `${Math.ceil(ms / 1000)} 秒`
}

/** 并发跑延迟测试，未在超时内返回的算失败 */
async function delayAll(client, names, { concurrency = 6, timeout = 5000 } = {}) {
  const results = []
  let cursor = 0
  const worker = async () => {
    while (cursor < names.length) {
      const name = names[cursor++]
      try {
        const { delay } = await client.delay(name, { timeout })
        results.push({ name, delay })
      } catch {
        results.push({ name, delay: null })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker))
  return results
}

export class ClashProxy extends (globalThis.plugin || class {}) {
  constructor() {
    super({
      name: 'clash代理',
      dsc: 'mihomo 内核代理：启停、模式切换、测速、订阅导入、临时面板',
      event: 'message',
      priority: 300,
      rule: [
        { reg: '^#代理(?:部署|安装|更新内核)$', fnc: 'deploy', permission: 'master' },
        { reg: '^#代理(?:开|开启|启动)$', fnc: 'open', permission: 'master' },
        { reg: '^#代理(?:关|关闭|停止)$', fnc: 'close', permission: 'master' },
        { reg: '^#代理(?:状态|信息)$', fnc: 'status', permission: 'master' },
        { reg: '^#代理模式(?:\\s*([\\s\\S]+))?$', fnc: 'mode', permission: 'master' },
        { reg: '^#代理tun(?:\\s*(开|关|on|off|true|false|1|0))?$', fnc: 'tun', permission: 'master' },
        { reg: '^#代理节点(?:\\s*([\\s\\S]+))?$', fnc: 'node', permission: 'master' },
        { reg: '^#代理测速(?:\\s*([\\s\\S]+))?$', fnc: 'speedtest', permission: 'master' },
        { reg: '^#代理订阅(?:\\s*([\\s\\S]+))?$', fnc: 'subscription', permission: 'master' },
        { reg: '^#代理web(?:\\s*(\\d+))?$', fnc: 'web', permission: 'master' },
        { reg: '^#代理下线$', fnc: 'offline', permission: 'master' },
      ],
    })
  }

  onLoad() {
    pluginRef = this
    /** 探测内核是否已在跑，不阻塞插件加载 */
    settings(this).then(cfg => refresh(cfg)).catch(() => {})
  }

  /** 下载内核 + 生成配置 + 启动 + 准备面板静态文件 */
  async runDeploy(e = this.e) {
    const cfg = await settings(this)
    const k = getKernel(cfg)
    await e.reply('开始部署：下载内核 → 生成配置 → 启动')
    const bin = await k.ensureBinary()
    await e.reply(`内核就绪：${bin}`)
    const synced = await refreshSubscriptions(cfg).catch(() => ({ updated: 0 }))
    if (synced.updated) await e.reply(`已刷新 ${synced.updated} 条过期订阅`)
    const result = await k.start()
    await refresh(cfg)
    let panelText = '面板文件待下载（发 #代理web 时自动拉取）'
    try {
      await ensureDashboard(cfg)
      panelText = '面板文件已就绪'
    } catch (err) {
      panelText = `面板文件下载失败：${err.message}`
    }
    const info = await k.client.version()
    return e.reply(
      [
        `${result.already ? '内核已在运行' : '内核已启动'}：${info.version || info.meta}`,
        `混合端口 ${cfg.core.mixedPort} · 控制器 127.0.0.1:${cfg.core.controllerPort}`,
        panelText,
        '下一步：发 #代理订阅 <订阅地址> 导入节点，再发 #代理开',
      ].join('\n'),
    )
  }

  async runOpen(e = this.e) {
    const cfg = await settings(this)
    const k = getKernel(cfg)
    const running = await refresh(cfg)
    if (running) {
      // 订阅可能在停机期间变过，重写一遍配置再热重载，省得节点对不上
      await k.writeConfig(await readSubscriptions()).then(() => k.reload()).catch(() => {})
      return e.reply(`代理已在运行（${running.version || 'mihomo'}），端口 ${cfg.core.mixedPort}`)
    }
    await refreshSubscriptions(cfg).catch(() => {})
    const result = await k.start()
    await refresh(cfg)
    return e.reply(`代理已启动：${result.version}，端口 ${cfg.core.mixedPort}，模式 ${MODE_TEXT[cfg.core.mode] || cfg.core.mode}`)
  }

  async runClose(e = this.e) {
    const cfg = await settings(this)
    const k = getKernel(cfg)
    const result = await k.stop()
    active = null
    const panels = destroyAllSessions()
    if (!result.stopped) return e.reply(`没有关掉：${result.reason}`)
    return e.reply(`代理已停止（pid ${result.pid}）${panels ? `，${panels} 个临时面板已销毁` : ''}`)
  }

  async runStatus(e = this.e) {
    const cfg = await settings(this)
    const k = getKernel(cfg)
    const info = await refresh(cfg)
    const subs = await readSubscriptions()
    const panels = listSessions()
    if (!info) {
      return e.reply(
        [
          '代理未运行',
          `内核：${k.binaryPath}`,
          `订阅：${subs.length} 条`,
          `临时面板：${panels.length} 个（失效，内核没起时打不开）`,
        ].join('\n'),
      )
    }
    const configs = await k.client.configs().catch(() => ({}))
    const traffic = await k.client.traffic().catch(() => null)
    return e.reply(
      [
        `代理运行中：${info.version || info.meta}`,
        `模式：${MODE_TEXT[configs.mode] || configs.mode} · 端口 ${configs['mixed-port'] || cfg.core.mixedPort}`,
        `订阅：${subs.length} 条${subs.length ? `（${subs.map(s => `${s.name} ${s.count} 节点`).join('、')}）` : ''}`,
        traffic ? `流量：↑${fmtBytes(traffic.upload)} ↓${fmtBytes(traffic.download)} · 连接 ${traffic.count}` : '',
        `临时面板：${panels.length} 个${panels.length ? `，最近到期 ${fmtLeft(Math.min(...panels))}` : ''}`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }

  async runMode(e = this.e) {
    const cfg = await settings(this)
    const wanted = MODES[String(e.msg).replace(/^#代理模式\s*/, '').trim()]
    const k = await requireRunning(cfg)
    if (!wanted) {
      const configs = await k.client.configs().catch(() => ({}))
      return e.reply(`当前模式：${MODE_TEXT[configs.mode] || configs.mode}\n用法：#代理模式 规则 / 全局 / 直连`)
    }
    await k.client.setMode(wanted)
    cfg.core.mode = wanted
    // 全局模式走 GLOBAL 分组，它默认是 DIRECT，不带上当前节点等于没代理
    if (wanted === 'global') {
      const { proxies } = await k.client.proxies().catch(() => ({ proxies: {} }))
      const now = proxies[GROUP_MAIN]?.now
      if (now && proxies[now] && !GROUP_TYPES.has(proxies[now].type)) await k.client.select('GLOBAL', now).catch(() => {})
    }
    return e.reply(`已切换到${MODE_TEXT[wanted]}模式`)
  }

  /**
   * TUN 模式：把本机全部流量（含 git、ssh 这类不认环境变量的程序）接管进内核。
   * 改的是配置文件里的字段，切完要重建配置并重启内核，TUN 只在启动时生效。
   */
  async runTun(e = this.e) {
    const cfg = await settings(this)
    const arg = String(e.msg).replace(/^#代理tun\s*/, '').trim()
    let on
    if (/^(开|on|true|1)$/i.test(arg)) on = true
    else if (/^(关|off|false|0)$/i.test(arg)) on = false
    else on = !cfg.core?.tun
    if (on === !!cfg.core?.tun) return e.reply(on ? 'TUN 已经开着' : 'TUN 已经关着')
    const k = getKernel(cfg)
    const running = await refresh(cfg)
    if (on && process.platform === 'win32') return e.reply('Windows 上要用 TUN 得先装 wintun 驱动，暂不支持一键开启')
    cfg.core.tun = on
    await saveSettings(this)
    if (!running) return e.reply(on ? 'TUN 已写入配置，发 #代理开 启动后生效' : 'TUN 已在配置里关闭')
    await e.reply(on ? '正在开启 TUN：重建配置并重启内核，代理会断几秒' : '正在关闭 TUN：重建配置并重启内核')
    await k.stop()
    await new Promise(r => setTimeout(r, 800))
    await k.writeConfig(await readSubscriptions())
    const info = await k.start()
    active = { port: cfg.core.controllerPort, secret: k.client.secret }
    return e.reply(
      on
        ? `TUN 已开启（内核 ${info.version || '已就绪'}），本机所有程序都会走代理；要恢复发 #代理tun 关`
        : 'TUN 已关闭，只有手动指向 127.0.0.1 端口或配了环境变量的程序走代理',
    )
  }

  /** 不带关键字时列出主分组里可选的节点，带上就直接切过去 */
  async runNode(e = this.e) {
    const cfg = await settings(this)
    const keyword = String(e.msg).replace(/^#代理节点\s*/, '').trim()
    const k = await requireRunning(cfg)
    const { proxies } = await k.client.proxies()
    const configs = await k.client.configs().catch(() => ({}))
    const groupName = configs.mode === 'global' ? 'GLOBAL' : GROUP_MAIN
    const group = proxies[groupName]
    if (!group) throw new ClashError(`找不到分组 ${groupName}，可能是配置里没有订阅`)

    const members = (group.all || []).filter(name => !GROUP_TYPES.has(proxies[name]?.type))
    if (!keyword) {
      const head = members.slice(0, 20).map((name, i) => `${i + 1}. ${name}`)
      return e.reply(
        [
          `当前节点：${group.now || '未选择'}`,
          `可选节点 ${members.length} 个${members.length > head.length ? '（只列前 20）' : ''}：`,
          ...head,
          '切换用 #代理节点 <名字里的关键词>',
        ].join('\n'),
      )
    }
    const hits = members.filter(name => name.includes(keyword))
    if (!hits.length) {
      const fuzzy = members.filter(name => name.toLowerCase().includes(keyword.toLowerCase()))
      if (!fuzzy.length) return e.reply(`没有匹配「${keyword}」的节点，发 #代理节点 看列表`)
      hits.push(...fuzzy)
    }
    if (hits.length > 1) {
      return e.reply([`有 ${hits.length} 个节点匹配，再具体一点：`, ...hits.slice(0, 10).map(n => `· ${n}`)].join('\n'))
    }
    await k.client.select(groupName, hits[0])
    return e.reply(`已切到：${hits[0]}`)
  }

  async runSpeedtest(e = this.e) {
    const cfg = await settings(this)
    const keyword = String(e.msg).replace(/^#代理测速\s*/, '').trim()
    const k = await requireRunning(cfg)
    const { proxies } = await k.client.proxies()
    const configs = await k.client.configs().catch(() => ({}))
    const groupName = configs.mode === 'global' ? 'GLOBAL' : GROUP_MAIN
    // 只测当前分组里真正的节点，别把 GLOBAL/PASS 这些内置出口也当成节点
    const members = proxies[groupName]?.all?.length ? proxies[groupName].all : Object.keys(proxies)
    let names = members.filter(
      name => proxies[name] && !GROUP_TYPES.has(proxies[name].type) && !BUILTIN.has(name),
    )
    if (keyword) names = names.filter(n => n.includes(keyword))
    if (!names.length) return e.reply(keyword ? `没有匹配「${keyword}」的节点` : '当前没有可测速的节点，先导入订阅')
    if (names.length > 200) names = names.slice(0, 200)
    await e.reply(`开始测速：${names.length} 个节点，并发 6，可能要几十秒`)
    const results = await delayAll(k.client, names)
    const ok = results.filter(r => r.delay !== null).sort((a, b) => a.delay - b.delay)
    const bad = results.length - ok.length
    const top = ok.slice(0, 5).map((r, i) => `${i + 1}. ${r.name} — ${r.delay}ms`)
    const fastest = ok[0]
    if (fastest) await k.client.select(groupName, fastest.name).catch(() => {})
    return e.reply(
      [
        `测速完成：可用 ${ok.length} / ${results.length}${bad ? `，失败 ${bad}` : ''}`,
        ...top,
        fastest ? `\n已自动切到最快的：${fastest.name}` : '\n没有可用节点',
      ].join('\n'),
    )
  }

  /** 无参列出订阅，url 导入，删 <名字|序号> 移除 */
  async runSubscription(e = this.e) {
    const cfg = await settings(this)
    const ua = cfg.subscription?.userAgent || 'clash.meta'
    const arg = String(e.msg).replace(/^#代理订阅\s*/, '').trim()
    const applyConfig = async () => {
      const k = getKernel(cfg)
      if (!(await refresh(cfg))) return false
      await k.writeConfig(await readSubscriptions())
      await k.reload().catch(() => {})
      return true
    }
    if (!arg) {
      const list = await readSubscriptions()
      if (!list.length) return e.reply('还没有订阅，用 #代理订阅 <订阅地址> 导入')
      return e.reply(
        [
          `订阅 ${list.length} 条：`,
          ...list.map(
            (s, i) =>
              `${i + 1}. ${displayName(s)}${s.active === false ? '（未启用）' : '（使用中）'} — ${s.count} 节点（${s.kind === 'clash' ? 'Clash 配置' : '分享链接'}）`,
          ),
          '切换：#代理订阅 切 <名字或序号>',
          '更新：#代理订阅 更新 [名字或序号]（不带参数更新全部）',
          '改名：#代理订阅 改名 <名字或序号> <新名字>',
          '删除：#代理订阅 删 <名字或序号>',
        ].join('\n'),
      )
    }

    const pick = async key => {
      const list = await readSubscriptions()
      return /^\d+$/.test(key) ? list[Number(key) - 1] : list.find(i => i.name === key || i.label === key)
    }

    if (/^切\s+/.test(arg)) {
      const key = arg.replace(/^切\s+/, '').trim()
      const target = await pick(key)
      if (!target) return e.reply(`没有找到订阅「${key}」`)
      await activateSubscription(target.name)
      const applied = await applyConfig()
      return e.reply(`已切换到订阅：${displayName(target)}（${target.count} 节点）${applied ? '，配置已重载' : '\n发 #代理开 启动后生效'}`)
    }

    if (/^更新(\s+|$)/.test(arg)) {
      const key = arg.replace(/^更新\s*/, '').trim()
      if (!key) {
        const list = await readSubscriptions()
        if (!list.length) return e.reply('还没有订阅')
        const failed = []
        for (const sub of list) {
          try {
            await updateSubscription(sub.name, ua)
          } catch (err) {
            failed.push(`${displayName(sub)}：${err.message}`)
          }
        }
        const applied = await applyConfig()
        return e.reply(
          [`已更新 ${list.length - failed.length} 条订阅`, ...failed.map(f => `✖ ${f}`), applied ? '配置已重载' : ''].filter(Boolean).join('\n'),
        )
      }
      const target = await pick(key)
      if (!target) return e.reply(`没有找到订阅「${key}」`)
      const info = await updateSubscription(target.name, ua)
      const applied = await applyConfig()
      return e.reply(`已更新订阅：${displayName(info)}，${info.count} 个节点${applied ? '，配置已重载' : ''}`)
    }

    if (/^改名\s+/.test(arg)) {
      const m = arg.match(/^改名\s+(\S+)\s+([\s\S]+)$/)
      if (!m) return e.reply('用法：#代理订阅 改名 <名字或序号> <新名字>')
      const target = await pick(m[1])
      if (!target) return e.reply(`没有找到订阅「${m[1]}」`)
      const renamed = await renameSubscription(target.name, m[2].trim())
      return e.reply(`已改名为：${displayName(renamed)}`)
    }

    if (/^删\s+/.test(arg)) {
      const key = arg.replace(/^删\s+/, '').trim()
      const target = await pick(key)
      if (!target) return e.reply(`没有找到订阅「${key}」`)
      const removed = await removeSubscription(target.name)
      await applyConfig()
      return e.reply(`已删除订阅：${displayName(removed)}`)
    }

    if (!/^https?:\/\//i.test(arg)) return e.reply('订阅地址要以 http:// 或 https:// 开头')
    const entry = await importSubscription(arg, { ua })
    const running = await refresh(cfg)
    // 节点是内联进 config.yaml 的，只 reload 不会把新订阅算进去
    if (running) await applyConfig()
    return e.reply(
      [
        `已导入订阅：${displayName(entry)}`,
        `解析到 ${entry.count} 个节点（${entry.kind === 'clash' ? 'Clash 配置' : '分享链接'}）${entry.skipped ? `，跳过 ${entry.skipped} 条无法识别` : ''}`,
        running ? '已热重载配置，直接发 #代理测速 或 #代理节点 选节点' : '发 #代理开 启动后生效',
      ].join('\n'),
    )
  }

  /** 生成临时面板链接；群里只回一句，链接走私聊 */
  async runWeb(e = this.e) {
    const cfg = await settings(this)
    const minutes = Number(String(e.msg).replace(/^#代理web\s*/, '').trim()) || cfg.panel?.ttlMinutes || 30
    await requireRunning(cfg)
    await ensureDashboard(cfg)
    const { token, expiresAt } = createSession(minutes, cfg.panel?.maxSessions ?? 5)
    const url = `${panelBase(cfg)}${PREFIX}/${token}/`
    const text = [
      `临时面板已生成（${fmtLeft(expiresAt - Date.now())}内有效）：`,
      url,
      '右下角「订阅」按钮可导入和管理订阅。',
      '链接只在本次会话有效，过期或 #代理下线 后立刻失效。',
    ].join('\n')
    if (e.isGroup) {
      await sendPrivate(e, text)
      return e.reply(`临时面板链接已私聊发给 ${e.sender?.card || e.sender?.nickname || e.user_id}，${fmtLeft(expiresAt - Date.now())}内有效`)
    }
    return e.reply(text)
  }

  async runOffline(e = this.e) {
    const count = destroyAllSessions()
    return e.reply(count ? `已销毁 ${count} 个临时面板，旧链接全部失效` : '当前没有有效的临时面板')
  }

  /** 框架只把异常写进 ERROR 日志，用户什么都看不到，这里统一回一条 */
  async deploy(e = this.e) {
    return safe(e, () => this.runDeploy(e))
  }

  async open(e = this.e) {
    return safe(e, () => this.runOpen(e))
  }

  async close(e = this.e) {
    return safe(e, () => this.runClose(e))
  }

  async status(e = this.e) {
    return safe(e, () => this.runStatus(e))
  }

  async mode(e = this.e) {
    return safe(e, () => this.runMode(e))
  }

  async tun(e = this.e) {
    return safe(e, () => this.runTun(e))
  }

  async node(e = this.e) {
    return safe(e, () => this.runNode(e))
  }

  async speedtest(e = this.e) {
    return safe(e, () => this.runSpeedtest(e))
  }

  async subscription(e = this.e) {
    return safe(e, () => this.runSubscription(e))
  }

  async web(e = this.e) {
    return safe(e, () => this.runWeb(e))
  }

  async offline(e = this.e) {
    return safe(e, () => this.runOffline(e))
  }
}

/** 路由在模块加载时挂上，热重载只换解析器 */
try {
  mountPanel(globalThis.Bot?.express, {
    client: () => active,
    subs: {
      list: async () =>
        (await readSubscriptions()).map(s => ({
          name: s.name,
          label: s.label || '',
          count: s.count,
          kind: s.kind,
          active: s.active !== false,
          updatedAt: s.updatedAt,
        })),
      add: async (url, opts = {}) => {
        const cfg = await settings(pluginRef)
        return importSubscription(url, { ...opts, ua: cfg.subscription?.userAgent || 'clash.meta' })
      },
      remove: key => removeSubscription(key),
      rename: (key, label) => renameSubscription(key, label),
      update: async key => {
        const cfg = await settings(pluginRef)
        return updateSubscription(key, cfg.subscription?.userAgent || 'clash.meta')
      },
      activate: key => activateSubscription(key),
      /** 节点是内联进 config.yaml 的，加完订阅必须重写再 reload，只 reload 等于没变 */
      reload: async () => {
        const cfg = await settings(pluginRef)
        const k = getKernel(cfg)
        await k.writeConfig(await readSubscriptions())
        if (await refresh(cfg)) await k.reload()
      },
      status: async () => {
        const cfg = await settings(pluginRef)
        const info = await refresh(cfg).catch(() => null)
        if (!info) return { running: false }
        const k = getKernel(cfg)
        const [configs, proxies] = await Promise.all([
          k.client.configs().catch(() => ({})),
          k.client.proxies().catch(() => ({ proxies: {} })),
        ])
        const nodes = Object.values(proxies.proxies || {}).filter(p => !BUILTIN.has(p.name) && !GROUP_TYPES.has(p.type)).length
        return { running: true, version: info.version, mode: MODE_TEXT[configs.mode] || configs.mode, nodes }
      },
    },
  })
} catch (err) {
  globalThis.logger?.error?.(`[clash-proxy] 挂载临时面板失败：${err.message}`)
}
