/* ============================================================
   cosmos.js : app

   Wires the controls to the renderer and to the code emitters.

   The control list is a single spec, and every control names the
   config key it writes. Adding a knob means adding one entry here,
   not touching the HTML, the render call and the exporters
   separately and hoping they agree.

   ------------------------------------------------------------
   WHAT HAPPENS WHEN A SLIDER MOVES

     the control's handler writes cfg[key]
       -> sync()       pushes cfg back out to every control: the
                       readouts, the rows that hide themselves, any
                       value it had to nudge to stay sensible
       -> rebuild()    body = Cosmos.build(cfg), then:
            paint()    draw one frame into the <pre>
            code()     re-emit both source panes

   Size and colour skip rebuild(): they change how a frame is
   painted, not what is in it. They carry `preview: true` in SPEC.

   Running alongside all of that, tick() sits on
   requestAnimationFrame forever, moves the angle on by however much
   real time has passed, and calls paint().

   cfg is the single source of truth. Everything on the page is
   derived from it, never the other way round, which is why sync()
   only ever pushes outward.

   IN THIS FILE
     font probe ...... measures the glyph shape the browser picked
     SPEC ............ every control, as one list of data
     build ........... turns SPEC into DOM
     sync ............ cfg -> controls
     render loop ..... rebuild / fitSize / paint / tick
     code panes ...... emit and tab switching
     copy ............ the clipboard helper, shared by both buttons
     buttons ......... randomize and reset
     console hook .... window.__cosmos
     handshake ....... the ping that keeps cosmos.py alive
     go .............. first paint
   ============================================================ */
