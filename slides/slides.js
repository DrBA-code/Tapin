// Air Swipe Slides — PDF slides controlled by hand gestures from the webcam.
// Hand tracking loads only when presenting starts, so loading slides never depends on it.
let FilesetResolver = null, GestureRecognizer = null;

const $ = id => document.getElementById(id);
addEventListener("error", e => { const n = document.getElementById("fileErr"); if (n && !n.textContent) n.textContent = "Something went wrong on this page: " + e.message; });
const pdfjs = window.pdfjsLib;
// Libraries are served from this site (vendor/), not a third-party CDN, so school and office networks don't block them.
pdfjs.GlobalWorkerOptions.workerSrc = new URL("vendor/pdf.worker.min.js", location.href).href;
const WASM = new URL("vendor/mediapipe-wasm", location.href).href;
const MODEL = "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------- state ----------------
let deck = null, page = 1, total = 0, deckName = "";   // deck: { kind: "pdf", doc } or { kind: "images", imgs: [HTMLImageElement] }
const cache = new Map();          // page number -> rendered canvas
let recognizer = null, stream = null, running = false;
let gesturesOn = true, blanked = false;

// ---------------- setup screen ----------------
const SENS_LABELS = ["Very low", "Low", "Medium", "High", "Very high"];
const SENS_DIST = [0.26, 0.21, 0.16, 0.12, 0.09]; // share of camera width the hand must travel
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
    deckName = (pdfFile ? pdfFile.name : imgs[0].name).replace(/\.[^.]+$/, "");
    deckKey = deckName + "|" + total; loadThrown();
    $("pageCount").textContent = `${total} slide${total === 1 ? "" : "s"}`;
    $("loaded").hidden = false; $("fileErr").textContent = "";
    $("startBtn").disabled = false;
    const thumbs = $("thumbs"); thumbs.innerHTML = "";
    for (let i = 1; i <= Math.min(total, 24); i++) { const w = document.createElement("div"); w.className = "t"; w.appendChild(await renderPage(i, 120, true)); thumbs.appendChild(w); }
  } catch (err) {
    console.error(err);
    $("fileErr").textContent = "Couldn't open those slides (" + (err?.message || err) + "). Try saving them again from PowerPoint, or send this message to the DLU.";
  }
}

