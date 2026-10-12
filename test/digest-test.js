// Unit checks for Digest.js — parsing, reader state, bar state and rows.
// Run: node test/digest-test.js

const assert = require("assert")
const D = require("../Digest.js")

const NOW = Date.parse("2026-10-13T08:00:00Z")
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")
const minutes = n => n * 60 * 1000
const days = n => n * 24 * 3600 * 1000

function story(n, extra) {
  return Object.assign({
    id: ("00000000000" + n.toString(16)).slice(-12),
    headline: "Story " + n, why: "Why " + n,
    url: "https://example.com/" + n, source: "HN"
  }, extra || {})
}

function repo(n, extra) {
  return Object.assign({
    id: ("aaaaaaaaaaa" + n.toString(16)).slice(-12),
    name: "org/repo" + n, why: "Repo why " + n,
    url: "https://github.com/org/repo" + n, unvetted: false
  }, extra || {})
}

// The 2026-10-12 day file as the service wrote it: before Phase 2.5, so no
// sources.stale; the try item shares a URL (and id) with a top story.
function day(extra) {
  return Object.assign({
    version: 1, date: "2026-10-12", generated_at: "2026-10-12T18:27:56Z",
    model: "sonnet", prompt_version: "be49fbe55108", lookback_hours: 26,
    catch_up: false, legacy: false, state: "ok",
    sources: { ok: 12, total: 12, failed: [] },
    note: "",
    top: [story(1), story(2), story(3)],
    repos: [repo(1), repo(2, { unvetted: true })],
    "try": { id: "000000000003", title: "Try it", what_to_do: "Do the thing", url: "https://example.com/3" },
    skipped: "Skipped about 50 items."
  }, extra || {})
}

const parse = obj => D.parseDigest(JSON.stringify(obj))

// --- sanitizers -------------------------------------------------------------

assert.strictEqual(D.cleanUrl("https://example.com/a"), "https://example.com/a", "https kept")
assert.strictEqual(D.cleanUrl("http://example.com"), "http://example.com", "http kept")
assert.strictEqual(D.cleanUrl("javascript:alert(1)"), null, "javascript: rejected")
assert.strictEqual(D.cleanUrl("https://exa mple.com"), null, "inner whitespace rejected")
assert.strictEqual(D.cleanUrl(" https://example.com"), null, "leading whitespace rejected")
assert.strictEqual(D.cleanUrl("https://"), null, "empty host rejected")
assert.strictEqual(D.cleanUrl(null), null, "null rejected")
assert.strictEqual(D.cleanText("a\nb\u0007c", 50), "a b c", "control chars stripped")
assert.strictEqual(D.cleanText("x".repeat(20), 10).length, 10, "length capped")
assert.ok(D.cleanText("x".repeat(20), 10).endsWith("…"), "cap marks truncation")
assert.strictEqual(D.cleanText(42, 10), "", "non-string is empty")

{
  const d = parse(day({
    top: [story(1), story(2, { url: "javascript:alert(1)" }), story(3, { url: "https://a b" }), story(4, { headline: "" })],
    repos: [repo(1, { url: "ftp://x" }), repo(2)],
    "try": { id: "bad id", title: "T\u0000itle", what_to_do: "w", url: "javascript:x" }
  }))
  assert.deepStrictEqual(d.top.map(s => s.headline), ["Story 1"], "bad-URL and untitled stories dropped")
  assert.deepStrictEqual(d.repos.map(r => r.name), ["org/repo2"], "bad-URL repo dropped")
  assert.strictEqual(d["try"].url, null, "bad try URL nulled, item kept")
  assert.strictEqual(d["try"].id, null, "malformed id nulled")
  assert.strictEqual(d["try"].title, "T itle", "try title sanitized")
}
assert.strictEqual(D.parseDigest("not json"), null, "unparseable day")
assert.strictEqual(D.parseDigest("[]"), null, "non-object day")
assert.strictEqual(parse(day({ date: "yesterday" })), null, "day without a valid date")
assert.strictEqual(parse(day({ "try": null }))["try"], null, "null try")
assert.strictEqual(parse(day({ state: "weird" })).state, "ok", "unknown day state")

// rev3 fields: present and absent
{
  const old = parse(day())
  assert.strictEqual(old.sources.stale, null, "pre-2.5 day: stale not recorded")
  const fresh = parse(day({ sources: { ok: 11, total: 12, failed: ["X"], stale: ["Smol AI News"] } }))
  assert.deepStrictEqual(fresh.sources.stale, ["Smol AI News"], "stale list read")
  assert.deepStrictEqual(fresh.sources.failed, ["X"], "failed list read")
  const legacy = parse(day({ legacy: true, sources: undefined, "try": { id: null, title: "T", what_to_do: "w", url: null } }))
  assert.strictEqual(legacy.sources, null, "legacy day without sources")
  assert.strictEqual(legacy.legacy, true, "legacy flag")
}

