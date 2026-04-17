package api

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
)

type AdminWSHub struct {
	mu    sync.RWMutex
	conns map[*websocket.Conn]bool
}

func NewAdminWSHub() *AdminWSHub {
	return &AdminWSHub{conns: make(map[*websocket.Conn]bool)}
}

func (h *AdminWSHub) Broadcast(eventType string, data any) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	payload, err := json.Marshal(map[string]any{"type": eventType, "data": data, "ts": time.Now().Unix()})
	if err != nil {
		log.Printf("AdminWSHub.Broadcast: json.Marshal: %v", err)
		return
	}
	for conn := range h.conns {
		conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		conn.WriteMessage(websocket.TextMessage, payload)
	}
}

func (handler *Handler) AdminWS(c *gin.Context) {
	tokenStr := c.Query("token")
	if tokenStr == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing token"})
		return
	}
	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
		return []byte(handler.jwtSecret), nil
	})
	if err != nil || !token.Valid {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
		return
	}

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("admin ws upgrade failed: %v", err)
		return
	}

	hub := handler.adminWS
	hub.mu.Lock()
	hub.conns[conn] = true
	hub.mu.Unlock()

	defer func() {
		hub.mu.Lock()
		delete(hub.conns, conn)
		hub.mu.Unlock()
		conn.Close()
	}()

	conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		return nil
	})

	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
