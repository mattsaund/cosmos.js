"""ASCII planet renderer.

No images and no pre-baked frames. Every glyph is a ray cast at a body, shaded
from a real lighting model, and quantised onto a density ramp.

Pure computation: nothing here imports tkinter or touches a window. The desktop
app drives it, and cosmos/emit.py writes standalone copies of the same maths in
Python and JavaScript.
"""
import math

# Bourke's 10-level ramp. Ink density rises monotonically, which the
# obvious-looking ".,:;=+ic*ox%#@" does not: 'i' and 'c' read lighter than '='
# and '+', so gradients come out mottled. Index 0 is a space, which gives the
# empty-sky threshold for free.
RAMP = " .:-=+*#%@"

# Glyph advance divided by line height. A character cell is taller than it is
# wide, so a disk drawn on a square grid of them comes out an egg; every column
# count is derived through this to keep it round. Terminals and Tk's monospace
# fonts sit near 0.5; the app measures the real one and passes it in.
CHAR_ASPECT = 0.5

# Key light: upper left, toward the viewer.
def _unit(x, y, z):
    m = math.sqrt(x * x + y * y + z * z) or 1.0
    return (x / m, y / m, z / m)


LIGHT = _unit(-0.60, 0.40, 0.69)


def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def rng(seed):
    """Linear congruential generator, matching the JavaScript original exactly:
    the mask is what JavaScript's >>> 0 does for free. Deterministic, so a given
    seed always draws the same craters."""
    s = seed & 0xFFFFFFFF

    def nxt():
        nonlocal s
        s = (s * 1664525 + 1013904223) & 0xFFFFFFFF
        return s / 4294967296

    return nxt


def features(seed, count, r_min, r_span):
    """Surface blobs as body-frame unit vectors plus a cosine radius, so a
    texture lookup is a dot product rather than inverse trig per glyph."""
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


def circles(seed, count, w_min, w_span):
    """A plane through the centre cuts the sphere in a great circle, so
    abs(dot(p, n)) is the angular distance from that line. Gives a feature that
    wraps the whole body, which no blob can do."""
    r = rng(seed)
    out = []
    for _ in range(count):
        y = r() * 2 - 1
        ph = r() * math.pi * 2
        s = math.sqrt(max(0.0, 1 - y * y))
        out.append((s * math.cos(ph), y, s * math.sin(ph), w_min + r() * w_span))
    return out


def lobes(seed, count, a_min, a_span, neg_chance):
    """Deformation lobes. Amplitudes are signed so the shape dents as well as
    bulges."""
    r = rng(seed)
    out = []
    for _ in range(count):
        y = r() * 2 - 1
        ph = r() * math.pi * 2
        c = math.sqrt(max(0.0, 1 - y * y))
        amp = (a_min + r() * a_span) * (-1 if r() < neg_chance else 1)
        out.append((c * math.cos(ph), y, c * math.sin(ph), amp))
    return out


def wrap_pi(x):
    return (x + math.pi) % (2 * math.pi) - math.pi


# --- textures --------------------------------------------------------------
# Each takes a body-frame unit vector plus the latitude and longitude already
# derived from it, and returns an albedo around 1.0. Anything under ~0.14 rad
# across lands inside a single glyph and reads as noise rather than a feature,
# which is what sets the floors below.

def _t_cratered(b, bx, by, bz, la, lo):
    a = 0.86
    for cx, cy, cz, cc, _rim in b.maria:
        d = bx * cx + by * cy + bz * cz
        if d > cc:
            a -= 0.40 * (d - cc) / (1 - cc)
    for cx, cy, cz, cc, rim in b.craters:
        d = bx * cx + by * cy + bz * cz
        if d > cc:
            a += 0.22 if d < rim else -0.26   # bright rim, dark floor
    return clamp(a, 0.12, 1.12)


def _t_ice(b, bx, by, bz, la, lo):
    a = 1.00
    for cx, cy, cz, cc, _rim in b.maria:              # chaos terrain
        d = bx * cx + by * cy + bz * cz
        if d > cc:
            a -= 0.16 * (d - cc) / (1 - cc)
    for cx, cy, cz, w in b.cracks:                    # fractures
        d = abs(bx * cx + by * cy + bz * cz)
        if d < w:
            a -= 0.60 * (1 - 0.45 * d / w)
        elif d < w * 1.8:
            a += 0.14 * (1 - (d - w) / (w * 0.8))
    for cx, cy, cz, cc, _rim in b.craters:            # fresh impacts
        d = bx * cx + by * cy + bz * cz
        if d > cc:
            a += 0.26 * (d - cc) / (1 - cc)
    a += 0.03 * math.sin(lo * 8.0 + la * 5.0)
    return clamp(a, 0.10, 1.22)