{
  const s = D.parseStatus(JSON.stringify({
    version: 1, state: "running", started_at: "2026-10-13T07:55:00Z", finished_at: null,
    date: null, json: null, markdown: null, lookback_hours: null, catch_up: null,
    sources: null, feeds: [], deduped: null, error: "", prompt_version: null, model: "sonnet"
  }))
  assert.strictEqual(s.state, "running", "running status")
  assert.strictEqual(s.sources, null, "null sources while running")
  assert.strictEqual(s.deduped, null, "null deduped while running")
  assert.strictEqual(s.date, null, "null date while running")

  const done = D.parseStatus(JSON.stringify({
    state: "ok", started_at: "x", date: "2026-10-13", deduped: 6,
    sources: { ok: 12, total: 12, failed: [], stale: ["Eugene Yan"] },
    feeds: [{ label: "HN", url: "https://hnrss.org/newest", ok: true, kept: 7, error: "",
              last_ok: "2026-10-13T07:56:00Z", newest: "2026-10-13T07:00:00Z", stale: false },
            { label: "Trending", url: "https://github.com/trending", ok: true, kept: 3, newest: null },
            "junk"]
  }))
  assert.strictEqual(done.deduped, 6, "deduped read")
  assert.deepStrictEqual(done.sources.stale, ["Eugene Yan"], "status stale read")
  assert.strictEqual(done.feeds.length, 2, "non-object feeds dropped")
  assert.strictEqual(done.feeds[0].newest, "2026-10-13T07:00:00Z", "feeds[].newest read")
  assert.strictEqual(done.feeds[1].newest, null, "undated feed")
  assert.strictEqual(done.feeds[1].stale, false, "missing stale is false")
  assert.strictEqual(D.parseStatus(JSON.stringify({ state: "bogus" })).state, "unknown", "unknown status state")
  assert.strictEqual(D.parseStatus(""), null, "empty status")
}

{
  const idx = D.parseIndex(JSON.stringify({ version: 1, days: [
    { date: "2026-10-11", state: "ok", items: [] },
    { date: "2026-10-12", state: "degraded", legacy: false, items: [
      { id: null, section: "try", title: "T", url: null, why: "w" },
      { id: "000000000001", section: "top", title: "", url: "https://x.y" }] },
    { date: "bad" }
  ] }))
  assert.deepStrictEqual(idx.days.map(d => d.date), ["2026-10-12", "2026-10-11"], "index newest first, bad dates dropped")
  assert.strictEqual(idx.days[0].items.length, 1, "untitled index item dropped")
  assert.strictEqual(idx.days[0].items[0].url, null, "legacy try without url")
  assert.strictEqual(D.parseIndex("{}"), null, "index without days")
}

// --- bar state ------------------------------------------------------------

{
  const reader = D.emptyReader()
  const doneReader = D.markDone(reader, "2026-10-12", iso(NOW))
  const st = (state, extra) => Object.assign({ state: state, started_at: iso(NOW - minutes(5)) }, extra || {})

  assert.strictEqual(D.barState(st("running"), "2026-10-12", reader, NOW), "running", "running")
  assert.strictEqual(D.barState(st("running", { started_at: iso(NOW - minutes(29)) }), "", reader, NOW), "running", "29 min is still running")
  assert.strictEqual(D.barState(st("running", { started_at: iso(NOW - minutes(30)) }), "", reader, NOW), "stalled", "stalled at 30 min")
  assert.strictEqual(D.barState(st("running", { started_at: null }), "", reader, NOW), "stalled", "running without a start time")
  assert.strictEqual(D.barState(st("failed"), "2026-10-12", reader, NOW), "failed", "failed")
  assert.strictEqual(D.barState(st("degraded"), "2026-10-12", reader, NOW), "degraded", "degraded")
  assert.strictEqual(D.barState(st("ok"), "2026-10-12", reader, NOW), "unread", "unread")
  assert.strictEqual(D.barState(st("ok"), "2026-10-12", doneReader, NOW), "idle", "idle once done")
  assert.strictEqual(D.barState(st("empty"), "2026-10-12", doneReader, NOW), "idle", "empty day done")
  assert.strictEqual(D.barState(null, "2026-10-12", reader, NOW), "unread", "no status file yet")
  assert.strictEqual(D.barState(null, "", reader, NOW), "idle", "nothing at all")

  // precedence: running → stalled → failed → degraded → unread → idle
  assert.strictEqual(D.barState(st("running"), "2026-10-12", reader, NOW), "running", "running beats unread")
  assert.strictEqual(D.barState(st("failed"), "2026-10-12", doneReader, NOW), "failed", "failed even when read")
  assert.strictEqual(D.barState(st("degraded"), "2026-10-12", reader, NOW), "degraded", "degraded beats unread")

  // unread only when the newest date isn't done; older done days don't count
  const oldDone = D.markDone(reader, "2026-10-11", iso(NOW))
  assert.strictEqual(D.isUnread("2026-10-12", oldDone), true, "older day done, newest unread")
  assert.strictEqual(D.isUnread("2026-10-12", doneReader), false, "newest done")
  assert.strictEqual(D.isUnread("", reader), false, "no newest day")
  assert.strictEqual(D.isUrgent("degraded") && D.isUrgent("failed") && D.isUrgent("stalled"), true, "urgent states")
  assert.strictEqual(D.isUrgent("unread") || D.isUrgent("running") || D.isUrgent("idle"), false, "non-urgent states")
}

