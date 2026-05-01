# Screenshots

Drop the four PNGs referenced from the root `README.md` here.

| Filename | Capture |
|---|---|
| `01-constellation.png` | Graph tab, athlai-bot session (or any large session). Force-directed cluster with labels visible. |
| `02-rca.png` | RCA tab, self-resolveScope session. Left panel shows ranked candidates with score badges + recent commits. |
| `03-impact.png` | Impact tab after running `findCallers` impact analysis. The "high blast radius" banner + tree + ranked table. |
| `04-inspector.png` | Graph tab with a node selected. Monaco panel slid in on the left, showing the source. |

## Capture them in 2 minutes

```sh
# 1. Generate sessions
mkdir -p /tmp/cgrca-sessions
cgrca rca symbol:resolveScope --repo packages/core --persist /tmp/cgrca-sessions/self.sqlite

# 2. Boot the UI
cgrca-view /tmp/cgrca-sessions

# 3. In your browser, take screenshots of each tab and drop them in this dir
#    with the filenames above. Cmd-Shift-4 on macOS, then drag the rectangle.
```

The README's image references will resolve as soon as you commit the PNGs.
