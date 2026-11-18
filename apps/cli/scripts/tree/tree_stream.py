"""Live tree renderer for the CLI home screen.

Started by apps/cli/src/tui/components/live-tree.tsx:
    python -u tree_stream.py COLS ROWS

stdout: one JSON object per frame: {"w", "h", "rows": [str], "runs": [count, "#hex"|null, ...]}
        (runs are row-major colour runs over w*h cells; null = no colour).
stdin:  "COLS ROWS" lines resize the tree. EOF (parent gone) stops the process.
The tree grows once, then spins forever.
"""

import json
import sys
import threading
import time

from terminal_tree import make_scene, render_braille

FPS = 12

size = [int(sys.argv[1]), int(sys.argv[2])] if len(sys.argv) > 2 else [40, 26]
alive = True


def read_stdin():
    global alive
    for line in sys.stdin:
        parts = line.split()
        if len(parts) == 2 and all(p.isdigit() for p in parts):
            size[0], size[1] = max(10, int(parts[0])), max(8, int(parts[1]))
    alive = False


def runs_of(colors):
    runs, prev = [], object()
    for c in colors:
        if runs and c == prev:
            runs[-2] += 1
        else:
            runs += [1, c]
        prev = c
    return runs


def main():
    threading.Thread(target=read_stdin, daemon=True).start()
    cols, rows = size
    scene = make_scene(cols, rows)
    start = time.perf_counter()
    frame = 0
    while alive:
        if (cols, rows) != tuple(size):
            cols, rows = size
            scene = make_scene(cols, rows)
        t = time.perf_counter() - start
        lines, colors = render_braille(scene, t, cols, rows)
        # Blank cells take the previous colour so runs stay long (a space's colour is invisible).
        last = None
        for i, c in enumerate(colors):
            if c is None:
                colors[i] = last
            else:
                last = c
        try:
            sys.stdout.write(json.dumps({"w": cols, "h": rows, "rows": lines, "runs": runs_of(colors)}, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        except (BrokenPipeError, OSError):
            return
        frame += 1
        delay = start + frame / FPS - time.perf_counter()
        if delay > 0:
            time.sleep(delay)
        else:
            frame = int((time.perf_counter() - start) * FPS)  # fell behind: skip ahead


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    main()
