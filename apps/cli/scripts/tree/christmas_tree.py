import math
import time
import numpy as np
import pygame

# ── Configuration ────────────────────────────────────────────────────────────
TAU = 2.0 * np.pi
GROUND = -1.15
Y0, Y1 = -0.82, 1.45

# Animation timing (seconds)
T_GROW = (0.0, 2.8)
T_GARLAND = (2.4, 4.0)
T_BALLS = (3.6, 5.0)
T_LIGHTS = (4.6, 5.8)
T_GIFTS = (5.0, 6.0)
T_STAR = 5.8
T_MSG = 6.4

# Material IDs
NEEDLE, SNOW, TRUNK, TINSEL, BALL, LIGHT, GIFT = range(7)

# Colors (0..1 RGB)
WHITE = np.array([0.95, 0.97, 1.00])
RED = np.array([0.95, 0.18, 0.16])
GOLD = np.array([1.00, 0.80, 0.22])
BAUBLE_GOLD = np.array([1.00, 0.76, 0.24])
WARM = np.array([1.00, 0.84, 0.45])
GREEN_BOX = np.array([0.16, 0.72, 0.34])
BLUE_BOX = np.array([0.22, 0.45, 0.95])

MESSAGE = "MERRY CHRISTMAS 2026"
RAMP = " .,:;-=+*#%@&W"
RAMP_CODES = np.array([ord(c) for c in RAMP], dtype=np.int32)

# Grid & Display
COLS, ROWS = 112, 74
CW, CH = 8, 12
FONT_PX = 12
W, H = COLS * CW, ROWS * CH
MONO = "consolas,menlo,dejavusansmono,couriernew,monospace"
HINT = "Space pause · R restart · S screenshot · Esc quit"
DIM, ACCENT, SIGN = (96, 104, 122), (255, 196, 90), (176, 168, 196)


# ── Geometry Helpers ─────────────────────────────────────────────────────────
def unit(v):
    v = np.asarray(v, dtype=np.float64)
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, 1e-8)


def envelope(y):
    u = np.clip((y - Y0) / (Y1 - Y0), 0.0, 1.0)
    return 0.96 * (1.0 - u) ** 0.92


def fib_sphere(n):
    i = np.arange(n, dtype=np.float64)
    phi = np.arccos(1.0 - 2.0 * (i + 0.5) / n)
    theta = np.pi * (1.0 + 5.0 ** 0.5) * i
    return np.stack(
        [np.sin(phi) * np.cos(theta), np.cos(phi), np.sin(phi) * np.sin(theta)],
        axis=1,
    )


def grow_time(y):
    return T_GROW[0] + (T_GROW[1] - T_GROW[0]) * np.clip(
        (y - GROUND) / (Y1 - GROUND), 0.0, 1.0
    )


class Parts:
    def __init__(self):
        self.p, self.nrm, self.col = [], [], []
        self.kind, self.t0, self.base = [], [], []
        self.centre, self.pop, self.phase = [], [], []

    def add(self, p, nrm, col, kind=NEEDLE, t0=0.0, base=1.0, centre=None, pop=False, phase=0.0):
        p = np.asarray(p, dtype=np.float64)
        n = len(p)
        nrm = unit(np.broadcast_to(np.asarray(nrm, dtype=np.float64), (n, 3)))
        col = np.broadcast_to(np.asarray(col, dtype=np.float64), (n, 3))
        kind = np.broadcast_to(np.asarray(kind, dtype=np.int32), (n,))
        t0 = np.broadcast_to(np.asarray(t0, dtype=np.float64), (n,))
        base = np.broadcast_to(np.asarray(base, dtype=np.float64), (n,))
        centre = p if centre is None else np.broadcast_to(np.asarray(centre, dtype=np.float64), (n, 3))
        pop = np.full(n, bool(pop), dtype=bool)
        phase = np.broadcast_to(np.asarray(phase, dtype=np.float64), (n,))

        self.p.append(p)
        self.nrm.append(nrm)
        self.col.append(col)
        self.kind.append(kind)
        self.t0.append(t0)
        self.base.append(base)
        self.centre.append(centre)
        self.pop.append(pop)
        self.phase.append(phase)

    def finalize(self):
        return {
            "p": np.concatenate(self.p, axis=0),
            "nrm": np.concatenate(self.nrm, axis=0),
            "col": np.concatenate(self.col, axis=0),
            "kind": np.concatenate(self.kind, axis=0),
            "t0": np.concatenate(self.t0, axis=0),
            "base": np.concatenate(self.base, axis=0),
            "centre": np.concatenate(self.centre, axis=0),
            "pop": np.concatenate(self.pop, axis=0),
            "phase": np.concatenate(self.phase, axis=0),
        }