async function renderPage(n, targetHeight, isThumb = false, factor = 1) {
  const dprI = Math.min(window.devicePixelRatio || 1, 2);
  if (deck.kind === "images") {
    const img = deck.imgs[n - 1], c = document.createElement("canvas");
    const fit = isThumb ? (targetHeight * dprI) / img.naturalHeight : Math.min(innerWidth / img.naturalWidth, innerHeight / img.naturalHeight) * dprI;
    const scale = Math.min(fit * factor, Math.max(fit, 1)); // pictures can't gain detail beyond their own pixels
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    if (!isThumb) { c.style.width = img.naturalWidth * fit / dprI + "px"; c.style.height = img.naturalHeight * fit / dprI + "px"; }
    const ctx = c.getContext("2d"); ctx.imageSmoothingQuality = "high"; ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  const p = await deck.doc.getPage(n);
  const base = p.getViewport({ scale: 1 });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let scale;
  if (isThumb) scale = (targetHeight * dpr) / base.height;
  else scale = Math.min(innerWidth / base.width, innerHeight / base.height) * dpr;
  const cssW = base.width * scale / dpr, cssH = base.height * scale / dpr;
  if (!isThumb && factor > 1) scale *= Math.min(factor, 6000 / (base.width * scale)); // cap memory
  const vp = p.getViewport({ scale });
  const c = document.createElement("canvas");
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  if (!isThumb) { c.style.width = cssW + "px"; c.style.height = cssH + "px"; }
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

// ---------------- which hand does what ----------------
// Webcams differ in how left and right come out, so "Check my hands" learns it once on each computer.
const handRoles = () => $("handRoles").checked;   // right palm = next, left palm = back
const swapHands = () => $("swapHands").checked;
try { const v = localStorage.getItem("airswipe_roles"); if (v !== null) $("handRoles").checked = v === "1"; } catch {}
try { const v = localStorage.getItem("airswipe_swap"); if (v !== null) $("swapHands").checked = v === "1"; } catch {}
$("handRoles").addEventListener("change", () => { try { localStorage.setItem("airswipe_roles", handRoles() ? "1" : "0"); } catch {} });
$("swapHands").addEventListener("change", () => { try { localStorage.setItem("airswipe_swap", swapHands() ? "1" : "0"); } catch {} });
let handCal = null;   // { rightLabel, rightSign }
try { handCal = JSON.parse(localStorage.getItem("airswipe_handcal")); } catch {}
let calib = null;     // while checking: { start, labels: [], signs: [] }
const palmZ = lm => (lm[5].x - lm[0].x) * (lm[17].y - lm[0].y) - (lm[5].y - lm[0].y) * (lm[17].x - lm[0].x);
function whichHand(label) {
  if (!label) return null;
  let h = handCal?.rightLabel ? (label === handCal.rightLabel ? "right" : "left") : (label === "Left" ? "left" : "right");
  if (swapHands()) h = h === "right" ? "left" : "right";
  return h;
}
// Is the palm facing the camera? A left palm turns the opposite way to a right palm.
function palmFacing(lm, hand) {
  const rightSign = handCal?.rightSign || -1;
  return palmZ(lm) * (hand === "right" ? rightSign : -rightSign) > 0;
}
function startHandCheck() {
  calib = { start: performance.now(), labels: [], signs: [] };
  camNote("Checking your hands: raise your RIGHT hand, palm facing the camera, and hold it there…");
}
function handCheckFrame(lm, label, now) {
  if (lm && label) {
    calib.labels.push(label);
    const z = palmZ(lm); if (Math.abs(z) > 1e-4) calib.signs.push(z > 0 ? 1 : -1);
  }
  if (calib.labels.length >= 25 && calib.signs.length >= 15) {
    handCal = { rightLabel: majority(calib.labels), rightSign: calib.signs.reduce((a, b) => a + b, 0) > 0 ? 1 : -1 };
    try { localStorage.setItem("airswipe_handcal", JSON.stringify(handCal)); } catch {}
    if (swapHands()) { $("swapHands").checked = false; $("swapHands").dispatchEvent(new Event("change")); }
    calib = null; camNote("Hands checked ✓  Right palm sweep left = next · Left palm sweep right = back");
    setTimeout(() => camNote(""), 3500);
  } else if (now - calib.start > 15000) {
    calib = null; camNote("Couldn't see your hand clearly. Press H or the Check my hands button to try again.");
    setTimeout(() => camNote(""), 5000);
  }
}
const majority = arr => { const c = {}; arr.forEach(v => { if (v != null) c[v] = (c[v] || 0) + 1; }); return Object.keys(c).sort((a, b) => c[b] - c[a])[0] || null; };

// ---------------- hand zoom ----------------
let zoom = 1, tx = 0, ty = 0, zoomGesture = null, pinchPrev = null, sharpTimer = null, zoomCooldown = 0;
const zoomOn = () => $("zoomOpt").checked;
try { const v = localStorage.getItem("airswipe_zoom"); if (v !== null) $("zoomOpt").checked = v === "1"; } catch {}
$("zoomOpt").addEventListener("change", () => { try { localStorage.setItem("airswipe_zoom", zoomOn() ? "1" : "0"); } catch {} syncZoomBtn(); if (!zoomOn()) resetZoom(); });
function syncZoomBtn() { const b = $("bZoom"); b.setAttribute("aria-pressed", zoomOn()); b.textContent = zoomOn() ? "Hand zoom on" : "Hand zoom off"; }
syncZoomBtn();
function toggleZoom() { $("zoomOpt").checked = !zoomOn(); $("zoomOpt").dispatchEvent(new Event("change")); flash(zoomOn() ? "Zoom on" : "Zoom off"); }

function slideEl() { return $("slideWrap").querySelector("canvas"); }
function applyZoom(smooth = false) {
  const c = slideEl(); if (!c) return;
  const w = parseFloat(c.style.width) || c.clientWidth, h = parseFloat(c.style.height) || c.clientHeight;
  const maxX = Math.max(0, (w * zoom - w) / 2), maxY = Math.max(0, (h * zoom - h) / 2); // can reach every edge of the slide
  tx = Math.max(-maxX, Math.min(maxX, tx)); ty = Math.max(-maxY, Math.min(maxY, ty));
  c.className = ""; // a finished transition would otherwise keep overriding the zoom
  c.style.transition = smooth ? "transform .35s cubic-bezier(.2,.8,.2,1)" : "none";
  c.style.transform = zoom === 1 && tx === 0 && ty === 0 ? "" : `translate(${tx}px,${ty}px) scale(${zoom})`;
  $("count").textContent = zoom > 1.01 ? `${page} / ${total} · ×${zoom.toFixed(1)}` : `${page} / ${total}`;
  clearTimeout(sharpTimer);
  if (zoom > 1.2) sharpTimer = setTimeout(sharpen, 350);
}
// Zoom about a focal point given relative to the screen centre.
function zoomTo(z, fx, fy) {
  z = Math.max(1, Math.min(5, z));
  if (z < 1.04) { z = 1; tx = 0; ty = 0; }
  else { tx = fx - (fx - tx) * (z / zoom); ty = fy - (fy - ty) * (z / zoom); }
  zoom = z; applyZoom();
}
function resetZoom() { zoom = 1; tx = 0; ty = 0; zoomGesture = null; pinchPrev = null; applyZoom(true); }
let sharpFor = 0;
async function sharpen() {
  if (!deck || zoom <= 1.2) return;
  const want = Math.round(zoom * 2) / 2; if (want === sharpFor) return;
  const n = page, c = await renderPage(n, 0, false, want);
  if (n !== page || Math.abs(zoom - want) > 1.5) return;
  const old = slideEl(); if (!old) return;
  c.style.transform = old.style.transform; c.style.transition = "none";
  old.replaceWith(c); sharpFor = want;
}

// ---------------- phone remote ----------------
// The phone page (../remote/#CODE) sends next / prev / blank over a Supabase Realtime broadcast channel.
const REMOTE_URL = new URL("../remote/", location.href).href;
let remoteCode = null, remoteChan = null, sbc = null;
try { remoteCode = sessionStorage.getItem("airswipe_remote"); } catch {}
if (!remoteCode) {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; remoteCode = Array.from({ length: 6 }, () => A[Math.floor(Math.random() * A.length)]).join("");
  try { sessionStorage.setItem("airswipe_remote", remoteCode); } catch {}
}
function qrSvg(text) { if (!window.qrcode) return ""; const q = window.qrcode(0, "M"); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); }
(function setupRemote() {
  const link = REMOTE_URL + "#" + remoteCode;
  ["rqrSetup", "rqrStage"].forEach(id => ($(id).innerHTML = qrSvg(link)));
  ["rcodeSetup", "rcodeStage"].forEach(id => ($(id).textContent = remoteCode));
  $("rurlStage").textContent = REMOTE_URL.replace(/^https?:\/\//, "");
  const cfg = window.TAPIN_CONFIG || {};
  if (!window.supabase || !cfg.SUPABASE_URL) { $("rstatSetup").textContent = "Phone remote unavailable (no connection)."; return; }
  const sb = sbc = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  remoteChan = sb.channel("remote-" + remoteCode, { config: { broadcast: { self: false } } });
  remoteChan.on("broadcast", { event: "cmd" }, ({ payload }) => {
    const cmd = payload && payload.cmd;
    $("rstatSetup").textContent = "Phone connected ✓";
    if (running && deck) {
      if (cmd === "next") { if (blanked) setBlank(false); else { flash("▶"); next(); } }
      else if (cmd === "prev") { if (blanked) setBlank(false); else { flash("◀"); prev(); } }
      else if (cmd === "blank") setBlank(!blanked);
    }
    sendRemoteState();
  });
  remoteChan.subscribe(st => { if (st === "SUBSCRIBED") $("rstatSetup").textContent = "Ready: scan with your phone"; else if (st === "CHANNEL_ERROR" || st === "TIMED_OUT") $("rstatSetup").textContent = "Phone remote reconnecting…"; });
})();
function sendRemoteState() {
  if (!remoteChan) return;
  remoteChan.send({ type: "broadcast", event: "state", payload: { page: deck && running ? page : 0, total: deck && running ? total : 0, blank: blanked } });
}

// ---------------- grab and throw to the room ----------------
// Close your hand (fist) to grab the slide, open it to throw. Each slide goes once; items ticked in the
// Throw console go instead of the slide, once, and untick themselves.
let throwCfg = null, roomChan = null, armedCount = 0, throwing = false, deckKey = "";
let thrownPages = new Set();
let grab = {};
function loadThrown() { try { thrownPages = new Set(JSON.parse(sessionStorage.getItem("airswipe_thrown_" + deckKey) || "[]")); } catch { thrownPages = new Set(); } }
function saveThrown() { try { sessionStorage.setItem("airswipe_thrown_" + deckKey, JSON.stringify([...thrownPages])); } catch {} }
async function connectRoom(code, pin, quiet) {
  if (!sbc) { if (!quiet) $("tErr").textContent = "No connection to the service."; return false; }
  code = code.trim().toUpperCase();
  const { data: role, error } = await sbc.rpc("coordinator_check", { p_code: code, p_pin: pin });
  if (!role) { if (!quiet) $("tErr").textContent = error && /Could not find|schema cache/i.test(error.message) ? "The database needs upgrades 3–5 run first." : "That link code and PIN don't match a programme."; return false; }
  const { data: prog } = await sbc.from("programmes").select("id,code,name").eq("code", code).maybeSingle();
  if (!prog) return false;
  throwCfg = { code, pin, prog };
  try { sessionStorage.setItem("airswipe_room", JSON.stringify({ code, pin })); } catch {}
  if (roomChan) sbc.removeChannel(roomChan);
  roomChan = sbc.channel("room-" + code, { config: { broadcast: { self: false } } });
  roomChan.on("broadcast", { event: "armed" }, ({ payload }) => { armedCount = payload?.count || 0; showArmed(); });
  roomChan.subscribe();
  $("tForm").hidden = true; $("tConn").hidden = false; $("tErr").textContent = "";
  $("tProg").textContent = prog.name;
  await refreshArmed();
  return true;
}
async function refreshArmed() {
  if (!throwCfg) return;
  const { data } = await sbc.rpc("list_throws", { p_pin: throwCfg.pin, p_programme: throwCfg.prog.id });
  armedCount = (data || []).filter(t => t.armed).length; showArmed();
}
function showArmed() {
  $("tArmed").textContent = armedCount ? `${armedCount} ticked item${armedCount > 1 ? "s" : ""} will go with your next throw.` : "Your next throw sends the slide on screen.";
  $("armBadge").hidden = !throwCfg; $("armBadge").textContent = armedCount ? `✊ ${armedCount} ticked to throw` : "✊ Grab & throw ready";
}
$("tForm").addEventListener("submit", e => { e.preventDefault(); $("tErr").textContent = "Checking…"; connectRoom($("tCode").value, $("tPin").value); });
$("tOff").addEventListener("click", () => { throwCfg = null; if (roomChan) sbc.removeChannel(roomChan); roomChan = null; try { sessionStorage.removeItem("airswipe_room"); } catch {} $("tForm").hidden = false; $("tConn").hidden = true; showArmed(); });
$("tRefresh").addEventListener("click", refreshArmed);
setTimeout(() => { try { const r = JSON.parse(sessionStorage.getItem("airswipe_room") || "null"); if (r) connectRoom(r.code, r.pin, true); } catch {} }, 600);
showArmed();

function showGrab(on) {
  $("slideWrap").classList.toggle("grabbed", on);
  $("grabHint").hidden = !on;
  if (on) $("grabHint").textContent = armedCount ? `✊ Grabbed ${armedCount} ticked item${armedCount > 1 ? "s" : ""}: open your hand to throw` : (thrownPages.has(page) ? "✊ Already thrown this slide" : "✊ Grabbed: open your hand towards the room to throw");
}
const fromOf = t => (t === "A" ? "left" : t === "B" ? "right" : "top");
async function doThrow(target) {
  if (!throwCfg || throwing) return;
  throwing = true;
  const where = target === "all" ? "everyone" : "Group " + target;
  try {
    if (armedCount > 0) {
      const { data, error } = await sbc.rpc("throw_armed", { p_pin: throwCfg.pin, p_programme: throwCfg.prog.id, p_target: target });
      if (error) throw error;
      (data || []).forEach(t => roomChan?.send({ type: "broadcast", event: "throw", payload: { id: t.id, target: t.target, from: fromOf(target) } }));
      armedCount = 0; showArmed();
      tossAnim(); swoosh("next"); flash(`Thrown to ${where} ✓`);
      return;
    }
    if (thrownPages.has(page)) { flash("Already thrown ✓"); return; }
    const c = slideEl(); if (!c) return;
    const n = page; thrownPages.add(n); saveThrown();
    tossAnim(); swoosh("next");
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.85));
    const path = `${throwCfg.code}/slide-${crypto.randomUUID()}.jpg`;
    const up = await sbc.storage.from("throws").upload(path, blob, { contentType: "image/jpeg" });
    if (up.error) throw up.error;
    const url = sbc.storage.from("throws").getPublicUrl(path).data.publicUrl;
    const title = `Slide ${n}${deckName ? " · " + deckName : ""}`;
    const prep = await sbc.rpc("prepare_throw", { p_pin: throwCfg.pin, p_programme: throwCfg.prog.id, p_kind: "image", p_title: title, p_url: url, p_payload: { page: n } });
    if (prep.error) throw prep.error;
    const sent = await sbc.rpc("send_throw", { p_pin: throwCfg.pin, p_throw: prep.data.id, p_target: target });
    if (sent.error) throw sent.error;
    roomChan?.send({ type: "broadcast", event: "throw", payload: { id: sent.data.id, target: sent.data.target, from: fromOf(target) } });
    flash(`Thrown to ${where} ✓`);
  } catch (err) {
    console.error(err);
    thrownPages.delete(page); saveThrown();
    camNote("Couldn't throw: " + (err?.message || "check the connection")); setTimeout(() => camNote(""), 5000);
  } finally { throwing = false; }
}
function tossAnim() { const w = $("slideWrap"); w.classList.remove("tossed"); void w.offsetWidth; w.classList.add("tossed"); setTimeout(() => w.classList.remove("tossed"), 900); }

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