// --- freshness --------------------------------------------------------------

assert.strictEqual(D.freshness(NOW - 30 * 1000, NOW), "just now")
assert.strictEqual(D.freshness(NOW - minutes(5), NOW), "5m ago")
assert.strictEqual(D.freshness(NOW - minutes(185), NOW), "3h ago")
assert.strictEqual(D.freshness(NOW - days(2), NOW), "2d ago")
assert.strictEqual(D.freshness(NOW + minutes(5), NOW), "just now", "clock skew clamps")

// --- reader state -----------------------------------------------------------

{
  const r0 = D.emptyReader()
  const frozen = JSON.stringify(r0)
  const r1 = D.markRead(r0, "000000000001", iso(NOW))
  assert.strictEqual(JSON.stringify(r0), frozen, "markRead doesn't mutate")
  assert.strictEqual(D.isRead(r1, "000000000001"), true, "marked read")
  const r2 = D.markDone(r1, "2026-10-12", iso(NOW))
  assert.strictEqual(D.isRead(r1, "000000000001") && !("2026-10-12" in r1.done), true, "markDone doesn't mutate")
  assert.strictEqual(r2.done["2026-10-12"], iso(NOW), "marked done")

  const old = D.markRead(D.markRead(r0, "old", iso(NOW - days(121))), "recent", iso(NOW - days(119)))
  const pruned = D.markRead(old, "new", iso(NOW))
  assert.deepStrictEqual(Object.keys(pruned.read).sort(), ["new", "recent"], "read older than 120 days pruned")
  assert.deepStrictEqual(Object.keys(old.read).sort(), ["old", "recent"], "pruning doesn't mutate")
  assert.deepStrictEqual(Object.keys(D.markDone(old, "2026-10-12", iso(NOW)).read), ["recent"], "markDone prunes too")
}

{
  const raw = JSON.stringify({
    version: 1, futureKey: { keep: [1, 2] },
    done: { "2026-10-12": "2026-10-12T20:00:00Z", bad: 5 },
    read: { a: "2026-10-12T20:00:00Z" },
    saved: { a: { title: "A", at: "2026-10-12T20:00:00Z" }, b: "nope" },
    votes: "not a map"
  })
  const r = D.parseReader(raw)
  assert.deepStrictEqual(r.extra, { futureKey: { keep: [1, 2] } }, "unknown keys kept")
  assert.deepStrictEqual(Object.keys(r.done), ["2026-10-12"], "malformed done entry dropped")
  assert.deepStrictEqual(Object.keys(r.saved), ["a"], "malformed saved entry dropped")
  assert.deepStrictEqual(r.votes, {}, "bad map defaults to {}")
  assert.deepStrictEqual(r.tries, {}, "missing map defaults to {}")
  const again = JSON.parse(D.serializeReader(D.markRead(r, "c", iso(NOW))))
  assert.deepStrictEqual(again.futureKey, { keep: [1, 2] }, "unknown keys survive a write")
  assert.strictEqual(again.version, 1, "version written")
  assert.deepStrictEqual(Object.keys(again.read).sort(), ["a", "c"], "round-trip keeps entries")
  assert.deepStrictEqual(D.parseReader(D.serializeReader(r)), r, "parse/serialize round-trip")
  assert.strictEqual(D.parseReader("{ truncated"), null, "corrupt reader is null")
  assert.strictEqual(D.parseReader("[1]"), null, "non-object reader is null")
  assert.deepStrictEqual(D.parseReader(""), D.emptyReader(), "empty file is a fresh reader")
}

