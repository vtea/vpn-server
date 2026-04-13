package api

import (
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"vpn-api/internal/model"
	"vpn-api/internal/service"
)

func (h *Handler) nodeSegmentsDetail(nodeID string) ([]gin.H, error) {
	var nss []model.NodeSegment
	if err := h.db.Where("node_id = ?", nodeID).Find(&nss).Error; err != nil {
		return nil, err
	}
	out := make([]gin.H, 0, len(nss))
	for _, ns := range nss {
		var seg model.NetworkSegment
		if err := h.db.Where("id = ?", ns.SegmentID).First(&seg).Error; err != nil {
			continue
		}
		out = append(out, gin.H{
			"segment": seg,
			"slot":    ns.Slot,
		})
	}
	return out, nil
}

func (h *Handler) ListNetworkSegments(c *gin.Context) {
	var items []model.NetworkSegment
	if err := h.db.Order("id asc").Find(&items).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

// GetNetworkSegmentNextValues 返回新建网段时的推荐地址第二段（库内最小空闲值）与预览用监听基端口（≥56714，随机；创建时会重新分配）。
func (h *Handler) GetNetworkSegmentNextValues(c *gin.Context) {
	second, err := service.SuggestNextSecondOctet(h.db)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	portBase, err := service.PickRandomPortBase(h.db)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"suggested_second_octet": second,
		"suggested_port_base":    portBase,
		"note":                   "OpenVPN 监听端口在创建时由服务端自 56714 起随机分配并校验不冲突（UDP/TCP 共用端口号）；预览值仅供参考",
	})
}

type createSegmentReq struct {
	Name               string `json:"name" binding:"required"`
	Description        string `json:"description"`
	SecondOctet        *uint8 `json:"second_octet"` // 省略则使用 SuggestNextSecondOctet
	DefaultOvpnProto string `json:"default_ovpn_proto"` // 可选 udp|tcp；空则 udp
}

func (h *Handler) CreateNetworkSegment(c *gin.Context) {
	var req createSegmentReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var second uint8
	if req.SecondOctet != nil {
		second = *req.SecondOctet
		if second == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "second_octet cannot be 0 (reserved for built-in default)"})
			return
		}
		if err := service.ValidateSecondOctetAvailable(h.db, second, ""); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	} else {
		var err error
		second, err = service.SuggestNextSecondOctet(h.db)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	}

	portBase, err := service.PickRandomPortBase(h.db)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	id, err := service.GenerateNetworkSegmentID(h.db)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if strings.TrimSpace(req.DefaultOvpnProto) != "" {
		lp := strings.ToLower(strings.TrimSpace(req.DefaultOvpnProto))
		if lp != "udp" && lp != "tcp" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "default_ovpn_proto must be udp or tcp"})
			return
		}
	}
	proto := service.NormalizeInstanceProto(req.DefaultOvpnProto)

	seg := model.NetworkSegment{
		ID:               id,
		Name:             strings.TrimSpace(req.Name),
		Description:      req.Description,
		SecondOctet:      second,
		PortBase:         portBase,
		DefaultOvpnProto: proto,
	}
	if err := h.db.Create(&seg).Error; err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	h.audit(c, "create_network_segment", fmt.Sprintf("segment:%s", seg.ID), fmt.Sprintf("second_octet=%d port_base=%d proto=%s", seg.SecondOctet, seg.PortBase, seg.DefaultOvpnProto))
	c.JSON(http.StatusCreated, gin.H{"segment": seg})
}

type patchSegmentReq struct {
	Name               *string `json:"name"`
	Description        *string `json:"description"`
	PortBase           *int    `json:"port_base"`
	DefaultOvpnProto   *string `json:"default_ovpn_proto"`   // udp | tcp
	ApplyToInstances   *bool   `json:"apply_to_instances"`   // true 时将当前网段 default_ovpn_proto 批量写入该 segment 下已有实例
}

func (h *Handler) PatchNetworkSegment(c *gin.Context) {
	id := c.Param("id")
	if id == "default" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot modify the built-in default segment via API"})
		return
	}
	var seg model.NetworkSegment
	if err := h.db.Where("id = ?", id).First(&seg).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "segment not found"})
		return
	}
	var req patchSegmentReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Name != nil {
		seg.Name = strings.TrimSpace(*req.Name)
	}
	if req.Description != nil {
		seg.Description = *req.Description
	}
	if req.PortBase != nil {
		if err := service.ValidatePortBaseNoOverlap(h.db, *req.PortBase, id); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		seg.PortBase = *req.PortBase
	}
	if req.DefaultOvpnProto != nil {
		raw := strings.TrimSpace(*req.DefaultOvpnProto)
		if raw != "" {
			lr := strings.ToLower(raw)
			if lr != "udp" && lr != "tcp" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "default_ovpn_proto must be udp or tcp"})
				return
			}
		}
		seg.DefaultOvpnProto = service.NormalizeInstanceProto(*req.DefaultOvpnProto)
	}
	if err := h.db.Save(&seg).Error; err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.ApplyToInstances != nil && *req.ApplyToInstances {
		if err := h.db.Model(&model.Instance{}).Where("segment_id = ?", id).Update("proto", seg.DefaultOvpnProto).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		var nodeIDs []string
		if err := h.db.Model(&model.Instance{}).Where("segment_id = ?", id).Distinct("node_id").Pluck("node_id", &nodeIDs).Error; err != nil {
			log.Printf("patch segment: distinct node_id: %v", err)
		} else {
			for _, nid := range nodeIDs {
				h.db.Model(&model.Node{}).Where("id = ?", nid).UpdateColumn("config_version", gorm.Expr("config_version + ?", 1))
				h.pushInstancesConfigToNode(nid)
			}
		}
	}
	h.audit(c, "patch_network_segment", fmt.Sprintf("segment:%s", id), fmt.Sprintf("apply_to_instances=%v", req.ApplyToInstances != nil && *req.ApplyToInstances))
	c.JSON(http.StatusOK, gin.H{"segment": seg})
}

func (h *Handler) DeleteNetworkSegment(c *gin.Context) {
	id := c.Param("id")
	if id == "default" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot delete the built-in default segment"})
		return
	}
	var n int64
	if err := h.db.Model(&model.NodeSegment{}).Where("segment_id = ?", id).Count(&n).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if n > 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("segment still used by %d node binding(s)", n)})
		return
	}
	if err := h.db.Where("id = ?", id).Delete(&model.NetworkSegment{}).Error; err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	h.audit(c, "delete_network_segment", fmt.Sprintf("segment:%s", id), "")
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func firstSegmentIDForNode(db *gorm.DB, nodeID string) (string, error) {
	var ns model.NodeSegment
	if err := db.Where("node_id = ?", nodeID).Order("segment_id asc").First(&ns).Error; err != nil {
		return "", err
	}
	return ns.SegmentID, nil
}
