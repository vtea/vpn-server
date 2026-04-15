package main

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseInstancesFromNodeConfigJSON_topLevel(t *testing.T) {
	raw := `{"node_id":"node-1","instances":[{"mode":"node-direct","proto":"tcp","port":57318}]}`
	list := parseInstancesFromNodeConfigJSON([]byte(raw))
	if len(list) != 1 || list[0].Mode != "node-direct" || list[0].Proto != "tcp" {
		t.Fatalf("got %#v", list)
	}
}

func TestParseInstancesFromNodeConfigJSON_nestedConfigObject(t *testing.T) {
	raw := `{"config":{"instances":[{"mode":"cn-split","proto":"udp","port":57319}]}}`
	list := parseInstancesFromNodeConfigJSON([]byte(raw))
	if len(list) != 1 || list[0].Mode != "cn-split" {
		t.Fatalf("got %#v", list)
	}
}

func TestParseInstancesFromNodeConfigJSON_configJSONString(t *testing.T) {
	inner, _ := json.Marshal(map[string]any{
		"instances": []map[string]any{
			{"mode": "global", "proto": "tcp"},
		},
	})
	outer, _ := json.Marshal(map[string]any{"config": string(inner)})
	list := parseInstancesFromNodeConfigJSON(outer)
	if len(list) != 1 || list[0].Mode != "global" || list[0].Proto != "tcp" {
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

func TestBuildWGListenLine(t *testing.T) {
	if got := buildWGListenLine("wg-node-10", 51820, "wg-node-10"); got != "ListenPort = 51820" {
		t.Fatalf("unexpected listen line: %s", got)
	}
	if got := buildWGListenLine("wg-node-20", 51820, "wg-node-10"); strings.Contains(got, "ListenPort =") {
		t.Fatalf("non-owner interface should not keep fixed listen port: %s", got)
	}
	if got := buildWGListenLine("wg-node-10", 0, "wg-node-10"); strings.Contains(got, "ListenPort =") {
		t.Fatalf("zero req listen port should not render fixed line: %s", got)
	}
}

func TestClassifyWGStartError(t *testing.T) {
	cases := map[string]string{
		"RTNETLINK answers: Address already in use":             "port_conflict",
		"Name or service not known: <NODE20_IP>:51820":          "endpoint_parse_error",
		"ip link wg-node-20: Device does not exist":             "missing_interface",
		"unexpected control process exited with unknown reason": "unknown",
	}
	for input, want := range cases {
		if got := classifyWGStartError(input); got != want {
			t.Fatalf("classifyWGStartError(%q)=%q want=%q", input, got, want)
		}
	}
}

func TestWireGuardEndpointField(t *testing.T) {
	if got := wireGuardEndpointField("203.0.113.5", 51820); got != "203.0.113.5:51820" {
		t.Fatalf("ipv4: %q", got)
	}
	if got := wireGuardEndpointField("2001:db8::1", 51820); got != "[2001:db8::1]:51820" {
		t.Fatalf("ipv6: %q", got)
	}
	if got := wireGuardEndpointField("vpn.example.com", 51820); got != "vpn.example.com:51820" {
		t.Fatalf("dns: %q", got)
	}
	if wireGuardEndpointField("", 51820) != "" || wireGuardEndpointField("1.2.3.4", 0) != "" {
		t.Fatal("expected empty")
	}
}

func TestWgIniOneLine(t *testing.T) {
	in := "  key\nwith\rstuff\x01 "
	if got := wgIniOneLine(in); got != "key with stuff" {
		t.Fatalf("%q", got)
	}
}

func TestWgPeerNodeIDSafeForPath(t *testing.T) {
	if !wgPeerNodeIDSafeForPath("node-10") {
		t.Fatal()
	}
	if wgPeerNodeIDSafeForPath("../x") || wgPeerNodeIDSafeForPath("a/b") || wgPeerNodeIDSafeForPath("x\ny") {
		t.Fatal("expected false")
	}
}

func TestPeerNodeIDFromWGConfPath(t *testing.T) {
	p := filepath.Join("etc", "wireguard", "wg-node-30.conf")
	id, ok := peerNodeIDFromWGConfPath(p)
	if !ok || id != "node-30" {
		t.Fatalf("got ok=%v id=%q", ok, id)
	}
	if _, ok := peerNodeIDFromWGConfPath("/etc/wireguard/privatekey"); ok {
		t.Fatal("expected false for non-wg conf name")
	}
}
