import { createHead } from "@unhead/vue/server";
import { defineComponent, ref, onMounted, createSSRApp, useSSRContext, reactive, computed, resolveComponent, withCtx, createVNode, resolveDynamicComponent, openBlock, createBlock, toDisplayString, createCommentVNode, Fragment, renderList, createTextVNode, unref, onUnmounted, resolveDirective, mergeProps, withKeys, nextTick, onBeforeUnmount, watch, Transition } from "vue";
import { createRouter, createMemoryHistory, useRouter, useRoute } from "vue-router";
import { createPinia } from "pinia";
import ElementPlus, { ElMessage, ElMessageBox } from "element-plus";
import * as ElementPlusIconsVue from "@element-plus/icons-vue";
import { Search, EditPen, User, Lock, ArrowDown, Plus } from "@element-plus/icons-vue";
import { ssrRenderAttrs, ssrRenderComponent, ssrRenderList, ssrRenderClass, ssrRenderVNode, ssrInterpolate, ssrRenderStyle, ssrGetDirectiveProps, ssrRenderAttr } from "vue/server-renderer";
import axios from "axios";
const ClientOnly = defineComponent({
  setup(props, { slots }) {
    const mounted = ref(false);
    onMounted(() => mounted.value = true);
    return () => {
      if (!mounted.value)
        return slots.placeholder && slots.placeholder({});
      return slots.default && slots.default({});
    };
  }
});
function ViteSSG(App2, routerOptions, fn, options) {
  const {
    transformState,
    registerComponents = true,
    useHead = true,
    rootContainer = "#app"
  } = {};
  async function createApp$1(routePath) {
    const app = createSSRApp(App2);
    let head;
    if (useHead) {
      app.use(head = createHead());
    }
    const router = createRouter({
      history: createMemoryHistory(routerOptions.base),
      ...routerOptions
    });
    const { routes: routes2 } = routerOptions;
    if (registerComponents)
      app.component("ClientOnly", ClientOnly);
    const appRenderCallbacks = [];
    const onSSRAppRendered = (cb) => appRenderCallbacks.push(cb);
    const triggerOnSSRAppRendered = () => {
      return Promise.all(appRenderCallbacks.map((cb) => cb()));
    };
    const context = {
      app,
      head,
      isClient: false,
      router,
      routes: routes2,
      onSSRAppRendered,
      triggerOnSSRAppRendered,
      initialState: {},
      transformState,
      routePath
    };
    await (fn == null ? void 0 : fn(context));
    app.use(router);
    let entryRoutePath;
    let isFirstRoute = true;
    router.beforeEach((to, from, next) => {
      if (isFirstRoute || entryRoutePath && entryRoutePath === to.path) {
        isFirstRoute = false;
        entryRoutePath = to.path;
        to.meta.state = context.initialState;
      }
      next();
    });
    {
      const route = context.routePath ?? "/";
      router.push(route);
      await router.isReady();
      context.initialState = router.currentRoute.value.meta.state || {};
    }
    const initialState = context.initialState;
    return {
      ...context,
      initialState
    };
  }
  return createApp$1;
}
function parseJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4;
    if (pad === 2) b64 += "==";
    else if (pad === 3) b64 += "=";
    else if (pad !== 0) return null;
    const binary = atob(b64);
    const json = decodeURIComponent(
      binary.split("").map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join("")
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}
const TOKEN_KEY = "token";
const ADMIN_PROFILE_KEY = "admin_profile";
function readProfileFromStorage() {
  const raw = localStorage.getItem(ADMIN_PROFILE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
const tokenRef = ref(localStorage.getItem(TOKEN_KEY) || "");
const adminProfileRef = ref(readProfileFromStorage());
function getSessionToken() {
  return tokenRef.value;
}
function getAdminProfile() {
  return adminProfileRef.value;
}
function setSessionToken(token) {
  const safeToken = typeof token === "string" ? token : "";
  if (safeToken) localStorage.setItem(TOKEN_KEY, safeToken);
  else localStorage.removeItem(TOKEN_KEY);
  tokenRef.value = safeToken;
}
function setAdminProfile(profile) {
  if (!profile || typeof profile !== "object") {
    localStorage.removeItem(ADMIN_PROFILE_KEY);
    adminProfileRef.value = null;
    return;
  }
  localStorage.setItem(ADMIN_PROFILE_KEY, JSON.stringify(profile));
  adminProfileRef.value = profile;
}
function setAuthSession({ token, admin }) {
  setSessionToken(token);
  setAdminProfile(admin || null);
}
function clearAuthSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ADMIN_PROFILE_KEY);
  tokenRef.value = "";
  adminProfileRef.value = null;
}
function normalizeRolePerms(info) {
  if (!info || typeof info !== "object") return { role: "", perms: "" };
  const roleRaw = typeof info.role === "string" ? info.role.trim() : "";
  const role = roleRaw.toLowerCase();
  const permsSource = "perms" in info ? info.perms : info.permissions;
  const perms = typeof permsSource === "string" ? permsSource.trim() : "";
  return { role, perms };
}
function isSuperAdminSession() {
  let info = getAdminProfile();
  if (!info || !info.role && !info.permissions && !info.perms) {
    const token = getSessionToken();
    const payload = token ? parseJwtPayload(token) : null;
    info = payload && typeof payload === "object" ? payload : null;
  }
  const { role, perms } = normalizeRolePerms(info);
  return role === "admin" || perms === "*";
}
const API_BASE_STORAGE_KEY = "vpn_admin_api_base_url";
function normalizeApiBase(s) {
  if (typeof s !== "string") return "";
  let t = s.trim();
  if (t.endsWith("/")) t = t.slice(0, -1);
  if (t.endsWith("/api")) {
    t = t.slice(0, -4);
  }
  return t;
}
function isLoopbackHostname(h) {
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}
function devLoopbackSamePage(base, origin) {
  try {
    const b = new URL(base);
    const o = new URL(origin);
    if (!isLoopbackHostname(b.hostname) || !isLoopbackHostname(o.hostname)) return false;
    return b.port === o.port && b.protocol === o.protocol;
  } catch (_) {
    return false;
  }
}
function viteLocalShell() {
  if (typeof window === "undefined") return false;
  try {
    const p = window.location;
    if (!isLoopbackHostname(p.hostname)) return false;
    const port = p.port || (p.protocol === "https:" ? "443" : "80");
    return port === "56701" || port === "56702";
  } catch (_) {
    return false;
  }
}
function preferRelativeToAvoidLoopbackCors(base) {
  if (!base || typeof window === "undefined") return false;
  try {
    const b = new URL(base);
    const p = window.location;
    if (!isLoopbackHostname(b.hostname) || !isLoopbackHostname(p.hostname)) return false;
    return b.origin !== p.origin;
  } catch (_) {
    return false;
  }
}
function getApiBaseURL() {
  let base = "";
  const stored = localStorage.getItem(API_BASE_STORAGE_KEY);
  if (stored !== null) {
    base = normalizeApiBase(stored);
  } else {
    base = normalizeApiBase("https://vpnapi.gaiasc.com");
  }
  if (viteLocalShell() && typeof window !== "undefined" && base !== "") {
    try {
      const origin = window.location.origin;
      if (preferRelativeToAvoidLoopbackCors(base) || base === origin || devLoopbackSamePage(base, origin)) {
        return "";
      }
    } catch (_) {
    }
  }
  return base;
}
function repairStoredApiBaseIfNeeded() {
  try {
    if (typeof localStorage === "undefined") return;
    const raw = localStorage.getItem(API_BASE_STORAGE_KEY);
    if (raw === null) return;
    const fixed = normalizeApiBase(raw);
    if (fixed !== raw) {
      localStorage.setItem(API_BASE_STORAGE_KEY, fixed);
    }
  } catch (_) {
  }
}
function setApiBaseURL(url) {
  localStorage.setItem(API_BASE_STORAGE_KEY, normalizeApiBase(url));
}
function clearApiBaseURL() {
  localStorage.removeItem(API_BASE_STORAGE_KEY);
}
function getBuildTimeApiBaseURL() {
  return normalizeApiBase("https://vpnapi.gaiasc.com");
}
const REQUEST_TIMEOUT_MS = 45e3;
const publicHttp = axios.create({ timeout: REQUEST_TIMEOUT_MS });
publicHttp.interceptors.request.use((cfg) => {
  cfg.baseURL = getApiBaseURL();
  return cfg;
});
publicHttp.interceptors.response.use(
  (res) => res,
  (err) => {
    const isTimeout = err.code === "ECONNABORTED" || typeof err.message === "string" && err.message.includes("timeout");
    if (isTimeout) {
      ElMessage.error(
        "请求超时：请确认 vpn-api 已启动，且 API 地址配置正确"
      );
    }
    return Promise.reject(err);
  }
);
const http = axios.create({ baseURL: "", timeout: REQUEST_TIMEOUT_MS });
http.interceptors.request.use((cfg) => {
  cfg.baseURL = getApiBaseURL();
  const token = localStorage.getItem("token");
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});
http.interceptors.response.use(
  (res) => res,
  (err) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i;
    const isTimeout = err.code === "ECONNABORTED" || typeof err.message === "string" && err.message.includes("timeout");
    if (isTimeout) {
      ElMessage.error(
        "请求超时：请确认 vpn-api 已启动（默认 56700），且「API 连接」未指向错误地址；开发环境勿将 API 填成页面端口 56701"
      );
      return Promise.reject(err);
    }
    const status = (_a = err.response) == null ? void 0 : _a.status;
    const msg = (_c = (_b = err.response) == null ? void 0 : _b.data) == null ? void 0 : _c.error;
    const suppress404 = Boolean((_e = (_d = err.config) == null ? void 0 : _d.meta) == null ? void 0 : _e.suppress404);
    if (!err.response) {
      ElMessage.error(
        "无法连接 API：请确认 vpn-api 已启动，且端口与前端配置一致（开发环境默认反代到 127.0.0.1:56700）"
      );
    } else if (status === 401) {
      const onLogin = ((_f = routerProxy.currentRoute.value) == null ? void 0 : _f.path) === "/login";
      if (onLogin) {
        ElMessage.error(msg || "用户名或密码错误");
      } else {
        clearAuthSession();
        routerProxy.push("/login");
        ElMessage.error(msg || "登录已过期，请重新登录");
      }
    } else if (status === 403) {
      const suppress403 = Boolean((_h = (_g = err.config) == null ? void 0 : _g.meta) == null ? void 0 : _h.suppress403);
      if (!suppress403) {
        ElMessage.error(msg || "没有操作权限");
      }
    } else if (status === 404) {
      if (suppress404) return Promise.reject(err);
      ElMessage.error(
        msg || "接口不存在 (404)。若管理台在 56701：请确认 vpn-api 已启动于 56700，且 API 地址勿填成页面地址；可到「API 连接」清空或设为 http://127.0.0.1:56700"
      );
    } else if (status >= 500) {
      const raw = (_i = err.response) == null ? void 0 : _i.data;
      const detail = typeof raw === "string" ? raw : (raw == null ? void 0 : raw.error) || (raw && typeof raw === "object" ? JSON.stringify(raw) : "");
      ElMessage.error(
        detail || msg || "服务器错误（若刚升级端口：请确认后端监听 56700，且未将 VITE_API_BASE_URL 指向旧地址）"
      );
    } else if (msg) {
      ElMessage.error(msg);
    }
    return Promise.reject(err);
  }
);
function formatDate(val) {
  if (!val) return "-";
  const d = new Date(val);
  if (isNaN(d.getTime())) return val;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function formatRelativeTime(val) {
  if (!val) return "-";
  const d = new Date(val);
  if (isNaN(d.getTime())) return val;
  const diff = Date.now() - d.getTime();
  const minutes = Math.floor(diff / 6e4);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatDate(val);
}
const nodeStatusMap = {
  online: { label: "在线", type: "success" },
  offline: { label: "离线", type: "danger" }
};
const userStatusMap = {
  active: { label: "正常", type: "success" },
  disabled: { label: "禁用", type: "info" }
};
const certStatusMap = {
  pending: { label: "待签发", type: "warning" },
  active: { label: "可用", type: "success" },
  placeholder: { label: "节点离线（可重试签发）", type: "warning" },
  revoked: { label: "已吊销", type: "danger" },
  revoking: { label: "吊销中", type: "warning" },
  failed: { label: "签发失败", type: "danger" }
};
const tunnelStatusMap = {
  healthy: { label: "正常", type: "success" },
  degraded: { label: "降级", type: "warning" },
  ok: { label: "正常", type: "success" },
  down: { label: "中断", type: "danger" },
  invalid_config: { label: "配置无效", type: "danger" },
  unknown: { label: "未知", type: "info" },
  pending: { label: "等待", type: "warning" }
};
function getStatusInfo(category, status) {
  var _a;
  const maps = { node: nodeStatusMap, user: userStatusMap, cert: certStatusMap, tunnel: tunnelStatusMap };
  return ((_a = maps[category]) == null ? void 0 : _a[status]) || { label: status || "-", type: "info" };
}
const tagTypeToToneClass = {
  success: "record-card--tone-success",
  warning: "record-card--tone-warning",
  danger: "record-card--tone-danger",
  info: "record-card--tone-info"
};
function recordCardToneFromTagType(type) {
  return tagTypeToToneClass[type] || "record-card--tone-neutral";
}
function recordCardToneClass(category, status) {
  const { type } = getStatusInfo(category, status);
  return recordCardToneFromTagType(type);
}
function downloadBlob(content, filename, type = "text/csv") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
const _export_sfc = (sfc, props) => {
  const target = sfc.__vccOpts || sfc;
  for (const [key, val] of props) {
    target[key] = val;
  }
  return target;
};
const _sfc_main$c = {
  __name: "Dashboard",
  __ssrInlineRender: true,
  setup(__props) {
    const stats = reactive({ nodes: 0, onlineNodes: 0, users: 0, tunnels: 0 });
    const dashboardUserStats = reactive({ users_total: null, users_visible: null });
    const nodeRows = ref([]);
    const recentLogs = ref([]);
    const statCards = [
      { key: "nodes", label: "节点总数", icon: "Monitor", color: "primary" },
      { key: "onlineNodes", label: "在线节点", icon: "CircleCheck", color: "success" },
      { key: "users", label: "用户", icon: "User", color: "warning" },
      { key: "tunnels", label: "隧道数", icon: "Connection", color: "info" }
    ];
    const userStatLabel = computed(() => {
      const t = dashboardUserStats.users_total;
      const v = dashboardUserStats.users_visible;
      if (t != null && v != null && t !== v) return "可见用户";
      return "用户总数";
    });
    const userStatHint = computed(() => {
      const t = dashboardUserStats.users_total;
      const v = dashboardUserStats.users_visible;
      if (t == null || v == null || t === v) return "";
      return `全平台共 ${t} 名`;
    });
    const safeFetch = async (url, config = {}) => {
      try {
        return await http.get(url, {
          ...config,
          meta: { ...config.meta, suppress404: true }
        });
      } catch {
        return null;
      }
    };
    onMounted(async () => {
      const [nodesRes, dashStatsRes, tunnelsRes, logsRes] = await Promise.all([
        safeFetch("/api/nodes"),
        safeFetch("/api/dashboard/stats"),
        safeFetch("/api/tunnels"),
        safeFetch("/api/audit-logs")
      ]);
      if (nodesRes) {
        const items = nodesRes.data.items || [];
        nodeRows.value = items;
        stats.nodes = items.length;
        stats.onlineNodes = items.filter((i) => {
          var _a;
          return ((_a = i.node) == null ? void 0 : _a.status) === "online";
        }).length;
      }
      if (dashStatsRes == null ? void 0 : dashStatsRes.data) {
        const d = dashStatsRes.data;
        const vis = d.users_visible;
        const tot = d.users_total;
        dashboardUserStats.users_total = typeof tot === "number" ? tot : null;
        dashboardUserStats.users_visible = typeof vis === "number" ? vis : null;
        stats.users = typeof vis === "number" ? vis : typeof tot === "number" ? tot : 0;
      } else {
        const usersRes = await safeFetch("/api/users");
        if (usersRes) stats.users = (usersRes.data.items || []).length;
      }
      if (tunnelsRes) stats.tunnels = (tunnelsRes.data.items || []).length;
      if (logsRes) recentLogs.value = (logsRes.data.items || []).slice(0, 8);
    });
    return (_ctx, _push, _parent, _attrs) => {
      const _component_el_row = resolveComponent("el-row");
      const _component_el_col = resolveComponent("el-col");
      const _component_el_icon = resolveComponent("el-icon");
      const _component_el_button = resolveComponent("el-button");
      const _component_ArrowRight = resolveComponent("ArrowRight");
      const _component_el_link = resolveComponent("el-link");
      const _component_el_tag = resolveComponent("el-tag");
      const _component_el_empty = resolveComponent("el-empty");
      const _component_el_timeline = resolveComponent("el-timeline");
      const _component_el_timeline_item = resolveComponent("el-timeline-item");
      _push(`<div${ssrRenderAttrs(_attrs)} data-v-99d1b44b>`);
      _push(ssrRenderComponent(_component_el_row, {
        gutter: 16,
        class: "mb-lg"
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`<!--[-->`);
            ssrRenderList(statCards, (item) => {
              _push2(ssrRenderComponent(_component_el_col, {
                key: item.key,
                xs: 12,
                sm: 12,
                md: 8,
                lg: 6,
                class: "dashboard-stat-col"
              }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(`<div class="stat-card" data-v-99d1b44b${_scopeId2}><div class="${ssrRenderClass([`stat-icon--${item.color}`, "stat-icon"])}" data-v-99d1b44b${_scopeId2}>`);
                    _push3(ssrRenderComponent(_component_el_icon, { size: 24 }, {
                      default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                        if (_push4) {
                          ssrRenderVNode(_push4, createVNode(resolveDynamicComponent(item.icon), null, null), _parent4, _scopeId3);
                        } else {
                          return [
                            (openBlock(), createBlock(resolveDynamicComponent(item.icon)))
                          ];
                        }
                      }),
                      _: 2
                    }, _parent3, _scopeId2));
                    _push3(`</div><div class="stat-content" data-v-99d1b44b${_scopeId2}><div class="stat-value" data-v-99d1b44b${_scopeId2}>${ssrInterpolate(stats[item.key])}</div><div class="stat-label" data-v-99d1b44b${_scopeId2}>${ssrInterpolate(item.key === "users" ? userStatLabel.value : item.label)}</div>`);
                    if (item.key === "users" && userStatHint.value) {
                      _push3(`<div class="stat-hint" data-v-99d1b44b${_scopeId2}>${ssrInterpolate(userStatHint.value)}</div>`);
                    } else {
                      _push3(`<!---->`);
                    }
                    _push3(`</div></div>`);
                  } else {
                    return [
                      createVNode("div", { class: "stat-card" }, [
                        createVNode("div", {
                          class: ["stat-icon", `stat-icon--${item.color}`]
                        }, [
                          createVNode(_component_el_icon, { size: 24 }, {
                            default: withCtx(() => [
                              (openBlock(), createBlock(resolveDynamicComponent(item.icon)))
                            ]),
                            _: 2
                          }, 1024)
                        ], 2),
                        createVNode("div", { class: "stat-content" }, [
                          createVNode("div", { class: "stat-value" }, toDisplayString(stats[item.key]), 1),
                          createVNode("div", { class: "stat-label" }, toDisplayString(item.key === "users" ? userStatLabel.value : item.label), 1),
                          item.key === "users" && userStatHint.value ? (openBlock(), createBlock("div", {
                            key: 0,
                            class: "stat-hint"
                          }, toDisplayString(userStatHint.value), 1)) : createCommentVNode("", true)
                        ])
                      ])
                    ];
                  }
                }),
                _: 2
              }, _parent2, _scopeId));
            });
            _push2(`<!--]-->`);
          } else {
            return [
              (openBlock(), createBlock(Fragment, null, renderList(statCards, (item) => {
                return createVNode(_component_el_col, {
                  key: item.key,
                  xs: 12,
                  sm: 12,
                  md: 8,
                  lg: 6,
                  class: "dashboard-stat-col"
                }, {
                  default: withCtx(() => [
                    createVNode("div", { class: "stat-card" }, [
                      createVNode("div", {
                        class: ["stat-icon", `stat-icon--${item.color}`]
                      }, [
                        createVNode(_component_el_icon, { size: 24 }, {
                          default: withCtx(() => [
                            (openBlock(), createBlock(resolveDynamicComponent(item.icon)))
                          ]),
                          _: 2
                        }, 1024)
                      ], 2),
                      createVNode("div", { class: "stat-content" }, [
                        createVNode("div", { class: "stat-value" }, toDisplayString(stats[item.key]), 1),
                        createVNode("div", { class: "stat-label" }, toDisplayString(item.key === "users" ? userStatLabel.value : item.label), 1),
                        item.key === "users" && userStatHint.value ? (openBlock(), createBlock("div", {
                          key: 0,
                          class: "stat-hint"
                        }, toDisplayString(userStatHint.value), 1)) : createCommentVNode("", true)
                      ])
                    ])
                  ]),
                  _: 2
                }, 1024);
              }), 64))
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(ssrRenderComponent(_component_el_row, { gutter: 16 }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_col, {
              xs: 24,
              sm: 24,
              md: 14,
              lg: 14
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`<div class="page-card" data-v-99d1b44b${_scopeId2}><div class="page-card-header" data-v-99d1b44b${_scopeId2}><span class="page-card-title" data-v-99d1b44b${_scopeId2}>节点状态</span>`);
                  _push3(ssrRenderComponent(_component_el_button, {
                    plain: "",
                    type: "primary",
                    onClick: ($event) => _ctx.$router.push("/nodes")
                  }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(` 查看全部 `);
                        _push4(ssrRenderComponent(_component_el_icon, null, {
                          default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                            if (_push5) {
                              _push5(ssrRenderComponent(_component_ArrowRight, null, null, _parent5, _scopeId4));
                            } else {
                              return [
                                createVNode(_component_ArrowRight)
                              ];
                            }
                          }),
                          _: 1
                        }, _parent4, _scopeId3));
                      } else {
                        return [
                          createTextVNode(" 查看全部 "),
                          createVNode(_component_el_icon, null, {
                            default: withCtx(() => [
                              createVNode(_component_ArrowRight)
                            ]),
                            _: 1
                          })
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(`</div>`);
                  if (nodeRows.value.length) {
                    _push3(`<div class="record-grid record-grid--dense" data-v-99d1b44b${_scopeId2}><!--[-->`);
                    ssrRenderList(nodeRows.value, (row) => {
                      _push3(`<div class="${ssrRenderClass([unref(recordCardToneClass)("node", row.node.status), "record-card"])}" data-v-99d1b44b${_scopeId2}><div class="record-card__head" data-v-99d1b44b${_scopeId2}><div class="min-w-0" data-v-99d1b44b${_scopeId2}><div class="record-card__title" data-v-99d1b44b${_scopeId2}>`);
                      _push3(ssrRenderComponent(_component_el_link, {
                        type: "primary",
                        onClick: ($event) => _ctx.$router.push(`/nodes/${row.node.id}`)
                      }, {
                        default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                          if (_push4) {
                            _push4(`${ssrInterpolate(row.node.name)}`);
                          } else {
                            return [
                              createTextVNode(toDisplayString(row.node.name), 1)
                            ];
                          }
                        }),
                        _: 2
                      }, _parent3, _scopeId2));
                      _push3(`</div><div class="record-card__meta" data-v-99d1b44b${_scopeId2}>${ssrInterpolate(row.node.region || "—")}</div></div>`);
                      _push3(ssrRenderComponent(_component_el_tag, {
                        size: "small",
                        round: "",
                        type: "info"
                      }, {
                        default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                          var _a, _b;
                          if (_push4) {
                            _push4(`${ssrInterpolate(((_a = row.instances) == null ? void 0 : _a.length) || 0)} 实例`);
                          } else {
                            return [
                              createTextVNode(toDisplayString(((_b = row.instances) == null ? void 0 : _b.length) || 0) + " 实例", 1)
                            ];
                          }
                        }),
                        _: 2
                      }, _parent3, _scopeId2));
                      _push3(`</div><div class="record-card__fields" data-v-99d1b44b${_scopeId2}><div class="kv-row" data-v-99d1b44b${_scopeId2}><span class="kv-label" data-v-99d1b44b${_scopeId2}>状态</span><span class="kv-value" data-v-99d1b44b${_scopeId2}><span class="${ssrRenderClass([`status-dot--${row.node.status}`, "status-dot"])}" data-v-99d1b44b${_scopeId2}></span> ${ssrInterpolate(unref(getStatusInfo)("node", row.node.status).label)}</span></div><div class="kv-row" data-v-99d1b44b${_scopeId2}><span class="kv-label" data-v-99d1b44b${_scopeId2}>在线用户</span><span class="kv-value" data-v-99d1b44b${_scopeId2}>${ssrInterpolate(row.node.online_users ?? 0)}</span></div></div></div>`);
                    });
                    _push3(`<!--]--></div>`);
                  } else {
                    _push3(ssrRenderComponent(_component_el_empty, {
                      description: "暂无节点",
                      "image-size": 60
                    }, null, _parent3, _scopeId2));
                  }
                  _push3(`</div>`);
                } else {
                  return [
                    createVNode("div", { class: "page-card" }, [
                      createVNode("div", { class: "page-card-header" }, [
                        createVNode("span", { class: "page-card-title" }, "节点状态"),
                        createVNode(_component_el_button, {
                          plain: "",
                          type: "primary",
                          onClick: ($event) => _ctx.$router.push("/nodes")
                        }, {
                          default: withCtx(() => [
                            createTextVNode(" 查看全部 "),
                            createVNode(_component_el_icon, null, {
                              default: withCtx(() => [
                                createVNode(_component_ArrowRight)
                              ]),
                              _: 1
                            })
                          ]),
                          _: 1
                        }, 8, ["onClick"])
                      ]),
                      nodeRows.value.length ? (openBlock(), createBlock("div", {
                        key: 0,
                        class: "record-grid record-grid--dense"
                      }, [
                        (openBlock(true), createBlock(Fragment, null, renderList(nodeRows.value, (row) => {
                          return openBlock(), createBlock("div", {
                            key: row.node.id,
                            class: ["record-card", unref(recordCardToneClass)("node", row.node.status)]
                          }, [
                            createVNode("div", { class: "record-card__head" }, [
                              createVNode("div", { class: "min-w-0" }, [
                                createVNode("div", { class: "record-card__title" }, [
                                  createVNode(_component_el_link, {
                                    type: "primary",
                                    onClick: ($event) => _ctx.$router.push(`/nodes/${row.node.id}`)
                                  }, {
                                    default: withCtx(() => [
                                      createTextVNode(toDisplayString(row.node.name), 1)
                                    ]),
                                    _: 2
                                  }, 1032, ["onClick"])
                                ]),
                                createVNode("div", { class: "record-card__meta" }, toDisplayString(row.node.region || "—"), 1)
                              ]),
                              createVNode(_component_el_tag, {
                                size: "small",
                                round: "",
                                type: "info"
                              }, {
                                default: withCtx(() => {
                                  var _a;
                                  return [
                                    createTextVNode(toDisplayString(((_a = row.instances) == null ? void 0 : _a.length) || 0) + " 实例", 1)
                                  ];
                                }),
                                _: 2
                              }, 1024)
                            ]),
                            createVNode("div", { class: "record-card__fields" }, [
                              createVNode("div", { class: "kv-row" }, [
                                createVNode("span", { class: "kv-label" }, "状态"),
                                createVNode("span", { class: "kv-value" }, [
                                  createVNode("span", {
                                    class: ["status-dot", `status-dot--${row.node.status}`]
                                  }, null, 2),
                                  createTextVNode(" " + toDisplayString(unref(getStatusInfo)("node", row.node.status).label), 1)
                                ])
                              ]),
                              createVNode("div", { class: "kv-row" }, [
                                createVNode("span", { class: "kv-label" }, "在线用户"),
                                createVNode("span", { class: "kv-value" }, toDisplayString(row.node.online_users ?? 0), 1)
                              ])
                            ])
                          ], 2);
                        }), 128))
                      ])) : (openBlock(), createBlock(_component_el_empty, {
                        key: 1,
                        description: "暂无节点",
                        "image-size": 60
                      }))
                    ])
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_col, {
              xs: 24,
              sm: 24,
              md: 10,
              lg: 10
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`<div class="page-card" data-v-99d1b44b${_scopeId2}><div class="page-card-header" data-v-99d1b44b${_scopeId2}><span class="page-card-title" data-v-99d1b44b${_scopeId2}>最近操作</span>`);
                  _push3(ssrRenderComponent(_component_el_button, {
                    plain: "",
                    type: "primary",
                    onClick: ($event) => _ctx.$router.push("/audit")
                  }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(` 查看全部 `);
                        _push4(ssrRenderComponent(_component_el_icon, null, {
                          default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                            if (_push5) {
                              _push5(ssrRenderComponent(_component_ArrowRight, null, null, _parent5, _scopeId4));
                            } else {
                              return [
                                createVNode(_component_ArrowRight)
                              ];
                            }
                          }),
                          _: 1
                        }, _parent4, _scopeId3));
                      } else {
                        return [
                          createTextVNode(" 查看全部 "),
                          createVNode(_component_el_icon, null, {
                            default: withCtx(() => [
                              createVNode(_component_ArrowRight)
                            ]),
                            _: 1
                          })
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(`</div>`);
                  _push3(ssrRenderComponent(_component_el_timeline, null, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(`<!--[-->`);
                        ssrRenderList(recentLogs.value, (log) => {
                          _push4(ssrRenderComponent(_component_el_timeline_item, {
                            key: log.id,
                            timestamp: unref(formatRelativeTime)(log.created_at),
                            placement: "top"
                          }, {
                            default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                              if (_push5) {
                                _push5(`<div class="timeline-content" data-v-99d1b44b${_scopeId4}><span class="timeline-user" data-v-99d1b44b${_scopeId4}>${ssrInterpolate(log.admin_user)}</span><span class="timeline-action" data-v-99d1b44b${_scopeId4}>${ssrInterpolate(log.action)}</span>`);
                                if (log.target) {
                                  _push5(ssrRenderComponent(_component_el_tag, {
                                    size: "small",
                                    type: "info"
                                  }, {
                                    default: withCtx((_5, _push6, _parent6, _scopeId5) => {
                                      if (_push6) {
                                        _push6(`${ssrInterpolate(log.target)}`);
                                      } else {
                                        return [
                                          createTextVNode(toDisplayString(log.target), 1)
                                        ];
                                      }
                                    }),
                                    _: 2
                                  }, _parent5, _scopeId4));
                                } else {
                                  _push5(`<!---->`);
                                }
                                _push5(`</div>`);
                              } else {
                                return [
                                  createVNode("div", { class: "timeline-content" }, [
                                    createVNode("span", { class: "timeline-user" }, toDisplayString(log.admin_user), 1),
                                    createVNode("span", { class: "timeline-action" }, toDisplayString(log.action), 1),
                                    log.target ? (openBlock(), createBlock(_component_el_tag, {
                                      key: 0,
                                      size: "small",
                                      type: "info"
                                    }, {
                                      default: withCtx(() => [
                                        createTextVNode(toDisplayString(log.target), 1)
                                      ]),
                                      _: 2
                                    }, 1024)) : createCommentVNode("", true)
                                  ])
                                ];
                              }
                            }),
                            _: 2
                          }, _parent4, _scopeId3));
                        });
                        _push4(`<!--]-->`);
                        if (!recentLogs.value.length) {
                          _push4(ssrRenderComponent(_component_el_empty, {
                            description: "暂无操作记录",
                            "image-size": 60
                          }, null, _parent4, _scopeId3));
                        } else {
                          _push4(`<!---->`);
                        }
                      } else {
                        return [
                          (openBlock(true), createBlock(Fragment, null, renderList(recentLogs.value, (log) => {
                            return openBlock(), createBlock(_component_el_timeline_item, {
                              key: log.id,
                              timestamp: unref(formatRelativeTime)(log.created_at),
                              placement: "top"
                            }, {
                              default: withCtx(() => [
                                createVNode("div", { class: "timeline-content" }, [
                                  createVNode("span", { class: "timeline-user" }, toDisplayString(log.admin_user), 1),
                                  createVNode("span", { class: "timeline-action" }, toDisplayString(log.action), 1),
                                  log.target ? (openBlock(), createBlock(_component_el_tag, {
                                    key: 0,
                                    size: "small",
                                    type: "info"
                                  }, {
                                    default: withCtx(() => [
                                      createTextVNode(toDisplayString(log.target), 1)
                                    ]),
                                    _: 2
                                  }, 1024)) : createCommentVNode("", true)
                                ])
                              ]),
                              _: 2
                            }, 1032, ["timestamp"]);
                          }), 128)),
                          !recentLogs.value.length ? (openBlock(), createBlock(_component_el_empty, {
                            key: 0,
                            description: "暂无操作记录",
                            "image-size": 60
                          })) : createCommentVNode("", true)
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(`</div>`);
                } else {
                  return [
                    createVNode("div", { class: "page-card" }, [
                      createVNode("div", { class: "page-card-header" }, [
                        createVNode("span", { class: "page-card-title" }, "最近操作"),
                        createVNode(_component_el_button, {
                          plain: "",
                          type: "primary",
                          onClick: ($event) => _ctx.$router.push("/audit")
                        }, {
                          default: withCtx(() => [
                            createTextVNode(" 查看全部 "),
                            createVNode(_component_el_icon, null, {
                              default: withCtx(() => [
                                createVNode(_component_ArrowRight)
                              ]),
                              _: 1
                            })
                          ]),
                          _: 1
                        }, 8, ["onClick"])
                      ]),
                      createVNode(_component_el_timeline, null, {
                        default: withCtx(() => [
                          (openBlock(true), createBlock(Fragment, null, renderList(recentLogs.value, (log) => {
                            return openBlock(), createBlock(_component_el_timeline_item, {
                              key: log.id,
                              timestamp: unref(formatRelativeTime)(log.created_at),
                              placement: "top"
                            }, {
                              default: withCtx(() => [
                                createVNode("div", { class: "timeline-content" }, [
                                  createVNode("span", { class: "timeline-user" }, toDisplayString(log.admin_user), 1),
                                  createVNode("span", { class: "timeline-action" }, toDisplayString(log.action), 1),
                                  log.target ? (openBlock(), createBlock(_component_el_tag, {
                                    key: 0,
                                    size: "small",
                                    type: "info"
                                  }, {
                                    default: withCtx(() => [
                                      createTextVNode(toDisplayString(log.target), 1)
                                    ]),
                                    _: 2
                                  }, 1024)) : createCommentVNode("", true)
                                ])
                              ]),
                              _: 2
                            }, 1032, ["timestamp"]);
                          }), 128)),
                          !recentLogs.value.length ? (openBlock(), createBlock(_component_el_empty, {
                            key: 0,
                            description: "暂无操作记录",
                            "image-size": 60
                          })) : createCommentVNode("", true)
                        ]),
                        _: 1
                      })
                    ])
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_col, {
                xs: 24,
                sm: 24,
                md: 14,
                lg: 14
              }, {
                default: withCtx(() => [
                  createVNode("div", { class: "page-card" }, [
                    createVNode("div", { class: "page-card-header" }, [
                      createVNode("span", { class: "page-card-title" }, "节点状态"),
                      createVNode(_component_el_button, {
                        plain: "",
                        type: "primary",
                        onClick: ($event) => _ctx.$router.push("/nodes")
                      }, {
                        default: withCtx(() => [
                          createTextVNode(" 查看全部 "),
                          createVNode(_component_el_icon, null, {
                            default: withCtx(() => [
                              createVNode(_component_ArrowRight)
                            ]),
                            _: 1
                          })
                        ]),
                        _: 1
                      }, 8, ["onClick"])
                    ]),
                    nodeRows.value.length ? (openBlock(), createBlock("div", {
                      key: 0,
                      class: "record-grid record-grid--dense"
                    }, [
                      (openBlock(true), createBlock(Fragment, null, renderList(nodeRows.value, (row) => {
                        return openBlock(), createBlock("div", {
                          key: row.node.id,
                          class: ["record-card", unref(recordCardToneClass)("node", row.node.status)]
                        }, [
                          createVNode("div", { class: "record-card__head" }, [
                            createVNode("div", { class: "min-w-0" }, [
                              createVNode("div", { class: "record-card__title" }, [
                                createVNode(_component_el_link, {
                                  type: "primary",
                                  onClick: ($event) => _ctx.$router.push(`/nodes/${row.node.id}`)
                                }, {
                                  default: withCtx(() => [
                                    createTextVNode(toDisplayString(row.node.name), 1)
                                  ]),
                                  _: 2
                                }, 1032, ["onClick"])
                              ]),
                              createVNode("div", { class: "record-card__meta" }, toDisplayString(row.node.region || "—"), 1)
                            ]),
                            createVNode(_component_el_tag, {
                              size: "small",
                              round: "",
                              type: "info"
                            }, {
                              default: withCtx(() => {
                                var _a;
                                return [
                                  createTextVNode(toDisplayString(((_a = row.instances) == null ? void 0 : _a.length) || 0) + " 实例", 1)
                                ];
                              }),
                              _: 2
                            }, 1024)
                          ]),
                          createVNode("div", { class: "record-card__fields" }, [
                            createVNode("div", { class: "kv-row" }, [
                              createVNode("span", { class: "kv-label" }, "状态"),
                              createVNode("span", { class: "kv-value" }, [
                                createVNode("span", {
                                  class: ["status-dot", `status-dot--${row.node.status}`]
                                }, null, 2),
                                createTextVNode(" " + toDisplayString(unref(getStatusInfo)("node", row.node.status).label), 1)
                              ])
                            ]),
                            createVNode("div", { class: "kv-row" }, [
                              createVNode("span", { class: "kv-label" }, "在线用户"),
                              createVNode("span", { class: "kv-value" }, toDisplayString(row.node.online_users ?? 0), 1)
                            ])
                          ])
                        ], 2);
                      }), 128))
                    ])) : (openBlock(), createBlock(_component_el_empty, {
                      key: 1,
                      description: "暂无节点",
                      "image-size": 60
                    }))
                  ])
                ]),
                _: 1
              }),
              createVNode(_component_el_col, {
                xs: 24,
                sm: 24,
                md: 10,
                lg: 10
              }, {
                default: withCtx(() => [
                  createVNode("div", { class: "page-card" }, [
                    createVNode("div", { class: "page-card-header" }, [
                      createVNode("span", { class: "page-card-title" }, "最近操作"),
                      createVNode(_component_el_button, {
                        plain: "",
                        type: "primary",
                        onClick: ($event) => _ctx.$router.push("/audit")
                      }, {
                        default: withCtx(() => [
                          createTextVNode(" 查看全部 "),
                          createVNode(_component_el_icon, null, {
                            default: withCtx(() => [
                              createVNode(_component_ArrowRight)
                            ]),
                            _: 1
                          })
                        ]),
                        _: 1
                      }, 8, ["onClick"])
                    ]),
                    createVNode(_component_el_timeline, null, {
                      default: withCtx(() => [
                        (openBlock(true), createBlock(Fragment, null, renderList(recentLogs.value, (log) => {
                          return openBlock(), createBlock(_component_el_timeline_item, {
                            key: log.id,
                            timestamp: unref(formatRelativeTime)(log.created_at),
                            placement: "top"
                          }, {
                            default: withCtx(() => [
                              createVNode("div", { class: "timeline-content" }, [
                                createVNode("span", { class: "timeline-user" }, toDisplayString(log.admin_user), 1),
                                createVNode("span", { class: "timeline-action" }, toDisplayString(log.action), 1),
                                log.target ? (openBlock(), createBlock(_component_el_tag, {
                                  key: 0,
                                  size: "small",
                                  type: "info"
                                }, {
                                  default: withCtx(() => [
                                    createTextVNode(toDisplayString(log.target), 1)
                                  ]),
                                  _: 2
                                }, 1024)) : createCommentVNode("", true)
                              ])
                            ]),
                            _: 2
                          }, 1032, ["timestamp"]);
                        }), 128)),
                        !recentLogs.value.length ? (openBlock(), createBlock(_component_el_empty, {
                          key: 0,
                          description: "暂无操作记录",
                          "image-size": 60
                        })) : createCommentVNode("", true)
                      ]),
                      _: 1
                    })
                  ])
                ]),
                _: 1
              })
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div>`);
    };
  }
};
const _sfc_setup$c = _sfc_main$c.setup;
_sfc_main$c.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/views/Dashboard.vue");
  return _sfc_setup$c ? _sfc_setup$c(props, ctx) : void 0;
};
const Dashboard = /* @__PURE__ */ _export_sfc(_sfc_main$c, [["__scopeId", "data-v-99d1b44b"]]);
const _sfc_main$b = {
  __name: "Nodes",
  __ssrInlineRender: true,
  setup(__props) {
    const rows = ref([]);
    const loading = ref(false);
    const search = ref("");
    const statusFilter = ref("");
    const showAdd = ref(false);
    const addLoading = ref(false);
    const router = useRouter();
    const showDelete = ref(false);
    const deleteLoading = ref(false);
    const deletePassword = ref("");
    const deleteTargetId = ref("");
    const segmentOptions = ref([]);
    const addForm = reactive({ name: "", region: "", public_ip: "", segment_ids: ["default"] });
    const showUpgrade = ref(false);
    const upgradeLoading = ref(false);
    const upgradeTask = ref({});
    const upgradeItems = ref([]);
    const upgradePollTimer = ref(null);
    const latestAgentVersion = ref("");
    const nodeUpgradeStatusMap = ref({});
    const upgradeForm = reactive({
      version: "",
      arch: "amd64",
      download_url: "",
      download_url_lan: "",
      sha256: "",
      canary_node_id: ""
    });
    const upgradeCandidates = ref({});
    const displayAgentVersion = (v) => {
      const s = String(v || "").trim().replace(/^v/i, "").replace(/-unknown$/i, "");
      return s;
    };
    const isNodeOnline = (status) => String(status || "").toLowerCase() === "online";
    const nodeUserOrbitSizeClass = (n) => {
      const v = Number(n);
      if (!Number.isFinite(v) || v < 0) return "";
      if (v > 999) return "node-user-orbit--digits-4";
      if (v > 99) return "node-user-orbit--digits-3";
      if (v > 9) return "node-user-orbit--digits-2";
      return "";
    };
    const agentVersionTooltip = (node) => {
      const raw = String((node == null ? void 0 : node.agent_version) || "").trim();
      const verLine = raw ? `版本：${raw}` : "版本：未上报";
      const arch = (node == null ? void 0 : node.agent_arch) ? `架构：${node.agent_arch}` : "";
      const lat = latestAgentVersion.value ? `仓库参考：${latestAgentVersion.value}` : "";
      return [verLine, arch, lat].filter(Boolean).join("\n");
    };
    const canManageAllNodes = computed(() => {
      const p = getAdminProfile();
      return (p == null ? void 0 : p.role) === "admin" || (p == null ? void 0 : p.permissions) === "*" || (p == null ? void 0 : p.node_scope) === "all";
    });
    const nodesEmptyDescription = computed(() => {
      const p = getAdminProfile();
      if ((p == null ? void 0 : p.node_scope) === "scoped" && Array.isArray(p.node_ids) && p.node_ids.length === 0) {
        return "当前账号未分配任何可管理节点，请联系超级管理员在「管理员管理」中配置节点范围";
      }
      return "暂无节点";
    });
    const filteredRows = computed(() => {
      let list = rows.value;
      if (statusFilter.value) {
        list = list.filter((r) => {
          var _a;
          return ((_a = r.node) == null ? void 0 : _a.status) === statusFilter.value;
        });
      }
      if (search.value) {
        const q = search.value.toLowerCase();
        list = list.filter(
          (r) => {
            var _a, _b;
            return (((_a = r.node) == null ? void 0 : _a.name) || "").toLowerCase().includes(q) || (((_b = r.node) == null ? void 0 : _b.public_ip) || "").includes(q);
          }
        );
      }
      return list;
    });
    const enabledInstances = (list) => (list || []).filter((i) => i.enabled === true);
    const onlineNodes = computed(() => rows.value.filter((r) => {
      var _a;
      return ((_a = r.node) == null ? void 0 : _a.status) === "online";
    }));
    const modeLabel = (mode) => {
      const m = {
        "node-direct": "节点直连",
        "cn-split": "国内分流",
        global: "全局"
      };
      return m[mode] || mode || "-";
    };
    const modeShortLabel = (mode) => {
      const m = { "node-direct": "直连", "cn-split": "分流", global: "全局" };
      return m[mode] || (mode ? String(mode) : "—");
    };
    const instanceTagLabel = (inst) => {
      const p = (inst.proto || "udp").toLowerCase() === "tcp" ? "T" : "U";
      return `${modeShortLabel(inst.mode)}${p}${inst.port}`;
    };
    const instanceTagTooltip = (inst) => {
      const seg = inst.segment_id || "default";
      const proto = (inst.proto || "udp").toUpperCase();
      const parts = [
        `${modeLabel(inst.mode)} ${proto}/${inst.port}`,
        `网段实例: ${seg}`
      ];
      if (inst.subnet) parts.push(`子网: ${inst.subnet}`);
      if (inst.mode) parts.push(`mode: ${inst.mode}`);
      return parts.join("\n");
    };
    const loadSegments = async () => {
      var _a;
      try {
        const res = await http.get("/api/network-segments");
        segmentOptions.value = res.data.items || [];
        if (!((_a = addForm.segment_ids) == null ? void 0 : _a.length) && segmentOptions.value.length) {
          addForm.segment_ids = ["default"].filter(
            (id) => segmentOptions.value.some((s) => s.id === id)
          );
          if (!addForm.segment_ids.length) {
            addForm.segment_ids = [segmentOptions.value[0].id];
          }
        }
      } catch {
        segmentOptions.value = [];
      }
    };
    const loadNodes = async () => {
      loading.value = true;
      try {
        rows.value = (await http.get("/api/nodes")).data.items || [];
      } finally {
        loading.value = false;
      }
    };
    const loadNodeUpgradeStatus = async () => {
      var _a, _b;
      try {
        const res = await http.get("/api/nodes/upgrade-status", {
          // Backward compatible: old api may not have this endpoint.
          validateStatus: (s) => s >= 200 && s < 300 || s === 404
        });
        if (res.status === 404) {
          nodeUpgradeStatusMap.value = {};
          return;
        }
        const items = ((_a = res.data) == null ? void 0 : _a.items) || [];
        if ((_b = res.data) == null ? void 0 : _b.latest_version) latestAgentVersion.value = displayAgentVersion(res.data.latest_version);
        const m = {};
        for (const it of items) {
          if (it.node_id) m[it.node_id] = it;
        }
        nodeUpgradeStatusMap.value = m;
      } catch {
        nodeUpgradeStatusMap.value = {};
      }
    };
    const doAdd = async () => {
      var _a, _b, _c;
      if (!((_a = addForm.segment_ids) == null ? void 0 : _a.length)) {
        ElMessage.warning("请至少选择一个组网网段");
        return;
      }
      addLoading.value = true;
      try {
        const res = await http.post("/api/nodes", {
          name: addForm.name,
          region: addForm.region,
          public_ip: addForm.public_ip,
          segment_ids: addForm.segment_ids
        });
        ElMessage.success(
          "节点创建成功。默认仅启用“节点直连”，其它模式请在节点详情「组网接入」中手动启用并保存。"
        );
        showAdd.value = false;
        Object.assign(addForm, { name: "", region: "", public_ip: "", segment_ids: ["default"] });
        await loadNodes();
        const nid = (_c = (_b = res.data) == null ? void 0 : _b.node) == null ? void 0 : _c.id;
        const postCreateDeploy = {
          token: res.data.bootstrap_token || "",
          online: res.data.deploy_command || "",
          offline: res.data.deploy_offline || "",
          scriptUrl: res.data.script_url || "",
          onlineLan: res.data.deploy_command_lan || "",
          offlineLan: res.data.deploy_offline_lan || "",
          scriptUrlLan: res.data.script_url_lan || "",
          apiUrlLan: res.data.api_url_lan || "",
          deployUrlWarning: res.data.deploy_url_warning || "",
          deployUrlNote: res.data.deploy_url_note || ""
        };
        if (nid) {
          await router.push({ path: `/nodes/${nid}`, state: { postCreateDeploy } });
        } else {
          ElMessage.warning("已创建但响应缺少节点 ID，请从列表进入详情");
        }
      } finally {
        addLoading.value = false;
      }
    };
    const openDeleteDialog = (node) => {
      deleteTargetId.value = node.id;
      deletePassword.value = "";
      showDelete.value = true;
    };
    const confirmDelete = async () => {
      if (!deletePassword.value) {
        ElMessage.warning("请输入密码");
        return;
      }
      deleteLoading.value = true;
      try {
        await http.post(`/api/nodes/${deleteTargetId.value}/delete`, { password: deletePassword.value });
        ElMessage.success("已删除");
        showDelete.value = false;
        loadNodes();
      } catch {
      } finally {
        deleteLoading.value = false;
      }
    };
    const refreshWG = async (node) => {
      var _a, _b;
      if (!(node == null ? void 0 : node.id)) return;
      try {
        const res = await http.post(`/api/nodes/${node.id}/wg-refresh`);
        const invalid = Number((_a = res.data) == null ? void 0 : _a.invalid) || 0;
        const total = Number((_b = res.data) == null ? void 0 : _b.total_tunnel) || 0;
        if (invalid > 0) {
          ElMessage.warning(
            `已下发 WireGuard 配置刷新。共 ${total} 条隧道，其中 ${invalid} 条配置校验未通过（请在节点详情「相关隧道」中查看状态并修正）。`
          );
        } else {
          ElMessage.success(
            total > 0 ? `已下发 WireGuard 配置刷新（${total} 条隧道，配置校验均通过）。` : "已下发 WireGuard 配置刷新（当前无隧道条目）。"
          );
        }
      } catch {
      }
    };
    const stopUpgradePoll = () => {
      if (upgradePollTimer.value) {
        clearInterval(upgradePollTimer.value);
        upgradePollTimer.value = null;
      }
    };
    const loadUpgradeTask = async (taskId) => {
      if (!taskId) return;
      const [tRes, iRes] = await Promise.all([
        http.get(`/api/agent-upgrades/${taskId}`),
        http.get(`/api/agent-upgrades/${taskId}/items`)
      ]);
      upgradeTask.value = tRes.data.task || {};
      upgradeItems.value = iRes.data.items || [];
      if (["succeeded", "failed"].includes(upgradeTask.value.status)) {
        stopUpgradePoll();
        await loadNodes();
        await loadNodeUpgradeStatus();
      }
    };
    const openUpgradeDialog = () => {
      upgradeTask.value = {};
      upgradeItems.value = [];
      Object.assign(upgradeForm, {
        version: "",
        arch: "amd64",
        download_url: "",
        download_url_lan: "",
        sha256: "",
        canary_node_id: ""
      });
      showUpgrade.value = true;
      loadUpgradeDefaults();
    };
    const openUpgradeFromNode = async (row) => {
      var _a;
      const nodeID = (_a = row == null ? void 0 : row.node) == null ? void 0 : _a.id;
      openUpgradeDialog();
      upgradeForm.canary_node_id = nodeID || "";
      const st = nodeUpgradeStatusMap.value[nodeID];
      if (st == null ? void 0 : st.task_id) {
        await loadUpgradeTask(st.task_id);
      }
    };
    const openUpgradeIfNeeded = (row) => {
      var _a;
      if (agentUpgradeHintText((_a = row == null ? void 0 : row.node) == null ? void 0 : _a.agent_version) !== "需更新") return;
      openUpgradeFromNode(row);
    };
    const loadUpgradeDefaults = async () => {
      var _a;
      try {
        const res = await http.get("/api/agent-upgrades/defaults", {
          validateStatus: (s) => s >= 200 && s < 300 || s === 404,
          /** 403 时走 catch 内本地 fallback，避免与全局 403 提示重复 */
          meta: { suppress403: true }
        });
        if (res.status === 404) {
          throw new Error("defaults endpoint not available");
        }
        const d = ((_a = res.data) == null ? void 0 : _a.defaults) || {};
        if (d.version) latestAgentVersion.value = displayAgentVersion(d.version);
        upgradeCandidates.value = d.candidates || {};
        upgradeForm.version = d.version || upgradeForm.version;
        upgradeForm.arch = d.recommended_arch || d.arch || upgradeForm.arch;
        applyArchCandidate(upgradeForm.arch, d);
      } catch {
        const origin = window.location.origin;
        const fallback = {
          version: "19700101.000000",
          recommended_arch: "amd64",
          download_url: `${origin}/api/downloads/vpn-agent/amd64/vpn-agent+19700101.000000`,
          download_url_lan: "",
          sha256: "",
          candidates: {
            amd64: {
              download_url: `${origin}/api/downloads/vpn-agent/amd64/vpn-agent+19700101.000000`,
              download_url_lan: "",
              sha256: ""
            },
            arm64: {
              download_url: `${origin}/api/downloads/vpn-agent/arm64/vpn-agent+19700101.000000`,
              download_url_lan: "",
              sha256: ""
            }
          }
        };
        upgradeCandidates.value = fallback.candidates;
        latestAgentVersion.value = displayAgentVersion(fallback.version);
        upgradeForm.version = fallback.version;
        upgradeForm.arch = fallback.recommended_arch;
        applyArchCandidate(upgradeForm.arch, fallback);
      }
    };
    const applyArchCandidate = (arch, fallbackDefaults = null) => {
      var _a;
      const c = (_a = upgradeCandidates.value) == null ? void 0 : _a[arch];
      if (c) {
        upgradeForm.download_url = c.download_url || "";
        upgradeForm.download_url_lan = c.download_url_lan || "";
        upgradeForm.sha256 = c.sha256 || "";
        return;
      }
      const d = fallbackDefaults || {};
      upgradeForm.download_url = d.download_url || upgradeForm.download_url;
      upgradeForm.download_url_lan = d.download_url_lan || upgradeForm.download_url_lan;
      upgradeForm.sha256 = d.sha256 || upgradeForm.sha256;
    };
    const startUpgrade = async () => {
      var _a, _b;
      if (!upgradeForm.version || !upgradeForm.download_url || !upgradeForm.sha256) {
        ElMessage.warning("请填写版本、下载地址和 SHA256");
        return;
      }
      upgradeLoading.value = true;
      try {
        const res = await http.post("/api/agent-upgrades", {
          version: upgradeForm.version,
          download_url: upgradeForm.download_url,
          download_url_lan: upgradeForm.download_url_lan || "",
          sha256: upgradeForm.sha256,
          canary_node_id: upgradeForm.canary_node_id || ""
        });
        const taskId = (_b = (_a = res.data) == null ? void 0 : _a.task) == null ? void 0 : _b.id;
        if (!taskId) {
          ElMessage.error("创建升级任务失败：无任务 ID");
          return;
        }
        ElMessage.success(`已创建升级任务 #${taskId}`);
        await loadUpgradeTask(taskId);
        stopUpgradePoll();
        upgradePollTimer.value = setInterval(() => loadUpgradeTask(taskId), 3e3);
      } finally {
        upgradeLoading.value = false;
      }
    };
    const formatUpgradeStage = (stage) => {
      const m = {
        canary: "灰度",
        rollout: "全量"
      };
      return m[stage] || stage || "-";
    };
    const formatUpgradeStatus = (status) => {
      const m = {
        prechecking: "预检中",
        pending: "待执行",
        running: "执行中",
        verifying: "校验中",
        succeeded: "成功",
        failed: "失败",
        timeout: "超时",
        skipped: "跳过"
      };
      return m[status] || status || "-";
    };
    const upgradeStatusTagType = (status) => {
      if (status === "succeeded") return "success";
      if (status === "failed" || status === "timeout") return "danger";
      if (status === "running" || status === "prechecking" || status === "verifying") return "warning";
      if (status === "skipped") return "info";
      return "info";
    };
    const parseVersion = (v) => {
      const s = displayAgentVersion(v);
      if (!s) return null;
      const parts = s.split(".").map((x) => Number.parseInt(x, 10));
      if (parts.some((n) => Number.isNaN(n))) return null;
      while (parts.length < 3) parts.push(0);
      return parts.slice(0, 3);
    };
    const compareVersion = (a, b) => {
      const va = parseVersion(a);
      const vb = parseVersion(b);
      if (!va || !vb) return 0;
      for (let i = 0; i < 3; i++) {
        if (va[i] > vb[i]) return 1;
        if (va[i] < vb[i]) return -1;
      }
      return 0;
    };
    const agentUpgradeHintText = (current) => {
      if (!current) return "未上报";
      if (!parseVersion(current)) return "版本异常";
      if (!parseVersion(latestAgentVersion.value)) return "版本未知";
      const cmp = compareVersion(current, latestAgentVersion.value);
      if (cmp >= 0) return "已最新";
      return "需更新";
    };
    const agentUpgradeHintType = (current) => {
      if (!current) return "warning";
      if (!parseVersion(current) || !parseVersion(latestAgentVersion.value)) return "warning";
      const cmp = compareVersion(current, latestAgentVersion.value);
      return cmp >= 0 ? "success" : "danger";
    };
    onMounted(async () => {
      await loadUpgradeDefaults();
      await loadSegments();
      await loadNodes();
      await loadNodeUpgradeStatus();
    });
    onUnmounted(() => {
      stopUpgradePoll();
    });
    return (_ctx, _push, _parent, _attrs) => {
      const _component_el_button = resolveComponent("el-button");
      const _component_el_icon = resolveComponent("el-icon");
      const _component_Plus = resolveComponent("Plus");
      const _component_el_input = resolveComponent("el-input");
      const _component_el_select = resolveComponent("el-select");
      const _component_el_option = resolveComponent("el-option");
      const _component_el_text = resolveComponent("el-text");
      const _component_el_link = resolveComponent("el-link");
      const _component_el_tooltip = resolveComponent("el-tooltip");
      const _component_el_tag = resolveComponent("el-tag");
      const _component_Delete = resolveComponent("Delete");
      const _component_el_empty = resolveComponent("el-empty");
      const _component_el_dialog = resolveComponent("el-dialog");
      const _component_el_alert = resolveComponent("el-alert");
      const _component_el_form = resolveComponent("el-form");
      const _component_el_form_item = resolveComponent("el-form-item");
      const _directive_loading = resolveDirective("loading");
      _push(`<div${ssrRenderAttrs(_attrs)} data-v-e2c06596><div class="page-card" data-v-e2c06596><div class="page-card-header" data-v-e2c06596><span class="page-card-title" data-v-e2c06596>节点管理</span><div style="${ssrRenderStyle({ "display": "flex", "gap": "8px" })}" data-v-e2c06596>`);
      if (canManageAllNodes.value) {
        _push(ssrRenderComponent(_component_el_button, { onClick: openUpgradeDialog }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`批量升级 Agent`);
            } else {
              return [
                createTextVNode("批量升级 Agent")
              ];
            }
          }),
          _: 1
        }, _parent));
      } else {
        _push(`<!---->`);
      }
      if (canManageAllNodes.value) {
        _push(ssrRenderComponent(_component_el_button, {
          type: "primary",
          onClick: ($event) => showAdd.value = true
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(ssrRenderComponent(_component_el_icon, null, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(ssrRenderComponent(_component_Plus, null, null, _parent3, _scopeId2));
                  } else {
                    return [
                      createVNode(_component_Plus)
                    ];
                  }
                }),
                _: 1
              }, _parent2, _scopeId));
              _push2(` 添加节点 `);
            } else {
              return [
                createVNode(_component_el_icon, null, {
                  default: withCtx(() => [
                    createVNode(_component_Plus)
                  ]),
                  _: 1
                }),
                createTextVNode(" 添加节点 ")
              ];
            }
          }),
          _: 1
        }, _parent));
      } else {
        _push(`<!---->`);
      }
      _push(`</div></div><div class="action-bar" data-v-e2c06596><div class="filter-group" data-v-e2c06596>`);
      _push(ssrRenderComponent(_component_el_input, {
        modelValue: search.value,
        "onUpdate:modelValue": ($event) => search.value = $event,
        placeholder: "搜索名称 / IP...",
        clearable: "",
        style: { "width": "220px" },
        "prefix-icon": unref(Search)
      }, null, _parent));
      _push(ssrRenderComponent(_component_el_select, {
        modelValue: statusFilter.value,
        "onUpdate:modelValue": ($event) => statusFilter.value = $event,
        placeholder: "状态筛选",
        clearable: "",
        style: { "width": "130px" }
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_option, {
              label: "在线",
              value: "online"
            }, null, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_option, {
              label: "离线",
              value: "offline"
            }, null, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_option, {
                label: "在线",
                value: "online"
              }),
              createVNode(_component_el_option, {
                label: "离线",
                value: "offline"
              })
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div>`);
      _push(ssrRenderComponent(_component_el_text, {
        type: "info",
        size: "small"
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`共 ${ssrInterpolate(filteredRows.value.length)} 个节点`);
          } else {
            return [
              createTextVNode("共 " + toDisplayString(filteredRows.value.length) + " 个节点", 1)
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div><div${ssrRenderAttrs(mergeProps({ class: "record-grid" }, ssrGetDirectiveProps(_ctx, _directive_loading, loading.value)))} data-v-e2c06596><!--[-->`);
      ssrRenderList(filteredRows.value, (row) => {
        var _a;
        _push(`<div class="${ssrRenderClass([unref(recordCardToneClass)("node", row.node.status), "record-card node-list-card"])}" data-v-e2c06596><div class="record-card__head" data-v-e2c06596><div class="min-w-0" data-v-e2c06596><div class="record-card__title record-card__title--with-node-num" data-v-e2c06596>`);
        _push(ssrRenderComponent(_component_el_link, {
          type: "primary",
          onClick: ($event) => _ctx.$router.push(`/nodes/${row.node.id}`)
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`${ssrInterpolate(row.node.name)}`);
            } else {
              return [
                createTextVNode(toDisplayString(row.node.name), 1)
              ];
            }
          }),
          _: 2
        }, _parent));
        if (row.node.node_number != null && row.node.node_number !== "") {
          _push(`<span class="node-title-node-number" data-v-e2c06596> · ${ssrInterpolate(row.node.node_number)}</span>`);
        } else {
          _push(`<!---->`);
        }
        _push(`</div><div class="record-card__meta" data-v-e2c06596>${ssrInterpolate(row.node.region || "—")} `);
        if (row.node.public_ip) {
          _push(`<span data-v-e2c06596> · ${ssrInterpolate(row.node.public_ip)}</span>`);
        } else {
          _push(`<!---->`);
        }
        _push(`</div></div><div class="record-card__head-aside" data-v-e2c06596>`);
        if (agentUpgradeHintText((_a = row.node) == null ? void 0 : _a.agent_version) !== "已最新") {
          _push(ssrRenderComponent(_component_el_tooltip, {
            placement: "top",
            content: agentVersionTooltip(row.node)
          }, {
            default: withCtx((_, _push2, _parent2, _scopeId) => {
              var _a2, _b, _c, _d;
              if (_push2) {
                _push2(ssrRenderComponent(_component_el_tag, {
                  size: "small",
                  type: agentUpgradeHintType((_a2 = row.node) == null ? void 0 : _a2.agent_version),
                  style: { cursor: agentUpgradeHintText((_b = row.node) == null ? void 0 : _b.agent_version) === "需更新" ? "pointer" : "default" },
                  class: "node-agent-status-tag",
                  onClick: ($event) => openUpgradeIfNeeded(row)
                }, {
                  default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    var _a3, _b2;
                    if (_push3) {
                      _push3(`${ssrInterpolate(agentUpgradeHintText((_a3 = row.node) == null ? void 0 : _a3.agent_version))}`);
                    } else {
                      return [
                        createTextVNode(toDisplayString(agentUpgradeHintText((_b2 = row.node) == null ? void 0 : _b2.agent_version)), 1)
                      ];
                    }
                  }),
                  _: 2
                }, _parent2, _scopeId));
              } else {
                return [
                  createVNode(_component_el_tag, {
                    size: "small",
                    type: agentUpgradeHintType((_c = row.node) == null ? void 0 : _c.agent_version),
                    style: { cursor: agentUpgradeHintText((_d = row.node) == null ? void 0 : _d.agent_version) === "需更新" ? "pointer" : "default" },
                    class: "node-agent-status-tag",
                    onClick: ($event) => openUpgradeIfNeeded(row)
                  }, {
                    default: withCtx(() => {
                      var _a3;
                      return [
                        createTextVNode(toDisplayString(agentUpgradeHintText((_a3 = row.node) == null ? void 0 : _a3.agent_version)), 1)
                      ];
                    }),
                    _: 2
                  }, 1032, ["type", "style", "onClick"])
                ];
              }
            }),
            _: 2
          }, _parent));
        } else {
          _push(`<!---->`);
        }
        _push(ssrRenderComponent(_component_el_tooltip, {
          placement: "top",
          content: `${unref(getStatusInfo)("node", row.node.status).label}，在线用户 ${row.node.online_users ?? 0}`
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`<span class="node-user-orbit-tooltip" data-v-e2c06596${_scopeId}><span class="${ssrRenderClass([
                isNodeOnline(row.node.status) ? "node-user-orbit-wrap--online" : "node-user-orbit-wrap--offline",
                "node-user-orbit-wrap"
              ])}" data-v-e2c06596${_scopeId}>`);
              if (isNodeOnline(row.node.status)) {
                _push2(`<span class="node-user-orbit-spin" aria-hidden="true" data-v-e2c06596${_scopeId}></span>`);
              } else {
                _push2(`<!---->`);
              }
              _push2(`<span class="${ssrRenderClass([nodeUserOrbitSizeClass(row.node.online_users), "node-user-orbit-inner"])}" data-v-e2c06596${_scopeId}><span class="node-user-orbit-num" data-v-e2c06596${_scopeId}>${ssrInterpolate(row.node.online_users ?? 0)}</span></span></span></span>`);
            } else {
              return [
                createVNode("span", { class: "node-user-orbit-tooltip" }, [
                  createVNode("span", {
                    class: [
                      "node-user-orbit-wrap",
                      isNodeOnline(row.node.status) ? "node-user-orbit-wrap--online" : "node-user-orbit-wrap--offline"
                    ]
                  }, [
                    isNodeOnline(row.node.status) ? (openBlock(), createBlock("span", {
                      key: 0,
                      class: "node-user-orbit-spin",
                      "aria-hidden": "true"
                    })) : createCommentVNode("", true),
                    createVNode("span", {
                      class: ["node-user-orbit-inner", nodeUserOrbitSizeClass(row.node.online_users)]
                    }, [
                      createVNode("span", { class: "node-user-orbit-num" }, toDisplayString(row.node.online_users ?? 0), 1)
                    ], 2)
                  ], 2)
                ])
              ];
            }
          }),
          _: 2
        }, _parent));
        _push(`</div></div><div class="record-card__tags record-card__tags--node-list" data-v-e2c06596>`);
        if (enabledInstances(row.instances).length) {
          _push(`<!--[-->`);
          ssrRenderList(enabledInstances(row.instances), (inst) => {
            _push(ssrRenderComponent(_component_el_tooltip, {
              key: inst.id,
              placement: "top",
              content: instanceTagTooltip(inst)
            }, {
              default: withCtx((_, _push2, _parent2, _scopeId) => {
                if (_push2) {
                  _push2(ssrRenderComponent(_component_el_tag, {
                    size: "small",
                    class: "instance-tag"
                  }, {
                    default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                      if (_push3) {
                        _push3(`${ssrInterpolate(instanceTagLabel(inst))}`);
                      } else {
                        return [
                          createTextVNode(toDisplayString(instanceTagLabel(inst)), 1)
                        ];
                      }
                    }),
                    _: 2
                  }, _parent2, _scopeId));
                } else {
                  return [
                    createVNode(_component_el_tag, {
                      size: "small",
                      class: "instance-tag"
                    }, {
                      default: withCtx(() => [
                        createTextVNode(toDisplayString(instanceTagLabel(inst)), 1)
                      ]),
                      _: 2
                    }, 1024)
                  ];
                }
              }),
              _: 2
            }, _parent));
          });
          _push(`<!--]-->`);
        } else {
          _push(ssrRenderComponent(_component_el_text, {
            type: "info",
            size: "small"
          }, {
            default: withCtx((_, _push2, _parent2, _scopeId) => {
              if (_push2) {
                _push2(`暂无已启用接入`);
              } else {
                return [
                  createTextVNode("暂无已启用接入")
                ];
              }
            }),
            _: 2
          }, _parent));
        }
        _push(`</div><div class="record-card__actions" data-v-e2c06596>`);
        _push(ssrRenderComponent(_component_el_button, {
          size: "small",
          plain: "",
          onClick: ($event) => refreshWG(row.node)
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`刷新WG`);
            } else {
              return [
                createTextVNode("刷新WG")
              ];
            }
          }),
          _: 2
        }, _parent));
        _push(ssrRenderComponent(_component_el_button, {
          size: "small",
          type: "primary",
          plain: "",
          onClick: ($event) => _ctx.$router.push(`/nodes/${row.node.id}`)
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(ssrRenderComponent(_component_el_icon, null, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(ssrRenderComponent(unref(EditPen), null, null, _parent3, _scopeId2));
                  } else {
                    return [
                      createVNode(unref(EditPen))
                    ];
                  }
                }),
                _: 2
              }, _parent2, _scopeId));
              _push2(` 编辑 `);
            } else {
              return [
                createVNode(_component_el_icon, null, {
                  default: withCtx(() => [
                    createVNode(unref(EditPen))
                  ]),
                  _: 1
                }),
                createTextVNode(" 编辑 ")
              ];
            }
          }),
          _: 2
        }, _parent));
        _push(ssrRenderComponent(_component_el_button, {
          size: "small",
          type: "danger",
          plain: "",
          onClick: ($event) => openDeleteDialog(row.node)
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(ssrRenderComponent(_component_el_icon, null, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(ssrRenderComponent(_component_Delete, null, null, _parent3, _scopeId2));
                  } else {
                    return [
                      createVNode(_component_Delete)
                    ];
                  }
                }),
                _: 2
              }, _parent2, _scopeId));
              _push2(` 删除 `);
            } else {
              return [
                createVNode(_component_el_icon, null, {
                  default: withCtx(() => [
                    createVNode(_component_Delete)
                  ]),
                  _: 1
                }),
                createTextVNode(" 删除 ")
              ];
            }
          }),
          _: 2
        }, _parent));
        _push(`</div></div>`);
      });
      _push(`<!--]-->`);
      if (!loading.value && !filteredRows.value.length) {
        _push(ssrRenderComponent(_component_el_empty, {
          description: nodesEmptyDescription.value,
          "image-size": 60
        }, null, _parent));
      } else {
        _push(`<!---->`);
      }
      _push(`</div></div>`);
      _push(ssrRenderComponent(_component_el_dialog, {
        modelValue: showAdd.value,
        "onUpdate:modelValue": ($event) => showAdd.value = $event,
        title: "添加节点",
        width: "520px",
        "destroy-on-close": ""
      }, {
        footer: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_button, {
              onClick: ($event) => showAdd.value = false
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`取消`);
                } else {
                  return [
                    createTextVNode("取消")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_button, {
              type: "primary",
              loading: addLoading.value,
              onClick: doAdd
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`确认添加`);
                } else {
                  return [
                    createTextVNode("确认添加")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_button, {
                onClick: ($event) => showAdd.value = false
              }, {
                default: withCtx(() => [
                  createTextVNode("取消")
                ]),
                _: 1
              }, 8, ["onClick"]),
              createVNode(_component_el_button, {
                type: "primary",
                loading: addLoading.value,
                onClick: doAdd
              }, {
                default: withCtx(() => [
                  createTextVNode("确认添加")
                ]),
                _: 1
              }, 8, ["loading"])
            ];
          }
        }),
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_alert, {
              type: "info",
              closable: false,
              "show-icon": "",
              style: { "margin-bottom": "14px" }
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(` 各接入实例的 VPN 子网由系统按节点号与所选网段自动分配，无需手工填写。 `);
                } else {
                  return [
                    createTextVNode(" 各接入实例的 VPN 子网由系统按节点号与所选网段自动分配，无需手工填写。 ")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_form, {
              model: addForm,
              "label-width": "100px"
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_form_item, {
                    label: "组网网段",
                    required: ""
                  }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_select, {
                          modelValue: addForm.segment_ids,
                          "onUpdate:modelValue": ($event) => addForm.segment_ids = $event,
                          multiple: "",
                          filterable: "",
                          placeholder: "至少选择一个网段",
                          style: { "width": "100%" }
                        }, {
                          default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                            if (_push5) {
                              _push5(`<!--[-->`);
                              ssrRenderList(segmentOptions.value, (s) => {
                                _push5(ssrRenderComponent(_component_el_option, {
                                  key: s.id,
                                  label: `${s.name} (${s.id})`,
                                  value: s.id
                                }, null, _parent5, _scopeId4));
                              });
                              _push5(`<!--]-->`);
                            } else {
                              return [
                                (openBlock(true), createBlock(Fragment, null, renderList(segmentOptions.value, (s) => {
                                  return openBlock(), createBlock(_component_el_option, {
                                    key: s.id,
                                    label: `${s.name} (${s.id})`,
                                    value: s.id
                                  }, null, 8, ["label", "value"]);
                                }), 128))
                              ];
                            }
                          }),
                          _: 1
                        }, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_select, {
                            modelValue: addForm.segment_ids,
                            "onUpdate:modelValue": ($event) => addForm.segment_ids = $event,
                            multiple: "",
                            filterable: "",
                            placeholder: "至少选择一个网段",
                            style: { "width": "100%" }
                          }, {
                            default: withCtx(() => [
                              (openBlock(true), createBlock(Fragment, null, renderList(segmentOptions.value, (s) => {
                                return openBlock(), createBlock(_component_el_option, {
                                  key: s.id,
                                  label: `${s.name} (${s.id})`,
                                  value: s.id
                                }, null, 8, ["label", "value"]);
                              }), 128))
                            ]),
                            _: 1
                          }, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "名称" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: addForm.name,
                          "onUpdate:modelValue": ($event) => addForm.name = $event,
                          placeholder: "如: Shanghai"
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: addForm.name,
                            "onUpdate:modelValue": ($event) => addForm.name = $event,
                            placeholder: "如: Shanghai"
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "地域" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: addForm.region,
                          "onUpdate:modelValue": ($event) => addForm.region = $event,
                          placeholder: "如: cn-east"
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: addForm.region,
                            "onUpdate:modelValue": ($event) => addForm.region = $event,
                            placeholder: "如: cn-east"
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "公网地址" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: addForm.public_ip,
                          "onUpdate:modelValue": ($event) => addForm.public_ip = $event,
                          placeholder: "如: 1.2.3.4 或 node.example.com"
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: addForm.public_ip,
                            "onUpdate:modelValue": ($event) => addForm.public_ip = $event,
                            placeholder: "如: 1.2.3.4 或 node.example.com"
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_el_form_item, {
                      label: "组网网段",
                      required: ""
                    }, {
                      default: withCtx(() => [
                        createVNode(_component_el_select, {
                          modelValue: addForm.segment_ids,
                          "onUpdate:modelValue": ($event) => addForm.segment_ids = $event,
                          multiple: "",
                          filterable: "",
                          placeholder: "至少选择一个网段",
                          style: { "width": "100%" }
                        }, {
                          default: withCtx(() => [
                            (openBlock(true), createBlock(Fragment, null, renderList(segmentOptions.value, (s) => {
                              return openBlock(), createBlock(_component_el_option, {
                                key: s.id,
                                label: `${s.name} (${s.id})`,
                                value: s.id
                              }, null, 8, ["label", "value"]);
                            }), 128))
                          ]),
                          _: 1
                        }, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "名称" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: addForm.name,
                          "onUpdate:modelValue": ($event) => addForm.name = $event,
                          placeholder: "如: Shanghai"
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "地域" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: addForm.region,
                          "onUpdate:modelValue": ($event) => addForm.region = $event,
                          placeholder: "如: cn-east"
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "公网地址" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: addForm.public_ip,
                          "onUpdate:modelValue": ($event) => addForm.public_ip = $event,
                          placeholder: "如: 1.2.3.4 或 node.example.com"
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    })
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_alert, {
                type: "info",
                closable: false,
                "show-icon": "",
                style: { "margin-bottom": "14px" }
              }, {
                default: withCtx(() => [
                  createTextVNode(" 各接入实例的 VPN 子网由系统按节点号与所选网段自动分配，无需手工填写。 ")
                ]),
                _: 1
              }),
              createVNode(_component_el_form, {
                model: addForm,
                "label-width": "100px"
              }, {
                default: withCtx(() => [
                  createVNode(_component_el_form_item, {
                    label: "组网网段",
                    required: ""
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_el_select, {
                        modelValue: addForm.segment_ids,
                        "onUpdate:modelValue": ($event) => addForm.segment_ids = $event,
                        multiple: "",
                        filterable: "",
                        placeholder: "至少选择一个网段",
                        style: { "width": "100%" }
                      }, {
                        default: withCtx(() => [
                          (openBlock(true), createBlock(Fragment, null, renderList(segmentOptions.value, (s) => {
                            return openBlock(), createBlock(_component_el_option, {
                              key: s.id,
                              label: `${s.name} (${s.id})`,
                              value: s.id
                            }, null, 8, ["label", "value"]);
                          }), 128))
                        ]),
                        _: 1
                      }, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "名称" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: addForm.name,
                        "onUpdate:modelValue": ($event) => addForm.name = $event,
                        placeholder: "如: Shanghai"
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "地域" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: addForm.region,
                        "onUpdate:modelValue": ($event) => addForm.region = $event,
                        placeholder: "如: cn-east"
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "公网地址" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: addForm.public_ip,
                        "onUpdate:modelValue": ($event) => addForm.public_ip = $event,
                        placeholder: "如: 1.2.3.4 或 node.example.com"
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  })
                ]),
                _: 1
              }, 8, ["model"])
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(ssrRenderComponent(_component_el_dialog, {
        modelValue: showDelete.value,
        "onUpdate:modelValue": ($event) => showDelete.value = $event,
        title: "删除节点",
        width: "400px",
        "destroy-on-close": "",
        onClosed: ($event) => deletePassword.value = ""
      }, {
        footer: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_button, {
              onClick: ($event) => showDelete.value = false
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`取消`);
                } else {
                  return [
                    createTextVNode("取消")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_button, {
              type: "danger",
              loading: deleteLoading.value,
              onClick: confirmDelete
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`确认删除`);
                } else {
                  return [
                    createTextVNode("确认删除")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_button, {
                onClick: ($event) => showDelete.value = false
              }, {
                default: withCtx(() => [
                  createTextVNode("取消")
                ]),
                _: 1
              }, 8, ["onClick"]),
              createVNode(_component_el_button, {
                type: "danger",
                loading: deleteLoading.value,
                onClick: confirmDelete
              }, {
                default: withCtx(() => [
                  createTextVNode("确认删除")
                ]),
                _: 1
              }, 8, ["loading"])
            ];
          }
        }),
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`<p style="${ssrRenderStyle({ "margin": "0 0 12px", "color": "var(--text-secondary)", "font-size": "13px" })}" data-v-e2c06596${_scopeId}> 删除节点将清理相关隧道与接入配置，此操作不可恢复。请输入当前登录管理员密码确认。 </p>`);
            _push2(ssrRenderComponent(_component_el_input, {
              modelValue: deletePassword.value,
              "onUpdate:modelValue": ($event) => deletePassword.value = $event,
              type: "password",
              placeholder: "管理员密码",
              "show-password": "",
              onKeyup: confirmDelete
            }, null, _parent2, _scopeId));
          } else {
            return [
              createVNode("p", { style: { "margin": "0 0 12px", "color": "var(--text-secondary)", "font-size": "13px" } }, " 删除节点将清理相关隧道与接入配置，此操作不可恢复。请输入当前登录管理员密码确认。 "),
              createVNode(_component_el_input, {
                modelValue: deletePassword.value,
                "onUpdate:modelValue": ($event) => deletePassword.value = $event,
                type: "password",
                placeholder: "管理员密码",
                "show-password": "",
                onKeyup: withKeys(confirmDelete, ["enter"])
              }, null, 8, ["modelValue", "onUpdate:modelValue"])
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(ssrRenderComponent(_component_el_dialog, {
        modelValue: showUpgrade.value,
        "onUpdate:modelValue": ($event) => showUpgrade.value = $event,
        title: "批量升级 Agent",
        width: "720px",
        "destroy-on-close": ""
      }, {
        footer: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_button, {
              onClick: ($event) => showUpgrade.value = false
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`关闭`);
                } else {
                  return [
                    createTextVNode("关闭")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_button, {
              type: "primary",
              loading: upgradeLoading.value,
              onClick: startUpgrade
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`开始灰度+全量`);
                } else {
                  return [
                    createTextVNode("开始灰度+全量")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_button, {
                onClick: ($event) => showUpgrade.value = false
              }, {
                default: withCtx(() => [
                  createTextVNode("关闭")
                ]),
                _: 1
              }, 8, ["onClick"]),
              createVNode(_component_el_button, {
                type: "primary",
                loading: upgradeLoading.value,
                onClick: startUpgrade
              }, {
                default: withCtx(() => [
                  createTextVNode("开始灰度+全量")
                ]),
                _: 1
              }, 8, ["loading"])
            ];
          }
        }),
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_form, {
              model: upgradeForm,
              "label-width": "120px"
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_form_item, {
                    label: "目标版本",
                    required: ""
                  }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: upgradeForm.version,
                          "onUpdate:modelValue": ($event) => upgradeForm.version = $event,
                          placeholder: "如: 0.2.1"
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: upgradeForm.version,
                            "onUpdate:modelValue": ($event) => upgradeForm.version = $event,
                            placeholder: "如: 0.2.1"
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "架构推荐" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_select, {
                          modelValue: upgradeForm.arch,
                          "onUpdate:modelValue": ($event) => upgradeForm.arch = $event,
                          style: { "width": "100%" },
                          onChange: applyArchCandidate
                        }, {
                          default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                            if (_push5) {
                              _push5(ssrRenderComponent(_component_el_option, {
                                label: "amd64",
                                value: "amd64"
                              }, null, _parent5, _scopeId4));
                              _push5(ssrRenderComponent(_component_el_option, {
                                label: "arm64",
                                value: "arm64"
                              }, null, _parent5, _scopeId4));
                            } else {
                              return [
                                createVNode(_component_el_option, {
                                  label: "amd64",
                                  value: "amd64"
                                }),
                                createVNode(_component_el_option, {
                                  label: "arm64",
                                  value: "arm64"
                                })
                              ];
                            }
                          }),
                          _: 1
                        }, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_select, {
                            modelValue: upgradeForm.arch,
                            "onUpdate:modelValue": ($event) => upgradeForm.arch = $event,
                            style: { "width": "100%" },
                            onChange: applyArchCandidate
                          }, {
                            default: withCtx(() => [
                              createVNode(_component_el_option, {
                                label: "amd64",
                                value: "amd64"
                              }),
                              createVNode(_component_el_option, {
                                label: "arm64",
                                value: "arm64"
                              })
                            ]),
                            _: 1
                          }, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, {
                    label: "下载地址",
                    required: ""
                  }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: upgradeForm.download_url,
                          "onUpdate:modelValue": ($event) => upgradeForm.download_url = $event,
                          placeholder: "https://.../vpn-agent-linux-amd64"
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: upgradeForm.download_url,
                            "onUpdate:modelValue": ($event) => upgradeForm.download_url = $event,
                            placeholder: "https://.../vpn-agent-linux-amd64"
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "内网地址" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: upgradeForm.download_url_lan,
                          "onUpdate:modelValue": ($event) => upgradeForm.download_url_lan = $event,
                          placeholder: "http://intranet/.../vpn-agent-linux-amd64 (可选)"
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: upgradeForm.download_url_lan,
                            "onUpdate:modelValue": ($event) => upgradeForm.download_url_lan = $event,
                            placeholder: "http://intranet/.../vpn-agent-linux-amd64 (可选)"
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, {
                    label: "SHA256",
                    required: ""
                  }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: upgradeForm.sha256,
                          "onUpdate:modelValue": ($event) => upgradeForm.sha256 = $event,
                          placeholder: "64 位 sha256"
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: upgradeForm.sha256,
                            "onUpdate:modelValue": ($event) => upgradeForm.sha256 = $event,
                            placeholder: "64 位 sha256"
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "灰度节点" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_select, {
                          modelValue: upgradeForm.canary_node_id,
                          "onUpdate:modelValue": ($event) => upgradeForm.canary_node_id = $event,
                          clearable: "",
                          placeholder: "默认自动选第一个在线节点",
                          style: { "width": "100%" }
                        }, {
                          default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                            if (_push5) {
                              _push5(`<!--[-->`);
                              ssrRenderList(onlineNodes.value, (n) => {
                                _push5(ssrRenderComponent(_component_el_option, {
                                  key: n.node.id,
                                  label: `${n.node.name} (${n.node.id})`,
                                  value: n.node.id
                                }, null, _parent5, _scopeId4));
                              });
                              _push5(`<!--]-->`);
                            } else {
                              return [
                                (openBlock(true), createBlock(Fragment, null, renderList(onlineNodes.value, (n) => {
                                  return openBlock(), createBlock(_component_el_option, {
                                    key: n.node.id,
                                    label: `${n.node.name} (${n.node.id})`,
                                    value: n.node.id
                                  }, null, 8, ["label", "value"]);
                                }), 128))
                              ];
                            }
                          }),
                          _: 1
                        }, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_select, {
                            modelValue: upgradeForm.canary_node_id,
                            "onUpdate:modelValue": ($event) => upgradeForm.canary_node_id = $event,
                            clearable: "",
                            placeholder: "默认自动选第一个在线节点",
                            style: { "width": "100%" }
                          }, {
                            default: withCtx(() => [
                              (openBlock(true), createBlock(Fragment, null, renderList(onlineNodes.value, (n) => {
                                return openBlock(), createBlock(_component_el_option, {
                                  key: n.node.id,
                                  label: `${n.node.name} (${n.node.id})`,
                                  value: n.node.id
                                }, null, 8, ["label", "value"]);
                              }), 128))
                            ]),
                            _: 1
                          }, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_el_form_item, {
                      label: "目标版本",
                      required: ""
                    }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: upgradeForm.version,
                          "onUpdate:modelValue": ($event) => upgradeForm.version = $event,
                          placeholder: "如: 0.2.1"
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "架构推荐" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_select, {
                          modelValue: upgradeForm.arch,
                          "onUpdate:modelValue": ($event) => upgradeForm.arch = $event,
                          style: { "width": "100%" },
                          onChange: applyArchCandidate
                        }, {
                          default: withCtx(() => [
                            createVNode(_component_el_option, {
                              label: "amd64",
                              value: "amd64"
                            }),
                            createVNode(_component_el_option, {
                              label: "arm64",
                              value: "arm64"
                            })
                          ]),
                          _: 1
                        }, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, {
                      label: "下载地址",
                      required: ""
                    }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: upgradeForm.download_url,
                          "onUpdate:modelValue": ($event) => upgradeForm.download_url = $event,
                          placeholder: "https://.../vpn-agent-linux-amd64"
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "内网地址" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: upgradeForm.download_url_lan,
                          "onUpdate:modelValue": ($event) => upgradeForm.download_url_lan = $event,
                          placeholder: "http://intranet/.../vpn-agent-linux-amd64 (可选)"
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, {
                      label: "SHA256",
                      required: ""
                    }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: upgradeForm.sha256,
                          "onUpdate:modelValue": ($event) => upgradeForm.sha256 = $event,
                          placeholder: "64 位 sha256"
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "灰度节点" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_select, {
                          modelValue: upgradeForm.canary_node_id,
                          "onUpdate:modelValue": ($event) => upgradeForm.canary_node_id = $event,
                          clearable: "",
                          placeholder: "默认自动选第一个在线节点",
                          style: { "width": "100%" }
                        }, {
                          default: withCtx(() => [
                            (openBlock(true), createBlock(Fragment, null, renderList(onlineNodes.value, (n) => {
                              return openBlock(), createBlock(_component_el_option, {
                                key: n.node.id,
                                label: `${n.node.name} (${n.node.id})`,
                                value: n.node.id
                              }, null, 8, ["label", "value"]);
                            }), 128))
                          ]),
                          _: 1
                        }, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    })
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            if (upgradeTask.value.id) {
              _push2(ssrRenderComponent(_component_el_alert, {
                type: "info",
                closable: false,
                "show-icon": "",
                style: { "margin-bottom": "12px" }
              }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(` 任务 #${ssrInterpolate(upgradeTask.value.id)} 状态：${ssrInterpolate(upgradeTask.value.status)}，成功 ${ssrInterpolate(upgradeTask.value.success_count || 0)}/${ssrInterpolate(upgradeTask.value.total_nodes || 0)}，失败 ${ssrInterpolate(upgradeTask.value.failed_count || 0)}`);
                  } else {
                    return [
                      createTextVNode(" 任务 #" + toDisplayString(upgradeTask.value.id) + " 状态：" + toDisplayString(upgradeTask.value.status) + "，成功 " + toDisplayString(upgradeTask.value.success_count || 0) + "/" + toDisplayString(upgradeTask.value.total_nodes || 0) + "，失败 " + toDisplayString(upgradeTask.value.failed_count || 0), 1)
                    ];
                  }
                }),
                _: 1
              }, _parent2, _scopeId));
            } else {
              _push2(`<!---->`);
            }
            if (upgradeItems.value.length) {
              _push2(`<div class="dialog-record-stack" data-v-e2c06596${_scopeId}><!--[-->`);
              ssrRenderList(upgradeItems.value, (it, idx) => {
                _push2(`<div class="${ssrRenderClass([unref(recordCardToneFromTagType)(upgradeStatusTagType(it.status)), "record-card"])}" data-v-e2c06596${_scopeId}><div class="record-card__head" data-v-e2c06596${_scopeId}><div class="record-card__title mono-text min-w-0" data-v-e2c06596${_scopeId}>${ssrInterpolate(it.node_id)}</div><div style="${ssrRenderStyle({ "display": "flex", "flex-wrap": "wrap", "gap": "6px", "justify-content": "flex-end" })}" data-v-e2c06596${_scopeId}>`);
                _push2(ssrRenderComponent(_component_el_tag, {
                  size: "small",
                  effect: "plain"
                }, {
                  default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(`${ssrInterpolate(formatUpgradeStage(it.stage))}`);
                    } else {
                      return [
                        createTextVNode(toDisplayString(formatUpgradeStage(it.stage)), 1)
                      ];
                    }
                  }),
                  _: 2
                }, _parent2, _scopeId));
                _push2(ssrRenderComponent(_component_el_tag, {
                  size: "small",
                  type: upgradeStatusTagType(it.status)
                }, {
                  default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(`${ssrInterpolate(formatUpgradeStatus(it.status))}`);
                    } else {
                      return [
                        createTextVNode(toDisplayString(formatUpgradeStatus(it.status)), 1)
                      ];
                    }
                  }),
                  _: 2
                }, _parent2, _scopeId));
                _push2(`</div></div><div class="record-card__fields" data-v-e2c06596${_scopeId}><div class="kv-row" data-v-e2c06596${_scopeId}><span class="kv-label" data-v-e2c06596${_scopeId}>版本 / 步骤</span><span class="kv-value" data-v-e2c06596${_scopeId}>${ssrInterpolate(it.result_version || "—")} · ${ssrInterpolate(it.step || "—")}</span></div><div class="kv-row" data-v-e2c06596${_scopeId}><span class="kv-label" data-v-e2c06596${_scopeId}>错误码</span><span class="kv-value" data-v-e2c06596${_scopeId}>${ssrInterpolate(it.error_code || "—")}</span></div><div class="kv-row" data-v-e2c06596${_scopeId}><span class="kv-label" data-v-e2c06596${_scopeId}>信息</span><span class="kv-value" data-v-e2c06596${_scopeId}>${ssrInterpolate(it.message || "—")}</span></div><div class="kv-row" data-v-e2c06596${_scopeId}><span class="kv-label" data-v-e2c06596${_scopeId}>日志摘要</span><span class="kv-value" data-v-e2c06596${_scopeId}>${ssrInterpolate(it.stderr_tail || "—")}</span></div></div></div>`);
              });
              _push2(`<!--]--></div>`);
            } else {
              _push2(`<!---->`);
            }
          } else {
            return [
              createVNode(_component_el_form, {
                model: upgradeForm,
                "label-width": "120px"
              }, {
                default: withCtx(() => [
                  createVNode(_component_el_form_item, {
                    label: "目标版本",
                    required: ""
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: upgradeForm.version,
                        "onUpdate:modelValue": ($event) => upgradeForm.version = $event,
                        placeholder: "如: 0.2.1"
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "架构推荐" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_select, {
                        modelValue: upgradeForm.arch,
                        "onUpdate:modelValue": ($event) => upgradeForm.arch = $event,
                        style: { "width": "100%" },
                        onChange: applyArchCandidate
                      }, {
                        default: withCtx(() => [
                          createVNode(_component_el_option, {
                            label: "amd64",
                            value: "amd64"
                          }),
                          createVNode(_component_el_option, {
                            label: "arm64",
                            value: "arm64"
                          })
                        ]),
                        _: 1
                      }, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, {
                    label: "下载地址",
                    required: ""
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: upgradeForm.download_url,
                        "onUpdate:modelValue": ($event) => upgradeForm.download_url = $event,
                        placeholder: "https://.../vpn-agent-linux-amd64"
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "内网地址" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: upgradeForm.download_url_lan,
                        "onUpdate:modelValue": ($event) => upgradeForm.download_url_lan = $event,
                        placeholder: "http://intranet/.../vpn-agent-linux-amd64 (可选)"
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, {
                    label: "SHA256",
                    required: ""
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: upgradeForm.sha256,
                        "onUpdate:modelValue": ($event) => upgradeForm.sha256 = $event,
                        placeholder: "64 位 sha256"
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "灰度节点" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_select, {
                        modelValue: upgradeForm.canary_node_id,
                        "onUpdate:modelValue": ($event) => upgradeForm.canary_node_id = $event,
                        clearable: "",
                        placeholder: "默认自动选第一个在线节点",
                        style: { "width": "100%" }
                      }, {
                        default: withCtx(() => [
                          (openBlock(true), createBlock(Fragment, null, renderList(onlineNodes.value, (n) => {
                            return openBlock(), createBlock(_component_el_option, {
                              key: n.node.id,
                              label: `${n.node.name} (${n.node.id})`,
                              value: n.node.id
                            }, null, 8, ["label", "value"]);
                          }), 128))
                        ]),
                        _: 1
                      }, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  })
                ]),
                _: 1
              }, 8, ["model"]),
              upgradeTask.value.id ? (openBlock(), createBlock(_component_el_alert, {
                key: 0,
                type: "info",
                closable: false,
                "show-icon": "",
                style: { "margin-bottom": "12px" }
              }, {
                default: withCtx(() => [
                  createTextVNode(" 任务 #" + toDisplayString(upgradeTask.value.id) + " 状态：" + toDisplayString(upgradeTask.value.status) + "，成功 " + toDisplayString(upgradeTask.value.success_count || 0) + "/" + toDisplayString(upgradeTask.value.total_nodes || 0) + "，失败 " + toDisplayString(upgradeTask.value.failed_count || 0), 1)
                ]),
                _: 1
              })) : createCommentVNode("", true),
              upgradeItems.value.length ? (openBlock(), createBlock("div", {
                key: 1,
                class: "dialog-record-stack"
              }, [
                (openBlock(true), createBlock(Fragment, null, renderList(upgradeItems.value, (it, idx) => {
                  return openBlock(), createBlock("div", {
                    key: idx,
                    class: ["record-card", unref(recordCardToneFromTagType)(upgradeStatusTagType(it.status))]
                  }, [
                    createVNode("div", { class: "record-card__head" }, [
                      createVNode("div", { class: "record-card__title mono-text min-w-0" }, toDisplayString(it.node_id), 1),
                      createVNode("div", { style: { "display": "flex", "flex-wrap": "wrap", "gap": "6px", "justify-content": "flex-end" } }, [
                        createVNode(_component_el_tag, {
                          size: "small",
                          effect: "plain"
                        }, {
                          default: withCtx(() => [
                            createTextVNode(toDisplayString(formatUpgradeStage(it.stage)), 1)
                          ]),
                          _: 2
                        }, 1024),
                        createVNode(_component_el_tag, {
                          size: "small",
                          type: upgradeStatusTagType(it.status)
                        }, {
                          default: withCtx(() => [
                            createTextVNode(toDisplayString(formatUpgradeStatus(it.status)), 1)
                          ]),
                          _: 2
                        }, 1032, ["type"])
                      ])
                    ]),
                    createVNode("div", { class: "record-card__fields" }, [
                      createVNode("div", { class: "kv-row" }, [
                        createVNode("span", { class: "kv-label" }, "版本 / 步骤"),
                        createVNode("span", { class: "kv-value" }, toDisplayString(it.result_version || "—") + " · " + toDisplayString(it.step || "—"), 1)
                      ]),
                      createVNode("div", { class: "kv-row" }, [
                        createVNode("span", { class: "kv-label" }, "错误码"),
                        createVNode("span", { class: "kv-value" }, toDisplayString(it.error_code || "—"), 1)
                      ]),
                      createVNode("div", { class: "kv-row" }, [
                        createVNode("span", { class: "kv-label" }, "信息"),
                        createVNode("span", { class: "kv-value" }, toDisplayString(it.message || "—"), 1)
                      ]),
                      createVNode("div", { class: "kv-row" }, [
                        createVNode("span", { class: "kv-label" }, "日志摘要"),
                        createVNode("span", { class: "kv-value" }, toDisplayString(it.stderr_tail || "—"), 1)
                      ])
                    ])
                  ], 2);
                }), 128))
              ])) : createCommentVNode("", true)
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div>`);
    };
  }
};
const _sfc_setup$b = _sfc_main$b.setup;
_sfc_main$b.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/views/Nodes.vue");
  return _sfc_setup$b ? _sfc_setup$b(props, ctx) : void 0;
};
const Nodes = /* @__PURE__ */ _export_sfc(_sfc_main$b, [["__scopeId", "data-v-e2c06596"]]);
const _sfc_main$a = {
  __name: "NodeDetail",
  __ssrInlineRender: true,
  setup(__props) {
    const route = useRoute();
    const nodeId = route.params.id;
    const loading = ref(false);
    const refreshing = ref(false);
    const latestAgentVersion = ref("");
    const node = ref({});
    const instances = ref([]);
    const segments = ref([]);
    const tunnels = ref([]);
    const meshSummary = ref({ note: "", openvpn_instance_subnets: [], wireguard_peer_local_ips: [] });
    const editSubnet = reactive({});
    const editPort = reactive({});
    const editProto = reactive({});
    const editExitNode = reactive({});
    const nodeNameById = ref({});
    const postCreateDeploy = ref(null);
    const editNode = reactive({ name: "", region: "", public_ip: "" });
    const savingNode = ref(false);
    const tunnelDialogVisible = ref(false);
    const tunnelSaving = ref(false);
    const tunnelEditId = ref(null);
    const tunnelForm = reactive({ subnet: "", ip_a: "", ip_b: "", wg_port: 56720 });
    const rotateDeployVisible = ref(false);
    const rotateData = reactive({
      token: "",
      online: "",
      onlineLan: "",
      offline: "",
      offlineLan: "",
      scriptUrl: "",
      scriptUrlLan: "",
      deployUrlWarning: "",
      deployUrlNote: ""
    });
    const enabledInstances = computed(() => (instances.value || []).filter((i) => i.enabled === true));
    const disabledInstances = computed(() => (instances.value || []).filter((i) => i.enabled !== true));
    const modeLabel = (mode) => {
      const m = {
        "node-direct": "节点直连",
        "cn-split": "国内分流",
        global: "全局"
      };
      return m[mode] || mode || "-";
    };
    const modeMeshShort = (mode) => {
      const m = { "node-direct": "直连", "cn-split": "分流", global: "全局" };
      return m[mode] || mode || "—";
    };
    const protoMeshChar = (p) => (p || "udp").toLowerCase() === "tcp" ? "T" : "U";
    const instanceModeUsesExit = (mode) => mode === "node-direct" || mode === "cn-split" || mode === "global";
    const peerTunnelIds = computed(() => {
      const ids = [];
      for (const row of tunnels.value) {
        const pid = row.node_a === nodeId ? row.node_b : row.node_a;
        if (pid) ids.push(pid);
      }
      return [...new Set(ids)].sort();
    });
    const peerTunnelOptionLabel = (pid) => {
      if (!pid) return "—";
      const n = nodeNameById.value[pid];
      if (n && n !== pid) return `${pid} · ${n}`;
      return pid;
    };
    const tunnelPeerLine = (row) => {
      const pid = row.node_a === nodeId ? row.node_b : row.node_a;
      return peerTunnelOptionLabel(pid || "");
    };
    const exitCellLabel = (row) => {
      const e = (row.exit_node || "").trim();
      if (!e) {
        return row.mode === "node-direct" ? "本入口节点出口" : "—";
      }
      return peerTunnelOptionLabel(e);
    };
    const dismissPostCreate = () => {
      postCreateDeploy.value = null;
    };
    const tryConsumePostCreateDeploy = () => {
      const s = window.history.state;
      if (s == null ? void 0 : s.postCreateDeploy) {
        postCreateDeploy.value = { ...s.postCreateDeploy };
        const next = { ...s };
        delete next.postCreateDeploy;
        window.history.replaceState(next, "");
      }
    };
    const segmentName = (id) => {
      var _a;
      if (!id) return "default";
      const x = segments.value.find((s) => {
        var _a2;
        return ((_a2 = s.segment) == null ? void 0 : _a2.id) === id;
      });
      return ((_a = x == null ? void 0 : x.segment) == null ? void 0 : _a.name) ? `${x.segment.name} (${id})` : id;
    };
    const protoUpper = (p) => (p || "udp").toLowerCase() === "tcp" ? "TCP" : "UDP";
    const savedProtoKey = (inst) => (inst.proto || "udp").toLowerCase() === "tcp" ? "tcp" : "udp";
    const instanceListenDirty = (inst) => {
      const ep = editProto[inst.id] === "tcp" ? "tcp" : "udp";
      return ep !== savedProtoKey(inst) || editPort[inst.id] !== inst.port;
    };
    const displayAgentVersion = (v) => {
      const s = String(v || "").trim().replace(/^v/i, "").replace(/-unknown$/i, "");
      return s;
    };
    const parseVersion = (v) => {
      const s = displayAgentVersion(v);
      if (!s) return null;
      const parts = s.split(".").map((x) => Number.parseInt(x, 10));
      if (parts.some((n) => Number.isNaN(n))) return null;
      while (parts.length < 3) parts.push(0);
      return parts.slice(0, 3);
    };
    const compareVersion = (a, b) => {
      const va = parseVersion(a);
      const vb = parseVersion(b);
      if (!va || !vb) return 0;
      for (let i = 0; i < 3; i++) {
        if (va[i] > vb[i]) return 1;
        if (va[i] < vb[i]) return -1;
      }
      return 0;
    };
    const resolveAgentVersionTone = (agentRaw) => {
      const cur = displayAgentVersion(agentRaw);
      if (!cur) return "empty";
      if (!parseVersion(cur)) return "warn";
      const lat = latestAgentVersion.value;
      if (!lat || !parseVersion(lat)) return "warn";
      return compareVersion(cur, lat) >= 0 ? "latest" : "stale";
    };
    const statCards = computed(() => {
      var _a;
      const st = node.value.status;
      const statusLabel = st ? getStatusInfo("node", st).label : "-";
      const agentRaw = String(node.value.agent_version || "").trim();
      const agentDisplay = agentRaw ? displayAgentVersion(agentRaw) : "—";
      return [
        {
          key: "latest-status",
          statusLabel,
          rawStatus: st || "",
          agentDisplay,
          agentVersionTone: resolveAgentVersionTone(agentRaw),
          onlineUsers: node.value.online_users,
          icon: "CircleCheck",
          color: "primary"
        },
        { key: "number", label: "节点号", value: node.value.node_number || "-", icon: "Coin", color: "warning" },
        {
          key: "tunnels",
          label: "相关隧道",
          value: ((_a = tunnels.value) == null ? void 0 : _a.length) ?? 0,
          icon: "Connection",
          color: "info"
        }
      ];
    });
    const load = async ({ refresh = false } = {}) => {
      var _a, _b, _c, _d;
      if (refresh) refreshing.value = true;
      else loading.value = true;
      try {
        const upgradeReq = http.get("/api/nodes/upgrade-status", {
          validateStatus: (s) => s >= 200 && s < 300 || s === 404
        }).catch(() => ({ status: 404, data: {} }));
        const [nodeRes, statusRes, nodesRes, upgradeRes] = await Promise.all([
          http.get(`/api/nodes/${nodeId}`),
          http.get(`/api/nodes/${nodeId}/status`),
          http.get("/api/nodes"),
          upgradeReq
        ]);
        if (upgradeRes.status !== 404 && ((_a = upgradeRes.data) == null ? void 0 : _a.latest_version)) {
          latestAgentVersion.value = displayAgentVersion(upgradeRes.data.latest_version);
        } else {
          latestAgentVersion.value = "";
        }
        node.value = nodeRes.data.node || {};
        instances.value = nodeRes.data.instances || [];
        segments.value = nodeRes.data.segments || [];
        meshSummary.value = nodeRes.data.mesh_summary || {
          note: "",
          openvpn_instance_subnets: [],
          wireguard_peer_local_ips: []
        };
        tunnels.value = statusRes.data.tunnels || [];
        node.value.online_users = statusRes.data.online_users;
        if (((_b = statusRes.data) == null ? void 0 : _b.agent_version) !== void 0 && ((_c = statusRes.data) == null ? void 0 : _c.agent_version) !== null) {
          node.value.agent_version = statusRes.data.agent_version;
        }
        const m = {};
        for (const it of nodesRes.data.items || []) {
          if ((_d = it.node) == null ? void 0 : _d.id) m[it.node.id] = it.node.name || "";
        }
        nodeNameById.value = m;
        editNode.name = node.value.name || "";
        editNode.region = node.value.region || "";
        editNode.public_ip = node.value.public_ip || "";
        for (const inst of instances.value) {
          editSubnet[inst.id] = inst.subnet || "";
          editPort[inst.id] = inst.port;
          editProto[inst.id] = inst.proto === "tcp" ? "tcp" : "udp";
          editExitNode[inst.id] = (inst.exit_node || "").trim();
        }
      } finally {
        if (refresh) refreshing.value = false;
        else loading.value = false;
      }
    };
    const toggleInstance = async (inst) => {
      try {
        await http.patch(`/api/instances/${inst.id}`, { enabled: !inst.enabled });
        inst.enabled = !inst.enabled;
        ElMessage.success("已更新");
        await load();
      } catch {
      }
    };
    const saveNodeMeta = async () => {
      savingNode.value = true;
      try {
        const res = await http.patch(`/api/nodes/${nodeId}`, {
          name: editNode.name,
          region: editNode.region,
          public_ip: editNode.public_ip
        });
        node.value = res.data.node || node.value;
        ElMessage.success("基本信息已保存");
      } catch {
      } finally {
        savingNode.value = false;
      }
    };
    const rotateBootstrap = async () => {
      try {
        await ElMessageBox.confirm(
          "将作废当前 Bootstrap 令牌并签发新令牌；已用旧令牌完成首次注册的节点不受影响，重装须使用新命令。",
          "重新生成部署令牌",
          { type: "warning", confirmButtonText: "确定换发" }
        );
      } catch {
        return;
      }
      try {
        const res = await http.post(`/api/nodes/${nodeId}/rotate-bootstrap-token`);
        rotateData.token = res.data.bootstrap_token || "";
        rotateData.online = res.data.deploy_command || "";
        rotateData.onlineLan = res.data.deploy_command_lan || "";
        rotateData.offline = res.data.deploy_offline || "";
        rotateData.offlineLan = res.data.deploy_offline_lan || "";
        rotateData.scriptUrl = res.data.script_url || "";
        rotateData.scriptUrlLan = res.data.script_url_lan || "";
        rotateData.deployUrlWarning = res.data.deploy_url_warning || "";
        rotateData.deployUrlNote = res.data.deploy_url_note || "";
        rotateDeployVisible.value = true;
        ElMessage.success("已换发新令牌");
      } catch {
      }
    };
    const copyTextExecCommand = (t) => {
      const ta = document.createElement("textarea");
      ta.value = t;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      } finally {
        document.body.removeChild(ta);
      }
      return ok;
    };
    const copyText = async (t) => {
      var _a;
      if (!t) return;
      try {
        if ((_a = navigator == null ? void 0 : navigator.clipboard) == null ? void 0 : _a.writeText) {
          await navigator.clipboard.writeText(t);
          ElMessage.success("已复制");
          return;
        }
      } catch {
      }
      if (copyTextExecCommand(t)) {
        ElMessage.success("已复制");
        return;
      }
      ElMessage.error("复制失败");
    };
    const openTunnelEdit = (row) => {
      tunnelEditId.value = row.id;
      tunnelForm.subnet = row.subnet || "";
      tunnelForm.ip_a = row.ip_a || "";
      tunnelForm.ip_b = row.ip_b || "";
      tunnelForm.wg_port = row.wg_port || 56720;
      tunnelDialogVisible.value = true;
    };
    const saveTunnelEdit = async () => {
      tunnelSaving.value = true;
      try {
        await http.patch(`/api/tunnels/${tunnelEditId.value}`, {
          subnet: tunnelForm.subnet,
          ip_a: tunnelForm.ip_a,
          ip_b: tunnelForm.ip_b,
          wg_port: tunnelForm.wg_port
        });
        ElMessage.success("隧道已更新");
        tunnelDialogVisible.value = false;
        await load();
      } catch {
      } finally {
        tunnelSaving.value = false;
      }
    };
    const saveInstancePatch = async (inst) => {
      const subnet = (editSubnet[inst.id] ?? "").trim();
      const port = editPort[inst.id];
      const proto = editProto[inst.id] === "tcp" ? "tcp" : "udp";
      const curExit = (inst.exit_node || "").trim();
      const newExit = String(editExitNode[inst.id] ?? "").trim();
      const body = {};
      if (subnet) body.subnet = subnet;
      if (typeof port === "number" && port > 0) body.port = port;
      if (proto !== (inst.proto || "udp")) body.proto = proto;
      if (instanceModeUsesExit(inst.mode) && newExit !== curExit) {
        body.exit_node = newExit;
      }
      if (!Object.keys(body).length) {
        ElMessage.warning("请修改子网、端口、UDP/TCP 或出口节点后再保存");
        return;
      }
      try {
        const protoChanged = Object.prototype.hasOwnProperty.call(body, "proto");
        const exitChanged = Object.prototype.hasOwnProperty.call(body, "exit_node");
        await http.patch(`/api/instances/${inst.id}`, body);
        if (protoChanged) {
          ElMessage.success({
            message: "已保存。已有用户授权需在「用户 → 授权」中点击「重试签发」并重新下载 .ovpn，客户端首部 proto 才会与实例一致。",
            duration: 8e3,
            showClose: true
          });
        } else if (exitChanged) {
          ElMessage.success({
            message: "已保存。请在目标节点重新执行策略路由步骤（或重装/同步 Agent 配置）后，/etc/vpn-agent/policy-routing.sh 才会使用新的出口。",
            duration: 8e3,
            showClose: true
          });
        } else {
          ElMessage.success("已保存");
        }
        await load();
      } catch {
      }
    };
    onMounted(() => {
      tryConsumePostCreateDeploy();
      load();
    });
    return (_ctx, _push, _parent, _attrs) => {
      var _a, _b, _c, _d;
      const _component_el_page_header = resolveComponent("el-page-header");
      const _component_el_tag = resolveComponent("el-tag");
      const _component_el_button = resolveComponent("el-button");
      const _component_el_icon = resolveComponent("el-icon");
      const _component_Refresh = resolveComponent("Refresh");
      const _component_el_alert = resolveComponent("el-alert");
      const _component_el_text = resolveComponent("el-text");
      const _component_el_input = resolveComponent("el-input");
      const _component_el_link = resolveComponent("el-link");
      const _component_el_row = resolveComponent("el-row");
      const _component_el_col = resolveComponent("el-col");
      const _component_el_tooltip = resolveComponent("el-tooltip");
      const _component_DocumentCopy = resolveComponent("DocumentCopy");
      const _component_InfoFilled = resolveComponent("InfoFilled");
      const _component_el_divider = resolveComponent("el-divider");
      const _component_el_form = resolveComponent("el-form");
      const _component_el_form_item = resolveComponent("el-form-item");
      const _component_el_collapse = resolveComponent("el-collapse");
      const _component_el_collapse_item = resolveComponent("el-collapse-item");
      const _component_el_switch = resolveComponent("el-switch");
      const _component_el_select = resolveComponent("el-select");
      const _component_el_option = resolveComponent("el-option");
      const _component_el_input_number = resolveComponent("el-input-number");
      const _component_el_empty = resolveComponent("el-empty");
      const _component_el_dialog = resolveComponent("el-dialog");
      const _component_el_tabs = resolveComponent("el-tabs");
      const _component_el_tab_pane = resolveComponent("el-tab-pane");
      const _directive_loading = resolveDirective("loading");
      _push(`<div${ssrRenderAttrs(mergeProps(_attrs, ssrGetDirectiveProps(_ctx, _directive_loading, loading.value)))} data-v-4dd96569>`);
      _push(ssrRenderComponent(_component_el_page_header, {
        onBack: ($event) => _ctx.$router.push("/nodes"),
        class: "node-page-header"
      }, {
        content: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`<div class="detail-header-row" data-v-4dd96569${_scopeId}><div class="detail-header-main" data-v-4dd96569${_scopeId}><span class="detail-header-name" data-v-4dd96569${_scopeId}>${ssrInterpolate(node.value.name || unref(nodeId))}</span>`);
            if (node.value.node_number != null && node.value.node_number !== "") {
              _push2(`<span class="detail-header-node-num" data-v-4dd96569${_scopeId}> · ${ssrInterpolate(node.value.node_number)}</span>`);
            } else {
              _push2(`<!---->`);
            }
            if (node.value.status) {
              _push2(ssrRenderComponent(_component_el_tag, {
                type: unref(getStatusInfo)("node", node.value.status).type,
                size: "small",
                class: "detail-header-tag"
              }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(`${ssrInterpolate(unref(getStatusInfo)("node", node.value.status).label)}`);
                  } else {
                    return [
                      createTextVNode(toDisplayString(unref(getStatusInfo)("node", node.value.status).label), 1)
                    ];
                  }
                }),
                _: 1
              }, _parent2, _scopeId));
            } else {
              _push2(`<!---->`);
            }
            _push2(`</div>`);
            _push2(ssrRenderComponent(_component_el_button, {
              type: "primary",
              plain: "",
              size: "small",
              loading: refreshing.value,
              class: "detail-header-refresh",
              onClick: ($event) => load({ refresh: true })
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_icon, null, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_Refresh, null, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_Refresh)
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(` 刷新状态 `);
                } else {
                  return [
                    createVNode(_component_el_icon, null, {
                      default: withCtx(() => [
                        createVNode(_component_Refresh)
                      ]),
                      _: 1
                    }),
                    createTextVNode(" 刷新状态 ")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(`</div>`);
          } else {
            return [
              createVNode("div", { class: "detail-header-row" }, [
                createVNode("div", { class: "detail-header-main" }, [
                  createVNode("span", { class: "detail-header-name" }, toDisplayString(node.value.name || unref(nodeId)), 1),
                  node.value.node_number != null && node.value.node_number !== "" ? (openBlock(), createBlock("span", {
                    key: 0,
                    class: "detail-header-node-num"
                  }, " · " + toDisplayString(node.value.node_number), 1)) : createCommentVNode("", true),
                  node.value.status ? (openBlock(), createBlock(_component_el_tag, {
                    key: 1,
                    type: unref(getStatusInfo)("node", node.value.status).type,
                    size: "small",
                    class: "detail-header-tag"
                  }, {
                    default: withCtx(() => [
                      createTextVNode(toDisplayString(unref(getStatusInfo)("node", node.value.status).label), 1)
                    ]),
                    _: 1
                  }, 8, ["type"])) : createCommentVNode("", true)
                ]),
                createVNode(_component_el_button, {
                  type: "primary",
                  plain: "",
                  size: "small",
                  loading: refreshing.value,
                  class: "detail-header-refresh",
                  onClick: ($event) => load({ refresh: true })
                }, {
                  default: withCtx(() => [
                    createVNode(_component_el_icon, null, {
                      default: withCtx(() => [
                        createVNode(_component_Refresh)
                      ]),
                      _: 1
                    }),
                    createTextVNode(" 刷新状态 ")
                  ]),
                  _: 1
                }, 8, ["loading", "onClick"])
              ])
            ];
          }
        }),
        _: 1
      }, _parent));
      if (postCreateDeploy.value) {
        _push(ssrRenderComponent(_component_el_alert, {
          type: "success",
          "show-icon": "",
          closable: "",
          class: "mb-md",
          onClose: dismissPostCreate
        }, {
          title: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`新节点已创建：请先配置「相关隧道」与分流出口，再在目标机执行部署`);
            } else {
              return [
                createTextVNode("新节点已创建：请先配置「相关隧道」与分流出口，再在目标机执行部署")
              ];
            }
          }),
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`<div class="post-create-deploy" data-v-4dd96569${_scopeId}><div data-v-4dd96569${_scopeId}>Bootstrap Token: <code data-v-4dd96569${_scopeId}>${ssrInterpolate(postCreateDeploy.value.token)}</code></div>`);
              _push2(ssrRenderComponent(_component_el_text, {
                type: "info",
                size: "small",
                style: { "display": "block", "margin-top": "6px" }
              }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(`在线部署（公网）`);
                  } else {
                    return [
                      createTextVNode("在线部署（公网）")
                    ];
                  }
                }),
                _: 1
              }, _parent2, _scopeId));
              _push2(ssrRenderComponent(_component_el_input, {
                type: "textarea",
                rows: 2,
                "model-value": postCreateDeploy.value.online,
                readonly: ""
              }, null, _parent2, _scopeId));
              _push2(ssrRenderComponent(_component_el_button, {
                size: "small",
                class: "mt-sm",
                onClick: ($event) => copyText(postCreateDeploy.value.online)
              }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(`复制命令`);
                  } else {
                    return [
                      createTextVNode("复制命令")
                    ];
                  }
                }),
                _: 1
              }, _parent2, _scopeId));
              if (postCreateDeploy.value.offline) {
                _push2(`<!--[-->`);
                _push2(ssrRenderComponent(_component_el_text, {
                  type: "info",
                  size: "small",
                  style: { "display": "block", "margin-top": "8px" }
                }, {
                  default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(`离网部署（公网）`);
                    } else {
                      return [
                        createTextVNode("离网部署（公网）")
                      ];
                    }
                  }),
                  _: 1
                }, _parent2, _scopeId));
                _push2(ssrRenderComponent(_component_el_input, {
                  type: "textarea",
                  rows: 2,
                  "model-value": postCreateDeploy.value.offline,
                  readonly: ""
                }, null, _parent2, _scopeId));
                _push2(ssrRenderComponent(_component_el_button, {
                  size: "small",
                  class: "mt-sm",
                  onClick: ($event) => copyText(postCreateDeploy.value.offline)
                }, {
                  default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(`复制离网命令`);
                    } else {
                      return [
                        createTextVNode("复制离网命令")
                      ];
                    }
                  }),
                  _: 1
                }, _parent2, _scopeId));
                if (postCreateDeploy.value.scriptUrl) {
                  _push2(ssrRenderComponent(_component_el_text, {
                    type: "info",
                    size: "small",
                    style: { "display": "block", "margin-top": "4px" }
                  }, {
                    default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                      if (_push3) {
                        _push3(` 或下载脚本：`);
                        _push3(ssrRenderComponent(_component_el_link, {
                          href: postCreateDeploy.value.scriptUrl,
                          target: "_blank",
                          type: "primary"
                        }, {
                          default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                            if (_push4) {
                              _push4(`node-setup.sh`);
                            } else {
                              return [
                                createTextVNode("node-setup.sh")
                              ];
                            }
                          }),
                          _: 1
                        }, _parent3, _scopeId2));
                      } else {
                        return [
                          createTextVNode(" 或下载脚本："),
                          createVNode(_component_el_link, {
                            href: postCreateDeploy.value.scriptUrl,
                            target: "_blank",
                            type: "primary"
                          }, {
                            default: withCtx(() => [
                              createTextVNode("node-setup.sh")
                            ]),
                            _: 1
                          }, 8, ["href"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent2, _scopeId));
                } else {
                  _push2(`<!---->`);
                }
                _push2(`<!--]-->`);
              } else {
                _push2(`<!---->`);
              }
              if (postCreateDeploy.value.onlineLan) {
                _push2(`<!--[-->`);
                _push2(ssrRenderComponent(_component_el_text, {
                  type: "info",
                  size: "small",
                  style: { "display": "block", "margin-top": "8px" }
                }, {
                  default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(`在线部署（内网）`);
                    } else {
                      return [
                        createTextVNode("在线部署（内网）")
                      ];
                    }
                  }),
                  _: 1
                }, _parent2, _scopeId));
                _push2(ssrRenderComponent(_component_el_input, {
                  type: "textarea",
                  rows: 2,
                  "model-value": postCreateDeploy.value.onlineLan,
                  readonly: ""
                }, null, _parent2, _scopeId));
                _push2(ssrRenderComponent(_component_el_button, {
                  size: "small",
                  class: "mt-sm",
                  onClick: ($event) => copyText(postCreateDeploy.value.onlineLan)
                }, {
                  default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(`复制内网命令`);
                    } else {
                      return [
                        createTextVNode("复制内网命令")
                      ];
                    }
                  }),
                  _: 1
                }, _parent2, _scopeId));
                _push2(`<!--]-->`);
              } else {
                _push2(`<!---->`);
              }
              if (postCreateDeploy.value.deployUrlWarning) {
                _push2(ssrRenderComponent(_component_el_alert, {
                  type: "warning",
                  closable: false,
                  "show-icon": "",
                  style: { "margin-top": "10px" }
                }, {
                  default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(`${ssrInterpolate(postCreateDeploy.value.deployUrlWarning)}`);
                    } else {
                      return [
                        createTextVNode(toDisplayString(postCreateDeploy.value.deployUrlWarning), 1)
                      ];
                    }
                  }),
                  _: 1
                }, _parent2, _scopeId));
              } else {
                _push2(`<!---->`);
              }
              if (postCreateDeploy.value.deployUrlNote) {
                _push2(ssrRenderComponent(_component_el_text, {
                  type: "info",
                  size: "small",
                  style: { "display": "block", "margin-top": "8px" }
                }, {
                  default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(`${ssrInterpolate(postCreateDeploy.value.deployUrlNote)}`);
                    } else {
                      return [
                        createTextVNode(toDisplayString(postCreateDeploy.value.deployUrlNote), 1)
                      ];
                    }
                  }),
                  _: 1
                }, _parent2, _scopeId));
              } else {
                _push2(`<!---->`);
              }
              _push2(`</div>`);
            } else {
              return [
                createVNode("div", { class: "post-create-deploy" }, [
                  createVNode("div", null, [
                    createTextVNode("Bootstrap Token: "),
                    createVNode("code", null, toDisplayString(postCreateDeploy.value.token), 1)
                  ]),
                  createVNode(_component_el_text, {
                    type: "info",
                    size: "small",
                    style: { "display": "block", "margin-top": "6px" }
                  }, {
                    default: withCtx(() => [
                      createTextVNode("在线部署（公网）")
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_input, {
                    type: "textarea",
                    rows: 2,
                    "model-value": postCreateDeploy.value.online,
                    readonly: ""
                  }, null, 8, ["model-value"]),
                  createVNode(_component_el_button, {
                    size: "small",
                    class: "mt-sm",
                    onClick: ($event) => copyText(postCreateDeploy.value.online)
                  }, {
                    default: withCtx(() => [
                      createTextVNode("复制命令")
                    ]),
                    _: 1
                  }, 8, ["onClick"]),
                  postCreateDeploy.value.offline ? (openBlock(), createBlock(Fragment, { key: 0 }, [
                    createVNode(_component_el_text, {
                      type: "info",
                      size: "small",
                      style: { "display": "block", "margin-top": "8px" }
                    }, {
                      default: withCtx(() => [
                        createTextVNode("离网部署（公网）")
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_input, {
                      type: "textarea",
                      rows: 2,
                      "model-value": postCreateDeploy.value.offline,
                      readonly: ""
                    }, null, 8, ["model-value"]),
                    createVNode(_component_el_button, {
                      size: "small",
                      class: "mt-sm",
                      onClick: ($event) => copyText(postCreateDeploy.value.offline)
                    }, {
                      default: withCtx(() => [
                        createTextVNode("复制离网命令")
                      ]),
                      _: 1
                    }, 8, ["onClick"]),
                    postCreateDeploy.value.scriptUrl ? (openBlock(), createBlock(_component_el_text, {
                      key: 0,
                      type: "info",
                      size: "small",
                      style: { "display": "block", "margin-top": "4px" }
                    }, {
                      default: withCtx(() => [
                        createTextVNode(" 或下载脚本："),
                        createVNode(_component_el_link, {
                          href: postCreateDeploy.value.scriptUrl,
                          target: "_blank",
                          type: "primary"
                        }, {
                          default: withCtx(() => [
                            createTextVNode("node-setup.sh")
                          ]),
                          _: 1
                        }, 8, ["href"])
                      ]),
                      _: 1
                    })) : createCommentVNode("", true)
                  ], 64)) : createCommentVNode("", true),
                  postCreateDeploy.value.onlineLan ? (openBlock(), createBlock(Fragment, { key: 1 }, [
                    createVNode(_component_el_text, {
                      type: "info",
                      size: "small",
                      style: { "display": "block", "margin-top": "8px" }
                    }, {
                      default: withCtx(() => [
                        createTextVNode("在线部署（内网）")
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_input, {
                      type: "textarea",
                      rows: 2,
                      "model-value": postCreateDeploy.value.onlineLan,
                      readonly: ""
                    }, null, 8, ["model-value"]),
                    createVNode(_component_el_button, {
                      size: "small",
                      class: "mt-sm",
                      onClick: ($event) => copyText(postCreateDeploy.value.onlineLan)
                    }, {
                      default: withCtx(() => [
                        createTextVNode("复制内网命令")
                      ]),
                      _: 1
                    }, 8, ["onClick"])
                  ], 64)) : createCommentVNode("", true),
                  postCreateDeploy.value.deployUrlWarning ? (openBlock(), createBlock(_component_el_alert, {
                    key: 2,
                    type: "warning",
                    closable: false,
                    "show-icon": "",
                    style: { "margin-top": "10px" }
                  }, {
                    default: withCtx(() => [
                      createTextVNode(toDisplayString(postCreateDeploy.value.deployUrlWarning), 1)
                    ]),
                    _: 1
                  })) : createCommentVNode("", true),
                  postCreateDeploy.value.deployUrlNote ? (openBlock(), createBlock(_component_el_text, {
                    key: 3,
                    type: "info",
                    size: "small",
                    style: { "display": "block", "margin-top": "8px" }
                  }, {
                    default: withCtx(() => [
                      createTextVNode(toDisplayString(postCreateDeploy.value.deployUrlNote), 1)
                    ]),
                    _: 1
                  })) : createCommentVNode("", true)
                ])
              ];
            }
          }),
          _: 1
        }, _parent));
      } else {
        _push(`<!---->`);
      }
      _push(`<section class="node-overview mb-lg" data-v-4dd96569><div class="node-overview__head" data-v-4dd96569><span class="node-overview__title" data-v-4dd96569>运行概况</span>`);
      _push(ssrRenderComponent(_component_el_text, {
        type: "info",
        size: "small",
        class: "node-overview__hint"
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(` 状态后为在线人数；版本号绿色为已跟上参考、红色为建议升级、橙色为无法比对；隧道数来自当前列表 `);
          } else {
            return [
              createTextVNode(" 状态后为在线人数；版本号绿色为已跟上参考、红色为建议升级、橙色为无法比对；隧道数来自当前列表 ")
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div>`);
      _push(ssrRenderComponent(_component_el_row, { gutter: 16 }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`<!--[-->`);
            ssrRenderList(statCards.value, (item) => {
              _push2(ssrRenderComponent(_component_el_col, {
                key: item.key,
                xs: 24,
                sm: 12,
                lg: 8,
                class: "overview-col"
              }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(`<div class="stat-card" data-v-4dd96569${_scopeId2}><div class="${ssrRenderClass([`stat-icon--${item.color}`, "stat-icon"])}" data-v-4dd96569${_scopeId2}>`);
                    _push3(ssrRenderComponent(_component_el_icon, { size: 24 }, {
                      default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                        if (_push4) {
                          ssrRenderVNode(_push4, createVNode(resolveDynamicComponent(item.icon), null, null), _parent4, _scopeId3);
                        } else {
                          return [
                            (openBlock(), createBlock(resolveDynamicComponent(item.icon)))
                          ];
                        }
                      }),
                      _: 2
                    }, _parent3, _scopeId2));
                    _push3(`</div><div class="stat-content" data-v-4dd96569${_scopeId2}>`);
                    if (item.key === "latest-status") {
                      _push3(`<div class="stat-latest" data-v-4dd96569${_scopeId2}><div class="stat-value stat-value--latest" data-v-4dd96569${_scopeId2}>`);
                      if (item.rawStatus) {
                        _push3(ssrRenderComponent(_component_el_tooltip, {
                          content: `原始状态: ${item.rawStatus}`,
                          placement: "top"
                        }, {
                          default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                            if (_push4) {
                              _push4(`<span class="stat-value-text" data-v-4dd96569${_scopeId3}>${ssrInterpolate(item.statusLabel)}</span>`);
                            } else {
                              return [
                                createVNode("span", { class: "stat-value-text" }, toDisplayString(item.statusLabel), 1)
                              ];
                            }
                          }),
                          _: 2
                        }, _parent3, _scopeId2));
                      } else {
                        _push3(`<span class="stat-value-text" data-v-4dd96569${_scopeId2}>${ssrInterpolate(item.statusLabel)}</span>`);
                      }
                      _push3(`<span class="stat-inline-online-num" data-v-4dd96569${_scopeId2}>${ssrInterpolate(item.onlineUsers != null ? item.onlineUsers : "—")}</span></div><div class="${ssrRenderClass([`stat-agent-version-display--${item.agentVersionTone}`, "stat-agent-version-display"])}" data-v-4dd96569${_scopeId2}> 版本：${ssrInterpolate(item.agentDisplay)}</div></div>`);
                    } else {
                      _push3(`<div class="stat-value stat-value--overview-num" data-v-4dd96569${_scopeId2}><span class="stat-value-text" data-v-4dd96569${_scopeId2}>${ssrInterpolate(item.value)}</span></div>`);
                    }
                    if (item.label) {
                      _push3(`<div class="stat-label stat-label--overview" data-v-4dd96569${_scopeId2}>${ssrInterpolate(item.label)}</div>`);
                    } else {
                      _push3(`<!---->`);
                    }
                    _push3(`</div></div>`);
                  } else {
                    return [
                      createVNode("div", { class: "stat-card" }, [
                        createVNode("div", {
                          class: ["stat-icon", `stat-icon--${item.color}`]
                        }, [
                          createVNode(_component_el_icon, { size: 24 }, {
                            default: withCtx(() => [
                              (openBlock(), createBlock(resolveDynamicComponent(item.icon)))
                            ]),
                            _: 2
                          }, 1024)
                        ], 2),
                        createVNode("div", { class: "stat-content" }, [
                          item.key === "latest-status" ? (openBlock(), createBlock("div", {
                            key: 0,
                            class: "stat-latest"
                          }, [
                            createVNode("div", { class: "stat-value stat-value--latest" }, [
                              item.rawStatus ? (openBlock(), createBlock(_component_el_tooltip, {
                                key: 0,
                                content: `原始状态: ${item.rawStatus}`,
                                placement: "top"
                              }, {
                                default: withCtx(() => [
                                  createVNode("span", { class: "stat-value-text" }, toDisplayString(item.statusLabel), 1)
                                ]),
                                _: 2
                              }, 1032, ["content"])) : (openBlock(), createBlock("span", {
                                key: 1,
                                class: "stat-value-text"
                              }, toDisplayString(item.statusLabel), 1)),
                              createVNode("span", { class: "stat-inline-online-num" }, toDisplayString(item.onlineUsers != null ? item.onlineUsers : "—"), 1)
                            ]),
                            createVNode("div", {
                              class: ["stat-agent-version-display", `stat-agent-version-display--${item.agentVersionTone}`]
                            }, " 版本：" + toDisplayString(item.agentDisplay), 3)
                          ])) : (openBlock(), createBlock("div", {
                            key: 1,
                            class: "stat-value stat-value--overview-num"
                          }, [
                            createVNode("span", { class: "stat-value-text" }, toDisplayString(item.value), 1)
                          ])),
                          item.label ? (openBlock(), createBlock("div", {
                            key: 2,
                            class: "stat-label stat-label--overview"
                          }, toDisplayString(item.label), 1)) : createCommentVNode("", true)
                        ])
                      ])
                    ];
                  }
                }),
                _: 2
              }, _parent2, _scopeId));
            });
            _push2(`<!--]-->`);
          } else {
            return [
              (openBlock(true), createBlock(Fragment, null, renderList(statCards.value, (item) => {
                return openBlock(), createBlock(_component_el_col, {
                  key: item.key,
                  xs: 24,
                  sm: 12,
                  lg: 8,
                  class: "overview-col"
                }, {
                  default: withCtx(() => [
                    createVNode("div", { class: "stat-card" }, [
                      createVNode("div", {
                        class: ["stat-icon", `stat-icon--${item.color}`]
                      }, [
                        createVNode(_component_el_icon, { size: 24 }, {
                          default: withCtx(() => [
                            (openBlock(), createBlock(resolveDynamicComponent(item.icon)))
                          ]),
                          _: 2
                        }, 1024)
                      ], 2),
                      createVNode("div", { class: "stat-content" }, [
                        item.key === "latest-status" ? (openBlock(), createBlock("div", {
                          key: 0,
                          class: "stat-latest"
                        }, [
                          createVNode("div", { class: "stat-value stat-value--latest" }, [
                            item.rawStatus ? (openBlock(), createBlock(_component_el_tooltip, {
                              key: 0,
                              content: `原始状态: ${item.rawStatus}`,
                              placement: "top"
                            }, {
                              default: withCtx(() => [
                                createVNode("span", { class: "stat-value-text" }, toDisplayString(item.statusLabel), 1)
                              ]),
                              _: 2
                            }, 1032, ["content"])) : (openBlock(), createBlock("span", {
                              key: 1,
                              class: "stat-value-text"
                            }, toDisplayString(item.statusLabel), 1)),
                            createVNode("span", { class: "stat-inline-online-num" }, toDisplayString(item.onlineUsers != null ? item.onlineUsers : "—"), 1)
                          ]),
                          createVNode("div", {
                            class: ["stat-agent-version-display", `stat-agent-version-display--${item.agentVersionTone}`]
                          }, " 版本：" + toDisplayString(item.agentDisplay), 3)
                        ])) : (openBlock(), createBlock("div", {
                          key: 1,
                          class: "stat-value stat-value--overview-num"
                        }, [
                          createVNode("span", { class: "stat-value-text" }, toDisplayString(item.value), 1)
                        ])),
                        item.label ? (openBlock(), createBlock("div", {
                          key: 2,
                          class: "stat-label stat-label--overview"
                        }, toDisplayString(item.label), 1)) : createCommentVNode("", true)
                      ])
                    ])
                  ]),
                  _: 2
                }, 1024);
              }), 128))
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</section><div class="page-card mb-md" data-v-4dd96569><div class="page-card-header" data-v-4dd96569><span class="page-card-title" data-v-4dd96569>基本信息</span><div class="header-actions" data-v-4dd96569>`);
      _push(ssrRenderComponent(_component_el_button, {
        type: "warning",
        plain: "",
        size: "small",
        onClick: rotateBootstrap
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(` 重新生成部署令牌 `);
          } else {
            return [
              createTextVNode(" 重新生成部署令牌 ")
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(ssrRenderComponent(_component_el_button, {
        type: "primary",
        size: "small",
        loading: savingNode.value,
        onClick: saveNodeMeta
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`保存`);
          } else {
            return [
              createTextVNode("保存")
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div></div><div class="node-readonly-block" data-v-4dd96569><div class="node-subsection-label" data-v-4dd96569>节点标识与只读信息</div><div class="node-readonly-strip" data-v-4dd96569><div class="node-kv" data-v-4dd96569><span class="node-kv-label" data-v-4dd96569>节点 ID</span><span class="node-kv-val mono-text" data-v-4dd96569>${ssrInterpolate(node.value.id || "—")}</span></div><div class="node-kv" data-v-4dd96569><span class="node-kv-label" data-v-4dd96569>组网网段</span><span class="node-kv-val node-kv-val--tags" data-v-4dd96569>`);
      if (segments.value.length) {
        _push(`<!--[-->`);
        ssrRenderList(segments.value, (s, i) => {
          _push(ssrRenderComponent(_component_el_tag, {
            key: i,
            size: "small",
            class: "segment-tag",
            effect: "plain"
          }, {
            default: withCtx((_, _push2, _parent2, _scopeId) => {
              var _a2, _b2, _c2, _d2;
              if (_push2) {
                _push2(`${ssrInterpolate(((_a2 = s.segment) == null ? void 0 : _a2.name) || ((_b2 = s.segment) == null ? void 0 : _b2.id))} (槽 ${ssrInterpolate(s.slot)}) `);
              } else {
                return [
                  createTextVNode(toDisplayString(((_c2 = s.segment) == null ? void 0 : _c2.name) || ((_d2 = s.segment) == null ? void 0 : _d2.id)) + " (槽 " + toDisplayString(s.slot) + ") ", 1)
                ];
              }
            }),
            _: 2
          }, _parent));
        });
        _push(`<!--]-->`);
      } else {
        _push(ssrRenderComponent(_component_el_text, {
          type: "info",
          size: "small"
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`未绑定`);
            } else {
              return [
                createTextVNode("未绑定")
              ];
            }
          }),
          _: 1
        }, _parent));
      }
      _push(`</span></div><div class="node-kv" data-v-4dd96569><span class="node-kv-label" data-v-4dd96569>IP 库版本</span><span class="node-kv-val" data-v-4dd96569>${ssrInterpolate(node.value.ip_list_version || "未更新")}</span></div></div><div class="node-kv-wg" data-v-4dd96569><span class="node-kv-label" data-v-4dd96569>WG 公钥</span><span class="wg-key-inline" data-v-4dd96569><span class="mono-text wg-key-text" data-v-4dd96569>${ssrInterpolate(node.value.wg_public_key || "未上报")}</span>`);
      if (node.value.wg_public_key) {
        _push(ssrRenderComponent(_component_el_button, {
          link: "",
          type: "primary",
          size: "small",
          class: "wg-key-copy",
          onClick: ($event) => copyText(node.value.wg_public_key)
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(ssrRenderComponent(_component_el_icon, null, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(ssrRenderComponent(_component_DocumentCopy, null, null, _parent3, _scopeId2));
                  } else {
                    return [
                      createVNode(_component_DocumentCopy)
                    ];
                  }
                }),
                _: 1
              }, _parent2, _scopeId));
              _push2(` 复制 `);
            } else {
              return [
                createVNode(_component_el_icon, null, {
                  default: withCtx(() => [
                    createVNode(_component_DocumentCopy)
                  ]),
                  _: 1
                }),
                createTextVNode(" 复制 ")
              ];
            }
          }),
          _: 1
        }, _parent));
      } else {
        _push(`<!---->`);
      }
      _push(`</span></div></div>`);
      if (meshSummary.value.note) {
        _push(`<div class="mesh-note-panel" data-v-4dd96569>`);
        _push(ssrRenderComponent(_component_el_icon, { class: "mesh-note-panel__icon" }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(ssrRenderComponent(_component_InfoFilled, null, null, _parent2, _scopeId));
            } else {
              return [
                createVNode(_component_InfoFilled)
              ];
            }
          }),
          _: 1
        }, _parent));
        _push(`<p class="mesh-note-panel__text" data-v-4dd96569>${ssrInterpolate(meshSummary.value.note)}</p></div>`);
      } else {
        _push(`<!---->`);
      }
      if (((_a = meshSummary.value.openvpn_instance_subnets) == null ? void 0 : _a.length) || ((_b = meshSummary.value.wireguard_peer_local_ips) == null ? void 0 : _b.length)) {
        _push(`<div class="mesh-summary-block" data-v-4dd96569>`);
        if ((_c = meshSummary.value.openvpn_instance_subnets) == null ? void 0 : _c.length) {
          _push(`<div class="mesh-summary-section" data-v-4dd96569><div class="mesh-summary-label" data-v-4dd96569>OpenVPN 客户端地址池与监听（按实例）</div><!--[-->`);
          ssrRenderList(meshSummary.value.openvpn_instance_subnets, (row, idx) => {
            _push(ssrRenderComponent(_component_el_tag, {
              key: "ov-" + idx,
              size: "small",
              class: "mesh-tag"
            }, {
              default: withCtx((_, _push2, _parent2, _scopeId) => {
                if (_push2) {
                  _push2(`${ssrInterpolate(modeMeshShort(row.mode))} · ${ssrInterpolate(protoMeshChar(row.proto))}/${ssrInterpolate(row.port)} · ${ssrInterpolate(row.subnet)}`);
                } else {
                  return [
                    createTextVNode(toDisplayString(modeMeshShort(row.mode)) + " · " + toDisplayString(protoMeshChar(row.proto)) + "/" + toDisplayString(row.port) + " · " + toDisplayString(row.subnet), 1)
                  ];
                }
              }),
              _: 2
            }, _parent));
          });
          _push(`<!--]--></div>`);
        } else {
          _push(`<!---->`);
        }
        if ((_d = meshSummary.value.wireguard_peer_local_ips) == null ? void 0 : _d.length) {
          _push(`<div class="mesh-summary-section" data-v-4dd96569><div class="mesh-summary-label" data-v-4dd96569>WireGuard 骨干（每对端一条 /30，本端 IP）</div><!--[-->`);
          ssrRenderList(meshSummary.value.wireguard_peer_local_ips, (row, idx) => {
            _push(`<div class="mesh-wg-line" data-v-4dd96569><span class="mesh-wg-k" data-v-4dd96569>对端</span><span class="mesh-wg-v mesh-wg-peer" data-v-4dd96569>${ssrInterpolate(row.peer_node_id)}</span><span class="mesh-wg-k" data-v-4dd96569>本端</span><span class="mesh-wg-v mesh-wg-ip" data-v-4dd96569>${ssrInterpolate(row.local_ip)}</span>`);
            if (row.wg_port != null && row.wg_port !== "") {
              _push(`<!--[--><span class="mesh-wg-k" data-v-4dd96569>监听</span><span class="mesh-wg-v mesh-wg-port" data-v-4dd96569>UDP ${ssrInterpolate(row.wg_port)}</span><!--]-->`);
            } else {
              _push(`<!---->`);
            }
            _push(`<span class="mesh-wg-k" data-v-4dd96569>隧道</span>`);
            _push(ssrRenderComponent(_component_el_text, {
              type: "info",
              size: "small",
              class: "mesh-wg-v"
            }, {
              default: withCtx((_, _push2, _parent2, _scopeId) => {
                if (_push2) {
                  _push2(`${ssrInterpolate(row.tunnel_subnet)}`);
                } else {
                  return [
                    createTextVNode(toDisplayString(row.tunnel_subnet), 1)
                  ];
                }
              }),
              _: 2
            }, _parent));
            _push(`</div>`);
          });
          _push(`<!--]--></div>`);
        } else {
          _push(`<!---->`);
        }
        _push(`</div>`);
      } else {
        _push(`<!---->`);
      }
      _push(ssrRenderComponent(_component_el_divider, {
        "content-position": "left",
        class: "node-edit-divider"
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`可编辑`);
          } else {
            return [
              createTextVNode("可编辑")
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(ssrRenderComponent(_component_el_form, {
        class: "node-meta-form",
        "label-width": "72px",
        onSubmit: () => {
        }
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`<div class="node-edit-strip" data-v-4dd96569${_scopeId}>`);
            _push2(ssrRenderComponent(_component_el_form_item, {
              label: "名称",
              required: ""
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_input, {
                    modelValue: editNode.name,
                    "onUpdate:modelValue": ($event) => editNode.name = $event,
                    placeholder: "节点显示名称",
                    class: "node-edit-input"
                  }, null, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_el_input, {
                      modelValue: editNode.name,
                      "onUpdate:modelValue": ($event) => editNode.name = $event,
                      placeholder: "节点显示名称",
                      class: "node-edit-input"
                    }, null, 8, ["modelValue", "onUpdate:modelValue"])
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_form_item, { label: "地域" }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_input, {
                    modelValue: editNode.region,
                    "onUpdate:modelValue": ($event) => editNode.region = $event,
                    placeholder: "如 cn-east",
                    class: "node-edit-input"
                  }, null, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_el_input, {
                      modelValue: editNode.region,
                      "onUpdate:modelValue": ($event) => editNode.region = $event,
                      placeholder: "如 cn-east",
                      class: "node-edit-input"
                    }, null, 8, ["modelValue", "onUpdate:modelValue"])
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_form_item, { label: "公网地址" }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_input, {
                    modelValue: editNode.public_ip,
                    "onUpdate:modelValue": ($event) => editNode.public_ip = $event,
                    placeholder: "IPv4/IPv6 或域名",
                    class: "node-edit-input node-edit-input--wide"
                  }, null, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_el_input, {
                      modelValue: editNode.public_ip,
                      "onUpdate:modelValue": ($event) => editNode.public_ip = $event,
                      placeholder: "IPv4/IPv6 或域名",
                      class: "node-edit-input node-edit-input--wide"
                    }, null, 8, ["modelValue", "onUpdate:modelValue"])
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(`</div>`);
          } else {
            return [
              createVNode("div", { class: "node-edit-strip" }, [
                createVNode(_component_el_form_item, {
                  label: "名称",
                  required: ""
                }, {
                  default: withCtx(() => [
                    createVNode(_component_el_input, {
                      modelValue: editNode.name,
                      "onUpdate:modelValue": ($event) => editNode.name = $event,
                      placeholder: "节点显示名称",
                      class: "node-edit-input"
                    }, null, 8, ["modelValue", "onUpdate:modelValue"])
                  ]),
                  _: 1
                }),
                createVNode(_component_el_form_item, { label: "地域" }, {
                  default: withCtx(() => [
                    createVNode(_component_el_input, {
                      modelValue: editNode.region,
                      "onUpdate:modelValue": ($event) => editNode.region = $event,
                      placeholder: "如 cn-east",
                      class: "node-edit-input"
                    }, null, 8, ["modelValue", "onUpdate:modelValue"])
                  ]),
                  _: 1
                }),
                createVNode(_component_el_form_item, { label: "公网地址" }, {
                  default: withCtx(() => [
                    createVNode(_component_el_input, {
                      modelValue: editNode.public_ip,
                      "onUpdate:modelValue": ($event) => editNode.public_ip = $event,
                      placeholder: "IPv4/IPv6 或域名",
                      class: "node-edit-input node-edit-input--wide"
                    }, null, 8, ["modelValue", "onUpdate:modelValue"])
                  ]),
                  _: 1
                })
              ])
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div><div class="page-card mb-md node-instances-card" data-v-4dd96569><div class="page-card-header node-instances-card__head" data-v-4dd96569><span class="page-card-title" data-v-4dd96569>组网接入（模式与地址）</span>`);
      _push(ssrRenderComponent(_component_el_button, {
        type: "primary",
        link: "",
        loading: refreshing.value,
        class: "node-instances-card__refresh",
        onClick: ($event) => load({ refresh: true })
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_icon, null, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_Refresh, null, null, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_Refresh)
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(` 刷新状态 `);
          } else {
            return [
              createVNode(_component_el_icon, null, {
                default: withCtx(() => [
                  createVNode(_component_Refresh)
                ]),
                _: 1
              }),
              createTextVNode(" 刷新状态 ")
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div>`);
      _push(ssrRenderComponent(_component_el_collapse, { class: "instance-hint-collapse mb-md" }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_collapse_item, { name: "instance-hint" }, {
              title: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`<span class="collapse-hint-title" data-v-4dd96569${_scopeId2}>`);
                  _push3(ssrRenderComponent(_component_el_icon, { class: "collapse-hint-icon" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_InfoFilled, null, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_InfoFilled)
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(` 使用说明（协议、出口与在线用户） </span>`);
                } else {
                  return [
                    createVNode("span", { class: "collapse-hint-title" }, [
                      createVNode(_component_el_icon, { class: "collapse-hint-icon" }, {
                        default: withCtx(() => [
                          createVNode(_component_InfoFilled)
                        ]),
                        _: 1
                      }),
                      createTextVNode(" 使用说明（协议、出口与在线用户） ")
                    ])
                  ];
                }
              }),
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`<div class="section-hint-body" data-v-4dd96569${_scopeId2}><p data-v-4dd96569${_scopeId2}> 以下为已启用的接入实例；子网为 VPN 客户端地址池（CIDR），修改后需 Agent 同步生效。上方「组网地址摘要」与签发所用协议均以数据库中已保存的 <code data-v-4dd96569${_scopeId2}>instances.proto</code> 为准；下拉未点「保存」前不会生效。用户 .ovpn 的 <code data-v-4dd96569${_scopeId2}>proto</code> 在签发时写入，改协议后须在「用户 → 授权」中<strong data-v-4dd96569${_scopeId2}>重试签发</strong>并重新下载配置。 </p><p data-v-4dd96569${_scopeId2}><strong data-v-4dd96569${_scopeId2}>节点直连（<code data-v-4dd96569${_scopeId2}>node-direct</code>）</strong>：向客户端推送默认路由，流量经本入口节点公网出口上网（NAT 到本机 WAN）。<strong data-v-4dd96569${_scopeId2}>出口节点</strong>留空即可；若填写对端节点 ID（须与本页「相关隧道」一致），则该实例流量经 WireGuard 到对端再出网。 </p><p data-v-4dd96569${_scopeId2}><strong data-v-4dd96569${_scopeId2}>国内分流（<code data-v-4dd96569${_scopeId2}>cn-split</code>）/ 全局（<code data-v-4dd96569${_scopeId2}>global</code>）</strong>：<strong data-v-4dd96569${_scopeId2}>出口节点</strong>填写对端节点 ID；留空时节点脚本仍按旧逻辑尝试 <code data-v-4dd96569${_scopeId2}>hongkong</code> 等内置名。 </p><p data-v-4dd96569${_scopeId2}><strong data-v-4dd96569${_scopeId2}>新建节点</strong>默认仅启用 <code data-v-4dd96569${_scopeId2}>node-direct</code>（节点直连）；其余模式需在下方列表中打开「启用」后，在节点上重新执行安装脚本或等待同步，以生成对应 OpenVPN 与路由。 </p><p data-v-4dd96569${_scopeId2}><strong data-v-4dd96569${_scopeId2}>在线用户</strong>由 Agent 按各模式固定 management 端口统计；若长期为 0 请见运维手册第 3.3 节。若客户端开启「仅允许 VPN 流量」而所用实例未推默认路由（旧版节点），可能出现连上但无公网，见用户指南。 </p></div>`);
                } else {
                  return [
                    createVNode("div", { class: "section-hint-body" }, [
                      createVNode("p", null, [
                        createTextVNode(" 以下为已启用的接入实例；子网为 VPN 客户端地址池（CIDR），修改后需 Agent 同步生效。上方「组网地址摘要」与签发所用协议均以数据库中已保存的 "),
                        createVNode("code", null, "instances.proto"),
                        createTextVNode(" 为准；下拉未点「保存」前不会生效。用户 .ovpn 的 "),
                        createVNode("code", null, "proto"),
                        createTextVNode(" 在签发时写入，改协议后须在「用户 → 授权」中"),
                        createVNode("strong", null, "重试签发"),
                        createTextVNode("并重新下载配置。 ")
                      ]),
                      createVNode("p", null, [
                        createVNode("strong", null, [
                          createTextVNode("节点直连（"),
                          createVNode("code", null, "node-direct"),
                          createTextVNode("）")
                        ]),
                        createTextVNode("：向客户端推送默认路由，流量经本入口节点公网出口上网（NAT 到本机 WAN）。"),
                        createVNode("strong", null, "出口节点"),
                        createTextVNode("留空即可；若填写对端节点 ID（须与本页「相关隧道」一致），则该实例流量经 WireGuard 到对端再出网。 ")
                      ]),
                      createVNode("p", null, [
                        createVNode("strong", null, [
                          createTextVNode("国内分流（"),
                          createVNode("code", null, "cn-split"),
                          createTextVNode("）/ 全局（"),
                          createVNode("code", null, "global"),
                          createTextVNode("）")
                        ]),
                        createTextVNode("："),
                        createVNode("strong", null, "出口节点"),
                        createTextVNode("填写对端节点 ID；留空时节点脚本仍按旧逻辑尝试 "),
                        createVNode("code", null, "hongkong"),
                        createTextVNode(" 等内置名。 ")
                      ]),
                      createVNode("p", null, [
                        createVNode("strong", null, "新建节点"),
                        createTextVNode("默认仅启用 "),
                        createVNode("code", null, "node-direct"),
                        createTextVNode("（节点直连）；其余模式需在下方列表中打开「启用」后，在节点上重新执行安装脚本或等待同步，以生成对应 OpenVPN 与路由。 ")
                      ]),
                      createVNode("p", null, [
                        createVNode("strong", null, "在线用户"),
                        createTextVNode("由 Agent 按各模式固定 management 端口统计；若长期为 0 请见运维手册第 3.3 节。若客户端开启「仅允许 VPN 流量」而所用实例未推默认路由（旧版节点），可能出现连上但无公网，见用户指南。 ")
                      ])
                    ])
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_collapse_item, { name: "instance-hint" }, {
                title: withCtx(() => [
                  createVNode("span", { class: "collapse-hint-title" }, [
                    createVNode(_component_el_icon, { class: "collapse-hint-icon" }, {
                      default: withCtx(() => [
                        createVNode(_component_InfoFilled)
                      ]),
                      _: 1
                    }),
                    createTextVNode(" 使用说明（协议、出口与在线用户） ")
                  ])
                ]),
                default: withCtx(() => [
                  createVNode("div", { class: "section-hint-body" }, [
                    createVNode("p", null, [
                      createTextVNode(" 以下为已启用的接入实例；子网为 VPN 客户端地址池（CIDR），修改后需 Agent 同步生效。上方「组网地址摘要」与签发所用协议均以数据库中已保存的 "),
                      createVNode("code", null, "instances.proto"),
                      createTextVNode(" 为准；下拉未点「保存」前不会生效。用户 .ovpn 的 "),
                      createVNode("code", null, "proto"),
                      createTextVNode(" 在签发时写入，改协议后须在「用户 → 授权」中"),
                      createVNode("strong", null, "重试签发"),
                      createTextVNode("并重新下载配置。 ")
                    ]),
                    createVNode("p", null, [
                      createVNode("strong", null, [
                        createTextVNode("节点直连（"),
                        createVNode("code", null, "node-direct"),
                        createTextVNode("）")
                      ]),
                      createTextVNode("：向客户端推送默认路由，流量经本入口节点公网出口上网（NAT 到本机 WAN）。"),
                      createVNode("strong", null, "出口节点"),
                      createTextVNode("留空即可；若填写对端节点 ID（须与本页「相关隧道」一致），则该实例流量经 WireGuard 到对端再出网。 ")
                    ]),
                    createVNode("p", null, [
                      createVNode("strong", null, [
                        createTextVNode("国内分流（"),
                        createVNode("code", null, "cn-split"),
                        createTextVNode("）/ 全局（"),
                        createVNode("code", null, "global"),
                        createTextVNode("）")
                      ]),
                      createTextVNode("："),
                      createVNode("strong", null, "出口节点"),
                      createTextVNode("填写对端节点 ID；留空时节点脚本仍按旧逻辑尝试 "),
                      createVNode("code", null, "hongkong"),
                      createTextVNode(" 等内置名。 ")
                    ]),
                    createVNode("p", null, [
                      createVNode("strong", null, "新建节点"),
                      createTextVNode("默认仅启用 "),
                      createVNode("code", null, "node-direct"),
                      createTextVNode("（节点直连）；其余模式需在下方列表中打开「启用」后，在节点上重新执行安装脚本或等待同步，以生成对应 OpenVPN 与路由。 ")
                    ]),
                    createVNode("p", null, [
                      createVNode("strong", null, "在线用户"),
                      createTextVNode("由 Agent 按各模式固定 management 端口统计；若长期为 0 请见运维手册第 3.3 节。若客户端开启「仅允许 VPN 流量」而所用实例未推默认路由（旧版节点），可能出现连上但无公网，见用户指南。 ")
                    ])
                  ])
                ]),
                _: 1
              })
            ];
          }
        }),
        _: 1
      }, _parent));
      if (enabledInstances.value.length) {
        _push(`<p class="listen-summary-line" data-v-4dd96569><span class="listen-summary-label" data-v-4dd96569>当前监听（公网入站需放行）</span><!--[-->`);
        ssrRenderList(enabledInstances.value, (inst) => {
          _push(ssrRenderComponent(_component_el_tag, {
            key: "ls-" + inst.id,
            size: "small",
            type: "info",
            effect: "plain",
            class: "listen-summary-tag"
          }, {
            default: withCtx((_, _push2, _parent2, _scopeId) => {
              if (_push2) {
                _push2(`${ssrInterpolate(modeLabel(inst.mode))} 已保存 ${ssrInterpolate(protoUpper(inst.proto))}/${ssrInterpolate(inst.port)}`);
                if (instanceListenDirty(inst)) {
                  _push2(`<span class="listen-summary-pending" data-v-4dd96569${_scopeId}> · 未保存 ${ssrInterpolate(protoUpper(editProto[inst.id]))}/${ssrInterpolate(editPort[inst.id])}</span>`);
                } else {
                  _push2(`<!---->`);
                }
              } else {
                return [
                  createTextVNode(toDisplayString(modeLabel(inst.mode)) + " 已保存 " + toDisplayString(protoUpper(inst.proto)) + "/" + toDisplayString(inst.port), 1),
                  instanceListenDirty(inst) ? (openBlock(), createBlock("span", {
                    key: 0,
                    class: "listen-summary-pending"
                  }, " · 未保存 " + toDisplayString(protoUpper(editProto[inst.id])) + "/" + toDisplayString(editPort[inst.id]), 1)) : createCommentVNode("", true)
                ];
              }
            }),
            _: 2
          }, _parent));
        });
        _push(`<!--]--></p>`);
      } else {
        _push(`<!---->`);
      }
      _push(`<div class="instance-cards-wrap" data-v-4dd96569><div class="instance-cards-grid" data-v-4dd96569><!--[-->`);
      ssrRenderList(enabledInstances.value, (row) => {
        _push(`<div class="${ssrRenderClass([unref(recordCardToneFromTagType)("success"), "record-card instance-card"])}" data-v-4dd96569><div class="record-card__head instance-card__head" data-v-4dd96569><div class="inst-segment-cell min-w-0" data-v-4dd96569>`);
        _push(ssrRenderComponent(_component_el_tooltip, {
          content: segmentName(row.segment_id),
          placement: "top",
          disabled: !segmentName(row.segment_id)
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`<span class="inst-segment-text" data-v-4dd96569${_scopeId}>${ssrInterpolate(segmentName(row.segment_id))}</span>`);
            } else {
              return [
                createVNode("span", { class: "inst-segment-text" }, toDisplayString(segmentName(row.segment_id)), 1)
              ];
            }
          }),
          _: 2
        }, _parent));
        if (segmentName(row.segment_id)) {
          _push(ssrRenderComponent(_component_el_button, {
            link: "",
            type: "primary",
            size: "small",
            class: "inst-segment-copy",
            onClick: ($event) => copyText(segmentName(row.segment_id))
          }, {
            default: withCtx((_, _push2, _parent2, _scopeId) => {
              if (_push2) {
                _push2(ssrRenderComponent(_component_el_icon, null, {
                  default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(ssrRenderComponent(_component_DocumentCopy, null, null, _parent3, _scopeId2));
                    } else {
                      return [
                        createVNode(_component_DocumentCopy)
                      ];
                    }
                  }),
                  _: 2
                }, _parent2, _scopeId));
              } else {
                return [
                  createVNode(_component_el_icon, null, {
                    default: withCtx(() => [
                      createVNode(_component_DocumentCopy)
                    ]),
                    _: 1
                  })
                ];
              }
            }),
            _: 2
          }, _parent));
        } else {
          _push(`<!---->`);
        }
        _push(`</div>`);
        _push(ssrRenderComponent(_component_el_switch, {
          "model-value": row.enabled,
          size: "small",
          onChange: ($event) => toggleInstance(row)
        }, null, _parent));
        _push(`</div><div class="instance-card__fields" data-v-4dd96569><div class="inst-field-row inst-field-row--top" data-v-4dd96569><div class="inst-field inst-field--stack" data-v-4dd96569><span class="inst-field__label" data-v-4dd96569>模式</span><div class="inst-field__ctl inst-field__ctl--text" data-v-4dd96569>${ssrInterpolate(modeLabel(row.mode))}</div></div><div class="inst-field inst-field--stack" data-v-4dd96569><span class="inst-field__label" data-v-4dd96569>协议</span>`);
        _push(ssrRenderComponent(_component_el_select, {
          modelValue: editProto[row.id],
          "onUpdate:modelValue": ($event) => editProto[row.id] = $event,
          size: "small",
          class: "inst-field__ctl inst-select-proto"
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(ssrRenderComponent(_component_el_option, {
                label: "UDP",
                value: "udp"
              }, null, _parent2, _scopeId));
              _push2(ssrRenderComponent(_component_el_option, {
                label: "TCP",
                value: "tcp"
              }, null, _parent2, _scopeId));
            } else {
              return [
                createVNode(_component_el_option, {
                  label: "UDP",
                  value: "udp"
                }),
                createVNode(_component_el_option, {
                  label: "TCP",
                  value: "tcp"
                })
              ];
            }
          }),
          _: 2
        }, _parent));
        _push(`</div><div class="inst-field inst-field--stack" data-v-4dd96569><span class="inst-field__label" data-v-4dd96569>端口</span>`);
        _push(ssrRenderComponent(_component_el_input_number, {
          modelValue: editPort[row.id],
          "onUpdate:modelValue": ($event) => editPort[row.id] = $event,
          min: 1,
          max: 65535,
          size: "small",
          "controls-position": "right",
          class: "inst-field__ctl inst-input-port"
        }, null, _parent));
        _push(`</div></div><div class="inst-field inst-field--row" data-v-4dd96569><span class="inst-field__label" data-v-4dd96569>子网 (CIDR)</span>`);
        _push(ssrRenderComponent(_component_el_input, {
          modelValue: editSubnet[row.id],
          "onUpdate:modelValue": ($event) => editSubnet[row.id] = $event,
          size: "small",
          placeholder: "10.8.0.0/24",
          class: "inst-field__ctl inst-input-cidr"
        }, null, _parent));
        _push(`</div><div class="inst-field inst-field--row" data-v-4dd96569><span class="inst-field__label" data-v-4dd96569>出口节点</span>`);
        if (instanceModeUsesExit(row.mode)) {
          _push(ssrRenderComponent(_component_el_select, {
            modelValue: editExitNode[row.id],
            "onUpdate:modelValue": ($event) => editExitNode[row.id] = $event,
            clearable: "",
            filterable: "",
            placeholder: row.mode === "node-direct" ? "未指定（本入口节点公网出口）" : "未指定（内置名回退）",
            size: "small",
            class: "inst-field__ctl inst-select-exit"
          }, {
            default: withCtx((_, _push2, _parent2, _scopeId) => {
              if (_push2) {
                _push2(`<!--[-->`);
                ssrRenderList(peerTunnelIds.value, (pid) => {
                  _push2(ssrRenderComponent(_component_el_option, {
                    key: pid,
                    label: peerTunnelOptionLabel(pid),
                    value: pid
                  }, null, _parent2, _scopeId));
                });
                _push2(`<!--]-->`);
              } else {
                return [
                  (openBlock(true), createBlock(Fragment, null, renderList(peerTunnelIds.value, (pid) => {
                    return openBlock(), createBlock(_component_el_option, {
                      key: pid,
                      label: peerTunnelOptionLabel(pid),
                      value: pid
                    }, null, 8, ["label", "value"]);
                  }), 128))
                ];
              }
            }),
            _: 2
          }, _parent));
        } else {
          _push(ssrRenderComponent(_component_el_text, {
            type: "info",
            class: "inst-field__ctl"
          }, {
            default: withCtx((_, _push2, _parent2, _scopeId) => {
              if (_push2) {
                _push2(`—`);
              } else {
                return [
                  createTextVNode("—")
                ];
              }
            }),
            _: 2
          }, _parent));
        }
        _push(`</div></div><div class="record-card__actions" data-v-4dd96569>`);
        _push(ssrRenderComponent(_component_el_button, {
          type: "primary",
          size: "small",
          onClick: ($event) => saveInstancePatch(row)
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`保存`);
            } else {
              return [
                createTextVNode("保存")
              ];
            }
          }),
          _: 2
        }, _parent));
        _push(`</div></div>`);
      });
      _push(`<!--]--></div></div>`);
      if (!enabledInstances.value.length) {
        _push(ssrRenderComponent(_component_el_empty, {
          description: "暂无已启用实例",
          "image-size": 60
        }, null, _parent));
      } else {
        _push(`<!---->`);
      }
      if (disabledInstances.value.length) {
        _push(ssrRenderComponent(_component_el_collapse, { class: "mt-md" }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(ssrRenderComponent(_component_el_collapse_item, {
                title: "已禁用的接入（可重新启用）",
                name: "disabled"
              }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(`<div class="instance-cards-wrap" data-v-4dd96569${_scopeId2}><div class="instance-cards-grid" data-v-4dd96569${_scopeId2}><!--[-->`);
                    ssrRenderList(disabledInstances.value, (row) => {
                      _push3(`<div class="record-card instance-card instance-card--readonly record-card--tone-muted" data-v-4dd96569${_scopeId2}><div class="record-card__head instance-card__head" data-v-4dd96569${_scopeId2}><div class="inst-segment-cell min-w-0" data-v-4dd96569${_scopeId2}>`);
                      _push3(ssrRenderComponent(_component_el_tooltip, {
                        content: segmentName(row.segment_id),
                        placement: "top",
                        disabled: !segmentName(row.segment_id)
                      }, {
                        default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                          if (_push4) {
                            _push4(`<span class="inst-segment-text" data-v-4dd96569${_scopeId3}>${ssrInterpolate(segmentName(row.segment_id))}</span>`);
                          } else {
                            return [
                              createVNode("span", { class: "inst-segment-text" }, toDisplayString(segmentName(row.segment_id)), 1)
                            ];
                          }
                        }),
                        _: 2
                      }, _parent3, _scopeId2));
                      if (segmentName(row.segment_id)) {
                        _push3(ssrRenderComponent(_component_el_button, {
                          link: "",
                          type: "primary",
                          size: "small",
                          class: "inst-segment-copy",
                          onClick: ($event) => copyText(segmentName(row.segment_id))
                        }, {
                          default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                            if (_push4) {
                              _push4(ssrRenderComponent(_component_el_icon, null, {
                                default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                                  if (_push5) {
                                    _push5(ssrRenderComponent(_component_DocumentCopy, null, null, _parent5, _scopeId4));
                                  } else {
                                    return [
                                      createVNode(_component_DocumentCopy)
                                    ];
                                  }
                                }),
                                _: 2
                              }, _parent4, _scopeId3));
                            } else {
                              return [
                                createVNode(_component_el_icon, null, {
                                  default: withCtx(() => [
                                    createVNode(_component_DocumentCopy)
                                  ]),
                                  _: 1
                                })
                              ];
                            }
                          }),
                          _: 2
                        }, _parent3, _scopeId2));
                      } else {
                        _push3(`<!---->`);
                      }
                      _push3(`</div>`);
                      _push3(ssrRenderComponent(_component_el_switch, {
                        "model-value": row.enabled,
                        size: "small",
                        onChange: ($event) => toggleInstance(row)
                      }, null, _parent3, _scopeId2));
                      _push3(`</div><div class="instance-card__fields" data-v-4dd96569${_scopeId2}><div class="kv-row" data-v-4dd96569${_scopeId2}><span class="kv-label" data-v-4dd96569${_scopeId2}>模式</span><span class="kv-value" data-v-4dd96569${_scopeId2}>${ssrInterpolate(modeLabel(row.mode))}</span></div><div class="kv-row" data-v-4dd96569${_scopeId2}><span class="kv-label" data-v-4dd96569${_scopeId2}>协议 / 端口</span><span class="kv-value" data-v-4dd96569${_scopeId2}>${ssrInterpolate(protoUpper(row.proto))} / ${ssrInterpolate(row.port)}</span></div><div class="kv-row" data-v-4dd96569${_scopeId2}><span class="kv-label" data-v-4dd96569${_scopeId2}>子网</span><span class="kv-value mono-text" data-v-4dd96569${_scopeId2}>${ssrInterpolate(row.subnet || "—")}</span></div><div class="kv-row" data-v-4dd96569${_scopeId2}><span class="kv-label" data-v-4dd96569${_scopeId2}>出口节点</span><span class="kv-value" data-v-4dd96569${_scopeId2}>${ssrInterpolate(exitCellLabel(row))}</span></div></div></div>`);
                    });
                    _push3(`<!--]--></div></div>`);
                  } else {
                    return [
                      createVNode("div", { class: "instance-cards-wrap" }, [
                        createVNode("div", { class: "instance-cards-grid" }, [
                          (openBlock(true), createBlock(Fragment, null, renderList(disabledInstances.value, (row) => {
                            return openBlock(), createBlock("div", {
                              key: row.id,
                              class: "record-card instance-card instance-card--readonly record-card--tone-muted"
                            }, [
                              createVNode("div", { class: "record-card__head instance-card__head" }, [
                                createVNode("div", { class: "inst-segment-cell min-w-0" }, [
                                  createVNode(_component_el_tooltip, {
                                    content: segmentName(row.segment_id),
                                    placement: "top",
                                    disabled: !segmentName(row.segment_id)
                                  }, {
                                    default: withCtx(() => [
                                      createVNode("span", { class: "inst-segment-text" }, toDisplayString(segmentName(row.segment_id)), 1)
                                    ]),
                                    _: 2
                                  }, 1032, ["content", "disabled"]),
                                  segmentName(row.segment_id) ? (openBlock(), createBlock(_component_el_button, {
                                    key: 0,
                                    link: "",
                                    type: "primary",
                                    size: "small",
                                    class: "inst-segment-copy",
                                    onClick: ($event) => copyText(segmentName(row.segment_id))
                                  }, {
                                    default: withCtx(() => [
                                      createVNode(_component_el_icon, null, {
                                        default: withCtx(() => [
                                          createVNode(_component_DocumentCopy)
                                        ]),
                                        _: 1
                                      })
                                    ]),
                                    _: 1
                                  }, 8, ["onClick"])) : createCommentVNode("", true)
                                ]),
                                createVNode(_component_el_switch, {
                                  "model-value": row.enabled,
                                  size: "small",
                                  onChange: ($event) => toggleInstance(row)
                                }, null, 8, ["model-value", "onChange"])
                              ]),
                              createVNode("div", { class: "instance-card__fields" }, [
                                createVNode("div", { class: "kv-row" }, [
                                  createVNode("span", { class: "kv-label" }, "模式"),
                                  createVNode("span", { class: "kv-value" }, toDisplayString(modeLabel(row.mode)), 1)
                                ]),
                                createVNode("div", { class: "kv-row" }, [
                                  createVNode("span", { class: "kv-label" }, "协议 / 端口"),
                                  createVNode("span", { class: "kv-value" }, toDisplayString(protoUpper(row.proto)) + " / " + toDisplayString(row.port), 1)
                                ]),
                                createVNode("div", { class: "kv-row" }, [
                                  createVNode("span", { class: "kv-label" }, "子网"),
                                  createVNode("span", { class: "kv-value mono-text" }, toDisplayString(row.subnet || "—"), 1)
                                ]),
                                createVNode("div", { class: "kv-row" }, [
                                  createVNode("span", { class: "kv-label" }, "出口节点"),
                                  createVNode("span", { class: "kv-value" }, toDisplayString(exitCellLabel(row)), 1)
                                ])
                              ])
                            ]);
                          }), 128))
                        ])
                      ])
                    ];
                  }
                }),
                _: 1
              }, _parent2, _scopeId));
            } else {
              return [
                createVNode(_component_el_collapse_item, {
                  title: "已禁用的接入（可重新启用）",
                  name: "disabled"
                }, {
                  default: withCtx(() => [
                    createVNode("div", { class: "instance-cards-wrap" }, [
                      createVNode("div", { class: "instance-cards-grid" }, [
                        (openBlock(true), createBlock(Fragment, null, renderList(disabledInstances.value, (row) => {
                          return openBlock(), createBlock("div", {
                            key: row.id,
                            class: "record-card instance-card instance-card--readonly record-card--tone-muted"
                          }, [
                            createVNode("div", { class: "record-card__head instance-card__head" }, [
                              createVNode("div", { class: "inst-segment-cell min-w-0" }, [
                                createVNode(_component_el_tooltip, {
                                  content: segmentName(row.segment_id),
                                  placement: "top",
                                  disabled: !segmentName(row.segment_id)
                                }, {
                                  default: withCtx(() => [
                                    createVNode("span", { class: "inst-segment-text" }, toDisplayString(segmentName(row.segment_id)), 1)
                                  ]),
                                  _: 2
                                }, 1032, ["content", "disabled"]),
                                segmentName(row.segment_id) ? (openBlock(), createBlock(_component_el_button, {
                                  key: 0,
                                  link: "",
                                  type: "primary",
                                  size: "small",
                                  class: "inst-segment-copy",
                                  onClick: ($event) => copyText(segmentName(row.segment_id))
                                }, {
                                  default: withCtx(() => [
                                    createVNode(_component_el_icon, null, {
                                      default: withCtx(() => [
                                        createVNode(_component_DocumentCopy)
                                      ]),
                                      _: 1
                                    })
                                  ]),
                                  _: 1
                                }, 8, ["onClick"])) : createCommentVNode("", true)
                              ]),
                              createVNode(_component_el_switch, {
                                "model-value": row.enabled,
                                size: "small",
                                onChange: ($event) => toggleInstance(row)
                              }, null, 8, ["model-value", "onChange"])
                            ]),
                            createVNode("div", { class: "instance-card__fields" }, [
                              createVNode("div", { class: "kv-row" }, [
                                createVNode("span", { class: "kv-label" }, "模式"),
                                createVNode("span", { class: "kv-value" }, toDisplayString(modeLabel(row.mode)), 1)
                              ]),
                              createVNode("div", { class: "kv-row" }, [
                                createVNode("span", { class: "kv-label" }, "协议 / 端口"),
                                createVNode("span", { class: "kv-value" }, toDisplayString(protoUpper(row.proto)) + " / " + toDisplayString(row.port), 1)
                              ]),
                              createVNode("div", { class: "kv-row" }, [
                                createVNode("span", { class: "kv-label" }, "子网"),
                                createVNode("span", { class: "kv-value mono-text" }, toDisplayString(row.subnet || "—"), 1)
                              ]),
                              createVNode("div", { class: "kv-row" }, [
                                createVNode("span", { class: "kv-label" }, "出口节点"),
                                createVNode("span", { class: "kv-value" }, toDisplayString(exitCellLabel(row)), 1)
                              ])
                            ])
                          ]);
                        }), 128))
                      ])
                    ])
                  ]),
                  _: 1
                })
              ];
            }
          }),
          _: 1
        }, _parent));
      } else {
        _push(`<!---->`);
      }
      _push(`</div><div class="page-card mb-md tunnel-section" data-v-4dd96569><div class="page-card-header tunnel-section__head" data-v-4dd96569><span class="page-card-title" data-v-4dd96569>相关隧道</span></div><div class="tunnel-cards-wrap" data-v-4dd96569><div class="tunnel-cards-grid" data-v-4dd96569><!--[-->`);
      ssrRenderList(tunnels.value, (row) => {
        _push(`<div class="${ssrRenderClass([unref(recordCardToneClass)("tunnel", row.status), "record-card tunnel-card"])}" data-v-4dd96569><div class="record-card__head" data-v-4dd96569><div class="record-card__title min-w-0" data-v-4dd96569>${ssrInterpolate(tunnelPeerLine(row))}</div>`);
        _push(ssrRenderComponent(_component_el_button, {
          type: "primary",
          size: "small",
          link: "",
          onClick: ($event) => openTunnelEdit(row)
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`编辑`);
            } else {
              return [
                createTextVNode("编辑")
              ];
            }
          }),
          _: 2
        }, _parent));
        _push(`</div><div class="record-card__fields" data-v-4dd96569><div class="kv-row" data-v-4dd96569><span class="kv-label" data-v-4dd96569>隧道子网</span><span class="kv-value mono-text" data-v-4dd96569>${ssrInterpolate(row.subnet || "—")}</span></div><div class="kv-row" data-v-4dd96569><span class="kv-label" data-v-4dd96569>WG 本端 / 对端</span><span class="kv-value mono-text" data-v-4dd96569>${ssrInterpolate(row.node_a === unref(nodeId) ? row.ip_a : row.ip_b)} → ${ssrInterpolate(row.node_a === unref(nodeId) ? row.ip_b : row.ip_a)}</span></div><div class="kv-row" data-v-4dd96569><span class="kv-label" data-v-4dd96569>状态</span><span class="kv-value" data-v-4dd96569><span class="${ssrRenderClass([`status-dot--${row.status}`, "status-dot"])}" data-v-4dd96569></span> ${ssrInterpolate(unref(getStatusInfo)("tunnel", row.status).label)}</span></div><div class="kv-row" data-v-4dd96569><span class="kv-label" data-v-4dd96569>WG 端口 / 延迟</span><span class="kv-value" data-v-4dd96569>${ssrInterpolate(row.wg_port != null ? row.wg_port : "—")} <span class="record-card__meta" data-v-4dd96569> · </span> ${ssrInterpolate(row.latency_ms > 0 ? row.latency_ms.toFixed(1) : "—")} ms </span></div></div></div>`);
      });
      _push(`<!--]--></div></div>`);
      if (!tunnels.value.length) {
        _push(ssrRenderComponent(_component_el_empty, {
          description: "暂无隧道",
          "image-size": 60,
          class: "tunnel-empty"
        }, null, _parent));
      } else {
        _push(`<!---->`);
      }
      _push(`</div>`);
      _push(ssrRenderComponent(_component_el_dialog, {
        modelValue: tunnelDialogVisible.value,
        "onUpdate:modelValue": ($event) => tunnelDialogVisible.value = $event,
        title: "编辑隧道（WireGuard /30）",
        width: "520px",
        "destroy-on-close": ""
      }, {
        footer: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_button, {
              onClick: ($event) => tunnelDialogVisible.value = false
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`取消`);
                } else {
                  return [
                    createTextVNode("取消")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_button, {
              type: "primary",
              loading: tunnelSaving.value,
              onClick: saveTunnelEdit
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`保存`);
                } else {
                  return [
                    createTextVNode("保存")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_button, {
                onClick: ($event) => tunnelDialogVisible.value = false
              }, {
                default: withCtx(() => [
                  createTextVNode("取消")
                ]),
                _: 1
              }, 8, ["onClick"]),
              createVNode(_component_el_button, {
                type: "primary",
                loading: tunnelSaving.value,
                onClick: saveTunnelEdit
              }, {
                default: withCtx(() => [
                  createTextVNode("保存")
                ]),
                _: 1
              }, 8, ["loading"])
            ];
          }
        }),
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_alert, {
              type: "warning",
              closable: false,
              "show-icon": "",
              class: "mb-md"
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(` 须为 IPv4 /30，且 <code data-v-4dd96569${_scopeId2}>ip_a</code> 对应 <code data-v-4dd96569${_scopeId2}>node_a</code>、<code data-v-4dd96569${_scopeId2}>ip_b</code> 对应 <code data-v-4dd96569${_scopeId2}>node_b</code>。修改后两端节点 <code data-v-4dd96569${_scopeId2}>config_version</code> 递增；现场 WG 配置需与 Agent/脚本同步。 `);
                } else {
                  return [
                    createTextVNode(" 须为 IPv4 /30，且 "),
                    createVNode("code", null, "ip_a"),
                    createTextVNode(" 对应 "),
                    createVNode("code", null, "node_a"),
                    createTextVNode("、"),
                    createVNode("code", null, "ip_b"),
                    createTextVNode(" 对应 "),
                    createVNode("code", null, "node_b"),
                    createTextVNode("。修改后两端节点 "),
                    createVNode("code", null, "config_version"),
                    createTextVNode(" 递增；现场 WG 配置需与 Agent/脚本同步。 ")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_form, { "label-width": "120px" }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "隧道子网" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: tunnelForm.subnet,
                          "onUpdate:modelValue": ($event) => tunnelForm.subnet = $event,
                          placeholder: "如 172.16.0.0/30"
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: tunnelForm.subnet,
                            "onUpdate:modelValue": ($event) => tunnelForm.subnet = $event,
                            placeholder: "如 172.16.0.0/30"
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "ip_a (node_a)" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: tunnelForm.ip_a,
                          "onUpdate:modelValue": ($event) => tunnelForm.ip_a = $event
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: tunnelForm.ip_a,
                            "onUpdate:modelValue": ($event) => tunnelForm.ip_a = $event
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "ip_b (node_b)" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: tunnelForm.ip_b,
                          "onUpdate:modelValue": ($event) => tunnelForm.ip_b = $event
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: tunnelForm.ip_b,
                            "onUpdate:modelValue": ($event) => tunnelForm.ip_b = $event
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "WG 端口" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input_number, {
                          modelValue: tunnelForm.wg_port,
                          "onUpdate:modelValue": ($event) => tunnelForm.wg_port = $event,
                          min: 1,
                          max: 65535
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input_number, {
                            modelValue: tunnelForm.wg_port,
                            "onUpdate:modelValue": ($event) => tunnelForm.wg_port = $event,
                            min: 1,
                            max: 65535
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_el_form_item, { label: "隧道子网" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: tunnelForm.subnet,
                          "onUpdate:modelValue": ($event) => tunnelForm.subnet = $event,
                          placeholder: "如 172.16.0.0/30"
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "ip_a (node_a)" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: tunnelForm.ip_a,
                          "onUpdate:modelValue": ($event) => tunnelForm.ip_a = $event
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "ip_b (node_b)" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: tunnelForm.ip_b,
                          "onUpdate:modelValue": ($event) => tunnelForm.ip_b = $event
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "WG 端口" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input_number, {
                          modelValue: tunnelForm.wg_port,
                          "onUpdate:modelValue": ($event) => tunnelForm.wg_port = $event,
                          min: 1,
                          max: 65535
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    })
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_alert, {
                type: "warning",
                closable: false,
                "show-icon": "",
                class: "mb-md"
              }, {
                default: withCtx(() => [
                  createTextVNode(" 须为 IPv4 /30，且 "),
                  createVNode("code", null, "ip_a"),
                  createTextVNode(" 对应 "),
                  createVNode("code", null, "node_a"),
                  createTextVNode("、"),
                  createVNode("code", null, "ip_b"),
                  createTextVNode(" 对应 "),
                  createVNode("code", null, "node_b"),
                  createTextVNode("。修改后两端节点 "),
                  createVNode("code", null, "config_version"),
                  createTextVNode(" 递增；现场 WG 配置需与 Agent/脚本同步。 ")
                ]),
                _: 1
              }),
              createVNode(_component_el_form, { "label-width": "120px" }, {
                default: withCtx(() => [
                  createVNode(_component_el_form_item, { label: "隧道子网" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: tunnelForm.subnet,
                        "onUpdate:modelValue": ($event) => tunnelForm.subnet = $event,
                        placeholder: "如 172.16.0.0/30"
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "ip_a (node_a)" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: tunnelForm.ip_a,
                        "onUpdate:modelValue": ($event) => tunnelForm.ip_a = $event
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "ip_b (node_b)" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: tunnelForm.ip_b,
                        "onUpdate:modelValue": ($event) => tunnelForm.ip_b = $event
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "WG 端口" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input_number, {
                        modelValue: tunnelForm.wg_port,
                        "onUpdate:modelValue": ($event) => tunnelForm.wg_port = $event,
                        min: 1,
                        max: 65535
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  })
                ]),
                _: 1
              })
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(ssrRenderComponent(_component_el_dialog, {
        modelValue: rotateDeployVisible.value,
        "onUpdate:modelValue": ($event) => rotateDeployVisible.value = $event,
        title: "新的部署命令",
        width: "680px",
        "destroy-on-close": ""
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_alert, {
              type: "success",
              closable: false,
              style: { "margin-bottom": "16px" }
            }, {
              title: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(` 已换发 Bootstrap Token：<code data-v-4dd96569${_scopeId2}>${ssrInterpolate(rotateData.token)}</code>`);
                } else {
                  return [
                    createTextVNode(" 已换发 Bootstrap Token："),
                    createVNode("code", null, toDisplayString(rotateData.token), 1)
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            if (rotateData.deployUrlNote) {
              _push2(ssrRenderComponent(_component_el_alert, {
                type: "info",
                closable: false,
                style: { "margin-bottom": "12px" }
              }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(`${ssrInterpolate(rotateData.deployUrlNote)}`);
                  } else {
                    return [
                      createTextVNode(toDisplayString(rotateData.deployUrlNote), 1)
                    ];
                  }
                }),
                _: 1
              }, _parent2, _scopeId));
            } else {
              _push2(`<!---->`);
            }
            if (rotateData.deployUrlWarning) {
              _push2(ssrRenderComponent(_component_el_alert, {
                type: "warning",
                closable: false,
                "show-icon": "",
                style: { "margin-bottom": "16px" }
              }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(`${ssrInterpolate(rotateData.deployUrlWarning)}`);
                  } else {
                    return [
                      createTextVNode(toDisplayString(rotateData.deployUrlWarning), 1)
                    ];
                  }
                }),
                _: 1
              }, _parent2, _scopeId));
            } else {
              _push2(`<!---->`);
            }
            if (rotateData.online) {
              _push2(ssrRenderComponent(_component_el_tabs, null, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(ssrRenderComponent(_component_el_tab_pane, { label: "在线（公网）" }, {
                      default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                        if (_push4) {
                          _push4(ssrRenderComponent(_component_el_input, {
                            type: "textarea",
                            rows: 3,
                            "model-value": rotateData.online,
                            readonly: ""
                          }, null, _parent4, _scopeId3));
                          _push4(ssrRenderComponent(_component_el_button, {
                            size: "small",
                            style: { "margin-top": "8px" },
                            onClick: ($event) => copyText(rotateData.online)
                          }, {
                            default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                              if (_push5) {
                                _push5(`复制`);
                              } else {
                                return [
                                  createTextVNode("复制")
                                ];
                              }
                            }),
                            _: 1
                          }, _parent4, _scopeId3));
                        } else {
                          return [
                            createVNode(_component_el_input, {
                              type: "textarea",
                              rows: 3,
                              "model-value": rotateData.online,
                              readonly: ""
                            }, null, 8, ["model-value"]),
                            createVNode(_component_el_button, {
                              size: "small",
                              style: { "margin-top": "8px" },
                              onClick: ($event) => copyText(rotateData.online)
                            }, {
                              default: withCtx(() => [
                                createTextVNode("复制")
                              ]),
                              _: 1
                            }, 8, ["onClick"])
                          ];
                        }
                      }),
                      _: 1
                    }, _parent3, _scopeId2));
                    if (rotateData.onlineLan) {
                      _push3(ssrRenderComponent(_component_el_tab_pane, { label: "在线（内网）" }, {
                        default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                          if (_push4) {
                            _push4(ssrRenderComponent(_component_el_input, {
                              type: "textarea",
                              rows: 3,
                              "model-value": rotateData.onlineLan,
                              readonly: ""
                            }, null, _parent4, _scopeId3));
                            _push4(ssrRenderComponent(_component_el_button, {
                              size: "small",
                              style: { "margin-top": "8px" },
                              onClick: ($event) => copyText(rotateData.onlineLan)
                            }, {
                              default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                                if (_push5) {
                                  _push5(`复制`);
                                } else {
                                  return [
                                    createTextVNode("复制")
                                  ];
                                }
                              }),
                              _: 1
                            }, _parent4, _scopeId3));
                          } else {
                            return [
                              createVNode(_component_el_input, {
                                type: "textarea",
                                rows: 3,
                                "model-value": rotateData.onlineLan,
                                readonly: ""
                              }, null, 8, ["model-value"]),
                              createVNode(_component_el_button, {
                                size: "small",
                                style: { "margin-top": "8px" },
                                onClick: ($event) => copyText(rotateData.onlineLan)
                              }, {
                                default: withCtx(() => [
                                  createTextVNode("复制")
                                ]),
                                _: 1
                              }, 8, ["onClick"])
                            ];
                          }
                        }),
                        _: 1
                      }, _parent3, _scopeId2));
                    } else {
                      _push3(`<!---->`);
                    }
                    if (rotateData.offline) {
                      _push3(ssrRenderComponent(_component_el_tab_pane, { label: "离网（公网）" }, {
                        default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                          if (_push4) {
                            _push4(ssrRenderComponent(_component_el_input, {
                              type: "textarea",
                              rows: 3,
                              "model-value": rotateData.offline,
                              readonly: ""
                            }, null, _parent4, _scopeId3));
                            _push4(ssrRenderComponent(_component_el_button, {
                              size: "small",
                              style: { "margin-top": "8px" },
                              onClick: ($event) => copyText(rotateData.offline)
                            }, {
                              default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                                if (_push5) {
                                  _push5(`复制`);
                                } else {
                                  return [
                                    createTextVNode("复制")
                                  ];
                                }
                              }),
                              _: 1
                            }, _parent4, _scopeId3));
                            if (rotateData.scriptUrl) {
                              _push4(ssrRenderComponent(_component_el_text, {
                                type: "info",
                                size: "small",
                                style: { "display": "block", "margin-top": "8px" }
                              }, {
                                default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                                  if (_push5) {
                                    _push5(` 或下载脚本：`);
                                    _push5(ssrRenderComponent(_component_el_link, {
                                      href: rotateData.scriptUrl,
                                      target: "_blank",
                                      type: "primary"
                                    }, {
                                      default: withCtx((_5, _push6, _parent6, _scopeId5) => {
                                        if (_push6) {
                                          _push6(`node-setup.sh`);
                                        } else {
                                          return [
                                            createTextVNode("node-setup.sh")
                                          ];
                                        }
                                      }),
                                      _: 1
                                    }, _parent5, _scopeId4));
                                  } else {
                                    return [
                                      createTextVNode(" 或下载脚本："),
                                      createVNode(_component_el_link, {
                                        href: rotateData.scriptUrl,
                                        target: "_blank",
                                        type: "primary"
                                      }, {
                                        default: withCtx(() => [
                                          createTextVNode("node-setup.sh")
                                        ]),
                                        _: 1
                                      }, 8, ["href"])
                                    ];
                                  }
                                }),
                                _: 1
                              }, _parent4, _scopeId3));
                            } else {
                              _push4(`<!---->`);
                            }
                          } else {
                            return [
                              createVNode(_component_el_input, {
                                type: "textarea",
                                rows: 3,
                                "model-value": rotateData.offline,
                                readonly: ""
                              }, null, 8, ["model-value"]),
                              createVNode(_component_el_button, {
                                size: "small",
                                style: { "margin-top": "8px" },
                                onClick: ($event) => copyText(rotateData.offline)
                              }, {
                                default: withCtx(() => [
                                  createTextVNode("复制")
                                ]),
                                _: 1
                              }, 8, ["onClick"]),
                              rotateData.scriptUrl ? (openBlock(), createBlock(_component_el_text, {
                                key: 0,
                                type: "info",
                                size: "small",
                                style: { "display": "block", "margin-top": "8px" }
                              }, {
                                default: withCtx(() => [
                                  createTextVNode(" 或下载脚本："),
                                  createVNode(_component_el_link, {
                                    href: rotateData.scriptUrl,
                                    target: "_blank",
                                    type: "primary"
                                  }, {
                                    default: withCtx(() => [
                                      createTextVNode("node-setup.sh")
                                    ]),
                                    _: 1
                                  }, 8, ["href"])
                                ]),
                                _: 1
                              })) : createCommentVNode("", true)
                            ];
                          }
                        }),
                        _: 1
                      }, _parent3, _scopeId2));
                    } else {
                      _push3(`<!---->`);
                    }
                    if (rotateData.offlineLan) {
                      _push3(ssrRenderComponent(_component_el_tab_pane, { label: "离网（内网）" }, {
                        default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                          if (_push4) {
                            _push4(ssrRenderComponent(_component_el_input, {
                              type: "textarea",
                              rows: 3,
                              "model-value": rotateData.offlineLan,
                              readonly: ""
                            }, null, _parent4, _scopeId3));
                            _push4(ssrRenderComponent(_component_el_button, {
                              size: "small",
                              style: { "margin-top": "8px" },
                              onClick: ($event) => copyText(rotateData.offlineLan)
                            }, {
                              default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                                if (_push5) {
                                  _push5(`复制`);
                                } else {
                                  return [
                                    createTextVNode("复制")
                                  ];
                                }
                              }),
                              _: 1
                            }, _parent4, _scopeId3));
                            if (rotateData.scriptUrlLan) {
                              _push4(ssrRenderComponent(_component_el_text, {
                                type: "info",
                                size: "small",
                                style: { "display": "block", "margin-top": "8px" }
                              }, {
                                default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                                  if (_push5) {
                                    _push5(` 或下载脚本：`);
                                    _push5(ssrRenderComponent(_component_el_link, {
                                      href: rotateData.scriptUrlLan,
                                      target: "_blank",
                                      type: "primary"
                                    }, {
                                      default: withCtx((_5, _push6, _parent6, _scopeId5) => {
                                        if (_push6) {
                                          _push6(`node-setup.sh`);
                                        } else {
                                          return [
                                            createTextVNode("node-setup.sh")
                                          ];
                                        }
                                      }),
                                      _: 1
                                    }, _parent5, _scopeId4));
                                  } else {
                                    return [
                                      createTextVNode(" 或下载脚本："),
                                      createVNode(_component_el_link, {
                                        href: rotateData.scriptUrlLan,
                                        target: "_blank",
                                        type: "primary"
                                      }, {
                                        default: withCtx(() => [
                                          createTextVNode("node-setup.sh")
                                        ]),
                                        _: 1
                                      }, 8, ["href"])
                                    ];
                                  }
                                }),
                                _: 1
                              }, _parent4, _scopeId3));
                            } else {
                              _push4(`<!---->`);
                            }
                          } else {
                            return [
                              createVNode(_component_el_input, {
                                type: "textarea",
                                rows: 3,
                                "model-value": rotateData.offlineLan,
                                readonly: ""
                              }, null, 8, ["model-value"]),
                              createVNode(_component_el_button, {
                                size: "small",
                                style: { "margin-top": "8px" },
                                onClick: ($event) => copyText(rotateData.offlineLan)
                              }, {
                                default: withCtx(() => [
                                  createTextVNode("复制")
                                ]),
                                _: 1
                              }, 8, ["onClick"]),
                              rotateData.scriptUrlLan ? (openBlock(), createBlock(_component_el_text, {
                                key: 0,
                                type: "info",
                                size: "small",
                                style: { "display": "block", "margin-top": "8px" }
                              }, {
                                default: withCtx(() => [
                                  createTextVNode(" 或下载脚本："),
                                  createVNode(_component_el_link, {
                                    href: rotateData.scriptUrlLan,
                                    target: "_blank",
                                    type: "primary"
                                  }, {
                                    default: withCtx(() => [
                                      createTextVNode("node-setup.sh")
                                    ]),
                                    _: 1
                                  }, 8, ["href"])
                                ]),
                                _: 1
                              })) : createCommentVNode("", true)
                            ];
                          }
                        }),
                        _: 1
                      }, _parent3, _scopeId2));
                    } else {
                      _push3(`<!---->`);
                    }
                  } else {
                    return [
                      createVNode(_component_el_tab_pane, { label: "在线（公网）" }, {
                        default: withCtx(() => [
                          createVNode(_component_el_input, {
                            type: "textarea",
                            rows: 3,
                            "model-value": rotateData.online,
                            readonly: ""
                          }, null, 8, ["model-value"]),
                          createVNode(_component_el_button, {
                            size: "small",
                            style: { "margin-top": "8px" },
                            onClick: ($event) => copyText(rotateData.online)
                          }, {
                            default: withCtx(() => [
                              createTextVNode("复制")
                            ]),
                            _: 1
                          }, 8, ["onClick"])
                        ]),
                        _: 1
                      }),
                      rotateData.onlineLan ? (openBlock(), createBlock(_component_el_tab_pane, {
                        key: 0,
                        label: "在线（内网）"
                      }, {
                        default: withCtx(() => [
                          createVNode(_component_el_input, {
                            type: "textarea",
                            rows: 3,
                            "model-value": rotateData.onlineLan,
                            readonly: ""
                          }, null, 8, ["model-value"]),
                          createVNode(_component_el_button, {
                            size: "small",
                            style: { "margin-top": "8px" },
                            onClick: ($event) => copyText(rotateData.onlineLan)
                          }, {
                            default: withCtx(() => [
                              createTextVNode("复制")
                            ]),
                            _: 1
                          }, 8, ["onClick"])
                        ]),
                        _: 1
                      })) : createCommentVNode("", true),
                      rotateData.offline ? (openBlock(), createBlock(_component_el_tab_pane, {
                        key: 1,
                        label: "离网（公网）"
                      }, {
                        default: withCtx(() => [
                          createVNode(_component_el_input, {
                            type: "textarea",
                            rows: 3,
                            "model-value": rotateData.offline,
                            readonly: ""
                          }, null, 8, ["model-value"]),
                          createVNode(_component_el_button, {
                            size: "small",
                            style: { "margin-top": "8px" },
                            onClick: ($event) => copyText(rotateData.offline)
                          }, {
                            default: withCtx(() => [
                              createTextVNode("复制")
                            ]),
                            _: 1
                          }, 8, ["onClick"]),
                          rotateData.scriptUrl ? (openBlock(), createBlock(_component_el_text, {
                            key: 0,
                            type: "info",
                            size: "small",
                            style: { "display": "block", "margin-top": "8px" }
                          }, {
                            default: withCtx(() => [
                              createTextVNode(" 或下载脚本："),
                              createVNode(_component_el_link, {
                                href: rotateData.scriptUrl,
                                target: "_blank",
                                type: "primary"
                              }, {
                                default: withCtx(() => [
                                  createTextVNode("node-setup.sh")
                                ]),
                                _: 1
                              }, 8, ["href"])
                            ]),
                            _: 1
                          })) : createCommentVNode("", true)
                        ]),
                        _: 1
                      })) : createCommentVNode("", true),
                      rotateData.offlineLan ? (openBlock(), createBlock(_component_el_tab_pane, {
                        key: 2,
                        label: "离网（内网）"
                      }, {
                        default: withCtx(() => [
                          createVNode(_component_el_input, {
                            type: "textarea",
                            rows: 3,
                            "model-value": rotateData.offlineLan,
                            readonly: ""
                          }, null, 8, ["model-value"]),
                          createVNode(_component_el_button, {
                            size: "small",
                            style: { "margin-top": "8px" },
                            onClick: ($event) => copyText(rotateData.offlineLan)
                          }, {
                            default: withCtx(() => [
                              createTextVNode("复制")
                            ]),
                            _: 1
                          }, 8, ["onClick"]),
                          rotateData.scriptUrlLan ? (openBlock(), createBlock(_component_el_text, {
                            key: 0,
                            type: "info",
                            size: "small",
                            style: { "display": "block", "margin-top": "8px" }
                          }, {
                            default: withCtx(() => [
                              createTextVNode(" 或下载脚本："),
                              createVNode(_component_el_link, {
                                href: rotateData.scriptUrlLan,
                                target: "_blank",
                                type: "primary"
                              }, {
                                default: withCtx(() => [
                                  createTextVNode("node-setup.sh")
                                ]),
                                _: 1
                              }, 8, ["href"])
                            ]),
                            _: 1
                          })) : createCommentVNode("", true)
                        ]),
                        _: 1
                      })) : createCommentVNode("", true)
                    ];
                  }
                }),
                _: 1
              }, _parent2, _scopeId));
            } else {
              _push2(`<!---->`);
            }
          } else {
            return [
              createVNode(_component_el_alert, {
                type: "success",
                closable: false,
                style: { "margin-bottom": "16px" }
              }, {
                title: withCtx(() => [
                  createTextVNode(" 已换发 Bootstrap Token："),
                  createVNode("code", null, toDisplayString(rotateData.token), 1)
                ]),
                _: 1
              }),
              rotateData.deployUrlNote ? (openBlock(), createBlock(_component_el_alert, {
                key: 0,
                type: "info",
                closable: false,
                style: { "margin-bottom": "12px" }
              }, {
                default: withCtx(() => [
                  createTextVNode(toDisplayString(rotateData.deployUrlNote), 1)
                ]),
                _: 1
              })) : createCommentVNode("", true),
              rotateData.deployUrlWarning ? (openBlock(), createBlock(_component_el_alert, {
                key: 1,
                type: "warning",
                closable: false,
                "show-icon": "",
                style: { "margin-bottom": "16px" }
              }, {
                default: withCtx(() => [
                  createTextVNode(toDisplayString(rotateData.deployUrlWarning), 1)
                ]),
                _: 1
              })) : createCommentVNode("", true),
              rotateData.online ? (openBlock(), createBlock(_component_el_tabs, { key: 2 }, {
                default: withCtx(() => [
                  createVNode(_component_el_tab_pane, { label: "在线（公网）" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        type: "textarea",
                        rows: 3,
                        "model-value": rotateData.online,
                        readonly: ""
                      }, null, 8, ["model-value"]),
                      createVNode(_component_el_button, {
                        size: "small",
                        style: { "margin-top": "8px" },
                        onClick: ($event) => copyText(rotateData.online)
                      }, {
                        default: withCtx(() => [
                          createTextVNode("复制")
                        ]),
                        _: 1
                      }, 8, ["onClick"])
                    ]),
                    _: 1
                  }),
                  rotateData.onlineLan ? (openBlock(), createBlock(_component_el_tab_pane, {
                    key: 0,
                    label: "在线（内网）"
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        type: "textarea",
                        rows: 3,
                        "model-value": rotateData.onlineLan,
                        readonly: ""
                      }, null, 8, ["model-value"]),
                      createVNode(_component_el_button, {
                        size: "small",
                        style: { "margin-top": "8px" },
                        onClick: ($event) => copyText(rotateData.onlineLan)
                      }, {
                        default: withCtx(() => [
                          createTextVNode("复制")
                        ]),
                        _: 1
                      }, 8, ["onClick"])
                    ]),
                    _: 1
                  })) : createCommentVNode("", true),
                  rotateData.offline ? (openBlock(), createBlock(_component_el_tab_pane, {
                    key: 1,
                    label: "离网（公网）"
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        type: "textarea",
                        rows: 3,
                        "model-value": rotateData.offline,
                        readonly: ""
                      }, null, 8, ["model-value"]),
                      createVNode(_component_el_button, {
                        size: "small",
                        style: { "margin-top": "8px" },
                        onClick: ($event) => copyText(rotateData.offline)
                      }, {
                        default: withCtx(() => [
                          createTextVNode("复制")
                        ]),
                        _: 1
                      }, 8, ["onClick"]),
                      rotateData.scriptUrl ? (openBlock(), createBlock(_component_el_text, {
                        key: 0,
                        type: "info",
                        size: "small",
                        style: { "display": "block", "margin-top": "8px" }
                      }, {
                        default: withCtx(() => [
                          createTextVNode(" 或下载脚本："),
                          createVNode(_component_el_link, {
                            href: rotateData.scriptUrl,
                            target: "_blank",
                            type: "primary"
                          }, {
                            default: withCtx(() => [
                              createTextVNode("node-setup.sh")
                            ]),
                            _: 1
                          }, 8, ["href"])
                        ]),
                        _: 1
                      })) : createCommentVNode("", true)
                    ]),
                    _: 1
                  })) : createCommentVNode("", true),
                  rotateData.offlineLan ? (openBlock(), createBlock(_component_el_tab_pane, {
                    key: 2,
                    label: "离网（内网）"
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        type: "textarea",
                        rows: 3,
                        "model-value": rotateData.offlineLan,
                        readonly: ""
                      }, null, 8, ["model-value"]),
                      createVNode(_component_el_button, {
                        size: "small",
                        style: { "margin-top": "8px" },
                        onClick: ($event) => copyText(rotateData.offlineLan)
                      }, {
                        default: withCtx(() => [
                          createTextVNode("复制")
                        ]),
                        _: 1
                      }, 8, ["onClick"]),
                      rotateData.scriptUrlLan ? (openBlock(), createBlock(_component_el_text, {
                        key: 0,
                        type: "info",
                        size: "small",
                        style: { "display": "block", "margin-top": "8px" }
                      }, {
                        default: withCtx(() => [
                          createTextVNode(" 或下载脚本："),
                          createVNode(_component_el_link, {
                            href: rotateData.scriptUrlLan,
                            target: "_blank",
                            type: "primary"
                          }, {
                            default: withCtx(() => [
                              createTextVNode("node-setup.sh")
                            ]),
                            _: 1
                          }, 8, ["href"])
                        ]),
                        _: 1
                      })) : createCommentVNode("", true)
                    ]),
                    _: 1
                  })) : createCommentVNode("", true)
                ]),
                _: 1
              })) : createCommentVNode("", true)
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div>`);
    };
  }
};
const _sfc_setup$a = _sfc_main$a.setup;
_sfc_main$a.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/views/NodeDetail.vue");
  return _sfc_setup$a ? _sfc_setup$a(props, ctx) : void 0;
};
const NodeDetail = /* @__PURE__ */ _export_sfc(_sfc_main$a, [["__scopeId", "data-v-4dd96569"]]);
const _sfc_main$9 = {
  __name: "Users",
  __ssrInlineRender: true,
  setup(__props) {
    const scopedWithoutNodesHint = computed(() => {
      const p = getAdminProfile();
      if ((p == null ? void 0 : p.node_scope) !== "scoped") return "";
      const ids = Array.isArray(p.node_ids) ? p.node_ids : [];
      if (ids.length > 0) return "";
      return "当前账号未分配任何节点，无法查看或新增 VPN 授权；请联系超级管理员在「管理员管理」中为您勾选可管辖节点。";
    });
    const scopedNodeHint = computed(() => {
      const p = getAdminProfile();
      if ((p == null ? void 0 : p.node_scope) !== "scoped") return "";
      if (!Array.isArray(p.node_ids) || p.node_ids.length === 0) return "";
      return "列表已隐藏「仅在其它节点存在未结授权、且与您管辖节点无任何授权记录」的用户（超级管理员仍可见全量）。您仅能管理所选节点上的 VPN 授权；外区授权在已吊销、吊销中或失败状态下不计入跨区占用；若仍存在其它跨区未结授权，对其「编辑」或「删除」将被禁用，请联系超级管理员处理。";
    });
    const rows = ref([]);
    const loading = ref(false);
    const search = ref("");
    const groupFilter = ref("");
    const showAdd = ref(false);
    const addLoading = ref(false);
    const addForm = reactive({ username: "", display_name: "", group_name: "" });
    const showEdit = ref(false);
    const editUserId = ref(null);
    const editForm = reactive({ display_name: "", group_name: "", status: "active" });
    const showGrants = ref(false);
    const grantUser = ref({});
    const grants = ref([]);
    const allInstances = ref([]);
    const newGrantInstanceId = ref(null);
    const grantLoading = ref(false);
    const grantsRefreshLoading = ref(false);
    const groups = computed(() => [...new Set(rows.value.map((r) => r.group_name))].sort());
    const filteredRows = computed(() => {
      let list = rows.value;
      if (groupFilter.value) {
        list = list.filter((r) => r.group_name === groupFilter.value);
      }
      if (search.value) {
        const q = search.value.toLowerCase();
        list = list.filter(
          (r) => (r.username || "").toLowerCase().includes(q) || (r.display_name || "").toLowerCase().includes(q)
        );
      }
      return list;
    });
    const modeMeshLabel = (mode) => {
      const m = { "node-direct": "直连", "cn-split": "分流", global: "全局" };
      return m[mode] || (mode ? String(mode) : "—");
    };
    const grantInstanceOptionLabel = (inst) => {
      const nm = (inst.node_name || "").trim() || inst.node_id || "—";
      const nid = inst.node_id || "—";
      const mesh = modeMeshLabel(inst.mode);
      const port = inst.port != null && inst.port !== "" ? inst.port : "—";
      return `${nm} (${nid}) / ${mesh} (${port})`;
    };
    const grantableInstances = computed(() => {
      const blocked = /* @__PURE__ */ new Set();
      for (const g of grants.value) {
        if (!["revoked", "failed"].includes(g.cert_status)) {
          blocked.add(g.instance_id);
        }
      }
      return allInstances.value.filter((inst) => inst.enabled === true && !blocked.has(inst.id));
    });
    const loadUsers = async () => {
      loading.value = true;
      try {
        rows.value = (await http.get("/api/users")).data.items || [];
      } finally {
        loading.value = false;
      }
    };
    const doAdd = async () => {
      addLoading.value = true;
      try {
        await http.post("/api/users", addForm);
        ElMessage.success("创建成功");
        showAdd.value = false;
        Object.assign(addForm, { username: "", display_name: "", group_name: "" });
        loadUsers();
      } finally {
        addLoading.value = false;
      }
    };
    const openEdit = (user) => {
      editUserId.value = user.id;
      editForm.display_name = user.display_name;
      editForm.group_name = user.group_name;
      editForm.status = user.status;
      showEdit.value = true;
    };
    const doEdit = async () => {
      try {
        await http.patch(`/api/users/${editUserId.value}`, editForm);
        ElMessage.success("已保存");
        showEdit.value = false;
        loadUsers();
      } catch {
      }
    };
    const deleteUser = async (id) => {
      try {
        await http.delete(`/api/users/${id}`);
        ElMessage.success("已删除");
        loadUsers();
      } catch {
      }
    };
    const openGrants = async (user) => {
      var _a, _b;
      grantUser.value = user;
      showGrants.value = true;
      const [g, n] = await Promise.all([
        http.get(`/api/users/${user.id}/grants`),
        http.get("/api/nodes")
      ]);
      grants.value = g.data.items || [];
      const insts = [];
      for (const item of n.data.items || []) {
        for (const inst of item.instances || []) {
          insts.push({
            ...inst,
            node_id: ((_a = item.node) == null ? void 0 : _a.id) || inst.node_id,
            node_name: ((_b = item.node) == null ? void 0 : _b.name) || ""
          });
        }
      }
      allInstances.value = insts;
    };
    const refreshGrants = async () => {
      var _a;
      const uid = (_a = grantUser.value) == null ? void 0 : _a.id;
      if (!uid) return;
      grantsRefreshLoading.value = true;
      try {
        const { data } = await http.get(`/api/users/${uid}/grants`);
        grants.value = data.items || [];
      } catch {
      } finally {
        grantsRefreshLoading.value = false;
      }
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitGrantStatus = async (grantId, expectedStatus, maxAttempts = 8, intervalMs = 1500) => {
      var _a;
      const uid = (_a = grantUser.value) == null ? void 0 : _a.id;
      if (!uid) return false;
      for (let i = 0; i < maxAttempts; i++) {
        const { data } = await http.get(`/api/users/${uid}/grants`);
        grants.value = data.items || [];
        const target = grants.value.find((g) => g.id === grantId);
        if ((target == null ? void 0 : target.cert_status) === expectedStatus) return true;
        await sleep(intervalMs);
      }
      return false;
    };
    const doGrant = async () => {
      if (!newGrantInstanceId.value) return;
      grantLoading.value = true;
      try {
        const { data } = await http.post(`/api/users/${grantUser.value.id}/grants`, {
          instance_id: newGrantInstanceId.value
        });
        ElMessage.success(data.reissued ? "已重新发起证书签发" : "授权成功");
        newGrantInstanceId.value = null;
        grants.value = (await http.get(`/api/users/${grantUser.value.id}/grants`)).data.items || [];
        await loadUsers();
      } catch {
      } finally {
        grantLoading.value = false;
      }
    };
    const safeOvpnBaseName = (cn) => {
      if (!cn || typeof cn !== "string") return "";
      const s = cn.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
      return s || "";
    };
    const filenameFromContentDisposition = (cd) => {
      if (!cd) return "";
      const mStar = /filename\*=UTF-8''([^;\s]+)/i.exec(cd);
      if (mStar) {
        try {
          return decodeURIComponent(mStar[1].replace(/^"|"$/g, ""));
        } catch {
          return mStar[1].replace(/^"|"$/g, "");
        }
      }
      const mQ = /filename="([^"]+)"/i.exec(cd);
      if (mQ) return mQ[1];
      const mU = /filename=([^;\s]+)/i.exec(cd);
      if (mU) return mU[1].replace(/^"|"$/g, "");
      return "";
    };
    const downloadOVPN = async (id, certCN) => {
      try {
        const res = await http.get(`/api/grants/${id}/download`, { responseType: "blob" });
        const disposition = res.headers["content-disposition"] || res.headers["Content-Disposition"] || "";
        const fromHeader = filenameFromContentDisposition(disposition);
        const fromCn = safeOvpnBaseName(certCN);
        const filename = fromHeader || (fromCn ? `${fromCn}.ovpn` : "") || `grant-${id}.ovpn`;
        const url = URL.createObjectURL(res.data);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      } catch {
        ElMessage.error("下载失败");
      }
    };
    const revokeGrant = async (id) => {
      var _a;
      try {
        await ElMessageBox.confirm("确定吊销？", "确认", { type: "warning" });
        const { data } = await http.delete(`/api/grants/${id}`);
        const status = (_a = data == null ? void 0 : data.grant) == null ? void 0 : _a.cert_status;
        if (status === "revoked") {
          ElMessage.success("已吊销");
        } else {
          ElMessage.success("已提交吊销请求，正在自动刷新状态...");
          const done = await waitGrantStatus(id, "revoked");
          if (done) {
            ElMessage.success("吊销已完成");
          } else {
            ElMessage.warning("吊销请求已提交，状态同步稍慢，请稍后手动刷新");
          }
        }
        grants.value = (await http.get(`/api/users/${grantUser.value.id}/grants`)).data.items || [];
        await loadUsers();
      } catch {
      }
    };
    const purgeGrant = async (id) => {
      try {
        await ElMessageBox.confirm(
          "将永久从数据库中删除该授权记录（含已吊销项），以便同一实例可重新授权且不再触发证书 CN 冲突。确定删除？",
          "删除授权记录",
          { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
        );
        await http.delete(`/api/grants/${id}/purge`);
        ElMessage.success("已删除记录");
        grants.value = (await http.get(`/api/users/${grantUser.value.id}/grants`)).data.items || [];
        await loadUsers();
      } catch {
      }
    };
    const retryIssue = async (id) => {
      try {
        await http.post(`/api/grants/${id}/retry-issue`);
        ElMessage.success("已重新向节点下发签发任务，请稍后刷新查看状态");
        grants.value = (await http.get(`/api/users/${grantUser.value.id}/grants`)).data.items || [];
        await loadUsers();
      } catch {
      }
    };
    onMounted(() => void loadUsers().catch(() => {
    }));
    return (_ctx, _push, _parent, _attrs) => {
      const _component_el_button = resolveComponent("el-button");
      const _component_el_icon = resolveComponent("el-icon");
      const _component_Plus = resolveComponent("Plus");
      const _component_el_alert = resolveComponent("el-alert");
      const _component_el_input = resolveComponent("el-input");
      const _component_el_select = resolveComponent("el-select");
      const _component_el_option = resolveComponent("el-option");
      const _component_el_text = resolveComponent("el-text");
      const _component_Key = resolveComponent("Key");
      const _component_el_tooltip = resolveComponent("el-tooltip");
      const _component_Edit = resolveComponent("Edit");
      const _component_el_popconfirm = resolveComponent("el-popconfirm");
      const _component_Delete = resolveComponent("Delete");
      const _component_el_empty = resolveComponent("el-empty");
      const _component_el_dialog = resolveComponent("el-dialog");
      const _component_el_form = resolveComponent("el-form");
      const _component_el_form_item = resolveComponent("el-form-item");
      const _component_Refresh = resolveComponent("Refresh");
      const _component_Close = resolveComponent("Close");
      const _component_el_tag = resolveComponent("el-tag");
      const _component_Download = resolveComponent("Download");
      const _component_CircleClose = resolveComponent("CircleClose");
      const _component_el_divider = resolveComponent("el-divider");
      const _directive_loading = resolveDirective("loading");
      _push(`<div${ssrRenderAttrs(_attrs)} data-v-28a03ad7><div class="page-card" data-v-28a03ad7><div class="page-card-header" data-v-28a03ad7><span class="page-card-title" data-v-28a03ad7>授权管理</span>`);
      _push(ssrRenderComponent(_component_el_button, {
        type: "primary",
        onClick: ($event) => showAdd.value = true
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_icon, null, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_Plus, null, null, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_Plus)
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(` 添加用户 `);
          } else {
            return [
              createVNode(_component_el_icon, null, {
                default: withCtx(() => [
                  createVNode(_component_Plus)
                ]),
                _: 1
              }),
              createTextVNode(" 添加用户 ")
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div>`);
      if (scopedWithoutNodesHint.value) {
        _push(ssrRenderComponent(_component_el_alert, {
          type: "warning",
          closable: false,
          "show-icon": "",
          style: { "margin-bottom": "12px" }
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`${ssrInterpolate(scopedWithoutNodesHint.value)}`);
            } else {
              return [
                createTextVNode(toDisplayString(scopedWithoutNodesHint.value), 1)
              ];
            }
          }),
          _: 1
        }, _parent));
      } else {
        _push(`<!---->`);
      }
      if (scopedNodeHint.value) {
        _push(ssrRenderComponent(_component_el_alert, {
          type: "info",
          closable: false,
          "show-icon": "",
          style: { "margin-bottom": "12px" }
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`${ssrInterpolate(scopedNodeHint.value)}`);
            } else {
              return [
                createTextVNode(toDisplayString(scopedNodeHint.value), 1)
              ];
            }
          }),
          _: 1
        }, _parent));
      } else {
        _push(`<!---->`);
      }
      _push(`<div class="action-bar" data-v-28a03ad7><div class="filter-group" data-v-28a03ad7>`);
      _push(ssrRenderComponent(_component_el_input, {
        modelValue: search.value,
        "onUpdate:modelValue": ($event) => search.value = $event,
        placeholder: "搜索用户名 / 姓名...",
        clearable: "",
        style: { "width": "220px" },
        "prefix-icon": unref(Search)
      }, null, _parent));
      _push(ssrRenderComponent(_component_el_select, {
        modelValue: groupFilter.value,
        "onUpdate:modelValue": ($event) => groupFilter.value = $event,
        placeholder: "按组筛选",
        clearable: "",
        style: { "width": "140px" }
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`<!--[-->`);
            ssrRenderList(groups.value, (g) => {
              _push2(ssrRenderComponent(_component_el_option, {
                key: g,
                label: g,
                value: g
              }, null, _parent2, _scopeId));
            });
            _push2(`<!--]-->`);
          } else {
            return [
              (openBlock(true), createBlock(Fragment, null, renderList(groups.value, (g) => {
                return openBlock(), createBlock(_component_el_option, {
                  key: g,
                  label: g,
                  value: g
                }, null, 8, ["label", "value"]);
              }), 128))
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div>`);
      _push(ssrRenderComponent(_component_el_text, {
        type: "info",
        size: "small"
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`共 ${ssrInterpolate(filteredRows.value.length)} 个用户`);
          } else {
            return [
              createTextVNode("共 " + toDisplayString(filteredRows.value.length) + " 个用户", 1)
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div><div${ssrRenderAttrs(mergeProps({ class: "record-grid" }, ssrGetDirectiveProps(_ctx, _directive_loading, loading.value)))} data-v-28a03ad7><!--[-->`);
      ssrRenderList(filteredRows.value, (row) => {
        _push(`<div class="${ssrRenderClass([unref(recordCardToneClass)("user", row.status), "record-card"])}" data-v-28a03ad7><div class="record-card__head" data-v-28a03ad7><div class="min-w-0" data-v-28a03ad7><div class="record-card__title" data-v-28a03ad7>${ssrInterpolate(row.username)}</div><div class="record-card__meta" data-v-28a03ad7>${ssrInterpolate(row.display_name || "—")} · ${ssrInterpolate(row.group_name || "default")}</div></div><span data-v-28a03ad7><span class="${ssrRenderClass([`status-dot--${row.status}`, "status-dot"])}" data-v-28a03ad7></span> ${ssrInterpolate(unref(getStatusInfo)("user", row.status).label)}</span></div><div class="record-card__actions" data-v-28a03ad7>`);
        _push(ssrRenderComponent(_component_el_button, {
          size: "small",
          plain: "",
          type: "primary",
          onClick: ($event) => openGrants(row)
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(ssrRenderComponent(_component_el_icon, null, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(ssrRenderComponent(_component_Key, null, null, _parent3, _scopeId2));
                  } else {
                    return [
                      createVNode(_component_Key)
                    ];
                  }
                }),
                _: 2
              }, _parent2, _scopeId));
              _push2(` 授权 `);
            } else {
              return [
                createVNode(_component_el_icon, null, {
                  default: withCtx(() => [
                    createVNode(_component_Key)
                  ]),
                  _: 1
                }),
                createTextVNode(" 授权 ")
              ];
            }
          }),
          _: 2
        }, _parent));
        _push(ssrRenderComponent(_component_el_tooltip, {
          disabled: !row.cross_scope_edit_blocked,
          content: "该用户在其它节点仍有有效 VPN 授权，无法在此编辑整户资料；请联系超级管理员。",
          placement: "top"
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`<span class="action-tooltip-wrap" data-v-28a03ad7${_scopeId}>`);
              _push2(ssrRenderComponent(_component_el_button, {
                size: "small",
                plain: "",
                type: "primary",
                disabled: !!row.cross_scope_edit_blocked,
                onClick: ($event) => openEdit(row)
              }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(ssrRenderComponent(_component_el_icon, null, {
                      default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                        if (_push4) {
                          _push4(ssrRenderComponent(_component_Edit, null, null, _parent4, _scopeId3));
                        } else {
                          return [
                            createVNode(_component_Edit)
                          ];
                        }
                      }),
                      _: 2
                    }, _parent3, _scopeId2));
                    _push3(` 编辑 `);
                  } else {
                    return [
                      createVNode(_component_el_icon, null, {
                        default: withCtx(() => [
                          createVNode(_component_Edit)
                        ]),
                        _: 1
                      }),
                      createTextVNode(" 编辑 ")
                    ];
                  }
                }),
                _: 2
              }, _parent2, _scopeId));
              _push2(`</span>`);
            } else {
              return [
                createVNode("span", { class: "action-tooltip-wrap" }, [
                  createVNode(_component_el_button, {
                    size: "small",
                    plain: "",
                    type: "primary",
                    disabled: !!row.cross_scope_edit_blocked,
                    onClick: ($event) => openEdit(row)
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_el_icon, null, {
                        default: withCtx(() => [
                          createVNode(_component_Edit)
                        ]),
                        _: 1
                      }),
                      createTextVNode(" 编辑 ")
                    ]),
                    _: 1
                  }, 8, ["disabled", "onClick"])
                ])
              ];
            }
          }),
          _: 2
        }, _parent));
        _push(ssrRenderComponent(_component_el_tooltip, {
          disabled: !row.cross_scope_edit_blocked,
          content: "该用户在其它节点仍有有效 VPN 授权，无法在此删除整户；请联系超级管理员。",
          placement: "top"
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`<span class="action-tooltip-wrap" data-v-28a03ad7${_scopeId}>`);
              _push2(ssrRenderComponent(_component_el_popconfirm, {
                title: "删除用户并吊销所有证书？",
                onConfirm: ($event) => deleteUser(row.id)
              }, {
                reference: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(ssrRenderComponent(_component_el_button, {
                      size: "small",
                      plain: "",
                      type: "danger",
                      disabled: !!row.cross_scope_edit_blocked
                    }, {
                      default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                        if (_push4) {
                          _push4(ssrRenderComponent(_component_el_icon, null, {
                            default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                              if (_push5) {
                                _push5(ssrRenderComponent(_component_Delete, null, null, _parent5, _scopeId4));
                              } else {
                                return [
                                  createVNode(_component_Delete)
                                ];
                              }
                            }),
                            _: 2
                          }, _parent4, _scopeId3));
                          _push4(` 删除 `);
                        } else {
                          return [
                            createVNode(_component_el_icon, null, {
                              default: withCtx(() => [
                                createVNode(_component_Delete)
                              ]),
                              _: 1
                            }),
                            createTextVNode(" 删除 ")
                          ];
                        }
                      }),
                      _: 2
                    }, _parent3, _scopeId2));
                  } else {
                    return [
                      createVNode(_component_el_button, {
                        size: "small",
                        plain: "",
                        type: "danger",
                        disabled: !!row.cross_scope_edit_blocked
                      }, {
                        default: withCtx(() => [
                          createVNode(_component_el_icon, null, {
                            default: withCtx(() => [
                              createVNode(_component_Delete)
                            ]),
                            _: 1
                          }),
                          createTextVNode(" 删除 ")
                        ]),
                        _: 1
                      }, 8, ["disabled"])
                    ];
                  }
                }),
                _: 2
              }, _parent2, _scopeId));
              _push2(`</span>`);
            } else {
              return [
                createVNode("span", { class: "action-tooltip-wrap" }, [
                  createVNode(_component_el_popconfirm, {
                    title: "删除用户并吊销所有证书？",
                    onConfirm: ($event) => deleteUser(row.id)
                  }, {
                    reference: withCtx(() => [
                      createVNode(_component_el_button, {
                        size: "small",
                        plain: "",
                        type: "danger",
                        disabled: !!row.cross_scope_edit_blocked
                      }, {
                        default: withCtx(() => [
                          createVNode(_component_el_icon, null, {
                            default: withCtx(() => [
                              createVNode(_component_Delete)
                            ]),
                            _: 1
                          }),
                          createTextVNode(" 删除 ")
                        ]),
                        _: 1
                      }, 8, ["disabled"])
                    ]),
                    _: 2
                  }, 1032, ["onConfirm"])
                ])
              ];
            }
          }),
          _: 2
        }, _parent));
        _push(`</div></div>`);
      });
      _push(`<!--]-->`);
      if (!loading.value && !filteredRows.value.length) {
        _push(ssrRenderComponent(_component_el_empty, {
          description: "暂无用户",
          "image-size": 60
        }, null, _parent));
      } else {
        _push(`<!---->`);
      }
      _push(`</div></div>`);
      _push(ssrRenderComponent(_component_el_dialog, {
        modelValue: showAdd.value,
        "onUpdate:modelValue": ($event) => showAdd.value = $event,
        title: "添加用户",
        width: "min(450px, 92vw)",
        "destroy-on-close": "",
        class: "user-form-dialog"
      }, {
        footer: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_button, {
              onClick: ($event) => showAdd.value = false
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`取消`);
                } else {
                  return [
                    createTextVNode("取消")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_button, {
              type: "primary",
              loading: addLoading.value,
              onClick: doAdd
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`确认`);
                } else {
                  return [
                    createTextVNode("确认")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_button, {
                onClick: ($event) => showAdd.value = false
              }, {
                default: withCtx(() => [
                  createTextVNode("取消")
                ]),
                _: 1
              }, 8, ["onClick"]),
              createVNode(_component_el_button, {
                type: "primary",
                loading: addLoading.value,
                onClick: doAdd
              }, {
                default: withCtx(() => [
                  createTextVNode("确认")
                ]),
                _: 1
              }, 8, ["loading"])
            ];
          }
        }),
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_form, {
              model: addForm,
              "label-width": "80px"
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "用户名" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: addForm.username,
                          "onUpdate:modelValue": ($event) => addForm.username = $event
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: addForm.username,
                            "onUpdate:modelValue": ($event) => addForm.username = $event
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "姓名" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: addForm.display_name,
                          "onUpdate:modelValue": ($event) => addForm.display_name = $event
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: addForm.display_name,
                            "onUpdate:modelValue": ($event) => addForm.display_name = $event
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "组" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: addForm.group_name,
                          "onUpdate:modelValue": ($event) => addForm.group_name = $event,
                          placeholder: "default"
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: addForm.group_name,
                            "onUpdate:modelValue": ($event) => addForm.group_name = $event,
                            placeholder: "default"
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_el_form_item, { label: "用户名" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: addForm.username,
                          "onUpdate:modelValue": ($event) => addForm.username = $event
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "姓名" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: addForm.display_name,
                          "onUpdate:modelValue": ($event) => addForm.display_name = $event
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "组" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: addForm.group_name,
                          "onUpdate:modelValue": ($event) => addForm.group_name = $event,
                          placeholder: "default"
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    })
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_form, {
                model: addForm,
                "label-width": "80px"
              }, {
                default: withCtx(() => [
                  createVNode(_component_el_form_item, { label: "用户名" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: addForm.username,
                        "onUpdate:modelValue": ($event) => addForm.username = $event
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "姓名" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: addForm.display_name,
                        "onUpdate:modelValue": ($event) => addForm.display_name = $event
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "组" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: addForm.group_name,
                        "onUpdate:modelValue": ($event) => addForm.group_name = $event,
                        placeholder: "default"
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  })
                ]),
                _: 1
              }, 8, ["model"])
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(ssrRenderComponent(_component_el_dialog, {
        modelValue: showEdit.value,
        "onUpdate:modelValue": ($event) => showEdit.value = $event,
        title: "编辑用户",
        width: "min(450px, 92vw)",
        "destroy-on-close": "",
        class: "user-form-dialog"
      }, {
        footer: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_button, {
              onClick: ($event) => showEdit.value = false
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`取消`);
                } else {
                  return [
                    createTextVNode("取消")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_button, {
              type: "primary",
              onClick: doEdit
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`保存`);
                } else {
                  return [
                    createTextVNode("保存")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_button, {
                onClick: ($event) => showEdit.value = false
              }, {
                default: withCtx(() => [
                  createTextVNode("取消")
                ]),
                _: 1
              }, 8, ["onClick"]),
              createVNode(_component_el_button, {
                type: "primary",
                onClick: doEdit
              }, {
                default: withCtx(() => [
                  createTextVNode("保存")
                ]),
                _: 1
              })
            ];
          }
        }),
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_form, {
              model: editForm,
              "label-width": "80px"
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "姓名" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: editForm.display_name,
                          "onUpdate:modelValue": ($event) => editForm.display_name = $event
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: editForm.display_name,
                            "onUpdate:modelValue": ($event) => editForm.display_name = $event
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "组" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: editForm.group_name,
                          "onUpdate:modelValue": ($event) => editForm.group_name = $event
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: editForm.group_name,
                            "onUpdate:modelValue": ($event) => editForm.group_name = $event
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "状态" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_select, {
                          modelValue: editForm.status,
                          "onUpdate:modelValue": ($event) => editForm.status = $event,
                          style: { "width": "100%" }
                        }, {
                          default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                            if (_push5) {
                              _push5(ssrRenderComponent(_component_el_option, {
                                label: "正常",
                                value: "active"
                              }, null, _parent5, _scopeId4));
                              _push5(ssrRenderComponent(_component_el_option, {
                                label: "禁用",
                                value: "disabled"
                              }, null, _parent5, _scopeId4));
                            } else {
                              return [
                                createVNode(_component_el_option, {
                                  label: "正常",
                                  value: "active"
                                }),
                                createVNode(_component_el_option, {
                                  label: "禁用",
                                  value: "disabled"
                                })
                              ];
                            }
                          }),
                          _: 1
                        }, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_select, {
                            modelValue: editForm.status,
                            "onUpdate:modelValue": ($event) => editForm.status = $event,
                            style: { "width": "100%" }
                          }, {
                            default: withCtx(() => [
                              createVNode(_component_el_option, {
                                label: "正常",
                                value: "active"
                              }),
                              createVNode(_component_el_option, {
                                label: "禁用",
                                value: "disabled"
                              })
                            ]),
                            _: 1
                          }, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_el_form_item, { label: "姓名" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: editForm.display_name,
                          "onUpdate:modelValue": ($event) => editForm.display_name = $event
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "组" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: editForm.group_name,
                          "onUpdate:modelValue": ($event) => editForm.group_name = $event
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "状态" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_select, {
                          modelValue: editForm.status,
                          "onUpdate:modelValue": ($event) => editForm.status = $event,
                          style: { "width": "100%" }
                        }, {
                          default: withCtx(() => [
                            createVNode(_component_el_option, {
                              label: "正常",
                              value: "active"
                            }),
                            createVNode(_component_el_option, {
                              label: "禁用",
                              value: "disabled"
                            })
                          ]),
                          _: 1
                        }, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    })
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_form, {
                model: editForm,
                "label-width": "80px"
              }, {
                default: withCtx(() => [
                  createVNode(_component_el_form_item, { label: "姓名" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: editForm.display_name,
                        "onUpdate:modelValue": ($event) => editForm.display_name = $event
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "组" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: editForm.group_name,
                        "onUpdate:modelValue": ($event) => editForm.group_name = $event
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "状态" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_select, {
                        modelValue: editForm.status,
                        "onUpdate:modelValue": ($event) => editForm.status = $event,
                        style: { "width": "100%" }
                      }, {
                        default: withCtx(() => [
                          createVNode(_component_el_option, {
                            label: "正常",
                            value: "active"
                          }),
                          createVNode(_component_el_option, {
                            label: "禁用",
                            value: "disabled"
                          })
                        ]),
                        _: 1
                      }, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  })
                ]),
                _: 1
              }, 8, ["model"])
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(ssrRenderComponent(_component_el_dialog, {
        modelValue: showGrants.value,
        "onUpdate:modelValue": ($event) => showGrants.value = $event,
        width: "min(720px, 94vw)",
        "destroy-on-close": "",
        "show-close": false,
        class: "grant-dialog"
      }, {
        header: withCtx(({ titleId, titleClass, close }, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`<div class="grant-dialog-header" data-v-28a03ad7${_scopeId}><span${ssrRenderAttr("id", titleId)} class="${ssrRenderClass(titleClass)}" data-v-28a03ad7${_scopeId}> 授权管理 - ${ssrInterpolate(grantUser.value.display_name || grantUser.value.username)}</span><span class="grant-dialog-header__actions" data-v-28a03ad7${_scopeId}>`);
            _push2(ssrRenderComponent(_component_el_tooltip, {
              content: "刷新状态",
              placement: "bottom"
            }, {
              default: withCtx((_, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_button, {
                    text: "",
                    circle: "",
                    loading: grantsRefreshLoading.value,
                    onClick: refreshGrants
                  }, {
                    default: withCtx((_2, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_icon, null, {
                          default: withCtx((_3, _push5, _parent5, _scopeId4) => {
                            if (_push5) {
                              _push5(ssrRenderComponent(_component_Refresh, null, null, _parent5, _scopeId4));
                            } else {
                              return [
                                createVNode(_component_Refresh)
                              ];
                            }
                          }),
                          _: 2
                        }, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_icon, null, {
                            default: withCtx(() => [
                              createVNode(_component_Refresh)
                            ]),
                            _: 1
                          })
                        ];
                      }
                    }),
                    _: 2
                  }, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_el_button, {
                      text: "",
                      circle: "",
                      loading: grantsRefreshLoading.value,
                      onClick: refreshGrants
                    }, {
                      default: withCtx(() => [
                        createVNode(_component_el_icon, null, {
                          default: withCtx(() => [
                            createVNode(_component_Refresh)
                          ]),
                          _: 1
                        })
                      ]),
                      _: 1
                    }, 8, ["loading"])
                  ];
                }
              }),
              _: 2
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_button, {
              text: "",
              circle: "",
              class: "grant-dialog-header__close",
              onClick: close
            }, {
              default: withCtx((_, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_icon, { class: "el-dialog__close" }, {
                    default: withCtx((_2, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_Close, null, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_Close)
                        ];
                      }
                    }),
                    _: 2
                  }, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_el_icon, { class: "el-dialog__close" }, {
                      default: withCtx(() => [
                        createVNode(_component_Close)
                      ]),
                      _: 1
                    })
                  ];
                }
              }),
              _: 2
            }, _parent2, _scopeId));
            _push2(`</span></div>`);
          } else {
            return [
              createVNode("div", { class: "grant-dialog-header" }, [
                createVNode("span", {
                  id: titleId,
                  class: titleClass
                }, " 授权管理 - " + toDisplayString(grantUser.value.display_name || grantUser.value.username), 11, ["id"]),
                createVNode("span", { class: "grant-dialog-header__actions" }, [
                  createVNode(_component_el_tooltip, {
                    content: "刷新状态",
                    placement: "bottom"
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_el_button, {
                        text: "",
                        circle: "",
                        loading: grantsRefreshLoading.value,
                        onClick: refreshGrants
                      }, {
                        default: withCtx(() => [
                          createVNode(_component_el_icon, null, {
                            default: withCtx(() => [
                              createVNode(_component_Refresh)
                            ]),
                            _: 1
                          })
                        ]),
                        _: 1
                      }, 8, ["loading"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_button, {
                    text: "",
                    circle: "",
                    class: "grant-dialog-header__close",
                    onClick: close
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_el_icon, { class: "el-dialog__close" }, {
                        default: withCtx(() => [
                          createVNode(_component_Close)
                        ]),
                        _: 1
                      })
                    ]),
                    _: 1
                  }, 8, ["onClick"])
                ])
              ])
            ];
          }
        }),
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`<div class="dialog-record-stack mb-md" data-v-28a03ad7${_scopeId}><!--[-->`);
            ssrRenderList(grants.value, (row) => {
              _push2(`<div class="${ssrRenderClass([unref(recordCardToneClass)("cert", row.cert_status), "record-card"])}" data-v-28a03ad7${_scopeId}><div class="record-card__head" data-v-28a03ad7${_scopeId}><div class="min-w-0" data-v-28a03ad7${_scopeId}><div class="record-card__title mono-text" data-v-28a03ad7${_scopeId}>${ssrInterpolate(row.cert_cn)}</div></div>`);
              _push2(ssrRenderComponent(_component_el_tag, {
                type: unref(getStatusInfo)("cert", row.cert_status).type,
                size: "small"
              }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(`${ssrInterpolate(unref(getStatusInfo)("cert", row.cert_status).label)}`);
                  } else {
                    return [
                      createTextVNode(toDisplayString(unref(getStatusInfo)("cert", row.cert_status).label), 1)
                    ];
                  }
                }),
                _: 2
              }, _parent2, _scopeId));
              _push2(`</div><div class="record-card__actions" data-v-28a03ad7${_scopeId}>`);
              if (["pending", "placeholder", "failed"].includes(row.cert_status)) {
                _push2(ssrRenderComponent(_component_el_button, {
                  size: "small",
                  plain: "",
                  type: "warning",
                  onClick: ($event) => retryIssue(row.id)
                }, {
                  default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(` 重试签发 `);
                    } else {
                      return [
                        createTextVNode(" 重试签发 ")
                      ];
                    }
                  }),
                  _: 2
                }, _parent2, _scopeId));
              } else {
                _push2(`<!---->`);
              }
              _push2(ssrRenderComponent(_component_el_button, {
                size: "small",
                plain: "",
                type: "primary",
                onClick: ($event) => downloadOVPN(row.id, row.cert_cn),
                disabled: !["active", "placeholder"].includes(row.cert_status)
              }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(ssrRenderComponent(_component_el_icon, null, {
                      default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                        if (_push4) {
                          _push4(ssrRenderComponent(_component_Download, null, null, _parent4, _scopeId3));
                        } else {
                          return [
                            createVNode(_component_Download)
                          ];
                        }
                      }),
                      _: 2
                    }, _parent3, _scopeId2));
                    _push3(` 下载 `);
                  } else {
                    return [
                      createVNode(_component_el_icon, null, {
                        default: withCtx(() => [
                          createVNode(_component_Download)
                        ]),
                        _: 1
                      }),
                      createTextVNode(" 下载 ")
                    ];
                  }
                }),
                _: 2
              }, _parent2, _scopeId));
              _push2(ssrRenderComponent(_component_el_button, {
                size: "small",
                plain: "",
                type: "danger",
                onClick: ($event) => revokeGrant(row.id),
                disabled: ["revoked", "revoking"].includes(row.cert_status)
              }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(ssrRenderComponent(_component_el_icon, null, {
                      default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                        if (_push4) {
                          _push4(ssrRenderComponent(_component_CircleClose, null, null, _parent4, _scopeId3));
                        } else {
                          return [
                            createVNode(_component_CircleClose)
                          ];
                        }
                      }),
                      _: 2
                    }, _parent3, _scopeId2));
                    _push3(` 吊销 `);
                  } else {
                    return [
                      createVNode(_component_el_icon, null, {
                        default: withCtx(() => [
                          createVNode(_component_CircleClose)
                        ]),
                        _: 1
                      }),
                      createTextVNode(" 吊销 ")
                    ];
                  }
                }),
                _: 2
              }, _parent2, _scopeId));
              _push2(ssrRenderComponent(_component_el_button, {
                size: "small",
                plain: "",
                type: "danger",
                onClick: ($event) => purgeGrant(row.id),
                disabled: row.cert_status === "active"
              }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(` 删除 `);
                  } else {
                    return [
                      createTextVNode(" 删除 ")
                    ];
                  }
                }),
                _: 2
              }, _parent2, _scopeId));
              _push2(`</div></div>`);
            });
            _push2(`<!--]-->`);
            if (!grants.value.length) {
              _push2(ssrRenderComponent(_component_el_empty, {
                description: "暂无授权",
                "image-size": 48
              }, null, _parent2, _scopeId));
            } else {
              _push2(`<!---->`);
            }
            _push2(`</div>`);
            _push2(ssrRenderComponent(_component_el_text, {
              type: "info",
              size: "small",
              style: { "display": "block", "margin-top": "8px" }
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(` 下载将自动返回与节点实例协议一致的配置文件。 `);
                } else {
                  return [
                    createTextVNode(" 下载将自动返回与节点实例协议一致的配置文件。 ")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_divider, null, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`添加新授权`);
                } else {
                  return [
                    createTextVNode("添加新授权")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            if (grantableInstances.value.length === 0) {
              _push2(ssrRenderComponent(_component_el_text, {
                type: "info",
                size: "small",
                class: "mb-md",
                style: { "display": "block" }
              }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(` 当前没有可新增的实例（实例可能已关闭、已全部授权，或仅存在可重新签发的已吊销项——请在上方列表操作）。 `);
                  } else {
                    return [
                      createTextVNode(" 当前没有可新增的实例（实例可能已关闭、已全部授权，或仅存在可重新签发的已吊销项——请在上方列表操作）。 ")
                    ];
                  }
                }),
                _: 1
              }, _parent2, _scopeId));
            } else {
              _push2(`<!---->`);
            }
            _push2(`<div class="filter-group grant-create-row" data-v-28a03ad7${_scopeId}>`);
            _push2(ssrRenderComponent(_component_el_select, {
              modelValue: newGrantInstanceId.value,
              "onUpdate:modelValue": ($event) => newGrantInstanceId.value = $event,
              placeholder: "选择实例",
              class: "grant-instance-select",
              clearable: ""
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`<!--[-->`);
                  ssrRenderList(grantableInstances.value, (inst) => {
                    _push3(ssrRenderComponent(_component_el_option, {
                      key: inst.id,
                      label: grantInstanceOptionLabel(inst),
                      value: inst.id
                    }, null, _parent3, _scopeId2));
                  });
                  _push3(`<!--]-->`);
                } else {
                  return [
                    (openBlock(true), createBlock(Fragment, null, renderList(grantableInstances.value, (inst) => {
                      return openBlock(), createBlock(_component_el_option, {
                        key: inst.id,
                        label: grantInstanceOptionLabel(inst),
                        value: inst.id
                      }, null, 8, ["label", "value"]);
                    }), 128))
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_button, {
              type: "primary",
              class: "grant-create-btn",
              onClick: doGrant,
              loading: grantLoading.value,
              disabled: grantableInstances.value.length === 0
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_icon, null, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_Plus, null, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_Plus)
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(` 授权 `);
                } else {
                  return [
                    createVNode(_component_el_icon, null, {
                      default: withCtx(() => [
                        createVNode(_component_Plus)
                      ]),
                      _: 1
                    }),
                    createTextVNode(" 授权 ")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(`</div>`);
          } else {
            return [
              createVNode("div", { class: "dialog-record-stack mb-md" }, [
                (openBlock(true), createBlock(Fragment, null, renderList(grants.value, (row) => {
                  return openBlock(), createBlock("div", {
                    key: row.id,
                    class: ["record-card", unref(recordCardToneClass)("cert", row.cert_status)]
                  }, [
                    createVNode("div", { class: "record-card__head" }, [
                      createVNode("div", { class: "min-w-0" }, [
                        createVNode("div", { class: "record-card__title mono-text" }, toDisplayString(row.cert_cn), 1)
                      ]),
                      createVNode(_component_el_tag, {
                        type: unref(getStatusInfo)("cert", row.cert_status).type,
                        size: "small"
                      }, {
                        default: withCtx(() => [
                          createTextVNode(toDisplayString(unref(getStatusInfo)("cert", row.cert_status).label), 1)
                        ]),
                        _: 2
                      }, 1032, ["type"])
                    ]),
                    createVNode("div", { class: "record-card__actions" }, [
                      ["pending", "placeholder", "failed"].includes(row.cert_status) ? (openBlock(), createBlock(_component_el_button, {
                        key: 0,
                        size: "small",
                        plain: "",
                        type: "warning",
                        onClick: ($event) => retryIssue(row.id)
                      }, {
                        default: withCtx(() => [
                          createTextVNode(" 重试签发 ")
                        ]),
                        _: 1
                      }, 8, ["onClick"])) : createCommentVNode("", true),
                      createVNode(_component_el_button, {
                        size: "small",
                        plain: "",
                        type: "primary",
                        onClick: ($event) => downloadOVPN(row.id, row.cert_cn),
                        disabled: !["active", "placeholder"].includes(row.cert_status)
                      }, {
                        default: withCtx(() => [
                          createVNode(_component_el_icon, null, {
                            default: withCtx(() => [
                              createVNode(_component_Download)
                            ]),
                            _: 1
                          }),
                          createTextVNode(" 下载 ")
                        ]),
                        _: 1
                      }, 8, ["onClick", "disabled"]),
                      createVNode(_component_el_button, {
                        size: "small",
                        plain: "",
                        type: "danger",
                        onClick: ($event) => revokeGrant(row.id),
                        disabled: ["revoked", "revoking"].includes(row.cert_status)
                      }, {
                        default: withCtx(() => [
                          createVNode(_component_el_icon, null, {
                            default: withCtx(() => [
                              createVNode(_component_CircleClose)
                            ]),
                            _: 1
                          }),
                          createTextVNode(" 吊销 ")
                        ]),
                        _: 1
                      }, 8, ["onClick", "disabled"]),
                      createVNode(_component_el_button, {
                        size: "small",
                        plain: "",
                        type: "danger",
                        onClick: ($event) => purgeGrant(row.id),
                        disabled: row.cert_status === "active"
                      }, {
                        default: withCtx(() => [
                          createTextVNode(" 删除 ")
                        ]),
                        _: 1
                      }, 8, ["onClick", "disabled"])
                    ])
                  ], 2);
                }), 128)),
                !grants.value.length ? (openBlock(), createBlock(_component_el_empty, {
                  key: 0,
                  description: "暂无授权",
                  "image-size": 48
                })) : createCommentVNode("", true)
              ]),
              createVNode(_component_el_text, {
                type: "info",
                size: "small",
                style: { "display": "block", "margin-top": "8px" }
              }, {
                default: withCtx(() => [
                  createTextVNode(" 下载将自动返回与节点实例协议一致的配置文件。 ")
                ]),
                _: 1
              }),
              createVNode(_component_el_divider, null, {
                default: withCtx(() => [
                  createTextVNode("添加新授权")
                ]),
                _: 1
              }),
              grantableInstances.value.length === 0 ? (openBlock(), createBlock(_component_el_text, {
                key: 0,
                type: "info",
                size: "small",
                class: "mb-md",
                style: { "display": "block" }
              }, {
                default: withCtx(() => [
                  createTextVNode(" 当前没有可新增的实例（实例可能已关闭、已全部授权，或仅存在可重新签发的已吊销项——请在上方列表操作）。 ")
                ]),
                _: 1
              })) : createCommentVNode("", true),
              createVNode("div", { class: "filter-group grant-create-row" }, [
                createVNode(_component_el_select, {
                  modelValue: newGrantInstanceId.value,
                  "onUpdate:modelValue": ($event) => newGrantInstanceId.value = $event,
                  placeholder: "选择实例",
                  class: "grant-instance-select",
                  clearable: ""
                }, {
                  default: withCtx(() => [
                    (openBlock(true), createBlock(Fragment, null, renderList(grantableInstances.value, (inst) => {
                      return openBlock(), createBlock(_component_el_option, {
                        key: inst.id,
                        label: grantInstanceOptionLabel(inst),
                        value: inst.id
                      }, null, 8, ["label", "value"]);
                    }), 128))
                  ]),
                  _: 1
                }, 8, ["modelValue", "onUpdate:modelValue"]),
                createVNode(_component_el_button, {
                  type: "primary",
                  class: "grant-create-btn",
                  onClick: doGrant,
                  loading: grantLoading.value,
                  disabled: grantableInstances.value.length === 0
                }, {
                  default: withCtx(() => [
                    createVNode(_component_el_icon, null, {
                      default: withCtx(() => [
                        createVNode(_component_Plus)
                      ]),
                      _: 1
                    }),
                    createTextVNode(" 授权 ")
                  ]),
                  _: 1
                }, 8, ["loading", "disabled"])
              ])
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div>`);
    };
  }
};
const _sfc_setup$9 = _sfc_main$9.setup;
_sfc_main$9.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/views/Users.vue");
  return _sfc_setup$9 ? _sfc_setup$9(props, ctx) : void 0;
};
const Users = /* @__PURE__ */ _export_sfc(_sfc_main$9, [["__scopeId", "data-v-28a03ad7"]]);
const _sfc_main$8 = {
  __name: "Rules",
  __ssrInlineRender: true,
  setup(__props) {
    const ipListRows = ref([]);
    const loadingIP = ref(false);
    const updating = ref(false);
    const updateScope = ref("all");
    const ipSources = ref([]);
    const loadingSources = ref(false);
    const sourceApiSupported = ref(true);
    const showEditSource = ref(false);
    const sourceForm = reactive({
      scope: "domestic",
      primary_url: "",
      mirror_url: "",
      connect_timeout_sec: 8,
      max_time_sec: 30,
      retry_count: 2,
      enabled: true
    });
    const exceptions = ref([]);
    const loadingEx = ref(false);
    const showAddEx = ref(false);
    const exForm = reactive({ cidr: "", domain: "", direction: "foreign", note: "" });
    const loadIP = async () => {
      loadingIP.value = true;
      try {
        const resp = await http.get("/api/ip-list/status");
        const rows = resp.data.items || [];
        ipListRows.value = rows.map((row) => {
          if (!Object.prototype.hasOwnProperty.call(row, "domestic_version")) {
            return {
              node_id: row.node_id,
              domestic_version: row.version || "未更新",
              domestic_entry_count: row.entry_count || 0,
              domestic_last_update_at: row.last_update_at || "",
              overseas_version: "未更新",
              overseas_entry_count: 0,
              overseas_last_update_at: ""
            };
          }
          return row;
        });
      } finally {
        loadingIP.value = false;
      }
    };
    const loadSources = async () => {
      var _a;
      loadingSources.value = true;
      try {
        const resp = await http.get("/api/ip-list/sources", { meta: { suppress404: true } });
        ipSources.value = resp.data.items || [];
        sourceApiSupported.value = true;
      } catch (err) {
        if (((_a = err == null ? void 0 : err.response) == null ? void 0 : _a.status) === 404) {
          sourceApiSupported.value = false;
          ipSources.value = [];
          return;
        }
        throw err;
      } finally {
        loadingSources.value = false;
      }
    };
    const loadEx = async () => {
      loadingEx.value = true;
      try {
        exceptions.value = (await http.get("/api/ip-list/exceptions")).data.items || [];
      } finally {
        loadingEx.value = false;
      }
    };
    const triggerUpdate = async () => {
      var _a, _b;
      updating.value = true;
      try {
        const scope = sourceApiSupported.value ? updateScope.value : "all";
        const resp = await http.post("/api/ip-list/update", { scope });
        const sent = (_a = resp.data) == null ? void 0 : _a.sent_to;
        const total = (_b = resp.data) == null ? void 0 : _b.total_nodes;
        if (typeof sent === "number" && typeof total === "number") {
          if (sent === 0) {
            ElMessage.warning(
              `没有 WebSocket 在线的节点（0 / ${total}），指令未下发。请确认各节点 vpn-agent 已运行且能连上控制面。`
            );
          } else {
            ElMessage.success(`更新指令已下发（在线 ${sent} / 共 ${total} 节点）`);
          }
        } else {
          ElMessage.success("更新指令已下发");
        }
        setTimeout(loadIP, 3e3);
      } finally {
        updating.value = false;
      }
    };
    const openEditSource = (row) => {
      if (!sourceApiSupported.value) return;
      Object.assign(sourceForm, row);
      showEditSource.value = true;
    };
    const saveSource = async () => {
      try {
        await http.patch(`/api/ip-list/sources/${sourceForm.scope}`, {
          primary_url: sourceForm.primary_url,
          mirror_url: sourceForm.mirror_url,
          connect_timeout_sec: sourceForm.connect_timeout_sec,
          max_time_sec: sourceForm.max_time_sec,
          retry_count: sourceForm.retry_count,
          enabled: sourceForm.enabled
        });
        ElMessage.success("同步源已更新");
        showEditSource.value = false;
        loadSources();
      } catch {
      }
    };
    const doAddEx = async () => {
      try {
        await http.post("/api/ip-list/exceptions", exForm);
        ElMessage.success("已添加");
        showAddEx.value = false;
        Object.assign(exForm, { cidr: "", domain: "", direction: "foreign", note: "" });
        loadEx();
      } catch {
      }
    };
    const deleteEx = async (id) => {
      try {
        await http.delete(`/api/ip-list/exceptions/${id}`);
        ElMessage.success("已删除");
        loadEx();
      } catch {
      }
    };
    onMounted(() => {
      void loadIP().catch(() => {
      });
      void loadSources().catch(() => {
      });
      void loadEx().catch(() => {
      });
    });
    return (_ctx, _push, _parent, _attrs) => {
      const _component_el_select = resolveComponent("el-select");
      const _component_el_option = resolveComponent("el-option");
      const _component_el_button = resolveComponent("el-button");
      const _component_el_icon = resolveComponent("el-icon");
      const _component_Refresh = resolveComponent("Refresh");
      const _component_el_empty = resolveComponent("el-empty");
      const _component_el_tag = resolveComponent("el-tag");
      const _component_el_alert = resolveComponent("el-alert");
      const _component_Plus = resolveComponent("Plus");
      const _component_el_popconfirm = resolveComponent("el-popconfirm");
      const _component_Delete = resolveComponent("Delete");
      const _component_el_dialog = resolveComponent("el-dialog");
      const _component_el_form = resolveComponent("el-form");
      const _component_el_form_item = resolveComponent("el-form-item");
      const _component_el_input = resolveComponent("el-input");
      const _component_el_input_number = resolveComponent("el-input-number");
      const _component_el_switch = resolveComponent("el-switch");
      const _directive_loading = resolveDirective("loading");
      _push(`<div${ssrRenderAttrs(_attrs)} data-v-e2c1d629><div class="page-card mb-md" data-v-e2c1d629><div class="page-card-header" data-v-e2c1d629><span class="page-card-title" data-v-e2c1d629>IP 库状态（国内/海外）</span><div class="rules-actions" data-v-e2c1d629>`);
      _push(ssrRenderComponent(_component_el_select, {
        modelValue: updateScope.value,
        "onUpdate:modelValue": ($event) => updateScope.value = $event,
        style: { "width": "140px" }
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_option, {
              label: "全部",
              value: "all"
            }, null, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_option, {
              label: "仅国内",
              value: "domestic"
            }, null, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_option, {
              label: "仅海外",
              value: "overseas"
            }, null, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_option, {
                label: "全部",
                value: "all"
              }),
              createVNode(_component_el_option, {
                label: "仅国内",
                value: "domestic"
              }),
              createVNode(_component_el_option, {
                label: "仅海外",
                value: "overseas"
              })
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(ssrRenderComponent(_component_el_button, {
        type: "primary",
        class: "rules-header-btn",
        onClick: triggerUpdate,
        loading: updating.value
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_icon, null, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_Refresh, null, null, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_Refresh)
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(` 全网立即更新 `);
          } else {
            return [
              createVNode(_component_el_icon, null, {
                default: withCtx(() => [
                  createVNode(_component_Refresh)
                ]),
                _: 1
              }),
              createTextVNode(" 全网立即更新 ")
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div></div><div${ssrRenderAttrs(mergeProps({ class: "record-grid" }, ssrGetDirectiveProps(_ctx, _directive_loading, loadingIP.value)))} data-v-e2c1d629><!--[-->`);
      ssrRenderList(ipListRows.value, (row) => {
        _push(`<div class="record-card" data-v-e2c1d629><div class="record-card__head" data-v-e2c1d629><div class="record-card__title mono-text min-w-0" data-v-e2c1d629>${ssrInterpolate(row.node_id)}</div></div><div class="record-card__fields" data-v-e2c1d629><div class="kv-row" data-v-e2c1d629><span class="kv-label" data-v-e2c1d629>国内版本</span><span class="kv-value" data-v-e2c1d629>${ssrInterpolate(row.domestic_version || "—")}</span></div><div class="kv-row" data-v-e2c1d629><span class="kv-label" data-v-e2c1d629>国内条目 / 更新</span><span class="kv-value" data-v-e2c1d629>${ssrInterpolate(row.domestic_entry_count ?? 0)} · ${ssrInterpolate(unref(formatDate)(row.domestic_last_update_at))}</span></div><div class="kv-row" data-v-e2c1d629><span class="kv-label" data-v-e2c1d629>海外版本</span><span class="kv-value" data-v-e2c1d629>${ssrInterpolate(row.overseas_version || "—")}</span></div><div class="kv-row" data-v-e2c1d629><span class="kv-label" data-v-e2c1d629>海外条目 / 更新</span><span class="kv-value" data-v-e2c1d629>${ssrInterpolate(row.overseas_entry_count ?? 0)} · ${ssrInterpolate(unref(formatDate)(row.overseas_last_update_at))}</span></div></div></div>`);
      });
      _push(`<!--]-->`);
      if (!loadingIP.value && !ipListRows.value.length) {
        _push(ssrRenderComponent(_component_el_empty, {
          description: "暂无 IP 库数据",
          "image-size": 60
        }, null, _parent));
      } else {
        _push(`<!---->`);
      }
      _push(`</div></div>`);
      if (sourceApiSupported.value) {
        _push(`<div class="page-card mb-md" data-v-e2c1d629><div class="page-card-header" data-v-e2c1d629><span class="page-card-title" data-v-e2c1d629>IP 库同步源配置</span></div><div${ssrRenderAttrs(mergeProps({ class: "record-grid record-grid--single" }, ssrGetDirectiveProps(_ctx, _directive_loading, loadingSources.value)))} data-v-e2c1d629><!--[-->`);
        ssrRenderList(ipSources.value, (row) => {
          _push(`<div class="${ssrRenderClass([unref(recordCardToneFromTagType)(row.enabled ? "success" : "info"), "record-card"])}" data-v-e2c1d629><div class="record-card__head" data-v-e2c1d629><div class="record-card__title" data-v-e2c1d629>${ssrInterpolate(row.scope === "domestic" ? "国内库" : "海外库")}</div>`);
          _push(ssrRenderComponent(_component_el_tag, {
            type: row.enabled ? "success" : "info",
            size: "small"
          }, {
            default: withCtx((_, _push2, _parent2, _scopeId) => {
              if (_push2) {
                _push2(`${ssrInterpolate(row.enabled ? "启用" : "关闭")}`);
              } else {
                return [
                  createTextVNode(toDisplayString(row.enabled ? "启用" : "关闭"), 1)
                ];
              }
            }),
            _: 2
          }, _parent));
          _push(`</div><div class="record-card__fields" data-v-e2c1d629><div class="kv-row" data-v-e2c1d629><span class="kv-label" data-v-e2c1d629>主地址</span><span class="kv-value" data-v-e2c1d629>${ssrInterpolate(row.primary_url || "—")}</span></div><div class="kv-row" data-v-e2c1d629><span class="kv-label" data-v-e2c1d629>镜像</span><span class="kv-value" data-v-e2c1d629>${ssrInterpolate(row.mirror_url || "—")}</span></div><div class="kv-row" data-v-e2c1d629><span class="kv-label" data-v-e2c1d629>超时 / 重试</span><span class="kv-value" data-v-e2c1d629>${ssrInterpolate(row.max_time_sec ?? "—")}s · ${ssrInterpolate(row.retry_count ?? "—")} 次</span></div></div><div class="record-card__actions" data-v-e2c1d629>`);
          _push(ssrRenderComponent(_component_el_button, {
            size: "small",
            onClick: ($event) => openEditSource(row)
          }, {
            default: withCtx((_, _push2, _parent2, _scopeId) => {
              if (_push2) {
                _push2(`编辑`);
              } else {
                return [
                  createTextVNode("编辑")
                ];
              }
            }),
            _: 2
          }, _parent));
          _push(`</div></div>`);
        });
        _push(`<!--]--></div></div>`);
      } else {
        _push(`<div class="page-card mb-md" data-v-e2c1d629>`);
        _push(ssrRenderComponent(_component_el_alert, {
          title: "当前 API 版本暂不支持“同步源配置”，已自动降级为兼容模式（不影响国内库基础功能）。",
          type: "warning",
          closable: false,
          "show-icon": ""
        }, null, _parent));
        _push(`</div>`);
      }
      _push(`<div class="page-card" data-v-e2c1d629><div class="page-card-header" data-v-e2c1d629><span class="page-card-title" data-v-e2c1d629>手工例外规则</span>`);
      _push(ssrRenderComponent(_component_el_button, {
        type: "primary",
        class: "rules-header-btn",
        onClick: ($event) => showAddEx.value = true
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_icon, null, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_Plus, null, null, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_Plus)
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(` 添加规则 `);
          } else {
            return [
              createVNode(_component_el_icon, null, {
                default: withCtx(() => [
                  createVNode(_component_Plus)
                ]),
                _: 1
              }),
              createTextVNode(" 添加规则 ")
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div><div${ssrRenderAttrs(mergeProps({ class: "record-grid" }, ssrGetDirectiveProps(_ctx, _directive_loading, loadingEx.value)))} data-v-e2c1d629><!--[-->`);
      ssrRenderList(exceptions.value, (row) => {
        _push(`<div class="${ssrRenderClass([unref(recordCardToneFromTagType)(row.direction === "foreign" ? "warning" : "success"), "record-card"])}" data-v-e2c1d629><div class="record-card__head" data-v-e2c1d629><div class="record-card__title mono-text min-w-0" data-v-e2c1d629>${ssrInterpolate(row.cidr || row.domain || "例外规则")}</div>`);
        _push(ssrRenderComponent(_component_el_tag, {
          type: row.direction === "foreign" ? "warning" : "success",
          size: "small"
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`${ssrInterpolate(row.direction === "foreign" ? "走境外" : "走国内")}`);
            } else {
              return [
                createTextVNode(toDisplayString(row.direction === "foreign" ? "走境外" : "走国内"), 1)
              ];
            }
          }),
          _: 2
        }, _parent));
        _push(`</div><div class="record-card__fields" data-v-e2c1d629><div class="kv-row" data-v-e2c1d629><span class="kv-label" data-v-e2c1d629>IP 段</span><span class="kv-value mono-text" data-v-e2c1d629>${ssrInterpolate(row.cidr || "—")}</span></div><div class="kv-row" data-v-e2c1d629><span class="kv-label" data-v-e2c1d629>域名</span><span class="kv-value" data-v-e2c1d629>${ssrInterpolate(row.domain || "—")}</span></div><div class="kv-row" data-v-e2c1d629><span class="kv-label" data-v-e2c1d629>备注</span><span class="kv-value" data-v-e2c1d629>${ssrInterpolate(row.note || "—")}</span></div></div><div class="record-card__actions" data-v-e2c1d629>`);
        _push(ssrRenderComponent(_component_el_popconfirm, {
          title: "删除此规则？",
          onConfirm: ($event) => deleteEx(row.id)
        }, {
          reference: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(ssrRenderComponent(_component_el_button, {
                size: "small",
                plain: "",
                type: "danger"
              }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(ssrRenderComponent(_component_el_icon, null, {
                      default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                        if (_push4) {
                          _push4(ssrRenderComponent(_component_Delete, null, null, _parent4, _scopeId3));
                        } else {
                          return [
                            createVNode(_component_Delete)
                          ];
                        }
                      }),
                      _: 2
                    }, _parent3, _scopeId2));
                    _push3(` 删除 `);
                  } else {
                    return [
                      createVNode(_component_el_icon, null, {
                        default: withCtx(() => [
                          createVNode(_component_Delete)
                        ]),
                        _: 1
                      }),
                      createTextVNode(" 删除 ")
                    ];
                  }
                }),
                _: 2
              }, _parent2, _scopeId));
            } else {
              return [
                createVNode(_component_el_button, {
                  size: "small",
                  plain: "",
                  type: "danger"
                }, {
                  default: withCtx(() => [
                    createVNode(_component_el_icon, null, {
                      default: withCtx(() => [
                        createVNode(_component_Delete)
                      ]),
                      _: 1
                    }),
                    createTextVNode(" 删除 ")
                  ]),
                  _: 1
                })
              ];
            }
          }),
          _: 2
        }, _parent));
        _push(`</div></div>`);
      });
      _push(`<!--]-->`);
      if (!loadingEx.value && !exceptions.value.length) {
        _push(ssrRenderComponent(_component_el_empty, {
          description: "暂无例外规则",
          "image-size": 60
        }, null, _parent));
      } else {
        _push(`<!---->`);
      }
      _push(`</div></div>`);
      _push(ssrRenderComponent(_component_el_dialog, {
        modelValue: showAddEx.value,
        "onUpdate:modelValue": ($event) => showAddEx.value = $event,
        title: "添加例外规则",
        width: "min(480px, 92vw)",
        "destroy-on-close": "",
        class: "rules-dialog"
      }, {
        footer: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_button, {
              onClick: ($event) => showAddEx.value = false
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`取消`);
                } else {
                  return [
                    createTextVNode("取消")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_button, {
              type: "primary",
              onClick: doAddEx
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`确认`);
                } else {
                  return [
                    createTextVNode("确认")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_button, {
                onClick: ($event) => showAddEx.value = false
              }, {
                default: withCtx(() => [
                  createTextVNode("取消")
                ]),
                _: 1
              }, 8, ["onClick"]),
              createVNode(_component_el_button, {
                type: "primary",
                onClick: doAddEx
              }, {
                default: withCtx(() => [
                  createTextVNode("确认")
                ]),
                _: 1
              })
            ];
          }
        }),
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_form, {
              model: exForm,
              "label-width": "80px"
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "IP 段" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: exForm.cidr,
                          "onUpdate:modelValue": ($event) => exForm.cidr = $event,
                          placeholder: "如 104.16.0.0/12"
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: exForm.cidr,
                            "onUpdate:modelValue": ($event) => exForm.cidr = $event,
                            placeholder: "如 104.16.0.0/12"
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "域名" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: exForm.domain,
                          "onUpdate:modelValue": ($event) => exForm.domain = $event,
                          placeholder: "如 *.notion.so"
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: exForm.domain,
                            "onUpdate:modelValue": ($event) => exForm.domain = $event,
                            placeholder: "如 *.notion.so"
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "方向" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_select, {
                          modelValue: exForm.direction,
                          "onUpdate:modelValue": ($event) => exForm.direction = $event,
                          style: { "width": "100%" }
                        }, {
                          default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                            if (_push5) {
                              _push5(ssrRenderComponent(_component_el_option, {
                                label: "走境外",
                                value: "foreign"
                              }, null, _parent5, _scopeId4));
                              _push5(ssrRenderComponent(_component_el_option, {
                                label: "走国内",
                                value: "domestic"
                              }, null, _parent5, _scopeId4));
                            } else {
                              return [
                                createVNode(_component_el_option, {
                                  label: "走境外",
                                  value: "foreign"
                                }),
                                createVNode(_component_el_option, {
                                  label: "走国内",
                                  value: "domestic"
                                })
                              ];
                            }
                          }),
                          _: 1
                        }, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_select, {
                            modelValue: exForm.direction,
                            "onUpdate:modelValue": ($event) => exForm.direction = $event,
                            style: { "width": "100%" }
                          }, {
                            default: withCtx(() => [
                              createVNode(_component_el_option, {
                                label: "走境外",
                                value: "foreign"
                              }),
                              createVNode(_component_el_option, {
                                label: "走国内",
                                value: "domestic"
                              })
                            ]),
                            _: 1
                          }, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "备注" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: exForm.note,
                          "onUpdate:modelValue": ($event) => exForm.note = $event
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: exForm.note,
                            "onUpdate:modelValue": ($event) => exForm.note = $event
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_el_form_item, { label: "IP 段" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: exForm.cidr,
                          "onUpdate:modelValue": ($event) => exForm.cidr = $event,
                          placeholder: "如 104.16.0.0/12"
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "域名" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: exForm.domain,
                          "onUpdate:modelValue": ($event) => exForm.domain = $event,
                          placeholder: "如 *.notion.so"
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "方向" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_select, {
                          modelValue: exForm.direction,
                          "onUpdate:modelValue": ($event) => exForm.direction = $event,
                          style: { "width": "100%" }
                        }, {
                          default: withCtx(() => [
                            createVNode(_component_el_option, {
                              label: "走境外",
                              value: "foreign"
                            }),
                            createVNode(_component_el_option, {
                              label: "走国内",
                              value: "domestic"
                            })
                          ]),
                          _: 1
                        }, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "备注" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: exForm.note,
                          "onUpdate:modelValue": ($event) => exForm.note = $event
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    })
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_form, {
                model: exForm,
                "label-width": "80px"
              }, {
                default: withCtx(() => [
                  createVNode(_component_el_form_item, { label: "IP 段" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: exForm.cidr,
                        "onUpdate:modelValue": ($event) => exForm.cidr = $event,
                        placeholder: "如 104.16.0.0/12"
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "域名" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: exForm.domain,
                        "onUpdate:modelValue": ($event) => exForm.domain = $event,
                        placeholder: "如 *.notion.so"
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "方向" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_select, {
                        modelValue: exForm.direction,
                        "onUpdate:modelValue": ($event) => exForm.direction = $event,
                        style: { "width": "100%" }
                      }, {
                        default: withCtx(() => [
                          createVNode(_component_el_option, {
                            label: "走境外",
                            value: "foreign"
                          }),
                          createVNode(_component_el_option, {
                            label: "走国内",
                            value: "domestic"
                          })
                        ]),
                        _: 1
                      }, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "备注" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: exForm.note,
                        "onUpdate:modelValue": ($event) => exForm.note = $event
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  })
                ]),
                _: 1
              }, 8, ["model"])
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(ssrRenderComponent(_component_el_dialog, {
        modelValue: showEditSource.value,
        "onUpdate:modelValue": ($event) => showEditSource.value = $event,
        title: "编辑同步源",
        width: "min(560px, 92vw)",
        "destroy-on-close": "",
        class: "rules-dialog"
      }, {
        footer: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_button, {
              onClick: ($event) => showEditSource.value = false
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`取消`);
                } else {
                  return [
                    createTextVNode("取消")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_button, {
              type: "primary",
              onClick: saveSource
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`保存`);
                } else {
                  return [
                    createTextVNode("保存")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_button, {
                onClick: ($event) => showEditSource.value = false
              }, {
                default: withCtx(() => [
                  createTextVNode("取消")
                ]),
                _: 1
              }, 8, ["onClick"]),
              createVNode(_component_el_button, {
                type: "primary",
                onClick: saveSource
              }, {
                default: withCtx(() => [
                  createTextVNode("保存")
                ]),
                _: 1
              })
            ];
          }
        }),
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_form, {
              model: sourceForm,
              "label-width": "110px"
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "主地址" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: sourceForm.primary_url,
                          "onUpdate:modelValue": ($event) => sourceForm.primary_url = $event
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: sourceForm.primary_url,
                            "onUpdate:modelValue": ($event) => sourceForm.primary_url = $event
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "镜像地址" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: sourceForm.mirror_url,
                          "onUpdate:modelValue": ($event) => sourceForm.mirror_url = $event
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: sourceForm.mirror_url,
                            "onUpdate:modelValue": ($event) => sourceForm.mirror_url = $event
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "连接超时(s)" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input_number, {
                          modelValue: sourceForm.connect_timeout_sec,
                          "onUpdate:modelValue": ($event) => sourceForm.connect_timeout_sec = $event,
                          min: 1,
                          max: 60
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input_number, {
                            modelValue: sourceForm.connect_timeout_sec,
                            "onUpdate:modelValue": ($event) => sourceForm.connect_timeout_sec = $event,
                            min: 1,
                            max: 60
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "总超时(s)" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input_number, {
                          modelValue: sourceForm.max_time_sec,
                          "onUpdate:modelValue": ($event) => sourceForm.max_time_sec = $event,
                          min: 3,
                          max: 300
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input_number, {
                            modelValue: sourceForm.max_time_sec,
                            "onUpdate:modelValue": ($event) => sourceForm.max_time_sec = $event,
                            min: 3,
                            max: 300
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "重试次数" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input_number, {
                          modelValue: sourceForm.retry_count,
                          "onUpdate:modelValue": ($event) => sourceForm.retry_count = $event,
                          min: 0,
                          max: 10
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input_number, {
                            modelValue: sourceForm.retry_count,
                            "onUpdate:modelValue": ($event) => sourceForm.retry_count = $event,
                            min: 0,
                            max: 10
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "启用" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_switch, {
                          modelValue: sourceForm.enabled,
                          "onUpdate:modelValue": ($event) => sourceForm.enabled = $event
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_switch, {
                            modelValue: sourceForm.enabled,
                            "onUpdate:modelValue": ($event) => sourceForm.enabled = $event
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_el_form_item, { label: "主地址" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: sourceForm.primary_url,
                          "onUpdate:modelValue": ($event) => sourceForm.primary_url = $event
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "镜像地址" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: sourceForm.mirror_url,
                          "onUpdate:modelValue": ($event) => sourceForm.mirror_url = $event
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "连接超时(s)" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input_number, {
                          modelValue: sourceForm.connect_timeout_sec,
                          "onUpdate:modelValue": ($event) => sourceForm.connect_timeout_sec = $event,
                          min: 1,
                          max: 60
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "总超时(s)" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input_number, {
                          modelValue: sourceForm.max_time_sec,
                          "onUpdate:modelValue": ($event) => sourceForm.max_time_sec = $event,
                          min: 3,
                          max: 300
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "重试次数" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input_number, {
                          modelValue: sourceForm.retry_count,
                          "onUpdate:modelValue": ($event) => sourceForm.retry_count = $event,
                          min: 0,
                          max: 10
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "启用" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_switch, {
                          modelValue: sourceForm.enabled,
                          "onUpdate:modelValue": ($event) => sourceForm.enabled = $event
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    })
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_form, {
                model: sourceForm,
                "label-width": "110px"
              }, {
                default: withCtx(() => [
                  createVNode(_component_el_form_item, { label: "主地址" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: sourceForm.primary_url,
                        "onUpdate:modelValue": ($event) => sourceForm.primary_url = $event
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "镜像地址" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: sourceForm.mirror_url,
                        "onUpdate:modelValue": ($event) => sourceForm.mirror_url = $event
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "连接超时(s)" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input_number, {
                        modelValue: sourceForm.connect_timeout_sec,
                        "onUpdate:modelValue": ($event) => sourceForm.connect_timeout_sec = $event,
                        min: 1,
                        max: 60
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "总超时(s)" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input_number, {
                        modelValue: sourceForm.max_time_sec,
                        "onUpdate:modelValue": ($event) => sourceForm.max_time_sec = $event,
                        min: 3,
                        max: 300
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "重试次数" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input_number, {
                        modelValue: sourceForm.retry_count,
                        "onUpdate:modelValue": ($event) => sourceForm.retry_count = $event,
                        min: 0,
                        max: 10
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "启用" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_switch, {
                        modelValue: sourceForm.enabled,
                        "onUpdate:modelValue": ($event) => sourceForm.enabled = $event
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  })
                ]),
                _: 1
              }, 8, ["model"])
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div>`);
    };
  }
};
const _sfc_setup$8 = _sfc_main$8.setup;
_sfc_main$8.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/views/Rules.vue");
  return _sfc_setup$8 ? _sfc_setup$8(props, ctx) : void 0;
};
const Rules = /* @__PURE__ */ _export_sfc(_sfc_main$8, [["__scopeId", "data-v-e2c1d629"]]);
const TOPO_RACK_W = 26;
const TOPO_RACK_H = 32;
const POLL_INTERVAL_MS = 1e4;
const _sfc_main$7 = {
  __name: "Tunnels",
  __ssrInlineRender: true,
  setup(__props) {
    const rows = ref([]);
    const nodes = ref([]);
    const loading = ref(false);
    const topoCanvasRef = ref(null);
    const topoW = ref(320);
    const topoH = ref(350);
    const TOPO_RACK_HALF_W = TOPO_RACK_W / 2;
    const TOPO_RACK_HALF_H = TOPO_RACK_H / 2;
    const nodeBoxStyle = (n) => ({
      left: `${n.x - TOPO_RACK_HALF_W}px`,
      top: `${n.y - TOPO_RACK_HALF_H}px`
    });
    const pan = reactive({ x: 0, y: 0 });
    const scale = ref(1);
    const dragState = reactive({ node: null, offsetX: 0, offsetY: 0 });
    const nodePositions = reactive({});
    let pollTimer = null;
    const touchGesture = reactive({
      mode: "none",
      pinchDist0: 0,
      scale0: 1
    });
    const canvasPan = reactive({
      active: false,
      pointerId: null,
      startClientX: 0,
      startClientY: 0,
      pan0X: 0,
      pan0Y: 0
    });
    const topoLayerStyle = computed(() => ({
      width: `${topoW.value}px`,
      height: `${topoH.value}px`,
      transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale.value})`,
      transformOrigin: "0 0"
    }));
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const touchDist = (a, b) => {
      const dx = a.clientX - b.clientX;
      const dy = a.clientY - b.clientY;
      return Math.hypot(dx, dy) || 1;
    };
    const clientToGraph = (clientX, clientY) => {
      const el = topoCanvasRef.value;
      if (!el) return { x: 0, y: 0 };
      const r = el.getBoundingClientRect();
      return {
        x: (clientX - r.left - pan.x) / scale.value,
        y: (clientY - r.top - pan.y) / scale.value
      };
    };
    let detachTopoTouch = null;
    const onTouchStart = (e) => {
      if (dragState.node) return;
      if (e.touches.length === 2) {
        canvasPan.active = false;
        canvasPan.pointerId = null;
        touchGesture.mode = "pinch";
        touchGesture.pinchDist0 = touchDist(e.touches[0], e.touches[1]);
        touchGesture.scale0 = scale.value;
      }
    };
    const onTouchMove = (e) => {
      if (dragState.node) return;
      if (e.touches.length === 2) {
        e.preventDefault();
        touchGesture.mode = "pinch";
        const d = touchDist(e.touches[0], e.touches[1]);
        if (!touchGesture.pinchDist0) {
          touchGesture.pinchDist0 = d;
          touchGesture.scale0 = scale.value;
        }
        scale.value = clamp(touchGesture.scale0 * (d / touchGesture.pinchDist0), 0.5, 2.5);
      }
    };
    const onTouchEnd = (e) => {
      if (e.touches.length === 0) {
        touchGesture.mode = "none";
        touchGesture.pinchDist0 = 0;
      } else if (e.touches.length === 1) {
        touchGesture.pinchDist0 = 0;
      }
    };
    const endNodeDrag = () => {
      dragState.node = null;
      document.removeEventListener("pointermove", onNodePointerMove);
      document.removeEventListener("pointerup", endNodeDrag);
      document.removeEventListener("pointercancel", endNodeDrag);
    };
    const onNodePointerMove = (e) => {
      if (!dragState.node) return;
      if (e.cancelable) e.preventDefault();
      const p = clientToGraph(e.clientX, e.clientY);
      const w = topoW.value;
      const h = topoH.value;
      nodePositions[dragState.node.id] = {
        x: clamp(p.x - dragState.offsetX, TOPO_RACK_HALF_W, w - TOPO_RACK_HALF_W),
        y: clamp(p.y - dragState.offsetY, TOPO_RACK_HALF_H, h - TOPO_RACK_HALF_H)
      };
    };
    const linkPalette = (status) => {
      if (status === "ok" || status === "healthy") {
        return { core: "#22c55e", glow: "rgba(34, 197, 94, 0.5)" };
      }
      if (status === "down" || status === "invalid_config") {
        return { core: "#ef4444", glow: "rgba(239, 68, 68, 0.5)" };
      }
      return { core: "#eab308", glow: "rgba(234, 179, 8, 0.48)" };
    };
    const rackLedColor = (n) => n.status === "online" ? "#4ade80" : "#64748b";
    const topoNodes = computed(() => {
      const list = nodes.value;
      if (!list.length) return [];
      const cx = topoW.value / 2;
      const cy = topoH.value / 2;
      const r = Math.min(110, Math.min(topoW.value, topoH.value) * 0.28);
      return list.map((n, i) => {
        var _a, _b, _c, _d;
        const id = (_a = n.node) == null ? void 0 : _a.id;
        if (!nodePositions[id]) {
          const angle = 2 * Math.PI * i / list.length - Math.PI / 2;
          nodePositions[id] = { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
        }
        return {
          id,
          label: ((_b = n.node) == null ? void 0 : _b.name) || id,
          status: (_c = n.node) == null ? void 0 : _c.status,
          users: (_d = n.node) == null ? void 0 : _d.online_users,
          ...nodePositions[id]
        };
      });
    });
    const topoLinks = computed(() => {
      const m = {};
      topoNodes.value.forEach((n) => {
        m[n.id] = n;
      });
      return rows.value.map((t) => {
        const a = m[t.node_a];
        const b = m[t.node_b];
        if (!a || !b) return null;
        return {
          id: t.id,
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
          status: t.status,
          latency: t.latency_ms,
          loss: t.loss_pct
        };
      }).filter(Boolean);
    });
    const nodeUserCount = (nodeID) => {
      var _a;
      const hit = nodes.value.find((n) => {
        var _a2;
        return ((_a2 = n.node) == null ? void 0 : _a2.id) === nodeID;
      });
      return ((_a = hit == null ? void 0 : hit.node) == null ? void 0 : _a.online_users) ?? 0;
    };
    const clearTopoNodePositions = () => {
      Object.keys(nodePositions).forEach((k) => {
        delete nodePositions[k];
      });
    };
    const fitTopoPan = () => {
      const el = topoCanvasRef.value;
      if (!el) return;
      const cw = el.clientWidth;
      const ch = el.clientHeight || topoH.value;
      const gcX = topoW.value / 2;
      const gcY = topoH.value / 2;
      pan.x = cw / 2 - gcX * scale.value;
      pan.y = ch / 2 - gcY * scale.value;
    };
    const updateTopoDimensions = () => {
      const el = topoCanvasRef.value;
      if (!el) return;
      const nw = Math.max(280, Math.floor(el.clientWidth || 320));
      const nh = Math.max(240, Math.floor(el.clientHeight || 350));
      const wChanged = Math.abs(nw - topoW.value) > 1;
      const hChanged = Math.abs(nh - topoH.value) > 1;
      if (wChanged || hChanged) {
        clearTopoNodePositions();
        topoW.value = nw;
        topoH.value = nh;
        nextTick(() => fitTopoPan());
      }
    };
    const loadData = async () => {
      loading.value = true;
      try {
        const [tRes, nRes] = await Promise.all([
          http.get("/api/tunnels"),
          http.get("/api/nodes")
        ]);
        rows.value = tRes.data.items || [];
        nodes.value = nRes.data.items || [];
      } finally {
        loading.value = false;
      }
    };
    let topoResizeObserver = null;
    onMounted(async () => {
      await nextTick();
      updateTopoDimensions();
      fitTopoPan();
      window.addEventListener("resize", updateTopoDimensions);
      const canvas = topoCanvasRef.value;
      if (canvas) {
        const opts = { passive: false };
        canvas.addEventListener("touchstart", onTouchStart, opts);
        canvas.addEventListener("touchmove", onTouchMove, opts);
        canvas.addEventListener("touchend", onTouchEnd, { passive: true });
        canvas.addEventListener("touchcancel", onTouchEnd, { passive: true });
        detachTopoTouch = () => {
          canvas.removeEventListener("touchstart", onTouchStart);
          canvas.removeEventListener("touchmove", onTouchMove);
          canvas.removeEventListener("touchend", onTouchEnd);
          canvas.removeEventListener("touchcancel", onTouchEnd);
        };
        topoResizeObserver = new ResizeObserver(() => {
          updateTopoDimensions();
        });
        topoResizeObserver.observe(canvas);
      }
      await loadData();
      await nextTick();
      updateTopoDimensions();
      fitTopoPan();
      pollTimer = setInterval(loadData, POLL_INTERVAL_MS);
    });
    onUnmounted(() => {
      window.removeEventListener("resize", updateTopoDimensions);
      topoResizeObserver == null ? void 0 : topoResizeObserver.disconnect();
      topoResizeObserver = null;
      endNodeDrag();
      detachTopoTouch == null ? void 0 : detachTopoTouch();
      detachTopoTouch = null;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    });
    return (_ctx, _push, _parent, _attrs) => {
      const _component_el_text = resolveComponent("el-text");
      const _component_el_empty = resolveComponent("el-empty");
      const _directive_loading = resolveDirective("loading");
      _push(`<div${ssrRenderAttrs(_attrs)} data-v-876dd26a><div class="page-card mb-md" data-v-876dd26a><div class="page-card-header topo-page-head" data-v-876dd26a><span class="page-card-title" data-v-876dd26a>网络拓扑</span>`);
      _push(ssrRenderComponent(_component_el_text, {
        class: "topo-gesture-hint",
        type: "info",
        size: "small"
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(` 移动端：单指拖空白处平移 · 双指捏合缩放 · 拖动节点可重排 `);
          } else {
            return [
              createTextVNode(" 移动端：单指拖空白处平移 · 双指捏合缩放 · 拖动节点可重排 ")
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div><div class="topo-canvas" data-v-876dd26a><div class="topo-transform-layer" style="${ssrRenderStyle(topoLayerStyle.value)}" data-v-876dd26a><svg${ssrRenderAttr("width", topoW.value)}${ssrRenderAttr("height", topoH.value)} class="topo-svg" aria-hidden="true" data-v-876dd26a><defs data-v-876dd26a><filter id="topo-link-soft-glow" x="-60%" y="-60%" width="220%" height="220%" data-v-876dd26a><feGaussianBlur stdDeviation="2.2" result="b" data-v-876dd26a></feGaussianBlur><feMerge data-v-876dd26a><feMergeNode in="b" data-v-876dd26a></feMergeNode><feMergeNode in="SourceGraphic" data-v-876dd26a></feMergeNode></feMerge></filter></defs><!--[-->`);
      ssrRenderList(topoLinks.value, (link) => {
        _push(`<g class="topo-link-group" data-v-876dd26a><line class="topo-link-glow"${ssrRenderAttr("x1", link.x1)}${ssrRenderAttr("y1", link.y1)}${ssrRenderAttr("x2", link.x2)}${ssrRenderAttr("y2", link.y2)}${ssrRenderAttr("stroke", linkPalette(link.status).glow)} stroke-width="7" stroke-linecap="round" opacity="0.55" data-v-876dd26a></line><line class="topo-link-core"${ssrRenderAttr("x1", link.x1)}${ssrRenderAttr("y1", link.y1)}${ssrRenderAttr("x2", link.x2)}${ssrRenderAttr("y2", link.y2)}${ssrRenderAttr("stroke", linkPalette(link.status).core)} stroke-width="2.2" stroke-linecap="round" filter="url(#topo-link-soft-glow)" data-v-876dd26a></line><text class="topo-link-metric topo-link-metric--latency"${ssrRenderAttr("x", (link.x1 + link.x2) / 2)}${ssrRenderAttr("y", (link.y1 + link.y2) / 2 - 8)} text-anchor="middle" font-size="11" data-v-876dd26a>${ssrInterpolate(link.latency > 0 ? link.latency.toFixed(0) + "ms" : "")}</text><text class="${ssrRenderClass([{ "topo-link-metric--loss": link.loss > 0 }, "topo-link-metric"])}"${ssrRenderAttr("x", (link.x1 + link.x2) / 2)}${ssrRenderAttr("y", (link.y1 + link.y2) / 2 + 6)} text-anchor="middle" font-size="10" data-v-876dd26a>${ssrInterpolate(link.loss > 0 ? link.loss.toFixed(1) + "% loss" : "")}</text></g>`);
      });
      _push(`<!--]--></svg><!--[-->`);
      ssrRenderList(topoNodes.value, (n) => {
        _push(`<div class="${ssrRenderClass([{ "is-node-online": n.status === "online" }, "topo-node"])}" style="${ssrRenderStyle(nodeBoxStyle(n))}" data-v-876dd26a><div class="topo-rack-wrap" data-v-876dd26a><svg class="topo-rack-svg" viewBox="0 0 28 34" aria-hidden="true" data-v-876dd26a><defs data-v-876dd26a><linearGradient${ssrRenderAttr("id", "topoRackGrad-" + n.id)} x1="0%" y1="0%" x2="0%" y2="100%" data-v-876dd26a><stop offset="0%" stop-color="#64748b" data-v-876dd26a></stop><stop offset="55%" stop-color="#3d4f63" data-v-876dd26a></stop><stop offset="100%" stop-color="#1e293b" data-v-876dd26a></stop></linearGradient></defs><rect x="0.5" y="0.5" width="27" height="33" rx="2.5"${ssrRenderAttr("fill", "url(#topoRackGrad-" + n.id + ")")} stroke="#94a3b8" stroke-width="0.6" data-v-876dd26a></rect><rect x="2.5" y="3" width="23" height="9" rx="1.2" fill="#0f172a" stroke="#334155" stroke-width="0.4" data-v-876dd26a></rect><rect x="4" y="5" width="7" height="1.8" rx="0.35" fill="#1e293b" data-v-876dd26a></rect><rect x="4" y="7.2" width="11" height="1.4" rx="0.35" fill="#1e293b" data-v-876dd26a></rect><circle cx="22.5" cy="7.5" r="1.35"${ssrRenderAttr("fill", rackLedColor(n))} class="topo-rack-led" data-v-876dd26a></circle><rect x="2.5" y="13.5" width="23" height="9" rx="1.2" fill="#0f172a" stroke="#334155" stroke-width="0.4" data-v-876dd26a></rect><rect x="4" y="15.5" width="7" height="1.8" rx="0.35" fill="#1e293b" data-v-876dd26a></rect><rect x="4" y="17.7" width="9" height="1.4" rx="0.35" fill="#1e293b" data-v-876dd26a></rect><circle cx="22.5" cy="18" r="1.35"${ssrRenderAttr("fill", rackLedColor(n))} class="topo-rack-led" data-v-876dd26a></circle><rect x="2.5" y="24" width="23" height="8" rx="1.2" fill="#0f172a" stroke="#334155" stroke-width="0.4" data-v-876dd26a></rect><rect x="4" y="25.8" width="9" height="1.6" rx="0.35" fill="#1e293b" data-v-876dd26a></rect><rect x="4" y="27.8" width="6" height="1.2" rx="0.35" fill="#1e293b" data-v-876dd26a></rect><circle cx="22.5" cy="28" r="1.35"${ssrRenderAttr("fill", rackLedColor(n))} class="topo-rack-led" data-v-876dd26a></circle></svg></div><div class="topo-node-meta" data-v-876dd26a><div class="topo-label" data-v-876dd26a>${ssrInterpolate(n.label)}</div><div class="topo-users" data-v-876dd26a>${ssrInterpolate(n.users || 0)} 人在线</div></div></div>`);
      });
      _push(`<!--]--></div></div></div><div class="page-card" data-v-876dd26a><div class="page-card-header" data-v-876dd26a><span class="page-card-title" data-v-876dd26a>隧道列表</span>`);
      _push(ssrRenderComponent(_component_el_text, {
        type: "info",
        size: "small"
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`共 ${ssrInterpolate(rows.value.length)} 条`);
          } else {
            return [
              createTextVNode("共 " + toDisplayString(rows.value.length) + " 条", 1)
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div><div${ssrRenderAttrs(mergeProps({ class: "record-grid" }, ssrGetDirectiveProps(_ctx, _directive_loading, loading.value)))} data-v-876dd26a><!--[-->`);
      ssrRenderList(rows.value, (row) => {
        _push(`<div class="${ssrRenderClass([unref(recordCardToneClass)("tunnel", row.status), "record-card"])}" data-v-876dd26a><div class="record-card__head" data-v-876dd26a><div class="record-card__title min-w-0" data-v-876dd26a>${ssrInterpolate(row.node_a)} <span class="record-card__meta" style="${ssrRenderStyle({ "display": "inline", "margin": "0 6px" })}" data-v-876dd26a>↔</span> ${ssrInterpolate(row.node_b)}</div></div><div class="record-card__fields" data-v-876dd26a><div class="kv-row" data-v-876dd26a><span class="kv-label" data-v-876dd26a>子网</span><span class="kv-value mono-text" data-v-876dd26a>${ssrInterpolate(row.subnet || "—")}</span></div><div class="kv-row" data-v-876dd26a><span class="kv-label" data-v-876dd26a>状态</span><span class="kv-value" data-v-876dd26a><span class="${ssrRenderClass([`status-dot--${row.status}`, "status-dot"])}" data-v-876dd26a></span> ${ssrInterpolate(unref(getStatusInfo)("tunnel", row.status).label)}</span></div><div class="kv-row" data-v-876dd26a><span class="kv-label" data-v-876dd26a>状态原因</span><span class="kv-value" data-v-876dd26a>${ssrInterpolate(row.status_reason || "—")}</span></div><div class="kv-row" data-v-876dd26a><span class="kv-label" data-v-876dd26a>A / B 在线</span><span class="kv-value" data-v-876dd26a>${ssrInterpolate(nodeUserCount(row.node_a))} / ${ssrInterpolate(nodeUserCount(row.node_b))}</span></div><div class="kv-row" data-v-876dd26a><span class="kv-label" data-v-876dd26a>延迟 / 丢包</span><span class="kv-value" data-v-876dd26a>${ssrInterpolate(Number.isFinite(row.latency_ms) ? Number(row.latency_ms).toFixed(1) : "—")} ms <span class="record-card__meta" data-v-876dd26a> · </span>`);
        _push(ssrRenderComponent(_component_el_text, {
          type: row.loss_pct > 1 ? "danger" : ""
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`${ssrInterpolate(row.loss_pct > 0 ? row.loss_pct.toFixed(1) : "0")}% `);
            } else {
              return [
                createTextVNode(toDisplayString(row.loss_pct > 0 ? row.loss_pct.toFixed(1) : "0") + "% ", 1)
              ];
            }
          }),
          _: 2
        }, _parent));
        _push(`</span></div></div></div>`);
      });
      _push(`<!--]--></div>`);
      if (!loading.value && !rows.value.length) {
        _push(ssrRenderComponent(_component_el_empty, {
          description: "暂无隧道",
          "image-size": 60
        }, null, _parent));
      } else {
        _push(`<!---->`);
      }
      _push(`</div></div>`);
    };
  }
};
const _sfc_setup$7 = _sfc_main$7.setup;
_sfc_main$7.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/views/Tunnels.vue");
  return _sfc_setup$7 ? _sfc_setup$7(props, ctx) : void 0;
};
const Tunnels = /* @__PURE__ */ _export_sfc(_sfc_main$7, [["__scopeId", "data-v-876dd26a"]]);
const _sfc_main$6 = {
  __name: "Audit",
  __ssrInlineRender: true,
  setup(__props) {
    const viewportNarrow = ref(typeof window !== "undefined" && window.innerWidth <= 600);
    const onResizeAudit = () => {
      viewportNarrow.value = window.innerWidth <= 600;
    };
    const paginationLayout = computed(
      () => viewportNarrow.value ? "prev, pager, next" : "total, prev, pager, next, sizes"
    );
    const paginationSmall = computed(() => viewportNarrow.value);
    const rows = ref([]);
    const loading = ref(false);
    const total = ref(0);
    const page = ref(1);
    const pageSize = ref(50);
    const search = ref("");
    const actionFilter = ref("");
    const actionOptions = ref([]);
    const loadLogs = async () => {
      loading.value = true;
      try {
        const params = { page: page.value, limit: pageSize.value };
        if (actionFilter.value) params.action = actionFilter.value;
        if (search.value) params.search = search.value;
        const res = await http.get("/api/audit-logs", { params });
        rows.value = res.data.items || [];
        total.value = res.data.total || 0;
        if (res.data.actions) actionOptions.value = res.data.actions.sort();
      } finally {
        loading.value = false;
      }
    };
    const onSearch = () => {
      page.value = 1;
      loadLogs();
    };
    const onSizeChange = (size) => {
      pageSize.value = size;
      page.value = 1;
      loadLogs();
    };
    const exportCSV = () => {
      const header = "time,admin,action,target,detail\n";
      const body = rows.value.map((r) => `"${r.created_at}","${r.admin_user}","${r.action}","${r.target || ""}","${r.detail || ""}"`).join("\n");
      downloadBlob(header + body, "audit-logs.csv");
    };
    onMounted(() => {
      window.addEventListener("resize", onResizeAudit);
      loadLogs();
    });
    onBeforeUnmount(() => {
      window.removeEventListener("resize", onResizeAudit);
    });
    return (_ctx, _push, _parent, _attrs) => {
      const _component_el_button = resolveComponent("el-button");
      const _component_el_icon = resolveComponent("el-icon");
      const _component_Download = resolveComponent("Download");
      const _component_el_input = resolveComponent("el-input");
      const _component_el_select = resolveComponent("el-select");
      const _component_el_option = resolveComponent("el-option");
      const _component_el_text = resolveComponent("el-text");
      const _component_el_tag = resolveComponent("el-tag");
      const _component_el_empty = resolveComponent("el-empty");
      const _component_el_pagination = resolveComponent("el-pagination");
      const _directive_loading = resolveDirective("loading");
      _push(`<div${ssrRenderAttrs(_attrs)}><div class="page-card"><div class="page-card-header"><span class="page-card-title">审计日志</span>`);
      _push(ssrRenderComponent(_component_el_button, { onClick: exportCSV }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_icon, null, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_Download, null, null, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_Download)
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(` 导出 CSV `);
          } else {
            return [
              createVNode(_component_el_icon, null, {
                default: withCtx(() => [
                  createVNode(_component_Download)
                ]),
                _: 1
              }),
              createTextVNode(" 导出 CSV ")
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div><div class="action-bar"><div class="filter-group">`);
      _push(ssrRenderComponent(_component_el_input, {
        modelValue: search.value,
        "onUpdate:modelValue": ($event) => search.value = $event,
        placeholder: "搜索操作人 / 目标...",
        clearable: "",
        style: { "width": "220px" },
        "prefix-icon": unref(Search),
        onClear: onSearch,
        onKeyup: onSearch
      }, null, _parent));
      _push(ssrRenderComponent(_component_el_select, {
        modelValue: actionFilter.value,
        "onUpdate:modelValue": ($event) => actionFilter.value = $event,
        placeholder: "操作类型",
        clearable: "",
        style: { "width": "160px" },
        onChange: onSearch
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`<!--[-->`);
            ssrRenderList(actionOptions.value, (a) => {
              _push2(ssrRenderComponent(_component_el_option, {
                key: a,
                label: a,
                value: a
              }, null, _parent2, _scopeId));
            });
            _push2(`<!--]-->`);
          } else {
            return [
              (openBlock(true), createBlock(Fragment, null, renderList(actionOptions.value, (a) => {
                return openBlock(), createBlock(_component_el_option, {
                  key: a,
                  label: a,
                  value: a
                }, null, 8, ["label", "value"]);
              }), 128))
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div>`);
      _push(ssrRenderComponent(_component_el_text, {
        type: "info",
        size: "small"
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`共 ${ssrInterpolate(total.value)} 条记录`);
          } else {
            return [
              createTextVNode("共 " + toDisplayString(total.value) + " 条记录", 1)
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div><div${ssrRenderAttrs(mergeProps({ class: "record-grid record-grid--single" }, ssrGetDirectiveProps(_ctx, _directive_loading, loading.value)))}><!--[-->`);
      ssrRenderList(rows.value, (row) => {
        _push(`<div class="record-card"><div class="record-card__head"><div class="min-w-0"><div class="record-card__title">${ssrInterpolate(unref(formatDate)(row.created_at))}</div><div class="record-card__meta">${ssrInterpolate(row.admin_user || "—")}</div></div>`);
        _push(ssrRenderComponent(_component_el_tag, {
          size: "small",
          type: "info"
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`${ssrInterpolate(row.action)}`);
            } else {
              return [
                createTextVNode(toDisplayString(row.action), 1)
              ];
            }
          }),
          _: 2
        }, _parent));
        _push(`</div><div class="record-card__fields"><div class="kv-row"><span class="kv-label">目标</span><span class="kv-value">${ssrInterpolate(row.target || "—")}</span></div><div class="kv-row"><span class="kv-label">详情</span><span class="kv-value">${ssrInterpolate(row.detail || "—")}</span></div></div></div>`);
      });
      _push(`<!--]-->`);
      if (!loading.value && !rows.value.length) {
        _push(ssrRenderComponent(_component_el_empty, {
          description: "暂无记录",
          "image-size": 60
        }, null, _parent));
      } else {
        _push(`<!---->`);
      }
      _push(`</div><div class="pagination-wrap">`);
      _push(ssrRenderComponent(_component_el_pagination, {
        "current-page": page.value,
        "onUpdate:currentPage": ($event) => page.value = $event,
        "page-size": pageSize.value,
        total: total.value,
        layout: paginationLayout.value,
        "page-sizes": [20, 50, 100],
        small: paginationSmall.value,
        onCurrentChange: loadLogs,
        onSizeChange
      }, null, _parent));
      _push(`</div></div></div>`);
    };
  }
};
const _sfc_setup$6 = _sfc_main$6.setup;
_sfc_main$6.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/views/Audit.vue");
  return _sfc_setup$6 ? _sfc_setup$6(props, ctx) : void 0;
};
const _sfc_main$5 = {
  __name: "Admins",
  __ssrInlineRender: true,
  setup(__props) {
    const admins = ref([]);
    const nodeOptions = ref([]);
    const nodeOptsLoading = ref(false);
    const loading = ref(false);
    const dialogVisible = ref(false);
    const isEditing = ref(false);
    const editingId = ref(null);
    const saving = ref(false);
    const resetPwdVisible = ref(false);
    const resetting = ref(false);
    const allModules = [
      { value: "nodes", label: "节点管理" },
      { value: "users", label: "授权管理" },
      { value: "rules", label: "分流规则" },
      { value: "tunnels", label: "隧道状态" },
      { value: "audit", label: "审计日志" },
      { value: "admins", label: "管理员管理" }
    ];
    const roleOptions = [
      { value: "admin", label: "超级管理员 - 全部权限", tagType: "danger" },
      { value: "operator", label: "运维管理员 - 可配置指定模块", tagType: "warning" },
      { value: "viewer", label: "只读查看 - 仅查看指定模块", tagType: "info" }
    ];
    const form = ref({ username: "", password: "", role: "operator", permList: [], nodeIds: [] });
    const resetForm = ref({ id: null, username: "", newPassword: "" });
    const canManageAdmins = computed(() => isSuperAdminSession());
    const parsePerms = (s) => {
      if (!s) return [];
      return s.split(",").map((p) => p.trim()).filter(Boolean);
    };
    const permLabel = (p) => {
      const m = allModules.find((mod) => mod.value === p);
      return m ? m.label : p;
    };
    const roleLabel = (r) => {
      if (r === "admin") return "超级管理员";
      if (r === "operator") return "运维管理员";
      if (r === "viewer") return "只读查看";
      return r;
    };
    const roleTagType = (r) => {
      if (r === "admin") return "danger";
      if (r === "operator") return "warning";
      return "info";
    };
    const fetchAdmins = async () => {
      loading.value = true;
      try {
        admins.value = (await http.get("/api/admins")).data.items || [];
      } finally {
        loading.value = false;
      }
    };
    const loadNodeOptions = async () => {
      if (!canManageAdmins.value) return;
      nodeOptsLoading.value = true;
      try {
        const { data } = await http.get("/api/nodes");
        nodeOptions.value = (data.items || []).map((item) => item.node).filter(Boolean);
      } catch {
        nodeOptions.value = [];
      } finally {
        nodeOptsLoading.value = false;
      }
    };
    const openCreate = async () => {
      isEditing.value = false;
      editingId.value = null;
      form.value = {
        username: "",
        password: "",
        role: "operator",
        permList: ["nodes", "users", "rules", "tunnels", "audit"],
        nodeIds: []
      };
      await loadNodeOptions();
      dialogVisible.value = true;
    };
    const openEdit = async (row) => {
      isEditing.value = true;
      editingId.value = row.id;
      const perms = row.permissions === "*" ? allModules.map((m) => m.value) : parsePerms(row.permissions);
      const nids = row.node_scope === "scoped" && Array.isArray(row.node_ids) ? [...row.node_ids] : [];
      form.value = { username: row.username, password: "", role: row.role, permList: perms, nodeIds: nids };
      await loadNodeOptions();
      dialogVisible.value = true;
    };
    const handleSave = async () => {
      const permissions = form.value.role === "admin" ? "*" : form.value.permList.join(",");
      if (isEditing.value) {
        saving.value = true;
        try {
          const body = { role: form.value.role, permissions };
          if (form.value.role !== "admin") {
            body.node_ids = form.value.nodeIds || [];
          }
          await http.patch(`/api/admins/${editingId.value}`, body);
          ElMessage.success("更新成功");
          dialogVisible.value = false;
          fetchAdmins();
        } finally {
          saving.value = false;
        }
      } else {
        if (!form.value.username || !form.value.password) {
          ElMessage.warning("请填写用户名和密码");
          return;
        }
        if (form.value.password.length < 6) {
          ElMessage.warning("密码至少6位");
          return;
        }
        saving.value = true;
        try {
          const payload = {
            username: form.value.username,
            password: form.value.password,
            role: form.value.role,
            permissions
          };
          if (form.value.role !== "admin") {
            payload.node_ids = form.value.nodeIds || [];
          }
          await http.post("/api/admins", payload);
          ElMessage.success("创建成功");
          dialogVisible.value = false;
          fetchAdmins();
        } finally {
          saving.value = false;
        }
      }
    };
    const openResetPwd = (row) => {
      resetForm.value = { id: row.id, username: row.username, newPassword: "" };
      resetPwdVisible.value = true;
    };
    const handleResetPwd = async () => {
      if (resetForm.value.newPassword.length < 6) {
        ElMessage.warning("密码至少6位");
        return;
      }
      resetting.value = true;
      try {
        await http.post(`/api/admins/${resetForm.value.id}/reset-password`, {
          new_password: resetForm.value.newPassword
        });
        ElMessage.success("密码重置成功");
        resetPwdVisible.value = false;
      } finally {
        resetting.value = false;
      }
    };
    const handleDelete = async (row) => {
      try {
        await ElMessageBox.confirm(`确定删除管理员 "${row.username}" 吗？`, "确认删除", { type: "warning" });
        await http.delete(`/api/admins/${row.id}`);
        ElMessage.success("删除成功");
        fetchAdmins();
      } catch {
      }
    };
    onMounted(fetchAdmins);
    return (_ctx, _push, _parent, _attrs) => {
      const _component_el_button = resolveComponent("el-button");
      const _component_el_icon = resolveComponent("el-icon");
      const _component_Plus = resolveComponent("Plus");
      const _component_el_tag = resolveComponent("el-tag");
      const _component_el_text = resolveComponent("el-text");
      const _component_Edit = resolveComponent("Edit");
      const _component_Lock = resolveComponent("Lock");
      const _component_Delete = resolveComponent("Delete");
      const _component_el_alert = resolveComponent("el-alert");
      const _component_el_empty = resolveComponent("el-empty");
      const _component_el_dialog = resolveComponent("el-dialog");
      const _component_el_form = resolveComponent("el-form");
      const _component_el_form_item = resolveComponent("el-form-item");
      const _component_el_input = resolveComponent("el-input");
      const _component_el_select = resolveComponent("el-select");
      const _component_el_option = resolveComponent("el-option");
      const _component_el_checkbox_group = resolveComponent("el-checkbox-group");
      const _component_el_checkbox = resolveComponent("el-checkbox");
      const _directive_loading = resolveDirective("loading");
      _push(`<div${ssrRenderAttrs(_attrs)} data-v-67633754><div class="page-card" data-v-67633754><div class="page-card-header" data-v-67633754><span class="page-card-title" data-v-67633754>管理员管理</span>`);
      _push(ssrRenderComponent(_component_el_button, {
        type: "primary",
        onClick: openCreate,
        disabled: !canManageAdmins.value
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_icon, null, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_Plus, null, null, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_Plus)
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(` 添加管理员 `);
          } else {
            return [
              createVNode(_component_el_icon, null, {
                default: withCtx(() => [
                  createVNode(_component_Plus)
                ]),
                _: 1
              }),
              createTextVNode(" 添加管理员 ")
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div><div class="action-bar" data-v-67633754><div class="filter-group" data-v-67633754><!--[-->`);
      ssrRenderList(roleOptions, (r) => {
        _push(ssrRenderComponent(_component_el_tag, {
          key: r.value,
          type: r.tagType
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`${ssrInterpolate(r.label)}`);
            } else {
              return [
                createTextVNode(toDisplayString(r.label), 1)
              ];
            }
          }),
          _: 2
        }, _parent));
      });
      _push(`<!--]--></div>`);
      _push(ssrRenderComponent(_component_el_text, {
        type: "info",
        size: "small"
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`共 ${ssrInterpolate(admins.value.length)} 个管理员`);
          } else {
            return [
              createTextVNode("共 " + toDisplayString(admins.value.length) + " 个管理员", 1)
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div><div${ssrRenderAttrs(mergeProps({ class: "record-grid" }, ssrGetDirectiveProps(_ctx, _directive_loading, loading.value)))} data-v-67633754><!--[-->`);
      ssrRenderList(admins.value, (row) => {
        _push(`<div class="${ssrRenderClass([unref(recordCardToneFromTagType)(roleTagType(row.role)), "record-card"])}" data-v-67633754><div class="record-card__head" data-v-67633754><div class="min-w-0" data-v-67633754><div class="record-card__title" data-v-67633754>${ssrInterpolate(row.username)} `);
        if (row.username === "admin") {
          _push(ssrRenderComponent(_component_el_tag, {
            size: "small",
            type: "danger",
            style: { "margin-left": "6px" }
          }, {
            default: withCtx((_, _push2, _parent2, _scopeId) => {
              if (_push2) {
                _push2(`默认`);
              } else {
                return [
                  createTextVNode("默认")
                ];
              }
            }),
            _: 2
          }, _parent));
        } else {
          _push(`<!---->`);
        }
        _push(`</div><div class="record-card__meta" data-v-67633754>#${ssrInterpolate(row.id)} · ${ssrInterpolate(unref(formatDate)(row.created_at))}</div></div>`);
        _push(ssrRenderComponent(_component_el_tag, {
          type: roleTagType(row.role),
          size: "small"
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`${ssrInterpolate(roleLabel(row.role))}`);
            } else {
              return [
                createTextVNode(toDisplayString(roleLabel(row.role)), 1)
              ];
            }
          }),
          _: 2
        }, _parent));
        _push(`</div><div class="record-card__tags" data-v-67633754>`);
        if (row.permissions === "*" || row.role === "admin") {
          _push(ssrRenderComponent(_component_el_tag, {
            size: "small",
            type: "danger"
          }, {
            default: withCtx((_, _push2, _parent2, _scopeId) => {
              if (_push2) {
                _push2(`全部权限`);
              } else {
                return [
                  createTextVNode("全部权限")
                ];
              }
            }),
            _: 2
          }, _parent));
        } else {
          _push(`<!--[-->`);
          ssrRenderList(parsePerms(row.permissions), (p) => {
            _push(ssrRenderComponent(_component_el_tag, {
              key: p,
              size: "small",
              class: "perm-tag"
            }, {
              default: withCtx((_, _push2, _parent2, _scopeId) => {
                if (_push2) {
                  _push2(`${ssrInterpolate(permLabel(p))}`);
                } else {
                  return [
                    createTextVNode(toDisplayString(permLabel(p)), 1)
                  ];
                }
              }),
              _: 2
            }, _parent));
          });
          _push(`<!--]-->`);
        }
        if (row.node_scope === "scoped") {
          _push(ssrRenderComponent(_component_el_tag, {
            size: "small",
            type: "info",
            style: { "margin-left": "4px" }
          }, {
            default: withCtx((_, _push2, _parent2, _scopeId) => {
              if (_push2) {
                _push2(` 节点 ${ssrInterpolate(row.node_ids && row.node_ids.length || 0)} 个 `);
              } else {
                return [
                  createTextVNode(" 节点 " + toDisplayString(row.node_ids && row.node_ids.length || 0) + " 个 ", 1)
                ];
              }
            }),
            _: 2
          }, _parent));
        } else {
          _push(`<!---->`);
        }
        _push(`</div><div class="record-card__actions" data-v-67633754>`);
        _push(ssrRenderComponent(_component_el_button, {
          size: "small",
          plain: "",
          type: "primary",
          onClick: ($event) => openEdit(row),
          disabled: !canManageAdmins.value
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(ssrRenderComponent(_component_el_icon, null, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(ssrRenderComponent(_component_Edit, null, null, _parent3, _scopeId2));
                  } else {
                    return [
                      createVNode(_component_Edit)
                    ];
                  }
                }),
                _: 2
              }, _parent2, _scopeId));
              _push2(` 编辑 `);
            } else {
              return [
                createVNode(_component_el_icon, null, {
                  default: withCtx(() => [
                    createVNode(_component_Edit)
                  ]),
                  _: 1
                }),
                createTextVNode(" 编辑 ")
              ];
            }
          }),
          _: 2
        }, _parent));
        _push(ssrRenderComponent(_component_el_button, {
          size: "small",
          plain: "",
          type: "warning",
          onClick: ($event) => openResetPwd(row),
          disabled: !canManageAdmins.value
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(ssrRenderComponent(_component_el_icon, null, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(ssrRenderComponent(_component_Lock, null, null, _parent3, _scopeId2));
                  } else {
                    return [
                      createVNode(_component_Lock)
                    ];
                  }
                }),
                _: 2
              }, _parent2, _scopeId));
              _push2(` 重置密码 `);
            } else {
              return [
                createVNode(_component_el_icon, null, {
                  default: withCtx(() => [
                    createVNode(_component_Lock)
                  ]),
                  _: 1
                }),
                createTextVNode(" 重置密码 ")
              ];
            }
          }),
          _: 2
        }, _parent));
        _push(ssrRenderComponent(_component_el_button, {
          size: "small",
          plain: "",
          type: "danger",
          onClick: ($event) => handleDelete(row),
          disabled: !canManageAdmins.value || row.username === "admin"
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(ssrRenderComponent(_component_el_icon, null, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(ssrRenderComponent(_component_Delete, null, null, _parent3, _scopeId2));
                  } else {
                    return [
                      createVNode(_component_Delete)
                    ];
                  }
                }),
                _: 2
              }, _parent2, _scopeId));
              _push2(` 删除 `);
            } else {
              return [
                createVNode(_component_el_icon, null, {
                  default: withCtx(() => [
                    createVNode(_component_Delete)
                  ]),
                  _: 1
                }),
                createTextVNode(" 删除 ")
              ];
            }
          }),
          _: 2
        }, _parent));
        _push(`</div></div>`);
      });
      _push(`<!--]-->`);
      if (!canManageAdmins.value && admins.value.length) {
        _push(ssrRenderComponent(_component_el_alert, {
          type: "info",
          closable: false,
          "show-icon": "",
          style: { "margin-top": "12px" }
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(` 当前账号仅有「管理员管理」查看权限；添加、编辑、重置密码、删除需超级管理员（角色为超级管理员，或权限为 *）。 `);
            } else {
              return [
                createTextVNode(" 当前账号仅有「管理员管理」查看权限；添加、编辑、重置密码、删除需超级管理员（角色为超级管理员，或权限为 *）。 ")
              ];
            }
          }),
          _: 1
        }, _parent));
      } else {
        _push(`<!---->`);
      }
      if (!loading.value && !admins.value.length) {
        _push(ssrRenderComponent(_component_el_empty, {
          description: "暂无管理员",
          "image-size": 60
        }, null, _parent));
      } else {
        _push(`<!---->`);
      }
      _push(`</div></div>`);
      _push(ssrRenderComponent(_component_el_dialog, {
        modelValue: dialogVisible.value,
        "onUpdate:modelValue": ($event) => dialogVisible.value = $event,
        title: isEditing.value ? "编辑管理员" : "添加管理员",
        width: "560px",
        "destroy-on-close": ""
      }, {
        footer: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_button, {
              onClick: ($event) => dialogVisible.value = false
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`取消`);
                } else {
                  return [
                    createTextVNode("取消")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_button, {
              type: "primary",
              loading: saving.value,
              onClick: handleSave
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`确定`);
                } else {
                  return [
                    createTextVNode("确定")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_button, {
                onClick: ($event) => dialogVisible.value = false
              }, {
                default: withCtx(() => [
                  createTextVNode("取消")
                ]),
                _: 1
              }, 8, ["onClick"]),
              createVNode(_component_el_button, {
                type: "primary",
                loading: saving.value,
                onClick: handleSave
              }, {
                default: withCtx(() => [
                  createTextVNode("确定")
                ]),
                _: 1
              }, 8, ["loading"])
            ];
          }
        }),
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_form, {
              model: form.value,
              "label-width": "80px"
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "用户名" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: form.value.username,
                          "onUpdate:modelValue": ($event) => form.value.username = $event,
                          disabled: isEditing.value,
                          placeholder: "请输入用户名"
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: form.value.username,
                            "onUpdate:modelValue": ($event) => form.value.username = $event,
                            disabled: isEditing.value,
                            placeholder: "请输入用户名"
                          }, null, 8, ["modelValue", "onUpdate:modelValue", "disabled"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  if (!isEditing.value) {
                    _push3(ssrRenderComponent(_component_el_form_item, { label: "密码" }, {
                      default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                        if (_push4) {
                          _push4(ssrRenderComponent(_component_el_input, {
                            modelValue: form.value.password,
                            "onUpdate:modelValue": ($event) => form.value.password = $event,
                            type: "password",
                            "show-password": "",
                            placeholder: "至少6位"
                          }, null, _parent4, _scopeId3));
                        } else {
                          return [
                            createVNode(_component_el_input, {
                              modelValue: form.value.password,
                              "onUpdate:modelValue": ($event) => form.value.password = $event,
                              type: "password",
                              "show-password": "",
                              placeholder: "至少6位"
                            }, null, 8, ["modelValue", "onUpdate:modelValue"])
                          ];
                        }
                      }),
                      _: 1
                    }, _parent3, _scopeId2));
                  } else {
                    _push3(`<!---->`);
                  }
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "角色" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_select, {
                          modelValue: form.value.role,
                          "onUpdate:modelValue": ($event) => form.value.role = $event,
                          style: { "width": "100%" }
                        }, {
                          default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                            if (_push5) {
                              _push5(ssrRenderComponent(_component_el_option, {
                                label: "超级管理员",
                                value: "admin"
                              }, null, _parent5, _scopeId4));
                              _push5(ssrRenderComponent(_component_el_option, {
                                label: "运维管理员",
                                value: "operator"
                              }, null, _parent5, _scopeId4));
                              _push5(ssrRenderComponent(_component_el_option, {
                                label: "只读查看",
                                value: "viewer"
                              }, null, _parent5, _scopeId4));
                            } else {
                              return [
                                createVNode(_component_el_option, {
                                  label: "超级管理员",
                                  value: "admin"
                                }),
                                createVNode(_component_el_option, {
                                  label: "运维管理员",
                                  value: "operator"
                                }),
                                createVNode(_component_el_option, {
                                  label: "只读查看",
                                  value: "viewer"
                                })
                              ];
                            }
                          }),
                          _: 1
                        }, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_select, {
                            modelValue: form.value.role,
                            "onUpdate:modelValue": ($event) => form.value.role = $event,
                            style: { "width": "100%" }
                          }, {
                            default: withCtx(() => [
                              createVNode(_component_el_option, {
                                label: "超级管理员",
                                value: "admin"
                              }),
                              createVNode(_component_el_option, {
                                label: "运维管理员",
                                value: "operator"
                              }),
                              createVNode(_component_el_option, {
                                label: "只读查看",
                                value: "viewer"
                              })
                            ]),
                            _: 1
                          }, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  if (form.value.role !== "admin") {
                    _push3(ssrRenderComponent(_component_el_form_item, { label: "权限" }, {
                      default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                        if (_push4) {
                          _push4(ssrRenderComponent(_component_el_checkbox_group, {
                            modelValue: form.value.permList,
                            "onUpdate:modelValue": ($event) => form.value.permList = $event
                          }, {
                            default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                              if (_push5) {
                                _push5(`<!--[-->`);
                                ssrRenderList(allModules, (m) => {
                                  _push5(ssrRenderComponent(_component_el_checkbox, {
                                    key: m.value,
                                    label: m.value
                                  }, {
                                    default: withCtx((_5, _push6, _parent6, _scopeId5) => {
                                      if (_push6) {
                                        _push6(`${ssrInterpolate(m.label)}`);
                                      } else {
                                        return [
                                          createTextVNode(toDisplayString(m.label), 1)
                                        ];
                                      }
                                    }),
                                    _: 2
                                  }, _parent5, _scopeId4));
                                });
                                _push5(`<!--]-->`);
                              } else {
                                return [
                                  (openBlock(), createBlock(Fragment, null, renderList(allModules, (m) => {
                                    return createVNode(_component_el_checkbox, {
                                      key: m.value,
                                      label: m.value
                                    }, {
                                      default: withCtx(() => [
                                        createTextVNode(toDisplayString(m.label), 1)
                                      ]),
                                      _: 2
                                    }, 1032, ["label"]);
                                  }), 64))
                                ];
                              }
                            }),
                            _: 1
                          }, _parent4, _scopeId3));
                        } else {
                          return [
                            createVNode(_component_el_checkbox_group, {
                              modelValue: form.value.permList,
                              "onUpdate:modelValue": ($event) => form.value.permList = $event
                            }, {
                              default: withCtx(() => [
                                (openBlock(), createBlock(Fragment, null, renderList(allModules, (m) => {
                                  return createVNode(_component_el_checkbox, {
                                    key: m.value,
                                    label: m.value
                                  }, {
                                    default: withCtx(() => [
                                      createTextVNode(toDisplayString(m.label), 1)
                                    ]),
                                    _: 2
                                  }, 1032, ["label"]);
                                }), 64))
                              ]),
                              _: 1
                            }, 8, ["modelValue", "onUpdate:modelValue"])
                          ];
                        }
                      }),
                      _: 1
                    }, _parent3, _scopeId2));
                  } else {
                    _push3(`<!---->`);
                  }
                  if (form.value.role !== "admin") {
                    _push3(ssrRenderComponent(_component_el_form_item, { label: "节点范围" }, {
                      default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                        if (_push4) {
                          _push4(ssrRenderComponent(_component_el_select, {
                            modelValue: form.value.nodeIds,
                            "onUpdate:modelValue": ($event) => form.value.nodeIds = $event,
                            multiple: "",
                            filterable: "",
                            "collapse-tags": "",
                            "collapse-tags-tooltip": "",
                            placeholder: "选择可管理的节点（不选则列表为空）",
                            style: { "width": "100%" },
                            loading: nodeOptsLoading.value
                          }, {
                            default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                              if (_push5) {
                                _push5(`<!--[-->`);
                                ssrRenderList(nodeOptions.value, (n) => {
                                  _push5(ssrRenderComponent(_component_el_option, {
                                    key: n.id,
                                    label: `${n.name} (${n.id})`,
                                    value: n.id
                                  }, null, _parent5, _scopeId4));
                                });
                                _push5(`<!--]-->`);
                              } else {
                                return [
                                  (openBlock(true), createBlock(Fragment, null, renderList(nodeOptions.value, (n) => {
                                    return openBlock(), createBlock(_component_el_option, {
                                      key: n.id,
                                      label: `${n.name} (${n.id})`,
                                      value: n.id
                                    }, null, 8, ["label", "value"]);
                                  }), 128))
                                ];
                              }
                            }),
                            _: 1
                          }, _parent4, _scopeId3));
                          _push4(ssrRenderComponent(_component_el_text, {
                            type: "info",
                            size: "small",
                            style: { "display": "block", "margin-top": "6px" }
                          }, {
                            default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                              if (_push5) {
                                _push5(` 决定「节点管理」「授权」等可见的节点；超级管理员不受此限制。 `);
                              } else {
                                return [
                                  createTextVNode(" 决定「节点管理」「授权」等可见的节点；超级管理员不受此限制。 ")
                                ];
                              }
                            }),
                            _: 1
                          }, _parent4, _scopeId3));
                        } else {
                          return [
                            createVNode(_component_el_select, {
                              modelValue: form.value.nodeIds,
                              "onUpdate:modelValue": ($event) => form.value.nodeIds = $event,
                              multiple: "",
                              filterable: "",
                              "collapse-tags": "",
                              "collapse-tags-tooltip": "",
                              placeholder: "选择可管理的节点（不选则列表为空）",
                              style: { "width": "100%" },
                              loading: nodeOptsLoading.value
                            }, {
                              default: withCtx(() => [
                                (openBlock(true), createBlock(Fragment, null, renderList(nodeOptions.value, (n) => {
                                  return openBlock(), createBlock(_component_el_option, {
                                    key: n.id,
                                    label: `${n.name} (${n.id})`,
                                    value: n.id
                                  }, null, 8, ["label", "value"]);
                                }), 128))
                              ]),
                              _: 1
                            }, 8, ["modelValue", "onUpdate:modelValue", "loading"]),
                            createVNode(_component_el_text, {
                              type: "info",
                              size: "small",
                              style: { "display": "block", "margin-top": "6px" }
                            }, {
                              default: withCtx(() => [
                                createTextVNode(" 决定「节点管理」「授权」等可见的节点；超级管理员不受此限制。 ")
                              ]),
                              _: 1
                            })
                          ];
                        }
                      }),
                      _: 1
                    }, _parent3, _scopeId2));
                  } else {
                    _push3(`<!---->`);
                  }
                } else {
                  return [
                    createVNode(_component_el_form_item, { label: "用户名" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: form.value.username,
                          "onUpdate:modelValue": ($event) => form.value.username = $event,
                          disabled: isEditing.value,
                          placeholder: "请输入用户名"
                        }, null, 8, ["modelValue", "onUpdate:modelValue", "disabled"])
                      ]),
                      _: 1
                    }),
                    !isEditing.value ? (openBlock(), createBlock(_component_el_form_item, {
                      key: 0,
                      label: "密码"
                    }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: form.value.password,
                          "onUpdate:modelValue": ($event) => form.value.password = $event,
                          type: "password",
                          "show-password": "",
                          placeholder: "至少6位"
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    })) : createCommentVNode("", true),
                    createVNode(_component_el_form_item, { label: "角色" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_select, {
                          modelValue: form.value.role,
                          "onUpdate:modelValue": ($event) => form.value.role = $event,
                          style: { "width": "100%" }
                        }, {
                          default: withCtx(() => [
                            createVNode(_component_el_option, {
                              label: "超级管理员",
                              value: "admin"
                            }),
                            createVNode(_component_el_option, {
                              label: "运维管理员",
                              value: "operator"
                            }),
                            createVNode(_component_el_option, {
                              label: "只读查看",
                              value: "viewer"
                            })
                          ]),
                          _: 1
                        }, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    form.value.role !== "admin" ? (openBlock(), createBlock(_component_el_form_item, {
                      key: 1,
                      label: "权限"
                    }, {
                      default: withCtx(() => [
                        createVNode(_component_el_checkbox_group, {
                          modelValue: form.value.permList,
                          "onUpdate:modelValue": ($event) => form.value.permList = $event
                        }, {
                          default: withCtx(() => [
                            (openBlock(), createBlock(Fragment, null, renderList(allModules, (m) => {
                              return createVNode(_component_el_checkbox, {
                                key: m.value,
                                label: m.value
                              }, {
                                default: withCtx(() => [
                                  createTextVNode(toDisplayString(m.label), 1)
                                ]),
                                _: 2
                              }, 1032, ["label"]);
                            }), 64))
                          ]),
                          _: 1
                        }, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    })) : createCommentVNode("", true),
                    form.value.role !== "admin" ? (openBlock(), createBlock(_component_el_form_item, {
                      key: 2,
                      label: "节点范围"
                    }, {
                      default: withCtx(() => [
                        createVNode(_component_el_select, {
                          modelValue: form.value.nodeIds,
                          "onUpdate:modelValue": ($event) => form.value.nodeIds = $event,
                          multiple: "",
                          filterable: "",
                          "collapse-tags": "",
                          "collapse-tags-tooltip": "",
                          placeholder: "选择可管理的节点（不选则列表为空）",
                          style: { "width": "100%" },
                          loading: nodeOptsLoading.value
                        }, {
                          default: withCtx(() => [
                            (openBlock(true), createBlock(Fragment, null, renderList(nodeOptions.value, (n) => {
                              return openBlock(), createBlock(_component_el_option, {
                                key: n.id,
                                label: `${n.name} (${n.id})`,
                                value: n.id
                              }, null, 8, ["label", "value"]);
                            }), 128))
                          ]),
                          _: 1
                        }, 8, ["modelValue", "onUpdate:modelValue", "loading"]),
                        createVNode(_component_el_text, {
                          type: "info",
                          size: "small",
                          style: { "display": "block", "margin-top": "6px" }
                        }, {
                          default: withCtx(() => [
                            createTextVNode(" 决定「节点管理」「授权」等可见的节点；超级管理员不受此限制。 ")
                          ]),
                          _: 1
                        })
                      ]),
                      _: 1
                    })) : createCommentVNode("", true)
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_form, {
                model: form.value,
                "label-width": "80px"
              }, {
                default: withCtx(() => [
                  createVNode(_component_el_form_item, { label: "用户名" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: form.value.username,
                        "onUpdate:modelValue": ($event) => form.value.username = $event,
                        disabled: isEditing.value,
                        placeholder: "请输入用户名"
                      }, null, 8, ["modelValue", "onUpdate:modelValue", "disabled"])
                    ]),
                    _: 1
                  }),
                  !isEditing.value ? (openBlock(), createBlock(_component_el_form_item, {
                    key: 0,
                    label: "密码"
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: form.value.password,
                        "onUpdate:modelValue": ($event) => form.value.password = $event,
                        type: "password",
                        "show-password": "",
                        placeholder: "至少6位"
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  })) : createCommentVNode("", true),
                  createVNode(_component_el_form_item, { label: "角色" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_select, {
                        modelValue: form.value.role,
                        "onUpdate:modelValue": ($event) => form.value.role = $event,
                        style: { "width": "100%" }
                      }, {
                        default: withCtx(() => [
                          createVNode(_component_el_option, {
                            label: "超级管理员",
                            value: "admin"
                          }),
                          createVNode(_component_el_option, {
                            label: "运维管理员",
                            value: "operator"
                          }),
                          createVNode(_component_el_option, {
                            label: "只读查看",
                            value: "viewer"
                          })
                        ]),
                        _: 1
                      }, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  form.value.role !== "admin" ? (openBlock(), createBlock(_component_el_form_item, {
                    key: 1,
                    label: "权限"
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_el_checkbox_group, {
                        modelValue: form.value.permList,
                        "onUpdate:modelValue": ($event) => form.value.permList = $event
                      }, {
                        default: withCtx(() => [
                          (openBlock(), createBlock(Fragment, null, renderList(allModules, (m) => {
                            return createVNode(_component_el_checkbox, {
                              key: m.value,
                              label: m.value
                            }, {
                              default: withCtx(() => [
                                createTextVNode(toDisplayString(m.label), 1)
                              ]),
                              _: 2
                            }, 1032, ["label"]);
                          }), 64))
                        ]),
                        _: 1
                      }, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  })) : createCommentVNode("", true),
                  form.value.role !== "admin" ? (openBlock(), createBlock(_component_el_form_item, {
                    key: 2,
                    label: "节点范围"
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_el_select, {
                        modelValue: form.value.nodeIds,
                        "onUpdate:modelValue": ($event) => form.value.nodeIds = $event,
                        multiple: "",
                        filterable: "",
                        "collapse-tags": "",
                        "collapse-tags-tooltip": "",
                        placeholder: "选择可管理的节点（不选则列表为空）",
                        style: { "width": "100%" },
                        loading: nodeOptsLoading.value
                      }, {
                        default: withCtx(() => [
                          (openBlock(true), createBlock(Fragment, null, renderList(nodeOptions.value, (n) => {
                            return openBlock(), createBlock(_component_el_option, {
                              key: n.id,
                              label: `${n.name} (${n.id})`,
                              value: n.id
                            }, null, 8, ["label", "value"]);
                          }), 128))
                        ]),
                        _: 1
                      }, 8, ["modelValue", "onUpdate:modelValue", "loading"]),
                      createVNode(_component_el_text, {
                        type: "info",
                        size: "small",
                        style: { "display": "block", "margin-top": "6px" }
                      }, {
                        default: withCtx(() => [
                          createTextVNode(" 决定「节点管理」「授权」等可见的节点；超级管理员不受此限制。 ")
                        ]),
                        _: 1
                      })
                    ]),
                    _: 1
                  })) : createCommentVNode("", true)
                ]),
                _: 1
              }, 8, ["model"])
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(ssrRenderComponent(_component_el_dialog, {
        modelValue: resetPwdVisible.value,
        "onUpdate:modelValue": ($event) => resetPwdVisible.value = $event,
        title: "重置密码",
        width: "400px",
        "destroy-on-close": ""
      }, {
        footer: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_button, {
              onClick: ($event) => resetPwdVisible.value = false
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`取消`);
                } else {
                  return [
                    createTextVNode("取消")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_button, {
              type: "primary",
              loading: resetting.value,
              onClick: handleResetPwd
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`确定`);
                } else {
                  return [
                    createTextVNode("确定")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_button, {
                onClick: ($event) => resetPwdVisible.value = false
              }, {
                default: withCtx(() => [
                  createTextVNode("取消")
                ]),
                _: 1
              }, 8, ["onClick"]),
              createVNode(_component_el_button, {
                type: "primary",
                loading: resetting.value,
                onClick: handleResetPwd
              }, {
                default: withCtx(() => [
                  createTextVNode("确定")
                ]),
                _: 1
              }, 8, ["loading"])
            ];
          }
        }),
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_form, {
              model: resetForm.value,
              "label-width": "80px"
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "管理员" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          "model-value": resetForm.value.username,
                          disabled: ""
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            "model-value": resetForm.value.username,
                            disabled: ""
                          }, null, 8, ["model-value"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "新密码" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: resetForm.value.newPassword,
                          "onUpdate:modelValue": ($event) => resetForm.value.newPassword = $event,
                          type: "password",
                          "show-password": "",
                          placeholder: "至少6位"
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: resetForm.value.newPassword,
                            "onUpdate:modelValue": ($event) => resetForm.value.newPassword = $event,
                            type: "password",
                            "show-password": "",
                            placeholder: "至少6位"
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_el_form_item, { label: "管理员" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          "model-value": resetForm.value.username,
                          disabled: ""
                        }, null, 8, ["model-value"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "新密码" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: resetForm.value.newPassword,
                          "onUpdate:modelValue": ($event) => resetForm.value.newPassword = $event,
                          type: "password",
                          "show-password": "",
                          placeholder: "至少6位"
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    })
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_form, {
                model: resetForm.value,
                "label-width": "80px"
              }, {
                default: withCtx(() => [
                  createVNode(_component_el_form_item, { label: "管理员" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        "model-value": resetForm.value.username,
                        disabled: ""
                      }, null, 8, ["model-value"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "新密码" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: resetForm.value.newPassword,
                        "onUpdate:modelValue": ($event) => resetForm.value.newPassword = $event,
                        type: "password",
                        "show-password": "",
                        placeholder: "至少6位"
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  })
                ]),
                _: 1
              }, 8, ["model"])
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div>`);
    };
  }
};
const _sfc_setup$5 = _sfc_main$5.setup;
_sfc_main$5.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/views/Admins.vue");
  return _sfc_setup$5 ? _sfc_setup$5(props, ctx) : void 0;
};
const Admins = /* @__PURE__ */ _export_sfc(_sfc_main$5, [["__scopeId", "data-v-67633754"]]);
const LOGIN_DRAFT_KEY = "vpn_web_login_draft";
const _sfc_main$4 = {
  __name: "Login",
  __ssrInlineRender: true,
  setup(__props) {
    const loading = ref(false);
    const apiOpen = ref(true);
    const form = reactive({ username: "", password: "" });
    const apiBaseInput = ref("");
    function loadLoginDraft() {
      try {
        const raw = localStorage.getItem(LOGIN_DRAFT_KEY);
        if (!raw) return;
        const o = JSON.parse(raw);
        if (o && typeof o.username === "string") form.username = o.username;
        if (o && typeof o.password === "string") form.password = o.password;
      } catch {
      }
    }
    function saveLoginDraft() {
      try {
        localStorage.setItem(
          LOGIN_DRAFT_KEY,
          JSON.stringify({ username: form.username, password: form.password })
        );
      } catch {
      }
    }
    onMounted(() => {
      const raw = localStorage.getItem(API_BASE_STORAGE_KEY);
      apiBaseInput.value = raw !== null ? raw : "";
      loadLoginDraft();
    });
    watch(
      () => [form.username, form.password],
      () => {
        saveLoginDraft();
      }
    );
    const saveApiBase = () => {
      setApiBaseURL(apiBaseInput.value);
      ElMessage.success("API 地址已保存");
    };
    const onSubmit = async () => {
      if (!form.username || !form.password) {
        ElMessage.warning("请输入用户名和密码");
        return;
      }
      loading.value = true;
      try {
        const res = await http.post("/api/auth/login", form);
        setAuthSession({ token: res.data.token, admin: res.data.admin });
        ElMessage.success("登录成功");
        routerProxy.push("/");
      } catch {
      } finally {
        loading.value = false;
      }
    };
    return (_ctx, _push, _parent, _attrs) => {
      const _component_el_form = resolveComponent("el-form");
      const _component_el_form_item = resolveComponent("el-form-item");
      const _component_el_input = resolveComponent("el-input");
      const _component_el_button = resolveComponent("el-button");
      const _component_el_icon = resolveComponent("el-icon");
      _push(`<div${ssrRenderAttrs(mergeProps({ class: "login-page" }, _attrs))} data-v-3d1a3c9d><div class="login-stack" data-v-3d1a3c9d><header class="login-brand" data-v-3d1a3c9d><div class="brand-logo" aria-hidden="true" data-v-3d1a3c9d>V</div><h1 class="brand-title" data-v-3d1a3c9d>VPN 管理中心</h1><p class="brand-sub" data-v-3d1a3c9d> 企业级 VPN 控制面 · 与控制台同一套界面规范 </p></header><div class="login-card" data-v-3d1a3c9d><section class="card-block" data-v-3d1a3c9d>`);
      _push(ssrRenderComponent(_component_el_form, {
        model: form,
        onSubmit,
        size: "large",
        class: "login-form"
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_form_item, null, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_input, {
                    modelValue: form.username,
                    "onUpdate:modelValue": ($event) => form.username = $event,
                    placeholder: "用户名",
                    "prefix-icon": unref(User),
                    autocomplete: "username"
                  }, null, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_el_input, {
                      modelValue: form.username,
                      "onUpdate:modelValue": ($event) => form.username = $event,
                      placeholder: "用户名",
                      "prefix-icon": unref(User),
                      autocomplete: "username"
                    }, null, 8, ["modelValue", "onUpdate:modelValue", "prefix-icon"])
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_form_item, null, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_input, {
                    modelValue: form.password,
                    "onUpdate:modelValue": ($event) => form.password = $event,
                    type: "password",
                    placeholder: "密码",
                    "show-password": "",
                    "prefix-icon": unref(Lock),
                    autocomplete: "current-password",
                    onKeyup: onSubmit
                  }, null, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_el_input, {
                      modelValue: form.password,
                      "onUpdate:modelValue": ($event) => form.password = $event,
                      type: "password",
                      placeholder: "密码",
                      "show-password": "",
                      "prefix-icon": unref(Lock),
                      autocomplete: "current-password",
                      onKeyup: withKeys(onSubmit, ["enter"])
                    }, null, 8, ["modelValue", "onUpdate:modelValue", "prefix-icon"])
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_button, {
              type: "primary",
              loading: loading.value,
              class: "login-btn",
              onClick: onSubmit
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(` 登录 `);
                } else {
                  return [
                    createTextVNode(" 登录 ")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_form_item, null, {
                default: withCtx(() => [
                  createVNode(_component_el_input, {
                    modelValue: form.username,
                    "onUpdate:modelValue": ($event) => form.username = $event,
                    placeholder: "用户名",
                    "prefix-icon": unref(User),
                    autocomplete: "username"
                  }, null, 8, ["modelValue", "onUpdate:modelValue", "prefix-icon"])
                ]),
                _: 1
              }),
              createVNode(_component_el_form_item, null, {
                default: withCtx(() => [
                  createVNode(_component_el_input, {
                    modelValue: form.password,
                    "onUpdate:modelValue": ($event) => form.password = $event,
                    type: "password",
                    placeholder: "密码",
                    "show-password": "",
                    "prefix-icon": unref(Lock),
                    autocomplete: "current-password",
                    onKeyup: withKeys(onSubmit, ["enter"])
                  }, null, 8, ["modelValue", "onUpdate:modelValue", "prefix-icon"])
                ]),
                _: 1
              }),
              createVNode(_component_el_button, {
                type: "primary",
                loading: loading.value,
                class: "login-btn",
                onClick: onSubmit
              }, {
                default: withCtx(() => [
                  createTextVNode(" 登录 ")
                ]),
                _: 1
              }, 8, ["loading"])
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</section><div class="card-divider" data-v-3d1a3c9d></div><section class="card-block api-block" data-v-3d1a3c9d><button type="button" class="api-header"${ssrRenderAttr("aria-expanded", apiOpen.value)} data-v-3d1a3c9d><span class="api-header-main" data-v-3d1a3c9d><span class="api-title" data-v-3d1a3c9d>API 根地址</span><span class="api-badge" data-v-3d1a3c9d>前后端分离时填写</span></span>`);
      _push(ssrRenderComponent(_component_el_icon, {
        class: ["api-chevron", { open: apiOpen.value }]
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(unref(ArrowDown), null, null, _parent2, _scopeId));
          } else {
            return [
              createVNode(unref(ArrowDown))
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</button><div class="api-body" style="${ssrRenderStyle(apiOpen.value ? null : { display: "none" })}" data-v-3d1a3c9d><div class="api-row" data-v-3d1a3c9d>`);
      _push(ssrRenderComponent(_component_el_input, {
        modelValue: apiBaseInput.value,
        "onUpdate:modelValue": ($event) => apiBaseInput.value = $event,
        placeholder: "例如 https://vpnapi.example.com",
        clearable: ""
      }, null, _parent));
      _push(ssrRenderComponent(_component_el_button, {
        type: "primary",
        onClick: saveApiBase
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(`保存`);
          } else {
            return [
              createTextVNode("保存")
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div><p class="api-tip" data-v-3d1a3c9d> 无尾部斜杠、不要带 /api。登录后可在侧栏「API 连接」修改。 </p></div></section></div></div></div>`);
    };
  }
};
const _sfc_setup$4 = _sfc_main$4.setup;
_sfc_main$4.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/views/Login.vue");
  return _sfc_setup$4 ? _sfc_setup$4(props, ctx) : void 0;
};
const Login = /* @__PURE__ */ _export_sfc(_sfc_main$4, [["__scopeId", "data-v-3d1a3c9d"]]);
const _sfc_main$3 = {
  __name: "SelfService",
  __ssrInlineRender: true,
  setup(__props) {
    const username = ref("");
    const loggedIn = ref(false);
    const loading = ref(false);
    const grants = ref([]);
    const doLogin = async () => {
      var _a, _b, _c;
      if (!username.value) return;
      loading.value = true;
      try {
        const res = await publicHttp.get("/api/self-service/lookup", { params: { username: username.value } });
        grants.value = res.data.grants || [];
        loggedIn.value = true;
      } catch (err) {
        const msg = (_b = (_a = err == null ? void 0 : err.response) == null ? void 0 : _a.data) == null ? void 0 : _b.error;
        if (((_c = err == null ? void 0 : err.response) == null ? void 0 : _c.status) === 404) {
          ElMessage.error("用户名不存在");
        } else {
          ElMessage.error(msg || "查询失败，请联系管理员");
        }
      } finally {
        loading.value = false;
      }
    };
    const download = (grantId) => {
      const path = `/api/self-service/grants/${grantId}/download?username=${encodeURIComponent(username.value)}`;
      const root = getApiBaseURL();
      window.open(root ? `${root}${path}` : path, "_blank");
    };
    return (_ctx, _push, _parent, _attrs) => {
      const _component_el_form = resolveComponent("el-form");
      const _component_el_form_item = resolveComponent("el-form-item");
      const _component_el_input = resolveComponent("el-input");
      const _component_el_button = resolveComponent("el-button");
      const _component_el_page_header = resolveComponent("el-page-header");
      const _component_el_tag = resolveComponent("el-tag");
      const _component_el_alert = resolveComponent("el-alert");
      _push(`<div${ssrRenderAttrs(mergeProps({ class: "portal-page" }, _attrs))} data-v-33e8c22c><div class="portal-shell" data-v-33e8c22c><header class="portal-brand" data-v-33e8c22c><div class="portal-brand__logo" data-v-33e8c22c>V</div><div class="portal-brand__text" data-v-33e8c22c><h1 class="portal-brand__title" data-v-33e8c22c>员工自助门户</h1><p class="portal-brand__desc" data-v-33e8c22c>使用用户名查询并下载个人 VPN 配置（与管理中心同一套视觉规范）</p></div></header>`);
      if (!loggedIn.value) {
        _push(`<div class="record-card portal-card" data-v-33e8c22c><h2 class="portal-card__title" data-v-33e8c22c>查找我的配置</h2><p class="portal-card__subtitle" data-v-33e8c22c>输入你在系统中登记的用户名</p>`);
        _push(ssrRenderComponent(_component_el_form, {
          class: "portal-form",
          onSubmit: doLogin
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(ssrRenderComponent(_component_el_form_item, { label: "用户名" }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(ssrRenderComponent(_component_el_input, {
                      modelValue: username.value,
                      "onUpdate:modelValue": ($event) => username.value = $event,
                      placeholder: "输入你的用户名",
                      clearable: ""
                    }, null, _parent3, _scopeId2));
                  } else {
                    return [
                      createVNode(_component_el_input, {
                        modelValue: username.value,
                        "onUpdate:modelValue": ($event) => username.value = $event,
                        placeholder: "输入你的用户名",
                        clearable: ""
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ];
                  }
                }),
                _: 1
              }, _parent2, _scopeId));
              _push2(ssrRenderComponent(_component_el_button, {
                type: "primary",
                class: "portal-submit",
                loading: loading.value,
                onClick: doLogin
              }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(` 查看我的配置 `);
                  } else {
                    return [
                      createTextVNode(" 查看我的配置 ")
                    ];
                  }
                }),
                _: 1
              }, _parent2, _scopeId));
            } else {
              return [
                createVNode(_component_el_form_item, { label: "用户名" }, {
                  default: withCtx(() => [
                    createVNode(_component_el_input, {
                      modelValue: username.value,
                      "onUpdate:modelValue": ($event) => username.value = $event,
                      placeholder: "输入你的用户名",
                      clearable: ""
                    }, null, 8, ["modelValue", "onUpdate:modelValue"])
                  ]),
                  _: 1
                }),
                createVNode(_component_el_button, {
                  type: "primary",
                  class: "portal-submit",
                  loading: loading.value,
                  onClick: doLogin
                }, {
                  default: withCtx(() => [
                    createTextVNode(" 查看我的配置 ")
                  ]),
                  _: 1
                }, 8, ["loading"])
              ];
            }
          }),
          _: 1
        }, _parent));
        _push(`</div>`);
      } else {
        _push(`<!--[--><div class="record-card portal-card portal-card--header" data-v-33e8c22c>`);
        _push(ssrRenderComponent(_component_el_page_header, {
          class: "portal-page-header",
          onBack: ($event) => loggedIn.value = false
        }, {
          content: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`<span class="portal-page-header__title" data-v-33e8c22c${_scopeId}>我的 VPN 配置</span>`);
              _push2(ssrRenderComponent(_component_el_tag, {
                type: "info",
                size: "small",
                effect: "plain",
                class: "portal-page-header__user"
              }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(`${ssrInterpolate(username.value)}`);
                  } else {
                    return [
                      createTextVNode(toDisplayString(username.value), 1)
                    ];
                  }
                }),
                _: 1
              }, _parent2, _scopeId));
            } else {
              return [
                createVNode("span", { class: "portal-page-header__title" }, "我的 VPN 配置"),
                createVNode(_component_el_tag, {
                  type: "info",
                  size: "small",
                  effect: "plain",
                  class: "portal-page-header__user"
                }, {
                  default: withCtx(() => [
                    createTextVNode(toDisplayString(username.value), 1)
                  ]),
                  _: 1
                })
              ];
            }
          }),
          _: 1
        }, _parent));
        _push(`</div>`);
        if (!grants.value.length) {
          _push(ssrRenderComponent(_component_el_alert, {
            type: "info",
            title: "暂无可用配置",
            description: "管理员尚未为你分配 VPN 访问权限，请联系 IT 部门。",
            closable: false,
            class: "portal-alert"
          }, null, _parent));
        } else {
          _push(`<div class="record-grid record-grid--single portal-grants" data-v-33e8c22c><!--[-->`);
          ssrRenderList(grants.value, (g) => {
            _push(`<div class="${ssrRenderClass([unref(recordCardToneClass)("cert", g.cert_status), "record-card grant-card"])}" data-v-33e8c22c><div class="record-card__head grant-card__head" data-v-33e8c22c><div class="min-w-0" data-v-33e8c22c><div class="record-card__title mono-text" data-v-33e8c22c>${ssrInterpolate(g.cert_cn)}</div><div class="record-card__meta grant-card__hint" data-v-33e8c22c>与节点实例协议一致的配置文件</div></div>`);
            _push(ssrRenderComponent(_component_el_tag, {
              type: g.cert_status === "active" ? "success" : g.cert_status === "placeholder" ? "warning" : "danger",
              size: "small"
            }, {
              default: withCtx((_, _push2, _parent2, _scopeId) => {
                if (_push2) {
                  _push2(`${ssrInterpolate(g.cert_status === "active" ? "可用" : g.cert_status === "placeholder" ? "待签发" : "已吊销")}`);
                } else {
                  return [
                    createTextVNode(toDisplayString(g.cert_status === "active" ? "可用" : g.cert_status === "placeholder" ? "待签发" : "已吊销"), 1)
                  ];
                }
              }),
              _: 2
            }, _parent));
            _push(`</div><div class="record-card__actions grant-card__actions" data-v-33e8c22c>`);
            _push(ssrRenderComponent(_component_el_button, {
              type: "primary",
              disabled: !["active", "placeholder"].includes(g.cert_status),
              onClick: ($event) => download(g.id)
            }, {
              default: withCtx((_, _push2, _parent2, _scopeId) => {
                if (_push2) {
                  _push2(` 下载配置 `);
                } else {
                  return [
                    createTextVNode(" 下载配置 ")
                  ];
                }
              }),
              _: 2
            }, _parent));
            _push(`</div></div>`);
          });
          _push(`<!--]--></div>`);
        }
        _push(`<!--]-->`);
      }
      _push(`</div></div>`);
    };
  }
};
const _sfc_setup$3 = _sfc_main$3.setup;
_sfc_main$3.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/views/SelfService.vue");
  return _sfc_setup$3 ? _sfc_setup$3(props, ctx) : void 0;
};
const SelfService = /* @__PURE__ */ _export_sfc(_sfc_main$3, [["__scopeId", "data-v-33e8c22c"]]);
const _sfc_main$2 = {
  __name: "ApiConfig",
  __ssrInlineRender: true,
  setup(__props) {
    const form = reactive({ url: "" });
    const saving = ref(false);
    const testing = ref(false);
    const effectiveDisplay = computed(() => getApiBaseURL() || "（空：使用当前站点相对路径 /api/…）");
    const buildDefaultDisplay = computed(() => getBuildTimeApiBaseURL() || "（未设置）");
    onMounted(() => {
      const raw = localStorage.getItem(API_BASE_STORAGE_KEY);
      form.url = raw !== null ? raw : "";
    });
    const onSave = () => {
      saving.value = true;
      try {
        setApiBaseURL(form.url);
        ElMessage.success("已保存，后续请求将使用新地址");
      } finally {
        saving.value = false;
      }
    };
    const onReset = () => {
      clearApiBaseURL();
      form.url = "";
      ElMessage.success("已恢复为构建时默认（或同域）");
    };
    const onTest = async () => {
      setApiBaseURL(form.url);
      testing.value = true;
      try {
        const { data } = await http.get("/api/health");
        if (data && data.grant_purge === true) {
          ElMessage.success("连接成功：后端支持授权记录删除（grant_purge）");
        } else {
          ElMessage.warning({
            message: "已连通，但健康检查未返回 grant_purge。若「删除授权」报 404，请用当前仓库重新编译并重启 vpn-api。",
            duration: 8e3,
            showClose: true
          });
        }
      } catch {
      } finally {
        testing.value = false;
      }
    };
    return (_ctx, _push, _parent, _attrs) => {
      const _component_el_form = resolveComponent("el-form");
      const _component_el_form_item = resolveComponent("el-form-item");
      const _component_el_input = resolveComponent("el-input");
      const _component_el_button = resolveComponent("el-button");
      _push(`<div${ssrRenderAttrs(mergeProps({ class: "page-card" }, _attrs))} data-v-d0f6a9d8><div class="page-card-header" data-v-d0f6a9d8><span class="page-card-title" data-v-d0f6a9d8>API 连接</span></div><p class="hint" data-v-d0f6a9d8> 管理台与后端不在同一域名/端口时，在此填写控制面 API 的根地址（协议 + 主机 + 端口，勿带 /api 后缀）。 保存后即时生效，无需重新构建。 </p>`);
      _push(ssrRenderComponent(_component_el_form, {
        "label-width": "120px",
        style: { "max-width": "640px" }
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_form_item, { label: "当前生效" }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_input, {
                    "model-value": effectiveDisplay.value,
                    readonly: ""
                  }, null, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_el_input, {
                      "model-value": effectiveDisplay.value,
                      readonly: ""
                    }, null, 8, ["model-value"])
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_form_item, { label: "构建时默认" }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_input, {
                    "model-value": buildDefaultDisplay.value,
                    readonly: ""
                  }, null, _parent3, _scopeId2));
                  _push3(`<div class="sub" data-v-d0f6a9d8${_scopeId2}>来自环境变量 VITE_API_BASE_URL；未设置则为空（使用当前站点下的 /api/…）</div>`);
                } else {
                  return [
                    createVNode(_component_el_input, {
                      "model-value": buildDefaultDisplay.value,
                      readonly: ""
                    }, null, 8, ["model-value"]),
                    createVNode("div", { class: "sub" }, "来自环境变量 VITE_API_BASE_URL；未设置则为空（使用当前站点下的 /api/…）")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_form_item, { label: "自定义地址" }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_input, {
                    modelValue: form.url,
                    "onUpdate:modelValue": ($event) => form.url = $event,
                    placeholder: "例如 https://vpn-api.example.com 或 http://192.168.1.10:56700",
                    clearable: ""
                  }, null, _parent3, _scopeId2));
                  _push3(`<div class="sub" data-v-d0f6a9d8${_scopeId2}>留空并保存表示强制使用「当前浏览器访问的站点」作为 API 根（同域）。</div>`);
                } else {
                  return [
                    createVNode(_component_el_input, {
                      modelValue: form.url,
                      "onUpdate:modelValue": ($event) => form.url = $event,
                      placeholder: "例如 https://vpn-api.example.com 或 http://192.168.1.10:56700",
                      clearable: ""
                    }, null, 8, ["modelValue", "onUpdate:modelValue"]),
                    createVNode("div", { class: "sub" }, "留空并保存表示强制使用「当前浏览器访问的站点」作为 API 根（同域）。")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_form_item, null, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_button, {
                    type: "primary",
                    loading: saving.value,
                    onClick: onSave
                  }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(`保存`);
                      } else {
                        return [
                          createTextVNode("保存")
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_button, { onClick: onReset }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(`恢复构建默认`);
                      } else {
                        return [
                          createTextVNode("恢复构建默认")
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_button, {
                    loading: testing.value,
                    onClick: onTest
                  }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(`测试连接`);
                      } else {
                        return [
                          createTextVNode("测试连接")
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_el_button, {
                      type: "primary",
                      loading: saving.value,
                      onClick: onSave
                    }, {
                      default: withCtx(() => [
                        createTextVNode("保存")
                      ]),
                      _: 1
                    }, 8, ["loading"]),
                    createVNode(_component_el_button, { onClick: onReset }, {
                      default: withCtx(() => [
                        createTextVNode("恢复构建默认")
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_button, {
                      loading: testing.value,
                      onClick: onTest
                    }, {
                      default: withCtx(() => [
                        createTextVNode("测试连接")
                      ]),
                      _: 1
                    }, 8, ["loading"])
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_form_item, { label: "当前生效" }, {
                default: withCtx(() => [
                  createVNode(_component_el_input, {
                    "model-value": effectiveDisplay.value,
                    readonly: ""
                  }, null, 8, ["model-value"])
                ]),
                _: 1
              }),
              createVNode(_component_el_form_item, { label: "构建时默认" }, {
                default: withCtx(() => [
                  createVNode(_component_el_input, {
                    "model-value": buildDefaultDisplay.value,
                    readonly: ""
                  }, null, 8, ["model-value"]),
                  createVNode("div", { class: "sub" }, "来自环境变量 VITE_API_BASE_URL；未设置则为空（使用当前站点下的 /api/…）")
                ]),
                _: 1
              }),
              createVNode(_component_el_form_item, { label: "自定义地址" }, {
                default: withCtx(() => [
                  createVNode(_component_el_input, {
                    modelValue: form.url,
                    "onUpdate:modelValue": ($event) => form.url = $event,
                    placeholder: "例如 https://vpn-api.example.com 或 http://192.168.1.10:56700",
                    clearable: ""
                  }, null, 8, ["modelValue", "onUpdate:modelValue"]),
                  createVNode("div", { class: "sub" }, "留空并保存表示强制使用「当前浏览器访问的站点」作为 API 根（同域）。")
                ]),
                _: 1
              }),
              createVNode(_component_el_form_item, null, {
                default: withCtx(() => [
                  createVNode(_component_el_button, {
                    type: "primary",
                    loading: saving.value,
                    onClick: onSave
                  }, {
                    default: withCtx(() => [
                      createTextVNode("保存")
                    ]),
                    _: 1
                  }, 8, ["loading"]),
                  createVNode(_component_el_button, { onClick: onReset }, {
                    default: withCtx(() => [
                      createTextVNode("恢复构建默认")
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_button, {
                    loading: testing.value,
                    onClick: onTest
                  }, {
                    default: withCtx(() => [
                      createTextVNode("测试连接")
                    ]),
                    _: 1
                  }, 8, ["loading"])
                ]),
                _: 1
              })
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div>`);
    };
  }
};
const _sfc_setup$2 = _sfc_main$2.setup;
_sfc_main$2.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/views/ApiConfig.vue");
  return _sfc_setup$2 ? _sfc_setup$2(props, ctx) : void 0;
};
const ApiConfig = /* @__PURE__ */ _export_sfc(_sfc_main$2, [["__scopeId", "data-v-d0f6a9d8"]]);
const PORT_MIN = 56714;
const _sfc_main$1 = {
  __name: "NetworkSegments",
  __ssrInlineRender: true,
  setup(__props) {
    const canManageSegments = computed(() => {
      const p = getAdminProfile();
      return (p == null ? void 0 : p.role) === "admin" || (p == null ? void 0 : p.permissions) === "*" || (p == null ? void 0 : p.node_scope) === "all";
    });
    const rows = ref([]);
    const loading = ref(false);
    const showAdd = ref(false);
    const saving = ref(false);
    const hintLoading = ref(false);
    const previewPortBase = ref(null);
    const showEdit = ref(false);
    const editSaving = ref(false);
    const editForm = reactive({
      id: "",
      name: "",
      description: "",
      default_ovpn_proto: "udp",
      /** 打开对话框时的协议，用于判断是否展示 apply_to_instances */
      initialProto: "udp",
      /** 修改默认协议时默认勾选，与计划一致 */
      apply_to_instances: true
    });
    const form = reactive({
      name: "",
      second_octet: 1,
      description: "",
      default_ovpn_proto: "udp",
      port_mode: "random",
      port_base: 56714
    });
    const portHint = computed(() => {
      if (previewPortBase.value != null) {
        return `预览约 ${previewPortBase.value}–${previewPortBase.value + 3}（保存时重新随机）`;
      }
      return `创建时随机（≥${PORT_MIN}，保证不冲突）`;
    });
    const portHelpText = computed(() => {
      if (form.port_mode === "manual") {
        return "手动输入监听起始端口（1–65531），系统会占用连续 4 个端口并校验与已有网段不冲突；低位端口可能需要节点系统权限。";
      }
      return `创建时在 ${PORT_MIN}–65531 内随机选取连续 4 个端口（UDP/TCP 共用）；下方为预览，实际以保存成功后的值为准。`;
    });
    const protoLabel = (p) => (p || "udp").toLowerCase() === "tcp" ? "TCP" : "UDP";
    const normProto = (p) => (p || "udp").toLowerCase() === "tcp" ? "tcp" : "udp";
    const editProtoChanged = computed(
      () => normProto(editForm.default_ovpn_proto) !== normProto(editForm.initialProto)
    );
    const load = async () => {
      loading.value = true;
      try {
        const res = await http.get("/api/network-segments");
        rows.value = res.data.items || [];
      } finally {
        loading.value = false;
      }
    };
    const loadNextValues = async () => {
      hintLoading.value = true;
      try {
        const res = await http.get("/api/network-segments/next-values");
        const s = res.data.suggested_second_octet;
        if (typeof s === "number") form.second_octet = s;
        previewPortBase.value = res.data.suggested_port_base ?? null;
      } catch {
        previewPortBase.value = null;
      } finally {
        hintLoading.value = false;
      }
    };
    const onDialogOpen = () => {
      Object.assign(form, {
        name: "",
        second_octet: 1,
        description: "",
        default_ovpn_proto: "udp",
        port_mode: "random",
        port_base: PORT_MIN
      });
      previewPortBase.value = null;
      loadNextValues();
    };
    const openAdd = () => {
      showAdd.value = true;
    };
    const openEdit = (row) => {
      const p = normProto(row.default_ovpn_proto);
      editForm.id = row.id;
      editForm.name = row.name || "";
      editForm.description = row.description || "";
      editForm.default_ovpn_proto = p;
      editForm.initialProto = p;
      editForm.apply_to_instances = true;
      showEdit.value = true;
    };
    const submitEdit = async () => {
      var _a;
      if (!((_a = editForm.name) == null ? void 0 : _a.trim())) {
        ElMessage.warning("请填写名称");
        return;
      }
      editSaving.value = true;
      try {
        const body = {
          name: editForm.name.trim(),
          description: editForm.description || ""
        };
        const newP = normProto(editForm.default_ovpn_proto);
        const oldP = normProto(editForm.initialProto);
        if (newP !== oldP) {
          body.default_ovpn_proto = newP;
          body.apply_to_instances = editForm.apply_to_instances;
        }
        await http.patch(`/api/network-segments/${editForm.id}`, body);
        const syncHint = newP !== oldP && editForm.apply_to_instances ? "，已批量更新本网段下实例协议" : "";
        ElMessage.success(`已保存${syncHint}`);
        showEdit.value = false;
        load();
      } catch {
      } finally {
        editSaving.value = false;
      }
    };
    const submit = async () => {
      var _a;
      if (!((_a = form.name) == null ? void 0 : _a.trim())) {
        ElMessage.warning("请填写名称");
        return;
      }
      if (!form.second_octet || form.second_octet < 1 || form.second_octet > 254) {
        ElMessage.warning("第二段须为 1–254");
        return;
      }
      if (form.port_mode === "manual") {
        if (!Number.isInteger(form.port_base) || form.port_base < 1 || form.port_base > 65531) {
          ElMessage.warning("监听端口须为 1–65531 的整数");
          return;
        }
      }
      saving.value = true;
      try {
        const body = {
          name: form.name.trim(),
          second_octet: form.second_octet,
          description: form.description || "",
          default_ovpn_proto: form.default_ovpn_proto === "tcp" ? "tcp" : "udp"
        };
        if (form.port_mode === "manual") {
          body.port_base = form.port_base;
        }
        const res = await http.post("/api/network-segments", body);
        const seg = res.data.segment;
        const pr = seg ? `${protoLabel(seg.default_ovpn_proto)} ${seg.port_base}–${seg.port_base + 3}` : "";
        ElMessage.success(seg ? `已创建，ID: ${seg.id}，${pr}` : "已创建");
        showAdd.value = false;
        load();
      } catch {
      } finally {
        saving.value = false;
      }
    };
    const removeSeg = async (row) => {
      try {
        await ElMessageBox.confirm(`确定删除网段「${row.name}」？若有节点绑定将失败。`, "确认", { type: "warning" });
        await http.delete(`/api/network-segments/${row.id}`);
        ElMessage.success("已删除");
        load();
      } catch (e) {
      }
    };
    void load().catch(() => {
    });
    return (_ctx, _push, _parent, _attrs) => {
      const _component_el_button = resolveComponent("el-button");
      const _component_el_icon = resolveComponent("el-icon");
      const _component_el_text = resolveComponent("el-text");
      const _component_el_tag = resolveComponent("el-tag");
      const _component_el_empty = resolveComponent("el-empty");
      const _component_el_dialog = resolveComponent("el-dialog");
      const _component_el_form = resolveComponent("el-form");
      const _component_el_form_item = resolveComponent("el-form-item");
      const _component_el_input = resolveComponent("el-input");
      const _component_el_input_number = resolveComponent("el-input-number");
      const _component_el_radio_group = resolveComponent("el-radio-group");
      const _component_el_radio = resolveComponent("el-radio");
      const _component_el_alert = resolveComponent("el-alert");
      const _component_el_checkbox = resolveComponent("el-checkbox");
      const _directive_loading = resolveDirective("loading");
      _push(`<div${ssrRenderAttrs(_attrs)}><div class="page-card"><div class="page-card-header"><span class="page-card-title">组网网段</span>`);
      if (canManageSegments.value) {
        _push(ssrRenderComponent(_component_el_button, {
          type: "primary",
          onClick: openAdd
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(ssrRenderComponent(_component_el_icon, null, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(ssrRenderComponent(unref(Plus), null, null, _parent3, _scopeId2));
                  } else {
                    return [
                      createVNode(unref(Plus))
                    ];
                  }
                }),
                _: 1
              }, _parent2, _scopeId));
              _push2(` 新建网段 `);
            } else {
              return [
                createVNode(_component_el_icon, null, {
                  default: withCtx(() => [
                    createVNode(unref(Plus))
                  ]),
                  _: 1
                }),
                createTextVNode(" 新建网段 ")
              ];
            }
          }),
          _: 1
        }, _parent));
      } else {
        _push(`<!---->`);
      }
      _push(`</div>`);
      _push(ssrRenderComponent(_component_el_text, {
        type: "info",
        size: "small",
        style: { "display": "block", "margin-bottom": "12px" }
      }, {
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(` 网段 ID 由系统自动生成。地址第二段仅在<strong${_scopeId}>新建</strong>时可填；监听起始端口支持随机分配或手动指定（UDP/TCP 共用端口，连续占用 4 个端口）。新建节点在该网段下生成实例时，默认使用「默认协议」。若要让<strong${_scopeId}>已有</strong>接入实例一并改协议，请点「编辑」修改默认协议并勾选「同步到已有实例」；否则库中 <code${_scopeId}>instances.proto</code> 不变，签发与用户 .ovpn 仍为旧协议。 `);
          } else {
            return [
              createTextVNode(" 网段 ID 由系统自动生成。地址第二段仅在"),
              createVNode("strong", null, "新建"),
              createTextVNode("时可填；监听起始端口支持随机分配或手动指定（UDP/TCP 共用端口，连续占用 4 个端口）。新建节点在该网段下生成实例时，默认使用「默认协议」。若要让"),
              createVNode("strong", null, "已有"),
              createTextVNode("接入实例一并改协议，请点「编辑」修改默认协议并勾选「同步到已有实例」；否则库中 "),
              createVNode("code", null, "instances.proto"),
              createTextVNode(" 不变，签发与用户 .ovpn 仍为旧协议。 ")
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`<div${ssrRenderAttrs(mergeProps({ class: "record-grid" }, ssrGetDirectiveProps(_ctx, _directive_loading, loading.value)))}><!--[-->`);
      ssrRenderList(rows.value, (row) => {
        _push(`<div class="record-card"><div class="record-card__head"><div class="min-w-0"><div class="record-card__title mono-text">${ssrInterpolate(row.id)}</div><div class="record-card__meta">${ssrInterpolate(row.name)}</div></div>`);
        _push(ssrRenderComponent(_component_el_tag, {
          size: "small",
          effect: "plain"
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`${ssrInterpolate(protoLabel(row.default_ovpn_proto))}`);
            } else {
              return [
                createTextVNode(toDisplayString(protoLabel(row.default_ovpn_proto)), 1)
              ];
            }
          }),
          _: 2
        }, _parent));
        _push(`</div><div class="record-card__fields"><div class="kv-row"><span class="kv-label">地址第二段</span><span class="kv-value">${ssrInterpolate(row.second_octet === 0 ? "（默认/旧公式）" : row.second_octet)}</span></div><div class="kv-row"><span class="kv-label">监听起始端口</span><span class="kv-value">${ssrInterpolate(row.port_base ?? "—")}</span></div><div class="kv-row"><span class="kv-label">说明</span><span class="kv-value">${ssrInterpolate(row.description || "—")}</span></div></div><div class="record-card__actions">`);
        if (row.id !== "default" && canManageSegments.value) {
          _push(`<!--[-->`);
          _push(ssrRenderComponent(_component_el_button, {
            size: "small",
            type: "primary",
            plain: "",
            onClick: ($event) => openEdit(row)
          }, {
            default: withCtx((_, _push2, _parent2, _scopeId) => {
              if (_push2) {
                _push2(`编辑`);
              } else {
                return [
                  createTextVNode("编辑")
                ];
              }
            }),
            _: 2
          }, _parent));
          _push(ssrRenderComponent(_component_el_button, {
            size: "small",
            type: "danger",
            plain: "",
            onClick: ($event) => removeSeg(row)
          }, {
            default: withCtx((_, _push2, _parent2, _scopeId) => {
              if (_push2) {
                _push2(`删除`);
              } else {
                return [
                  createTextVNode("删除")
                ];
              }
            }),
            _: 2
          }, _parent));
          _push(`<!--]-->`);
        } else {
          _push(ssrRenderComponent(_component_el_text, {
            type: "info",
            size: "small"
          }, {
            default: withCtx((_, _push2, _parent2, _scopeId) => {
              if (_push2) {
                _push2(`内置（不可改网段属性）`);
              } else {
                return [
                  createTextVNode("内置（不可改网段属性）")
                ];
              }
            }),
            _: 2
          }, _parent));
        }
        _push(`</div></div>`);
      });
      _push(`<!--]-->`);
      if (!loading.value && !rows.value.length) {
        _push(ssrRenderComponent(_component_el_empty, {
          description: "暂无网段",
          "image-size": 60
        }, null, _parent));
      } else {
        _push(`<!---->`);
      }
      _push(`</div></div>`);
      _push(ssrRenderComponent(_component_el_dialog, {
        modelValue: showAdd.value,
        "onUpdate:modelValue": ($event) => showAdd.value = $event,
        title: "新建组网网段",
        width: "520px",
        "destroy-on-close": "",
        onOpen: onDialogOpen
      }, {
        footer: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_button, {
              onClick: ($event) => showAdd.value = false
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`取消`);
                } else {
                  return [
                    createTextVNode("取消")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_button, {
              type: "primary",
              loading: saving.value,
              onClick: submit
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`创建`);
                } else {
                  return [
                    createTextVNode("创建")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_button, {
                onClick: ($event) => showAdd.value = false
              }, {
                default: withCtx(() => [
                  createTextVNode("取消")
                ]),
                _: 1
              }, 8, ["onClick"]),
              createVNode(_component_el_button, {
                type: "primary",
                loading: saving.value,
                onClick: submit
              }, {
                default: withCtx(() => [
                  createTextVNode("创建")
                ]),
                _: 1
              }, 8, ["loading"])
            ];
          }
        }),
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_form, {
              model: form,
              "label-width": "120px"
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "网段 ID" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          "model-value": "保存后由系统自动生成",
                          disabled: ""
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            "model-value": "保存后由系统自动生成",
                            disabled: ""
                          })
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, {
                    label: "名称",
                    required: ""
                  }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: form.name,
                          "onUpdate:modelValue": ($event) => form.name = $event,
                          placeholder: "如：上海出口"
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: form.name,
                            "onUpdate:modelValue": ($event) => form.name = $event,
                            placeholder: "如：上海出口"
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, {
                    label: "第二段 (1–254)",
                    required: ""
                  }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(`<div style="${ssrRenderStyle({ "display": "flex", "align-items": "center", "gap": "8px", "flex-wrap": "wrap", "width": "100%" })}"${_scopeId3}>`);
                        _push4(ssrRenderComponent(_component_el_input_number, {
                          modelValue: form.second_octet,
                          "onUpdate:modelValue": ($event) => form.second_octet = $event,
                          min: 1,
                          max: 254,
                          "controls-position": "right"
                        }, null, _parent4, _scopeId3));
                        _push4(ssrRenderComponent(_component_el_button, {
                          size: "small",
                          loading: hintLoading.value,
                          onClick: loadNextValues
                        }, {
                          default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                            if (_push5) {
                              _push5(`按库重算推荐`);
                            } else {
                              return [
                                createTextVNode("按库重算推荐")
                              ];
                            }
                          }),
                          _: 1
                        }, _parent4, _scopeId3));
                        _push4(`</div>`);
                        _push4(ssrRenderComponent(_component_el_text, {
                          type: "info",
                          size: "small"
                        }, {
                          default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                            if (_push5) {
                              _push5(`与数据库中已有网段的第二段不能重复。`);
                            } else {
                              return [
                                createTextVNode("与数据库中已有网段的第二段不能重复。")
                              ];
                            }
                          }),
                          _: 1
                        }, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode("div", { style: { "display": "flex", "align-items": "center", "gap": "8px", "flex-wrap": "wrap", "width": "100%" } }, [
                            createVNode(_component_el_input_number, {
                              modelValue: form.second_octet,
                              "onUpdate:modelValue": ($event) => form.second_octet = $event,
                              min: 1,
                              max: 254,
                              "controls-position": "right"
                            }, null, 8, ["modelValue", "onUpdate:modelValue"]),
                            createVNode(_component_el_button, {
                              size: "small",
                              loading: hintLoading.value,
                              onClick: loadNextValues
                            }, {
                              default: withCtx(() => [
                                createTextVNode("按库重算推荐")
                              ]),
                              _: 1
                            }, 8, ["loading"])
                          ]),
                          createVNode(_component_el_text, {
                            type: "info",
                            size: "small"
                          }, {
                            default: withCtx(() => [
                              createTextVNode("与数据库中已有网段的第二段不能重复。")
                            ]),
                            _: 1
                          })
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "默认协议" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_radio_group, {
                          modelValue: form.default_ovpn_proto,
                          "onUpdate:modelValue": ($event) => form.default_ovpn_proto = $event
                        }, {
                          default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                            if (_push5) {
                              _push5(ssrRenderComponent(_component_el_radio, { label: "udp" }, {
                                default: withCtx((_5, _push6, _parent6, _scopeId5) => {
                                  if (_push6) {
                                    _push6(`UDP`);
                                  } else {
                                    return [
                                      createTextVNode("UDP")
                                    ];
                                  }
                                }),
                                _: 1
                              }, _parent5, _scopeId4));
                              _push5(ssrRenderComponent(_component_el_radio, { label: "tcp" }, {
                                default: withCtx((_5, _push6, _parent6, _scopeId5) => {
                                  if (_push6) {
                                    _push6(`TCP`);
                                  } else {
                                    return [
                                      createTextVNode("TCP")
                                    ];
                                  }
                                }),
                                _: 1
                              }, _parent5, _scopeId4));
                            } else {
                              return [
                                createVNode(_component_el_radio, { label: "udp" }, {
                                  default: withCtx(() => [
                                    createTextVNode("UDP")
                                  ]),
                                  _: 1
                                }),
                                createVNode(_component_el_radio, { label: "tcp" }, {
                                  default: withCtx(() => [
                                    createTextVNode("TCP")
                                  ]),
                                  _: 1
                                })
                              ];
                            }
                          }),
                          _: 1
                        }, _parent4, _scopeId3));
                        _push4(ssrRenderComponent(_component_el_text, {
                          type: "info",
                          size: "small",
                          style: { "display": "block", "margin-top": "4px" }
                        }, {
                          default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                            if (_push5) {
                              _push5(` 此后绑定本网段的新节点，其四套 OpenVPN 实例默认使用该协议；可与其它网段不同以实现 UDP/TCP 并存。 `);
                            } else {
                              return [
                                createTextVNode(" 此后绑定本网段的新节点，其四套 OpenVPN 实例默认使用该协议；可与其它网段不同以实现 UDP/TCP 并存。 ")
                              ];
                            }
                          }),
                          _: 1
                        }, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_radio_group, {
                            modelValue: form.default_ovpn_proto,
                            "onUpdate:modelValue": ($event) => form.default_ovpn_proto = $event
                          }, {
                            default: withCtx(() => [
                              createVNode(_component_el_radio, { label: "udp" }, {
                                default: withCtx(() => [
                                  createTextVNode("UDP")
                                ]),
                                _: 1
                              }),
                              createVNode(_component_el_radio, { label: "tcp" }, {
                                default: withCtx(() => [
                                  createTextVNode("TCP")
                                ]),
                                _: 1
                              })
                            ]),
                            _: 1
                          }, 8, ["modelValue", "onUpdate:modelValue"]),
                          createVNode(_component_el_text, {
                            type: "info",
                            size: "small",
                            style: { "display": "block", "margin-top": "4px" }
                          }, {
                            default: withCtx(() => [
                              createTextVNode(" 此后绑定本网段的新节点，其四套 OpenVPN 实例默认使用该协议；可与其它网段不同以实现 UDP/TCP 并存。 ")
                            ]),
                            _: 1
                          })
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "监听端口" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(`<div style="${ssrRenderStyle({ "display": "flex", "flex-direction": "column", "gap": "8px", "width": "100%" })}"${_scopeId3}>`);
                        _push4(ssrRenderComponent(_component_el_radio_group, {
                          modelValue: form.port_mode,
                          "onUpdate:modelValue": ($event) => form.port_mode = $event
                        }, {
                          default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                            if (_push5) {
                              _push5(ssrRenderComponent(_component_el_radio, { label: "random" }, {
                                default: withCtx((_5, _push6, _parent6, _scopeId5) => {
                                  if (_push6) {
                                    _push6(`随机分配`);
                                  } else {
                                    return [
                                      createTextVNode("随机分配")
                                    ];
                                  }
                                }),
                                _: 1
                              }, _parent5, _scopeId4));
                              _push5(ssrRenderComponent(_component_el_radio, { label: "manual" }, {
                                default: withCtx((_5, _push6, _parent6, _scopeId5) => {
                                  if (_push6) {
                                    _push6(`手动指定`);
                                  } else {
                                    return [
                                      createTextVNode("手动指定")
                                    ];
                                  }
                                }),
                                _: 1
                              }, _parent5, _scopeId4));
                            } else {
                              return [
                                createVNode(_component_el_radio, { label: "random" }, {
                                  default: withCtx(() => [
                                    createTextVNode("随机分配")
                                  ]),
                                  _: 1
                                }),
                                createVNode(_component_el_radio, { label: "manual" }, {
                                  default: withCtx(() => [
                                    createTextVNode("手动指定")
                                  ]),
                                  _: 1
                                })
                              ];
                            }
                          }),
                          _: 1
                        }, _parent4, _scopeId3));
                        if (form.port_mode === "manual") {
                          _push4(ssrRenderComponent(_component_el_input_number, {
                            modelValue: form.port_base,
                            "onUpdate:modelValue": ($event) => form.port_base = $event,
                            min: 1,
                            max: 65531,
                            "controls-position": "right",
                            style: { "width": "220px" }
                          }, null, _parent4, _scopeId3));
                        } else {
                          _push4(ssrRenderComponent(_component_el_input, {
                            "model-value": portHint.value,
                            readonly: ""
                          }, null, _parent4, _scopeId3));
                        }
                        _push4(`</div>`);
                        _push4(ssrRenderComponent(_component_el_text, {
                          type: "info",
                          size: "small",
                          style: { "display": "block", "margin-top": "4px" }
                        }, {
                          default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                            if (_push5) {
                              _push5(`${ssrInterpolate(portHelpText.value)}`);
                            } else {
                              return [
                                createTextVNode(toDisplayString(portHelpText.value), 1)
                              ];
                            }
                          }),
                          _: 1
                        }, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode("div", { style: { "display": "flex", "flex-direction": "column", "gap": "8px", "width": "100%" } }, [
                            createVNode(_component_el_radio_group, {
                              modelValue: form.port_mode,
                              "onUpdate:modelValue": ($event) => form.port_mode = $event
                            }, {
                              default: withCtx(() => [
                                createVNode(_component_el_radio, { label: "random" }, {
                                  default: withCtx(() => [
                                    createTextVNode("随机分配")
                                  ]),
                                  _: 1
                                }),
                                createVNode(_component_el_radio, { label: "manual" }, {
                                  default: withCtx(() => [
                                    createTextVNode("手动指定")
                                  ]),
                                  _: 1
                                })
                              ]),
                              _: 1
                            }, 8, ["modelValue", "onUpdate:modelValue"]),
                            form.port_mode === "manual" ? (openBlock(), createBlock(_component_el_input_number, {
                              key: 0,
                              modelValue: form.port_base,
                              "onUpdate:modelValue": ($event) => form.port_base = $event,
                              min: 1,
                              max: 65531,
                              "controls-position": "right",
                              style: { "width": "220px" }
                            }, null, 8, ["modelValue", "onUpdate:modelValue"])) : (openBlock(), createBlock(_component_el_input, {
                              key: 1,
                              "model-value": portHint.value,
                              readonly: ""
                            }, null, 8, ["model-value"]))
                          ]),
                          createVNode(_component_el_text, {
                            type: "info",
                            size: "small",
                            style: { "display": "block", "margin-top": "4px" }
                          }, {
                            default: withCtx(() => [
                              createTextVNode(toDisplayString(portHelpText.value), 1)
                            ]),
                            _: 1
                          })
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "说明" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: form.description,
                          "onUpdate:modelValue": ($event) => form.description = $event,
                          type: "textarea",
                          rows: 2
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: form.description,
                            "onUpdate:modelValue": ($event) => form.description = $event,
                            type: "textarea",
                            rows: 2
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_el_form_item, { label: "网段 ID" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          "model-value": "保存后由系统自动生成",
                          disabled: ""
                        })
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, {
                      label: "名称",
                      required: ""
                    }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: form.name,
                          "onUpdate:modelValue": ($event) => form.name = $event,
                          placeholder: "如：上海出口"
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, {
                      label: "第二段 (1–254)",
                      required: ""
                    }, {
                      default: withCtx(() => [
                        createVNode("div", { style: { "display": "flex", "align-items": "center", "gap": "8px", "flex-wrap": "wrap", "width": "100%" } }, [
                          createVNode(_component_el_input_number, {
                            modelValue: form.second_octet,
                            "onUpdate:modelValue": ($event) => form.second_octet = $event,
                            min: 1,
                            max: 254,
                            "controls-position": "right"
                          }, null, 8, ["modelValue", "onUpdate:modelValue"]),
                          createVNode(_component_el_button, {
                            size: "small",
                            loading: hintLoading.value,
                            onClick: loadNextValues
                          }, {
                            default: withCtx(() => [
                              createTextVNode("按库重算推荐")
                            ]),
                            _: 1
                          }, 8, ["loading"])
                        ]),
                        createVNode(_component_el_text, {
                          type: "info",
                          size: "small"
                        }, {
                          default: withCtx(() => [
                            createTextVNode("与数据库中已有网段的第二段不能重复。")
                          ]),
                          _: 1
                        })
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "默认协议" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_radio_group, {
                          modelValue: form.default_ovpn_proto,
                          "onUpdate:modelValue": ($event) => form.default_ovpn_proto = $event
                        }, {
                          default: withCtx(() => [
                            createVNode(_component_el_radio, { label: "udp" }, {
                              default: withCtx(() => [
                                createTextVNode("UDP")
                              ]),
                              _: 1
                            }),
                            createVNode(_component_el_radio, { label: "tcp" }, {
                              default: withCtx(() => [
                                createTextVNode("TCP")
                              ]),
                              _: 1
                            })
                          ]),
                          _: 1
                        }, 8, ["modelValue", "onUpdate:modelValue"]),
                        createVNode(_component_el_text, {
                          type: "info",
                          size: "small",
                          style: { "display": "block", "margin-top": "4px" }
                        }, {
                          default: withCtx(() => [
                            createTextVNode(" 此后绑定本网段的新节点，其四套 OpenVPN 实例默认使用该协议；可与其它网段不同以实现 UDP/TCP 并存。 ")
                          ]),
                          _: 1
                        })
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "监听端口" }, {
                      default: withCtx(() => [
                        createVNode("div", { style: { "display": "flex", "flex-direction": "column", "gap": "8px", "width": "100%" } }, [
                          createVNode(_component_el_radio_group, {
                            modelValue: form.port_mode,
                            "onUpdate:modelValue": ($event) => form.port_mode = $event
                          }, {
                            default: withCtx(() => [
                              createVNode(_component_el_radio, { label: "random" }, {
                                default: withCtx(() => [
                                  createTextVNode("随机分配")
                                ]),
                                _: 1
                              }),
                              createVNode(_component_el_radio, { label: "manual" }, {
                                default: withCtx(() => [
                                  createTextVNode("手动指定")
                                ]),
                                _: 1
                              })
                            ]),
                            _: 1
                          }, 8, ["modelValue", "onUpdate:modelValue"]),
                          form.port_mode === "manual" ? (openBlock(), createBlock(_component_el_input_number, {
                            key: 0,
                            modelValue: form.port_base,
                            "onUpdate:modelValue": ($event) => form.port_base = $event,
                            min: 1,
                            max: 65531,
                            "controls-position": "right",
                            style: { "width": "220px" }
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])) : (openBlock(), createBlock(_component_el_input, {
                            key: 1,
                            "model-value": portHint.value,
                            readonly: ""
                          }, null, 8, ["model-value"]))
                        ]),
                        createVNode(_component_el_text, {
                          type: "info",
                          size: "small",
                          style: { "display": "block", "margin-top": "4px" }
                        }, {
                          default: withCtx(() => [
                            createTextVNode(toDisplayString(portHelpText.value), 1)
                          ]),
                          _: 1
                        })
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "说明" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: form.description,
                          "onUpdate:modelValue": ($event) => form.description = $event,
                          type: "textarea",
                          rows: 2
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    })
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_form, {
                model: form,
                "label-width": "120px"
              }, {
                default: withCtx(() => [
                  createVNode(_component_el_form_item, { label: "网段 ID" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        "model-value": "保存后由系统自动生成",
                        disabled: ""
                      })
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, {
                    label: "名称",
                    required: ""
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: form.name,
                        "onUpdate:modelValue": ($event) => form.name = $event,
                        placeholder: "如：上海出口"
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, {
                    label: "第二段 (1–254)",
                    required: ""
                  }, {
                    default: withCtx(() => [
                      createVNode("div", { style: { "display": "flex", "align-items": "center", "gap": "8px", "flex-wrap": "wrap", "width": "100%" } }, [
                        createVNode(_component_el_input_number, {
                          modelValue: form.second_octet,
                          "onUpdate:modelValue": ($event) => form.second_octet = $event,
                          min: 1,
                          max: 254,
                          "controls-position": "right"
                        }, null, 8, ["modelValue", "onUpdate:modelValue"]),
                        createVNode(_component_el_button, {
                          size: "small",
                          loading: hintLoading.value,
                          onClick: loadNextValues
                        }, {
                          default: withCtx(() => [
                            createTextVNode("按库重算推荐")
                          ]),
                          _: 1
                        }, 8, ["loading"])
                      ]),
                      createVNode(_component_el_text, {
                        type: "info",
                        size: "small"
                      }, {
                        default: withCtx(() => [
                          createTextVNode("与数据库中已有网段的第二段不能重复。")
                        ]),
                        _: 1
                      })
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "默认协议" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_radio_group, {
                        modelValue: form.default_ovpn_proto,
                        "onUpdate:modelValue": ($event) => form.default_ovpn_proto = $event
                      }, {
                        default: withCtx(() => [
                          createVNode(_component_el_radio, { label: "udp" }, {
                            default: withCtx(() => [
                              createTextVNode("UDP")
                            ]),
                            _: 1
                          }),
                          createVNode(_component_el_radio, { label: "tcp" }, {
                            default: withCtx(() => [
                              createTextVNode("TCP")
                            ]),
                            _: 1
                          })
                        ]),
                        _: 1
                      }, 8, ["modelValue", "onUpdate:modelValue"]),
                      createVNode(_component_el_text, {
                        type: "info",
                        size: "small",
                        style: { "display": "block", "margin-top": "4px" }
                      }, {
                        default: withCtx(() => [
                          createTextVNode(" 此后绑定本网段的新节点，其四套 OpenVPN 实例默认使用该协议；可与其它网段不同以实现 UDP/TCP 并存。 ")
                        ]),
                        _: 1
                      })
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "监听端口" }, {
                    default: withCtx(() => [
                      createVNode("div", { style: { "display": "flex", "flex-direction": "column", "gap": "8px", "width": "100%" } }, [
                        createVNode(_component_el_radio_group, {
                          modelValue: form.port_mode,
                          "onUpdate:modelValue": ($event) => form.port_mode = $event
                        }, {
                          default: withCtx(() => [
                            createVNode(_component_el_radio, { label: "random" }, {
                              default: withCtx(() => [
                                createTextVNode("随机分配")
                              ]),
                              _: 1
                            }),
                            createVNode(_component_el_radio, { label: "manual" }, {
                              default: withCtx(() => [
                                createTextVNode("手动指定")
                              ]),
                              _: 1
                            })
                          ]),
                          _: 1
                        }, 8, ["modelValue", "onUpdate:modelValue"]),
                        form.port_mode === "manual" ? (openBlock(), createBlock(_component_el_input_number, {
                          key: 0,
                          modelValue: form.port_base,
                          "onUpdate:modelValue": ($event) => form.port_base = $event,
                          min: 1,
                          max: 65531,
                          "controls-position": "right",
                          style: { "width": "220px" }
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])) : (openBlock(), createBlock(_component_el_input, {
                          key: 1,
                          "model-value": portHint.value,
                          readonly: ""
                        }, null, 8, ["model-value"]))
                      ]),
                      createVNode(_component_el_text, {
                        type: "info",
                        size: "small",
                        style: { "display": "block", "margin-top": "4px" }
                      }, {
                        default: withCtx(() => [
                          createTextVNode(toDisplayString(portHelpText.value), 1)
                        ]),
                        _: 1
                      })
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "说明" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: form.description,
                        "onUpdate:modelValue": ($event) => form.description = $event,
                        type: "textarea",
                        rows: 2
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  })
                ]),
                _: 1
              }, 8, ["model"])
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(ssrRenderComponent(_component_el_dialog, {
        modelValue: showEdit.value,
        "onUpdate:modelValue": ($event) => showEdit.value = $event,
        title: "编辑组网网段",
        width: "520px",
        "destroy-on-close": ""
      }, {
        footer: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_button, {
              onClick: ($event) => showEdit.value = false
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`取消`);
                } else {
                  return [
                    createTextVNode("取消")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_button, {
              type: "primary",
              loading: editSaving.value,
              onClick: submitEdit
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`保存`);
                } else {
                  return [
                    createTextVNode("保存")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_button, {
                onClick: ($event) => showEdit.value = false
              }, {
                default: withCtx(() => [
                  createTextVNode("取消")
                ]),
                _: 1
              }, 8, ["onClick"]),
              createVNode(_component_el_button, {
                type: "primary",
                loading: editSaving.value,
                onClick: submitEdit
              }, {
                default: withCtx(() => [
                  createTextVNode("保存")
                ]),
                _: 1
              }, 8, ["loading"])
            ];
          }
        }),
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_form, {
              model: editForm,
              "label-width": "120px"
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "网段 ID" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          "model-value": editForm.id,
                          disabled: ""
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            "model-value": editForm.id,
                            disabled: ""
                          }, null, 8, ["model-value"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, {
                    label: "名称",
                    required: ""
                  }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: editForm.name,
                          "onUpdate:modelValue": ($event) => editForm.name = $event,
                          placeholder: "显示名称"
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: editForm.name,
                            "onUpdate:modelValue": ($event) => editForm.name = $event,
                            placeholder: "显示名称"
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "默认协议" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_radio_group, {
                          modelValue: editForm.default_ovpn_proto,
                          "onUpdate:modelValue": ($event) => editForm.default_ovpn_proto = $event
                        }, {
                          default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                            if (_push5) {
                              _push5(ssrRenderComponent(_component_el_radio, { label: "udp" }, {
                                default: withCtx((_5, _push6, _parent6, _scopeId5) => {
                                  if (_push6) {
                                    _push6(`UDP`);
                                  } else {
                                    return [
                                      createTextVNode("UDP")
                                    ];
                                  }
                                }),
                                _: 1
                              }, _parent5, _scopeId4));
                              _push5(ssrRenderComponent(_component_el_radio, { label: "tcp" }, {
                                default: withCtx((_5, _push6, _parent6, _scopeId5) => {
                                  if (_push6) {
                                    _push6(`TCP`);
                                  } else {
                                    return [
                                      createTextVNode("TCP")
                                    ];
                                  }
                                }),
                                _: 1
                              }, _parent5, _scopeId4));
                            } else {
                              return [
                                createVNode(_component_el_radio, { label: "udp" }, {
                                  default: withCtx(() => [
                                    createTextVNode("UDP")
                                  ]),
                                  _: 1
                                }),
                                createVNode(_component_el_radio, { label: "tcp" }, {
                                  default: withCtx(() => [
                                    createTextVNode("TCP")
                                  ]),
                                  _: 1
                                })
                              ];
                            }
                          }),
                          _: 1
                        }, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_radio_group, {
                            modelValue: editForm.default_ovpn_proto,
                            "onUpdate:modelValue": ($event) => editForm.default_ovpn_proto = $event
                          }, {
                            default: withCtx(() => [
                              createVNode(_component_el_radio, { label: "udp" }, {
                                default: withCtx(() => [
                                  createTextVNode("UDP")
                                ]),
                                _: 1
                              }),
                              createVNode(_component_el_radio, { label: "tcp" }, {
                                default: withCtx(() => [
                                  createTextVNode("TCP")
                                ]),
                                _: 1
                              })
                            ]),
                            _: 1
                          }, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  if (editProtoChanged.value) {
                    _push3(ssrRenderComponent(_component_el_alert, {
                      type: "warning",
                      closable: false,
                      "show-icon": "",
                      style: { "margin-bottom": "12px" }
                    }, {
                      default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                        if (_push4) {
                          _push4(` 仅改网段默认不会更新已有实例。若希望本网段下<strong${_scopeId3}>所有已存在</strong>接入实例改为新协议，请勾选下方选项（对应 API <code${_scopeId3}>apply_to_instances: true</code>）。 `);
                        } else {
                          return [
                            createTextVNode(" 仅改网段默认不会更新已有实例。若希望本网段下"),
                            createVNode("strong", null, "所有已存在"),
                            createTextVNode("接入实例改为新协议，请勾选下方选项（对应 API "),
                            createVNode("code", null, "apply_to_instances: true"),
                            createTextVNode("）。 ")
                          ];
                        }
                      }),
                      _: 1
                    }, _parent3, _scopeId2));
                  } else {
                    _push3(`<!---->`);
                  }
                  if (editProtoChanged.value) {
                    _push3(ssrRenderComponent(_component_el_form_item, { label: " " }, {
                      default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                        if (_push4) {
                          _push4(ssrRenderComponent(_component_el_checkbox, {
                            modelValue: editForm.apply_to_instances,
                            "onUpdate:modelValue": ($event) => editForm.apply_to_instances = $event
                          }, {
                            default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                              if (_push5) {
                                _push5(` 将默认协议同步到本网段下已有接入实例（推荐） `);
                              } else {
                                return [
                                  createTextVNode(" 将默认协议同步到本网段下已有接入实例（推荐） ")
                                ];
                              }
                            }),
                            _: 1
                          }, _parent4, _scopeId3));
                        } else {
                          return [
                            createVNode(_component_el_checkbox, {
                              modelValue: editForm.apply_to_instances,
                              "onUpdate:modelValue": ($event) => editForm.apply_to_instances = $event
                            }, {
                              default: withCtx(() => [
                                createTextVNode(" 将默认协议同步到本网段下已有接入实例（推荐） ")
                              ]),
                              _: 1
                            }, 8, ["modelValue", "onUpdate:modelValue"])
                          ];
                        }
                      }),
                      _: 1
                    }, _parent3, _scopeId2));
                  } else {
                    _push3(`<!---->`);
                  }
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "说明" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: editForm.description,
                          "onUpdate:modelValue": ($event) => editForm.description = $event,
                          type: "textarea",
                          rows: 2
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: editForm.description,
                            "onUpdate:modelValue": ($event) => editForm.description = $event,
                            type: "textarea",
                            rows: 2
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_el_form_item, { label: "网段 ID" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          "model-value": editForm.id,
                          disabled: ""
                        }, null, 8, ["model-value"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, {
                      label: "名称",
                      required: ""
                    }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: editForm.name,
                          "onUpdate:modelValue": ($event) => editForm.name = $event,
                          placeholder: "显示名称"
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "默认协议" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_radio_group, {
                          modelValue: editForm.default_ovpn_proto,
                          "onUpdate:modelValue": ($event) => editForm.default_ovpn_proto = $event
                        }, {
                          default: withCtx(() => [
                            createVNode(_component_el_radio, { label: "udp" }, {
                              default: withCtx(() => [
                                createTextVNode("UDP")
                              ]),
                              _: 1
                            }),
                            createVNode(_component_el_radio, { label: "tcp" }, {
                              default: withCtx(() => [
                                createTextVNode("TCP")
                              ]),
                              _: 1
                            })
                          ]),
                          _: 1
                        }, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    editProtoChanged.value ? (openBlock(), createBlock(_component_el_alert, {
                      key: 0,
                      type: "warning",
                      closable: false,
                      "show-icon": "",
                      style: { "margin-bottom": "12px" }
                    }, {
                      default: withCtx(() => [
                        createTextVNode(" 仅改网段默认不会更新已有实例。若希望本网段下"),
                        createVNode("strong", null, "所有已存在"),
                        createTextVNode("接入实例改为新协议，请勾选下方选项（对应 API "),
                        createVNode("code", null, "apply_to_instances: true"),
                        createTextVNode("）。 ")
                      ]),
                      _: 1
                    })) : createCommentVNode("", true),
                    editProtoChanged.value ? (openBlock(), createBlock(_component_el_form_item, {
                      key: 1,
                      label: " "
                    }, {
                      default: withCtx(() => [
                        createVNode(_component_el_checkbox, {
                          modelValue: editForm.apply_to_instances,
                          "onUpdate:modelValue": ($event) => editForm.apply_to_instances = $event
                        }, {
                          default: withCtx(() => [
                            createTextVNode(" 将默认协议同步到本网段下已有接入实例（推荐） ")
                          ]),
                          _: 1
                        }, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    })) : createCommentVNode("", true),
                    createVNode(_component_el_form_item, { label: "说明" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: editForm.description,
                          "onUpdate:modelValue": ($event) => editForm.description = $event,
                          type: "textarea",
                          rows: 2
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    })
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_form, {
                model: editForm,
                "label-width": "120px"
              }, {
                default: withCtx(() => [
                  createVNode(_component_el_form_item, { label: "网段 ID" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        "model-value": editForm.id,
                        disabled: ""
                      }, null, 8, ["model-value"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, {
                    label: "名称",
                    required: ""
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: editForm.name,
                        "onUpdate:modelValue": ($event) => editForm.name = $event,
                        placeholder: "显示名称"
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "默认协议" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_radio_group, {
                        modelValue: editForm.default_ovpn_proto,
                        "onUpdate:modelValue": ($event) => editForm.default_ovpn_proto = $event
                      }, {
                        default: withCtx(() => [
                          createVNode(_component_el_radio, { label: "udp" }, {
                            default: withCtx(() => [
                              createTextVNode("UDP")
                            ]),
                            _: 1
                          }),
                          createVNode(_component_el_radio, { label: "tcp" }, {
                            default: withCtx(() => [
                              createTextVNode("TCP")
                            ]),
                            _: 1
                          })
                        ]),
                        _: 1
                      }, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  editProtoChanged.value ? (openBlock(), createBlock(_component_el_alert, {
                    key: 0,
                    type: "warning",
                    closable: false,
                    "show-icon": "",
                    style: { "margin-bottom": "12px" }
                  }, {
                    default: withCtx(() => [
                      createTextVNode(" 仅改网段默认不会更新已有实例。若希望本网段下"),
                      createVNode("strong", null, "所有已存在"),
                      createTextVNode("接入实例改为新协议，请勾选下方选项（对应 API "),
                      createVNode("code", null, "apply_to_instances: true"),
                      createTextVNode("）。 ")
                    ]),
                    _: 1
                  })) : createCommentVNode("", true),
                  editProtoChanged.value ? (openBlock(), createBlock(_component_el_form_item, {
                    key: 1,
                    label: " "
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_el_checkbox, {
                        modelValue: editForm.apply_to_instances,
                        "onUpdate:modelValue": ($event) => editForm.apply_to_instances = $event
                      }, {
                        default: withCtx(() => [
                          createTextVNode(" 将默认协议同步到本网段下已有接入实例（推荐） ")
                        ]),
                        _: 1
                      }, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  })) : createCommentVNode("", true),
                  createVNode(_component_el_form_item, { label: "说明" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: editForm.description,
                        "onUpdate:modelValue": ($event) => editForm.description = $event,
                        type: "textarea",
                        rows: 2
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  })
                ]),
                _: 1
              }, 8, ["model"])
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`</div>`);
    };
  }
};
const _sfc_setup$1 = _sfc_main$1.setup;
_sfc_main$1.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/views/NetworkSegments.vue");
  return _sfc_setup$1 ? _sfc_setup$1(props, ctx) : void 0;
};
const routes = [
  { path: "/login", component: Login },
  { path: "/self-service", component: SelfService, meta: { noAuth: true } },
  { path: "/settings/api", component: ApiConfig, meta: { requiresSuperAdmin: true } },
  { path: "/", component: Dashboard },
  { path: "/network-segments", component: _sfc_main$1 },
  { path: "/nodes", component: Nodes },
  { path: "/nodes/:id", component: NodeDetail },
  { path: "/users", component: Users },
  { path: "/rules", component: Rules },
  { path: "/tunnels", component: Tunnels },
  { path: "/audit", component: _sfc_main$6 },
  { path: "/admins", component: Admins }
];
let _router = null;
function bindRouter(r) {
  _router = r;
}
function installNavigationGuards(router) {
  router.beforeEach((to) => {
    return true;
  });
}
const routerProxy = new Proxy(
  /** @type {import('vue-router').Router} */
  {},
  {
    get(_, prop) {
      if (!_router) {
        return void 0;
      }
      const v = _router[
        /** @type {keyof import('vue-router').Router} */
        prop
      ];
      return typeof v === "function" ? v.bind(_router) : v;
    }
  }
);
const _sfc_main = {
  __name: "App",
  __ssrInlineRender: true,
  setup(__props) {
    const route = useRoute();
    const isCollapsed = ref(false);
    const isMobile = ref(false);
    const syncCollapsedForViewport = () => {
      const mobile = window.innerWidth <= 768;
      isMobile.value = mobile;
      if (mobile) {
        isCollapsed.value = true;
      }
    };
    const handleResize = () => {
      syncCollapsedForViewport();
    };
    const fullPages = ["/login", "/self-service"];
    const isFullPage = computed(() => fullPages.includes(route.path));
    const menuMap = {
      "/": "仪表盘",
      "/settings/api": "API 连接",
      "/network-segments": "组网网段",
      "/nodes": "节点管理",
      "/users": "授权管理",
      "/rules": "分流规则",
      "/tunnels": "隧道状态",
      "/audit": "审计日志",
      "/admins": "管理员管理"
    };
    const activeMenu = computed(() => {
      if (route.path.startsWith("/nodes/")) return "/nodes";
      if (route.path.startsWith("/settings")) return "/settings/api";
      if (route.path === "/network-segments") return "/network-segments";
      return route.path;
    });
    const currentBreadcrumb = computed(() => {
      if (route.path.startsWith("/nodes/")) return "节点管理";
      if (route.path.startsWith("/settings")) return "API 连接";
      return menuMap[route.path] || "";
    });
    const normalizeAdminInfo = (info) => {
      if (!info || typeof info !== "object") return {};
      const roleRaw = typeof info.role === "string" ? info.role.trim() : "";
      const role = roleRaw.toLowerCase();
      const username = typeof info.username === "string" ? info.username.trim() : typeof info.sub === "string" ? info.sub.trim() : "";
      const permsSource = info.perms ?? info.permissions ?? "";
      const perms = typeof permsSource === "string" ? permsSource.trim() : "";
      const nodeScope = typeof info.node_scope === "string" ? info.node_scope.trim() : "";
      const nodeIds = Array.isArray(info.node_ids) ? info.node_ids.filter((x) => typeof x === "string") : [];
      return { username, role, perms, node_scope: nodeScope, node_ids: nodeIds };
    };
    const adminInfo = computed(() => {
      const profile = normalizeAdminInfo(getAdminProfile());
      if (profile.username || profile.role || profile.perms) return profile;
      const token = getSessionToken();
      if (!token) return {};
      const payload = parseJwtPayload(token);
      if (!payload) return {};
      return normalizeAdminInfo(payload);
    });
    const roleLabel = computed(() => {
      const r = adminInfo.value.role;
      if (r === "admin") return "超级管理员";
      if (r === "operator") return "运维管理员";
      if (r === "viewer") return "只读查看";
      return r || "未知";
    });
    const roleTagType = computed(() => {
      const r = adminInfo.value.role;
      if (r === "admin") return "danger";
      if (r === "operator") return "warning";
      return "info";
    });
    const hasPerm = (module) => {
      const info = adminInfo.value;
      if (info.role === "admin") return true;
      if (info.perms === "*") return true;
      if (!info.perms) return false;
      return info.perms.split(",").map((s) => s.trim()).includes(module);
    };
    const isSuperAdmin = computed(() => isSuperAdminSession());
    watch(
      () => route.path,
      () => {
        if (isMobile.value && !isCollapsed.value) {
          isCollapsed.value = true;
        }
      }
    );
    onMounted(async () => {
      var _a, _b;
      syncCollapsedForViewport();
      window.addEventListener("resize", handleResize);
      const token = getSessionToken();
      if (!token) return;
      try {
        const res = await http.get("/api/me", { meta: { suppress404: true } });
        setAdminProfile(((_a = res.data) == null ? void 0 : _a.admin) || null);
      } catch (err) {
        const st = (_b = err.response) == null ? void 0 : _b.status;
        if (st === 404) {
          clearAuthSession();
          if (routerProxy.currentRoute.value.path !== "/login") {
            routerProxy.push("/login");
            ElMessage.warning("登录状态无效（账号不存在或已变更），请重新登录");
          }
        }
      }
    });
    onBeforeUnmount(() => {
      window.removeEventListener("resize", handleResize);
    });
    const changePwdVisible = ref(false);
    const changingPwd = ref(false);
    const pwdForm = reactive({ oldPassword: "", newPassword: "", confirmPassword: "" });
    const handleChangePwd = async () => {
      if (!pwdForm.oldPassword) {
        ElMessage.warning("请输入旧密码");
        return;
      }
      if (pwdForm.newPassword.length < 6) {
        ElMessage.warning("新密码至少6位");
        return;
      }
      if (pwdForm.newPassword !== pwdForm.confirmPassword) {
        ElMessage.warning("两次输入的密码不一致");
        return;
      }
      changingPwd.value = true;
      try {
        await http.post("/api/me/password", { old_password: pwdForm.oldPassword, new_password: pwdForm.newPassword });
        ElMessage.success("密码修改成功，请重新登录");
        changePwdVisible.value = false;
        clearAuthSession();
        routerProxy.push("/login");
      } catch {
      } finally {
        changingPwd.value = false;
      }
    };
    const handleCommand = (cmd) => {
      if (cmd === "changePwd") {
        Object.assign(pwdForm, { oldPassword: "", newPassword: "", confirmPassword: "" });
        changePwdVisible.value = true;
      } else if (cmd === "logout") {
        clearAuthSession();
        routerProxy.push("/login");
      }
    };
    return (_ctx, _push, _parent, _attrs) => {
      const _component_router_view = resolveComponent("router-view");
      const _component_el_menu = resolveComponent("el-menu");
      const _component_el_menu_item = resolveComponent("el-menu-item");
      const _component_el_icon = resolveComponent("el-icon");
      const _component_Odometer = resolveComponent("Odometer");
      const _component_User = resolveComponent("User");
      const _component_Share = resolveComponent("Share");
      const _component_Monitor = resolveComponent("Monitor");
      const _component_Guide = resolveComponent("Guide");
      const _component_Connection = resolveComponent("Connection");
      const _component_Document = resolveComponent("Document");
      const _component_Setting = resolveComponent("Setting");
      const _component_Link = resolveComponent("Link");
      const _component_Fold = resolveComponent("Fold");
      const _component_Expand = resolveComponent("Expand");
      const _component_el_breadcrumb = resolveComponent("el-breadcrumb");
      const _component_el_breadcrumb_item = resolveComponent("el-breadcrumb-item");
      const _component_el_dropdown = resolveComponent("el-dropdown");
      const _component_el_avatar = resolveComponent("el-avatar");
      const _component_UserFilled = resolveComponent("UserFilled");
      const _component_el_tag = resolveComponent("el-tag");
      const _component_ArrowDown = resolveComponent("ArrowDown");
      const _component_el_dropdown_menu = resolveComponent("el-dropdown-menu");
      const _component_el_dropdown_item = resolveComponent("el-dropdown-item");
      const _component_Lock = resolveComponent("Lock");
      const _component_SwitchButton = resolveComponent("SwitchButton");
      const _component_el_dialog = resolveComponent("el-dialog");
      const _component_el_form = resolveComponent("el-form");
      const _component_el_form_item = resolveComponent("el-form-item");
      const _component_el_input = resolveComponent("el-input");
      const _component_el_button = resolveComponent("el-button");
      _push(`<!--[-->`);
      if (isFullPage.value) {
        _push(ssrRenderComponent(_component_router_view, null, null, _parent));
      } else {
        _push(`<div class="app-layout" data-v-cbcf4284><aside class="${ssrRenderClass([{ "is-collapsed": isCollapsed.value, "is-mobile": isMobile.value }, "layout-sidebar"])}" aria-label="主导航" data-v-cbcf4284><div class="sidebar-logo" data-v-cbcf4284><div class="logo-icon" aria-hidden="true" data-v-cbcf4284>V</div><span class="logo-text" data-v-cbcf4284>VPN 管理中心</span></div><div class="sidebar-menu" data-v-cbcf4284>`);
        _push(ssrRenderComponent(_component_el_menu, {
          key: activeMenu.value,
          "default-active": activeMenu.value,
          collapse: isCollapsed.value,
          "collapse-transition": false,
          router: "",
          class: "app-sidebar-menu",
          "background-color": "transparent",
          "text-color": "rgba(224,242,254,0.82)",
          "active-text-color": "#f8fafc"
        }, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(ssrRenderComponent(_component_el_menu_item, { index: "/" }, {
                title: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(`仪表盘`);
                  } else {
                    return [
                      createTextVNode("仪表盘")
                    ];
                  }
                }),
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(ssrRenderComponent(_component_el_icon, null, {
                      default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                        if (_push4) {
                          _push4(ssrRenderComponent(_component_Odometer, null, null, _parent4, _scopeId3));
                        } else {
                          return [
                            createVNode(_component_Odometer)
                          ];
                        }
                      }),
                      _: 1
                    }, _parent3, _scopeId2));
                  } else {
                    return [
                      createVNode(_component_el_icon, null, {
                        default: withCtx(() => [
                          createVNode(_component_Odometer)
                        ]),
                        _: 1
                      })
                    ];
                  }
                }),
                _: 1
              }, _parent2, _scopeId));
              if (hasPerm("users")) {
                _push2(ssrRenderComponent(_component_el_menu_item, { index: "/users" }, {
                  title: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(`授权管理`);
                    } else {
                      return [
                        createTextVNode("授权管理")
                      ];
                    }
                  }),
                  default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(ssrRenderComponent(_component_el_icon, null, {
                        default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                          if (_push4) {
                            _push4(ssrRenderComponent(_component_User, null, null, _parent4, _scopeId3));
                          } else {
                            return [
                              createVNode(_component_User)
                            ];
                          }
                        }),
                        _: 1
                      }, _parent3, _scopeId2));
                    } else {
                      return [
                        createVNode(_component_el_icon, null, {
                          default: withCtx(() => [
                            createVNode(_component_User)
                          ]),
                          _: 1
                        })
                      ];
                    }
                  }),
                  _: 1
                }, _parent2, _scopeId));
              } else {
                _push2(`<!---->`);
              }
              if (hasPerm("nodes")) {
                _push2(ssrRenderComponent(_component_el_menu_item, { index: "/network-segments" }, {
                  title: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(`组网网段`);
                    } else {
                      return [
                        createTextVNode("组网网段")
                      ];
                    }
                  }),
                  default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(ssrRenderComponent(_component_el_icon, null, {
                        default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                          if (_push4) {
                            _push4(ssrRenderComponent(_component_Share, null, null, _parent4, _scopeId3));
                          } else {
                            return [
                              createVNode(_component_Share)
                            ];
                          }
                        }),
                        _: 1
                      }, _parent3, _scopeId2));
                    } else {
                      return [
                        createVNode(_component_el_icon, null, {
                          default: withCtx(() => [
                            createVNode(_component_Share)
                          ]),
                          _: 1
                        })
                      ];
                    }
                  }),
                  _: 1
                }, _parent2, _scopeId));
              } else {
                _push2(`<!---->`);
              }
              if (hasPerm("nodes")) {
                _push2(ssrRenderComponent(_component_el_menu_item, { index: "/nodes" }, {
                  title: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(`节点管理`);
                    } else {
                      return [
                        createTextVNode("节点管理")
                      ];
                    }
                  }),
                  default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(ssrRenderComponent(_component_el_icon, null, {
                        default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                          if (_push4) {
                            _push4(ssrRenderComponent(_component_Monitor, null, null, _parent4, _scopeId3));
                          } else {
                            return [
                              createVNode(_component_Monitor)
                            ];
                          }
                        }),
                        _: 1
                      }, _parent3, _scopeId2));
                    } else {
                      return [
                        createVNode(_component_el_icon, null, {
                          default: withCtx(() => [
                            createVNode(_component_Monitor)
                          ]),
                          _: 1
                        })
                      ];
                    }
                  }),
                  _: 1
                }, _parent2, _scopeId));
              } else {
                _push2(`<!---->`);
              }
              if (hasPerm("rules")) {
                _push2(ssrRenderComponent(_component_el_menu_item, { index: "/rules" }, {
                  title: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(`分流规则`);
                    } else {
                      return [
                        createTextVNode("分流规则")
                      ];
                    }
                  }),
                  default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(ssrRenderComponent(_component_el_icon, null, {
                        default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                          if (_push4) {
                            _push4(ssrRenderComponent(_component_Guide, null, null, _parent4, _scopeId3));
                          } else {
                            return [
                              createVNode(_component_Guide)
                            ];
                          }
                        }),
                        _: 1
                      }, _parent3, _scopeId2));
                    } else {
                      return [
                        createVNode(_component_el_icon, null, {
                          default: withCtx(() => [
                            createVNode(_component_Guide)
                          ]),
                          _: 1
                        })
                      ];
                    }
                  }),
                  _: 1
                }, _parent2, _scopeId));
              } else {
                _push2(`<!---->`);
              }
              if (hasPerm("tunnels")) {
                _push2(ssrRenderComponent(_component_el_menu_item, { index: "/tunnels" }, {
                  title: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(`隧道状态`);
                    } else {
                      return [
                        createTextVNode("隧道状态")
                      ];
                    }
                  }),
                  default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(ssrRenderComponent(_component_el_icon, null, {
                        default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                          if (_push4) {
                            _push4(ssrRenderComponent(_component_Connection, null, null, _parent4, _scopeId3));
                          } else {
                            return [
                              createVNode(_component_Connection)
                            ];
                          }
                        }),
                        _: 1
                      }, _parent3, _scopeId2));
                    } else {
                      return [
                        createVNode(_component_el_icon, null, {
                          default: withCtx(() => [
                            createVNode(_component_Connection)
                          ]),
                          _: 1
                        })
                      ];
                    }
                  }),
                  _: 1
                }, _parent2, _scopeId));
              } else {
                _push2(`<!---->`);
              }
              if (hasPerm("audit")) {
                _push2(ssrRenderComponent(_component_el_menu_item, { index: "/audit" }, {
                  title: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(`审计日志`);
                    } else {
                      return [
                        createTextVNode("审计日志")
                      ];
                    }
                  }),
                  default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(ssrRenderComponent(_component_el_icon, null, {
                        default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                          if (_push4) {
                            _push4(ssrRenderComponent(_component_Document, null, null, _parent4, _scopeId3));
                          } else {
                            return [
                              createVNode(_component_Document)
                            ];
                          }
                        }),
                        _: 1
                      }, _parent3, _scopeId2));
                    } else {
                      return [
                        createVNode(_component_el_icon, null, {
                          default: withCtx(() => [
                            createVNode(_component_Document)
                          ]),
                          _: 1
                        })
                      ];
                    }
                  }),
                  _: 1
                }, _parent2, _scopeId));
              } else {
                _push2(`<!---->`);
              }
              if (hasPerm("admins")) {
                _push2(ssrRenderComponent(_component_el_menu_item, { index: "/admins" }, {
                  title: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(`管理员管理`);
                    } else {
                      return [
                        createTextVNode("管理员管理")
                      ];
                    }
                  }),
                  default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(ssrRenderComponent(_component_el_icon, null, {
                        default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                          if (_push4) {
                            _push4(ssrRenderComponent(_component_Setting, null, null, _parent4, _scopeId3));
                          } else {
                            return [
                              createVNode(_component_Setting)
                            ];
                          }
                        }),
                        _: 1
                      }, _parent3, _scopeId2));
                    } else {
                      return [
                        createVNode(_component_el_icon, null, {
                          default: withCtx(() => [
                            createVNode(_component_Setting)
                          ]),
                          _: 1
                        })
                      ];
                    }
                  }),
                  _: 1
                }, _parent2, _scopeId));
              } else {
                _push2(`<!---->`);
              }
              if (isSuperAdmin.value) {
                _push2(ssrRenderComponent(_component_el_menu_item, { index: "/settings/api" }, {
                  title: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(`API 连接`);
                    } else {
                      return [
                        createTextVNode("API 连接")
                      ];
                    }
                  }),
                  default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(ssrRenderComponent(_component_el_icon, null, {
                        default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                          if (_push4) {
                            _push4(ssrRenderComponent(_component_Link, null, null, _parent4, _scopeId3));
                          } else {
                            return [
                              createVNode(_component_Link)
                            ];
                          }
                        }),
                        _: 1
                      }, _parent3, _scopeId2));
                    } else {
                      return [
                        createVNode(_component_el_icon, null, {
                          default: withCtx(() => [
                            createVNode(_component_Link)
                          ]),
                          _: 1
                        })
                      ];
                    }
                  }),
                  _: 1
                }, _parent2, _scopeId));
              } else {
                _push2(`<!---->`);
              }
            } else {
              return [
                createVNode(_component_el_menu_item, { index: "/" }, {
                  title: withCtx(() => [
                    createTextVNode("仪表盘")
                  ]),
                  default: withCtx(() => [
                    createVNode(_component_el_icon, null, {
                      default: withCtx(() => [
                        createVNode(_component_Odometer)
                      ]),
                      _: 1
                    })
                  ]),
                  _: 1
                }),
                hasPerm("users") ? (openBlock(), createBlock(_component_el_menu_item, {
                  key: 0,
                  index: "/users"
                }, {
                  title: withCtx(() => [
                    createTextVNode("授权管理")
                  ]),
                  default: withCtx(() => [
                    createVNode(_component_el_icon, null, {
                      default: withCtx(() => [
                        createVNode(_component_User)
                      ]),
                      _: 1
                    })
                  ]),
                  _: 1
                })) : createCommentVNode("", true),
                hasPerm("nodes") ? (openBlock(), createBlock(_component_el_menu_item, {
                  key: 1,
                  index: "/network-segments"
                }, {
                  title: withCtx(() => [
                    createTextVNode("组网网段")
                  ]),
                  default: withCtx(() => [
                    createVNode(_component_el_icon, null, {
                      default: withCtx(() => [
                        createVNode(_component_Share)
                      ]),
                      _: 1
                    })
                  ]),
                  _: 1
                })) : createCommentVNode("", true),
                hasPerm("nodes") ? (openBlock(), createBlock(_component_el_menu_item, {
                  key: 2,
                  index: "/nodes"
                }, {
                  title: withCtx(() => [
                    createTextVNode("节点管理")
                  ]),
                  default: withCtx(() => [
                    createVNode(_component_el_icon, null, {
                      default: withCtx(() => [
                        createVNode(_component_Monitor)
                      ]),
                      _: 1
                    })
                  ]),
                  _: 1
                })) : createCommentVNode("", true),
                hasPerm("rules") ? (openBlock(), createBlock(_component_el_menu_item, {
                  key: 3,
                  index: "/rules"
                }, {
                  title: withCtx(() => [
                    createTextVNode("分流规则")
                  ]),
                  default: withCtx(() => [
                    createVNode(_component_el_icon, null, {
                      default: withCtx(() => [
                        createVNode(_component_Guide)
                      ]),
                      _: 1
                    })
                  ]),
                  _: 1
                })) : createCommentVNode("", true),
                hasPerm("tunnels") ? (openBlock(), createBlock(_component_el_menu_item, {
                  key: 4,
                  index: "/tunnels"
                }, {
                  title: withCtx(() => [
                    createTextVNode("隧道状态")
                  ]),
                  default: withCtx(() => [
                    createVNode(_component_el_icon, null, {
                      default: withCtx(() => [
                        createVNode(_component_Connection)
                      ]),
                      _: 1
                    })
                  ]),
                  _: 1
                })) : createCommentVNode("", true),
                hasPerm("audit") ? (openBlock(), createBlock(_component_el_menu_item, {
                  key: 5,
                  index: "/audit"
                }, {
                  title: withCtx(() => [
                    createTextVNode("审计日志")
                  ]),
                  default: withCtx(() => [
                    createVNode(_component_el_icon, null, {
                      default: withCtx(() => [
                        createVNode(_component_Document)
                      ]),
                      _: 1
                    })
                  ]),
                  _: 1
                })) : createCommentVNode("", true),
                hasPerm("admins") ? (openBlock(), createBlock(_component_el_menu_item, {
                  key: 6,
                  index: "/admins"
                }, {
                  title: withCtx(() => [
                    createTextVNode("管理员管理")
                  ]),
                  default: withCtx(() => [
                    createVNode(_component_el_icon, null, {
                      default: withCtx(() => [
                        createVNode(_component_Setting)
                      ]),
                      _: 1
                    })
                  ]),
                  _: 1
                })) : createCommentVNode("", true),
                isSuperAdmin.value ? (openBlock(), createBlock(_component_el_menu_item, {
                  key: 7,
                  index: "/settings/api"
                }, {
                  title: withCtx(() => [
                    createTextVNode("API 连接")
                  ]),
                  default: withCtx(() => [
                    createVNode(_component_el_icon, null, {
                      default: withCtx(() => [
                        createVNode(_component_Link)
                      ]),
                      _: 1
                    })
                  ]),
                  _: 1
                })) : createCommentVNode("", true)
              ];
            }
          }),
          _: 1
        }, _parent));
        _push(`</div></aside><div class="${ssrRenderClass([{ "is-collapsed": isCollapsed.value }, "layout-main"])}" data-v-cbcf4284><header class="layout-header" data-v-cbcf4284><div class="header-left" data-v-cbcf4284><button type="button" class="collapse-btn"${ssrRenderAttr("aria-expanded", String(!isCollapsed.value))}${ssrRenderAttr("aria-label", isCollapsed.value ? "展开侧栏" : "收起侧栏")} data-v-cbcf4284>`);
        _push(ssrRenderComponent(_component_el_icon, null, {
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              if (!isCollapsed.value) {
                _push2(ssrRenderComponent(_component_Fold, null, null, _parent2, _scopeId));
              } else {
                _push2(ssrRenderComponent(_component_Expand, null, null, _parent2, _scopeId));
              }
            } else {
              return [
                !isCollapsed.value ? (openBlock(), createBlock(_component_Fold, { key: 0 })) : (openBlock(), createBlock(_component_Expand, { key: 1 }))
              ];
            }
          }),
          _: 1
        }, _parent));
        _push(`</button>`);
        if (isMobile.value) {
          _push(`<span class="header-route-title" data-v-cbcf4284>${ssrInterpolate(currentBreadcrumb.value || "VPN 管理中心")}</span>`);
        } else {
          _push(`<!---->`);
        }
        if (!isMobile.value) {
          _push(ssrRenderComponent(_component_el_breadcrumb, { separator: "/" }, {
            default: withCtx((_, _push2, _parent2, _scopeId) => {
              if (_push2) {
                _push2(ssrRenderComponent(_component_el_breadcrumb_item, { to: { path: "/" } }, {
                  default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                    if (_push3) {
                      _push3(`首页`);
                    } else {
                      return [
                        createTextVNode("首页")
                      ];
                    }
                  }),
                  _: 1
                }, _parent2, _scopeId));
                if (currentBreadcrumb.value) {
                  _push2(ssrRenderComponent(_component_el_breadcrumb_item, null, {
                    default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                      if (_push3) {
                        _push3(`${ssrInterpolate(currentBreadcrumb.value)}`);
                      } else {
                        return [
                          createTextVNode(toDisplayString(currentBreadcrumb.value), 1)
                        ];
                      }
                    }),
                    _: 1
                  }, _parent2, _scopeId));
                } else {
                  _push2(`<!---->`);
                }
              } else {
                return [
                  createVNode(_component_el_breadcrumb_item, { to: { path: "/" } }, {
                    default: withCtx(() => [
                      createTextVNode("首页")
                    ]),
                    _: 1
                  }),
                  currentBreadcrumb.value ? (openBlock(), createBlock(_component_el_breadcrumb_item, { key: 0 }, {
                    default: withCtx(() => [
                      createTextVNode(toDisplayString(currentBreadcrumb.value), 1)
                    ]),
                    _: 1
                  })) : createCommentVNode("", true)
                ];
              }
            }),
            _: 1
          }, _parent));
        } else {
          _push(`<!---->`);
        }
        _push(`</div><div class="header-right" data-v-cbcf4284>`);
        _push(ssrRenderComponent(_component_el_dropdown, {
          trigger: "click",
          onCommand: handleCommand
        }, {
          dropdown: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(ssrRenderComponent(_component_el_dropdown_menu, null, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(ssrRenderComponent(_component_el_dropdown_item, { command: "changePwd" }, {
                      default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                        if (_push4) {
                          _push4(ssrRenderComponent(_component_el_icon, null, {
                            default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                              if (_push5) {
                                _push5(ssrRenderComponent(_component_Lock, null, null, _parent5, _scopeId4));
                              } else {
                                return [
                                  createVNode(_component_Lock)
                                ];
                              }
                            }),
                            _: 1
                          }, _parent4, _scopeId3));
                          _push4(`修改密码 `);
                        } else {
                          return [
                            createVNode(_component_el_icon, null, {
                              default: withCtx(() => [
                                createVNode(_component_Lock)
                              ]),
                              _: 1
                            }),
                            createTextVNode("修改密码 ")
                          ];
                        }
                      }),
                      _: 1
                    }, _parent3, _scopeId2));
                    _push3(ssrRenderComponent(_component_el_dropdown_item, {
                      command: "logout",
                      divided: ""
                    }, {
                      default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                        if (_push4) {
                          _push4(ssrRenderComponent(_component_el_icon, null, {
                            default: withCtx((_4, _push5, _parent5, _scopeId4) => {
                              if (_push5) {
                                _push5(ssrRenderComponent(_component_SwitchButton, null, null, _parent5, _scopeId4));
                              } else {
                                return [
                                  createVNode(_component_SwitchButton)
                                ];
                              }
                            }),
                            _: 1
                          }, _parent4, _scopeId3));
                          _push4(`退出登录 `);
                        } else {
                          return [
                            createVNode(_component_el_icon, null, {
                              default: withCtx(() => [
                                createVNode(_component_SwitchButton)
                              ]),
                              _: 1
                            }),
                            createTextVNode("退出登录 ")
                          ];
                        }
                      }),
                      _: 1
                    }, _parent3, _scopeId2));
                  } else {
                    return [
                      createVNode(_component_el_dropdown_item, { command: "changePwd" }, {
                        default: withCtx(() => [
                          createVNode(_component_el_icon, null, {
                            default: withCtx(() => [
                              createVNode(_component_Lock)
                            ]),
                            _: 1
                          }),
                          createTextVNode("修改密码 ")
                        ]),
                        _: 1
                      }),
                      createVNode(_component_el_dropdown_item, {
                        command: "logout",
                        divided: ""
                      }, {
                        default: withCtx(() => [
                          createVNode(_component_el_icon, null, {
                            default: withCtx(() => [
                              createVNode(_component_SwitchButton)
                            ]),
                            _: 1
                          }),
                          createTextVNode("退出登录 ")
                        ]),
                        _: 1
                      })
                    ];
                  }
                }),
                _: 1
              }, _parent2, _scopeId));
            } else {
              return [
                createVNode(_component_el_dropdown_menu, null, {
                  default: withCtx(() => [
                    createVNode(_component_el_dropdown_item, { command: "changePwd" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_icon, null, {
                          default: withCtx(() => [
                            createVNode(_component_Lock)
                          ]),
                          _: 1
                        }),
                        createTextVNode("修改密码 ")
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_dropdown_item, {
                      command: "logout",
                      divided: ""
                    }, {
                      default: withCtx(() => [
                        createVNode(_component_el_icon, null, {
                          default: withCtx(() => [
                            createVNode(_component_SwitchButton)
                          ]),
                          _: 1
                        }),
                        createTextVNode("退出登录 ")
                      ]),
                      _: 1
                    })
                  ]),
                  _: 1
                })
              ];
            }
          }),
          default: withCtx((_, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(`<span class="user-dropdown" data-v-cbcf4284${_scopeId}>`);
              _push2(ssrRenderComponent(_component_el_avatar, {
                size: 32,
                style: { "background": "var(--color-primary)" }
              }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(ssrRenderComponent(_component_el_icon, null, {
                      default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                        if (_push4) {
                          _push4(ssrRenderComponent(_component_UserFilled, null, null, _parent4, _scopeId3));
                        } else {
                          return [
                            createVNode(_component_UserFilled)
                          ];
                        }
                      }),
                      _: 1
                    }, _parent3, _scopeId2));
                  } else {
                    return [
                      createVNode(_component_el_icon, null, {
                        default: withCtx(() => [
                          createVNode(_component_UserFilled)
                        ]),
                        _: 1
                      })
                    ];
                  }
                }),
                _: 1
              }, _parent2, _scopeId));
              _push2(`<span class="user-name" data-v-cbcf4284${_scopeId}>${ssrInterpolate(adminInfo.value.username || "管理员")}</span>`);
              _push2(ssrRenderComponent(_component_el_tag, {
                type: roleTagType.value,
                size: "small",
                style: { "margin-left": "4px" }
              }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(`${ssrInterpolate(roleLabel.value)}`);
                  } else {
                    return [
                      createTextVNode(toDisplayString(roleLabel.value), 1)
                    ];
                  }
                }),
                _: 1
              }, _parent2, _scopeId));
              _push2(ssrRenderComponent(_component_el_icon, { class: "dropdown-arrow" }, {
                default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                  if (_push3) {
                    _push3(ssrRenderComponent(_component_ArrowDown, null, null, _parent3, _scopeId2));
                  } else {
                    return [
                      createVNode(_component_ArrowDown)
                    ];
                  }
                }),
                _: 1
              }, _parent2, _scopeId));
              _push2(`</span>`);
            } else {
              return [
                createVNode("span", { class: "user-dropdown" }, [
                  createVNode(_component_el_avatar, {
                    size: 32,
                    style: { "background": "var(--color-primary)" }
                  }, {
                    default: withCtx(() => [
                      createVNode(_component_el_icon, null, {
                        default: withCtx(() => [
                          createVNode(_component_UserFilled)
                        ]),
                        _: 1
                      })
                    ]),
                    _: 1
                  }),
                  createVNode("span", { class: "user-name" }, toDisplayString(adminInfo.value.username || "管理员"), 1),
                  createVNode(_component_el_tag, {
                    type: roleTagType.value,
                    size: "small",
                    style: { "margin-left": "4px" }
                  }, {
                    default: withCtx(() => [
                      createTextVNode(toDisplayString(roleLabel.value), 1)
                    ]),
                    _: 1
                  }, 8, ["type"]),
                  createVNode(_component_el_icon, { class: "dropdown-arrow" }, {
                    default: withCtx(() => [
                      createVNode(_component_ArrowDown)
                    ]),
                    _: 1
                  })
                ])
              ];
            }
          }),
          _: 1
        }, _parent));
        _push(`</div></header><main class="layout-content" data-v-cbcf4284>`);
        _push(ssrRenderComponent(_component_router_view, null, {
          default: withCtx(({ Component }, _push2, _parent2, _scopeId) => {
            if (_push2) {
              _push2(``);
              ssrRenderVNode(_push2, createVNode(resolveDynamicComponent(Component), null, null), _parent2, _scopeId);
            } else {
              return [
                createVNode(Transition, {
                  name: "fade-transform",
                  mode: "out-in"
                }, {
                  default: withCtx(() => [
                    (openBlock(), createBlock(resolveDynamicComponent(Component)))
                  ]),
                  _: 2
                }, 1024)
              ];
            }
          }),
          _: 1
        }, _parent));
        _push(`</main></div>`);
        if (isMobile.value && !isCollapsed.value) {
          _push(`<div class="mobile-sidebar-mask" data-v-cbcf4284></div>`);
        } else {
          _push(`<!---->`);
        }
        _push(`</div>`);
      }
      _push(ssrRenderComponent(_component_el_dialog, {
        modelValue: changePwdVisible.value,
        "onUpdate:modelValue": ($event) => changePwdVisible.value = $event,
        title: "修改密码",
        width: "400px",
        "destroy-on-close": ""
      }, {
        footer: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_button, {
              onClick: ($event) => changePwdVisible.value = false
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`取消`);
                } else {
                  return [
                    createTextVNode("取消")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
            _push2(ssrRenderComponent(_component_el_button, {
              type: "primary",
              loading: changingPwd.value,
              onClick: handleChangePwd
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(`确定`);
                } else {
                  return [
                    createTextVNode("确定")
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_button, {
                onClick: ($event) => changePwdVisible.value = false
              }, {
                default: withCtx(() => [
                  createTextVNode("取消")
                ]),
                _: 1
              }, 8, ["onClick"]),
              createVNode(_component_el_button, {
                type: "primary",
                loading: changingPwd.value,
                onClick: handleChangePwd
              }, {
                default: withCtx(() => [
                  createTextVNode("确定")
                ]),
                _: 1
              }, 8, ["loading"])
            ];
          }
        }),
        default: withCtx((_, _push2, _parent2, _scopeId) => {
          if (_push2) {
            _push2(ssrRenderComponent(_component_el_form, {
              model: pwdForm,
              "label-width": "80px"
            }, {
              default: withCtx((_2, _push3, _parent3, _scopeId2) => {
                if (_push3) {
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "旧密码" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: pwdForm.oldPassword,
                          "onUpdate:modelValue": ($event) => pwdForm.oldPassword = $event,
                          type: "password",
                          "show-password": "",
                          placeholder: "请输入当前密码"
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: pwdForm.oldPassword,
                            "onUpdate:modelValue": ($event) => pwdForm.oldPassword = $event,
                            type: "password",
                            "show-password": "",
                            placeholder: "请输入当前密码"
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "新密码" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: pwdForm.newPassword,
                          "onUpdate:modelValue": ($event) => pwdForm.newPassword = $event,
                          type: "password",
                          "show-password": "",
                          placeholder: "至少6位"
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: pwdForm.newPassword,
                            "onUpdate:modelValue": ($event) => pwdForm.newPassword = $event,
                            type: "password",
                            "show-password": "",
                            placeholder: "至少6位"
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                  _push3(ssrRenderComponent(_component_el_form_item, { label: "确认密码" }, {
                    default: withCtx((_3, _push4, _parent4, _scopeId3) => {
                      if (_push4) {
                        _push4(ssrRenderComponent(_component_el_input, {
                          modelValue: pwdForm.confirmPassword,
                          "onUpdate:modelValue": ($event) => pwdForm.confirmPassword = $event,
                          type: "password",
                          "show-password": "",
                          placeholder: "再次输入新密码"
                        }, null, _parent4, _scopeId3));
                      } else {
                        return [
                          createVNode(_component_el_input, {
                            modelValue: pwdForm.confirmPassword,
                            "onUpdate:modelValue": ($event) => pwdForm.confirmPassword = $event,
                            type: "password",
                            "show-password": "",
                            placeholder: "再次输入新密码"
                          }, null, 8, ["modelValue", "onUpdate:modelValue"])
                        ];
                      }
                    }),
                    _: 1
                  }, _parent3, _scopeId2));
                } else {
                  return [
                    createVNode(_component_el_form_item, { label: "旧密码" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: pwdForm.oldPassword,
                          "onUpdate:modelValue": ($event) => pwdForm.oldPassword = $event,
                          type: "password",
                          "show-password": "",
                          placeholder: "请输入当前密码"
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "新密码" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: pwdForm.newPassword,
                          "onUpdate:modelValue": ($event) => pwdForm.newPassword = $event,
                          type: "password",
                          "show-password": "",
                          placeholder: "至少6位"
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    }),
                    createVNode(_component_el_form_item, { label: "确认密码" }, {
                      default: withCtx(() => [
                        createVNode(_component_el_input, {
                          modelValue: pwdForm.confirmPassword,
                          "onUpdate:modelValue": ($event) => pwdForm.confirmPassword = $event,
                          type: "password",
                          "show-password": "",
                          placeholder: "再次输入新密码"
                        }, null, 8, ["modelValue", "onUpdate:modelValue"])
                      ]),
                      _: 1
                    })
                  ];
                }
              }),
              _: 1
            }, _parent2, _scopeId));
          } else {
            return [
              createVNode(_component_el_form, {
                model: pwdForm,
                "label-width": "80px"
              }, {
                default: withCtx(() => [
                  createVNode(_component_el_form_item, { label: "旧密码" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: pwdForm.oldPassword,
                        "onUpdate:modelValue": ($event) => pwdForm.oldPassword = $event,
                        type: "password",
                        "show-password": "",
                        placeholder: "请输入当前密码"
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "新密码" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: pwdForm.newPassword,
                        "onUpdate:modelValue": ($event) => pwdForm.newPassword = $event,
                        type: "password",
                        "show-password": "",
                        placeholder: "至少6位"
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  }),
                  createVNode(_component_el_form_item, { label: "确认密码" }, {
                    default: withCtx(() => [
                      createVNode(_component_el_input, {
                        modelValue: pwdForm.confirmPassword,
                        "onUpdate:modelValue": ($event) => pwdForm.confirmPassword = $event,
                        type: "password",
                        "show-password": "",
                        placeholder: "再次输入新密码"
                      }, null, 8, ["modelValue", "onUpdate:modelValue"])
                    ]),
                    _: 1
                  })
                ]),
                _: 1
              }, 8, ["model"])
            ];
          }
        }),
        _: 1
      }, _parent));
      _push(`<!--]-->`);
    };
  }
};
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("src/App.vue");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const App = /* @__PURE__ */ _export_sfc(_sfc_main, [["__scopeId", "data-v-cbcf4284"]]);
repairStoredApiBaseIfNeeded();
const createApp = ViteSSG(
  App,
  { routes, base: "/" },
  ({ app, router }) => {
    bindRouter(router);
    installNavigationGuards(router);
    for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
      app.component(key, component);
    }
    app.use(createPinia());
    app.use(ElementPlus);
  }
);
async function includedRoutes(paths) {
  return paths.filter((p) => !p.includes(":"));
}
export {
  createApp,
  includedRoutes
};
