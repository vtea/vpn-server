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
	"regexp"
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
	"vpn-api/internal/middleware"
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
	adminStr := adminClaimString(admin)
	if adminStr == "" {
		adminStr = "system"
	}
	rec := model.AuditLog{
		AdminUser: adminStr,
		Action:    action,
		Target:    target,
		Detail:    detail,
	}
	if err := h.db.Create(&rec).Error; err != nil {
		log.Printf("audit persist failed action=%s target=%s: %v", action, target, err)
	}
}

func (h *Handler) auditSystem(action, target, detail string) {
	rec := model.AuditLog{
		AdminUser: "system",
		Action:    action,
		Target:    target,
		Detail:    detail,
	}
	if err := h.db.Create(&rec).Error; err != nil {
		log.Printf("auditSystem persist failed action=%s target=%s: %v", action, target, err)
	}
}

// abortJSONIfDBFirstErr 将 gorm First/Take 错误映射为 404（无行）或 500（其它数据库错误），避免锁库等故障误报「未找到」。
func abortJSONIfDBFirstErr(c *gin.Context, err error, notFoundMsg string) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": notFoundMsg})
		return true
	}
	c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
	return true
}

// buildWireGuardRefreshPayload 生成与「刷新WG」一致的 update_wg_config JSON body。
func buildWireGuardRefreshPayload(db *gorm.DB, nodeID string) (payload []byte, invalid, total int, err error) {
	tunnelConfigs, err := service.BuildTunnelConfigsForNode(db, nodeID)
	if err != nil {
		return nil, 0, 0, err
	}
	if tunnelConfigs == nil {
		tunnelConfigs = []service.TunnelPeerConfig{}
	}
	listenPort := 0
	invalid = 0
	for _, tc := range tunnelConfigs {
		if tc.ConfigValid && strings.TrimSpace(tc.PeerPubKey) != "" && tc.WGPort > 0 {
			listenPort = tc.WGPort
			break
		}
		if !tc.ConfigValid {
			invalid++
		}
	}
	payload, err = json.Marshal(gin.H{
		"node_id":     nodeID,
		"listen_port": listenPort,
		"tunnels":     tunnelConfigs,
	})
	total = len(tunnelConfigs)
	return payload, invalid, total, err
}

// PushWireGuardRefreshToOnlineNode 在库变更后主动向在线 agent 下发 WG 快照（需 wg_refresh_v1）。
func (h *Handler) PushWireGuardRefreshToOnlineNode(nodeID, reason string) {
	nodeID = strings.TrimSpace(nodeID)
	if nodeID == "" || h.hub == nil {
		return
	}
	if !nodeSupportsCapability(h.db, nodeID, "wg_refresh_v1") {
		log.Printf("auto wg_refresh skipped node=%s: no wg_refresh_v1 (%s)", nodeID, reason)
		return
	}
	if !h.hub.IsOnline(nodeID) {
		log.Printf("auto wg_refresh skipped node=%s: websocket offline (%s)", nodeID, reason)
		return
	}
	lock := h.nodeRefreshLock(nodeID)
	lock.Lock()
	defer lock.Unlock()
	var node model.Node
	if err := h.db.Where("id = ?", nodeID).First(&node).Error; err != nil {
		return
	}
	payload, invalid, total, err := buildWireGuardRefreshPayload(h.db, nodeID)
	if err != nil {
		log.Printf("auto wg_refresh marshal node=%s: %v (%s)", nodeID, err, reason)
		return
	}
	if err := h.hub.SendToNode(nodeID, WSMessage{Type: "update_wg_config", Payload: payload}); err != nil {
		log.Printf("auto wg_refresh send node=%s: %v (%s)", nodeID, err, reason)
		return
	}
	log.Printf("auto wg_refresh ok node=%s tunnels=%d invalid=%d (%s)", nodeID, total, invalid, reason)
	h.auditSystem("wg_refresh_auto", fmt.Sprintf("node:%s", nodeID), fmt.Sprintf("%s total=%d invalid=%d", reason, total, invalid))
}

func (h *Handler) pushWireGuardRefreshToOnlineNodes(nodeIDs []string, reason string) {
	seen := make(map[string]struct{})
	for _, raw := range nodeIDs {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		h.PushWireGuardRefreshToOnlineNode(id, reason)
	}
}

// pushWireGuardRefreshForInstanceMesh 在实例创建或影响分流/子网的补丁后，刷新本节点及隧道对端的 WG 快照。
// 否则策略路由已指向 wg-*，但 AllowedIPs 仍缺 0.0.0.0/0 时，经出口中继的公网流量无法在入口侧选路封装。
func (h *Handler) pushWireGuardRefreshForInstanceMesh(nodeID string, reason string) {
	nodeID = strings.TrimSpace(nodeID)
	if nodeID == "" {
		return
	}
	ids := append([]string{nodeID}, service.MeshNeighborNodeIDs(h.db, nodeID)...)
	h.pushWireGuardRefreshToOnlineNodes(ids, reason)
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

	admin, err := h.firstAdminByUsernameCI(req.Username)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
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

	adminPayload := gin.H{
		"id":          admin.ID,
		"username":    admin.Username,
		"role":        admin.Role,
		"permissions": admin.Permissions,
		"created_at":  admin.CreatedAt,
	}
	if sc, err := h.adminScopeForUsername(admin.Username); err == nil && sc != nil {
		for k, v := range sc.ScopeJSON() {
			adminPayload[k] = v
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"token": token,
		"admin": adminPayload,
	})
}

func (h *Handler) GetCurrentAdmin(c *gin.Context) {
	username, _ := c.Get("admin")
	admin, err := h.firstAdminByUsernameCI(adminClaimString(username))
	if err != nil {
		respondAdminScopeLoadError(c, err)
		return
	}
	payload := gin.H{
		"id":          admin.ID,
		"username":    admin.Username,
		"role":        admin.Role,
		"permissions": admin.Permissions,
		"created_at":  admin.CreatedAt,
	}
	if sc, err := h.adminScopeForUsername(admin.Username); err == nil && sc != nil {
		for k, v := range sc.ScopeJSON() {
			payload[k] = v
		}
	}
	c.JSON(http.StatusOK, gin.H{"admin": payload})
}

type changePasswordReq struct {
	OldPassword string `json:"old_password" binding:"required"`
	NewPassword string `json:"new_password" binding:"required"`
}

func (h *Handler) ChangePassword(c *gin.Context) {
	username, _ := c.Get("admin")

	var req changePasswordReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(req.NewPassword) < 6 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "password must be at least 6 characters"})
		return
	}

	admin, err := h.firstAdminByUsernameCI(adminClaimString(username))
	if err != nil {
		respondAdminScopeLoadError(c, err)
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
	if err := h.db.Save(admin).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
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

func normalizeNodePublicHost(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", fmt.Errorf("public_ip cannot be empty")
	}
	if strings.Contains(s, "://") || strings.ContainsAny(s, "/\\?#@") {
		return "", fmt.Errorf("public_ip must be a valid IPv4/IPv6 address or domain")
	}
	if ip := net.ParseIP(s); ip != nil {
		return s, nil
	}
	if len(s) > 253 || strings.HasPrefix(s, ".") || strings.HasSuffix(s, ".") || strings.Contains(s, "..") {
		return "", fmt.Errorf("public_ip must be a valid IPv4/IPv6 address or domain")
	}
	labels := strings.Split(s, ".")
	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 {
			return "", fmt.Errorf("public_ip must be a valid IPv4/IPv6 address or domain")
		}
		if strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return "", fmt.Errorf("public_ip must be a valid IPv4/IPv6 address or domain")
		}
		for _, r := range label {
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' {
				continue
			}
			return "", fmt.Errorf("public_ip must be a valid IPv4/IPv6 address or domain")
		}
	}
	return s, nil
}

