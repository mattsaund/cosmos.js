#!/usr/bin/env python3
"""cosmos.js - ASCII planet generator.

Run it:      python3 cosmos.py
Or headless: python3 cosmos.py --render          one frame to stdout
             python3 cosmos.py --emit py         the standalone Python
             python3 cosmos.py --emit js         the standalone JavaScript

Standard library only. The window needs tkinter, which ships with CPython on
Windows and macOS; on most Linux distributions it is a separate package
(python3-tk on Debian and Ubuntu, python3-tkinter on Fedora). The --render and
--emit paths do not need it at all.
"""
import sys

from cosmos import emit, planet


def main(argv):
    if "--render" in argv or "--emit" in argv:
        cfg = planet.defaults()
        body = planet.Body(cfg)
        if "--render" in argv:
            print(planet.render(body, 0.0))
            return 0
        which = argv[argv.index("--emit") + 1] if len(argv) > argv.index("--emit") + 1 else "py"
        print(emit.python(cfg, body) if which.startswith("py")
              else emit.javascript(cfg, body))
        return 0

    try:
        from cosmos import ui
    except ImportError as exc:                       # tkinter missing
        sys.stderr.write(
            "cosmos.js needs tkinter for its window, and this Python does not have it.\n"
            "  Debian/Ubuntu:  sudo apt install python3-tk\n"
            "  Fedora:         sudo dnf install python3-tkinter\n"
            "  Arch:           sudo pacman -S tk\n"
            "\nWithout it you can still use --render and --emit, or open web/index.html.\n"
            "(%s)\n" % exc)
        return 1
    ui.main()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
