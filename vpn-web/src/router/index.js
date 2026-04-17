import { createRouter, createWebHistory } from 'vue-router'
import { ElMessage } from 'element-plus'
import { isSuperAdminSession } from '../utils/adminSession'
import Dashboard from '../views/Dashboard.vue'
import Nodes from '../views/Nodes.vue'
import NodeDetail from '../views/NodeDetail.vue'
import Users from '../views/Users.vue'
import Rules from '../views/Rules.vue'
import Tunnels from '../views/Tunnels.vue'
import Audit from '../views/Audit.vue'
import Admins from '../views/Admins.vue'
import Login from '../views/Login.vue'
import SelfService from '../views/SelfService.vue'
import ApiConfig from '../views/ApiConfig.vue'
import NetworkSegments from '../views/NetworkSegments.vue'

const routes = [
  { path: '/login', component: Login },
  { path: '/self-service', component: SelfService, meta: { noAuth: true } },
  { path: '/settings/api', component: ApiConfig, meta: { requiresSuperAdmin: true } },
  { path: '/', component: Dashboard },
  { path: '/network-segments', component: NetworkSegments },
  { path: '/nodes', component: Nodes },
  { path: '/nodes/:id', component: NodeDetail },
  { path: '/users', component: Users },
  { path: '/rules', component: Rules },
  { path: '/tunnels', component: Tunnels },
  { path: '/audit', component: Audit },
  { path: '/admins', component: Admins }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach((to) => {
  if (to.path === '/login' || to.meta?.noAuth) return true
  const token = localStorage.getItem('token')
  if (!token) return '/login'
  if (to.meta?.requiresSuperAdmin && !isSuperAdminSession()) {
    ElMessage.warning('仅超级管理员可访问 API 连接')
    return { path: '/', replace: true }
  }
  return true
})

export default router
