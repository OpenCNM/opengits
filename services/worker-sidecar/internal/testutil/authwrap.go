// Package testutil 提供跨包测试基建（仅 *_test 消费，严禁生产代码引用）。
package testutil

import "net/http"

// InternalAuthWrap 测试内联鉴权中间件：仅校验 x-internal-token 头（与 daemon
// s.internal 同契约：查询串 ?token= 不作为内部令牌通道），不符返回 401。
// 原各包 testRoutes 内重复的 wrap 闭包收敛至此（2026-11 测试基建去重）。
func InternalAuthWrap(internalToken string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("x-internal-token")
		if token != internalToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}