func (h *Handler) CreateNode(c *gin.Context) {
	if _, ok := h.ensureUnrestrictedAdmin(c); !ok {
		return
	}
	var req createNodeReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	publicHost, err := normalizeNodePublicHost(req.PublicIP)
	if err != nil {
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
			PublicIP:   publicHost,
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

	var wgPushPeers []string
	for _, t := range tunnels {
		if t.NodeA == node.ID && t.NodeB != "" {
			wgPushPeers = append(wgPushPeers, t.NodeB)
		} else if t.NodeB == node.ID && t.NodeA != "" {
			wgPushPeers = append(wgPushPeers, t.NodeA)
		}
	}
	h.pushWireGuardRefreshToOnlineNodes(wgPushPeers, "create_node new_peer "+node.ID)

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
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	q := h.db.Model(&model.Node{})
	if !h.scopeEffectiveUnrestricted(c, scope) {
		if len(scope.AllowedNodeIDs) == 0 {
			c.JSON(http.StatusOK, gin.H{"items": []gin.H{}})
			return
		}
		q = q.Where("id IN ?", scope.AllowedNodeIDs)
	}
	var nodes []model.Node
	if err := q.Find(&nodes).Error; err != nil {
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
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	id := c.Param("id")
	var node model.Node
	if abortJSONIfDBFirstErr(c, h.db.Where("id = ?", id).First(&node).Error, "node not found") {
		return
	}
	if !h.ensureNodeAllowed(c, scope, node.ID) {
		return
	}
	var instances []model.Instance
	if err := h.db.Where("node_id = ?", node.ID).Find(&instances).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	var tunnels []model.Tunnel
	if err := h.db.Where("node_a = ? OR node_b = ?", id, id).Find(&tunnels).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
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
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	id := c.Param("id")
	var node model.Node
	if abortJSONIfDBFirstErr(c, h.db.Where("id = ?", id).First(&node).Error, "node not found") {
		return
	}
	if !h.ensureNodeAllowed(c, scope, node.ID) {
		return
	}
	prevPublicIP := strings.TrimSpace(node.PublicIP)
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
		if s != "" {
			var err error
			s, err = normalizeNodePublicHost(s)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
				return
			}
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
	if req.PublicIP != nil && prevPublicIP != strings.TrimSpace(node.PublicIP) {
		h.pushWireGuardRefreshToOnlineNodes(service.MeshNeighborNodeIDs(h.db, id), "patch_node_public_ip "+id)
	}
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
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	id := c.Param("id")
	var node model.Node
	if abortJSONIfDBFirstErr(c, h.db.Where("id = ?", id).First(&node).Error, "node not found") {
		return
	}
	if !h.ensureNodeAllowed(c, scope, node.ID) {
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
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	tid, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid tunnel id"})
		return
	}
	var tun model.Tunnel
	if abortJSONIfDBFirstErr(c, h.db.First(&tun, uint(tid)).Error, "tunnel not found") {
		return
	}
	if !h.scopeEffectiveUnrestricted(c, scope) && (!scope.AllowsNode(tun.NodeA) || !scope.AllowsNode(tun.NodeB)) {
		c.JSON(http.StatusForbidden, gin.H{"error": "no permission for this tunnel"})
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
		if err := h.db.Model(&model.Node{}).Where("id = ?", nid).UpdateColumn("config_version", gorm.Expr("config_version + ?", 1)).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	h.audit(c, "patch_tunnel", fmt.Sprintf("tunnel:%d", tun.ID), fmt.Sprintf("subnet=%s ip_a=%s ip_b=%s wg_port=%d", tun.Subnet, tun.IPA, tun.IPB, tun.WGPort))
	h.pushWireGuardRefreshToOnlineNodes([]string{tun.NodeA, tun.NodeB}, fmt.Sprintf("patch_tunnel:%d", tun.ID))
	c.JSON(http.StatusOK, gin.H{"tunnel": tun})
}

type createUserReq struct {
	Username    string `json:"username" binding:"required"`
	DisplayName string `json:"display_name"`
	GroupName   string `json:"group_name"`
}

// firstVPNUserByUsernameCI 按 VPN 用户名查找（trim + 忽略大小写）。SQLite 下 uniqueIndex 对大小写敏感，创建前需显式查重。
func (h *Handler) firstVPNUserByUsernameCI(username string) (*model.User, error) {
	u := strings.TrimSpace(username)
	if u == "" {
		return nil, gorm.ErrRecordNotFound
	}
	var user model.User
	if err := h.db.Where("LOWER(TRIM(username)) = LOWER(?)", u).First(&user).Error; err != nil {
		return nil, err
	}
	return &user, nil
}

func (h *Handler) CreateUser(c *gin.Context) {
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	var req createUserReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请求体须为 JSON，且包含必填字段 username（VPN 用户名）", "detail": err.Error()})
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请填写 VPN 用户名（username）"})
		return
	}

	// 超级管理员：可创建任意 VPN 用户。非超管：仅允许创建与当前管理员登录名一致的 VPN 用户（自助建档，便于后续在本账号下签发证书）。
	unrestricted := h.scopeEffectiveUnrestricted(c, scope)
	if !unrestricted {
		if !strings.EqualFold(req.Username, strings.TrimSpace(scope.Admin.Username)) {
			c.JSON(http.StatusForbidden, gin.H{
				"error": "非超级管理员仅可创建与当前登录名一致的 VPN 用户",
				"code":  "create_user_self_username_only",
			})
			return
		}
		// 与 admins 表规范一致，避免 SQLite 下写入与登录名仅大小写不同的字符串导致列表/授权语义分裂。
		req.Username = strings.TrimSpace(scope.Admin.Username)
	}

	if _, err := h.firstVPNUserByUsernameCI(req.Username); err == nil {
		if !unrestricted {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "该登录名对应的 VPN 用户已在系统中，无需再次添加；请在「授权管理」列表中找到该用户并点击「授权」进行证书签发。",
				"code":  "username_exists_self_only",
			})
		} else {
			c.JSON(http.StatusBadRequest, gin.H{"error": "该 VPN 用户名已存在，请换一个名称，或在列表中编辑已有用户", "code": "username_exists"})
		}
		return
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	u := model.User{Username: req.Username, DisplayName: req.DisplayName, GroupName: req.GroupName, Status: "active"}
	if u.GroupName == "" {
		u.GroupName = "default"
	}
	if err := h.db.Create(&u).Error; err != nil {
		em := err.Error()
		if strings.Contains(strings.ToLower(em), "unique") || strings.Contains(strings.ToLower(em), "duplicate") {
			if !unrestricted {
				c.JSON(http.StatusBadRequest, gin.H{
					"error": "该登录名对应的 VPN 用户已在系统中，无需再次添加；请在「授权管理」列表中找到该用户并点击「授权」进行证书签发。",
					"code":  "username_exists_self_only",
				})
			} else {
				c.JSON(http.StatusBadRequest, gin.H{"error": "该 VPN 用户名已存在（数据库唯一约束）", "code": "username_exists"})
			}
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": em})
		return
	}
	h.audit(c, "create_user", fmt.Sprintf("user:%s", u.Username), fmt.Sprintf("group=%s", u.GroupName))
	c.JSON(http.StatusCreated, gin.H{"user": u})
}

// ensureVPNUserVisibleToScopedAdmin 受限管理员仅能访问列表中出现的 VPN 用户；不可见时返回 403 及 code，便于前端区分「不存在」与「存在但不在可见范围」。
// 与 CreateUser 等一致：JWT 声明为超管时也视为全量可见（避免库表与 Token 不一致时接口行为分裂）。
func (h *Handler) ensureVPNUserVisibleToScopedAdmin(c *gin.Context, scope *AdminScope, userID uint) bool {
	if h.scopeEffectiveUnrestricted(c, scope) {
		return true
	}
	vis, err := h.userVisibleToScopedList(scope, userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return false
	}
	if !vis {
		c.JSON(http.StatusForbidden, gin.H{
			"error": "该用户不在当前账号的可见范围内（与授权管理列表一致）",
			"code":  "user_not_in_scope",
		})
		return false
	}
	return true
}

// userListItemJSON 用户列表单项（与 model.User 序列化字段一致，并统一附带 cross_scope_edit_blocked）。
func userListItemJSON(u model.User, crossScopeEditBlocked bool) gin.H {
	return gin.H{
		"id":                       u.ID,
		"username":                 u.Username,
		"display_name":             u.DisplayName,
		"group_name":               u.GroupName,
		"status":                   u.Status,
		"created_at":               u.CreatedAt,
		"cross_scope_edit_blocked": crossScopeEditBlocked,
	}
}

func (h *Handler) ListUsers(c *gin.Context) {
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	unrestricted := h.scopeEffectiveUnrestricted(c, scope)

	var users []model.User
	if err := h.db.Order("username ASC").Find(&users).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	var blocked map[uint]struct{}
	if !unrestricted {
		blockedIDs, err := h.userIDsWithCrossScopeEditBlocked(scope)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		blocked = blockedIDs
		adminName := strings.TrimSpace(scope.Admin.Username)
		filtered := make([]model.User, 0, 1)
		for _, u := range users {
			if strings.EqualFold(strings.TrimSpace(u.Username), adminName) {
				filtered = append(filtered, u)
			}
		}
		users = filtered
	}
	items := make([]gin.H, 0, len(users))
	for _, u := range users {
		flag := false
		if !unrestricted {
			_, flag = blocked[u.ID]
		}
		items = append(items, userListItemJSON(u, flag))
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

// GetDashboardStats 仪表盘用户数字段：users_total 为库中用户总数；users_visible 为当前账号在授权管理列表中可见的数量（超管二者相同）。
func (h *Handler) GetDashboardStats(c *gin.Context) {
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	var usersTotal int64
	if err := h.db.Model(&model.User{}).Count(&usersTotal).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if h.scopeEffectiveUnrestricted(c, scope) {
		c.JSON(http.StatusOK, gin.H{
			"users_total":   usersTotal,
			"users_visible": usersTotal,
		})
		return
	}
	adminName := strings.TrimSpace(scope.Admin.Username)
	var usersVisible int64
	if adminName != "" {
		if err := h.db.Model(&model.User{}).
			Where("LOWER(TRIM(username)) = LOWER(?)", adminName).
			Count(&usersVisible).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"users_total":   usersTotal,
		"users_visible": usersVisible,
	})
}

// GetDashboardOnlineOverview 仪表盘：各在线节点上报的在线用户之和，及在线节点上仍处于 active 的授权行（用于弹窗列表）。
func (h *Handler) GetDashboardOnlineOverview(c *gin.Context) {
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	empty := gin.H{"online_users_sum": 0, "grants": []gin.H{}, "note": ""}

	if !h.scopeEffectiveUnrestricted(c, scope) && len(scope.AllowedNodeIDs) == 0 {
		empty["note"] = "当前账号未分配可管理节点。"
		c.JSON(http.StatusOK, empty)
		return
	}

	qSum := h.db.Model(&model.Node{}).Where("status = ?", "online")
	if !h.scopeEffectiveUnrestricted(c, scope) {
		qSum = qSum.Where("id IN ?", scope.AllowedNodeIDs)
	}
	var onlineUsersSum int64
	row := qSum.Select("COALESCE(SUM(online_users), 0)").Row()
	if err := row.Scan(&onlineUsersSum); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	type scanRow struct {
		GrantID         uint   `gorm:"column:grant_id"`
		CertCN          string `gorm:"column:cert_cn"`
		UserID          uint   `gorm:"column:user_id"`
		Username        string `gorm:"column:username"`
		DisplayName     string `gorm:"column:display_name"`
		InstanceID      uint   `gorm:"column:instance_id"`
		Mode            string `gorm:"column:mode"`
		Proto           string `gorm:"column:proto"`
		Port            int    `gorm:"column:port"`
		NodeID          string `gorm:"column:node_id"`
		NodeName        string `gorm:"column:node_name"`
		NodeOnlineUsers int    `gorm:"column:node_online_users"`
	}

	q := h.db.Table("user_grants").
		Select(`user_grants.id AS grant_id, user_grants.cert_cn AS cert_cn, user_grants.user_id AS user_id,
			users.username AS username, users.display_name AS display_name,
			instances.id AS instance_id, instances.mode AS mode, instances.proto AS proto, instances.port AS port,
			nodes.id AS node_id, nodes.name AS node_name, nodes.online_users AS node_online_users`).
		Joins("JOIN instances ON instances.id = user_grants.instance_id").
		Joins("JOIN nodes ON nodes.id = instances.node_id").
		Joins("JOIN users ON users.id = user_grants.user_id").
		Where("user_grants.cert_status = ?", "active").
		Where("nodes.status = ?", "online")

	if !h.scopeEffectiveUnrestricted(c, scope) {
		q = q.Where("instances.node_id IN ?", scope.AllowedNodeIDs)
		adminName := strings.TrimSpace(scope.Admin.Username)
		if adminName == "" {
			c.JSON(http.StatusOK, gin.H{
				"online_users_sum": onlineUsersSum,
				"grants":           []gin.H{},
				"note":             "当前账号用户名为空，无法列出授权。",
			})
			return
		}
		q = q.Where("LOWER(TRIM(users.username)) = LOWER(?)", adminName)
	}

	var rows []scanRow
	if err := q.Order("users.username ASC, user_grants.id ASC").Scan(&rows).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	items := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		items = append(items, gin.H{
			"grant_id":          r.GrantID,
			"cert_cn":           r.CertCN,
			"user_id":           r.UserID,
			"username":          r.Username,
			"display_name":      r.DisplayName,
			"instance_id":       r.InstanceID,
			"mode":              r.Mode,
			"proto":             r.Proto,
			"port":              r.Port,
			"node_id":           r.NodeID,
			"node_name":         r.NodeName,
			"node_online_users": r.NodeOnlineUsers,
		})
	}

	c.JSON(http.StatusOK, gin.H{
		"online_users_sum": onlineUsersSum,
		"grants":           items,
		"note":             "在线人数由各节点 Agent 定期上报；下列为当前「在线节点」上证书仍为有效的授权（未必与实时连接一一对应）。",
	})
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
	if err := q.Count(&total).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	var logs []model.AuditLog
	if err := q.Order("created_at desc").Offset(offset).Limit(limit).Find(&logs).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	var actions []string
	if err := h.db.Model(&model.AuditLog{}).Distinct("action").Pluck("action", &actions).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"items": logs, "total": total, "page": page, "limit": limit, "actions": actions})
}

