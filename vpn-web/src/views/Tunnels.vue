<template>
  <div>
    <div class="page-card mb-md">
      <div class="page-card-header topo-page-head">
        <span class="page-card-title">网络拓扑</span>
        <el-text class="topo-gesture-hint" type="info" size="small">
          移动端：单指拖空白处平移 · 双指捏合缩放 · 拖动节点可重排
        </el-text>
      </div>
      <div
        ref="topoCanvasRef"
        class="topo-canvas"
        @pointerdown="onCanvasPointerDown"
        @pointermove="onCanvasPointerMove"
        @pointerup="onCanvasPointerUp"
        @pointercancel="onCanvasPointerUp"
        @pointerleave="onCanvasPointerLeave"
      >
        <div class="topo-transform-layer" :style="topoLayerStyle">
          <svg :width="topoW" :height="topoH" class="topo-svg" aria-hidden="true">
            <defs>
              <filter id="topo-link-soft-glow" x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur stdDeviation="2.2" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <g
              v-for="link in topoLinks"
              :key="link.id"
              class="topo-link-group"
            >
              <line
                class="topo-link-glow"
                :x1="link.x1"
                :y1="link.y1"
                :x2="link.x2"
                :y2="link.y2"
                :stroke="linkPalette(link.status).glow"
                stroke-width="7"
                stroke-linecap="round"
                opacity="0.55"
              />
              <line
                class="topo-link-core"
                :x1="link.x1"
                :y1="link.y1"
                :x2="link.x2"
                :y2="link.y2"
                :stroke="linkPalette(link.status).core"
                stroke-width="2.2"
                stroke-linecap="round"
                filter="url(#topo-link-soft-glow)"
              />
              <text
                class="topo-link-metric topo-link-metric--latency"
                :x="(link.x1 + link.x2) / 2"
                :y="(link.y1 + link.y2) / 2 - 8"
                text-anchor="middle"
                font-size="11"
              >
                {{ link.latency > 0 ? link.latency.toFixed(0) + 'ms' : '' }}
              </text>
              <text
                class="topo-link-metric"
                :class="{ 'topo-link-metric--loss': link.loss > 0 }"
                :x="(link.x1 + link.x2) / 2"
                :y="(link.y1 + link.y2) / 2 + 6"
                text-anchor="middle"
                font-size="10"
              >
                {{ link.loss > 0 ? link.loss.toFixed(1) + '% loss' : '' }}
              </text>
            </g>
          </svg>
          <div
            v-for="n in topoNodes"
            :key="n.id"
            class="topo-node"
            :class="{ 'is-node-online': n.status === 'online' }"
            :style="nodeBoxStyle(n)"
            @pointerdown.stop="onNodePointerDown(n, $event)"
          >
            <div class="topo-rack-wrap">
              <svg class="topo-rack-svg" viewBox="0 0 28 34" aria-hidden="true">
                <defs>
                  <linearGradient :id="'topoRackGrad-' + n.id" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stop-color="#64748b" />
                    <stop offset="55%" stop-color="#3d4f63" />
                    <stop offset="100%" stop-color="#1e293b" />
                  </linearGradient>
                </defs>
                <rect
                  x="0.5"
                  y="0.5"
                  width="27"
                  height="33"
                  rx="2.5"
                  :fill="'url(#topoRackGrad-' + n.id + ')'"
                  stroke="#94a3b8"
                  stroke-width="0.6"
                />
                <rect x="2.5" y="3" width="23" height="9" rx="1.2" fill="#0f172a" stroke="#334155" stroke-width="0.4" />
                <rect x="4" y="5" width="7" height="1.8" rx="0.35" fill="#1e293b" />
                <rect x="4" y="7.2" width="11" height="1.4" rx="0.35" fill="#1e293b" />
                <circle cx="22.5" cy="7.5" r="1.35" :fill="rackLedColor(n)" class="topo-rack-led" />

                <rect x="2.5" y="13.5" width="23" height="9" rx="1.2" fill="#0f172a" stroke="#334155" stroke-width="0.4" />
                <rect x="4" y="15.5" width="7" height="1.8" rx="0.35" fill="#1e293b" />
                <rect x="4" y="17.7" width="9" height="1.4" rx="0.35" fill="#1e293b" />
                <circle cx="22.5" cy="18" r="1.35" :fill="rackLedColor(n)" class="topo-rack-led" />

                <rect x="2.5" y="24" width="23" height="8" rx="1.2" fill="#0f172a" stroke="#334155" stroke-width="0.4" />
                <rect x="4" y="25.8" width="9" height="1.6" rx="0.35" fill="#1e293b" />
                <rect x="4" y="27.8" width="6" height="1.2" rx="0.35" fill="#1e293b" />
                <circle cx="22.5" cy="28" r="1.35" :fill="rackLedColor(n)" class="topo-rack-led" />
              </svg>
            </div>
            <div class="topo-node-meta">
              <div class="topo-label">{{ n.label }}</div>
              <div class="topo-users">{{ n.users || 0 }} 人在线</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="page-card">
      <div class="page-card-header">
        <span class="page-card-title">隧道列表</span>
        <el-text type="info" size="small">共 {{ rows.length }} 条</el-text>
      </div>
      <div v-loading="loading" class="record-grid">
        <div
          v-for="row in rows"
          :key="row.id || `${row.node_a}-${row.node_b}-${row.subnet}`"
          class="record-card"
          :class="recordCardToneClass('tunnel', row.status)"
        >
          <div class="record-card__head">
            <div class="record-card__title min-w-0">
              {{ row.node_a }}
              <span class="record-card__meta" style="display:inline;margin:0 6px">↔</span>
              {{ row.node_b }}
            </div>
          </div>
          <div class="record-card__fields">
            <div class="kv-row">
              <span class="kv-label">子网</span>
              <span class="kv-value mono-text">{{ row.subnet || '—' }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">状态</span>
              <span class="kv-value">
                <span class="status-dot" :class="`status-dot--${row.status}`" />
                {{ getStatusInfo('tunnel', row.status).label }}
              </span>
            </div>
            <div class="kv-row">
              <span class="kv-label">状态原因</span>
              <span class="kv-value">{{ row.status_reason || '—' }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">A / B 在线</span>
              <span class="kv-value">{{ nodeUserCount(row.node_a) }} / {{ nodeUserCount(row.node_b) }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">延迟 / 丢包</span>
              <span class="kv-value">
                {{ Number.isFinite(row.latency_ms) ? Number(row.latency_ms).toFixed(1) : '—' }} ms
                <span class="record-card__meta"> · </span>
                <el-text :type="row.loss_pct > 1 ? 'danger' : ''">
                  {{ row.loss_pct > 0 ? row.loss_pct.toFixed(1) : '0' }}%
                </el-text>
              </span>
            </div>
          </div>
        </div>
      </div>
      <el-empty v-if="!loading && !rows.length" description="暂无隧道" :image-size="60" />
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, nextTick } from 'vue'
import http from '../api/http'
import { getStatusInfo, recordCardToneClass } from '../utils'

const rows = ref([])
const nodes = ref([])
const loading = ref(false)
const topoCanvasRef = ref(null)
const topoW = ref(320)
const topoH = ref(350)
/** 机架图标像素尺寸；连线锚点 (n.x, n.y) 对齐机架中心（不含下方文案） */
const TOPO_RACK_W = 26
const TOPO_RACK_H = 32
const TOPO_RACK_HALF_W = TOPO_RACK_W / 2
const TOPO_RACK_HALF_H = TOPO_RACK_H / 2

const nodeBoxStyle = (n) => ({
  left: `${n.x - TOPO_RACK_HALF_W}px`,
  top: `${n.y - TOPO_RACK_HALF_H}px`,
})

/** 画布平移 / 缩放（移动端手势），与节点坐标同一空间 */
const pan = reactive({ x: 0, y: 0 })
const scale = ref(1)
const dragState = reactive({ node: null, offsetX: 0, offsetY: 0 })
const nodePositions = reactive({})
let pollTimer = null
const POLL_INTERVAL_MS = 10000

const touchGesture = reactive({
  mode: 'none',
  pinchDist0: 0,
  scale0: 1
})

/** 单指 / 鼠标拖动画布（pointer 事件，避免 passive touch 无法 preventDefault） */
const canvasPan = reactive({
  active: false,
  pointerId: null,
  startClientX: 0,
  startClientY: 0,
  pan0X: 0,
  pan0Y: 0
})

const topoLayerStyle = computed(() => ({
  width: `${topoW.value}px`,
  height: `${topoH.value}px`,
  transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale.value})`,
  transformOrigin: '0 0'
}))

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

const touchDist = (a, b) => {
  const dx = a.clientX - b.clientX
  const dy = a.clientY - b.clientY
  return Math.hypot(dx, dy) || 1
}

const clientToGraph = (clientX, clientY) => {
  const el = topoCanvasRef.value
  if (!el) return { x: 0, y: 0 }
  const r = el.getBoundingClientRect()
  return {
    x: (clientX - r.left - pan.x) / scale.value,
    y: (clientY - r.top - pan.y) / scale.value
  }
}

let detachTopoTouch = null

const onTouchStart = (e) => {
  if (dragState.node) return
  if (e.touches.length === 2) {
    canvasPan.active = false
    canvasPan.pointerId = null
    touchGesture.mode = 'pinch'
    touchGesture.pinchDist0 = touchDist(e.touches[0], e.touches[1])
    touchGesture.scale0 = scale.value
  }
}

const onTouchMove = (e) => {
  if (dragState.node) return
  if (e.touches.length === 2) {
    e.preventDefault()
    touchGesture.mode = 'pinch'
    const d = touchDist(e.touches[0], e.touches[1])
    if (!touchGesture.pinchDist0) {
      touchGesture.pinchDist0 = d
      touchGesture.scale0 = scale.value
    }
    scale.value = clamp(touchGesture.scale0 * (d / touchGesture.pinchDist0), 0.5, 2.5)
  }
}

const onTouchEnd = (e) => {
  if (e.touches.length === 0) {
    touchGesture.mode = 'none'
    touchGesture.pinchDist0 = 0
  } else if (e.touches.length === 1) {
    touchGesture.pinchDist0 = 0
  }
}

const onCanvasPointerDown = (e) => {
  if (dragState.node) return
  if (e.target?.closest?.('.topo-node')) return
  if (e.pointerType === 'mouse' && e.button !== 0) return
  if (!e.isPrimary) return
  canvasPan.active = true
  canvasPan.pointerId = e.pointerId
  canvasPan.startClientX = e.clientX
  canvasPan.startClientY = e.clientY
  canvasPan.pan0X = pan.x
  canvasPan.pan0Y = pan.y
  try {
    ;(e.currentTarget).setPointerCapture(e.pointerId)
  } catch {
    // ignore
  }
}

const onCanvasPointerMove = (e) => {
  if (!canvasPan.active || e.pointerId !== canvasPan.pointerId) return
  if (e.cancelable) e.preventDefault()
  pan.x = canvasPan.pan0X + (e.clientX - canvasPan.startClientX)
  pan.y = canvasPan.pan0Y + (e.clientY - canvasPan.startClientY)
}

const onCanvasPointerUp = (e) => {
  if (!canvasPan.active || e.pointerId !== canvasPan.pointerId) return
  canvasPan.active = false
  canvasPan.pointerId = null
  try {
    ;(e.currentTarget)?.releasePointerCapture?.(e.pointerId)
  } catch {
    // ignore
  }
}

const onCanvasPointerLeave = (e) => {
  if (e.pointerType === 'mouse') onCanvasPointerUp(e)
}

const endNodeDrag = () => {
  dragState.node = null
  document.removeEventListener('pointermove', onNodePointerMove)
  document.removeEventListener('pointerup', endNodeDrag)
  document.removeEventListener('pointercancel', endNodeDrag)
}

const onNodePointerMove = (e) => {
  if (!dragState.node) return
  if (e.cancelable) e.preventDefault()
  const p = clientToGraph(e.clientX, e.clientY)
  const w = topoW.value
  const h = topoH.value
  nodePositions[dragState.node.id] = {
    x: clamp(p.x - dragState.offsetX, TOPO_RACK_HALF_W, w - TOPO_RACK_HALF_W),
    y: clamp(p.y - dragState.offsetY, TOPO_RACK_HALF_H, h - TOPO_RACK_HALF_H)
  }
}

const onNodePointerDown = (n, e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  e.preventDefault()
  try {
    e.currentTarget?.setPointerCapture?.(e.pointerId)
  } catch {
    // ignore
  }
  dragState.node = n
  const p = clientToGraph(e.clientX, e.clientY)
  dragState.offsetX = p.x - n.x
  dragState.offsetY = p.y - n.y
  document.addEventListener('pointermove', onNodePointerMove, { passive: false })
  document.addEventListener('pointerup', endNodeDrag)
  document.addEventListener('pointercancel', endNodeDrag)
}

/** 链路颜色：正常绿 / 中断红 / 其余黄（含未知、降级、等待等） */
const linkPalette = (status) => {
  if (status === 'ok' || status === 'healthy') {
    return { core: '#22c55e', glow: 'rgba(34, 197, 94, 0.5)' }
  }
  if (status === 'down' || status === 'invalid_config') {
    return { core: '#ef4444', glow: 'rgba(239, 68, 68, 0.5)' }
  }
  return { core: '#eab308', glow: 'rgba(234, 179, 8, 0.48)' }
}

const rackLedColor = (n) => (n.status === 'online' ? '#4ade80' : '#64748b')

const topoNodes = computed(() => {
  const list = nodes.value
  if (!list.length) return []
  const cx = topoW.value / 2
  const cy = topoH.value / 2
  const r = Math.min(110, Math.min(topoW.value, topoH.value) * 0.28)
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

const clearTopoNodePositions = () => {
  Object.keys(nodePositions).forEach((k) => {
    delete nodePositions[k]
  })
}

/** 将图坐标 (cx,cy) 对齐到视口中心，避免窄屏只看到图右侧 */
const fitTopoPan = () => {
  const el = topoCanvasRef.value
  if (!el) return
  const cw = el.clientWidth
  const ch = el.clientHeight || topoH.value
  const gcX = topoW.value / 2
  const gcY = topoH.value / 2
  pan.x = cw / 2 - gcX * scale.value
  pan.y = ch / 2 - gcY * scale.value
}

const updateTopoDimensions = () => {
  const el = topoCanvasRef.value
  if (!el) return
  const nw = Math.max(280, Math.floor(el.clientWidth || 320))
  const nh = Math.max(240, Math.floor(el.clientHeight || 350))
  const wChanged = Math.abs(nw - topoW.value) > 1
  const hChanged = Math.abs(nh - topoH.value) > 1
  if (wChanged || hChanged) {
    clearTopoNodePositions()
    topoW.value = nw
    topoH.value = nh
    nextTick(() => fitTopoPan())
  }
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

let topoResizeObserver = null

onMounted(async () => {
  await nextTick()
  updateTopoDimensions()
  fitTopoPan()
  window.addEventListener('resize', updateTopoDimensions)
  const canvas = topoCanvasRef.value
  if (canvas) {
    const opts = { passive: false }
    canvas.addEventListener('touchstart', onTouchStart, opts)
    canvas.addEventListener('touchmove', onTouchMove, opts)
    canvas.addEventListener('touchend', onTouchEnd, { passive: true })
    canvas.addEventListener('touchcancel', onTouchEnd, { passive: true })
    detachTopoTouch = () => {
      canvas.removeEventListener('touchstart', onTouchStart)
      canvas.removeEventListener('touchmove', onTouchMove)
      canvas.removeEventListener('touchend', onTouchEnd)
      canvas.removeEventListener('touchcancel', onTouchEnd)
    }
    topoResizeObserver = new ResizeObserver(() => {
      updateTopoDimensions()
    })
    topoResizeObserver.observe(canvas)
  }
  await loadData()
  await nextTick()
  updateTopoDimensions()
  fitTopoPan()
  pollTimer = setInterval(loadData, POLL_INTERVAL_MS)
})

onUnmounted(() => {
  window.removeEventListener('resize', updateTopoDimensions)
  topoResizeObserver?.disconnect()
  topoResizeObserver = null
  endNodeDrag()
  detachTopoTouch?.()
  detachTopoTouch = null
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
})
</script>

<style scoped>
.topo-page-head {
  flex-wrap: wrap;
  gap: 8px;
  align-items: flex-start;
}

.topo-gesture-hint {
  flex: 1 1 200px;
  min-width: 0;
  line-height: 1.4;
}

@media (min-width: 769px) {
  .topo-gesture-hint {
    display: none;
  }
}

.topo-canvas {
  width: 100%;
  height: 350px;
  position: relative;
  border-radius: var(--radius-md);
  overflow: hidden;
  user-select: none;
  touch-action: none;
  cursor: grab;
  background:
    linear-gradient(rgba(56, 189, 248, 0.08) 1px, transparent 1px),
    linear-gradient(90deg, rgba(56, 189, 248, 0.06) 1px, transparent 1px),
    radial-gradient(ellipse 95% 75% at 50% 18%, rgba(14, 165, 233, 0.16), transparent 58%),
    linear-gradient(168deg, #070d16 0%, #0f172a 42%, #111827 100%);
  background-size:
    28px 28px,
    28px 28px,
    100% 100%,
    100% 100%;
  box-shadow: inset 0 0 0 1px rgba(56, 189, 248, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

.topo-transform-layer {
  position: absolute;
  left: 0;
  top: 0;
  will-change: transform;
}

.topo-svg {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}

.topo-link-core {
  stroke-dasharray: 12 10;
  animation: topo-link-dash 2.4s linear infinite;
}

.topo-link-metric {
  fill: rgba(148, 163, 184, 0.95);
}

.topo-link-metric--latency {
  font-weight: 600;
  fill: rgba(226, 232, 240, 0.95);
}

.topo-link-metric--loss {
  fill: #fca5a5;
}

@keyframes topo-link-dash {
  to {
    stroke-dashoffset: -44;
  }
}

@media (prefers-reduced-motion: reduce) {
  .topo-link-core {
    animation: none;
    stroke-dasharray: 0;
  }
}

/* 宽度固定为机架宽：避免「文案比机架宽」时 flex 居中把机架挤偏，导致与连线锚点 n.x 不对齐 */
.topo-node {
  position: absolute;
  width: 26px;
  box-sizing: border-box;
  padding-bottom: 36px;
  cursor: grab;
  touch-action: none;
}

.topo-node:active {
  cursor: grabbing;
}

.topo-node-meta {
  position: absolute;
  top: calc(32px + 2px);
  left: 50%;
  transform: translateX(-50%);
  width: max-content;
  max-width: 120px;
  text-align: center;
}

.topo-rack-wrap {
  width: 26px;
  height: 32px;
  display: block;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.45));
}

.topo-rack-svg {
  display: block;
  width: 100%;
  height: 100%;
}

.topo-rack-led {
  transition: fill 0.25s ease;
}

.is-node-online .topo-rack-led {
  animation: topo-led-pulse 2.2s ease-in-out infinite;
}

@keyframes topo-led-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

@media (prefers-reduced-motion: reduce) {
  .is-node-online .topo-rack-led {
    animation: none;
  }
}

.topo-label {
  font-size: 11px;
  font-weight: 600;
  line-height: 1.2;
  color: #e2e8f0;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65);
  max-width: 118px;
  margin: 0 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.topo-users {
  font-size: 9px;
  color: #94a3b8;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  line-height: 1.2;
  margin-top: 2px;
}

@media (max-width: 768px) {
  .topo-canvas {
    height: 300px;
  }
  .topo-label {
    font-size: 10px;
    max-width: 96px;
  }
}
</style>
