package api

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"vpn-api/internal/config"
	"vpn-api/internal/model"
)

func readFirstLineTrimmed(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	s := strings.TrimSpace(string(b))
	if s == "" {
		return ""
	}
	lines := strings.Split(s, "\n")
	if len(lines) == 0 {
		return ""
	}
	return strings.TrimSpace(lines[0])
}

// effectiveLatestAgentVersion returns the "latest version" used by API for upgrade hints.
// Priority:
// 1) AGENT_LATEST_VERSION (existing behavior; explicit override)
// 2) .agent-release-version near deployment root (auto from deploy script)
// 3) fallback "19700101.000000"
func (h *Handler) effectiveLatestAgentVersion() string {
	if v := strings.TrimSpace(h.agentLatestVersion); v != "" {
		return v
	}
	// deploy-control-plane writes INSTALL_DIR/.agent-release-version.
	// When DB_PATH is INSTALL_DIR/data/vpn.db, we can infer INSTALL_DIR from DB_PATH.
	if strings.EqualFold(h.dbDriver, "sqlite") && strings.TrimSpace(h.dbPath) != "" {
		dp := filepath.Clean(strings.TrimSpace(h.dbPath))
		dataDir := filepath.Dir(dp)
		installDir := filepath.Clean(filepath.Join(dataDir, ".."))
		if v := readFirstLineTrimmed(filepath.Join(installDir, ".agent-release-version")); v != "" {
			return v
		}
	}
	// Secondary candidates for custom layouts.
	if h.caDir != "" {
		parent := filepath.Dir(filepath.Clean(h.caDir))
		if v := readFirstLineTrimmed(filepath.Join(parent, ".agent-release-version")); v != "" {
			return v
		}
	}
	if wd, err := os.Getwd(); err == nil {
		wd = filepath.Clean(wd)
		for _, p := range []string{
			filepath.Join(wd, ".agent-release-version"),
			filepath.Join(wd, "..", ".agent-release-version"),
		} {
			if v := readFirstLineTrimmed(p); v != "" {
				return v
			}
		}
	}
	return "19700101.000000"
}

type createAgentUpgradeReq struct {
	Version      string `json:"version" binding:"required"`
	DownloadURL  string `json:"download_url" binding:"required"`
	DownloadURLLAN string `json:"download_url_lan"`
	SHA256       string `json:"sha256" binding:"required"`
	CanaryNodeID string `json:"canary_node_id"`
}

func (h *Handler) GetAgentUpgradeDefaults(c *gin.Context) {
	base := strings.TrimRight(config.EffectiveExternalBaseURL(c.Request, h.externalURL), "/")
	baseLAN := strings.TrimRight(h.externalURLLAN, "/")

	makeURLs := func(arch string) (string, string) {
		// Use legacy stable download endpoint by default for better compatibility
		// across mixed control-plane versions and reverse-proxy setups.
		pubURL := base + "/api/downloads/vpn-agent-linux-" + arch
		lanURL := ""
		if baseLAN != "" {
			lanURL = baseLAN + "/api/downloads/vpn-agent-linux-" + arch
		}
		return pubURL, lanURL
	}
	shaForArch := func(arch string) string {
		agentPath, err := resolveVPNAgentPath(arch, h.caDir, h.dbPath, h.dbDriver)
		if err != nil {
			return ""
		}
		s, serr := fileSHA256Hex(agentPath)
		if serr != nil {
			return ""
		}
		return s
	}

	var online []model.Node
	if err := h.db.Where("status = ?", "online").Find(&online).Error; err != nil {
		log.Printf("agent upgrade defaults: list online nodes: %v", err)
		online = nil
	}
	amdCount, armCount := 0, 0
	for _, n := range online {
		a := strings.TrimSpace(strings.ToLower(n.AgentArch))
		if a == "arm64" {
			armCount++
		} else if a == "amd64" {
			amdCount++
		}
	}
	recommendedArch := "amd64"
	if armCount > amdCount {
		recommendedArch = "arm64"
	}
	recPub, recLan := makeURLs(recommendedArch)
	recSHA := shaForArch(recommendedArch)
	amdPub, amdLan := makeURLs("amd64")
	armPub, armLan := makeURLs("arm64")

	c.JSON(http.StatusOK, gin.H{
		"defaults": gin.H{
			"version":          h.effectiveLatestAgentVersion(),
			"download_url":     recPub,
			"download_url_lan": recLan,
			"sha256":           recSHA,
			"arch":             recommendedArch,
			"recommended_arch": recommendedArch,
			"online_arch_stats": gin.H{
				"amd64": amdCount,
				"arm64": armCount,
			},
			"candidates": gin.H{
				"amd64": gin.H{
					"download_url":     amdPub,
					"download_url_lan": amdLan,
					"sha256":           shaForArch("amd64"),
				},
				"arm64": gin.H{
					"download_url":     armPub,
					"download_url_lan": armLan,
					"sha256":           shaForArch("arm64"),
				},
			},
		},
	})
}

