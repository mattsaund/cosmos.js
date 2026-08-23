"""Code emitters.

Turns the current settings into a standalone program in Python or JavaScript
that draws the same planet the preview is drawing. Both exports are
self-contained: no imports beyond the standard library, no dependency on this
package.

Only what the settings actually use gets written out. A smooth cratered body
with no rings emits neither the ray-bisection search nor the ring compositing,
so the file stays readable instead of shipping every branch of the renderer.

Two things must hold or the exports drift away from the preview:
  - derived seeds are resolved HERE and baked in as literals, so neither
    language has to reproduce JavaScript's int32 xor
  - Python rounds half to even and JavaScript rounds half up, so the ramp index
    uses int(x + 0.5) rather than round(x)
"""
from . import planet


def _n(v):
    """Trim a float so the emitted source reads like something a person wrote,
    without losing precision that would move a glyph."""
    s = repr(round(float(v), 6))
    return s if ("." in s or "e" in s) else s + ".0"


def _seeds(cfg):
    """The seeds the renderer derives with xor, resolved to plain positive
    integers. JavaScript's ^ works on int32 and can hand back a negative number
    that its PRNG then reads as unsigned; Python's never does."""
    s = int(cfg["seed"]) & 0xFFFFFFFF
    return {
        "craters": s,
        "maria": (s ^ 0x9E3779B9) & 0xFFFFFFFF,
        "cracks": (s ^ 0x51F0AA) & 0xFFFFFFFF,
        "shape": (s ^ 0x51F0AA) & 0xFFFFFFFF,
        "facets": (s ^ 0xA33C17) & 0xFFFFFFFF,
        "knobs": (s ^ 0xB0C1D2) & 0xFFFFFFFF,
    }


def _parts(cfg):
    """Which pieces this configuration actually needs."""
    t = cfg["texture"]
    return {
        "rock": cfg.get("lumpiness", 0) > 0.001,
        "rings": bool(cfg["rings"]),
        "craters": t in ("cratered", "ice", "rock", "lava"),
        "maria": t in ("cratered", "ice", "desert"),
        "cracks": t in ("ice", "lava"),
    }


# --- texture bodies --------------------------------------------------------

_TEX_PY = {
    "cratered": """    a = 0.86
    for cx, cy, cz, cc, rim in MARIA:
        d = bx * cx + by * cy + bz * cz
        if d > cc:
            a -= 0.40 * (d - cc) / (1 - cc)
    for cx, cy, cz, cc, rim in CRATERS:
        d = bx * cx + by * cy + bz * cz
        if d > cc:
            a += 0.22 if d < rim else -0.26   # bright rim, dark floor
    return min(1.12, max(0.12, a))""",

    "ice": """    a = 1.00
    for cx, cy, cz, cc, rim in MARIA:              # chaos terrain
        d = bx * cx + by * cy + bz * cz
        if d > cc:
            a -= 0.16 * (d - cc) / (1 - cc)
    for cx, cy, cz, w in CRACKS:                   # fractures
        d = abs(bx * cx + by * cy + bz * cz)
        if d < w:
            a -= 0.60 * (1 - 0.45 * d / w)
        elif d < w * 1.8:
            a += 0.14 * (1 - (d - w) / (w * 0.8))
    for cx, cy, cz, cc, rim in CRATERS:            # fresh impacts
        d = bx * cx + by * cy + bz * cz
        if d > cc:
            a += 0.26 * (d - cc) / (1 - cc)
    a += 0.03 * math.sin(lo * 8.0 + la * 5.0)
    return min(1.22, max(0.10, a))""",

    "gas": """    # Latitude bands alone are rotation-invariant: the body would turn and
    # look completely still. The longitude terms make the spin legible.
    a = (0.80 + 0.17 * math.sin(la * 12.5)
              + 0.10 * math.sin(la * 5.5 + 0.8)
              + 0.14 * math.sin(lo * 4.0 + la * 14.0)    # festoons
              + 0.07 * math.sin(lo * 7.0 - la * 9.0))    # turbulence
    dl = ((lo - 0.7 + math.pi) % (2 * math.pi) - math.pi) * 0.62
    dla = (la + 0.33) * 1.9
    d = math.sqrt(dl * dl + dla * dla)                   # the storm
    if d < 0.42:
        a *= 0.50 + 0.36 * (d / 0.42)
    return min(1.15, max(0.12, a))""",

    "desert": """    a = (0.78 + 0.09 * math.sin(lo * 3.4 + la * 2.1)
              + 0.06 * math.sin(la * 6.3 - lo * 1.7))
    for cx, cy, cz, cc, rim in MARIA:
        d = bx * cx + by * cy + bz * cz
        if d > cc:
            a -= 0.24 * (d - cc) / (1 - cc)
    p = abs(la)                                    # polar caps
    if p > 1.16:
        a = 1.20
    elif p > 0.99:
        a += 0.42 * (p - 0.99) / 0.17
    return min(1.20, max(0.15, a))""",

    "lava": """    a = 0.26
    for cx, cy, cz, w in CRACKS:                   # glowing fissures
        d = abs(bx * cx + by * cy + bz * cz)
        if d < w * 2.4:
            a += 0.90 * (1 - d / (w * 2.4))
    for cx, cy, cz, cc, rim in CRATERS:            # hot pools
        d = bx * cx + by * cy + bz * cz
        if d > cc:
            a += 0.55 * (d - cc) / (1 - cc)
    a += 0.05 * math.sin(lo * 9.0 + la * 6.0)
    return min(1.30, max(0.05, a))""",

    "rock": """    a = (0.72 + 0.10 * math.sin(lo * 6.0 + la * 4.0)
              + 0.06 * math.sin(lo * 13.0 - la * 7.0))
    for cx, cy, cz, cc, rim in CRATERS:
        d = bx * cx + by * cy + bz * cz
        if d > cc:
            a += 0.16 if d < rim else -0.20
    return min(1.10, max(0.10, a))""",
}

