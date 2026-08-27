# Unduruz backend

Self-hosted agent service for a Raspberry Pi 5. Claude agents draft work, you
approve it, a payment processor collects the money. The service never touches
your bank account and never publishes anything on its own.

```
 agents draft  ─►  review gate (you)  ─►  you publish  ─►  processor webhook
   worker.js         dashboard              manually          sales table
```

## What each piece does

| Path | Job |
|---|---|
| `src/worker.js` | The agent loop. Creates tasks, drafts them with Claude, handles rework. |
| `src/policy.js` | The compliance rules, in one place. Injected into every Claude call. |
| `src/server.js` | API + control room dashboard. Binds to localhost only. |
| `src/routes/webhooks.js` | Verified sale webhooks. The only writer to `sales`. |
| `src/queue.js` | Postgres job queue with retries and backoff. No Redis. |
| `db/schema.sql` | Tables. Run once. |
| `deploy/` | systemd units and the Cloudflare tunnel config. |

## Install on the Pi

Assumes Ubuntu Server or Raspberry Pi OS 64-bit, and a user called `unduruz`.

```bash
# 1. Node 20 and Postgres
sudo apt update && sudo apt install -y postgresql
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 2. Database
sudo -u postgres psql -c "CREATE USER unduruz WITH PASSWORD 'pick-something-long';"
sudo -u postgres psql -c "CREATE DATABASE unduruz OWNER unduruz;"

# 3. Code
cd /home/unduruz && git clone <your-repo> unduruz-backend
cd unduruz-backend && npm install

# 4. Secrets
cp .env.example .env
nano .env                 # fill in every value
chmod 600 .env            # nobody else on the box can read your API key

# 5. Schema
npm run migrate

# 6. Services
sudo cp deploy/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now unduruz-api unduruz-worker
systemctl status unduruz-api unduruz-worker
```

Generate the dashboard token with `openssl rand -hex 32`.

## Reaching it

Two different problems, two different tools.

