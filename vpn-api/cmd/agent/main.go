package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"vpn-api/internal/debuglog"
	"vpn-api/internal/service"
)

type Config struct {
	APIURL     string `json:"api_url"`
	NodeToken  string `json:"node_token"`
	NodeID     string `json:"node_id"`
	EasyRSADir string `json:"easyrsa_dir"`
}

type WSMessage struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

const defaultAgentVersion = "0.2.1"

// buildVersion can be injected by -ldflags "-X main.buildVersion=vX.Y.Z".
var buildVersion string
var startupIPListReportOnce sync.Once

func agentVersion() string {
	if strings.TrimSpace(buildVersion) != "" {
		return strings.TrimSpace(buildVersion)
	}
	return defaultAgentVersion
}

// versionsEqualForUpgrade compares upgrade target vs self-reported version, ignoring optional "v" prefix.
func versionsEqualForUpgrade(a, b string) bool {
	a = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(a), "v"))
	b = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(b), "v"))
	return a == b
}

func main() {
	cfgPath := flag.String("config", "/etc/vpn-agent/agent.yaml", "agent config file (JSON)")
	flag.Parse()

	cfg, err := loadConfig(*cfgPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	if cfg.EasyRSADir == "" {
		cfg.EasyRSADir = "/etc/openvpn/server/easy-rsa"
	}

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-sigs
		log.Println("shutting down agent")
		os.Exit(0)
	}()

	go cronIPListUpdate(cfg)

	var activeConn *websocket.Conn
	var connMu sync.Mutex

	go cronHealthReport(&activeConn, &connMu, cfg)
	go monitorTunnelFailover(&activeConn, &connMu, cfg)
	go cronCertRenewal(&activeConn, &connMu, cfg)

	for {
		if err := connectAndServe(cfg, &activeConn, &connMu); err != nil {
			log.Printf("connection error: %v, reconnecting in 10s", err)
		}
		time.Sleep(10 * time.Second)
	}
}

func loadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func connectAndServe(cfg *Config, activeConn **websocket.Conn, connMu *sync.Mutex) error {
	u, err := url.Parse(cfg.APIURL)
	if err != nil {
		return err
	}
	scheme := "ws"
	if u.Scheme == "https" {
		scheme = "wss"
	}
	wsURL := fmt.Sprintf("%s://%s/api/agent/ws?token=%s", scheme, u.Host, cfg.NodeToken)

	log.Printf("connecting to %s", wsURL)
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer func() {
		connMu.Lock()
		*activeConn = nil
		connMu.Unlock()
		conn.Close()
	}()
	connMu.Lock()
	*activeConn = conn
	connMu.Unlock()
	log.Printf("connected, node=%s", cfg.NodeID)

	sendReport(conn, cfg)
	sendStartupIPListStatus(conn)

	heartbeat := time.NewTicker(30 * time.Second)
	defer heartbeat.Stop()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				log.Printf("read error: %v", err)
				return
			}
			var msg WSMessage
			if json.Unmarshal(raw, &msg) != nil {
				continue
			}
			handleCommand(conn, cfg, msg)
		}
	}()

	for {
		select {
		case <-done:
			return fmt.Errorf("connection closed")
		case <-heartbeat.C:
			msg := WSMessage{Type: "heartbeat"}
			data, _ := json.Marshal(msg)
			if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
				return fmt.Errorf("heartbeat write: %w", err)
			}
		}
	}
}

func sendReport(conn *websocket.Conn, cfg *Config) {
	wgKey := readWGPublicKey()
	payload, _ := json.Marshal(map[string]any{
		"agent_version": agentVersion(),
		"agent_arch":    runtime.GOARCH,
		"wg_pubkey":     wgKey,
		"capabilities":  []string{"upgrade_agent_v2", "upgrade_precheck"},
	})
	msg := WSMessage{Type: "report", Payload: payload}
	data, _ := json.Marshal(msg)
	conn.WriteMessage(websocket.TextMessage, data)
}

func sendStartupIPListStatus(conn *websocket.Conn) {
	startupIPListReportOnce.Do(func() {
		for _, scope := range []string{"domestic", "overseas"} {
			count := countIPListEntries(scope)
			if count <= 0 {
				continue
			}
			version := ipListLocalVersion(scope)
			sendResult(conn, "iplist_result", map[string]any{
				"success":     true,
				"scope":       scope,
				"version":     version,
				"entry_count": count,
			})
			log.Printf("startup iplist status reported: scope=%s version=%s entries=%d", scope, version, count)
		}
	})
}

func ipListLocalVersion(scope string) string {
	p := ipListLocalFile(scope)
	fi, err := os.Stat(p)
	if err != nil {
		return time.Now().Format("20060102-150405")
	}
	return fi.ModTime().Format("20060102-150405")
}

const wgPublicKeyFile = "/etc/wireguard/publickey"

func readWGPublicKey() string {
	if data, err := os.ReadFile(wgPublicKeyFile); err == nil {
		s := strings.TrimSpace(string(data))
		if s != "" {
			return s
		}
	}
	out, err := exec.Command("wg", "show", "all", "public-key").Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			return line
		}
	}
	return ""
}

func normalizeOpenVPNProto(s string) string {
	if strings.ToLower(strings.TrimSpace(s)) == "tcp" {
		return "tcp"
	}
	return "udp"
}

