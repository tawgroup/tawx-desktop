package keys

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/openziti/llm-gateway/providers"
)

func mustStore(t *testing.T, entries []EntryConfig) *Store {
	t.Helper()
	store, err := NewStore(entries)
	if err != nil {
		t.Fatalf("NewStore() = %v, want nil", err)
	}
	return store
}

func TestStoreLookupUsesDigest(t *testing.T) {
	store := mustStore(t, []EntryConfig{
		{Name: "alice", Key: "sk-gw-aaa"},
		{Name: "bob", Key: "sk-gw-bbb"},
	})

	record, ok := store.Lookup("sk-gw-aaa")
	if !ok || record.Name != "alice" || record.Source != configSourceName {
		t.Fatalf("Lookup(alice) = %+v, %v", record, ok)
	}
	if _, ok := store.Lookup("sk-gw-ccc"); ok {
		t.Fatal("Lookup(unknown) succeeded")
	}
	if got := len(store.snapshot.Load().byDigest); got != 2 {
		t.Errorf("resident records = %d, want 2", got)
	}
}

func TestStoreDuplicateKeyRejectedWithoutSecret(t *testing.T) {
	secret := "sk-gw-shared"
	_, err := NewStore([]EntryConfig{
		{Name: "alice", Key: secret},
		{Name: "bob", Key: secret},
	})
	if err == nil || !strings.Contains(err.Error(), "'alice' and 'bob'") {
		t.Fatalf("NewStore() = %v, want duplicate error naming both entries", err)
	}
	if strings.Contains(err.Error(), secret) {
		t.Error("duplicate error exposed key material")
	}
}

func TestStoreRejectsInvalidConfigRecord(t *testing.T) {
	tests := []struct {
		name  string
		entry EntryConfig
		path  string
	}{
		{"empty name", EntryConfig{Key: "sk-valid"}, ".name"},
		{"empty key", EntryConfig{Name: "alice"}, ".key"},
		{"bad grammar", EntryConfig{Name: "alice", Key: "not valid"}, ".key"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := NewStore([]EntryConfig{tt.entry})
			if err == nil || !strings.Contains(err.Error(), tt.path) {
				t.Fatalf("NewStore() = %v, want error containing %q", err, tt.path)
			}
			if tt.entry.Key != "" && strings.Contains(err.Error(), tt.entry.Key) {
				t.Error("validation error exposed key material")
			}
		})
	}
}

func TestMiddlewarePassthroughAndAuthentication(t *testing.T) {
	store := mustStore(t, []EntryConfig{{Name: "alice", Key: "sk-gw-alice"}})
	var got *Record
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = FromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	})
	handler := store.Middleware(inner)

	for _, path := range []string{"/", "/health", "/metrics", "/favicon.svg", "/assets/app.js", "/proxy/remote"} {
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, path, nil))
		if rr.Code != http.StatusOK {
			t.Errorf("%s returned %d, want 200", path, rr.Code)
		}
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer sk-gw-alice")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK || got == nil || got.Name != "alice" {
		t.Fatalf("valid key returned %d with record %+v", rr.Code, got)
	}

	for _, auth := range []string{"", "Bearer sk-gw-wrong"} {
		req = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		rr = httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Errorf("Authorization %q returned %d, want 401", auth, rr.Code)
		}
		var response providers.ErrorResponse
		if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
			t.Fatalf("error response is not JSON: %v", err)
		}
		if response.Error.Type != providers.ErrorTypeAuthentication {
			t.Errorf("error type = %q, want %q", response.Error.Type, providers.ErrorTypeAuthentication)
		}
	}
}

func TestMiddlewareRejectsExpiredLikeUnknown(t *testing.T) {
	now := time.Date(2026, time.August, 11, 12, 0, 0, 0, time.UTC)
	digest, err := HashKey("sk-expired")
	if err != nil {
		t.Fatal(err)
	}
	expires := now
	store := &Store{clock: func() time.Time { return now }}
	store.snapshot.Store(&Snapshot{SchemaVersion: 1, Generation: 1, byDigest: map[[32]byte]*Record{
		digest: {Name: "expired", Digest: digest, ExpiresAt: &expires},
	}})
	handler := store.Middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("expired key reached inner handler")
	}))
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer sk-expired")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expired key returned %d, want 401", rr.Code)
	}
}

func TestFromContextNil(t *testing.T) {
	if record := FromContext(t.Context()); record != nil {
		t.Fatalf("FromContext() = %+v, want nil", record)
	}
}

func TestMiddlewareBindsAuthenticationSnapshotForRequestLifetime(t *testing.T) {
	store := mustStore(t, []EntryConfig{{Name: "alice", Key: "sk-alice"}})
	ready := make(chan struct{})
	resume := make(chan struct{})
	result := make(chan *Record, 1)
	handler := store.Middleware(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		close(ready)
		<-resume
		result <- FromContext(request.Context())
	}))
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	request.Header.Set("Authorization", "Bearer sk-alice")
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(httptest.NewRecorder(), request)
		close(done)
	}()
	<-ready
	if err := store.Install(configSourceName, &Contribution{SchemaVersion: 1}, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, ok := store.Lookup("sk-alice"); ok {
		t.Fatal("revoked key remained in the resident snapshot")
	}
	close(resume)
	record := <-result
	if record == nil || record.Name != "alice" {
		t.Fatalf("request-bound record = %+v, want original alice record", record)
	}
	<-done
}
