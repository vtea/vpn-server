// Package debuglog writes one-line NDJSON for debug session analysis (no secrets).
package debuglog

import (
	"encoding/json"
	"os"
	"sync"
	"time"
)

const SessionID = "892464"

var mu sync.Mutex

// Line appends one NDJSON record to VPN_DEBUG_LOG or ./debug-892464.log (cwd).
// On VPN nodes run agent with: VPN_DEBUG_LOG=/etc/vpn-agent/debug-892464.log (writable by the agent user).
func Line(hypothesisID, location, message string, data map[string]any) {
	mu.Lock()
	defer mu.Unlock()
	path := os.Getenv("VPN_DEBUG_LOG")
	if path == "" {
		path = "debug-892464.log"
	}
	rec := map[string]any{
		"sessionId":    SessionID,
		"hypothesisId": hypothesisID,
		"location":     location,
		"message":      message,
		"timestamp":    time.Now().UnixMilli(),
	}
	for k, v := range data {
		rec[k] = v
	}
	b, err := json.Marshal(rec)
	if err != nil {
		return
	}
	b = append(b, '\n')
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	_, _ = f.Write(b)
	_ = f.Close()
}
