import fsp from 'node:fs/promises'

/** 先直连、再按镜像前缀重试；镜像写法是前缀 + 原始地址，空串表示直连 */
export async function fetchBuffer(url, { mirrors = [''], timeout = 120000, headers } = {}) {
  let lastErr
  for (const mirror of mirrors) {
    try {
      const res = await fetch(mirror ? `${mirror}${url}` : url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`下载失败：${lastErr?.message || '未知错误'}`)
}

export async function fetchJson(url, { timeout = 20000, headers } = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function extractZip(buffer, dir) {
  const { execFileSync } = await import('node:child_process')
  const fs = await import('node:fs')
  const path = await import('node:path')
  await fsp.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.download-${Date.now()}.zip`)
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
  return fs.existsSync(dir)
}
