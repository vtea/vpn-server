package service

import (
	"encoding/binary"
	"fmt"
	"net"

	"gorm.io/gorm"
	"vpn-api/internal/model"
)

// IPv4CIDRsOverlap 判断两个 IPv4 CIDR 是否重叠。
func IPv4CIDRsOverlap(a, b string) (bool, error) {
	_, na, err := net.ParseCIDR(a)
	if err != nil {
		return false, fmt.Errorf("invalid cidr %q: %w", a, err)
	}
	_, nb, err := net.ParseCIDR(b)
	if err != nil {
		return false, fmt.Errorf("invalid cidr %q: %w", b, err)
	}
	sa, ea, ok := ipv4NetBounds(na)
	if !ok {
		return false, fmt.Errorf("not ipv4 cidr: %s", a)
	}
	sb, eb, ok := ipv4NetBounds(nb)
	if !ok {
		return false, fmt.Errorf("not ipv4 cidr: %s", b)
	}
	return !(ea < sb || eb < sa), nil
}

func ipv4NetBounds(n *net.IPNet) (start, end uint32, ok bool) {
	ip4 := n.IP.To4()
	if ip4 == nil {
		return 0, 0, false
	}
	maskOnes, _ := n.Mask.Size()
	if maskOnes < 0 || maskOnes > 32 {
		return 0, 0, false
	}
	start = binary.BigEndian.Uint32(ip4)
	hostBits := 32 - maskOnes
	if hostBits >= 32 {
		end = start
	} else {
		width := uint32(1) << hostBits
		end = start + width - 1
	}
	return start, end, true
}

// InstanceSubnetConflictsOthers 若 newSubnet 与任意其他实例的 subnet 重叠，返回描述字符串，否则 "".
func InstanceSubnetConflictsOthers(db *gorm.DB, excludeInstanceID uint, newSubnet string) (string, error) {
	var insts []model.Instance
	if err := db.Find(&insts).Error; err != nil {
		return "", err
	}
	for _, inst := range insts {
		if inst.ID == excludeInstanceID {
			continue
		}
		if inst.Subnet == "" {
			continue
		}
		ov, err := IPv4CIDRsOverlap(newSubnet, inst.Subnet)
		if err != nil {
			return "", err
		}
		if ov {
			return fmt.Sprintf("overlaps instance id=%d node=%s subnet=%s", inst.ID, inst.NodeID, inst.Subnet), nil
		}
	}
	return "", nil
}
