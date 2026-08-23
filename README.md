# cosmos.js

An ASCII planet generator for any project you want to have an animated planet. Tune a specific planet with sliders, then copy the generated code into whatever project you want.

Nothing is pre-rendered. Every glyph is a ray cast at a body, shaded from a real lighting model, and quantised onto a density ramp.

## Run it

#### Python web server:

```sh
python3 cosmos.py
```

It serves `web/` on a free loopback port, opens your browser at it, and stops when you close the tab. Python Standard library only.  nothing to install.

Headless modes (nogui):

```sh
python3 cosmos.py --no-open # just print the URL
python3 cosmos.py --port 8000 # a fixed port instead of a free one
python3 cosmos.py --verbose # log every request
```

#### HTML Index File:

There is also a browser build in `web/` with the same controls. Open `web/index.html` or launch a local html server. The Python script is for a web server setup and future expandability.

## Controls

| **texture**        | rock, cratered, ice, gas giant, lava, desert                       |
| ------------------ | ------------------------------------------------------------------ |
| **resolution**     | glyph rows; columns follow so the disk stays round                 |
| **size**           | preview font size, in px                                           |
| **brightness**     | multiplies the shaded result                                       |
| **night side**     | how much light reaches the dark limb                               |
| **crater count**   | how many impacts get scattered on the surface                      |
| **lumpiness**      | 0 is a perfect sphere; wind it up for an asteroid                  |
| **tilt / roll**    | where the pole points                                              |
| **rotation speed** | radians per second                                                 |
| **direction**      | clockwise or counterclockwise, as seen with the pole toward you    |
| **rings**          | draw a ring system, with inner and outer radii                     |
| **color**          | ink colour, carried into both exports as hex and as an ANSI escape |
| **seed**           | which craters, fractures and lumps you get                         |

**Randomize** generates a completely random planet. **Reset** sets everything to default
## The exports

Both programs allow you to copy raw Python or JavaScript code for the planet you create. You can use this code in any project or website you want. pass the argument `--once` for a single frame. The JavaScript runs in a browser (it appends a `<pre>` and animates) or under Node
(it prints one frame).

## Files

```
cosmos.py serves web/, stops when the tab closes

web/index.html the app
web/js/planet.js the renderer: pure computation, no DOM
web/js/emit.js turns a config into standalone Python or JavaScript
web/js/app.js controls, preview loop, code panes, launcher heartbeat
web/css/app.css chrome
```
## Credits

Matthew Saunders: [msaunders.dev](https://msaunders.dev).