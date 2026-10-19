"""
Air Swipe for PowerPoint — PSSDC training suite.

Watches the webcam for hand gestures and presses the matching keys in whatever
window is in front (PowerPoint, Google Slides, a PDF viewer…):

  right hand, palm to camera, sweeping left  -> Right arrow (next slide)
  left hand, palm to camera, sweeping right  -> Left arrow  (previous slide)
  hold an open palm (1 s) -> B            (black screen on/off in PowerPoint)
  two hands apart/together-> + / -        (PowerPoint slide-show zoom)
  clap                    -> back to normal zoom

F9 turns gestures on or off from anywhere.
"""
import json
import math
import os
import queue
import struct
import sys
import tempfile
import threading
import time
import wave
import random
import tkinter as tk
from tkinter import ttk

import cv2
from PIL import Image, ImageTk
from pynput import keyboard
import mediapipe as mp
import qrcode
import websocket  # websocket-client

SUPABASE_URL = "https://ncfgthjozyombclfjxmk.supabase.co"
SUPABASE_KEY = "sb_publishable_Y5xdRl5QmqUVYCTznlpKbg_HXx7JAT1"   # public key, safe to ship
REMOTE_PAGE = "https://tapin-alpha.vercel.app/remote/#"

APP = "Air Swipe for PowerPoint"
SETTINGS_DIR = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "AirSwipe")
SETTINGS_FILE = os.path.join(SETTINGS_DIR, "settings.json")
DEFAULTS = {"gestures": True, "sound": True, "zoom": True, "roles": True, "swap": False, "sensitivity": 3, "on_top": True, "camera": 0,
            "right_label": None, "right_sign": None}  # learned once by "Check my hands"
SENS_DIST = [0.26, 0.21, 0.16, 0.12, 0.09]  # share of the camera picture the hand must travel
SENS_LABELS = ["Very low", "Low", "Medium", "High", "Very high"]

WINDOW_S, COOLDOWN_S, HOLD_S, SETTLE_S = 0.6, 0.7, 1.5, 0.2  # palm must be held still 1.5 s, since palms also swipe
DROPOUT_S = 0.3      # a fast swipe blurs the hand for a few frames; don't forget it straight away
RECOIL_S = 1.3       # after a swipe, ignore the hand travelling back the other way
VK_ADD, VK_SUBTRACT = 0x6B, 0x6D  # numeric keypad + and -, which PowerPoint's slide show uses for zoom

GREEN, GOLD, DARK, MUTED = "#3fb98a", "#e8b44a", "#0b1612", "#8fa69b"


# ---------------------------------------------------------------- settings
def load_settings():
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            return {**DEFAULTS, **json.load(f)}
    except Exception:
        return dict(DEFAULTS)


def save_settings(s):
    try:
        os.makedirs(SETTINGS_DIR, exist_ok=True)
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(s, f)
    except Exception:
        pass


# ---------------------------------------------------------------- swoosh sound
def make_swoosh(path, f0, f1, dur, rate=22050):
    """Noise swept through a band-pass filter: the 'fwip' of a waved cloth."""
    n = int(rate * dur)
    rng = random.Random(7)
    low = band = 0.0
    q = 1.1
    out = []
    for i in range(n):
        t = i / n
        fc = f0 * (f1 / f0) ** min(1.0, t / 0.85)
        f = 2 * math.sin(math.pi * fc / rate)
        x = rng.uniform(-1, 1)
        high = x - low - q * band
        band += f * high
        low += f * band
        env = (t / 0.35) ** 2 if t < 0.35 else ((1 - t) / 0.65) ** 1.6
        out.append(max(-1.0, min(1.0, band * env * 0.9)))
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", int(v * 32000)) for v in out))


class Sounds:
    def __init__(self):
        self.files = {}
        try:
            d = os.path.join(tempfile.gettempdir(), "airswipe_sounds")
            os.makedirs(d, exist_ok=True)
            for name, (a, b, dur) in {"next": (500, 3600, 0.36), "prev": (3200, 500, 0.36), "pause": (900, 300, 0.5)}.items():
                p = os.path.join(d, f"{name}.wav")
                if not os.path.exists(p):
                    make_swoosh(p, a, b, dur)
                self.files[name] = p
        except Exception:
            self.files = {}

    def play(self, name):
        p = self.files.get(name)
        if not p:
            return
        try:
            import winsound
            winsound.PlaySound(p, winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT)
        except Exception:
            pass


