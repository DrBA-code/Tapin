// Air Swipe Slides — PDF slides controlled by hand gestures from the webcam.
import { FilesetResolver, GestureRecognizer } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const $ = id => document.getElementById(id);
const pdfjs = window.pdfjsLib;
pdfjs.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------- state ----------------
let deck = null, page = 1, total = 0;   // deck: { kind: "pdf", doc } or { kind: "images", imgs: [HTMLImageElement] }
const cache = new Map();          // page number -> rendered canvas
let recognizer = null, stream = null, running = false;
let gesturesOn = true, blanked = false;

// ---------------- setup screen ----------------
const SENS_LABELS = ["Very low", "Low", "Medium", "High", "Very high"];
const SENS_DIST = [0.30, 0.25, 0.20, 0.16, 0.12]; // share of camera width the hand must travel
function sensitivity() { return +$("sens").value; }
function showSens() { $("sensVal").textContent = SENS_LABELS[sensitivity() - 1]; try { localStorage.setItem("airswipe_sens", $("sens").value); } catch {} }
try { const s = localStorage.getItem("airswipe_sens"); if (s) $("sens").value = s; } catch {}
showSens();
$("sens").addEventListener("input", showSens);

const drop = $("drop");
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => { if (e.dataTransfer.files?.length) loadFiles([...e.dataTransfer.files]); });
$("file").addEventListener("change", e => { if (e.target.files?.length) loadFiles([...e.target.files]); });

const isPdf = f => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name);
const isImg = f => /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name);
const isPpt = f => /\.(pptx?|ppsx?|key|odp)$/i.test(f.name);
const natural = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

async function loadFiles(files) {
  $("fileErr").textContent = "";
  if (files.some(isPpt)) { $("fileErr").textContent = "Browsers can't open PowerPoint files directly. In PowerPoint use File → Save As → PDF, or File → Export → PNG to save each slide as a picture, then choose that here."; return; }
  const pdfFile = files.find(isPdf), imgs = files.filter(isImg).sort(natural);
  if (!pdfFile && !imgs.length) { $("fileErr").textContent = "Choose a PDF, or the slide pictures (PNG or JPG)."; return; }
  try {
    $("fileErr").textContent = "Opening slides…";
    if (pdfFile) {
      const data = new Uint8Array(await pdfFile.arrayBuffer());
      deck = { kind: "pdf", doc: await pdfjs.getDocument({ data }).promise };
      total = deck.doc.numPages;
      $("fileName").textContent = pdfFile.name;
    } else {
      const loaded = await Promise.all(imgs.map(f => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(f); })));
      deck = { kind: "images", imgs: loaded };
      total = loaded.length;
      $("fileName").textContent = imgs.length === 1 ? imgs[0].name : `${imgs.length} pictures (${imgs[0].name} … ${imgs[imgs.length - 1].name})`;
    }
    page = 1; cache.clear();
    $("pageCount").textContent = `${total} slide${total === 1 ? "" : "s"}`;
    $("loaded").hidden = false; $("fileErr").textContent = "";
    $("startBtn").disabled = false;
    const thumbs = $("thumbs"); thumbs.innerHTML = "";
    for (let i = 1; i <= Math.min(total, 12); i++) thumbs.appendChild(await renderPage(i, 70, true));
  } catch (err) {
    console.error(err);
    $("fileErr").textContent = "Couldn't open those slides. Try saving them again from PowerPoint.";
  }
}