func nonEmptyOr(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return strings.TrimSpace(v)
}

func fileSHA256Hex(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", h.Sum(nil)), nil
}

func (h *Handler) CreateAgentUpgradeTask(c *gin.Context) {
	var req createAgentUpgradeReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	req.Version = strings.TrimSpace(req.Version)
	req.DownloadURL = strings.TrimSpace(req.DownloadURL)
	req.DownloadURLLAN = strings.TrimSpace(req.DownloadURLLAN)
	req.SHA256 = strings.ToLower(strings.TrimSpace(req.SHA256))
	req.CanaryNodeID = strings.TrimSpace(req.CanaryNodeID)
	if req.Version == "" || req.DownloadURL == "" || len(req.SHA256) != 64 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "version/download_url/sha256 invalid"})
		return
	}

	var nodes []model.Node
	if err := h.db.Where("status = ?", "online").Find(&nodes).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	online := make([]model.Node, 0, len(nodes))
	for _, n := range nodes {
		if h.hub != nil && h.hub.IsOnline(n.ID) {
			online = append(online, n)
		}
	}
	if len(online) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no online nodes"})
		return
	}

	canaryID := req.CanaryNodeID
	if canaryID == "" {
		canaryID = online[0].ID
	}
	canaryFound := false
	for _, n := range online {
		if n.ID == canaryID {
			canaryFound = true
			break
		}
	}
	if !canaryFound {
		c.JSON(http.StatusBadRequest, gin.H{"error": "canary node must be online"})
		return
	}

	adminAny, _ := c.Get("admin")
	adminUser, _ := adminAny.(string)
	task := model.AgentUpgradeTask{
		Version:      req.Version,
		DownloadURL:  req.DownloadURL,
		DownloadURLLAN: req.DownloadURLLAN,
		SHA256:       req.SHA256,
		Strategy:     "canary",
		Status:       "pending",
		CanaryNodeID: canaryID,
		TotalNodes:   len(online),
		CreatedBy:    adminUser,
	}
	if err := h.db.Create(&task).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	for _, n := range online {
		stage := "rollout"
		if n.ID == canaryID {
			stage = "canary"
		}
		item := model.AgentUpgradeTaskItem{
			TaskID: task.ID, NodeID: n.ID, Stage: stage, Status: "prechecking",
		}
		if err := h.db.Create(&item).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	h.audit(c, "create_agent_upgrade", fmt.Sprintf("task:%d", task.ID), fmt.Sprintf("version=%s total=%d canary=%s", task.Version, task.TotalNodes, task.CanaryNodeID))

	go h.runAgentUpgradeTask(task.ID)

	c.JSON(http.StatusCreated, gin.H{"task": task})
}

