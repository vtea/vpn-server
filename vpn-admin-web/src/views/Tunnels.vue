<template>
  <div>
    <div class="page-card mb-md">
      <div class="page-card-header">
        <span class="page-card-title">网络拓扑</span>
      </div>
      <div
        ref="topoCanvasRef"
        class="topo-canvas"
        @mousedown="onBgDown"
        @mousemove="onBgMove"
        @mouseup="onBgUp"
      >
        <svg :width="topoW" height="350" class="topo-svg">
          <line
            v-for="link in topoLinks"
            :key="link.id"
            :x1="link.x1" :y1="link.y1" :x2="link.x2" :y2="link.y2"
            :stroke="linkColor(link.status)"
            stroke-width="2"
            stroke-linecap="round"
          />
          <text
            v-for="link in topoLinks"
            :key="'lt' + link.id"
            :x="(link.x1 + link.x2) / 2"
            :y="(link.y1 + link.y2) / 2 - 8"
            text-anchor="middle"
            font-size="11"
            fill="var(--text-regular)"
          >
            {{ link.latency > 0 ? link.latency.toFixed(0) + 'ms' : '' }}
          </text>
          <text
            v-for="link in topoLinks"
            :key="'ll' + link.id"
            :x="(link.x1 + link.x2) / 2"
            :y="(link.y1 + link.y2) / 2 + 6"
            text-anchor="middle"
            font-size="10"
            :fill="link.loss > 0 ? 'var(--color-danger)' : 'var(--text-secondary)'"
          >
            {{ link.loss > 0 ? link.loss.toFixed(1) + '% loss' : '' }}
          </text>
        </svg>
        <div
          v-for="n in topoNodes"
          :key="n.id"
          class="topo-node"
          :style="{ left: n.x - 35 + 'px', top: n.y - 20 + 'px' }"
          @mousedown.stop="startDrag(n, $event)"
        >
          <div class="topo-dot" :class="{ 'is-online': n.status === 'online' }" />
          <div class="topo-label">{{ n.label }}</div>
          <div class="topo-users">{{ n.users || 0 }} 人在线</div>
        </div>
      </div>
    </div>

    <div class="page-card">
      <div class="page-card-header">
        <span class="page-card-title">隧道列表</span>
        <el-text type="info" size="small">共 {{ rows.length }} 条</el-text>
      </div>
      <el-table :data="rows" v-loading="loading" stripe size="small">
        <el-table-column prop="node_a" label="节点 A" min-width="120" />
        <el-table-column prop="node_b" label="节点 B" min-width="120" />
        <el-table-column label="A 在线人数" width="100" align="center">
          <template #default="{ row }">{{ nodeUserCount(row.node_a) }}</template>
        </el-table-column>
        <el-table-column label="B 在线人数" width="100" align="center">
          <template #default="{ row }">{{ nodeUserCount(row.node_b) }}</template>
        </el-table-column>
        <el-table-column prop="subnet" label="子网" min-width="140" />
        <el-table-column prop="status" label="状态" width="90">
          <template #default="{ row }">
            <span>
              <span class="status-dot" :class="`status-dot--${row.status}`" />
              {{ getStatusInfo('tunnel', row.status).label }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="latency_ms" label="延迟(ms)" width="100" align="center">
          <template #default="{ row }">
            {{ Number.isFinite(row.latency_ms) ? Number(row.latency_ms).toFixed(1) : '-' }}
          </template>
        </el-table-column>
        <el-table-column prop="loss_pct" label="丢包(%)" width="100" align="center">
          <template #default="{ row }">
            <el-text :type="row.loss_pct > 1 ? 'danger' : ''">
              {{ row.loss_pct > 0 ? row.loss_pct.toFixed(1) : '0' }}
            </el-text>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, nextTick } from 'vue'
import http from '../api/http'
import { getStatusInfo } from '../utils'

