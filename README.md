# dsh-token-stats

Token usage statistics for DeepSeek Harness, mounted as a Settings page.

It reads the durable session logs this machine already has and turns them into
the numbers you would otherwise have to guess at.

## What it shows

| Block | What it is |
|---|---|
| Dashboard | Six figures: lifetime tokens, peak day (with its date), today, last 7 days, daily average (per active day), and the cache-read share of all tokens |
| Daily | A GitHub-style contribution heatmap, always ending today: a **fixed eighteen weeks** of 26px squares, centred in the card. The window is deliberately not derived from the card width — that made the block grow on a wide screen and squeeze every square on a narrow one — so a card narrower than the block shaves the cells just enough to hold all eighteen columns. Colour depth is continuous (see below). Days that have not happened yet keep a dashed slot |
| Weekly | One bar per week over the **same block**: same window, column pitch, width and height, aligned column-for-column, with each bar inset inside its column so consecutive weeks read as separate bars |
| Trend | One smooth line per model over the selected range. The axis granularity follows the range: day up to a month, week up to six months, month up to two years, year beyond |
| Share | A ring chart of per-model usage in the selected range, with a named legend and the range total in the middle |

One range control drives **both** the trend and the share chart — they share a
single card, so the scope is stated once.

A metric switcher drives the heatmap, the trend and the ring together:

* **Total** — uncached input + output + cache read + cache write, which is
  exactly what a provider reports as `totalTokens`.
* **Input + output** — the narrower figure, excluding cache reads. On a warm
  session cache reads dominate (98.8% on the machine this was built against), so
  the two are offered side by side rather than blended.
* Input, Output, Cache read, and Cache write — the last one appears only if the
  deployment ever reports it; no provider mounted here does.

All displayed numbers are unit-scaled in the active locale: 万 / 亿 in Chinese,
K / M / B in English.

## Install

```bash
dsh plugin --profile web add github:mathangler/dsh-token-stats
```

Then restart the running `dsh web` process.

The bundle patch inserts one host row into the profile. The browser half is
loaded automatically because `package.json` declares `dsh.client.platform: web`.
Built and verified against DSH `0.1.5-rc.1`.

A refresh answers immediately and keeps the numbers on screen while the rescan
runs behind it. A harness whose `sessionQuery` offers `observeSession` reads a
running session through that observation; on a harness without it the plugin
still works and reads whole session logs instead.

To update an installed copy, remove it first and add it again — pnpm will not
re-resolve a git HEAD while the spec is unchanged:

```bash
dsh plugin --profile web remove dsh-token-stats
dsh plugin --profile web add github:mathangler/dsh-token-stats
```

On restricted networks `github.com` itself may be unreachable while **installs
still work**: pnpm fetches the tarball from `codeload.github.com`, a different
host.

## Where the numbers come from

Token usage is recorded by the harness on exactly one durable event type —
`assistant/message`, in `data.usage` — and the provider/model that produced that
message sits on the same event at `data.message.source`. That makes one assistant
message the only atomic unit carrying both a usage sample and its route, which is
why the fold is message-level.

* **Attempt slots.** A billed attempt can emit more than one `assistant/message`
  sample. Samples are keyed by `(turn, step, epoch)`, where `epoch` advances on
  `llm/retry-started` and `assistant/attempt`; a later sample in the same slot
  replaces the earlier one, so a retry is billed again while a streaming sample is
  not double counted.
* **Forked sessions.** A seeded session's log contains its parent's events as a
  leading prefix. `inheritedEventCount` events are skipped, so a fork is never
  counted twice.
* **Day boundaries** follow the machine's local timezone.
* **Ranking.** Models are ranked by Total; beyond eight models the tail is merged
  into one "Other models" slice rather than dropped.
* **Removed sessions keep counting.** A session that disappears from the listing
  keeps its last known usage, because a "lifetime" figure that shrinks whenever
  old history is cleaned up would be worse than useless. The footnote reports how
  many such sessions are retained. Set `retainSessions: false` to count listed
  logs only, in which case the totals do decrease when sessions are removed.
* **Skipped sessions stay visible.** A log the read path refuses is counted and
  reported with its reason in the footnote's tooltip, because a skipped session
  shrinks every total.

The platform's own `deriveTurnTokenUsage()` is **not** used as the source of
truth. It is turn-level, so it cannot attribute usage to a model, and it returns
`undefined` for any turn containing a compaction. On the machine this was
developed against it accounted for 294.7M tokens where this fold accounts for
340.2M — it silently loses about 13% of real usage. It is instead used as a
cross-check in the test suite, where the fold must reproduce all four buckets
exactly on every turn the deriver can derive.

## Colour scale

The heatmap anchors its ramp on the busiest day in view and maps usage through a
power curve, `opacity = 0.15 + 0.85 * (value / max) ** 0.45`. Three candidates
were measured on real data before choosing:

| Day | Linear | Log | **Power 0.45** |
|---|---|---|---|
| 8,885 | 0.150 | 0.200 | 0.158 |
| 14,963,448 | 0.198 | 0.777 | 0.383 |
| 25,885,348 | 0.233 | 0.819 | 0.449 |
| 111,566,640 | 0.508 | 0.933 | 0.726 |
| 264,785,241 | 1.000 | 1.000 | 1.000 |

* **Linear** makes ordinary days identical: 15M and 26M differ by 0.035.
* **Logarithmic** makes busy days identical: 111M and 265M — a 153M gap — differ
  by 0.067, i.e. invisible. It flattens exactly the region a heavy user reads.
* **Power 0.45** keeps both apart: 0.274 between the two busiest days and 0.065
  between the two ordinary ones.

The exponent is the named constant `INTENSITY_GAMMA`; lower it for more contrast
at the top, raise it for more at the bottom. One consequence is inherent to any
single scale: an extreme outlier would push every other day toward the floor.

## Performance and caching

**The cost of a session log is its decode, and nothing else.** Measured on a real
corpus (36 sessions, 190 known ids, one 14MB log):

| operation | 14MB log | 5MB log |
|---|---|---|
| `persistence.open()` — the zstd decode | **1062ms** | 435ms |
| `handle.read()` — parse the events | **16ms** | 14ms |
| `foldSession` over 18151 events | **10ms** | — |
| `open()` again, from the backend's memo | 6ms | 11ms |
| `query.readSession` (validated: replays the log) | **11293ms** | 4456ms |

So reading *less* of a log saves nothing — the decode is unavoidable and dominates by
two orders of magnitude — while *never opening* one saves everything. Every policy
below follows from that.

* **The platform's `tokenUsage` projection is the first source** — but not through its
  *view*. `dsh-token-meter` registers a projection unit and
  `dsh-session-projection-cache` checkpoints it on every turn boundary, so the harness
  has *already* folded and stored every session's provider-reported totals. Reading
  that value back through the registry's supported route does not work, though:
  `viewCheckpoint` (and `cachedSnapshot`, which is built on it) serve only units that
  declare a `wire` view, and `tokenUsage` declares none — measured, they return nothing
  for this key while the row sits on disk complete. The stored row is a documented
  `ProjectionCheckpointRow` (`{ ver, seq, val }`, `val` being `{ totals, last }`), so the
  totals are read from it directly and shape-checked. That is what lets a session whose
  log cannot be read still be counted at its platform total instead of vanishing from a
  "lifetime" figure the platform can still account for.
* **Nothing decodes a log on the request path.** A request is answered from state the
  host already maintains. The first request a freshly booted host receives used to
  *block* for the whole first scan — measured at 4014ms with a 4s listing and 9014ms
  with a 9s one — which is exactly the moment a user is staring at it. It now answers
  "warming up" at once and lets the panel poll.
* **A scan pays for at most `MAX_DECODES_PER_SCAN` (2) decodes**, on top of a 1s
  budget and a 20s ceiling. A time budget alone cannot bound this: it is checked
  *before* a decode, and one cold decode (1062ms) is longer than the whole budget, so
  a scan that read four sessions cost 7.4s in production. Counting decodes bounds the
  worst case directly.
* **A scan that leaves work behind queues the next round itself.** Bounding alone is
  not enough: the residue would otherwise only advance when something asked for a
  scan, and nothing does while the panel sits open inside its TTL. Measured on a real
  cold start, the panel stayed at 8 of 15 days and 1 of 9 models indefinitely. Each
  round is still bounded and nothing touches a request, so a cold corpus places itself
  within a few seconds in the background.
* **A parked session is revisited, and its total is right meanwhile.** A session a
  scan had no budget for still reports the platform's **exact** total — under the
  unattributed key, on the day it was created — so the lifetime figure is never a
  placeholder. Only the calendar placement is, and the entry records that (`placed`)
  so a later round comes back for it. Treating a parked entry as a finished split is
  what made the partial heatmap permanent.
* **Only a real split is carried over.** A split is proven current when the platform's
  row for that session has not moved since it was derived: the log's usage content is
  exactly what produced that row. That check costs one comparison and replaces the
  `stat`/`observeSession` a marker used to need — which on the live session was
  `observeSession` over a 13MB log, paid on every refresh to conclude that nothing had
  changed.
* **One open per session, not two.** The events and the inherited cut come back from
  the same handle, because a second open on a cold memo is another full decode.
* **A closed session is read through the persistence handle, not `readSession`.**
  `readSession` returns a *validated* snapshot: it replays the whole log to prove it is
  well-formed, which is right before resuming a session and 8× too much here
  (**11293ms against 1355ms** for the same 14MB log, identical totals).
* **The durable state is not discarded for being old.** It used to expire after 24h,
  which threw away every session's split — including the deleted sessions' history,
  which exists nowhere else — and forced a fully cold re-derivation. Entries are
  revalidated per session against the platform's own row instead, so age proves
  nothing and expiry only destroyed work.
* **The rollup's layout version is not a delete button.** Version 1 is still read:
  the per-day and per-model contributions of sessions whose logs are *already gone*
  cannot be re-derived from anything, so a version bump that discarded the file would
  make the lifetime total shrink.
