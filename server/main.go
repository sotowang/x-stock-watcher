package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	ossignal "os/signal"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "modernc.org/sqlite"
)

const maxRequestBytes = 16 << 10

var (
	postIDPattern = regexp.MustCompile(`^[0-9]{5,30}$`)
	handlePattern = regexp.MustCompile(`^[A-Za-z0-9_]{1,15}$`)
	tickerPattern = regexp.MustCompile(`^[A-Z]{1,5}$`)
)

type config struct {
	ListenAddr      string
	DatabasePath    string
	Tokens          []string
	DailyTokenLimit int
}

type signalPayload struct {
	PostID         string   `json:"postId"`
	Handle         string   `json:"handle"`
	PostURL        string   `json:"postUrl"`
	PostTime       string   `json:"postTime,omitempty"`
	SubscriberOnly bool     `json:"subscriberOnly"`
	DiscordWebhook string   `json:"discordWebhookUrl"`
	Signals        []signal `json:"signals"`
}

type signal struct {
	Ticker     string  `json:"ticker"`
	Type       string  `json:"type"`
	Direction  string  `json:"direction"`
	Action     string  `json:"action"`
	Confidence float64 `json:"confidence"`
	Conclusion string  `json:"conclusion"`
}

type app struct {
	db             *sql.DB
	webhookURL     string // test-only override; production uses the payload destination
	tokenHashes    map[string]struct{}
	dailyLimit     int
	client         *http.Client
	wake           chan struct{}
	rateMu         sync.Mutex
	rateCounters   map[string]int
	resolveChannel func(context.Context, string) (string, error)
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	db, err := openDatabase(cfg.DatabasePath)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	a := newApp(db, cfg)
	ctx, cancel := ossignal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	go a.runDispatcher(ctx)

	server := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           a.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		_ = server.Shutdown(shutdownCtx)
	}()

	log.Printf("discord relay listening on %s", cfg.ListenAddr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func loadConfig() (config, error) {
	cfg := config{
		ListenAddr:      envOr("LISTEN_ADDR", "127.0.0.1:8787"),
		DatabasePath:    envOr("DATABASE_PATH", "./data/relay.db"),
		DailyTokenLimit: envInt("DAILY_TOKEN_LIMIT", 200),
	}
	for _, token := range strings.Split(os.Getenv("INGEST_TOKENS"), ",") {
		if token = strings.TrimSpace(token); token != "" {
			cfg.Tokens = append(cfg.Tokens, token)
		}
	}
	if len(cfg.Tokens) == 0 {
		return cfg, errors.New("INGEST_TOKENS must contain at least one access token")
	}
	return cfg, nil
}

func openDatabase(path string) (*sql.DB, error) {
	if dir := directoryOf(path); dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	statements := []string{
		`PRAGMA journal_mode=WAL`,
		`PRAGMA busy_timeout=5000`,
		`CREATE TABLE IF NOT EXISTS deliveries (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			channel_key TEXT NOT NULL,
			post_id TEXT NOT NULL,
			payload TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			attempts INTEGER NOT NULL DEFAULT 0,
			next_attempt_at TEXT,
			discord_message_id TEXT,
			last_error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE(channel_key, post_id)
		)`,
		`CREATE INDEX IF NOT EXISTS deliveries_pending_idx ON deliveries(status, next_attempt_at, id)`,
		`UPDATE deliveries SET status='pending' WHERE status='processing'`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			db.Close()
			return nil, err
		}
	}
	return db, nil
}

func newApp(db *sql.DB, cfg config) *app {
	hashes := make(map[string]struct{}, len(cfg.Tokens))
	for _, token := range cfg.Tokens {
		hashes[hashToken(token)] = struct{}{}
	}
	return &app{
		db:          db,
		tokenHashes: hashes, dailyLimit: cfg.DailyTokenLimit,
		client: &http.Client{Timeout: 10 * time.Second}, wake: make(chan struct{}, 1),
		rateCounters: make(map[string]int),
	}
}

func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", a.handleHealth)
	mux.HandleFunc("POST /v1/subscriber-signals", a.authorized(a.handleSignal))
	mux.HandleFunc("POST /v1/test", a.authorized(a.handleTest))
	return securityHeaders(mux)
}

