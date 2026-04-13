package service

import (
	"errors"
	"strings"

	"vpn-api/internal/model"
)

// ErrGrantOVPNNotFound 表示没有可下载的配置（未签发或该协议侧为空）。
var ErrGrantOVPNNotFound = errors.New("ovpn profile not available")

// NormalizeDownloadProtoQuery 将查询参数规范为 tcp、udp；空或非法则返回 ""。
func NormalizeDownloadProtoQuery(q string) string {
	switch strings.ToLower(strings.TrimSpace(q)) {
	case "tcp":
		return "tcp"
	case "udp":
		return "udp"
	default:
		return ""
	}
}

// GrantOVPNForDownload 按查询参数或默认（实例协议）选取要下发的 .ovpn 字节。
// instanceProtoNorm 应为 NormalizeInstanceProto 的结果或原始实例 proto。
func GrantOVPNForDownload(g *model.UserGrant, instanceProto string, protoQuery string) ([]byte, error) {
	want := NormalizeDownloadProtoQuery(protoQuery)
	if want == "" {
		if len(g.OVPNContent) > 0 {
			return g.OVPNContent, nil
		}
		if NormalizeInstanceProto(instanceProto) == "tcp" {
			if len(g.OvpnTCP) > 0 {
				return g.OvpnTCP, nil
			}
		} else {
			if len(g.OvpnUDP) > 0 {
				return g.OvpnUDP, nil
			}
		}
		return nil, ErrGrantOVPNNotFound
	}
	if want == "tcp" {
		if len(g.OvpnTCP) > 0 {
			return g.OvpnTCP, nil
		}
	} else {
		if len(g.OvpnUDP) > 0 {
			return g.OvpnUDP, nil
		}
	}
	if len(g.OVPNContent) > 0 {
		return g.OVPNContent, nil
	}
	return nil, ErrGrantOVPNNotFound
}
