import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * Vite 会校验 Host；经公网域名、内网穿透等访问 dev/preview 时需放行。
 * 未设置 DEV_ALLOWED_HOSTS 时允许任意 Host（便于本地开发）；生产化 preview 可设：
 * DEV_ALLOWED_HOSTS=example.com,www.example.com
 * 修改后需重启 vite 进程。
 */
function devAllowedHosts() {
  const raw = process.env.DEV_ALLOWED_HOSTS?.trim()
  if (!raw) return true
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return list.length ? list : true
}

const allowedHosts = devAllowedHosts()

/** 管理台与 vpn-api 分端口时，由 dev/preview 将 /api 转发到后端（勿与页面端口混为 API 根地址） */
const apiProxy = {
  '/api': {
    target: 'http://127.0.0.1:56700',
    changeOrigin: true
  }
}

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 56701,
    // 56701 被占用时勿自动递增到 56700：会与 vpn-api 默认端口冲突，/api 代理会连错目标 → EADDRINUSE / ENOBUFS
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts,
    proxy: apiProxy
  },
  // vite preview 默认不继承 server.proxy，未配置时访问 /api/* 会 404（与 dev 行为不一致）
  preview: {
    port: 56701,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts,
    proxy: apiProxy
  }
})