# ── Scene Construction ───────────────────────────────────────────────────────
def build():
    rng = np.random.default_rng(7)
    q = Parts()
    tips = []

    # needles: whorls of drooping branches, denser and longer at the bottom
    for i, y in enumerate(np.linspace(Y0 + 0.02, Y1 - 0.06, 24)):
        u = (y - Y0) / (Y1 - Y0)
        R = envelope(y) + 0.05
        nb = int(6 + 12 * (1 - u))
        for b in range(nb):
            a = TAU * (b + 0.5 * rng.random()) / nb + i * 0.77
            L = R * rng.uniform(0.85, 1.08)
            n = int(25 + 270 * L)
            s = rng.random(n) ** 0.65  # 0 trunk .. 1 tip
            d = np.array([np.cos(a), 0, np.sin(a)])
            side = np.array([-np.sin(a), 0, np.cos(a)])
            spread = (0.025 + 0.09 * s) * rng.normal(0, 1, n)
            sl = s * L
            p = d * sl[:, None] + side * spread[:, None]
            p[:, 1] = y + 0.06 * sl - 0.20 * sl ** 2 + 0.012 * rng.normal(0, 1, n)
            nrm = unit(d * 0.75 + np.array([0, 0.55, 0]) + 0.3 * rng.normal(0, 1, (n, 3)))
            ao = (0.30 + 0.70 * s ** 1.3) * rng.uniform(0.75, 1.1, n)
            snow = (s > 0.5) & (rng.random(n) < 0.06 * s) & (nrm[:, 1] > 0.5)
            green = np.array([0.10, 0.48, 0.18]) + np.array([0.12, 0.38, 0.14]) * rng.random((n, 1))
            q.add(
                p,
                nrm,
                np.where(snow[:, None], WHITE, green),
                np.where(snow, SNOW, NEEDLE),
                grow_time(y) + 0.45 * s,
                base=np.where(snow, 1.0, ao),
            )
            tl = 0.93 * L
            tips.append(d * tl + [0, y + 0.06 * tl - 0.20 * tl ** 2, 0])

    # dark inner cone so nothing shows through the branches
    m = 6000
    y = Y0 + (Y1 - 0.1 - Y0) * rng.random(m)
    phi = rng.random(m) * TAU
    out = np.stack([np.cos(phi), np.full(m, 0.3), np.sin(phi)], 1)
    r = 0.6 * envelope(y)
    q.add(
        np.stack([np.cos(phi) * r, y, np.sin(phi) * r], 1),
        out,
        (0.10, 0.42, 0.16),
        NEEDLE,
        grow_time(y),
        base=0.75,
    )

    # trunk
    m = 1500
    y, phi = GROUND + rng.random(m) * (Y0 + 0.1 - GROUND), rng.random(m) * TAU
    n = np.stack([np.cos(phi), np.zeros(m), np.sin(phi)], 1)
    bark = 0.75 + 0.25 * np.sign(np.sin(phi * 30 + y * 5))
    q.add(
        n * 0.08 + np.stack([np.zeros(m), y, np.zeros(m)], 1),
        n,
        np.array([0.42, 0.26, 0.14]) * bark[:, None],
        TRUNK,
        grow_time(y),
    )

    # tinsel garland: a gold spiral drooping in swags between hanging points
    u = np.linspace(0, 1, 2600)
    turns = 3.6
    yg = Y0 + 0.15 + (Y1 - Y0 - 0.45) * u
    ag = TAU * turns * u + 0.9
    swag = -0.07 * np.abs(np.sin(ag * 2.5))
    rg = envelope(yg) + 0.07
    line = np.stack([np.cos(ag) * rg, yg + swag, np.sin(ag) * rg], 1)
    for _ in range(4):
        nrm = np.stack([np.cos(ag), np.full_like(u, 0.3), np.sin(ag)], 1) + 0.6 * rng.normal(0, 1, line.shape)
        q.add(
            line + 0.016 * rng.normal(0, 1, line.shape),
            nrm,
            GOLD,
            TINSEL,
            T_GARLAND[0] + u * (T_GARLAND[1] - T_GARLAND[0]),
            phase=rng.random(len(u)) * TAU,
        )

    # baubles: mostly red, some gold
    sphere = fib_sphere(160)
    for k in range(34):
        u = (k + rng.random()) / 34
        y = Y0 + 0.08 + u * (Y1 - Y0 - 0.38)
        a = k * 2.39996 + rng.random() * 0.4
        c = np.array([np.cos(a), 0, np.sin(a)]) * envelope(y) + [0, y - 0.03, 0]
        rad = 0.058 + 0.032 * (1 - u)
        col = RED if k % 2 == 0 else BAUBLE_GOLD  # half red, half gold
        q.add(
            c + sphere * rad,
            sphere,
            col,
            BALL,
            T_BALLS[0] + rng.random() * (T_BALLS[1] - T_BALLS[0]),
            centre=c,
            pop=True,
        )

    # fairy lights on the branch tips
    tips = np.array(tips)
    pick = rng.choice(len(tips), min(170, len(tips)), replace=False)
    bulb = fib_sphere(16)
    light_t0 = T_LIGHTS[0] + rng.random(len(pick)) * (T_LIGHTS[1] - T_LIGHTS[0])
    for c, t0 in zip(tips[pick], light_t0):
        col = WARM if rng.random() < 0.8 else (1.0, 0.95, 0.85)
        q.add(
            c + bulb * 0.03,
            bulb,
            col,
            LIGHT,
            t0,
            centre=c,
            phase=rng.random() * TAU,
        )

    # presents: boxes with a crossed ribbon and a bow
    gifts = [
        (0.3, 1.12, 0.30, 0.24, 0.28, 0.4, RED, GOLD),
        (1.5, 1.18, 0.26, 0.30, 0.26, 0.8, BLUE_BOX, GOLD),
        (2.6, 1.10, 0.34, 0.18, 0.26, 1.0, GOLD, RED),
        (3.7, 1.18, 0.24, 0.26, 0.24, 0.2, RED, WHITE),
        (4.7, 1.12, 0.30, 0.22, 0.30, 0.1, GREEN_BOX, RED),
        (5.6, 1.22, 0.22, 0.24, 0.22, 0.6, BLUE_BOX, WHITE),
    ]
    loop = fib_sphere(80)
    for g, (a, dist, w, h, d, rot, body, rib) in enumerate(gifts):
        areas = np.array([w * d, h * d, h * d, h * w, h * w])
        m = int(5000 * areas.sum())
        face = rng.choice(5, m, p=areas / areas.sum())
        fa, fb = rng.random(m) - 0.5, rng.random(m) - 0.5
        lx = np.select([face == 0, face == 1, face == 2], [fa * w, np.full(m, w / 2), np.full(m, -w / 2)], default=fa * w)
        ly = np.where(face == 0, h, (fb + 0.5) * h)
        lz = np.select([face == 0, face <= 2, face == 3], [fb * d, fa * d, np.full(m, d / 2)], default=np.full(m, -d / 2))
        n = np.array([[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1.0]])[face]

        is_rib = (np.abs(lx) < 0.025) | (np.abs(lz) < 0.025)
        col = np.where(is_rib[:, None], rib, body)

        cr, sr = np.cos(rot), np.sin(rot)
        rx = lx * cr - lz * sr
        rz = lx * sr + lz * cr
        nx = n[:, 0] * cr - n[:, 2] * sr
        nz = n[:, 0] * sr + n[:, 2] * cr

        cx, cz = np.cos(a) * dist, np.sin(a) * dist
        pts = np.stack([cx + rx, GROUND + ly, cz + rz], 1)
        nrm = np.stack([nx, n[:, 1], nz], 1)
        t0 = T_GIFTS[0] + (g / len(gifts)) * (T_GIFTS[1] - T_GIFTS[0])
        centre = np.array([cx, GROUND + h * 0.5, cz])
        q.add(pts, nrm, col, GIFT, t0, centre=centre, pop=True)

        # bow on top
        bow_c = np.array([cx, GROUND + h + 0.025, cz])
        q.add(bow_c + loop * np.array([0.055, 0.025, 0.035]), loop, rib, GIFT, t0, centre=bow_c, pop=True)

    # background twinkling stars + falling sparkling stars
    bg_stars = np.column_stack([rng.random(160), rng.random(160), rng.random(160) * TAU])
    n_fall = 120
    falling_stars = np.column_stack([
        rng.random(n_fall),                 # x0
        rng.random(n_fall),                 # y0
        rng.uniform(0.05, 0.16, n_fall),    # fall speed
        rng.uniform(0.005, 0.025, n_fall),  # gentle horizontal sway
        rng.random(n_fall) * TAU,           # sparkle phase
        rng.random(n_fall) < 0.30,          # 30% warm gold, 70% icy white
    ])
    scene = q.finalize()
    scene["bg_stars"] = bg_stars
    scene["falling_stars"] = falling_stars
    scene["num_lights"] = len(pick)
    return scene


