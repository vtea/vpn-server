<template>
  <div>
    <el-row :gutter="16" class="mb-lg">
      <el-col
        v-for="item in visibleStatCards"
        :key="item.key"
        :xs="12"
        :sm="12"
        :md="8"
        :lg="4"
        class="dashboard-stat-col"
      >
        <div
          class="stat-card"
          :class="{
            'stat-card--clickable': item.key === 'onlineUsers' && showOnlineOverviewStatCard,
            'stat-card--loading': item.key === 'onlineUsers' && onlineOverviewLoading
          }"
          :role="item.key === 'onlineUsers' && showOnlineOverviewStatCard ? 'button' : undefined"
          :tabindex="item.key === 'onlineUsers' && showOnlineOverviewStatCard ? 0 : -1"
          :aria-busy="item.key === 'onlineUsers' && onlineOverviewLoading ? 'true' : undefined"
          @click="onStatCardClick(item.key)"
          @keydown="onStatCardKeydown($event, item.key)"
        >
          <div class="stat-icon" :class="`stat-icon--${item.color}`">
            <el-icon :size="24"><component :is="item.icon" /></el-icon>
          </div>
          <div class="stat-content">
            <div class="stat-value">{{ stats[item.key] }}</div>
            <div class="stat-label">{{ item.key === 'users' ? userStatLabel : item.label }}</div>
          </div>
        </div>
      </el-col>
    </el-row>

    <el-dialog
      v-model="showOnlineDialog"
      title="在线授权（在线节点上的有效证书）"
      width="min(920px, 96vw)"
      destroy-on-close
    >
      <el-alert type="info" :closable="false" show-icon class="mb-md">
        {{ onlineOverviewNote }}
      </el-alert>
      <el-table
        :data="onlineOverviewGrants"
        row-key="grant_id"
        stripe
        max-height="460"
        empty-text="暂无符合条件的授权"
      >
        <el-table-column prop="username" label="用户" width="100" />
        <el-table-column prop="display_name" label="姓名" width="100" show-overflow-tooltip />
        <el-table-column prop="cert_cn" label="证书 CN" min-width="160" show-overflow-tooltip />
        <el-table-column prop="node_name" label="节点" min-width="100" show-overflow-tooltip />
        <el-table-column label="实例" min-width="160">
          <template #default="{ row }">
            {{ row.mode }} · {{ row.proto }}/{{ row.port }}
          </template>
        </el-table-column>
        <el-table-column prop="node_online_users" label="节点在线人数" width="120" align="right" />
      </el-table>
    </el-dialog>

    <el-row :gutter="16">
      <el-col
        v-if="showNodeStatCards"
        :xs="24"
        :sm="24"
        :md="dashboardTwoColumnBottom ? 14 : 24"
        :lg="dashboardTwoColumnBottom ? 14 : 24"
      >
        <div class="page-card">
          <div class="page-card-header">
            <span class="page-card-title">节点状态</span>
            <el-button
              v-if="hasModulePermission('nodes')"
              plain
              type="primary"
              @click="$router.push('/nodes')"
            >
              查看全部 <el-icon><ArrowRight /></el-icon>
            </el-button>
          </div>
          <div v-if="nodeRows.length" class="record-grid record-grid--dense">
            <div
              v-for="row in nodeRows"
              :key="row.node.id"
              class="record-card"
              :class="recordCardToneClass('node', row.node.status)"
            >
              <div class="record-card__head">
                <div class="min-w-0">
                  <div class="record-card__title">
                    <el-link
                      v-if="hasModulePermission('nodes')"
                      type="primary"
                      @click="$router.push(`/nodes/${row.node.id}`)"
                    >
                      {{ row.node.name }}
                    </el-link>
                    <span v-else>{{ row.node.name }}</span>
                  </div>
                  <div class="record-card__meta">{{ row.node.region || '—' }}</div>
                </div>
                <el-tag size="small" round type="info">{{ row.instances?.length || 0 }} 实例</el-tag>
              </div>
              <div class="record-card__fields">
                <div class="kv-row">
                  <span class="kv-label">状态</span>
                  <span class="kv-value">
                    <span class="status-dot" :class="`status-dot--${row.node.status}`" />
                    {{ getStatusInfo('node', row.node.status).label }}
                  </span>
                </div>
                <div class="kv-row">
                  <span class="kv-label">在线用户</span>
                  <span class="kv-value">{{ row.node.online_users ?? 0 }}</span>
                </div>
              </div>
            </div>
          </div>
          <el-empty v-else description="暂无节点" :image-size="60" />
        </div>
      </el-col>
      <el-col
        v-if="hasModulePermission('audit')"
        :xs="24"
        :sm="24"
        :md="dashboardTwoColumnBottom ? 10 : 24"
        :lg="dashboardTwoColumnBottom ? 10 : 24"
      >
        <div class="page-card">
          <div class="page-card-header">
            <span class="page-card-title">最近操作</span>
            <el-button
              v-if="hasModulePermission('audit')"
              plain
              type="primary"
              @click="$router.push('/audit')"
            >
              查看全部 <el-icon><ArrowRight /></el-icon>
            </el-button>
          </div>
          <el-timeline>
            <el-timeline-item
              v-for="log in recentLogs"
              :key="log.id"
              :timestamp="formatRelativeTime(log.created_at)"
              placement="top"
            >
              <div class="timeline-content">
                <span class="timeline-user">{{ log.admin_user }}</span>
                <span class="timeline-action">{{ log.action }}</span>
                <el-tag size="small" type="info" v-if="log.target">{{ log.target }}</el-tag>
              </div>
            </el-timeline-item>
            <el-empty v-if="!recentLogs.length" description="暂无操作记录" :image-size="60" />
          </el-timeline>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { reactive, ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Monitor,
  CircleCheck,
  UserFilled,
  User,
  Connection,
  ArrowRight
} from '@element-plus/icons-vue'
import http from '../api/http'
import {
  hasModulePermission,
  hasAnyModulePermission,
  isSuperAdminSession
} from '../utils/adminSession'
import { getStatusInfo, formatRelativeTime, recordCardToneClass } from '../utils'