{
  // monitor A read an item, monitor B marked the day done: both survive
  const base = D.emptyReader()
  const a = D.markRead(base, "x", "2026-10-13T08:00:00Z")
  const b = D.markDone(base, "2026-10-12", "2026-10-13T08:00:05Z")
  const merged = D.mergeReader(a, b)
  assert.strictEqual(D.isRead(merged, "x"), true, "A's read survives")
  assert.strictEqual(merged.done["2026-10-12"], "2026-10-13T08:00:05Z", "B's done survives")

  const older = { title: "old", at: "2026-10-13T07:00:00Z" }
  const newer = { title: "new", at: "2026-10-13T08:00:00Z" }
  const mine = Object.assign(D.emptyReader(), { saved: { s: newer }, read: { r: "2026-10-13T07:00:00Z" } })
  const theirs = Object.assign(D.emptyReader(), { saved: { s: older }, read: { r: "2026-10-13T09:00:00Z" },
                                                  done: { "2026-10-11": "2026-10-12T00:00:00Z" } })
  const m = D.mergeReader(mine, theirs)
  assert.strictEqual(m.saved.s.title, "new", "newer entry wins (mine)")
  assert.strictEqual(m.read.r, "2026-10-13T09:00:00Z", "newer entry wins (theirs)")
  assert.strictEqual(D.mergeReader(theirs, mine).saved.s.title, "new", "merge is order-independent per entry")
  assert.deepStrictEqual(Object.keys(D.mergeReader(b, theirs).done).sort(), ["2026-10-11", "2026-10-12"], "done is a union")
  assert.strictEqual(mine.saved.s.title, "new", "merge doesn't mutate")

  const withExtra = Object.assign(D.emptyReader(), { extra: { later: 1 } })
  assert.deepStrictEqual(D.mergeReader(D.emptyReader(), withExtra).extra, { later: 1 }, "merge keeps unknown keys from disk")
}

// --- rows -------------------------------------------------------------------

{
  const list = D.rows(parse(day({ note: "Slow day." })), true)
  assert.deepStrictEqual(list.map(r => r.kind + ":" + r.section), [
    "header:top", "note:top", "item:top", "item:top", "item:top",
    "header:repos", "item:repos", "item:repos",
    "header:try", "item:try",
    "header:skipped", "note:skipped"
  ], "row order")
  assert.strictEqual(list[2].item.title, "Story 1", "story title")
  assert.strictEqual(list[2].item.source, "HN", "story source")
  assert.strictEqual(list[7].item.unvetted, true, "unvetted repo")
  assert.strictEqual(list[9].item.why, "Do the thing", "try why is what_to_do")
  assert.strictEqual(D.rows(parse(day()), false).some(r => r.section === "skipped"), false, "skipped hidden")
  assert.deepStrictEqual(D.rows(null, true), [], "no digest, no rows")

  assert.strictEqual(D.sectionStart(list, "top"), 0, "top starts at its header")
  assert.strictEqual(D.sectionStart(list, "repos"), 5, "repos header")
  assert.strictEqual(D.sectionStart(list, "nope"), -1, "missing section")
  assert.strictEqual(D.sectionTarget(list, "top"), 2, "1 lands on the first story, past the note")
  assert.strictEqual(D.sectionTarget(list, "try"), 9, "3 lands on the try item")
  assert.strictEqual(D.sectionTarget(list, "skipped"), 10, "4 lands on the skipped header")
  assert.strictEqual(D.nextSection(list, 2, 1), 6, "Tab: top → repos")
  assert.strictEqual(D.nextSection(list, 6, 1), 9, "Tab: repos → try")
  assert.strictEqual(D.nextSection(list, 9, 1), 2, "Tab wraps past skipped to top")
  assert.strictEqual(D.nextSection(list, 2, -1), 9, "Shift-Tab wraps to try")
  assert.strictEqual(D.nextSection(list, -1, 1), 2, "Tab without a cursor starts at top")
  assert.strictEqual(D.moveCursor(list, 4, 1), 6, "j skips the repos header")
  assert.strictEqual(D.moveCursor(list, 2, -1), 2, "k stops at the first item")
  assert.strictEqual(D.moveCursor(list, 9, 1), 9, "j stops at the last item")
  assert.strictEqual(D.findRow(list, "try", "000000000003"), 9, "same id, try section")
  assert.strictEqual(D.findRow(list, "top", "000000000003"), 4, "same id, top section")
  assert.strictEqual(D.findRow(list, "top", null), -1, "null id")

  const degraded = D.rows(parse(day({ state: "degraded", top: [], repos: [], "try": null,
    sources: { ok: 3, total: 12, failed: ["HN", "Latent Space"], stale: [] } })), true)
  assert.strictEqual(degraded.length, 1, "degraded is one row")
  assert.strictEqual(degraded[0].kind, "empty", "degraded row kind")
  assert.ok(degraded[0].text.indexOf("2 of 12 feeds unreachable") === 0, "degraded count")
  assert.ok(degraded[0].text.indexOf("HN, Latent Space") > 0, "degraded lists failed feeds")

  const empty = D.rows(parse(day({ state: "empty", top: [], repos: [], "try": null })), true)
  assert.deepStrictEqual(empty, [{ kind: "empty", section: "", text: "No new items" }], "empty is one row")

  // catch-up day: 10 stories / 5 repos, every one rendered
  const catchUp = parse(day({ catch_up: true, lookback_hours: 74,
    top: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => story(n)), repos: [1, 2, 3, 4, 5].map(n => repo(n)) }))
  const cl = D.rows(catchUp, true)
  assert.strictEqual(cl.filter(r => r.kind === "item" && r.section === "top").length, 10, "10 stories")
  assert.strictEqual(cl.filter(r => r.kind === "item" && r.section === "repos").length, 5, "5 repos")
}

