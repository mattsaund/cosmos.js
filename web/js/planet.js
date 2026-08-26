/* ============================================================
   cosmos.js : ASCII planet renderer

   No images and no pre-baked frames. Every glyph is a ray cast at
   a body, shaded from a real lighting model, and quantised onto a
   density ramp. The same maths runs three times over in this
   project: here for the live preview, and again in the JavaScript
   and Python that emit.js writes out. Change the algorithm here
   and the emitters have to follow, or the exports stop matching
   what the preview shows.

   Pure computation: nothing in this file touches the DOM.

   ------------------------------------------------------------
   HOW A FRAME HAPPENS

     build(cfg)     Run once, when a setting changes. Scatters the
                    craters, fractures and lumps out of the seed,
                    measures how much sky the body needs, and picks
                    a column count that keeps the disk round.
                    Hands back a "body": everything render() needs.

     render(b, a)   Run once per animation frame, at spin angle a.
                    For every glyph in the grid: fire a ray, find
                    where it meets the surface, light that point,
                    ask the texture how bright the ground is there,
                    composite the rings over it, and round the
                    answer onto a character.

   THE THREE SPACES
   Every x/y/z below lives in one of these, and mixing them up is
   the easiest way to break this file.

     screen  sx, sy      the glyph grid, measured in body radii.
                         sx runs right, sy runs up, centre is 0, 0.
     view    x, y, z     the camera's frame: +z points at you, so
                         the light and the silhouette live here.
     body    bx, by, bz  bolted to the planet, so it turns and they
                         do not. Craters are stored here, which is
                         exactly why they rotate with the surface
                         instead of sliding across it.

   NAMES THAT KEEP COMING BACK
     b            a built body, i.e. whatever build() returned
     cfg / c      the settings object
     la, lo       latitude and longitude on the body, in radians
     nx, ny, nz   the spin axis, in view space
     u*, v*       two axes across the equator, square to that axis
     d            almost always a dot product

   IN THIS FILE
     ramp and aspect .. the characters, and the shape of a text cell
     small maths ...... clamp, unit, rng
     scatter .......... seed -> craters, fractures, lumps
     textures ......... five surfaces, one albedo function each
     config ........... defaults() and build()
     shape ............ radius(), what makes a body non-spherical
     render ........... the per-glyph loop
   ============================================================ */
