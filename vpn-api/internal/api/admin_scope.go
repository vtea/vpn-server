package api

import (
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"vpn-api/internal/model"
)

// AdminScope 当前管理员可访问的节点范围（超级管理员为全局）。
type AdminScope struct {
	Admin          model.Admin
	Unrestricted   bool
	AllowedNodeIDs []string
	allowedSet     map[string]struct{}
}

// AdminIsUnrestricted 超级管理员或 permissions 为 * 时不使用节点白名单。
// Role 与数据库中大小写/空格差异做归一化，避免界面与接口判定不一致。
func AdminIsUnrestricted(a *model.Admin) bool {
	if a == nil {
		return false
	}
	if strings.EqualFold(strings.TrimSpace(a.Role), "admin") {
		return true
	}
	return strings.TrimSpace(a.Permissions) == "*"
}

// loadAdminScope 从数据库解析当前 JWT 对应管理员的节点范围。
func (h *Handler) loadAdminScope(c *gin.Context) (*AdminScope, error) {
	username, _ := c.Get("admin")
	usernameStr, _ := username.(string)
	return h.adminScopeForUsername(usernameStr)
}

// respondAdminScopeLoadError 将 loadAdminScope 错误映射为 HTTP 状态（管理员记录不存在时返回 401）。
func respondAdminScopeLoadError(c *gin.Context, err error) {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "管理员账号不存在或已删除，请重新登录"})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
}

// loadAdminScopeOrAbort 加载当前管理员节点范围；失败时已写入响应，调用方应直接 return。
func (h *Handler) loadAdminScopeOrAbort(c *gin.Context) (*AdminScope, bool) {
	scope, err := h.loadAdminScope(c)
	if err != nil {
		respondAdminScopeLoadError(c, err)
		return nil, false
	}
	return scope, true
}

func (h *Handler) adminScopeForUsername(username string) (*AdminScope, error) {
	var admin model.Admin
	if err := h.db.Where("username = ?", strings.TrimSpace(username)).First(&admin).Error; err != nil {
		return nil, err
	}
	if AdminIsUnrestricted(&admin) {
		return &AdminScope{Admin: admin, Unrestricted: true}, nil
	}
	var rows []model.AdminNodeScope
	if err := h.db.Where("admin_id = ?", admin.ID).Find(&rows).Error; err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(rows))
	set := make(map[string]struct{}, len(rows))
	for _, r := range rows {
		nid := strings.TrimSpace(r.NodeID)
		if nid == "" {
			continue
		}
		if _, ok := set[nid]; ok {
			continue
		}
		set[nid] = struct{}{}
		ids = append(ids, nid)
	}
	sort.Strings(ids)
	return &AdminScope{
		Admin:          admin,
		Unrestricted:   false,
		AllowedNodeIDs: ids,
		allowedSet:     set,
	}, nil
}

// AllowsNode 判断 node_id 是否在当前范围内。
func (s *AdminScope) AllowsNode(nodeID string) bool {
	if s == nil {
		return false
	}
	if s.Unrestricted {
		return true
	}
	_, ok := s.allowedSet[nodeID]
	return ok
}

// ScopeJSON 用于 /me、login 等返回 node_scope 与 node_ids。
func (s *AdminScope) ScopeJSON() gin.H {
	if s == nil {
		return gin.H{"node_scope": "scoped", "node_ids": []string{}}
	}
	if s.Unrestricted {
		return gin.H{"node_scope": "all"}
	}
	return gin.H{"node_scope": "scoped", "node_ids": s.AllowedNodeIDs}
}

