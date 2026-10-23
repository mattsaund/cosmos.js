/* ============================================================
   cosmos.js : app

   Wires the controls to the renderer and to the code emitters.

   The control list is a single spec, and every control names the
   config key it writes. Adding a knob means adding one entry here,
   not touching the HTML, the render call and the exporters
   separately and hoping they agree.

   ------------------------------------------------------------
   WHAT HAPPENS WHEN A SLIDER MOVES

     the control's handler writes cfg[key], then calls changed():
       -> sync()       pushes cfg back out to every control: the
                       readouts, the rows that hide themselves, any
                       value it had to nudge to stay sensible
       -> rebuild()    body = Cosmos.build(cfg, grid), then:
            paint()    draw one frame into the <pre>
            code()     re-emit both source panes

   Spin, direction, rotation speed and color skip rebuild(), because
   build() never reads them: the body they would rebuild is the one
   already there. They carry `keepBody: true` in SPEC. Font size
   does not: it decides how many rows the grid has, and that is a
   different body.

   While the planet spins, tick() runs on requestAnimationFrame,
   moves the angle on by however much real time has passed, and
   calls paint() as often as the motion needs and the machine can
   comfortably afford. With spin off the loop stops altogether.

   cfg is the single source of truth. Everything on the page is
   derived from it, never the other way round, which is why sync()
   only ever pushes outward.

   IN THIS FILE
     font probe ...... measures the glyph shape the browser picked
     SPEC ............ every control, as one list of data
     build ........... turns SPEC into DOM
     sync ............ cfg -> controls
     render loop ..... rebuild, sizing, pacing, paint, tick
     highlight ....... a small tokenizer for the two source panes
     code panes ...... emit and tab switching
     copy ............ the clipboard helper, shared by both buttons
     screenshot ...... the same frame, drawn into a 4K PNG
     buttons ......... randomize and reset
     console hook .... window.__cosmos
     handshake ....... the ping that keeps cosmos.py alive
     go .............. first paint
   ============================================================ */
