# Web UI 重构计划

## 概述

将 VPN 管理后台的 Web UI 从基础原型升级为专业级后台管理系统，统一所有样式和 JS 代码规范。

## 已完成变更

### 1. 基础架构搭建

| 文件 | 变更内容 |
|------|---------|
| `src/assets/styles/global.scss` | 全面重写。定义 CSS 变量体系（颜色、间距、圆角、阴影、过渡），全局 reset，滚动条美化，布局类（`.layout-sidebar`、`.layout-header`、`.layout-content`），页面模式类（`.page-card`、`.action-bar`、`.filter-group`、`.pagination-wrap`），统计卡片（`.stat-card`），状态指示点（`.status-dot--*`），Element Plus 组件覆写，路由过渡动画。 |
| `src/main.js` | 引入 `global.scss`，全局注册 `@element-plus/icons-vue` 图标库。 |
| `src/api/http.js` | 响应拦截器增加统一业务错误提示：401 自动跳转登录 + 提示，403/500+ 自动 `ElMessage.error`，有 `error` 字段的响应自动提示。各页面不再需要重复写 `catch + ElMessage.error`。 |
| `src/utils/index.js` | 新建公共工具模块：`formatDate()`、`formatRelativeTime()`、`getStatusInfo(category, status)` 状态映射、`confirmAction()`、`downloadBlob()` 文件下载。 |

### 2. 全局布局 (`App.vue`)

- 深色侧边栏（`#001529`）+ Logo 区域 + 图标菜单
- 侧边栏折叠/展开功能
- 顶部导航栏：折叠按钮 + 面包屑导航 + 用户头像下拉菜单
- 路由切换过渡动画（`fade-transform`）
- 登录页和自助页脱离主布局

### 3. 登录页 (`Login.vue`)

- 左右分栏设计：左侧深色品牌区 + 右侧登录表单
- 使用封装的 `http.js` 替代直接 `axios`
- 响应式：移动端隐藏品牌区
- 渐变背景

### 4. 仪表盘 (`Dashboard.vue`)

- 彩色统计卡片：图标 + 数值 + 标签，hover 上浮效果
- 节点状态表格：使用 `status-dot` 指示灯 + 可点击跳转
- 最近操作时间线：使用 `formatRelativeTime()` 显示相对时间
- "查看全部" 快捷链接

### 5. 列表页面标准化

所有列表页统一采用以下规范：

- **布局结构**：`page-card` > `page-card-header` > `action-bar` > `el-table` > `pagination-wrap`
- **筛选区**：使用 `.filter-group` 包裹搜索框和下拉筛选
- **表格**：`stripe` 斑马纹，`status-dot` 状态指示，合理列宽
- **空状态**：使用 `el-empty` 组件
- **错误处理**：依赖 `http.js` 统一拦截，仅在需要成功提示时写 `ElMessage.success`
- **对话框**：统一 `destroy-on-close`
- **表单重置**：使用 `Object.assign()` 统一重置

| 页面 | 关键变更 |
|------|---------|
| `Nodes.vue` | 统一布局，搜索框加图标，状态用 `status-dot`，实例标签优化 |
| `NodeDetail.vue` | 统计卡片化，使用 `getStatusInfo()`，空状态处理 |
| `Users.vue` | 统一布局，操作按钮加图标，授权弹窗优化 |
| `Rules.vue` | 统一布局，使用 `formatDate()` 格式化时间 |
| `Tunnels.vue` | 拓扑图使用 CSS 变量替代硬编码颜色，表格统一风格 |
| `Audit.vue` | 统一布局，使用 `downloadBlob()` 导出，分页使用 `.pagination-wrap` |
| `SelfService.vue` | 使用 `http.js` 替代直接 `axios`，使用 `getStatusInfo()` |
| `Admins.vue` | **新增页面**，管理员 CRUD + 角色权限 + 重置密码，按统一规范重构 |

### 6. 协作者新增功能（已合并并规范化）

| 功能 | 说明 |
|------|------|
| **管理员管理** (`Admins.vue`) | 新增页面，支持管理员增删改查、角色分配（admin/operator/viewer）、权限模块配置、重置密码 |
| **权限控制** (`App.vue`) | 侧边栏菜单根据 JWT token 中的 `role` 和 `perms` 字段动态显示/隐藏 |
| **修改密码** (`App.vue`) | 用户下拉菜单增加"修改密码"功能，调用 `POST /api/me/password` |
| **用户信息展示** (`App.vue`) | 顶部导航栏显示当前管理员用户名和角色标签 |
| **下载优化** (`Users.vue`) | `downloadOVPN` 改为 `responseType: 'blob'` + 解析 `content-disposition` 获取文件名 |
| **路由新增** (`router/index.js`) | 新增 `/admins` 路由 |
| **调试代码清理** (`Dashboard.vue`) | 清理了被注入的 `fetch('http://127.0.0.1:7363/...')` 调试代码 |

## CSS 变量一览

```scss
--color-primary / --color-success / --color-warning / --color-danger / --color-info
--bg-page / --bg-card / --bg-sidebar / --bg-sidebar-menu / --bg-sidebar-hover
--text-primary / --text-regular / --text-secondary / --text-sidebar / --text-sidebar-active
--border-light / --border-lighter
--radius-sm / --radius-md / --radius-lg
--shadow-sm / --shadow-md / --shadow-lg
--header-height / --sidebar-width / --sidebar-collapsed-width
--spacing-xs / --spacing-sm / --spacing-md / --spacing-lg / --spacing-xl
--transition-fast / --transition-normal
```

## 公共工具函数 (`src/utils/index.js`)

| 函数 | 用途 |
|------|------|
| `formatDate(val)` | 格式化为 `YYYY-MM-DD HH:mm:ss` |
| `formatRelativeTime(val)` | 格式化为"刚刚"、"5 分钟前"等 |
| `getStatusInfo(category, status)` | 返回 `{ label, type }`，支持 node/user/cert/tunnel |
| `confirmAction(message, action)` | 执行操作并显示成功提示 |
| `downloadBlob(content, filename)` | 创建 Blob 并触发下载 |

## 文件结构

```
src/
├── api/
│   └── http.js              # Axios 封装 + 统一错误处理
├── assets/
│   └── styles/
│       └── global.scss       # 全局样式 + CSS 变量
├── router/
│   └── index.js              # 路由配置（未变更）
├── utils/
│   └── index.js              # 公共工具函数
├── views/
│   ├── Admins.vue            # 管理员管理（CRUD + 角色权限）
│   ├── Audit.vue
│   ├── Dashboard.vue
│   ├── Login.vue
│   ├── NodeDetail.vue
│   ├── Nodes.vue
│   ├── Rules.vue
│   ├── SelfService.vue
│   ├── Tunnels.vue
│   └── Users.vue
├── App.vue                   # 全局布局（含权限控制 + 修改密码）
└── main.js                   # 入口文件
```
