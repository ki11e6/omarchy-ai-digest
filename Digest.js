// Pure digest logic for the AI Digest panel. No Qt in here, so `node` can
// drive the checks directly; QML's .js import ignores the module.exports block.
//
// Every file this reads is written by the ai-digest service, but the panel
// still treats them as untrusted: anything that reaches a Text or a process
// argv goes through these parsers first.

var SECTIONS = ["top", "repos", "try", "skipped"]
var SECTION_TITLES = {
  top: "Top stories",
  repos: "Repos worth a look",
  try: "Worth trying this week",
  skipped: "Skipped"
}

// Somewhat above the service's own caps (prompt.txt / validate_digest), so a
// small change there doesn't silently cut text here.
var MAX_TITLE = 160
var MAX_WHY = 500
var MAX_WHAT = 600
var MAX_NOTE = 300
var MAX_SKIPPED = 400
var MAX_LABEL = 80
var MAX_URL = 2000
var MAX_ITEMS = 20
var MAX_FEEDS = 100
var MAX_RESULTS = 50

// A run older than this is stalled: TimeoutStartSec 25 min + the 1.5 min stop
// timeout is 26.5 min, so 30 is safe but tight. Don't lower it.
var STALL_MS = 30 * 60 * 1000
var READ_KEEP_MS = 120 * 24 * 3600 * 1000

var TRY_STATES = ["later", "tried", "skipped"]
var TRY_TITLES = { later: "Later", tried: "Tried", skipped: "Skipped" }

var STATUS_STATES = ["running", "ok", "empty", "degraded", "failed"]
var DAY_STATES = ["ok", "empty", "degraded"]

var URL_RE = /^https?:\/\/\S+$/
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/
var WEEK_RE = /^\d{4}-W\d{2}$/
var ID_RE = /^[0-9a-f]{12}$/

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function cleanText(value, max) {
  if (typeof value !== "string") return ""
  var t = value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim()
  return t.length > max ? t.slice(0, max - 1).replace(/\s+$/, "") + "…" : t
}

function cleanUrl(value) {
  if (typeof value !== "string" || value.length > MAX_URL) return null
  return URL_RE.test(value) ? value : null
}

function cleanId(value) {
  return typeof value === "string" && ID_RE.test(value) ? value : null
}

function cleanDate(value) {
  return typeof value === "string" && DATE_RE.test(value) ? value : null
}

function cleanLabels(value) {
  if (!Array.isArray(value)) return []
  var out = []
  for (var i = 0; i < value.length && out.length < MAX_FEEDS; i++) {
    var t = cleanText(value[i], MAX_LABEL)
    if (t) out.push(t)
  }
  return out
}

function cleanCount(value) {
  return typeof value === "number" && isFinite(value) && value >= 0 ? Math.floor(value) : null
}

function parseJson(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null
  try {
    return JSON.parse(raw)
  } catch (e) {
    return null
  }
}

// `stale` stays null when the file predates it, so headerFacts can tell
// "no stale feeds" from "not recorded" and fall back to the status file.
function parseSources(s) {
  if (!isObject(s)) return null
  return {
    ok: cleanCount(s.ok),
    total: cleanCount(s.total),
    failed: cleanLabels(s.failed),
    stale: Array.isArray(s.stale) ? cleanLabels(s.stale) : null
  }
}

function parseDigest(raw) {
  var d = parseJson(raw)
  if (!isObject(d)) return null
  var date = cleanDate(d.date)
  if (!date) return null

  var top = []
  var rawTop = Array.isArray(d.top) ? d.top : []
  for (var i = 0; i < rawTop.length && top.length < MAX_ITEMS; i++) {
    var s = rawTop[i]
    if (!isObject(s)) continue
    var url = cleanUrl(s.url)
    var headline = cleanText(s.headline, MAX_TITLE)
    if (!url || !headline) continue
    top.push({ id: cleanId(s.id), headline: headline, why: cleanText(s.why, MAX_WHY),
               url: url, source: cleanText(s.source, MAX_LABEL) })
  }

  var repos = []
  var rawRepos = Array.isArray(d.repos) ? d.repos : []
  for (var j = 0; j < rawRepos.length && repos.length < MAX_ITEMS; j++) {
    var r = rawRepos[j]
    if (!isObject(r)) continue
    var rurl = cleanUrl(r.url)
    var name = cleanText(r.name, MAX_TITLE)
    if (!rurl || !name) continue
    repos.push({ id: cleanId(r.id), name: name, why: cleanText(r.why, MAX_WHY),
                 url: rurl, unvetted: r.unvetted === true })
  }

  // The try item survives without a link: legacy days never had one.
  var tryItem = null
  if (isObject(d["try"])) {
    var title = cleanText(d["try"].title, MAX_TITLE)
    if (title) {
      tryItem = { id: cleanId(d["try"].id), title: title,
                  what_to_do: cleanText(d["try"].what_to_do, MAX_WHAT), url: cleanUrl(d["try"].url) }
    }
  }

  return {
    date: date,
    generated_at: typeof d.generated_at === "string" ? d.generated_at : "",
    model: cleanText(d.model, MAX_LABEL),
    prompt_version: cleanText(d.prompt_version, MAX_LABEL),
    lookback_hours: cleanCount(d.lookback_hours),
    catch_up: d.catch_up === true,
    legacy: d.legacy === true,
    state: DAY_STATES.indexOf(d.state) >= 0 ? d.state : "ok",
    sources: parseSources(d.sources),
    note: cleanText(d.note, MAX_NOTE),
    top: top,
    repos: repos,
    "try": tryItem,
    skipped: cleanText(d.skipped, MAX_SKIPPED)
  }
}