_TEX_JS = {
    "cratered": """  var a = 0.86, i, c, d;
  for (i = 0; i < MARIA.length; i++) {
    c = MARIA[i]; d = bx * c[0] + by * c[1] + bz * c[2];
    if (d > c[3]) a -= 0.40 * (d - c[3]) / (1 - c[3]);
  }
  for (i = 0; i < CRATERS.length; i++) {
    c = CRATERS[i]; d = bx * c[0] + by * c[1] + bz * c[2];
    if (d > c[3]) a += (d < c[4]) ? 0.22 : -0.26;   // bright rim, dark floor
  }
  return Math.min(1.12, Math.max(0.12, a));""",

    "ice": """  var a = 1.00, i, c, d;
  for (i = 0; i < MARIA.length; i++) {              // chaos terrain
    c = MARIA[i]; d = bx * c[0] + by * c[1] + bz * c[2];
    if (d > c[3]) a -= 0.16 * (d - c[3]) / (1 - c[3]);
  }
  for (i = 0; i < CRACKS.length; i++) {             // fractures
    c = CRACKS[i]; d = Math.abs(bx * c[0] + by * c[1] + bz * c[2]);
    if (d < c[3]) a -= 0.60 * (1 - 0.45 * d / c[3]);
    else if (d < c[3] * 1.8) a += 0.14 * (1 - (d - c[3]) / (c[3] * 0.8));
  }
  for (i = 0; i < CRATERS.length; i++) {            // fresh impacts
    c = CRATERS[i]; d = bx * c[0] + by * c[1] + bz * c[2];
    if (d > c[3]) a += 0.26 * (d - c[3]) / (1 - c[3]);
  }
  a += 0.03 * Math.sin(lo * 8.0 + la * 5.0);
  return Math.min(1.22, Math.max(0.10, a));""",

    "gas": """  // Latitude bands alone are rotation-invariant: the body would turn and
  // look completely still. The longitude terms make the spin legible.
  var a = 0.80 + 0.17 * Math.sin(la * 12.5)
               + 0.10 * Math.sin(la * 5.5 + 0.8)
               + 0.14 * Math.sin(lo * 4.0 + la * 14.0)    // festoons
               + 0.07 * Math.sin(lo * 7.0 - la * 9.0);    // turbulence
  var w = lo - 0.7;
  while (w > Math.PI) w -= 2 * Math.PI;
  while (w < -Math.PI) w += 2 * Math.PI;
  var dl = w * 0.62, dla = (la + 0.33) * 1.9;
  var d = Math.sqrt(dl * dl + dla * dla);                 // the storm
  if (d < 0.42) a *= 0.50 + 0.36 * (d / 0.42);
  return Math.min(1.15, Math.max(0.12, a));""",

    "desert": """  var a = 0.78 + 0.09 * Math.sin(lo * 3.4 + la * 2.1)
               + 0.06 * Math.sin(la * 6.3 - lo * 1.7);
  for (var i = 0; i < MARIA.length; i++) {
    var c = MARIA[i], d = bx * c[0] + by * c[1] + bz * c[2];
    if (d > c[3]) a -= 0.24 * (d - c[3]) / (1 - c[3]);
  }
  var p = Math.abs(la);                            // polar caps
  if (p > 1.16) a = 1.20;
  else if (p > 0.99) a += 0.42 * (p - 0.99) / 0.17;
  return Math.min(1.20, Math.max(0.15, a));""",

    "lava": """  var a = 0.26, i, c, d;
  for (i = 0; i < CRACKS.length; i++) {             // glowing fissures
    c = CRACKS[i]; d = Math.abs(bx * c[0] + by * c[1] + bz * c[2]);
    if (d < c[3] * 2.4) a += 0.90 * (1 - d / (c[3] * 2.4));
  }
  for (i = 0; i < CRATERS.length; i++) {            // hot pools
    c = CRATERS[i]; d = bx * c[0] + by * c[1] + bz * c[2];
    if (d > c[3]) a += 0.55 * (d - c[3]) / (1 - c[3]);
  }
  a += 0.05 * Math.sin(lo * 9.0 + la * 6.0);
  return Math.min(1.30, Math.max(0.05, a));""",

    "rock": """  var a = 0.72 + 0.10 * Math.sin(lo * 6.0 + la * 4.0)
               + 0.06 * Math.sin(lo * 13.0 - la * 7.0);
  for (var i = 0; i < CRATERS.length; i++) {
    var c = CRATERS[i], d = bx * c[0] + by * c[1] + bz * c[2];
    if (d > c[3]) a += (d < c[4]) ? 0.16 : -0.20;
  }
  return Math.min(1.10, Math.max(0.10, a));""",
}


