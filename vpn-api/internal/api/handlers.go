package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
	"vpn-api/internal/config"
	"vpn-api/internal/debuglog"
	"vpn-api/internal/model"
	"vpn-api/internal/service"
)

// DefaultAgentDownloadPackage is the name segment in versioned agent URLs:
// GET /api/downloads/vpn-agent/{arch}/{package}+{version}. Reserved for future multi-artifact support.
const DefaultAgentDownloadPackage = "vpn-agent"

type Handler struct {
	db                 *gorm.DB
	jwtSecret          string
	hub                *WSHub
	ca                 *service.CentralCA
	adminWS            *AdminWSHub
	externalURL        string
	externalURLLAN     string // optional; when set, CreateNode exposes a second deploy command for intranet
	agentLatestVersion string
	caDir              string // used to resolve e.g. /opt/vpn-api/bin/vpn-agent-linux-* when not under /usr/local/bin
	dbPath             string // sqlite: used with dbDriver to find …/bin next to …/data/vpn.db
	dbDriver           string
	ipListDualEnabled  bool
	wgRefreshLocks     sync.Map
}

func NewHandler(db *gorm.DB, jwtSecret string, hub *WSHub, ca *service.CentralCA, externalURL, externalURLLAN, agentLatestVersion, caDir, dbPath, dbDriver string, ipListDualEnabled bool) *Handler {
	h := &Handler{
		db: db, jwtSecret: jwtSecret, hub: hub, ca: ca, adminWS: NewAdminWSHub(),
		externalURL: externalURL, externalURLLAN: strings.TrimSpace(externalURLLAN), agentLatestVersion: strings.TrimSpace(agentLatestVersion), caDir: caDir,
		dbPath: dbPath, dbDriver: strings.TrimSpace(dbDriver), ipListDualEnabled: ipListDualEnabled,
	}
	h.normalizePersistedAgentVersions()
	return h
}

func (h *Handler) normalizePersistedAgentVersions() {
	if h == nil || h.db == nil {
		return
	}
	_ = h.db.Model(&model.Node{}).
		Where("agent_version LIKE ?", "%-unknown").
		Update("agent_version", gorm.Expr("REPLACE(agent_version, ?, '')", "-unknown")).Error
}

func (h *Handler) audit(c *gin.Context, action, target, detail string) {
	admin, _ := c.Get("admin")
	adminStr, _ := admin.(string)
	if adminStr == "" {
		adminStr = "system"
	}
	log := model.AuditLog{
		AdminUser: adminStr,
		Action:    action,
		Target:    target,
		Detail:    detail,
	}
	_ = h.db.Create(&log).Error
}

func (h *Handler) nodeRefreshLock(nodeID string) *sync.Mutex {
	if v, ok := h.wgRefreshLocks.Load(nodeID); ok {
		if mu, ok2 := v.(*sync.Mutex); ok2 {
			return mu
		}
	}
	mu := &sync.Mutex{}
	actual, _ := h.wgRefreshLocks.LoadOrStore(nodeID, mu)
	out, _ := actual.(*sync.Mutex)
	if out == nil {
		return mu
	}
	return out
}

type loginReq struct {
	Username string `json:"username" binding:"required"`
	Password string `json:"password" binding:"required"`
}

func (h *Handler) Login(c *gin.Context) {
	var req loginReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var admin model.Admin
	if err := h.db.Where("username = ?", req.Username).First(&admin).Error; err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(admin.PasswordHash), []byte(req.Password)); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}

	claims := jwt.MapClaims{
		"sub":   admin.Username,
		"role":  admin.Role,
		"perms": admin.Permissions,
		"exp":   time.Now().Add(12 * time.Hour).Unix(),
	}
	jt := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	token, err := jt.SignedString([]byte(h.jwtSecret))
	if err != nil {
		// 仅极少数情况（如密钥配置异常）；便于排查
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to sign token"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"token": token,
		"admin": gin.H{
			"id":          admin.ID,
			"username":    admin.Username,
			"role":        admin.Role,
			"permissions": admin.Permissions,
			"created_at":  admin.CreatedAt,
		},
	})
}

func (h *Handler) GetCurrentAdmin(c *gin.Context) {
	username, _ := c.Get("admin")
	usernameStr, _ := username.(string)
	var admin model.Admin
	if err := h.db.Where("username = ?", usernameStr).First(&admin).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "admin not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"admin": admin})
}

type changePasswordReq struct {
	OldPassword string `json:"old_password" binding:"required"`
	NewPassword string `json:"new_password" binding:"required"`
}

func (h *Handler) ChangePassword(c *gin.Context) {
	username, _ := c.Get("admin")
	usernameStr, _ := username.(string)

	var req changePasswordReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(req.NewPassword) < 6 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "password must be at least 6 characters"})
		return
	}

	var admin model.Admin
	if err := h.db.Where("username = ?", usernameStr).First(&admin).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "admin not found"})
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(admin.PasswordHash), []byte(req.OldPassword)); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "old password is incorrect"})
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	admin.PasswordHash = string(hash)
	h.db.Save(&admin)
	h.audit(c, "change_password", fmt.Sprintf("admin:%s", admin.Username), "self")
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) Health(c *gin.Context) {
	// grant_purge：管理台用于判断后端是否支持 DELETE /api/grants/:id/purge（旧二进制无此路由会 404）
	c.JSON(http.StatusOK, gin.H{
		"status":      "ok",
		"grant_purge": true,
	})
}

type createNodeReq struct {
	Name       string   `json:"name" binding:"required"`
	Region     string   `json:"region" binding:"required"`
	PublicIP   string   `json:"public_ip" binding:"required"`
	SegmentIDs []string `json:"segment_ids"`
}

func (h *Handler) CreateNode(c *gin.Context) {
	var req createNodeReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	segmentIDs := req.SegmentIDs
	if len(segmentIDs) == 0 {
		segmentIDs = []string{"default"}
	}
	seen := map[string]bool{}
	var uniqSeg []string
	for _, sid := range segmentIDs {
		if sid == "" || seen[sid] {
			continue
		}
		seen[sid] = true
		uniqSeg = append(uniqSeg, sid)
	}
	if len(uniqSeg) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "segment_ids must contain at least one valid id"})
		return
	}
	segmentIDs = uniqSeg

	var segs []model.NetworkSegment
	for _, sid := range segmentIDs {
		var s model.NetworkSegment
		if err := h.db.Where("id = ?", sid).First(&s).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("network segment not found: %s", sid)})
			return
		}
		segs = append(segs, s)
	}
	if err := service.ValidateSegmentsPortOverlap(segs); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var node model.Node
	var bootstrapToken string
	var tunnels []model.Tunnel
	var instances []model.Instance
	if err := h.db.Transaction(func(tx *gorm.DB) error {
		num, err := service.NextNodeNumber(tx)
		if err != nil {
			return err
		}
		nodeID := service.NodeIDFromNumber(num)
		btok, err := service.NewBootstrapToken()
		if err != nil {
			return err
		}
		bootstrapToken = btok
		node = model.Node{
			ID:         nodeID,
			Name:       req.Name,
			NodeNumber: num,
			Region:     req.Region,
			PublicIP:   req.PublicIP,
			Status:     "offline",
		}
		nodeToken := model.NodeBootstrapToken{NodeID: nodeID, Token: bootstrapToken}
		if err := tx.Create(&node).Error; err != nil {
			return err
		}
		for _, s := range segs {
			var slot uint8
			if s.ID == "default" && s.SecondOctet == 0 {
				slot = 0
			} else {
				var err error
				slot, err = service.NextSegmentSlot(tx, s.ID)
				if err != nil {
					return err
				}
			}
			ns := model.NodeSegment{NodeID: nodeID, SegmentID: s.ID, Slot: slot}
			if err := tx.Create(&ns).Error; err != nil {
				return err
			}
			instances = append(instances, service.BuildInstancesForMembership(nodeID, num, s, slot)...)
		}
		if err := tx.Create(&instances).Error; err != nil {
			return err
		}
		if err := tx.Create(&nodeToken).Error; err != nil {
			return err
		}
		var cerr error
		tunnels, cerr = service.CreateTunnelsForNewNode(tx, nodeID)
		return cerr
	}); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	h.audit(c, "create_node", fmt.Sprintf("node:%s", node.ID), fmt.Sprintf("region=%s ip=%s tunnels=%d segments=%v", node.Region, node.PublicIP, len(tunnels), segmentIDs))

	resp := gin.H{
		"node":      node,
		"instances": instances,
		"tunnels":   tunnels,
	}
	for k, v := range h.deployHintsForBootstrapToken(c, bootstrapToken) {
		resp[k] = v
	}
	c.JSON(http.StatusCreated, resp)
}

func (h *Handler) ListNodes(c *gin.Context) {
	var nodes []model.Node
	if err := h.db.Find(&nodes).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if len(nodes) == 0 {
		c.JSON(http.StatusOK, gin.H{"items": []gin.H{}})
		return
	}

	nodeIDs := make([]string, 0, len(nodes))
	for _, n := range nodes {
		nodeIDs = append(nodeIDs, n.ID)
	}

	var allInst []model.Instance
	if err := h.db.Where("node_id IN ?", nodeIDs).Find(&allInst).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	instByNode := make(map[string][]model.Instance)
	for _, inst := range allInst {
		instByNode[inst.NodeID] = append(instByNode[inst.NodeID], inst)
	}

	var allNS []model.NodeSegment
	if err := h.db.Where("node_id IN ?", nodeIDs).Find(&allNS).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	segIDSet := make(map[string]struct{})
	for _, ns := range allNS {
		segIDSet[ns.SegmentID] = struct{}{}
	}
	segIDs := make([]string, 0, len(segIDSet))
	for id := range segIDSet {
		segIDs = append(segIDs, id)
	}
	segByID := make(map[string]model.NetworkSegment)
	if len(segIDs) > 0 {
		var segs []model.NetworkSegment
		if err := h.db.Where("id IN ?", segIDs).Find(&segs).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		for _, s := range segs {
			segByID[s.ID] = s
		}
	}
	nsByNode := make(map[string][]model.NodeSegment)
	for _, ns := range allNS {
		nsByNode[ns.NodeID] = append(nsByNode[ns.NodeID], ns)
	}

	res := make([]gin.H, 0, len(nodes))
	for _, n := range nodes {
		segsOut := make([]gin.H, 0)
		for _, ns := range nsByNode[n.ID] {
			if seg, ok := segByID[ns.SegmentID]; ok {
				segsOut = append(segsOut, gin.H{"segment": seg, "slot": ns.Slot})
			}
		}
		instList := instByNode[n.ID]
		if instList == nil {
			instList = []model.Instance{}
		}
		res = append(res, gin.H{
			"node":      n,
			"instances": instList,
			"segments":  segsOut,
		})
	}

	c.JSON(http.StatusOK, gin.H{"items": res})
}

