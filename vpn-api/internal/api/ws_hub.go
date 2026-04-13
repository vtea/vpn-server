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

	hub.db.Model(&model.Node{}).Where("id = ?", bt.NodeID).Updates(map[string]any{
		"status": "online",
	})
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

		hub.db.Model(&model.Node{}).Where("id = ?", ac.NodeID).Updates(map[string]any{
			"status": "offline",
		})
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
			hub.db.Model(&model.Node{}).Where("id = ?", ac.NodeID).Updates(map[string]any{
				"status": "online",
			})
		case "report":
			var rpt struct {
				AgentVersion string   `json:"agent_version"`
				AgentArch    string   `json:"agent_arch"`
				WGPublicKey  string   `json:"wg_pubkey"`
				Capabilities []string `json:"capabilities"`
			}
			if json.Unmarshal(msg.Payload, &rpt) == nil {
				updates := map[string]any{"status": "online"}
				if rpt.AgentVersion != "" {
					updates["agent_version"] = rpt.AgentVersion
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
				hub.db.Model(&model.Node{}).Where("id = ?", ac.NodeID).Updates(updates)
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
				OnlineUsers int    `json:"online_users"`
				WGPublicKey string `json:"wg_pubkey"`
				Tunnels     []struct {
					PeerNodeID string  `json:"peer_node_id"`
					LatencyMs  float64 `json:"latency_ms"`
					LossPct    float64 `json:"loss_pct"`
					Reachable  bool    `json:"reachable"`
				} `json:"tunnels"`
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
				hub.db.Model(&model.Node{}).Where("id = ?", ac.NodeID).Updates(updates)
				for _, t := range h.Tunnels {
					status := "ok"
					if !t.Reachable {
						status = "down"
					}
					hub.db.Model(&model.Tunnel{}).
						Where("(node_a = ? AND node_b = ?) OR (node_a = ? AND node_b = ?)",
							ac.NodeID, t.PeerNodeID, t.PeerNodeID, ac.NodeID).
						Updates(map[string]any{
							"latency_ms": t.LatencyMs,
							"loss_pct":   t.LossPct,
							"status":     status,
						})
					if tid := hub.findTunnelID(ac.NodeID, t.PeerNodeID); tid != 0 {
						hub.db.Create(&model.TunnelMetric{
							TunnelID:  tid,
							LatencyMs: t.LatencyMs,
							LossPct:   t.LossPct,
						})
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
			if json.Unmarshal(msg.Payload, &res) == nil && res.Success {
				now := time.Now()
				scope := strings.ToLower(strings.TrimSpace(res.Scope))
				if scope == "" || scope == "domestic" {
					hub.db.Model(&model.Node{}).Where("id = ?", ac.NodeID).Updates(map[string]any{
						"ip_list_version":            res.Version,
						"ip_list_count":              res.EntryCount,
						"ip_list_update_at":          &now,
						"domestic_ip_list_version":   res.Version,
						"domestic_ip_list_count":     res.EntryCount,
						"domestic_ip_list_update_at": &now,
					})
				} else if scope == "overseas" {
					hub.db.Model(&model.Node{}).Where("id = ?", ac.NodeID).Updates(map[string]any{
						"overseas_ip_list_version":   res.Version,
						"overseas_ip_list_count":     res.EntryCount,
						"overseas_ip_list_update_at": &now,
					})
				}
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
				hub.db.Model(&model.AgentUpgradeTaskItem{}).
					Where("task_id = ? AND node_id = ? AND status IN ?", res.TaskID, ac.NodeID, []string{"pending", "running", "verifying"}).
					Updates(updates)
				if res.CurrentVersion != "" {
					hub.db.Model(&model.Node{}).Where("id = ?", ac.NodeID).Update("agent_version", res.CurrentVersion)
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
				hub.db.Model(&model.AgentUpgradeTaskItem{}).
					Where("task_id = ? AND node_id = ? AND status = ?", res.TaskID, ac.NodeID, "prechecking").
					Updates(updates)
			}
		}
	}
}

func (hub *WSHub) findTunnelID(nodeA, nodeB string) uint {
	var t model.Tunnel
	hub.db.
		Select("id").
		Where("(node_a = ? AND node_b = ?) OR (node_a = ? AND node_b = ?)",
			nodeA, nodeB, nodeB, nodeA).
		Limit(1).
		Find(&t)
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
