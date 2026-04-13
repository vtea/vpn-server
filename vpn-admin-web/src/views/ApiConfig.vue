<template>
  <div class="page-card">
    <div class="page-card-header">
      <span class="page-card-title">API 连接</span>
    </div>
    <p class="hint">
      管理台与后端不在同一域名/端口时，在此填写控制面 API 的根地址（协议 + 主机 + 端口，勿带 /api 后缀）。
      保存后即时生效，无需重新构建。
    </p>
    <el-form label-width="120px" style="max-width:640px">
      <el-form-item label="当前生效">
        <el-input :model-value="effectiveDisplay" readonly />
      </el-form-item>
      <el-form-item label="构建时默认">
        <el-input :model-value="buildDefaultDisplay" readonly />
        <div class="sub">来自环境变量 VITE_API_BASE_URL；未设置则为空（使用当前站点下的 /api/…）</div>
      </el-form-item>
      <el-form-item label="自定义地址">
        <el-input
          v-model="form.url"
          placeholder="例如 https://vpn-api.example.com 或 http://192.168.1.10:56700"
          clearable
        />
        <div class="sub">留空并保存表示强制使用「当前浏览器访问的站点」作为 API 根（同域）。</div>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="saving" @click="onSave">保存</el-button>
        <el-button @click="onReset">恢复构建默认</el-button>
        <el-button :loading="testing" @click="onTest">测试连接</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import http, {
  getApiBaseURL,
  setApiBaseURL,
  clearApiBaseURL,
  getBuildTimeApiBaseURL
} from '../api/http'
import { API_BASE_STORAGE_KEY } from '../utils/apiBase'

const form = reactive({ url: '' })
const saving = ref(false)
const testing = ref(false)

const effectiveDisplay = computed(() => getApiBaseURL() || '（空：使用当前站点相对路径 /api/…）')
const buildDefaultDisplay = computed(() => getBuildTimeApiBaseURL() || '（未设置）')

onMounted(() => {
  const raw = localStorage.getItem(API_BASE_STORAGE_KEY)
  form.url = raw !== null ? raw : ''
})

const onSave = () => {
  saving.value = true
  try {
    setApiBaseURL(form.url)
    ElMessage.success('已保存，后续请求将使用新地址')
  } finally {
    saving.value = false
  }
}

const onReset = () => {
  clearApiBaseURL()
  form.url = ''
  ElMessage.success('已恢复为构建时默认（或同域）')
}

const onTest = async () => {
  setApiBaseURL(form.url)
  testing.value = true
  try {
    const { data } = await http.get('/api/health')
    if (data && data.grant_purge === true) {
      ElMessage.success('连接成功：后端支持授权记录删除（grant_purge）')
    } else {
      ElMessage.warning({
        message:
          '已连通，但健康检查未返回 grant_purge。若「删除授权」报 404，请用当前仓库重新编译并重启 vpn-api。',
        duration: 8000,
        showClose: true
      })
    }
  } catch {
    // http 拦截器已提示
  } finally {
    testing.value = false
  }
}
</script>

<style scoped>
.hint {
  color: var(--text-secondary);
  font-size: 14px;
  margin: 0 0 20px;
  line-height: 1.6;
}
.sub {
  font-size: 12px;
  color: var(--text-placeholder);
  margin-top: 6px;
  line-height: 1.5;
}
</style>