func (h *Handler) GetNode(c *gin.Context) {
	id := c.Param("id")
	var node model.Node
	if err := h.db.Where("id = ?", id).First(&node).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "node not found"})
		return
	}
	var instances []model.Instance
	_ = h.db.Where("node_id = ?", node.ID).Find(&instances).Error
	var tunnels []model.Tunnel
	_ = h.db.Where("node_a = ? OR node_b = ?", id, id).Find(&tunnels).Error
	segs, _ := h.nodeSegmentsDetail(node.ID)
	c.JSON(http.StatusOK, gin.H{
		"node":         node,
		"instances":    instances,
		"segments":     segs,
		"mesh_summary": meshSummaryForNode(id, instances, tunnels),
	})
}

// meshSummaryForNode 聚合展示用：无单一「节点组网 IP」，仅汇总 OpenVPN 实例子网与 WG 隧道本端地址。
func meshSummaryForNode(nodeID string, insts []model.Instance, tunnels []model.Tunnel) gin.H {
	ov := make([]gin.H, 0, len(insts))
	for _, i := range insts {
		ov = append(ov, gin.H{
			"mode":       i.Mode,
			"subnet":     i.Subnet,
			"segment_id": i.SegmentID,
			"proto":      i.Proto,
			"port":       i.Port,
			"enabled":    i.Enabled,
		})
	}
	wgRows := make([]gin.H, 0, len(tunnels))
	for _, t := range tunnels {
		peer := t.NodeB
		local := t.IPA
		if t.NodeA != nodeID {
			peer = t.NodeA
			local = t.IPB
		}
		wgRows = append(wgRows, gin.H{
			"peer_node_id":  peer,
			"local_ip":      local,
			"tunnel_subnet": t.Subnet,
			"wg_port":       t.WGPort,
		})
	}
	return gin.H{
		"note":                     "本节点没有单一「组网 IP」字段：OpenVPN 侧为各接入实例的客户端地址池（CIDR）；WireGuard 骨干为与每个对端一条 /30，本端地址因对端而异。详细见下方「组网接入」与「相关隧道」。",
		"openvpn_instance_subnets": ov,
		"wireguard_peer_local_ips": wgRows,
	}
}

type patchNodeReq struct {
	Name     *string `json:"name"`
	Region   *string `json:"region"`
	PublicIP *string `json:"public_ip"`
}

// PatchNode 更新节点展示字段（名称、地域、公网 IP）。
func (h *Handler) PatchNode(c *gin.Context) {
	id := c.Param("id")
	var node model.Node
	if err := h.db.Where("id = ?", id).First(&node).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "node not found"})
		return
	}
	var req patchNodeReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Name != nil {
		node.Name = strings.TrimSpace(*req.Name)
	}
	if req.Region != nil {
		node.Region = strings.TrimSpace(*req.Region)
	}
	if req.PublicIP != nil {
		s := strings.TrimSpace(*req.PublicIP)
		if s != "" && net.ParseIP(s) == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "public_ip must be a valid IPv4/IPv6 address"})
			return
		}
		node.PublicIP = s
	}
	if node.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name cannot be empty"})
		return
	}
	if err := h.db.Save(&node).Error; err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	h.audit(c, "patch_node", fmt.Sprintf("node:%s", node.ID), fmt.Sprintf("name=%s region=%s ip=%s", node.Name, node.Region, node.PublicIP))
	c.JSON(http.StatusOK, gin.H{"node": node})
}

func (h *Handler) deployHintsForBootstrapToken(c *gin.Context, bootstrapToken string) gin.H {
	var r *http.Request
	if c != nil {
		r = c.Request
	}
	apiURL := config.EffectiveExternalBaseURL(r, h.externalURL)
	out := gin.H{
		"bootstrap_token": bootstrapToken,
		"api_url":         apiURL,
		"deploy_command":  fmt.Sprintf("curl -fsSL %s/api/node-setup.sh | bash -s -- --api-url %s --token %s --apply", apiURL, apiURL, bootstrapToken),
		"deploy_offline":  fmt.Sprintf("bash node-setup.sh --api-url %s --token %s --apply", apiURL, bootstrapToken),
		"script_url":      fmt.Sprintf("%s/api/node-setup.sh", apiURL),
	}
	if lan := strings.TrimRight(h.externalURLLAN, "/"); lan != "" {
		out["api_url_lan"] = lan
		out["deploy_command_lan"] = fmt.Sprintf("curl -fsSL %s/api/node-setup.sh | bash -s -- --api-url %s --token %s --apply", lan, lan, bootstrapToken)
		out["deploy_offline_lan"] = fmt.Sprintf("bash node-setup.sh --api-url %s --token %s --apply", lan, bootstrapToken)
		out["script_url_lan"] = fmt.Sprintf("%s/api/node-setup.sh", lan)
	}
	if config.ExternalURLIsLoopbackOnly(h.externalURL) && !config.ExternalURLIsLoopbackOnly(apiURL) {
		out["deploy_url_note"] = "部署命令中的控制面地址已根据本次浏览器请求的 Host / X-Forwarded-* 自动推断（环境变量 EXTERNAL_URL 仍为回环）。生产环境建议在服务端固定设置 EXTERNAL_URL；反向代理请正确传递 X-Forwarded-Host、X-Forwarded-Proto。"
	}
	if config.ExternalURLIsLoopbackOnly(apiURL) {
		out["deploy_url_warning"] = "无法从当前请求得到公网可达地址（多为本机 127.0.0.1 访问或缺少转发头）。请在运行 vpn-api 的环境设置 EXTERNAL_URL 为控制面公网 IP 或域名（若节点只走内网可设 EXTERNAL_URL_LAN），并放行防火墙/反向代理端口。"
	}
	return out
}

// RotateNodeBootstrapToken 作废旧 bootstrap 令牌并签发新令牌（用于重装 / 误用一次性注册后）。
func (h *Handler) RotateNodeBootstrapToken(c *gin.Context) {
	id := c.Param("id")
	var node model.Node
	if err := h.db.Where("id = ?", id).First(&node).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "node not found"})
		return
	}
	tok, err := service.NewBootstrapToken()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if err := h.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("node_id = ?", id).Delete(&model.NodeBootstrapToken{}).Error; err != nil {
			return err
		}
		return tx.Create(&model.NodeBootstrapToken{NodeID: id, Token: tok}).Error
	}); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	h.audit(c, "rotate_bootstrap_token", fmt.Sprintf("node:%s", id), "")
	resp := h.deployHintsForBootstrapToken(c, tok)
	resp["node_id"] = id
	c.JSON(http.StatusOK, resp)
}

type patchTunnelReq struct {
	Subnet *string `json:"subnet"`
	IPA    *string `json:"ip_a"`
	IPB    *string `json:"ip_b"`
	WGPort *int    `json:"wg_port"`
}

// PatchTunnel 高级：调整 WireGuard /30 与端点 IP；会递增两端节点 config_version。
func (h *Handler) PatchTunnel(c *gin.Context) {
	tid, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid tunnel id"})
		return
	}
	var tun model.Tunnel
	if err := h.db.First(&tun, uint(tid)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "tunnel not found"})
		return
	}
	var req patchTunnelReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Subnet == nil && req.IPA == nil && req.IPB == nil && req.WGPort == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no fields to update"})
		return
	}
	sub, ipa, ipb := tun.Subnet, tun.IPA, tun.IPB
	if req.Subnet != nil {
		sub = strings.TrimSpace(*req.Subnet)
	}
	if req.IPA != nil {
		ipa = strings.TrimSpace(*req.IPA)
	}
	if req.IPB != nil {
		ipb = strings.TrimSpace(*req.IPB)
	}
	if err := service.ValidateTunnelWGFields(h.db, tun.ID, sub, ipa, ipb); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	tun.Subnet, tun.IPA, tun.IPB = sub, ipa, ipb
	if req.WGPort != nil && *req.WGPort > 0 {
		tun.WGPort = *req.WGPort
	}
	if err := h.db.Save(&tun).Error; err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	for _, nid := range []string{tun.NodeA, tun.NodeB} {
		h.db.Model(&model.Node{}).Where("id = ?", nid).UpdateColumn("config_version", gorm.Expr("config_version + ?", 1))
	}
	h.audit(c, "patch_tunnel", fmt.Sprintf("tunnel:%d", tun.ID), fmt.Sprintf("subnet=%s ip_a=%s ip_b=%s wg_port=%d", tun.Subnet, tun.IPA, tun.IPB, tun.WGPort))
	c.JSON(http.StatusOK, gin.H{"tunnel": tun})
}

type createUserReq struct {
	Username    string `json:"username" binding:"required"`
	DisplayName string `json:"display_name"`
	GroupName   string `json:"group_name"`
}

func (h *Handler) CreateUser(c *gin.Context) {
	var req createUserReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	u := model.User{Username: req.Username, DisplayName: req.DisplayName, GroupName: req.GroupName, Status: "active"}
	if u.GroupName == "" {
		u.GroupName = "default"
	}
	if err := h.db.Create(&u).Error; err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	h.audit(c, "create_user", fmt.Sprintf("user:%s", u.Username), fmt.Sprintf("group=%s", u.GroupName))
	c.JSON(http.StatusCreated, gin.H{"user": u})
}

func (h *Handler) ListUsers(c *gin.Context) {
	var users []model.User
	if err := h.db.Find(&users).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": users})
}

func (h *Handler) ListAuditLogs(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 200 {
		limit = 50
	}
	offset := (page - 1) * limit

	q := h.db.Model(&model.AuditLog{})
	if action := c.Query("action"); action != "" {
		q = q.Where("action = ?", action)
	}
	if search := c.Query("search"); search != "" {
		like := "%" + search + "%"
		q = q.Where("admin_user LIKE ? OR target LIKE ? OR detail LIKE ?", like, like, like)
	}

	var total int64
	q.Count(&total)

	var logs []model.AuditLog
	if err := q.Order("created_at desc").Offset(offset).Limit(limit).Find(&logs).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	var actions []string
	h.db.Model(&model.AuditLog{}).Distinct("action").Pluck("action", &actions)

	c.JSON(http.StatusOK, gin.H{"items": logs, "total": total, "page": page, "limit": limit, "actions": actions})
}

