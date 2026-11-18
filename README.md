# clash-proxy

用 [mihomo](https://github.com/MetaCubeX/mihomo) 内核给机器人做代理开关，附带一个只在临时链接上开放的 Web 面板（[zashboard](https://github.com/Zephyruso/zashboard)）。

控制器只监听 `127.0.0.1`，面板走机器人自己的端口，用一次性 token 反代；token 过期或发 `#代理下线` 后链接立刻失效，不会把一个免密的 Clash 面板暴露在公网。

## 安装

仓库地址：[GitHub](https://github.com/HL-z7/clash-proxy) · [Gitee 镜像](https://gitee.com/fox-glaze/clash-proxy)

```bash
cd <机器人根目录>

# GitHub
git clone https://github.com/HL-z7/clash-proxy.git plugins/clash-proxy

# GitHub 拉不动时套一层加速代理，仓库路径原样拼在后面
git clone https://gh-proxy.com/https://github.com/HL-z7/clash-proxy.git plugins/clash-proxy

# 国内直连更稳的镜像
git clone https://gitee.com/fox-glaze/clash-proxy.git plugins/clash-proxy
```

加速前缀只对公开仓库有效，失效了换 `https://ghfast.top/` 或 `https://ghproxy.net/` 试。

不需要装依赖（只用框架自带的 `express`/`ws`/`yaml`），重启机器人即可。Linux 服务器上发 `#代理部署` 会自己下内核，不用手动装 mihomo。

## 指令

| 指令 | 说明 |
| --- | --- |
| `#代理部署` | 下载内核、生成配置、启动，并顺手预下载面板 |
| `#代理开` / `#代理关` | 启停内核 |
| `#代理状态` | 版本、模式、端口、订阅与临时面板数量、累计流量 |
| `#代理模式 规则\|全局\|直连` | 切换模式，不带参数时显示当前模式 |
| `#代理tun [开\|关]` | 开关 TUN：接管整机流量，不认环境变量的程序（git、ssh）也会走代理；切换会重启内核 |
| `#代理节点` | 列出主分组里的节点；`#代理节点 <关键词>` 直接切换 |
| `#代理测速 [关键词]` | 并发测延迟，列最快的 5 个并自动切到最快的那个 |
| `#代理订阅 <url>` | 导入订阅（Clash 配置或 vmess/vless/trojan/ss/hysteria2/tuic 分享链接） |
| `#代理订阅` | 列出订阅（标出使用中/未启用） |
| `#代理订阅 切 <名字或序号>` | 切换使用中的订阅，只有启用的那条的节点会进配置 |
| `#代理订阅 更新 [名字或序号]` | 重新拉取订阅，不填就是全部更新 |
| `#代理订阅 改名 <名字或序号> <新名字>` | 给订阅起个好认的名字 |
| `#代理订阅 删 <名字或序号>` | 删除订阅 |
| `#代理web [分钟]` | 生成临时面板链接；群里发会改成私聊发送 |
| `#代理下线` | 销毁全部临时面板，已发出的链接立即失效 |

全部指令仅主人可用。指令和参数之间的空格可省略，`#代理订阅https://…`、`#代理模式全局` 都认。

## 配置

首次部署后生成 `config/clash-proxy.yaml`：

```yaml
core:
  path: ''            # 填已有 mihomo 路径则跳过下载
  version: latest     # 或 v1.19.34 这类固定版本
  mixedPort: 7890
  controllerPort: 9090
  secret: ''          # 留空自动生成，存 data/clash-proxy/secret
  mode: rule
  tun: false          # 需要 root，且接管整机流量
  allowLan: false     # 公网机器默认关；开了等于开放代理，务必同时配 auth
  auth: []            # 例如 ['user:pass']，只对开了 allowLan 的混合端口生效
  logLevel: info
panel:
  ttlMinutes: 30
  maxSessions: 5
  baseUrl: ''         # 留空用 server.url；服务器上 server.url 常是 localhost，要填公网地址
  dashboardVersion: v3.30.0
download:
  mirrors: ['https://gh-proxy.com/', 'https://ghfast.top/', '']
subscription:
  userAgent: clash.meta
  autoUpdateHours: 0  # >0 时启动前自动刷新过期订阅
```

## 运行数据

```
data/clash-proxy/
├── bin/mihomo           内核
├── config.yaml          每次启动/重载时生成
├── secret               控制器密码
├── providers/*.yaml     各订阅解析后的节点
├── subscriptions.json   订阅列表
├── panel/               面板静态文件
└── mihomo.log
```

生成的规则只用私网 CIDR + `MATCH`，**不用 GEOIP/GEOSITE**：那要内核去下 8MB 的 `geoip.metadb`，国内首启会卡在 “Can't find MMDB” 一直起不来。要加分流规则自己写 `IP-CIDR`/`DOMAIN-SUFFIX`。

节点是内联进 `config.yaml` 的，不用 `proxy-providers`：mihomo 的 `/proxies` 不返回 provider 里的节点，测速和按节点切换都会拿不到（`/providers/proxies/{name}/delay` 也不支持单节点测试）。

## 面板

`#代理web` 只给一个临时地址 `/pp/<token>/`，里面就是 zashboard（看连接、切节点、切模式、看流量）。右下角有个「订阅」按钮，点开是订阅管理浮层：粘贴订阅地址导入、列出现有订阅、切换/更新/改名/删除。

订阅管理走的是插件自己的接口（`/pp/<token>/manage/subs`），导入或更新后会把节点重新写进 `config.yaml` 再热重载，等于面板里直接完成 `#代理订阅` 那一步。节点选择仍在 zashboard 的 Proxies 页。

## 面板安全

- 控制器 `external-controller: 127.0.0.1:<port>`，公网摸不到。
- `/pp/<24 字节随机 token>/` 由机器人端口反代，token 只存内存（挂在 `globalThis` 上，热重载不失效）。
- token 默认 30 分钟过期，最多同时 5 个；`#代理下线` 全部清空。
- `/pp` 加进了 `express.public`，所以请求不会先撞框架鉴权，但每个请求都校验 token 和内核存活。
- 面板 HTML 注入后端配置，打开即连，不用手填地址和密码。