def _rgb(hex_color):
    h = hex_color.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


# --- Python ----------------------------------------------------------------

def python(cfg, b):
    s, p, L = _seeds(cfg), _parts(cfg), []
    lump = cfg.get("lumpiness", 0)

    L += [
        "#!/usr/bin/env python3",
        '"""',
        "ASCII %s planet, generated by cosmos.js." % cfg["texture"],
        "",
        "Standard library only. Run it and it animates in the terminal;",
        "pass --once to print a single frame and exit.",
        '"""',
        "import math, sys, time",
        "",
        'RAMP = " .:-=+*#%@"',
        "COLS, ROWS = %d, %d" % (b.cols, b.rows),
        "EXT_X, EXT_Y = %s, %s   # frame half-size, in body radii" % (_n(b.ext_x), _n(b.ext_y)),
        "TILT, ROLL = %s, %s" % (_n(cfg["tilt"]), _n(cfg["roll"])),
        "AMBIENT   = %s   # light on the night side" % _n(cfg["ambient"]),
        "GAIN      = %s" % _n(cfg["brightness"]),
        "SPEED     = %s   # radians per second" % _n(cfg["speed"] * cfg["direction"]),
        "LIGHT     = (%s, %s, %s)   # key light, upper left"
        % (_n(planet.LIGHT[0]), _n(planet.LIGHT[1]), _n(planet.LIGHT[2])),
    ]
    if p["rock"]:
        L.append("MAXR      = %s   # bounding radius, measured not summed" % _n(b.max))
    if p["rings"]:
        L.append("RING_IN, RING_OUT = %s, %s" % (_n(cfg["ring_inner"]), _n(cfg["ring_outer"])))
        L.append("RING_GAPS = ((1.68, 1.78), (2.04, 2.09))")
    L += ["COLOR     = %s" % (_rgb(cfg["color"]),), "", "", '''def rng(seed):
    """Linear congruential generator, matching the JavaScript original exactly:
    the mask is what JavaScript's >>> 0 does for free."""
    s = seed & 0xFFFFFFFF

    def nxt():
        nonlocal s
        s = (s * 1664525 + 1013904223) & 0xFFFFFFFF
        return s / 4294967296

    return nxt
''', ""]

    if p["craters"] or p["maria"]:
        L += ['''def features(seed, count, r_min, r_span):
    """Surface blobs as unit vectors plus a cosine radius, so a lookup is a dot
    product instead of inverse trig for every glyph."""
    r = rng(seed)
    out = []
    for _ in range(count):
        y = r() * 2 - 1
        ph = r() * math.pi * 2
        s = math.sqrt(max(0.0, 1 - y * y))
        rad = r_min + r() * r_span
        out.append((s * math.cos(ph), y, s * math.sin(ph),
                    math.cos(rad), math.cos(rad * 0.7)))
    return out
''', ""]
    if p["cracks"]:
        L += ['''def circles(seed, count, w_min, w_span):
    """A plane through the centre cuts the sphere in a great circle, so
    abs(dot(p, n)) is the distance from that line. Gives a feature that wraps
    the whole body, which no blob can do."""
    r = rng(seed)
    out = []
    for _ in range(count):
        y = r() * 2 - 1
        ph = r() * math.pi * 2
        s = math.sqrt(max(0.0, 1 - y * y))
        out.append((s * math.cos(ph), y, s * math.sin(ph), w_min + r() * w_span))
    return out
''', ""]
    if p["rock"]:
        L += ['''def lobes(seed, count, a_min, a_span, neg_chance):
    """Deformation lobes in BODY space. That is the whole point: rotating the
    body rotates the lumps, which is what makes an asteroid read as an asteroid
    rather than a sphere wearing a moving texture."""
    r = rng(seed)
    out = []
    for _ in range(count):
        y = r() * 2 - 1
        ph = r() * math.pi * 2
        c = math.sqrt(max(0.0, 1 - y * y))
        amp = (a_min + r() * a_span) * (-1 if r() < neg_chance else 1)
        out.append((c * math.cos(ph), y, c * math.sin(ph), amp))
    return out
''', ""]

    if p["craters"]:
        L.append("CRATERS = features(%d, %d, 0.15, 0.20)" % (s["craters"], int(round(cfg["craters"]))))
    if p["maria"]:
        L.append("MARIA   = features(%d, 5, 0.40, 0.26)" % s["maria"])
    if p["cracks"]:
        L.append("CRACKS  = circles(%d, 8, 0.046, 0.042)" % s["cracks"])
    if p["rock"]:
        L.append("SHAPE   = lobes(%d, 5, %s, %s, 0.50)" % (s["shape"], _n(0.105 * lump), _n(0.075 * lump)))
        L.append("FACETS  = lobes(%d, 14, %s, %s, 0.45)" % (s["facets"], _n(0.034 * lump), _n(0.042 * lump)))
        L.append("KNOBS   = lobes(%d, 24, %s, %s, 0.45)" % (s["knobs"], _n(0.018 * lump), _n(0.036 * lump)))
        L.append("ELONG   = %s" % _n(0.24 * lump))
    L += ["", ""]

    L += ["def texture(bx, by, bz, la, lo):",
          '    """Albedo at a point on the surface, around 1.0."""',
          _TEX_PY[cfg["texture"]], "", ""]

    if p["rock"]:
        L += ['''def radius(bx, by, bz):
    """Direction-varying radius. Powers are written out as products: pow() here
    would run a million times per frame."""
    r = 1.0 + ELONG * (bx * bx - 0.34)
    for lx, ly, lz, a in SHAPE:          # signed, gentle: the silhouette
        d = bx * lx + by * ly + bz * lz
        r += a * d * d * d
    for lx, ly, lz, a in FACETS:         # one-sided: flats and edges
        d = bx * lx + by * ly + bz * lz
        if d > 0:
            d2 = d * d
            r += a * d2 * d2 * d
    for lx, ly, lz, a in KNOBS:          # tight: knobs and pits
        d = bx * lx + by * ly + bz * lz
        if d > 0:
            d3 = d * d * d
            r += a * d3 * d3 * d3
    return r
''', ""]

    L += ['''def frame(angle):
    """One frame, as a string of ROWS lines."""
    ct, st = math.cos(TILT), math.sin(TILT)
    nx, ny, nz = -math.sin(ROLL) * ct, math.cos(ROLL) * ct, st

    # An orthonormal equatorial basis perpendicular to the axis.
    hx, hy, hz = (1.0, 0.0, 0.0) if abs(nz) > 0.9 else (0.0, 0.0, 1.0)
    ux, uy, uz = hy * nz - hz * ny, hz * nx - hx * nz, hx * ny - hy * nx
    um = math.sqrt(ux * ux + uy * uy + uz * uz) or 1.0
    ux, uy, uz = ux / um, uy / um, uz / um
    vx, vy, vz = ny * uz - nz * uy, nz * ux - nx * uz, nx * uy - ny * ux

    ca, sa = math.cos(angle), math.sin(angle)
    lx, ly, lz = LIGHT
    last = len(RAMP) - 1

    def to_body(px, py, pz):
        """View space to body space. Returns the distance from the centre along
        with the direction, since the caller needs both."""
        d = math.sqrt(px * px + py * py + pz * pz) or 1.0
        ax, ay, az = px / d, py / d, pz / d
        b1y = ax * nx + ay * ny + az * nz
        b0 = ax * ux + ay * uy + az * uz
        b1 = ax * vx + ay * vy + az * vz
        return d, b0 * ca + b1 * sa, b1y, b1 * ca - b0 * sa

    rows = []
    for j in range(ROWS):
        line = []
        sy = (1 - 2 * (j + 0.5) / ROWS) * EXT_Y
        for k in range(COLS):
            sx = (2 * (k + 0.5) / COLS - 1) * EXT_X
            d2 = sx * sx + sy * sy

            sphere, zs, hit = -1.0, -1e9, False''']

    if p["rock"]:
        L.append('''            # Bisect down the ray. Newton would take fewer steps but blows
            # up near the silhouette where the surface is edge-on.
            hi = MAXR * MAXR - d2
            if hi > 0:
                hi = math.sqrt(hi)
                lo = 0.0
                # to_body hands back the distance as well as the direction, and
                # it is the distance that decides the silhouette.
                dd, bx, by, bz = to_body(sx, sy, 0.0)
                if dd < radius(bx, by, bz):
                    for _ in range(9):
                        mid = (lo + hi) * 0.5
                        dd, bx, by, bz = to_body(sx, sy, mid)
                        if dd < radius(bx, by, bz):
                            lo = mid
                        else:
                            hi = mid
                    zs, hit = lo, True''')
    else:
        L.append('''            if d2 <= 1:
                zs, hit = math.sqrt(1 - d2), True''')

    L.append('''
            if hit:
                lp, bx, by, bz = to_body(sx, sy, zs)
                nzv = zs / lp                     # cosine of the view angle
                lum = (sx / lp) * lx + (sy / lp) * ly + nzv * lz
                if lum < 0:
                    lum = 0.0
                byc = min(1.0, max(-1.0, by))
                alb = texture(bx, byc, bz, math.asin(byc), math.atan2(bz, bx))
                sphere = alb * (AMBIENT + (1 - AMBIENT) * lum * (0.45 + 0.55 * lum))
                sphere *= (0.58 + 0.42 * nzv) * GAIN      # limb darkening

            ring_lum, cov, zr = 0.0, 0.0, -1e9''')

    if p["rings"]:
        L.append('''            # The rings are a translucent sheet, not a surface: a faint
            # band in front of the planet composites over it.
            if abs(nz) > 0.05:
                zr = -(nx * sx + ny * sy) / nz
                rr = math.sqrt(d2 + zr * zr)
                if RING_IN <= rr <= RING_OUT and not any(a < rr < b for a, b in RING_GAPS):
                    t = (rr - RING_IN) / (RING_OUT - RING_IN)
                    cov = (0.55 + 0.45 * math.sin(t * 8.2)) * (1 - 0.45 * t)
                    # Inner material shears ahead of outer on a Keplerian
                    # profile. Without it the rings are radially symmetric and
                    # look frozen at every angle.
                    au = sx * ux + sy * uy + zr * uz
                    av = sx * vx + sy * vy + zr * vz
                    phi = math.atan2(av, au) - angle * (rr ** -1.5) * 1.7
                    cov *= 0.70 + 0.30 * (0.62 * math.sin(phi * 2.0 + 0.4)
                                        + 0.38 * math.sin(phi * 5.0 - 1.1))
                    cov = min(1.0, max(0.0, cov)) * (0.55 + 0.45 * (1 - abs(nz)))
                    ring_lum = 0.88 * GAIN
                    ql = sx * lx + sy * ly + zr * lz     # planet shadow
                    if ql < 0:
                        px, py, pz = sx - ql * lx, sy - ql * ly, zr - ql * lz
                        if px * px + py * py + pz * pz < 1:
                            ring_lum *= 0.16''')

    L.append('''
            back = sphere if sphere >= 0 else 0.0
            if cov > 0 and (d2 > 1 or zr > zs):
                v = ring_lum * cov + back * (1 - cov)
            else:
                v = back
            # int(x + 0.5), not round(): Python rounds half to even and would
            # pick a different glyph than the JavaScript original.
            line.append(RAMP[int(min(1.0, max(0.0, v)) * last + 0.5)])
        rows.append("".join(line))
    return "\\n".join(rows)


def main():
    tint = "\\x1b[38;2;%d;%d;%dm" % COLOR
    if "--once" in sys.argv:
        print(tint + frame(0.0) + "\\x1b[0m")
        return
    start = time.time()
    try:
        sys.stdout.write("\\x1b[?25l")            # hide the cursor
        while True:
            angle = (time.time() - start) * SPEED
            sys.stdout.write("\\x1b[H" + tint + frame(angle) + "\\x1b[0m")
            sys.stdout.flush()
            time.sleep(1 / 30)
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout.write("\\x1b[?25h\\x1b[0m\\n")  # restore it


if __name__ == "__main__":
    main()''')
    return "\n".join(L) + "\n"