var Cosmos = (function () {
  'use strict';

  /* --- ramp and aspect -------------------------------------- */

  /* Bourke's 10-level ramp. Ink density rises monotonically, which the
     obvious-looking ".,:;=+ic*ox%#@" does not: 'i' and 'c' read lighter than
     '=' and '+', so gradients come out mottled. Index 0 is a space, which
     gives the empty-sky threshold for free. */
  var RAMP = ' .:-=+*#%@';

  /* Glyph advance divided by line height. A character cell is taller than it
     is wide, so a disk drawn on a square grid of them comes out an egg; every
     column count is derived through this to keep it round. 0.6 is the usual
     ratio, but which monospace font actually resolves decides it, so the app
     measures the real one at boot and calls setAspect. */
  var CHAR_ASPECT = 0.6;

  /* Called by the app once it has measured the font the browser actually
     resolved. Ratios outside the range any real monospace font occupies are
     dropped on the floor: a probe taken before the font has loaded can report
     nonsense, and a bad ratio here surfaces as a badly stretched planet rather
     than as an error anyone would notice. */
  function setAspect(v) { if (v > 0.2 && v < 1.2) CHAR_ASPECT = v; }

  /* --- small maths ---------------------------------------- */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* Scale a vector to length 1. The `|| 1` is a guard, not a rounding trick:
     without it a zero-length vector turns the whole frame into NaN, which
     draws as a solid block of one character. */
  function unit(x, y, z) {
    var m = Math.sqrt(x * x + y * y + z * z) || 1;
    return [x / m, y / m, z / m];
  }

  /* Deterministic PRNG, so a given seed always draws the same craters. A
     linear congruential generator is more than enough for scattering points
     and keeps the Python port trivial. */
  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /* --- scatter: seed -> surface features -------------------- *
     Three ways of sprinkling something over a sphere, all drawing on the same
     seeded PRNG, so the same seed always gives back the same planet. Each
     returns a plain array that the textures (or radius()) then read once per
     glyph, which is why the shapes below are chosen for cheap lookups rather
     than for being pleasant to read. */

  /* Round patches: craters, maria, hot pools. Each one is

       x, y, z   unit vector from the centre of the body to the middle of the
                 patch, in body space
       c         cos(radius), so testing a point costs one dot product:
                 dot > c means the point is inside the patch
       rim       cos(radius * 0.7), the same test for the inner 70%. So a point
                 with dot > c but dot < rim is in the outer third: the wall of
                 a crater, and the reason craters read as craters at all.

     Mind the sense of it. A BIGGER dot product means CLOSER to the middle of
     the patch, so the comparisons over in the textures look inside out until
     that clicks. */
  function features(seed, n, rMin, rSpan) {
    var r = rng(seed), out = [], i;
    for (i = 0; i < n; i++) {
      var y = r() * 2 - 1;
      var ph = r() * Math.PI * 2;
      var s = Math.sqrt(Math.max(0, 1 - y * y));
      var rad = rMin + r() * rSpan;
      out.push({
        x: s * Math.cos(ph), y: y, z: s * Math.sin(ph),
        c: Math.cos(rad), rim: Math.cos(rad * 0.7)
      });
    }
    return out;
  }

  /* Lines that go all the way round: fractures on ice, fissures on lava.

     A plane through the centre cuts the sphere in a great circle, so
     |dot(p, n)| is the angular distance from that line. Gives a feature that
     wraps the whole body, which no blob can do. `w` is the half-width in those
     same units, so a point is on the line when |dot| < w. */
  function circles(seed, n, wMin, wSpan) {
    var r = rng(seed), out = [], i;
    for (i = 0; i < n; i++) {
      var y = r() * 2 - 1;
      var ph = r() * Math.PI * 2;
      var s = Math.sqrt(Math.max(0, 1 - y * y));
      out.push({
        x: s * Math.cos(ph), y: y, z: s * Math.sin(ph),
        w: wMin + r() * wSpan
      });
    }
    return out;
  }

  /* Lobes for an irregular body. Amplitudes are signed so the shape dents as
     well as bulges. Unlike the two above, these are not read by the textures:
     radius() uses them to move the surface itself, and `a` is how far, in body
     radii. */
  function lobes(seed, n, aMin, aSpan, negChance) {
    var r = rng(seed), out = [], i;
    for (i = 0; i < n; i++) {
      var y = r() * 2 - 1;
      var ph = r() * Math.PI * 2;
      var c = Math.sqrt(Math.max(0, 1 - y * y));
      out.push({
        x: c * Math.cos(ph), y: y, z: c * Math.sin(ph),
        a: (aMin + r() * aSpan) * (r() < negChance ? -1 : 1)
      });
    }
    return out;
  }

  /* --- textures -------------------------------------------- *
     The colour of the ground, before any light reaches it.

     Each takes a body-frame unit vector plus the latitude and longitude
     already derived from it, and returns an albedo around 1.0, where 1.0 is
     plain grey ground; render() multiplies the lighting by whatever comes
     back. Anything under ~0.14 rad across lands inside a single glyph and
     reads as noise rather than as a feature, which is what sets the floors
     below.

     The clamp at the end of each one is not tidying up. Enough overlapping
     features will push the albedo negative or well past the top of the ramp,
     and either of those comes out as a flat slab of a single character.

     Adding a texture means adding it in five other places as well; the
     checklist is at the top of emit.js. */

  var TEXTURES = {
    /* An icy moon: bright, fractured, with dark chaos terrain between. */
    ice: function (b, bx, by, bz, la, lo) {
      var a = 1.00, i, c, d;
      for (i = 0; i < b.maria.length; i++) {          // chaos terrain
        c = b.maria[i];
        d = bx * c.x + by * c.y + bz * c.z;
        if (d > c.c) a -= 0.16 * (d - c.c) / (1 - c.c);
      }
      for (i = 0; i < b.cracks.length; i++) {         // fractures
        c = b.cracks[i];
        d = Math.abs(bx * c.x + by * c.y + bz * c.z);
        if (d < c.w) a -= 0.60 * (1 - 0.45 * d / c.w);
        else if (d < c.w * 1.8) a += 0.14 * (1 - (d - c.w) / (c.w * 0.8));
      }
      for (i = 0; i < b.craters.length; i++) {        // fresh impacts
        c = b.craters[i];
        d = bx * c.x + by * c.y + bz * c.z;
        if (d > c.c) a += 0.26 * (d - c.c) / (1 - c.c);
      }
      a += 0.03 * Math.sin(lo * 8.0 + la * 5.0);
      return clamp(a, 0.10, 1.22);
    },

    /* A banded giant, with one long-lived storm below the equator. */
    gas: function (b, bx, by, bz, la, lo) {
      /* Latitude bands alone are rotation-invariant: the body would turn and
         look completely still. The longitudinal terms are what make the spin
         legible. */
      var a = 0.80 + 0.17 * Math.sin(la * 12.5)
                   + 0.10 * Math.sin(la * 5.5 + 0.8)
                   + 0.14 * Math.sin(lo * 4.0 + la * 14.0)     // festoons
                   + 0.07 * Math.sin(lo * 7.0 - la * 9.0);     // turbulence
      var dl = wrapPi(lo - 0.7) * 0.62, dla = (la + 0.33) * 1.9;   // the storm
      var d = Math.sqrt(dl * dl + dla * dla);
      if (d < 0.42) a *= 0.50 + 0.36 * (d / 0.42);
      return clamp(a, 0.12, 1.15);
    },

    /* A dry world: soft dune tones, dark basins, bright polar caps. */
    desert: function (b, bx, by, bz, la, lo) {
      var a = 0.78 + 0.09 * Math.sin(lo * 3.4 + la * 2.1)
                   + 0.06 * Math.sin(la * 6.3 - lo * 1.7);
      for (var i = 0; i < b.maria.length; i++) {
        var c = b.maria[i], d = bx * c.x + by * c.y + bz * c.z;
        if (d > c.c) a -= 0.24 * (d - c.c) / (1 - c.c);
      }
      var p = Math.abs(la);                                    // polar caps
      if (p > 1.16) a = 1.20;
      else if (p > 0.99) a += 0.42 * (p - 0.99) / 0.17;
      return clamp(a, 0.15, 1.20);
    },

    /* Mostly dark crust, lit from within along the fissures. */
    lava: function (b, bx, by, bz, la, lo) {
      var a = 0.26, i, c, d;
      for (i = 0; i < b.cracks.length; i++) {         // glowing fissures
        c = b.cracks[i];
        d = Math.abs(bx * c.x + by * c.y + bz * c.z);
        if (d < c.w * 2.4) a += 0.90 * (1 - d / (c.w * 2.4));
      }
      for (i = 0; i < b.craters.length; i++) {        // hot pools
        c = b.craters[i];
        d = bx * c.x + by * c.y + bz * c.z;
        if (d > c.c) a += 0.55 * (d - c.c) / (1 - c.c);
      }
      a += 0.05 * Math.sin(lo * 9.0 + la * 6.0);
      return clamp(a, 0.05, 1.30);
    },

    /* A plain rocky body: gently mottled, lightly cratered. The default, the
       fallback for a name that is not here, and the quietest of the five.
       Craters are the crater count slider's job on this one, rather than a
       texture of their own. */
    rock: function (b, bx, by, bz, la, lo) {
      var a = 0.72 + 0.10 * Math.sin(lo * 6.0 + la * 4.0)
                   + 0.06 * Math.sin(lo * 13.0 - la * 7.0);
      for (var i = 0; i < b.craters.length; i++) {
        var c = b.craters[i], d = bx * c.x + by * c.y + bz * c.z;
        if (d > c.c) a += (d < c.rim) ? 0.16 : -0.20;
      }
      return clamp(a, 0.10, 1.10);
    }
  };

  /* Fold an angle back into -pi..pi. Longitude wraps, so the distance to the
     storm above has to be measured across the seam rather than the long way
     round the planet. */
  function wrapPi(x) {
    while (x > Math.PI) x -= 2 * Math.PI;
    while (x < -Math.PI) x += 2 * Math.PI;
    return x;
  }

  /* --- config ---------------------------------------------- */

  /* The opening planet, and the complete list of settings the renderer
     honours. app.js builds its sliders against these keys and emit.js reads
     the same object, so a new setting starts here and nowhere else. */
  function defaults() {
    return {
      texture:   'rock',
      rows:      24,        // glyph rows; columns follow from CHAR_ASPECT
      size:      14,        // preview font size in px, ignored by the maths
      brightness: 1.00,     // multiplies the shaded result
      ambient:   0.16,      // light on the night side
      craters:   15,
      speed:     0.09,      // radians per second
      direction: 1,         // 1 or -1
      lumpiness: 0.00,      // 0 is a perfect sphere
      tilt:      0.30,
      roll:      0.10,
      rings:     false,
      ringInner: 1.30,
      ringOuter: 2.30,
      color:     '#ffffff',
      seed:      20260823
    };
  }

  /* Everything derived from a config once, so the per-glyph loop below never
     allocates or re-seeds. Call this when settings change, not per frame.

     What comes back, and who reads it:

       tex, amb, gain             the shading; read at every glyph
       rows, cols                 the size of the character grid
       extX, extY                 how much sky the frame covers, in body radii
       max                        bounding radius, for the ray search
       rock                       true if the body is lumpy enough to need
                                  that search at all
       craters, maria, cracks     feature tables, read by the textures
       shape, facets, knobs       deformation lobes, read by radius()
       elong                      how far the body is stretched along bx
       rings                      ring geometry, or null */
  function build(cfg) {
    var c = cfg || defaults();
    var lump = c.lumpiness || 0;
    var b = {
      cfg:     c,
      tex:     TEXTURES[c.texture] || TEXTURES.rock,
      rows:    Math.max(6, Math.round(c.rows)),
      amb:     c.ambient,
      gain:    c.brightness,
      tilt:    c.tilt,
      roll:    c.roll,
      rock:    lump > 0.001,
      craters: features(c.seed, Math.max(0, Math.round(c.craters)), 0.15, 0.20),
      maria:   features(c.seed ^ 0x9E3779B9, 5, 0.40, 0.26),
      /* Note: cracks and shape below are derived from the same constant, so on
         a lumpy ice body the first fracture and the first lobe point the same
         way. Worth knowing before trusting them to be independent. Changing it
         would repaint every planet anyone has already saved a seed for. */
      cracks:  circles(c.seed ^ 0x51F0AA, 8, 0.046, 0.042),
      rings:   c.rings ? { inner: c.ringInner, outer: c.ringOuter,
                           gaps: [[1.68, 1.78], [2.04, 2.09]] } : null
    };

    /* Three scales of deformation, all generated from the seed. Hand-picking
       amplitudes was the trap here: one broad lobe well above its neighbours
       reads as a spike rather than as terrain. */
    b.shape  = lobes(c.seed ^ 0x51F0AA, 5,  0.105 * lump, 0.075 * lump, 0.50);
    b.facets = lobes(c.seed ^ 0xA33C17, 14, 0.034 * lump, 0.042 * lump, 0.45);
    b.knobs  = lobes(c.seed ^ 0xB0C1D2, 24, 0.018 * lump, 0.036 * lump, 0.45);
    b.elong  = 0.24 * lump;

    /* The frame has to cover the body at its widest. Measured over a spread of
       directions rather than summed analytically: the lobes cannot all peak
       the same way, so the analytic worst case is far too generous and would
       leave the body swimming in empty margin. */
    b.max = 1;
    if (b.rock) {
      var m = 0, i, ga = Math.PI * (3 - Math.sqrt(5));
      for (i = 0; i < 800; i++) {
        var y = 1 - 2 * (i + 0.5) / 800;
        var r = Math.sqrt(Math.max(0, 1 - y * y)), th = ga * i;
        var rr = radius(b, r * Math.cos(th), y, r * Math.sin(th));
        if (rr > m) m = rr;
      }
      b.max = m * 1.05;
    }
    /* How far the body reaches along each screen axis, worked out separately:
       a tilted ring system is wide and flat, and forcing a square frame around
       it leaves the body swimming in empty sky above and below.

       The rings lie in the plane perpendicular to the body's axis n, and
       {u, v, n} is orthonormal, so a ring of radius r projects onto a screen
       axis to exactly r * sqrt(1 - n_axis^2). Deriving the vertical extent from
       tilt alone was the bug behind rings cut off top and bottom: roll turns the
       axis within the view plane, so a rolled body at shallow tilt has rings
       reaching nearly the full radius vertically, where the old formula
       expected almost none of it. */
    var axisX = -Math.sin(c.roll) * Math.cos(c.tilt);
    var axisY = Math.cos(c.roll) * Math.cos(c.tilt);
    var ringX = b.rings ? c.ringOuter * Math.sqrt(Math.max(0, 1 - axisX * axisX)) : 0;
    var ringY = b.rings ? c.ringOuter * Math.sqrt(Math.max(0, 1 - axisY * axisY)) : 0;
    var MARGIN = 1.03;                    // a little air so nothing meets the edge
    b.extX = Math.max(b.max, ringX) * MARGIN;
    b.extY = Math.max(b.max, ringY) * MARGIN;
    /* Columns follow from the frame's aspect and the glyph's, so the disk comes
       out round rather than as an egg. */
    b.cols = Math.max(8, Math.round(b.rows * (b.extX / b.extY) / CHAR_ASPECT));
    return b;
  }

  /* --- shape ----------------------------------------------- */

  /* Direction-varying radius: how far the surface sits from the centre when
     looking in direction (bx, by, bz). 1 is a sphere, and a smooth body short
     circuits to exactly that.

     The lobes live in BODY space, which is the whole point: rotating the body
     rotates the lumps, and that is what makes an asteroid read as an asteroid
     rather than a sphere wearing a moving texture. Powers are done by
     multiplication; Math.pow here would run a million times per redraw. */
  function radius(b, bx, by, bz) {
    if (!b.rock) return 1;
    var r = 1 + b.elong * (bx * bx - 0.34);
    var i, L, d, d2, d3;
    for (i = 0; i < b.shape.length; i++) {          // signed, gentle: silhouette
      L = b.shape[i]; d = bx * L.x + by * L.y + bz * L.z;
      r += L.a * d * d * d;
    }
    for (i = 0; i < b.facets.length; i++) {         // one-sided: flats and edges
      L = b.facets[i]; d = bx * L.x + by * L.y + bz * L.z;
      if (d > 0) { d2 = d * d; r += L.a * d2 * d2 * d; }
    }
    for (i = 0; i < b.knobs.length; i++) {          // tight: knobs and pits
      L = b.knobs[i]; d = bx * L.x + by * L.y + bz * L.z;
      if (d > 0) { d3 = d * d * d; r += L.a * d3 * d3 * d3; }
    }
    return r;
  }

  /* One fixed light, in VIEW space, so it stays put while the body turns
     under it. emit.js bakes these three numbers into both exports, so there is
     one definition of the light rather than three. */
  var LIGHT = unit(-0.60, 0.40, 0.69);   // key light, upper left, toward viewer

  /* --- render ---------------------------------------------- */

  /* One frame of body `b`, turned to `angle` radians. Comes back as rows of
     glyphs joined by newlines, with no trailing newline: exactly what a <pre>
     wants. Nothing is kept between calls apart from the body itself, so frames
     can be drawn in any order, which is what makes scrubbing and the --once
     exports work.

     The whole function is one pass over the grid. Everything before the loop
     is setup that would otherwise be recomputed at every glyph. */
  function render(b, angle) {
    var W = b.cols, H = b.rows, extX = b.extX, extY = b.extY;
    var lastIdx = RAMP.length - 1;

    /* Setup 1: the spin axis, in view space. Tilt leans the pole toward or
       away from the viewer; roll turns it within the plane of the screen. */
    var ct = Math.cos(b.tilt), st = Math.sin(b.tilt);
    var nx = -Math.sin(b.roll) * ct, ny = Math.cos(b.roll) * ct, nz = st;

    /* Setup 2: two more axes to finish the frame, both lying across the
       equator. h is any direction that is not parallel to the axis, and the
       cross products turn it into a clean perpendicular pair. The swap when
       the axis is near +z is that "not parallel" clause earning its keep:
       crossing a vector with itself leaves nothing to normalise. */
    var hx = 0, hy = 0, hz = 1;
    if (Math.abs(nz) > 0.9) { hx = 1; hz = 0; }
    var ux = hy * nz - hz * ny, uy = hz * nx - hx * nz, uz = hx * ny - hy * nx;
    var um = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    ux /= um; uy /= um; uz /= um;
    var vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;

    /* Setup 3: everything else the inner loop would otherwise re-read. */
    var ca = Math.cos(angle), sa = Math.sin(angle);
    var lx = LIGHT[0], ly = LIGHT[1], lz = LIGHT[2];
    var rings = b.rings, gaps = rings ? rings.gaps : null;

    /* View space -> body space, and the single busiest function in the
       project. It writes the direction into _bx/_by/_bz and RETURNS the
       distance from the centre, because the ray search needs both and handing
       back a pair would allocate an object per bisection step.

       Scratch rather than a returned array: this runs once per bisection step
       per cell, and allocating there would be all GC and no work. */
    var _bx = 0, _by = 0, _bz = 0;
    function toBody(px, py, pz) {
      var L = Math.sqrt(px * px + py * py + pz * pz) || 1;
      var ax = px / L, ay = py / L, az = pz / L;
      _by = ax * nx + ay * ny + az * nz;
      var b0 = ax * ux + ay * uy + az * uz;
      var b1 = ax * vx + ay * vy + az * vz;
      _bx = b0 * ca + b1 * sa;
      _bz = b1 * ca - b0 * sa;
      return L;
    }

    /* One pass over the grid. Rows run down the screen but up the frame, hence
       the 1 - ... in sy; the + 0.5 aims the ray at the middle of the cell
       rather than its corner. */
    var out = new Array(H), i, j;
    for (j = 0; j < H; j++) {
      var line = new Array(W);
      var sy = (1 - 2 * (j + 0.5) / H) * extY;

      for (i = 0; i < W; i++) {
        var sx = (2 * (i + 0.5) / W - 1) * extX;
        var d2 = sx * sx + sy * sy;    // squared distance from the centre

        /* ---- lit surface ----
           How far along the ray the body is, if it is there at all. zs is that
           depth, and -1e9 stands in for "nothing here", so the ring test
           further down can compare against it without a special case. */
        var sphere = -1, zs = -1e9, hit = false;
        if (b.rock) {
          /* Bisect down the ray: hi starts outside the bounding sphere, lo at
             the z=0 plane. Newton would take fewer steps but blows up near the
             silhouette where the surface is edge-on; bisection just works. */
          var hi = b.max * b.max - d2;
          if (hi > 0) {
            hi = Math.sqrt(hi);
            var lo = 0;
            if (toBody(sx, sy, 0) < radius(b, _bx, _by, _bz)) {
              for (var k = 0; k < 9; k++) {
                var mid = (lo + hi) * 0.5;
                if (toBody(sx, sy, mid) < radius(b, _bx, _by, _bz)) lo = mid;
                else hi = mid;
              }
              zs = lo; hit = true;
            }
          }
        } else if (d2 <= 1) {
          zs = Math.sqrt(1 - d2); hit = true;
        }

        if (hit) {
          var Lp = toBody(sx, sy, zs);
          var nzv = zs / Lp;                        // cosine of the view angle
          var lum = (sx / Lp) * lx + (sy / Lp) * ly + nzv * lz;
          if (lum < 0) lum = 0;                     // turned away from the light
          /* Rounding can hand back 1.0000000001 for a unit vector, and asin of
             that is NaN, which paints as a hole in the planet. */
          var by = clamp(_by, -1, 1);
          var alb = b.tex(b, _bx, by, _bz, Math.asin(by), Math.atan2(_bz, _bx));
          /* Lambert, softened. Straight cosine falls off far too fast for ten
             shades: the terminator lands inside two or three characters and
             the body reads as a paper cut-out. The (0.45 + 0.55 * lum) term
             pulls the midtones apart again so the ramp has something to spend
             its steps on. */
          sphere = alb * (b.amb + (1 - b.amb) * lum * (0.45 + 0.55 * lum));
          sphere *= (0.58 + 0.42 * nzv) * b.gain;   // limb darkening
        }

        /* ---- ring plane ----
           A translucent sheet, not a solid surface: a faint band crossing in
           front of the planet has to composite over it, not replace it. */
        var ringLum = 0, cov = 0, zr = -1e9;
        /* Rings seen dead edge-on are a plane containing the viewer: there is
           no sheet left to hit, and the division below would blow up. Skip. */
        if (rings && Math.abs(nz) > 0.05) {
          zr = -(nx * sx + ny * sy) / nz;
          var rr = Math.sqrt(d2 + zr * zr);
          if (rr >= rings.inner && rr <= rings.outer) {
            var open = true;
            for (var g = 0; g < gaps.length; g++) {
              if (rr > gaps[g][0] && rr < gaps[g][1]) { open = false; break; }
            }
            if (open) {
              var t = (rr - rings.inner) / (rings.outer - rings.inner);
              cov = (0.55 + 0.45 * Math.sin(t * 8.2)) * (1 - 0.45 * t);

              /* Azimuth measured in the rotating frame. Inner material shears
                 ahead of outer on a Keplerian profile, so the density clumps
                 wind up as the body turns. Without this the rings are
                 radially symmetric and look frozen at every angle. */
              var au = sx * ux + sy * uy + zr * uz;
              var av = sx * vx + sy * vy + zr * vz;
              var phi = Math.atan2(av, au) - angle * Math.pow(rr, -1.5) * 1.7;
              cov *= 0.70 + 0.30 * (0.62 * Math.sin(phi * 2.0 + 0.4)
                                  + 0.38 * Math.sin(phi * 5.0 - 1.1));
              cov = clamp(cov, 0, 1) * (0.55 + 0.45 * (1 - Math.abs(nz)));
              ringLum = 0.88 * b.gain;

              /* The planet's own shadow falling across the rings. */
              var qL = sx * lx + sy * ly + zr * lz;
              if (qL < 0) {
                var px = sx - qL * lx, py = sy - qL * ly, pz = zr - qL * lz;
                if (px * px + py * py + pz * pz < 1) ringLum *= 0.16;
              }
            }
          }
        }

        /* ---- depth resolve ----
           Only two things can be under this glyph, and the ring wins when
           there is ring here at all and it is not hiding behind the planet.
           Even then it lets the surface through, in proportion to how thin the
           ring happens to be at that radius. */
        var back = sphere >= 0 ? sphere : 0;
        var v = (cov > 0 && (d2 > 1 || zr > zs))
              ? ringLum * cov + back * (1 - cov)
              : back;
        /* And this is the line the whole file exists for: a brightness in
           0..1 becomes one of ten characters. Index 0 is a space, so empty sky
           falls out of the same expression. */
        line[i] = RAMP.charAt(Math.round(clamp(v, 0, 1) * lastIdx));
      }
      out[j] = line.join('');
    }
    return out.join('\n');
  }

  /* What the rest of the app can see. RAMP and LIGHT are out here because
     emit.js bakes them into the generated source: one definition, three
     programs. TEXTURES is exposed so the five names can be listed without
     hard-coding them somewhere else. */
  return {
    RAMP: RAMP,
    LIGHT: LIGHT,
    setAspect: setAspect,
    aspect: function () { return CHAR_ASPECT; },
    TEXTURES: TEXTURES,
    defaults: defaults,
    build: build,
    render: render
  };
})();
