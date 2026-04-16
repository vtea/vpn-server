package main

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"vpn-api/internal/api"
	"vpn-api/internal/config"
	"vpn-api/internal/middleware"
	"vpn-api/internal/model"
	"vpn-api/internal/service"
)

func main() {
	cfg := config.Load()
	if strings.EqualFold(strings.TrimSpace(os.Getenv("IPLIST_DUAL_ENABLED")), "false") {
		log.Printf("NOTICE: IPLIST_DUAL_ENABLED=false is ignored; dual IP list mode is always enabled (see vpn-api/README.md).")
	}
	if config.ExternalURLIsLoopbackOnly(cfg.ExternalURL) {
		log.Printf("WARNING: EXTERNAL_URL=%q 为回环地址；生成的部署命令中 --api-url 仅本机可用。远程节点请设置 EXTERNAL_URL 为控制面公网 IP/域名（见 vpn-api/README.md）。", cfg.ExternalURL)
	}

	db, err := openDB(cfg)
	if err != nil {
		log.Fatalf("open db failed: %v", err)
	}

	if err := autoMigrateAndSeed(db); err != nil {
		log.Fatalf("init db failed: %v", err)
	}
	if err := migrateLegacyModeIDs(db); err != nil {
		log.Fatalf("mode migration failed: %v", err)
	}
	if err := ensureSegmentsAndBackfill(db); err != nil {
		log.Fatalf("segment migration failed: %v", err)
	}

	ca := service.NewCentralCA(cfg.CADir)
	if caErr := ca.Init(); caErr != nil {
		log.Printf("WARNING: central CA init failed: %v (certificate features may not work)", caErr)
	}

	hub := api.NewWSHub(db)
	h := api.NewHandler(db, cfg.JWTSecret, hub, ca, cfg.ExternalURL, cfg.ExternalURLLAN, cfg.AgentLatestVersion, cfg.CADir, cfg.DBPath, cfg.DBDriver, cfg.IPListDualEnabled)
	hub.AutoWireGuardRefresh = h.PushWireGuardRefreshToOnlineNode
	hub.OnEvent = func(eventType string, data any) {
		h.BroadcastToAdmins(eventType, data)
	}
	r := gin.Default()
	r.GET("/favicon.ico", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	r.Use(func(c *gin.Context) {
		c.Next()
		if c.Writer.Status() >= 500 {
			log.Printf("[http] %s %s -> %d", c.Request.Method, c.Request.URL.Path, c.Writer.Status())
		}
	})
	// 直连监听时不信任任何代理，消除 Gin 关于「信任全部代理」的启动告警；若经 Nginx/Caddy 反代，应改为 SetTrustedProxies([]string{"内网 CIDR"})
	if err := r.SetTrustedProxies(nil); err != nil {
		log.Printf("gin SetTrustedProxies: %v", err)
	}

	if len(cfg.CORSAllowedOrigins) > 0 {
		corsCfg := cors.Config{
			AllowMethods:     []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"},
			AllowHeaders:     []string{"Origin", "Content-Length", "Content-Type", "Authorization", "X-Requested-With", "Accept"},
			ExposeHeaders:    []string{"Content-Length", "Content-Disposition"},
			AllowCredentials: false,
			MaxAge:           12 * time.Hour,
		}
		if len(cfg.CORSAllowedOrigins) == 1 && cfg.CORSAllowedOrigins[0] == "*" {
			corsCfg.AllowAllOrigins = true
		} else {
			corsCfg.AllowOrigins = cfg.CORSAllowedOrigins
		}
		r.Use(cors.New(corsCfg))
	}

	r.GET("/api/health", h.Health)
	r.POST("/api/auth/login", h.Login)
	r.POST("/api/agent/register", h.AgentRegister)
	r.POST("/api/agent/report", h.AgentReport)
	r.GET("/api/agent/ws", hub.HandleWS)
	r.GET("/api/admin/ws", h.AdminWS)
	r.GET("/api/self-service/lookup", h.SelfServiceLookup)
	r.GET("/api/self-service/grants/:id/download", h.SelfServiceDownload)
	r.GET("/api/node-setup.sh", h.ServeNodeSetupScript)
	r.GET("/api/downloads/vpn-agent-linux-amd64", h.ServeVPNAgentLinuxAMD64)
	r.GET("/api/downloads/vpn-agent-linux-arm64", h.ServeVPNAgentLinuxARM64)
	r.GET("/api/downloads/vpn-agent/:seg1/:seg2", h.ServeVPNAgentVersionedDownload)
	// Some probes (curl -I / health checks / proxies) use HEAD.
	// Register explicit HEAD routes to avoid false 404 on download endpoints.
	r.HEAD("/api/downloads/vpn-agent-linux-amd64", h.ServeVPNAgentLinuxAMD64)
	r.HEAD("/api/downloads/vpn-agent-linux-arm64", h.ServeVPNAgentLinuxARM64)
	r.HEAD("/api/downloads/vpn-agent/:seg1/:seg2", h.ServeVPNAgentVersionedDownload)
	r.GET("/api/ip-lists/download/:scope", h.DownloadIPList)

	secured := r.Group("/api", middleware.JWT(cfg.JWTSecret))

	secured.GET("/me", h.GetCurrentAdmin)
	secured.POST("/me/password", h.ChangePassword)

	nodes := secured.Group("", middleware.RequirePermission("nodes"))
	nodes.GET("/network-segments", h.ListNetworkSegments)
	nodes.GET("/network-segments/next-values", h.GetNetworkSegmentNextValues)
	nodes.POST("/network-segments", h.CreateNetworkSegment)
	nodes.PATCH("/network-segments/:id", h.PatchNetworkSegment)
	nodes.DELETE("/network-segments/:id", h.DeleteNetworkSegment)

	nodes.GET("/nodes", h.ListNodes)
	// Register static route before param route to avoid matching "upgrade-status" as :id.
	nodes.GET("/nodes/upgrade-status", h.ListNodeUpgradeStatus)
	nodes.GET("/nodes/state-consistency", h.GetNodeStateConsistency)
	nodes.GET("/nodes/:id", h.GetNode)
	nodes.PATCH("/nodes/:id", h.PatchNode)
	nodes.POST("/nodes", h.CreateNode)
	nodes.POST("/nodes/:id/delete", h.DeleteNodeWithPassword)
	nodes.POST("/nodes/:id/rotate-bootstrap-token", h.RotateNodeBootstrapToken)
	nodes.POST("/nodes/:id/wg-refresh", h.RefreshNodeWG)
	nodes.GET("/nodes/:id/status", h.GetNodeStatus)
	nodes.GET("/nodes/:id/instances", h.ListNodeInstances)
	nodes.POST("/nodes/:id/instances", h.CreateInstance)
	nodes.PATCH("/instances/:id", h.PatchInstance)

	users := secured.Group("", middleware.RequirePermission("users"))
	users.GET("/users", h.ListUsers)
	users.POST("/users", h.CreateUser)
	users.GET("/users/:id", h.GetUser)
	users.PATCH("/users/:id", h.UpdateUser)
	users.DELETE("/users/:id", h.DeleteUser)
	users.GET("/users/:id/grants", h.ListUserGrants)
	users.POST("/users/:id/grants", h.CreateUserGrant)
	users.GET("/grants/:id/download", h.DownloadGrantOVPN)
	users.DELETE("/grants/:id/purge", h.PurgeGrant)
	users.DELETE("/grants/:id", h.RevokeGrant)
	users.POST("/grants/:id/retry-issue", h.RetryIssueGrant)

	tunnels := secured.Group("", middleware.RequirePermission("tunnels"))
	tunnels.GET("/tunnels", h.ListTunnels)
	tunnels.POST("/tunnels/repair-mesh", h.RepairTunnelMesh)
	tunnels.PATCH("/tunnels/:id", h.PatchTunnel)
	tunnels.GET("/tunnels/:id/metrics", h.GetTunnelMetrics)

	rules := secured.Group("", middleware.RequirePermission("rules"))
	rules.GET("/ip-list/status", h.IPListStatus)
	rules.POST("/ip-list/update", h.TriggerIPListUpdate)
	rules.GET("/ip-list/sources", h.ListIPListSources)
	rules.PATCH("/ip-list/sources/:scope", h.PatchIPListSource)
	rules.GET("/ip-list/exceptions", h.ListExceptions)
	rules.POST("/ip-list/exceptions", h.CreateException)
	rules.DELETE("/ip-list/exceptions/:id", h.DeleteException)

	audit := secured.Group("", middleware.RequirePermission("audit"))
	audit.GET("/audit-logs", h.ListAuditLogs)

	admins := secured.Group("", middleware.RequirePermission("admins"))
	admins.GET("/admins", h.ListAdmins)
	admins.POST("/admins", h.CreateAdmin)
	admins.PATCH("/admins/:id", h.UpdateAdmin)
	admins.POST("/admins/:id/reset-password", h.ResetAdminPassword)
	admins.DELETE("/admins/:id", h.DeleteAdmin)
	admins.GET("/agent-upgrades/defaults", h.GetAgentUpgradeDefaults)
	admins.POST("/agent-upgrades", h.CreateAgentUpgradeTask)
	admins.GET("/agent-upgrades/:id", h.GetAgentUpgradeTask)
	admins.GET("/agent-upgrades/:id/items", h.ListAgentUpgradeTaskItems)

	secured.GET("/metrics", h.PrometheusMetrics)
	secured.GET("/config/versions", h.ListConfigVersions)
	secured.POST("/config/rollback/:version", h.RollbackConfig)

	addr := fmt.Sprintf(":%s", cfg.Port)
	log.Printf("vpn-api listening on %s", addr)
	if err := r.Run(addr); err != nil {
		log.Fatal(err)
	}
}

func ensureSegmentsAndBackfill(db *gorm.DB) error {
	var n int64
	if err := db.Model(&model.NetworkSegment{}).Where("id = ?", "default").Count(&n).Error; err != nil {
		return err
	}
	if n == 0 {
		seg := model.NetworkSegment{
			ID:               "default",
			Name:             "默认组网网段",
			Description:      "默认组网：10.{节点号}.{模式序号}.0/24；监听 56710–56712（默认 UDP）",
			SecondOctet:      0,
			PortBase:         56710,
			DefaultOvpnProto: "udp",
		}
		if err := db.Create(&seg).Error; err != nil {
			return err
		}
	}
	if err := db.Model(&model.Instance{}).
		Where("segment_id IS NULL OR segment_id = ?", "").
		Update("segment_id", "default").Error; err != nil {
		return err
	}
	var nodes []model.Node
	if err := db.Find(&nodes).Error; err != nil {
		return err
	}
	for _, node := range nodes {
		var c int64
		db.Model(&model.NodeSegment{}).Where("node_id = ?", node.ID).Count(&c)
		if c == 0 {
			if err := db.Create(&model.NodeSegment{NodeID: node.ID, SegmentID: "default", Slot: 0}).Error; err != nil {
				return err
			}
		}
	}
	return nil
}

func openDB(cfg config.Config) (*gorm.DB, error) {
	switch cfg.DBDriver {
	case "postgres":
		return gorm.Open(postgres.Open(cfg.DBPath), &gorm.Config{})
	default:
		db, err := gorm.Open(sqlite.Open(sqliteDSN(cfg.DBPath)), &gorm.Config{})
		if err != nil {
			return nil, err
		}
		sqlDB, err := db.DB()
		if err != nil {
			return nil, err
		}
		// SQLite 单写者：多连接并发易导致 "database is locked" → 查询失败返回 500；限制为单连接（官方推荐）
		sqlDB.SetMaxOpenConns(1)
		sqlDB.SetMaxIdleConns(1)
		sqlDB.SetConnMaxLifetime(0)
		return db, nil
	}
}

// sqliteDSN 为 glebarez/sqlite 追加 pragma，降低并发下 "database is locked" 导致查询 500 的概率。
func sqliteDSN(path string) string {
	if strings.Contains(path, "?") {
		return path + "&_pragma=busy_timeout(8000)"
	}
	return path + "?_pragma=busy_timeout(8000)"
}

func autoMigrateAndSeed(db *gorm.DB) error {
	if err := db.AutoMigrate(
		&model.Admin{},
		&model.NetworkSegment{},
		&model.Node{},
		&model.NodeSegment{},
		&model.Instance{},
		&model.User{},
		&model.UserGrant{},
		&model.NodeBootstrapToken{},
		&model.Tunnel{},
		&model.TunnelMetric{},
		&model.IPListException{},
		&model.IPListSource{},
		&model.IPListArtifact{},
		&model.AuditLog{},
		&model.ConfigVersion{},
		&model.AgentUpgradeTask{},
		&model.AgentUpgradeTaskItem{},
	); err != nil {
		return err
	}

	if err := db.Model(&model.Instance{}).Where("proto = ? OR proto IS NULL", "").Update("proto", "udp").Error; err != nil {
		return err
	}

	// 网段默认 OpenVPN 协议列迁移回填
	if err := db.Model(&model.NetworkSegment{}).
		Where("default_ovpn_proto IS NULL OR default_ovpn_proto = ?", "").
		Update("default_ovpn_proto", "udp").Error; err != nil {
		return err
	}
	if err := db.Model(&model.NetworkSegment{}).
		Where("default_ovpn_proto NOT IN ?", []string{"udp", "tcp"}).
		Update("default_ovpn_proto", "udp").Error; err != nil {
		return err
	}

	if err := ensureIPListSources(db); err != nil {
		return err
	}
	if err := upgradeLegacyOverseasIPListSource(db); err != nil {
		return err
	}

	now := time.Now()
	if err := db.Model(&model.Node{}).
		Where("(domestic_ip_list_version IS NULL OR domestic_ip_list_version = '') AND ip_list_version IS NOT NULL AND ip_list_version != ''").
		Updates(map[string]any{
			"domestic_ip_list_version":   gorm.Expr("ip_list_version"),
			"domestic_ip_list_count":     gorm.Expr("ip_list_count"),
			"domestic_ip_list_update_at": gorm.Expr("COALESCE(ip_list_update_at, ?)", now),
		}).Error; err != nil {
		return err
	}

	var count int64
	if err := db.Model(&model.Admin{}).Count(&count).Error; err != nil {
		return err
	}
	if count == 0 {
		hash, err := bcrypt.GenerateFromPassword([]byte("admin123"), bcrypt.DefaultCost)
		if err != nil {
			return err
		}
		admin := model.Admin{Username: "admin", PasswordHash: string(hash), Role: "admin", Permissions: "*"}
		if err := db.Create(&admin).Error; err != nil {
			return err
		}
		db.Create(&model.AuditLog{AdminUser: "system", Action: "seed_admin", Target: "admin", Detail: "created default admin account"})
	}
	return nil
}

// upgradeLegacyOverseasIPListSource 将误配的 china6.txt（IPv6）源改为 IPv4 段列表，避免节点 ipset hash:net 刷屏失败。
func upgradeLegacyOverseasIPListSource(db *gorm.DB) error {
	var src model.IPListSource
	if err := db.Where("scope = ?", "overseas").First(&src).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return err
	}
	if !strings.Contains(src.PrimaryURL, "china6.txt") && !strings.Contains(src.MirrorURL, "china6.txt") {
		return nil
	}
	res := db.Model(&model.IPListSource{}).Where("scope = ?", "overseas").Updates(map[string]any{
		"primary_url":  "https://www.ipdeny.com/ipblocks/data/countries/us.zone",
		"mirror_url":   "https://www.ipdeny.com/ipblocks/data/countries/jp.zone",
		"max_time_sec": 120,
	})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected > 0 {
		log.Printf("vpn-api: upgraded overseas IPListSource (removed china6 IPv6 URLs); run 分流规则「全网立即更新」以重建 overseas 制品")
	}
	return nil
}

