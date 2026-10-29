"""procedural, TILEABLE texture generators (numpy only). Every array is in v-up order (row 0 = v 0 = the bottom of the picture, as Blender stores pixels). Each generator returns a dict with
albedo (H, W, 3) 0..1 sRGB, height (H, W) 0..1, roughness (H, W) 0..1 and optionally alpha (H, W)."""
import math

import numpy as np


def _rng(seed):
    return np.random.default_rng(int(seed))


def noise(size, sigma, rng, aniso=(1.0, 1.0)):
    """periodic smooth noise in 0..1 (random field low-passed in Fourier space: it tiles by construction); sigma in pixels, aniso (sx, sy) stretches the grain"""
    n = size if isinstance(size, tuple) else (size, size)
    w = rng.standard_normal((n[0], n[1]))
    fy = np.fft.fftfreq(n[0])[:, None]
    fx = np.fft.fftfreq(n[1])[None, :]
    k2 = (fx * sigma * aniso[0]) ** 2 + (fy * sigma * aniso[1]) ** 2
    f = np.fft.fft2(w) * np.exp(-2 * (math.pi ** 2) * k2)
    a = np.real(np.fft.ifft2(f))
    a = (a - a.min()) / max(a.max() - a.min(), 1e-9)
    return a


def fbm(size, rng, octaves=4, base_sigma=None, aniso=(1.0, 1.0)):
    s = size if isinstance(size, int) else size[0]
    base_sigma = base_sigma or s / 8
    out, amp, tot = 0.0, 1.0, 0.0
    for o in range(octaves):
        out = out + amp * noise(size, max(base_sigma / (2 ** o), 0.7), rng, aniso)
        tot += amp
        amp *= 0.5
    out = out / tot
    return (out - out.min()) / max(out.max() - out.min(), 1e-9)


def normal_from_height(h, strength=2.0):
    """tangent-space normal map (OpenGL: +Y = +V up), from a periodic height field, encoded 0..1"""
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    nx, ny, nz = -dx * strength * h.shape[1] / 64.0, -dy * strength * h.shape[0] / 64.0, np.ones_like(h)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx / ln * 0.5 + 0.5, ny / ln * 0.5 + 0.5, nz / ln * 0.5 + 0.5], axis=-1)


def _smoothstep(a, b, x):
    t = np.clip((x - a) / max(b - a, 1e-9), 0, 1)
    return t * t * (3 - 2 * t)


