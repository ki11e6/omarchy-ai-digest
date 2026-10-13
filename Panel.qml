import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Digest.js" as Digest

// Bar icon + keyboard panel for the ai-digest service. Read-only over the
// service's files; the only things written are reader.json and, on `E`,
// saved.md.
//
// The bar builds this widget once per monitor, so everything here exists N
// times. No IpcHandler: `omarchy-shell shell toggle <id>` already routes to
// the focused screen's instance, and a per-instance handler would race for
// the target. reader.json is shared by all instances (see readerFile).
Panel {
  id: root
  moduleName: "io.github.ki11e6.ai-digest"

  readonly property string home: Quickshell.env("HOME")
  readonly property string digestDir: expandPath(setting("digestDir", "")) || home + "/ai-digest"
  readonly property string stateDir: home + "/.local/state/ai-digest"
  readonly property string feedsPath: home + "/.config/ai-digest/feeds.txt"
  readonly property bool showSkipped: setting("showSkipped", true) === true
  readonly property bool unreadDot: setting("unreadDot", true) === true

  property var status: null
  property string statusWarning: ""
  property var archiveIndex: null
  property var digest: null
  property var weekly: null
  property bool useMarkdown: false
  property string legacyText: ""

  property var reader: Digest.emptyReader()
  property bool readerReady: false
  property bool readerDirty: false
  property bool savingNow: false
  property string readerWarning: ""

  // `r`: set until status.json next changes or systemctl refuses the start
  property bool runRequested: false
  property string runWarning: ""
  property string runStderr: ""

  property double nowMs: Date.now()
  property int cursorIndex: -1
  property string cursorSection: ""
  property string cursorId: ""

  // digest | search | saved | tries | health | week | help
  property string view: "digest"
  property string searchQuery: ""
  property string notice: ""
  property int exportCount: 0
  // `g` from search: where the cursor goes once that day has loaded
  property var pendingJump: null

  // Never derived from the clock: the newest day is whatever the service last
  // wrote. Without index.json, latest.json stands in; status.date isn't used
  // because a failed run's date has no day file.
  readonly property string newestDate: archiveIndex && archiveIndex.days.length > 0
    ? archiveIndex.days[0].date
    : ""
  // "" follows the newest day, so a new digest shows up without pressing T
  property string selectedDate: ""
  readonly property string shownDay: selectedDate !== "" ? selectedDate : newestDate
  readonly property string dayBase: digestDir + "/" + (shownDay !== "" ? shownDay : "latest")
  readonly property string shownDate: digest ? digest.date : shownDay
  readonly property string unreadDate: newestDate !== "" ? newestDate : (digest ? digest.date : "")
  readonly property var neighbours: Digest.dayNeighbours(archiveIndex, shownDay)

  readonly property string barState: Digest.barState(status, unreadDate, reader, nowMs)
  readonly property bool unread: Digest.isUnread(unreadDate, reader)
  readonly property bool urgent: Digest.isUrgent(barState)
  readonly property var facts: Digest.headerFacts(digest, status)
  readonly property var searchResults: view === "search" ? Digest.search(archiveIndex, searchQuery) : []
  readonly property var rowList: {
    if (view === "search") return Digest.searchRows(searchResults, searchQuery)
    if (view === "saved") return Digest.savedRows(reader)
    if (view === "tries") return Digest.triesRows(reader)
    if (view === "health") return Digest.healthRows(status, nowMs)
    if (view === "week") return Digest.weekRows(weekly)
    if (view === "help") return Digest.helpRows()
    return Digest.rows(digest, showSkipped)
  }

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color urgentColor: bar ? bar.urgent : Color.urgent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property var viewTitles: ({ search: "Search", saved: "Saved", tries: "Try log", health: "Feed health", week: "Week", help: "Keys" })

  readonly property string tooltip: {
    var parts = []
    if (facts.date) parts.push(facts.date)
    if (facts.sources) parts.push(facts.sources + " sources")
    if (barState !== "idle") parts.push(barState)
    return "AI digest" + (parts.length ? " — " + parts.join(" · ") : "")
  }

  readonly property string metaText: {
    if (view === "search") return searchQuery.trim() ? searchResults.length + (searchResults.length === Digest.MAX_RESULTS ? "+" : "") + " matches" : ""
    if (view === "saved") return Digest.savedList(reader).length + " saved"
    if (view === "week") return Digest.weekMeta(weekly, nowMs)
    if (view !== "digest") return ""
    var parts = []
    if (facts.date) parts.push(facts.date)
    if (digest && digest.legacy) parts.push("from the old archive")
    else if (facts.generatedMs !== null) parts.push(Digest.freshness(facts.generatedMs, nowMs))
    if (barState === "running") parts.push("running now")
    return parts.join(" · ")
  }

  readonly property string detailText: {
    if (view !== "digest") return ""
    var parts = []
    if (facts.sources) parts.push(facts.sources + " sources")
    if (facts.catchUp) parts.push(facts.catchUp)
    return parts.join(" · ")
  }

  readonly property string historyText: {
    if (view !== "digest" || !archiveIndex || archiveIndex.days.length < 2) return ""
    var parts = []
    // key first, then what it does, like the footer hints
    if (neighbours.older) parts.push("[ older " + neighbours.older)
    if (neighbours.newer) parts.push("] newer " + neighbours.newer)
    if (selectedDate !== "") parts.push("T newest")
    return parts.join("   ·   ")
  }

  readonly property string urgentText: {
    var retry = "\nPress r to run it again."
    if (barState === "stalled") {
      var started = status ? Date.parse(status.started_at || "") : NaN
      return "The digest run started " + (isFinite(started) ? Digest.freshness(started, nowMs) : "a while ago")
        + " and hasn't finished." + retry
    }
    var failed = facts.failed.length ? "Unreachable: " + facts.failed.join(", ") : ""
    if (barState === "failed")
      return "Last run failed: " + (facts.error || "unknown error") + (failed ? "\n" + failed : "") + retry
    if (barState === "degraded") return (failed || "Most feeds were unreachable.") + retry
    return ""
  }

  readonly property string dimText: {
    var lines = []
    if (historyText) lines.push(historyText)
    // too long for the hero's single meta line
    if (view === "health") lines.push(Digest.healthSummary(status, nowMs))
    if (view === "digest" && !urgent && facts.failed.length) lines.push("failed: " + facts.failed.join(", "))
    if (view === "digest" && facts.stale.length) lines.push("stale: " + facts.stale.join(", "))
    if (runRequested) lines.push("Starting the digest…")
    if (notice) lines.push(notice)
    return lines.join("\n")
  }

  visible: true
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  function nowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
  }

  // Same rules as the first-party agents plugin's sync folder setting.
  function expandPath(path) {
    var value = String(path || "").trim()
    if (value === "") return ""
    if (value === "~") return home
    if (value.indexOf("~/") === 0) return home + value.substring(1)
    if (value.indexOf("$HOME/") === 0) return home + value.substring(5)
    if (value.charAt(0) !== "/") return home + "/" + value
    return value.replace(/\/+$/, "")
  }

  function shortPath(path) {
    return path.indexOf(home + "/") === 0 ? "~" + path.substring(home.length) : path
  }

  // --- reader state ---------------------------------------------------------

  function updateReader(next) {
    reader = next
    readerDirty = true
    if (readerReady) saveTimer.restart()
  }

  function loadReader(raw) {
    var parsed = Digest.parseReader(raw)
    if (parsed === null) {
      readerWarning = "reader.json is unreadable; starting with empty reader state. Your next change replaces the file."
    } else {
      reader = Digest.mergeReader(reader, parsed, nowIso())
      readerWarning = ""
    }
    readerReady = true
    if (readerDirty) saveTimer.restart()
  }

  function flushReader() {
    savingNow = true
    readerDirty = false
    readerFile.setText(Digest.serializeReader(reader))
  }

  // --- cursor ---------------------------------------------------------------

  function selectedItem() {
    var r = cursorIndex >= 0 && cursorIndex < rowList.length ? rowList[cursorIndex] : null
    return r && r.kind === "item" ? r.item : null
  }

  function setCursor(i) {
    cursorIndex = i
    var item = selectedItem()
    cursorSection = item ? rowList[i].section : ""
    cursorId = item && item.id ? item.id : ""
    ensureRowVisible(i)
  }

  function ensureRowVisible(i) {
    // before the first layout the viewport has no height yet, and every row
    // would look "below" it
    if (!flick || !listColumn || i < 0 || flick.height <= 0) return
    var kids = listColumn.children
    for (var n = 0; n < kids.length; n++) {
      var k = kids[n]
      if (!k || k.rowIndex !== i) continue
      var top = k.mapToItem(flick.contentItem, 0, 0).y
      var bottom = top + k.height
      if (top < flick.contentY) flick.contentY = top
      else if (bottom > flick.contentY + flick.height) flick.contentY = Math.max(0, bottom - flick.height)
      return
    }
  }

  // The panel is a full-screen surface, so rows sliding under a still pointer
  // (first layout, scrolling) produce hover events; only real pointer motion
  // moves the cursor. Same gate as the shell's clipboard plugin.
  function selectFromPointer(i, area, mouse) {
    if (pointerGate.moved(area, mouse)) setCursor(i)
  }

  function jumpToSection(section) {
    var t = Digest.sectionTarget(rowList, section)
    if (t < 0) return
    if (rowList[t].kind === "item") {
      setCursor(t)
      return
    }
    // no item to select (Skipped): show the section to its last row, since
    // the cursor can't go there; its header wins if both don't fit
    var last = t
    while (last + 1 < rowList.length && rowList[last + 1].section === section) last++
    ensureRowVisible(last)
    ensureRowVisible(t)
  }

  function resetCursor() {
    cursorIndex = -1
    cursorSection = ""
    cursorId = ""
  }

  // Same item if it's still there; otherwise the nearest item at or above the
  // old position (an unsave in the saved view), else the first item.
  function placeCursor() {
    var i = -1
    var jump = pendingJump
    if (jump && view === "digest" && digest && digest.date === jump.date) {
      pendingJump = null
      i = Digest.findRow(rowList, jump.section, jump.id)
      if (i < 0) i = Digest.sectionTarget(rowList, jump.section)
    } else {
      i = Digest.findRow(rowList, cursorSection, cursorId)
      if (i < 0 && cursorIndex >= 0) {
        i = Math.min(cursorIndex, rowList.length - 1)
        if (i >= 0 && rowList[i].kind !== "item") i = Digest.moveCursor(rowList, i, -1)
      }
    }
    var first = Digest.moveCursor(rowList, -1, 1)
    setCursor(i >= 0 && rowList[i].kind === "item" ? i : first)
    // On the first item, show the list from its top instead: whatever sits
    // above it (W's themes, a note) stays in view. Also covers files that
    // finish loading after the view switched, which rebuild the rows again.
    if (cursorIndex === first) flick.contentY = 0
  }

  onRowListChanged: {
    pointerGate.reset()
    placeCursor()
  }

  // --- views and history ------------------------------------------------------

  function setView(next) {
    notice = ""
    var same = next === view
    resetCursor()
    // every view opens at the top of its list; the first row is still in view
    flick.contentY = 0
    view = next
    // same view: rowList doesn't change, so nothing else puts the cursor back
    if (same) placeCursor()
    if (next === "search") {
      Qt.callLater(function() { searchField.forceActiveFocus(); searchField.selectAll() })
    } else {
      keyCatcher.forceActiveFocus()
    }
  }

  function showDay(date) {
    if (!date) return
    pendingJump = null
    var next = date === newestDate ? "" : date
    var same = next === selectedDate && view === "digest"
    resetCursor()
    selectedDate = next
    if (view !== "digest") setView("digest")
    if (same) placeCursor()
    flick.contentY = 0
  }

  function jumpTo(item) {
    if (!item) return
    var target = Digest.jumpTarget(archiveIndex, item.id, item.date, item.section)
    if (!target) return
    showDay(target.date)
    pendingJump = target
    // the day may already be loaded, in which case no reload will apply the jump
    if (digest && digest.date === target.date) placeCursor()
  }

  // --- actions --------------------------------------------------------------

  function openItem(item) {
    if (!item || !item.url) return
    Util.execArgv(["xdg-open", item.url])
    if (item.id) updateReader(Digest.markRead(reader, item.id, nowIso()))
    root.close()
  }

  function copyItem(item) {
    if (!item || !item.url) return
    Util.execArgv(["wl-copy", item.url])
  }

  function askItem(item) {
    if (!item || view === "health") return
    Util.execArgv(["omarchy", "agent", "prompt", Digest.agentPrompt(item)])
    root.close()
  }

  function saveItem(item) {
    if (!item || view === "health") return
    if (!item.id) { notice = "This item has no link, so it can't be saved."; return }
    updateReader(Digest.toggleSaved(reader, item, nowIso()))
  }

  function cycleTryItem(item) {
    if (!item || view === "health") return
    if (!item.id) { notice = "This item has no link, so it can't be tracked."; return }
    updateReader(Digest.cycleTry(reader, item, nowIso()))
  }

  function voteItem(item, vote) {
    if (!item || view === "health") return
    if (!item.id) { notice = "This item has no link, so it can't be voted on."; return }
    updateReader(Digest.toggleVote(reader, item, vote, nowIso()))
  }

  function exportSaved() {
    exportCount = Digest.savedList(reader).length
    exportFile.setText(Digest.savedMarkdown(reader))
  }

  function editDay() {
    var path = dayBase + ".md"
    if (view === "health") path = feedsPath
    else if (view === "week" && weekly) path = digestDir + "/weekly/" + weekly.week + ".md"
    Util.execArgv(["omarchy-launch-editor", path])
    root.close()
  }

  function runNow() {
    if (barState === "running" || runner.running) return
    runWarning = ""
    runStderr = ""
    runRequested = true
    runner.running = true
  }

  function markDayDone() {
    if (shownDate) updateReader(Digest.markDone(reader, shownDate, nowIso()))
  }

  readonly property var viewKeys: ({ "S": "saved", "L": "tries", "H": "health", "W": "week", "?": "help" })

  function handleKey(t) {
    var item = selectedItem()
    if (t === "/") setView("search")
    else if (viewKeys[t]) {
      // the weekly run doesn't touch status.json, so nothing else tells the panel it changed
      if (t === "W") weeklyFile.reload()
      setView(view === viewKeys[t] ? "digest" : viewKeys[t])
    }
    else if (t === "o") openItem(item)
    else if (t === "c") copyItem(item)
    else if (t === "a") askItem(item)
    else if (t === "s") saveItem(item)
    else if (t === "t") cycleTryItem(item)
    else if (t === "+") voteItem(item, 1)
    else if (t === "-") voteItem(item, -1)
    else if (t === "E") exportSaved()
    else if (t === "e") editDay()
    else if (t === "r") runNow()
    else if (t === "[") showDay(neighbours.older)
    else if (t === "]") showDay(neighbours.newer)
    else if (t === "T") showDay(newestDate)
    else if (t === "g" && view === "search") jumpTo(item)
    else if (view === "digest") {
      var n = "1234".indexOf(t)
      if (n >= 0) jumpToSection(Digest.SECTIONS[n])
      else if (t === "m") markDayDone()
    }
  }

  onOpenedChanged: {
    if (!opened) return
    nowMs = Date.now()
    notice = ""
    // every open starts on the newest digest, at the top: the header carries the run state
    pointerGate.reset()
    if (selectedDate !== "") showDay(newestDate)
    if (view !== "digest") setView("digest")
    if (cursorIndex < 0) setCursor(Digest.moveCursor(rowList, -1, 1))
    // after the first layout: on the first open the panel has no size yet
    Qt.callLater(function() {
      flick.contentY = 0
      root.ensureRowVisible(root.cursorIndex)
    })
  }

  // --- files ----------------------------------------------------------------

  // The commit point: the service writes status.json last, so the day file
  // and index are reloaded from here and never watched themselves.
  FileView {
    id: statusFile
    path: root.stateDir + "/status.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      var raw = text()
      root.status = Digest.parseStatus(raw)
      root.statusWarning = Digest.statusWarning(raw, root.status)
      // any write means the service has reported, even a run that failed
      // before this instance saw it as `running`
      root.runRequested = false
      root.nowMs = Date.now()
      indexFile.reload()
      dayFile.reload()
      weeklyFile.reload()
      if (root.useMarkdown) mdFile.reload()
    }
    onLoadFailed: function(error) {
      root.status = null
      root.statusWarning = error === FileViewError.FileNotFound
        ? "" : "Can't read status.json (" + FileViewError.toString(error) + ")."
    }
  }

  // `r`. Util.execArgv is detached and never reports back, so a missing unit
  // or a refused start would look like nothing happened. --no-block returns
  // once the job is queued; the service's own status.json takes it from there.
  Process {
    id: runner
    command: ["systemctl", "--user", "start", "--no-block", "ai-digest.service"]
    // the exit can land before the collector; whichever comes second has both
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.runStderr = String(text || "").trim().slice(0, 300)
        if (root.runWarning !== "" && root.runStderr !== "") root.runWarning = "Couldn't start ai-digest.service: " + root.runStderr
      }
    }
    onExited: function(exitCode) {
      if (exitCode === 0) return
      root.runRequested = false
      root.runWarning = "Couldn't start ai-digest.service" + (root.runStderr !== "" ? ": " + root.runStderr : " (exit " + exitCode + ").")
    }
  }

  FileView {
    id: indexFile
    path: root.digestDir + "/index.json"
    printErrors: false
    onLoaded: root.archiveIndex = Digest.parseIndex(text())
    onLoadFailed: function(error) { root.archiveIndex = null }
  }

  FileView {
    id: dayFile
    path: root.dayBase + ".json"
    printErrors: false
    onLoaded: {
      root.digest = Digest.parseDigest(text())
      root.useMarkdown = root.digest === null
    }
    onLoadFailed: function(error) {
      root.digest = null
      root.useMarkdown = true
    }
  }

  // `ai-digest --weekly`'s newest roll-up (a symlink the service repoints).
  FileView {
    id: weeklyFile
    path: root.digestDir + "/weekly/latest.json"
    printErrors: false
    onLoaded: root.weekly = Digest.parseWeekly(text())
    onLoadFailed: function(error) { root.weekly = null }
  }

  // Legacy days have no JSON; their markdown is shown as plain text.
  FileView {
    id: mdFile
    path: root.useMarkdown ? root.dayBase + ".md" : ""
    printErrors: false
    onLoaded: root.legacyText = String(text()).slice(0, 20000)
    onLoadFailed: function(error) { root.legacyText = "" }
  }

  // Every instance writes the whole file, so every instance watches it: a
  // change from another monitor is merged in (Digest.mergeReader), and the
  // change event caused by our own write is skipped.
  FileView {
    id: readerFile
    path: root.stateDir + "/reader.json"
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onFileChanged: {
      if (root.savingNow) { root.savingNow = false; return }
      reload()
    }
    onLoaded: root.loadReader(text())
    onLoadFailed: function(error) {
      if (error === FileViewError.FileNotFound) root.loadReader("")
      else root.readerWarning = "Can't read reader.json (" + FileViewError.toString(error) + "); changes won't be saved."
    }
    onSaveFailed: function(error) {
      root.savingNow = false
      root.readerWarning = "Can't save reader.json: " + FileViewError.toString(error)
    }
  }

  // Write-only: never loaded, so a hand-edited saved.md is only replaced on `E`.
  FileView {
    id: exportFile
    path: root.digestDir + "/saved.md"
    preload: false
    atomicWrites: true
    printErrors: false
    onSaved: root.notice = "Exported " + root.exportCount + " items to " + root.shortPath(path)
    onSaveFailed: function(error) { root.notice = "Can't write saved.md: " + FileViewError.toString(error) }
  }

  PointerMoveGate {
    id: pointerGate
    referenceItem: flick
  }

  Timer {
    id: saveTimer
    interval: 400
    onTriggered: root.flushReader()
  }

  // Lets `running` turn into `stalled` while the panel is closed.
  Timer {
    interval: 5 * 60 * 1000
    running: root.barState === "running"
    repeat: true
    onTriggered: root.nowMs = Date.now()
  }

  Timer {
    interval: 60 * 1000
    running: root.opened
    repeat: true
    onTriggered: root.nowMs = Date.now()
  }

  // --- bar ------------------------------------------------------------------

  Item {
    id: iconHolder
    anchors.fill: parent

    // On a wrapper, not the button: WidgetButton binds its own opacity.
    SequentialAnimation on opacity {
      running: root.barState === "running"
      loops: Animation.Infinite
      alwaysRunToEnd: true
      NumberAnimation { to: 0.35; duration: 700; easing.type: Easing.InOutSine }
      NumberAnimation { to: 1; duration: 700; easing.type: Easing.InOutSine }
    }

    BarIconButton {
      id: button
      anchors.fill: parent
      bar: root.bar
      text: String.fromCodePoint(0xF0395)
      active: root.urgent
      tooltipText: root.tooltip
      onPressed: function(b) { root.toggle() }
    }

    Rectangle {
      visible: root.unread && root.unreadDot
      width: Style.space(5)
      height: width
      radius: width / 2
      color: Color.accent
      anchors.centerIn: parent
      anchors.horizontalCenterOffset: Style.bar.iconCanvas / 2
      anchors.verticalCenterOffset: -Style.bar.iconCanvas / 2 + height / 2
    }
  }

  // --- panel ----------------------------------------------------------------

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(460))
    contentHeight: panel.fittedContentHeight(
      header.implicitHeight + gap + column.implicitHeight + gap + footer.implicitHeight, Style.space(680))

    readonly property int gap: Style.space(10)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // the search field takes every key while focused; it hands Esc and
      // Enter back itself (see searchField)
      blocked: searchField.activeFocus
      onMoveRequested: function(dx, dy) {
        pointerGate.reset()
        if (dy !== 0) root.setCursor(Digest.moveCursor(root.rowList, root.cursorIndex, dy))
      }
      onTabRequested: function(direction) {
        pointerGate.reset()
        if (root.view === "digest") root.setCursor(Digest.nextSection(root.rowList, root.cursorIndex, direction))
      }
      // Enter fires both returnRequested and activateRequested; only this one is used.
      onActivateRequested: root.openItem(root.selectedItem())
      onCloseRequested: root.view !== "digest" ? root.setView("digest") : root.close()
      onTextKey: function(t) {
        pointerGate.reset()
        root.handleKey(t)
      }

      // Outside the Flickable, like the footer: which day or view this is, and
      // any run warning, stay visible however far the list scrolls.
      Column {
        id: header
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: panel.gap

        PanelHero {
          width: parent.width
          title: root.view === "digest" ? "AI digest" : "AI digest · " + root.viewTitles[root.view]
          meta: root.metaText
          detail: root.detailText
          foreground: root.foreground
          fontFamily: root.fontFamily
          iconComponent: Component {
            Text {
              textFormat: Text.PlainText
              text: String.fromCodePoint(0xF0395)
              color: root.urgent ? root.urgentColor : root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.display
            }
          }
        }

        Text {
          textFormat: Text.PlainText
          visible: text !== ""
          width: parent.width
          text: [root.urgentText, root.statusWarning, root.runWarning, root.readerWarning].filter(function(s) { return s !== "" }).join("\n")
          color: root.urgentColor
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        Text {
          textFormat: Text.PlainText
          visible: text !== ""
          width: parent.width
          text: root.dimText
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }

        TextField {
          id: searchField
          visible: root.view === "search"
          width: parent.width
          placeholderText: "Search " + (root.archiveIndex ? root.archiveIndex.days.length : 0) + " days of digests"
          foreground: root.foreground
          font.family: root.fontFamily
          onTextChanged: root.searchQuery = text
          Keys.onEscapePressed: function(event) { keyCatcher.forceActiveFocus(); event.accepted = true }
          Keys.onReturnPressed: function(event) { keyCatcher.forceActiveFocus(); event.accepted = true }
          Keys.onEnterPressed: function(event) { keyCatcher.forceActiveFocus(); event.accepted = true }
        }
      }

      Flickable {
        id: flick
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: header.bottom
        anchors.topMargin: panel.gap
        anchors.bottom: footer.top
        anchors.bottomMargin: panel.gap
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: flick.width
          spacing: panel.gap

          Column {
            id: listColumn
            visible: root.rowList.length > 0
            width: parent.width
            spacing: Style.space(6)

            Repeater {
              model: root.rowList

              delegate: Column {
                id: slot
                required property var modelData
                required property int index
                readonly property int rowIndex: index
                width: listColumn.width

                PanelSectionHeader {
                  visible: slot.modelData.kind === "header"
                  text: visible ? slot.modelData.text : ""
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  topPadding: slot.index > 0 ? Style.space(8) : Math.ceil(fontSize * 0.15)
                }

                Text {
                  textFormat: Text.PlainText
                  visible: slot.modelData.kind === "note" || slot.modelData.kind === "empty"
                  width: parent.width
                  leftPadding: Style.spacing.rowPaddingX
                  rightPadding: Style.space(8)
                  topPadding: slot.modelData.kind === "empty" ? Style.space(6) : 0
                  bottomPadding: slot.modelData.kind === "empty" ? Style.space(6) : 0
                  text: visible ? slot.modelData.text : ""
                  color: slot.modelData.kind === "empty" ? root.foreground : root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  wrapMode: Text.WordWrap
                }

                // a weekly theme: prose, not a selectable item
                Column {
                  visible: slot.modelData.kind === "theme"
                  width: parent.width
                  leftPadding: Style.spacing.rowPaddingX
                  rightPadding: Style.space(8)
                  topPadding: Style.space(4)
                  bottomPadding: Style.space(4)
                  spacing: Style.space(2)

                  Text {
                    textFormat: Text.PlainText
                    width: parent.width - parent.leftPadding - parent.rightPadding
                    text: slot.modelData.kind === "theme" ? slot.modelData.title : ""
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    font.bold: true
                    wrapMode: Text.WordWrap
                  }

                  Text {
                    textFormat: Text.PlainText
                    visible: text !== ""
                    width: parent.width - parent.leftPadding - parent.rightPadding
                    text: slot.modelData.kind === "theme" ? slot.modelData.text : ""
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    wrapMode: Text.WordWrap
                  }
                }

                Row {
                  visible: slot.modelData.kind === "key"
                  leftPadding: Style.spacing.rowPaddingX
                  spacing: Style.space(12)

                  Text {
                    textFormat: Text.PlainText
                    width: Style.space(80)
                    text: slot.modelData.kind === "key" ? slot.modelData.key : ""
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    font.bold: true
                  }

                  Text {
                    textFormat: Text.PlainText
                    width: listColumn.width - Style.space(80) - Style.space(12) - Style.spacing.rowPaddingX
                    text: slot.modelData.kind === "key" ? slot.modelData.text : ""
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    wrapMode: Text.WordWrap
                  }
                }

                ItemRow {
                  visible: slot.modelData.kind === "item"
                  width: parent.width
                  item: visible ? slot.modelData.item : null
                  rowIndex: slot.index
                  selected: root.cursorIndex === slot.index
                  read: visible && Digest.isRead(root.reader, slot.modelData.item.id)
                  saved: visible && Digest.isSaved(root.reader, slot.modelData.item.id)
                  tryState: visible ? Digest.tryState(root.reader, slot.modelData.item.id) : ""
                  vote: visible ? Digest.voteOf(root.reader, slot.modelData.item.id) : 0
                  foreground: root.foreground
                  urgentColor: root.urgentColor
                  fontFamily: root.fontFamily
                  onPointerMoved: function(area, mouse) { root.selectFromPointer(slot.index, area, mouse) }
                  onActivated: root.openItem(slot.modelData.item)
                }
              }
            }
          }

          Text {
            textFormat: Text.PlainText
            visible: root.view === "digest" && root.rowList.length === 0 && root.useMarkdown && root.legacyText !== ""
            width: parent.width
            text: root.legacyText
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          Text {
            textFormat: Text.PlainText
            visible: root.view === "digest" && root.rowList.length === 0 && !(root.useMarkdown && root.legacyText !== "")
            width: parent.width
            topPadding: Style.space(6)
            bottomPadding: Style.space(6)
            text: root.barState === "running" ? "The digest is running…" : "No digest yet. Press r to run it now."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
          }
        }
      }

      // Outside the Flickable so the hints stay visible on a long list; the
      // rest of the keys are under `?`.
      Column {
        id: footer
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        spacing: panel.gap

        PanelSeparator {
          width: parent.width
          foreground: root.foreground
        }

        Text {
          textFormat: Text.PlainText
          width: parent.width
          // non-breaking space inside each pair, so a wrap never strands a key from its label
          text: [["Enter", "open"], ["s", "save"], ["t", "try"], ["[ ]", "day"], ["/", "search"], ["?", "keys"],
                 ["Esc", root.view === "digest" ? "close" : "back"]]
            .map(function(p) { return p[0] + "\u00a0" + p[1] }).join("   ")
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          horizontalAlignment: Text.AlignHCenter
          wrapMode: Text.WordWrap
        }
      }
    }
  }
}
