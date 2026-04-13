<template>
  <div>
    <el-row :gutter="16" class="mb-lg">
      <el-col
        v-for="item in statCards"
        :key="item.key"
        :xs="12"
        :sm="12"
        :md="8"
        :lg="6"
        class="dashboard-stat-col"
      >
        <div class="stat-card">
          <div class="stat-icon" :class="`stat-icon--${item.color}`">
            <el-icon :size="24"><component :is="item.icon" /></el-icon>
          </div>
          <div class="stat-content">
            <div class="stat-value">{{ stats[item.key] }}</div>
            <div class="stat-label">{{ item.label }}</div>
          </div>
        </div>
      </el-col>
    </el-row>

    <el-row :gutter="16">
      <el-col :xs="24" :sm="24" :md="14" :lg="14">
        <div class="page-card">
          <div class="page-card-header">
            <span class="page-card-title">节点状态</span>
            <el-button plain type="primary" @click="$router.push('/nodes')">
              查看全部 <el-icon><ArrowRight /></el-icon>
            </el-button>
          </div>
          <el-table :data="nodeRows" size="small" stripe>
            <el-table-column prop="node.name" label="名称" min-width="120">
              <template #default="{ row }">
                <el-link type="primary" @click="$router.push(`/nodes/${row.node.id}`)">
                  {{ row.node.name }}
                </el-link>
              </template>
            </el-table-column>
            <el-table-column prop="node.region" label="地域" width="100" />
            <el-table-column prop="node.status" label="状态" width="90">
              <template #default="{ row }">
                <span>
                  <span class="status-dot" :class="`status-dot--${row.node.status}`" />
                  {{ getStatusInfo('node', row.node.status).label }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="实例数" width="80" align="center">
              <template #default="{ row }">
                <el-tag size="small" round>{{ row.instances?.length || 0 }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="node.online_users" label="在线" width="70" align="center" />
          </el-table>
        </div>
      </el-col>
      <el-col :xs="24" :sm="24" :md="10" :lg="10">
        <div class="page-card">
          <div class="page-card-header">
            <span class="page-card-title">最近操作</span>
            <el-button plain type="primary" @click="$router.push('/audit')">
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
import { reactive, ref, onMounted } from 'vue'
import http from '../api/http'
import { getStatusInfo, formatRelativeTime } from '../utils'

const stats = reactive({ nodes: 0, onlineNodes: 0, users: 0, tunnels: 0 })
const nodeRows = ref([])
const recentLogs = ref([])

const statCards = [
  { key: 'nodes', label: '节点总数', icon: 'Monitor', color: 'primary' },
  { key: 'onlineNodes', label: '在线节点', icon: 'CircleCheck', color: 'success' },
  { key: 'users', label: '用户总数', icon: 'User', color: 'warning' },
  { key: 'tunnels', label: '隧道数', icon: 'Connection', color: 'info' },
]

const safeFetch = async (url, params) => {
  try { return await http.get(url, params) } catch { return null }
}

onMounted(async () => {
  const [nodesRes, usersRes, tunnelsRes, logsRes] = await Promise.all([
    safeFetch('/api/nodes'),
    safeFetch('/api/users'),
    safeFetch('/api/tunnels'),
    safeFetch('/api/audit-logs'),
  ])
  if (nodesRes) {
    const items = nodesRes.data.items || []
    nodeRows.value = items
    stats.nodes = items.length
    stats.onlineNodes = items.filter(i => i.node?.status === 'online').length
  }
  if (usersRes) stats.users = (usersRes.data.items || []).length
  if (tunnelsRes) stats.tunnels = (tunnelsRes.data.items || []).length
  if (logsRes) recentLogs.value = (logsRes.data.items || []).slice(0, 8)
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