# ---------------------------------------------------------------- gesture engine
def palm_centre(lm):
    pts = [lm[i] for i in (0, 5, 9, 13, 17)]
    return sum(p.x for p in pts) / 5, sum(p.y for p in pts) / 5


def is_open_palm(lm):
    """Four fingers straight (tips further from the wrist than their middle joints) and thumb out."""
    w = lm[0]
    def d(a): return math.hypot(lm[a].x - w.x, lm[a].y - w.y)
    fingers = all(d(tip) > d(pip) * 1.15 for tip, pip in ((8, 6), (12, 10), (16, 14), (20, 18)))
    size = math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) or 0.1
    thumb = math.hypot(lm[4].x - lm[5].x, lm[4].y - lm[5].y) / size > 0.55
    return fingers and thumb


def palm_z(lm):
    """Turn of wrist -> index knuckle -> little-finger knuckle; its sign flips between palm and back of the hand."""
    ax, ay = lm[5].x - lm[0].x, lm[5].y - lm[0].y
    bx, by = lm[17].x - lm[0].x, lm[17].y - lm[0].y
    return ax * by - ay * bx


def which_hand(label, settings):
    """Webcams differ in how left and right come out, so use what "Check my hands" learned on this computer."""
    right_label = settings.get("right_label")
    if right_label:
        h = "right" if label == right_label else "left" if label else None
    else:
        h = {"Left": "left", "Right": "right"}.get(label)
    if h and settings.get("swap"):
        h = "left" if h == "right" else "right"
    return h


def palm_facing(lm, hand, settings):
    """True when the palm faces the camera. A left palm turns the opposite way to a right palm."""
    right_sign = settings.get("right_sign") or -1
    expected = right_sign if hand == "right" else -right_sign
    return palm_z(lm) * expected > 0