def _t_gas(b, bx, by, bz, la, lo):
    # Latitude bands alone are rotation-invariant: the body would turn and look
    # completely still. The longitude terms are what make the spin legible.
    a = (0.80 + 0.17 * math.sin(la * 12.5)
              + 0.10 * math.sin(la * 5.5 + 0.8)
              + 0.14 * math.sin(lo * 4.0 + la * 14.0)     # festoons
              + 0.07 * math.sin(lo * 7.0 - la * 9.0))     # turbulence
    dl = wrap_pi(lo - 0.7) * 0.62
    dla = (la + 0.33) * 1.9
    d = math.sqrt(dl * dl + dla * dla)                    # the storm
    if d < 0.42:
        a *= 0.50 + 0.36 * (d / 0.42)
    return clamp(a, 0.12, 1.15)


def _t_desert(b, bx, by, bz, la, lo):
    a = (0.78 + 0.09 * math.sin(lo * 3.4 + la * 2.1)
              + 0.06 * math.sin(la * 6.3 - lo * 1.7))
    for cx, cy, cz, cc, _rim in b.maria:
        d = bx * cx + by * cy + bz * cz
        if d > cc:
            a -= 0.24 * (d - cc) / (1 - cc)
    p = abs(la)                                           # polar caps
    if p > 1.16:
        a = 1.20
    elif p > 0.99:
        a += 0.42 * (p - 0.99) / 0.17
    return clamp(a, 0.15, 1.20)


def _t_lava(b, bx, by, bz, la, lo):
    a = 0.26
    for cx, cy, cz, w in b.cracks:                        # glowing fissures
        d = abs(bx * cx + by * cy + bz * cz)
        if d < w * 2.4:
            a += 0.90 * (1 - d / (w * 2.4))
    for cx, cy, cz, cc, _rim in b.craters:                # hot pools
        d = bx * cx + by * cy + bz * cz
        if d > cc:
            a += 0.55 * (d - cc) / (1 - cc)
    a += 0.05 * math.sin(lo * 9.0 + la * 6.0)
    return clamp(a, 0.05, 1.30)


def _t_rock(b, bx, by, bz, la, lo):
    a = (0.72 + 0.10 * math.sin(lo * 6.0 + la * 4.0)
              + 0.06 * math.sin(lo * 13.0 - la * 7.0))
    for cx, cy, cz, cc, rim in b.craters:
        d = bx * cx + by * cy + bz * cz
        if d > cc:
            a += 0.16 if d < rim else -0.20
    return clamp(a, 0.10, 1.10)


TEXTURES = {
    "rock": _t_rock,
    "cratered": _t_cratered,
    "ice": _t_ice,
    "gas": _t_gas,
    "lava": _t_lava,
    "desert": _t_desert,
}

TEXTURE_ORDER = ["rock", "cratered", "ice", "gas", "lava", "desert"]
TEXTURE_LABELS = {"gas": "gas giant"}


def defaults():
    return {
        "texture": "cratered",
        "rows": 24,          # glyph rows; columns follow from the cell aspect
        "size": 14,          # preview font size in px, ignored by the maths
        "brightness": 1.00,
        "ambient": 0.16,     # light on the night side
        "craters": 15,
        "speed": 0.09,       # radians per second
        "direction": 1,      # +1 counterclockwise, -1 clockwise
        "lumpiness": 0.00,   # 0 is a perfect sphere
        "tilt": 0.30,
        "roll": 0.10,
        "rings": False,
        "ring_inner": 1.30,
        "ring_outer": 2.30,
        "color": "#ffffff",
        "seed": 20260823,
    }


