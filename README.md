# Pokémon Lazada Telegram Alerts

An **alert-only** restock monitor for ten Pokémon TCG listings on Lazada Singapore.

It opens each listing in a headless browser, checks whether a visible, enabled purchase
control is present, and sends you a Telegram message when one appears.

**It does not buy anything.** It never logs in, never adds to cart, never fills in
checkout details, never places an order, never joins or skips a queue, and never
solves a CAPTCHA. It only reads public listing pages and sends you a message.

---

## ⚠️ Current status: Lazada is blocking automated checks

Verified on 14 September 2026: every one of the ten listings currently returns
Alibaba's anti-bot interstitial (`/_____tmd_____/punish?x5secdata=…`) instead of the
product page. This was reproduced with headless Chromium, a standard Chrome user
agent, the real Chrome channel, **and** a visible non-headless browser window with a
persistent profile. All were blocked identically.

The watcher handles this correctly and honestly — it reports a failure rather than
pretending the item is out of stock:

```
Check failed for Ascended Heroes Pokémon Center ETB: Lazada served an anti-bot
challenge page instead of the listing for Ascended Heroes Pokémon Center ETB;
it was not checked.
Round complete: 0 checked, 0 alert(s), 10 failure(s).
```

That distinction matters: a monitor that silently reported "out of stock" for a page
it could not read would never alert you, and you would never know why.

Getting past that interstitial would mean defeating a bot-detection challenge. This
project deliberately does not do that. Until Lazada serves these pages to automated
clients again, treat the watcher as ready-but-blocked. If you see
`Round complete: 10 checked`, it is working; if you see `10 failure(s)`, it is blocked.

---

## Set up Telegram

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and follow
   the prompts. It replies with a **bot token** that looks like `123456789:AA...`.

   **Your bot token is a password.** Anyone who has it can post as your bot. Never
   share it, never paste it into a chat or screenshot, and never commit it. It lives
   only in your local `.env`, which is git-ignored. If it leaks, send `/revoke` to
   @BotFather and generate a new one.

2. Copy the example environment file and fill in the token:

   ```sh
   cp .env.example .env
   npm install
   ```

   Open `.env` and paste the token after `TELEGRAM_BOT_TOKEN=`.

3. Open your new bot in Telegram and send it `/start` — a bot cannot message you until
   you have messaged it first.

4. Find your chat ID and confirm delivery works:

   ```sh
   npm run telegram:chat-id
   npm run telegram:test
   ```

   `telegram:chat-id` prints the chat ID(s) that have messaged your bot. Paste the ID
   into `.env` after `TELEGRAM_CHAT_ID=`, then `telegram:test` sends a harmless
   "Telegram notifications are ready" message. If it arrives, you are connected.

5. Start watching:

   ```sh
   npm start
   ```

Full sequence:

```sh
cp .env.example .env
npm install
npm run telegram:chat-id
npm run telegram:test
npm start
```

On a first local run you may also need the browser binary once:

```sh
npx playwright install chromium
```

Stop the watcher with `Ctrl+C`. It finishes the listing it is on, closes the browser,
and exits — usually within a second.

## Keeping it running

A sleeping Mac stops the watcher. `caffeinate` can wrap the watcher directly, so one
command both runs it and keeps the machine awake:

```sh
caffeinate -dimsu npm start
```

Leave that Terminal window open; `Ctrl+C` stops both. It prevents display, idle, disk
and system sleep, but it will not keep the machine awake with the lid closed on battery.

To keep it running after the Terminal window is closed:

```sh
nohup caffeinate -dimsu npm start > watcher.log 2>&1 &
```

Then `tail -f watcher.log` to watch it, and `pkill -INT -f "node src/index.js"` to stop
it cleanly.

### Backing off while blocked

While every listing is blocked the watcher cannot detect anything, so it doubles its
wait after each fully-blocked round — 60s, 120s, 240s — up to a ceiling of 10 minutes.
This costs no coverage (nothing is visible either way) and gives an IP-reputation block
room to lapse. The moment any listing becomes readable it returns to the normal
interval and sends you a Telegram notice that monitoring is live again.

## Configuration

Set these in `.env` (local) or in Render's dashboard (cloud).

| Variable | Default | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | Required. From @BotFather. Secret. |
| `TELEGRAM_CHAT_ID` | — | Required. From `npm run telegram:chat-id`. |
| `POLL_INTERVAL_SECONDS` | `30` | Seconds between full passes over all ten listings. **Values below 30 are rejected** so the watcher stays a polite observer. |
| `POLL_JITTER_SECONDS` | `0` | Optional random extra delay per round, so requests are not exactly periodic. |
| `NAVIGATION_TIMEOUT_MS` | `25000` | How long one Lazada page load may take before that check is abandoned. |
| `LISTING_SPACING_MS` | derived | Pause between consecutive listings. Unset, the round is spread across the interval. |
| `CHECK_CONCURRENCY` | `1` | How many listings may be in flight at once. Each gets its own browser page. |

Neither the token nor the chat ID is ever printed to the console or included in an
error message.

### Round latency

`CHECK_CONCURRENCY` is the setting that matters most for how quickly a restock is
noticed. A round spends nearly all of its time *waiting on replies*, so checking
several listings at once overlaps that waiting rather than stacking it:

