package config

import "testing"

func TestMergeCORSOrigins_dedupe(t *testing.T) {
	t.Setenv("CORS_ALLOWED_ORIGINS", "https://a.example.com, https://b.example.com/path")
	t.Setenv("WEB_APP_ORIGINS", "https://b.example.com,https://c.example.com")
	t.Setenv("WEB_APP_ORIGIN", "https://a.example.com")
	got := mergeCORSOrigins()
	if len(got) != 3 {
		t.Fatalf("want 3 unique origins, got %v", got)
	}
}

func TestMergeCORSOrigins_empty(t *testing.T) {
	t.Setenv("CORS_ALLOWED_ORIGINS", "")
	t.Setenv("WEB_APP_ORIGINS", "")
	t.Setenv("WEB_APP_ORIGIN", "")
	got := mergeCORSOrigins()
	if len(got) != 0 {
		t.Fatalf("want empty, got %v", got)
	}
}