class Body:
    """Everything derived from a config once, so the per-glyph loop never
    re-seeds or rebuilds a feature list. Construct on a settings change, not
    per frame."""

    def __init__(self, cfg, aspect=CHAR_ASPECT):
        self.cfg = cfg
        lump = cfg.get("lumpiness", 0.0)
        seed = int(cfg["seed"]) & 0xFFFFFFFF

        self.tex = TEXTURES.get(cfg["texture"], _t_cratered)
        self.rows = max(6, int(round(cfg["rows"])))
        self.amb = cfg["ambient"]
        self.gain = cfg["brightness"]
        self.tilt = cfg["tilt"]
        self.roll = cfg["roll"]
        self.rock = lump > 0.001

        self.craters = features(seed, max(0, int(round(cfg["craters"]))), 0.15, 0.20)
        self.maria = features(seed ^ 0x9E3779B9, 5, 0.40, 0.26)
        self.cracks = circles(seed ^ 0x51F0AA, 8, 0.046, 0.042)

        # Three scales of deformation, all generated from the seed. Hand-picking
        # amplitudes was the trap here: one broad lobe well above its neighbours
        # reads as a spike rather than as terrain.
        self.shape = lobes(seed ^ 0x51F0AA, 5, 0.105 * lump, 0.075 * lump, 0.50)
        self.facets = lobes(seed ^ 0xA33C17, 14, 0.034 * lump, 0.042 * lump, 0.45)
        self.knobs = lobes(seed ^ 0xB0C1D2, 24, 0.018 * lump, 0.036 * lump, 0.45)
        self.elong = 0.24 * lump

        self.rings = None
        if cfg["rings"]:
            self.rings = (cfg["ring_inner"], cfg["ring_outer"],
                          ((1.68, 1.78), (2.04, 2.09)))

        # The frame has to cover the body at its widest. Measured over a spread
        # of directions rather than summed analytically: the lobes cannot all
        # peak the same way, so the analytic worst case is far too generous and
        # would leave the body swimming in empty margin.
        self.max = 1.0
        if self.rock:
            m, ga = 0.0, math.pi * (3 - math.sqrt(5))
            for i in range(800):
                y = 1 - 2 * (i + 0.5) / 800
                rr = math.sqrt(max(0.0, 1 - y * y))
                th = ga * i
                v = self.radius(rr * math.cos(th), y, rr * math.sin(th))
                if v > m:
                    m = v
            self.max = m * 1.05

        # Horizontal and vertical extents are set apart, not shared. A tilted
        # ring system is wide and flat: forcing a square frame around it leaves
        # the body swimming in empty sky above and below.
        if self.rings:
            self.ext_x = cfg["ring_outer"] * 1.02
            self.ext_y = max(self.max,
                             cfg["ring_outer"] * abs(math.sin(cfg["tilt"])) + 0.15) * 1.06
        else:
            self.ext_x = self.max * 1.02
            self.ext_y = self.max * 1.02
        self.cols = max(8, int(round(self.rows * (self.ext_x / self.ext_y) / aspect)))

    def radius(self, bx, by, bz):
        """Direction-varying radius. The lobes live in BODY space, which is the
        whole point: rotating the body rotates the lumps, and that is what makes
        an asteroid read as an asteroid rather than a sphere wearing a moving
        texture. Powers are written out as products; pow() here would run a
        million times per frame."""
        if not self.rock:
            return 1.0
        r = 1.0 + self.elong * (bx * bx - 0.34)
        for lx, ly, lz, a in self.shape:          # signed, gentle: silhouette
            d = bx * lx + by * ly + bz * lz
            r += a * d * d * d
        for lx, ly, lz, a in self.facets:         # one-sided: flats and edges
            d = bx * lx + by * ly + bz * lz
            if d > 0:
                d2 = d * d
                r += a * d2 * d2 * d
        for lx, ly, lz, a in self.knobs:          # tight: knobs and pits
            d = bx * lx + by * ly + bz * lz
            if d > 0:
                d3 = d * d * d
                r += a * d3 * d3 * d3
        return r


