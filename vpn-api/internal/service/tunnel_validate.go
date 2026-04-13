package service

import (
	"fmt"
	"net"

	"gorm.io/gorm"
	"vpn-api/internal/model"
)

// ValidateTunnelWGFields 校验隧道为 IPv4 /30，且两端 IP 落在子网内、互不冲突。
func ValidateTunnelWGFields(db *gorm.DB, excludeTunnelID uint, subnet, ipA, ipB string) error {
	if subnet == "" || ipA == "" || ipB == "" {
		return fmt.Errorf("subnet, ip_a, ip_b are required")
	}
	ipa := net.ParseIP(ipA).To4()
	ipb := net.ParseIP(ipB).To4()
	if ipa == nil || ipb == nil {
		return fmt.Errorf("ip_a and ip_b must be IPv4 addresses")
	}
	if ipA == ipB {
		return fmt.Errorf("ip_a and ip_b must differ")
	}
	_, n, err := net.ParseCIDR(subnet)
	if err != nil {
		return fmt.Errorf("invalid subnet CIDR: %w", err)
	}
	ones, bits := n.Mask.Size()
	if bits != 32 || ones != 30 {
		return fmt.Errorf("tunnel subnet must be a /30 (WireGuard point-to-point)")
	}
	if !n.Contains(ipa) || !n.Contains(ipb) {
		return fmt.Errorf("ip_a and ip_b must belong to subnet %s", subnet)
	}

	var others []model.Tunnel
	if err := db.Find(&others).Error; err != nil {
		return err
	}
	for _, t := range others {
		if t.ID == excludeTunnelID {
			continue
		}
		if t.Subnet != "" {
			ov, err := IPv4CIDRsOverlap(subnet, t.Subnet)
			if err != nil {
				return err
			}
			if ov {
				return fmt.Errorf("subnet overlaps existing tunnel id=%d (%s)", t.ID, t.Subnet)
			}
		}
		for _, used := range []string{t.IPA, t.IPB} {
			if used == "" {
				continue
			}
			if used == ipA || used == ipB {
				return fmt.Errorf("address %s already used by tunnel id=%d", used, t.ID)
			}
		}
	}
	return nil
}