func (h *Handler) ListTunnels(c *gin.Context) {
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	q := h.db.Model(&model.Tunnel{})
	if !h.scopeEffectiveUnrestricted(c, scope) {
		if len(scope.AllowedNodeIDs) == 0 {
			c.JSON(http.StatusOK, gin.H{"items": []model.Tunnel{}})
			return
		}
		q = q.Where("node_a IN ? AND node_b IN ?", scope.AllowedNodeIDs, scope.AllowedNodeIDs)
	}
	var tunnels []model.Tunnel
	if err := q.Find(&tunnels).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": tunnels})
}

// RepairTunnelMesh 补全任意两节点之间缺失的隧道记录（全互联缺边修复），并递增受影响节点的 config_version。
func (h *Handler) RepairTunnelMesh(c *gin.Context) {
	if _, ok := h.ensureUnrestrictedAdmin(c); !ok {
		return
	}
	created, err := service.EnsureFullMeshTunnels(h.db)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	affected := make(map[string]struct{})
	for _, t := range created {
		affected[t.NodeA] = struct{}{}
		affected[t.NodeB] = struct{}{}
	}
	for nid := range affected {
		if err := h.db.Model(&model.Node{}).Where("id = ?", nid).UpdateColumn("config_version", gorm.Expr("config_version + ?", 1)).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	h.audit(c, "repair_tunnel_mesh", "tunnels", fmt.Sprintf("created=%d", len(created)))
	if len(affected) > 0 {
		ids := make([]string, 0, len(affected))
		for nid := range affected {
			ids = append(ids, nid)
		}
		h.pushWireGuardRefreshToOnlineNodes(ids, "repair_tunnel_mesh")
	}
	c.JSON(http.StatusOK, gin.H{"created_count": len(created), "items": created})
}

func (h *Handler) TriggerIPListUpdate(c *gin.Context) {
	admScope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	if !h.ipListDualEnabled {
		q := h.db.Model(&model.Node{})
		if !h.scopeEffectiveUnrestricted(c, admScope) {
			if len(admScope.AllowedNodeIDs) == 0 {
				h.audit(c, "trigger_iplist_update", "scoped", "legacy sent_to=0 (no allowed nodes)")
				c.JSON(http.StatusOK, gin.H{"sent_to": 0, "total_nodes": 0})
				return
			}
			q = q.Where("id IN ?", admScope.AllowedNodeIDs)
		}
		var nodes []model.Node
		if err := q.Find(&nodes).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		var exceptions []model.IPListException
		if err := h.db.Find(&exceptions).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		sent := 0
		for _, n := range nodes {
			if h.hub != nil && h.hub.IsOnline(n.ID) {
				if err := h.hub.SendToNode(n.ID, WSMessage{Type: "update_iplist"}); err != nil {
					log.Printf("TriggerIPListUpdate legacy: send update_iplist to %s: %v", n.ID, err)
				}
				if len(exceptions) > 0 {
					exPayload, merr := json.Marshal(map[string]any{"exceptions": exceptions})
					if merr != nil {
						log.Printf("TriggerIPListUpdate legacy: marshal exceptions: %v", merr)
					} else {
						if err := h.hub.SendToNode(n.ID, WSMessage{Type: "update_exceptions", Payload: exPayload}); err != nil {
							log.Printf("TriggerIPListUpdate legacy: send update_exceptions to %s: %v", n.ID, err)
						}
					}
				}
				sent++
			}
		}
		h.audit(c, "trigger_iplist_update", "all_nodes", fmt.Sprintf("legacy sent_to=%d nodes exceptions=%d", sent, len(exceptions)))
		legacyOffline := len(nodes) - sent
		if legacyOffline < 0 {
			legacyOffline = 0
		}
		c.JSON(http.StatusOK, gin.H{"sent_to": sent, "total_nodes": len(nodes), "offline_node_count": legacyOffline})
		return
	}

	type reqBody struct {
		Scope string `json:"scope"`
	}
	var req reqBody
	if err := c.ShouldBindJSON(&req); err != nil {
		// 空 body / 仅空白时常见为 EOF 或 json 的 unexpected end；仍按默认 scope 处理
		if !errors.Is(err, io.EOF) && !strings.Contains(err.Error(), "unexpected end of JSON input") {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	}
	listScope := normalizeIPListScope(req.Scope)
	if listScope == "all" {
		listScope = "all"
	}

	// 「全部」时仅刷新已启用的同步源；未启用则跳过（不拉取、不报错）。已启用项并行拉取，墙钟时间约 max(启用路数)。
	synced := []string{}
	if listScope == "all" {
		var domSrc, ovrSrc model.IPListSource
		if err := h.db.Where("scope = ?", "domestic").First(&domSrc).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if err := h.db.Where("scope = ?", "overseas").First(&ovrSrc).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		var domErr, ovrErr error
		var wg sync.WaitGroup
		if domSrc.Enabled {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, domErr = h.refreshIPListArtifact("domestic")
			}()
		}
		if ovrSrc.Enabled {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, ovrErr = h.refreshIPListArtifact("overseas")
			}()
		}
		wg.Wait()
		if domSrc.Enabled && domErr != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "refresh domestic ip list failed: " + domErr.Error()})
			return
		}
		if ovrSrc.Enabled && ovrErr != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "refresh overseas ip list failed: " + ovrErr.Error()})
			return
		}
		if domSrc.Enabled {
			synced = append(synced, "domestic")
		}
		if ovrSrc.Enabled {
			synced = append(synced, "overseas")
		}
		if len(synced) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "国内与海外 IP 库同步源均已关闭，无法刷新"})
			return
		}
	} else if listScope == "domestic" {
		var src model.IPListSource
		if err := h.db.Where("scope = ?", "domestic").First(&src).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if !src.Enabled {
			c.JSON(http.StatusBadRequest, gin.H{"error": "国内 IP 库同步源已关闭，无法刷新"})
			return
		}
		if _, err := h.refreshIPListArtifact("domestic"); err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "refresh domestic ip list failed: " + err.Error()})
			return
		}
		synced = append(synced, "domestic")
	} else if listScope == "overseas" {
		var src model.IPListSource
		if err := h.db.Where("scope = ?", "overseas").First(&src).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if !src.Enabled {
			c.JSON(http.StatusBadRequest, gin.H{"error": "海外 IP 库同步源已关闭，无法刷新"})
			return
		}
		if _, err := h.refreshIPListArtifact("overseas"); err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "refresh overseas ip list failed: " + err.Error()})
			return
		}
		synced = append(synced, "overseas")
	}

	effectiveScope := listScope
	if listScope == "all" {
		if len(synced) == 1 {
			effectiveScope = synced[0]
		} else {
			effectiveScope = "all"
		}
	}

	if !h.scopeEffectiveUnrestricted(c, admScope) {
		if len(admScope.AllowedNodeIDs) == 0 {
			h.audit(c, "trigger_iplist_update", "scoped", "sent_to=0 (no allowed nodes)")
			c.JSON(http.StatusOK, gin.H{
				"scope":              listScope,
				"effective_scope":    effectiveScope,
				"synced":             synced,
				"sent_to":            0,
				"total_nodes":        0,
				"offline_node_count": 0,
			})
			return
		}
	}
	var exceptionsCount int64
	if err := h.db.Model(&model.IPListException{}).Count(&exceptionsCount).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	sent, totalNodes, offlineCount, err := h.pushIPListUpdateToOnlineNodes(c, admScope, effectiveScope)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.audit(c, "trigger_iplist_update", "all_nodes", fmt.Sprintf("scope=%s effective=%s sent_to=%d nodes exceptions=%d", listScope, effectiveScope, sent, exceptionsCount))
	c.JSON(http.StatusOK, gin.H{
		"scope":              listScope,
		"effective_scope":    effectiveScope,
		"synced":             synced,
		"sent_to":            sent,
		"total_nodes":        totalNodes,
		"offline_node_count": offlineCount,
	})
}

