package middleware

import (
	"crypto/rand"
	"encoding/hex"
	"strings"

	"github.com/gin-gonic/gin"
)

const (
	// ContextKeyRequestID Gin 上下文中请求关联 ID 的键。
	ContextKeyRequestID = "request_id"
	// HeaderRequestID 客户端可传入并与响应回显的请求 ID 头。
	HeaderRequestID = "X-Request-ID"
)

// RequestID 注入或传递 X-Request-ID，便于日志与排查（如 SQLite locked 与具体请求对齐）；缺省时生成随机 hex。
func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		rid := strings.TrimSpace(c.GetHeader(HeaderRequestID))
		if rid == "" {
			rid = randomRequestID()
		}
		c.Set(ContextKeyRequestID, rid)
		c.Header(HeaderRequestID, rid)
		c.Next()
	}
}

func randomRequestID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "req-unknown"
	}
	return hex.EncodeToString(b)
}

// GetRequestID 从上下文读取请求 ID（未设置时返回空字符串）。
func GetRequestID(c *gin.Context) string {
	if v, ok := c.Get(ContextKeyRequestID); ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}