```sh
CHECK_CONCURRENCY=5 npm start
```

Raising it does **not** raise the request rate — `LISTING_SPACING_MS` still applies
between consecutive requests, and a round still issues exactly one request per
listing. It changes how much of the round is spent idle.

Two related costs were removed at the same time: a challenged page now fails as
soon as the interstitial paints instead of waiting out the full navigation
timeout, and a listing whose purchase control is already rendered is reported
immediately instead of sleeping through a fixed settle window.

## What counts as "in stock"

A listing is reported available only when the page shows a purchase control that is
**visible, enabled, and offering a purchase** — text such as "Add to Cart", "Buy Now"
or "Pre-order". A control is not treated as available when it is disabled,
`aria-disabled`, hidden, or reads "Out of Stock", "Sold Out", "Notify Me" or
"Coming Soon". Page prose that merely mentions adding to cart is ignored.

You get an alert when:

- a listing is available the first time it is successfully checked;
- a listing goes from unavailable to available;
- an already available listing changes price.

You do **not** get repeat alerts every round for the same item at the same price. If
Telegram delivery fails, the alert is not marked as sent and is retried next round
with its original reason.

## Alert format

```
Pokémon restock detected

Ascended Heroes Pokémon Center ETB
Price: S$89.90
Seller: Pokémon Official Store
Detected: 14 Sep 2026, 20:42:07.148 SGT

Open Lazada listing   ← clickable, direct product link
```

The detection time is stamped to the millisecond, matching the precision public
restock channels publish, so your own alerts can be compared against theirs on
the same scale.

## Deploy as an always-on cloud worker (optional)

`render.yaml` defines a Docker-based **Render Background Worker** — it runs
continuously and exposes no public web address.

1. Push this project to a **private** GitHub repository. Never push `.env`; it is
   git-ignored already.
2. In the [Render dashboard](https://dashboard.render.com/), choose
   **New → Blueprint**, connect the repository, and let Render read `render.yaml`.
3. Add the two secrets in Render's **Environment** settings before the first deploy:
   `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. They are declared with `sync: false`
   so they are never stored in the repo. `POLL_INTERVAL_SECONDS`,
   `POLL_JITTER_SECONDS` and `NAVIGATION_TIMEOUT_MS` are set from the blueprint and
   can be edited there.
4. Deploy, then check the logs for `Round complete: 10 checked`.

Run only one instance. Two instances mean duplicate alerts. Note that a cloud IP is
*more* likely to hit the anti-bot interstitial described above, not less.

## Verify

```sh
npm test
```

Runs the full suite on Node's built-in test runner, including real headless-Chromium
tests that render sample markup and assert what the detector concludes from it.

## Recording the public restock feed

```sh
npm run feed:watch
```

Public restock channels publish a detection timestamp to the millisecond
(`Found at 13:25:11.135`) alongside each drop. That is free ground truth about
**when restocks actually happen**, which is the measurement this project has
never had — the watcher has fired zero alerts, so it has no observations of its
own to reason from.

The recorder reads a channel's public `t.me/s/<handle>` preview page, the same
one any visitor sees in a browser. It uses no account, no bot token, and no API
credentials, and it fetches at a browsing cadence. Set `FEED_CHANNEL_HANDLE` to
a channel handle and it appends one JSONL row per drop to `feed/restocks.jsonl`:

```json
{"id":"channel/1234","productName":"30th Celebration 2-Pack Blister",
 "pdpUrl":"https://www.lazada.sg/products/…","foundAt":"2026-09-23T05:25:11.135Z",
 "postedAt":"2026-09-23T05:25:30.000Z","publishDelayMs":18865}
```

**`foundAt` is the column that pays.** Accumulate enough rows and the
distribution answers whether drops cluster into predictable windows or arrive
uniformly at random. If they cluster, watching hard for a known hour beats
watching constantly, and the monitoring-fleet question mostly dissolves.

**`publishDelayMs` does not measure what it looks like it measures.** The
preview page timestamps posts to the second while the body reports detection to
the millisecond, so every gap lands inside ±1s — in the first live sample, all
20 of 20. More to the point, a channel that restamps `Found at` at publication
will always report a delay of zero no matter how late it actually posted, so a
*(Delayed)* channel cannot be used to measure its own delay. The column is kept
because a genuine multi-second gap would still be worth seeing, and
`withinTimestampResolution` counts how many rows carried no usable signal.

## Project layout

```
src/
  index.js             wiring: config, browser, watcher, shutdown
  config.js            product list and validated environment
  lazada-observer.js   share-link resolution and the in-page DOM snapshot
  availability.js      turns a snapshot into an availability decision
  alert-gate.js        decides whether an observation deserves an alert
  watcher.js           polling loop, per-round summary, interruptible sleep
  telegram.js          message formatting and Bot API delivery
  telegram-chat-id.js  `npm run telegram:chat-id`
  send-telegram-check.js `npm run telegram:test`
  restock-feed.js      parses a public restock post into a dataset row
  feed-collector.js    reads the t.me preview page and appends new drops
  feed-watch.js        `npm run feed:watch`
test/                  one file per module
```
