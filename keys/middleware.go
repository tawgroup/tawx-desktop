package keys

import (
	"context"
	"net/http"
	"strings"

	"github.com/openziti/llm-gateway/providers"
)

type contextKey int

const apiKeyContextKey contextKey = iota

// Middleware returns a handler that enforces bearer-token authentication.
// Health, metrics, the bundled web UI, and its loopback-only provider proxy
// remain unauthenticated. The proxy must forward the upstream provider key,
// which is unrelated to gateway virtual keys.
func (s *Store) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/health" || r.URL.Path == "/metrics" || r.URL.Path == "/favicon.svg" || r.URL.Path == "/proxy/remote" || strings.HasPrefix(r.URL.Path, "/assets/") {
			next.ServeHTTP(w, r)
			return
		}

		auth := r.Header.Get("Authorization")
		if auth == "" || !strings.HasPrefix(auth, "Bearer ") {
			providers.WriteError(w,
				providers.NewAPIError("API key required", providers.ErrorTypeAuthentication),
				http.StatusUnauthorized,
			)
			return
		}

		record, ok := s.Lookup(strings.TrimPrefix(auth, "Bearer "))
		if !ok {
			providers.WriteError(w, providers.ErrUnauthorized, http.StatusUnauthorized)
			return
		}

		ctx := context.WithValue(r.Context(), apiKeyContextKey, record)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// FromContext returns the record bound when the request authenticated.
func FromContext(ctx context.Context) *Record {
	record, _ := ctx.Value(apiKeyContextKey).(*Record)
	return record
}