func (h *Handler) ListTunnels(c *gin.Context) {
	var tunnels []model.Tunnel
	if err := h.db.Find(&tunnels).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": tunnels})
}

func (h *Handler) TriggerIPListUpdate(c *gin.Context) {
	if !h.ipListDualEnabled {
		var nodes []model.Node
		if err := h.db.Find(&nodes).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		var exceptions []model.IPListException
		h.db.Find(&exceptions)
		sent := 0
		for _, n := range nodes {
			if h.hub != nil && h.hub.IsOnline(n.ID) {
				_ = h.hub.SendToNode(n.ID, WSMessage{Type: "update_iplist"})
				if len(exceptions) > 0 {
					payload, _ := json.Marshal(map[string]any{"exceptions": exceptions})
					_ = h.hub.SendToNode(n.ID, WSMessage{Type: "update_exceptions", Payload: payload})
				}
				sent++
			}
		}
		h.audit(c, "trigger_iplist_update", "all_nodes", fmt.Sprintf("legacy sent_to=%d nodes exceptions=%d", sent, len(exceptions)))
		c.JSON(http.StatusOK, gin.H{"sent_to": sent, "total_nodes": len(nodes)})
		return
	}

	type reqBody struct {
		Scope string `json:"scope"`
	}
	var req reqBody
	_ = c.ShouldBindJSON(&req)
	scope := normalizeIPListScope(req.Scope)
	if scope == "all" {
		scope = "all"
	}

	synced := []string{}
	if scope == "all" || scope == "domestic" {
		if _, err := h.refreshIPListArtifact("domestic"); err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "refresh domestic ip list failed: " + err.Error()})
			return
		}
		synced = append(synced, "domestic")
	}
	if scope == "all" || scope == "overseas" {
		if _, err := h.refreshIPListArtifact("overseas"); err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "refresh overseas ip list failed: " + err.Error()})
			return
		}
		synced = append(synced, "overseas")
	}

	var nodes []model.Node
	if err := h.db.Find(&nodes).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	var exceptions []model.IPListException
	h.db.Find(&exceptions)

	sent := 0
	for _, n := range nodes {
		if h.hub != nil && h.hub.IsOnline(n.ID) {
			payload, _ := json.Marshal(gin.H{"scope": scope})
			_ = h.hub.SendToNode(n.ID, WSMessage{Type: "update_iplist", Payload: payload})
			if len(exceptions) > 0 {
				payload, _ := json.Marshal(map[string]any{"exceptions": exceptions})
				_ = h.hub.SendToNode(n.ID, WSMessage{Type: "update_exceptions", Payload: payload})
			}
			sent++
		}
	}
	h.audit(c, "trigger_iplist_update", "all_nodes", fmt.Sprintf("scope=%s sent_to=%d nodes exceptions=%d", scope, sent, len(exceptions)))
	c.JSON(http.StatusOK, gin.H{"scope": scope, "synced": synced, "sent_to": sent, "total_nodes": len(nodes)})
}

