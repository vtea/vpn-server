package config

import (
	"net/url"
	"os"
	"strings"
)

type Config struct {
	Port               string
	DBDriver           string // "sqlite" or "postgres"
	DBPath             string // sqlite path or postgres DSN
	JWTSecret          string
	CADir              string   // central CA directory
	ExternalURL        string   // public-facing URL for deploy commands and script downloads
	ExternalURLLAN     string   // optional LAN URL for second deploy command (intranet bootstrap)
	AgentLatestVersion string   // latest agent version for upgrade recommendation/defaults
	CORSAllowedOrigins []string // empty = no CORS middleware (same-origin / reverse-proxy handles it)
	IPListDualEnabled  bool
}

func Load() Config {
	port := getOrDefault("API_PORT", "56700")
	return Config{
		Port:               port,
		DBDriver:           getOrDefault("DB_DRIVER", "sqlite"),
		DBPath:             getOrDefault("DB_PATH", "./vpn.db"),
		JWTSecret:          getOrDefault("JWT_SECRET", "change-this-secret"),
		CADir:              getOrDefault("CA_DIR", "./ca"),
		ExternalURL:        getOrDefault("EXTERNAL_URL", "http://127.0.0.1:"+port),
		ExternalURLLAN:     strings.TrimSpace(os.Getenv("EXTERNAL_URL_LAN")),
		// Empty means "auto detect from .agent-release-version".
		AgentLatestVersion: strings.TrimSpace(os.Getenv("AGENT_LATEST_VERSION")),
		CORSAllowedOrigins: mergeCORSOrigins(),
		// 恒为 true：Agent 依赖 /api/ip-lists/download/{domestic,overseas}；设为 false 会导致 404 且控制台「全网更新」无法同步节点。
		IPListDualEnabled: true,
	}
}

func parseCommaList(s string) []string {
	if s == "" {
		return nil
	}
	var out []string
	for _, p := range strings.Split(s, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// mergeCORSOrigins 合并 CORS_ALLOWED_ORIGINS、WEB_APP_ORIGINS 与单值 WEB_APP_ORIGIN（去重），便于「管理台域名」与「API 域名」分离部署时只配一组变量。
func mergeCORSOrigins() []string {
	seen := make(map[string]struct{})
	var out []string
	add := func(raw string) {
		o := normalizeCORSOrigin(raw)
		if o == "" {
			return
		}
		if _, ok := seen[o]; ok {
			return
		}
		seen[o] = struct{}{}
		out = append(out, o)
	}
	for _, p := range parseCommaList(os.Getenv("CORS_ALLOWED_ORIGINS")) {
		add(p)
	}
	for _, p := range parseCommaList(os.Getenv("WEB_APP_ORIGINS")) {
		add(p)
	}
	if v := strings.TrimSpace(os.Getenv("WEB_APP_ORIGIN")); v != "" {
		add(v)
	}
	return out
}

// normalizeCORSOrigin 将配置值规范为「协议 + 主机（+ 端口）」形式的 Origin，忽略路径。
func normalizeCORSOrigin(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if !strings.Contains(s, "://") {
		return strings.TrimSuffix(s, "/")
	}
	u, err := url.Parse(s)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return strings.TrimSuffix(s, "/")
	}
	return u.Scheme + "://" + u.Host
}

func getOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