func (h *Handler) IPListStatus(c *gin.Context) {
	admScope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	nq := h.db.Model(&model.Node{})
	if !h.scopeEffectiveUnrestricted(c, admScope) {
		if len(admScope.AllowedNodeIDs) == 0 {
			if !h.ipListDualEnabled {
				c.JSON(http.StatusOK, gin.H{"items": []any{}})
				return
			}
			c.JSON(http.StatusOK, gin.H{"items": []any{}, "artifacts": gin.H{}})
			return
		}
		nq = nq.Where("id IN ?", admScope.AllowedNodeIDs)
	}
	var nodes []model.Node
	if err := nq.Find(&nodes).Error; err != nil {
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
		NodeID                  string `json:"node_id"`
		DomesticVersion         string `json:"domestic_version"`
		DomesticEntryCount      int    `json:"domestic_entry_count"`
		DomesticLastUpdateAt    string `json:"domestic_last_update_at"`
		DomesticLastSyncError   string `json:"domestic_last_sync_error,omitempty"`
		OverseasVersion         string `json:"overseas_version"`
		OverseasEntryCount      int    `json:"overseas_entry_count"`
		OverseasLastUpdateAt    string `json:"overseas_last_update_at"`
		OverseasLastSyncError   string `json:"overseas_last_sync_error,omitempty"`
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
			NodeID:                n.ID,
			DomesticVersion:       dVer,
			DomesticEntryCount:    dCount,
			DomesticLastUpdateAt:  dAt,
			DomesticLastSyncError: strings.TrimSpace(n.DomesticIPListLastError),
			OverseasVersion:       oVer,
			OverseasEntryCount:    n.OverseasIPListCount,
			OverseasLastUpdateAt:  oAt,
			OverseasLastSyncError: strings.TrimSpace(n.OverseasIPListLastError),
		})
	}
	artifacts := map[string]gin.H{}
	for _, scope := range []string{"domestic", "overseas"} {
		var a model.IPListArtifact
		err := h.db.Where("scope = ?", scope).Order("created_at desc").First(&a).Error
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				continue
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		artifacts[scope] = gin.H{
			"version":     a.Version,
			"entry_count": a.EntryCount,
			"created_at":  a.CreatedAt.Format(time.RFC3339),
			"sha256":      a.SHA256,
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

// normalizeIPListSourceKind 将同步源类型规范为 remote 或 manual。
func normalizeIPListSourceKind(s string) string {
	s = strings.TrimSpace(strings.ToLower(s))
	if s == model.IPListSourceKindManual {
		return model.IPListSourceKindManual
	}
	return model.IPListSourceKindRemote
}

// buildIPListArtifactFromBytes 将原始列表文本解析为 IPv4 CIDR 行并落盘、写入 ip_list_artifacts（与 refresh 远端成功路径一致）。
func (h *Handler) buildIPListArtifactFromBytes(scope string, raw []byte, sourceLabel string) (*model.IPListArtifact, error) {
	scope = normalizeIPListScope(scope)
	if scope == "all" {
		return nil, fmt.Errorf("invalid scope for artifact")
	}
	lines := strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n")
	filtered := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if scope == "overseas" {
			ip, _, err := net.ParseCIDR(line)
			if err != nil || ip.To4() == nil {
				continue
			}
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
		SourceURL:  sourceLabel,
	}
	if err := h.db.Create(artifact).Error; err != nil {
		return nil, err
	}
	return artifact, nil
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
	kind := normalizeIPListSourceKind(src.SourceKind)
	if kind == model.IPListSourceKindManual {
		var art model.IPListArtifact
		if err := h.db.Where("scope = ?", scope).Order("created_at desc").First(&art).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil, fmt.Errorf("manual scope %s: no artifact yet, upload a file first", scope)
			}
			return nil, err
		}
		if _, err := os.Stat(art.FilePath); err != nil {
			return nil, fmt.Errorf("manual scope %s: artifact file missing: %w", scope, err)
		}
		return &art, nil
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
			req, reqErr := http.NewRequest(http.MethodGet, u, nil)
			if reqErr != nil {
				lastErr = reqErr
				continue
			}
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
	return h.buildIPListArtifactFromBytes(scope, body, used)
}

// pushIPListUpdateToOnlineNodes 向当前管理员可见的在线节点下发 update_iplist 与例外规则（与 TriggerIPListUpdate 一致）。
func (h *Handler) pushIPListUpdateToOnlineNodes(c *gin.Context, admScope *AdminScope, effectiveScope string) (sent int, totalNodes int, offlineCount int, err error) {
	nq := h.db.Model(&model.Node{})
	if !h.scopeEffectiveUnrestricted(c, admScope) {
		if len(admScope.AllowedNodeIDs) == 0 {
			return 0, 0, 0, nil
		}
		nq = nq.Where("id IN ?", admScope.AllowedNodeIDs)
	}
	var nodes []model.Node
	if err := nq.Find(&nodes).Error; err != nil {
		return 0, 0, 0, err
	}
	var exceptions []model.IPListException
	if err := h.db.Find(&exceptions).Error; err != nil {
		return 0, 0, 0, err
	}
	sent = 0
	for _, n := range nodes {
		if h.hub != nil && h.hub.IsOnline(n.ID) {
			scopePayload, merr := json.Marshal(gin.H{"scope": effectiveScope})
			if merr != nil {
				log.Printf("pushIPListUpdateToOnlineNodes: marshal iplist scope: %v", merr)
			} else {
				if err := h.hub.SendToNode(n.ID, WSMessage{Type: "update_iplist", Payload: scopePayload}); err != nil {
					log.Printf("pushIPListUpdateToOnlineNodes: send update_iplist to %s: %v", n.ID, err)
				}
			}
			if len(exceptions) > 0 {
				exPayload, exErr := json.Marshal(map[string]any{"exceptions": exceptions})
				if exErr != nil {
					log.Printf("pushIPListUpdateToOnlineNodes: marshal exceptions: %v", exErr)
				} else {
					if err := h.hub.SendToNode(n.ID, WSMessage{Type: "update_exceptions", Payload: exPayload}); err != nil {
						log.Printf("pushIPListUpdateToOnlineNodes: send update_exceptions to %s: %v", n.ID, err)
					}
				}
			}
			sent++
		}
	}
	offlineCount = len(nodes) - sent
	if offlineCount < 0 {
		offlineCount = 0
	}
	return sent, len(nodes), offlineCount, nil
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
		SourceKind        *string `json:"source_kind"`
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
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "source not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if req.SourceKind != nil {
		k := normalizeIPListSourceKind(*req.SourceKind)
		if k != model.IPListSourceKindRemote && k != model.IPListSourceKindManual {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid source_kind"})
			return
		}
		item.SourceKind = k
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

// ipListUploadMaxBytes 本地上传 IP 库单文件大小上限。
const ipListUploadMaxBytes = 32 << 20

// UploadIPListSource 接受 multipart 文件，解析后生成制品并可选通知在线节点（source_kind 须为 manual）。
func (h *Handler) UploadIPListSource(c *gin.Context) {
	if !h.ipListDualEnabled {
		c.JSON(http.StatusNotFound, gin.H{"error": "ip-list source api disabled"})
		return
	}
	admScope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	scope := normalizeIPListScope(c.Param("scope"))
	if scope == "all" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid scope"})
		return
	}
	var src model.IPListSource
	if err := h.db.Where("scope = ?", scope).First(&src).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "source not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if normalizeIPListSourceKind(src.SourceKind) != model.IPListSourceKindManual {
		c.JSON(http.StatusBadRequest, gin.H{"error": "当前为远端同步模式，请先在编辑中将来源切换为「本地上传」"})
		return
	}
	if !src.Enabled {
		c.JSON(http.StatusBadRequest, gin.H{"error": "同步源已关闭，无法上传"})
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, ipListUploadMaxBytes+4096)
	if err := c.Request.ParseMultipartForm(ipListUploadMaxBytes + 4096); err != nil {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "上传过大或格式错误"})
		return
	}
	fh, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 file 字段"})
		return
	}
	f, err := fh.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	body, err := io.ReadAll(io.LimitReader(f, ipListUploadMaxBytes+1))
	_ = f.Close()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if len(body) > ipListUploadMaxBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "文件超过大小限制"})
		return
	}
	label := fmt.Sprintf("upload://%s", filepath.Base(fh.Filename))
	art, err := h.buildIPListArtifactFromBytes(scope, body, label)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	now := time.Now()
	src.LastManualAt = &now
	if err := h.db.Save(&src).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	sent, totalNodes, offlineCount, err := h.pushIPListUpdateToOnlineNodes(c, admScope, scope)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.audit(c, "upload_iplist", scope, fmt.Sprintf("version=%s entries=%d sent_to=%d/%d", art.Version, art.EntryCount, sent, totalNodes))
	c.JSON(http.StatusOK, gin.H{
		"artifact": gin.H{
			"scope":       art.Scope,
			"version":     art.Version,
			"entry_count": art.EntryCount,
			"sha256":      art.SHA256,
			"created_at":  art.CreatedAt,
		},
		"sent_to":            sent,
		"total_nodes":        totalNodes,
		"offline_node_count": offlineCount,
	})
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
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "artifact not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
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

