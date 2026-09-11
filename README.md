# dsh-token-stats

Token usage statistics for DeepSeek Harness, mounted as a Settings page.

It reads the durable session logs this machine already has and turns them into
the numbers you would otherwise have to guess at.

## What it shows

| Block | What it is |
|---|---|
| Dashboard | Six figures: lifetime tokens, peak day (with its date), today, last 7 days, daily average (per active day), and the cache-read share of all tokens |
| Daily | A GitHub-style contribution heatmap, always ending today: a **fixed sixteen weeks** (a quarter of a year) of 26px squares, centred in the card. The window is deliberately not derived from the card width — that made the block grow on a wide screen and squeeze every square on a narrow one — so only a card too narrow for the block shrinks the cells. Colour depth is continuous (see below). Days that have not happened yet keep a dashed slot |
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

Reading every session log on every panel open would be wasteful, so each
session's folded buckets are cached per session id, keyed by its log marker.
Unchanged sessions are reused; only a log that grew is re-read and its buckets
replaced. The rollup is persisted to
`<system temp>/dsh-token-stats/rollup-v1.json` — the system temp directory, never
`~/.dsh` — and a missing, stale or corrupt rollup only costs one full rescan.

Four things keep a scan cheap, each measured on a 22-session machine:

* **Metadata change detection.** A closed session's marker comes from
  `sessionPersistence.stat()` (`sizeBytes` + `eventCount`), not from parsing its
  log; live sessions still go through `listEvents` because their newest events may
  not have been flushed yet.
* **Failure memoization.** A log the read path refuses is remembered together with
  the marker it failed at, and is retried only once that log changes. Without
  this, three unreadable logs were re-read and re-rejected on every scan, which
  alone cost about 2.8 seconds per scan.
* **Model names are cached for ten minutes**; resolving them can interrogate a
  provider.
* **The browser paints the last answer immediately** and revalidates behind it, so
  re-entering Settings never shows a loading state for numbers it already has.
* **The last aggregate is persisted alongside the rollup**, so even the first panel
  open after a host restart is answered from disk rather than waiting for a scan.
* **The scan hands the event loop back between sessions.** Parsing and folding a
  changed log is synchronous work on the host's single thread, and the live
  session's log is tens of megabytes; measured against the live host, panel
  requests issued during a rescan waited 0.5–3.9s for the pass to finish. One
  macrotask per session lets an answer that is already cached out between them.

Together these took a warm scan from about 3.0s to about 0.2s. A panel open is now
answered at once from one of three places: the 60-second aggregate cache, the
persisted aggregate, or — when even that is past its budget — a `stale: true`
answer that is refreshed *behind* the response while the panel revalidates and
shows a quiet "Refreshing…" hint. On the machine this was built against, an open
answered in 66–83ms while the same data took up to 27.5s to rescan, because that
pass re-reads the live session's whole log; the panel follows a stale answer up on
a bounded schedule (0.7s, growing to one request every 2.5s, twelve in all, about
28s of coverage). An explicit refresh still rescans synchronously.

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
