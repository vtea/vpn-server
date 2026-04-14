package model

import "time"

type Admin struct {
	ID           uint      `json:"id" gorm:"primaryKey"`
	Username     string    `json:"username" gorm:"uniqueIndex;not null"`
	PasswordHash string    `json:"-" gorm:"not null"`
	Role         string    `json:"role" gorm:"default:admin"`
	Permissions  string    `json:"permissions" gorm:"default:*"`
	CreatedAt    time.Time `json:"created_at"`
}

// Permissions is a comma-separated list of module keys.
// "*" means full access. Available modules:
//
//	nodes, users, rules, tunnels, audit, admins
func (a *Admin) HasPermission(module string) bool {
	if a.Role == "admin" || a.Permissions == "*" {
		return true
	}
	for _, p := range splitPerms(a.Permissions) {
		if p == module || p == "*" {
			return true
		}
	}
	return false
}

func splitPerms(s string) []string {
	if s == "" {
		return nil
	}
	var result []string
	start := 0
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == ',' {
			p := s[start:i]
			for len(p) > 0 && p[0] == ' ' {
				p = p[1:]
			}
			for len(p) > 0 && p[len(p)-1] == ' ' {
				p = p[:len(p)-1]
			}
			if p != "" {
				result = append(result, p)
			}
			start = i + 1
		}
	}
	return result
}

type Node struct {
	ID                     string     `json:"id" gorm:"primaryKey"`
	Name                   string     `json:"name" gorm:"not null"`
	NodeNumber             int        `json:"node_number" gorm:"uniqueIndex;not null"`
	Region                 string     `json:"region" gorm:"not null"`
	PublicIP               string     `json:"public_ip" gorm:"not null"`
	WGPublicKey            string     `json:"wg_public_key"`
	Status                 string     `json:"status" gorm:"default:offline"`
	AgentVersion           string     `json:"agent_version"`
	AgentArch              string     `json:"agent_arch"`
	AgentCapabilities      string     `json:"agent_capabilities"`
	ConfigVersion          int        `json:"config_version" gorm:"default:0"`
	OnlineUsers            int        `json:"online_users" gorm:"default:0"`
	IPListVersion          string     `json:"ip_list_version"`
	IPListCount            int        `json:"ip_list_count" gorm:"default:0"`
	IPListUpdateAt         *time.Time `json:"ip_list_update_at"`
	DomesticIPListVersion  string     `json:"domestic_ip_list_version"`
	DomesticIPListCount    int        `json:"domestic_ip_list_count" gorm:"default:0"`
	DomesticIPListUpdateAt *time.Time `json:"domestic_ip_list_update_at"`
	OverseasIPListVersion  string     `json:"overseas_ip_list_version"`
	OverseasIPListCount    int        `json:"overseas_ip_list_count" gorm:"default:0"`
	OverseasIPListUpdateAt *time.Time `json:"overseas_ip_list_update_at"`
	CreatedAt              time.Time  `json:"created_at"`
}

type IPListSource struct {
	ID                uint      `json:"id" gorm:"primaryKey"`
	Scope             string    `json:"scope" gorm:"uniqueIndex;not null"` // domestic | overseas
	PrimaryURL        string    `json:"primary_url" gorm:"not null"`
	MirrorURL         string    `json:"mirror_url"`
	ConnectTimeoutSec int       `json:"connect_timeout_sec" gorm:"default:8"`
	MaxTimeSec        int       `json:"max_time_sec" gorm:"default:30"`
	RetryCount        int       `json:"retry_count" gorm:"default:2"`
	Enabled           bool      `json:"enabled" gorm:"default:true"`
	UpdatedAt         time.Time `json:"updated_at"`
	CreatedAt         time.Time `json:"created_at"`
}

type IPListArtifact struct {
	ID         uint      `json:"id" gorm:"primaryKey"`
	Scope      string    `json:"scope" gorm:"index;not null"` // domestic | overseas
	Version    string    `json:"version" gorm:"index;not null"`
	EntryCount int       `json:"entry_count" gorm:"default:0"`
	SHA256     string    `json:"sha256"`
	FilePath   string    `json:"file_path" gorm:"not null"`
	SourceURL  string    `json:"source_url"`
	CreatedAt  time.Time `json:"created_at"`
}

