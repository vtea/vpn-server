package service

import (
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"vpn-api/internal/model"
)

func testDBMesh(t *testing.T) *gorm.DB {
	t.Helper()
	// 每个用例独立内存库；勿用无名的 file::memory:?cache=shared，否则同进程内会共享一张表。
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Node{}, &model.Tunnel{}); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestEnsureFullMeshTunnels_fillsMissingEdges(t *testing.T) {
	db := testDBMesh(t)
	nodes := []model.Node{
		{ID: "a", Name: "A", NodeNumber: 1, Region: "r", PublicIP: "1.1.1.1"},
		{ID: "b", Name: "B", NodeNumber: 2, Region: "r", PublicIP: "1.1.1.2"},
		{ID: "c", Name: "C", NodeNumber: 3, Region: "r", PublicIP: "1.1.1.3"},
	}
	for _, n := range nodes {
		if err := db.Create(&n).Error; err != nil {
			t.Fatal(err)
		}
	}
	// 仅 a-b，缺 a-c、b-c
	if err := db.Create(&model.Tunnel{
		NodeA: "a", NodeB: "b",
		Subnet: "172.16.0.0/30", IPA: "172.16.0.1", IPB: "172.16.0.2",
		WGPort: wgPort, Status: "pending",
	}).Error; err != nil {
		t.Fatal(err)
	}

	created, err := EnsureFullMeshTunnels(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(created) != 2 {
		t.Fatalf("expected 2 new tunnels, got %d", len(created))
	}

	var total int64
	if err := db.Model(&model.Tunnel{}).Count(&total).Error; err != nil {
		t.Fatal(err)
	}
	if total != 3 {
		t.Fatalf("expected 3 tunnels total, got %d", total)
	}

	created2, err := EnsureFullMeshTunnels(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(created2) != 0 {
		t.Fatalf("idempotent repair: expected 0, got %d", len(created2))
	}
}

func TestMeshNeighborNodeIDs(t *testing.T) {
	db := testDBMesh(t)
	for _, n := range []model.Node{
		{ID: "a", Name: "A", NodeNumber: 1, Region: "r", PublicIP: "1.1.1.1"},
		{ID: "b", Name: "B", NodeNumber: 2, Region: "r", PublicIP: "1.1.1.2"},
		{ID: "c", Name: "C", NodeNumber: 3, Region: "r", PublicIP: "1.1.1.3"},
	} {
		if err := db.Create(&n).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, tun := range []model.Tunnel{
		{NodeA: "a", NodeB: "b", Subnet: "172.16.0.0/30", IPA: "172.16.0.1", IPB: "172.16.0.2", WGPort: wgPort, Status: "pending"},
		{NodeA: "b", NodeB: "c", Subnet: "172.16.0.4/30", IPA: "172.16.0.5", IPB: "172.16.0.6", WGPort: wgPort, Status: "pending"},
	} {
		if err := db.Create(&tun).Error; err != nil {
			t.Fatal(err)
		}
	}
	na := MeshNeighborNodeIDs(db, "a")
	if len(na) != 1 || na[0] != "b" {
		t.Fatalf("neighbors of a: %#v", na)
	}
	nb := MeshNeighborNodeIDs(db, "b")
	if len(nb) != 2 {
		t.Fatalf("neighbors of b: %#v", nb)
	}
}

func TestEnsureFullMeshTunnels_nodeAIsLowerNodeNumber(t *testing.T) {
	db := testDBMesh(t)
	// id 字典序与 node_number 相反，验证按 node_number 定 NodeA
	if err := db.Create(&model.Node{ID: "z", Name: "Z", NodeNumber: 1, Region: "r", PublicIP: "1.0.0.1"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Node{ID: "y", Name: "Y", NodeNumber: 2, Region: "r", PublicIP: "1.0.0.2"}).Error; err != nil {
		t.Fatal(err)
	}
	created, err := EnsureFullMeshTunnels(db)
	if err != nil || len(created) != 1 {
		t.Fatalf("got %v len=%d", err, len(created))
	}
	tun := created[0]
	if tun.NodeA != "z" || tun.NodeB != "y" {
		t.Fatalf("expected node_a=z node_b=y, got %q %q", tun.NodeA, tun.NodeB)
	}
	if tun.IPA != "172.16.0.1" || tun.IPB != "172.16.0.2" {
		t.Fatalf("unexpected ips %q %q", tun.IPA, tun.IPB)
	}
}

func TestBuildTunnelConfigsForNode_allowedIPsIncludesDefaultWhenExitPeer(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Node{}, &model.Tunnel{}, &model.Instance{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Node{
		ID: "entry", Name: "E", NodeNumber: 1, Region: "r", PublicIP: "203.0.113.1",
		WGPublicKey: "YFEntryPubKeyBase64MustBe44CharsLongTest0=",
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Node{
		ID: "exit", Name: "X", NodeNumber: 2, Region: "r", PublicIP: "203.0.113.2",
		WGPublicKey: "YFExitPubKeyBase64MustBe44CharsLongTest00=",
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Tunnel{
		NodeA: "entry", NodeB: "exit",
		Subnet: "172.16.0.0/30", IPA: "172.16.0.1", IPB: "172.16.0.2",
		WGPort: wgPort, Status: "pending",
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Instance{
		NodeID: "entry", SegmentID: "default", Mode: "cn-split",
		Port: 1194, Proto: "udp", Subnet: "10.8.0.0/24", ExitNode: "exit", Enabled: true,
	}).Error; err != nil {
		t.Fatal(err)
	}

	cfgs, err := BuildTunnelConfigsForNode(db, "entry")
	if err != nil {
		t.Fatal(err)
	}
	if len(cfgs) != 1 {
		t.Fatalf("expected 1 tunnel config, got %d", len(cfgs))
	}
	if !strings.Contains(cfgs[0].AllowedIPs, "0.0.0.0/0") {
		t.Fatalf("AllowedIPs must include 0.0.0.0/0 for exit relay, got %q", cfgs[0].AllowedIPs)
	}
}

func TestBuildTunnelConfigsForNode_noDefaultRouteWithoutExitNode(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Node{}, &model.Tunnel{}, &model.Instance{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Node{
		ID: "entry", Name: "E", NodeNumber: 1, Region: "r", PublicIP: "203.0.113.1",
		WGPublicKey: "YFEntryPubKeyBase64MustBe44CharsLongTest0=",
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Node{
		ID: "exit", Name: "X", NodeNumber: 2, Region: "r", PublicIP: "203.0.113.2",
		WGPublicKey: "YFExitPubKeyBase64MustBe44CharsLongTest00=",
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Tunnel{
		NodeA: "entry", NodeB: "exit",
		Subnet: "172.16.0.0/30", IPA: "172.16.0.1", IPB: "172.16.0.2",
		WGPort: wgPort, Status: "pending",
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Instance{
		NodeID: "entry", SegmentID: "default", Mode: "cn-split",
		Port: 1194, Proto: "udp", Subnet: "10.8.0.0/24", ExitNode: "", Enabled: true,
	}).Error; err != nil {
		t.Fatal(err)
	}

	cfgs, err := BuildTunnelConfigsForNode(db, "entry")
	if err != nil {
		t.Fatal(err)
	}
	if len(cfgs) != 1 {
		t.Fatalf("expected 1 tunnel config, got %d", len(cfgs))
	}
	if strings.Contains(cfgs[0].AllowedIPs, "0.0.0.0/0") {
		t.Fatalf("without exit_node UUID, should not add 0.0.0.0/0 (legacy script may still use tunnel): %q", cfgs[0].AllowedIPs)
	}
}