const stats = reactive({ nodes: 0, onlineNodes: 0, onlineUsers: 0, users: 0, tunnels: 0 })
/** 仪表盘 /api/dashboard/stats 返回的原始计数，用于标签与副文案 */
const dashboardUserStats = reactive({ users_total: null, users_visible: null })
const nodeRows = ref([])
const recentLogs = ref([])
const showOnlineDialog = ref(false)
const onlineOverviewGrants = ref([])
const onlineOverviewNote = ref('')
/** 防止连续点击「在线用户」重复请求 */
const onlineOverviewLoading = ref(false)

const statCards = [
  { key: 'nodes', label: '节点总数', icon: Monitor, color: 'primary' },
  { key: 'onlineNodes', label: '在线节点', icon: CircleCheck, color: 'success' },
  { key: 'onlineUsers', label: '在线用户', icon: UserFilled, color: 'success' },
  { key: 'users', label: '用户', icon: User, color: 'warning' },
  { key: 'tunnels', label: '隧道数', icon: Connection, color: 'info' },
]

/** 与节点列表/实例相关的统计卡片（无节点类模块则不展示，亦不请求对应数据） */
const showNodeStatCards = computed(
  () =>
    isSuperAdminSession() ||
    hasAnyModulePermission(['nodes', 'users', 'admins', 'tunnels'])
)

/** 在线人数汇总与在线授权弹窗：与节点/用户/隧道/审计等管辖相关；纯 rules 等无需请求 online-overview */
const showOnlineOverviewStatCard = computed(
  () =>
    isSuperAdminSession() ||
    hasAnyModulePermission(['users', 'nodes', 'tunnels', 'admins', 'audit'])
)

const showTunnelStatCard = computed(
  () => isSuperAdminSession() || hasModulePermission('tunnels')
)

/**
 * 首页指标卡按权限裁剪，避免无权限项仍占位或触发点击请求。
 */
const visibleStatCards = computed(() => {
  const out = []
  for (const item of statCards) {
    if (item.key === 'nodes' || item.key === 'onlineNodes') {
      if (!showNodeStatCards.value) continue
    } else if (item.key === 'onlineUsers') {
      if (!showOnlineOverviewStatCard.value) continue
    } else if (item.key === 'tunnels') {
      if (!showTunnelStatCard.value) continue
    }
    out.push(item)
  }
  return out
})

/** 底部两栏同时展示时为 14+10；仅一栏时占满 */
const dashboardTwoColumnBottom = computed(
  () => showNodeStatCards.value && hasModulePermission('audit')
)

/** 用户卡片主标签：超管为「用户总数」，受限运维为「可见用户」 */
const userStatLabel = computed(() => {
  const t = dashboardUserStats.users_total
  const v = dashboardUserStats.users_visible
  if (t != null && v != null && t !== v) return '可见用户'
  return '用户总数'
})

/** 解析接口返回的在线人数（兼容 number / 字符串） */
const parseOnlineUsersSum = (raw) => {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw)
  const n = Number.parseInt(String(raw ?? '').trim(), 10)
  return Number.isFinite(n) ? n : 0
}