def weave(size, seed=1, threads=12, colour=(0.12, 0.12, 0.13), colour2=None, rough=0.85, tint_var=0.3):
    rng = _rng(seed)
    c = size / threads
    y, x = np.mgrid[0:size, 0:size].astype(np.float64)
    u, v = (x % c) / c, (y % c) / c
    i, j = (x // c).astype(int), (y // c).astype(int)
    over = ((i + j) % 2) == 0  # a horizontal thread lies over here, a vertical one there
    prof_h = np.sin(math.pi * v) ** 0.6 * (0.85 + 0.15 * np.sin(math.pi * u))
    prof_v = np.sin(math.pi * u) ** 0.6 * (0.85 + 0.15 * np.sin(math.pi * v))
    h = np.where(over, prof_h, prof_v)
    h = np.where(over, np.maximum(h, 0.55 * prof_v), np.maximum(h, 0.55 * prof_h))
    fib = noise(size, 1.2, rng, aniso=(0.15, 1.0)) * np.where(over, 1.0, 0.0) + noise(size, 1.2, rng, aniso=(1.0, 0.15)) * np.where(over, 0.0, 1.0)
    h = np.clip(h * 0.9 + fib * 0.1, 0, 1)
    tint = 1 - tint_var / 2 + tint_var * noise(size, c * 1.5, rng)
    base = np.array(colour)[None, None, :] * np.ones((size, size, 1))
    if colour2 is not None:  # two thread colours: the horizontal threads in `colour`, the vertical ones in `colour2` (a woven checker)
        base = np.where(over[..., None], np.array(colour)[None, None, :], np.array(colour2)[None, None, :])
    alb = base * (0.55 + 0.45 * h[..., None]) * tint[..., None]  # a little crevice darkening between the threads (painted into the colour, not a lighting bake)
    return {"albedo": np.clip(alb, 0, 1), "height": h, "roughness": np.full((size, size), rough) + 0.05 * fib, "normal_strength": 1.6}


def diamond(size, seed=1, colour=(0.86, 0.82, 0.72), colour2=(0.46, 0.47, 0.48), rings=4, line=0.30, zigzag=0.20, zz_freq=8, threads=80, rough=0.9):
    """a woven fabric with a motif of NESTED zigzag diamond outlines (grey on cream by default), one diamond per picture repeat, tileable: `colour` = the ground thread, `colour2` = the motif thread, `rings` = nested outlines per diamond, `line` = outline width as a fraction of the ring spacing, `zigzag` = saw-tooth depth as a fraction of the spacing (0 = straight lines), `zz_freq` = teeth per diamond edge (integer), `threads` = threads across one repeat (fine weave)"""
    base = weave(size, seed, threads, colour, tint_var=0.10)
    ink = weave(size, seed + 1, threads, colour2, tint_var=0.10)
    y, x = np.mgrid[0:size, 0:size].astype(np.float64)
    ax, ay = np.abs(x / size - 0.5), np.abs(y / size - 0.5)
    step = 0.5 / rings
    zf = int(zz_freq)
    def tri(t):
        return np.abs(((t * zf) % 1.0) * 2 - 1)
    d1 = ax + ay
    d = np.where(d1 <= 0.5, d1 + zigzag * step * tri(ax - ay), (1 - d1) + zigzag * step * tri(ax - ay))   # folded: diamonds around the repeat's centre and around its corners, no seam at the edge
    rv = d / step
    near = np.abs(rv - np.round(rv))
    m = 1 - _smoothstep(line / 2, line / 2 + 0.10, near)
    m = np.where(np.round(rv) >= 1, m, 0.0)[..., None]
    alb = ink["albedo"] * m + base["albedo"] * (1 - m)
    h = np.clip(base["height"] * (1 - m[..., 0]) + ink["height"] * m[..., 0], 0, 1)
    return {"albedo": np.clip(alb, 0, 1), "height": h, "roughness": base["roughness"], "normal_strength": 1.2}


def tiles(size, seed=1, nx=4, ny=4, gap=0.04, colour=(0.30, 0.32, 0.34), grout=(0.10, 0.10, 0.10), variation=0.35, rough=0.55, palette=None):
    rng = _rng(seed)
    cw, ch = size / nx, size / ny
    y, x = np.mgrid[0:size, 0:size].astype(np.float64)
    ti, tj = (x // cw).astype(int), (y // ch).astype(int)
    u, v = (x % cw) / cw, (y % ch) / ch
    g = gap / 2
    inside = _smoothstep(g, g + 0.02, u) * _smoothstep(g, g + 0.02, 1 - u) * _smoothstep(g, g + 0.02, v) * _smoothstep(g, g + 0.02, 1 - v) if gap > 0 else np.ones((size, size))  # gap 0: no grout and no tile-edge shading at all
    rv = rng.random((ny, nx))
    hv = rng.random((ny, nx))
    per = rv[tj, ti]
    cleft = fbm(size, rng, octaves=5, base_sigma=size / 14)
    fine = noise(size, 1.5, rng)
    h = inside * (0.75 + 0.25 * cleft) - 0.05 * fine * inside
    col = np.array(colour)
    tone = (1 - variation / 2 + variation * per)[..., None] * (0.85 + 0.3 * cleft[..., None])
    warm = np.array([1.0, 0.97, 0.93]) * (hv[tj, ti] > 0.5)[..., None] + np.array([0.94, 0.98, 1.0]) * (hv[tj, ti] <= 0.5)[..., None]
    base_col = col[None, None, :] * np.ones((size, size, 1))
    if palette:  # a slate that is brown here, grey there, green-grey elsewhere: each tile picks a palette colour and mottles towards a second one
        pal = np.array(palette, float)
        k1 = rng.integers(0, len(pal), (ny, nx))
        k2 = rng.integers(0, len(pal), (ny, nx))
        mix = np.clip(cleft * 1.4 - 0.2, 0, 1)[..., None]
        base_col = pal[k1[tj, ti]] * (1 - mix) + pal[k2[tj, ti]] * mix
    alb = base_col * tone * warm * (0.9 + 0.2 * fine[..., None])
    alb = alb * inside[..., None] + np.array(grout)[None, None, :] * (1 - inside[..., None])
    rough_map = rough * inside + 0.95 * (1 - inside) + 0.08 * fine
    return {"albedo": np.clip(alb, 0, 1), "height": np.clip(h, 0, 1), "roughness": np.clip(rough_map, 0, 1), "normal_strength": 3.0}


def slate(size, seed=1, palette=((0.47, 0.43, 0.36), (0.40, 0.43, 0.40), (0.37, 0.34, 0.29)), scale=0.18, grain=0.12, strata=0.05, rough=0.6, colour=None):
    """a CONTINUOUS slate surface (no grout, no tile borders: the geometry supplies those): large cloudy variation between the palette colours (`scale` = patch size as a fraction of the picture), a fine mineral grain, faint stratification streaks"""
    rng = _rng(seed)
    pal = np.array(palette, float)
    if colour is not None:  # a single colour: scale the palette to that average, keeping its brown/grey/green spread
        pal = np.clip(pal * (np.array(colour, float) / pal.mean(0)), 0, 1)
    n = len(pal)
    a = fbm(size, rng, octaves=4, base_sigma=size * scale)
    b = fbm(size, rng, octaves=3, base_sigma=size * scale * 0.6)
    f = np.clip(a * (n - 1), 0, n - 1 - 1e-6)
    i0 = f.astype(int)
    t = (f - i0)[..., None]
    base = pal[i0] * (1 - t) + pal[np.minimum(i0 + 1, n - 1)] * t
    base = base * (0.9 + 0.2 * b[..., None])
    fine = noise(size, 1.2, rng)
    streak = noise(size, size * 0.12, rng, aniso=(0.05, 1.0))
    alb = base * (1 - grain / 2 + grain * fine[..., None]) * (1 - strata / 2 + strata * streak[..., None])
    h = 0.5 * fine + 0.3 * fbm(size, rng, octaves=3, base_sigma=size / 40) + 0.2 * streak
    return {"albedo": np.clip(alb, 0, 1), "height": np.clip(h, 0, 1), "roughness": np.clip(rough + 0.1 * (fine - 0.5), 0, 1), "normal_strength": 1.2}


def deck(size, seed=1, boards=6, colour=(0.40, 0.41, 0.41), gap=0.012, variation=0.12, rough=0.7, grain_dir="u"):
    rng = _rng(seed)
    y, x = np.mgrid[0:size, 0:size].astype(np.float64)
    bj = (y // (size / boards)).astype(int)
    v = (y % (size / boards)) / (size / boards)
    per = rng.random(boards)[bj]
    groove = _smoothstep(gap / 2, gap / 2 + 0.01, v) * _smoothstep(gap / 2, gap / 2 + 0.01, 1 - v) if gap > 0 else np.ones((size, size))  # gap 0: no joint shading at all
    grain = fbm(size, rng, octaves=4, base_sigma=size / 6, aniso=(0.06, 1.0))
    fine = noise(size, 1.2, rng, aniso=(0.08, 1.0))
    if grain_dir == "u":  # the generators' streaks run along image rows' normal (vertical); boards run along U, so turn them
        grain, fine = grain.T.copy(), fine.T.copy()
    h = groove * (0.7 + 0.18 * grain + 0.12 * fine)
    col = np.array(colour)
    alb = col[None, None, :] * (1 - variation / 2 + variation * per)[..., None] * (0.92 + 0.16 * grain[..., None]) * (0.96 + 0.08 * fine[..., None])
    alb = alb * (0.35 + 0.65 * groove[..., None])
    return {"albedo": np.clip(alb, 0, 1), "height": np.clip(h, 0, 1), "roughness": np.clip(rough * groove + 0.95 * (1 - groove) + 0.05 * fine, 0, 1), "normal_strength": 2.0}


def fabric(size, seed=1, threads=40, colour=(0.62, 0.58, 0.50), colour2=None, rough=0.92):
    t = weave(size, seed, threads, colour, colour2, tint_var=0.04)
    rng = _rng(seed + 7)
    soft = 0.985 + 0.03 * noise(size, size / 10, rng)
    t["albedo"] = np.clip(t["albedo"] * soft[..., None] / np.maximum(t["albedo"].mean(), 1e-6) * (np.mean(colour) if colour2 is None else (np.mean(colour) + np.mean(colour2)) / 2), 0, 1)
    t["roughness"] = np.full((size, size), rough)
    t["normal_strength"] = 0.8
    return t


def _stamp(S, cx, cy, ang, la, lb, wrap):
    """yield (slice, mask-ready coordinates) of an ellipse centred (cx, cy), semi-axes la (along ang) and lb"""
    R = int(max(la, lb)) + 2
    offs = (-S, 0, S) if wrap else (0,)
    for ox in offs:
        for oy in offs:
            x0, x1, y0, y1 = int(cx + ox - R), int(cx + ox + R), int(cy + oy - R), int(cy + oy + R)
            if x1 < 0 or y1 < 0 or x0 >= S or y0 >= S:
                continue
            xa, xb, ya, yb = max(x0, 0), min(x1, S), max(y0, 0), min(y1, S)
            yy, xx = np.mgrid[ya:yb, xa:xb].astype(np.float64)
            dx, dy = xx - (cx + ox), yy - (cy + oy)
            c, s_ = math.cos(ang), math.sin(ang)
            yield (slice(ya, yb), slice(xa, xb)), dx * c + dy * s_, -dx * s_ + dy * c


def conifer(size, seed=1, leaves=8, colour=(0.12, 0.30, 0.10), colour2=(0.30, 0.46, 0.16), length=(0.40, 0.46), gloss=0.7, cells=2):
    """an RGBA atlas of flat conifer (thuja / cypress) frond sprays: a stem with short side branchlets of overlapping scale tufts, darker inside, lighter at the tips; each spray lies wholly inside its cell (`cells` x `cells` sheet), the rest transparent"""
    if not isinstance(length, (list, tuple)):
        length = (float(length) * 0.85, float(length) * 1.15)
    rng = _rng(seed)
    S = size
    cs = S / cells
    alb, alpha, height, rough = np.zeros((S, S, 3)), np.zeros((S, S)), np.zeros((S, S)), np.full((S, S), 0.9)
    c1, c2 = np.array(colour), np.array(colour2 if colour2 is not None else colour)
    for k in range(int(leaves)):
        cell = k % (cells * cells)
        ox, oy = (cell % cells) * cs, (cell // cells) * cs
        L = rng.uniform(*length) * S
        L = min(L, cs * 0.9)
        ang = math.pi / 2 + rng.uniform(-0.35, 0.35)  # stem direction: mostly up the card
        cx, cy = ox + cs / 2 + rng.uniform(-0.04, 0.04) * cs, oy + cs / 2 + rng.uniform(-0.04, 0.04) * cs
        d = np.array([math.cos(ang), math.sin(ang)])
        n = np.array([-d[1], d[0]])
        base = np.array([cx, cy]) - d * L / 2
        tone = rng.uniform(0.85, 1.15)
        nb = 24
        for i in range(nb):
            t = i / (nb - 1)
            p = base + d * (t * L)
            bl = L * 0.24 * (1 - t) ** 0.7 + L * 0.025   # branchlet half-length: tapering to the tip
            for side in (-1, 1):
                for j in range(6):
                    u = (j + 0.5) / 6
                    q = p + n * side * bl * u + d * (bl * u * 0.45)   # branchlets sweep forward
                    r = L * (0.020 + 0.008 * (1 - t)) * (1 - 0.35 * u)
                    a_ = ang + side * 0.9 * (1 - 0.3 * u)
                    col = (c1 * (1 - (0.35 + 0.65 * u * (0.5 + 0.5 * t))) + c2 * (0.35 + 0.65 * u * (0.5 + 0.5 * t))) * tone * rng.uniform(0.8, 1.2)
                    for sl, a_loc, b_loc in _stamp(S, q[0], q[1], a_, r * 1.7, r, False):
                        m = (a_loc / (r * 1.7)) ** 2 + (b_loc / r) ** 2 < 1
                        m &= (np.mgrid[sl[0], sl[1]][1] >= ox) & (np.mgrid[sl[0], sl[1]][1] < ox + cs) & (np.mgrid[sl[0], sl[1]][0] >= oy) & (np.mgrid[sl[0], sl[1]][0] < oy + cs)
                        alb[sl][m] = col
                        alpha[sl][m] = 1.0
                        height[sl][m] = 0.4 + 0.5 * u
                        rough[sl][m] = gloss
        for sl, a_loc, b_loc in _stamp(S, cx, cy, ang, L / 2, L * 0.006, False):   # the stem
            m = (np.abs(a_loc) < L / 2) & (np.abs(b_loc) < L * 0.006)
            alb[sl][m] = c1 * 0.9
            alpha[sl][m] = 1.0
    alpha = np.clip(alpha, 0, 1)
    alb = np.where(alpha[..., None] > 0, alb, (c1 * 0.5)[None, None, :])
    return {"albedo": np.clip(alb, 0, 1), "height": np.clip(height, 0, 1), "roughness": np.clip(rough, 0, 1), "alpha": alpha, "normal_strength": 0.8}


def conifer_clump(size, seed=1, leaves=7, colour=(0.16, 0.32, 0.12), colour2=(0.40, 0.52, 0.22), colour3=(0.50, 0.30, 0.13), length=(0.06, 0.10), gloss=0.75, cells=2, rust=0.14):
    """an RGBA atlas of dense conifer foliage as it reads at mid distance: `leaves` clumps per cell, each a ragged cloud of hundreds of tiny scale tufts, mottled dark-to-light green (`colour`, `colour2`), a fraction `rust` of the outer tufts rusty-brown (`colour3`); `length` = clump radius as a fraction of the picture; every clump lies wholly inside its cell, the rest transparent"""
    if not isinstance(length, (list, tuple)):
        length = (float(length) * 0.8, float(length) * 1.2)
    rng = _rng(seed)
    S = size
    cs = S / cells
    alb, alpha, height, rough = np.zeros((S, S, 3)), np.zeros((S, S)), np.zeros((S, S)), np.full((S, S), 0.9)
    c1, c2, c3 = np.array(colour), np.array(colour2), np.array(colour3)
    mott = fbm(S, rng, octaves=4, base_sigma=S / 14)
    for cell in range(cells * cells):
        ox, oy = (cell % cells) * cs, (cell // cells) * cs
        for _ in range(int(leaves)):
            R = rng.uniform(*length) * S
            R = min(R, cs * 0.45)
            cx = ox + R * 1.25 + rng.random() * max(cs - 2.5 * R, 0)
            cy = oy + R * 1.25 + rng.random() * max(cs - 2.5 * R, 0)
            n = int(R * R / (S * S) * 9000) + 40
            pts = []
            for _k in range(n):
                rr = R * math.sqrt(rng.random()) * (0.7 + 0.3 * rng.random())
                th = rng.random() * 6.283
                pts.append((rr / R, cx + rr * math.cos(th), cy + rr * 0.85 * math.sin(th), th))
            pts.sort(key=lambda p: p[0])   # inner tufts first, outer ones on top
            for rn, x, y, th in pts:
                r = S * rng.uniform(0.0045, 0.0085)
                m = float(mott[min(int(y), S - 1), min(int(x), S - 1)])
                col = c1 * (1 - m) + c2 * m
                col = col * (1.0 - 0.3 * (1 - rn) ** 2) * rng.uniform(0.85, 1.15)   # darker towards the clump centre
                if rn > 0.55 and rng.random() < rust * (rn - 0.4) * 2:
                    col = c3 * rng.uniform(0.8, 1.15)
                for sl, a_loc, b_loc in _stamp(S, x, y, math.pi / 2 + rng.uniform(-0.8, 0.8), r * 2.2, r, False):
                    mk = (a_loc / (r * 2.2)) ** 2 + (b_loc / r) ** 2 < 1
                    alb[sl][mk] = col
                    alpha[sl][mk] = 1.0
                    height[sl][mk] = 0.3 + 0.7 * rn
                    rough[sl][mk] = gloss
    alb = np.where(alpha[..., None] > 0, alb, (c1 * 0.5)[None, None, :])
    return {"albedo": np.clip(alb, 0, 1), "height": np.clip(height, 0, 1), "roughness": np.clip(rough, 0, 1), "alpha": np.clip(alpha, 0, 1), "normal_strength": 0.6}


def leaf(size, seed=1, leaves=90, colour=(0.22, 0.50, 0.16), length=(0.09, 0.16), gloss=0.32, density=1.0, cells=1, kind="broad", colour2=None):
    """an RGBA atlas of small glossy broad oval leaves with an irregular edge, soft veins and a midrib; alpha = the leaves (the rest transparent); `cells` 1 (default): tiles at the picture edge; `cells` 2 or more: a cells x cells sheet in which every leaf lies WHOLLY inside its cell (no leaf is cut by a card's crop edge); `kind` "conifer": frond sprays instead (see conifer)"""
    if kind == "conifer_clump":
        return conifer_clump(size, seed, leaves if leaves != 90 else 7, colour if tuple(colour) != (0.22, 0.50, 0.16) else (0.16, 0.32, 0.12), colour2 if colour2 is not None else (0.40, 0.52, 0.22), (0.50, 0.30, 0.13), length if length != (0.09, 0.16) else (0.06, 0.10), gloss if gloss != 0.32 else 0.75, max(cells, 2))
    if kind == "conifer":
        return conifer(size, seed, leaves if leaves != 90 else 8, colour if tuple(colour) != (0.22, 0.50, 0.16) else (0.12, 0.30, 0.10), colour2, length if length != (0.09, 0.16) else (0.40, 0.46), gloss if gloss != 0.32 else 0.7, max(cells, 2))
    if not isinstance(length, (list, tuple)):  # a single number = the typical leaf length as a fraction of the picture (+-20 %)
        length = (float(length) * 0.8, float(length) * 1.2)
    length = (float(length[0]), float(length[1]))
    rng = _rng(seed)
    S = size
    alb = np.zeros((S, S, 3))
    alpha = np.zeros((S, S))
    height = np.zeros((S, S))
    rough = np.full((S, S), 0.9)
    order = rng.permutation(int(leaves * density))
    contain = cells > 1
    cs = S / cells
    for _i, _ in enumerate(order):
        L = rng.uniform(*length) * S
        if contain:
            ce = _i % (cells * cells)
            Rm = L * 0.75 * 1.0
            Rm = min(Rm, cs / 2 - 1)
            cx = (ce % cells) * cs + Rm + rng.random() * max(cs - 2 * Rm, 0)
            cy = (ce // cells) * cs + Rm + rng.random() * max(cs - 2 * Rm, 0)
            L = min(L, Rm / 0.75 * 1.0)
        else:
            cx, cy = rng.random() * S, rng.random() * S
        Wd = L * rng.uniform(0.52, 0.72)
        ang = rng.random() * math.pi * 2
        tone = rng.uniform(0.75, 1.25)
        hue = rng.uniform(-0.05, 0.05)
        ph = rng.random(6) * 6.28
        R = int(L * 0.75) + 2
        for ox in ((0,) if contain else (-S, 0, S)):
            for oy in ((0,) if contain else (-S, 0, S)):
                x0, x1 = int(cx + ox - R), int(cx + ox + R)
                y0, y1 = int(cy + oy - R), int(cy + oy + R)
                if x1 < 0 or y1 < 0 or x0 >= S or y0 >= S:
                    continue
                xa, xb, ya, yb = max(x0, 0), min(x1, S), max(y0, 0), min(y1, S)
                yy, xx = np.mgrid[ya:yb, xa:xb].astype(np.float64)
                dx, dy = xx - (cx + ox), yy - (cy + oy)
                c, s_ = math.cos(ang), math.sin(ang)
                a_ = dx * c + dy * s_          # along the leaf
                b_ = -dx * s_ + dy * c         # across
                th = np.arctan2(b_ / Wd * L, a_)
                edge = 1 + 0.07 * np.sin(5 * th + ph[0]) + 0.05 * np.sin(9 * th + ph[1]) + 0.03 * np.sin(17 * th + ph[2])  # irregular outline
                r = np.sqrt((a_ / (L / 2)) ** 2 + (b_ / (Wd / 2)) ** 2)
                tip = 1 + 0.35 * np.clip(a_ / (L / 2), 0, 1) ** 2   # oval, pointed at the tip (a_ > 0), rounder at the base
                inside = r * tip < edge
                if not inside.any():
                    continue
                rim = np.clip((edge - r * tip) * 6, 0, 1)
                mid = np.exp(-(b_ / (Wd * 0.04 + 0.8)) ** 2) * (a_ > -L / 2)  # the midrib
                veins = np.abs(np.sin((a_ / L * 6 + np.abs(b_) / Wd * 3.0) * math.pi)) ** 4  # softer, fewer veins: thin hard lines alias into a grey moire at small atlas sizes
                shade = tone * (0.7 + 0.3 * rim) * (1.0 + 0.2 * mid - 0.025 * veins * (np.abs(b_) < Wd / 2))
                col = np.array(colour) * shade[..., None] + np.array([hue, hue * 0.5, 0])
                col[..., 1] += 0.04 * mid
                sl = (slice(ya, yb), slice(xa, xb))
                alb[sl][inside] = col[inside]
                alpha[sl][inside] = 1.0
                height[sl][inside] = (0.5 + 0.35 * rim + 0.12 * mid - 0.02 * veins)[inside]
                rough[sl][inside] = gloss + 0.1 * (1 - rim[inside])
    # soften the alpha edge a touch
    a2 = (alpha + np.roll(alpha, 1, 0) + np.roll(alpha, -1, 0) + np.roll(alpha, 1, 1) + np.roll(alpha, -1, 1)) / 5
    alpha = np.where(alpha > 0.5, np.maximum(a2, 0.6), a2 * 0.0 + 0.0)
    alpha = np.clip(alpha, 0, 1)
    # under-leaf colour in the gaps so the alpha cut has no dark halo
    bg = np.array(colour) * 0.55
    alb = np.where(alpha[..., None] > 0, alb, bg[None, None, :])
    return {"albedo": np.clip(alb, 0, 1), "height": np.clip(height, 0, 1), "roughness": np.clip(rough, 0, 1), "alpha": alpha, "normal_strength": 0.9}


def grille(size, seed=1, nx=24, ny=24, hole=0.28, colour=(0.80, 0.79, 0.74), dark=(0.05, 0.05, 0.05), staggered=True, rough=0.5):
    """a fine perforated speaker grille: round holes on a regular (staggered) grid in a plate; holes are dark and sunk"""
    rng = _rng(seed)
    y, x = np.mgrid[0:size, 0:size].astype(np.float64)
    cw, ch = size / nx, size / ny
    j = (y // ch).astype(int)
    xs = x + np.where(staggered & (j % 2 == 1), cw / 2, 0.0)
    u, v = (xs % cw) / cw - 0.5, (y % ch) / ch - 0.5
    d = np.sqrt(u * u + v * v)
    inside = _smoothstep(hole - 0.03, hole + 0.03, d)  # 0 in a hole, 1 on the plate
    fine = noise(size, 1.2, rng)
    h = inside * (0.85 + 0.1 * fine)
    alb = np.array(colour)[None, None, :] * (0.92 + 0.12 * fine[..., None]) * inside[..., None] + np.array(dark)[None, None, :] * (1 - inside[..., None])
    return {"albedo": np.clip(alb, 0, 1), "height": h, "roughness": np.clip(rough * inside + 0.9 * (1 - inside), 0, 1), "normal_strength": 3.0}


def grass(size, seed=1, colour=(0.30, 0.50, 0.16), colour2=(0.55, 0.58, 0.22), rough=0.9):
    """short lawn / grass ground cover: large patches between two greens, fine vertical blade streaks and speckle"""
    rng = _rng(seed)
    patch = fbm(size, rng, octaves=4, base_sigma=size / 7)
    blades = noise(size, 1.3, rng, aniso=(1.0, 0.18))
    fine = noise(size, 1.0, rng)
    mix = np.clip(patch * 1.3 - 0.15, 0, 1)[..., None]
    base = np.array(colour)[None, None, :] * (1 - mix) + np.array(colour2)[None, None, :] * mix
    alb = base * (0.7 + 0.5 * blades[..., None]) * (0.9 + 0.2 * fine[..., None])
    h = 0.4 * blades + 0.3 * fine + 0.3 * patch
    return {"albedo": np.clip(alb, 0, 1), "height": np.clip(h, 0, 1), "roughness": np.full((size, size), rough) + 0.05 * fine, "normal_strength": 1.5}


def soil(size, seed=1, colour=(0.34, 0.24, 0.16), stones=(0.62, 0.57, 0.50), stone_amount=0.14, rough=0.95):
    """bare soil / mulch: dark brown with darker and lighter patches and scattered small stones"""
    rng = _rng(seed)
    patch = fbm(size, rng, octaves=5, base_sigma=size / 9)
    grain = noise(size, 1.1, rng)
    st = noise(size, 2.2, rng)
    peb = _smoothstep(1 - stone_amount - 0.02, 1 - stone_amount + 0.02, st)
    base = np.array(colour)[None, None, :] * (0.65 + 0.7 * patch[..., None])
    alb = base * (0.85 + 0.3 * grain[..., None]) * (1 - peb[..., None]) + np.array(stones)[None, None, :] * (0.8 + 0.4 * grain[..., None]) * peb[..., None]
    h = 0.35 * patch + 0.25 * grain + 0.4 * peb
    return {"albedo": np.clip(alb, 0, 1), "height": np.clip(h, 0, 1), "roughness": np.clip(rough - 0.1 * peb, 0, 1), "normal_strength": 2.5}


PRESETS = {"weave": weave, "diamond": diamond, "tiles": tiles, "slate": slate, "deck": deck, "fabric": fabric, "leaf": leaf, "grille": grille, "grass": grass, "soil": soil}