type IPListException struct {
	ID        uint      `json:"id" gorm:"primaryKey"`
	CIDR      string    `json:"cidr"`
	Domain    string    `json:"domain"`
	Direction string    `json:"direction" gorm:"not null"` // "foreign" or "domestic"
	Note      string    `json:"note"`
	CreatedAt time.Time `json:"created_at"`
}

type TunnelMetric struct {
	ID        uint      `json:"id" gorm:"primaryKey"`
	TunnelID  uint      `json:"tunnel_id" gorm:"index;not null"`
	LatencyMs float64   `json:"latency_ms"`
	LossPct   float64   `json:"loss_pct"`
	CreatedAt time.Time `json:"created_at"`
}

// NetworkSegment 组网网段：地址规划（SecondOctet/槽位）与 OpenVPN 监听端口基址（PortBase，UDP/TCP 共用端口号）。
// SecondOctet=0 且 id=default 时表示兼容旧版：子网为 10.{node_number}.{mode_idx}.0/24。
type NetworkSegment struct {
	ID               string    `json:"id" gorm:"primaryKey"`
	Name             string    `json:"name" gorm:"not null"`
	Description      string    `json:"description"`
	SecondOctet      uint8     `json:"second_octet" gorm:"not null"` // 0 仅用于 default；新网段为 1–254
	PortBase         int       `json:"port_base" gorm:"not null;default:56710"`
	DefaultOvpnProto string    `json:"default_ovpn_proto" gorm:"not null;default:udp"` // 新建节点在该网段下生成实例时的默认 OpenVPN 协议：udp | tcp
	CreatedAt        time.Time `json:"created_at"`
}

// NodeSegment 节点与组网网段多对多；Slot 在网段内用于 10.x.(slot*3+idx) 分配（旧公式网段固定为 0）。
type NodeSegment struct {
	NodeID    string `json:"node_id" gorm:"primaryKey"`
	SegmentID string `json:"segment_id" gorm:"primaryKey"`
	Slot      uint8  `json:"slot" gorm:"not null"`
}

type Instance struct {
	ID        uint   `json:"id" gorm:"primaryKey"`
	NodeID    string `json:"node_id" gorm:"index;not null"`
	SegmentID string `json:"segment_id" gorm:"index;not null;default:default"`
	Mode      string `json:"mode" gorm:"not null"`
	Port      int    `json:"port" gorm:"not null"`
	Proto     string `json:"proto" gorm:"not null;default:udp"` // OpenVPN: udp | tcp
	Subnet    string `json:"subnet" gorm:"not null"`
	ExitNode  string `json:"exit_node"`
	Enabled   bool   `json:"enabled" gorm:"default:true"`
}

type UserGrant struct {
	ID          uint      `json:"id" gorm:"primaryKey"`
	UserID      uint      `json:"user_id" gorm:"index;not null"`
	InstanceID  uint      `json:"instance_id" gorm:"index;not null"`
	CertCN      string    `json:"cert_cn" gorm:"uniqueIndex;not null"`
	CertStatus  string    `json:"cert_status" gorm:"default:active"`
	OVPNContent []byte    `json:"-" gorm:"type:blob"` // 与实例 proto 一致的一份，兼容旧下载逻辑
	OvpnTCP     []byte    `json:"-" gorm:"column:ovpn_tcp;type:blob"`
	OvpnUDP     []byte    `json:"-" gorm:"column:ovpn_udp;type:blob"`
	CreatedAt   time.Time `json:"created_at"`
}

type NodeBootstrapToken struct {
	ID        uint       `json:"id" gorm:"primaryKey"`
	NodeID    string     `json:"node_id" gorm:"index;not null"`
	Token     string     `json:"-" gorm:"uniqueIndex;not null"`
	Used      bool       `json:"used" gorm:"default:false"`
	CreatedAt time.Time  `json:"created_at"`
	UsedAt    *time.Time `json:"used_at"`
}