class Engine:
    """Turns hand landmarks into key presses. All times in seconds."""

    def __init__(self, app):
        self.app = app
        self.kb = keyboard.Controller()
        self.history = []
        self.hand_since = 0
        self.cooldown_until = 0
        self.hold_start = 0
        self.hold_latched = False
        self.zoom_ref = None
        self.zoom_steps = 0
        self.blank = False
        self.last_seen = 0
        self.last_dir = None
        self.last_dir_at = 0
        self.seen_hand = (None, False)
        self.calib = None

    # ---- one-time check: the presenter raises their RIGHT palm and we learn how this webcam reports it
    def start_calibration(self):
        self.calib = {"start": time.monotonic(), "labels": [], "signs": []}
        self.app.status_q.put(("calib", "Raise your RIGHT hand, palm facing the camera, and hold it there…"))

    def calibrate(self, lm, label, now):
        c = self.calib
        if label:
            c["labels"].append(label)
            z = palm_z(lm)
            if abs(z) > 1e-4:
                c["signs"].append(1 if z > 0 else -1)
        if len(c["labels"]) >= 25 and len(c["signs"]) >= 15:
            s = self.app.settings
            s["right_label"] = max(set(c["labels"]), key=c["labels"].count)
            s["right_sign"] = 1 if sum(c["signs"]) > 0 else -1
            s["swap"] = False
            save_settings(s)
            self.calib = None
            self.app.status_q.put(("calibdone", "Hands checked ✓  Right palm ← next · Left palm → back"))
        elif now - c["start"] > 15:
            self.calib = None
            self.app.status_q.put(("calibfail", "Couldn't see your hand clearly. Click Check my hands to try again."))

    def tap(self, key):
        try:
            self.kb.press(key); self.kb.release(key)
        except Exception:
            pass

    def reset_single(self):
        self.history = []; self.hand_since = 0; self.hold_start = 0

    def update(self, hands, now, labels=None):
        s = self.app.settings
        if not s["gestures"] and self.calib is None:
            self.reset_single(); self.zoom_ref = None
            return 0.0
        # ---- two hands: zoom
        if s["zoom"] and len(hands) == 2:
            self.reset_single()
            return self.two_hands(hands, now)
        self.zoom_ref = None
        if not hands and self.calib is not None:
            if now - self.calib["start"] > 15:
                self.calib = None
                self.app.status_q.put(("calibfail", "Couldn't see your hand. Click Check my hands to try again."))
            return 0.0
        if not hands:
            # Fast movement often loses the hand for a few frames, or it leaves the picture at the end of a swipe.
            # Judge the swipe on what was already seen before forgetting it.
            if self.history and now - self.last_seen < DROPOUT_S:
                self.try_swipe(now)
                return 0.0
            self.reset_single(); self.hold_latched = False
            return 0.0
        lm = hands[0]
        self.last_seen = now
        if not self.hand_since:
            self.hand_since = now
        x, y = palm_centre(lm)
        label = (labels or [None])[0]
        if self.calib is not None:
            self.calibrate(lm, label, now)
            return 0.0
        hand = which_hand(label, s)
        front = palm_facing(lm, hand, s) if hand else False
        self.seen_hand = (hand, front)
        self.history.append((now, x, y, hand, front))
        self.history = [h for h in self.history if now - h[0] <= WINDOW_S]

        # ---- open palm held still: black screen toggle
        recent = [h for h in self.history if now - h[0] < 0.5]
        spread = (max(h[1] for h in recent) - min(h[1] for h in recent) + max(h[2] for h in recent) - min(h[2] for h in recent)) if recent else 1
        palm = is_open_palm(lm)
        meter = 0.0
        if palm and spread < 0.05:
            if not self.hold_start:
                self.hold_start = now
            meter = 0.0 if self.hold_latched else min(1.0, (now - self.hold_start) / HOLD_S)
            if meter >= 1 and not self.hold_latched:
                self.hold_latched = True
                self.blank = not self.blank
                self.tap("b")
                self.app.event("pause", "Screen dark" if self.blank else "Slide back")
                self.cooldown_until = now + COOLDOWN_S
                self.history = []
                return 0.0
        else:
            self.hold_start = 0
            if not palm:
                self.hold_latched = False

        # ---- swipes
        self.try_swipe(now)
        return meter

    def try_swipe(self, now):
        s = self.app.settings
        if now < self.cooldown_until or len(self.history) < 3 or (self.hand_since and now - self.hand_since < SETTLE_S):
            return
        # Use the largest travel inside the window, not just first-to-last, so a swipe that curves back still counts.
        xs = [h[1] for h in self.history]; ys = [h[2] for h in self.history]
        i_min_x, i_max_x = xs.index(min(xs)), xs.index(max(xs))
        i_min_y, i_max_y = ys.index(min(ys)), ys.index(max(ys))
        dx = (max(xs) - min(xs)) * (1 if i_max_x > i_min_x else -1)
        dy = (max(ys) - min(ys)) * (1 if i_max_y > i_min_y else -1)
        need = SENS_DIST[s["sensitivity"] - 1]
        direction = None
        if abs(dx) >= need and abs(dy) < 0.8 * abs(dx):
            # The camera picture is not mirrored: moving to the presenter's left moves right in the picture.
            direction = "left" if dx > 0 else "right"   # up and down are ignored
        if not direction:
            return
        if s["roles"]:
            # Only the right hand goes forward and only the left hand goes back, so a hand drifting back is ignored.
            # Anything else, like a hand drifting back after a swipe, is ignored.
            hands_seen = [h[3] for h in self.history if h[3]]
            hand = max(set(hands_seen), key=hands_seen.count) if hands_seen else None
            front = sum(1 for h in self.history if h[4]) >= len(self.history) / 2
            # Palm to the camera: right hand sweeping left goes forward, left hand sweeping right goes back.
            ok = (hand == "right" and front) if direction == "left" else (hand == "left" and front)
            if not ok:
                self.history = []
                return
        opposite = {"left": "right", "right": "left"}
        if self.last_dir and direction == opposite[self.last_dir] and now - self.last_dir_at < RECOIL_S:
            self.history = []  # that was the hand coming back, not a new swipe
            return
        if self.blank:
            self.blank = False
            self.tap("b")
            self.app.event("pause", "Slide back")
        elif direction == "left":
            self.tap(keyboard.Key.right)
            self.app.event("next", "Next ▶")
        else:
            self.tap(keyboard.Key.left)
            self.app.event("prev", "◀ Previous")
        self.last_dir, self.last_dir_at = direction, now
        self.cooldown_until = now + COOLDOWN_S
        self.history = []
        self.hold_start = 0

    def two_hands(self, hands, now):
        (ax, ay), (bx, by) = palm_centre(hands[0]), palm_centre(hands[1])
        d = math.hypot(ax - bx, (ay - by) * 0.75)
        if now < self.cooldown_until:
            return 0.0
        if d < 0.08:  # clap: back to normal
            if self.zoom_steps > 0:
                for _ in range(self.zoom_steps):
                    self.tap(keyboard.KeyCode.from_vk(VK_SUBTRACT)); time.sleep(0.03)
                self.zoom_steps = 0
                self.app.event("prev", "Full view")
            self.zoom_ref = None
            self.cooldown_until = now + 0.8
            return 0.0
        if self.zoom_ref is None:
            self.zoom_ref = (now, d)
            return 0.0
        t0, ref = self.zoom_ref
        if now - t0 < 0.2:
            self.zoom_ref = (t0, d)
            return 0.0
        if d / ref >= 1.18 and self.zoom_steps < 6:
            self.tap(keyboard.KeyCode.from_vk(VK_ADD)); self.zoom_steps += 1
            self.zoom_ref = (t0, d); self.app.event(None, f"Zoom in ×{self.zoom_steps}")
        elif d / ref <= 0.85 and self.zoom_steps > 0:
            self.tap(keyboard.KeyCode.from_vk(VK_SUBTRACT)); self.zoom_steps -= 1
            self.zoom_ref = (t0, d); self.app.event(None, "Zoom out" if self.zoom_steps else "Full view")
        return 0.0


