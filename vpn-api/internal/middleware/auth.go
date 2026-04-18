package middleware

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

// jwtClaimString 将 JWT MapClaims 中的值规范为可比较的字符串。
func jwtClaimString(v any) string {
	if v == nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return strings.TrimSpace(t)
	default:
		return strings.TrimSpace(fmt.Sprint(t))
	}
}

// JWTClaimsUnrestricted 基于 Token claims 判断是否为超级管理员（与库表 AdminIsUnrestricted 语义对齐，仅不查库）。
// role 大小写不敏感；permissions 须为精确 "*"（去首尾空格）。
func JWTClaimsUnrestricted(c *gin.Context) bool {
	rs, _ := c.Get("role")
	roleStr := jwtClaimString(rs)
	if strings.EqualFold(roleStr, "admin") {
		return true
	}
	ps, _ := c.Get("permissions")
	return jwtClaimString(ps) == "*"
}

func JWT(secret string) gin.HandlerFunc {
	return func(c *gin.Context) {
		auth := c.GetHeader("Authorization")
		if auth == "" || !strings.HasPrefix(auth, "Bearer ") {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing bearer token"})
			return
		}

		tokenStr := strings.TrimPrefix(auth, "Bearer ")
		token, err := jwt.Parse(tokenStr, func(token *jwt.Token) (interface{}, error) {
			return []byte(secret), nil
		})
		if err != nil || !token.Valid {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
			return
		}

		claims, ok := token.Claims.(jwt.MapClaims)
		if ok {
			c.Set("admin", claims["sub"])
			c.Set("role", jwtClaimString(claims["role"]))
			if _, exists := claims["perms"]; exists {
				c.Set("permissions", jwtClaimString(claims["perms"]))
			}
		}
		c.Next()
	}
}

func RequirePermission(module string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if JWTClaimsUnrestricted(c) {
			c.Next()
			return
		}

		perms, _ := c.Get("permissions")
		permsStr, _ := perms.(string)

		for _, p := range strings.Split(permsStr, ",") {
			if strings.TrimSpace(p) == module || strings.TrimSpace(p) == "*" {
				c.Next()
				return
			}
		}

		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "no permission for " + module})
	}
}

// RequireAnyPermission 与 RequirePermission 相同，但满足任一模块即放行（用于跨模块能力，如 Agent 升级既属节点运维也可能历史配置在 admins 下）。
func RequireAnyPermission(modules ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if JWTClaimsUnrestricted(c) {
			c.Next()
			return
		}

		perms, _ := c.Get("permissions")
		permsStr, _ := perms.(string)

		want := make(map[string]struct{}, len(modules))
		for _, m := range modules {
			want[strings.TrimSpace(m)] = struct{}{}
		}
		for _, p := range strings.Split(permsStr, ",") {
			p = strings.TrimSpace(p)
			if p == "*" {
				c.Next()
				return
			}
			if _, ok := want[p]; ok {
				c.Next()
				return
			}
		}

		modList := strings.Join(modules, " or ")
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "no permission for " + modList})
	}
}
