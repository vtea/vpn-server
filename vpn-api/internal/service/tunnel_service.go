package service

import (
	"fmt"
	"strconv"
	"strings"

	"gorm.io/gorm"
	"vpn-api/internal/model"
)

const (
	wgBaseNet = "172.16.0."
	wgPort    = 51820
)

func nextTunnelSubnetOffset(db *gorm.DB) (int, error) {
	var subnets []string
	if err := db.Model(&model.Tunnel{}).Pluck("subnet", &subnets).Error; err != nil {
		return 0, err
	}
	used := make(map[int]struct{}, len(subnets))
	for _, cidr := range subnets {
		octet, ok := tunnelSubnetOctet(cidr)
		if !ok {
			continue
		}
		used[octet] = struct{}{}
	}
	for octet := 0; octet <= 252; octet += 4 {
		if _, exists := used[octet]; !exists {
			return octet, nil
		}
	}
	return 0, fmt.Errorf("no available /30 subnet in %s0/24", wgBaseNet)
}

func tunnelSubnetOctet(cidr string) (int, bool) {
	if !strings.HasPrefix(cidr, wgBaseNet) || !strings.HasSuffix(cidr, "/30") {
		return 0, false
	}
	raw := strings.TrimSuffix(strings.TrimPrefix(cidr, wgBaseNet), "/30")
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 || n > 252 || n%4 != 0 {
		return 0, false
	}
	return n, true
}

func AllocateTunnelSubnet(db *gorm.DB) (subnet, ipA, ipB string, err error) {
	offset, err := nextTunnelSubnetOffset(db)
	if err != nil {
		return "", "", "", err
	}
	base := offset
	subnet = fmt.Sprintf("%s%d/30", wgBaseNet, base)
	ipA = fmt.Sprintf("%s%d", wgBaseNet, base+1)
	ipB = fmt.Sprintf("%s%d", wgBaseNet, base+2)
	return subnet, ipA, ipB, nil
}

func CreateTunnelsForNewNode(db *gorm.DB, newNodeID string) ([]model.Tunnel, error) {
	var existingNodes []model.Node
	if err := db.Where("id != ?", newNodeID).Find(&existingNodes).Error; err != nil {
		return nil, err
	}

	tunnels := make([]model.Tunnel, 0, len(existingNodes))
	for _, peer := range existingNodes {
		subnet, ipA, ipB, err := AllocateTunnelSubnet(db)
		if err != nil {
			return nil, err
		}

		t := model.Tunnel{
			NodeA:  newNodeID,
			NodeB:  peer.ID,
			Subnet: subnet,
			IPA:    ipA,
			IPB:    ipB,
			WGPort: wgPort,
			Status: "pending",
		}
		if err := db.Create(&t).Error; err != nil {
			return nil, err
		}
		tunnels = append(tunnels, t)
	}
	return tunnels, nil
}

type TunnelPeerConfig struct {
	PeerNodeID   string `json:"peer_node_id"`
	PeerEndpoint string `json:"peer_endpoint"`
	PeerPubKey   string `json:"peer_pubkey"`
	ConfigValid  bool   `json:"config_valid"`
	ConfigError  string `json:"config_error,omitempty"`
	LocalIP      string `json:"local_ip"`
	PeerIP       string `json:"peer_ip"`
	Subnet       string `json:"subnet"`
	WGPort       int    `json:"wg_port"`
	AllowedIPs   string `json:"allowed_ips"`
}

func BuildTunnelConfigsForNode(db *gorm.DB, nodeID string) ([]TunnelPeerConfig, error) {
	var tunnels []model.Tunnel
	if err := db.Where("node_a = ? OR node_b = ?", nodeID, nodeID).Find(&tunnels).Error; err != nil {
		return nil, err
	}

	configs := make([]TunnelPeerConfig, 0, len(tunnels))
	for _, t := range tunnels {
		var peerNodeID, localIP, peerIP string
		if t.NodeA == nodeID {
			peerNodeID = t.NodeB
			localIP = t.IPA
			peerIP = t.IPB
		} else {
			peerNodeID = t.NodeA
			localIP = t.IPB
			peerIP = t.IPA
		}

		var peerNode model.Node
		if err := db.Where("id = ?", peerNodeID).First(&peerNode).Error; err != nil {
			continue
		}

		var peerInstances []model.Instance
		db.Where("node_id = ?", peerNodeID).Find(&peerInstances)
		allowedCIDRs := peerIP + "/32"
		for _, inst := range peerInstances {
			allowedCIDRs += ", " + inst.Subnet
		}

		configs = append(configs, TunnelPeerConfig{
			PeerNodeID:   peerNodeID,
			PeerEndpoint: peerNode.PublicIP,
			PeerPubKey:   peerNode.WGPublicKey,
			ConfigValid:  strings.TrimSpace(peerNode.WGPublicKey) != "",
			ConfigError:  map[bool]string{true: "", false: "missing peer wg public key"}[strings.TrimSpace(peerNode.WGPublicKey) != ""],
			LocalIP:      localIP,
			PeerIP:       peerIP,
			Subnet:       t.Subnet,
			WGPort:       t.WGPort,
			AllowedIPs:   allowedCIDRs,
		})
	}
	return configs, nil
}
