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

      <el-table :data="rows" v-loading="loading" stripe>
        <el-table-column prop="created_at" label="时间" width="180">
          <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
        </el-table-column>
        <el-table-column prop="admin_user" label="操作人" width="110" />
        <el-table-column prop="action" label="动作" width="160">
          <template #default="{ row }">
            <el-tag size="small" type="info">{{ row.action }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="target" label="目标" min-width="140" />
        <el-table-column prop="detail" label="详情" min-width="180" show-overflow-tooltip />
      </el-table>

      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="page"
          :page-size="pageSize"
          :total="total"
          layout="total, prev, pager, next, sizes"
          :page-sizes="[20, 50, 100]"
          @current-change="loadLogs"
          @size-change="onSizeChange"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { Search } from '@element-plus/icons-vue'
import http from '../api/http'
import { formatDate, downloadBlob } from '../utils'

const rows = ref([])
const loading = ref(false)
const total = ref(0)
const page = ref(1)
const pageSize = ref(50)
const search = ref('')
const actionFilter = ref('')
const actionOptions = ref([])

const loadLogs = async () => {
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

onMounted(loadLogs)
</script>
