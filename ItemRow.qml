import QtQuick
import QtQuick.Layouts
import qs.Commons
import qs.Ui

// One digest item: bold title, dim "why", trailing markers. Hover moves the
// panel cursor rather than painting its own highlight (CursorSurface contract).
CursorSurface {
  id: row

  property var item: null
  property int rowIndex: -1
  property bool selected: false
  property bool read: false
  property bool saved: false
  property string tryState: ""
  property color urgentColor: Color.urgent
  property string fontFamily: Style.font.family
  readonly property color dim: Qt.darker(foreground, 1.55)

  signal pointerMoved(Item area, var mouse)
  signal activated()

  hasCursor: selected
  implicitHeight: content.implicitHeight + Style.space(12)

  MouseArea {
    id: area
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: row.item && row.item.url ? Qt.PointingHandCursor : Qt.ArrowCursor
    onPositionChanged: function(mouse) { row.pointerMoved(area, mouse) }
    onClicked: row.activated()
  }

  RowLayout {
    id: content
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    anchors.leftMargin: Style.spacing.rowPaddingX
    anchors.rightMargin: Style.space(8)
    spacing: Style.space(8)

    ColumnLayout {
      Layout.fillWidth: true
      spacing: Style.space(2)

      Text {
        textFormat: Text.PlainText
        Layout.fillWidth: true
        text: row.item ? row.item.title : ""
        color: row.item && row.item.failed ? row.urgentColor : row.foreground
        font.family: row.fontFamily
        font.pixelSize: Style.font.body
        font.bold: true
        wrapMode: Text.WordWrap
        maximumLineCount: 2
        elide: Text.ElideRight
      }

      // where a listed item came from (search, saved, try log)
      Text {
        textFormat: Text.PlainText
        Layout.fillWidth: true
        visible: text !== ""
        text: row.item && row.item.meta ? row.item.meta : ""
        color: row.dim
        font.family: row.fontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
      }

      Text {
        textFormat: Text.PlainText
        Layout.fillWidth: true
        visible: text !== ""
        text: row.item ? row.item.why : ""
        color: row.dim
        font.family: row.fontFamily
        font.pixelSize: Style.font.bodySmall
        wrapMode: Text.WordWrap
        maximumLineCount: 3
        elide: Text.ElideRight
      }
    }

    Text {
      textFormat: Text.PlainText
      Layout.alignment: Qt.AlignTop
      visible: text !== ""
      text: {
        var marks = []
        if (row.item && row.item.unvetted) marks.push("unvetted")
        if (row.item && row.item.stale) marks.push("stale")
        if (row.tryState) marks.push(row.tryState)
        if (row.saved) marks.push("★")
        if (row.read) marks.push("✓")
        return marks.join("  ")
      }
      color: row.dim
      font.family: row.fontFamily
      font.pixelSize: Style.font.caption
    }
  }
}