const rows = ref([])
const nodes = ref([])
const loading = ref(false)
const topoCanvasRef = ref(null)
const topoW = ref(750)
const dragState = reactive({ node: null, offsetX: 0, offsetY: 0 })
const nodePositions = reactive({})
let pollTimer = null
const POLL_INTERVAL_MS = 10000

const linkColor = (status) => {
  if (status === 'ok') return 'var(--color-success)'
  if (status === 'down') return 'var(--color-danger)'
  return 'var(--border-light)'
}

const topoNodes = computed(() => {
  const list = nodes.value
  if (!list.length) return []
  const cx = topoW.value / 2
  const cy = 175
  const r = 130
  return list.map((n, i) => {
    const id = n.node?.id
    if (!nodePositions[id]) {
      const angle = (2 * Math.PI * i) / list.length - Math.PI / 2
      nodePositions[id] = { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) }
    }
    return {
      id,
      label: n.node?.name || id,
      status: n.node?.status,
      users: n.node?.online_users,
      ...nodePositions[id],
    }
  })
})

const topoLinks = computed(() => {
  const m = {}
  topoNodes.value.forEach(n => { m[n.id] = n })
  return rows.value
    .map(t => {
      const a = m[t.node_a]
      const b = m[t.node_b]
      if (!a || !b) return null
      return {
        id: t.id,
        x1: a.x, y1: a.y,
        x2: b.x, y2: b.y,
        status: t.status,
        latency: t.latency_ms,
        loss: t.loss_pct,
      }
    })
    .filter(Boolean)
})

const nodeUserCount = (nodeID) => {
  const hit = nodes.value.find((n) => n.node?.id === nodeID)
  return hit?.node?.online_users ?? 0
}

const startDrag = (n, e) => {
  dragState.node = n
  dragState.offsetX = e.clientX - n.x
  dragState.offsetY = e.clientY - n.y
}

const onBgMove = (e) => {
  if (!dragState.node) return
  nodePositions[dragState.node.id] = {
    x: e.clientX - dragState.offsetX,
    y: e.clientY - dragState.offsetY,
  }
}

const onBgUp = () => { dragState.node = null }
const onBgDown = () => {}

const updateTopoWidth = () => {
  const w = topoCanvasRef.value?.clientWidth
  topoW.value = Math.max(320, Number(w) || 750)
}

const loadData = async () => {
  loading.value = true
  try {
    const [tRes, nRes] = await Promise.all([
      http.get('/api/tunnels'),
      http.get('/api/nodes'),
    ])
    rows.value = tRes.data.items || []
    nodes.value = nRes.data.items || []
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await nextTick()
  updateTopoWidth()
  window.addEventListener('resize', updateTopoWidth)
  await loadData()
  pollTimer = setInterval(loadData, POLL_INTERVAL_MS)
})

onUnmounted(() => {
  window.removeEventListener('resize', updateTopoWidth)
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
})
</script>

<style scoped>
.topo-canvas {
  width: 100%;
  height: 350px;
  position: relative;
  background: var(--border-lighter);
  border-radius: var(--radius-md);
  overflow: hidden;
  user-select: none;
}

.topo-svg {
  position: absolute;
  top: 0;
  left: 0;
}

.topo-node {
  position: absolute;
  width: 70px;
  text-align: center;
  cursor: grab;
}

.topo-node:active {
  cursor: grabbing;
}

.topo-dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  margin: 0 auto 2px;
  background: var(--text-secondary);
  transition: all var(--transition-fast);
}

.topo-dot.is-online {
  background: var(--color-success);
  box-shadow: 0 0 8px var(--color-success);
}

.topo-label {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--text-primary);
}

.topo-users {
  font-size: 10px;
  color: var(--text-secondary);
}

@media (max-width: 768px) {
  .topo-canvas {
    height: 300px;
  }
  .topo-node {
    width: 62px;
  }
  .topo-label {
    font-size: 11px;
  }
}
</style>