// weekly/latest.json, from `ai-digest --weekly`. Theme links aren't read: the
// view shows a theme as prose, and its items through the week's .md (`e`).
function parseWeekly(raw) {
  var w = parseJson(raw)
  if (!isObject(w) || typeof w.week !== "string" || !WEEK_RE.test(w.week)) return null

  var themes = []
  var rawThemes = Array.isArray(w.themes) ? w.themes : []
  for (var i = 0; i < rawThemes.length && themes.length < MAX_ITEMS; i++) {
    var t = rawThemes[i]
    if (!isObject(t)) continue
    var title = cleanText(t.title, MAX_TITLE)
    if (title) themes.push({ title: title, summary: cleanText(t.summary, MAX_WHAT) })
  }

  var picks = []
  var rawPicks = Array.isArray(w.top_picks) ? w.top_picks : []
  for (var j = 0; j < rawPicks.length && picks.length < MAX_ITEMS; j++) {
    var p = rawPicks[j]
    if (!isObject(p)) continue
    var url = cleanUrl(p.url)
    var headline = cleanText(p.headline, MAX_TITLE)
    if (!url || !headline) continue
    // the day and section the pick first appeared in, so saves and votes read like the daily ones
    picks.push({ id: cleanId(p.id), headline: headline, why: cleanText(p.why, MAX_WHY), url: url,
                 date: cleanDate(p.date) || "",
                 section: ["top", "repos", "try"].indexOf(p.section) >= 0 ? p.section : "top" })
  }

  return {
    week: w.week,
    start: cleanDate(w.start) || "",
    end: cleanDate(w.end) || "",
    days: Array.isArray(w.days) ? w.days.filter(function(d) { return cleanDate(d) !== null }).length : 0,
    generated_at: typeof w.generated_at === "string" ? w.generated_at : "",
    themes: themes,
    top_picks: picks,
    next_week_focus: cleanText(w.next_week_focus, MAX_WHAT)
  }
}

function parseStatus(raw) {
  var s = parseJson(raw)
  if (!isObject(s)) return null
  var feeds = []
  var rawFeeds = Array.isArray(s.feeds) ? s.feeds : []
  for (var i = 0; i < rawFeeds.length && feeds.length < MAX_FEEDS; i++) {
    var f = rawFeeds[i]
    if (!isObject(f)) continue
    feeds.push({
      label: cleanText(f.label, MAX_LABEL),
      url: cleanUrl(f.url),
      ok: f.ok === true,
      kept: cleanCount(f.kept),
      error: cleanText(f.error, MAX_WHY),
      last_ok: typeof f.last_ok === "string" ? f.last_ok : null,
      newest: typeof f.newest === "string" ? f.newest : null,
      stale: f.stale === true
    })
  }
  return {
    state: STATUS_STATES.indexOf(s.state) >= 0 ? s.state : "unknown",
    started_at: typeof s.started_at === "string" ? s.started_at : null,
    finished_at: typeof s.finished_at === "string" ? s.finished_at : null,
    date: cleanDate(s.date),
    json: typeof s.json === "string" ? s.json : null,
    markdown: typeof s.markdown === "string" ? s.markdown : null,
    lookback_hours: cleanCount(s.lookback_hours),
    catch_up: s.catch_up === true,
    sources: parseSources(s.sources),
    feeds: feeds,
    deduped: cleanCount(s.deduped),
    error: cleanText(s.error, MAX_WHY),
    prompt_version: cleanText(s.prompt_version, MAX_LABEL),
    model: cleanText(s.model, MAX_LABEL)
  }
}