/** 点击「在线用户」卡片：拉取并展示在线节点上的有效授权 */
const openOnlineOverview = async () => {
  if (!showOnlineOverviewStatCard.value) return
  if (onlineOverviewLoading.value) return
  onlineOverviewLoading.value = true
  try {
    const res = await http.get('/api/dashboard/online-overview', {
      meta: { suppress404: true, suppress403: true }
    })
    const d = res.data || {}
    stats.onlineUsers = parseOnlineUsersSum(d.online_users_sum)
    onlineOverviewGrants.value = Array.isArray(d.grants) ? d.grants : []
    onlineOverviewNote.value = typeof d.note === 'string' ? d.note : ''
    showOnlineDialog.value = true
  } catch (e) {
    const st = e.response?.status
    if (st === 404) {
      ElMessage.info('当前后端不支持在线授权概览，请升级 vpn-api。')
    } else if (st === 403) {
      ElMessage.warning('当前账号无权查看在线授权概览。')
    } else if (st >= 500) {
      ElMessage.error('加载在线授权概览失败，请稍后重试。')
    }
  } finally {
    onlineOverviewLoading.value = false
  }
}

const onStatCardClick = (key) => {
  if (key === 'onlineUsers' && showOnlineOverviewStatCard.value) {
    void openOnlineOverview()
  }
}

/**
 * 「在线用户」卡片为 role=button：Enter / Space 触发（避免空格滚动页面）。
 * @param {KeyboardEvent} e
 * @param {string} key
 */
const onStatCardKeydown = (e, key) => {
  if (key !== 'onlineUsers' || !showOnlineOverviewStatCard.value) return
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  onStatCardClick(key)
}

/**
 * 仪表盘统计为「尽力而为」：缺路由不弹 404；无模块权限不弹 403（否则仅具部分权限的管理员每次打开首页都会被刷屏）。
 */
const safeFetch = async (url, config = {}) => {
  try {
    return await http.get(url, {
      ...config,
      meta: { suppress404: true, suppress403: true, ...config.meta }
    })
  } catch {
    return null
  }
}

/**
 * 仅在有后端对应模块权限时拉取节点列表，避免无权限账号打开首页仍请求 /api/nodes 导致控制台 403。
 * @returns {Promise<object | null>}
 */
const fetchNodesIfPermitted = () => {
  if (hasAnyModulePermission(['nodes', 'admins', 'tunnels'])) {
    return safeFetch('/api/nodes')
  }
  if (hasModulePermission('users')) {
    return safeFetch('/api/grantable-nodes')
  }
  return Promise.resolve(null)
}

onMounted(async () => {
  const auditP = hasModulePermission('audit')
    ? safeFetch('/api/audit-logs')
    : Promise.resolve(null)
  const tunnelsP = hasModulePermission('tunnels')
    ? safeFetch('/api/tunnels')
    : Promise.resolve(null)
  const onlineOvP = showOnlineOverviewStatCard.value
    ? safeFetch('/api/dashboard/online-overview')
    : Promise.resolve(null)
  const [nodesRes, dashStatsRes, tunnelsRes, logsRes, onlineOvRes] = await Promise.all([
    fetchNodesIfPermitted(),
    safeFetch('/api/dashboard/stats'),
    tunnelsP,
    auditP,
    onlineOvP,
  ])
  if (nodesRes) {
    const items = nodesRes.data.items || []
    nodeRows.value = items
    stats.nodes = items.length
    stats.onlineNodes = items.filter(i => i.node?.status === 'online').length
  }
  if (dashStatsRes?.data) {
    const d = dashStatsRes.data
    const vis = d.users_visible
    const tot = d.users_total
    dashboardUserStats.users_total = typeof tot === 'number' ? tot : null
    dashboardUserStats.users_visible = typeof vis === 'number' ? vis : null
    stats.users = typeof vis === 'number' ? vis : (typeof tot === 'number' ? tot : 0)
  } else if (hasModulePermission('users')) {
    const usersRes = await safeFetch('/api/users')
    if (usersRes) stats.users = (usersRes.data.items || []).length
  }
  if (tunnelsRes) stats.tunnels = (tunnelsRes.data.items || []).length
  if (logsRes) recentLogs.value = (logsRes.data.items || []).slice(0, 8)
  if (onlineOvRes?.data) {
    stats.onlineUsers = parseOnlineUsersSum(onlineOvRes.data.online_users_sum)
  }
})
</script>

<style scoped>
.dashboard-stat-col {
  margin-bottom: 12px;
}
.timeline-content {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.stat-hint {
  font-size: 11px;
  color: var(--text-secondary, #909399);
  margin-top: 2px;
  line-height: 1.3;
}

.stat-card--clickable {
  cursor: pointer;
}
.stat-card--clickable:hover {
  box-shadow: var(--shadow-md, 0 4px 12px rgba(0, 0, 0, 0.08));
}
.stat-card--clickable:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}
.stat-card--loading {
  opacity: 0.72;
  pointer-events: none;
}

.timeline-user {
  font-weight: 600;
  color: var(--text-primary);
}

.timeline-action {
  color: var(--text-regular);
}

@media (max-width: 768px) {
  .timeline-content {
    gap: 6px;
  }
}
</style>
