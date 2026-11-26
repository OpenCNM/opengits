package webdoc

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseOpenApiSpecMap(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		specMap     map[string]any
		wantVersion string
		wantTitle   string
		wantNil     bool
	}{
		{
			name: "valid OpenAPI 3.1",
			specMap: map[string]any{
				"openapi": "3.1.0",
				"info": map[string]any{
					"title": "Eve Agent API",
				},
				"paths": map[string]any{
					"/v1/agents": map[string]any{},
				},
			},
			wantVersion: "3.1.0",
			wantTitle:   "Eve Agent API",
			wantNil:     false,
		},
		{
			name: "valid Swagger 2.0",
			specMap: map[string]any{
				"swagger": "2.0",
				"info": map[string]any{
					"title": "Legacy Petstore",
				},
				"paths": map[string]any{
					"/pets": map[string]any{},
				},
			},
			wantVersion: "2.0",
			wantTitle:   "Legacy Petstore",
			wantNil:     false,
		},
		{
			name: "missing paths and components",
			specMap: map[string]any{
				"openapi": "3.0.0",
				"info": map[string]any{
					"title": "Incomplete",
				},
			},
			wantNil: true,
		},
		{
			name: "invalid version string",
			specMap: map[string]any{
				"openapi": "4.0.0",
				"paths":   map[string]any{},
			},
			wantNil: true,
		},
		{
			name:    "nil map",
			specMap: nil,
			wantNil: true,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := ParseOpenApiSpecMap(tt.specMap, "https://example.com/openapi.json")
			if tt.wantNil {
				assert.Nil(t, got)
			} else {
				require.NotNil(t, got)
				assert.Equal(t, tt.wantVersion, got.Version)
				assert.Equal(t, tt.wantTitle, got.Title)
				assert.Equal(t, "https://example.com/openapi.json", got.SpecURL)
			}
		})
	}
}

func TestExtractSpecUrlsFromHTML(t *testing.T) {
	t.Parallel()

	base, err := url.Parse("https://docs.acme.com/api/v1")
	require.NoError(t, err)

	htmlSample := `
<!DOCTYPE html>
<html>
<head>
  <link rel="alternate" type="application/json" href="/schemas/openapi.json">
</head>
<body>
  <redoc spec-url="https://docs.acme.com/swagger.yaml"></redoc>
</body>
</html>
`
	var collected []string
	extractSpecUrlsFromHTML(htmlSample, base, func(s string) {
		collected = append(collected, s)
	})

	assert.Contains(t, collected, "https://docs.acme.com/swagger.yaml")
	assert.Contains(t, collected, "/schemas/openapi.json")
}

func TestDetectOpenApiSpec_WithServer(t *testing.T) {
	AllowTestLoopback = true
	t.Cleanup(func() { AllowTestLoopback = false })

	mockSpec := map[string]any{
		"openapi": "3.0.3",
		"info": map[string]any{
			"title": "Payment Gateway API",
		},
		"paths": map[string]any{
			"/charges": map[string]any{
				"post": map[string]any{
					"summary": "Create a charge",
				},
			},
		},
	}

	specBytes, err := json.Marshal(mockSpec)
	require.NoError(t, err)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/openapi.json":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(specBytes)
		case "/":
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`<html><head><title>API Docs</title></head><body><h1>Hello</h1></body></html>`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result := DetectOpenApiSpec(ctx, server.URL, "")
	require.NotNil(t, result)
	assert.Equal(t, "3.0.3", result.Version)
	assert.Equal(t, "Payment Gateway API", result.Title)
	assert.Contains(t, result.SpecURL, "/openapi.json")
	assert.NotNil(t, result.SpecRaw)
}

func TestDetectOpenApiSpec_DirectSpecURL(t *testing.T) {
	AllowTestLoopback = true
	t.Cleanup(func() { AllowTestLoopback = false })

	mockSpec := map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{
			"title": "Direct Spec API",
		},
		"paths": map[string]any{
			"/hello": map[string]any{},
		},
	}
	specBytes, _ := json.Marshal(mockSpec)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(specBytes)
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result := DetectOpenApiSpec(ctx, server.URL+"/custom/path/spec.json", "")
	require.NotNil(t, result)
	assert.Equal(t, "3.1.0", result.Version)
	assert.Equal(t, "Direct Spec API", result.Title)
}

func TestDetectOpenApiSpec_Non2xxAndLargePayload(t *testing.T) {
	AllowTestLoopback = true
	t.Cleanup(func() { AllowTestLoopback = false })

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/500.json":
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"server error"}`))
		case "/huge.json":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			chunk := make([]byte, 1024*1024)
			for i := 0; i < 16; i++ {
				_, _ = w.Write(chunk)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	res500 := DetectOpenApiSpec(ctx, server.URL+"/500.json", "")
	assert.Nil(t, res500)

	resHuge := DetectOpenApiSpec(ctx, server.URL+"/huge.json", "")
	assert.Nil(t, resHuge)
}

func TestFetchAndValidateSpec_YamlBillionLaughsDefense(t *testing.T) {
	AllowTestLoopback = true
	t.Cleanup(func() { AllowTestLoopback = false })

	bombYaml := `
a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]
`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-yaml")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(bombYaml))
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	client := NewSafeHTTPClient(2*time.Second, 1)
	res := fetchAndValidateSpec(ctx, client, server.URL+"/bomb.yaml")
	assert.Nil(t, res, "YAML alias bomb without valid OpenAPI structure must return nil")
}