async function renderPage(n, targetHeight, isThumb = false) {
  const dprI = Math.min(window.devicePixelRatio || 1, 2);
  if (deck.kind === "images") {
    const img = deck.imgs[n - 1], c = document.createElement("canvas");
    const scale = isThumb ? (targetHeight * dprI) / img.naturalHeight : Math.min(innerWidth / img.naturalWidth, innerHeight / img.naturalHeight) * dprI;
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    if (!isThumb) { c.style.width = c.width / dprI + "px"; c.style.height = c.height / dprI + "px"; }
    const ctx = c.getContext("2d"); ctx.imageSmoothingQuality = "high"; ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  const p = await deck.doc.getPage(n);
  const base = p.getViewport({ scale: 1 });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let scale;
  if (isThumb) scale = (targetHeight * dpr) / base.height;
  else scale = Math.min(innerWidth / base.width, innerHeight / base.height) * dpr;
  const vp = p.getViewport({ scale });
  const c = document.createElement("canvas");
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  if (!isThumb) { c.style.width = vp.width / dpr + "px"; c.style.height = vp.height / dpr + "px"; }
  await p.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
  return c;
}
async function slideCanvas(n) {
  if (!cache.has(n)) cache.set(n, renderPage(n));
  return cache.get(n);
}
function prefetch() {
  [page + 1, page - 1].forEach(n => { if (n >= 1 && n <= total) slideCanvas(n); });
  for (const k of cache.keys()) if (Math.abs(k - page) > 2) cache.delete(k);
}

// ---------------- swoosh sound ----------------
let actx = null, noiseBuf = null;
function soundOn() { return $("sound").checked; }
try { const v = localStorage.getItem("airswipe_sound"); if (v !== null) $("sound").checked = v === "1"; } catch {}
$("sound").addEventListener("change", () => { try { localStorage.setItem("airswipe_sound", soundOn() ? "1" : "0"); } catch {} if (soundOn()) { unlockAudio(); swoosh("next"); } });
$("testSound").addEventListener("click", () => { unlockAudio(); swoosh("next"); setTimeout(() => swoosh("prev"), 500); });
function unlockAudio() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    actx = new AC();
    noiseBuf = actx.createBuffer(1, actx.sampleRate * 0.8, actx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (actx.state === "suspended") actx.resume();
}
// A short burst of noise swept through a band-pass filter: the "fwip" of a cloth being flicked.
function swoosh(kind) {
  if (!soundOn() || !actx) return;
  const t = actx.currentTime, dur = kind === "pause" ? 0.5 : 0.36;
  const src = actx.createBufferSource(); src.buffer = noiseBuf;
  const bp = actx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 0.9;
  const hp = actx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 250;
  const g = actx.createGain();
  const [f0, f1] = kind === "prev" ? [3200, 500] : kind === "pause" ? [900, 300] : [500, 3600];
  bp.frequency.setValueAtTime(f0, t);
  bp.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.85);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.9, t + dur * 0.35);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(hp).connect(bp).connect(g).connect(actx.destination);
  src.start(t, Math.random() * 0.3); src.stop(t + dur + 0.02);
}

// ---------------- presenting ----------------
$("startBtn").addEventListener("click", start);
async function start() {
  if (!deck) return;
  unlockAudio();
  try { await document.documentElement.requestFullscreen(); } catch {}
  $("setup").hidden = true; $("stage").hidden = false;
  running = true; blanked = false; $("blank").hidden = true;
  await new Promise(r => setTimeout(r, 120)); // let full screen settle before sizing
  cache.clear();
  await go(page, 0);
  keepAwake();
  startTracking();
}
function exit() {
  running = false;
  stopCamera();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $("stage").hidden = true; $("setup").hidden = false;
}

async function go(n, dir) {
  if (!deck) return;
  n = Math.max(1, Math.min(total, n));
  if (n === page && dir !== 0) { flash(dir > 0 ? "End" : "Start"); return; }
  page = n;
  const c = await slideCanvas(n);
  if (n !== page) return;
  const wrap = $("slideWrap");
  wrap.innerHTML = "";
  if (!reduced && dir) c.className = dir > 0 ? "enter-next" : "enter-prev"; else c.className = "";
  wrap.appendChild(c);
  $("count").textContent = `${page} / ${total}`;
  prefetch();
}
const next = () => { if (blanked) return; if (page < total) swoosh("next"); go(page + 1, 1); };
const prev = () => { if (blanked) return; if (page > 1) swoosh("prev"); go(page - 1, -1); };
function setBlank(on) { blanked = on; $("blank").hidden = !on; flash(on ? "✋" : "▶"); swoosh("pause"); }

function flash(text) {
  const p = $("pop"); p.textContent = text;
  p.classList.remove("go"); void p.offsetWidth; p.classList.add("go");
}