var certCNNameRe = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

func normalizeCertNamePart(s string) string {
	v := strings.TrimSpace(s)
	if v == "" {
		return "unknown"
	}
	v = certCNNameRe.ReplaceAllString(v, "-")
	v = strings.Trim(v, "-._")
	if v == "" {
		return "unknown"
	}
	return v
}

// buildGrantCertCN 生成用户授权证书的 CN：节点名-组网模式-用户名-YYYYMMDD。
//
// 参数：
//   - nodeName: 节点展示名；
//   - instanceMode: 实例组网模式（如 node-direct、cn-split、global），经 NormalizeInstanceMode 规范化；
//   - username: 用户登录名；
//   - now: 日期部分，取服务器时区下的日历日 YYYYMMDD。
func buildGrantCertCN(nodeName, instanceMode, username string, now time.Time) string {
	nodePart := normalizeCertNamePart(nodeName)
	modePart := normalizeCertNamePart(service.NormalizeInstanceMode(instanceMode))
	userPart := normalizeCertNamePart(username)
	datePart := now.Format("20060102")
	return fmt.Sprintf("%s-%s-%s-%s", nodePart, modePart, userPart, datePart)
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
	if abortJSONIfDBFirstErr(c, h.db.First(&user, uint(userID)).Error, "user not found") {
		return
	}

	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	if !h.ensureVPNUserVisibleToScopedAdmin(c, scope, user.ID) {
		return
	}

	var inst model.Instance
	if abortJSONIfDBFirstErr(c, h.db.First(&inst, req.InstanceID).Error, "instance not found") {
		return
	}

	if !h.ensureNodeAllowed(c, scope, inst.NodeID) {
		return
	}

	var node model.Node
	if abortJSONIfDBFirstErr(c, h.db.First(&node, "id = ?", inst.NodeID).Error, "node not found") {
		return
	}

	certCN := buildGrantCertCN(node.Name, inst.Mode, user.Username, time.Now())

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
	var user model.User
	if abortJSONIfDBFirstErr(c, h.db.First(&user, uint(userID)).Error, "user not found") {
		return
	}
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	if !h.ensureVPNUserVisibleToScopedAdmin(c, scope, user.ID) {
		return
	}
	var grants []model.UserGrant
	if err := h.scopedUserGrantsQuery(c, scope, uint(userID)).Find(&grants).Error; err != nil {
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

	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	grant, ok := h.ensureGrantAllowed(c, scope, uint(grantID))
	if !ok {
		return
	}
	var inst model.Instance
	if abortJSONIfDBFirstErr(c, h.db.First(&inst, grant.InstanceID).Error, "instance not found") {
		return
	}
	protoQ := c.Query("proto")
	data, err := service.GrantOVPNForDownload(grant, inst.Proto, protoQ)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "配置未就绪或该协议暂无文件，请确认已签发成功"})
		return
	}
	filename := fmt.Sprintf("%s.ovpn", grant.CertCN)
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	c.Data(http.StatusOK, "application/x-openvpn-profile; charset=utf-8", service.SanitizeClientOVPNProfile(data))
}

func (h *Handler) RevokeGrant(c *gin.Context) {
	grantID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid grant id"})
		return
	}
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	grantPtr, ok := h.ensureGrantAllowed(c, scope, uint(grantID))
	if !ok {
		return
	}
	grant := *grantPtr
	grant.CertStatus = "revoking"
	if err := h.db.Save(&grant).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	var inst model.Instance
	if h.db.First(&inst, grant.InstanceID).Error == nil {
		if h.hub != nil && h.hub.IsOnline(inst.NodeID) {
			payload, merr := json.Marshal(map[string]any{"cert_cn": grant.CertCN})
			if merr != nil {
				log.Printf("revoke_grant: marshal revoke_cert payload: %v", merr)
			} else {
				if err := h.hub.SendToNode(inst.NodeID, WSMessage{Type: "revoke_cert", Payload: payload}); err != nil {
					log.Printf("revoke_grant: send revoke_cert to %s: %v", inst.NodeID, err)
				}
			}
		} else {
			grant.CertStatus = "revoked"
			if err := h.db.Save(&grant).Error; err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
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
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	grantPtr, ok := h.ensureGrantAllowed(c, scope, uint(grantID))
	if !ok {
		return
	}
	grant := *grantPtr
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
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	grantPtr, ok := h.ensureGrantAllowed(c, scope, uint(grantID))
	if !ok {
		return
	}
	grant := *grantPtr
	if grant.CertStatus != "pending" && grant.CertStatus != "failed" && grant.CertStatus != "placeholder" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "仅「待签发」「占位配置」或「签发失败」的授权可重试"})
		return
	}

	var user model.User
	if abortJSONIfDBFirstErr(c, h.db.First(&user, grant.UserID).Error, "user not found") {
		return
	}
	var inst model.Instance
	if abortJSONIfDBFirstErr(c, h.db.First(&inst, grant.InstanceID).Error, "instance not found") {
		return
	}
	var node model.Node
	if abortJSONIfDBFirstErr(c, h.db.First(&node, "id = ?", inst.NodeID).Error, "node not found") {
		return
	}

	certCN := buildGrantCertCN(node.Name, inst.Mode, user.Username, time.Now())
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
	if err := h.db.Find(&exceptions).Error; err != nil {
		log.Printf("broadcastExceptions: load exceptions: %v", err)
		return
	}
	payload, err := json.Marshal(map[string]any{"exceptions": exceptions})
	if err != nil {
		log.Printf("broadcastExceptions: json.Marshal: %v", err)
		return
	}
	var nodes []model.Node
	if err := h.db.Find(&nodes).Error; err != nil {
		log.Printf("broadcastExceptions: load nodes: %v", err)
		return
	}
	for _, n := range nodes {
		if h.hub.IsOnline(n.ID) {
			if err := h.hub.SendToNode(n.ID, WSMessage{Type: "update_exceptions", Payload: payload}); err != nil {
				log.Printf("broadcastExceptions: send to %s: %v", n.ID, err)
			}
		}
	}
}

type deleteNodePasswordReq struct {
	Password string `json:"password" binding:"required"`
}