// instanceRow matches bootstrap / control-plane instance JSON.
type instanceRow struct {
	Mode  string `json:"mode"`
	Proto string `json:"proto"`
	Port  int    `json:"port"`
}

// parseInstancesFromNodeConfigJSON extracts instances from:
//   - top-level { "instances": [ ... ] } (bootstrap-node.json, register response),
//   - { "config": { "instances": [ ... ] } } or { "config": "<json string>" } (last-config.json after rollback).
func parseInstancesFromNodeConfigJSON(data []byte) []instanceRow {
	var parseInner func(raw []byte) []instanceRow
	parseInner = func(raw []byte) []instanceRow {
		if len(raw) == 0 {
			return nil
		}
		var asList []instanceRow
		if json.Unmarshal(raw, &asList) == nil && len(asList) > 0 {
			return asList
		}
		var asObj struct {
			Instances []instanceRow `json:"instances"`
		}
		if json.Unmarshal(raw, &asObj) == nil && len(asObj.Instances) > 0 {
			return asObj.Instances
		}
		var asStr string
		if json.Unmarshal(raw, &asStr) == nil && strings.TrimSpace(asStr) != "" {
			return parseInner([]byte(asStr))
		}
		return nil
	}
	var root map[string]json.RawMessage
	if json.Unmarshal(data, &root) != nil {
		return nil
	}
	if raw, ok := root["instances"]; ok {
		if list := parseInner(raw); len(list) > 0 {
			return list
		}
	}
	if raw, ok := root["config"]; ok {
		if list := parseInner(raw); len(list) > 0 {
			return list
		}
	}
	return nil
}

// protoFromLocalOVPNBootstrap returns instances[].proto for the given mode from last-config.json, then bootstrap-node.json.
// last-config is written when the control plane pushes update_config (or rollback); bootstrap is node-setup ground truth.
func protoFromLocalOVPNBootstrap(mode string) string {
	mode = strings.TrimSpace(mode)
	if mode == "" {
		return ""
	}
	for _, path := range []string{"/etc/vpn-agent/last-config.json", "/etc/vpn-agent/bootstrap-node.json"} {
		data, err := os.ReadFile(path)
		if err != nil {
			// #region debug session 892464
			debuglog.Line("H2", "agent:protoFromLocalOVPNBootstrap", "file read", map[string]any{"path": path, "ok": false})
			// #endregion
			continue
		}
		list := parseInstancesFromNodeConfigJSON(data)
		// #region debug session 892464
		debuglog.Line("H3", "agent:protoFromLocalOVPNBootstrap", "parsed", map[string]any{"path": path, "instance_count": len(list), "want_mode": mode})
		// #endregion
		for _, in := range list {
			if in.Mode == mode {
				return normalizeOpenVPNProto(in.Proto)
			}
		}
	}
	return ""
}

// resolveClientProtoForIssueCert uses the control-plane (API) proto when the request carries a non-empty value so
// .ovpn remote port/proto stay consistent with DB; if proto is omitted, falls back to last-config then bootstrap.
func resolveClientProtoForIssueCert(apiProto, mode string) string {
	if strings.TrimSpace(apiProto) != "" {
		apiP := normalizeOpenVPNProto(apiProto)
		// #region debug session 892464
		debuglog.Line("H1", "agent:resolveClientProtoForIssueCert", "resolved", map[string]any{
			"mode": mode, "api_proto": apiP, "chosen": apiP, "source": "api",
		})
		// #endregion
		return apiP
	}
	localP := protoFromLocalOVPNBootstrap(mode)
	if localP == "" {
		localP = "udp"
	}
	// #region debug session 892464
	debuglog.Line("H1", "agent:resolveClientProtoForIssueCert", "resolved", map[string]any{
		"mode": mode, "local_proto": localP, "chosen": localP, "source": "local_fallback",
	})
	// #endregion
	return localP
}

