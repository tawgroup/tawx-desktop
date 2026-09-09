package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestRemoteProviderForwardsLocalModelDiscovery(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Fatalf("authorization header = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"id": "mock-model"}}})
	}))
	defer upstream.Close()

	request := httptest.NewRequest(http.MethodGet, "/proxy/remote?url="+url.QueryEscape(upstream.URL+"/v1/models"), nil)
	request.RemoteAddr = "127.0.0.1:32100"
	request.Header.Set("Authorization", "Bearer test-key")
	response := httptest.NewRecorder()

	new(Gateway).handleRemoteProvider(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("content type = %q", response.Header().Get("Content-Type"))
	}
}

func TestRemoteProviderRejectsNonLocalCallers(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/proxy/remote?url="+url.QueryEscape("https://api.example.com/v1/models"), nil)
	request.RemoteAddr = "203.0.113.9:32100"
	response := httptest.NewRecorder()

	new(Gateway).handleRemoteProvider(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestProviderTargetRequiresHTTPSOutsideLoopback(t *testing.T) {
	if _, err := providerTarget("http://api.example.com/v1/models"); err == nil {
		t.Fatal("expected insecure remote URL to be rejected")
	}
	if _, err := providerTarget("https://api.example.com/v1/models"); err != nil {
		t.Fatalf("HTTPS target rejected: %v", err)
	}
	if _, err := providerTarget("http://localhost:11434/v1/models"); err != nil {
		t.Fatalf("loopback HTTP target rejected: %v", err)
	}
}
