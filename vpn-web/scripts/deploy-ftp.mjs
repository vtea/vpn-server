#!/usr/bin/env node
/**
 * 将 `npm run build` 生成的 `dist/` 通过 FTP/FTPS 上传到服务器。
 *
 * 用法（在项目根 vpn-web/ 下）：
 *   npm run build
 *   FTP_HOST=ftp.example.com FTP_USER=u FTP_PASSWORD=p npm run deploy:ftp
 *
 * 可选环境变量：
 *   FTP_REMOTE_DIR  远端目录，默认 /
 *   FTP_SECURE      设为 1 或 true 时使用 FTPS（显式 TLS）
 *   FTP_VERBOSE     设为 1 时打印 FTP 调试日志
 *
 * 不要将密码写入仓库；可用 shell export 或 CI 密钥。
 */
import { Client } from 'basic-ftp'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(__dirname, '..', 'dist')

const host = process.env.FTP_HOST?.trim()
const user = process.env.FTP_USER?.trim()
const password = process.env.FTP_PASSWORD ?? ''
const remoteDir = (process.env.FTP_REMOTE_DIR ?? '/').trim() || '/'
const secure =
  process.env.FTP_SECURE === '1' ||
  process.env.FTP_SECURE === 'true' ||
  process.env.FTP_SECURE === 'yes'

function fail(msg) {
  console.error(msg)
  process.exit(1)
}

if (!host || !user) {
  fail('缺少 FTP_HOST 或 FTP_USER。示例：FTP_HOST=ftp.xxx.com FTP_USER=www FTP_PASSWORD=*** npm run deploy:ftp')
}

if (!fs.existsSync(distDir)) {
  fail('未找到 dist/，请先在本目录执行: npm run build')
}

const client = new Client()
client.ftp.verbose = process.env.FTP_VERBOSE === '1'

try {
  await client.access({
    host,
    user,
    password,
    secure
  })
  await client.ensureDir(remoteDir)
  await client.cd(remoteDir)
  console.log(`上传 ${distDir} -> ftp://${host}${remoteDir} (secure=${secure}) ...`)
  await client.uploadFromDir(distDir)
  console.log('上传完成。')
} catch (e) {
  console.error(e.message || e)
  process.exit(1)
} finally {
  client.close()
}
