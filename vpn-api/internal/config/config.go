package config

import (
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
		AgentLatestVersion: strings.TrimSpace(getOrDefault("AGENT_LATEST_VERSION", "0.2.1")),
		CORSAllowedOrigins: parseCommaList(os.Getenv("CORS_ALLOWED_ORIGINS")),
		IPListDualEnabled:  parseBoolDefault(os.Getenv("IPLIST_DUAL_ENABLED"), true),
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

func getOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func parseBoolDefault(raw string, def bool) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return def
	}
}
