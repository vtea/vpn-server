package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"gorm.io/gorm"
	"vpn-api/internal/debuglog"
	"vpn-api/internal/model"
	"vpn-api/internal/service"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// logWSHubDBErr 记录 Agent WebSocket 路径写库失败（不中断连接，便于排查节点/隧道状态漂移）。
func logWSHubDBErr(ctx string, err error) {
	if err != nil {
		log.Printf("ws_hub db: %s: %v", ctx, err)
	}
}

// truncateIPListSyncError 将同步失败原因截断至 DB 字段上限，并避免截断半个 UTF-8 字符。
func truncateIPListSyncError(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	const maxBytes = 512
	if len(s) <= maxBytes {
		return s
	}
	s = s[:maxBytes]
	for len(s) > 0 && !utf8.ValidString(s) {
		_, size := utf8.DecodeLastRuneInString(s)
		if size == 0 {
			break
		}
		s = s[:len(s)-size]
	}
	return s + "…"
}

type AgentConn struct {
	NodeID string
	Conn   *websocket.Conn
	Send   chan []byte
}

type WSHub struct {
	mu      sync.RWMutex
	conns   map[string]*AgentConn // nodeID -> conn
	db      *gorm.DB
	OnEvent func(eventType string, data any) // broadcast to admin WS
	// AutoWireGuardRefresh 由 main 注入：对在线 agent 下发 update_wg_config（与 Handler 手动刷新同源）。
	AutoWireGuardRefresh func(nodeID, reason string)
}

func NewWSHub(db *gorm.DB) *WSHub {
	return &WSHub{conns: make(map[string]*AgentConn), db: db}
}

// ErrAgentNotConnected 表示该节点当前无 Agent WebSocket 连接（与 DB 中节点「在线」状态可能短暂不一致）。
var ErrAgentNotConnected = errors.New("agent websocket not connected")

func (hub *WSHub) IsOnline(nodeID string) bool {
	hub.mu.RLock()
	defer hub.mu.RUnlock()
	_, ok := hub.conns[nodeID]
	return ok
}

func (hub *WSHub) ConnectedNodeIDs() []string {
	hub.mu.RLock()
	defer hub.mu.RUnlock()
	ids := make([]string, 0, len(hub.conns))
	for id := range hub.conns {
		ids = append(ids, id)
	}
	return ids
}

type WSMessage struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

