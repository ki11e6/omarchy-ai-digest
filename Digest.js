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

// A run older than this is stalled: TimeoutStartSec 25 min + the 1.5 min stop
// timeout is 26.5 min, so 30 is safe but tight. Don't lower it.
var STALL_MS = 30 * 60 * 1000
var READ_KEEP_MS = 120 * 24 * 3600 * 1000

var STATUS_STATES = ["running", "ok", "empty", "degraded", "failed"]
var DAY_STATES = ["ok", "empty", "degraded"]

var URL_RE = /^https?:\/\/\S+$/
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/
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
function mergeReader(mine, theirs) {
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

function pruneRead(read, nowIso) {
  var now = Date.parse(nowIso)
  var out = {}
  for (var k in read) {
    if (!Object.prototype.hasOwnProperty.call(read, k)) continue
    var t = Date.parse(read[k])
    if (!isFinite(now) || !isFinite(t) || now - t <= READ_KEEP_MS) out[k] = read[k]
  }
  return out
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
  var item = { id: id, section: section, title: title, why: why, url: url, source: "", unvetted: false }
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
      out.push({ kind: "item", section: "top", item: rowItem("top", s.id, s.headline, s.why, s.url, { source: s.source }) })
    }
  }
  if (digest.repos.length) {
    out.push({ kind: "header", section: "repos", text: SECTION_TITLES.repos })
    for (var j = 0; j < digest.repos.length; j++) {
      var r = digest.repos[j]
      out.push({ kind: "item", section: "repos", item: rowItem("repos", r.id, r.name, r.why, r.url, { unvetted: r.unvetted }) })
    }
  }
  if (digest["try"]) {
    var t = digest["try"]
    out.push({ kind: "header", section: "try", text: SECTION_TITLES["try"] })
    out.push({ kind: "item", section: "try", item: rowItem("try", t.id, t.title, t.what_to_do, t.url, {}) })
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
    STALL_MS: STALL_MS,
    cleanText: cleanText,
    cleanUrl: cleanUrl,
    parseDigest: parseDigest,
    parseStatus: parseStatus,
    parseIndex: parseIndex,
    emptyReader: emptyReader,
    parseReader: parseReader,
    serializeReader: serializeReader,
    mergeReader: mergeReader,
    markRead: markRead,
    markDone: markDone,
    isRead: isRead,
    isUnread: isUnread,
    barState: barState,
    isUrgent: isUrgent,
    freshness: freshness,
    rows: rows,
    sectionStart: sectionStart,
    sectionTarget: sectionTarget,
    nextSection: nextSection,
    moveCursor: moveCursor,
    findRow: findRow,
    agentPrompt: agentPrompt,
    headerFacts: headerFacts
  }
}