func handleCommand(conn *websocket.Conn, cfg *Config, msg WSMessage) {
	switch msg.Type {
	case "issue_cert":
		var req struct {
			CertCN     string `json:"cert_cn"`
			RemoteHost string `json:"remote_host"`
			Port       int    `json:"port"`
			Proto      string `json:"proto"`
			Mode       string `json:"mode"`
		}
		if json.Unmarshal(msg.Payload, &req) != nil {
			return
		}
		proto := resolveClientProtoForIssueCert(req.Proto, req.Mode)
		log.Printf("issuing cert: %s proto=%s (mode=%q)", req.CertCN, proto, req.Mode)
		ovpnTCP, ovpnUDP, err := issueCertPair(cfg, req.CertCN, req.RemoteHost, req.Port)
		result := map[string]any{"cert_cn": req.CertCN}
		if err != nil {
			result["success"] = false
			result["error"] = err.Error()
		} else {
			result["success"] = true
			result["ovpn_tcp"] = string(ovpnTCP)
			result["ovpn_udp"] = string(ovpnUDP)
			if proto == "tcp" {
				result["ovpn"] = string(ovpnTCP)
			} else {
				result["ovpn"] = string(ovpnUDP)
			}
		}
		sendResult(conn, "cert_result", result)

	case "revoke_cert":
		var req struct {
			CertCN string `json:"cert_cn"`
		}
		if json.Unmarshal(msg.Payload, &req) != nil {
			return
		}
		log.Printf("revoking cert: %s", req.CertCN)
		err := revokeCert(cfg, req.CertCN)
		result := map[string]any{"cert_cn": req.CertCN}
		if err != nil {
			result["success"] = false
			result["error"] = err.Error()
		} else {
			result["success"] = true
		}
		sendResult(conn, "cert_result", result)

	case "update_config":
		log.Printf("received config update, applying...")
		if !json.Valid(msg.Payload) {
			log.Printf("config update: invalid JSON payload, ignored")
			return
		}
		if err := os.WriteFile("/etc/vpn-agent/last-config.json", msg.Payload, 0600); err != nil {
			log.Printf("config update: write last-config.json: %v", err)
			return
		}
		log.Printf("config saved to /etc/vpn-agent/last-config.json")
		applyOpenVPNServerFromInstancesPayload(msg.Payload)

	case "update_exceptions":
		log.Printf("applying exception rules...")
		var payload struct {
			Exceptions []exceptionRule `json:"exceptions"`
		}
		if json.Unmarshal(msg.Payload, &payload) != nil {
			return
		}
		applyExceptions(payload.Exceptions)

	case "update_iplist":
		var req struct {
			Scope       string `json:"scope"`
			Version     string `json:"version"`
			DownloadURL string `json:"download_url"`
		}
		_ = json.Unmarshal(msg.Payload, &req)
		scope := normalizeIPListScope(req.Scope)
		scopes := []string{scope}
		if scope == "all" {
			scopes = []string{"domestic", "overseas"}
		}
		for _, sc := range scopes {
			log.Printf("updating ip-list scope=%s ...", sc)
			err := updateIPListFromAPI(cfg, sc, req.DownloadURL, req.Version)
			result := map[string]any{"scope": sc}
			if err != nil {
				result["success"] = false
				result["error"] = err.Error()
			} else {
				result["success"] = true
				result["version"] = time.Now().Format("20060102-150405")
				if cnt := countIPListEntries(sc); cnt > 0 {
					result["entry_count"] = cnt
				}
			}
			sendResult(conn, "iplist_result", result)
		}
	case "upgrade_agent":
		var req struct {
			TaskID         uint     `json:"task_id"`
			Version        string   `json:"version"`
			DownloadURLs   []string `json:"download_urls"`
			SHA256         string   `json:"sha256"`
			RestartService bool     `json:"restart_service"`
		}
		if json.Unmarshal(msg.Payload, &req) != nil {
			return
		}
		log.Printf("upgrade_agent: task=%d version=%s", req.TaskID, req.Version)
		execRes := performAgentUpgrade(req.Version, req.DownloadURLs, req.SHA256, req.RestartService)
		res := map[string]any{
			"task_id":         req.TaskID,
			"success":         execRes.Success,
			"current_version": agentVersion(),
			"step":            execRes.Step,
			"error_code":      execRes.ErrorCode,
			"stdout_tail":     execRes.StdoutTail,
			"stderr_tail":     execRes.StderrTail,
		}
		if execRes.Success && strings.TrimSpace(req.Version) != "" {
			res["current_version"] = strings.TrimSpace(req.Version)
		}
		if !execRes.Success && strings.TrimSpace(execRes.Error) != "" {
			res["error"] = execRes.Error
		}
		sendResult(conn, "upgrade_result", res)
	case "upgrade_precheck":
		var req struct {
			TaskID       uint     `json:"task_id"`
			DownloadURLs []string `json:"download_urls"`
		}
		if json.Unmarshal(msg.Payload, &req) != nil {
			return
		}
		ok, selected, err := precheckDownloadURLs(req.DownloadURLs)
		res := map[string]any{
			"task_id":      req.TaskID,
			"success":      ok,
			"selected_url": selected,
		}
		if err != nil {
			res["error"] = err.Error()
		}
		sendResult(conn, "upgrade_precheck_result", res)
	}
}

func sendResult(conn *websocket.Conn, msgType string, payload any) {
	p, _ := json.Marshal(payload)
	msg := WSMessage{Type: msgType, Payload: p}
	data, _ := json.Marshal(msg)
	conn.WriteMessage(websocket.TextMessage, data)
}

func precheckDownloadURLs(urls []string) (bool, string, error) {
	lastErr := ""
	for _, u := range urls {
		u = strings.TrimSpace(u)
		if u == "" {
			continue
		}
		cmd := exec.Command("bash", "-lc", fmt.Sprintf("curl -m 5 -fsSI %q >/dev/null || wget -T 5 --spider -q %q", u, u))
		if out, err := cmd.CombinedOutput(); err == nil {
			return true, u, nil
		} else {
			lastErr = strings.TrimSpace(string(out))
			if lastErr == "" {
				lastErr = err.Error()
			}
			lastErr = fmt.Sprintf("%s (%s)", lastErr, u)
		}
	}
	if lastErr == "" {
		lastErr = "no valid download url"
	}
	return false, "", fmt.Errorf(lastErr)
}

type upgradeExecResult struct {
	Success    bool
	Step       string
	ErrorCode  string
	Error      string
	StdoutTail string
	StderrTail string
}