func singleLine(s string) string {
	s = strings.ReplaceAll(s, "\r\n", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", " ")
	return strings.Join(strings.Fields(s), " ")
}

const (
	tunnelStatusHealthy  = "healthy"
	tunnelStatusDegraded = "degraded"
	tunnelStatusDown     = "down"
	tunnelStatusUnknown  = "unknown"
	tunnelStatusInvalid  = "invalid_config"

	tunnelFailureThreshold  = 3
	tunnelHandshakeFreshSec = 90
	tunnelHandshakeStaleSec = 300
)

type tunnelStatusEval struct {
	Status              string
	Reason              string
	ConsecutiveFailures int
	LastHealthyAt       *time.Time
}

// localizeTunnelAgentErrorDetail 将 Agent 上报的隧道错误中的常见英文片段转为中文，便于管理台展示。
func localizeTunnelAgentErrorDetail(msg string) string {
	s := strings.TrimSpace(msg)
	if s == "" {
		return ""
	}
	low := strings.ToLower(s)
	switch {
	case strings.Contains(low, "missing peer wg public key in bootstrap"):
		return "bootstrap 中缺少对端 WireGuard 公钥"
	case strings.Contains(low, "missing peer wg public key"):
		return "缺少对端 WireGuard 公钥"
	}
	out := s
	repl := []struct{ from, to string }{
		{"Unable to access interface: ", "无法访问接口："},
		{"Unable to access interface", "无法访问接口"},
		{"No such device", "无此设备"},
		{"does not exist", "不存在"},
		{"exit status 1", "退出码 1"},
		{"exit status 2", "退出码 2"},
	}
	for _, p := range repl {
		out = strings.ReplaceAll(out, p.from, p.to)
	}
	out = strings.ReplaceAll(out, "wg handshake ", "wg 握手 ")
	out = strings.ReplaceAll(out, "wg transfer ", "wg 流量 ")
	return strings.TrimSpace(out)
}

func normalizeAgentVersion(v string) string {
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(v, "v")
	v = strings.TrimSuffix(v, "-unknown")
	return strings.TrimSpace(v)
}

func canonicalTunnelStatus(s string) string {
	switch strings.TrimSpace(strings.ToLower(s)) {
	case "ok":
		return tunnelStatusHealthy
	case "":
		return tunnelStatusUnknown
	default:
		return strings.TrimSpace(strings.ToLower(s))
	}
}

func tunnelStatusSeverity(s string) int {
	switch canonicalTunnelStatus(s) {
	case tunnelStatusHealthy:
		return 1
	case tunnelStatusDegraded:
		return 2
	case tunnelStatusUnknown:
		return 3
	case tunnelStatusDown:
		return 4
	case tunnelStatusInvalid:
		return 5
	default:
		return 3
	}
}

func evaluateTunnelHealth(now time.Time, current model.Tunnel, item healthTunnelItem) tunnelStatusEval {
	failures := current.ConsecutiveFailures
	if failures < 0 {
		failures = 0
	}
	out := tunnelStatusEval{
		Status:              tunnelStatusUnknown,
		Reason:              "隧道遥测不足",
		ConsecutiveFailures: failures,
		LastHealthyAt:       current.LastHealthyAt,
	}

	if item.PeerPubKeyPresent != nil && !*item.PeerPubKeyPresent {
		out.ConsecutiveFailures = failures + 1
		out.Status = tunnelStatusInvalid
		out.Reason = "对端 WireGuard 公钥缺失"
		return out
	}

	if item.IfaceUp != nil && !*item.IfaceUp {
		out.ConsecutiveFailures = failures + 1
		out.Status = tunnelStatusDown
		out.Reason = "WireGuard 接口未就绪"
		return out
	}

	if item.LatestHandshakeAgeSec != nil {
		age := *item.LatestHandshakeAgeSec
		if age >= 0 && age <= tunnelHandshakeFreshSec {
			out.Status = tunnelStatusHealthy
			out.Reason = "最近有 WireGuard 握手"
			out.ConsecutiveFailures = 0
			out.LastHealthyAt = &now
			return out
		}
		if age > tunnelHandshakeFreshSec && age <= tunnelHandshakeStaleSec {
			out.Status = tunnelStatusDegraded
			out.Reason = "WireGuard 握手已过期"
			out.ConsecutiveFailures = 0
			return out
		}
	}

	trafficObserved := false
	if item.RxBytesDelta != nil && *item.RxBytesDelta > 0 {
		trafficObserved = true
	}
	if item.TxBytesDelta != nil && *item.TxBytesDelta > 0 {
		trafficObserved = true
	}
	if !trafficObserved {
		if item.RxBytesTotal != nil && *item.RxBytesTotal > 0 {
			trafficObserved = true
		}
		if item.TxBytesTotal != nil && *item.TxBytesTotal > 0 {
			trafficObserved = true
		}
	}
	if trafficObserved {
		out.Status = tunnelStatusDegraded
		out.Reason = "观测到流量但握手不够新"
		out.ConsecutiveFailures = 0
		return out
	}

	failures++
	out.ConsecutiveFailures = failures
	out.Reason = "握手过期且无流量进展"
	if failures >= tunnelFailureThreshold {
		out.Status = tunnelStatusDown
	} else {
		out.Status = tunnelStatusDegraded
		out.Reason = "健康检查未达判定阈值（暂降级）"
	}
	return out
}

type healthTunnelItem struct {
	PeerNodeID            string  `json:"peer_node_id"`
	LatencyMs             float64 `json:"latency_ms"`
	LossPct               float64 `json:"loss_pct"`
	Reachable             bool    `json:"reachable"`
	PeerPubKeyPresent     *bool   `json:"peer_pubkey_present,omitempty"`
	IfaceUp               *bool   `json:"iface_up,omitempty"`
	LatestHandshakeAgeSec *int64  `json:"latest_handshake_age_sec,omitempty"`
	RxBytesTotal          *int64  `json:"rx_bytes_total,omitempty"`
	TxBytesTotal          *int64  `json:"tx_bytes_total,omitempty"`
	RxBytesDelta          *int64  `json:"rx_bytes_delta,omitempty"` // 兼容旧 agent
	TxBytesDelta          *int64  `json:"tx_bytes_delta,omitempty"` // 兼容旧 agent
	Error                 string  `json:"error,omitempty"`
}

func (hub *WSHub) SendToNode(nodeID string, msg WSMessage) error {
	hub.mu.RLock()
	ac, ok := hub.conns[nodeID]
	hub.mu.RUnlock()
	if !ok {
		return ErrAgentNotConnected
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	// 禁止非阻塞丢弃：此前 default 分支会导致 issue_cert 静默丢失，授权永久「待签发」
	select {
	case ac.Send <- data:
		return nil
	case <-time.After(15 * time.Second):
		return fmt.Errorf("send to node %s timed out (downstream slow)", nodeID)
	}
}

func (hub *WSHub) HandleWS(c *gin.Context) {
	token := c.Query("token")
	if token == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing token query param"})
		return
	}

	var bt model.NodeBootstrapToken
	if err := hub.db.Where("token = ?", token).First(&bt).Error; err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
		return
	}

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("ws upgrade failed: %v", err)
		return
	}

	ac := &AgentConn{
		NodeID: bt.NodeID,
		Conn:   conn,
		Send:   make(chan []byte, 64),
	}

	hub.mu.Lock()
	if old, ok := hub.conns[bt.NodeID]; ok {
		old.Conn.Close()
	}
	hub.conns[bt.NodeID] = ac
	hub.mu.Unlock()

	logWSHubDBErr("node_online status", hub.db.Model(&model.Node{}).Where("id = ?", bt.NodeID).Updates(map[string]any{
		"status": "online",
	}).Error)
	if hub.OnEvent != nil {
		hub.OnEvent("node_online", map[string]any{"node_id": bt.NodeID})
	}

	go hub.writePump(ac)
	hub.readPump(ac)
}