# ── Projection & Rendering ───────────────────────────────────────────────────
def project(pts, cols, rows, aspect=0.5):
    cam_z = 3.9
    cam_y = 0.15
    fov = 1.65
    z = cam_z - pts[:, 2]
    inv_z = fov / np.maximum(z, 0.2)
    sx = cols * 0.5 + pts[:, 0] * inv_z * rows * (1.0 / aspect) * 0.48
    sy = rows * 0.54 - (pts[:, 1] - cam_y) * inv_z * rows * 0.48
    return sx, sy, z


def put(char, col, r, c, ch, tint, br=1.0):
    if 0 <= r < char.shape[0] and 0 <= c < char.shape[1]:
        char[r, c] = ord(ch)
        col[r, c] = np.clip(np.asarray(tint) * br * 255.0, 0, 255).astype(np.uint8)


def star(char, col, cx, cy, size, flash=0.0):
    rad = int(math.ceil(size * 2.2))
    for dy in range(-rad, rad + 1):
        for dx in range(-rad * 2, rad * 2 + 1):
            r, c = cy + dy, cx + dx
            if not (0 <= r < char.shape[0] and 0 <= c < char.shape[1]):
                continue
            dist = math.hypot(dx * 0.5, dy)
            ray = min(abs(dx * 0.5), abs(dy)) < 0.7 and dist < size * 1.9
            diag = abs(abs(dx * 0.5) - abs(dy)) < 0.65 and dist < size * 1.15
            core = dist < size * 0.65
            if core or ray or diag:
                br = max(0.0, 1.0 - dist / (size * 2.1)) + flash * 0.8
                ch = "@" if core else ("*" if br > 0.55 else "+")
                tint = WHITE if (core or flash > 0.35) else GOLD
                put(char, col, r, c, ch, tint, min(1.3, 0.55 + br))