func tailText(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return "..." + s[len(s)-max:]
}

func performAgentUpgrade(version string, downloadURLs []string, expectedSHA256 string, restartService bool) upgradeExecResult {
	result := upgradeExecResult{Step: "validate"}
	version = strings.TrimSpace(version)
	expectedSHA256 = strings.ToLower(strings.TrimSpace(expectedSHA256))
	if version == "" || len(expectedSHA256) != 64 {
		result.ErrorCode = "invalid_payload"
		result.Error = "invalid upgrade payload"
		return result
	}
	if versionsEqualForUpgrade(version, agentVersion()) {
		result.Success = true
		result.Step = "noop"
		return result
	}
	urls := make([]string, 0, len(downloadURLs))
	for _, u := range downloadURLs {
		if t := strings.TrimSpace(u); t != "" {
			urls = append(urls, t)
		}
	}
	if len(urls) == 0 {
		result.ErrorCode = "invalid_payload"
		result.Error = "invalid upgrade payload: download urls empty"
		return result
	}
	tmpPath := fmt.Sprintf("/tmp/vpn-agent.%d.bin", time.Now().UnixNano())
	var lastErr string
	usedURL := ""
	result.Step = "download"
	for _, u := range urls {
		dlCmd := exec.Command("bash", "-lc", fmt.Sprintf("curl -fsSL %q -o %q || wget -qO %q %q", u, tmpPath, tmpPath, u))
		if out, err := dlCmd.CombinedOutput(); err != nil {
			lastErr = fmt.Sprintf("download_failed[%s]: %v %s", u, err, strings.TrimSpace(string(out)))
			result.StderrTail = tailText(string(out), 700)
			continue
		}
		usedURL = u
		result.StdoutTail = tailText(fmt.Sprintf("download ok: %s", u), 700)
		lastErr = ""
		break
	}
	if lastErr != "" {
		result.ErrorCode = "download_failed"
		result.Error = lastErr
		return result
	}
	result.Step = "verify_hash"
	data, err := os.ReadFile(tmpPath)
	if err != nil {
		result.ErrorCode = "read_tmp_failed"
		result.Error = fmt.Sprintf("read tmp binary: %v", err)
		return result
	}
	got := fmt.Sprintf("%x", sha256.Sum256(data))
	if got != expectedSHA256 {
		result.ErrorCode = "sha256_mismatch"
		result.Error = fmt.Sprintf("sha256_mismatch[%s]: got=%s", usedURL, got)
		return result
	}
	result.Step = "replace"
	if err := os.WriteFile("/usr/local/bin/vpn-agent", data, 0755); err != nil {
		result.ErrorCode = "replace_failed"
		result.Error = fmt.Sprintf("replace binary: %v", err)
		return result
	}
	_ = os.Remove(tmpPath)

	if restartService {
		result.Step = "restart"
		// Delay restart slightly so this process can send upgrade_result first.
		reCmd := exec.Command("bash", "-lc", "nohup sh -c 'sleep 1; systemctl restart vpn-agent' >/tmp/vpn-agent-upgrade.log 2>&1 &")
		if out, err := reCmd.CombinedOutput(); err != nil {
			result.ErrorCode = "restart_launch_failed"
			result.Error = fmt.Sprintf("restart launch failed: %v", err)
			result.StderrTail = tailText(string(out), 700)
			return result
		}
	}
	result.Success = true
	return result
}

func buildOvpnProfileBytes(remoteHost string, port int, proto string, inline []byte) []byte {
	p := normalizeOpenVPNProto(proto)
	hdr := service.OpenVPNClientProfileHeader(remoteHost, port, p)
	var buf strings.Builder
	buf.WriteString(hdr)
	buf.Write(inline)
	return []byte(buf.String())
}

// issueCertPair runs easyrsa once and returns full client profiles for TCP and UDP (same certs, different proto line).
func issueCertPair(cfg *Config, certCN, remoteHost string, port int) (tcp []byte, udp []byte, err error) {
	easyrsaBin := filepath.Join(cfg.EasyRSADir, "easyrsa")

	cmd := exec.Command(easyrsaBin, "--days=3650", "build-client-full", certCN, "nopass")
	cmd.Dir = cfg.EasyRSADir
	cmd.Env = append(os.Environ(), "EASYRSA_BATCH=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		return nil, nil, fmt.Errorf("build-client-full: %w\n%s", err, out)
	}

	inlinePath := filepath.Join(cfg.EasyRSADir, "pki", "inline", "private", certCN+".inline")
	var inline []byte
	if raw, rerr := os.ReadFile(inlinePath); rerr == nil {
		cleaned := service.StripInlineComments(raw)
		sanitized, serr := service.SanitizeOpenVPNInlineAppend(cleaned)
		if serr != nil || !bytes.Contains(sanitized, []byte("<ca>")) {
			if serr != nil {
				log.Printf("sanitize inline for %s: %v, assembling from PKI files", certCN, serr)
			}
			inline, err = service.BuildSanitizedInlineAppendFromEasyRSA(cfg.EasyRSADir, certCN)
			if err != nil {
				return nil, nil, fmt.Errorf("assemble inline from PKI: %w", err)
			}
		} else {
			inline = sanitized
		}
	} else {
		inline, err = service.BuildSanitizedInlineAppendFromEasyRSA(cfg.EasyRSADir, certCN)
		if err != nil {
			return nil, nil, fmt.Errorf("read inline: %w", err)
		}
	}

	tcp = buildOvpnProfileBytes(remoteHost, port, "tcp", inline)
	udp = buildOvpnProfileBytes(remoteHost, port, "udp", inline)
	return tcp, udp, nil
}

