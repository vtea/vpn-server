<template>
  <div>
    <div class="page-card">
      <div class="page-card-header">
        <span class="page-card-title">组网网段</span>
        <el-button v-if="canManageSegments" type="primary" @click="openAdd">
          <el-icon><Plus /></el-icon> 新建网段
        </el-button>
      </div>
      <el-text type="info" size="small" style="display:block;margin-bottom:12px;">
        网段 ID 由系统自动生成。地址第二段仅在<strong>新建</strong>时可填；监听起始端口支持随机分配或手动指定（UDP/TCP 共用端口，连续占用 4
        个端口）。新建节点在该网段下生成实例时，默认使用「默认协议」。若要让<strong>已有</strong>接入实例一并改协议，请点「编辑」修改默认协议并勾选「同步到已有实例」；否则库中
        <code>instances.proto</code> 不变，签发与用户 .ovpn 仍为旧协议。
      </el-text>
      <div v-loading="loading" class="record-grid">
        <div v-for="row in rows" :key="row.id" class="record-card">
          <div class="record-card__head">
            <div class="min-w-0">
              <div class="record-card__title mono-text">{{ row.id }}</div>
              <div class="record-card__meta">{{ row.name }}</div>
            </div>
            <el-tag size="small" effect="plain">{{ protoLabel(row.default_ovpn_proto) }}</el-tag>
          </div>
          <div class="record-card__fields">
            <div class="kv-row">
              <span class="kv-label">地址第二段</span>
              <span class="kv-value">{{ row.second_octet === 0 ? '（默认/旧公式）' : row.second_octet }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">监听起始端口</span>
              <span class="kv-value">{{ row.port_base ?? '—' }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">说明</span>
              <span class="kv-value">{{ row.description || '—' }}</span>
            </div>
          </div>
          <div class="record-card__actions">
            <template v-if="row.id !== 'default' && canManageSegments">
              <el-button size="small" type="primary" plain @click="openEdit(row)">编辑</el-button>
              <el-button size="small" type="danger" plain @click="removeSeg(row)">删除</el-button>
            </template>
            <el-text v-else type="info" size="small">内置（不可改网段属性）</el-text>
          </div>
        </div>
        <el-empty v-if="!loading && !rows.length" description="暂无网段" :image-size="60" />
      </div>
    </div>

    <el-dialog v-model="showAdd" title="新建组网网段" width="520px" destroy-on-close @open="onDialogOpen">
      <el-form :model="form" label-width="120px">
        <el-form-item label="网段 ID">
          <el-input model-value="保存后由系统自动生成" disabled />
        </el-form-item>
        <el-form-item label="名称" required>
          <el-input v-model="form.name" placeholder="如：上海出口" />
        </el-form-item>
        <el-form-item label="第二段 (1–254)" required>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;width:100%;">
            <el-input-number v-model="form.second_octet" :min="1" :max="254" controls-position="right" />
            <el-button size="small" :loading="hintLoading" @click="loadNextValues">按库重算推荐</el-button>
          </div>
          <el-text type="info" size="small">与数据库中已有网段的第二段不能重复。</el-text>
        </el-form-item>
        <el-form-item label="默认协议">
          <el-radio-group v-model="form.default_ovpn_proto">
            <el-radio label="udp">UDP</el-radio>
            <el-radio label="tcp">TCP</el-radio>
          </el-radio-group>
          <el-text type="info" size="small" style="display:block;margin-top:4px;">
            此后绑定本网段的新节点，其四套 OpenVPN 实例默认使用该协议；可与其它网段不同以实现 UDP/TCP 并存。
          </el-text>
        </el-form-item>
        <el-form-item label="监听端口">
          <div style="display:flex;flex-direction:column;gap:8px;width:100%;">
            <el-radio-group v-model="form.port_mode">
              <el-radio label="random">随机分配</el-radio>
              <el-radio label="manual">手动指定</el-radio>
            </el-radio-group>
            <el-input-number
              v-if="form.port_mode === 'manual'"
              v-model="form.port_base"
              :min="1"
              :max="65531"
              controls-position="right"
              style="width: 220px"
            />
            <el-input v-else :model-value="portHint" readonly />
          </div>
          <el-text type="info" size="small" style="display:block;margin-top:4px;">
            {{ portHelpText }}
          </el-text>
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="form.description" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAdd = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showEdit" title="编辑组网网段" width="520px" destroy-on-close>
      <el-form :model="editForm" label-width="120px">
        <el-form-item label="网段 ID">
          <el-input :model-value="editForm.id" disabled />
        </el-form-item>
        <el-form-item label="名称" required>
          <el-input v-model="editForm.name" placeholder="显示名称" />
        </el-form-item>
        <el-form-item label="默认协议">
          <el-radio-group v-model="editForm.default_ovpn_proto">
            <el-radio label="udp">UDP</el-radio>
            <el-radio label="tcp">TCP</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-alert
          v-if="editProtoChanged"
          type="warning"
          :closable="false"
          show-icon
          style="margin-bottom: 12px"
        >
          仅改网段默认不会更新已有实例。若希望本网段下<strong>所有已存在</strong>接入实例改为新协议，请勾选下方选项（对应 API
          <code>apply_to_instances: true</code>）。
        </el-alert>
        <el-form-item v-if="editProtoChanged" label=" ">
          <el-checkbox v-model="editForm.apply_to_instances">
            将默认协议同步到本网段下已有接入实例（推荐）
          </el-checkbox>
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="editForm.description" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEdit = false">取消</el-button>
        <el-button type="primary" :loading="editSaving" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import http from '../api/http'
import { getAdminProfile, isSuperAdminSession } from '../utils/adminSession'

const PORT_MIN = 56714

/** 与 JWT 优先的超管判定一致，避免仅本地 profile 缺失时误隐藏「添加」等入口 */
const canManageSegments = computed(() => {
  if (isSuperAdminSession()) return true
  const p = getAdminProfile()
  return p?.node_scope === 'all'
})

const rows = ref([])
const loading = ref(false)
const showAdd = ref(false)
const saving = ref(false)
const hintLoading = ref(false)
const previewPortBase = ref(null)
const showEdit = ref(false)
const editSaving = ref(false)
const editForm = reactive({
  id: '',
  name: '',
  description: '',
  default_ovpn_proto: 'udp',
  /** 打开对话框时的协议，用于判断是否展示 apply_to_instances */
  initialProto: 'udp',
  /** 修改默认协议时默认勾选，与计划一致 */
  apply_to_instances: true
})

const form = reactive({
  name: '',
  second_octet: 1,
  description: '',
  default_ovpn_proto: 'udp',
  port_mode: 'random',
  port_base: 56714
})

const portHint = computed(() => {
  if (previewPortBase.value != null) {
    return `预览约 ${previewPortBase.value}–${previewPortBase.value + 3}（保存时重新随机）`
  }
  return `创建时随机（≥${PORT_MIN}，保证不冲突）`
})

const portHelpText = computed(() => {
  if (form.port_mode === 'manual') {
    return '手动输入监听起始端口（1–65531），系统会占用连续 4 个端口并校验与已有网段不冲突；低位端口可能需要节点系统权限。'
  }
  return `创建时在 ${PORT_MIN}–65531 内随机选取连续 4 个端口（UDP/TCP 共用）；下方为预览，实际以保存成功后的值为准。`
})

const protoLabel = (p) => ((p || 'udp').toLowerCase() === 'tcp' ? 'TCP' : 'UDP')

const normProto = (p) => ((p || 'udp').toLowerCase() === 'tcp' ? 'tcp' : 'udp')

const editProtoChanged = computed(
  () => normProto(editForm.default_ovpn_proto) !== normProto(editForm.initialProto)
)

const load = async () => {
  loading.value = true
  try {
    const res = await http.get('/api/network-segments')
    rows.value = res.data.items || []
  } finally {
    loading.value = false
  }
}

const loadNextValues = async () => {
  hintLoading.value = true
  try {
    const res = await http.get('/api/network-segments/next-values')
    const s = res.data.suggested_second_octet
    if (typeof s === 'number') form.second_octet = s
    previewPortBase.value = res.data.suggested_port_base ?? null
  } catch {
    previewPortBase.value = null
  } finally {
    hintLoading.value = false
  }
}

const onDialogOpen = () => {
  Object.assign(form, {
    name: '',
    second_octet: 1,
    description: '',
    default_ovpn_proto: 'udp',
    port_mode: 'random',
    port_base: PORT_MIN
  })
  previewPortBase.value = null
  loadNextValues()
}

const openAdd = () => {
  showAdd.value = true
}

const openEdit = (row) => {
  const p = normProto(row.default_ovpn_proto)
  editForm.id = row.id
  editForm.name = row.name || ''
  editForm.description = row.description || ''
  editForm.default_ovpn_proto = p
  editForm.initialProto = p
  editForm.apply_to_instances = true
  showEdit.value = true
}

const submitEdit = async () => {
  if (!editForm.name?.trim()) {
    ElMessage.warning('请填写名称')
    return
  }
  editSaving.value = true
  try {
    const body = {
      name: editForm.name.trim(),
      description: editForm.description || ''
    }
    const newP = normProto(editForm.default_ovpn_proto)
    const oldP = normProto(editForm.initialProto)
    if (newP !== oldP) {
      body.default_ovpn_proto = newP
      body.apply_to_instances = editForm.apply_to_instances
    }
    await http.patch(`/api/network-segments/${editForm.id}`, body)
    const syncHint = newP !== oldP && editForm.apply_to_instances ? '，已批量更新本网段下实例协议' : ''
    ElMessage.success(`已保存${syncHint}`)
    showEdit.value = false
    load()
  } catch {
    // http 统一处理
  } finally {
    editSaving.value = false
  }
}

const submit = async () => {
  if (!form.name?.trim()) {
    ElMessage.warning('请填写名称')
    return
  }
  if (!form.second_octet || form.second_octet < 1 || form.second_octet > 254) {
    ElMessage.warning('第二段须为 1–254')
    return
  }
  if (form.port_mode === 'manual') {
    if (!Number.isInteger(form.port_base) || form.port_base < 1 || form.port_base > 65531) {
      ElMessage.warning('监听端口须为 1–65531 的整数')
      return
    }
  }
  saving.value = true
  try {
    const body = {
      name: form.name.trim(),
      second_octet: form.second_octet,
      description: form.description || '',
      default_ovpn_proto: form.default_ovpn_proto === 'tcp' ? 'tcp' : 'udp'
    }
    if (form.port_mode === 'manual') {
      body.port_base = form.port_base
    }
    const res = await http.post('/api/network-segments', body)
    const seg = res.data.segment
    const pr = seg ? `${protoLabel(seg.default_ovpn_proto)} ${seg.port_base}–${seg.port_base + 3}` : ''
    ElMessage.success(seg ? `已创建，ID: ${seg.id}，${pr}` : '已创建')
    showAdd.value = false
    load()
  } catch {
    // http 统一处理
  } finally {
    saving.value = false
  }
}

const removeSeg = async (row) => {
  try {
    await ElMessageBox.confirm(`确定删除网段「${row.name}」？若有节点绑定将失败。`, '确认', { type: 'warning' })
    await http.delete(`/api/network-segments/${row.id}`)
    ElMessage.success('已删除')
    load()
  } catch (e) {
    if (e !== 'cancel') {
      // http 已提示
    }
  }
}

void load().catch(() => {})
</script>
