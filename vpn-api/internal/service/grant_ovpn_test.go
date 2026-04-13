package service

import (
	"testing"

	"vpn-api/internal/model"
)

func TestNormalizeDownloadProtoQuery(t *testing.T) {
	if NormalizeDownloadProtoQuery("TCP") != "tcp" {
		t.Fatal()
	}
	if NormalizeDownloadProtoQuery("udp") != "udp" {
		t.Fatal()
	}
	if NormalizeDownloadProtoQuery("") != "" {
		t.Fatal()
	}
	if NormalizeDownloadProtoQuery("x") != "" {
		t.Fatal()
	}
}

func TestGrantOVPNForDownload_defaultOVPNContent(t *testing.T) {
	g := &model.UserGrant{OVPNContent: []byte("default")}
	b, err := GrantOVPNForDownload(g, "udp", "")
	if err != nil || string(b) != "default" {
		t.Fatalf("got %v %q", err, b)
	}
}

func TestGrantOVPNForDownload_defaultByInstanceProto(t *testing.T) {
	g := &model.UserGrant{OvpnTCP: []byte("t"), OvpnUDP: []byte("u")}
	b, err := GrantOVPNForDownload(g, "tcp", "")
	if err != nil || string(b) != "t" {
		t.Fatalf("got %v %q", err, b)
	}
	b, err = GrantOVPNForDownload(g, "udp", "")
	if err != nil || string(b) != "u" {
		t.Fatalf("got %v %q", err, b)
	}
}

func TestGrantOVPNForDownload_explicitProto(t *testing.T) {
	g := &model.UserGrant{OvpnTCP: []byte("t"), OvpnUDP: []byte("u"), OVPNContent: []byte("d")}
	b, err := GrantOVPNForDownload(g, "udp", "tcp")
	if err != nil || string(b) != "t" {
		t.Fatalf("got %v %q", err, b)
	}
	b, err = GrantOVPNForDownload(g, "tcp", "udp")
	if err != nil || string(b) != "u" {
		t.Fatalf("got %v %q", err, b)
	}
}

func TestGrantOVPNForDownload_legacyFallback(t *testing.T) {
	g := &model.UserGrant{OVPNContent: []byte("legacy")}
	b, err := GrantOVPNForDownload(g, "tcp", "tcp")
	if err != nil || string(b) != "legacy" {
		t.Fatalf("got %v %q", err, b)
	}
}

func TestGrantOVPNForDownload_empty(t *testing.T) {
	g := &model.UserGrant{}
	_, err := GrantOVPNForDownload(g, "udp", "")
	if err != ErrGrantOVPNNotFound {
		t.Fatalf("got %v", err)
	}
}
