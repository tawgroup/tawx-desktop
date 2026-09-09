package gateway

import (
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/openziti/llm-gateway/providers"
)

const (
	maxProviderRequestBytes  = 4 << 20
	maxProviderResponseBytes = 8 << 20
)

func (g *Gateway) handleRemoteProvider(w http.ResponseWriter, r *http.Request) {
	if !isLoopbackRequest(r.RemoteAddr) {
		providers.WriteError(w, providers.NewAPIError("provider connections are available only from the local desktop", providers.ErrorTypePermission), http.StatusForbidden)
		return
	}

	target, err := providerTarget(r.URL.Query().Get("url"))
	if err != nil {
		providers.WriteError(w, providers.NewAPIError(err.Error(), providers.ErrorTypeInvalidRequest), http.StatusBadRequest)
		return
	}

	body := http.MaxBytesReader(w, r.Body, maxProviderRequestBytes)
	upstream, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), body)
	if err != nil {
		providers.WriteError(w, providers.NewAPIError("invalid provider request", providers.ErrorTypeInvalidRequest), http.StatusBadRequest)
		return
	}
	if contentType := r.Header.Get("Content-Type"); contentType != "" {
		upstream.Header.Set("Content-Type", contentType)
	}
	if authorization := r.Header.Get("Authorization"); authorization != "" {
		upstream.Header.Set("Authorization", authorization)
	}

	client := &http.Client{
		Timeout: 20 * time.Second,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return errors.New("too many provider redirects")
			}
			_, err := providerTarget(request.URL.String())
			return err
		},
	}
	response, err := client.Do(upstream)
	if err != nil {
		providers.WriteError(w, providers.NewAPIError("provider connection failed", providers.ErrorTypeServer), http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	w.Header().Set("Content-Type", response.Header.Get("Content-Type"))
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(response.Body, maxProviderResponseBytes))
}

func providerTarget(raw string) (*url.URL, error) {
	target, err := url.Parse(raw)
	if err != nil || target.Hostname() == "" || target.User != nil || target.Fragment != "" {
		return nil, errors.New("invalid provider URL")
	}
	if target.Scheme == "https" {
		return target, nil
	}
	if target.Scheme == "http" && isLoopbackHost(target.Hostname()) {
		return target, nil
	}
	return nil, errors.New("remote providers require HTTPS; HTTP is allowed only for localhost")
}

func isLoopbackRequest(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}