function parseIndex(raw) {
  var x = parseJson(raw)
  if (!isObject(x) || !Array.isArray(x.days)) return null
  var days = []
  for (var i = 0; i < x.days.length; i++) {
    var d = x.days[i]
    if (!isObject(d)) continue
    var date = cleanDate(d.date)
    if (!date) continue
    var items = []
    var rawItems = Array.isArray(d.items) ? d.items : []
    for (var j = 0; j < rawItems.length; j++) {
      var it = rawItems[j]
      if (!isObject(it)) continue
      var title = cleanText(it.title, MAX_TITLE)
      if (!title) continue
      items.push({ id: cleanId(it.id), section: SECTIONS.indexOf(it.section) >= 0 ? it.section : "top",
                   title: title, url: cleanUrl(it.url), why: cleanText(it.why, MAX_WHY) })
    }
    days.push({ date: date, state: DAY_STATES.indexOf(d.state) >= 0 ? d.state : "ok",
                legacy: d.legacy === true, items: items })
  }
  days.sort(function(a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0) })
  return { days: days }
}

// --- reader state ---------------------------------------------------------

var READER_MAPS = ["done", "read", "saved", "tries", "votes"]

function emptyReader() {
  return { version: 1, done: {}, read: {}, saved: {}, tries: {}, votes: {}, extra: {} }
}

// Tolerant on purpose: missing maps default to {}, entries of the wrong shape
// are dropped, unknown top-level keys ride along in `extra` so a later phase
// (or the service) never loses data to an older panel's write. Returns null
// only when the text isn't a JSON object at all; empty text is a fresh file.
function parseReader(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return emptyReader()
  var x = parseJson(raw)
  if (!isObject(x)) return null
  var reader = emptyReader()
  for (var key in x) {
    if (!Object.prototype.hasOwnProperty.call(x, key)) continue
    if (key === "version") continue
    if (READER_MAPS.indexOf(key) < 0) { reader.extra[key] = x[key]; continue }
    var map = x[key]
    if (!isObject(map)) continue
    var stamped = key === "done" || key === "read"
    for (var k in map) {
      if (!Object.prototype.hasOwnProperty.call(map, k)) continue
      var v = map[k]
      if (stamped ? typeof v === "string" : isObject(v)) reader[key][k] = v
    }
  }
  return reader
}

function serializeReader(reader) {
  var out = {}
  var extra = reader.extra || {}
  for (var key in extra) {
    if (Object.prototype.hasOwnProperty.call(extra, key)) out[key] = extra[key]
  }
  out.version = 1
  for (var i = 0; i < READER_MAPS.length; i++) out[READER_MAPS[i]] = reader[READER_MAPS[i]] || {}
  return JSON.stringify(out, null, 2) + "\n"
}

function stampOf(v) {
  var t = typeof v === "string" ? v : (isObject(v) && typeof v.at === "string" ? v.at : "")
  var ms = Date.parse(t)
  return isFinite(ms) ? ms : -Infinity
}

function copyMap(map) {
  var out = {}
  for (var k in map) {
    if (Object.prototype.hasOwnProperty.call(map, k)) out[k] = map[k]
  }
  return out
}

// One panel runs per monitor and each writes the whole file, so a load merges
// what's on disk into memory instead of replacing it: per entry, the newer
// timestamp wins. `done` is a union (a newer stamp still wins, harmlessly).
// With `nowIso`, the result is pruned as well, so an entry one monitor pruned
// isn't copied back from another monitor's older file.
function mergeReader(mine, theirs, nowIso) {
  var out = emptyReader()
  out.extra = copyMap(mine.extra || {})
  var te = theirs.extra || {}
  for (var key in te) {
    if (Object.prototype.hasOwnProperty.call(te, key)) out.extra[key] = te[key]
  }
  for (var i = 0; i < READER_MAPS.length; i++) {
    var name = READER_MAPS[i]
    var merged = copyMap(mine[name] || {})
    var other = theirs[name] || {}
    for (var k in other) {
      if (!Object.prototype.hasOwnProperty.call(other, k)) continue
      if (!(k in merged) || stampOf(other[k]) > stampOf(merged[k])) merged[k] = other[k]
    }
    out[name] = merged
  }
  if (nowIso) {
    out.read = pruneRead(out.read, nowIso)
    out.saved = pruneMap(out.saved, nowIso, true)
    out.tries = pruneMap(out.tries, nowIso, true)
    out.votes = pruneMap(out.votes, nowIso, true)
  }
  return out
}

function withMap(reader, name, map) {
  var out = {}
  for (var key in reader) {
    if (Object.prototype.hasOwnProperty.call(reader, key)) out[key] = reader[key]
  }
  out[name] = map
  return out
}