// DeleteNodeWithPassword 删除节点前校验当前登录管理员密码，防止误删。
func (h *Handler) DeleteNodeWithPassword(c *gin.Context) {
	id := c.Param("id")
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	var node model.Node
	if abortJSONIfDBFirstErr(c, h.db.Where("id = ?", id).First(&node).Error, "node not found") {
		return
	}
	if !h.ensureNodeAllowed(c, scope, node.ID) {
		return
	}
	username, _ := c.Get("admin")
	admin, err := h.firstAdminByUsernameCI(adminClaimString(username))
	if err != nil {
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
	if abortJSONIfDBFirstErr(c, h.db.Where("id = ?", id).First(&node).Error, "node not found") {
		return
	}

	var meshPeers []string
	var meshTuns []model.Tunnel
	if err := h.db.Where("node_a = ? OR node_b = ?", id, id).Find(&meshTuns).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	seen := make(map[string]struct{})
	for _, t := range meshTuns {
		peer := t.NodeA
		if peer == id {
			peer = t.NodeB
		}
		if peer == "" || peer == id {
			continue
		}
		if _, ok := seen[peer]; ok {
			continue
		}
		seen[peer] = struct{}{}
		meshPeers = append(meshPeers, peer)
	}

	var instanceIDs []uint
	var tunnelIDs []uint
	if err := h.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.Instance{}).Where("node_id = ?", id).Pluck("id", &instanceIDs).Error; err != nil {
			return err
		}
		if len(instanceIDs) > 0 {
			// 物理删除授权行，避免仅吊销仍占用 cert_cn 唯一约束；节点重建后同一用户+实例模式才能重新授权
			if err := tx.Where("instance_id IN ?", instanceIDs).Delete(&model.UserGrant{}).Error; err != nil {
				return err
			}
		}
		if err := tx.Model(&model.Tunnel{}).Where("node_a = ? OR node_b = ?", id, id).Pluck("id", &tunnelIDs).Error; err != nil {
			return err
		}
		if len(tunnelIDs) > 0 {
			if err := tx.Where("tunnel_id IN ?", tunnelIDs).Delete(&model.TunnelMetric{}).Error; err != nil {
				return err
			}
		}
		if err := tx.Where("node_id = ?", id).Delete(&model.ConfigVersion{}).Error; err != nil {
			return err
		}
		if err := tx.Where("node_id = ?", id).Delete(&model.NodeSegment{}).Error; err != nil {
			return err
		}
		if err := tx.Where("node_id = ?", id).Delete(&model.Instance{}).Error; err != nil {
			return err
		}
		if err := tx.Where("node_id = ?", id).Delete(&model.NodeBootstrapToken{}).Error; err != nil {
			return err
		}
		if err := tx.Where("node_a = ? OR node_b = ?", id, id).Delete(&model.Tunnel{}).Error; err != nil {
			return err
		}
		return tx.Delete(&node).Error
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.audit(c, "delete_node", fmt.Sprintf("node:%s", id), fmt.Sprintf("instances=%d cleaned_tunnels=%d", len(instanceIDs), len(tunnelIDs)))
	h.pushWireGuardRefreshToOnlineNodes(meshPeers, "delete_node removed "+id)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) GetUser(c *gin.Context) {
	userID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user id"})
		return
	}
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	var user model.User
	if abortJSONIfDBFirstErr(c, h.db.First(&user, uint(userID)).Error, "user not found") {
		return
	}
	if !h.ensureVPNUserVisibleToScopedAdmin(c, scope, user.ID) {
		return
	}
	var grants []model.UserGrant
	if err := h.scopedUserGrantsQuery(c, scope, user.ID).Find(&grants).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
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
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	var user model.User
	if abortJSONIfDBFirstErr(c, h.db.First(&user, uint(userID)).Error, "user not found") {
		return
	}
	if !h.ensureVPNUserVisibleToScopedAdmin(c, scope, user.ID) {
		return
	}
	if !h.scopeEffectiveUnrestricted(c, scope) {
		if outside, err := h.userHasOutOfScopeGrants(scope, user.ID); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		} else if outside {
			c.JSON(http.StatusForbidden, gin.H{"error": "该用户在您可管辖的节点范围外仍有 VPN 授权，无法修改资料；请联系超级管理员"})
			return
		}
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
	if err := h.db.Save(&user).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.audit(c, "update_user", fmt.Sprintf("user:%s", user.Username), "")
	c.JSON(http.StatusOK, gin.H{"user": user})
}

func (h *Handler) DeleteUser(c *gin.Context) {
	userID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user id"})
		return
	}
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	var user model.User
	if abortJSONIfDBFirstErr(c, h.db.First(&user, uint(userID)).Error, "user not found") {
		return
	}
	if !h.ensureVPNUserVisibleToScopedAdmin(c, scope, user.ID) {
		return
	}
	if !h.scopeEffectiveUnrestricted(c, scope) {
		if outside, err := h.userHasOutOfScopeGrants(scope, user.ID); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		} else if outside {
			c.JSON(http.StatusForbidden, gin.H{"error": "该用户在您可管辖的节点范围外仍有 VPN 授权，无法删除；请联系超级管理员"})
			return
		}
	}
	var grants []model.UserGrant
	if err := h.db.Where("user_id = ?", user.ID).Find(&grants).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	for _, g := range grants {
		if g.CertStatus == "active" || g.CertStatus == "placeholder" {
			g.CertStatus = "revoked"
			if err := h.db.Save(&g).Error; err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
		}
	}
	if err := h.db.Where("user_id = ?", user.ID).Delete(&model.UserGrant{}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if err := h.db.Delete(&user).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.audit(c, "delete_user", fmt.Sprintf("user:%s", user.Username), fmt.Sprintf("removed %d grant rows", len(grants)))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) ListNodeInstances(c *gin.Context) {
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	nodeID := c.Param("id")
	if !h.ensureNodeAllowed(c, scope, nodeID) {
		return
	}
	var instances []model.Instance
	if err := h.db.Where("node_id = ?", nodeID).Find(&instances).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
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
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	nodeID := c.Param("id")
	var node model.Node
	if abortJSONIfDBFirstErr(c, h.db.Where("id = ?", nodeID).First(&node).Error, "node not found") {
		return
	}
	if !h.ensureNodeAllowed(c, scope, node.ID) {
		return
	}
	var req createInstanceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	mode := service.NormalizeInstanceMode(req.Mode)
	if !service.IsSupportedInstanceMode(mode) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid mode: only node-direct/cn-split/global are allowed"})
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
	if err := h.db.Model(&model.NodeSegment{}).Where("node_id = ? AND segment_id = ?", nodeID, segID).Count(&nsCount).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if nsCount == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "node is not a member of this segment"})
		return
	}
	exitTrim := strings.TrimSpace(req.ExitNode)
	if instanceModeUsesExitPeer(mode) && exitTrim != "" {
		ok, err := h.tunnelConnectsPeers(nodeID, exitTrim)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if !ok {
			c.JSON(http.StatusBadRequest, gin.H{"error": "exit_node 须为本节点「相关隧道」中的对端节点 ID"})
			return
		}
	}
	inst := model.Instance{
		NodeID: nodeID, SegmentID: segID, Mode: mode, Port: req.Port,
		Proto: service.NormalizeInstanceProto(req.Proto), Subnet: req.Subnet, ExitNode: exitTrim, Enabled: true,
	}
	if err := h.db.Create(&inst).Error; err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.db.Model(&model.Node{}).Where("id = ?", nodeID).UpdateColumn("config_version", gorm.Expr("config_version + ?", 1)).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.pushInstancesConfigToNode(nodeID)
	h.pushWireGuardRefreshForInstanceMesh(nodeID, fmt.Sprintf("create_instance node=%s id=%d", nodeID, inst.ID))
	h.audit(c, "create_instance", fmt.Sprintf("node:%s", nodeID), fmt.Sprintf("mode=%s port=%d", mode, req.Port))
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
	switch service.NormalizeInstanceMode(mode) {
	case "node-direct", "cn-split", "global":
		return true
	default:
		return false
	}
}

// tunnelConnectsPeers 是否存在一条隧道，两端分别为 nodeID 与 peerID。
func (h *Handler) tunnelConnectsPeers(nodeID, peerID string) (bool, error) {
	if peerID == "" {
		return false, nil
	}
	var n int64
	if err := h.db.Model(&model.Tunnel{}).
		Where("(node_a = ? AND node_b = ?) OR (node_a = ? AND node_b = ?)", nodeID, peerID, peerID, nodeID).
		Count(&n).Error; err != nil {
		return false, err
	}
	return n > 0, nil
}

func (h *Handler) PatchInstance(c *gin.Context) {
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	instID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid instance id"})
		return
	}
	instPtr, ok := h.ensureInstanceAllowed(c, scope, uint(instID))
	if !ok {
		return
	}
	inst := *instPtr
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
			if v != "" {
				ok, err := h.tunnelConnectsPeers(inst.NodeID, v)
				if err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
					return
				}
				if !ok {
					c.JSON(http.StatusBadRequest, gin.H{"error": "exit_node 须为本节点「相关隧道」中的对端节点 ID"})
					return
				}
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
	if err := h.db.Model(&model.Node{}).Where("id = ?", inst.NodeID).UpdateColumn("config_version", gorm.Expr("config_version + ?", 1)).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.pushInstancesConfigToNode(inst.NodeID)
	if req.ExitNode != nil || req.Enabled != nil || req.Subnet != nil {
		h.pushWireGuardRefreshForInstanceMesh(inst.NodeID, fmt.Sprintf("patch_instance id=%d", inst.ID))
	}
	detail := fmt.Sprintf("enabled=%v subnet=%s port=%d proto=%s exit_node=%s", inst.Enabled, inst.Subnet, inst.Port, inst.Proto, inst.ExitNode)
	h.audit(c, "patch_instance", fmt.Sprintf("instance:%d", inst.ID), detail)
	c.JSON(http.StatusOK, gin.H{"instance": inst})
}

// errSkipPushOffline 表示 Agent 未连上或 hub 不可用，pushInstancesConfigToNode 静默跳过。
var errSkipPushOffline = errors.New("skip push: agent offline or hub unavailable")

// pushUpdateConfigToOnlineNode 向在线 Agent 发送 update_config（库中 instances 快照）。
func (h *Handler) pushUpdateConfigToOnlineNode(nodeID string) (instCount int, err error) {
	if h.hub == nil || !h.hub.IsOnline(nodeID) {
		return 0, errSkipPushOffline
	}
	var insts []model.Instance
	if err := h.db.Where("node_id = ?", nodeID).Order("id asc").Find(&insts).Error; err != nil {
		return 0, err
	}
	payload, err := json.Marshal(gin.H{"instances": insts})
	if err != nil {
		return 0, err
	}
	if err := h.hub.SendToNode(nodeID, WSMessage{Type: "update_config", Payload: payload}); err != nil {
		return len(insts), err
	}
	return len(insts), nil
}

// pushInstancesConfigToNode sends the current DB instances snapshot to an online agent (last-config.json + OpenVPN apply on node).
func (h *Handler) pushInstancesConfigToNode(nodeID string) {
	_, err := h.pushUpdateConfigToOnlineNode(nodeID)
	if err != nil {
		if errors.Is(err, errSkipPushOffline) {
			return
		}
		log.Printf("push instances config to %s: %v", nodeID, err)
	}
}

