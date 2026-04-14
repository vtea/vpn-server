package service

import (
	"fmt"
	"strings"

	"gorm.io/gorm"
	"vpn-api/internal/model"
)

// NormalizeInstanceProto returns "tcp" or "udp" for OpenVPN server/client profiles.
func NormalizeInstanceProto(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "tcp":
		return "tcp"
	default:
		return "udp"
	}
}

var defaultModes = []struct {
	Mode string
	Idx  int
}{
	{"node-direct", 0},
	{"cn-split", 1},
	{"global", 2},
}

var legacyModeIDMap = map[string]string{
	"local-only":     "node-direct",
	"hk-smart-split": "cn-split",
	"hk-global":      "global",
	"us-global":      "global",
}

func NormalizeInstanceMode(mode string) string {
	m := strings.ToLower(strings.TrimSpace(mode))
	if x, ok := legacyModeIDMap[m]; ok {
		return x
	}
	return m
}

func IsSupportedInstanceMode(mode string) bool {
	switch NormalizeInstanceMode(mode) {
	case "node-direct", "cn-split", "global":
		return true
	default:
		return false
	}
}

func NextNodeNumber(db *gorm.DB) (int, error) {
	var max int
	err := db.Model(&model.Node{}).Select("COALESCE(MAX(node_number), 0)").Scan(&max).Error
	if err != nil {
		return 0, err
	}
	if max == 0 {
		return 10, nil
	}
	return max + 10, nil
}

// NodeIDFromNumber 系统生成节点主键，避免与名称 slug 冲突。
func NodeIDFromNumber(num int) string {
	return fmt.Sprintf("node-%d", num)
}

// BuildDefaultInstances 兼容旧调用：单 default 网段、槽位 0。
func BuildDefaultInstances(nodeID string, nodeNumber int) []model.Instance {
	return BuildInstancesForMembership(nodeID, nodeNumber, model.NetworkSegment{
		ID:               "default",
		SecondOctet:      0,
		PortBase:         56710,
		DefaultOvpnProto: "udp",
	}, 0)
}

// BuildInstancesForMembership 为节点在某组网网段下生成三套 OpenVPN 接入配置。
// default 网段（SecondOctet=0）：10.{node_number}.{idx}.0/24，端口 PortBase+idx。
// 其他网段：10.{SecondOctet}.{slot*3+idx}.0/24，端口 PortBase+idx。
func BuildInstancesForMembership(nodeID string, nodeNumber int, seg model.NetworkSegment, slot uint8) []model.Instance {
	instances := make([]model.Instance, 0, len(defaultModes))
	for _, m := range defaultModes {
		var subnet string
		if seg.SecondOctet == 0 {
			subnet = fmt.Sprintf("10.%d.%d.0/24", nodeNumber, m.Idx)
		} else {
			third := int(slot)*3 + m.Idx
			if third > 255 {
				third = 255
			}
			subnet = fmt.Sprintf("10.%d.%d.0/24", seg.SecondOctet, third)
		}
		instances = append(instances, model.Instance{
			NodeID:    nodeID,
			SegmentID: seg.ID,
			Mode:      m.Mode,
			Port:      seg.PortBase + m.Idx,
			Proto:     NormalizeInstanceProto(seg.DefaultOvpnProto),
			Subnet:    subnet,
			Enabled:   m.Mode == "node-direct",
		})
	}
	return instances
}

// NextSegmentSlot 在网段内分配下一个槽位（每节点占 3 个第三段地址）。最多 64 个节点/网段。
func NextSegmentSlot(db *gorm.DB, segmentID string) (uint8, error) {
	var ms int
	err := db.Model(&model.NodeSegment{}).
		Where("segment_id = ?", segmentID).
		Select("COALESCE(MAX(slot), -1)").
		Scan(&ms).Error
	if err != nil {
		return 0, err
	}
	next := ms + 1
	if next > 63 {
		return 0, fmt.Errorf("segment %s has no free slots (max 64 nodes)", segmentID)
	}
	return uint8(next), nil
}

// SegmentPortRange 返回 [low, high] 闭区间，用于同节点多网段端口冲突检测。
func SegmentPortRange(seg model.NetworkSegment) (low, high int) {
	return seg.PortBase, seg.PortBase + len(defaultModes) - 1
}

// PortRangesOverlap 若两区间有重叠返回 true。
func PortRangesOverlap(a0, a1, b0, b1 int) bool {
	return a0 <= b1 && b0 <= a1
}

// ValidateSegmentsPortOverlap 检查同一节点将绑定的多个网段之间 OpenVPN 监听端口区间互不重叠（UDP/TCP 共用端口号）。
func ValidateSegmentsPortOverlap(segs []model.NetworkSegment) error {
	for i := 0; i < len(segs); i++ {
		a0, a1 := SegmentPortRange(segs[i])
		for j := i + 1; j < len(segs); j++ {
			b0, b1 := SegmentPortRange(segs[j])
			if PortRangesOverlap(a0, a1, b0, b1) {
				return fmt.Errorf("OpenVPN port ranges overlap between segments (%d-%d and %d-%d); set different PortBase on each segment",
					a0, a1, b0, b1)
			}
		}
	}
	return nil
}
