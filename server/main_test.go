package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testApp(t *testing.T, webhook string) *app {
	t.Helper()
	db, err := openDatabase(filepath.Join(t.TempDir(), "relay.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	a := newApp(db, config{Tokens: []string{"secret"}, DailyTokenLimit: 100})
	a.webhookURL = webhook
	a.resolveChannel = func(context.Context, string) (string, error) { return "test-channel", nil }
	return a
}

func validPayload() signalPayload {
	return signalPayload{
		PostID: "1961234567890123456", Handle: "Brownmoose",
		PostURL:  "https://x.com/Brownmoose/status/1961234567890123456",
		PostTime: "2026-08-29T08:00:00Z", SubscriberOnly: true,
		DiscordWebhook: "https://discord.com/api/webhooks/1/token",
		Signals:        []signal{{Ticker: "ORCL", Type: "forecast", Direction: "long", Action: "forecast_up", Confidence: .82, Conclusion: "The author expects ORCL to continue higher."}},
	}
}

func postJSON(t *testing.T, handler http.Handler, path string, value any) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(value)
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(body)))
	req.Header.Set("Authorization", "Bearer secret")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	return recorder
}

func TestSignalEndpointDeduplicates(t *testing.T) {
	a := testApp(t, "https://discord.com/api/webhooks/1/token")
	first := postJSON(t, a.routes(), "/v1/subscriber-signals", validPayload())
	if first.Code != http.StatusAccepted || !strings.Contains(first.Body.String(), "accepted") {
		t.Fatalf("first response: %d %s", first.Code, first.Body.String())
	}
	second := postJSON(t, a.routes(), "/v1/subscriber-signals", validPayload())
	if second.Code != http.StatusOK || !strings.Contains(second.Body.String(), "duplicate") {
		t.Fatalf("second response: %d %s", second.Code, second.Body.String())
	}
}

func TestDifferentWebhooksForSameChannelDeduplicate(t *testing.T) {
	a := testApp(t, "https://discord.com/api/webhooks/1/token")
	firstPayload := validPayload()
	firstPayload.DiscordWebhook = "https://discord.com/api/webhooks/1/first-token"
	first := postJSON(t, a.routes(), "/v1/subscriber-signals", firstPayload)
	if first.Code != http.StatusAccepted {
		t.Fatalf("first response: %d %s", first.Code, first.Body.String())
	}
	secondPayload := validPayload()
	secondPayload.DiscordWebhook = "https://discord.com/api/webhooks/2/second-token"
	second := postJSON(t, a.routes(), "/v1/subscriber-signals", secondPayload)
	if second.Code != http.StatusOK || !strings.Contains(second.Body.String(), "duplicate") {
		t.Fatalf("second response: %d %s", second.Code, second.Body.String())
	}
}

func TestSignalEndpointRejectsNonSubscriberPost(t *testing.T) {
	a := testApp(t, "https://discord.com/api/webhooks/1/token")
	payload := validPayload()
	payload.SubscriberOnly = false
	response := postJSON(t, a.routes(), "/v1/subscriber-signals", payload)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("response: %d %s", response.Code, response.Body.String())
	}
}

func TestSignalEndpointRequiresAuthentication(t *testing.T) {
	a := testApp(t, "https://discord.com/api/webhooks/1/token")
	body, _ := json.Marshal(validPayload())
	req := httptest.NewRequest(http.MethodPost, "/v1/subscriber-signals", strings.NewReader(string(body)))
	recorder := httptest.NewRecorder()
	a.routes().ServeHTTP(recorder, req)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("response: %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestDispatcherSendsSafeEmbed(t *testing.T) {
	var received map[string]any
	discord := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("wait") != "true" {
			t.Error("missing wait=true")
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"discord-message-id"}`))
	}))
	defer discord.Close()

	a := testApp(t, "https://discord.com/api/webhooks/1/token")
	a.webhookURL = discord.URL + "/api/webhooks/1/token"
	a.client = discord.Client()
	messageID, _, _, err := a.sendDiscord(context.Background(), validPayload())
	if err != nil {
		t.Fatal(err)
	}
	if messageID != "discord-message-id" {
		t.Fatalf("message id = %q", messageID)
	}
	mentions := received["allowed_mentions"].(map[string]any)["parse"].([]any)
	if len(mentions) != 0 {
		t.Fatal("mentions were not disabled")
	}
}

func TestAcceptedDeliveryReachesDiscordAndBecomesSent(t *testing.T) {
	discord := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"sent-message"}`))
	}))
	defer discord.Close()

	a := testApp(t, "https://discord.com/api/webhooks/1/token")
	a.webhookURL = discord.URL + "/api/webhooks/1/token"
	a.client = discord.Client()
	response := postJSON(t, a.routes(), "/v1/subscriber-signals", validPayload())
	if response.Code != http.StatusAccepted {
		t.Fatalf("response: %d %s", response.Code, response.Body.String())
	}
	a.dispatchAvailable(context.Background())
	var status, messageID string
	if err := a.db.QueryRow(`SELECT status, discord_message_id FROM deliveries`).Scan(&status, &messageID); err != nil {
		t.Fatal(err)
	}
	if status != "sent" || messageID != "sent-message" {
		t.Fatalf("status=%q messageID=%q", status, messageID)
	}
}

func TestPayloadRejectsPostIDSuffix(t *testing.T) {
	payload := validPayload()
	payload.PostURL += "999"
	if err := validatePayload(&payload); err == nil {
		t.Fatal("expected mismatched URL to be rejected")
	}
}

func TestRetryAfter(t *testing.T) {
	discord := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"retry_after":1.5}`))
	}))
	defer discord.Close()
	a := testApp(t, "https://discord.com/api/webhooks/1/token")
	a.webhookURL = discord.URL + "/api/webhooks/1/token"
	a.client = discord.Client()
	_, retry, permanent, err := a.sendDiscord(context.Background(), validPayload())
	if err == nil || permanent || retry != 1500*time.Millisecond {
		t.Fatalf("retry=%s permanent=%v err=%v", retry, permanent, err)
	}
}

func countDeliveries(t *testing.T, db *sql.DB) int {
	t.Helper()
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM deliveries`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}