// A removal (unsave, try-state back to none) is stored as a tombstone, not
// deleted: mergeReader copies over any key the other side lacks, so a deleted
// entry would come back with the next write from another monitor. The
// tombstone's newer `at` wins the merge instead.
function isLive(entry) {
  return isObject(entry) && entry.removed !== true
}

function tombstone(nowIso) {
  return { removed: true, at: nowIso }
}

// Drops entries older than READ_KEEP_MS: every entry of `read`, only the
// tombstones of the other maps (a live save is kept however old it is).
function pruneMap(map, nowIso, onlyTombstones) {
  var now = Date.parse(nowIso)
  var out = {}
  for (var k in map) {
    if (!Object.prototype.hasOwnProperty.call(map, k)) continue
    var t = stampOf(map[k])
    var old = isFinite(now) && isFinite(t) && now - t > READ_KEEP_MS
    if (!old || (onlyTombstones && isLive(map[k]))) out[k] = map[k]
  }
  return out
}

function pruneRead(read, nowIso) {
  return pruneMap(read, nowIso, false)
}

function markRead(reader, id, nowIso) {
  var read = pruneRead(reader.read || {}, nowIso)
  if (id) read[id] = nowIso
  return withMap(reader, "read", read)
}

function markDone(reader, date, nowIso) {
  var done = copyMap(reader.done || {})
  if (date) done[date] = nowIso
  return withMap(withMap(reader, "done", done), "read", pruneRead(reader.read || {}, nowIso))
}

function isRead(reader, id) {
  return !!id && !!reader && Object.prototype.hasOwnProperty.call(reader.read || {}, id)
}

function isUnread(newestDate, reader) {
  return !!newestDate && !(reader && Object.prototype.hasOwnProperty.call(reader.done || {}, newestDate))
}

function entryOf(reader, name, id) {
  if (!id || !reader || !isObject(reader[name])) return null
  var e = reader[name][id]
  return isLive(e) ? e : null
}

function isSaved(reader, id) {
  return entryOf(reader, "saved", id) !== null
}

function tryState(reader, id) {
  var e = entryOf(reader, "tries", id)
  return e && TRY_STATES.indexOf(e.state) >= 0 ? e.state : ""
}

// Items are keyed by id (sha1 of the URL), so an item without a link (a
// legacy Worth trying) can't be saved or tracked; the reader is returned as is.
function toggleSaved(reader, item, nowIso) {
  if (!item || !item.id) return reader
  var saved = pruneMap(reader.saved || {}, nowIso, true)
  saved[item.id] = isSaved(reader, item.id)
    ? tombstone(nowIso)
    : { title: item.title, url: item.url, date: item.date || "", section: item.section, at: nowIso }
  return withMap(reader, "saved", saved)
}

// later → tried → skipped → none
function cycleTry(reader, item, nowIso) {
  if (!item || !item.id) return reader
  var next = TRY_STATES[TRY_STATES.indexOf(tryState(reader, item.id)) + 1]
  var tries = pruneMap(reader.tries || {}, nowIso, true)
  tries[item.id] = next
    ? { state: next, title: item.title, url: item.url, date: item.date || "", section: item.section, at: nowIso }
    : tombstone(nowIso)
  return withMap(reader, "tries", tries)
}

function voteOf(reader, id) {
  var e = entryOf(reader, "votes", id)
  return e && (e.vote === 1 || e.vote === -1) ? e.vote : 0
}

// `+` / `-`: set the vote to 1 / -1; the same key again clears it. The
// service reads these (with their titles) as weak signals for the next digest.
function toggleVote(reader, item, vote, nowIso) {
  if (!item || !item.id || (vote !== 1 && vote !== -1)) return reader
  var votes = pruneMap(reader.votes || {}, nowIso, true)
  votes[item.id] = voteOf(reader, item.id) === vote
    ? tombstone(nowIso)
    : { vote: vote, title: item.title, section: item.section, date: item.date || "", at: nowIso }
  return withMap(reader, "votes", votes)
}

// Live entries of a reader map, sanitized (reader.json is a file like any
// other), newest first.
function entryList(map) {
  var out = []
  for (var id in map) {
    if (!Object.prototype.hasOwnProperty.call(map, id) || !isLive(map[id]) || !cleanId(id)) continue
    var e = map[id]
    var title = cleanText(e.title, MAX_TITLE)
    if (!title) continue
    out.push({ id: id, title: title, url: cleanUrl(e.url), date: cleanDate(e.date) || "",
               section: SECTIONS.indexOf(e.section) >= 0 ? e.section : "top",
               state: TRY_STATES.indexOf(e.state) >= 0 ? e.state : "", at: stampOf(e) })
  }
  out.sort(function(a, b) { return b.at - a.at })
  return out
}

