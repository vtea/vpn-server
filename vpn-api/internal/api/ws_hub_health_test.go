package api

import (
	"testing"
	"time"
	"vpn-api/internal/model"
)

func int64Ptr(v int64) *int64 { return &v }

func TestEvaluateTunnelHealthFreshHandshake(t *testing.T) {
	now := time.Now()
	age := int64(10)
	ifaceUp := true
	pubkey := true
	eval := evaluateTunnelHealth(now, model.Tunnel{}, healthTunnelItem{
		PeerPubKeyPresent:     &pubkey,
		IfaceUp:               &ifaceUp,
		LatestHandshakeAgeSec: &age,
	})
	if eval.Status != tunnelStatusHealthy {
		t.Fatalf("want healthy, got %s", eval.Status)
	}
	if eval.Reason != "recent wireguard handshake" {
		t.Fatalf("unexpected reason: %s", eval.Reason)
	}
}

func TestEvaluateTunnelHealthTrafficObservedWithoutFreshHandshake(t *testing.T) {
	now := time.Now()
	age := int64(999)
	ifaceUp := true
	pubkey := true
	rx := int64(1024)
	eval := evaluateTunnelHealth(now, model.Tunnel{ConsecutiveFailures: 2}, healthTunnelItem{
		PeerPubKeyPresent:     &pubkey,
		IfaceUp:               &ifaceUp,
		LatestHandshakeAgeSec: &age,
		RxBytesTotal:          &rx,
	})
	if eval.Status != tunnelStatusDegraded {
		t.Fatalf("want degraded, got %s", eval.Status)
	}
	if eval.Reason != "wireguard traffic observed but handshake not fresh" {
		t.Fatalf("unexpected reason: %s", eval.Reason)
	}
	if eval.ConsecutiveFailures != 0 {
		t.Fatalf("want failures reset to 0, got %d", eval.ConsecutiveFailures)
	}
}

func TestEvaluateTunnelHealthNoTrafficProgressThreshold(t *testing.T) {
	now := time.Now()
	age := int64(999)
	ifaceUp := true
	pubkey := true
	eval := evaluateTunnelHealth(now, model.Tunnel{ConsecutiveFailures: 2}, healthTunnelItem{
		PeerPubKeyPresent:     &pubkey,
		IfaceUp:               &ifaceUp,
		LatestHandshakeAgeSec: &age,
		RxBytesTotal:          int64Ptr(0),
		TxBytesTotal:          int64Ptr(0),
	})
	if eval.Status != tunnelStatusDown {
		t.Fatalf("want down, got %s", eval.Status)
	}
	if eval.Reason != "wireguard handshake stale and no traffic progress" {
		t.Fatalf("unexpected reason: %s", eval.Reason)
	}
}

