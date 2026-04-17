package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestPrecheckDownloadURLs_HEADOK(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead {
			t.Fatalf("expected HEAD, got %s", r.Method)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	ok, sel, err := precheckDownloadURLs([]string{ts.URL + "/bin"})
	if err != nil || !ok || sel == "" {
		t.Fatalf("precheck: ok=%v sel=%q err=%v", ok, sel, err)
	}
}

func TestPrecheckDownloadURLs_RangeAfterHEAD405(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodHead:
			w.WriteHeader(http.StatusMethodNotAllowed)
		case http.MethodGet:
			if r.Header.Get("Range") == "bytes=0-0" {
				w.WriteHeader(http.StatusPartialContent)
				_, _ = w.Write([]byte("x"))
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ok"))
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	defer ts.Close()

	ok, _, err := precheckDownloadURLs([]string{ts.URL + "/x"})
	if err != nil || !ok {
		t.Fatalf("expected success via range get: err=%v ok=%v", err, ok)
	}
}

func TestPrecheckDownloadURLs_AllFail(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer ts.Close()

	ok, _, err := precheckDownloadURLs([]string{ts.URL + "/nope"})
	if ok || err == nil {
		t.Fatalf("expected failure, ok=%v err=%v", ok, err)
	}
}

func TestDownloadURLToFile_RoundTrip(t *testing.T) {
	payload := []byte("hello-agent-binary-stub")
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(payload)
	}))
	defer ts.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "dl.bin")
	client := downloadClientFollowRedirects()
	if err := downloadURLToFile(client, ts.URL+"/file", dest); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(payload) {
		t.Fatalf("content mismatch: %q vs %q", got, payload)
	}
}

func TestHTTPStatusPrecheckOK(t *testing.T) {
	if !httpStatusPrecheckOK(200) || !httpStatusPrecheckOK(301) || httpStatusPrecheckOK(404) {
		t.Fatal("unexpected precheck ok mapping")
	}
}

func TestProbeDownloadURL_RedirectNoFollow(t *testing.T) {
	// 302 without Location body — precheck should accept 3xx on HEAD
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusFound)
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	transport := agentUpgradeTransport()
	client := &http.Client{
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	if err := probeDownloadURL(client, ts.URL+"/r"); err != nil {
		t.Fatalf("302 on head should succeed like curl -f: %v", err)
	}
}

func TestProbeDownloadURL_NewRequestError(t *testing.T) {
	transport := agentUpgradeTransport()
	client := &http.Client{
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	err := probeDownloadURL(client, "://bad")
	if err == nil {
		t.Fatal("expected error for bad url")
	}
}