function savedList(reader) {
  return entryList(reader && isObject(reader.saved) ? reader.saved : {})
}

// --- bar ------------------------------------------------------------------

// running → stalled → failed → degraded → unread → idle. A running status
// without a readable start time counts as stalled: nothing proves it's alive.
function barState(status, newestDate, reader, nowMs) {
  if (status && status.state === "running") {
    var started = Date.parse(status.started_at || "")
    return isFinite(started) && nowMs - started < STALL_MS ? "running" : "stalled"
  }
  if (status && status.state === "failed") return "failed"
  if (status && status.state === "degraded") return "degraded"
  return isUnread(newestDate, reader) ? "unread" : "idle"
}

function isUrgent(state) {
  return state === "stalled" || state === "failed" || state === "degraded"
}

function freshness(thenMs, nowMs) {
  var s = Math.max(0, Math.floor((nowMs - thenMs) / 1000))
  if (s < 60) return "just now"
  if (s < 3600) return Math.floor(s / 60) + "m ago"
  if (s < 86400) return Math.floor(s / 3600) + "h ago"
  return Math.floor(s / 86400) + "d ago"
}

// --- panel rows -------------------------------------------------------------

function rowItem(section, id, title, why, url, extra) {
  var item = { id: id, section: section, title: title, why: why, url: url, source: "", unvetted: false,
               date: "", meta: "" }
  for (var k in extra) item[k] = extra[k]
  return item
}

// Flat row list for the panel's Repeater, in section order. Degraded and
// empty days are a single explanatory row: the sections are empty by design.
function rows(digest, showSkipped) {
  if (!digest) return []
  if (digest.state === "degraded") {
    var src = digest.sources || { ok: null, total: null, failed: [] }
    var text = (src.failed.length && src.total !== null)
      ? src.failed.length + " of " + src.total + " feeds unreachable — network problem, not a slow news day."
      : "Most feeds were unreachable — network problem, not a slow news day."
    if (src.failed.length) text += "\nFailed: " + src.failed.join(", ")
    return [{ kind: "empty", section: "", text: text }]
  }
  if (digest.state === "empty") return [{ kind: "empty", section: "", text: "No new items" }]

  var out = []
  if (digest.note || digest.top.length) {
    out.push({ kind: "header", section: "top", text: SECTION_TITLES.top })
    if (digest.note) out.push({ kind: "note", section: "top", text: digest.note })
    for (var i = 0; i < digest.top.length; i++) {
      var s = digest.top[i]
      out.push({ kind: "item", section: "top", item: rowItem("top", s.id, s.headline, s.why, s.url, { source: s.source, date: digest.date }) })
    }
  }
  if (digest.repos.length) {
    out.push({ kind: "header", section: "repos", text: SECTION_TITLES.repos })
    for (var j = 0; j < digest.repos.length; j++) {
      var r = digest.repos[j]
      out.push({ kind: "item", section: "repos", item: rowItem("repos", r.id, r.name, r.why, r.url, { unvetted: r.unvetted, date: digest.date }) })
    }
  }
  if (digest["try"]) {
    var t = digest["try"]
    out.push({ kind: "header", section: "try", text: SECTION_TITLES["try"] })
    out.push({ kind: "item", section: "try", item: rowItem("try", t.id, t.title, t.what_to_do, t.url, { date: digest.date }) })
  }
  if (showSkipped && digest.skipped) {
    out.push({ kind: "header", section: "skipped", text: SECTION_TITLES.skipped })
    out.push({ kind: "note", section: "skipped", text: digest.skipped })
  }
  return out
}

// First row of a section (its header), or -1.
function sectionStart(list, section) {
  for (var i = 0; i < list.length; i++) {
    if (list[i].section === section) return i
  }
  return -1
}

function firstItemFrom(list, index) {
  for (var i = Math.max(0, index); i < list.length; i++) {
    if (list[i].kind === "item") return i
  }
  return -1
}

// Where the cursor lands for `1`-`4`: the section's first item, or its header
// when it has none (Skipped), so the panel can still scroll there.
function sectionTarget(list, section) {
  var start = sectionStart(list, section)
  if (start < 0) return -1
  var first = firstItemFrom(list, start)
  return first >= 0 && list[first].section === section ? first : start
}

