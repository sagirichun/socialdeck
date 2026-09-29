# SocialDeck

Enterprise social media operations platform. Connect many brand accounts, schedule and publish
content across nine networks, auto-reply to inbound comments with an AI model you control, and
relay pre-recorded video to RTMP ingest 24/7.

Built as a single Next.js application: one process serves the console and the API, background
work runs in a separate worker, and state lives in SQLite with an optional Redis-backed queue.

---

## Table of contents

- [Capabilities](#capabilities)
- [Architecture](#architecture)
- [Stack decisions](#stack-decisions)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Docker](#docker)
- [Going live](#going-live)
- [Connecting platforms](#connecting-platforms)
- [AI configuration](#ai-configuration)
- [RTMP relay](#rtmp-relay)
- [Operations](#operations)
- [Security model](#security-model)
- [Project layout](#project-layout)
- [Extending](#extending)
- [Troubleshooting](#troubleshooting)

---

## Capabilities

**Multi-account management.** Connect any number of accounts per network through OAuth 2.0
(authorization code, PKCE where the platform requires it) or static credentials for endpoints
that do not offer an OAuth flow. Access and refresh tokens are encrypted at rest with
AES-256-GCM. Supported networks:

| Network | Auth | Publish | Inbound comments | Metrics |
|---|---|---|---|---|
| Facebook Page | OAuth | text, image, video, link | yes | followers, impressions |
| Instagram Business | OAuth | image, video, carousel, Reels | yes | followers, reach |
| YouTube | OAuth | video, Shorts, community post | yes | views, subscribers |
| X (Twitter) | OAuth 1.0a / 2.0 | text, image, video | yes | impressions, followers |
| TikTok | OAuth | video, photo post | yes | views, followers |
| Threads | OAuth | text, image, video | yes | followers, likes |
| LinkedIn | OAuth | text, image, article | yes | impressions |
| Pinterest | OAuth | pin, video pin | no | saves, impressions |
| Mastodon | Static token | text, image, video | yes | followers |
| RTMP / SRT ingest | Static key | live video relay | no | ingest health |

**AI auto-reply.** Inbound comments arrive through platform webhooks or the polling fallback,
are classified for sentiment, intent and risk, and routed against per-account rules. Each rule
carries a tone, a language set, brand guidance, escalation keywords, quiet hours, blocked
topics and an hourly ceiling. Replies either land in a human approval queue or auto-send when
the rule and the classification both allow it. Refusals are explained, never silent.

**Publishing queue.** Every post is written to a SQL ledger before it is enqueued, so queue
state survives a broker restart and the console never lies about what is in flight. When Redis
is reachable, BullMQ drives the work; when it is not, an in-process timer wheel takes over and
the app keeps working on a single node. Per-account rate limits are enforced in the worker.

**RTMP relay.** Build a playlist from the media library, point it at an ingest URL, and ffmpeg
loops it 24/7 with H.264/AAC normalisation, a two-second keyframe interval and a target
bitrate. The supervisor tracks the child process, restarts it on unexpected exit, and streams
the ffmpeg log tail to the console.

**Media library.** Upload images and video, probe dimensions and duration, generate aspect
variants for each placement (9:16, 1:1, 4:5, 16:9) with ffmpeg crop chains, and dedupe by
content hash.

**Operations copilot.** An agent loop that plans against a tool catalog, executes read and
write tools, observes results and iterates, with a step ceiling and an approval gate for tools
that mutate state. Every step is persisted and replayable.

**Console surfaces.** Dashboard, composer, calendar, unified inbox, accounts, streams, AI
providers, agent, rules, media, queue, audit log, settings.

---

## Architecture

```
                     +-------------------------------+
   operator -------> |  Next.js app (console + API)  |
                     |  route handlers, session auth  |
                     +---------------+---------------+
                                     |
                    +----------------+----------------+
                    |                                 |
            +-------v--------+              +---------v---------+
            |  SQLite (WAL)  |              |  BullMQ + Redis   |
            |  ledger + data |              |  (optional)       |
            +-------+--------+              +---------+---------+
                    |                                 |
                    |                       +---------v---------+
                    |                       |  worker process   |
                    |                       |  publish / reply  |
                    |                       |  metrics / stream |
                    |                       +---------+---------+
                    |                                 |
                    +----------------+----------------+
                                     |
                     +---------------+---------------+
                     |                               |
            +--------v--------+            +---------v---------+
            |  platform APIs  |            |  ffmpeg -> RTMP   |
            +-----------------+            +-------------------+
```

Two processes, one codebase:

- `npm start` — the web tier (console + API)
- `npm run worker` — background consumers for publish, reply, metrics, stream and agent queues

The web tier degrades to inline execution when Redis is absent, which is why a single process
is enough for evaluation, small teams and single-node self-hosting.

---

## Stack decisions

| Choice | Why |
|---|---|
| **Next.js (App Router)** | One process for UI and API. Server route handlers give the same runtime for webhooks, OAuth callbacks and console data, so there is no second service to deploy or secure. |
| **SQLite via `node:sqlite`** | Node ships the driver. No native build step, no extra service, and WAL mode handles the read-heavy console plus a few concurrent workers. The schema is plain SQL you can read. |
| **BullMQ + Redis (optional)** | The queue needs delayed jobs, retries and a real broker once throughput grows. Keeping it optional means the app runs with zero infrastructure while still scaling to a proper worker pool. |
| **SQL ledger for queue state** | Broker state is invisible to the console when Redis is down. Writing the job row first makes queue history durable and the UI truthful in both modes. |
| **AES-256-GCM for tokens** | Platform tokens are long-lived bearer credentials. Column-level encryption means a database copy alone is not enough to act as the brand. |
| **ffmpeg via `child_process`** | The relay is a deterministic argument list plus a supervised child. A wrapper library would hide the exact flags, and the flags are the product. |
| **Tailwind + hand-rolled SVG charts** | The console needs exact axis labels and no layout surprises. A chart library would add a large dependency for four chart types. |

If you swap SQLite for Postgres, `src/lib/db.ts` is the only file that changes: it exposes
`all`, `one`, `run`, `uid` and `json`, and nothing else in the codebase touches a driver.

---

## Requirements

- **Node.js 22.13 or newer** — a hard floor, not a preference. `node:sqlite` is the persistence
  layer and it only exists unflagged from 22.13. The install fails loudly below that (`.npmrc`
  sets `engine-strict`, and every script entry point re-checks at runtime).
- **ffmpeg and ffprobe on `PATH`** — required for the relay, media probing and aspect variants.
  Publishing text and images works without it.
- **Redis 7+** — optional, only for the multi-process queue
- A machine that can reach the platform APIs you intend to publish to

### Checking your Node version

```bash
node -v     # must print v22.13.0 or higher
```

Distribution packages — and **Termux**, which is still on Node 20 — are usually too old.
If `node -v` prints v20 or lower, upgrade first:

```bash
# any Linux, including a proot/chroot Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs

# or without root
curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22 && fnm use 22

# Termux (the host, not inside proot)
pkg install nodejs-lts
```

Running under proot/chroot: install Node *inside* the guest, not on the Termux host — the
guest cannot see the host's runtime.

---

## Quick start

```bash
git clone https://github.com/sagirichun/socialdeck.git
cd socialdeck
npm install

cp .env.example .env
# Generate the encryption key. Every stored token is bound to it: changing it later
# invalidates all saved platform credentials and sessions.
node -e "console.log('APP_SECRET=' + require('crypto').randomBytes(32).toString('hex'))" >> .env

npm run migrate     # create the schema
npm run seed        # optional: demo accounts, posts, comments, streams

npm run dev         # console on http://localhost:3000
```

The seed prints the credentials it created. They are random per run unless you export
`SEED_ADMIN_PASSWORD` first; nothing usable is committed to the repository:

```
seed complete
  admin login: admin@socialdeck.local / <generated-password>
  accounts: 7, media: 4, comments: 8
```

Store that password somewhere safe — it is printed once and only as a hash is kept.

Run the background worker in a second terminal when you want scheduled work to execute even
while no browser is open:

```bash
npm run worker
```

Verify the install:

```bash
npm run check       # 24 assertions: schema, adapters, queue, publish, AI, crypto, SSRF guard
npm run typecheck   # strict TypeScript, no emit
npm run build       # production build
```

`npm run check` is the fastest way to know whether an environment is correctly provisioned. It
boots the domain layer without HTTP, exercises one write path per subsystem against a local
OpenAI-compatible test double, and exits non-zero on failure.

---

## Docker

The compose file runs the app, the worker and Redis together:

```bash
cp .env.example .env
node -e "console.log('APP_SECRET=' + require('crypto').randomBytes(32).toString('hex'))" >> .env
echo "REDIS_PASSWORD=$(openssl rand -hex 16)" >> .env

docker compose up -d --build
docker compose exec app npm run migrate
docker compose exec app npm run seed      # optional
```

The console is on `http://localhost:3111`. Data, media and Redis append-only files live in
named volumes, so `docker compose down` keeps your content and `docker compose down -v` erases
it.

The image installs ffmpeg, so the relay and media variants work without host packages.

---

## Going live

Out of the box `OUTBOUND_MODE=sandbox`: publishing and relay actions are simulated and
recorded, nothing leaves the machine. This is the safe way to explore the console with real
data shapes.

Set it to `live` when you are ready to act on real accounts:

```bash
OUTBOUND_MODE=live
```

Before that, set `APP_URL` to the public origin of the deployment. OAuth redirect URIs and
webhook signature checks are derived from it, and a mismatch is the most common cause of a
callback that fails only in production.

```bash
APP_URL=https://social.example.com
```

---

## Connecting platforms

OAuth credentials are stored per platform in the console under **Accounts**, not in
environment variables, so one deployment can serve several brands with separate apps.

1. Create an app in the platform's developer console.
2. Add the redirect URI it shows you in SocialDeck: `<APP_URL>/api/oauth/<platform>/callback`
3. Paste the client id and secret into **Accounts → OAuth applications**.
4. Click **Connect** on the platform and finish the consent screen.

Platforms that do not offer OAuth (Mastodon, RTMP ingest) take a token or stream key directly.

**Webhooks.** Point the platform's webhook at `<APP_URL>/api/webhooks/<platform>`. Signature
verification is on by default; the secret is the one configured with the OAuth app. Until a
webhook is registered, the metrics queue polls for new comments instead, so auto-reply still
works — it is just slower to notice.

---

## AI configuration

Any provider that speaks the OpenAI chat-completions shape works, as do Anthropic's Messages
API and Ollama's native endpoint. Configure under **AI providers**:

| Field | Notes |
|---|---|
| Kind | `openai`, `anthropic`, `openai-compatible`, `ollama`, `lmstudio`, `router`, `custom` |
| Base URL | `https://api.openai.com`, `http://localhost:11434`, `http://192.168.1.10:8080/v1`, ... |
| Model | provider-specific id |
| API key | optional for local servers; encrypted at rest when present |

Local deployments:

```bash
# Ollama, native endpoint
kind=ollama  base_url=http://localhost:11434  model=llama3.1

# LM Studio or any OpenAI-compatible gateway
kind=openai-compatible  base_url=http://localhost:1234/v1  model=<loaded-model>

# A router in front of several backends
kind=router  base_url=http://192.168.1.10:8080/v1  model=auto
```

A provider marked default is used wherever a rule, the agent or a content tool does not name
one. Use **Test** to send a single probe and see the model's reply, latency and error text
without touching live data.

---

## RTMP relay

1. Add your ingest URL and stream key to an account (YouTube Live, Facebook Live, Twitch, or
   any RTMP server you run).
2. Upload source video to **Media**.
3. Create a stream: pick the playlist, resolution, fps and bitrate.
4. Start it. ffmpeg loops the playlist with `-stream_loop -1`, normalises to H.264/AAC and
   pushes to the ingest. Logs stream into the console; the supervisor restarts on unexpected
   exit.

ffmpeg does not accept arbitrary codecs on RTMP ingest, which is why the relay re-encodes.
Expect roughly one CPU core per 1080p30 stream; lower the preset before lowering the bitrate.

---

## Operations

| Command | Purpose |
|---|---|
| `npm run dev` | Development server with hot reload |
| `npm run build` / `npm start` | Production build and serve |
| `npm run worker` | Background queue consumers |
| `npm run migrate` | Apply pending SQL migrations (idempotent, safe on boot) |
| `npm run seed` | Load the demo dataset |
| `npm run check` | End-to-end self-check, exits non-zero on failure |
| `npm run typecheck` | Strict TypeScript, no emit |

`GET /api/health` returns database counts, queue depth, outbound mode and the ffmpeg version.
Wire it to your uptime monitor; it does not require a session and it answers even when Redis is
down.

The **Audit log** records every mutating action with actor, entity and detail. **Queue** shows
per-job state, last error and throughput, with retry and purge.

---

## Security model

- **Tokens at rest.** AES-256-GCM, key derived from `APP_SECRET`. The console only ever shows
  the last four characters.
- **Sessions.** HTTP-only, SameSite=Lax cookies with a server-side expiry. Password hashing is
  scrypt with a per-user salt.
- **Authorization.** Every route requires a session. Role checks gate destructive operations.
  Unauthenticated requests receive 401 rather than a redirect, so the API fails closed.
- **Webhook integrity.** HMAC-SHA256 verification per platform, computed over the raw body
  before parsing.
- **Ingest URL validation.** The relay URL must use an RTMP/SRT scheme and must not resolve to
  loopback, private, link-local or cloud-metadata address space. This matters because ffmpeg
  turns an operator-supplied string into an outbound connection.
- **Path confinement.** Every media path is resolved and checked against the media root before
  a file handle is opened.

Deploy behind TLS. `APP_SECRET` is the root of trust for both stored tokens and session
cookies: keep it out of version control and rotate it deliberately, knowing rotation requires
reconnecting every platform account.

---

## Project layout

```
src/
  app/
    (app)/              console screens: dashboard, composer, calendar, inbox, accounts,
                        streams, ai, agent, rules, media, queue, audit, settings
    api/                route handlers: auth, accounts, posts, media, comments, replies,
                        rules, streams, ai, agent, dashboard, queue, audit, settings,
                        oauth, webhooks, health
    login/              unauthenticated sign-in
  components/           design system, charts, platform glyphs, application shell
  db/migrations/        numbered SQL migrations, applied in order
  lib/
    agent/              planner, tool catalog, run persistence
    platforms/          one adapter per network, registered in index.ts
    ai.ts               provider-agnostic completion, reply drafting, classification
    auth.ts             sessions, roles, password hashing
    crypto.ts           AES-256-GCM, scrypt, HMAC verification
    db.ts               driver surface and migration runner
    ffmpeg.ts           argument builder, process supervisor, probe
    media.ts            upload, variants, aspect presets
    publishing.ts       post lifecycle, retry, rate limits
    queue.ts            BullMQ wiring with inline fallback
    replies.ts          inbound ingestion, rule routing, reply state machine
    streams.ts          relay supervisor, ingest validation, health
    webhooks.ts         signature verification and normalization
  workers/              queue consumers
scripts/                migrate, seed, check
data/                   SQLite database (created at runtime)
media/                  uploads and stream artifacts (created at runtime)
```

---

## Extending

**Add a network.** Create `src/lib/platforms/<name>.ts` exporting an adapter that satisfies the
`PlatformAdapter` interface, register it with `registerAdapter`, and add one import line to
`src/lib/platforms/index.ts`. The console picks up the new platform from the adapter's declared
capabilities; no UI change is needed.

**Add a migration.** Drop a numbered `.sql` file into `src/db/migrations/`. They run in order on
boot and are recorded, so re-running is safe.

**Swap the database.** Reimplement `all`, `one`, `run`, `uid` and `json` in `src/lib/db.ts`
against your driver. Nothing else imports a database client.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `/api/health` reports `ffmpegPresent: false` | ffmpeg is not on `PATH`. Install it or set `FFMPEG_PATH` to an absolute binary path. |
| Publish jobs stay `queued`, nothing sends | No worker is running. Start `npm run worker`, or keep everything in one process — the inline wheel runs inside the web tier. |
| Queue mode is `inline` but Redis is running | Redis was unreachable at boot. Check `REDIS_URL` and credentials, then restart. |
| OAuth callback fails only in production | `APP_URL` does not match the public origin, so the redirect URI differs from the one registered with the platform. |
| Webhook deliveries rejected with 401 | The signing secret in the console differs from the one configured on the platform. |
| Stream starts then exits immediately | ffmpeg log tail in the console carries the ingest error — usually an expired stream key or a key that belongs to a different channel. |
| `node:sqlite` not found | Node is older than 22.5. Upgrade Node. |
| Migration fails after changing `APP_SECRET` | Tokens are bound to the key. Rotate back or reconnect the affected accounts. |

---

## License

MIT