func migrateLegacyModeIDs(db *gorm.DB) error {
	return db.Transaction(func(tx *gorm.DB) error {
		updates := map[string]string{
			"local-only":     "node-direct",
			"hk-smart-split": "cn-split",
			"hk-global":      "global",
			"us-global":      "global",
		}
		for from, to := range updates {
			if err := tx.Model(&model.Instance{}).Where("mode = ?", from).Update("mode", to).Error; err != nil {
				return err
			}
		}

		var bad []string
		if err := tx.Model(&model.Instance{}).
			Where("mode NOT IN ?", []string{"node-direct", "cn-split", "global"}).
			Distinct().
			Pluck("mode", &bad).Error; err != nil {
			return err
		}
		if len(bad) > 0 {
			return fmt.Errorf("unsupported instance modes found after migration: %v", bad)
		}
		return nil
	})
}

func ensureIPListSources(db *gorm.DB) error {
	defaults := []model.IPListSource{
		{
			Scope:             "domestic",
			PrimaryURL:        "https://raw.githubusercontent.com/17mon/china_ip_list/master/china_ip_list.txt",
			MirrorURL:         "https://cdn.jsdelivr.net/gh/17mon/china_ip_list@master/china_ip_list.txt",
			ConnectTimeoutSec: 8,
			MaxTimeSec:        30,
			RetryCount:        2,
			Enabled:           true,
		},
		{
			Scope:             "overseas",
			PrimaryURL:        "https://www.ipdeny.com/ipblocks/data/countries/us.zone",
			MirrorURL:         "https://www.ipdeny.com/ipblocks/data/countries/jp.zone",
			ConnectTimeoutSec: 8,
			MaxTimeSec:        120,
			RetryCount:        2,
			Enabled:           true,
		},
	}
	for _, s := range defaults {
		var existing model.IPListSource
		err := db.Where("scope = ?", s.Scope).First(&existing).Error
		if err == nil {
			continue
		}
		if errors.Is(err, gorm.ErrRecordNotFound) {
			if err := db.Create(&s).Error; err != nil {
				return err
			}
			continue
		}
		return err
	}
	return nil
}