// ---------------- transitions ----------------
const TRANSITIONS = { slide: "Slide", up: "Push up", down: "Push down", fade: "Fade", zoom: "Zoom", flip: "Flip", mix: "Mix", none: "None" };
const MIX = ["slide", "up", "down", "fade", "zoom", "flip"];
try { const v = localStorage.getItem("airswipe_trans"); if (v && TRANSITIONS[v]) $("trans").value = v; } catch {}
function setTransition(v) {
  $("trans").value = v;
  try { localStorage.setItem("airswipe_trans", v); } catch {}
  $("bTrans").textContent = "Transition: " + TRANSITIONS[v];
}
setTransition($("trans").value);
$("trans").addEventListener("change", () => setTransition($("trans").value));
function cycleTransition() { const keys = Object.keys(TRANSITIONS); setTransition(keys[(keys.indexOf($("trans").value) + 1) % keys.length]); flash(TRANSITIONS[$("trans").value]); }
const pickTransition = () => { const t = $("trans").value; return t === "mix" ? MIX[Math.floor(Math.random() * MIX.length)] : t; };

async function go(n, dir) {
  if (!deck) return;
  n = Math.max(1, Math.min(total, n));
  if (n === page && dir !== 0) { flash(dir > 0 ? "End" : "Start"); return; }
  page = n; zoom = 1; tx = 0; ty = 0; sharpFor = 0; zoomGesture = null; pinchPrev = null;
  const c = await slideCanvas(n);
  if (n !== page) return;
  const wrap = $("slideWrap");
  const olds = [...wrap.children].filter(el => el !== c);
  c.getAnimations?.().forEach(a => a.cancel());
  c.style.transform = ""; c.style.transition = "none"; c.className = "";
  const t = !reduced && dir ? pickTransition() : "none";
  if (t === "none" || !olds.length) {
    olds.forEach(o => o.remove());
    if (!wrap.contains(c)) wrap.appendChild(c);
  } else {
    const d = dir > 0 ? "n" : "p";
    olds.forEach(o => {
      o.getAnimations?.().forEach(a => a.cancel());
      o.className = `out-${t}-${d}`;
      o.addEventListener("animationend", () => o.remove(), { once: true });
      setTimeout(() => o.remove(), 900);
    });
    c.className = `in-${t}-${d}`;
    if (!wrap.contains(c)) wrap.appendChild(c);
  }
  $("count").textContent = `${page} / ${total}`;
  prefetch();
  sendRemoteState();
}
const next = () => { if (blanked) return; if (page < total) swoosh("next"); go(page + 1, 1); };
const prev = () => { if (blanked) return; if (page > 1) swoosh("prev"); go(page - 1, -1); };
function setBlank(on) { blanked = on; $("blank").hidden = !on; flash(on ? "✋" : "▶"); swoosh("pause"); sendRemoteState(); }

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
$("bZoom").addEventListener("click", toggleZoom);
$("bTrans").addEventListener("click", cycleTransition);
$("bRemote").addEventListener("click", () => { $("remotePanel").hidden = !$("remotePanel").hidden; });
$("bHands").addEventListener("click", () => { if (recognizer) startHandCheck(); });
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
  if (zoom > 1 && ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"].includes(e.key)) {
    e.preventDefault(); const st = 120;
    if (e.key === "ArrowRight") tx -= st; if (e.key === "ArrowLeft") tx += st; if (e.key === "ArrowDown") ty -= st; if (e.key === "ArrowUp") ty += st;
    applyZoom(true); return;
  }
  if (["ArrowRight", "PageDown", " ", "Enter"].includes(e.key)) { e.preventDefault(); next(); }
  else if (["ArrowLeft", "PageUp", "Backspace"].includes(e.key)) { e.preventDefault(); prev(); }
  else if (e.key === "b" || e.key === "B" || e.key === ".") setBlank(!blanked);
  else if (e.key === "g" || e.key === "G") toggleGestures();
  else if (e.key === "c" || e.key === "C") toggleCamPreview();
  else if (e.key === "s" || e.key === "S") { $("sound").checked = !soundOn(); $("sound").dispatchEvent(new Event("change")); flash(soundOn() ? "🔊" : "🔇"); }
  else if (e.key === "z" || e.key === "Z") toggleZoom();
  else if (e.key === "t" || e.key === "T") cycleTransition();
  else if (e.key === "p" || e.key === "P") $("remotePanel").hidden = !$("remotePanel").hidden;
  else if ((e.key === "h" || e.key === "H") && recognizer) startHandCheck();
  else if (e.key === "r" || e.key === "R" || e.key === "0") resetZoom();
  else if (e.key === "+" || e.key === "=") zoomTo(zoom * 1.25, 0, 0);
  else if (e.key === "-" || e.key === "_") zoomTo(zoom / 1.25, 0, 0);
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
      if (!GestureRecognizer) ({ FilesetResolver, GestureRecognizer } = await import("./vendor/vision_bundle.mjs"));
      const fileset = await FilesetResolver.forVisionTasks(WASM);
      try {
        recognizer = await GestureRecognizer.createFromOptions(fileset, { baseOptions: { modelAssetPath: MODEL, delegate: "GPU" }, runningMode: "VIDEO", numHands: 2 });
      } catch {
        recognizer = await GestureRecognizer.createFromOptions(fileset, { baseOptions: { modelAssetPath: MODEL, delegate: "CPU" }, runningMode: "VIDEO", numHands: 2 });
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
  if (!handCal) startHandCheck();
  loop();
}
function stopCamera() { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } }

// swipe + palm-hold detection
const WINDOW_MS = 600, COOLDOWN_MS = 700, HOLD_MS = 1500, DROPOUT_MS = 300, RECOIL_MS = 1300;
let lastSeen = 0, lastDir = null, lastDirAt = 0;
let history = [], handSince = 0, cooldownUntil = 0, holdStart = 0, holdLatched = false, lastVideoTime = -1, lastProcess = 0;

function loop() {
  if (!running || !stream) return;
  requestAnimationFrame(loop);
  const v = $("video"), now = performance.now();
  if (v.readyState < 2 || v.currentTime === lastVideoTime || now - lastProcess < 33) return;
  lastVideoTime = v.currentTime; lastProcess = now;
  let res;
  try { res = recognizer.recognizeForVideo(v, now); } catch { return; }
  const hands = res.landmarks || [];
  const lm = hands[0];
  draw(hands);
  if (calib) { handCheckFrame(hands.length === 1 ? lm : null, hands.length === 1 ? res.handedness?.[0]?.[0]?.categoryName : null, now); return; }
  if (gesturesOn && zoomOn() && hands.length === 2) {
    $("cam").classList.add("hot");
    history = []; handSince = 0; holdStart = 0; setMeter(0); pinchPrev = null;
    twoHandZoom(hands, now);
    return;
  }
  zoomGesture = null;
  if (!lm && history.length && now - lastSeen < DROPOUT_MS) { if (gesturesOn && zoom <= 1) trySwipe(now); return; } // fast swipes blur the hand for a few frames
  if (!lm && grab.active && now - (grab.last || 0) > 1500) { grab = {}; showGrab(false); }
  if (!lm) { history = []; handSince = 0; holdStart = 0; holdLatched = false; setMeter(0); $("cam").classList.remove("hot"); if (recognizer) $("camLbl").textContent = "Watching for gestures"; return; }
  $("cam").classList.add("hot");
  lastSeen = now;
  if (!handSince) handSince = now;
  const pts = [0, 5, 9, 13, 17].map(i => lm[i]);
  const x = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const y = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const label = res.handedness?.[0]?.[0]?.categoryName;
  const hand = whichHand(label);
  const front = hand ? palmFacing(lm, hand) : false;
  history.push({ t: now, x, y, hand, front });
  $("camLbl").textContent = hand ? `${hand === "right" ? "Right" : "Left"} hand · ${front ? "palm" : "back"}` : "Hand seen";
  while (history.length && now - history[0].t > WINDOW_MS) history.shift();

  const g = res.gestures?.[0]?.[0];
  const palm = g && g.categoryName === "Open_Palm" && g.score > 0.6;

  if (!gesturesOn) return;

  // While zoomed: pinch (thumb to index finger) and drag to move around; swipes and pause are paused.
  if (zoom > 1) {
    const handSize = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) || 0.1;
    const pinch = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y) / handSize < 0.35;
    if (pinch && zoomOn()) {
      const p = { x: (1 - (lm[4].x + lm[8].x) / 2) * innerWidth, y: ((lm[4].y + lm[8].y) / 2) * innerHeight };
      if (pinchPrev) { tx += (p.x - pinchPrev.x) * 1.8; ty += (p.y - pinchPrev.y) * 1.8; applyZoom(); }
      pinchPrev = p;
    } else pinchPrev = null;
    history = []; holdStart = 0; setMeter(0);
    return;
  }

  // Grab and throw: hold a fist to grab the slide, then open the hand to throw it.
  if (throwCfg) {
    const fist = g && g.categoryName === "Closed_Fist" && g.score > 0.6;
    if (fist) {
      if (!grab.since) { grab.since = now; grab.x = x; }
      if (!grab.active && now - grab.since > 350) { grab.active = true; grab.x = x; showGrab(true); }
      grab.last = now;
    } else if (grab.active && palm) {
      const dx = x - grab.x; // camera picture is not mirrored: towards the presenter's left is dx > 0
      const target = dx > 0.12 ? "A" : dx < -0.12 ? "B" : "all";
      grab = {}; showGrab(false);
      history = []; holdStart = 0; holdLatched = true; cooldownUntil = now + COOLDOWN_MS;
      doThrow(target);
      return;
    } else {
      grab.since = 0;
      if (grab.active && now - grab.last > 1500) { grab = {}; showGrab(false); }
    }
    if (grab.active) { history = []; holdStart = 0; setMeter(0); return; }
  }

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
  trySwipe(now);
}