# ---------------------------------------------------------------- camera thread
class Camera(threading.Thread):
    def __init__(self, app):
        super().__init__(daemon=True)
        self.app = app
        self.stop_flag = threading.Event()

    def run(self):
        idx = self.app.settings.get("camera", 0)
        cap = cv2.VideoCapture(idx, cv2.CAP_DSHOW) if sys.platform == "win32" else cv2.VideoCapture(idx)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        if not cap.isOpened():
            self.app.status_q.put(("error", "No camera found. Check the webcam is connected and not used by another app."))
            return
        self.app.status_q.put(("ok", "Watching for gestures"))
        drawing = mp.solutions.drawing_utils
        hands_sol = mp.solutions.hands
        with hands_sol.Hands(max_num_hands=2, model_complexity=0, min_detection_confidence=0.6, min_tracking_confidence=0.5) as tracker:
            while not self.stop_flag.is_set():
                ok, frame = cap.read()
                if not ok:
                    time.sleep(0.05)
                    continue
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                rgb.flags.writeable = False
                res = tracker.process(rgb)
                hands = [h.landmark for h in (res.multi_hand_landmarks or [])]
                labels = [h.classification[0].label for h in (res.multi_handedness or [])]
                meter = self.app.engine.update(hands, time.monotonic(), labels)
                # small mirrored preview for the window
                preview = frame.copy()
                for h in (res.multi_hand_landmarks or []):
                    drawing.draw_landmarks(preview, h, hands_sol.HAND_CONNECTIONS,
                                           drawing.DrawingSpec(color=(74, 180, 232), thickness=2, circle_radius=3),
                                           drawing.DrawingSpec(color=(138, 185, 63), thickness=2))
                preview = cv2.flip(preview, 1)
                preview = cv2.resize(preview, (320, 240))
                try:
                    self.app.frame_q.put_nowait((cv2.cvtColor(preview, cv2.COLOR_BGR2RGB), bool(hands), meter))
                except queue.Full:
                    pass
        cap.release()


