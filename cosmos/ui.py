"""The desktop app: a tkinter window with sliders, a live preview, and the
generated code.

tkinter ships with CPython, so this runs on a stock install with nothing to
pip. Plain tk widgets are used rather than ttk because they take direct colour
options, which is what makes a consistent dark theme possible without fighting
the platform theme engine.

Python renders roughly ten to thirty times slower than the browser build, so the
frame loop is adaptive: it schedules the next frame off how long the last one
actually took, and shows that cost in the status line. A heavy setting slows the
animation down rather than locking the window up.
"""
import random
import time
import tkinter as tk
from tkinter import colorchooser, font as tkfont

from . import emit, planet

BG      = "#000000"
PANEL   = "#0a0a0a"
PANEL_2 = "#131313"
LINE    = "#2f2f2f"
FG      = "#f2f2f2"
FG_2    = "#9a9a9a"
FG_3    = "#5f5f5f"
ON_BG   = "#1c1c1c"

MONO = ("DejaVu Sans Mono", "Menlo", "Consolas", "Courier New", "monospace")


def _mono(size):
    """First monospace family tkinter actually has, at the given size."""
    have = set(tkfont.families())
    for name in MONO:
        if name in have:
            return (name, size)
    return ("TkFixedFont", size)


# key, label, kind, and the numbers a slider needs
SPEC = [
    ("texture",    "texture",        "choice", None),
    ("rows",       "resolution",     "int",    (10, 70, 1)),
    ("size",       "size",           "int",    (5, 26, 1)),
    ("brightness", "brightness",     "float",  (0.35, 1.8, 0.01)),
    ("ambient",    "night side",     "float",  (0.0, 0.6, 0.01)),
    ("craters",    "crater count",   "int",    (0, 45, 1)),
    ("lumpiness",  "lumpiness",      "float",  (0.0, 1.4, 0.01)),
    ("tilt",       "tilt",           "float",  (-1.3, 1.3, 0.01)),
    ("roll",       "roll",           "float",  (-1.6, 1.6, 0.01)),
    ("speed",      "rotation speed", "float",  (0.0, 0.6, 0.005)),
    ("direction",  "direction",      "toggle", None),
    ("rings",      "rings",          "check",  None),
    ("ring_inner", "ring inner",     "float",  (1.05, 2.4, 0.01)),
    ("ring_outer", "ring outer",     "float",  (1.1, 3.2, 0.01)),
    ("color",      "colour",         "color",  None),
    ("seed",       "seed",           "seed",   None),
]