// Tab / Shift-Tab: the first item of the next / previous section that has items.
function nextSection(list, index, direction) {
  var targets = []
  for (var i = 0; i < SECTIONS.length; i++) {
    var t = sectionTarget(list, SECTIONS[i])
    if (t >= 0 && list[t].kind === "item") targets.push(t)
  }
  if (!targets.length) return index
  var current = index >= 0 && index < list.length ? list[index].section : ""
  for (var j = 0; j < targets.length; j++) {
    if (list[targets[j]].section === current)
      return targets[(j + direction + targets.length) % targets.length]
  }
  return direction > 0 ? targets[0] : targets[targets.length - 1]
}

function moveCursor(list, index, dy) {
  var i = index
  while (true) {
    i += dy
    if (i < 0 || i >= list.length) return index
    if (list[i].kind === "item") return i
  }
}

// Keep the cursor on the same item across a reload. Ids aren't unique within
// a day (the try item often repeats a story's URL), so the section counts too.
function findRow(list, section, id) {
  if (!id) return -1
  for (var i = 0; i < list.length; i++) {
    var r = list[i]
    if (r.kind === "item" && r.section === section && r.item.id === id) return i
  }
  return -1
}

// --- history and search -----------------------------------------------------

// `[` / `]`: the days either side of `date` in the index (newest first).
function dayNeighbours(index, date) {
  var days = index ? index.days : []
  for (var i = 0; i < days.length; i++) {
    if (days[i].date !== date) continue
    return { older: i + 1 < days.length ? days[i + 1].date : "", newer: i > 0 ? days[i - 1].date : "" }
  }
  return { older: "", newer: "" }
}

// In-memory filter over index.json: every whitespace-separated term must
// appear in the title or why, case-insensitively. Newest first, capped.
function search(index, query) {
  var terms = String(query || "").toLowerCase().split(/\s+/).filter(function(t) { return t !== "" })
  if (!index || !terms.length) return []
  var out = []
  for (var i = 0; i < index.days.length; i++) {
    var day = index.days[i]
    for (var j = 0; j < day.items.length; j++) {
      var it = day.items[j]
      var hay = (it.title + " " + it.why).toLowerCase()
      var all = true
      for (var t = 0; t < terms.length && all; t++) all = hay.indexOf(terms[t]) >= 0
      if (!all) continue
      out.push({ date: day.date, id: it.id, section: it.section, title: it.title, url: it.url, why: it.why })
      if (out.length >= MAX_RESULTS) return out
    }
  }
  return out
}

// `g` on a search result: the day and row to land on. Ids repeat across days
// by design, so the result's own day wins; within a day the same id can sit
// in two sections (a story that is also the try item), so its section wins.
// An item without an id (legacy try) still lands on its day.
function jumpTarget(index, id, date, section) {
  var days = index ? index.days : []
  var fallback = null
  for (var i = 0; i < days.length; i++) {
    var d = days[i]
    if (!id) {
      if (d.date === date) return { date: date, section: section || "", id: "" }
      continue
    }
    var hit = null
    for (var j = 0; j < d.items.length; j++) {
      if (d.items[j].id !== id) continue
      if (!hit || d.items[j].section === section) hit = { date: d.date, section: d.items[j].section, id: id }
    }
    if (hit && d.date === date) return hit
    if (hit && !fallback) fallback = hit
  }
  return fallback
}

// --- other views ----------------------------------------------------------------

function itemMeta(section, date) {
  return [SECTION_TITLES[section] || "", date || ""].filter(function(s) { return s !== "" }).join(" · ")
}

function searchRows(results, query) {
  if (!String(query || "").trim()) return [{ kind: "empty", section: "", text: "Type to search every digest in the archive." }]
  if (!results.length) return [{ kind: "empty", section: "", text: "No matches." }]
  var out = []
  for (var i = 0; i < results.length; i++) {
    var r = results[i]
    out.push({ kind: "item", section: "results",
               item: rowItem(r.section, r.id, r.title, r.why, r.url, { date: r.date, meta: itemMeta(r.section, r.date) }) })
  }
  return out
}

function listRow(e, group) {
  return { kind: "item", section: group, item: rowItem(e.section, e.id, e.title, "", e.url, { date: e.date, meta: itemMeta(e.section, e.date) }) }
}

function savedRows(reader) {
  var list = savedList(reader)
  if (!list.length) return [{ kind: "empty", section: "", text: "Nothing saved yet. Press s on an item to save it." }]
  return list.map(function(e) { return listRow(e, "saved") })
}

