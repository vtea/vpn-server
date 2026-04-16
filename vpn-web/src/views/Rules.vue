<template>
  <div>
    <div class="page-card mb-md">
      <div class="page-card-header">
        <span class="page-card-title">IP 库状态（国内/海外）</span>
        <div class="rules-actions">
          <el-select v-model="updateScope" style="width: 140px">
            <el-option label="全部" value="all" />
            <el-option label="仅国内" value="domestic" />
            <el-option label="仅海外" value="overseas" />
          </el-select>
          <el-button type="primary" class="rules-header-btn" @click="triggerUpdate" :loading="updating">
          <el-icon><Refresh /></el-icon> 全网立即更新
        </el-button>
        </div>
      </div>
      <div v-loading="loadingIP" class="record-grid">
        <div v-for="row in ipListRows" :key="row.node_id" class="record-card">
          <div class="record-card__head">
            <div class="record-card__title mono-text min-w-0">{{ row.node_id }}</div>
          </div>
          <div class="record-card__fields">
            <div class="kv-row">
              <span class="kv-label">国内版本</span>
              <span class="kv-value">{{ row.domestic_version || '—' }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">国内条目 / 更新</span>
              <span class="kv-value">{{ row.domestic_entry_count ?? 0 }} · {{ formatDate(row.domestic_last_update_at) }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">海外版本</span>
              <span class="kv-value">{{ row.overseas_version || '—' }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">海外条目 / 更新</span>
              <span class="kv-value">{{ row.overseas_entry_count ?? 0 }} · {{ formatDate(row.overseas_last_update_at) }}</span>
            </div>
          </div>
        </div>
        <el-empty v-if="!loadingIP && !ipListRows.length" description="暂无 IP 库数据" :image-size="60" />
      </div>
    </div>

    <div v-if="sourceApiSupported" class="page-card mb-md">
      <div class="page-card-header">
        <span class="page-card-title">IP 库同步源配置</span>
      </div>
      <div v-loading="loadingSources" class="record-grid record-grid--single">
        <div
          v-for="row in ipSources"
          :key="row.scope"
          class="record-card"
          :class="recordCardToneFromTagType(row.enabled ? 'success' : 'info')"
        >
          <div class="record-card__head">
            <div class="record-card__title">{{ row.scope === 'domestic' ? '国内库' : '海外库' }}</div>
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? '启用' : '关闭' }}</el-tag>
          </div>
          <div class="record-card__fields">
            <div class="kv-row">
              <span class="kv-label">主地址</span>
              <span class="kv-value">{{ row.primary_url || '—' }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">镜像</span>
              <span class="kv-value">{{ row.mirror_url || '—' }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">超时 / 重试</span>
              <span class="kv-value">{{ row.max_time_sec ?? '—' }}s · {{ row.retry_count ?? '—' }} 次</span>
            </div>
          </div>
          <div class="record-card__actions">
            <el-button size="small" @click="openEditSource(row)">编辑</el-button>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="page-card mb-md">
      <el-alert
        title="当前 API 版本暂不支持“同步源配置”，已自动降级为兼容模式（不影响国内库基础功能）。"
        type="warning"
        :closable="false"
        show-icon
      />
    </div>

    <div class="page-card">
      <div class="page-card-header">
        <span class="page-card-title">手工例外规则</span>
        <el-button type="primary" class="rules-header-btn" @click="showAddEx = true">
          <el-icon><Plus /></el-icon> 添加规则
        </el-button>
      </div>
      <div v-loading="loadingEx" class="record-grid">
        <div
          v-for="row in exceptions"
          :key="row.id"
          class="record-card"
          :class="recordCardToneFromTagType(row.direction === 'foreign' ? 'warning' : 'success')"
        >
          <div class="record-card__head">
            <div class="record-card__title mono-text min-w-0">{{ row.cidr || row.domain || '例外规则' }}</div>
            <el-tag :type="row.direction === 'foreign' ? 'warning' : 'success'" size="small">
              {{ row.direction === 'foreign' ? '走境外' : '走国内' }}
            </el-tag>
          </div>
          <div class="record-card__fields">
            <div class="kv-row">
              <span class="kv-label">IP 段</span>
              <span class="kv-value mono-text">{{ row.cidr || '—' }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">域名</span>
              <span class="kv-value">{{ row.domain || '—' }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">备注</span>
              <span class="kv-value">{{ row.note || '—' }}</span>
            </div>
          </div>
          <div class="record-card__actions">
            <el-popconfirm title="删除此规则？" @confirm="deleteEx(row.id)">
              <template #reference>
                <el-button size="small" plain type="danger">
                  <el-icon><Delete /></el-icon> 删除
                </el-button>
              </template>
            </el-popconfirm>
          </div>
        </div>
        <el-empty v-if="!loadingEx && !exceptions.length" description="暂无例外规则" :image-size="60" />
      </div>
    </div>

    <el-dialog v-model="showAddEx" title="添加例外规则" width="min(480px, 92vw)" destroy-on-close class="rules-dialog">
      <el-form :model="exForm" label-width="80px">
        <el-form-item label="IP 段">
          <el-input v-model="exForm.cidr" placeholder="如 104.16.0.0/12" />
        </el-form-item>
        <el-form-item label="域名">
          <el-input v-model="exForm.domain" placeholder="如 *.notion.so" />
        </el-form-item>
        <el-form-item label="方向">
          <el-select v-model="exForm.direction" style="width: 100%">
            <el-option label="走境外" value="foreign" />
            <el-option label="走国内" value="domestic" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="exForm.note" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddEx = false">取消</el-button>
        <el-button type="primary" @click="doAddEx">确认</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showEditSource" title="编辑同步源" width="min(560px, 92vw)" destroy-on-close class="rules-dialog">
      <el-form :model="sourceForm" label-width="110px">
        <el-form-item label="主地址">
          <el-input v-model="sourceForm.primary_url" />
        </el-form-item>
        <el-form-item label="镜像地址">
          <el-input v-model="sourceForm.mirror_url" />
        </el-form-item>
        <el-form-item label="连接超时(s)">
          <el-input-number v-model="sourceForm.connect_timeout_sec" :min="1" :max="60" />
        </el-form-item>
        <el-form-item label="总超时(s)">
          <el-input-number v-model="sourceForm.max_time_sec" :min="3" :max="300" />
        </el-form-item>
        <el-form-item label="重试次数">
          <el-input-number v-model="sourceForm.retry_count" :min="0" :max="10" />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="sourceForm.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditSource = false">取消</el-button>
        <el-button type="primary" @click="saveSource">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import http from '../api/http'
import { formatDate, recordCardToneFromTagType } from '../utils'

const ipListRows = ref([])
const loadingIP = ref(false)
const updating = ref(false)
const updateScope = ref('all')
const ipSources = ref([])
const loadingSources = ref(false)
const sourceApiSupported = ref(true)
const showEditSource = ref(false)
const sourceForm = reactive({
  scope: 'domestic',
  primary_url: '',
  mirror_url: '',
  connect_timeout_sec: 8,
  max_time_sec: 30,
  retry_count: 2,
  enabled: true
})

const exceptions = ref([])
const loadingEx = ref(false)
const showAddEx = ref(false)
const exForm = reactive({ cidr: '', domain: '', direction: 'foreign', note: '' })

const loadIP = async () => {
  loadingIP.value = true
  try {
    const resp = await http.get('/api/ip-list/status')
    const rows = resp.data.items || []
    ipListRows.value = rows.map((row) => {
      // 兼容旧后端返回字段：version/entry_count/last_update_at
      if (!Object.prototype.hasOwnProperty.call(row, 'domestic_version')) {
        return {
          node_id: row.node_id,
          domestic_version: row.version || '未更新',
          domestic_entry_count: row.entry_count || 0,
          domestic_last_update_at: row.last_update_at || '',
          overseas_version: '未更新',
          overseas_entry_count: 0,
          overseas_last_update_at: ''
        }
      }
      return row
    })
  } finally {
    loadingIP.value = false
  }
}

const loadSources = async () => {
  loadingSources.value = true
  try {
    const resp = await http.get('/api/ip-list/sources', { meta: { suppress404: true } })
    ipSources.value = resp.data.items || []
    sourceApiSupported.value = true
  } catch (err) {
    if (err?.response?.status === 404) {
      sourceApiSupported.value = false
      ipSources.value = []
      return
    }
    throw err
  } finally {
    loadingSources.value = false
  }
}

const loadEx = async () => {
  loadingEx.value = true
  try {
    exceptions.value = (await http.get('/api/ip-list/exceptions')).data.items || []
  } finally {
    loadingEx.value = false
  }
}

const triggerUpdate = async () => {
  updating.value = true
  try {
    const scope = sourceApiSupported.value ? updateScope.value : 'all'
    const resp = await http.post('/api/ip-list/update', { scope })
    const sent = resp.data?.sent_to
    const total = resp.data?.total_nodes
    if (typeof sent === 'number' && typeof total === 'number') {
      if (sent === 0) {
        ElMessage.warning(
          `没有 WebSocket 在线的节点（0 / ${total}），指令未下发。请确认各节点 vpn-agent 已运行且能连上控制面。`
        )
      } else {
        ElMessage.success(`更新指令已下发（在线 ${sent} / 共 ${total} 节点）`)
      }
    } else {
      ElMessage.success('更新指令已下发')
    }
    setTimeout(loadIP, 3000)
  } finally {
    updating.value = false
  }
}

const openEditSource = (row) => {
  if (!sourceApiSupported.value) return
  Object.assign(sourceForm, row)
  showEditSource.value = true
}

const saveSource = async () => {
  try {
    await http.patch(`/api/ip-list/sources/${sourceForm.scope}`, {
      primary_url: sourceForm.primary_url,
      mirror_url: sourceForm.mirror_url,
      connect_timeout_sec: sourceForm.connect_timeout_sec,
      max_time_sec: sourceForm.max_time_sec,
      retry_count: sourceForm.retry_count,
      enabled: sourceForm.enabled
    })
    ElMessage.success('同步源已更新')
    showEditSource.value = false
    loadSources()
  } catch {
    // http.js 已统一处理
  }
}

const doAddEx = async () => {
  try {
    await http.post('/api/ip-list/exceptions', exForm)
    ElMessage.success('已添加')
    showAddEx.value = false
    Object.assign(exForm, { cidr: '', domain: '', direction: 'foreign', note: '' })
    loadEx()
  } catch {
    // http.js 已统一处理
  }
}

const deleteEx = async (id) => {
  try {
    await http.delete(`/api/ip-list/exceptions/${id}`)
    ElMessage.success('已删除')
    loadEx()
  } catch {
    // http.js 已统一处理
  }
}

onMounted(() => {
  void loadIP().catch(() => {})
  void loadSources().catch(() => {})
  void loadEx().catch(() => {})
})
</script>

<style scoped>
@media (max-width: 768px) {
  .rules-actions {
    width: 100%;
    display: flex;
    gap: 8px;
  }
  .rules-header-btn {
    flex: 1;
  }
  .rules-dialog :deep(.el-dialog__body) {
    padding: 12px;
  }
}
</style>
