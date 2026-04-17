package api

import (
	"testing"

	"vpn-api/internal/model"
)

func TestAdminIsUnrestricted(t *testing.T) {
	if !AdminIsUnrestricted(&model.Admin{Role: "admin", Permissions: "nodes"}) {
		t.Fatal("admin role should be unrestricted")
	}
	if !AdminIsUnrestricted(&model.Admin{Role: "operator", Permissions: "*"}) {
		t.Fatal("star perms should be unrestricted")
	}
	if AdminIsUnrestricted(&model.Admin{Role: "operator", Permissions: "nodes"}) {
		t.Fatal("operator should not be unrestricted")
	}
}

func TestAdminScopeAllowsNode(t *testing.T) {
	s := &AdminScope{
		Unrestricted:   false,
		AllowedNodeIDs: []string{"a", "b"},
		allowedSet:     map[string]struct{}{"a": {}, "b": {}},
	}
	if !s.AllowsNode("a") || s.AllowsNode("z") {
		t.Fatalf("AllowsNode mismatch: a=%v z=%v", s.AllowsNode("a"), s.AllowsNode("z"))
	}
	u := &AdminScope{Unrestricted: true}
	if !u.AllowsNode("anything") {
		t.Fatal("unrestricted should allow any")
	}
}
