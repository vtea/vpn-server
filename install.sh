#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════════
# VPN 管理平台 — 一键安装入口
#
# 用法：
#   bash install.sh                    # 交互式安装（推荐）
#   bash install.sh --yes              # 跳过确认直接安装
#   bash install.sh --node             # 仅部署 VPN 节点（非控制面）
#   bash install.sh --help             # 查看帮助
#
# 说明：
#   本脚本是项目根目录的统一入口，会自动检测当前目录结构，
#   调用正确的部署脚本，无需手动查找路径。
#   管道或非交互环境（无 TTY）时控制面会自动继续并安装依赖；可用 --yes/-y 显式跳过确认。
#
# 默认端口（与 vpn-api 环境变量 API_PORT、docs/ports.md 一致）：
#   - 控制面 API：56700/tcp（REST、Agent WebSocket）
#   - 开发时管理台（Vite）：56701/tcp；生产可经 Nginx 监听 443/80 反代到 API
# ═══════════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODE="control-plane"
EXTRA_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --node)  MODE="node" ;;
    --help|-h)
      cat <<'HELP'
═══════════════════════════════════════════════════════════════
  VPN 管理平台安装程序
═══════════════════════════════════════════════════════════════

用法: bash install.sh [选项]

安装模式:
  (默认)          安装控制面（API + 前端构建；反向代理/TLS 请自备，见 docs/nginx-control-plane.example.conf）
  --node          仅安装 VPN 节点（需要先有控制面）

端口约定详见 docs/ports.md（摘要：API 默认 56700；管理台开发默认 56701）。

选项:
  --domain DOMAIN   设置 EXTERNAL_URL=https://DOMAIN（TLS 仍由你方 Nginx/证书处理）
  --skip-frontend   跳过前端构建
  --jwt-secret KEY  指定 JWT 密钥
  --http-proxy URL  控制面装依赖时使用 HTTP(S) 代理（透传 deploy-control-plane.sh）
  --socks5 URL      SOCKS5：推荐 socks5://账号:密码@主机:端口；无认证可 主机:端口
  --yes, -y         跳过所有确认提示（含控制面「是否自动安装缺失依赖」）
  --help, -h        显示此帮助

控制面：交互模式下若缺 Go/Node/apt 等，会先询问是否由脚本自动安装；选否将输出手动安装说明并退出。

控制面安装 (默认):
  bash install.sh
  bash install.sh --domain vpn.company.com
  bash install.sh --yes --skip-frontend

节点安装:
  bash install.sh --node --api-url http://控制面IP:56700 --token <TOKEN>
  bash install.sh --node --api-url http://控制面IP:56700 --token <TOKEN> --apply

完整流程:
  1. 在控制面服务器: bash install.sh
  2. 登录 Web 管理端（开发常见 http://<控制面IP>:56701；若已配 Nginx 则为 https://域名 或 :443），添加节点，复制 token
  3. 在节点服务器:   bash install.sh --node --api-url http://<控制面IP>:56700 --token <TOKEN> --apply

项目结构:
  install.sh              ← 你在这里
  vpn-api/                ← Go 后端 + Agent 源码
  vpn-admin-web/          ← Vue3 前端源码
  docs/                   ← 架构文档、运维手册、用户指南、ports.md（默认端口）
═══════════════════════════════════════════════════════════════
HELP
      exit 0 ;;
    *)  EXTRA_ARGS+=("$arg") ;;
  esac
done

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  VPN 管理平台安装程序"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  项目目录: $SCRIPT_DIR"
echo "  安装模式: $MODE"
echo ""

# 验证项目结构
if [[ ! -d "$SCRIPT_DIR/vpn-api" ]]; then
  echo "错误: 未找到 vpn-api/ 目录"
  echo "请确认你在项目根目录下运行此脚本。"
  echo ""
  echo "正确的目录结构:"
  echo "  $(basename "$SCRIPT_DIR")/"
  echo "  ├── install.sh        ← 当前脚本"
  echo "  ├── vpn-api/"
  echo "  ├── vpn-admin-web/"
  echo "  └── docs/"
  exit 1
fi

case "$MODE" in
  control-plane)
    DEPLOY_SCRIPT="$SCRIPT_DIR/vpn-api/scripts/deploy-control-plane.sh"
    if [[ ! -f "$DEPLOY_SCRIPT" ]]; then
      echo "错误: 未找到 $DEPLOY_SCRIPT"
      exit 1
    fi
    echo "  即将安装: 控制面 (API + Web 静态构建；Nginx 示例见 docs/)"
    echo ""
    exec bash "$DEPLOY_SCRIPT" --source-dir "$SCRIPT_DIR" "${EXTRA_ARGS[@]}"
    ;;

  node)
    NODE_SCRIPT="$SCRIPT_DIR/vpn-api/scripts/node-setup.sh"
    if [[ ! -f "$NODE_SCRIPT" ]]; then
      echo "错误: 未找到 $NODE_SCRIPT"
      exit 1
    fi
    echo "  即将安装: VPN 节点"
    echo ""
    exec bash "$NODE_SCRIPT" "${EXTRA_ARGS[@]}"
    ;;
esac