class App:
    def __init__(self, root):
        self.root = root
        self.cfg = planet.defaults()

        # Open on the finest grid the slider allows, at its smallest type.
        # Read off SPEC so retuning a range moves the starting point with it.
        for key, _label, _kind, rng_ in SPEC:
            if key == "rows":
                self.cfg["rows"] = rng_[1]
            if key == "size":
                self.cfg["size"] = rng_[0]

        self.angle = 0.0
        self.spinning = tk.BooleanVar(value=True)
        self.widgets = {}
        self.value_labels = {}
        self.frames = {}
        self._last_ms = 0.0

        # Built before the widgets, because laying out the code pane fills it
        # immediately and that needs a body to emit from. rebuild() replaces
        # this one once there is a font to measure the real cell aspect off.
        self.body = planet.Body(self.cfg, planet.CHAR_ASPECT)

        root.title("cosmos.js - ASCII planet generator")
        root.configure(bg=BG)
        root.geometry("1180x820")
        root.minsize(900, 600)

        self._build()
        self.rebuild()
        self._tick()

    # --- layout ------------------------------------------------------------
    def _build(self):
        head = tk.Frame(self.root, bg=BG)
        head.pack(fill="x", padx=14, pady=(12, 6))
        tk.Label(head, text="~/", font=_mono(15), bg=BG, fg=FG).pack(side="left")
        tk.Label(head, text="cosmos.js", font=_mono(15), bg=BG, fg=FG).pack(side="left")
        tk.Label(head, text="   ASCII planet generator", font=("TkDefaultFont", 10),
                 bg=BG, fg=FG_3).pack(side="left")

        body = tk.Frame(self.root, bg=BG)
        body.pack(fill="both", expand=True, padx=14, pady=(0, 12))

        # Controls scroll: at 16 controls the column is taller than a short
        # window, and a clipped seed box would look broken.
        left = tk.Frame(body, bg=PANEL, highlightthickness=1,
                        highlightbackground=LINE, width=272)
        left.pack(side="left", fill="y")
        left.pack_propagate(False)

        canvas = tk.Canvas(left, bg=PANEL, highlightthickness=0, width=250)
        bar = tk.Scrollbar(left, orient="vertical", command=canvas.yview)
        self.controls = tk.Frame(canvas, bg=PANEL)
        self.controls.bind("<Configure>",
                           lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.create_window((0, 0), window=self.controls, anchor="nw", width=248)
        canvas.configure(yscrollcommand=bar.set)
        canvas.pack(side="left", fill="both", expand=True, padx=(10, 0), pady=8)
        bar.pack(side="right", fill="y")
        canvas.bind_all("<Button-4>", lambda e: canvas.yview_scroll(-2, "units"))
        canvas.bind_all("<Button-5>", lambda e: canvas.yview_scroll(2, "units"))
        canvas.bind_all("<MouseWheel>",
                        lambda e: canvas.yview_scroll(-1 * (e.delta // 120), "units"))

        right = tk.Frame(body, bg=BG)
        right.pack(side="left", fill="both", expand=True, padx=(12, 0))

        # preview
        prev = tk.Frame(right, bg=PANEL, highlightthickness=1, highlightbackground=LINE)
        prev.pack(fill="both", expand=True)
        head2 = tk.Frame(prev, bg=PANEL)
        head2.pack(fill="x", padx=10, pady=(6, 0))
        self.status = tk.Label(head2, text="", font=_mono(9), bg=PANEL, fg=FG_3)
        self.status.pack(side="left")
        tk.Checkbutton(head2, text="spin", variable=self.spinning, font=_mono(9),
                       bg=PANEL, fg=FG_2, selectcolor=PANEL_2, activebackground=PANEL,
                       activeforeground=FG, highlightthickness=0,
                       bd=0).pack(side="right")
        self.canvas = tk.Text(prev, bg="#050505", fg=FG, bd=0, highlightthickness=0,
                              state="disabled", wrap="none", cursor="arrow")
        self.canvas.pack(fill="both", expand=True, padx=10, pady=10)

        # code
        code = tk.Frame(right, bg=PANEL, highlightthickness=1, highlightbackground=LINE)
        code.pack(fill="both", expand=True, pady=(12, 0))
        tabs = tk.Frame(code, bg=PANEL)
        tabs.pack(fill="x", padx=10, pady=(6, 0))
        self.tab = "py"
        self.tab_btns = {}
        for key, label in (("py", "planet.py"), ("js", "planet.js")):
            b = tk.Button(tabs, text=label, font=_mono(9), bd=0, padx=12, pady=4,
                          highlightthickness=1, cursor="hand2",
                          command=lambda k=key: self._show_tab(k))
            b.pack(side="left", padx=(0, 6))
            self.tab_btns[key] = b
        tk.Button(tabs, text="Copy", font=_mono(9), bg=PANEL_2, fg=FG, bd=0,
                  padx=12, pady=4, highlightthickness=1, highlightbackground=LINE,
                  activebackground=ON_BG, activeforeground=FG, cursor="hand2",
                  command=self._copy).pack(side="right")
        self.copy_btn = tabs.winfo_children()[-1]

        wrap = tk.Frame(code, bg=PANEL)
        wrap.pack(fill="both", expand=True, padx=10, pady=10)
        self.code = tk.Text(wrap, bg=PANEL_2, fg=FG_2, bd=0, highlightthickness=0,
                            wrap="none", font=_mono(9), insertbackground=FG, height=12)
        ybar = tk.Scrollbar(wrap, orient="vertical", command=self.code.yview)
        self.code.configure(yscrollcommand=ybar.set)
        ybar.pack(side="right", fill="y")
        self.code.pack(side="left", fill="both", expand=True)

        self._build_controls()
        self._show_tab("py")

    def _row(self, key, label):
        f = tk.Frame(self.controls, bg=PANEL)
        f.pack(fill="x", pady=(9, 0))
        top = tk.Frame(f, bg=PANEL)
        top.pack(fill="x")
        tk.Label(top, text=label, font=_mono(9), bg=PANEL, fg=FG_2).pack(side="left")
        v = tk.Label(top, text="", font=_mono(9), bg=PANEL, fg=FG)
        v.pack(side="right")
        self.value_labels[key] = v
        return f

    def _build_controls(self):
        for key, label, kind, rng_ in SPEC:
            f = self._row(key, label)
            self.frames[key] = f

            if kind in ("int", "float"):
                lo, hi, step = rng_
                var = tk.DoubleVar(value=self.cfg[key])
                sc = tk.Scale(f, from_=lo, to=hi, resolution=step, orient="horizontal",
                              variable=var, showvalue=False, bg=PANEL, fg=FG,
                              troughcolor=PANEL_2, activebackground=FG,
                              highlightthickness=0, bd=0, sliderrelief="flat",
                              sliderlength=16, width=10,
                              command=lambda _v, k=key, kd=kind: self._slid(k, kd))
                sc.pack(fill="x")
                self.widgets[key] = var

            elif kind == "choice":
                var = tk.StringVar(value=self.cfg[key])
                labels = [planet.TEXTURE_LABELS.get(t, t) for t in planet.TEXTURE_ORDER]
                om = tk.OptionMenu(f, var, *labels,
                                   command=lambda _v, k=key: self._chose(k))
                om.configure(bg=PANEL_2, fg=FG, font=_mono(9), bd=0,
                             highlightthickness=1, highlightbackground=LINE,
                             activebackground=ON_BG, activeforeground=FG,
                             anchor="w", padx=8)
                om["menu"].configure(bg=PANEL_2, fg=FG, font=_mono(9),
                                     activebackground=ON_BG, activeforeground=FG, bd=0)
                om.pack(fill="x")
                self.widgets[key] = var

            elif kind == "toggle":
                row = tk.Frame(f, bg=PANEL)
                row.pack(fill="x")
                self.dir_btns = {}
                for val, text in ((-1, "clockwise"), (1, "counterclockwise")):
                    b = tk.Button(row, text=text, font=_mono(8), bd=0, pady=4,
                                  highlightthickness=1, cursor="hand2",
                                  command=lambda v=val: self._set_dir(v))
                    b.pack(side="left", fill="x", expand=True, padx=(0, 4))
                    self.dir_btns[val] = b

            elif kind == "check":
                var = tk.BooleanVar(value=self.cfg[key])
                tk.Checkbutton(f, text="draw a ring system", variable=var,
                               font=_mono(9), bg=PANEL, fg=FG_2, selectcolor=PANEL_2,
                               activebackground=PANEL, activeforeground=FG,
                               highlightthickness=0, bd=0,
                               command=lambda k=key: self._checked(k)).pack(anchor="w")
                self.widgets[key] = var

            elif kind == "color":
                b = tk.Button(f, text="", bd=0, height=1, highlightthickness=1,
                              highlightbackground=LINE, cursor="hand2",
                              command=self._pick_color)
                b.pack(fill="x")
                self.widgets[key] = b

            elif kind == "seed":
                var = tk.StringVar(value=str(self.cfg[key]))
                e = tk.Entry(f, textvariable=var, font=_mono(9), bg=PANEL_2, fg=FG,
                             bd=0, highlightthickness=1, highlightbackground=LINE,
                             insertbackground=FG)
                e.pack(fill="x", ipady=3)
                e.bind("<Return>", lambda _e: self._seed_typed())
                e.bind("<FocusOut>", lambda _e: self._seed_typed())
                self.widgets[key] = var

        btns = tk.Frame(self.controls, bg=PANEL)
        btns.pack(fill="x", pady=(14, 12))
        for text, cmd in (("Randomize", self.randomize), ("Reset", self.reset)):
            tk.Button(btns, text=text, font=_mono(9), bg=PANEL_2, fg=FG, bd=0,
                      pady=6, highlightthickness=1, highlightbackground=LINE,
                      activebackground=ON_BG, activeforeground=FG, cursor="hand2",
                      command=cmd).pack(side="left", fill="x", expand=True, padx=(0, 6))

        self._sync()

    # --- control callbacks -------------------------------------------------
    def _slid(self, key, kind):
        v = self.widgets[key].get()
        self.cfg[key] = int(round(v)) if kind == "int" else v
        # Size only changes how the preview is painted, not the geometry.
        self._sync_labels()
        if key == "size":
            self._repaint_font()
        else:
            self.rebuild()

    def _chose(self, key):
        label = self.widgets[key].get()
        for t in planet.TEXTURE_ORDER:
            if planet.TEXTURE_LABELS.get(t, t) == label:
                self.cfg[key] = t
                break
        self.rebuild()

    def _set_dir(self, v):
        self.cfg["direction"] = v
        self._sync()
        self.rebuild()

    def _checked(self, key):
        self.cfg[key] = bool(self.widgets[key].get())
        self._sync()
        self.rebuild()

    def _pick_color(self):
        got = colorchooser.askcolor(color=self.cfg["color"], parent=self.root)
        if got and got[1]:
            self.cfg["color"] = got[1]
            self._sync()
            self._repaint_font()

    def _seed_typed(self):
        raw = self.widgets["seed"].get().strip()
        try:
            self.cfg["seed"] = int(raw) & 0xFFFFFFFF
        except ValueError:
            self.widgets["seed"].set(str(self.cfg["seed"]))
            return
        self.rebuild()

    def randomize(self):
        r = random.random
        c = self.cfg
        c["texture"] = random.choice(planet.TEXTURE_ORDER)
        c["seed"] = random.randrange(1 << 30)
        c["craters"] = random.randint(4, 34)
        c["lumpiness"] = (r() * 0.7 + 0.5) if c["texture"] == "rock" else (r() * 0.4 + 0.1 if r() < 0.25 else 0.0)
        c["tilt"] = r() * 1.8 - 0.9
        c["roll"] = r() * 2.4 - 1.2
        c["speed"] = 0.03 + r() * 0.25
        c["direction"] = random.choice((-1, 1))
        c["brightness"] = 0.75 + r() * 0.6
        c["ambient"] = 0.05 + r() * 0.25
        # A hue at high lightness, not three random bytes: those land on mud
        # about half the time.
        c["color"] = "#%02x%02x%02x" % tuple(
            int(v * 255) for v in _hsl(r() * 360, 55 + r() * 35, 60 + r() * 22))
        c["rings"] = r() < 0.35
        if c["rings"]:
            c["ring_inner"] = 1.15 + r() * 0.35
            c["ring_outer"] = c["ring_inner"] + 0.5 + r() * 0.9
            if abs(c["tilt"]) < 0.2:            # else the rings are edge-on
                c["tilt"] = 0.2 + r() * 0.4
        self._sync()
        self.rebuild()

    def reset(self):
        self.cfg = planet.defaults()
        for key, _l, _k, rng_ in SPEC:
            if key == "rows":
                self.cfg["rows"] = rng_[1]
            if key == "size":
                self.cfg["size"] = rng_[0]
        self._sync()
        self.rebuild()

    # --- state -> widgets --------------------------------------------------
    def _sync(self):
        for key, _label, kind, _r in SPEC:
            if kind in ("int", "float"):
                self.widgets[key].set(self.cfg[key])
            elif kind == "choice":
                t = self.cfg[key]
                self.widgets[key].set(planet.TEXTURE_LABELS.get(t, t))
            elif kind == "check":
                self.widgets[key].set(self.cfg[key])
            elif kind == "seed":
                self.widgets[key].set(str(self.cfg[key]))
            elif kind == "color":
                self.widgets[key].configure(bg=self.cfg[key], activebackground=self.cfg[key])

        for val, b in getattr(self, "dir_btns", {}).items():
            on = val == self.cfg["direction"]
            b.configure(bg=ON_BG if on else PANEL_2, fg=FG if on else FG_2,
                        highlightbackground=FG if on else LINE)

        self._ring_rows()

        # An inner radius above the outer one draws nothing at all, which looks
        # like a bug rather than a setting.
        if self.cfg["ring_outer"] < self.cfg["ring_inner"] + 0.15:
            self.cfg["ring_outer"] = self.cfg["ring_inner"] + 0.15
            self.widgets["ring_outer"].set(self.cfg["ring_outer"])
        self._sync_labels()

    def _ring_rows(self):
        """Show the ring radii only when there are rings for them to apply to,
        as the browser build does. Packed back before the colour row so they
        return to their place in the column rather than to the bottom."""
        for key in ("ring_inner", "ring_outer"):
            f = self.frames.get(key)
            if f is None:
                continue
            if self.cfg["rings"]:
                if not f.winfo_ismapped():
                    f.pack(fill="x", pady=(9, 0), before=self.frames["color"])
            else:
                f.pack_forget()

    def _sync_labels(self):
        for key, _label, kind, _r in SPEC:
            lab = self.value_labels[key]
            v = self.cfg[key]
            if kind == "int":
                lab.configure(text=("%d rows" % v) if key == "rows" else str(int(v)))
            elif kind == "float":
                lab.configure(text="%.2f" % v)
            elif kind == "seed":
                lab.configure(text="")
            else:
                lab.configure(text="")

    def _show_tab(self, key):
        self.tab = key
        for k, b in self.tab_btns.items():
            on = k == key
            b.configure(bg=ON_BG if on else PANEL_2, fg=FG if on else FG_3,
                        highlightbackground=FG if on else LINE)
        self._fill_code()

    def _copy(self):
        self.root.clipboard_clear()
        self.root.clipboard_append(self.code.get("1.0", "end-1c"))
        self.copy_btn.configure(text="Copied")
        self.root.after(1200, lambda: self.copy_btn.configure(text="Copy"))

    # --- render ------------------------------------------------------------
    def _aspect(self):
        """Measure the preview font's real advance over its line height. A
        character cell is taller than it is wide, so a disk drawn on a square
        grid of them comes out an egg."""
        f = tkfont.Font(font=_mono(int(self.cfg["size"])))
        adv = f.measure("M")
        lh = f.metrics("linespace")
        return (adv / lh) if lh else planet.CHAR_ASPECT

    def rebuild(self):
        self.body = planet.Body(self.cfg, self._aspect())
        self._repaint_font()
        self._fill_code()
        self.paint()

    def _repaint_font(self):
        self.canvas.configure(font=_mono(int(self.cfg["size"])), fg=self.cfg["color"])

    def _fill_code(self):
        src = (emit.python(self.cfg, self.body) if self.tab == "py"
               else emit.javascript(self.cfg, self.body))
        self.code.configure(state="normal")
        self.code.delete("1.0", "end")
        self.code.insert("1.0", src)
        self.code.configure(state="normal")   # left editable so it can be selected

    def paint(self):
        t0 = time.perf_counter()
        art = planet.render(self.body, self.angle)
        self._last_ms = (time.perf_counter() - t0) * 1000
        self.canvas.configure(state="normal")
        self.canvas.delete("1.0", "end")
        self.canvas.insert("1.0", art)
        self.canvas.configure(state="disabled")
        self.status.configure(
            text="%d x %d glyphs   %.0f ms/frame" % (self.body.cols, self.body.rows, self._last_ms))

    def _tick(self):
        if self.spinning.get():
            # Adaptive: never queue the next frame sooner than the last one took,
            # so a heavy setting slows the spin instead of locking the window.
            step = max(0.033, self._last_ms / 1000.0)
            self.angle += step * self.cfg["speed"] * self.cfg["direction"]
            self.paint()
        delay = max(33, int(self._last_ms) + 5)
        self.root.after(delay, self._tick)


def _hsl(h, s, l):
    """HSL to RGB floats. Picking a hue keeps every roll bright and saturated."""
    h, s, l = h / 360.0, s / 100.0, l / 100.0
    q = l * (1 + s) if l < 0.5 else l + s - l * s
    p = 2 * l - q

    def f(t):
        t = t % 1.0
        if t < 1 / 6:
            return p + (q - p) * 6 * t
        if t < 1 / 2:
            return q
        if t < 2 / 3:
            return p + (q - p) * (2 / 3 - t) * 6
        return p

    return f(h + 1 / 3), f(h), f(h - 1 / 3)


def main():
    root = tk.Tk()
    App(root)
    root.mainloop()
