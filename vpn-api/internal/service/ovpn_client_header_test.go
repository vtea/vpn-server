package service

import (
	"strings"
	"testing"
)

func TestOpenVPNClientProfileHeader_TCPUsesTcpClient(t *testing.T) {
	h := OpenVPNClientProfileHeader("example.com", 1194, "tcp")
	if !strings.Contains(h, "proto tcp-client") {
		t.Fatalf("want tcp-client in:\n%s", h)
	}
	if !strings.Contains(h, "cipher AES-256-GCM") {
		t.Fatal("want cipher line")
	}
}

func TestOpenVPNClientProfileHeader_UDP(t *testing.T) {
	h := OpenVPNClientProfileHeader("example.com", 1194, "udp")
	if !strings.Contains(h, "proto udp") {
		t.Fatalf("got:\n%s", h)
	}
}
