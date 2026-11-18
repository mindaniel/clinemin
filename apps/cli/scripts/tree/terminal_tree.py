"""Render christmas_tree.py as braille terminal cells (2x4 dots per cell).

render_braille(scene, t, cols, rows) -> (rows: list[str], colors: list[str | None])
colors is row-major, one "#rrggbb" per cell (None = blank cell).
"""

import importlib.util
import math
import os

os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
HERE = os.path.dirname(os.path.abspath(__file__))

_spec = importlib.util.spec_from_file_location("christmas_tree", os.path.join(HERE, "christmas_tree.py"))
tree = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tree)
np = tree.np

_project = tree.project
_star = tree.star
T_MSG = tree.T_MSG
tree.T_MSG = math.inf  # message is drawn as plain text below the tree instead

# Dot density follows brightness. A high floor leaves dark gaps between needles so the
# tree reads as branches with depth instead of a solid block.
DENSITY_FLOOR = 0.30
DENSITY_SPREAD = 0.62
LEVELS = 16  # colour steps per channel

BAYER = np.array([[0, 4], [6, 2], [1, 5], [7, 3]], dtype=np.float64) / 8.0
BIT = np.array([[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]], dtype=np.int32)
LEVEL_LUT = np.zeros(256)
LEVEL_LUT[33:] = 1.0
for _i, _c in enumerate(tree.RAMP):
    LEVEL_LUT[ord(_c)] = _i / (len(tree.RAMP) - 1)


def make_scene(cols, rows):
    """Build the scene, thinning the sky stars to suit a small grid."""
    scene = tree.build()
    area = (cols * rows) / (tree.COLS * tree.ROWS)
    keep = lambda a: a[: max(8, int(len(a) * area * 1.5))]
    scene["bg_stars"] = keep(scene["bg_stars"])
    scene["falling_stars"] = keep(scene["falling_stars"])
    return scene


def _hex(rgb):
    step = 255 / (LEVELS - 1)
    r, g, b = (int(round(round(float(v) / step) * step)) for v in rgb)
    return f"#{r:02x}{g:02x}{b:02x}"


def render_braille(scene, t, cols, rows):
    gw, gh = cols * 2, rows * 4
    # Each cell (about 1:2) holds 2x4 dots, so dots are square: aspect 1.
    tree.project = lambda pts, c, r, *a, **k: _project(pts, c, r, 1.0)
    scale = gh / tree.ROWS * 0.8
    tree.star = lambda ch, col, cx, cy, size, flash=0.0: _star(ch, col, cx, cy, max(1.0, size * scale), flash)
    char, col, _ = tree.render_frame(scene, t, gw, gh)

    level = LEVEL_LUT[np.clip(char, 0, 255)]
    thresh = DENSITY_FLOOR + DENSITY_SPREAD * np.tile(BAYER, (rows, cols))
    on = (char > 32) & (level >= thresh)

    on4 = on.reshape(rows, 4, cols, 2)
    bits = (on4 * BIT[None, :, None, :]).sum(axis=(1, 3))
    cnt = on4.sum(axis=(1, 3))
    c4 = col.reshape(rows, 4, cols, 2, 3).astype(np.float64) * on4[..., None]
    avg = c4.sum(axis=(1, 3)) / np.maximum(cnt, 1)[..., None]
    peak = c4.max(axis=(1, 3, 4))
    # Average colour lifted toward the brightest dot: keeps sparkle without one light tinting the cell.
    avg = np.clip(avg * np.sqrt(peak / np.maximum(avg.max(axis=2), 1.0))[..., None], 0, 255)

    lines = ["".join(chr(0x2800 + int(b)) if b else " " for b in row) for row in bits]
    colors = [_hex(avg[y, x]) if bits[y, x] else None for y in range(rows) for x in range(cols)]
    _message(lines, colors, t, cols, rows)
    return lines, colors


def _message(lines, colors, t, cols, rows):
    if t <= T_MSG or rows < 6:
        return
    msg = tree.MESSAGE
    row, x0 = rows - 2, (cols - len(msg)) // 2
    if x0 < 0:
        return
    shown = min(len(msg), int((t - T_MSG) * 10))
    line = list(lines[row])
    for x in range(max(x0 - 1, 0), min(cols, x0 + len(msg) + 1)):
        line[x] = " "
        colors[row * cols + x] = None
    for i, ch in enumerate(msg[:shown]):
        if ch != " ":
            tint = (tree.RED, tree.GOLD, tree.GREEN_BOX)[(i // 2 + int(t * 1.5)) % 3]
            br = 0.95 + 0.25 * math.sin(t * 5 + i)
            line[x0 + i] = ch
            colors[row * cols + x0 + i] = _hex(np.clip(tint * br * 255, 0, 255))
    lines[row] = "".join(line)