# ---------------------------------------------------------------- phone remote
class Remote(threading.Thread):
    """Listens on a Supabase Realtime channel for Next / Previous / Pause sent from the phone remote page."""

    def __init__(self, app, code):
        super().__init__(daemon=True)
        self.app, self.code = app, code
        self.topic = f"realtime:remote-{code}"
        self.ref = 0
        self.ws = None

    def send(self, event, payload, topic=None):
        self.ref += 1
        try:
            self.ws.send(json.dumps({"topic": topic or self.topic, "event": event, "payload": payload, "ref": str(self.ref)}))
        except Exception:
            pass

    def run(self):
        url = SUPABASE_URL.replace("https://", "wss://") + f"/realtime/v1/websocket?apikey={SUPABASE_KEY}&vsn=1.0.0"
        while True:
            try:
                self.ws = websocket.create_connection(url, timeout=30)
                self.send("phx_join", {"config": {"broadcast": {"self": False, "ack": False}, "presence": {"key": ""}, "private": False}})
                self.app.status_q.put(("remote", "Phone remote ready"))
                last_beat = time.monotonic()
                self.ws.settimeout(5)
                while True:
                    if time.monotonic() - last_beat > 25:
                        self.send("heartbeat", {}, topic="phoenix"); last_beat = time.monotonic()
                    try:
                        raw = self.ws.recv()
                    except websocket.WebSocketTimeoutException:
                        continue
                    if not raw:
                        raise ConnectionError("closed")
                    msg = json.loads(raw)
                    if msg.get("event") == "broadcast":
                        inner = msg.get("payload", {})
                        if inner.get("event") == "cmd":
                            self.handle(inner.get("payload", {}).get("cmd"))
            except Exception:
                self.app.status_q.put(("remote", "Phone remote reconnecting…"))
                time.sleep(3)

    def handle(self, cmd):
        e = self.app.engine
        if cmd == "next":
            e.tap(keyboard.Key.right); self.app.event("next", "Next ▶ (phone)")
        elif cmd == "prev":
            e.tap(keyboard.Key.left); self.app.event("prev", "◀ Previous (phone)")
        elif cmd == "blank":
            e.blank = not e.blank; e.tap("b"); self.app.event("pause", "Screen dark (phone)" if e.blank else "Slide back (phone)")
        if cmd in ("next", "prev", "blank", "hello"):
            self.send("broadcast", {"type": "broadcast", "event": "state", "payload": {"ok": True, "app": "desktop", "blank": e.blank}})


