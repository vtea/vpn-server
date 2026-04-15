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

// tunnelPairKeyUnordered 用于判断两节点之间是否已有隧道（与 node_a/node_b 存库顺序无关）。
func tunnelPairKeyUnordered(idA, idB string) string {
	if strings.Compare(idA, idB) < 0 {
		return idA + "\x00" + idB
	}
	return idB + "\x00" + idA
}

// EnsureFullMeshTunnels 扫描所有节点，为尚未存在隧道记录的无序节点对补建一条 /30 隧道。
// 新建行的 NodeA 为 node_number 较小者、IPA 为其隧道地址，与 BuildTunnelConfigsForNode 的语义一致。
// 在单事务内执行，便于分配子网时与已插入行一致。
func EnsureFullMeshTunnels(db *gorm.DB) ([]model.Tunnel, error) {
	var created []model.Tunnel
	err := db.Transaction(func(tx *gorm.DB) error {
		var nodes []model.Node
		if err := tx.Order("node_number asc, id asc").Find(&nodes).Error; err != nil {
			return err
		}
		if len(nodes) < 2 {
			return nil
		}

		var existing []model.Tunnel
		if err := tx.Find(&existing).Error; err != nil {
			return err
		}
		has := make(map[string]struct{}, len(existing))
		for _, t := range existing {
			has[tunnelPairKeyUnordered(t.NodeA, t.NodeB)] = struct{}{}
		}

		for i := 0; i < len(nodes); i++ {
			for j := i + 1; j < len(nodes); j++ {
				a, b := nodes[i].ID, nodes[j].ID
				if _, ok := has[tunnelPairKeyUnordered(a, b)]; ok {
					continue
				}
				subnet, ipA, ipB, err := AllocateTunnelSubnet(tx)
				if err != nil {
					return err
				}
				t := model.Tunnel{
					NodeA:  a,
					NodeB:  b,
					Subnet: subnet,
					IPA:    ipA,
					IPB:    ipB,
					WGPort: wgPort,
					Status: "pending",
				}
				if err := tx.Create(&t).Error; err != nil {
					return err
				}
				has[tunnelPairKeyUnordered(a, b)] = struct{}{}
				created = append(created, t)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return created, nil
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

// MeshNeighborNodeIDs 返回与 nodeID 在隧道表中相连的所有对端节点 ID（去重、顺序不保证）。
func MeshNeighborNodeIDs(db *gorm.DB, nodeID string) []string {
	var tunnels []model.Tunnel
	if err := db.Where("node_a = ? OR node_b = ?", nodeID, nodeID).Find(&tunnels).Error; err != nil {
		return nil
	}
	seen := make(map[string]struct{})
	var out []string
	for _, t := range tunnels {
		peer := t.NodeA
		if peer == nodeID {
			peer = t.NodeB
		}
		if peer == "" || peer == nodeID {
			continue
		}
		if _, ok := seen[peer]; ok {
			continue
		}
		seen[peer] = struct{}{}
		out = append(out, peer)
	}
	return out
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
		localIP = strings.TrimSpace(localIP)
		peerIP = strings.TrimSpace(peerIP)
		allowedCIDRs := peerIP + "/32"
		for _, inst := range peerInstances {
			sub := strings.TrimSpace(inst.Subnet)
			if sub == "" {
				continue
			}
			allowedCIDRs += ", " + sub
		}

		pub := strings.TrimSpace(peerNode.WGPublicKey)
		ep := strings.TrimSpace(peerNode.PublicIP)
		cfgErr := ""
		if pub == "" {
			cfgErr = "missing peer wg public key"
		}
		configs = append(configs, TunnelPeerConfig{
			PeerNodeID:   peerNodeID,
			PeerEndpoint: ep,
			PeerPubKey:   pub,
			ConfigValid:  pub != "",
			ConfigError:  cfgErr,
			LocalIP:      localIP,
			PeerIP:       peerIP,
			Subnet:       strings.TrimSpace(t.Subnet),
			WGPort:       t.WGPort,
			AllowedIPs:   allowedCIDRs,
		})
	}
	return configs, nil
}