func (h *Handler) GetNodeStatus(c *gin.Context) {
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	id := c.Param("id")
	var node model.Node
	if abortJSONIfDBFirstErr(c, h.db.Where("id = ?", id).First(&node).Error, "node not found") {
		return
	}
	if !h.ensureNodeAllowed(c, scope, node.ID) {
		return
	}
	var tunnels []model.Tunnel
	if err := h.db.Where("node_a = ? OR node_b = ?", id, id).Find(&tunnels).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"node_id":       node.ID,
		"status":        node.Status,
		"online_users":  node.OnlineUsers,
		"agent_version": node.AgentVersion,
		"tunnels":       tunnels,
	})
}

func (h *Handler) RefreshNodeWG(c *gin.Context) {
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	nodeID := strings.TrimSpace(c.Param("id"))
	if nodeID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing node id"})
		return
	}
	if !h.ensureNodeAllowed(c, scope, nodeID) {
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

	var node model.Node
	if abortJSONIfDBFirstErr(c, h.db.Where("id = ?", nodeID).First(&node).Error, "node not found") {
		return
	}
	payload, invalid, totalTunnel, err := buildWireGuardRefreshPayload(h.db, nodeID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !h.hub.IsOnline(nodeID) {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "node offline or ws send failed"})
		return
	}

	h.audit(c, "wg_refresh", fmt.Sprintf("node:%s", nodeID), fmt.Sprintf("total=%d invalid=%d", totalTunnel, invalid))
	c.JSON(http.StatusAccepted, gin.H{
		"ok":           true,
		"node_id":      nodeID,
		"total_tunnel": totalTunnel,
		"invalid":      invalid,
		"delivery":     "queued",
	})

	// SendToNode 在 WS 写阻塞或通道背压时可能阻塞十余秒；先返回 202，避免反向代理/浏览器长时间 pending。
	lock := h.nodeRefreshLock(nodeID)
	go func() {
		lock.Lock()
		defer lock.Unlock()
		if err := h.hub.SendToNode(nodeID, WSMessage{Type: "update_wg_config", Payload: payload}); err != nil {
			log.Printf("wg-refresh: async send to node %s failed: %v", nodeID, err)
		}
	}()
}

// SyncNodeAgentConfig 主动向在线 Agent 下发当前库中的 instances（WebSocket update_config），
// 用于保存后需手动重试或确认节点已应用策略路由 / last-config 时。
func (h *Handler) SyncNodeAgentConfig(c *gin.Context) {
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	nodeID := strings.TrimSpace(c.Param("id"))
	if nodeID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing node id"})
		return
	}
	if !h.ensureNodeAllowed(c, scope, nodeID) {
		return
	}
	var node model.Node
	if err := h.db.Where("id = ?", nodeID).First(&node).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "node not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	n, err := h.pushUpdateConfigToOnlineNode(nodeID)
	if errors.Is(err, errSkipPushOffline) {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "节点未在线，无法下发配置"})
		return
	}
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error()})
		return
	}
	h.audit(c, "sync_agent_config", fmt.Sprintf("node:%s", nodeID), fmt.Sprintf("instances=%d", n))
	c.JSON(http.StatusAccepted, gin.H{"ok": true, "node_id": nodeID, "instances": n})
}

