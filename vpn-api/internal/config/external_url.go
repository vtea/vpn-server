package config

import (
	"net/http"
	"net/url"
	"strings"
)

// ExternalURLIsLoopbackOnly 判断是否为仅本机可访问的地址（未配置公网/域名时常见）。
func ExternalURLIsLoopbackOnly(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(u.Hostname())) {
	case "127.0.0.1", "localhost", "::1":
		return true
	default:
		return false
	}
}

// EffectiveExternalBaseURL 在配置的 EXTERNAL_URL 为回环时，用当前 HTTP 请求推断控制面基址。
//
// 典型场景：管理员通过「公网 IP:56700」或「经 Nginx 的域名」打开管理台并创建节点，此时 Host / X-Forwarded-Host
// 可被节点用于回调控制面；无需事先改环境变量。若推断结果仍为本机地址（例如本机用 127.0.0.1 打开页面），则退回配置的 URL。
//
// 无法可靠「自动探测公网 IP」：进程不知道 NAT 外地址、可能多网卡、可能仅内网访问；对外 IP 探测依赖外网 HTTP，且不适合离线/合规环境。
func EffectiveExternalBaseURL(r *http.Request, configured string) string {
	configured = strings.TrimRight(strings.TrimSpace(configured), "/")
	if !ExternalURLIsLoopbackOnly(configured) {
		return configured
	}
	if r == nil {
		return configured
	}
	host := firstCSVHeader(r, "X-Forwarded-Host")
	if host == "" {
		host = strings.TrimSpace(r.Host)
	}
	if host == "" {
		return configured
	}
	scheme := inferRequestScheme(r)
	candidate := scheme + "://" + host
	if _, err := url.Parse(candidate); err != nil {
		return configured
	}
	if ExternalURLIsLoopbackOnly(candidate) {
		return configured
	}
	return strings.TrimRight(candidate, "/")
}

func firstCSVHeader(r *http.Request, key string) string {
	v := strings.TrimSpace(r.Header.Get(key))
	if v == "" {
		return ""
	}
	if i := strings.IndexByte(v, ','); i >= 0 {
		v = strings.TrimSpace(v[:i])
	}
	return v
}

func inferRequestScheme(r *http.Request) string {
	if p := firstCSVHeader(r, "X-Forwarded-Proto"); p != "" {
		return strings.ToLower(p)
	}
	if strings.EqualFold(r.Header.Get("X-Forwarded-Ssl"), "on") {
		return "https"
	}
	if r.TLS != nil {
		return "https"
	}
	return "http"
}