def render_frame(scene, t, cols=COLS, rows=ROWS):
    char = np.zeros((rows, cols), dtype=np.int32)
    col = np.zeros((rows, cols, 3), dtype=np.uint8)
    zbuf = np.full((rows, cols), np.inf, dtype=np.float64)

    # Static twinkling background stars
    for sx, sy, ph in scene["bg_stars"]:
        r = int(sy * (rows - 6))
        c = int(sx * cols)
        tw = 0.5 + 0.5 * math.sin(t * 2.2 + ph)
        if tw > 0.30:
            put(char, col, r, c, "+" if tw > 0.82 else ".", (0.65, 0.72, 0.90), 0.35 + 0.65 * tw)

    # Falling, sprinkling, sparkling stars
    for x0, y0, spd, amp, ph, is_gold in scene["falling_stars"]:
        fy = (y0 + t * spd) % 1.0
        fx = (x0 + amp * math.sin(t * 1.8 + ph)) % 1.0
        r = int(fy * (rows - 4))
        c = int(fx * cols)
        sp = 0.5 + 0.5 * math.sin(t * 7.0 + ph)
        ch = "*" if sp > 0.82 else ("+" if sp > 0.50 else ".")
        tint = (1.0, 0.90, 0.55) if is_gold else (0.85, 0.92, 1.0)
        put(char, col, r, c, ch, tint, 0.55 + 0.65 * sp)

    # Rotation
    ang = t * 0.42
    ca, sa = math.cos(ang), math.sin(ang)

    vis = t >= scene["t0"]
    p = scene["p"][vis].copy()
    nrm = scene["nrm"][vis]
    c_rgb = scene["col"][vis]
    kind = scene["kind"][vis]
    t0 = scene["t0"][vis]
    base = scene["base"][vis]
    centre = scene["centre"][vis]
    pop = scene["pop"][vis]
    phase = scene["phase"][vis]

    # Pop-in animation for baubles and gifts
    if np.any(pop):
        age = np.clip((t - t0[pop]) / 0.35, 0.0, 1.0)
        scale = 1.0 - (1.0 - age) ** 3
        p[pop] = centre[pop] + (p[pop] - centre[pop]) * scale[:, None]

    # Rotate around Y axis
    px = p[:, 0] * ca + p[:, 2] * sa
    pz = -p[:, 0] * sa + p[:, 2] * ca
    pr = np.stack([px, p[:, 1], pz], axis=1)

    nx = nrm[:, 0] * ca + nrm[:, 2] * sa
    nz = -nrm[:, 0] * sa + nrm[:, 2] * ca
    nr = np.stack([nx, nrm[:, 1], nz], axis=1)

    sx, sy, depth = project(pr, cols, rows, aspect=CW / CH)
    ix = sx.astype(np.int32)
    iy = sy.astype(np.int32)
    in_bounds = (ix >= 0) & (ix < cols) & (iy >= 0) & (iy < rows)

    ix, iy, depth = ix[in_bounds], iy[in_bounds], depth[in_bounds]
    nr, c_rgb, kind = nr[in_bounds], c_rgb[in_bounds], kind[in_bounds]
    base, phase = base[in_bounds], phase[in_bounds]

    # Brighter lighting
    light_dir = unit(np.array([0.45, 0.65, 0.60]))
    diff = np.clip(nr @ light_dir, 0.0, 1.0)
    lum = (0.48 + 0.78 * diff) * np.maximum(base, 0.55)

    # Twinkle for fairy lights and tinsel
    is_light = kind == LIGHT
    is_tinsel = kind == TINSEL
    if np.any(is_light):
        tw = 0.85 + 0.65 * np.sin(t * 5.5 + phase[is_light])
        lum[is_light] = np.clip(tw, 0.65, 1.60)
    if np.any(is_tinsel):
        lum[is_tinsel] = np.clip(lum[is_tinsel] + 0.45 * np.sin(t * 4.0 + phase[is_tinsel]), 0.55, 1.55)

    # Painter's algorithm (back-to-front)
    order = np.argsort(depth)[::-1]
    ix, iy, depth = ix[order], iy[order], depth[order]
    lum, c_rgb = lum[order], c_rgb[order]

    ramp_idx = np.clip((lum * (len(RAMP) - 1)).astype(np.int32), 1, len(RAMP) - 1)
    char[iy, ix] = RAMP_CODES[ramp_idx]
    col[iy, ix] = np.clip(c_rgb * np.clip(lum, 0.42, 1.55)[:, None] * 255.0, 0, 255).astype(np.uint8)
    zbuf[iy, ix] = depth

    # Top star
    if t > T_STAR:
        on = float(np.clip((t - T_STAR) / 0.6, 0.0, 1.0))
        flash = float(np.clip(1 - (t - T_STAR) / 1.0, 0, 1) ** 2)
        tx, ty, _ = project(np.array([[0, Y1 + 0.09, 0]]), cols, rows, CW / CH)
        star(char, col, int(tx[0]), int(ty[0]), (2.0 + 2.2 * on) * (1 + 0.05 * np.sin(t * 6.0)), flash=flash)

    # Bottom message
    if t > T_MSG:
        row, x0 = rows - 9, (cols - len(MESSAGE)) // 2
        shown = min(len(MESSAGE), int((t - T_MSG) * 10))
        char[row - 1 : row + 2, max(x0 - 3, 0) : x0 + shown + 3] = 0
        for i, ch in enumerate(MESSAGE[:shown]):
            if ch != " ":
                tint = (RED, GOLD, GREEN_BOX)[(i // 2 + int(t * 1.5)) % 3]
                put(char, col, row, x0 + i, ch, tint, 0.95 + 0.25 * np.sin(t * 5 + i))

    info = {
        "rotation": (math.degrees(ang) % 360.0),
        "lights": scene["num_lights"],
        "letters": int((char > 0).sum()),
    }
    return char, col, info


# ── Pygame Renderer ──────────────────────────────────────────────────────────
class Renderer:
    def __init__(self, cols=COLS, rows=ROWS, cw=CW, ch=CH, font_px=FONT_PX, hud_px=13):
        self.cols, self.rows, self.cw, self.ch = cols, rows, cw, ch
        self.w, self.h = cols * cw, rows * ch
        font = pygame.font.SysFont(MONO, font_px)
        self.hud_font = pygame.font.SysFont(MONO, hud_px)
        atlas = []
        for code in range(32, 127):
            s = pygame.Surface((cw, ch))
            g = font.render(chr(code), True, (255, 255, 255))
            s.blit(g, ((cw - g.get_width()) // 2, (ch - g.get_height()) // 2))
            atlas.append(pygame.surfarray.array3d(s).transpose(1, 0, 2))
        self.atlas = np.stack(atlas)  # glyph, CH, CW, 3

    def draw(self, screen, char, col, info, paused=False):
        idx = np.clip(char - 32, 0, len(self.atlas) - 1)
        mask = (char >= 32)[:, :, None, None, None]
        # (ROWS, COLS, CH, CW, 3)
        glyphs = self.atlas[idx].astype(np.uint16)
        tinted = (glyphs * col[:, :, None, None, :].astype(np.uint16)) >> 8
        tinted = np.where(mask, tinted, 0).astype(np.uint8)
        frame = tinted.transpose(0, 2, 1, 3, 4).reshape(self.h, self.w, 3)

        # Pygame surfarray expects (W, H, 3)
        pygame.surfarray.blit_array(screen, frame.transpose(1, 0, 2))

        # HUD overlay
        y_hud = self.h - 68
        s1 = self.hud_font.render("@ducminh.ascii", True, SIGN)
        s2 = self.hud_font.render(f"rotation {info['rotation']:6.2f}°     lights {info['lights']}", True, DIM)
        s3 = self.hud_font.render(f"letters {info['letters']:,}", True, DIM)
        s4 = self.hud_font.render(HINT + ("  [PAUSED]" if paused else ""), True, ACCENT if paused else DIM)

        screen.blit(s1, (14, y_hud))
        screen.blit(s2, (14, y_hud + 18))
        screen.blit(s3, (14, y_hud + 36))
        screen.blit(s4, (self.w - s4.get_width() - 14, y_hud + 36))


# ── Main Loop ────────────────────────────────────────────────────────────────
def main():
    pygame.init()
    screen = pygame.display.set_mode((W, H))
    pygame.display.set_caption("christmas_tree.py")
    clock = pygame.time.Clock()

    scene = build()
    renderer = Renderer()

    t = 0.0
    paused = False
    running = True

    while running:
        dt = clock.tick(30) / 1000.0
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                running = False
            elif event.type == pygame.KEYDOWN:
                if event.key == pygame.K_ESCAPE:
                    running = False
                elif event.key == pygame.K_SPACE:
                    paused = not paused
                elif event.key == pygame.K_r:
                    t = 0.0
                elif event.key == pygame.K_s:
                    fname = f"christmas_tree_{int(time.time())}.png"
                    pygame.image.save(screen, fname)
                    print(f"Saved {fname}")

        if not paused:
            t += dt

        char, col, info = render_frame(scene, t)
        renderer.draw(screen, char, col, info, paused)
        pygame.display.flip()

    pygame.quit()


if __name__ == "__main__":
    main()