func revokeCert(cfg *Config, certCN string) error {
	easyrsaBin := filepath.Join(cfg.EasyRSADir, "easyrsa")

	cmd := exec.Command(easyrsaBin, "revoke", certCN)
	cmd.Dir = cfg.EasyRSADir
	cmd.Env = append(os.Environ(), "EASYRSA_BATCH=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("revoke: %w\n%s", err, out)
	}

	cmd = exec.Command(easyrsaBin, "--days=3650", "gen-crl")
	cmd.Dir = cfg.EasyRSADir
	cmd.Env = append(os.Environ(), "EASYRSA_BATCH=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("gen-crl: %w\n%s", err, out)
	}

	return nil
}

func normalizeIPListScope(scope string) string {
	switch strings.ToLower(strings.TrimSpace(scope)) {
	case "", "domestic":
		return "domestic"
	case "overseas":
		return "overseas"
	case "all":
		return "all"
	default:
		return "domestic"
	}
}

func ipListLocalFile(scope string) string {
	if scope == "overseas" {
		return "/etc/vpn-agent/overseas-ip-list.txt"
	}
	return "/etc/vpn-agent/cn-ip-list.txt"
}

func ipSetName(scope string) string {
	if scope == "overseas" {
		return "overseas-ip"
	}
	return "china-ip"
}

func updateIPListFromAPI(cfg *Config, scope, downloadURL, version string) error {
	scope = normalizeIPListScope(scope)
	if scope == "all" {
		return fmt.Errorf("invalid scope for single update")
	}
	targetURL := strings.TrimSpace(downloadURL)
	if targetURL == "" {
		base := strings.TrimRight(strings.TrimSpace(cfg.APIURL), "/")
		targetURL = fmt.Sprintf("%s/api/ip-lists/download/%s", base, scope)
		if strings.TrimSpace(version) != "" {
			targetURL = targetURL + "?version=" + url.QueryEscape(strings.TrimSpace(version))
		}
	}
	resp, err := http.Get(targetURL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("download failed status=%d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	lines := strings.Split(strings.ReplaceAll(string(body), "\r\n", "\n"), "\n")
	filtered := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		filtered = append(filtered, line)
	}
	if len(filtered) == 0 {
		return fmt.Errorf("empty ip list")
	}
	content := strings.Join(filtered, "\n") + "\n"
	tmpFile := filepath.Join(os.TempDir(), fmt.Sprintf("iplist-%s-%d.txt", scope, time.Now().UnixNano()))
	if err := os.WriteFile(tmpFile, []byte(content), 0o644); err != nil {
		return err
	}
	defer os.Remove(tmpFile)
	setName := ipSetName(scope)
	script := fmt.Sprintf(`#!/bin/bash
set -euo pipefail
TMPFILE=%q
SET_NAME=%q
NEW_SET="${SET_NAME}-new"
ipset create "$NEW_SET" hash:net -exist
ipset flush "$NEW_SET"
while IFS= read -r cidr; do
  [[ -z "$cidr" || "$cidr" == \#* ]] && continue
  ipset add "$NEW_SET" "$cidr" -exist
done < "$TMPFILE"
ipset create "$SET_NAME" hash:net -exist
ipset swap "$NEW_SET" "$SET_NAME"
ipset destroy "$NEW_SET" 2>/dev/null || true
`, tmpFile, setName)
	cmd := exec.Command("bash", "-c", script)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("apply ipset failed: %w %s", err, strings.TrimSpace(string(out)))
	}
	if err := os.WriteFile(ipListLocalFile(scope), []byte(content), 0o644); err != nil {
		return err
	}
	if scope == "domestic" {
		_ = exec.Command("bash", "-c", "[[ -x /etc/vpn-agent/policy-routing.sh ]] && /etc/vpn-agent/policy-routing.sh || true").Run()
	}
	return nil
}

func countIPListEntries(scope string) int {
	data, err := os.ReadFile(ipListLocalFile(scope))
	if err != nil {
		return 0
	}
	count := 0
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) != "" && !strings.HasPrefix(line, "#") {
			count++
		}
	}
	return count
}

func cronIPListUpdate(cfg *Config) {
	for {
		now := time.Now()
		next := time.Date(now.Year(), now.Month(), now.Day(), 3, 0, 0, 0, now.Location())
		if now.After(next) {
			next = next.Add(24 * time.Hour)
		}
		sleepDur := time.Until(next)
		log.Printf("next IP list update at %s (in %s)", next.Format("2006-01-02 15:04"), sleepDur.Round(time.Minute))
		time.Sleep(sleepDur)

		for _, scope := range []string{"domestic", "overseas"} {
			log.Printf("cron: updating %s ip-list ...", scope)
			if err := updateIPListFromAPI(cfg, scope, "", ""); err != nil {
				log.Printf("cron: %s IP list update failed: %v", scope, err)
				continue
			}
			log.Printf("cron: %s IP list updated successfully", scope)
		}
	}
}