function triesRows(reader) {
  var list = entryList(reader && isObject(reader.tries) ? reader.tries : {})
  var out = []
  for (var i = 0; i < TRY_STATES.length; i++) {
    var state = TRY_STATES[i]
    var group = list.filter(function(e) { return e.state === state })
    if (!group.length) continue
    out.push({ kind: "header", section: state, text: TRY_TITLES[state] })
    for (var j = 0; j < group.length; j++) out.push(listRow(group[j], state))
  }
  return out.length ? out : [{ kind: "empty", section: "", text: "Nothing tracked yet. Press t on an item: later, tried, skipped." }]
}

function stampText(iso, nowMs) {
  var ms = Date.parse(iso || "")
  return isFinite(ms) ? freshness(ms, nowMs) : "never"
}

// One row per feed, in feeds.txt order. No url: Enter on a feed row has
// nothing useful to open (it's an RSS document).
function healthRows(status, nowMs) {
  if (!status || !status.feeds.length) return [{ kind: "empty", section: "", text: "No feed health recorded yet. It is written on every run." }]
  var out = []
  for (var i = 0; i < status.feeds.length; i++) {
    var f = status.feeds[i]
    var parts = [f.ok ? (f.kept !== null ? f.kept + " kept" : "ok") : "failed", "last ok " + stampText(f.last_ok, nowMs)]
    // a failed fetch says nothing about how fresh the feed is
    if (f.ok) parts.push("newest " + (f.newest ? stampText(f.newest, nowMs) : "undated"))
    var detail = parts.join(" · ")
    if (f.error) detail += "\n" + f.error
    out.push({ kind: "item", section: "feeds",
               item: rowItem("feeds", null, (f.ok ? "✓ " : "✗ ") + (f.label || f.url || "feed"), detail, null,
                             { stale: f.stale, failed: !f.ok }) })
  }
  return out
}

// `W`: themes as prose, top picks as item rows (open, copy, ask, save, vote),
// then the focus line.
function weekRows(weekly) {
  if (!weekly) return [{ kind: "empty", section: "", text: "No weekly roll-up yet. It runs on Sunday mornings, or now with: ai-digest --weekly" }]
  var out = []
  if (weekly.themes.length) {
    out.push({ kind: "header", section: "themes", text: "Themes" })
    for (var i = 0; i < weekly.themes.length; i++) {
      var t = weekly.themes[i]
      out.push({ kind: "theme", section: "themes", title: t.title, text: t.summary })
    }
  }
  if (weekly.top_picks.length) {
    out.push({ kind: "header", section: "picks", text: "Top picks" })
    for (var j = 0; j < weekly.top_picks.length; j++) {
      var p = weekly.top_picks[j]
      out.push({ kind: "item", section: "picks",
                 item: rowItem(p.section, p.id, p.headline, p.why, p.url, { date: p.date, meta: itemMeta(p.section, p.date) }) })
    }
  }
  if (weekly.next_week_focus) {
    out.push({ kind: "header", section: "focus", text: "Focus for next week" })
    out.push({ kind: "note", section: "focus", text: weekly.next_week_focus })
  }
  return out.length ? out : [{ kind: "empty", section: "", text: "This week's roll-up is empty." }]
}

function weekMeta(weekly, nowMs) {
  if (!weekly) return ""
  var parts = [weekly.week]
  if (weekly.start && weekly.end) parts.push(weekly.start + " – " + weekly.end)
  if (weekly.days) parts.push(weekly.days + (weekly.days === 1 ? " digest" : " digests"))
  var generated = Date.parse(weekly.generated_at)
  if (isFinite(generated)) parts.push(freshness(generated, nowMs))
  return parts.join(" · ")
}

function duration(ms) {
  var s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s"
}

// The health view's header line: the last run, from status.json.
function healthSummary(status, nowMs) {
  if (!status) return "No run recorded yet."
  var parts = ["last run " + status.state]
  var started = Date.parse(status.started_at || "")
  var finished = Date.parse(status.finished_at || "")
  if (isFinite(started)) parts.push("started " + freshness(started, nowMs))
  if (isFinite(started) && isFinite(finished)) parts.push("took " + duration(finished - started))
  if (status.prompt_version) parts.push("prompt " + status.prompt_version)
  if (status.model) parts.push(status.model)
  if (status.deduped !== null) parts.push(status.deduped + " deduped")
  return parts.join(" · ")
}

var KEYS = [
  ["j / k", "move"], ["Tab, 1-4", "next section, jump to section"], ["Enter, o", "open link (marks it read)"],
  ["c", "copy link"], ["a", "ask your agent about it"], ["s", "save / unsave"], ["t", "try: later → tried → skipped → none"],
  ["+ / -", "vote up / down (again to clear); steers the next digests"],
  ["[ / ]", "older / newer day"], ["T", "back to the newest day"], ["/", "search the archive (g: go to that day)"],
  ["S", "saved items"], ["E", "export saved items to saved.md"], ["L", "try log"], ["H", "feed health"],
  ["W", "weekly roll-up"],
  ["e", "edit the day's .md (in H: feeds.txt, in W: the week's .md)"], ["r", "run the digest now"], ["m", "mark the day done"],
  ["?", "this help"], ["Esc", "back, then close"]
]