// --- text -------------------------------------------------------------------

{
  const p = D.agentPrompt({ title: "Story", url: "https://e.com/s", why: "Because." })
  assert.ok(p.indexOf("Explain this for me: what it is, why it matters for a full-stack AI engineer, and how I'd try it in about an hour.") === 0, "prompt lead")
  assert.ok(p.indexOf("Story\nhttps://e.com/s") > 0, "title + url")
  assert.ok(p.endsWith("Because."), "why last")
  assert.strictEqual(D.agentPrompt({ title: "T", url: null, why: "" }).indexOf("null"), -1, "no url, no 'null'")
}

{
  const status = D.parseStatus(JSON.stringify({ state: "ok", date: "2026-10-12", lookback_hours: 26,
    sources: { ok: 11, total: 12, failed: ["Smol"], stale: ["Eugene Yan"] } }))
  const oldDay = parse(day())

  const f = D.headerFacts(oldDay, status)
  assert.strictEqual(f.date, "2026-10-12", "date")
  assert.strictEqual(f.sources, "12/12", "day sources win")
  assert.deepStrictEqual(f.stale, ["Eugene Yan"], "stale falls back to status for a pre-2.5 day")
  assert.strictEqual(f.catchUp, "", "not a catch-up")
  assert.strictEqual(f.generatedMs, Date.parse("2026-10-12T18:27:56Z"), "generated time")

  const withStale = parse(day({ sources: { ok: 12, total: 12, failed: [], stale: ["Smol AI News"] } }))
  assert.deepStrictEqual(D.headerFacts(withStale, status).stale, ["Smol AI News"], "day stale wins")
  const noneStale = parse(day({ sources: { ok: 12, total: 12, failed: [], stale: [] } }))
  assert.deepStrictEqual(D.headerFacts(noneStale, status).stale, [], "recorded empty stale doesn't fall back")
  assert.deepStrictEqual(D.headerFacts(oldDay, null).stale, [], "no status, no stale")
  const otherDay = Object.assign({}, status, { date: "2026-10-13" })
  assert.deepStrictEqual(D.headerFacts(oldDay, otherDay).stale, [], "status for another day isn't used")

  const cu = D.headerFacts(parse(day({ catch_up: true, lookback_hours: 74 })), null)
  assert.strictEqual(cu.catchUp, "catch-up ~74h", "catch-up text")

  const failed = D.parseStatus(JSON.stringify({ state: "failed", date: "2026-10-13", error: "claude returned no usable items",
    sources: { ok: 12, total: 12, failed: [], stale: [] } }))
  const ff = D.headerFacts(null, failed)
  assert.strictEqual(ff.error, "claude returned no usable items", "error text")
  assert.strictEqual(ff.date, "2026-10-13", "date from status without a day file")
  assert.strictEqual(ff.sources, "12/12", "sources from status without a day file")
  assert.strictEqual(D.headerFacts(oldDay, status).error, "", "no error when not failed")
}

console.log("digest-test: all checks passed")
