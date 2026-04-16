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
      <el-table :data="ipListRows" v-loading="loadingIP" stripe size="small">
        <el-table-column prop="node_id" label="节点" min-width="120" />
        <el-table-column prop="domestic_version" label="国内版本" min-width="120" />
        <el-table-column prop="domestic_entry_count" label="国内条目数" width="110" align="center" />
        <el-table-column prop="domestic_last_update_at" label="国内更新时间" min-width="160">
          <template #default="{ row }">{{ formatDate(row.domestic_last_update_at) }}</template>
        </el-table-column>
        <el-table-column prop="overseas_version" label="海外版本" min-width="120" />
        <el-table-column prop="overseas_entry_count" label="海外条目数" width="110" align="center" />
        <el-table-column prop="overseas_last_update_at" label="海外更新时间" min-width="160">
          <template #default="{ row }">{{ formatDate(row.overseas_last_update_at) }}</template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loadingIP && !ipListRows.length" description="暂无 IP 库数据" :image-size="60" />
    </div>

    <div v-if="sourceApiSupported" class="page-card mb-md">
      <div class="page-card-header">
        <span class="page-card-title">IP 库同步源配置</span>
      </div>
      <el-table :data="ipSources" v-loading="loadingSources" stripe size="small">
        <el-table-column prop="scope" label="库类型" width="100">
          <template #default="{ row }">{{ row.scope === 'domestic' ? '国内库' : '海外库' }}</template>
        </el-table-column>
        <el-table-column prop="primary_url" label="主地址" min-width="220" />
        <el-table-column prop="mirror_url" label="镜像地址" min-width="220" />
        <el-table-column prop="max_time_sec" label="超时(s)" width="90" />
        <el-table-column prop="retry_count" label="重试" width="80" />
        <el-table-column prop="enabled" label="启用" width="80" align="center">
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? '是' : '否' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" align="center">
          <template #default="{ row }">
            <el-button size="small" @click="openEditSource(row)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>
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
      <el-table :data="exceptions" v-loading="loadingEx" stripe size="small">
        <el-table-column prop="cidr" label="IP 段" min-width="140" />
        <el-table-column prop="domain" label="域名" min-width="140" />
        <el-table-column prop="direction" label="方向" width="100">
          <template #default="{ row }">
            <el-tag :type="row.direction === 'foreign' ? 'warning' : 'success'" size="small">
              {{ row.direction === 'foreign' ? '走境外' : '走国内' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="备注" min-width="120" />
        <el-table-column label="操作" width="90" align="center" class-name="op-col">
          <template #default="{ row }">
            <el-popconfirm title="删除此规则？" @confirm="deleteEx(row.id)">
              <template #reference>
                <el-button size="small" plain type="danger">
                  <el-icon><Delete /></el-icon> 删除
                </el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loadingEx && !exceptions.length" description="暂无例外规则" :image-size="60" />
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
import { formatDate } from '../utils'

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
    const scope = sourceApiSupported.value ? updateScope.value : 'domestic'
    await http.post('/api/ip-list/update', { scope })
    ElMessage.success('更新指令已下发')
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
  .page-card :deep(.el-table__cell),
  .page-card :deep(.el-table .el-button) {
    white-space: nowrap;
  }
  .rules-dialog :deep(.el-dialog__body) {
    padding: 12px;
  }
}
</style>