func (a *app) authorized(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		hash := hashToken(token)
		if token == "" || !a.validTokenHash(hash) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
			return
		}
		if !a.allowRequest(hash) {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"ok": false, "error": "daily token limit exceeded"})
			return
		}
		next(w, r)
	}
}

func (a *app) handleHealth(w http.ResponseWriter, _ *http.Request) {
	if err := a.db.Ping(); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *app) handleSignal(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var payload signalPayload
	if err := decoder.Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid JSON payload"})
		return
	}
	if err := validatePayload(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	channelID, err := a.discordChannelID(r.Context(), payload.DiscordWebhook)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "Discord webhook could not be verified"})
		return
	}
	encoded, _ := json.Marshal(payload)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := a.db.Exec(`INSERT OR IGNORE INTO deliveries
		(channel_key, post_id, payload, status, created_at, updated_at)
		VALUES (?, ?, ?, 'pending', ?, ?)`, channelID, payload.PostID, string(encoded), now, now)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": "database error"})
		return
	}
	inserted, _ := result.RowsAffected()
	if inserted == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "status": "duplicate"})
		return
	}
	a.signalDispatcher()
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "status": "accepted"})
}

func (a *app) handleTest(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
	var destination struct {
		DiscordWebhook string `json:"discordWebhookUrl"`
	}
	if err := json.NewDecoder(r.Body).Decode(&destination); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid JSON payload"})
		return
	}
	if _, err := validatedWebhookURL(destination.DiscordWebhook); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	payload := signalPayload{
		PostID: "test", Handle: "XStockWatcher", PostURL: "https://x.com/",
		PostTime: time.Now().UTC().Format(time.RFC3339), SubscriberOnly: true,
		DiscordWebhook: destination.DiscordWebhook,
		Signals:        []signal{{Ticker: "TEST", Type: "trade", Direction: "long", Action: "test", Confidence: 1, Conclusion: "Discord relay connection is working."}},
	}
	messageID, retryAfter, permanent, err := a.sendDiscord(r.Context(), payload)
	if err != nil {
		status := http.StatusBadGateway
		if permanent {
			status = http.StatusFailedDependency
		}
		writeJSON(w, status, map[string]any{"ok": false, "error": err.Error(), "retryAfter": retryAfter.Seconds()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "messageId": messageID})
}

func validatePayload(payload *signalPayload) error {
	payload.PostID = strings.TrimSpace(payload.PostID)
	payload.Handle = strings.TrimPrefix(strings.TrimSpace(payload.Handle), "@")
	payload.PostURL = strings.TrimSpace(payload.PostURL)
	payload.DiscordWebhook = strings.TrimSpace(payload.DiscordWebhook)
	if _, err := validatedWebhookURL(payload.DiscordWebhook); err != nil {
		return err
	}
	if !payload.SubscriberOnly {
		return errors.New("only subscriber-only posts are accepted")
	}
	if !postIDPattern.MatchString(payload.PostID) {
		return errors.New("invalid X post ID")
	}
	if !handlePattern.MatchString(payload.Handle) {
		return errors.New("invalid X account handle")
	}
	postURL, err := url.Parse(payload.PostURL)
	if err != nil || postURL.Scheme != "https" || (postURL.Hostname() != "x.com" && postURL.Hostname() != "www.x.com" && postURL.Hostname() != "twitter.com" && postURL.Hostname() != "www.twitter.com") {
		return errors.New("invalid X post URL")
	}
	expectedPath := "/" + strings.ToLower(payload.Handle) + "/status/" + payload.PostID
	actualPath := strings.ToLower(postURL.Path)
	if actualPath != expectedPath && !strings.HasPrefix(actualPath, expectedPath+"/") {
		return errors.New("post URL does not match the handle and post ID")
	}
	if len(payload.Signals) == 0 || len(payload.Signals) > 10 {
		return errors.New("signals must contain between 1 and 10 items")
	}
	allowedDirections := map[string]bool{"long": true, "short": true}
	allowedTypes := map[string]bool{"trade": true, "recommendation": true, "forecast": true}
	allowedActions := map[string]bool{"buy": true, "add": true, "hold": true, "sell": true, "short": true, "cover": true, "forecast_up": true, "forecast_down": true}
	for i := range payload.Signals {
		s := &payload.Signals[i]
		s.Ticker = strings.ToUpper(strings.TrimPrefix(strings.TrimSpace(s.Ticker), "$"))
		s.Conclusion = strings.TrimSpace(s.Conclusion)
		if !tickerPattern.MatchString(s.Ticker) {
			return fmt.Errorf("signal %d has an invalid ticker", i+1)
		}
		if !allowedTypes[s.Type] || !allowedDirections[s.Direction] || !allowedActions[s.Action] {
			return fmt.Errorf("signal %d has invalid classification", i+1)
		}
		if s.Confidence < 0 || s.Confidence > 1 {
			return fmt.Errorf("signal %d has invalid confidence", i+1)
		}
		if len(s.Conclusion) > 500 {
			s.Conclusion = s.Conclusion[:500]
		}
	}
	return nil
}