func (h *Handler) GetAgentUpgradeTask(c *gin.Context) {
	id := c.Param("id")
	var task model.AgentUpgradeTask
	if err := h.db.First(&task, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "task not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"task": task})
}

func (h *Handler) ListAgentUpgradeTaskItems(c *gin.Context) {
	id := c.Param("id")
	var items []model.AgentUpgradeTaskItem
	if err := h.db.Where("task_id = ?", id).Order("id asc").Find(&items).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

func (h *Handler) ListNodeUpgradeStatus(c *gin.Context) {
	type row struct {
		NodeID        string    `json:"node_id"`
		TaskID        uint      `json:"task_id"`
		TaskStatus    string    `json:"task_status"`
		ItemStatus    string    `json:"item_status"`
		Step          string    `json:"step"`
		ErrorCode     string    `json:"error_code"`
		Message       string    `json:"message"`
		StderrTail    string    `json:"stderr_tail"`
		TargetVersion string    `json:"target_version"`
		ResultVersion string    `json:"result_version"`
		UpdatedAt     time.Time `json:"updated_at"`
	}
	var rows []row
	q := `
SELECT i.node_id, i.task_id, t.status AS task_status, i.status AS item_status, i.step, i.error_code, i.message, i.stderr_tail,
       t.version AS target_version, i.result_version, i.updated_at
FROM agent_upgrade_task_items i
JOIN agent_upgrade_tasks t ON t.id = i.task_id
JOIN (
  SELECT node_id, MAX(updated_at) AS max_updated
  FROM agent_upgrade_task_items
  GROUP BY node_id
) latest ON latest.node_id = i.node_id AND latest.max_updated = i.updated_at
ORDER BY i.updated_at DESC;
`
	if err := h.db.Raw(q).Scan(&rows).Error; err != nil {
		log.Printf("agent upgrade status: scan: %v", err)
		rows = nil
	}

	type item struct {
		NodeID        string `json:"node_id"`
		TaskID        uint   `json:"task_id"`
		TaskStatus    string `json:"task_status"`
		ItemStatus    string `json:"item_status"`
		Step          string `json:"step"`
		ErrorCode     string `json:"error_code"`
		Message       string `json:"message"`
		StderrTail    string `json:"stderr_tail"`
		TargetVersion string `json:"target_version"`
		ResultVersion string `json:"result_version"`
		UpdatedAt     string `json:"updated_at"`
		NeedsUpdate   bool   `json:"needs_update"`
	}
	latest := h.effectiveLatestAgentVersion()
	out := make([]item, 0, len(rows))
	for _, r := range rows {
		cur := strings.TrimSpace(r.ResultVersion)
		if cur == "" {
			cur = strings.TrimSpace(r.TargetVersion)
		}
		out = append(out, item{
			NodeID:        r.NodeID,
			TaskID:        r.TaskID,
			TaskStatus:    r.TaskStatus,
			ItemStatus:    r.ItemStatus,
			Step:          r.Step,
			ErrorCode:     r.ErrorCode,
			Message:       r.Message,
			StderrTail:    r.StderrTail,
			TargetVersion: r.TargetVersion,
			ResultVersion: r.ResultVersion,
			UpdatedAt:     r.UpdatedAt.Format(time.RFC3339),
			NeedsUpdate:   compareSemver(cur, latest) < 0,
		})
	}
	c.JSON(http.StatusOK, gin.H{
		"latest_version": latest,
		"items":          out,
	})
}

func (h *Handler) runAgentUpgradeTask(taskID uint) {
	var task model.AgentUpgradeTask
	if err := h.db.First(&task, taskID).Error; err != nil {
		return
	}
	now := time.Now()
	h.db.Model(&model.AgentUpgradeTask{}).Where("id = ?", taskID).Updates(map[string]any{
		"status":     "running",
		"started_at": &now,
	})

	var items []model.AgentUpgradeTaskItem
	if err := h.db.Where("task_id = ?", taskID).Order("id asc").Find(&items).Error; err != nil {
		return
	}
	urls := make([]string, 0, 2)
	if strings.TrimSpace(task.DownloadURLLAN) != "" {
		urls = append(urls, strings.TrimSpace(task.DownloadURLLAN))
	}
	if strings.TrimSpace(task.DownloadURL) != "" {
		urls = append(urls, strings.TrimSpace(task.DownloadURL))
	}
	for _, it := range items {
		if nodeSupportsCapability(h.db, it.NodeID, "upgrade_precheck") {
			h.dispatchUpgradePrecheck(taskID, it, urls, 25*time.Second)
		} else {
			h.db.Model(&model.AgentUpgradeTaskItem{}).Where("id = ? AND status = ?", it.ID, "prechecking").Updates(map[string]any{
				"status":  "pending",
				"step":    "precheck",
				"message": "legacy_agent: precheck skipped",
			})
		}
	}
	if err := h.db.Where("task_id = ?", taskID).Order("id asc").Find(&items).Error; err != nil {
		return
	}
	var canary *model.AgentUpgradeTaskItem
	var rollout []model.AgentUpgradeTaskItem
	for i := range items {
		if items[i].Status != "pending" {
			continue
		}
		if items[i].Stage == "canary" {
			canary = &items[i]
		} else {
			rollout = append(rollout, items[i])
		}
	}
	if canary == nil {
		// All candidates may fail at precheck stage. Reuse finalize logic so
		// success/failed counters are populated consistently for the UI.
		h.db.Model(&model.AgentUpgradeTask{}).Where("id = ?", taskID).Updates(map[string]any{
			"status":        "failed",
			"error_summary": "canary precheck failed or unavailable",
		})
		h.finalizeUpgradeTask(taskID)
		return
	}

	if !h.dispatchUpgradeTaskItem(task, *canary, 3*time.Minute) {
		h.db.Model(&model.AgentUpgradeTaskItem{}).Where("task_id = ? AND id <> ? AND status = ?", taskID, canary.ID, "pending").Updates(map[string]any{
			"status":  "skipped",
			"message": "canary failed",
		})
		h.finalizeUpgradeTask(taskID)
		return
	}

	sem := make(chan struct{}, 5)
	var wg sync.WaitGroup
	for _, it := range rollout {
		it := it
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			_ = h.dispatchUpgradeTaskItem(task, it, 3*time.Minute)
		}()
	}
	wg.Wait()
	h.finalizeUpgradeTask(taskID)
}

func (h *Handler) dispatchUpgradeTaskItem(task model.AgentUpgradeTask, item model.AgentUpgradeTaskItem, timeout time.Duration) bool {
	h.db.Model(&model.AgentUpgradeTaskItem{}).Where("id = ?", item.ID).Updates(map[string]any{
		"status":  "running",
		"step":    "dispatch",
		"message": "dispatching upgrade command",
	})

	payload, merr := json.Marshal(map[string]any{
		"task_id":         task.ID,
		"version":         task.Version,
		"download_urls":   buildUpgradeURLs(task.DownloadURLLAN, task.DownloadURL),
		"sha256":          task.SHA256,
		"restart_service": true,
	})
	if merr != nil {
		log.Printf("dispatchUpgradeTaskItem: marshal upgrade_agent: %v", merr)
		h.db.Model(&model.AgentUpgradeTaskItem{}).Where("id = ?", item.ID).Updates(map[string]any{
			"status":  "failed",
			"message": "marshal upgrade payload failed",
		})
		return false
	}
	if h.hub == nil || h.hub.SendToNode(item.NodeID, WSMessage{Type: "upgrade_agent", Payload: payload}) != nil {
		h.db.Model(&model.AgentUpgradeTaskItem{}).Where("id = ?", item.ID).Updates(map[string]any{
			"status":  "failed",
			"message": "agent is offline or ws send failed",
		})
		return false
	}

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		time.Sleep(2 * time.Second)
		var cur model.AgentUpgradeTaskItem
		if err := h.db.First(&cur, item.ID).Error; err != nil {
			return false
		}
		if cur.Status == "succeeded" {
			return true
		}
		if cur.Status == "verifying" {
			if verifyNodeVersionApplied(h.db, item.NodeID, task.Version) {
				now := time.Now()
				h.db.Model(&model.AgentUpgradeTaskItem{}).Where("id = ?", item.ID).Updates(map[string]any{
					"status":       "succeeded",
					"step":         "verify_version",
					"message":      "node reported target version",
					"result_version": task.Version,
					"last_seen_at":  &now,
				})
				return true
			}
		}
		if cur.Status == "failed" {
			return false
		}
	}
	h.db.Model(&model.AgentUpgradeTaskItem{}).Where("id = ? AND status = ?", item.ID, "running").Updates(map[string]any{
		"status":  "timeout",
		"message": "upgrade timed out",
		"error_code": "upgrade_timeout",
	})
	h.db.Model(&model.AgentUpgradeTaskItem{}).Where("id = ? AND status = ?", item.ID, "verifying").Updates(map[string]any{
		"status":  "failed",
		"step":    "verify_version",
		"message": "version_not_applied before timeout",
		"error_code": "version_not_applied",
	})
	return false
}