(function () {
  'use strict';

  /* --- font probe ------------------------------------------- */

  /* Which monospace font resolves decides the glyph's advance, and the disk is
     only round if the column count is derived from the real one. Measure it
     off a throwaway <pre> rather than trusting the usual 0.6. */
  (function measureAspect() {
    var probe = document.createElement('pre');
    probe.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;top:0;' +
                          'font:100px/1 ui-monospace, monospace;white-space:pre;margin:0';
    probe.textContent = new Array(41).join('M');          // 40 glyphs
    document.body.appendChild(probe);
    var w = probe.getBoundingClientRect().width / 40;
    document.body.removeChild(probe);
    if (w > 0) Cosmos.setAspect(w / 100);
  })();

  var cfg = Cosmos.defaults();
  var body = Cosmos.build(cfg);

  /* --- SPEC: every control, as data ------------------------- *
     In page order. One entry is one row of the controls panel.

       key       the cfg property it writes; also what `when` refers to
       name      the label
       type      range | select | check | color | seg | number
       fmt       how the value reads out beside the label (default: 2dp)
       invert    the slider runs backwards against the value it writes
       preview   cheap: repaint, but do not rebuild the body
       when      only show this row while cfg[when] is truthy

     Adding a knob is one entry here plus one key in Cosmos.defaults().
     Nothing else in this file has to learn about it. */
  var SPEC = [
    { key: 'texture', name: 'texture', type: 'select', options: [
        ['rock', 'rock'], ['cratered', 'cratered'], ['ice', 'ice'],
        ['gas', 'gas giant'], ['lava', 'lava'], ['desert', 'desert']
      ] },
    { key: 'rows', name: 'resolution', type: 'range', min: 10, max: 70, step: 1,
      fmt: function (v) { return Math.round(v) + ' rows'; } },
    /* Whole pixels only. The preview scales the type down whenever the body
       will not fit the stage anyway (see fitSize), so a half-pixel step on the
       slider buys nothing but a fussier readout. */
    { key: 'size', name: 'size', type: 'range', min: 5, max: 26, step: 1,
      fmt: function (v) { return Math.round(v) + ' px'; }, preview: true },
    { key: 'brightness', name: 'brightness', type: 'range', min: 0.35, max: 1.8, step: 0.01 },
    /* Writes ambient light, but reads as its opposite: more shadow is less
       light on the night side. See toSlider/fromSlider. */
    { key: 'ambient', name: 'shadow', type: 'range', min: 0, max: 0.6, step: 0.01,
      invert: true },
    { key: 'craters', name: 'crater count', type: 'range', min: 0, max: 45, step: 1,
      fmt: function (v) { return String(Math.round(v)); } },
    { key: 'lumpiness', name: 'lumpiness', type: 'range', min: 0, max: 1.4, step: 0.01 },
    { key: 'tilt', name: 'tilt', type: 'range', min: -1.3, max: 1.3, step: 0.01 },
    { key: 'roll', name: 'roll', type: 'range', min: -1.6, max: 1.6, step: 0.01 },
    { key: 'speed', name: 'rotation speed', type: 'range', min: 0, max: 0.6, step: 0.005 },
    { key: 'direction', name: 'direction', type: 'seg', options: [[-1, 'clockwise'], [1, 'counterclockwise']] },
    { key: 'rings', name: 'rings', type: 'check' },
    { key: 'ringInner', name: 'ring inner', type: 'range', min: 1.05, max: 2.4, step: 0.01, when: 'rings' },
    { key: 'ringOuter', name: 'ring outer', type: 'range', min: 1.1, max: 3.2, step: 0.01, when: 'rings' },
    { key: 'color', name: 'colour', type: 'color', preview: true },
    { key: 'seed', name: 'seed', type: 'number', min: 0, step: 1,
      fmt: function (v) { return String(Math.round(v)); } }
  ];

  /* Open on the most detailed planet the sliders can make: resolution at the
     top of its range, size at the bottom of its. Taken from the SPEC itself so
     the two cannot drift apart if a range is ever retuned. */
  function startExtremes(c) {
    SPEC.forEach(function (sp) {
      if (sp.key === 'rows') c.rows = sp.max;
      if (sp.key === 'size') c.size = sp.min;
    });
    return c;
  }
  startExtremes(cfg);

  /* A slider can run the opposite way to the value it writes. Keeping the
     conversion in one pair of functions means the handler, the readout and the
     initial position cannot disagree about which way round it is. */
  function toSlider(c, v) { return c.invert ? (c.min + c.max - v) : v; }
  function fromSlider(c, p) { return c.invert ? (c.min + c.max - p) : p; }

  var host = document.getElementById('controls');
  var out = document.getElementById('out');
  var stage = document.querySelector('.stage');
  var dims = document.getElementById('dims');
  var spin = document.getElementById('spin');
  /* key -> { input, val, wrap, spec }, filled in as the controls are built, so
     sync() can find every piece of a row again without another DOM query. */
  var nodes = {};

  /* --- build the controls ----------------------------------- *
     One pass over SPEC, building each row as: a label line with the name and
     the live readout, then whatever input the type calls for, then the
     listener that writes back into cfg. The handlers differ only in which
     event they listen for and how much work the change costs. */
  SPEC.forEach(function (c) {
    var wrap = document.createElement('div');
    wrap.className = 'ctl';
    wrap.dataset.key = c.key;

    var top = document.createElement('div');
    top.className = 'ctl__top';
    var name = document.createElement('span');
    name.className = 'ctl__name';
    name.textContent = c.name;
    var val = document.createElement('span');
    val.className = 'ctl__val';
    top.appendChild(name);
    top.appendChild(val);
    wrap.appendChild(top);

    var input;
    if (c.type === 'range') {
      input = document.createElement('input');
      input.type = 'range';
      input.min = c.min; input.max = c.max; input.step = c.step;
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
      var lab = document.createElement('label');
      lab.className = 'check';
      lab.appendChild(input);
      lab.appendChild(document.createTextNode(' draw a ring system'));
      wrap.appendChild(lab);
    } else if (c.type === 'color') {
      input = document.createElement('input');
      input.type = 'color';
    } else if (c.type === 'number') {
      input = document.createElement('input');
      input.type = 'number';
      input.min = c.min; input.step = c.step;
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
          sync();
          rebuild();
        });
        input.appendChild(b);
      });
    }

    if (c.type !== 'check') wrap.appendChild(input);
    nodes[c.key] = { input: input, val: val, wrap: wrap, spec: c };

    if (c.type === 'range' || c.type === 'number') {
      input.addEventListener('input', function () {
        cfg[c.key] = fromSlider(c, Number(input.value));
        sync();
        /* Size and colour only touch how the preview is painted, so they can
           skip rebuilding the body and re-emitting the code. */
        if (c.preview) { paint(); code(); } else rebuild();
      });
    } else if (c.type === 'select') {
      input.addEventListener('change', function () {
        cfg[c.key] = input.value;
        sync(); rebuild();
      });
    } else if (c.type === 'check') {
      input.addEventListener('change', function () {
        cfg[c.key] = input.checked;
        sync(); rebuild();
      });
    } else if (c.type === 'color') {
      input.addEventListener('input', function () {
        cfg[c.key] = input.value;
        sync(); paint(); code();
      });
    }

    host.appendChild(wrap);
  });

  /* --- state -> controls ------------------------------------ */

  /* Make the page agree with cfg. One way only: cfg is the truth. Called after
     anything that changes it, including the changes that come from code rather
     than from a control - Randomize, Reset, the console hook - which is why it
     rewrites every row rather than just the one that moved. */
  function sync() {
    SPEC.forEach(function (c) {
      var nd = nodes[c.key], v = cfg[c.key];
      if (c.type === 'seg') {
        Array.prototype.forEach.call(nd.input.children, function (b) {
          b.classList.toggle('is-on', Number(b.dataset.value) === v);
        });
      } else if (c.type === 'check') {
        nd.input.checked = !!v;
      } else {
        nd.input.value = toSlider(c, v);
      }

      if (c.type === 'check' || c.type === 'color') nd.val.textContent = '';
      else if (c.type === 'select') nd.val.textContent = '';
      else if (c.type === 'seg') nd.val.textContent = '';
      /* Read out what the slider shows, not what it writes. */
      else nd.val.textContent = c.fmt ? c.fmt(toSlider(c, v))
                                      : Number(toSlider(c, v)).toFixed(2);

      /* Ring radii are meaningless with the rings switched off. */
      if (c.when) nd.wrap.style.display = cfg[c.when] ? '' : 'none';
    });

    /* An inner radius above the outer one draws nothing at all, which looks
       like a bug rather than a setting. Keep them ordered. */
    if (cfg.ringOuter < cfg.ringInner + 0.15) {
      cfg.ringOuter = cfg.ringInner + 0.15;
      nodes.ringOuter.input.value = cfg.ringOuter;
      nodes.ringOuter.val.textContent = cfg.ringOuter.toFixed(2);
    }
  }

  /* --- render loop ------------------------------------------ */
  var angle = 0;    // how far the body has turned, in radians
  var last = 0;     // timestamp of the previous frame; 0 while paused

  /* Re-derive the body from cfg, then repaint and re-emit. The expensive path:
     it re-scatters every feature and, for a lumpy body, re-measures the
     bounding radius over 800 directions. Fine on a slider drag, but that is
     why the cheap settings are allowed to skip it. */
  function rebuild() {
    body = Cosmos.build(cfg);
    paint();
    code();
  }

  /* The largest type this body can be drawn at and still fit the stage whole.

     A wide ring system needs a frame several times the planet's own width, so
     at anything but a small size the art is wider than the panel. Clipping it
     was bad on its own, and a centred overflow is worse than a plain one: what
     spills past the top and left edges cannot be scrolled to at all, so the
     planet simply hung off an invisible box. Capping the painted size instead
     means the whole body is always on screen, and `size` reads as a preferred
     maximum rather than a promise. */
  function fitSize() {
    var cs = getComputedStyle(stage);
    var w = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    var h = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (!(w > 0 && h > 0)) return cfg.size;      // not laid out yet
    var byWidth = w / (body.cols * Cosmos.aspect());
    var byHeight = h / body.rows;
    return Math.max(2, Math.min(cfg.size, byWidth, byHeight));
  }

  /* Draw the body at the current angle into the <pre>, and update the readout
     beside it. Cheap enough to run every animation frame. */
  function paint() {
    var fs = fitSize();
    out.style.fontSize = fs.toFixed(2) + 'px';
    out.style.color = cfg.color;
    out.textContent = Cosmos.render(body, angle);
    dims.textContent = body.cols + ' x ' + body.rows + ' glyphs'
                     + (fs < cfg.size - 0.05 ? '   fitted to ' + fs.toFixed(1) + 'px' : '');
  }

  /* The animation loop, running whether or not the planet is spinning.

     The angle advances by real elapsed time rather than a fixed step, so a
     slow frame does not slow the planet down. Clearing `last` while paused is
     what stops it lurching forward by the whole pause the moment spin comes
     back on. */
  function tick(now) {
    requestAnimationFrame(tick);
    if (!spin.checked) { last = now; return; }
    if (last) angle += (now - last) / 1000 * cfg.speed * cfg.direction;
    last = now;
    paint();
  }

  /* --- code panes ------------------------------------------ */
  var panes = { py: document.querySelector('#pane-py code'),
                js: document.querySelector('#pane-js code') };
  var current = 'py';   // which tab is showing, and so what Copy will copy

  /* Both panes every time, not just the visible one. Emitting is a millisecond
     or two and doing both here keeps switching tabs instant. */
  function code() {
    panes.py.textContent = Emit.python(cfg, body);
    panes.js.textContent = Emit.javascript(cfg, body);
  }

  /* Tab switching, which is only ever a class on the tab and a class on the
     pane it names. The panes are both already up to date. */
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.addEventListener('click', function () {
      current = t.dataset.pane;
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (o) {
        o.classList.toggle('is-on', o === t);
      });
      document.getElementById('pane-py').classList.toggle('is-on', current === 'py');
      document.getElementById('pane-js').classList.toggle('is-on', current === 'js');
    });
  });

  /* --- copy ------------------------------------------------- */

  /* Put `text` on the clipboard, then flash `btn` to say it worked and set it
     back to `label` afterwards. Both copy buttons come through here: Copy in
     the code panel head, which takes whichever source pane is on show, and
     Copy planet under the controls, which takes the art.

     navigator.clipboard needs a secure context, and this tool is meant to work
     opened straight off the disk over file://. Fall back to a scratch textarea
     and execCommand, which does not care. */
  function copyToClipboard(text, btn, label) {
    var done = function () {
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = label; }, 1200);
    };
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
    copyToClipboard(panes[current].textContent, copyBtn, 'Copy');
  });

  /* The planet as plain text, read back out of the <pre> rather than rendered
     again. That way what lands on the clipboard is the exact frame that was on
     screen when the button went down, not one a few milliseconds further round.
     Cosmos.render joins its rows with newlines and leaves no trailing one, so
     this pastes into a text document as it stands. */
  var artBtn = document.getElementById('copy-art');
  artBtn.addEventListener('click', function () {
    copyToClipboard(out.textContent, artBtn, 'Copy planet');
  });

  /* --- buttons --------------------------------------------- */
  /* A whole planet at once. The ranges are hand-picked rather than the full
     travel of each slider: the point is that every roll looks like a body
     somebody might have designed on purpose. Hence lumpiness going high only
     for rock, and a ringed planet being given a minimum tilt - rings seen
     exactly edge-on are a single line of glyphs. */
  document.getElementById('randomize').addEventListener('click', function () {
    var pick = function (a) { return a[Math.floor(Math.random() * a.length)]; };
    var r = function (lo, hi) { return lo + Math.random() * (hi - lo); };
    cfg.texture = pick(['rock', 'cratered', 'ice', 'gas', 'lava', 'desert']);
    cfg.seed = Math.floor(Math.random() * 1e9);
    cfg.craters = Math.round(r(4, 34));
    cfg.lumpiness = cfg.texture === 'rock' ? r(0.5, 1.2) : (Math.random() < 0.25 ? r(0.1, 0.5) : 0);
    cfg.tilt = r(-0.9, 0.9);
    cfg.roll = r(-1.2, 1.2);
    cfg.speed = r(0.03, 0.28);
    cfg.direction = Math.random() < 0.5 ? 1 : -1;
    cfg.brightness = r(0.75, 1.35);
    cfg.ambient = r(0.05, 0.3);
    cfg.color = hsl(Math.random() * 360, 55 + Math.random() * 35, 60 + Math.random() * 22);
    cfg.rings = Math.random() < 0.35;
    if (cfg.rings) {
      cfg.ringInner = r(1.15, 1.5);
      cfg.ringOuter = cfg.ringInner + r(0.5, 1.4);
      if (Math.abs(cfg.tilt) < 0.2) cfg.tilt = 0.2 + Math.random() * 0.4;  // else edge-on
    }
    sync(); rebuild();
  });

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

  /* Back to the defaults, opening extremes and all. */
  document.getElementById('reset').addEventListener('click', function () {
    cfg = startExtremes(Cosmos.defaults());
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
    emit: Emit
  };

  /* --- launcher handshake ---------------------------------- *
     cosmos.py serves this page and shuts down when the pings stop, so closing
     the tab closes the program. Opened over file:// there is nothing listening
     and nothing to tell. keepalive lets the last ping survive the page going
     away, which only shortens the wait.

     The first ping decides whether to keep going. This page is also hosted on a
     plain static server, where /__alive is simply not a route: pinging it every
     two seconds forever would be a 404 on a loop for every visitor. One probe
     that quietly gives up costs a single request. */
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    var ping = function () {
      return fetch('/__alive', { method: 'POST', keepalive: true })
        .then(function (r) { return r.ok; })
        .catch(function () { return false; });
    };
    try {
      ping().then(function (listening) {
        if (listening) setInterval(ping, 2000);
      });
    } catch (e) { /* no fetch: the launcher falls back to its own timeout */ }
  }

  /* --- resize ----------------------------------------------- */

  /* fitSize() measures the stage, so a resized window needs a repaint.
     Debounced because a drag fires this continuously and each repaint is a
     full re-render of every glyph. */
  var refit;
  window.addEventListener('resize', function () {
    clearTimeout(refit);
    refit = setTimeout(paint, 100);
  });

  /* --- go --------------------------------------------------- */
  sync();
  rebuild();
  requestAnimationFrame(tick);
})();