// adminsToPublicItems 列表接口返回管理员及 node_scope / node_ids（不含密码）。
func (h *Handler) adminsToPublicItems(admins []model.Admin) ([]gin.H, error) {
	if len(admins) == 0 {
		return []gin.H{}, nil
	}
	ids := make([]uint, len(admins))
	for i, a := range admins {
		ids[i] = a.ID
	}
	var scopes []model.AdminNodeScope
	if err := h.db.Where("admin_id IN ?", ids).Find(&scopes).Error; err != nil {
		return nil, err
	}
	byAdmin := make(map[uint][]string)
	for _, s := range scopes {
		byAdmin[s.AdminID] = append(byAdmin[s.AdminID], s.NodeID)
	}
	for k, v := range byAdmin {
		sort.Strings(v)
		byAdmin[k] = v
	}
	out := make([]gin.H, 0, len(admins))
	for _, a := range admins {
		row := gin.H{
			"id":          a.ID,
			"username":    a.Username,
			"role":        a.Role,
			"permissions": a.Permissions,
			"created_at":  a.CreatedAt,
		}
		if AdminIsUnrestricted(&a) {
			row["node_scope"] = "all"
		} else {
			row["node_scope"] = "scoped"
			nids := byAdmin[a.ID]
			if nids == nil {
				nids = []string{}
			}
			row["node_ids"] = nids
		}
		out = append(out, row)
	}
	return out, nil
}

func (h *Handler) ensureNodeAllowed(c *gin.Context, scope *AdminScope, nodeID string) bool {
	if scope == nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "permission denied"})
		return false
	}
	if scope.Unrestricted || scope.AllowsNode(nodeID) {
		return true
	}
	c.JSON(http.StatusForbidden, gin.H{"error": "no permission for this node"})
	return false
}

func (h *Handler) ensureInstanceAllowed(c *gin.Context, scope *AdminScope, instanceID uint) (*model.Instance, bool) {
	var inst model.Instance
	if err := h.db.First(&inst, instanceID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "instance not found"})
			return nil, false
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return nil, false
	}
	if !h.ensureNodeAllowed(c, scope, inst.NodeID) {
		return nil, false
	}
	return &inst, true
}

func (h *Handler) ensureGrantAllowed(c *gin.Context, scope *AdminScope, grantID uint) (*model.UserGrant, bool) {
	var grant model.UserGrant
	if err := h.db.First(&grant, grantID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "grant not found"})
			return nil, false
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return nil, false
	}
	if _, ok := h.ensureInstanceAllowed(c, scope, grant.InstanceID); !ok {
		return nil, false
	}
	return &grant, true
}

func (h *Handler) ensureUnrestrictedAdmin(c *gin.Context) (*AdminScope, bool) {
	scope, ok := h.loadAdminScopeOrAbort(c)
	if !ok {
		return nil, false
	}
	if !scope.Unrestricted {
		c.JSON(http.StatusForbidden, gin.H{"error": "only super administrators can perform this action"})
		return nil, false
	}
	return scope, true
}

// scopedUserGrantsQuery 构造某 VPN 用户的授权行查询；受限管理员仅包含其节点白名单内实例上的授权。
func (h *Handler) scopedUserGrantsQuery(scope *AdminScope, userID uint) *gorm.DB {
	if scope.Unrestricted {
		return h.db.Model(&model.UserGrant{}).Where("user_id = ?", userID)
	}
	if len(scope.AllowedNodeIDs) == 0 {
		return h.db.Model(&model.UserGrant{}).Where("user_id = ? AND 1 = 0", userID)
	}
	return h.db.Model(&model.UserGrant{}).
		Joins("JOIN instances ON instances.id = user_grants.instance_id").
		Where("user_grants.user_id = ?", userID).
		Where("instances.node_id IN ?", scope.AllowedNodeIDs)
}

// crossScopeBlockingCertStatuses 在判断「范围外是否仍有需协调的授权」时忽略的状态（吊销中/已吊销/失败等不再视为跨区占用）。
func crossScopeBlockingCertStatuses() []string {
	return []string{"revoked", "failed", "revoking"}
}

