# AI Digest 󰎕

A bar widget for Omarchy that is the reading surface for the `ai-digest`
systemd service: today's AI stories, a few repos worth a look, and one thing
to try, in a keyboard panel.

![kind: bar-widget](https://img.shields.io/badge/kind-bar--widget-blue)

![AI Digest panel](preview.png)

The service does all the work — fetching feeds, calling Claude, validating the
result. This plugin only reads the files it writes and keeps one file of its
own (what you've read, saved and want to try). No polling, no processes per keystroke, no AI calls
from the shell.

## The icon

| Looks like | Means |
|---|---|
| dot | the newest digest isn't marked done |
| pulsing | the service is running |
| urgent colour | the last run degraded (most feeds down), failed, or has been running for 30+ minutes |

A degraded day that is also unread shows both. Stale feeds (answering, but
quiet for longer than usual) don't change the icon; they're listed in the panel.

## Keys

| Key | Action |
|---|---|
| `j` / `k`, ↓ / ↑ | move |
| `Tab` / `Shift-Tab`, `1`-`4` | next / previous section, jump to Top / Repos / Try / Skipped |
| `Enter`, `o` | open the link (marks the item read) |
| `c` | copy the link |
| `a` | ask your default agent about the item |
| `s` / `S` | save / unsave the item; the saved list |
| `E` | export the saved list to `~/ai-digest/saved.md` |
| `t` / `L` | try-state: later → tried → skipped → none; the try log |
| `+` / `-` | vote the item up / down (again to clear); the service passes recent votes to the next digest as weak hints |
| `[` / `]`, `T` | older / newer day; back to the newest |
| `/` | search every digest in the archive; `g` on a result goes to that day |
| `H` | feed health: each feed's last fetch, newest item, stale marker, error |
| `e` | open the day's markdown in your editor (in `H`: `feeds.txt`) |
| `r` | run the digest now |
| `m` | mark the day's digest done (clears the dot) |
| `?` | key help |
| `Esc` | back to the digest, then close |

Bind a key to summon it on the focused monitor, e.g. in
`~/.config/hypr/bindings.lua`:

```lua
o.bind("SUPER + ALT + D", "AI digest", "omarchy-shell shell toggle io.github.ki11e6.ai-digest")
```

## Files

| Path | Written by | Used for |
|---|---|---|
| `~/.local/state/ai-digest/status.json` | service, last | run state; the only service file the panel watches |
| `~/ai-digest/index.json` | service | which day is newest, history, search |
| `~/ai-digest/YYYY-MM-DD.json` | service | the day shown |
| `~/ai-digest/YYYY-MM-DD.md` | service | `e`, and days without JSON (shown as plain text) |
| `~/.local/state/ai-digest/reader.json` | this plugin | read items, done days, saved items, try-states, votes |
| `~/ai-digest/saved.md` | this plugin, on `E` | the saved list as markdown links |

The bar runs one copy of the widget per monitor. Each copy watches
`reader.json` and merges changes from the others, so marking a day done on one
monitor clears the dot on all of them. Removals (unsave, try-state back to
none) are kept as timestamped tombstones so another monitor's older copy
can't bring them back; they age out after 120 days.

Days written before the service produced JSON can be converted with
`ai-digest --backfill`; until then they show as plain text.

## Settings

| Setting | Default | |
|---|---|---|
| Digest folder | `~/ai-digest` | where the service writes daily files |
| Show the Skipped line | on | |
| Show a dot for an unread digest | on | |

Changes apply without restarting the shell.

## Requirements

- Omarchy 4 with the shell plugin framework
- The `ai-digest` service (structured JSON output, `status.json` and `index.json`)

## Development

```bash
node test/digest-test.js   # pure logic in Digest.js
./dev.sh                   # copy into ~/.config/omarchy/plugins, validate, restart the shell, enable
```

## License

MIT