# --- JavaScript ------------------------------------------------------------

def javascript(cfg, b):
    s, p, L = _seeds(cfg), _parts(cfg), []
    lump = cfg.get("lumpiness", 0)

    L += [
        "/* ASCII %s planet, generated by cosmos.js." % cfg["texture"],
        "",
        "   Self-contained: no imports, no dependencies. In a browser, point it",
        "   at a <pre> and call animate(). Under Node, call frame(0) and print.",
        "*/",
        'var RAMP = " .:-=+*#%@";',
        "var COLS = %d, ROWS = %d;" % (b.cols, b.rows),
        "var EXT_X = %s, EXT_Y = %s;   // frame half-size, in body radii" % (_n(b.ext_x), _n(b.ext_y)),
        "var TILT = %s, ROLL = %s;" % (_n(cfg["tilt"]), _n(cfg["roll"])),
        "var AMBIENT = %s;        // light on the night side" % _n(cfg["ambient"]),
        "var GAIN = %s;" % _n(cfg["brightness"]),
        "var SPEED = %s;          // radians per second" % _n(cfg["speed"] * cfg["direction"]),
        "var LIGHT = [%s, %s, %s];  // key light, upper left"
        % (_n(planet.LIGHT[0]), _n(planet.LIGHT[1]), _n(planet.LIGHT[2])),
    ]
    if p["rock"]:
        L.append("var MAXR = %s;           // bounding radius, measured not summed" % _n(b.max))
    if p["rings"]:
        L.append("var RING_IN = %s, RING_OUT = %s;" % (_n(cfg["ring_inner"]), _n(cfg["ring_outer"])))
        L.append("var RING_GAPS = [[1.68, 1.78], [2.04, 2.09]];")
    L += ['var COLOR = "%s";' % cfg["color"], "",
          "/* Linear congruential generator: same seed, same craters, every run. */",
          "function rng(seed) {",
          "  var s = seed >>> 0;",
          "  return function () {",
          "    s = (s * 1664525 + 1013904223) >>> 0;",
          "    return s / 4294967296;",
          "  };",
          "}", ""]

    if p["craters"] or p["maria"]:
        L += ["/* Surface blobs as unit vectors plus a cosine radius, so a lookup is a",
              "   dot product instead of inverse trig for every glyph. */",
              "function features(seed, count, rMin, rSpan) {",
              "  var r = rng(seed), out = [];",
              "  for (var i = 0; i < count; i++) {",
              "    var y = r() * 2 - 1, ph = r() * Math.PI * 2;",
              "    var s = Math.sqrt(Math.max(0, 1 - y * y)), rad = rMin + r() * rSpan;",
              "    out.push([s * Math.cos(ph), y, s * Math.sin(ph),",
              "              Math.cos(rad), Math.cos(rad * 0.7)]);",
              "  }",
              "  return out;",
              "}", ""]
    if p["cracks"]:
        L += ["/* A plane through the centre cuts the sphere in a great circle, so",
              "   abs(dot(p, n)) is the distance from that line. */",
              "function circles(seed, count, wMin, wSpan) {",
              "  var r = rng(seed), out = [];",
              "  for (var i = 0; i < count; i++) {",
              "    var y = r() * 2 - 1, ph = r() * Math.PI * 2;",
              "    var s = Math.sqrt(Math.max(0, 1 - y * y));",
              "    out.push([s * Math.cos(ph), y, s * Math.sin(ph), wMin + r() * wSpan]);",
              "  }",
              "  return out;",
              "}", ""]
    if p["rock"]:
        L += ["/* Deformation lobes in BODY space: rotating the body rotates the lumps,",
              "   which is what makes an asteroid read as one. */",
              "function lobes(seed, count, aMin, aSpan, negChance) {",
              "  var r = rng(seed), out = [];",
              "  for (var i = 0; i < count; i++) {",
              "    var y = r() * 2 - 1, ph = r() * Math.PI * 2;",
              "    var c = Math.sqrt(Math.max(0, 1 - y * y));",
              "    out.push([c * Math.cos(ph), y, c * Math.sin(ph),",
              "              (aMin + r() * aSpan) * (r() < negChance ? -1 : 1)]);",
              "  }",
              "  return out;",
              "}", ""]

    if p["craters"]:
        L.append("var CRATERS = features(%d, %d, 0.15, 0.20);" % (s["craters"], int(round(cfg["craters"]))))
    if p["maria"]:
        L.append("var MARIA = features(%d, 5, 0.40, 0.26);" % s["maria"])
    if p["cracks"]:
        L.append("var CRACKS = circles(%d, 8, 0.046, 0.042);" % s["cracks"])
    if p["rock"]:
        L.append("var SHAPE = lobes(%d, 5, %s, %s, 0.50);" % (s["shape"], _n(0.105 * lump), _n(0.075 * lump)))
        L.append("var FACETS = lobes(%d, 14, %s, %s, 0.45);" % (s["facets"], _n(0.034 * lump), _n(0.042 * lump)))
        L.append("var KNOBS = lobes(%d, 24, %s, %s, 0.45);" % (s["knobs"], _n(0.018 * lump), _n(0.036 * lump)))
        L.append("var ELONG = %s;" % _n(0.24 * lump))
    L += ["", "/* Albedo at a point on the surface, around 1.0. */",
          "function texture(bx, by, bz, la, lo) {", _TEX_JS[cfg["texture"]], "}", ""]

    if p["rock"]:
        L += ["/* Direction-varying radius. Powers are written as products: Math.pow",
              "   here would run a million times per frame. */",
              "function radius(bx, by, bz) {",
              "  var r = 1 + ELONG * (bx * bx - 0.34), i, L, d, d2, d3;",
              "  for (i = 0; i < SHAPE.length; i++) {        // signed: the silhouette",
              "    L = SHAPE[i]; d = bx * L[0] + by * L[1] + bz * L[2];",
              "    r += L[3] * d * d * d;",
              "  }",
              "  for (i = 0; i < FACETS.length; i++) {       // one-sided: flats",
              "    L = FACETS[i]; d = bx * L[0] + by * L[1] + bz * L[2];",
              "    if (d > 0) { d2 = d * d; r += L[3] * d2 * d2 * d; }",
              "  }",
              "  for (i = 0; i < KNOBS.length; i++) {        // tight: knobs and pits",
              "    L = KNOBS[i]; d = bx * L[0] + by * L[1] + bz * L[2];",
              "    if (d > 0) { d3 = d * d * d; r += L[3] * d3 * d3 * d3; }",
              "  }",
              "  return r;",
              "}", ""]

    L += ["/* One frame, as a string of ROWS lines. */",
          "function frame(angle) {",
          "  var ct = Math.cos(TILT), st = Math.sin(TILT);",
          "  var nx = -Math.sin(ROLL) * ct, ny = Math.cos(ROLL) * ct, nz = st;",
          "",
          "  // An orthonormal equatorial basis perpendicular to the axis.",
          "  var hx = 0, hy = 0, hz = 1;",
          "  if (Math.abs(nz) > 0.9) { hx = 1; hz = 0; }",
          "  var ux = hy * nz - hz * ny, uy = hz * nx - hx * nz, uz = hx * ny - hy * nx;",
          "  var um = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;",
          "  ux /= um; uy /= um; uz /= um;",
          "  var vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;",
          "",
          "  var ca = Math.cos(angle), sa = Math.sin(angle);",
          "  var lx = LIGHT[0], ly = LIGHT[1], lz = LIGHT[2];",
          "  var last = RAMP.length - 1;",
          "",
          "  // Scratch rather than a returned array: this runs once per bisection",
          "  // step per cell, and allocating there would be all GC and no work.",
          "  var _bx = 0, _by = 0, _bz = 0;",
          "  function toBody(px, py, pz) {",
          "    var d = Math.sqrt(px * px + py * py + pz * pz) || 1;",
          "    var ax = px / d, ay = py / d, az = pz / d;",
          "    _by = ax * nx + ay * ny + az * nz;",
          "    var b0 = ax * ux + ay * uy + az * uz;",
          "    var b1 = ax * vx + ay * vy + az * vz;",
          "    _bx = b0 * ca + b1 * sa;",
          "    _bz = b1 * ca - b0 * sa;",
          "    return d;",
          "  }",
          "",
          "  var out = [];",
          "  for (var j = 0; j < ROWS; j++) {",
          "    var line = [];",
          "    var sy = (1 - 2 * (j + 0.5) / ROWS) * EXT_Y;",
          "    for (var k = 0; k < COLS; k++) {",
          "      var sx = (2 * (k + 0.5) / COLS - 1) * EXT_X;",
          "      var d2 = sx * sx + sy * sy;",
          "      var sphere = -1, zs = -1e9, hit = false;"]

    if p["rock"]:
        L += ["",
              "      // Bisect down the ray. Newton would take fewer steps but blows up",
              "      // near the silhouette where the surface is edge-on.",
              "      var hi = MAXR * MAXR - d2;",
              "      if (hi > 0) {",
              "        hi = Math.sqrt(hi);",
              "        var lo = 0;",
              "        if (toBody(sx, sy, 0) < radius(_bx, _by, _bz)) {",
              "          for (var q = 0; q < 9; q++) {",
              "            var mid = (lo + hi) * 0.5;",
              "            if (toBody(sx, sy, mid) < radius(_bx, _by, _bz)) lo = mid;",
              "            else hi = mid;",
              "          }",
              "          zs = lo; hit = true;",
              "        }",
              "      }"]
    else:
        L.append("      if (d2 <= 1) { zs = Math.sqrt(1 - d2); hit = true; }")

    L += ["",
          "      if (hit) {",
          "        var lp = toBody(sx, sy, zs);",
          "        var nzv = zs / lp;                  // cosine of the view angle",
          "        var lum = (sx / lp) * lx + (sy / lp) * ly + nzv * lz;",
          "        if (lum < 0) lum = 0;",
          "        var by = Math.min(1, Math.max(-1, _by));",
          "        var alb = texture(_bx, by, _bz, Math.asin(by), Math.atan2(_bz, _bx));",
          "        sphere = alb * (AMBIENT + (1 - AMBIENT) * lum * (0.45 + 0.55 * lum));",
          "        sphere *= (0.58 + 0.42 * nzv) * GAIN;   // limb darkening",
          "      }",
          "",
          "      var ringLum = 0, cov = 0, zr = -1e9;"]

    if p["rings"]:
        L += ["      // The rings are a translucent sheet, not a surface: a faint band in",
              "      // front of the planet composites over it rather than replacing it.",
              "      if (Math.abs(nz) > 0.05) {",
              "        zr = -(nx * sx + ny * sy) / nz;",
              "        var rr = Math.sqrt(d2 + zr * zr);",
              "        if (rr >= RING_IN && rr <= RING_OUT) {",
              "          var open = true;",
              "          for (var g = 0; g < RING_GAPS.length; g++) {",
              "            if (rr > RING_GAPS[g][0] && rr < RING_GAPS[g][1]) { open = false; break; }",
              "          }",
              "          if (open) {",
              "            var t = (rr - RING_IN) / (RING_OUT - RING_IN);",
              "            cov = (0.55 + 0.45 * Math.sin(t * 8.2)) * (1 - 0.45 * t);",
              "            // Inner material shears ahead of outer on a Keplerian profile.",
              "            // Without it the rings look frozen at every angle.",
              "            var au = sx * ux + sy * uy + zr * uz;",
              "            var av = sx * vx + sy * vy + zr * vz;",
              "            var phi = Math.atan2(av, au) - angle * Math.pow(rr, -1.5) * 1.7;",
              "            cov *= 0.70 + 0.30 * (0.62 * Math.sin(phi * 2.0 + 0.4)",
              "                                + 0.38 * Math.sin(phi * 5.0 - 1.1));",
              "            cov = Math.min(1, Math.max(0, cov)) * (0.55 + 0.45 * (1 - Math.abs(nz)));",
              "            ringLum = 0.88 * GAIN;",
              "            var ql = sx * lx + sy * ly + zr * lz;    // planet shadow",
              "            if (ql < 0) {",
              "              var px = sx - ql * lx, py = sy - ql * ly, pz = zr - ql * lz;",
              "              if (px * px + py * py + pz * pz < 1) ringLum *= 0.16;",
              "            }",
              "          }",
              "        }",
              "      }"]

    L += ["",
          "      var back = sphere >= 0 ? sphere : 0;",
          "      var v = (cov > 0 && (d2 > 1 || zr > zs))",
          "            ? ringLum * cov + back * (1 - cov)",
          "            : back;",
          '      line.push(RAMP.charAt(Math.round(Math.min(1, Math.max(0, v)) * last)));',
          "    }",
          '    out.push(line.join(""));',
          "  }",
          '  return out.join("\\n");',
          "}",
          "",
          "/* Browser driver. Give it a <pre> and it runs on wall-clock time. */",
          "function animate(el) {",
          '  el.style.font = "12px/1 ui-monospace, monospace";',
          "  el.style.color = COLOR;",
          '  el.style.whiteSpace = "pre";',
          "  var t0 = performance.now();",
          "  (function tick(now) {",
          "    el.textContent = frame((now - t0) / 1000 * SPEED);",
          "    requestAnimationFrame(tick);",
          "  })(t0);",
          "}",
          "",
          'if (typeof document !== "undefined") {',
          '  var host = document.createElement("pre");',
          "  document.body.appendChild(host);",
          "  animate(host);",
          '} else if (typeof console !== "undefined") {',
          "  console.log(frame(0));           // Node: one frame to stdout",
          "}"]
    return "\n".join(L) + "\n"