func (h *Handler) GetNodeStateConsistency(c *gin.Context) {
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	q := h.db.Model(&model.Node{})
	if !h.scopeEffectiveUnrestricted(c, scope) {
		if len(scope.AllowedNodeIDs) == 0 {
			c.JSON(http.StatusOK, gin.H{
				"total": 0, "mismatch": 0, "consistent": true,
				"items": []gin.H{},
			})
			return
		}
		q = q.Where("id IN ?", scope.AllowedNodeIDs)
	}
	var nodes []model.Node
	if err := q.Find(&nodes).Error; err != nil {
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
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	tunnelID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid tunnel id"})
		return
	}
	var tun model.Tunnel
	if abortJSONIfDBFirstErr(c, h.db.First(&tun, uint(tunnelID)).Error, "tunnel not found") {
		return
	}
	if !h.scopeEffectiveUnrestricted(c, scope) && (!scope.AllowsNode(tun.NodeA) || !scope.AllowsNode(tun.NodeB)) {
		c.JSON(http.StatusForbidden, gin.H{"error": "no permission for this tunnel"})
		return
	}
	var metrics []model.TunnelMetric
	if err := h.db.Where("tunnel_id = ?", uint(tunnelID)).Order("created_at desc").Limit(100).Find(&metrics).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
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
	res := h.db.Delete(&model.IPListException{}, uint(id))
	if res.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": res.Error.Error()})
		return
	}
	if res.RowsAffected == 0 {
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
	if abortJSONIfDBFirstErr(c, h.db.Where("id = ?", bt.NodeID).First(&node).Error, "node not found") {
		return
	}
	var instances []model.Instance
	if err := h.db.Where("node_id = ? AND enabled = ?", node.ID, true).Find(&instances).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "load instances: " + err.Error()})
		return
	}

	now := time.Now()
	bt.Used = true
	bt.UsedAt = &now
	if err := h.db.Save(&bt).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "mark bootstrap token used: " + err.Error()})
		return
	}

	// Do not set node.Status here. Real online/offline should be driven by
	// websocket lifecycle (connect/heartbeat/disconnect) in ws_hub.
	node.ConfigVersion++
	node.AgentVersion = "bootstrap"
	if err := h.db.Save(&node).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "update node after register: " + err.Error()})
		return
	}

	tunnelConfigs, _ := service.BuildTunnelConfigsForNode(h.db, node.ID)
	if tunnelConfigs == nil {
		tunnelConfigs = []service.TunnelPeerConfig{}
	}
	for _, tc := range tunnelConfigs {
		if tc.ConfigValid {
			continue
		}
		if err := h.db.Model(&model.Tunnel{}).
			Where("(node_a = ? AND node_b = ?) OR (node_a = ? AND node_b = ?)",
				node.ID, tc.PeerNodeID, tc.PeerNodeID, node.ID).
			Updates(map[string]any{
				"status":               "invalid_config",
				"status_reason":        tc.ConfigError,
				"status_updated_at":    time.Now(),
				"consecutive_failures": gorm.Expr("COALESCE(consecutive_failures, 0) + 1"),
			}).Error; err != nil {
			log.Printf("AgentRegister: mark tunnel invalid_config %s <-> %s: %v", node.ID, tc.PeerNodeID, err)
		}
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
	if abortJSONIfDBFirstErr(c, h.db.Where("id = ?", bt.NodeID).First(&node).Error, "node not found") {
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
	admScope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	scopedNodesQuery := func() *gorm.DB {
		q := h.db.Model(&model.Node{})
		if !h.scopeEffectiveUnrestricted(c, admScope) {
			if len(admScope.AllowedNodeIDs) == 0 {
				return q.Where("1 = 0")
			}
			return q.Where("id IN ?", admScope.AllowedNodeIDs)
		}
		return q
	}
	if !h.scopeEffectiveUnrestricted(c, admScope) && len(admScope.AllowedNodeIDs) == 0 {
		c.Data(http.StatusOK, "text/plain; charset=utf-8", []byte("vpn_nodes_total 0\nvpn_nodes_online 0\nvpn_users_total 0\nvpn_tunnels_total 0\nvpn_grants_total 0\nvpn_online_users 0\n"))
		return
	}
	var nodeCount, userCount, tunnelCount, grantCount int64
	if err := scopedNodesQuery().Count(&nodeCount).Error; err != nil {
		c.Data(http.StatusInternalServerError, "text/plain; charset=utf-8", []byte(err.Error()))
		return
	}
	if err := h.db.Model(&model.User{}).Count(&userCount).Error; err != nil {
		c.Data(http.StatusInternalServerError, "text/plain; charset=utf-8", []byte(err.Error()))
		return
	}
	tunQ := h.db.Model(&model.Tunnel{})
	if !h.scopeEffectiveUnrestricted(c, admScope) {
		tunQ = tunQ.Where("node_a IN ? AND node_b IN ?", admScope.AllowedNodeIDs, admScope.AllowedNodeIDs)
	}
	if err := tunQ.Count(&tunnelCount).Error; err != nil {
		c.Data(http.StatusInternalServerError, "text/plain; charset=utf-8", []byte(err.Error()))
		return
	}
	grantQ := h.db.Model(&model.UserGrant{})
	if !h.scopeEffectiveUnrestricted(c, admScope) {
		grantQ = grantQ.Joins("JOIN instances ON instances.id = user_grants.instance_id").
			Where("instances.node_id IN ?", admScope.AllowedNodeIDs)
	}
	if err := grantQ.Count(&grantCount).Error; err != nil {
		c.Data(http.StatusInternalServerError, "text/plain; charset=utf-8", []byte(err.Error()))
		return
	}

	var onlineNodes int64
	if err := scopedNodesQuery().Where("status = ?", "online").Count(&onlineNodes).Error; err != nil {
		c.Data(http.StatusInternalServerError, "text/plain; charset=utf-8", []byte(err.Error()))
		return
	}

	var totalOnlineUsers int
	var nodes []model.Node
	if err := scopedNodesQuery().Find(&nodes).Error; err != nil {
		c.Data(http.StatusInternalServerError, "text/plain; charset=utf-8", []byte(err.Error()))
		return
	}
	for _, n := range nodes {
		totalOnlineUsers += n.OnlineUsers
	}

	out := fmt.Sprintf("vpn_nodes_total %d\nvpn_nodes_online %d\nvpn_users_total %d\nvpn_tunnels_total %d\nvpn_grants_total %d\nvpn_online_users %d\n",
		nodeCount, onlineNodes, userCount, tunnelCount, grantCount, totalOnlineUsers)
	c.Data(http.StatusOK, "text/plain; charset=utf-8", []byte(out))
}

func (h *Handler) ListConfigVersions(c *gin.Context) {
	admScope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	nodeID := c.Query("node_id")
	if nodeID != "" && !h.scopeEffectiveUnrestricted(c, admScope) && !admScope.AllowsNode(nodeID) {
		c.JSON(http.StatusForbidden, gin.H{"error": "no permission for this node"})
		return
	}
	q := h.db.Order("created_at desc").Limit(50)
	if nodeID != "" {
		q = q.Where("node_id = ?", nodeID)
	} else if !h.scopeEffectiveUnrestricted(c, admScope) {
		if len(admScope.AllowedNodeIDs) == 0 {
			c.JSON(http.StatusOK, gin.H{"items": []model.ConfigVersion{}})
			return
		}
		q = q.Where("node_id IN ?", admScope.AllowedNodeIDs)
	}
	var versions []model.ConfigVersion
	if err := q.Find(&versions).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": versions})
}

func (h *Handler) RollbackConfig(c *gin.Context) {
	admScope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return
	}
	versionID, err := strconv.ParseUint(c.Param("version"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid version id"})
		return
	}
	var ver model.ConfigVersion
	if abortJSONIfDBFirstErr(c, h.db.First(&ver, uint(versionID)).Error, "version not found") {
		return
	}
	if !h.ensureNodeAllowed(c, admScope, ver.NodeID) {
		return
	}
	if h.hub != nil && h.hub.IsOnline(ver.NodeID) {
		payload, merr := json.Marshal(map[string]any{"config": ver.Snapshot})
		if merr != nil {
			log.Printf("RollbackConfig: marshal update_config: %v", merr)
		} else {
			if err := h.hub.SendToNode(ver.NodeID, WSMessage{Type: "update_config", Payload: payload}); err != nil {
				log.Printf("RollbackConfig: send update_config to %s: %v", ver.NodeID, err)
			}
		}
	}
	h.audit(c, "rollback_config", fmt.Sprintf("node:%s version:%d", ver.NodeID, ver.ID), ver.Comment)
	c.JSON(http.StatusOK, gin.H{"ok": true, "version": ver})
}

// canManageAdminsRequest 是否可对管理员账号做增删改查：JWT 超管声明或与库表一致的超管（避免仅 claims 与库不同步时行为分裂）。
func (h *Handler) canManageAdminsRequest(c *gin.Context) bool {
	if middleware.JWTClaimsUnrestricted(c) {
		return true
	}
	scope, err := h.loadAdminScope(c)
	if err != nil {
		return false
	}
	return AdminIsUnrestricted(&scope.Admin)
}

func (h *Handler) ListAdmins(c *gin.Context) {
	if !h.canManageAdminsRequest(c) {
		c.JSON(http.StatusForbidden, gin.H{"error": "only super administrators can list admins"})
		return
	}
	var admins []model.Admin
	if err := h.db.Order("id asc").Find(&admins).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	items, err := h.adminsToPublicItems(admins)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

type createAdminReq struct {
	Username    string   `json:"username" binding:"required"`
	Password    string   `json:"password" binding:"required"`
	Role        string   `json:"role"`
	Permissions string   `json:"permissions"`
	NodeIDs     []string `json:"node_ids"`
}

func (h *Handler) CreateAdmin(c *gin.Context) {
	if !h.canManageAdminsRequest(c) {
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
	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "username required"})
		return
	}
	if _, err := h.firstAdminByUsernameCI(req.Username); err == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "username already exists"})
		return
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
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
	if !AdminIsUnrestricted(&admin) {
		if err := validateNodeIDsExist(h.db, req.NodeIDs); err != nil {
			if delErr := h.db.Delete(&admin).Error; delErr != nil {
				log.Printf("CreateAdmin: rollback delete admin id=%d: %v", admin.ID, delErr)
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if err := h.replaceAdminNodeScopes(h.db, admin.ID, req.NodeIDs); err != nil {
			if delErr := h.db.Delete(&admin).Error; delErr != nil {
				log.Printf("CreateAdmin: rollback delete admin id=%d: %v", admin.ID, delErr)
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	h.audit(c, "create_admin", fmt.Sprintf("admin:%s", req.Username), fmt.Sprintf("role=%s perms=%s", req.Role, req.Permissions))
	items, _ := h.adminsToPublicItems([]model.Admin{admin})
	var out gin.H
	if len(items) > 0 {
		out = items[0]
	} else {
		out = gin.H{"id": admin.ID, "username": admin.Username, "role": admin.Role, "permissions": admin.Permissions, "created_at": admin.CreatedAt}
	}
	c.JSON(http.StatusCreated, gin.H{"admin": out})
}

type updateAdminReq struct {
	Role        *string   `json:"role"`
	Permissions *string   `json:"permissions"`
	NodeIDs     *[]string `json:"node_ids"`
}

func (h *Handler) UpdateAdmin(c *gin.Context) {
	if !h.canManageAdminsRequest(c) {
		c.JSON(http.StatusForbidden, gin.H{"error": "only admin can manage admins"})
		return
	}
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	var admin model.Admin
	if abortJSONIfDBFirstErr(c, h.db.First(&admin, uint(id)).Error, "admin not found") {
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
	if err := h.db.Save(&admin).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if AdminIsUnrestricted(&admin) {
		if err := h.db.Where("admin_id = ?", admin.ID).Delete(&model.AdminNodeScope{}).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	} else if req.NodeIDs != nil {
		if err := validateNodeIDsExist(h.db, *req.NodeIDs); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if err := h.replaceAdminNodeScopes(h.db, admin.ID, *req.NodeIDs); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	h.audit(c, "update_admin", fmt.Sprintf("admin:%s", admin.Username), fmt.Sprintf("role=%s perms=%s", admin.Role, admin.Permissions))
	items, err := h.adminsToPublicItems([]model.Admin{admin})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	var out gin.H
	if len(items) > 0 {
		out = items[0]
	} else {
		out = gin.H{"id": admin.ID, "username": admin.Username, "role": admin.Role, "permissions": admin.Permissions, "created_at": admin.CreatedAt}
	}
	c.JSON(http.StatusOK, gin.H{"admin": out})
}

type resetPasswordReq struct {
	NewPassword string `json:"new_password" binding:"required"`
}

func (h *Handler) ResetAdminPassword(c *gin.Context) {
	if !h.canManageAdminsRequest(c) {
		c.JSON(http.StatusForbidden, gin.H{"error": "only admin can reset passwords"})
		return
	}
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	var admin model.Admin
	if abortJSONIfDBFirstErr(c, h.db.First(&admin, uint(id)).Error, "admin not found") {
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
	if err := h.db.Save(&admin).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.audit(c, "reset_admin_password", fmt.Sprintf("admin:%s", admin.Username), "by super admin")
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) DeleteAdmin(c *gin.Context) {
	if !h.canManageAdminsRequest(c) {
		c.JSON(http.StatusForbidden, gin.H{"error": "only admin can manage admins"})
		return
	}
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	var admin model.Admin
	if abortJSONIfDBFirstErr(c, h.db.First(&admin, uint(id)).Error, "admin not found") {
		return
	}
	if admin.Username == "admin" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot delete default admin"})
		return
	}
	if err := h.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("admin_id = ?", admin.ID).Delete(&model.AdminNodeScope{}).Error; err != nil {
			return err
		}
		return tx.Delete(&admin).Error
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.audit(c, "delete_admin", fmt.Sprintf("admin:%s", admin.Username), "")
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) SelfServiceLookup(c *gin.Context) {
	username := strings.TrimSpace(c.Query("username"))
	if username == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "username is required"})
		return
	}
	var user model.User
	if abortJSONIfDBFirstErr(c, h.db.Where("LOWER(TRIM(username)) = LOWER(?)", username).First(&user).Error, "user not found") {
		return
	}
	var grants []model.UserGrant
	if err := h.db.Where("user_id = ?", user.ID).Find(&grants).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"user": user, "grants": grants})
}

func (h *Handler) SelfServiceDownload(c *gin.Context) {
	grantID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid grant id"})
		return
	}
	username := strings.TrimSpace(c.Query("username"))
	if username == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "username is required"})
		return
	}
	var grant model.UserGrant
	if abortJSONIfDBFirstErr(c, h.db.First(&grant, uint(grantID)).Error, "grant not found") {
		return
	}
	var user model.User
	if err := h.db.First(&user, grant.UserID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusForbidden, gin.H{"error": "access denied"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !strings.EqualFold(strings.TrimSpace(user.Username), username) {
		c.JSON(http.StatusForbidden, gin.H{"error": "access denied"})
		return
	}
	var inst model.Instance
	if abortJSONIfDBFirstErr(c, h.db.First(&inst, grant.InstanceID).Error, "instance not found") {
		return
	}
	protoQ := c.Query("proto")
	data, err := service.GrantOVPNForDownload(&grant, inst.Proto, protoQ)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "配置未就绪或该协议暂无文件，请确认已签发成功"})
		return
	}
	filename := fmt.Sprintf("%s.ovpn", grant.CertCN)
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	c.Data(http.StatusOK, "application/x-openvpn-profile; charset=utf-8", service.SanitizeClientOVPNProfile(data))
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
