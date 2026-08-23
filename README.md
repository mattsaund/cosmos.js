# cosmos.js

An ASCII planet generator. Tune a planet with sliders, watch it turn, then copy
it out as a standalone **Python** or **JavaScript** program that draws the same
thing.

Nothing is pre-rendered. Every glyph is a ray cast at a body, shaded from a real
lighting model, and quantised onto a density ramp.

```
                     ----:::::
              -=====+-----==:--:,.
          -=+++======+=::::::::....
        -=+++++======-----==::--:,..
      =++++++=======------====:!--:...
    ++**++++====----------------::!:..
```

## Run it

```sh
python3 cosmos.py
```

That is the whole install. Standard library only: nothing to pip, no build step.
The window needs **tkinter**, which ships with CPython on Windows and macOS; on
most Linux distributions it is a separate package (`python3-tk` on Debian and
Ubuntu, `python3-tkinter` on Fedora, `tk` on Arch). The program says so if it is
missing rather than dying on an import error.

Two headless modes need no window at all:

```sh
python3 cosmos.py --render      # one frame to stdout
python3 cosmos.py --emit py     # print the standalone Python
python3 cosmos.py --emit js     # print the standalone JavaScript
```

There is also a browser build in `web/` with the same controls. Open
`web/index.html` straight off the disk; no server needed.

**The two are the same program.** Identical controls, identical ranges and
steps, identical defaults, and both renderers produce byte-identical output for
the same settings. The browser is ten to thirty times faster, so the same
setting simply draws sooner there; nothing is off-limits on either side.

## Controls

| | |
|---|---|
| **texture** | rock, cratered, ice, gas giant, lava, desert |
| **resolution** | glyph rows; columns follow so the disk stays round |
| **size** | preview font size, in px |
| **brightness** | multiplies the shaded result |
| **night side** | how much light reaches the dark limb |
| **crater count** | how many impacts get scattered on the surface |
| **lumpiness** | 0 is a perfect sphere; wind it up for an asteroid |
| **tilt / roll** | where the pole points |
| **rotation speed** | radians per second |
| **direction** | clockwise or counterclockwise, as seen with the pole toward you |
| **rings** | draw a ring system, with inner and outer radii |
| **colour** | ink colour, carried into both exports as hex and as an ANSI escape |
| **seed** | which craters, fractures and lumps you get |

**Randomize** rolls a whole planet. **Reset** goes back to the defaults.

## The exports

Both panes emit a complete program. The Python needs only the standard library;
run it and it animates in the terminal, or pass `--once` for a single frame. The
JavaScript runs in a browser (it appends a `<pre>` and animates) or under Node
(it prints one frame).

Only what your settings actually use gets written out. A smooth moon with no
rings emits neither the ray-bisection search nor the ring compositing, so the
file stays readable instead of shipping every branch of the renderer.

## How it works

Each cell of the grid is one ray, fired straight down the z axis:

1. **Hit the body.** For a sphere that is one square root. For a lumpy body the
   radius varies with direction, so there is no closed form and the ray gets
   bisected instead. Newton's method would take fewer steps but blows up near
   the silhouette, where the surface is edge-on.
2. **Shade it.** Lambertian falloff against a fixed key light, plus limb
   darkening, plus an ambient floor so the night side does not go flat black.
3. **Texture it.** The hit point is rotated into *body* space and looked up. That
   rotation is what makes the surface travel as the planet turns, rather than
   sitting still like a decal on the screen.
4. **Composite the rings.** Rings are a translucent sheet, not a surface: a faint
   band crossing in front of the planet has to blend over it. They also carry
   density clumps that shear on a Keplerian profile, because a perfectly
   symmetric annulus looks identical at every angle and reads as frozen.
5. **Quantise.** The result indexes into `" .:-=+*#%@"`, Bourke's ramp. Ink
   density rises monotonically across it, which the obvious-looking
   `".,:;=+ic*ox%#@"` does not: `i` and `c` read lighter than `=` and `+`, so
   gradients come out mottled.

## Files

```
cosmos.py          entry point: the window, or --render / --emit
cosmos/planet.py   the renderer: pure computation, no tkinter
cosmos/emit.py     turns a config into standalone Python or JavaScript
cosmos/ui.py       the tkinter window

web/index.html     the browser build
web/js/planet.js   the same renderer in JavaScript
web/js/emit.js     the same emitters
web/js/app.js      controls, preview loop, code panes
web/css/app.css    chrome
```

The maths exists in several places at once: `planet.py` and `planet.js` for the
two previews, and twice more inside each `emit` module as the source it writes
out. **Change the algorithm in one and the rest have to follow**, or the exports
stop matching the preview. Two things in particular keep them in step:

- Derived seeds are resolved in `emit.js` and baked in as plain integers.
  JavaScript's `^` works on int32 and can hand back a negative number that the
  PRNG then reads as unsigned; Python's never does.
- The ramp index uses `int(x + 0.5)` in Python, not `round(x)`. Python rounds
  half to even and JavaScript rounds half up, so `round` picks a different glyph
  on exact halves.

Both are the kind of thing that silently shifts a few characters rather than
throwing, which is why the exports get checked against the preview rather than
eyeballed: render a configuration in each implementation and diff the text.

## Speed

Python is ten to thirty times slower than the browser at this. Rather than
capping what the desktop build will attempt, its frame loop is adaptive: it
schedules the next frame off how long the last one actually took, and prints
that cost in the status line. A heavy setting slows the spin down instead of
locking the window up, and every setting the browser offers is reachable.

Measured here, at the top of the resolution slider: a smooth body is about 14 ms
a frame, a lumpy one about 140. The gap is the surface. A sphere is one square
root; a lumpy body has no closed form, so every ray gets bisected nine times and
each step evaluates 43 lobes.

## Credits

Grown out of the ASCII planetarium on [msaunders.dev](https://msaunders.dev).