func buildUpgradeURLs(lan, pub string) []string {
	out := make([]string, 0, 2)
	seen := map[string]bool{}
	for _, raw := range []string{strings.TrimSpace(lan), strings.TrimSpace(pub)} {
		if raw == "" || seen[raw] {
			continue
		}
		out = append(out, raw)
		seen[raw] = true
	}
	return out
}

func (h *Handler) dispatchUpgradePrecheck(taskID uint, item model.AgentUpgradeTaskItem, urls []string, timeout time.Duration) {
	payload, merr := json.Marshal(map[string]any{
		"task_id":       taskID,
		"download_urls": urls,
	})
	if merr != nil {
		log.Printf("dispatchUpgradePrecheck: marshal payload: %v", merr)
		h.db.Model(&model.AgentUpgradeTaskItem{}).Where("id = ?", item.ID).Updates(map[string]any{
			"status":     "failed",
			"step":       "precheck",
			"error_code": "marshal_failed",
			"message":    "marshal precheck payload failed",
		})
		return
	}
	if h.hub == nil || h.hub.SendToNode(item.NodeID, WSMessage{Type: "upgrade_precheck", Payload: payload}) != nil {
		h.db.Model(&model.AgentUpgradeTaskItem{}).Where("id = ?", item.ID).Updates(map[string]any{
			"status":  "failed",
			"step":    "precheck",
			"error_code": "ws_send_failed",
			"message": "unreachable: ws send failed",
		})
		return
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		time.Sleep(1500 * time.Millisecond)
		var cur model.AgentUpgradeTaskItem
		if err := h.db.First(&cur, item.ID).Error; err != nil {
			return
		}
		if cur.Status == "pending" || cur.Status == "failed" {
			return
		}
	}
	h.db.Model(&model.AgentUpgradeTaskItem{}).Where("id = ? AND status = ?", item.ID, "prechecking").Updates(map[string]any{
		"status":  "failed",
		"step":    "precheck",
		"error_code": "precheck_timeout",
		"message": "unreachable: precheck timeout",
	})
}