def render(b, angle):
    """One frame, as a string of b.rows lines."""
    cols, rows = b.cols, b.rows
    ext_x, ext_y = b.ext_x, b.ext_y

    ct, st = math.cos(b.tilt), math.sin(b.tilt)
    nx, ny, nz = -math.sin(b.roll) * ct, math.cos(b.roll) * ct, st

    # An orthonormal equatorial basis perpendicular to that axis.
    hx, hy, hz = (1.0, 0.0, 0.0) if abs(nz) > 0.9 else (0.0, 0.0, 1.0)
    ux, uy, uz = hy * nz - hz * ny, hz * nx - hx * nz, hx * ny - hy * nx
    um = math.sqrt(ux * ux + uy * uy + uz * uz) or 1.0
    ux, uy, uz = ux / um, uy / um, uz / um
    vx, vy, vz = ny * uz - nz * uy, nz * ux - nx * uz, nx * uy - ny * ux

    ca, sa = math.cos(angle), math.sin(angle)
    lx, ly, lz = LIGHT
    last = len(RAMP) - 1
    amb, gain, tex, rock = b.amb, b.gain, b.tex, b.rock
    radius = b.radius
    maxr2 = b.max * b.max
    ring = b.rings
    sqrt, ramp = math.sqrt, RAMP

    def to_body(px, py, pz):
        """View space to body space. Returns the distance from the centre along
        with the direction, since the caller needs both."""
        d = sqrt(px * px + py * py + pz * pz) or 1.0
        ax, ay, az = px / d, py / d, pz / d
        b1y = ax * nx + ay * ny + az * nz
        b0 = ax * ux + ay * uy + az * uz
        b1 = ax * vx + ay * vy + az * vz
        return d, b0 * ca + b1 * sa, b1y, b1 * ca - b0 * sa

    out = []
    for j in range(rows):
        line = []
        sy = (1 - 2 * (j + 0.5) / rows) * ext_y
        for k in range(cols):
            sx = (2 * (k + 0.5) / cols - 1) * ext_x
            d2 = sx * sx + sy * sy

            sphere, zs, hit = -1.0, -1e9, False
            if rock:
                # Bisect down the ray: hi starts outside the bounding sphere, lo
                # at the z=0 plane. Newton would take fewer steps but blows up
                # near the silhouette where the surface is edge-on.
                hi = maxr2 - d2
                if hi > 0:
                    hi = sqrt(hi)
                    lo = 0.0
                    dd, bx, by, bz = to_body(sx, sy, 0.0)
                    if dd < radius(bx, by, bz):
                        for _ in range(9):
                            mid = (lo + hi) * 0.5
                            dd, bx, by, bz = to_body(sx, sy, mid)
                            if dd < radius(bx, by, bz):
                                lo = mid
                            else:
                                hi = mid
                        zs, hit = lo, True
            elif d2 <= 1:
                zs, hit = sqrt(1 - d2), True

            if hit:
                lp, bx, by, bz = to_body(sx, sy, zs)
                nzv = zs / lp                       # cosine of the view angle
                lum = (sx / lp) * lx + (sy / lp) * ly + nzv * lz
                if lum < 0:
                    lum = 0.0
                byc = clamp(by, -1.0, 1.0)
                alb = tex(b, bx, byc, bz, math.asin(byc), math.atan2(bz, bx))
                sphere = alb * (amb + (1 - amb) * lum * (0.45 + 0.55 * lum))
                sphere *= (0.58 + 0.42 * nzv) * gain      # limb darkening

            ring_lum, cov, zr = 0.0, 0.0, -1e9
            if ring is not None and abs(nz) > 0.05:
                # A translucent sheet, not a solid surface: a faint band
                # crossing in front of the planet composites over it.
                r_in, r_out, gaps = ring
                zr = -(nx * sx + ny * sy) / nz
                rr = sqrt(d2 + zr * zr)
                if r_in <= rr <= r_out and not any(a < rr < bb for a, bb in gaps):
                    t = (rr - r_in) / (r_out - r_in)
                    cov = (0.55 + 0.45 * math.sin(t * 8.2)) * (1 - 0.45 * t)
                    # Inner material shears ahead of outer on a Keplerian
                    # profile. Without it the rings are radially symmetric and
                    # look frozen at every angle.
                    au = sx * ux + sy * uy + zr * uz
                    av = sx * vx + sy * vy + zr * vz
                    phi = math.atan2(av, au) - angle * (rr ** -1.5) * 1.7
                    cov *= 0.70 + 0.30 * (0.62 * math.sin(phi * 2.0 + 0.4)
                                          + 0.38 * math.sin(phi * 5.0 - 1.1))
                    cov = clamp(cov, 0.0, 1.0) * (0.55 + 0.45 * (1 - abs(nz)))
                    ring_lum = 0.88 * gain
                    ql = sx * lx + sy * ly + zr * lz          # planet shadow
                    if ql < 0:
                        px, py, pz = sx - ql * lx, sy - ql * ly, zr - ql * lz
                        if px * px + py * py + pz * pz < 1:
                            ring_lum *= 0.16

            back = sphere if sphere >= 0 else 0.0
            if cov > 0 and (d2 > 1 or zr > zs):
                v = ring_lum * cov + back * (1 - cov)
            else:
                v = back
            # int(x + 0.5), not round(): Python rounds half to even and would
            # pick a different glyph than the JavaScript original.
            line.append(ramp[int(clamp(v, 0.0, 1.0) * last + 0.5)])
        out.append("".join(line))
    return "\n".join(out)