type delivery struct {
	ID       int64
	Payload  signalPayload
	Attempts int
}

func (a *app) runDispatcher(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		a.dispatchAvailable(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-a.wake:
		}
	}
}

func (a *app) signalDispatcher() {
	select {
	case a.wake <- struct{}{}:
	default:
	}
}

func (a *app) dispatchAvailable(ctx context.Context) {
	for i := 0; i < 20; i++ {
		delivery, ok, err := a.claimDelivery()
		if err != nil {
			log.Printf("claim delivery: %v", err)
			return
		}
		if !ok {
			return
		}
		messageID, retryAfter, permanent, sendErr := a.sendDiscord(ctx, delivery.Payload)
		if sendErr == nil {
			_, err = a.db.Exec(`UPDATE deliveries SET status='sent', discord_message_id=?, last_error=NULL, updated_at=? WHERE id=?`, messageID, nowString(), delivery.ID)
		} else if permanent || delivery.Attempts+1 >= 8 {
			_, err = a.db.Exec(`UPDATE deliveries SET status='dead', attempts=attempts+1, last_error=?, updated_at=? WHERE id=?`, sendErr.Error(), nowString(), delivery.ID)
		} else {
			if retryAfter <= 0 {
				retryAfter = backoff(delivery.Attempts + 1)
			}
			next := time.Now().UTC().Add(retryAfter).Format(time.RFC3339Nano)
			_, err = a.db.Exec(`UPDATE deliveries SET status='retry', attempts=attempts+1, next_attempt_at=?, last_error=?, updated_at=? WHERE id=?`, next, sendErr.Error(), nowString(), delivery.ID)
		}
		if err != nil {
			log.Printf("update delivery %d: %v", delivery.ID, err)
		}
	}
}

func (a *app) claimDelivery() (delivery, bool, error) {
	var d delivery
	var raw string
	err := a.db.QueryRow(`SELECT id, payload, attempts FROM deliveries
		WHERE status IN ('pending','retry') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
		ORDER BY id LIMIT 1`, nowString()).Scan(&d.ID, &raw, &d.Attempts)
	if errors.Is(err, sql.ErrNoRows) {
		return d, false, nil
	}
	if err != nil {
		return d, false, err
	}
	result, err := a.db.Exec(`UPDATE deliveries SET status='processing', updated_at=? WHERE id=? AND status IN ('pending','retry')`, nowString(), d.ID)
	if err != nil {
		return d, false, err
	}
	changed, _ := result.RowsAffected()
	if changed == 0 {
		return d, false, nil
	}
	if err := json.Unmarshal([]byte(raw), &d.Payload); err != nil {
		return d, false, err
	}
	return d, true, nil
}

