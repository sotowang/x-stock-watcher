# Self-hosted Discord relay

The relay accepts structured subscriber-only stock signals from X Stock Watcher, resolves each user-provided Discord webhook to its real channel ID, atomically deduplicates each X post per channel with SQLite, and delivers a fixed Discord embed. Failed deliveries remain in a database-backed outbox and retry automatically after restarts.

The relay never needs X cookies, an AI API key, or the full subscriber-only post text and images.

## Requirements

- A Linux server that can reach `discord.com`
- HTTPS through Caddy, Nginx, or another reverse proxy
- Go 1.25+ for a native build, or Docker
- A Discord incoming webhook for the destination channel

## Configure

Create a long random installation token:

```bash
openssl rand -hex 32
```

Copy `.env.example` to `.env` and set:

```dotenv
LISTEN_ADDR=127.0.0.1:8787
DATABASE_PATH=./data/relay.db
INGEST_TOKENS=one-long-random-token,another-token-if-needed
DAILY_TOKEN_LIMIT=200
```

Use a different token for each person or installation when practical. Tokens are hashed before comparison and are never written to the database or application logs.

## Run natively

```bash
cd server
go build -o relay .
set -a
. ./.env
set +a
./relay
```

The service listens on `127.0.0.1:8787` by default. Keep it behind HTTPS rather than exposing the Go listener directly.

Example Caddy configuration:

```caddyfile
notify.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Example systemd unit files are provided under [`deploy/`](deploy/). Copy the environment file outside the repository, restrict it to the service user, and update the paths in the unit before enabling it.

## Run with Docker

```bash
docker build -t x-stock-watcher-relay .
docker run -d \
  --name x-stock-watcher-relay \
  --restart unless-stopped \
  --env-file .env \
  -p 127.0.0.1:8787:8787 \
  -v "$PWD/data:/app/data" \
  x-stock-watcher-relay
```

## Verify

```bash
curl https://notify.example.com/healthz
```

Then open the extension and set:

1. **Send subscriber-only signals to Discord**: enabled
2. **Relay server URL**: `https://notify.example.com`
3. **Relay access token**: one value from `INGEST_TOKENS`
4. **Discord channel webhook URL**: create a webhook in that channel's Discord integrations and paste its URL
5. Click **Send Discord test message**

Only new posts are sent. The first scan of an account establishes a baseline without Discord delivery.

## API behavior

`POST /v1/subscriber-signals` requires `Authorization: Bearer <token>` and accepts at most 16 KiB. The server validates the X URL, post ID, handle, signal classification, and subscriber-only flag. The unique key is:

```text
Discord channel ID + X post ID
```

The first valid report returns HTTP `202` with `accepted`; later reports return HTTP `200` with `duplicate`. Discord `429` responses use Discord's requested retry interval. Authentication, permission, and missing-webhook responses become permanent failures; other failures retry up to eight times.

## Operations

- Back up the SQLite database together with its WAL files, or use SQLite's online backup mechanism.
- Monitor `/healthz`, process uptime, disk space, and logs.
- Rotate a compromised token by replacing it in `INGEST_TOKENS` and restarting the service.
- Rotate a compromised Discord webhook in Discord and update it in the affected extension installation.
- Periodically remove old `sent` and `dead` rows according to your retention policy.
- Never commit `.env`, the SQLite database, relay tokens, or Discord webhook URLs. The database contains queued webhook URLs, so protect and back it up as sensitive data.

Subscriber-only content should be delivered only to an appropriately restricted channel. The relay intentionally sends a short signal summary and original link rather than republishing the paid post.
