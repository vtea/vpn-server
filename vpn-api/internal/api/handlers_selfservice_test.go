package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
	"vpn-api/internal/model"
)

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(
		&model.Admin{},
		&model.NetworkSegment{},
		&model.Node{},
		&model.NodeSegment{},
		&model.Instance{},
		&model.User{},
		&model.UserGrant{},
	); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestLogin_NotFoundAdmin_Returns401(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := testDB(t)
	h := NewHandler(db, "jwt-secret", nil, nil, "http://127.0.0.1:56700", "", "", "", ".", "sqlite", true)
	r := gin.New()
	r.POST("/api/auth/login", h.Login)

	body := `{"username":"nobody","password":"x"}`
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestLogin_ValidCredentials_Returns200(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := testDB(t)
	hash, err := bcrypt.GenerateFromPassword([]byte("okpass"), bcrypt.DefaultCost)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Admin{Username: "admin", PasswordHash: string(hash), Role: "admin", Permissions: "*"}).Error; err != nil {
		t.Fatal(err)
	}
	h := NewHandler(db, "jwt-secret", nil, nil, "http://127.0.0.1:56700", "", "", "", ".", "sqlite", true)
	r := gin.New()
	r.POST("/api/auth/login", h.Login)

	body := `{"username":"admin","password":"okpass"}`
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%s", w.Code, w.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out["token"] == nil || out["token"] == "" {
		t.Fatal("expected token in response")
	}
}

func TestSelfServiceLookup_UserNotFound_Returns404(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := testDB(t)
	h := NewHandler(db, "jwt-secret", nil, nil, "http://127.0.0.1:56700", "", "", "", ".", "sqlite", true)
	r := gin.New()
	r.GET("/api/self-service/lookup", h.SelfServiceLookup)

	req := httptest.NewRequest(http.MethodGet, "/api/self-service/lookup?username=nouser", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("want 404, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestSelfServiceDownload_GrantNotFound_Returns404(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := testDB(t)
	h := NewHandler(db, "jwt-secret", nil, nil, "http://127.0.0.1:56700", "", "", "", ".", "sqlite", true)
	r := gin.New()
	r.GET("/api/self-service/grants/:id/download", h.SelfServiceDownload)

	req := httptest.NewRequest(http.MethodGet, "/api/self-service/grants/999/download?username=u", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("want 404, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestSelfServiceDownload_WrongUsername_Returns403(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := testDB(t)
	if err := db.Create(&model.User{Username: "alice"}).Error; err != nil {
		t.Fatal(err)
	}
	var u model.User
	if err := db.Where("username = ?", "alice").First(&u).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Node{
		ID: "node-1", Name: "n1", NodeNumber: 1, Region: "r", PublicIP: "1.1.1.1",
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.NodeSegment{NodeID: "node-1", SegmentID: "default", Slot: 0}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Instance{
		NodeID: "node-1", SegmentID: "default", Mode: "m1", Port: 1194, Subnet: "10.1.1.0/24",
	}).Error; err != nil {
		t.Fatal(err)
	}
	var inst model.Instance
	if err := db.First(&inst).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.UserGrant{
		UserID: u.ID, InstanceID: inst.ID, CertCN: "cn1", CertStatus: "active",
	}).Error; err != nil {
		t.Fatal(err)
	}
	var g model.UserGrant
	if err := db.First(&g).Error; err != nil {
		t.Fatal(err)
	}

	h := NewHandler(db, "jwt-secret", nil, nil, "http://127.0.0.1:56700", "", "", "", ".", "sqlite", true)
	r := gin.New()
	r.GET("/api/self-service/grants/:id/download", h.SelfServiceDownload)

	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/self-service/grants/%d/download?username=bob", g.ID), nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("want 403, got %d body=%s", w.Code, w.Body.String())
	}
}
