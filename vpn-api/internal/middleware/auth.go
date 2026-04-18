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
		if !ok {
			// 本 API 仅支持 MapClaims（与 Login 签发一致）；否则不设上下文仍 Next 会导致鉴权/审计异常。
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token claims"})
			return
		}
		// 与 role/perms 一致：sub 可能为 JSON 数字等非 string，需规范为字符串再写入上下文。
		sub := jwtClaimString(claims["sub"])
		if sub == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid token: missing sub"})
			return
		}
		c.Set("admin", sub)
		c.Set("role", jwtClaimString(claims["role"]))
		permsVal := claims["perms"]
		if permsVal == nil {
			permsVal = claims["permissions"]
		}
		c.Set("permissions", jwtClaimString(permsVal))
		c.Next()
	}
}

// permissionTokens 将 JWT/库表中的权限串拆成 token（支持逗号、分号、中文逗号及纯空格分隔，避免手工录入格式不一致导致鉴权失败）。
func permissionTokens(permsStr string) []string {
	s := strings.TrimSpace(permsStr)
	if s == "" {
		return nil
	}
	if strings.ContainsAny(s, ",;，") {
		parts := strings.FieldsFunc(s, func(r rune) bool {
			return r == ',' || r == ';' || r == '，'
		})
		out := make([]string, 0, len(parts))
		for _, p := range parts {
			t := strings.TrimSpace(p)
			if t != "" {
				out = append(out, t)
			}
		}
		return out
	}
	return strings.Fields(s)
}

func RequirePermission(module string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if JWTClaimsUnrestricted(c) {
			c.Next()
			return
		}

		perms, _ := c.Get("permissions")
		permsStr := jwtClaimString(perms)

		for _, p := range permissionTokens(permsStr) {
			if p == module || p == "*" {
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
		permsStr := jwtClaimString(perms)

		want := make(map[string]struct{}, len(modules))
		for _, m := range modules {
			want[strings.TrimSpace(m)] = struct{}{}
		}
		for _, p := range permissionTokens(permsStr) {
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
