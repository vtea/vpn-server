package service

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math/big"

	"gorm.io/gorm"
	"vpn-api/internal/model"
)

const (
	// 与内置 default 网段 56710–56713 衔接；新建网段随机 UDP 基端口不低于此值。
	MinAutoPortBase = 56714
	MaxPortBase     = 65531 // 保证 base+3 <= 65535
)

// SuggestNextSecondOctet 返回 1–254 中尚未被任一网段占用的最小值（不含内置 default 的 0）。
func SuggestNextSecondOctet(db *gorm.DB) (uint8, error) {
	var rows []struct {
		SecondOctet uint8
	}
	if err := db.Model(&model.NetworkSegment{}).Select("second_octet").Find(&rows).Error; err != nil {
		return 0, err
	}
	used := make(map[uint8]struct{}, len(rows))
	for _, r := range rows {
		used[r.SecondOctet] = struct{}{}
	}
	for v := uint8(1); v <= 254; v++ {
		if _, ok := used[v]; !ok {
			return v, nil
		}
	}
	return 0, fmt.Errorf("no available second octet (1-254)")
}

func portWindowOverlaps(a0, a1, b0, b1 int) bool {
	return a0 <= b1 && b0 <= a1
}

// PickRandomPortBase 在 [MinAutoPortBase, MaxPortBase] 内随机选取基端口，使 [base, base+3] 与库中已有网段不重叠。
func PickRandomPortBase(db *gorm.DB) (int, error) {
	var segs []model.NetworkSegment
	if err := db.Find(&segs).Error; err != nil {
		return 0, err
	}
	type span struct{ lo, hi int }
	var spans []span
	for _, s := range segs {
		lo, hi := SegmentPortRange(s)
		spans = append(spans, span{lo, hi})
	}
	width := int64(MaxPortBase - MinAutoPortBase + 1)
	if width <= 0 {
		return 0, fmt.Errorf("invalid port range configuration")
	}
	for attempt := 0; attempt < 256; attempt++ {
		n, err := rand.Int(rand.Reader, big.NewInt(width))
		if err != nil {
			return 0, err
		}
		base := MinAutoPortBase + int(n.Int64())
		lo, hi := base, base+3
		ok := true
		for _, sp := range spans {
			if portWindowOverlaps(lo, hi, sp.lo, sp.hi) {
				ok = false
				break
			}
		}
		if ok {
			return base, nil
		}
	}
	return 0, fmt.Errorf("could not find non-overlapping UDP port base after retries")
}

// ValidateSecondOctetAvailable 检查 second_octet 是否未被其他网段占用（1–254；0 为 default 保留）。
func ValidateSecondOctetAvailable(db *gorm.DB, secondOctet uint8, excludeSegmentID string) error {
	if secondOctet == 0 {
		return fmt.Errorf("second_octet cannot be 0 (reserved for built-in default)")
	}
	var n int64
	q := db.Model(&model.NetworkSegment{}).Where("second_octet = ?", secondOctet)
	if excludeSegmentID != "" {
		q = q.Where("id != ?", excludeSegmentID)
	}
	if err := q.Count(&n).Error; err != nil {
		return err
	}
	if n > 0 {
		return fmt.Errorf("second_octet %d already used by another segment", secondOctet)
	}
	return nil
}

// ValidatePortBaseNoOverlap 检查 [portBase, portBase+3] 是否与除 excludeID 外的网段重叠（通用校验，不限制下限）。
func ValidatePortBaseNoOverlap(db *gorm.DB, portBase int, excludeSegmentID string) error {
	if portBase < 1 || portBase > MaxPortBase {
		return fmt.Errorf("port_base must be between 1 and %d (need 4 consecutive UDP ports)", MaxPortBase)
	}
	lo, hi := portBase, portBase+3
	var segs []model.NetworkSegment
	if err := db.Find(&segs).Error; err != nil {
		return err
	}
	for _, s := range segs {
		if s.ID == excludeSegmentID {
			continue
		}
		slo, shi := SegmentPortRange(s)
		if portWindowOverlaps(lo, hi, slo, shi) {
			return fmt.Errorf("UDP ports %d-%d overlap with segment %s (%d-%d)", lo, hi, s.ID, slo, shi)
		}
	}
	return nil
}

// GenerateNetworkSegmentID 生成唯一网段 ID（ns_ + 12 hex）。
func GenerateNetworkSegmentID(db *gorm.DB) (string, error) {
	for i := 0; i < 8; i++ {
		b := make([]byte, 6)
		if _, err := rand.Read(b); err != nil {
			return "", err
		}
		id := "ns_" + hex.EncodeToString(b)
		var n int64
		if err := db.Model(&model.NetworkSegment{}).Where("id = ?", id).Count(&n).Error; err != nil {
			return "", err
		}
		if n == 0 {
			return id, nil
		}
	}
	return "", fmt.Errorf("failed to generate unique segment id")
}