let resizeTimer;
addEventListener("resize", () => {
  if (!running) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { cache.clear(); go(page, 0); }, 200);
});

// controls
$("bNext").addEventListener("click", next);
$("bPrev").addEventListener("click", prev);
$("bGest").addEventListener("click", toggleGestures);
$("bCam").addEventListener("click", toggleCamPreview);
$("bFs").addEventListener("click", async () => { try { document.fullscreenElement ? await document.exitFullscreen() : await document.documentElement.requestFullscreen(); } catch {} });
$("bExit").addEventListener("click", exit);
function toggleGestures() {
  gesturesOn = !gesturesOn;
  $("bGest").setAttribute("aria-pressed", gesturesOn); $("bGest").textContent = gesturesOn ? "Gestures on" : "Gestures off";
  $("cam").classList.toggle("armed", gesturesOn && !!recognizer);
  flash(gesturesOn ? "Gestures on" : "Gestures off");
}
function toggleCamPreview() {
  const cam = $("cam"); cam.hidden = !cam.hidden;
  $("bCam").setAttribute("aria-pressed", !cam.hidden);
}
addEventListener("keydown", e => {
  if ($("stage").hidden) return;
  if (["ArrowRight", "PageDown", " ", "Enter"].includes(e.key)) { e.preventDefault(); next(); }
  else if (["ArrowLeft", "PageUp", "Backspace"].includes(e.key)) { e.preventDefault(); prev(); }
  else if (e.key === "b" || e.key === "B" || e.key === ".") setBlank(!blanked);
  else if (e.key === "g" || e.key === "G") toggleGestures();
  else if (e.key === "c" || e.key === "C") toggleCamPreview();
  else if (e.key === "s" || e.key === "S") { $("sound").checked = !soundOn(); $("sound").dispatchEvent(new Event("change")); flash(soundOn() ? "🔊" : "🔇"); }
  else if (e.key === "Home") go(1, -1);
  else if (e.key === "End") go(total, 1);
  else if (e.key === "Escape" && !document.fullscreenElement) exit();
});
let mouseTimer;
$("stage").addEventListener("mousemove", () => {
  $("stage").classList.add("mouse");
  clearTimeout(mouseTimer); mouseTimer = setTimeout(() => $("stage").classList.remove("mouse"), 2500);
});

let wakeLock = null;
async function keepAwake() { try { if (!wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => (wakeLock = null)); } } catch {} }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && running) keepAwake(); });

// ---------------- hand tracking ----------------
function camNote(t) { const n = $("camNote"); n.textContent = t; n.hidden = !t; }

async function startTracking() {
  $("camLbl").textContent = "Starting camera…";
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }, audio: false });
  } catch (e) {
    $("camLbl").textContent = "No camera";
    camNote(e?.name === "NotAllowedError" ? "Camera permission was declined. Use the arrow keys, or allow the camera and restart." : "The camera couldn't start. Use the arrow keys to change slides.");
    return;
  }
  const v = $("video"); v.srcObject = stream; await v.play().catch(() => {});
  if (!recognizer) {
    $("camLbl").textContent = "Loading hand tracking…";
    try {
      const fileset = await FilesetResolver.forVisionTasks(WASM);
      try {
        recognizer = await GestureRecognizer.createFromOptions(fileset, { baseOptions: { modelAssetPath: MODEL, delegate: "GPU" }, runningMode: "VIDEO", numHands: 1 });
      } catch {
        recognizer = await GestureRecognizer.createFromOptions(fileset, { baseOptions: { modelAssetPath: MODEL, delegate: "CPU" }, runningMode: "VIDEO", numHands: 1 });
      }
    } catch (e) {
      console.error(e);
      $("camLbl").textContent = "Tracking unavailable";
      camNote("Hand tracking couldn't load. Check the internet connection. Arrow keys still work.");
      return;
    }
  }
  if (!running) return;
  $("camLbl").textContent = "Watching for gestures";
  $("cam").classList.toggle("armed", gesturesOn);
  camNote("");
  loop();
}
function stopCamera() { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } }

// swipe + palm-hold detection
const WINDOW_MS = 450, COOLDOWN_MS = 900, HOLD_MS = 1000;
let history = [], handSince = 0, cooldownUntil = 0, holdStart = 0, holdLatched = false, lastVideoTime = -1, lastProcess = 0;

function loop() {
  if (!running || !stream) return;
  requestAnimationFrame(loop);
  const v = $("video"), now = performance.now();
  if (v.readyState < 2 || v.currentTime === lastVideoTime || now - lastProcess < 33) return;
  lastVideoTime = v.currentTime; lastProcess = now;
  let res;
  try { res = recognizer.recognizeForVideo(v, now); } catch { return; }
  const lm = res.landmarks?.[0];
  draw(lm);
  if (!lm) { history = []; handSince = 0; holdStart = 0; holdLatched = false; setMeter(0); $("cam").classList.remove("hot"); return; }
  $("cam").classList.add("hot");
  if (!handSince) handSince = now;
  const pts = [0, 5, 9, 13, 17].map(i => lm[i]);
  const x = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const y = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  history.push({ t: now, x, y });
  while (history.length && now - history[0].t > WINDOW_MS) history.shift();

  const g = res.gestures?.[0]?.[0];
  const palm = g && g.categoryName === "Open_Palm" && g.score > 0.6;

  if (!gesturesOn) return;

  // Palm hold (still, open palm) toggles the pause screen.
  const recent = history.filter(h => now - h.t < 500);
  const spread = recent.length ? Math.max(...recent.map(h => h.x)) - Math.min(...recent.map(h => h.x)) + Math.max(...recent.map(h => h.y)) - Math.min(...recent.map(h => h.y)) : 1;
  if (palm && spread < 0.05) {
    if (!holdStart) holdStart = now;
    const prog = Math.min(1, (now - holdStart) / HOLD_MS);
    setMeter(holdLatched ? 0 : prog);
    if (prog >= 1 && !holdLatched) { holdLatched = true; setMeter(0); setBlank(!blanked); cooldownUntil = now + COOLDOWN_MS; history = []; return; }
  } else {
    holdStart = 0; setMeter(0);
    if (!palm) holdLatched = false;
  }

  // Swipe: quick mostly-horizontal travel of the open hand.
  // Ignore the first moment a hand appears, so raising it into view isn't read as a swipe up.
  if (now < cooldownUntil || history.length < 4 || now - handSince < 250) return;
  const first = history[0], last = history[history.length - 1];
  const dx = last.x - first.x, dy = last.y - first.y, need = SENS_DIST[sensitivity() - 1];
  // Camera image is not mirrored: a hand moving to the presenter's left moves right in the image (dx > 0).
  let dir = null;
  if (Math.abs(dx) >= need && Math.abs(dy) < 0.7 * Math.abs(dx)) dir = dx > 0 ? "left" : "right";
  else if (Math.abs(dy) >= need && Math.abs(dx) < 0.7 * Math.abs(dy)) dir = dy < 0 ? "up" : "down";
  if (dir) {
    if (blanked) setBlank(false);
    else if (dir === "right") { flash("◀"); prev(); }
    else { flash(dir === "up" ? "▲" : dir === "down" ? "▼" : "▶"); next(); }
    cooldownUntil = now + COOLDOWN_MS; history = []; holdStart = 0;
  }
}
function setMeter(p) { $("meter").style.width = (p * 100).toFixed(0) + "%"; }

const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
function draw(lm) {
  const c = $("overlay"), v = $("video");
  if (c.width !== v.videoWidth) { c.width = v.videoWidth || 640; c.height = v.videoHeight || 480; }
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  if (!lm) return;
  ctx.strokeStyle = "rgba(63,185,138,.9)"; ctx.lineWidth = 3; ctx.beginPath();
  BONES.forEach(([a, b]) => { ctx.moveTo(lm[a].x * c.width, lm[a].y * c.height); ctx.lineTo(lm[b].x * c.width, lm[b].y * c.height); });
  ctx.stroke();
  ctx.fillStyle = "#e8b44a";
  lm.forEach(p => { ctx.beginPath(); ctx.arc(p.x * c.width, p.y * c.height, 4, 0, Math.PI * 2); ctx.fill(); });
}