func (h *Handler) IPListStatus(c *gin.Context) {
	var nodes []model.Node
	if err := h.db.Find(&nodes).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !h.ipListDualEnabled {
		type item struct {
			NodeID       string `json:"node_id"`
			Version      string `json:"version"`
			EntryCount   int    `json:"entry_count"`
			LastUpdateAt string `json:"last_update_at"`
		}
		res := make([]item, 0, len(nodes))
		for _, n := range nodes {
			ver := n.IPListVersion
			if ver == "" {
				ver = "未更新"
			}
			lastUpdate := n.CreatedAt.Format(time.RFC3339)
			if n.IPListUpdateAt != nil {
				lastUpdate = n.IPListUpdateAt.Format(time.RFC3339)
			}
			res = append(res, item{
				NodeID: n.ID, Version: ver, EntryCount: n.IPListCount, LastUpdateAt: lastUpdate,
			})
		}
		c.JSON(http.StatusOK, gin.H{"items": res})
		return
	}
	type row struct {
		NodeID               string `json:"node_id"`
		DomesticVersion      string `json:"domestic_version"`
		DomesticEntryCount   int    `json:"domestic_entry_count"`
		DomesticLastUpdateAt string `json:"domestic_last_update_at"`
		OverseasVersion      string `json:"overseas_version"`
		OverseasEntryCount   int    `json:"overseas_entry_count"`
		OverseasLastUpdateAt string `json:"overseas_last_update_at"`
	}
	items := make([]row, 0, len(nodes))
	for _, n := range nodes {
		dVer := n.DomesticIPListVersion
		if dVer == "" {
			dVer = n.IPListVersion
		}
		if dVer == "" {
			dVer = "未更新"
		}
		oVer := n.OverseasIPListVersion
		if oVer == "" {
			oVer = "未更新"
		}
		dAt := n.CreatedAt.Format(time.RFC3339)
		if n.DomesticIPListUpdateAt != nil {
			dAt = n.DomesticIPListUpdateAt.Format(time.RFC3339)
		} else if n.IPListUpdateAt != nil {
			dAt = n.IPListUpdateAt.Format(time.RFC3339)
		}
		oAt := n.CreatedAt.Format(time.RFC3339)
		if n.OverseasIPListUpdateAt != nil {
			oAt = n.OverseasIPListUpdateAt.Format(time.RFC3339)
		}
		dCount := n.DomesticIPListCount
		if dCount == 0 && n.IPListCount > 0 {
			dCount = n.IPListCount
		}
		items = append(items, row{
			NodeID:               n.ID,
			DomesticVersion:      dVer,
			DomesticEntryCount:   dCount,
			DomesticLastUpdateAt: dAt,
			OverseasVersion:      oVer,
			OverseasEntryCount:   n.OverseasIPListCount,
			OverseasLastUpdateAt: oAt,
		})
	}
	artifacts := map[string]gin.H{}
	for _, scope := range []string{"domestic", "overseas"} {
		var a model.IPListArtifact
		err := h.db.Where("scope = ?", scope).Order("created_at desc").First(&a).Error
		if err == nil {
			artifacts[scope] = gin.H{
				"version":     a.Version,
				"entry_count": a.EntryCount,
				"created_at":  a.CreatedAt.Format(time.RFC3339),
				"sha256":      a.SHA256,
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": items, "artifacts": artifacts})
}

func normalizeIPListScope(scope string) string {
	switch strings.ToLower(strings.TrimSpace(scope)) {
	case "", "all":
		return "all"
	case "domestic":
		return "domestic"
	case "overseas":
		return "overseas"
	default:
		return "domestic"
	}
}

func (h *Handler) ipListStorageDir() string {
	if strings.EqualFold(h.dbDriver, "sqlite") && strings.TrimSpace(h.dbPath) != "" {
		dp := filepath.Clean(h.dbPath)
		dataDir := filepath.Dir(dp)
		baseDir := filepath.Clean(filepath.Join(dataDir, "..", "ip-lists"))
		if filepath.IsAbs(baseDir) {
			return baseDir
		}
		if abs, err := filepath.Abs(baseDir); err == nil {
			return abs
		}
		return baseDir
	}
	return filepath.Join(".", "ip-lists")
}

func (h *Handler) refreshIPListArtifact(scope string) (*model.IPListArtifact, error) {
	scope = normalizeIPListScope(scope)
	if scope == "all" {
		return nil, fmt.Errorf("invalid scope for artifact refresh")
	}
	var src model.IPListSource
	if err := h.db.Where("scope = ?", scope).First(&src).Error; err != nil {
		return nil, err
	}
	if !src.Enabled {
		return nil, fmt.Errorf("scope %s source disabled", scope)
	}
	urls := []string{strings.TrimSpace(src.PrimaryURL), strings.TrimSpace(src.MirrorURL)}
	client := &http.Client{Timeout: time.Duration(src.MaxTimeSec) * time.Second}
	var body []byte
	var used string
	var lastErr error
	for _, u := range urls {
		if u == "" {
			continue
		}
		for i := 0; i <= src.RetryCount; i++ {
			req, _ := http.NewRequest(http.MethodGet, u, nil)
			resp, err := client.Do(req)
			if err != nil {
				lastErr = err
				continue
			}
			data, readErr := io.ReadAll(resp.Body)
			resp.Body.Close()
			if readErr != nil {
				lastErr = readErr
				continue
			}
			if resp.StatusCode < 200 || resp.StatusCode >= 300 {
				lastErr = fmt.Errorf("status=%d", resp.StatusCode)
				continue
			}
			body = data
			used = u
			break
		}
		if len(body) > 0 {
			break
		}
	}
	if len(body) == 0 {
		if lastErr == nil {
			lastErr = fmt.Errorf("no source available")
		}
		return nil, lastErr
	}
	lines := strings.Split(strings.ReplaceAll(string(body), "\r\n", "\n"), "\n")
	filtered := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		filtered = append(filtered, line)
	}
	if len(filtered) == 0 {
		return nil, fmt.Errorf("empty ip list")
	}
	content := []byte(strings.Join(filtered, "\n") + "\n")
	hash := fmt.Sprintf("%x", sha256.Sum256(content))
	version := time.Now().Format("20060102-150405")
	storeDir := h.ipListStorageDir()
	if err := os.MkdirAll(storeDir, 0o755); err != nil {
		return nil, err
	}
	filename := fmt.Sprintf("%s-%s.txt", scope, version)
	path := filepath.Join(storeDir, filename)
	if err := os.WriteFile(path, content, 0o644); err != nil {
		return nil, err
	}
	artifact := &model.IPListArtifact{
		Scope:      scope,
		Version:    version,
		EntryCount: len(filtered),
		SHA256:     hash,
		FilePath:   path,
		SourceURL:  used,
	}
	if err := h.db.Create(artifact).Error; err != nil {
		return nil, err
	}
	return artifact, nil
}

func (h *Handler) ListIPListSources(c *gin.Context) {
	if !h.ipListDualEnabled {
		c.JSON(http.StatusNotFound, gin.H{"error": "ip-list source api disabled"})
		return
	}
	var items []model.IPListSource
	if err := h.db.Order("id asc").Find(&items).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

func (h *Handler) PatchIPListSource(c *gin.Context) {
	if !h.ipListDualEnabled {
		c.JSON(http.StatusNotFound, gin.H{"error": "ip-list source api disabled"})
		return
	}
	scope := normalizeIPListScope(c.Param("scope"))
	if scope == "all" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid scope"})
		return
	}
	var req struct {
		PrimaryURL        *string `json:"primary_url"`
		MirrorURL         *string `json:"mirror_url"`
		ConnectTimeoutSec *int    `json:"connect_timeout_sec"`
		MaxTimeSec        *int    `json:"max_time_sec"`
		RetryCount        *int    `json:"retry_count"`
		Enabled           *bool   `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var item model.IPListSource
	if err := h.db.Where("scope = ?", scope).First(&item).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "source not found"})
		return
	}
	if req.PrimaryURL != nil {
		item.PrimaryURL = strings.TrimSpace(*req.PrimaryURL)
	}
	if req.MirrorURL != nil {
		item.MirrorURL = strings.TrimSpace(*req.MirrorURL)
	}
	if req.ConnectTimeoutSec != nil && *req.ConnectTimeoutSec > 0 {
		item.ConnectTimeoutSec = *req.ConnectTimeoutSec
	}
	if req.MaxTimeSec != nil && *req.MaxTimeSec > 0 {
		item.MaxTimeSec = *req.MaxTimeSec
	}
	if req.RetryCount != nil && *req.RetryCount >= 0 {
		item.RetryCount = *req.RetryCount
	}
	if req.Enabled != nil {
		item.Enabled = *req.Enabled
	}
	if err := h.db.Save(&item).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"item": item})
}

func (h *Handler) DownloadIPList(c *gin.Context) {
	if !h.ipListDualEnabled {
		c.JSON(http.StatusNotFound, gin.H{"error": "ip-list download api disabled"})
		return
	}
	scope := normalizeIPListScope(c.Param("scope"))
	if scope == "all" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid scope"})
		return
	}
	version := strings.TrimSpace(c.Query("version"))
	var artifact model.IPListArtifact
	q := h.db.Where("scope = ?", scope).Order("created_at desc")
	if version != "" {
		q = h.db.Where("scope = ? AND version = ?", scope, version).Order("created_at desc")
	}
	if err := q.First(&artifact).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "artifact not found"})
		return
	}
	if _, err := os.Stat(artifact.FilePath); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "artifact file missing"})
		return
	}
	c.Header("X-IPList-Scope", artifact.Scope)
	c.Header("X-IPList-Version", artifact.Version)
	c.Header("X-IPList-SHA256", artifact.SHA256)
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filepath.Base(artifact.FilePath)))
	c.File(artifact.FilePath)
}

type createGrantReq struct {
	InstanceID uint `json:"instance_id" binding:"required"`
}

// finalizeUserGrantCert 在 user_grants 行已存在后，触发节点签发或写入占位 OVPN。
func (h *Handler) finalizeUserGrantCert(grant *model.UserGrant, node model.Node, inst model.Instance, certCN string) {
	proto := service.NormalizeInstanceProto(inst.Proto)
	// #region debug session 892464
	online := h.hub != nil && h.hub.IsOnline(node.ID)
	debuglog.Line("H1", "handlers.go:finalizeUserGrantCert", "issue_cert plan", map[string]any{
		"node_id": inst.NodeID, "inst_mode": inst.Mode, "inst_proto": inst.Proto, "norm_proto": proto, "hub_online": online,
	})
	// #endregion
	if h.hub != nil && h.hub.IsOnline(node.ID) {
		payload, err := json.Marshal(map[string]any{
			"cert_cn":     certCN,
			"remote_host": node.PublicIP,
			"port":        inst.Port,
			"proto":       proto,
			"mode":        inst.Mode,
		})
		if err != nil {
			log.Printf("issue_cert marshal failed: grant=%d cert_cn=%s node=%s instance=%d err=%v", grant.ID, certCN, node.ID, inst.ID, err)
			log.Printf("issue_cert payload: %v", err)
			return
		}
		log.Printf("issue_cert dispatch: grant=%d cert_cn=%s node=%s instance=%d status_before=%s hub_online=true proto=%s", grant.ID, certCN, node.ID, inst.ID, grant.CertStatus, proto)
		if err := h.hub.SendToNode(node.ID, WSMessage{Type: "issue_cert", Payload: payload}); err != nil {
			log.Printf("issue_cert dispatch failed: grant=%d cert_cn=%s node=%s instance=%d err=%v", grant.ID, certCN, node.ID, inst.ID, err)
			log.Printf("issue_cert send to node %s: %v (授权仍为待签发，可稍后点「重试签发」)", node.ID, err)
			return
		}
		return
	}
	tcpPh := service.BuildClientOVPN(node.PublicIP, inst.Port, certCN, "tcp")
	udpPh := service.BuildClientOVPN(node.PublicIP, inst.Port, certCN, "udp")
	grant.OvpnTCP = tcpPh
	grant.OvpnUDP = udpPh
	if proto == "tcp" {
		grant.OVPNContent = tcpPh
	} else {
		grant.OVPNContent = udpPh
	}
	grant.CertStatus = "placeholder"
	if err := h.db.Save(grant).Error; err != nil {
		log.Printf("issue_cert fallback save failed: grant=%d cert_cn=%s node=%s instance=%d status_after=placeholder err=%v", grant.ID, certCN, node.ID, inst.ID, err)
		return
	}
	log.Printf("issue_cert fallback placeholder: grant=%d cert_cn=%s node=%s instance=%d status_after=placeholder hub_online=false", grant.ID, certCN, node.ID, inst.ID)
}

func (h *Handler) CreateUserGrant(c *gin.Context) {
	userID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user id"})
		return
	}

	var req createGrantReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var user model.User
	if err := h.db.First(&user, uint(userID)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}

	var inst model.Instance
	if err := h.db.First(&inst, req.InstanceID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "instance not found"})
		return
	}

	var node model.Node
	if err := h.db.First(&node, "id = ?", inst.NodeID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "node not found"})
		return
	}

	certCN := fmt.Sprintf("%s-%s-%s", user.Username, node.ID, inst.Mode)

	var existing model.UserGrant
	err = h.db.Where("user_id = ? AND instance_id = ?", user.ID, inst.ID).First(&existing).Error
	if err == nil {
		switch existing.CertStatus {
		case "revoked", "failed":
			existing.CertCN = certCN
			existing.CertStatus = "pending"
			existing.OVPNContent = nil
			existing.OvpnTCP = nil
			existing.OvpnUDP = nil
			if err := h.db.Save(&existing).Error; err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			h.finalizeUserGrantCert(&existing, node, inst, certCN)
			h.audit(c, "grant_reissue", fmt.Sprintf("user:%s", user.Username), fmt.Sprintf("instance=%d cert_cn=%s", inst.ID, certCN))
			c.JSON(http.StatusOK, gin.H{"grant": existing, "reissued": true})
			return
		default:
			c.JSON(http.StatusConflict, gin.H{
				"error": "该用户对此 VPN 实例已有授权（待签发或有效），无需重复添加；若仅需重新下载请使用列表中的「下载」",
			})
			return
		}
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	grant := model.UserGrant{
		UserID:     user.ID,
		InstanceID: inst.ID,
		CertCN:     certCN,
		CertStatus: "pending",
	}
	if err := h.db.Create(&grant).Error; err != nil {
		msg := err.Error()
		if strings.Contains(msg, "UNIQUE constraint failed") && strings.Contains(msg, "cert_cn") {
			msg = "证书 CN 与已有记录冲突（可能曾用不同节点名创建过授权）。请删除或吊销旧记录后再试。"
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": msg})
		return
	}

	h.finalizeUserGrantCert(&grant, node, inst, certCN)

	h.audit(c, "grant_access", fmt.Sprintf("user:%s", user.Username), fmt.Sprintf("instance=%d cert_cn=%s", inst.ID, certCN))
	c.JSON(http.StatusCreated, gin.H{"grant": grant})
}

func (h *Handler) ListUserGrants(c *gin.Context) {
	userID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user id"})
		return
	}
	var grants []model.UserGrant
	if err := h.db.Where("user_id = ?", uint(userID)).Find(&grants).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": grants})
}

func (h *Handler) DownloadGrantOVPN(c *gin.Context) {
	grantID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid grant id"})
		return
	}

	if tokenQ := c.Query("token"); tokenQ != "" {
		token, parseErr := jwt.Parse(tokenQ, func(t *jwt.Token) (interface{}, error) {
			return []byte(h.jwtSecret), nil
		})
		if parseErr != nil || !token.Valid {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
			return
		}
	}

	var grant model.UserGrant
	if err := h.db.First(&grant, uint(grantID)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "grant not found"})
		return
	}
	var inst model.Instance
	if err := h.db.First(&inst, grant.InstanceID).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "instance not found"})
		return
	}
	protoQ := c.Query("proto")
	data, err := service.GrantOVPNForDownload(&grant, inst.Proto, protoQ)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "配置未就绪或该协议暂无文件，请确认已签发成功"})
		return
	}
	suffix := ""
	if p := service.NormalizeDownloadProtoQuery(protoQ); p != "" {
		suffix = "-" + p
	}
	filename := fmt.Sprintf("%s%s.ovpn", grant.CertCN, suffix)
	c.Header("Content-Type", "application/x-openvpn-profile")
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	c.Data(http.StatusOK, "application/x-openvpn-profile", service.SanitizeClientOVPNProfile(data))
}

func (h *Handler) RevokeGrant(c *gin.Context) {
	grantID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid grant id"})
		return
	}
	var grant model.UserGrant
	if err := h.db.First(&grant, uint(grantID)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "grant not found"})
		return
	}
	grant.CertStatus = "revoking"
	if err := h.db.Save(&grant).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	var inst model.Instance
	if h.db.First(&inst, grant.InstanceID).Error == nil {
		if h.hub != nil && h.hub.IsOnline(inst.NodeID) {
			payload, _ := json.Marshal(map[string]any{"cert_cn": grant.CertCN})
			_ = h.hub.SendToNode(inst.NodeID, WSMessage{Type: "revoke_cert", Payload: payload})
		} else {
			grant.CertStatus = "revoked"
			h.db.Save(&grant)
		}
	}

	h.audit(c, "revoke_grant", fmt.Sprintf("grant:%d", grant.ID), fmt.Sprintf("cert_cn=%s", grant.CertCN))
	c.JSON(http.StatusOK, gin.H{"grant": grant})
}

// PurgeGrant 永久删除授权记录（用于已吊销等历史行仍占用 cert_cn 唯一约束时清理）。
// 若证书仍为 active，必须先吊销再删除，避免节点侧仍有效的客户端证书与审计不一致。
func (h *Handler) PurgeGrant(c *gin.Context) {
	grantID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid grant id"})
		return
	}
	var grant model.UserGrant
	if err := h.db.First(&grant, uint(grantID)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "grant not found"})
		return
	}
	if grant.CertStatus == "active" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请先吊销该授权，再删除记录"})
		return
	}
	if err := h.db.Delete(&grant).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.audit(c, "purge_grant", fmt.Sprintf("grant:%d", grantID), fmt.Sprintf("cert_cn=%s", grant.CertCN))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// RetryIssueGrant 对待签发或签发失败的授权再次向节点下发 issue_cert（修复 WS 下发丢失、agent 未回传等导致的长时间「待签发」）。
func (h *Handler) RetryIssueGrant(c *gin.Context) {
	grantID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid grant id"})
		return
	}
	var grant model.UserGrant
	if err := h.db.First(&grant, uint(grantID)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "grant not found"})
		return
	}
	if grant.CertStatus != "pending" && grant.CertStatus != "failed" && grant.CertStatus != "placeholder" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "仅「待签发」「占位配置」或「签发失败」的授权可重试"})
		return
	}

	var user model.User
	if err := h.db.First(&user, grant.UserID).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "user not found"})
		return
	}
	var inst model.Instance
	if err := h.db.First(&inst, grant.InstanceID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "instance not found"})
		return
	}
	var node model.Node
	if err := h.db.First(&node, "id = ?", inst.NodeID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "node not found"})
		return
	}

	certCN := fmt.Sprintf("%s-%s-%s", user.Username, node.ID, inst.Mode)
	if grant.CertCN != certCN {
		grant.CertCN = certCN
	}
	statusBefore := grant.CertStatus
	grant.CertStatus = "pending"
	grant.OVPNContent = nil
	grant.OvpnTCP = nil
	grant.OvpnUDP = nil
	if err := h.db.Save(&grant).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	log.Printf("retry_issue_cert reset: grant=%d cert_cn=%s node=%s instance=%d status_before=%s status_after=pending", grant.ID, certCN, node.ID, inst.ID, statusBefore)

	if h.hub == nil || !h.hub.IsOnline(node.ID) {
		log.Printf("retry_issue_cert blocked offline: grant=%d cert_cn=%s node=%s instance=%d", grant.ID, certCN, node.ID, inst.ID)
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "节点 Agent 未连接控制面，无法下发签发；请确认 vpn-agent 与 WebSocket 正常"})
		return
	}
	proto := service.NormalizeInstanceProto(inst.Proto)
	payload, err := json.Marshal(map[string]any{
		"cert_cn":     certCN,
		"remote_host": node.PublicIP,
		"port":        inst.Port,
		"proto":       proto,
		"mode":        inst.Mode,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	log.Printf("retry_issue_cert dispatch: grant=%d cert_cn=%s node=%s instance=%d status_before=pending hub_online=true proto=%s", grant.ID, certCN, node.ID, inst.ID, proto)
	if err := h.hub.SendToNode(node.ID, WSMessage{Type: "issue_cert", Payload: payload}); err != nil {
		log.Printf("retry_issue_cert dispatch failed: grant=%d cert_cn=%s node=%s instance=%d err=%v", grant.ID, certCN, node.ID, inst.ID, err)
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error()})
		return
	}
	h.audit(c, "retry_issue_cert", fmt.Sprintf("grant:%d", grant.ID), certCN)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) broadcastExceptions() {
	if h.hub == nil {
		return
	}
	var exceptions []model.IPListException
	h.db.Find(&exceptions)
	payload, _ := json.Marshal(map[string]any{"exceptions": exceptions})
	var nodes []model.Node
	h.db.Find(&nodes)
	for _, n := range nodes {
		if h.hub.IsOnline(n.ID) {
			_ = h.hub.SendToNode(n.ID, WSMessage{Type: "update_exceptions", Payload: payload})
		}
	}
}

type deleteNodePasswordReq struct {
	Password string `json:"password" binding:"required"`
}

// DeleteNodeWithPassword 删除节点前校验当前登录管理员密码，防止误删。
func (h *Handler) DeleteNodeWithPassword(c *gin.Context) {
	id := c.Param("id")
	username, _ := c.Get("admin")
	usernameStr, _ := username.(string)
	var admin model.Admin
	if err := h.db.Where("username = ?", usernameStr).First(&admin).Error; err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "admin not found"})
		return
	}
	var req deleteNodePasswordReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(admin.PasswordHash), []byte(req.Password)); err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "invalid password"})
		return
	}
	h.deleteNode(c, id)
}

func (h *Handler) deleteNode(c *gin.Context, id string) {
	var node model.Node
	if err := h.db.Where("id = ?", id).First(&node).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "node not found"})
		return
	}

	var instanceIDs []uint
	h.db.Model(&model.Instance{}).Where("node_id = ?", id).Pluck("id", &instanceIDs)
	if len(instanceIDs) > 0 {
		// 物理删除授权行，避免仅吊销仍占用 cert_cn 唯一约束；节点重建后同一用户+实例模式才能重新授权
		h.db.Where("instance_id IN ?", instanceIDs).Delete(&model.UserGrant{})
	}

	var tunnelIDs []uint
	h.db.Model(&model.Tunnel{}).Where("node_a = ? OR node_b = ?", id, id).Pluck("id", &tunnelIDs)
	if len(tunnelIDs) > 0 {
		h.db.Where("tunnel_id IN ?", tunnelIDs).Delete(&model.TunnelMetric{})
	}

	h.db.Where("node_id = ?", id).Delete(&model.ConfigVersion{})
	h.db.Where("node_id = ?", id).Delete(&model.NodeSegment{})
	h.db.Where("node_id = ?", id).Delete(&model.Instance{})
	h.db.Where("node_id = ?", id).Delete(&model.NodeBootstrapToken{})
	h.db.Where("node_a = ? OR node_b = ?", id, id).Delete(&model.Tunnel{})
	h.db.Delete(&node)
	h.audit(c, "delete_node", fmt.Sprintf("node:%s", id), fmt.Sprintf("instances=%d cleaned_tunnels=%d", len(instanceIDs), len(tunnelIDs)))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) GetUser(c *gin.Context) {
	userID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user id"})
		return
	}
	var user model.User
	if err := h.db.First(&user, uint(userID)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	var grants []model.UserGrant
	h.db.Where("user_id = ?", user.ID).Find(&grants)
	c.JSON(http.StatusOK, gin.H{"user": user, "grants": grants})
}

type updateUserReq struct {
	DisplayName *string `json:"display_name"`
	GroupName   *string `json:"group_name"`
	Status      *string `json:"status"`
}

func (h *Handler) UpdateUser(c *gin.Context) {
	userID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user id"})
		return
	}
	var user model.User
	if err := h.db.First(&user, uint(userID)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	var req updateUserReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.DisplayName != nil {
		user.DisplayName = *req.DisplayName
	}
	if req.GroupName != nil {
		user.GroupName = *req.GroupName
	}
	if req.Status != nil {
		user.Status = *req.Status
	}
	h.db.Save(&user)
	h.audit(c, "update_user", fmt.Sprintf("user:%s", user.Username), "")
	c.JSON(http.StatusOK, gin.H{"user": user})
}

func (h *Handler) DeleteUser(c *gin.Context) {
	userID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user id"})
		return
	}
	var user model.User
	if err := h.db.First(&user, uint(userID)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	var grants []model.UserGrant
	h.db.Where("user_id = ?", user.ID).Find(&grants)
	for _, g := range grants {
		if g.CertStatus == "active" || g.CertStatus == "placeholder" {
			g.CertStatus = "revoked"
			h.db.Save(&g)
		}
	}
	h.db.Delete(&user)
	h.audit(c, "delete_user", fmt.Sprintf("user:%s", user.Username), fmt.Sprintf("revoked %d grants", len(grants)))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) ListNodeInstances(c *gin.Context) {
	nodeID := c.Param("id")
	var instances []model.Instance
	h.db.Where("node_id = ?", nodeID).Find(&instances)
	c.JSON(http.StatusOK, gin.H{"items": instances})
}

type createInstanceReq struct {
	SegmentID string `json:"segment_id"`
	Mode      string `json:"mode" binding:"required"`
	Port      int    `json:"port" binding:"required"`
	Proto     string `json:"proto"` // udp | tcp，默认 udp
	Subnet    string `json:"subnet" binding:"required"`
	ExitNode  string `json:"exit_node"`
}

func (h *Handler) CreateInstance(c *gin.Context) {
	nodeID := c.Param("id")
	var node model.Node
	if err := h.db.Where("id = ?", nodeID).First(&node).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "node not found"})
		return
	}
	var req createInstanceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	segID := strings.TrimSpace(req.SegmentID)
	if segID == "" {
		var err error
		segID, err = firstSegmentIDForNode(h.db, nodeID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "node has no network segment; bind a segment first"})
			return
		}
	}
	var nsCount int64
	h.db.Model(&model.NodeSegment{}).Where("node_id = ? AND segment_id = ?", nodeID, segID).Count(&nsCount)
	if nsCount == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "node is not a member of this segment"})
		return
	}
	exitTrim := strings.TrimSpace(req.ExitNode)
	if instanceModeUsesExitPeer(req.Mode) && exitTrim != "" && !h.tunnelConnectsPeers(nodeID, exitTrim) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "exit_node 须为本节点「相关隧道」中的对端节点 ID"})
		return
	}
	inst := model.Instance{
		NodeID: nodeID, SegmentID: segID, Mode: req.Mode, Port: req.Port,
		Proto: service.NormalizeInstanceProto(req.Proto), Subnet: req.Subnet, ExitNode: exitTrim, Enabled: true,
	}
	if err := h.db.Create(&inst).Error; err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	h.db.Model(&model.Node{}).Where("id = ?", nodeID).UpdateColumn("config_version", gorm.Expr("config_version + ?", 1))
	h.pushInstancesConfigToNode(nodeID)
	h.audit(c, "create_instance", fmt.Sprintf("node:%s", nodeID), fmt.Sprintf("mode=%s port=%d", req.Mode, req.Port))
	c.JSON(http.StatusCreated, gin.H{"instance": inst})
}

type patchInstanceReq struct {
	Enabled  *bool   `json:"enabled"`
	Subnet   *string `json:"subnet"`
	Port     *int    `json:"port"`
	Proto    *string `json:"proto"` // udp | tcp
	ExitNode *string `json:"exit_node"`
}

func instanceModeUsesExitPeer(mode string) bool {
	switch mode {
	case "local-only", "hk-smart-split", "hk-global", "us-global":
		return true
	default:
		return false
	}
}

// tunnelConnectsPeers 是否存在一条隧道，两端分别为 nodeID 与 peerID。
func (h *Handler) tunnelConnectsPeers(nodeID, peerID string) bool {
	if peerID == "" {
		return false
	}
	var n int64
	h.db.Model(&model.Tunnel{}).
		Where("(node_a = ? AND node_b = ?) OR (node_a = ? AND node_b = ?)", nodeID, peerID, peerID, nodeID).
		Count(&n)
	return n > 0
}

func (h *Handler) PatchInstance(c *gin.Context) {
	instID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid instance id"})
		return
	}
	var inst model.Instance
	if err := h.db.First(&inst, uint(instID)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "instance not found"})
		return
	}
	var req patchInstanceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Enabled == nil && req.Subnet == nil && req.Port == nil && req.Proto == nil && req.ExitNode == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no fields to update"})
		return
	}
	changed := false
	if req.Enabled != nil {
		inst.Enabled = *req.Enabled
		changed = true
	}
	if req.Subnet != nil {
		s := strings.TrimSpace(*req.Subnet)
		if s != "" {
			if _, _, err := net.ParseCIDR(s); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid subnet CIDR: %v", err)})
				return
			}
			conflict, err := service.InstanceSubnetConflictsOthers(h.db, inst.ID, s)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			if conflict != "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "subnet conflict: " + conflict})
				return
			}
			inst.Subnet = s
			changed = true
		}
	}
	if req.Port != nil && *req.Port > 0 {
		inst.Port = *req.Port
		changed = true
	}
	if req.Proto != nil {
		p := strings.TrimSpace(*req.Proto)
		if p != "" {
			inst.Proto = service.NormalizeInstanceProto(p)
			changed = true
		}
	}
	if req.ExitNode != nil {
		v := strings.TrimSpace(*req.ExitNode)
		if instanceModeUsesExitPeer(inst.Mode) {
			if v != "" && !h.tunnelConnectsPeers(inst.NodeID, v) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "exit_node 须为本节点「相关隧道」中的对端节点 ID"})
				return
			}
			if inst.ExitNode != v {
				inst.ExitNode = v
				changed = true
			}
		}
	}
	if !changed {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no changes applied"})
		return
	}
	if err := h.db.Save(&inst).Error; err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	h.db.Model(&model.Node{}).Where("id = ?", inst.NodeID).UpdateColumn("config_version", gorm.Expr("config_version + ?", 1))
	h.pushInstancesConfigToNode(inst.NodeID)
	detail := fmt.Sprintf("enabled=%v subnet=%s port=%d proto=%s exit_node=%s", inst.Enabled, inst.Subnet, inst.Port, inst.Proto, inst.ExitNode)
	h.audit(c, "patch_instance", fmt.Sprintf("instance:%d", inst.ID), detail)
	c.JSON(http.StatusOK, gin.H{"instance": inst})
}

// pushInstancesConfigToNode sends the current DB instances snapshot to an online agent (last-config.json + OpenVPN apply on node).
func (h *Handler) pushInstancesConfigToNode(nodeID string) {
	if h.hub == nil || !h.hub.IsOnline(nodeID) {
		return
	}
	var insts []model.Instance
	if err := h.db.Where("node_id = ?", nodeID).Order("id asc").Find(&insts).Error; err != nil {
		log.Printf("push instances config: list instances for %s: %v", nodeID, err)
		return
	}
	payload, err := json.Marshal(gin.H{"instances": insts})
	if err != nil {
		return
	}
	if err := h.hub.SendToNode(nodeID, WSMessage{Type: "update_config", Payload: payload}); err != nil {
		log.Printf("push instances config to %s: %v", nodeID, err)
	}
}

func (h *Handler) GetNodeStatus(c *gin.Context) {
	id := c.Param("id")
	var node model.Node
	if err := h.db.Where("id = ?", id).First(&node).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "node not found"})
		return
	}
	var tunnels []model.Tunnel
	h.db.Where("node_a = ? OR node_b = ?", id, id).Find(&tunnels)
	c.JSON(http.StatusOK, gin.H{
		"node_id":       node.ID,
		"status":        node.Status,
		"online_users":  node.OnlineUsers,
		"agent_version": node.AgentVersion,
		"tunnels":       tunnels,
	})
}

func (h *Handler) RefreshNodeWG(c *gin.Context) {
	nodeID := strings.TrimSpace(c.Param("id"))
	if nodeID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing node id"})
		return
	}
	if !nodeSupportsCapability(h.db, nodeID, "wg_refresh_v1") {
		c.JSON(http.StatusPreconditionFailed, gin.H{"error": "agent does not support wg_refresh_v1"})
		return
	}
	if h.hub == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "ws hub unavailable"})
		return
	}

	lock := h.nodeRefreshLock(nodeID)
	lock.Lock()
	defer lock.Unlock()

	var node model.Node
	if err := h.db.Where("id = ?", nodeID).First(&node).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "node not found"})
		return
	}
	tunnelConfigs, _ := service.BuildTunnelConfigsForNode(h.db, nodeID)
	if tunnelConfigs == nil {
		tunnelConfigs = []service.TunnelPeerConfig{}
	}
	listenPort := 0
	invalid := 0
	for _, tc := range tunnelConfigs {
		if tc.ConfigValid && strings.TrimSpace(tc.PeerPubKey) != "" && tc.WGPort > 0 {
			listenPort = tc.WGPort
			break
		}
		if !tc.ConfigValid {
			invalid++
		}
	}
	payload, _ := json.Marshal(gin.H{
		"node_id":     nodeID,
		"listen_port": listenPort,
		"tunnels":     tunnelConfigs,
	})
	if err := h.hub.SendToNode(nodeID, WSMessage{Type: "update_wg_config", Payload: payload}); err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "node offline or ws send failed"})
		return
	}
	h.audit(c, "wg_refresh", fmt.Sprintf("node:%s", nodeID), fmt.Sprintf("total=%d invalid=%d", len(tunnelConfigs), invalid))
	c.JSON(http.StatusAccepted, gin.H{
		"ok":           true,
		"node_id":      nodeID,
		"total_tunnel": len(tunnelConfigs),
		"invalid":      invalid,
	})
}

func (h *Handler) GetNodeStateConsistency(c *gin.Context) {
	var nodes []model.Node
	if err := h.db.Find(&nodes).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	connected := map[string]bool{}
	if h.hub != nil {
		for _, id := range h.hub.ConnectedNodeIDs() {
			connected[id] = true
		}
	}
	items := make([]gin.H, 0, len(nodes))
	mismatch := 0
	for _, n := range nodes {
		wsOnline := connected[n.ID]
		dbOnline := strings.TrimSpace(strings.ToLower(n.Status)) == "online"
		inconsistent := dbOnline != wsOnline
		if inconsistent {
			mismatch++
		}
		items = append(items, gin.H{
			"node_id":       n.ID,
			"db_status":     n.Status,
			"ws_online":     wsOnline,
			"inconsistent":  inconsistent,
			"agent_version": n.AgentVersion,
		})
	}
	c.JSON(http.StatusOK, gin.H{
		"total":      len(items),
		"mismatch":   mismatch,
		"consistent": mismatch == 0,
		"items":      items,
	})
}

func (h *Handler) GetTunnelMetrics(c *gin.Context) {
	tunnelID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid tunnel id"})
		return
	}
	var metrics []model.TunnelMetric
	h.db.Where("tunnel_id = ?", uint(tunnelID)).Order("created_at desc").Limit(100).Find(&metrics)
	c.JSON(http.StatusOK, gin.H{"items": metrics})
}

func (h *Handler) ListExceptions(c *gin.Context) {
	var items []model.IPListException
	if err := h.db.Order("created_at desc").Find(&items).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

type createExceptionReq struct {
	CIDR      string `json:"cidr"`
	Domain    string `json:"domain"`
	Direction string `json:"direction" binding:"required"`
	Note      string `json:"note"`
}

func (h *Handler) CreateException(c *gin.Context) {
	var req createExceptionReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	item := model.IPListException{CIDR: req.CIDR, Domain: req.Domain, Direction: req.Direction, Note: req.Note}
	if err := h.db.Create(&item).Error; err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	h.audit(c, "create_exception", fmt.Sprintf("cidr=%s domain=%s", req.CIDR, req.Domain), req.Direction)
	h.broadcastExceptions()
	c.JSON(http.StatusCreated, gin.H{"item": item})
}

func (h *Handler) DeleteException(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	if err := h.db.Delete(&model.IPListException{}, uint(id)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	h.audit(c, "delete_exception", fmt.Sprintf("exception:%d", id), "")
	h.broadcastExceptions()
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) AgentRegister(c *gin.Context) {
	token := c.GetHeader("X-Node-Token")
	if token == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing X-Node-Token"})
		return
	}

	var bt model.NodeBootstrapToken
	if err := h.db.Where("token = ?", token).First(&bt).Error; err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid node token"})
		return
	}
	if bt.Used {
		c.JSON(http.StatusForbidden, gin.H{
			"error": "bootstrap token already used; use POST /api/nodes/{id}/rotate-bootstrap-token (admin) to issue a new token before reinstalling",
		})
		return
	}

	var node model.Node
	if err := h.db.Where("id = ?", bt.NodeID).First(&node).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "node not found"})
		return
	}
	var instances []model.Instance
	_ = h.db.Where("node_id = ?", node.ID).Find(&instances).Error

	now := time.Now()
	bt.Used = true
	bt.UsedAt = &now
	_ = h.db.Save(&bt).Error

	// Do not set node.Status here. Real online/offline should be driven by
	// websocket lifecycle (connect/heartbeat/disconnect) in ws_hub.
	node.ConfigVersion++
	node.AgentVersion = "bootstrap"
	_ = h.db.Save(&node).Error

	tunnelConfigs, _ := service.BuildTunnelConfigsForNode(h.db, node.ID)
	if tunnelConfigs == nil {
		tunnelConfigs = []service.TunnelPeerConfig{}
	}
	for _, tc := range tunnelConfigs {
		if tc.ConfigValid {
			continue
		}
		_ = h.db.Model(&model.Tunnel{}).
			Where("(node_a = ? AND node_b = ?) OR (node_a = ? AND node_b = ?)",
				node.ID, tc.PeerNodeID, tc.PeerNodeID, node.ID).
			Updates(map[string]any{
				"status":               "invalid_config",
				"status_reason":        tc.ConfigError,
				"status_updated_at":    time.Now(),
				"consecutive_failures": gorm.Expr("COALESCE(consecutive_failures, 0) + 1"),
			}).Error
	}

	resp := gin.H{
		"node_id":      node.ID,
		"node_number":  node.NodeNumber,
		"public_ip":    node.PublicIP,
		"instances":    instances,
		"tunnels":      tunnelConfigs,
		"bootstrap_at": now.Unix(),
	}
	if h.ca != nil {
		if bundle, err := h.ca.Bundle(); err == nil {
			resp["ca_bundle"] = bundle
		}
	}
	c.JSON(http.StatusOK, resp)
}

type agentReportReq struct {
	Status       string `json:"status"`
	AgentVersion string `json:"agent_version"`
	WGPublicKey  string `json:"wg_pubkey"`
}

func (h *Handler) AgentReport(c *gin.Context) {
	token := c.GetHeader("X-Node-Token")
	if token == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing X-Node-Token"})
		return
	}

	var bt model.NodeBootstrapToken
	if err := h.db.Where("token = ?", token).First(&bt).Error; err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid node token"})
		return
	}

	var node model.Node
	if err := h.db.Where("id = ?", bt.NodeID).First(&node).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "node not found"})
		return
	}

	var req agentReportReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if req.Status != "" {
		node.Status = req.Status
	}
	if req.AgentVersion != "" {
		node.AgentVersion = req.AgentVersion
	}
	if req.WGPublicKey != "" {
		node.WGPublicKey = req.WGPublicKey
	}
	if err := h.db.Save(&node).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) BroadcastToAdmins(eventType string, data any) {
	if h.adminWS != nil {
		h.adminWS.Broadcast(eventType, data)
	}
}

func (h *Handler) PrometheusMetrics(c *gin.Context) {
	var nodeCount, userCount, tunnelCount, grantCount int64
	h.db.Model(&model.Node{}).Count(&nodeCount)
	h.db.Model(&model.User{}).Count(&userCount)
	h.db.Model(&model.Tunnel{}).Count(&tunnelCount)
	h.db.Model(&model.UserGrant{}).Count(&grantCount)

	var onlineNodes int64
	h.db.Model(&model.Node{}).Where("status = ?", "online").Count(&onlineNodes)

	var totalOnlineUsers int
	var nodes []model.Node
	h.db.Find(&nodes)
	for _, n := range nodes {
		totalOnlineUsers += n.OnlineUsers
	}

	out := fmt.Sprintf("vpn_nodes_total %d\nvpn_nodes_online %d\nvpn_users_total %d\nvpn_tunnels_total %d\nvpn_grants_total %d\nvpn_online_users %d\n",
		nodeCount, onlineNodes, userCount, tunnelCount, grantCount, totalOnlineUsers)
	c.Data(http.StatusOK, "text/plain; charset=utf-8", []byte(out))
}

func (h *Handler) ListConfigVersions(c *gin.Context) {
	nodeID := c.Query("node_id")
	q := h.db.Order("created_at desc").Limit(50)
	if nodeID != "" {
		q = q.Where("node_id = ?", nodeID)
	}
	var versions []model.ConfigVersion
	q.Find(&versions)
	c.JSON(http.StatusOK, gin.H{"items": versions})
}

func (h *Handler) RollbackConfig(c *gin.Context) {
	versionID, err := strconv.ParseUint(c.Param("version"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid version id"})
		return
	}
	var ver model.ConfigVersion
	if err := h.db.First(&ver, uint(versionID)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "version not found"})
		return
	}
	if h.hub != nil && h.hub.IsOnline(ver.NodeID) {
		payload, _ := json.Marshal(map[string]any{"config": ver.Snapshot})
		_ = h.hub.SendToNode(ver.NodeID, WSMessage{Type: "update_config", Payload: payload})
	}
	h.audit(c, "rollback_config", fmt.Sprintf("node:%s version:%d", ver.NodeID, ver.ID), ver.Comment)
	c.JSON(http.StatusOK, gin.H{"ok": true, "version": ver})
}

func (h *Handler) ListAdmins(c *gin.Context) {
	var admins []model.Admin
	h.db.Find(&admins)
	c.JSON(http.StatusOK, gin.H{"items": admins})
}

type createAdminReq struct {
	Username    string `json:"username" binding:"required"`
	Password    string `json:"password" binding:"required"`
	Role        string `json:"role"`
	Permissions string `json:"permissions"`
}

func (h *Handler) CreateAdmin(c *gin.Context) {
	role, _ := c.Get("role")
	if role != "admin" {
		c.JSON(http.StatusForbidden, gin.H{"error": "only admin can manage admins"})
		return
	}
	var req createAdminReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Role == "" {
		req.Role = "operator"
	}
	if req.Permissions == "" {
		if req.Role == "admin" {
			req.Permissions = "*"
		} else if req.Role == "viewer" {
			req.Permissions = "nodes,users,tunnels,audit"
		} else {
			req.Permissions = "nodes,users,rules,tunnels,audit"
		}
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	admin := model.Admin{Username: req.Username, PasswordHash: string(hash), Role: req.Role, Permissions: req.Permissions}
	if err := h.db.Create(&admin).Error; err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	h.audit(c, "create_admin", fmt.Sprintf("admin:%s", req.Username), fmt.Sprintf("role=%s perms=%s", req.Role, req.Permissions))
	c.JSON(http.StatusCreated, gin.H{"admin": admin})
}

type updateAdminReq struct {
	Role        *string `json:"role"`
	Permissions *string `json:"permissions"`
}

func (h *Handler) UpdateAdmin(c *gin.Context) {
	callerRole, _ := c.Get("role")
	if callerRole != "admin" {
		c.JSON(http.StatusForbidden, gin.H{"error": "only admin can manage admins"})
		return
	}
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	var admin model.Admin
	if err := h.db.First(&admin, uint(id)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "admin not found"})
		return
	}
	var req updateAdminReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Role != nil {
		admin.Role = *req.Role
	}
	if req.Permissions != nil {
		admin.Permissions = *req.Permissions
	}
	h.db.Save(&admin)
	h.audit(c, "update_admin", fmt.Sprintf("admin:%s", admin.Username), fmt.Sprintf("role=%s perms=%s", admin.Role, admin.Permissions))
	c.JSON(http.StatusOK, gin.H{"admin": admin})
}

type resetPasswordReq struct {
	NewPassword string `json:"new_password" binding:"required"`
}

func (h *Handler) ResetAdminPassword(c *gin.Context) {
	callerRole, _ := c.Get("role")
	if callerRole != "admin" {
		c.JSON(http.StatusForbidden, gin.H{"error": "only admin can reset passwords"})
		return
	}
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	var admin model.Admin
	if err := h.db.First(&admin, uint(id)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "admin not found"})
		return
	}
	var req resetPasswordReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(req.NewPassword) < 6 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "password must be at least 6 characters"})
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	admin.PasswordHash = string(hash)
	h.db.Save(&admin)
	h.audit(c, "reset_admin_password", fmt.Sprintf("admin:%s", admin.Username), "by super admin")
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) DeleteAdmin(c *gin.Context) {
	role, _ := c.Get("role")
	if role != "admin" {
		c.JSON(http.StatusForbidden, gin.H{"error": "only admin can manage admins"})
		return
	}
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	var admin model.Admin
	if err := h.db.First(&admin, uint(id)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "admin not found"})
		return
	}
	if admin.Username == "admin" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot delete default admin"})
		return
	}
	h.db.Delete(&admin)
	h.audit(c, "delete_admin", fmt.Sprintf("admin:%s", admin.Username), "")
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) SelfServiceLookup(c *gin.Context) {
	username := c.Query("username")
	if username == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "username is required"})
		return
	}
	var user model.User
	if err := h.db.Where("username = ?", username).First(&user).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	var grants []model.UserGrant
	h.db.Where("user_id = ?", user.ID).Find(&grants)
	c.JSON(http.StatusOK, gin.H{"user": user, "grants": grants})
}

func (h *Handler) SelfServiceDownload(c *gin.Context) {
	grantID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid grant id"})
		return
	}
	username := c.Query("username")
	if username == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "username is required"})
		return
	}
	var grant model.UserGrant
	if err := h.db.First(&grant, uint(grantID)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "grant not found"})
		return
	}
	var user model.User
	if err := h.db.First(&user, grant.UserID).Error; err != nil || user.Username != username {
		c.JSON(http.StatusForbidden, gin.H{"error": "access denied"})
		return
	}
	var inst model.Instance
	if err := h.db.First(&inst, grant.InstanceID).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "instance not found"})
		return
	}
	protoQ := c.Query("proto")
	data, err := service.GrantOVPNForDownload(&grant, inst.Proto, protoQ)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "配置未就绪或该协议暂无文件，请确认已签发成功"})
		return
	}
	suffix := ""
	if p := service.NormalizeDownloadProtoQuery(protoQ); p != "" {
		suffix = "-" + p
	}
	filename := fmt.Sprintf("%s%s.ovpn", grant.CertCN, suffix)
	c.Header("Content-Type", "application/x-openvpn-profile")
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	c.Data(http.StatusOK, "application/x-openvpn-profile", service.SanitizeClientOVPNProfile(data))
}

// resolveVPNAgentPath finds a vpn-agent binary to serve to nodes.
// Search order: VPN_AGENT_LINUX_* → VPN_AGENT_BIN_DIR → sqlite DB sibling …/bin (from DB_PATH) → {parent of caDir}/bin → cwd …/bin → next to vpn-api → /usr/local/bin → vpn-agent fallback.
func resolveVPNAgentPath(requestArch string, caDir string, dbPath string, dbDriver string) (string, error) {
	if requestArch != "amd64" && requestArch != "arm64" {
		return "", fmt.Errorf("unsupported architecture")
	}
	name := "vpn-agent-linux-" + requestArch
	tryFile := func(p string) (string, bool) {
		p = filepath.Clean(p)
		fi, err := os.Stat(p)
		if err != nil || fi.IsDir() || fi.Size() == 0 {
			return "", false
		}
		return p, true
	}
	if requestArch == "amd64" {
		if p := strings.TrimSpace(os.Getenv("VPN_AGENT_LINUX_AMD64")); p != "" {
			if path, ok := tryFile(p); ok {
				return path, nil
			}
		}
	} else {
		if p := strings.TrimSpace(os.Getenv("VPN_AGENT_LINUX_ARM64")); p != "" {
			if path, ok := tryFile(p); ok {
				return path, nil
			}
		}
	}
	if d := strings.TrimSpace(os.Getenv("VPN_AGENT_BIN_DIR")); d != "" {
		if path, ok := tryFile(filepath.Join(d, name)); ok {
			return path, nil
		}
	}
	// 与 deploy-control-plane 约定一致：DB_PATH=…/data/vpn.db → …/bin/vpn-agent-linux-*（相对 DB_PATH 用 Abs 解析，避免 WorkingDirectory 与路径不一致）
	if strings.EqualFold(dbDriver, "sqlite") && strings.TrimSpace(dbPath) != "" {
		dp := filepath.Clean(dbPath)
		dataDir := filepath.Dir(dp)
		cand := filepath.Clean(filepath.Join(dataDir, "..", "bin", name))
		if !filepath.IsAbs(cand) {
			if abs, err := filepath.Abs(cand); err == nil {
				cand = abs
			}
		}
		if path, ok := tryFile(cand); ok {
			return path, nil
		}
	}
	if caDir != "" {
		parent := filepath.Dir(filepath.Clean(caDir))
		if path, ok := tryFile(filepath.Join(parent, "bin", name)); ok {
			return path, nil
		}
	}
	if wd, err := os.Getwd(); err == nil {
		wd = filepath.Clean(wd)
		for _, p := range []string{
			filepath.Join(wd, "bin", name),
			filepath.Join(wd, "..", "bin", name),
		} {
			if path, ok := tryFile(p); ok {
				return path, nil
			}
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	dir := filepath.Dir(exe)
	candidates := []string{
		filepath.Join(dir, name),
		filepath.Join("/usr/local/bin", name),
	}
	for _, p := range candidates {
		if path, ok := tryFile(p); ok {
			return path, nil
		}
	}
	if runtime.GOARCH == requestArch {
		for _, p := range []string{
			filepath.Join(dir, "vpn-agent"),
			"/usr/local/bin/vpn-agent",
		} {
			if path, ok := tryFile(p); ok {
				return path, nil
			}
		}
	}
	return "", os.ErrNotExist
}

func resolveVPNAgentPathByVersion(requestArch, version, caDir, dbPath, dbDriver string) (string, error) {
	version = strings.TrimSpace(strings.TrimPrefix(version, "v"))
	if version == "" {
		return resolveVPNAgentPath(requestArch, caDir, dbPath, dbDriver)
	}
	if requestArch != "amd64" && requestArch != "arm64" {
		return "", fmt.Errorf("unsupported architecture")
	}
	tryFile := func(p string) (string, bool) {
		p = filepath.Clean(p)
		fi, err := os.Stat(p)
		if err != nil || fi.IsDir() || fi.Size() == 0 {
			return "", false
		}
		return p, true
	}
	nameCandidates := []string{
		fmt.Sprintf("vpn-agent-linux-%s-%s", requestArch, version),
		fmt.Sprintf("vpn-agent-%s-linux-%s", version, requestArch),
		fmt.Sprintf("vpn-agent-%s-%s", version, requestArch),
	}
	dirCandidates := []string{}
	if d := strings.TrimSpace(os.Getenv("VPN_AGENT_BIN_DIR")); d != "" {
		dirCandidates = append(dirCandidates, d)
	}
	if strings.EqualFold(dbDriver, "sqlite") && strings.TrimSpace(dbPath) != "" {
		dp := filepath.Clean(dbPath)
		dataDir := filepath.Dir(dp)
		dirCandidates = append(dirCandidates, filepath.Clean(filepath.Join(dataDir, "..", "bin")))
	}
	if caDir != "" {
		parent := filepath.Dir(filepath.Clean(caDir))
		dirCandidates = append(dirCandidates, filepath.Join(parent, "bin"))
	}
	if wd, err := os.Getwd(); err == nil {
		wd = filepath.Clean(wd)
		dirCandidates = append(dirCandidates, filepath.Join(wd, "bin"), filepath.Join(wd, "..", "bin"))
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		dirCandidates = append(dirCandidates, dir, "/usr/local/bin")
	}
	for _, d := range dirCandidates {
		for _, n := range nameCandidates {
			if p, ok := tryFile(filepath.Join(d, n)); ok {
				return p, nil
			}
		}
	}
	// Fallback to non-versioned latest entrypoint for compatibility.
	return resolveVPNAgentPath(requestArch, caDir, dbPath, dbDriver)
}

// ServeVPNAgentLinuxAMD64 / ServeVPNAgentLinuxARM64 serve the node agent (no auth; used by node-setup.sh).
func (h *Handler) ServeVPNAgentLinuxAMD64(c *gin.Context) { h.serveVPNAgentDownload(c, "amd64") }
func (h *Handler) ServeVPNAgentLinuxARM64(c *gin.Context) { h.serveVPNAgentDownload(c, "arm64") }
func (h *Handler) ServeVPNAgentVersionedDownload(c *gin.Context) {
	seg1 := strings.TrimSpace(c.Param("seg1"))
	seg2 := strings.TrimSpace(c.Param("seg2"))
	seg1Lower := strings.ToLower(seg1)

	var arch, version string
	if seg1Lower == "amd64" || seg1Lower == "arm64" {
		arch = seg1Lower
		pkg := ""
		switch {
		case strings.Contains(seg2, "+"):
			parts := strings.SplitN(seg2, "+", 2)
			pkg = strings.TrimSpace(parts[0])
			version = strings.TrimSpace(parts[1])
		case strings.HasPrefix(seg2, DefaultAgentDownloadPackage+"-"):
			// 兼容写法：/api/downloads/vpn-agent/{arch}/vpn-agent-{version}
			pkg = DefaultAgentDownloadPackage
			version = strings.TrimSpace(strings.TrimPrefix(seg2, DefaultAgentDownloadPackage+"-"))
		default:
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid download path: expected {package}+{version} or {package}-{version} after architecture"})
			return
		}
		if pkg == "" || version == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid download path: empty package or version"})
			return
		}
		if pkg != DefaultAgentDownloadPackage {
			c.JSON(http.StatusNotFound, gin.H{"error": "unknown agent package: " + pkg})
			return
		}
	} else {
		// Legacy: /api/downloads/vpn-agent/{version}/{arch}
		version = seg1
		arch = strings.ToLower(seg2)
	}
	path, err := resolveVPNAgentPathByVersion(arch, version, h.caDir, h.dbPath, h.dbDriver)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "vpn-agent binary not available for this architecture/version"})
		return
	}
	c.Header("Content-Type", "application/octet-stream")
	c.Header("Content-Disposition", `attachment; filename="vpn-agent"`)
	c.File(path)
}

func (h *Handler) serveVPNAgentDownload(c *gin.Context, arch string) {
	path, err := resolveVPNAgentPath(arch, h.caDir, h.dbPath, h.dbDriver)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "vpn-agent binary not available for this architecture; place vpn-agent-linux-" + arch + " next to vpn-api or use matching GOARCH build"})
		return
	}
	c.Header("Content-Type", "application/octet-stream")
	c.Header("Content-Disposition", `attachment; filename="vpn-agent"`)
	c.File(path)
}

// normalizeShellScriptForUnix strips UTF-8 BOM and CRLF so curl|bash on Linux does not see
// invalid set options (e.g. "pipefail\r" → 无效的选项名).
func normalizeShellScriptForUnix(data []byte) []byte {
	if len(data) >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF {
		data = data[3:]
	}
	data = bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
	data = bytes.ReplaceAll(data, []byte("\r"), []byte("\n"))
	return data
}

func (h *Handler) ServeNodeSetupScript(c *gin.Context) {
	candidates := make([]string, 0, 8)
	seen := make(map[string]struct{}, 8)
	addCandidate := func(p string) {
		p = strings.TrimSpace(p)
		if p == "" {
			return
		}
		clean := filepath.Clean(p)
		if _, ok := seen[clean]; ok {
			return
		}
		seen[clean] = struct{}{}
		candidates = append(candidates, clean)
	}

	// Highest priority: explicit path from service environment.
	addCandidate(os.Getenv("NODE_SETUP_SCRIPT_PATH"))
	// Infer from DB_PATH (e.g. …/data/vpn.db → …/scripts/ and …/vpn-api/scripts/) when systemd omits NODE_SETUP_SCRIPT_PATH.
	if dp := strings.TrimSpace(h.dbPath); dp != "" {
		dataDir := filepath.Dir(filepath.Clean(dp))
		root := filepath.Clean(filepath.Join(dataDir, ".."))
		addCandidate(filepath.Join(root, "scripts", "node-setup.sh"))
		addCandidate(filepath.Join(root, "vpn-api", "scripts", "node-setup.sh"))
	}
	// Common deployment locations on production hosts.
	addCandidate("/opt/vpn-api/scripts/node-setup.sh")
	addCandidate("/opt/vpn-api/vpn-api/scripts/node-setup.sh")
	addCandidate("/home/vpn-server/vpn-api/scripts/node-setup.sh")
	// Backward-compatible relative and executable-neighbor lookups.
	addCandidate("scripts/node-setup.sh")
	addCandidate("../scripts/node-setup.sh")
	exeDir := filepath.Dir(os.Args[0])
	addCandidate(filepath.Join(exeDir, "scripts", "node-setup.sh"))
	addCandidate(filepath.Join(exeDir, "..", "scripts", "node-setup.sh"))

	tried := make([]string, 0, len(candidates))
	for _, p := range candidates {
		tried = append(tried, p)
		if data, err := os.ReadFile(p); err == nil {
			data = normalizeShellScriptForUnix(data)
			c.Header("Content-Disposition", "attachment; filename=\"node-setup.sh\"")
			c.Data(http.StatusOK, "text/x-shellscript; charset=utf-8", data)
			return
		}
	}
	cwd, _ := os.Getwd()
	log.Printf("[node-setup] node-setup.sh not found; NODE_SETUP_SCRIPT_PATH=%q cwd=%q exe=%q tried=%v",
		strings.TrimSpace(os.Getenv("NODE_SETUP_SCRIPT_PATH")), cwd, os.Args[0], tried)
	c.JSON(http.StatusNotFound, gin.H{"error": "node-setup.sh not found on server"})
}