* **A failed scan reports itself instead of leaving `stale` true forever.** A rejected
  background scan used to be swallowed while `stale` was recomputed from the request,
  so it stayed true and the panel polled for two minutes over a scan that had already
  died — reported as "the refresh fails". The failure is now recorded, `stale` goes
  false, the reason travels with the numbers, and a cooldown stops a retry storm.
* **`listSessions` is bounded.** It is the only call in a scan that can hang, and
  nothing else in the composition accepts an abort signal; a listing that never
  settles used to leave the request pending forever.
* **A burst of Refresh presses costs one scan.** A press landing within
  `DEFAULT_REFRESH_FLOOR_MS` (600ms) of a completed scan is answered from that scan and
  reported as neither stale nor scanning. It is a floor on re-scanning rather than a
  result cache, and it is opt-in: a direct caller of the core gets a guaranteed fresh
  scan unless it asks otherwise.
* **The last aggregate is persisted alongside the rollup**, so the first panel open
  after a host restart is answered from disk.

Measured end to end on that corpus, through the plugin's own route:
| | before | now |
|---|---|---|
| first refresh after boot, durable state missing | **blocked 4–9s** | **5ms**, warming, then placed in the background |
| **pressing Refresh again** | **4–5s every press** | **5–10ms**, and `read 0` |
| cold start, until every session is placed | ~20s of log reading | **~3s of bounded background rounds** |
| restart, rollup on disk | 31.4s | **3ms** |
| panel open, aggregate cached | 66–83ms | **5–47ms** |

A refresh in the steady state does **no log decodes at all** (`read 0, reused 36`); the
remainder is one `listSessions`. The displayed total is unchanged across presses, which
is expected: it only moves when a session log grows.

The totals are not an approximation of the platform's: a session's folded buckets are
reconciled against its `tokenUsage` total, and across the corpus the panel's grand total
matched the platform's to **0.000%**.

## What "exact" is checked against

The figure is verified against the platform's own stored totals, independently of this
plugin's bookkeeping. On the corpus measured here:

| check | result |
|---|---|
| each session's independent fold vs the platform's stored total | **37 of 37 match**, 0 mismatches |
| every session's fold, summed, vs the platform's store | 3381.151M vs 3381.263M |
| the payload's per-day sum vs its per-model sum | **identical** — nothing double-counted |
| `failed` / `pending` / `retired` | **0 / 0 / 0** — nothing unaccounted for |

The remaining 0.113M is a platform record for a session deleted **before this host ever
saw it**: the platform keeps its total, but no listing mentions it and no log exists to
say which days it was spent on. It is deliberately not invented onto a day — an
unattributable number placed on a guessed date would corrupt the calendar to flatter the
total. A session this plugin *has* seen keeps its per-day history for exactly this
reason, and that history is never merged, expired, or dropped:

* A session removed from the listing keeps its own per-day, per-model entry — including
  days over a year old. Nothing is folded into a lumped "deleted sessions" total, because
  a lumped total has no day to sit on: merging is what would make days vanish from the
  heatmap.
* A session whose log cannot be read keeps the contribution it was last known to have
  rather than being blanked. Blanking made the figure *shrink* on a failed re-read.
* A session that appears while the host is running is folded **at once**, whatever the
  decode budget says — a new session's log is tiny, and its days are the one thing that
  cannot be recovered later if it is deleted. Only a backlog that already existed when
  the host started is spread across rounds.
* The durable state has no expiry, and the rollup's layout version is not a delete
  button, so an upgrade cannot cost history.

A panel open is answered at once from one of three places: the 60-second aggregate
cache, the persisted aggregate, or a `stale: true` answer that is refreshed *behind*
the response while the panel revalidates and shows a quiet "Refreshing…" hint. An
explicit refresh rescans the same way. A round that could not list its sessions (a busy
host) is *skipped*, not failed: the held numbers are re-published with a quiet note and
the round retries itself, because nothing about a starved process says anything about
the numbers.

The panel measures its chart slot from the ref callback that attaches it — not
from an effect, because on a cold open the slot does not exist yet when effects
run — and remembers that width across mounts. Both views are built from one
geometry — the same week count, column pitch, width and height — and the slot
reserves exactly that block, and only once a width has actually been measured.

The host also runs exactly one warm-up scan, ten seconds after boot and clear of
the first paint. There is no polling and no interval.

## Privacy

Everything is computed locally from session logs already on disk. Nothing leaves
the machine, and the plugin adds no model-visible content: no prompt section, no
tool, no model call of its own.

## Options

The host row accepts optional configuration:

```yaml
- id: token-stats
  name: dsh-token-stats
  config:
    maxModels: 8
    retainSessions: true
```

## Tests

```bash
node --test test/
```

Layers: `load` (bundle contract, stylesheet and surface audit, nav marking, pure
helpers, plus a smoke test that actually renders every chart and the panel
itself), `route` (trust fence, wire faults, envelopes) and `host-core` (the fold,
the payload builder, incremental scans, plus a cross-check against the platform
deriver on whatever real session logs the machine has).

## License

MIT