function trySwipe(now) {
  // Ignore the first moment a hand appears, so raising it into view isn't read as a swipe up.
  if (now < cooldownUntil || history.length < 3 || (handSince && now - handSince < 200)) return;
  // Largest travel in the window, so a swipe that curves back at the end still counts.
  const xs = history.map(h => h.x), ys = history.map(h => h.y);
  const sgn = (arr, mn, mx) => (arr.indexOf(mx) > arr.indexOf(mn) ? 1 : -1);
  const dx = (Math.max(...xs) - Math.min(...xs)) * sgn(xs, Math.min(...xs), Math.max(...xs));
  const dy = (Math.max(...ys) - Math.min(...ys)) * sgn(ys, Math.min(...ys), Math.max(...ys));
  const need = SENS_DIST[sensitivity() - 1];
  // Camera image is not mirrored: a hand moving to the presenter's left moves right in the image (dx > 0).
  let dir = null;
  if (Math.abs(dx) >= need && Math.abs(dy) < 0.8 * Math.abs(dx)) dir = dx > 0 ? "left" : "right"; // up and down are ignored
  if (!dir) return;
  if (handRoles()) {
    // Only the right hand goes forward and only the left hand goes back, so a hand drifting back after a swipe is ignored.
    // Anything else (like a hand drifting back after a swipe) is ignored.
    const hand = majority(history.map(h => h.hand));
    const front = history.filter(h => h.front).length >= history.length / 2;
    // Palm to the camera: right hand sweeping left goes forward, left hand sweeping right goes back.
    const ok = dir === "left" ? hand === "right" && front : hand === "left" && front;
    if (!ok) { history = []; return; }
  }
  const opposite = { left: "right", right: "left" };
  if (lastDir && dir === opposite[lastDir] && now - lastDirAt < RECOIL_MS) { history = []; return; } // the hand coming back
  if (blanked) setBlank(false);
  else if (dir === "left") { flash("▶"); next(); }
  else { flash("◀"); prev(); }
  lastDir = dir; lastDirAt = now;
  cooldownUntil = now + COOLDOWN_MS; history = []; holdStart = 0;
}
function twoHandZoom(hands, now) {
  const centre = lm => { const pts = [0, 5, 9, 13, 17].map(i => lm[i]); return { x: 1 - pts.reduce((a, p) => a + p.x, 0) / 5, y: pts.reduce((a, p) => a + p.y, 0) / 5 }; };
  const a = centre(hands[0]), b = centre(hands[1]);
  const d = Math.hypot(a.x - b.x, (a.y - b.y) * 0.75);
  const fx = ((a.x + b.x) / 2 - 0.5) * innerWidth, fy = ((a.y + b.y) / 2 - 0.5) * innerHeight;
  if (now < zoomCooldown) return;
  // Clap: hands meet -> back to full view.
  if (d < 0.08) {
    if (zoom > 1) { resetZoom(); swoosh("prev"); flash("⤢"); }
    zoomGesture = null; zoomCooldown = now + 800; return;
  }
  if (!zoomGesture) { zoomGesture = { since: now, d0: d, z0: zoom }; return; }
  if (now - zoomGesture.since < 200) { zoomGesture.d0 = d; zoomGesture.z0 = zoom; return; } // let both hands settle
  zoomTo(zoomGesture.z0 * (d / zoomGesture.d0), fx, fy);
}
function setMeter(p) { $("meter").style.width = (p * 100).toFixed(0) + "%"; }

const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
function draw(hands) {
  const c = $("overlay"), v = $("video");
  if (c.width !== v.videoWidth) { c.width = v.videoWidth || 640; c.height = v.videoHeight || 480; }
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  hands.forEach(lm => drawHand(ctx, c, lm));
}
function drawHand(ctx, c, lm) {
  ctx.strokeStyle = "rgba(63,185,138,.9)"; ctx.lineWidth = 3; ctx.beginPath();
  BONES.forEach(([a, b]) => { ctx.moveTo(lm[a].x * c.width, lm[a].y * c.height); ctx.lineTo(lm[b].x * c.width, lm[b].y * c.height); });
  ctx.stroke();
  ctx.fillStyle = "#e8b44a";
  lm.forEach(p => { ctx.beginPath(); ctx.arc(p.x * c.width, p.y * c.height, 4, 0, Math.PI * 2); ctx.fill(); });
}