function helpRows() {
  return KEYS.map(function(k) { return { kind: "key", section: "", key: k[0], text: k[1] } })
}

// ~/ai-digest/saved.md. Titles come from feeds, so link syntax in them is
// escaped; parentheses in URLs are percent-encoded so they can't end the link.
function savedMarkdown(reader) {
  var lines = ["# Saved from AI digest", ""]
  var list = savedList(reader)
  for (var i = 0; i < list.length; i++) {
    var e = list[i]
    var title = e.title.replace(/[\\\[\]]/g, "\\$&")
    var link = e.url ? "[" + title + "](" + e.url.replace(/\(/g, "%28").replace(/\)/g, "%29") + ")" : title
    lines.push("- " + link + " — " + itemMeta(e.section, e.date).replace(" · ", ", "))
  }
  if (!list.length) lines.push("Nothing saved.")
  return lines.join("\n") + "\n"
}

// --- text -----------------------------------------------------------------

function agentPrompt(item) {
  var parts = ["Explain this for me: what it is, why it matters for a full-stack AI engineer, and how I'd try it in about an hour."]
  parts.push(item.title + (item.url ? "\n" + item.url : ""))
  if (item.why) parts.push(item.why)
  return parts.join("\n\n")
}

// What the panel header and the bar tooltip say about a day. Fields the day
// file lacks (stale lists predate Phase 2.5) come from status.json, but only
// when it describes the same day.
function headerFacts(digest, status) {
  var sameDay = !!status && (!digest || status.date === digest.date)
  var daySrc = digest ? digest.sources : null
  var statusSrc = sameDay ? status.sources : null
  var src = daySrc || statusSrc
  var stale = daySrc && daySrc.stale !== null ? daySrc.stale : (statusSrc && statusSrc.stale ? statusSrc.stale : [])
  var hours = digest ? digest.lookback_hours : (sameDay ? status.lookback_hours : null)
  var catchUp = digest ? digest.catch_up : (sameDay && status.catch_up)
  var generated = digest ? Date.parse(digest.generated_at) : NaN
  return {
    date: digest ? digest.date : (status && status.date ? status.date : ""),
    sources: src && src.ok !== null && src.total !== null ? src.ok + "/" + src.total : "",
    catchUp: catchUp ? (hours !== null ? "catch-up ~" + hours + "h" : "catch-up") : "",
    failed: src ? src.failed : [],
    stale: stale,
    error: status && status.state === "failed" ? status.error : "",
    generatedMs: isFinite(generated) ? generated : null
  }
}

if (typeof module !== "undefined") {
  module.exports = {
    SECTIONS: SECTIONS,
    SECTION_TITLES: SECTION_TITLES,
    STALL_MS: STALL_MS,
    MAX_RESULTS: MAX_RESULTS,
    cleanText: cleanText,
    cleanUrl: cleanUrl,
    parseDigest: parseDigest,
    parseStatus: parseStatus,
    parseIndex: parseIndex,
    parseWeekly: parseWeekly,
    emptyReader: emptyReader,
    parseReader: parseReader,
    serializeReader: serializeReader,
    mergeReader: mergeReader,
    markRead: markRead,
    markDone: markDone,
    isRead: isRead,
    isUnread: isUnread,
    isSaved: isSaved,
    tryState: tryState,
    toggleSaved: toggleSaved,
    cycleTry: cycleTry,
    voteOf: voteOf,
    toggleVote: toggleVote,
    savedList: savedList,
    barState: barState,
    isUrgent: isUrgent,
    freshness: freshness,
    rows: rows,
    sectionStart: sectionStart,
    sectionTarget: sectionTarget,
    nextSection: nextSection,
    moveCursor: moveCursor,
    findRow: findRow,
    dayNeighbours: dayNeighbours,
    search: search,
    jumpTarget: jumpTarget,
    searchRows: searchRows,
    savedRows: savedRows,
    triesRows: triesRows,
    healthRows: healthRows,
    healthSummary: healthSummary,
    weekRows: weekRows,
    weekMeta: weekMeta,
    helpRows: helpRows,
    savedMarkdown: savedMarkdown,
    agentPrompt: agentPrompt,
    headerFacts: headerFacts
  }
}