(function () {
  'use strict';

  /* --- font probe ------------------------------------------- */

  /* The glyph's advance decides the column count, and the disk is only round
     if that count is derived from the real one. Measure it off a throwaway
     <pre> rather than trusting the usual 0.6.

     The stack named here has to be the stack the planet is drawn in, or the
     grid gets cut for a glyph nobody is looking at. Returns 0 if the page is
     not far enough along to measure, which setAspect then ignores. */
  var FONT = '"Paper Mono", monospace';
  function measureAspect() {
    var probe = document.createElement('pre');
    probe.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;top:0;' +
                          'font:100px/1 ' + FONT + ';white-space:pre;margin:0';
    probe.textContent = new Array(41).join('M');          // 40 glyphs
    document.body.appendChild(probe);
    var w = probe.getBoundingClientRect().width / 40;
    document.body.removeChild(probe);
    return w > 0 ? w / 100 : 0;
  }
  Cosmos.setAspect(measureAspect());

  var cfg = Cosmos.defaults();
  var body = null;   // what Cosmos.build made of cfg; rebuild() keeps it current

  /* --- SPEC: every control, as data ------------------------- *
     In page order. One entry is one row of the controls panel.

       key       the cfg property it writes; also what `when` refers to
       name      the row's caption: above the control, or beside it for a
                 check or the color swatch
       type      range | select | check | color | seg | number
       min, max  the real range a range control spans. The page shows 0 to
                 100 and fromSlider maps the position onto this, unless:
       real      the slider carries its own value rather than a position, for
                 the two settings whose numbers mean something on sight: a
                 font size in px and a count of craters. A brightness of 1.35
                 does not read as anything, so it stays a position
       fmt       how a real slider or a number box reads out
       invert    the slider runs backward against the value it writes
       keepBody  build() never reads this setting, so changing it skips
                 the rebuild, see changed()
       when      only show this row while cfg[when] is truthy

     Adding a knob is one entry here plus one key in Cosmos.defaults().
     Nothing else in this file has to learn about it. */
  var SPEC = [
    { key: 'texture', name: 'texture', type: 'select', options: [
        ['rock', 'rock'], ['ice', 'ice'],
        ['gas', 'gas giant'], ['lava', 'lava'], ['desert', 'desert']
      ] },
    /* Glyph height, and so the resolution as well: the grid always fills the
       panel, so a smaller glyph is simply more of them. rebuild() turns this
       into a row count, and the number on the slider is the height in pixels
       a character actually gets. */
    { key: 'size', name: 'font size', type: 'range', min: 4, max: 40, real: true,
      fmt: function (v) { return Math.round(v) + ' px'; } },
    /* How much of the panel the body fills, from a speck to the whole thing.
       It stops at 1 on purpose: past that the planet would run off its own
       frame and get cut, and the frame is the picture. Unlike font size this
       changes no character counts at all, only how much sky each one covers,
       and it rides into both exports through EXT_X and EXT_Y. */
    { key: 'zoom', name: 'zoom', type: 'range', min: 0.08, max: 1 },
    /* The top of this range is well past the point where the lit side starts
       clipping to a solid block of '@'. That is deliberate: a blown out planet
       is a look, and the ramp only has ten steps to lose. */
    { key: 'brightness', name: 'brightness', type: 'range', min: 0.35, max: 3 },
    /* Writes ambient light, but reads as its opposite: more shadow is less
       light on the night side. See toSlider/fromSlider. */
    { key: 'ambient', name: 'shadow', type: 'range', min: 0, max: 0.6, invert: true },
    { key: 'craters', name: 'crater count', type: 'range', min: 0, max: 45, real: true },
    { key: 'lumpiness', name: 'lumpiness', type: 'range', min: 0, max: 1.4 },
    { key: 'tilt', name: 'tilt', type: 'range', min: -1.3, max: 1.3 },
    { key: 'roll', name: 'roll', type: 'range', min: -1.6, max: 1.6 },
    { key: 'rings', name: 'rings', type: 'check' },
    { key: 'ringInner', name: 'ring inner', type: 'range', min: 1.05, max: 2.4, when: 'rings' },
    { key: 'ringOuter', name: 'ring outer', type: 'range', min: 1.1, max: 3.2, when: 'rings' },
    /* Preview only. The exports always animate, whatever this says: unchecking
       it parks the angle where it is, which is what you want while dialing in
       a texture or lining up a frame to copy. The two controls it hides do
       reach the exports, so a parked preview still exports a spinning planet
       at the speed and direction last set here. */
    { key: 'spin', name: 'spin', type: 'check', keepBody: true },
    { key: 'direction', name: 'direction', type: 'seg', when: 'spin', keepBody: true,
      options: [[-1, 'clockwise'], [1, 'counterclockwise']] },
    { key: 'speed', name: 'rotation speed', type: 'range', min: 0, max: 0.6, when: 'spin',
      keepBody: true },
    { key: 'color', name: 'color', type: 'color', keepBody: true },
    /* A number box, so it carries the value itself, never a 0 to 100
       position. The top is the PRNG's own: seeds are read as unsigned 32 bit,
       so anything past it would just wrap round to a smaller one. */
    { key: 'seed', name: 'seed', type: 'number', min: 0, max: 4294967295, step: 1,
      fmt: function (v) { return String(Math.round(v)); } }
  ];

  /* Every slider runs 0 to 100 whatever it actually writes, so the controls
     column reads as one set of dials rather than as eleven unrelated number
     lines. The real range lives in SPEC and never reaches the page: these two
     functions are the only place the two scales meet, which is what keeps the
     handler, the readout and the opening position from disagreeing.

     `invert` still flips the direction, for the one slider that reads as the
     opposite of the value it writes. */
  var SLIDER_MAX = 100;

  function toSlider(c, v) {
    if (c.real) return Math.round(v);                   // carries its own value
    var t = (v - c.min) / (c.max - c.min);              // real value as 0..1
    if (c.invert) t = 1 - t;
    return Math.round(clamp01(t) * SLIDER_MAX);
  }

  function fromSlider(c, p) {
    if (c.real) return p;
    var t = clamp01(p / SLIDER_MAX);
    if (c.invert) t = 1 - t;
    return tidy(c.min + t * (c.max - c.min));
  }

  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }

  /* Rounded to six places, far finer than one step of any slider. Both
     exports write each setting out digit for digit (see n() in emit.js),
     and this is what keeps that to 0.182 rather than 0.18200000000000016. */
  function tidy(v) { return Math.round(v * 1e6) / 1e6; }

  var host = document.getElementById('controls');
  var out = document.getElementById('out');
  var stage = document.querySelector('.stage');
  var dims = document.getElementById('dims');
  /* key -> { input, val, wrap, spec }, filled in as the controls are built, so
     sync() can find every piece of a row again without another DOM query.
     val is null on an inline row, a check or the color swatch, which has no
     readout. */
  var nodes = {};

  /* --- build the controls ----------------------------------- *
     One pass over SPEC, building each row as: a label line with the name and
     the live readout, then whatever input the type calls for, then the
     listener that writes back into cfg. The handlers differ only in which
     event they listen for and how much work the change costs.

     Checkboxes and the color swatch break that layout. They are small enough
     to carry their name beside them, like a form label, and they show their
     own value, so they skip the label line entirely. */
  SPEC.forEach(function (c) {
    var wrap = document.createElement('div');
    wrap.className = 'ctl';
    wrap.dataset.key = c.key;

    var inline = c.type === 'check' || c.type === 'color';

    /* The label line: the name on the left, the live readout on the right. */
    var val = null;
    if (!inline) {
      var top = document.createElement('div');
      top.className = 'ctl__top';
      var name = document.createElement('span');
      name.className = 'ctl__name';
      name.textContent = c.name;
      val = document.createElement('span');
      val.className = 'ctl__val';
      top.appendChild(name);
      top.appendChild(val);
      wrap.appendChild(top);
    }

    var input;
    if (c.type === 'range') {
      input = document.createElement('input');
      input.type = 'range';
      /* 0 to 100 on the page, and fromSlider turns the position back into
         whatever the renderer wants. A `real` control keeps its own range, so
         the number under the thumb is the setting itself. */
      input.min = c.real ? c.min : 0;
      input.max = c.real ? c.max : SLIDER_MAX;
      input.step = 1;
    } else if (c.type === 'select') {
      input = document.createElement('select');
      c.options.forEach(function (o) {
        var op = document.createElement('option');
        op.value = o[0]; op.textContent = o[1];
        input.appendChild(op);
      });
    } else if (c.type === 'check') {
      input = document.createElement('input');
      input.type = 'checkbox';
    } else if (c.type === 'color') {
      input = document.createElement('input');
      input.type = 'color';
    } else if (c.type === 'number') {
      input = document.createElement('input');
      input.type = 'number';
      input.min = c.min; input.max = c.max; input.step = c.step;
    } else if (c.type === 'seg') {
      input = document.createElement('div');
      input.className = 'seg';
      c.options.forEach(function (o) {
        var b = document.createElement('button');
        b.type = 'button';
        b.dataset.value = o[0];
        b.textContent = o[1];
        b.addEventListener('click', function () {
          cfg[c.key] = Number(o[0]);
          changed(c);
        });
        input.appendChild(b);
      });
    }

    /* An inline row wraps its input in a <label> with the name after it, so
       clicking the word works as well as clicking the box or the swatch. */
    if (inline) {
      var lab = document.createElement('label');
      lab.className = 'ctl__inline';
      lab.appendChild(input);
      lab.appendChild(document.createTextNode(c.name));
      wrap.appendChild(lab);
    } else {
      wrap.appendChild(input);
    }
    nodes[c.key] = { input: input, val: val, wrap: wrap, spec: c };

    if (c.type === 'range' || c.type === 'number') {
      input.addEventListener('input', function () {
        var raw = Number(input.value);
        /* A box being typed into can hold nothing, or half a number, which
           Number() reads as 0 or NaN. Neither is a setting, so wait for the
           next keystroke instead of redrawing a planet nobody asked for. */
        if (input.value === '' || !isFinite(raw)) return;
        /* A slider holds a position to translate. A number box holds the
           value itself, kept to a whole number inside its range. */
        cfg[c.key] = c.type === 'range'
          ? fromSlider(c, raw)
          : Math.min(c.max, Math.max(c.min, Math.floor(raw)));
        changed(c);
      });
    } else if (c.type === 'select') {
      input.addEventListener('change', function () { cfg[c.key] = input.value; changed(c); });
    } else if (c.type === 'check') {
      input.addEventListener('change', function () { cfg[c.key] = input.checked; changed(c); });
    } else if (c.type === 'color') {
      input.addEventListener('input', function () { cfg[c.key] = input.value; changed(c); });
    }

    host.appendChild(wrap);
  });

  /* Everything a control does once its value is in cfg. A `keepBody`
     setting is one build() never reads, so the body stays as it is and only
     what hangs off the setting is redone: the pace for speed, the ink for
     color, the source panes for both. Anything else is a new body. */
  function changed(c) {
    sync();
    if (c.keepBody) { gap = paceOf(); dress(); code(); }
    else rebuild();
  }

  /* --- state -> controls ------------------------------------ */

  /* Make the page agree with cfg. One way only: cfg is the truth. Called after
     anything that changes it, including the changes that come from code rather
     than from a control (Randomize, Reset, the console hook), which is why it
     rewrites every row rather than just the one that moved. */
  function sync() {
    /* An inner radius above the outer one draws nothing at all, which looks
       like a bug rather than a setting. Keep them ordered before anything is
       shown, so the rows below report the nudged value like any other. */
    if (cfg.ringOuter < cfg.ringInner + 0.15) {
      cfg.ringOuter = tidy(Math.min(nodes.ringOuter.spec.max, cfg.ringInner + 0.15));
    }

    SPEC.forEach(function (c) {
      var nd = nodes[c.key], v = cfg[c.key];
      if (c.type === 'seg') {
        Array.prototype.forEach.call(nd.input.children, function (b) {
          b.classList.toggle('is-on', Number(b.dataset.value) === v);
        });
      } else if (c.type === 'check') {
        nd.input.checked = !!v;
      } else if (c.type === 'range') {
        /* The only control whose page value is not its config value. A select,
           a color well and a number box all carry the setting itself. */
        nd.input.value = toSlider(c, v);
      } else {
        nd.input.value = v;
      }

      /* The readout. Inline rows have none at all, and a select or a seg
         already shows its own value, so theirs stays blank. */
      if (nd.val) {
        if (c.type === 'select' || c.type === 'seg') nd.val.textContent = '';
        /* The readout reports the slider, not the setting behind it: every
           range reads 0 to 100 like every other one. A number box is the
           exception, since the number in it is the value itself. */
        else if (c.type === 'number') nd.val.textContent = c.fmt ? c.fmt(v) : String(v);
        else nd.val.textContent = c.fmt ? c.fmt(toSlider(c, v))
                                        : String(toSlider(c, v));
      }

      /* Rows that mean nothing right now, like the ring radii with the rings
         switched off, are hidden rather than left to be dragged for nothing. */
      if (c.when) nd.wrap.style.display = cfg[c.when] ? '' : 'none';
    });

    wake();   // spin may have just come on, from a checkbox, Reset or the console
  }

  /* --- render loop ------------------------------------------ */
  var angle = 0;       // how far the body has turned, in radians
  var last = 0;        // timestamp of the previous tick; 0 while the loop is parked
  var painted = 0;     // timestamp of the last repaint
  var gap = 0;         // milliseconds between repaints while spinning, see paceOf()
  var cost = 0;        // what a repaint costs the main thread, in ms, see tick()
  var drawPx = 8;      // the font size the art is drawn at, see fitIn() and settle()
  var shown = '';      // the frame that is in the <pre> right now
  var looping = false; // whether tick() is scheduled

  /* Re-derive the body from cfg, then repaint and re-emit. The expensive path:
     it re-scatters every feature and, for a lumpy body, re-measures the
     bounding radius over 800 directions. Fine on a slider drag, but that is
     why the cheap settings are allowed to skip it.

     The stage is measured once, here, and everything that hangs off its size
     is settled at the same time. A frame then never has to ask the page for
     its layout, which would be a style recalculation per frame for an answer
     that only changes when this runs. */
  function rebuild() {
    var box = stageBox();
    /* The frame is cut to the panel it fills, and the grid to the glyph size
       asked for. Neither is a setting, so neither lives in cfg. */
    body = Cosmos.build(cfg, { rows: rowsFor(box, cfg.size), wide: shapeOf(box) });
    drawPx = fitIn(box);
    gap = paceOf();
    dress();
    paint();
    settle(box);
    code();
    /* That was a fresh frame, so tick() can wait a full beat before the next.
       While a slider is dragged, this is what stops the planet being drawn
       twice a frame, once here and once more by the loop. */
    painted = performance.now();
  }

  /* The stage's box, in CSS px. Everything about the grid is measured off
     this one rectangle: its shape becomes the frame's shape, its height over
     the font size becomes the row count, and the two together decide the
     size the glyphs are finally drawn at. The stage has no padding (see
     .stage in app.css), so its client size is all the art gets. Zero on
     either side means the page is not laid out yet, which every caller
     checks for. */
  function stageBox() {
    return { w: stage.clientWidth, h: stage.clientHeight };
  }

  /* The panel's shape, width over height. Cosmos.build cuts the frame to this,
     so the glyph grid covers the whole panel rather than sitting inside it as
     a smaller box with an edge around the art. */
  function shapeOf(box) {
    return (box.w > 0 && box.h > 0) ? box.w / box.h : 1;
  }

  /* How many rows it takes to draw glyphs `px` tall down the panel.

     The grid fills the panel, so the row count and the glyph size are two
     readings of one number and only one of them needs a slider. The slider
     carries the one a person can see.

     Capped by a glyph budget rather than a row count, because the columns
     follow the panel's shape: the same rows cost twice as much in a panel
     twice as wide. Past the cap the glyphs come out larger than the slider
     asked for, which is a better failure than a frame that takes longer to
     draw than the screen takes to refresh. The budget is high enough that the
     smallest font on the slider is reachable on a normal screen; it only
     bites on a very large display.

     The row count is a whole number, so the glyph height can only land within
     half a row of what was asked for: the error is px * px / (2 * height), a
     fraction of a pixel at 6px and under a pixel at 40. Honoring the request
     exactly would mean leaving up to a row of empty panel under the art. The
     slider is a request, filled to within less than one glyph. */
  var GLYPH_BUDGET = 180000;

  function rowsFor(box, px) {
    if (!(box.w > 0 && box.h > 0)) return 24;   // nothing laid out to measure
    var cap = Math.sqrt(GLYPH_BUDGET * Cosmos.aspect() * box.h / box.w);
    return Math.max(6, Math.round(Math.min(box.h / px, cap)));
  }

  /* The size the art is actually drawn at: whatever makes the grid fill the
     panel exactly. The font size slider chose the row count (rowsFor), and
     this turns that count back into a pixel size, which is the requested one
     to within half a row.

     Never smaller than the fit, and that is the point: the grid is cut to the
     panel's shape, so any smaller size would just leave a margin, and a
     margin around the art makes the planet look boxed in.

     Not rounded to whole pixels either. Rounding down would cost up to a
     pixel per row, which over a couple of hundred rows is a visible strip of
     empty panel along the bottom edge. */
  function fitIn(box) {
    if (!(box.w > 0 && box.h > 0)) return 8;    // nothing laid out yet to measure
    return Math.max(2, Math.min(box.w / (body.cols * Cosmos.aspect()), box.h / body.rows));
  }

  /* fitIn() trusts the arithmetic, and a browser may lay the glyphs out a
     hair wider than it says. Firefox rounds every glyph's advance to a
     sixtieth of a pixel, which over a few hundred columns comes to a pixel
     or two: enough to cut off the last column and push the art off center.
     So look at what was actually laid out, and shrink the type until it
     fits. Once per rebuild, never per frame, and where nothing overruns it
     costs one measurement of a layout that was happening anyway. */
  function settle(box) {
    if (!(box.w > 0 && box.h > 0)) return;      // nothing laid out yet to fit
    for (var k = 0; k < 3; k++) {
      var r = out.getBoundingClientRect();
      if (!(r.width > box.w || r.height > box.h)) return;
      drawPx *= Math.min(box.w / r.width, box.h / r.height);
      out.style.fontSize = drawPx.toFixed(3) + 'px';
    }
  }

  /* How long to wait between repaints while the planet turns, going by the
     motion alone. tick() may wait longer still, see DUTY.

     The art can only show movement in whole glyphs, so repainting faster than
     the surface crosses a glyph just draws the same picture again. At the
     default speed the surface takes most of a tenth of a second to cross one,
     so repainting sixty times a second regardless would spend most of a CPU
     core redrawing frames that had not changed. Instead this paces repaints
     at two per glyph crossing at the fastest moving point, never more often
     than the screen refreshes, and never less than four a second.

     The fastest point is the equator facing the viewer, out at the body's
     furthest reach for a lumpy one, or the inner edge of the rings, whose
     material outruns the surface by up to about 1.7 times (see the
     Keplerian shear in planet.js). */
  function paceOf() {
    var spin = Math.abs(cfg.speed);                      // radians per second
    var glyph = 2 * body.extX / body.cols;               // one column, in body radii
    var reach = Math.max(body.max, body.rings ? 1.7 : 1);
    var crossings = spin * reach / glyph;                // glyphs crossed per second
    if (!(crossings > 0)) return 250;
    return Math.min(250, Math.max(1000 / 60, 1000 / (2 * crossings)));
  }

  /* Everything about the <pre> except its text: the size and color the glyphs
     are drawn in, and the grid readout laid over the top of the stage. These
     only change on a rebuild or a new color, so they stay out of the per
     frame path. */
  function dress() {
    out.style.fontSize = drawPx.toFixed(3) + 'px';
    out.style.color = cfg.color;
    dims.textContent = body.cols + ' x ' + body.rows + ' glyphs';
  }

  /* Draw the body at the current angle into the <pre>. It writes only when the
     frame actually differs from the one on screen: handing the page the same
     text again still costs a full relayout of every glyph in it. The existing
     text node is updated in place rather than replaced. */
  function paint() {
    var art = Cosmos.render(body, angle);
    if (art === shown) return;
    if (out.firstChild) out.firstChild.nodeValue = art;
    else out.textContent = art;
    shown = art;
  }

  /* The least time the loop leaves between repaints, as a multiple of what a
     repaint costs. At 3, drawing the planet never takes more than about a
     third of the main thread. Only heavy frames ever reach this, a lumpy
     body at a small font size above all: they are drawn less often rather
     than pinning a core, and the page stays responsive around them. */
  var DUTY = 3;

  /* The animation loop, scheduled only while the planet spins.

     The angle advances by real elapsed time rather than a fixed step, so a
     slow frame does not slow the planet down, and it advances on every tick
     even when that tick does not repaint, so pacing never changes how fast
     the planet turns, only how often it is drawn.

     With spin off the loop stops outright rather than ticking over idle, and
     wake() starts it again. Starting again from last = 0 is what stops the
     planet lurching forward by the whole pause the moment spin comes back. */
  function tick(now) {
    if (!cfg.spin) { looping = false; last = 0; return; }
    requestAnimationFrame(tick);
    if (last) angle += (now - last) / 1000 * cfg.speed * cfg.direction;
    last = now;
    /* Half a refresh of slack, so a 33ms pace lands on every second frame of
       a 60Hz screen rather than drifting to every third. */
    if (now - painted < Math.max(gap, cost * DUTY) - 8) return;
    painted = now;

    var t0 = performance.now();
    paint();
    /* Asking for a size makes the browser lay the new frame out now rather
       than after this callback, so the time below covers the layout too. It
       is the same layout either way; this only moves it. */
    void out.offsetHeight;
    var ms = performance.now() - t0;
    /* Smoothed, so one slow frame, a garbage collection say, does not hold
       the planet back for long. */
    cost = cost ? cost * 0.75 + ms * 0.25 : ms;
  }

  /* Start the loop if the planet should be spinning and it is not already
     running. Called from sync(), so any change that turns spin on, from a
     checkbox to Reset to the console hook, brings the loop back. */
  function wake() {
    if (looping || !cfg.spin) return;
    looping = true;
    requestAnimationFrame(tick);
  }

  /* --- highlight ------------------------------------------- *
     Enough of a tokenizer to color the two source panes, and no more. A
     highlighting library would be the only dependency this project has, for a
     job that comes to a handful of patterns when the only two languages it
     will ever see are the two it writes itself.

     Everything goes out escaped. The input is always our own emitter's
     output, so there is nothing hostile in it, but escaping is what makes
     that a property of the code rather than a thing to remember. */

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* First pattern to match at a position wins, so strings come before
     comments and triple quotes before single ones. A # inside a Python string
     is never read as a comment, because the scanner never lands inside a
     string: the string rule swallows it whole.

     Every group inside a rule must be non-capturing. The scanner joins these
     into one alternation and finds the rule by group number, so a stray
     capture would shift every index after it. */
  var RULES = {
    py: [
      ['str', /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/],
      ['com', /#[^\n]*/],
      ['kw',  /\b(?:and|as|assert|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield)\b/],
      ['fn',  /\b(?:abs|any|enumerate|float|int|KeyboardInterrupt|len|list|max|min|print|range|round|str|sum|tuple|zip)\b/],
      ['num', /\b(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/]
    ],
    js: [
      ['str', /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/],
      ['com', /\/\*[\s\S]*?\*\/|\/\/[^\n]*/],
      ['kw',  /\b(?:break|case|catch|const|continue|default|delete|do|else|false|finally|for|function|if|in|instanceof|let|new|null|of|return|switch|this|throw|true|try|typeof|undefined|var|void|while)\b/],
      ['fn',  /\b(?:Array|JSON|Math|Number|Object|String|console|document|parseFloat|parseInt|performance|requestAnimationFrame|setTimeout|window)\b/],
      ['num', /\b(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/]
    ]
  };

  /* Compiled once rather than once per emit: both panes are rebuilt on every
     slider move, and building a regex this size per frame would show. */
  var SCANNER = {};
  Object.keys(RULES).forEach(function (lang) {
    SCANNER[lang] = new RegExp(RULES[lang].map(function (r) {
      return '(' + r[1].source + ')';
    }).join('|'), 'g');
  });

  /* `src` as HTML, with every token wrapped in the span its rule names. */
  function highlight(src, lang) {
    var rules = RULES[lang], re = SCANNER[lang];
    var out = '', last = 0, m, i;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      for (i = 1; i <= rules.length; i++) if (m[i] !== undefined) break;
      out += esc(src.slice(last, m.index)) +
             '<span class="t-' + rules[i - 1][0] + '">' + esc(m[0]) + '</span>';
      last = m.index + m[0].length;
    }
    return out + esc(src.slice(last));
  }

  /* --- code panes ------------------------------------------ */
  var panes = { py: document.querySelector('#pane-py code'),
                js: document.querySelector('#pane-js code') };
  var current = 'py';   // which tab is showing, and so what Copy will copy

  /* Both panes every time, not just the visible one. Emitting is a millisecond
     or two and doing both here keeps switching tabs instant. */
  function code() {
    panes.py.innerHTML = highlight(Emit.python(cfg, body), 'py');
    panes.js.innerHTML = highlight(Emit.javascript(cfg, body), 'js');
  }

  /* Tab switching, which is only ever a class on the tab and a class on the
     pane it names, plus the tab's aria-selected for screen readers. The panes
     are both already up to date. */
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.addEventListener('click', function () {
      current = t.dataset.pane;
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (o) {
        o.classList.toggle('is-on', o === t);
        o.setAttribute('aria-selected', String(o === t));
      });
      document.getElementById('pane-py').classList.toggle('is-on', current === 'py');
      document.getElementById('pane-js').classList.toggle('is-on', current === 'js');
    });
  });

  /* --- copy ------------------------------------------------- */

  /* A button that flashes a confirmation has to know what it said before.
     Reading it on the first press and parking it on the element means the
     answer comes from the page itself, so renaming a button in the HTML can
     never leave this file holding a stale copy of its name. */
  function restingLabel(btn) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    return btn.dataset.label;
  }

  /* Say `word` on `btn` for a beat, then put its own name back. A second
     press inside that beat starts the beat over rather than letting the
     first one's timer cut the second word short. */
  function flash(btn, word) {
    var label = restingLabel(btn);
    btn.textContent = word;
    clearTimeout(btn.flashTimer);
    btn.flashTimer = setTimeout(function () { btn.textContent = label; }, 1200);
  }

  /* Put `text` on the clipboard, then flash `btn` to say it worked. Both copy
     buttons come through here: Copy in the code panel head, which takes
     whichever source pane is on show, and Copy planet under the controls,
     which takes the art.

     navigator.clipboard needs a secure context, and this tool is meant to work
     opened straight off the disk over file://. Fall back to a scratch textarea
     and execCommand, which does not care. */
  function copyToClipboard(text, btn) {
    var done = function () { flash(btn, 'Copied'); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* nothing to do */ }
      document.body.removeChild(ta);
    }
  }

  var copyBtn = document.getElementById('copy');
  copyBtn.addEventListener('click', function () {
    copyToClipboard(panes[current].textContent, copyBtn);
  });

  /* The planet as plain text, read back out of the <pre> rather than rendered
     again. That way what lands on the clipboard is the exact frame that was on
     screen when the button went down, not one a few milliseconds further round.
     Cosmos.render joins its rows with newlines and leaves no trailing one, so
     this pastes into a text document as it stands. */
  var artBtn = document.getElementById('copy-art');
  artBtn.addEventListener('click', function () {
    copyToClipboard(out.textContent, artBtn);
  });

  /* --- screenshot ------------------------------------------ *
     The planet as a picture rather than as text: the frame that is on screen,
     drawn large on black and handed over as a PNG.

     Nothing is re-rendered. The glyphs come out of the <pre>, the same place
     the copy button reads from, so the file and the clipboard always agree
     about which frame they caught. */

  var SHOT_W = 3840, SHOT_H = 2160;   // 4K, and the only size this offers
  var SHOT_PAD = 0.04;                // fraction of the frame kept as margin

  /* The blank margin around the art, as [top, bottom, left, right] row and
     column indices, or null if there is no ink at all.

     Worth trimming rather than drawing as is. The frame deliberately carries
     empty sky, since it is cut to hold the body at any tilt, and a ring system
     seen edge on sits in a band through the middle of it. Saving that verbatim
     spends most of a 4K canvas on black. */
  function inkBox(lines) {
    var top = -1, bottom = -1, left = Infinity, right = -1, i, a, b;
    for (i = 0; i < lines.length; i++) {
      a = lines[i].search(/\S/);
      if (a < 0) continue;                       // a row of pure sky
      b = lines[i].replace(/\s+$/, '').length - 1;
      if (top < 0) top = i;
      bottom = i;
      if (a < left) left = a;
      if (b > right) right = b;
    }
    return top < 0 ? null : [top, bottom, left, right];
  }

  /* Lay `text` out on a 4K canvas in `color` on black, and hand back the
     canvas. Null if there is nothing to draw.

     The type is sized from the canvas's own measurement of the glyph rather
     than from Cosmos.aspect(). The two should agree, both being Paper Mono,
     but it is the canvas doing the drawing, so it is the canvas that gets to
     say whether the art fits. */
  function shotCanvas(text, color) {
    var all = text.split('\n');
    var box = inkBox(all);
    if (!box) return null;                       // nothing drawn, nothing to save
    var lines = all.slice(box[0], box[1] + 1).map(function (l) {
      return l.slice(box[2], box[3] + 1);
    });
    var rows = lines.length, cols = box[3] - box[2] + 1, i;

    var cv = document.createElement('canvas');
    cv.width = SHOT_W;
    cv.height = SHOT_H;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, SHOT_W, SHOT_H);

    /* Measured once at a reference size and scaled from there: the advance of
       a monospace glyph is linear in the font size, so one measureText answers
       for every size this might pick. */
    var REF = 100;
    ctx.font = REF + 'px ' + FONT;
    var perPx = (ctx.measureText('M').width || REF * Cosmos.aspect()) / REF;
    var size = Math.min(SHOT_W * (1 - SHOT_PAD) / (cols * perPx),
                        SHOT_H * (1 - SHOT_PAD) / rows);

    ctx.font = size + 'px ' + FONT;
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    /* Line height 1, to match the <pre> on screen, so the art keeps the
       proportions it was designed at. */
    var x = (SHOT_W - cols * perPx * size) / 2;
    var y = (SHOT_H - rows * size) / 2;
    for (i = 0; i < rows; i++) ctx.fillText(lines[i], x, y + (i + 0.5) * size);
    return cv;
  }

  var shotBtn = document.getElementById('screenshot');
  shotBtn.addEventListener('click', function () {
    /* All read before anything async, so what gets saved is the frame that
       was up when the button went down rather than one a few turns later, and
       the file is named for the planet it shows. */
    var text = out.textContent, color = cfg.color;
    var file = 'cosmos-' + cfg.texture + '-' + Math.round(cfg.seed) + '.png';

    var save = function () {
      var cv = shotCanvas(text, color);
      if (!cv) return;
      cv.toBlob(function (blob) {
        if (!blob) return;
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = file;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        /* Released on a later turn of the loop. Revoking it in the same tick
           can beat the download to the file in some browsers. */
        setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
        flash(shotBtn, 'Saved');
      }, 'image/png');
    };

    /* A canvas draws in whatever font has arrived by then, so wait for the
       webfont rather than saving a 4K picture of the fallback. Both arms of
       the then() are the same call: a font that fails to load is still a
       screenshot worth having. */
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(save, save);
    else save();
  });

  /* --- buttons --------------------------------------------- */
  /* A whole planet at once. The ranges are hand-picked rather than the full
     travel of each slider: the point is that every roll looks like a body
     somebody might have designed on purpose. Hence lumpiness going high only
     for rock, and a ringed planet being given a minimum tilt: rings seen
     exactly edge-on are a single line of glyphs. */
  document.getElementById('randomize').addEventListener('click', function () {
    var pick = function (a) { return a[Math.floor(Math.random() * a.length)]; };
    var r = function (lo, hi) { return lo + Math.random() * (hi - lo); };
    cfg.texture = pick(Object.keys(Cosmos.TEXTURES));
    cfg.seed = Math.floor(Math.random() * 1e9);
    slide('craters', r(4, 34));
    slide('lumpiness', cfg.texture === 'rock' ? r(0.5, 1.2) : (Math.random() < 0.25 ? r(0.1, 0.5) : 0));
    slide('tilt', r(-0.9, 0.9));
    slide('roll', r(-1.2, 1.2));
    slide('speed', r(0.03, 0.28));
    cfg.direction = Math.random() < 0.5 ? 1 : -1;
    slide('brightness', r(0.75, 1.35));
    slide('ambient', r(0.05, 0.3));
    cfg.color = hsl(Math.random() * 360, 55 + Math.random() * 35, 60 + Math.random() * 22);
    cfg.rings = Math.random() < 0.35;
    if (cfg.rings) {
      slide('ringInner', r(1.15, 1.5));
      slide('ringOuter', cfg.ringInner + r(0.5, 1.4));
      if (Math.abs(cfg.tilt) < 0.2) slide('tilt', 0.2 + Math.random() * 0.4);  // else edge-on
    }
    sync(); rebuild();
  });

  /* Set a slider's setting to the slider position nearest `v`, so a rolled
     planet is one the sliders can show exactly: drag a thumb away and back
     and the planet comes back with it, digit for digit. */
  function slide(key, v) {
    var c = nodes[key].spec;
    cfg[key] = fromSlider(c, toSlider(c, v));
  }

  /* HSL to hex. Picking a hue keeps every roll bright and saturated; picking
     three random bytes instead lands on mud about half the time. */
  function hsl(h, s, l) {
    h /= 360; s /= 100; l /= 100;
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    var f = function (t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    var hex = function (v) {
      var n = Math.round(v * 255).toString(16);
      return n.length < 2 ? '0' + n : n;
    };
    return '#' + hex(f(h + 1 / 3)) + hex(f(h)) + hex(f(h - 1 / 3));
  }

  /* Back to the opening planet, exactly as Cosmos.defaults() describes it. */
  document.getElementById('reset').addEventListener('click', function () {
    cfg = Cosmos.defaults();
    sync(); rebuild();
  });

  /* --- console hook ----------------------------------------- *
     Exposed so the renderer can be driven from the console, and so the
     equivalence test can render a known config without the UI. From devtools:

       __cosmos.set({ texture: 'lava', lumpiness: 0.8 })   apply and redraw
       __cosmos.frame(1.2)                                 one frame, as text
       __cosmos.body()                                     what build() made */
  window.__cosmos = {
    get cfg() { return cfg; },
    set: function (patch) {
      Object.keys(patch).forEach(function (k) { cfg[k] = patch[k]; });
      sync(); rebuild();
      return Cosmos.render(body, 0);
    },
    frame: function (a) { return Cosmos.render(body, a || 0); },
    body: function () { return body; },
    emit: Emit,
    highlight: highlight          // __cosmos.highlight(src, 'py' | 'js')
  };

  /* --- launcher handshake ---------------------------------- *
     cosmos.py serves this page and shuts down once the page is gone, so
     closing the tab closes the program. It hears about that from a goodbye
     sent to /__bye as the page goes away, and stops a few seconds later
     unless a page says hello again, which is what a reload does. A ping
     every two seconds while the page is open covers the times no goodbye
     arrives, a crashed browser say. Opened over file:// there is nothing
     listening and nothing to tell.

     The first ping decides whether to keep going. This page is also hosted on a
     plain static server, where /__alive is simply not a route: pinging it every
     two seconds forever would be a 404 on a loop for every visitor. One probe
     that quietly gives up costs a single request. */
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    var ping = function () {
      return fetch('/__alive', { method: 'POST' })
        .then(function (r) { return r.ok; })
        .catch(function () { return false; });
    };
    try {
      ping().then(function (listening) {
        if (!listening) return;
        setInterval(ping, 2000);
        /* A beacon is made for exactly this: the browser still sends it
           after the page itself has gone. */
        window.addEventListener('pagehide', function () {
          if (navigator.sendBeacon) navigator.sendBeacon('/__bye');
        });
      });
    } catch (e) { /* no fetch: the launcher falls back to its own timeout */ }
  }

  /* --- resize ----------------------------------------------- */

  /* A resized window is a differently shaped frame, so this is a full rebuild
     rather than a repaint: the column count follows the panel. Debounced
     because a drag fires this continuously and a rebuild re-scatters every
     feature. */
  var refit;
  window.addEventListener('resize', function () {
    clearTimeout(refit);
    refit = setTimeout(rebuild, 100);
  });

  /* --- go --------------------------------------------------- */
  sync();      // also starts the loop, since the planet opens spinning
  rebuild();

  /* The probe above can run before the webfont has arrived, in which case it
     describes the fallback and the grid is cut for the wrong glyph. Measure
     once more when the font settles, and rebuild only if it actually moved,
     so the common case of a cached font costs nothing. */
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      var a = measureAspect();
      if (a > 0 && Math.abs(a - Cosmos.aspect()) > 0.001) {
        Cosmos.setAspect(a);
        rebuild();
      }
    });
  }
})();
