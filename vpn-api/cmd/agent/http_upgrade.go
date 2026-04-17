package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// Limits for agent binary download (defense-in-depth; curl had no explicit cap).
const (
	maxAgentBinaryBytes = 512 << 20 // 512 MiB
	downloadHTTPTimeout = 30 * time.Minute
	precheckHeadTimeout = 5 * time.Second
	precheckGetTimeout  = 8 * time.Second
	maxPrecheckBodyRead = 64 * 1024
	// precheckHTTPTimeout bounds each RoundTrip (including body read and Body.Close drain); see limitedDrain comment.
	precheckHTTPTimeout = 10 * time.Second
)

// agentUpgradeTransport returns a cloned DefaultTransport with TLS 1.2+ and proxy env preserved.
func agentUpgradeTransport() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	if t.TLSClientConfig == nil {
		t.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	} else {
		tc := t.TLSClientConfig.Clone()
		tc.MinVersion = tls.VersionTLS12
		t.TLSClientConfig = tc
	}
	return t
}

// agentHTTPUserAgent returns a stable UA for precheck/download (avoids default Go-http-client blocks).
func agentHTTPUserAgent() string {
	return "vpn-agent/" + agentVersion()
}

// httpStatusPrecheckOK mirrors curl -f: success for 2xx/3xx, failure for 4xx/5xx.
func httpStatusPrecheckOK(code int) bool {
	return code >= 200 && code < 400
}

func drainResponseBody(resp *http.Response) {
	if resp == nil || resp.Body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
}

// limitedDrain reads up to maxBytes from resp.Body, then closes the body.
//
// Note: net/http response bodies may read additional bytes on Close() to allow
// connection reuse (see net/http body.Close). Mitigations: keep precheck cheap (HEAD
// usually has no body), use per-request deadlines, and set http.Client.Timeout on
// the precheck client so each RoundTrip (including Close) is bounded.
func limitedDrain(resp *http.Response, maxBytes int64) {
	if resp == nil || resp.Body == nil {
		return
	}
	_, _ = io.CopyN(io.Discard, resp.Body, maxBytes)
	_ = resp.Body.Close()
}

// precheckDownloadURLs probes each URL until one responds like curl HEAD / ranged GET / wget spider
// (no redirect follow on probe, matching previous shell without -L).
func precheckDownloadURLs(urls []string) (bool, string, error) {
	transport := agentUpgradeTransport()
	noRedirect := &http.Client{
		Transport: transport,
		Timeout:   precheckHTTPTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	var lastErr string
	for _, raw := range urls {
		u := strings.TrimSpace(raw)
		if u == "" {
			continue
		}
		if err := probeDownloadURL(noRedirect, u); err == nil {
			return true, u, nil
		} else {
			lastErr = fmt.Sprintf("%v (%s)", err, u)
		}
	}
	if lastErr == "" {
		lastErr = "no valid download url"
	}
	return false, "", fmt.Errorf("%s", lastErr)
}

// probeDownloadURL tries HEAD (5s), then ranged GET (8s), then short GET (8s), like curl || curl || wget.
func probeDownloadURL(client *http.Client, rawURL string) error {
	var lastErr error
	setLast := func(err error) {
		if err != nil {
			lastErr = err
		}
	}

	// 1) HEAD
	ctx, cancel := context.WithTimeout(context.Background(), precheckHeadTimeout)
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, rawURL, nil)
	if err != nil {
		cancel()
		setLast(err)
	} else {
		req.Header.Set("User-Agent", agentHTTPUserAgent())
		resp, err := client.Do(req)
		cancel()
		if err != nil {
			setLast(err)
		} else {
			code := resp.StatusCode
			// HEAD should have no body; cap read before Close.
			limitedDrain(resp, 256)
			if httpStatusPrecheckOK(code) {
				return nil
			}
			setLast(fmt.Errorf("head status=%d", code))
		}
	}

	// 2) GET Range bytes=0-0
	ctx2, cancel2 := context.WithTimeout(context.Background(), precheckGetTimeout)
	req2, err := http.NewRequestWithContext(ctx2, http.MethodGet, rawURL, nil)
	if err != nil {
		cancel2()
		setLast(err)
	} else {
		req2.Header.Set("User-Agent", agentHTTPUserAgent())
		req2.Header.Set("Range", "bytes=0-0")
		resp2, err := client.Do(req2)
		cancel2()
		if err != nil {
			setLast(err)
		} else {
			code := resp2.StatusCode
			if code == http.StatusOK || code == http.StatusPartialContent {
				limitedDrain(resp2, maxPrecheckBodyRead)
				return nil
			}
			limitedDrain(resp2, maxPrecheckBodyRead)
			setLast(fmt.Errorf("range get status=%d", code))
		}
	}

	// 3) Short GET (wget --spider-like)
	ctx3, cancel3 := context.WithTimeout(context.Background(), precheckGetTimeout)
	req3, err := http.NewRequestWithContext(ctx3, http.MethodGet, rawURL, nil)
	if err != nil {
		cancel3()
		if lastErr != nil {
			return fmt.Errorf("%w; newrequest get: %v", lastErr, err)
		}
		return err
	}
	req3.Header.Set("User-Agent", agentHTTPUserAgent())
	resp3, err := client.Do(req3)
	cancel3()
	if err != nil {
		if lastErr != nil {
			return fmt.Errorf("%v; range_get: %w", lastErr, err)
		}
		return err
	}
	code := resp3.StatusCode
	if httpStatusPrecheckOK(code) {
		limitedDrain(resp3, maxPrecheckBodyRead)
		return nil
	}
	limitedDrain(resp3, maxPrecheckBodyRead)
	if lastErr != nil {
		return fmt.Errorf("%v; last get status=%d", lastErr, code)
	}
	return fmt.Errorf("precheck failed: last status=%d", code)
}

// downloadClientFollowRedirects returns an http.Client that follows redirects (curl -L) with a total timeout.
func downloadClientFollowRedirects() *http.Client {
	return &http.Client{
		Transport: agentUpgradeTransport(),
		Timeout:   downloadHTTPTimeout,
	}
}

// downloadURLToFile streams GET to destPath with a size limit; truncates/overwrites destPath.
// The client should use downloadHTTPTimeout (see downloadClientFollowRedirects); total time
// including Body.Close drain is bounded by that timeout.
func downloadURLToFile(client *http.Client, rawURL, destPath string) error {
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", agentHTTPUserAgent())
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer drainResponseBody(resp)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("http status %d: %s", resp.StatusCode, strings.TrimSpace(string(snippet)))
	}

	f, err := os.OpenFile(destPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()

	lr := io.LimitReader(resp.Body, maxAgentBinaryBytes+1)
	n, err := io.Copy(f, lr)
	if err != nil {
		return err
	}
	if n > maxAgentBinaryBytes {
		return fmt.Errorf("download exceeded max size (%d bytes)", maxAgentBinaryBytes)
	}
	return nil
}
