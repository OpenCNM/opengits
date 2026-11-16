package mdx

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHandleHeal(t *testing.T) {
	healPayload, _ := json.Marshal(HealRequest{
		Content: "# API Spec\nText with {query}\n\n```json\n{\"raw\": true}\n```\n\nInline `{keep: 1}` code",
	})
	emptyPayload, _ := json.Marshal(HealRequest{
		Content: "",
	})
	pandocPayload, _ := json.Marshal(HealRequest{
		Content: "===CONTENT_BEGIN===\n![alt](/img.png){width=50%}\n===CONTENT_END===",
	})
	csharpPayload, _ := json.Marshal(HealRequest{
		Content: "# C# Example\n```c#\nint x = 1;\n```\nSome {brace}",
	})

	tests := []struct {
		name         string
		body         string
		wantStatus   int
		wantOk       bool
		wantContains []string
		wantExclude  []string
	}{
		{
			name:       "bad request on invalid json",
			body:       `{invalid-json`,
			wantStatus: http.StatusBadRequest,
			wantOk:     false,
		},
		{
			name:       "empty content returns empty string",
			body:       string(emptyPayload),
			wantStatus: http.StatusOK,
			wantOk:     true,
		},
		{
			name:       "heals prose braces while preserving code block braces",
			body:       string(healPayload),
			wantStatus: http.StatusOK,
			wantOk:     true,
			wantContains: []string{
				"Text with &#123;query&#125;",
				"{\"raw\": true}",
				"`{keep: 1}`",
			},
			wantExclude: []string{
				"Text with {query}",
			},
		},
		{
			name:       "strips pandoc image extensions and sentinels",
			body:       string(pandocPayload),
			wantStatus: http.StatusOK,
			wantOk:     true,
			wantContains: []string{
				"![alt](/img.png)",
			},
			wantExclude: []string{
				"===CONTENT_BEGIN===",
				"===CONTENT_END===",
				"{width=50%}",
			},
		},
		{
			name:       "strictly preserves code block language aliases (zero syntax disruption)",
			body:       string(csharpPayload),
			wantStatus: http.StatusOK,
			wantOk:     true,
			wantContains: []string{
				"```c#",
				"int x = 1;",
				"Some &#123;brace&#125;",
			},
			wantExclude: []string{
				"```csharp",
				"Some {brace}",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/v1/mdx/heal", bytes.NewBufferString(tt.body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			HandleHeal(rec, req)

			assert.Equal(t, tt.wantStatus, rec.Code)
			if tt.wantStatus == http.StatusOK {
				var resp HealResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.Equal(t, tt.wantOk, resp.Ok)
				for _, s := range tt.wantContains {
					assert.Contains(t, resp.Content, s)
				}
				for _, s := range tt.wantExclude {
					assert.NotContains(t, resp.Content, s)
				}
			}
		})
	}
}

func TestHandleValidate(t *testing.T) {
	validPayload, _ := json.Marshal(ValidateRequest{
		Content: "# Title\n\nA normal paragraph with standard markdown.",
	})
	emptyPayload, _ := json.Marshal(ValidateRequest{
		Content: "",
	})
	genericCollisionPayload, _ := json.Marshal(ValidateRequest{
		Content: "Some text with <T> generic collision outside code block.",
	})
	unclosedTagPayload, _ := json.Marshal(ValidateRequest{
		Content: "# Section\n\n<CustomWrapper>\nParagraph text without closing tag.",
	})

	tests := []struct {
		name            string
		body            string
		wantStatus      int
		wantOk          bool
		wantValid       bool
		wantErrContains string
		wantErrEmpty    bool
	}{
		{
			name:       "bad request on invalid json",
			body:       `{invalid-json`,
			wantStatus: http.StatusBadRequest,
			wantOk:     false,
		},
		{
			name:         "valid mdx content returns valid true",
			body:         string(validPayload),
			wantStatus:   http.StatusOK,
			wantOk:       true,
			wantValid:    true,
			wantErrEmpty: true,
		},
		{
			name:         "empty content returns valid true",
			body:         string(emptyPayload),
			wantStatus:   http.StatusOK,
			wantOk:       true,
			wantValid:    true,
			wantErrEmpty: true,
		},
		{
			name:            "generic type collision returns valid false with error",
			body:            string(genericCollisionPayload),
			wantStatus:      http.StatusOK,
			wantOk:          true,
			wantValid:       false,
			wantErrContains: "generic type parameter collision",
		},
		{
			name:            "unclosed tag returns valid false with error",
			body:            string(unclosedTagPayload),
			wantStatus:      http.StatusOK,
			wantOk:          true,
			wantValid:       false,
			wantErrContains: "closing tag",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/v1/mdx/validate", bytes.NewBufferString(tt.body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			HandleValidate(rec, req)

			assert.Equal(t, tt.wantStatus, rec.Code)
			if tt.wantStatus == http.StatusOK {
				var resp ValidateResponse
				err := json.Unmarshal(rec.Body.Bytes(), &resp)
				require.NoError(t, err)
				assert.Equal(t, tt.wantOk, resp.Ok)
				assert.Equal(t, tt.wantValid, resp.Valid)
				if tt.wantErrEmpty {
					assert.Empty(t, resp.Error)
				}
				if tt.wantErrContains != "" {
					assert.Contains(t, resp.Error, tt.wantErrContains)
				}
			}
		})
	}
}