# ---------------------------------------------------------------- window
class App:
    def __init__(self):
        self.settings = load_settings()
        self.sounds = Sounds()
        self.engine = Engine(self)
        self.frame_q = queue.Queue(maxsize=2)
        self.status_q = queue.Queue()
        self.msg_until = 0

        self.root = tk.Tk()
        self.root.title(APP)
        self.root.configure(bg=DARK)
        self.root.resizable(False, False)
        self.root.attributes("-topmost", self.settings["on_top"])
        self.root.protocol("WM_DELETE_WINDOW", self.quit)

        style = ttk.Style(self.root)
        try: style.theme_use("clam")
        except Exception: pass
        style.configure("TCheckbutton", background=DARK, foreground="#eef4ef", font=("Segoe UI", 10))
        style.map("TCheckbutton", background=[("active", DARK)])
        style.configure("TScale", background=DARK)

        tk.Label(self.root, text="Air Swipe", bg=DARK, fg=GOLD, font=("Segoe UI", 16, "bold")).pack(anchor="w", padx=14, pady=(12, 0))
        tk.Label(self.root, text="PSSDC training suite · for PowerPoint and any slideshow", bg=DARK, fg=MUTED, font=("Segoe UI", 9)).pack(anchor="w", padx=14)

        self.border = tk.Frame(self.root, bg="#20372e", padx=3, pady=3)
        self.border.pack(padx=14, pady=10)
        self.video = tk.Label(self.border, bg="black", width=320, height=240)
        self.video.pack()
        self.meter = tk.Canvas(self.border, height=4, width=320, bg="#111", highlightthickness=0)
        self.meter.pack(fill="x")
        self.meter_bar = self.meter.create_rectangle(0, 0, 0, 4, fill=GOLD, width=0)

        self.status = tk.Label(self.root, text="Starting camera…", bg=DARK, fg="#eef4ef", font=("Segoe UI", 11, "bold"))
        self.status.pack(anchor="w", padx=14)
        self.hint = tk.Label(self.root, text="Click on your slideshow once so the keys go to it. Clicking this window won't take the keys away.", bg=DARK, fg=MUTED, font=("Segoe UI", 9), wraplength=320, justify="left")
        self.hint.pack(anchor="w", padx=14, pady=(0, 8))

        self.vars = {}
        for key, label in (("gestures", "Gestures on   (F9 from anywhere)"), ("roles", "Right palm ← next, left palm → back"), ("sound", "Swoosh sound"), ("zoom", "Hand zoom (two hands; clap to reset)"), ("on_top", "Keep this window on top")):
            v = tk.BooleanVar(value=self.settings[key]); self.vars[key] = v
            ttk.Checkbutton(self.root, text=label, variable=v, command=lambda k=key: self.toggle(k)).pack(anchor="w", padx=14)

        row = tk.Frame(self.root, bg=DARK); row.pack(fill="x", padx=14, pady=(8, 4))
        tk.Label(row, text="Swipe sensitivity", bg=DARK, fg="#eef4ef", font=("Segoe UI", 10)).pack(side="left")
        self.sens_lbl = tk.Label(row, text=SENS_LABELS[self.settings["sensitivity"] - 1], bg=DARK, fg=MUTED, font=("Segoe UI", 9))
        self.sens_lbl.pack(side="right")
        self.sens = tk.Scale(self.root, from_=1, to=5, orient="horizontal", showvalue=False, bg=DARK, fg="#eef4ef", troughcolor="#20372e", highlightthickness=0, bd=0, command=self.set_sens)
        self.sens.set(self.settings["sensitivity"])
        self.sens.pack(fill="x", padx=14)

        tk.Button(self.root, text="Check my hands", command=self.engine.start_calibration, bg="#20372e", fg="#eef4ef",
                  activebackground=GREEN, relief="flat", font=("Segoe UI", 10), padx=10, pady=4).pack(anchor="w", padx=14, pady=(6, 0))

        # phone remote
        self.remote_code = "".join(random.choice("ABCDEFGHJKMNPQRSTUVWXYZ23456789") for _ in range(6))
        remote_row = tk.Frame(self.root, bg=DARK); remote_row.pack(fill="x", padx=14, pady=(10, 0))
        qr_img = qrcode.make(REMOTE_PAGE + self.remote_code, box_size=3, border=1).get_image().convert("RGB").resize((110, 110))
        self.qr_photo = ImageTk.PhotoImage(qr_img)
        tk.Label(remote_row, image=self.qr_photo, bg="white").pack(side="left")
        remote_txt = tk.Frame(remote_row, bg=DARK); remote_txt.pack(side="left", padx=10, fill="x")
        tk.Label(remote_txt, text="Phone remote", bg=DARK, fg=GOLD, font=("Segoe UI", 11, "bold")).pack(anchor="w")
        tk.Label(remote_txt, text="Scan to control the slides from your phone.", bg=DARK, fg=MUTED, font=("Segoe UI", 9), wraplength=190, justify="left").pack(anchor="w")
        tk.Label(remote_txt, text=f"Code: {self.remote_code}", bg=DARK, fg="#eef4ef", font=("Consolas", 12, "bold")).pack(anchor="w", pady=(4, 0))
        self.remote_status = tk.Label(remote_txt, text="Connecting…", bg=DARK, fg=MUTED, font=("Segoe UI", 9))
        self.remote_status.pack(anchor="w")

        tk.Label(self.root, text="Right palm, sweep left: next\nLeft palm, sweep right: previous\nHold open palm still 1.5 s: black screen  ·  Two hands: zoom",
                 bg=DARK, fg=MUTED, font=("Segoe UI", 9), justify="left").pack(anchor="w", padx=14, pady=(8, 14))

        self.root.after(200, self.no_focus_steal)
        self.hotkeys = keyboard.GlobalHotKeys({"<f9>": lambda: self.root.after(0, self.hotkey_toggle)})
        self.hotkeys.start()
        self.camera = Camera(self)
        self.camera.start()
        self.remote = Remote(self, self.remote_code)
        self.remote.start()
        if not self.settings.get("right_label"):
            self.root.after(1500, self.engine.start_calibration)
        self.root.after(30, self.poll)

    def no_focus_steal(self):
        """Clicking this window must not take the keyboard away from PowerPoint (Windows only)."""
        if sys.platform != "win32":
            return
        try:
            import ctypes
            GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_APPWINDOW = -20, 0x08000000, 0x00040000
            hwnd = ctypes.windll.user32.GetParent(self.root.winfo_id())
            style = ctypes.windll.user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            ctypes.windll.user32.SetWindowLongW(hwnd, GWL_EXSTYLE, style | WS_EX_NOACTIVATE | WS_EX_APPWINDOW)
        except Exception:
            pass

    # settings
    def toggle(self, key):
        self.settings[key] = bool(self.vars[key].get())
        if key == "on_top":
            self.root.attributes("-topmost", self.settings["on_top"])
        if key == "sound" and self.settings["sound"]:
            self.sounds.play("next")
        save_settings(self.settings)
        self.show_msg({"gestures": "Gestures on" if self.settings["gestures"] else "Gestures off",
                       "zoom": "Hand zoom on" if self.settings["zoom"] else "Hand zoom off"}.get(key, ""))

    def hotkey_toggle(self):
        self.vars["gestures"].set(not self.vars["gestures"].get())
        self.toggle("gestures")

    def set_sens(self, v):
        v = int(float(v)); self.settings["sensitivity"] = v
        self.sens_lbl.config(text=SENS_LABELS[v - 1]); save_settings(self.settings)

    # called from the camera thread
    def event(self, sound, text):
        if sound and self.settings["sound"]:
            self.sounds.play(sound)
        self.status_q.put(("msg", text))

    def show_msg(self, text):
        if text:
            self.status.config(text=text, fg=GOLD); self.msg_until = time.monotonic() + 1.2

    def poll(self):
        try:
            while True:
                kind, text = self.status_q.get_nowait()
                if kind == "error":
                    self.status.config(text="Camera problem", fg="#f2786f"); self.hint.config(text=text); self.msg_until = float("inf")
                elif kind == "msg":
                    self.show_msg(text)
                elif kind == "ok":
                    self.status.config(text=text, fg="#eef4ef")
                elif kind == "calib":
                    self.status.config(text="Checking your hands", fg=GOLD); self.hint.config(text=text); self.msg_until = float("inf")
                elif kind in ("calibdone", "calibfail"):
                    self.status.config(text="Hands checked" if kind == "calibdone" else "Hand check failed", fg=GREEN if kind == "calibdone" else "#f2786f")
                    self.hint.config(text=text); self.msg_until = time.monotonic() + 3
                elif kind == "remote":
                    self.remote_status.config(text=text, fg=GREEN if "ready" in text else MUTED)
        except queue.Empty:
            pass
        try:
            rgb, seen, meter = self.frame_q.get_nowait()
            img = ImageTk.PhotoImage(Image.fromarray(rgb))
            self.video.configure(image=img); self.video.image = img
            on = self.settings["gestures"]
            self.border.config(bg=(GOLD if seen else GREEN) if on else "#20372e")
            self.meter.coords(self.meter_bar, 0, 0, int(320 * meter), 4)
            if time.monotonic() > self.msg_until:
                hand, front = self.engine.seen_hand
                seen_txt = (f"{'Right' if hand == 'right' else 'Left'} hand · {'palm' if front else 'back'}" if hand else "Hand seen")
                self.status.config(text=(seen_txt if seen else "Watching for gestures") if on else "Gestures off (F9 to turn on)", fg="#eef4ef" if on else MUTED)
        except queue.Empty:
            pass
        self.root.after(30, self.poll)

    def quit(self):
        self.camera.stop_flag.set()
        try: self.hotkeys.stop()
        except Exception: pass
        self.root.after(150, self.root.destroy)

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    App().run()