func cronHealthReport(activeConn **websocket.Conn, connMu *sync.Mutex, cfg *Config) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		connMu.Lock()
		conn := *activeConn
		connMu.Unlock()
		if conn == nil {
			continue
		}

		tunnelStats := collectTunnelHealth()
		onlineUsers := countOnlineUsers()

		payload, _ := json.Marshal(map[string]any{
			"online_users": onlineUsers,
			"tunnels":      tunnelStats,
			"wg_pubkey":    readWGPublicKey(),
		})
		msg := WSMessage{Type: "health", Payload: payload}
		data, _ := json.Marshal(msg)

		connMu.Lock()
		if *activeConn != nil {
			(*activeConn).WriteMessage(websocket.TextMessage, data)
		}
		connMu.Unlock()
	}
}

type tunnelHealthItem struct {
	PeerNodeID string  `json:"peer_node_id"`
	LatencyMs  float64 `json:"latency_ms"`
	LossPct    float64 `json:"loss_pct"`
	Reachable  bool    `json:"reachable"`
}

func collectTunnelHealth() []tunnelHealthItem {
	data, err := os.ReadFile("/etc/vpn-agent/bootstrap-node.json")
	if err != nil {
		return nil
	}
	var bootstrap struct {
		Tunnels []struct {
			PeerNodeID string `json:"peer_node_id"`
			PeerIP     string `json:"peer_ip"`
		} `json:"tunnels"`
	}
	if json.Unmarshal(data, &bootstrap) != nil {
		return nil
	}

	results := make([]tunnelHealthItem, 0, len(bootstrap.Tunnels))
	for _, t := range bootstrap.Tunnels {
		item := tunnelHealthItem{PeerNodeID: t.PeerNodeID}
		out, err := exec.Command("ping", "-c", "3", "-W", "3", t.PeerIP).CombinedOutput()
		if err != nil {
			item.Reachable = false
			item.LossPct = 100
		} else {
			item.Reachable = true
			item.LatencyMs = extractAvgLatency(string(out))
			item.LossPct = extractLossPct(string(out))
		}
		results = append(results, item)
	}
	return results
}

func extractAvgLatency(output string) float64 {
	for _, line := range strings.Split(output, "\n") {
		if strings.Contains(line, "avg") && strings.Contains(line, "/") {
			parts := strings.Split(line, "=")
			if len(parts) >= 2 {
				vals := strings.Split(strings.TrimSpace(parts[len(parts)-1]), "/")
				if len(vals) >= 2 {
					v, _ := strconv.ParseFloat(vals[1], 64)
					return v
				}
			}
		}
	}
	return 0
}

func extractLossPct(output string) float64 {
	for _, line := range strings.Split(output, "\n") {
		if strings.Contains(line, "packet loss") {
			for _, word := range strings.Fields(line) {
				if strings.HasSuffix(word, "%") {
					v, _ := strconv.ParseFloat(strings.TrimSuffix(word, "%"), 64)
					return v
				}
			}
		}
	}
	return 0
}

// instancesListForHealth prefers last-config.json (control-plane push / rollback) over bootstrap-node.json.
func instancesListForHealth() []instanceRow {
	for _, path := range []string{"/etc/vpn-agent/last-config.json", "/etc/vpn-agent/bootstrap-node.json"} {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if list := parseInstancesFromNodeConfigJSON(data); len(list) > 0 {
			return list
		}
	}
	return nil
}

func ensureUDPExplicitExitNotify(lines []string) []string {
	for _, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "explicit-exit-notify") {
			return lines
		}
	}
	for i, line := range lines {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "proto ") && strings.Contains(t, "udp") {
			out := make([]string, 0, len(lines)+1)
			out = append(out, lines[:i+1]...)
			out = append(out, "explicit-exit-notify 1")
			out = append(out, lines[i+1:]...)
			return out
		}
	}
	return lines
}

func applyOpenVPNServerConf(mode string, port int, proto string) error {
	proto = normalizeOpenVPNProto(proto)
	confPath := filepath.Join("/etc/openvpn/server", mode, "server.conf")
	b, err := os.ReadFile(confPath)
	if err != nil {
		return err
	}
	raw := strings.ReplaceAll(string(b), "\r\n", "\n")
	lines := strings.Split(raw, "\n")
	var out []string
	for _, line := range lines {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "explicit-exit-notify") {
			if proto == "tcp" {
				continue
			}
		}
		if strings.HasPrefix(t, "port ") {
			out = append(out, fmt.Sprintf("port %d", port))
			continue
		}
		if strings.HasPrefix(t, "proto ") {
			out = append(out, fmt.Sprintf("proto %s", proto))
			continue
		}
		out = append(out, line)
	}
	if proto == "udp" {
		out = ensureUDPExplicitExitNotify(out)
	}
	newContent := strings.Join(out, "\n")
	if newContent == raw {
		return nil
	}
	return os.WriteFile(confPath, []byte(newContent), 0644)
}

