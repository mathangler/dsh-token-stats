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

A refresh is answered from the platform's own numbers wherever it can be, and only
falls back to reading a log when it must. Seven things keep a scan cheap, measured
on a real 25-session / 42MB corpus:

* **The platform's `tokenUsage` projection is the first source.** `dsh-token-meter`
  registers a projection unit and `dsh-session-projection-cache` checkpoints it on
  every turn boundary, so the harness has *already* folded and stored every
  session's provider-reported totals. Reading them back is a Map lookup plus a
  schema check against the listed header's lifecycle identity — no open, no stat,
  no read.
* **A marker is only computed when it can change the answer.** Deriving the
  day/model split is the one thing the platform does not record, so it is the only
  reason to read a log. When the platform's total for a session matches the one the
  last split was reconciled against, the split is proven current and the session is
  carried over without a `stat`, an `observeSession`, or a read. This matters most
  for a live session: `observeSession` on the 13MB session being written cost 4.5s
  on its own, paid on every refresh, purely to conclude that nothing had changed.
* **Deriving splits is budgeted.** A cold corpus wants ~20s of log reading to place
  every session on the calendar, which no panel open should wait for. A scan spends
  at most `SPLIT_BUDGET_MS` (2.5s) deriving splits and defers the rest; deferred
  sessions still report the platform's **exact total** under the unattributed key on
  their creation day, and the following scan reads their log and replaces it. The
  set drains to zero — measured 8 → 5 → 3 → 1 → 0 across five scans — and every
  scan's grand total was equal to the platform's to the token throughout.
* **A closed session is read through the persistence handle, not `readSession`.**
  `sessionQuery.readSession` returns a *validated* snapshot: it replays the whole
  log to prove it is well-formed, which is right before resuming a session and far
  too much for counting four numbers per assistant message. Over the same corpus:
  **29.9s through `readSession` against ~3.3s through `handle.read()`**, with
  identical totals.
* **Metadata change detection, keyed on the log rather than the file.** A closed
  session's marker comes from `sessionPersistence.stat()`'s `eventCount`; `sizeBytes`
  is only consulted when no count exists, because the byte size also moves when the
  store re-compresses an unchanged log, and keying on it made every refresh re-read
  every large session for nothing.
* **A format migration does not discard cached totals.** The projection cache binds
  a record to a session's format generation, so a harness upgrade that migrates
  stored logs makes an exact-generation lookup miss every session it touched —
  measured here: a v3→v4 migration silently cost 4 of 25 sessions their cached
  totals. A row from the immediately preceding generation is read anyway, because
  the generation governs how a log is *decoded*, not how many tokens it reports.
* **The last aggregate is persisted alongside the rollup**, so the first panel open
  after a host restart is answered from disk, and the scan hands the event loop back
  between sessions so a request whose answer is already cached never waits behind a
  whole pass.

Measured end to end on that corpus, through the plugin's own handler:

| | before | now |
|---|---|---|
| cold scan (no rollup, first boot) | 31.4s | **~2.9s** |
| restart, rollup on disk | 31.4s | **3ms** |
| re-scan, nothing changed | 31.4s | **0.2–0.5s**, zero log reads |
| panel open, aggregate cached | 66–83ms | **7–47ms** |

The totals are not an approximation of the platform's: a session's folded buckets
are reconciled against its `tokenUsage` total, and across all 25 sessions the
panel's grand total matched the platform's to **0.000%**.

A panel open is answered at once from one of three places: the 60-second aggregate
cache, the persisted aggregate, or a `stale: true` answer that is refreshed *behind*
the response while the panel revalidates and shows a quiet "Refreshing…" hint. An
explicit refresh rescans the same way.

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