func (hub *WSHub) readPump(ac *AgentConn) {
	defer func() {
		hub.mu.Lock()
		if hub.conns[ac.NodeID] == ac {
			delete(hub.conns, ac.NodeID)
		}
		hub.mu.Unlock()
		ac.Conn.Close()

		logWSHubDBErr("node_offline status", hub.db.Model(&model.Node{}).Where("id = ?", ac.NodeID).Updates(map[string]any{
			"status": "offline",
		}).Error)
		if hub.OnEvent != nil {
			hub.OnEvent("node_offline", map[string]any{"node_id": ac.NodeID})
		}
	}()

	ac.Conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	ac.Conn.SetPongHandler(func(string) error {
		ac.Conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		return nil
	})

	for {
		_, raw, err := ac.Conn.ReadMessage()
		if err != nil {
			break
		}

		var msg WSMessage
		if json.Unmarshal(raw, &msg) != nil {
			continue
		}

		switch msg.Type {
		case "heartbeat":
			logWSHubDBErr("heartbeat status", hub.db.Model(&model.Node{}).Where("id = ?", ac.NodeID).Updates(map[string]any{
				"status": "online",
			}).Error)
		case "report":
			var rpt struct {
				AgentVersion string   `json:"agent_version"`
				AgentArch    string   `json:"agent_arch"`
				WGPublicKey  string   `json:"wg_pubkey"`
				Capabilities []string `json:"capabilities"`
			}
			if json.Unmarshal(msg.Payload, &rpt) == nil {
				var prev model.Node
				_ = hub.db.Select("wg_public_key").Where("id = ?", ac.NodeID).First(&prev).Error
				prevWG := strings.TrimSpace(prev.WGPublicKey)
				updates := map[string]any{"status": "online"}
				if rpt.AgentVersion != "" {
					updates["agent_version"] = normalizeAgentVersion(rpt.AgentVersion)
				}
				if rpt.AgentArch != "" {
					updates["agent_arch"] = strings.TrimSpace(strings.ToLower(rpt.AgentArch))
				}
				if rpt.WGPublicKey != "" {
					updates["wg_public_key"] = rpt.WGPublicKey
				}
				if len(rpt.Capabilities) > 0 {
					updates["agent_capabilities"] = strings.Join(rpt.Capabilities, ",")
				}
				logWSHubDBErr("report", hub.db.Model(&model.Node{}).Where("id = ?", ac.NodeID).Updates(updates).Error)
				log.Printf("agent report: node=%s version=%s arch=%s capabilities=%d wg_pubkey=%t", ac.NodeID, normalizeAgentVersion(rpt.AgentVersion), strings.TrimSpace(rpt.AgentArch), len(rpt.Capabilities), strings.TrimSpace(rpt.WGPublicKey) != "")
				newWG := strings.TrimSpace(rpt.WGPublicKey)
				if hub.AutoWireGuardRefresh != nil && newWG != "" && newWG != prevWG {
					for _, peer := range service.MeshNeighborNodeIDs(hub.db, ac.NodeID) {
						hub.AutoWireGuardRefresh(peer, "peer_wg_pubkey_changed:"+ac.NodeID)
					}
				}
			}
		case "cert_result":
			var res struct {
				CertCN  string `json:"cert_cn"`
				Success bool   `json:"success"`
				OVPN    string `json:"ovpn"`
				OvpnTCP string `json:"ovpn_tcp"`
				OvpnUDP string `json:"ovpn_udp"`
				Error   string `json:"error"`
			}
			if json.Unmarshal(msg.Payload, &res) == nil {
				var grant model.UserGrant
				grantFound := hub.db.Where("cert_cn = ?", res.CertCN).First(&grant).Error == nil
				if res.Success {
					// revoke_cert 也复用 cert_result；其成功回执通常不携带 ovpn 内容，需标记为 revoked
					if len(strings.TrimSpace(res.OVPN)) == 0 && len(strings.TrimSpace(res.OvpnTCP)) == 0 && len(strings.TrimSpace(res.OvpnUDP)) == 0 {
						upd := hub.db.Model(&model.UserGrant{}).Where("cert_cn = ?", res.CertCN).Updates(map[string]any{
							"cert_status": "revoked",
						})
						if upd.Error != nil {
							log.Printf("revoke_result update failed: cert_cn=%s node=%s success=true err=%v", res.CertCN, ac.NodeID, upd.Error)
						} else if grantFound {
							log.Printf("revoke_result applied: grant=%d cert_cn=%s node=%s instance=%d status_before=%s status_after=revoked rows=%d", grant.ID, res.CertCN, ac.NodeID, grant.InstanceID, grant.CertStatus, upd.RowsAffected)
						} else {
							log.Printf("revoke_result applied without grant row: cert_cn=%s node=%s status_after=revoked rows=%d", res.CertCN, ac.NodeID, upd.RowsAffected)
						}
						break
					}
					tcpIn := []byte(res.OvpnTCP)
					udpIn := []byte(res.OvpnUDP)
					legacyIn := []byte(res.OVPN)
					var tcpB, udpB []byte
					if len(tcpIn) > 0 {
						tcpB = service.SanitizeClientOVPNProfile(tcpIn)
					}
					if len(udpIn) > 0 {
						udpB = service.SanitizeClientOVPNProfile(udpIn)
					}
					if len(tcpB) == 0 && len(udpB) == 0 && len(legacyIn) > 0 {
						legacy := service.SanitizeClientOVPNProfile(legacyIn)
						var g model.UserGrant
						if hub.db.Where("cert_cn = ?", res.CertCN).First(&g).Error == nil {
							var inst model.Instance
							if hub.db.First(&inst, g.InstanceID).Error == nil {
								if service.NormalizeInstanceProto(inst.Proto) == "tcp" {
									tcpB = legacy
								} else {
									udpB = legacy
								}
							}
						}
						if len(tcpB) == 0 && len(udpB) == 0 {
							udpB = legacy
						}
					}
					primary := udpB
					var g model.UserGrant
					if hub.db.Where("cert_cn = ?", res.CertCN).First(&g).Error == nil {
						var inst model.Instance
						if hub.db.First(&inst, g.InstanceID).Error == nil {
							if service.NormalizeInstanceProto(inst.Proto) == "tcp" {
								primary = tcpB
							} else {
								primary = udpB
							}
						}
					}
					if len(primary) == 0 {
						if len(tcpB) > 0 {
							primary = tcpB
						} else {
							primary = udpB
						}
					}
					// #region debug session 892464
					debuglog.Line("H4", "ws_hub.go:cert_result", "sanitized dual", map[string]any{
						"cert_cn": res.CertCN, "tcp_len": len(tcpB), "udp_len": len(udpB), "primary_len": len(primary),
					})
					// #endregion
					upd := hub.db.Model(&model.UserGrant{}).Where("cert_cn = ?", res.CertCN).Updates(map[string]any{
						"ovpn_tcp":     tcpB,
						"ovpn_udp":     udpB,
						"ovpn_content": primary,
						"cert_status":  "active",
					})
					if upd.Error != nil {
						log.Printf("cert_result update failed: cert_cn=%s node=%s success=true err=%v", res.CertCN, ac.NodeID, upd.Error)
					} else if grantFound {
						log.Printf("cert_result applied: grant=%d cert_cn=%s node=%s instance=%d status_before=%s status_after=active tcp_len=%d udp_len=%d primary_len=%d rows=%d", grant.ID, res.CertCN, ac.NodeID, grant.InstanceID, grant.CertStatus, len(tcpB), len(udpB), len(primary), upd.RowsAffected)
					} else {
						log.Printf("cert_result applied without grant row: cert_cn=%s node=%s status_after=active rows=%d", res.CertCN, ac.NodeID, upd.RowsAffected)
					}
				} else {
					// #region debug session 892464
					debuglog.Line("H5", "ws_hub.go:cert_result", "issue failed", map[string]any{
						"cert_cn": res.CertCN, "err_len": len(res.Error),
					})
					// #endregion
					upd := hub.db.Model(&model.UserGrant{}).Where("cert_cn = ?", res.CertCN).Updates(map[string]any{
						"cert_status": "failed",
					})
					if upd.Error != nil {
						log.Printf("cert_result fail update error: cert_cn=%s node=%s success=false err=%v", res.CertCN, ac.NodeID, upd.Error)
					} else if grantFound {
						log.Printf("cert_result marked failed: grant=%d cert_cn=%s node=%s instance=%d status_before=%s status_after=failed rows=%d", grant.ID, res.CertCN, ac.NodeID, grant.InstanceID, grant.CertStatus, upd.RowsAffected)
					} else {
						log.Printf("cert_result marked failed without grant row: cert_cn=%s node=%s rows=%d", res.CertCN, ac.NodeID, upd.RowsAffected)
					}
					log.Printf("cert_result failed for %s: %s", res.CertCN, res.Error)
				}
			}
		case "health":
			var h struct {
				OnlineUsers int                `json:"online_users"`
				WGPublicKey string             `json:"wg_pubkey"`
				Tunnels     []healthTunnelItem `json:"tunnels"`
			}
			if json.Unmarshal(msg.Payload, &h) == nil {
				updates := map[string]any{
					"online_users": h.OnlineUsers,
					"status":       "online",
				}
				if h.OnlineUsers == 0 {
					log.Printf("health: node=%s reports online_users=0", ac.NodeID)
				}
				if h.WGPublicKey != "" {
					updates["wg_public_key"] = h.WGPublicKey
				}
				logWSHubDBErr("health node", hub.db.Model(&model.Node{}).Where("id = ?", ac.NodeID).Updates(updates).Error)
				now := time.Now()
				for _, t := range h.Tunnels {
					var tunnel model.Tunnel
					if err := hub.db.
						Where("(node_a = ? AND node_b = ?) OR (node_a = ? AND node_b = ?)",
							ac.NodeID, t.PeerNodeID, t.PeerNodeID, ac.NodeID).
						First(&tunnel).Error; err != nil {
						continue
					}
					eval := evaluateTunnelHealth(now, tunnel, t)
					reason := eval.Reason
					if strings.TrimSpace(t.Error) != "" {
						reason = reason + "：" + singleLine(localizeTunnelAgentErrorDetail(t.Error))
					}
					currentStatus := canonicalTunnelStatus(tunnel.Status)
					reporterIsPrimary := ac.NodeID == tunnel.NodeA
					// 双端都上报时，非主端仅允许把状态“变差”，避免 A/B 交替覆盖导致抖动。
					if !reporterIsPrimary && tunnelStatusSeverity(eval.Status) < tunnelStatusSeverity(currentStatus) {
						eval.Status = currentStatus
						eval.Reason = strings.TrimSpace(tunnel.StatusReason)
						eval.ConsecutiveFailures = tunnel.ConsecutiveFailures
						eval.LastHealthyAt = tunnel.LastHealthyAt
						if eval.Reason == "" {
							eval.Reason = "非主上报端未降低已报状态"
						}
					}
					logWSHubDBErr(fmt.Sprintf("health tunnel id=%d", tunnel.ID), hub.db.Model(&model.Tunnel{}).
						Where("id = ?", tunnel.ID).
						Updates(map[string]any{
							"latency_ms":           t.LatencyMs,
							"loss_pct":             t.LossPct,
							"status":               eval.Status,
							"status_reason":        reason,
							"status_updated_at":    now,
							"consecutive_failures": eval.ConsecutiveFailures,
							"last_healthy_at":      eval.LastHealthyAt,
						}).Error)
					if tid := hub.findTunnelID(ac.NodeID, t.PeerNodeID); tid != 0 {
						logWSHubDBErr(fmt.Sprintf("tunnel_metric tunnel_id=%d", tid), hub.db.Create(&model.TunnelMetric{
							TunnelID:  tid,
							LatencyMs: t.LatencyMs,
							LossPct:   t.LossPct,
						}).Error)
					}
				}
				if hub.OnEvent != nil {
					hub.OnEvent("node_health", map[string]any{
						"node_id":      ac.NodeID,
						"online_users": h.OnlineUsers,
						"tunnels":      h.Tunnels,
					})
				}
			}
		case "iplist_result":
			var res struct {
				Success    bool   `json:"success"`
				Scope      string `json:"scope"`
				Version    string `json:"version"`
				EntryCount int    `json:"entry_count"`
				Error      string `json:"error"`
			}
			if json.Unmarshal(msg.Payload, &res) == nil {
				scope := strings.ToLower(strings.TrimSpace(res.Scope))
				if !res.Success {
					errMsg := truncateIPListSyncError(res.Error)
					log.Printf("IPLIST_SYNC_FAIL iplist_result failed: node=%s scope=%s error=%s", ac.NodeID, scope, singleLine(res.Error))
					updates := map[string]any{}
					switch scope {
					case "overseas":
						updates["overseas_ip_list_last_error"] = errMsg
					case "domestic":
						updates["domestic_ip_list_last_error"] = errMsg
					default:
						// scope 为空（如 payload 解析失败）时写入国内库字段，便于控制台展示。
						updates["domestic_ip_list_last_error"] = errMsg
					}
					logWSHubDBErr("iplist_result failure persist", hub.db.Model(&model.Node{}).Where("id = ?", ac.NodeID).Updates(updates).Error)
					break
				}
				now := time.Now()
				if scope == "" || scope == "domestic" {
					logWSHubDBErr("iplist_result domestic", hub.db.Model(&model.Node{}).Where("id = ?", ac.NodeID).Updates(map[string]any{
						"ip_list_version":               res.Version,
						"ip_list_count":                 res.EntryCount,
						"ip_list_update_at":             &now,
						"domestic_ip_list_version":      res.Version,
						"domestic_ip_list_count":        res.EntryCount,
						"domestic_ip_list_update_at":    &now,
						"domestic_ip_list_last_error":   "",
					}).Error)
				} else if scope == "overseas" {
					logWSHubDBErr("iplist_result overseas", hub.db.Model(&model.Node{}).Where("id = ?", ac.NodeID).Updates(map[string]any{
						"overseas_ip_list_version":    res.Version,
						"overseas_ip_list_count":      res.EntryCount,
						"overseas_ip_list_update_at":  &now,
						"overseas_ip_list_last_error": "",
					}).Error)
				}
				log.Printf("iplist_result applied: node=%s scope=%s version=%s entries=%d", ac.NodeID, scope, strings.TrimSpace(res.Version), res.EntryCount)
			}
		case "wg_refresh_result":
			var res struct {
				Success bool   `json:"success"`
				Error   string `json:"error"`
				Results []struct {
					PeerNodeID string `json:"peer_node_id"`
					Success    bool   `json:"success"`
					Changed    bool   `json:"changed"`
					Error      string `json:"error"`
				} `json:"results"`
			}
			if json.Unmarshal(msg.Payload, &res) == nil {
				now := time.Now()
				okPeers := 0
				for _, it := range res.Results {
					if it.Success {
						okPeers++
						continue
					}
					reason := singleLine(localizeTunnelAgentErrorDetail(strings.TrimSpace(it.Error)))
					if reason == "" {
						reason = "WireGuard 刷新失败"
					}
					logWSHubDBErr(fmt.Sprintf("wg_refresh_result peer=%s", it.PeerNodeID), hub.db.Model(&model.Tunnel{}).
						Where("(node_a = ? AND node_b = ?) OR (node_a = ? AND node_b = ?)",
							ac.NodeID, it.PeerNodeID, it.PeerNodeID, ac.NodeID).
						Updates(map[string]any{
							"status":               tunnelStatusInvalid,
							"status_reason":        reason,
							"status_updated_at":    now,
							"consecutive_failures": gorm.Expr("COALESCE(consecutive_failures, 0) + 1"),
						}).Error)
				}
				detail := fmt.Sprintf("success=%t ok_peers=%d total_peers=%d error=%s", res.Success, okPeers, len(res.Results), singleLine(res.Error))
				logWSHubDBErr("wg_refresh_result audit", hub.db.Create(&model.AuditLog{
					AdminUser: "system",
					Action:    "wg_refresh_result",
					Target:    "node:" + ac.NodeID,
					Detail:    detail,
				}).Error)
				log.Printf("wg_refresh_result: node=%s %s", ac.NodeID, detail)
			}
		case "upgrade_result":
			var res struct {
				TaskID         uint   `json:"task_id"`
				Success        bool   `json:"success"`
				Error          string `json:"error"`
				CurrentVersion string `json:"current_version"`
				Step           string `json:"step"`
				ErrorCode      string `json:"error_code"`
				StdoutTail     string `json:"stdout_tail"`
				StderrTail     string `json:"stderr_tail"`
			}
			if json.Unmarshal(msg.Payload, &res) == nil && res.TaskID > 0 {
				now := time.Now()
				updates := map[string]any{
					"result_version": res.CurrentVersion,
					"step":           singleLine(res.Step),
					"error_code":     singleLine(res.ErrorCode),
					"stdout_tail":    singleLine(res.StdoutTail),
					"stderr_tail":    singleLine(res.StderrTail),
					"last_seen_at":   &now,
				}
				if res.Success {
					updates["status"] = "verifying"
					updates["message"] = "upgrade command succeeded, waiting for version report"
				} else {
					updates["status"] = "failed"
					updates["message"] = singleLine(res.Error)
				}
				// 允许在控制面已判 timeout 后仍接收晚到的结果（例如下载接近上限时长、或此前 WS 读阻塞导致重连晚到）。
				logWSHubDBErr(fmt.Sprintf("upgrade_result task=%d node=%s", res.TaskID, ac.NodeID), hub.db.Model(&model.AgentUpgradeTaskItem{}).
					Where("task_id = ? AND node_id = ? AND status IN ?", res.TaskID, ac.NodeID, []string{"pending", "running", "verifying", "timeout"}).
					Updates(updates).Error)
				if res.CurrentVersion != "" {
					logWSHubDBErr(fmt.Sprintf("upgrade_result agent_version node=%s", ac.NodeID), hub.db.Model(&model.Node{}).Where("id = ?", ac.NodeID).Update("agent_version", res.CurrentVersion).Error)
				}
			}
		case "upgrade_precheck_result":
			var res struct {
				TaskID      uint   `json:"task_id"`
				Success     bool   `json:"success"`
				SelectedURL string `json:"selected_url"`
				Error       string `json:"error"`
			}
			if json.Unmarshal(msg.Payload, &res) == nil && res.TaskID > 0 {
				now := time.Now()
				updates := map[string]any{}
				if res.Success {
					updates["status"] = "pending"
					updates["message"] = "precheck ok: " + singleLine(res.SelectedURL)
				} else {
					updates["status"] = "failed"
					updates["message"] = "unreachable: " + singleLine(res.Error)
				}
				updates["step"] = "precheck"
				updates["error_code"] = map[bool]string{true: "", false: "precheck_failed"}[res.Success]
				updates["last_seen_at"] = &now
				logWSHubDBErr(fmt.Sprintf("upgrade_precheck_result task=%d node=%s", res.TaskID, ac.NodeID), hub.db.Model(&model.AgentUpgradeTaskItem{}).
					Where("task_id = ? AND node_id = ? AND status = ?", res.TaskID, ac.NodeID, "prechecking").
					Updates(updates).Error)
			}
		}
	}
}

func (hub *WSHub) findTunnelID(nodeA, nodeB string) uint {
	var t model.Tunnel
	if err := hub.db.
		Select("id").
		Where("(node_a = ? AND node_b = ?) OR (node_a = ? AND node_b = ?)",
			nodeA, nodeB, nodeB, nodeA).
		Limit(1).
		Find(&t).Error; err != nil {
		logWSHubDBErr(fmt.Sprintf("findTunnelID %s-%s", nodeA, nodeB), err)
	}
	return t.ID
}

func (hub *WSHub) writePump(ac *AgentConn) {
	ticker := time.NewTicker(30 * time.Second)
	defer func() {
		ticker.Stop()
		ac.Conn.Close()
	}()

	for {
		select {
		case msg, ok := <-ac.Send:
			if !ok {
				ac.Conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			ac.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := ac.Conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			ac.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := ac.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