// userHasOutOfScopeGrants 为真表示该用户在白名单外仍有「非终态」VPN 授权行（整户编辑/删除前须拒绝，避免影响其他区域）。
func (h *Handler) userHasOutOfScopeGrants(scope *AdminScope, userID uint) (bool, error) {
	if scope == nil || scope.Unrestricted {
		return false, nil
	}
	terminal := crossScopeBlockingCertStatuses()
	if len(scope.AllowedNodeIDs) == 0 {
		var n int64
		err := h.db.Model(&model.UserGrant{}).
			Where("user_id = ?", userID).
			Where("cert_status NOT IN ?", terminal).
			Count(&n).Error
		return n > 0, err
	}
	var n int64
	err := h.db.Model(&model.UserGrant{}).
		Joins("JOIN instances ON instances.id = user_grants.instance_id").
		Where("user_grants.user_id = ? AND instances.node_id NOT IN ?", userID, scope.AllowedNodeIDs).
		Where("user_grants.cert_status NOT IN ?", terminal).
		Count(&n).Error
	return n > 0, err
}

// userIDsWithCrossScopeEditBlocked 返回在受限管理员视角下「整户不可编辑」的用户 ID 集合（与 userHasOutOfScopeGrants 判定一致）。
func (h *Handler) userIDsWithCrossScopeEditBlocked(scope *AdminScope) (map[uint]struct{}, error) {
	out := make(map[uint]struct{})
	if scope == nil || scope.Unrestricted {
		return out, nil
	}
	terminal := crossScopeBlockingCertStatuses()
	if len(scope.AllowedNodeIDs) == 0 {
		var ids []uint
		if err := h.db.Model(&model.UserGrant{}).
			Where("cert_status NOT IN ?", terminal).
			Distinct("user_id").
			Pluck("user_id", &ids).Error; err != nil {
			return nil, err
		}
		for _, id := range ids {
			out[id] = struct{}{}
		}
		return out, nil
	}
	var idsScoped []uint
	if err := h.db.Model(&model.UserGrant{}).
		Joins("JOIN instances ON instances.id = user_grants.instance_id").
		Where("user_grants.cert_status NOT IN ?", terminal).
		Where("instances.node_id NOT IN ?", scope.AllowedNodeIDs).
		Distinct("user_grants.user_id").
		Pluck("user_grants.user_id", &idsScoped).Error; err != nil {
		return nil, err
	}
	for _, id := range idsScoped {
		out[id] = struct{}{}
	}
	return out, nil
}

// userVisibleToScopedList 非超级管理员仅可见与当前登录管理员「用户名一致」的 VPN 用户一行；超级管理员可见全部。
// 单用户校验（GetUser 等）与此一致。
func (h *Handler) userVisibleToScopedList(scope *AdminScope, userID uint) (bool, error) {
	if scope == nil || scope.Unrestricted {
		return true, nil
	}
	var u model.User
	if err := h.db.First(&u, userID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return false, nil
		}
		return false, err
	}
	adminName := strings.TrimSpace(scope.Admin.Username)
	userName := strings.TrimSpace(u.Username)
	if adminName == "" || userName == "" {
		return false, nil
	}
	return strings.EqualFold(adminName, userName), nil
}

// replaceAdminNodeScopes 覆盖某管理员的节点白名单（调用方已校验 node_id 存在）。
func (h *Handler) replaceAdminNodeScopes(tx *gorm.DB, adminID uint, nodeIDs []string) error {
	if err := tx.Where("admin_id = ?", adminID).Delete(&model.AdminNodeScope{}).Error; err != nil {
		return err
	}
	seen := map[string]struct{}{}
	for _, raw := range nodeIDs {
		nid := strings.TrimSpace(raw)
		if nid == "" {
			continue
		}
		if _, ok := seen[nid]; ok {
			continue
		}
		seen[nid] = struct{}{}
		row := model.AdminNodeScope{AdminID: adminID, NodeID: nid}
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
	}
	return nil
}

func validateNodeIDsExist(db *gorm.DB, nodeIDs []string) error {
	for _, raw := range nodeIDs {
		nid := strings.TrimSpace(raw)
		if nid == "" {
			continue
		}
		var n int64
		if err := db.Model(&model.Node{}).Where("id = ?", nid).Count(&n).Error; err != nil {
			return err
		}
		if n == 0 {
			return fmt.Errorf("node not found: %s", nid)
		}
	}
	return nil
}
