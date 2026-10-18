(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const TITLES = ["Prof", "Dr", "Mr", "Mrs", "Miss"];
  const cfg = window.TAPIN_CONFIG || {};
  const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.startsWith("PASTE");
  const sb = configured && window.supabase ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const kioskUrl = location.origin + location.pathname + "#kiosk";

  let entries = [];
  let eventName = "";

  // ---------- helpers ----------
  const fullName = e => (e.title === "Miss" ? "Miss " : e.title ? e.title + ". " : "") + e.name;
  const initials = n => (n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join("");
  const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function drawQR(el) {
    if (!el || !window.qrcode) return;
    const q = window.qrcode(0, "M"); q.addData(kioskUrl); q.make();
    el.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }
  function setEventLabels() {
    $("dEvent").textContent = eventName || "Welcome";
    $("kEvent").textContent = eventName || "Welcome";
    $("dDate").textContent = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" }).toUpperCase();
  }

  // ---------- routing ----------
  let wakeLock = null;
  async function keepAwake() { try { if (!wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => (wakeLock = null)); } } catch (e) {} }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !$("display").hidden) keepAwake(); });

  function route() {
    const h = location.hash.replace("#", "");
    const mode = h === "kiosk" || h === "display" ? h : "home";
    ["home", "kiosk", "display"].forEach(m => ($(m).hidden = m !== mode));
    if (mode === "display") { renderRoll(); keepAwake(); setTimeout(playNext, 300); }
    if (mode === "kiosk") { startCamera(); keepAwake(); } else stopCamera();
  }
  addEventListener("hashchange", route);

  // ---------- kiosk: camera ----------
  let stream = null, fallbackPhoto = null;
  async function startCamera() {
    if (stream) return;
    const msg = $("camMsg");
    if (!navigator.mediaDevices?.getUserMedia) return cameraUnavailable("This browser can't use the camera here.");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 720 } }, audio: false });
      const v = $("video"); v.srcObject = stream; v.hidden = false; msg.hidden = true; $("still").hidden = true;
      await v.play().catch(() => {});
      $("camStart").hidden = true; $("pickLbl").hidden = true;
      $("camHint").textContent = "Look at the camera. Your photo is taken when you tap Check me in.";
    } catch (e) {
      stream = null;
      cameraUnavailable(e && e.name === "NotAllowedError" ? "Camera permission was declined." : "The camera couldn't start.");
    }
  }
  function cameraUnavailable(reason) {
    $("camMsg").hidden = false; $("camMsg").textContent = "No camera";
    $("video").hidden = true;
    $("camHint").textContent = reason + " Tap Turn on camera to try again, or take a photo instead.";
    $("camStart").hidden = false; $("pickLbl").hidden = false;
  }
  function stopCamera() { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } }
  $("camStart").addEventListener("click", startCamera);

  function snapFromVideo(size) {
    const v = $("video");
    if (!stream || !v.videoWidth) return null;
    const s = Math.min(v.videoWidth, v.videoHeight), c = document.createElement("canvas");
    c.width = c.height = size; const ctx = c.getContext("2d");
    ctx.translate(size, 0); ctx.scale(-1, 1); // keep the mirror view people saw
    ctx.drawImage(v, (v.videoWidth - s) / 2, (v.videoHeight - s) / 2, s, s, 0, 0, size, size);
    return c;
  }
  function fileToCanvas(file, size) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const s = Math.min(img.width, img.height), c = document.createElement("canvas");
        c.width = c.height = size;
        c.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        URL.revokeObjectURL(url); res(c);
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("read")); };
      img.src = url;
    });
  }
  const canvasToBlob = c => new Promise(r => c.toBlob(r, "image/jpeg", 0.8));

  $("fPhoto").addEventListener("change", async e => {
    const f = e.target.files?.[0]; if (!f) return;
    try {
      fallbackPhoto = await fileToCanvas(f, 480);
      $("still").src = fallbackPhoto.toDataURL("image/jpeg", 0.8); $("still").hidden = false; $("camMsg").hidden = true;
      $("camHint").textContent = "Photo ready. Tap Check me in.";
    } catch { $("ciErr").textContent = "That photo couldn't be read. Take it again."; }
  });

  // ---------- kiosk: form ----------
  TITLES.forEach(t => $("titles").insertAdjacentHTML("beforeend", `<input type="radio" name="title" id="t_${t}" value="${t}"><label for="t_${t}">${t}</label>`));

  $("ciForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("ciErr");
    const title = document.querySelector('input[name="title"]:checked')?.value || "";
    const name = $("fName").value.trim().replace(/\s+/g, " ");
    const mda = $("fMda").value.trim().replace(/\s+/g, " ");
    if (!title) return (err.textContent = "Choose your title.");
    if (name.length < 3) return (err.textContent = "Enter your full name.");
    if (mda.length < 2) return (err.textContent = "Enter your MDA.");
    if (!$("fConsent").checked) return (err.textContent = "Tick the box to agree to your photo being shown.");
    if (!sb) return (err.textContent = "Check-in isn't connected yet. Ask the organiser to finish setup.");

    const canvas = snapFromVideo(480) || fallbackPhoto;
    if (!canvas) return (err.textContent = "We need your photo. Turn on the camera or take a photo instead.");
    if (stream) { const f = $("flash"); f.classList.remove("go"); void f.offsetWidth; f.classList.add("go"); }

    err.textContent = ""; const btn = $("ciSubmit"); btn.disabled = true; btn.textContent = "Checking you in…";
    try {
      const blob = await canvasToBlob(canvas);
      const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.jpg`;
      const up = await sb.storage.from("photos").upload(path, blob, { contentType: "image/jpeg", upsert: false });
      if (up.error) throw up.error;
      const photo_url = sb.storage.from("photos").getPublicUrl(path).data.publicUrl;
      const ins = await sb.from("checkins").insert({ title, name, mda, photo_url });
      if (ins.error) throw ins.error;
      showDone({ title, name }, canvas.toDataURL("image/jpeg", 0.8));
    } catch (x) {
      console.error(x);
      err.textContent = "Couldn't save your check-in. Check the internet connection and tap Check me in again.";
    } finally { btn.disabled = false; btn.textContent = "Check me in"; }
  });

  let doneTimer = null;
  function showDone(e, src) {
    stopCamera();
    $("ciForm").hidden = true; $("ciDone").hidden = false;
    $("doneImg").src = src; $("doneName").textContent = "Welcome, " + fullName(e);
    clearTimeout(doneTimer); doneTimer = setTimeout(resetKiosk, 10000);
  }
  function resetKiosk() {
    clearTimeout(doneTimer);
    $("ciForm").reset(); fallbackPhoto = null; $("still").hidden = true;
    $("ciDone").hidden = true; $("ciForm").hidden = false; $("ciErr").textContent = "";
    if (!$("kiosk").hidden) startCamera();
  }
  $("nextBtn").addEventListener("click", resetKiosk);

  // ---------- display ----------
  const queue = []; let playing = false; let initialLoaded = false;
  const shown = new Set();

  function renderRoll() {
    const roll = $("roll");
    $("dCount").firstChild.nodeValue = String(entries.length);
    $("countLine").textContent = `${entries.length} checked in`;
    if (!entries.length) {
      roll.innerHTML = `<div class="empty"><h2>Waiting for the first arrival</h2><div class="qr" id="qrEmpty"></div><div>Scan to check in. Each arrival is welcomed here, then listed in order.</div></div>`;
      drawQR($("qrEmpty"));
      return;
    }
    roll.innerHTML = entries.map((e, i) => {
      const pic = e.photo_url ? `<img src="${esc(e.photo_url)}" alt="" loading="lazy">` : `<div class="ph">${esc(initials(e.name))}</div>`;
      return `<div class="entry${shown.has(e.id) ? "" : " pending"}" data-id="${esc(e.id)}"><div class="sn">${i + 1}.</div>${pic}<div class="who"><div class="nm">${esc(fullName(e))}</div><div class="md">${esc(e.mda)}</div><div class="tm">${fmtTime(e.arrived_at)}</div></div></div>`;
    }).join("");
  }

  let lastSig = null;
  function onEntries(list) {
    const sig = list.map(e => e.id).join(",");
    if (sig === lastSig && initialLoaded) return; // nothing changed
    lastSig = sig;
    entries = list;
    if (!initialLoaded) { list.forEach(e => shown.add(e.id)); initialLoaded = true; }
    else list.forEach(e => { if (!shown.has(e.id) && !queue.some(q => q.id === e.id)) queue.push(e); });
    renderRoll();
    playNext();
  }

  async function playNext() {
    if (playing || !queue.length || $("display").hidden) return;
    playing = true;
    const e = queue.shift();
    const idx = entries.findIndex(x => x.id === e.id);
    if (idx >= 0) await showWelcome(e, idx + 1, true);
    playing = false; playNext();
  }

  async function showWelcome(e, serial, real) {
    const w = $("welcome");
    if (e.photo_url) { // preload so the portrait appears with the name
      await new Promise(r => { const i = new Image(); i.onload = i.onerror = r; i.src = e.photo_url; setTimeout(r, 3000); });
    }
    $("wBig").outerHTML = e.photo_url ? `<img class="big" id="wBig" src="${esc(e.photo_url)}" alt="">` : `<div class="big" id="wBig">${esc(initials(e.name))}</div>`;
    $("wName").textContent = fullName(e); $("wMda").textContent = e.mda;
    $("wNum").textContent = `No. ${serial} · arrived ${fmtTime(e.arrived_at)}`;
    w.hidden = false; w.classList.remove("in"); void w.offsetWidth; w.classList.add("in");
    await wait(reduced ? 3000 : 4800);

    const target = real ? $("roll").querySelector(`.entry[data-id="${CSS.escape(e.id)}"]`) : null;
    if (target) { target.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" }); await wait(400); }
    const bigEl = $("wBig"), thumb = target?.querySelector("img,.ph");
    if (thumb && !reduced && bigEl.animate) {
      const a = bigEl.getBoundingClientRect(), b = thumb.getBoundingClientRect();
      const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2), s = b.width / a.width;
      w.querySelectorAll(".hello,.name,.mda,.num").forEach(n => n.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: "forwards" }));
      w.animate([{ backgroundColor: "rgba(6,12,10,.86)" }, { backgroundColor: "rgba(6,12,10,0)" }], { duration: 900, fill: "forwards" });
      await bigEl.animate([{ transform: "none" }, { transform: `translate(${dx}px,${dy}px) scale(${s})` }], { duration: 900, easing: "cubic-bezier(.6,0,.2,1)", fill: "forwards" }).finished;
    } else if (w.animate && !reduced) {
      await w.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 500, fill: "forwards" }).finished;
    }
    if (real) {
      shown.add(e.id);
      const live = $("roll").querySelector(`.entry[data-id="${CSS.escape(e.id)}"]`);
      if (live) { live.classList.remove("pending"); live.classList.add("fresh"); }
    }
    w.hidden = true; w.getAnimations({ subtree: true }).forEach(an => an.cancel()); w.classList.remove("in");
  }

  $("demoBtn").addEventListener("click", () => {
    if (playing) return; playing = true;
    showWelcome({ title: "Dr", name: "Sample Attendee", mda: "Example MDA (preview only, not saved)", arrived_at: new Date().toISOString() }, entries.length + 1, false)
      .then(() => { playing = false; playNext(); });
  });
  $("fsBtn").addEventListener("click", async () => { try { document.fullscreenElement ? await document.exitFullscreen() : await document.documentElement.requestFullscreen(); } catch {} });
  $("backBtn").addEventListener("click", () => { location.hash = ""; });

  // ---------- data ----------
  async function loadEntries() {
    const { data, error } = await sb.from("checkins").select("id,title,name,mda,photo_url,arrived_at").order("arrived_at", { ascending: true }).limit(1000);
    if (error) { status("Can't reach the database. Retrying…"); return; }
    status("");
    // If rows were removed (organiser cleared the list), start fresh without replaying welcomes.
    if (data.length < entries.length) { shown.clear(); queue.length = 0; initialLoaded = false; }
    onEntries(data);
  }
  async function loadSettings() {
    const { data } = await sb.from("settings").select("event_name").eq("id", 1).maybeSingle();
    eventName = data?.event_name || "";
    if (document.activeElement !== $("evName")) $("evName").value = eventName;
    setEventLabels();
  }
  function status(t) { const n = $("dNote"); n.textContent = t; n.hidden = !t; }

  // ---------- organiser ----------
  const pin = () => $("pin").value.trim();
  function adminMsg(t) { $("adminMsg").textContent = t; }
  $("evSave").addEventListener("click", async () => {
    if (!sb) return adminMsg("Not connected yet.");
    if (!pin()) return adminMsg("Enter the organiser PIN first.");
    const { error } = await sb.rpc("set_event_name", { p_pin: pin(), p_name: $("evName").value.trim() });
    adminMsg(error ? (/PIN/.test(error.message) ? "That PIN is wrong." : "Couldn't save the name.") : "Programme name saved.");
    if (!error) loadSettings();
  });
  $("resetBtn").addEventListener("click", () => { if (!pin()) return adminMsg("Enter the organiser PIN first."); $("resetConfirm").hidden = false; });
  $("resetNo").addEventListener("click", () => { $("resetConfirm").hidden = true; });
  $("resetYes").addEventListener("click", async () => {
    $("resetYes").disabled = true;
    const { error } = await sb.rpc("clear_checkins", { p_pin: pin() });
    $("resetYes").disabled = false; $("resetConfirm").hidden = true;
    adminMsg(error ? (/PIN/.test(error.message) ? "That PIN is wrong." : "Couldn't clear the list.") : "All check-ins cleared.");
    if (!error) loadEntries();
  });

  // ---------- boot ----------
  setEventLabels();
  drawQR($("qrHome")); drawQR($("qrBar"));
  $("kioskUrl").textContent = kioskUrl;
  route();

  if (!sb) {
    $("cfgNote").hidden = false;
    $("cfgNote").textContent = "Not connected to the database yet: add the Supabase anon public key to config.js. The welcome preview still works.";
    status("Not connected. Preview only.");
    return;
  }
  loadSettings();
  loadEntries();
  sb.channel("tapin")
    .on("postgres_changes", { event: "*", schema: "public", table: "checkins" }, () => loadEntries())
    .on("postgres_changes", { event: "*", schema: "public", table: "settings" }, () => loadSettings())
    .subscribe(s => { if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") status("Live link interrupted. Refreshing every few seconds."); });
  setInterval(loadEntries, 15000); // safety net if the live link drops
})();
