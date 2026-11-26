package webdoc

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRobotsQueryMatching(t *testing.T) {
	AllowTestLoopback = true
	t.Cleanup(func() { AllowTestLoopback = false })
	resetRobotsCache()
	defer resetRobotsCache()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/robots.txt" {
			_, _ = w.Write([]byte("User-agent: *\nDisallow: /*?\n"))
			return
		}
		_, _ = w.Write([]byte("ok"))
	}))
	defer ts.Close()

	if IsUrlAllowedByRobots(context.Background(), ts.URL+"/page") {
		t.Log("clean path allowed as expected")
	} else {
		t.Fatal("clean path must be allowed")
	}
	if IsUrlAllowedByRobots(context.Background(), ts.URL+"/page?replytocom=1") {
		t.Fatal("query URL must be blocked by Disallow: /*?")
	}
}

func TestRobotsServerErrorFailClosed(t *testing.T) {
	AllowTestLoopback = true
	t.Cleanup(func() { AllowTestLoopback = false })
	resetRobotsCache()
	defer resetRobotsCache()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer ts.Close()

	if IsUrlAllowedByRobots(context.Background(), ts.URL+"/any") {
		t.Fatal("5xx robots must fail closed to disallow-all")
	}
}
