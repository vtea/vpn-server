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

/**
 * Vue Router 路由表（供 vite-ssg 预渲染与客户端共用）。
 * 含动态段 `/nodes/:id` 的路径不会在构建期生成静态 HTML，需由客户端进入或后续配服务器回退。
 */
export const routes = [
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