// applyOpenVPNServerFromInstancesPayload updates each mode's server.conf port/proto from control-plane instance rows, then try-restarts units.
func applyOpenVPNServerFromInstancesPayload(payload []byte) {
	rows := parseInstancesFromNodeConfigJSON(payload)
	if len(rows) == 0 {
		return
	}
	for _, row := range rows {
		mode := strings.TrimSpace(row.Mode)
		if mode == "" || row.Port <= 0 {
			log.Printf("openvpn apply: skip row (mode=%q port=%d)", mode, row.Port)
			continue
		}
		if err := applyOpenVPNServerConf(mode, row.Port, row.Proto); err != nil {
			log.Printf("openvpn apply: mode=%s: %v", mode, err)
			continue
		}
		out, err := exec.Command("systemctl", "try-restart", "openvpn-"+mode).CombinedOutput()
		if err != nil {
			log.Printf("openvpn apply: try-restart openvpn-%s: %v %s", mode, err, strings.TrimSpace(string(out)))
		}
	}
}

// openvpnMgmtPortForMode 与 node-setup.sh 中 per-mode management 端口约定一致（与 instances JSON 数组顺序无关）。
func openvpnMgmtPortForMode(mode string) (int, bool) {
	switch mode {
	case "local-only":
		return 56730, true
	case "hk-smart-split":
		return 56731, true
	case "hk-global":
		return 56732, true
	case "us-global":
		return 56733, true
	default:
		return 0, false
	}
}

func countOnlineUsers() int {
	list := instancesListForHealth()
	if len(list) == 0 {
		log.Printf("health: no instances found in last-config/bootstrap, online user count defaults to 0")
		return 0
	}

	total := 0
	for _, inst := range list {
		mgmtPort, ok := openvpnMgmtPortForMode(inst.Mode)
		if !ok {
			log.Printf("health: skip online count for unknown instance mode %q", inst.Mode)
			continue
		}
		count := queryOpenVPNManagement(mgmtPort)
		if count < 0 {
			out, _ := exec.Command("systemctl", "is-active", "openvpn-"+inst.Mode).Output()
			if strings.TrimSpace(string(out)) != "active" {
				log.Printf("health: openvpn-%s is not active", inst.Mode)
			}
			continue
		}
		total += count
	}
	return total
}

func parseOpenVPNClientListCount(statusText string) int {
	count := 0
	for _, line := range strings.Split(statusText, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "CLIENT_LIST") {
			count++
		}
	}
	return count
}

func queryOpenVPNManagement(port int) int {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 2*time.Second)
	if err != nil {
		return -1
	}
	defer conn.Close()

	buf := make([]byte, 4096)
	_ = conn.SetReadDeadline(time.Now().Add(1200 * time.Millisecond))
	_, _ = conn.Read(buf) // best-effort read for welcome banner

	if _, err := fmt.Fprintf(conn, "status 3\n"); err != nil {
		log.Printf("health: management %d write status failed: %v", port, err)
		return -1
	}
	var sb strings.Builder
	deadline := time.Now().Add(8 * time.Second)
	for {
		_ = conn.SetReadDeadline(time.Now().Add(1200 * time.Millisecond))
		n, err := conn.Read(buf)
		if n > 0 {
			sb.Write(buf[:n])
		}
		if strings.Contains(sb.String(), "\nEND") || strings.Contains(sb.String(), "\r\nEND") {
			break
		}
		if err != nil {
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				if time.Now().After(deadline) {
					break
				}
				continue
			}
			if !errors.Is(err, io.EOF) {
				log.Printf("health: management %d read failed: %v", port, err)
				return -1
			}
			break
		}
		if time.Now().After(deadline) {
			break
		}
	}

	resp := sb.String()
	count := parseOpenVPNClientListCount(resp)
	if count == 0 {
		preview := strings.ReplaceAll(strings.TrimSpace(resp), "\n", "\\n")
		if len(preview) > 240 {
			preview = preview[:240] + "..."
		}
		log.Printf("health: management %d returned zero CLIENT_LIST rows (sample=%q)", port, preview)
	}
	return count
}

type exceptionRule struct {
	CIDR      string `json:"cidr"`
	Domain    string `json:"domain"`
	Direction string `json:"direction"`
}

func applyExceptions(rules []exceptionRule) {
	var script strings.Builder
	script.WriteString("ipset create vpn-ex-foreign hash:net -exist\n")
	script.WriteString("ipset create vpn-ex-domestic hash:net -exist\n")
	script.WriteString("ipset flush vpn-ex-foreign\n")
	script.WriteString("ipset flush vpn-ex-domestic\n")

	for _, r := range rules {
		if r.CIDR == "" {
			continue
		}
		if r.Direction == "foreign" {
			script.WriteString(fmt.Sprintf("ipset add vpn-ex-foreign %s -exist\n", r.CIDR))
		} else {
			script.WriteString(fmt.Sprintf("ipset add vpn-ex-domestic %s -exist\n", r.CIDR))
		}
	}

	rulesJSON, _ := json.Marshal(rules)
	os.WriteFile("/etc/vpn-agent/exceptions.json", rulesJSON, 0600)

	cmd := exec.Command("bash", "-c", script.String())
	out, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("apply exceptions failed: %v\n%s", err, out)
	} else {
		log.Printf("applied %d exception rules (CIDR)", len(rules))
	}

	generateDnsmasqConfig(rules)
}

