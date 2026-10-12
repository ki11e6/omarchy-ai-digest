import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Digest.js" as Digest

// Bar icon + keyboard panel for the ai-digest service. Read-only over the
// service's files; the only thing written is reader.json.
//
// The bar builds this widget once per monitor, so everything here exists N
// times. No IpcHandler: `omarchy-shell shell toggle <id>` already routes to
// the focused screen's instance, and a per-instance handler would race for
// the target. reader.json is shared by all instances (see readerFile).
Panel {
  id: root
  moduleName: "io.github.ki11e6.ai-digest"

  readonly property string home: Quickshell.env("HOME")
  readonly property string digestDir: home + "/ai-digest"
  readonly property string stateDir: home + "/.local/state/ai-digest"

  property var status: null
  property var archiveIndex: null
  property var digest: null
  property bool useMarkdown: false
  property string legacyText: ""

  property var reader: Digest.emptyReader()
  property bool readerReady: false
  property bool readerDirty: false
  property bool savingNow: false
  property string readerWarning: ""

  property double nowMs: Date.now()
  property int cursorIndex: -1
  property string cursorSection: ""
  property string cursorId: ""

  // Never derived from the clock: the newest day is whatever the service last
  // wrote. Without index.json, latest.json stands in; status.date isn't used
  // because a failed run's date has no day file.
  readonly property string newestDate: archiveIndex && archiveIndex.days.length > 0
    ? archiveIndex.days[0].date
    : ""
  // Phase 4 makes this navigable; for now it follows the newest day.
  readonly property string selectedDate: newestDate
  readonly property string dayBase: digestDir + "/" + (selectedDate !== "" ? selectedDate : "latest")
  readonly property string shownDate: digest ? digest.date : selectedDate
  readonly property string unreadDate: newestDate !== "" ? newestDate : (digest ? digest.date : "")

  readonly property string barState: Digest.barState(status, unreadDate, reader, nowMs)
  readonly property bool unread: Digest.isUnread(unreadDate, reader)
  readonly property bool urgent: Digest.isUrgent(barState)
  readonly property var facts: Digest.headerFacts(digest, status)
  readonly property var rowList: Digest.rows(digest, true)

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color urgentColor: bar ? bar.urgent : Color.urgent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property string tooltip: {
    var parts = []
    if (facts.date) parts.push(facts.date)
    if (facts.sources) parts.push(facts.sources + " sources")
    if (barState !== "idle") parts.push(barState)
    return "AI digest" + (parts.length ? " — " + parts.join(" · ") : "")
  }

  readonly property string metaText: {
    var parts = []
    if (facts.date) parts.push(facts.date)
    if (facts.generatedMs !== null) parts.push(Digest.freshness(facts.generatedMs, nowMs))
    if (barState === "running") parts.push("running now")
    return parts.join(" · ")
  }

  readonly property string detailText: {
    var parts = []
    if (facts.sources) parts.push(facts.sources + " sources")
    if (facts.catchUp) parts.push(facts.catchUp)
    return parts.join(" · ")
  }

  readonly property string urgentText: {
    if (barState === "stalled") {
      var started = status ? Date.parse(status.started_at || "") : NaN
      return "The digest run started " + (isFinite(started) ? Digest.freshness(started, nowMs) : "a while ago")
        + " and hasn't finished."
    }
    var failed = facts.failed.length ? "Unreachable: " + facts.failed.join(", ") : ""
    if (barState === "failed")
      return "Last run failed: " + (facts.error || "unknown error") + (failed ? "\n" + failed : "")
    if (barState === "degraded") return failed || "Most feeds were unreachable."
    return ""
  }

  readonly property string dimText: {
    var lines = []
    if (!urgent && facts.failed.length) lines.push("failed: " + facts.failed.join(", "))
    if (facts.stale.length) lines.push("stale: " + facts.stale.join(", "))
    return lines.join("\n")
  }

  visible: true
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  function nowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
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
      readerWarning = "reader.json is unreadable; starting with empty reader state."
    } else {
      reader = Digest.mergeReader(reader, parsed)
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
    cursorSection = item ? item.section : ""
    cursorId = item && item.id ? item.id : ""
    ensureRowVisible(i)
  }

  function ensureRowVisible(i) {
    if (!flick || !listColumn || i < 0) return
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

  function jumpToSection(section) {
    var t = Digest.sectionTarget(rowList, section)
    if (t < 0) return
    if (rowList[t].kind === "item") setCursor(t)
    else ensureRowVisible(t)
  }

  onRowListChanged: {
    var i = Digest.findRow(rowList, cursorSection, cursorId)
    setCursor(i >= 0 ? i : Digest.moveCursor(rowList, -1, 1))
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
    if (!item) return
    Util.execArgv(["omarchy", "agent", "prompt", Digest.agentPrompt(item)])
    root.close()
  }

  function editDay() {
    Util.execArgv(["omarchy-launch-editor", dayBase + ".md"])
    root.close()
  }

  function runNow() {
    if (barState === "running") return
    Util.execArgv(["systemctl", "--user", "start", "--no-block", "ai-digest.service"])
  }

  function markDayDone() {
    if (shownDate) updateReader(Digest.markDone(reader, shownDate, nowIso()))
  }

  onOpenedChanged: {
    if (!opened) return
    nowMs = Date.now()
    // the header carries the run state, so every open starts at the top
    flick.contentY = 0
    if (cursorIndex < 0) setCursor(Digest.moveCursor(rowList, -1, 1))
    else ensureRowVisible(cursorIndex)
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
      root.status = Digest.parseStatus(text())
      root.nowMs = Date.now()
      indexFile.reload()
      dayFile.reload()
      if (root.useMarkdown) mdFile.reload()
    }
    onLoadFailed: function(error) { root.status = null }
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
      visible: root.unread
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
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(680))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (dy !== 0) root.setCursor(Digest.moveCursor(root.rowList, root.cursorIndex, dy))
      }
      onTabRequested: function(direction) {
        root.setCursor(Digest.nextSection(root.rowList, root.cursorIndex, direction))
      }
      // Enter fires both returnRequested and activateRequested; only this one is used.
      onActivateRequested: root.openItem(root.selectedItem())
      onCloseRequested: root.close()
      onTextKey: function(t) {
        var n = "1234".indexOf(t)
        if (n >= 0) root.jumpToSection(Digest.SECTIONS[n])
        else if (t === "o") root.openItem(root.selectedItem())
        else if (t === "c") root.copyItem(root.selectedItem())
        else if (t === "a") root.askItem(root.selectedItem())
        else if (t === "e") root.editDay()
        else if (t === "r") root.runNow()
        else if (t === "m") root.markDayDone()
      }

      Flickable {
        id: flick
        anchors.fill: parent
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
          spacing: Style.space(10)

          PanelHero {
            width: parent.width
            title: "AI digest"
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
            text: [root.urgentText, root.readerWarning].filter(function(s) { return s !== "" }).join("\n")
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

                ItemRow {
                  visible: slot.modelData.kind === "item"
                  width: parent.width
                  item: visible ? slot.modelData.item : null
                  rowIndex: slot.index
                  selected: root.cursorIndex === slot.index
                  read: visible && Digest.isRead(root.reader, slot.modelData.item.id)
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  onHovered: root.setCursor(slot.index)
                  onActivated: root.openItem(slot.modelData.item)
                }
              }
            }
          }

          Text {
            textFormat: Text.PlainText
            visible: root.rowList.length === 0 && root.useMarkdown && root.legacyText !== ""
            width: parent.width
            text: root.legacyText
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          Text {
            textFormat: Text.PlainText
            visible: root.rowList.length === 0 && !(root.useMarkdown && root.legacyText !== "")
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

          PanelSeparator {
            width: parent.width
            foreground: root.foreground
          }

          Text {
            textFormat: Text.PlainText
            width: parent.width
            text: "j/k move   Tab/1-4 section   Enter/o open   c copy   a ask   e edit   r run   m done   Esc close"
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
}