**You → dashboard: Tailscale.** Private, no open ports.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# then browse to http://<pi-tailscale-name>:8787 from any of your devices
```

**Processor → webhooks: Cloudflare Tunnel.** Outbound-only, works behind CGNAT
(common on Australian home internet), no port forwarding.

```bash
sudo cloudflared service install
sudo nano /etc/cloudflared/config.yml    # use deploy/cloudflared-config.yml
sudo systemctl restart cloudflared
```

The tunnel config publishes **only** `/webhooks/*`. The dashboard and API are
never exposed to the internet.

Then in your processor's dashboard set the webhook URL:

- Lemon Squeezy → `https://hooks.yourdomain.com/webhooks/lemon`, and copy the
  signing secret into `LEMON_WEBHOOK_SECRET`.
- Gumroad → `https://hooks.yourdomain.com/webhooks/gumroad`, and put your seller
  id in `GUMROAD_SELLER_ID`.

## The town as a front end

The game is served from the Pi too:

- `http://<pi>:8787/`      the control room
- `http://<pi>:8787/game`  Unduruz Town, wired to the same data

Hit **Live** in the town's header, paste the same dashboard token, and the dock
stops simulating: tasks, the review queue, the activity log, the ledger and the
header figure all come from Postgres. Orders typed at an agent go to the Pi and
become real tasks. Approve there or in the control room; it is the same row.

Served from the Pi, leave the address field blank. To open the town as a local
file on your laptop instead, put `http://<pi>:8787` in the address field.

Disconnect and it falls back to the offline simulation, which is still useful
for showing someone how the place works without touching live data.

## Talking to your agents

Click a board member or the Director in the town, hit **Talk to them**, and you
get a real conversation that persists.

They remember in two layers. The last twenty turns are replayed verbatim, so
immediate back-and-forth works normally. Older conversation is folded into a
rolling summary by a background job, so a decision you made three weeks ago
survives without sending a thousand messages to the API every time. The panel at
the top of the chat shows you exactly what an agent currently remembers.

Each one also sees their own live task list, so "how's that going?" is a
question they can actually answer.

**Turn this into a task** takes the last few turns of conversation and files it
as a tracked task, which then goes through the same approval gate as everything
else. Plan it out in conversation, then commit it to work.

Personalities live in `PERSONAS` in `src/chat.js` — Lin is blunt and numerical,
Otto pitches angles, Priya catches risk, Zeke wants the smallest thing that
ships. Edit that object to change how they talk.

Chat needs the game connected to the Pi (the **Live** button), since the memory
lives in Postgres.

## Images (optional)

Agents can illustrate their own drafts using **Cloudflare Workers AI**, which has
a genuinely free tier. The default model is FLUX.1 Schnell, which is Apache-2.0
licensed, so the output is commercially usable — unlike most "free" image APIs,
which quietly exclude commercial use.

Set up:

1. Cloudflare dashboard → copy your **Account ID** from the URL.
2. My Profile → API Tokens → Create Token → **Workers AI** template.
3. Put both in `.env`, then `sudo systemctl restart unduruz-worker`.

```
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
DAILY_IMAGE_LIMIT=20
```

Leave them blank and everything else works exactly as before — images are
strictly optional and a failure never fails a task.

Once configured, drafts in the visual categories (digital products, video,
marketing) get an image automatically. Thumbnails appear on the review card;
click one to enlarge, or open the work view and hit **Generate another image**
if you don't like it.

The agent writes its own prompt, inside the same policy: no living artists, no
brands or trademarks, no real people, no lettering. Note that purely
AI-generated images are not copyrightable, so treat them as disposable
illustration rather than brand assets you own.

## What the agents actually produce

**The real file.** For digital products and research, the agent builds the
actual deliverable — a formatted PDF or a working spreadsheet with real rows,
not a description of one. It appears on the review card as a download chip. That
file is the thing a customer pays for. Uses `pdfkit` and `exceljs`; no API, no
key, no cost.

**Mockups at platform sizes.** Every generated image is also cut to 1200x630,
1080x1080 and 1080x1350 with a title bar, using `sharp`. Smart-cropped, so the
subject survives the reframe. Listing thumbnails without opening an editor.

**Duplicate detection.** Each draft is embedded (free, same Cloudflare tier) and
compared against everything already approved or published. Score over
`DUPE_THRESHOLD` and the review card shows a warning naming the earlier piece.
This enforces the no-bulk-identical rule that Fiverr bans people over, and
YouTube demonetises for.

**Phone notifications.** Set `NTFY_TOPIC` to something unguessable and subscribe
to that topic in the free ntfy app. You get a push when a draft needs review
(flagged if it looks duplicated) and a high-priority one when a sale lands. Set
`PUBLIC_URL` to make the notification tappable straight into the town.

All four are optional. Missing credentials or a failure never breaks a task —
it logs a warning and moves on.

## Daily use

1. Open the control room. Anything the agents drafted is under **Waiting on your decision**.
2. Read the draft. Tick each disclosure box — **Approve stays disabled until you do**.
3. Approve, or send it back with a note and the agent revises it.
4. Publish it yourself on the platform, then hit **Mark published**.
5. When someone buys, the processor calls the webhook and the sale appears under
   **Real sales**. That number is the only real one on the page.

Type an order in plain words ("a Notion CRM for wedding photographers") and it
becomes one niche-specific task.

## The guard rails, and why they are there

- **Nothing auto-publishes.** Every platform in the research punishes automated
  bulk posting. A human in the loop is what keeps accounts alive.
- **`MAX_PENDING_REVIEW`** stops the agents once drafts pile up. A queue you
  never read is worse than no queue.
- **`DAILY_DRAFT_LIMIT`** caps volume and API spend together. A bug cannot run
  up a bill overnight.
- **Approve is locked** behind the disclosure checklist, so undisclosed AI
  cannot be shipped by reflex. Undisclosed AI is the top account-termination
  risk, not AI itself.
- **Sales are written only by verified webhooks**, never by an agent. Lemon
  Squeezy is HMAC-verified; Gumroad is checked against your seller id. The
  `UNIQUE (provider, external_id)` constraint makes replays harmless.
- **No key material anywhere near the browser.** The dashboard talks to your Pi,
  the Pi talks to Anthropic.

## Cost

With `DAILY_DRAFT_LIMIT=12`, mostly Haiku for parsing and Sonnet for drafting,
expect single-digit dollars a month. Watch it:

```sql
SELECT * FROM usage_day ORDER BY day DESC LIMIT 7;
```

If it climbs, push more work to `MODEL_CHEAP` or lower the daily limit.

## Handy commands

```bash
journalctl -u unduruz-worker -f            # watch the agents work
journalctl -u unduruz-api -f
sudo systemctl restart unduruz-worker
psql -U unduruz -d unduruz -c "SELECT status, count(*) FROM tasks GROUP BY status;"
psql -U unduruz -d unduruz -c "SELECT * FROM jobs WHERE status='failed';"
```

## Before you take real money

- Get a free ABN (sole trader). Without one, businesses paying you must withhold 47%.
- GST registration is not required under A$75,000 turnover.
- Australian Consumer Law applies to digital goods. You cannot write "no refunds".
- Pick a Merchant of Record (Lemon Squeezy or Gumroad) so VAT/GST/sales tax is
  handled for you. Payhip covers EU/UK only.

General information, not advice — check ato.gov.au and business.gov.au.

## Deliberately not included

**Automated posting to YouTube or TikTok.** TikTok's Content Posting API requires
a per-app content audit, and unaudited apps can only post privately, capped at
five users per 24 hours. YouTube's quota and spam rules make bulk uploading a
fast route to a strike. The `published` flag exists so you can post by hand and
still track everything. Add an uploader later if you want, behind the same
approval gate.
