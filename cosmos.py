#!/usr/bin/env python3
"""cosmos.js - ASCII planet generator.

    python3 cosmos.py

Serves web/ on a loopback port, opens your browser at it, and shuts itself down
when the page stops answering. Closing the tab closes the program.

Standard library only, and all of it is plumbing: the generator itself is the
JavaScript under web/, which is also what runs if you just open web/index.html
straight off the disk.

How the shutdown works: the page pings /__alive every couple of seconds. A
watchdog thread arms on the first ping and stops the server once the pings stop
for --timeout seconds. That survives a reload, which takes well under the
timeout, and it does not rely on catching a close event the browser is under no
obligation to send.
"""
import argparse
import http.server
import os
import sys
import threading
import time
import webbrowser

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
PING_PATH = "/__alive"    # kept in step with the fetch() in web/js/app.js
IDLE_TIMEOUT = 5.0        # seconds of silence before the server gives up
POLL = 0.5                # how often the watchdog checks, in seconds


class State:
    """Shared between the request handler and the watchdog."""

    def __init__(self):
        self.last_ping = None          # None until the page first says hello
        self.lock = threading.Lock()

    def touch(self):
        with self.lock:
            self.last_ping = time.monotonic()

    def silent_for(self):
        """Seconds since the last ping, or None if there has never been one."""
        with self.lock:
            if self.last_ping is None:
                return None
            return time.monotonic() - self.last_ping


def make_handler(state, quiet):
    """Build the request handler class.

    A factory rather than a plain class because http.server constructs a fresh
    handler per request and gives us no way to pass anything in: the shared
    state and the quiet flag have to be closed over instead.
    """

    class Handler(http.server.SimpleHTTPRequestHandler):
        """Serves web/, with one extra route: PING_PATH, the heartbeat."""

        def __init__(self, *a, **kw):
            super().__init__(*a, directory=ROOT, **kw)

        def _ping(self):
            state.touch()
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_POST(self):
            if self.path == PING_PATH:
                self._ping()
            else:
                self.send_error(404)

        def do_GET(self):
            if self.path == PING_PATH:
                self._ping()
            else:
                super().do_GET()

        def end_headers(self):
            # This app gets edited in place, and a cached app.js is a confusing
            # way to lose ten minutes.
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def log_message(self, fmt, *args):
            if not quiet:
                super().log_message(fmt, *args)

    return Handler


def watchdog(state, server, timeout):
    """Arms on the first ping, then shuts the server down when they stop."""
    while True:
        time.sleep(POLL)
        silent = state.silent_for()
        if silent is None:
            continue                    # the page has not loaded yet; keep waiting
        if silent > timeout:
            server.shutdown()
            return


def main(argv=None):
    """Start the server, open a browser at it, and wait.

    Returns a process exit code, so the failures below read as `return 1`
    rather than as exceptions the user has to interpret.
    """
    ap = argparse.ArgumentParser(description="Serve the cosmos.js planet generator.")
    ap.add_argument("--port", type=int, default=0,
                    help="port to serve on (default: let the OS pick a free one)")
    ap.add_argument("--no-open", action="store_true",
                    help="do not open a browser, just print the URL")
    ap.add_argument("--timeout", type=float, default=IDLE_TIMEOUT,
                    help="seconds without a ping before shutting down "
                         "(default: %(default)s)")
    ap.add_argument("--verbose", action="store_true", help="log every request")
    args = ap.parse_args(argv)

    if not os.path.isdir(ROOT):
        sys.stderr.write("cosmos.js: cannot find %s\n" % ROOT)
        return 1

    state = State()
    handler = make_handler(state, quiet=not args.verbose)

    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    except OSError as exc:
        sys.stderr.write("cosmos.js: cannot serve on port %s (%s)\n" % (args.port, exc))
        return 1
    server.daemon_threads = True

    url = "http://127.0.0.1:%d/" % server.server_address[1]
    # Flushed: stdout is block-buffered when this is piped or captured, and a
    # URL that shows up minutes later is no use to anyone.
    print("cosmos.js  ->  %s" % url, flush=True)
    print("close the tab to stop the server, or press Ctrl-C", flush=True)

    threading.Thread(target=watchdog, args=(state, server, args.timeout),
                     daemon=True).start()

    if not args.no_open:
        # A browser that takes its time opening cannot trip the watchdog: the
        # watchdog does not arm until the first ping arrives.
        threading.Thread(target=webbrowser.open, args=(url,), daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
    finally:
        server.server_close()
    print("cosmos.js  stopped", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
