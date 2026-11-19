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

import os
import subprocess


def ensure_numpy():
    """No numpy here: install it once into a private venv (~/.cline/tree-venv)
    and re-run this script with that Python. Never touches the system Python.
    A failed install is not retried for a day."""
    try:
        import numpy  # noqa: F401
        return
    except ImportError:
        pass
    home = os.path.join(os.path.expanduser("~"), ".cline")
    venv = os.path.join(home, "tree-venv")
    vpy = os.path.join(venv, "Scripts", "python.exe") if os.name == "nt" else os.path.join(venv, "bin", "python")
    failed = os.path.join(home, "tree-venv-failed")
    if os.path.abspath(sys.executable) == os.path.abspath(vpy):
        sys.exit(1)  # the venv itself has no numpy: give up (robot logo)
    if not os.path.exists(vpy) or subprocess.run([vpy, "-c", "import numpy"], capture_output=True).returncode:
        if os.path.exists(failed) and time.time() - os.path.getmtime(failed) < 86400:
            sys.exit(1)
        quiet = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "stdin": subprocess.DEVNULL}
        try:
            os.makedirs(home, exist_ok=True)
            subprocess.run([sys.executable, "-m", "venv", venv], check=True, timeout=300, **quiet)
            subprocess.run([vpy, "-m", "pip", "install", "-q", "numpy"], check=True, timeout=900, **quiet)
        except Exception:
            open(failed, "w").close()
            sys.exit(1)
    os.execv(vpy, [vpy, "-u", os.path.abspath(__file__), *sys.argv[1:]])


ensure_numpy()
from terminal_tree import make_scene, render_braille  # noqa: E402

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
