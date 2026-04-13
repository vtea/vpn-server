package service

import "fmt"

// OpenVPNClientProfileHeader returns the fixed preamble for a client .ovpn (must match node-setup server.conf:
// cipher AES-256-GCM, auth SHA512). protoNorm must be "tcp" or "udp" (use NormalizeInstanceProto first).
// TCP uses "proto tcp-client" so clients match a server listening with "proto tcp".
func OpenVPNClientProfileHeader(remoteHost string, port int, protoNorm string) string {
	protoLine := "udp"
	if NormalizeInstanceProto(protoNorm) == "tcp" {
		protoLine = "tcp-client"
	}
	return fmt.Sprintf(`client
dev tun
proto %s
remote %s %d
resolv-retry infinite
nobind
persist-key
persist-tun
remote-cert-tls server
cipher AES-256-GCM
auth SHA512
ignore-unknown-option block-outside-dns
verb 3
`, protoLine, remoteHost, port)
}