func generateDnsmasqConfig(rules []exceptionRule) {
	var conf strings.Builder
	conf.WriteString("# Auto-generated by vpn-agent for domain-based split routing\n")

	hasDomains := false
	for _, r := range rules {
		if r.Domain == "" {
			continue
		}
		hasDomains = true
		domain := strings.TrimPrefix(r.Domain, "*.")
		if r.Direction == "foreign" {
			conf.WriteString(fmt.Sprintf("ipset=/%s/vpn-ex-foreign\n", domain))
			conf.WriteString(fmt.Sprintf("server=/%s/8.8.8.8\n", domain))
		} else {
			conf.WriteString(fmt.Sprintf("ipset=/%s/vpn-ex-domestic\n", domain))
			conf.WriteString(fmt.Sprintf("server=/%s/119.29.29.29\n", domain))
		}
	}

	if !hasDomains {
		return
	}

	confPath := "/etc/dnsmasq.d/vpn-exceptions.conf"
	if err := os.WriteFile(confPath, []byte(conf.String()), 0644); err != nil {
		log.Printf("write dnsmasq config failed: %v", err)
		return
	}

	if out, err := exec.Command("systemctl", "reload", "dnsmasq").CombinedOutput(); err != nil {
		exec.Command("systemctl", "restart", "dnsmasq").CombinedOutput()
		_ = out
	}
	log.Printf("dnsmasq config updated with domain exceptions")
}

func monitorTunnelFailover(activeConn **websocket.Conn, connMu *sync.Mutex, cfg *Config) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		data, err := os.ReadFile("/etc/vpn-agent/bootstrap-node.json")
		if err != nil {
			continue
		}
		var bootstrap struct {
			Tunnels []struct {
				PeerNodeID string `json:"peer_node_id"`
				PeerIP     string `json:"peer_ip"`
			} `json:"tunnels"`
		}
		if json.Unmarshal(data, &bootstrap) != nil {
			continue
		}

		for _, t := range bootstrap.Tunnels {
			_, err := exec.Command("ping", "-c", "1", "-W", "2", t.PeerIP).Output()
			if err != nil {
				log.Printf("failover: tunnel to %s DOWN, attempting restart", t.PeerNodeID)
				exec.Command("systemctl", "restart", "wg-quick@wg-"+t.PeerNodeID).Run()
				time.Sleep(3 * time.Second)
				if _, err2 := exec.Command("ping", "-c", "1", "-W", "2", t.PeerIP).Output(); err2 != nil {
					log.Printf("failover: tunnel to %s still DOWN after restart", t.PeerNodeID)
				} else {
					log.Printf("failover: tunnel to %s recovered", t.PeerNodeID)
				}
			}
		}
	}
}

func cronCertRenewal(activeConn **websocket.Conn, connMu *sync.Mutex, cfg *Config) {
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()

	for range ticker.C {
		easyrsaBin := filepath.Join(cfg.EasyRSADir, "easyrsa")
		pki := filepath.Join(cfg.EasyRSADir, "pki")
		issuedDir := filepath.Join(pki, "issued")

		entries, err := os.ReadDir(issuedDir)
		if err != nil {
			continue
		}

		for _, entry := range entries {
			if !strings.HasSuffix(entry.Name(), ".crt") {
				continue
			}
			certPath := filepath.Join(issuedDir, entry.Name())
			out, err := exec.Command("openssl", "x509", "-enddate", "-noout", "-in", certPath).Output()
			if err != nil {
				continue
			}

			line := strings.TrimSpace(string(out))
			dateStr := strings.TrimPrefix(line, "notAfter=")
			expiry, err := time.Parse("Jan  2 15:04:05 2006 MST", dateStr)
			if err != nil {
				expiry, err = time.Parse("Jan 2 15:04:05 2006 MST", dateStr)
				if err != nil {
					continue
				}
			}

			daysLeft := int(time.Until(expiry).Hours() / 24)
			cn := strings.TrimSuffix(entry.Name(), ".crt")

			if daysLeft <= 30 && daysLeft > 0 {
				log.Printf("cert-renewal: %s expires in %d days, renewing...", cn, daysLeft)

				cmd := exec.Command(easyrsaBin, "revoke", cn)
				cmd.Dir = cfg.EasyRSADir
				cmd.Env = append(os.Environ(), "EASYRSA_BATCH=1")
				cmd.CombinedOutput()

				cmd = exec.Command(easyrsaBin, "--days=3650", "gen-crl")
				cmd.Dir = cfg.EasyRSADir
				cmd.Env = append(os.Environ(), "EASYRSA_BATCH=1")
				cmd.CombinedOutput()

				if strings.HasPrefix(cn, "server-") {
					cmd = exec.Command(easyrsaBin, "--days=3650", "build-server-full", cn, "nopass")
				} else {
					cmd = exec.Command(easyrsaBin, "--days=3650", "build-client-full", cn, "nopass")
				}
				cmd.Dir = cfg.EasyRSADir
				cmd.Env = append(os.Environ(), "EASYRSA_BATCH=1")
				if out, err := cmd.CombinedOutput(); err != nil {
					log.Printf("cert-renewal: failed to renew %s: %v\n%s", cn, err, out)
				} else {
					log.Printf("cert-renewal: %s renewed successfully", cn)
				}
			}
		}
	}
}