func (a *app) sendDiscord(ctx context.Context, payload signalPayload) (string, time.Duration, bool, error) {
	fields := make([]map[string]any, 0, len(payload.Signals))
	for _, s := range payload.Signals {
		value := s.Conclusion
		if value == "" {
			value = "Explicit stock signal"
		}
		value += fmt.Sprintf("\n**Confidence:** %d%%", int(s.Confidence*100+0.5))
		fields = append(fields, map[string]any{
			"name":  fmt.Sprintf("$%s · %s · %s", s.Ticker, titleWord(s.Direction), actionLabel(s.Action)),
			"value": value, "inline": false,
		})
	}
	embed := map[string]any{
		"title": "🔒 Subscriber-only signal · @" + payload.Handle,
		"url":   payload.PostURL, "color": 0xa21caf, "fields": fields,
		"footer": map[string]string{"text": "X Stock Watcher · Open the original post to verify access and context"},
	}
	if parsed, err := time.Parse(time.RFC3339, payload.PostTime); err == nil {
		embed["timestamp"] = parsed.UTC().Format(time.RFC3339)
	}
	body, _ := json.Marshal(map[string]any{
		"username": "X Stock Watcher", "embeds": []any{embed},
		"allowed_mentions": map[string]any{"parse": []string{}},
	})
	var webhook *url.URL
	var err error
	if a.webhookURL != "" {
		webhook, err = url.Parse(a.webhookURL)
	} else {
		webhook, err = validatedWebhookURL(payload.DiscordWebhook)
	}
	if err != nil {
		return "", 0, true, err
	}
	query := webhook.Query()
	query.Set("wait", "true")
	webhook.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, webhook.String(), strings.NewReader(string(body)))
	if err != nil {
		return "", 0, false, err
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := a.client.Do(req)
	if err != nil {
		return "", 0, false, err
	}
	defer response.Body.Close()
	limited := io.LimitReader(response.Body, 32<<10)
	responseBody, _ := io.ReadAll(limited)
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		var result struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(responseBody, &result)
		return result.ID, 0, false, nil
	}
	if response.StatusCode == http.StatusTooManyRequests {
		var result struct {
			RetryAfter float64 `json:"retry_after"`
		}
		_ = json.Unmarshal(responseBody, &result)
		return "", time.Duration(result.RetryAfter * float64(time.Second)), false, errors.New("Discord rate limited the webhook")
	}
	permanent := response.StatusCode == 401 || response.StatusCode == 403 || response.StatusCode == 404
	return "", 0, permanent, fmt.Errorf("Discord returned HTTP %d", response.StatusCode)
}

func validatedWebhookURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || (parsed.Hostname() != "discord.com" && parsed.Hostname() != "discordapp.com") || !strings.HasPrefix(parsed.Path, "/api/webhooks/") {
		return nil, errors.New("discordWebhookUrl must be an HTTPS Discord webhook URL")
	}
	return parsed, nil
}

func (a *app) discordChannelID(ctx context.Context, webhookURL string) (string, error) {
	if a.resolveChannel != nil {
		return a.resolveChannel(ctx, webhookURL)
	}
	webhook, err := validatedWebhookURL(webhookURL)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, webhook.String(), nil)
	if err != nil {
		return "", err
	}
	response, err := a.client.Do(req)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("Discord returned HTTP %d", response.StatusCode)
	}
	var metadata struct {
		ChannelID string `json:"channel_id"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 32<<10)).Decode(&metadata); err != nil || metadata.ChannelID == "" {
		return "", errors.New("Discord webhook has no channel ID")
	}
	return metadata.ChannelID, nil
}

func (a *app) validTokenHash(hash string) bool { _, ok := a.tokenHashes[hash]; return ok }

func (a *app) allowRequest(tokenHash string) bool {
	if a.dailyLimit <= 0 {
		return true
	}
	key := time.Now().UTC().Format("2006-01-02") + ":" + tokenHash
	a.rateMu.Lock()
	defer a.rateMu.Unlock()
	for existing := range a.rateCounters {
		if !strings.HasPrefix(existing, time.Now().UTC().Format("2006-01-02")+":") {
			delete(a.rateCounters, existing)
		}
	}
	if a.rateCounters[key] >= a.dailyLimit {
		return false
	}
	a.rateCounters[key]++
	return true
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
func nowString() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func backoff(attempt int) time.Duration {
	delay := time.Minute * time.Duration(1<<min(attempt, 6))
	if delay > time.Hour {
		return time.Hour
	}
	return delay
}
func titleWord(value string) string {
	if value == "" {
		return value
	}
	return strings.ToUpper(value[:1]) + value[1:]
}
func actionLabel(value string) string { return strings.ReplaceAll(titleWord(value), "_", " ") }
func directoryOf(path string) string {
	index := strings.LastIndexAny(path, `/\`)
	if index < 0 {
		return "."
	}
	return path[:index]
}
func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
func envInt(key string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key)))
	if err != nil {
		return fallback
	}
	return value
}
