/**
 * Vue Router 路由表（供 vite-ssg 预渲染与客户端共用）。
 * 含动态段 `/nodes/:id` 的路径不会在构建期生成静态 HTML，需由客户端进入或后续配服务器回退。
 * 大页使用 import() 懒加载，与 manualChunks 配合减小首包。
 */
export const routes = [
  { path: '/login', component: () => import('../views/Login.vue') },
  { path: '/self-service', component: () => import('../views/SelfService.vue'), meta: { noAuth: true } },
  { path: '/settings/api', component: () => import('../views/ApiConfig.vue'), meta: { requiresSuperAdmin: true } },
  { path: '/', component: () => import('../views/Dashboard.vue') },
  {
    path: '/network-segments',
    component: () => import('../views/NetworkSegments.vue'),
    meta: { requiresModule: 'nodes' }
  },
  { path: '/nodes', component: () => import('../views/Nodes.vue'), meta: { requiresModule: 'nodes' } },
  { path: '/nodes/:id', component: () => import('../views/NodeDetail.vue'), meta: { requiresModule: 'nodes' } },
  { path: '/users', component: () => import('../views/Users.vue'), meta: { requiresModule: 'users' } },
  { path: '/rules', component: () => import('../views/Rules.vue'), meta: { requiresModule: 'rules' } },
  { path: '/tunnels', component: () => import('../views/Tunnels.vue'), meta: { requiresModule: 'tunnels' } },
  { path: '/audit', component: () => import('../views/Audit.vue'), meta: { requiresModule: 'audit' } },
  { path: '/admins', component: () => import('../views/Admins.vue'), meta: { requiresSuperAdmin: true } }
]