type User struct {
	ID          uint      `json:"id" gorm:"primaryKey"`
	Username    string    `json:"username" gorm:"uniqueIndex;not null"`
	DisplayName string    `json:"display_name"`
	GroupName   string    `json:"group_name" gorm:"default:default"`
	Status      string    `json:"status" gorm:"default:active"`
	CreatedAt   time.Time `json:"created_at"`
}

type Tunnel struct {
	ID                  uint       `json:"id" gorm:"primaryKey"`
	NodeA               string     `json:"node_a" gorm:"index;not null"`
	NodeB               string     `json:"node_b" gorm:"index;not null"`
	Subnet              string     `json:"subnet" gorm:"uniqueIndex;not null"` // /30 组网子网全局唯一
	IPA                 string     `json:"ip_a" gorm:"not null"`
	IPB                 string     `json:"ip_b" gorm:"not null"`
	WGPort              int        `json:"wg_port" gorm:"default:56720"`
	Status              string     `json:"status" gorm:"default:unknown"`
	StatusReason        string     `json:"status_reason"`
	StatusUpdatedAt     *time.Time `json:"status_updated_at"`
	LastHealthyAt       *time.Time `json:"last_healthy_at"`
	ConsecutiveFailures int        `json:"consecutive_failures" gorm:"default:0"`
	LatencyMs           float64    `json:"latency_ms"`
	LossPct             float64    `json:"loss_pct"`
	CreatedAt           time.Time  `json:"created_at"`
}

type AuditLog struct {
	ID        uint      `json:"id" gorm:"primaryKey"`
	AdminUser string    `json:"admin_user" gorm:"not null"`
	Action    string    `json:"action" gorm:"not null"`
	Target    string    `json:"target"`
	Detail    string    `json:"detail"`
	CreatedAt time.Time `json:"created_at"`
}

type ConfigVersion struct {
	ID        uint      `json:"id" gorm:"primaryKey"`
	NodeID    string    `json:"node_id" gorm:"index"`
	Snapshot  string    `json:"snapshot" gorm:"type:text"`
	Comment   string    `json:"comment"`
	AdminUser string    `json:"admin_user"`
	CreatedAt time.Time `json:"created_at"`
}

type AgentUpgradeTask struct {
	ID             uint       `json:"id" gorm:"primaryKey"`
	Version        string     `json:"version" gorm:"not null"`
	DownloadURL    string     `json:"download_url" gorm:"not null"`
	DownloadURLLAN string     `json:"download_url_lan"`
	SHA256         string     `json:"sha256" gorm:"not null"`
	Strategy       string     `json:"strategy" gorm:"not null;default:canary"`
	Status         string     `json:"status" gorm:"not null;default:pending"`
	CanaryNodeID   string     `json:"canary_node_id"`
	TotalNodes     int        `json:"total_nodes" gorm:"default:0"`
	SuccessCount   int        `json:"success_count" gorm:"default:0"`
	FailedCount    int        `json:"failed_count" gorm:"default:0"`
	CreatedBy      string     `json:"created_by"`
	ErrorSummary   string     `json:"error_summary"`
	StartedAt      *time.Time `json:"started_at"`
	FinishedAt     *time.Time `json:"finished_at"`
	CreatedAt      time.Time  `json:"created_at"`
}

type AgentUpgradeTaskItem struct {
	ID            uint       `json:"id" gorm:"primaryKey"`
	TaskID        uint       `json:"task_id" gorm:"index;not null"`
	NodeID        string     `json:"node_id" gorm:"index;not null"`
	Stage         string     `json:"stage" gorm:"not null"` // canary | rollout
	Status        string     `json:"status" gorm:"not null;default:pending"`
	Message       string     `json:"message"`
	Step          string     `json:"step"`
	ErrorCode     string     `json:"error_code"`
	StdoutTail    string     `json:"stdout_tail"`
	StderrTail    string     `json:"stderr_tail"`
	ResultVersion string     `json:"result_version"`
	LastSeenAt    *time.Time `json:"last_seen_at"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}
