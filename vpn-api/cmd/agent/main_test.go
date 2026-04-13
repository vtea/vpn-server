package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestParseInstancesFromNodeConfigJSON_topLevel(t *testing.T) {
	raw := `{"node_id":"node-1","instances":[{"mode":"local-only","proto":"tcp","port":57318}]}`
	list := parseInstancesFromNodeConfigJSON([]byte(raw))
	if len(list) != 1 || list[0].Mode != "local-only" || list[0].Proto != "tcp" {
		t.Fatalf("got %#v", list)
	}
}

func TestParseInstancesFromNodeConfigJSON_nestedConfigObject(t *testing.T) {
	raw := `{"config":{"instances":[{"mode":"hk-smart-split","proto":"udp","port":57319}]}}`
	list := parseInstancesFromNodeConfigJSON([]byte(raw))
	if len(list) != 1 || list[0].Mode != "hk-smart-split" {
		t.Fatalf("got %#v", list)
	}
}

func TestParseInstancesFromNodeConfigJSON_configJSONString(t *testing.T) {
	inner, _ := json.Marshal(map[string]any{
		"instances": []map[string]any{
			{"mode": "us-global", "proto": "tcp"},
		},
	})
	outer, _ := json.Marshal(map[string]any{"config": string(inner)})
	list := parseInstancesFromNodeConfigJSON(outer)
	if len(list) != 1 || list[0].Mode != "us-global" || list[0].Proto != "tcp" {
		t.Fatalf("got %#v", list)
	}
}

func TestNormalizeOpenVPNProto(t *testing.T) {
	if normalizeOpenVPNProto("TCP") != "tcp" {
		t.Fatal()
	}
	if normalizeOpenVPNProto("udp") != "udp" {
		t.Fatal()
	}
	if normalizeOpenVPNProto("") != "udp" {
		t.Fatal()
	}
}

func TestBuildOvpnProfileBytes_tcpAndUdpHeaders(t *testing.T) {
	inline := []byte("<ca>\nTEST\n</ca>\n")
	tcpB := buildOvpnProfileBytes("example.com", 1194, "tcp", inline)
	udpB := buildOvpnProfileBytes("example.com", 1194, "udp", inline)
	if !strings.Contains(string(tcpB), "proto tcp-client") {
		t.Fatalf("tcp profile: %s", tcpB)
	}
	if !strings.Contains(string(udpB), "proto udp") {
		t.Fatalf("udp profile: %s", udpB)
	}
	if !bytes.HasSuffix(tcpB, inline) || !bytes.HasSuffix(udpB, inline) {
		t.Fatal("inline append mismatch")
	}
}

func TestParseOpenVPNClientListCount(t *testing.T) {
	statusText := strings.Join([]string{
		">INFO:OpenVPN Management Interface",
		"TITLE,OpenVPN 2.6.8 x86_64-linux-gnu",
		"TIME,Mon Apr 13 13:14:15 2026,1712985255",
		"CLIENT_LIST,alice,1.2.3.4:50000,10.66.0.2,",
		"CLIENT_LIST,bob,5.6.7.8:50001,10.66.0.3,",
		"ROUTING_TABLE,10.66.0.2,alice,1.2.3.4:50000,",
		"END",
	}, "\n")

	if got := parseOpenVPNClientListCount(statusText); got != 2 {
		t.Fatalf("want 2, got %d", got)
	}
}