func nodeSupportsCapability(db *gorm.DB, nodeID, capability string) bool {
	var n model.Node
	if err := db.Select("agent_capabilities").Where("id = ?", nodeID).First(&n).Error; err != nil {
		return false
	}
	capability = strings.TrimSpace(capability)
	if capability == "" {
		return false
	}
	for _, c := range strings.Split(strings.TrimSpace(n.AgentCapabilities), ",") {
		if strings.TrimSpace(c) == capability {
			return true
		}
	}
	return false
}

func verifyNodeVersionApplied(db *gorm.DB, nodeID, target string) bool {
	var n model.Node
	if err := db.Select("agent_version").Where("id = ?", nodeID).First(&n).Error; err != nil {
		return false
	}
	return compareSemver(n.AgentVersion, target) >= 0
}

func compareSemver(a, b string) int {
	parse := func(v string) [3]int {
		v = strings.TrimSpace(strings.TrimPrefix(strings.ToLower(v), "v"))
		out := [3]int{0, 0, 0}
		parts := strings.Split(v, ".")
		for i := 0; i < len(parts) && i < 3; i++ {
			n, _ := strconv.Atoi(strings.TrimSpace(parts[i]))
			out[i] = n
		}
		return out
	}
	av := parse(a)
	bv := parse(b)
	for i := 0; i < 3; i++ {
		if av[i] > bv[i] {
			return 1
		}
		if av[i] < bv[i] {
			return -1
		}
	}
	return 0
}

func (h *Handler) finalizeUpgradeTask(taskID uint) {
	var total, success, failed int64
	h.db.Model(&model.AgentUpgradeTaskItem{}).Where("task_id = ?", taskID).Count(&total)
	h.db.Model(&model.AgentUpgradeTaskItem{}).Where("task_id = ? AND status = ?", taskID, "succeeded").Count(&success)
	h.db.Model(&model.AgentUpgradeTaskItem{}).Where("task_id = ? AND status IN ?", taskID, []string{"failed", "timeout"}).Count(&failed)
	status := "succeeded"
	summary := ""
	if failed > 0 {
		status = "failed"
		summary = fmt.Sprintf("failed=%d", failed)
	}
	finish := time.Now()
	h.db.Model(&model.AgentUpgradeTask{}).Where("id = ?", taskID).Updates(map[string]any{
		"status":        status,
		"success_count": int(success),
		"failed_count":  int(failed),
		"error_summary": summary,
		"finished_at":   &finish,
	})
}
