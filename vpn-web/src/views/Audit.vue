<template>
  <div>
    <div class="page-card">
      <div class="page-card-header">
        <span class="page-card-title">审计日志</span>
        <el-button @click="exportCSV">
          <el-icon><Download /></el-icon> 导出 CSV
        </el-button>
      </div>

      <div class="action-bar">
        <div class="filter-group">
          <el-input
            v-model="search"
            placeholder="搜索操作人 / 目标..."
            clearable
            style="width: 220px"
            :prefix-icon="Search"
            @clear="onSearch"
            @keyup.enter="onSearch"
          />
          <el-select
            v-model="actionFilter"
            placeholder="操作类型"
            clearable
            style="width: 160px"
            @change="onSearch"
          >
            <el-option v-for="a in actionOptions" :key="a" :label="a" :value="a" />
          </el-select>
        </div>
        <el-text type="info" size="small">共 {{ total }} 条记录</el-text>
      </div>

      <div v-loading="loading" class="record-grid record-grid--single">
        <div v-for="row in rows" :key="row.id" class="record-card">
          <div class="record-card__head">
            <div class="min-w-0">
              <div class="record-card__title">{{ formatDate(row.created_at) }}</div>
              <div class="record-card__meta">{{ row.admin_user || '—' }}</div>
            </div>
            <el-tag size="small" type="info">{{ row.action }}</el-tag>
          </div>
          <div class="record-card__fields">
            <div class="kv-row">
              <span class="kv-label">目标</span>
              <span class="kv-value">{{ row.target || '—' }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">详情</span>
              <span class="kv-value">{{ row.detail || '—' }}</span>
            </div>
          </div>
        </div>
        <el-empty v-if="!loading && !rows.length" description="暂无记录" :image-size="60" />
      </div>

      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="page"
          :page-size="pageSize"
          :total="total"
          :layout="paginationLayout"
          :page-sizes="[20, 50, 100]"
          :small="paginationSmall"
          @current-change="loadLogs"
          @size-change="onSizeChange"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { Search } from '@element-plus/icons-vue'
import http from '../api/http'
import { hasModulePermission } from '../utils/adminSession'
import { formatDate, downloadBlob } from '../utils'

const viewportNarrow = ref(typeof window !== 'undefined' && window.innerWidth <= 600)
const onResizeAudit = () => {
  viewportNarrow.value = window.innerWidth <= 600
}
const paginationLayout = computed(() =>
  viewportNarrow.value ? 'prev, pager, next' : 'total, prev, pager, next, sizes'
)
const paginationSmall = computed(() => viewportNarrow.value)

const rows = ref([])
const loading = ref(false)
const total = ref(0)
const page = ref(1)
const pageSize = ref(50)
const search = ref('')
const actionFilter = ref('')
const actionOptions = ref([])

const loadLogs = async () => {
  if (!hasModulePermission('audit')) return
  loading.value = true
  try {
    const params = { page: page.value, limit: pageSize.value }
    if (actionFilter.value) params.action = actionFilter.value
    if (search.value) params.search = search.value
    const res = await http.get('/api/audit-logs', { params })
    rows.value = res.data.items || []
    total.value = res.data.total || 0
    if (res.data.actions) actionOptions.value = res.data.actions.sort()
  } finally {
    loading.value = false
  }
}

const onSearch = () => { page.value = 1; loadLogs() }
const onSizeChange = (size) => { pageSize.value = size; page.value = 1; loadLogs() }

const exportCSV = () => {
  const header = 'time,admin,action,target,detail\n'
  const body = rows.value
    .map(r => `"${r.created_at}","${r.admin_user}","${r.action}","${r.target || ''}","${r.detail || ''}"`)
    .join('\n')
  downloadBlob(header + body, 'audit-logs.csv')
}

onMounted(() => {
  window.addEventListener('resize', onResizeAudit)
  loadLogs()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResizeAudit)
})
</script>
