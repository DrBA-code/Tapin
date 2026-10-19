(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const TITLES = ["Prof", "Dr", "Mr", "Mrs", "Miss"];
  const cfg = window.TAPIN_CONFIG || {};
  const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.startsWith("PASTE");
  const sb = configured && window.supabase ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const BASE = location.origin + location.pathname;

  // ---------- helpers ----------
  const fullName = e => (e.title === "Miss" ? "Miss " : e.title ? e.title + ". " : "") + e.name;
  const initials = n => (n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join("");
  const fmtTime = t => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
  const fmtDate = t => new Date(t).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  const fmtDur = (a, b) => { if (!a || !b) return ""; const m = Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000)); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} }
  };
  const session = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
    del(k) { try { sessionStorage.removeItem(k); } catch {} }
  };
  const kioskLink = code => `${BASE}#kiosk/${code}`;
  function qrSvg(text) {
    if (!window.qrcode) return "";
    const q = window.qrcode(0, "M"); q.addData(text); q.make();
    return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }
  document.querySelectorAll("[data-logos]").forEach(el => el.appendChild($("logosTpl").content.cloneNode(true)));

  // ---------- routing ----------
  const SECTIONS = ["home", "kiosk", "display", "register", "qrpage"];
  let routeToken = 0;
  let cleanup = [];
  function parseHash() {
    const [mode, code] = location.hash.replace(/^#/, "").split("/");
    return { mode: mode || "home", code: (code || "").toUpperCase() };
  }
  function show(id) { SECTIONS.forEach(s => ($(s).hidden = s !== id)); }
  async function route() {
    const token = ++routeToken;
    cleanup.forEach(fn => { try { fn(); } catch {} }); cleanup = [];
    stopCamera();
    const { mode, code } = parseHash();
    if (mode === "kiosk") return openKiosk(code, token);
    if (mode === "display") return openDisplay(code, token);
    if (mode === "register") return openRegister(code, token);
    if (mode === "qr") return openQrPage(code, token);
    return openHome(token);
  }
  addEventListener("hashchange", route);

  let wakeLock = null;
  async function keepAwake() { try { if (!wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => (wakeLock = null)); } } catch (e) {} }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && (!$("display").hidden || !$("kiosk").hidden)) keepAwake(); });

  async function getProgramme(code) {
    if (!sb || !code) return null;
    const { data } = await sb.from("programmes").select("*").eq("code", code).maybeSingle();
    return data || null;
  }

  // =====================================================================
  // ORGANISER HOME
  // =====================================================================
  const pin = () => session.get("tapin_pin") || "";
  async function verifyPin(p) {
    if (!sb) return false;
    const { data, error } = await sb.rpc("organiser_check", { p_pin: p });
    return !error && data === true;
  }

  async function openHome(token) {
    show("home");
    if (!sb) {
      $("cfgNote").hidden = false;
      $("cfgNote").textContent = "Not connected to the database. Check config.js.";
      return;
    }
    if (pin() && await verifyPin(pin())) {
      if (token !== routeToken) return;
      const back = session.get("tapin_after");
      if (back) { session.del("tapin_after"); location.hash = back; return; }
      $("signin").hidden = true; $("coordIn").hidden = true; $("console").hidden = false;
      loadProgrammes();
      const ch = sb.channel("home-" + Date.now())
        .on("postgres_changes", { event: "*", schema: "public", table: "programmes" }, () => loadProgrammes())
        .on("postgres_changes", { event: "*", schema: "public", table: "checkins" }, () => loadProgrammes())
        .subscribe();
      cleanup.push(() => sb.removeChannel(ch));
    } else {
      $("signin").hidden = false; $("coordIn").hidden = false; $("console").hidden = true;
    }
  }

  $("pinForm").addEventListener("submit", async e => {
    e.preventDefault();
    const p = $("pin").value.trim();
    if (!p) return ($("pinErr").textContent = "Enter the organiser PIN.");
    $("pinErr").textContent = "Checking…";
    if (await verifyPin(p)) { session.set("tapin_pin", p); $("pin").value = ""; $("pinErr").textContent = ""; route(); }
    else $("pinErr").textContent = "That PIN is wrong.";
  });
  $("coordForm").addEventListener("submit", async e => {
    e.preventDefault();
    const code = $("cCode").value.trim().toUpperCase(), p = $("cPin").value;
    if (code.length < 4) return ($("cErr").textContent = "Enter your programme's link code.");
    if (!p) return ($("cErr").textContent = "Enter your coordinator PIN.");
    $("cErr").textContent = "Checking…";
    const { data, error } = await sb.rpc("coordinator_check", { p_code: code, p_pin: p });
    if (error || !data) return ($("cErr").textContent = "That link code and PIN don't match a programme.");
    session.set("tapin_cpin_" + code, p); $("cPin").value = ""; $("cErr").textContent = "";
    location.hash = "#register/" + code;
  });
  $("signOut").addEventListener("click", () => { session.del("tapin_pin"); route(); });

  $("newForm").addEventListener("submit", async e => {
    e.preventDefault();
    const name = $("newName").value.trim(), pcode = $("newCode").value.trim(), coord = $("newCoord").value.trim(), cpin = $("newCPin").value.trim();
    const err = $("newErr");
    if (name.length < 3) return (err.textContent = "Enter the programme name.");
    if (pcode.length < 2) return (err.textContent = "Enter the programme code.");
    if (coord.length < 3) return (err.textContent = "Enter the programme coordinator's name.");
    if (cpin.length < 4) return (err.textContent = "Set a coordinator PIN of at least 4 characters.");
    err.textContent = "Opening portal…";
    const { error } = await sb.rpc("create_programme", { p_pin: pin(), p_name: name, p_programme_code: pcode, p_coordinator: coord, p_coordinator_pin: cpin });
    if (error) {
      const m = error.message || "";
      if (/Could not find the function|does not exist|schema cache/i.test(m)) return (err.textContent = "The database needs an update: run upgrade-3-coordinators.sql (and upgrade-4-throw.sql) in Supabase, then try again.");
      if (/PIN/.test(m)) return (err.textContent = /Coordinator PIN/.test(m) ? m + "." : "Your session expired. Sign in again.");
      return (err.textContent = "Couldn't open the portal: " + m);
    }
    err.textContent = "";
    $("newForm").reset();
    showNewPanel(false);
    $("newDone").textContent = `“${name}” is open. Its QR code is at the top of the list.`;
    loadProgrammes();
  });

  // The "Start a programme" box stays closed until you ask for it, and closes again once the portal is open.
  function showNewPanel(open) {
    $("newPanel").hidden = !open; $("newToggle").hidden = open;
    if (open) { $("newDone").textContent = ""; $("newName").focus(); }
  }
  $("newToggle").addEventListener("click", () => showNewPanel(true));
  $("newClose").addEventListener("click", () => { showNewPanel(false); $("newErr").textContent = ""; });

  let progLoadTimer = null;
  function loadProgrammes() { clearTimeout(progLoadTimer); progLoadTimer = setTimeout(doLoadProgrammes, 150); }
  async function doLoadProgrammes() {
    const [{ data: progs }, { data: rows }] = await Promise.all([
      sb.from("programmes").select("*").order("created_at", { ascending: false }),
      sb.from("checkins").select("programme_id,tap_out_at").not("programme_id", "is", null).limit(10000)
    ]);
    const counts = {};
    (rows || []).forEach(r => { const c = (counts[r.programme_id] ||= { in: 0, out: 0 }); c.in++; if (r.tap_out_at) c.out++; });
    const list = $("progList");
    if (!progs || !progs.length) { list.innerHTML = `<p class="muted">No programmes yet. Create your first portal above.</p>`; showNewPanel(true); return; }
    list.innerHTML = progs.map(p => {
      const c = counts[p.id] || { in: 0, out: 0 };
      return `<article class="prog ${p.status}" data-id="${esc(p.id)}">
        <div class="qr">${qrSvg(kioskLink(p.code))}</div>
        <div class="info">
          <div><span class="pill ${p.status}">${p.status === "open" ? "Open" : "Closed"}</span></div>
          <h3>${esc(p.name)}</h3>
          <div class="meta">${esc(p.programme_code || "No code")} · Coordinator: ${esc(p.coordinator || "—")}</div>
          <div class="meta">Opened ${fmtDate(p.created_at)} · ${c.in} checked in · ${c.out} tapped out · Link code ${esc(p.code)}</div>
          <div class="actions">
            <a class="btn small" href="#display/${p.code}" target="_blank" rel="noopener">Welcome screen</a>
            <a class="btn small ghost" href="#register/${p.code}">Register</a>
            <a class="btn small ghost" href="#qr/${p.code}" target="_blank" rel="noopener">QR poster</a>
            <a class="btn small ghost" href="throw/#${p.code}" target="_blank" rel="noopener">Throw console</a>
            <a class="btn small ghost" href="slides/" target="_blank" rel="noopener" data-present="${p.code}">Present slides</a>
            <a class="btn small ghost" href="wheel/#${p.code}" target="_blank" rel="noopener">Spin the wheel</a>
            <a class="btn small ghost" href="assess/#${p.code}" target="_blank" rel="noopener">Assessments</a>
            <button class="btn small ghost" data-act="copy" data-code="${p.code}" type="button">Copy check-in link</button>
            <button class="btn small ghost" data-act="copycoord" data-code="${p.code}" type="button">Copy coordinator link</button>
            <button class="btn small ghost" data-act="edit" type="button">Edit</button>
            <button class="btn small ghost" data-act="${p.status === "open" ? "close" : "reopen"}" type="button">${p.status === "open" ? "Close programme" : "Reopen"}</button>
          </div>
          <form class="edit" hidden novalidate>
            <label class="f">Programme name<input type="text" name="name" value="${esc(p.name)}"></label>
            <label class="f">Programme code<input type="text" name="pcode" value="${esc(p.programme_code)}"></label>
            <label class="f">Programme coordinator<input type="text" name="coord" value="${esc(p.coordinator)}"></label>
            <label class="f">New coordinator PIN<input type="text" name="cpin" autocomplete="off" placeholder="Leave blank to keep the current PIN"></label>
            <div class="row"><button class="btn small" type="submit">Save</button><button class="btn small ghost" data-act="cancel" type="button">Cancel</button></div>
          </form>
          <div class="err" role="status"></div>
        </div>
      </article>`;
    }).join("");
  }

  // "Present slides": open Air Swipe Slides already connected to this programme's room (no codes to type).
  function presentWith(code, p) { try { localStorage.setItem("airswipe_room", JSON.stringify({ code, pin: p })); } catch {} }
  document.addEventListener("click", e => {
    const a = e.target.closest("a[data-present]"); if (!a) return;
    if (a.dataset.present === "register") { if (rProg) presentWith(rProg.code, rPin); }
    else presentWith(a.dataset.present, pin());
  });
  $("progList").addEventListener("click", async e => {
    const btn = e.target.closest("button[data-act]"); if (!btn) return;
    const card = btn.closest(".prog"), id = card.dataset.id, msg = card.querySelector(".err"), act = btn.dataset.act;
    if (act === "copy") {
      const link = kioskLink(btn.dataset.code);
      try { await navigator.clipboard.writeText(link); msg.textContent = "Check-in link copied."; }
      catch { msg.textContent = link; }
    }
    if (act === "copycoord") {
      const link = `${BASE}#register/${btn.dataset.code}`;
      try { await navigator.clipboard.writeText(link); msg.textContent = "Coordinator link copied. Send it with their PIN."; }
      catch { msg.textContent = link; }
    }
    if (act === "edit") card.querySelector(".edit").hidden = false;
    if (act === "cancel") card.querySelector(".edit").hidden = true;
    if (act === "close" || act === "reopen") {
      if (act === "close" && btn.dataset.sure !== "1") { btn.dataset.sure = "1"; btn.textContent = "Tap again to close"; msg.textContent = "Closing stops new check-ins and tap-outs. The register is kept."; return; }
      const { error } = await sb.rpc("set_programme_status", { p_pin: pin(), p_id: id, p_status: act === "close" ? "closed" : "open" });
      msg.textContent = error ? "Couldn't change the status." : "";
      loadProgrammes();
    }
  });
  $("progList").addEventListener("submit", async e => {
    e.preventDefault();
    const f = e.target, card = f.closest(".prog"), msg = card.querySelector(".err");
    const { error } = await sb.rpc("update_programme", { p_pin: pin(), p_id: card.dataset.id, p_name: f.name.value, p_programme_code: f.pcode.value, p_coordinator: f.coord.value });
    if (error) return (msg.textContent = "Couldn't save the changes.");
    const np = f.cpin.value.trim();
    if (np) {
      if (np.length < 4) return (msg.textContent = "Details saved. The coordinator PIN must be at least 4 characters.");
      const r = await sb.rpc("set_coordinator_pin", { p_pin: pin(), p_id: card.dataset.id, p_new_pin: np });
      if (r.error) return (msg.textContent = "Details saved, but the coordinator PIN couldn't be changed.");
    }
    msg.textContent = np ? "Saved, including the new coordinator PIN." : "Saved.";
    loadProgrammes();
  });

  // =====================================================================
  // KIOSK — tap in / tap out
  // =====================================================================
  let kProg = null;
  async function openKiosk(code, token) {
    show("kiosk");
    $("kNoProg").hidden = true; $("kMain").hidden = true;
    if (!code) { $("kNoProg").hidden = false; $("kNoProgMsg").textContent = "Scan the QR code for your programme to check in."; return; }
    kProg = await getProgramme(code);
    if (token !== routeToken) return;
    if (!kProg) { $("kNoProg").hidden = false; $("kNoProgMsg").textContent = sb ? "This check-in link isn't valid. Scan the QR code shown at the venue." : "Check-in isn't connected yet."; return; }
    if (kProg.status !== "open") { $("kNoProg").hidden = false; $("kNoProgMsg").textContent = `${kProg.name} is closed. Check-in and tap-out are no longer available.`; return; }
    $("kEvent").textContent = kProg.name;
    $("kMain").hidden = false;
    keepAwake();
    setTab("in");
  }

  function setTab(which) {
    $("tabIn").setAttribute("aria-selected", which === "in");
    $("tabOut").setAttribute("aria-selected", which === "out");
    $("ciDone").hidden = true;
    $("ciForm").hidden = which !== "in";
    $("outPanel").hidden = which !== "out";
    if (which === "in") { startCamera(); } else { stopCamera(); prepareTapOut(); }
  }
  $("tabIn").addEventListener("click", () => setTab("in"));
  $("tabOut").addEventListener("click", () => setTab("out"));

  // camera
  let stream = null, fallbackPhoto = null;
  async function startCamera() {
    if (stream || $("kiosk").hidden) return;
    if (!navigator.mediaDevices?.getUserMedia) return cameraUnavailable("This browser can't use the camera here.");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 720 } }, audio: false });
      if ($("kiosk").hidden || $("ciForm").hidden) { stopCamera(); return; }
      const v = $("video"); v.srcObject = stream; v.hidden = false; $("camMsg").hidden = true; $("still").hidden = true;
      await v.play().catch(() => {});
      $("camStart").hidden = true; $("pickLbl").hidden = true;
      $("camHint").textContent = "Look at the camera. Your photo is taken when you tap Check me in.";
    } catch (e) {
      stream = null;
      cameraUnavailable(e && e.name === "NotAllowedError" ? "Camera permission was declined." : "The camera couldn't start.");
    }
  }
  function cameraUnavailable(reason) {
    $("camMsg").hidden = false; $("camMsg").textContent = "No camera"; $("video").hidden = true;
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
    ctx.translate(size, 0); ctx.scale(-1, 1);
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
    if (!sb || !kProg) return (err.textContent = "Check-in isn't connected. Ask the organiser.");
    const canvas = snapFromVideo(480) || fallbackPhoto;
    if (!canvas) return (err.textContent = "We need your photo. Turn on the camera or take a photo instead.");
    if (stream) { const f = $("flash"); f.classList.remove("go"); void f.offsetWidth; f.classList.add("go"); }

    err.textContent = ""; const btn = $("ciSubmit"); btn.disabled = true; btn.textContent = "Checking you in…";
    try {
      const blob = await canvasToBlob(canvas);
      const id = crypto.randomUUID();
      const path = `${kProg.code}/${id}.jpg`;
      const up = await sb.storage.from("photos").upload(path, blob, { contentType: "image/jpeg", upsert: false });
      if (up.error) throw up.error;
      const photo_url = sb.storage.from("photos").getPublicUrl(path).data.publicUrl;
      const ins = await sb.from("checkins").insert({ id, programme_id: kProg.id, title, name, mda, photo_url });
      if (ins.error) throw ins.error;
      store.set("tapin_mine_" + kProg.code, { id, title, name, photo_url, arrived_at: new Date().toISOString() });
      showDone("in", { title, name }, canvas.toDataURL("image/jpeg", 0.8));
    } catch (x) {
      console.error(x);
      err.textContent = "Couldn't save your check-in. Check the internet connection and tap Check me in again.";
    } finally { btn.disabled = false; btn.textContent = "Check me in"; }
  });

  // tap out
  let outChosen = null, outSearchTimer = null;
  function prepareTapOut() {
    $("outErr").textContent = ""; $("outQ").value = ""; $("outResults").innerHTML = "";
    const mine = kProg && store.get("tapin_mine_" + kProg.code);
    if (mine && !mine.out) chooseForOut(mine, true); else showOutSearch();
  }
  function showOutSearch() { outChosen = null; $("outMine").hidden = true; $("outSearch").hidden = false; }
  function chooseForOut(rec, isMine) {
    outChosen = rec;
    $("outMineImg").src = rec.photo_url || ""; $("outMineImg").hidden = !rec.photo_url;
    $("outMineName").textContent = fullName(rec);
    $("outMineIn").textContent = rec.arrived_at ? `Checked in at ${fmtTime(rec.arrived_at)}` : "";
    $("outNotMe").textContent = isMine ? "This isn't me" : "Choose someone else";
    $("outMine").hidden = false; $("outSearch").hidden = true;
  }
  $("outNotMe").addEventListener("click", showOutSearch);
  $("outQ").addEventListener("input", () => {
    clearTimeout(outSearchTimer);
    const q = $("outQ").value.trim();
    if (q.length < 3) { $("outResults").innerHTML = ""; return; }
    outSearchTimer = setTimeout(async () => {
      const like = "%" + q.replace(/[%_\\]/g, m => "\\" + m) + "%";
      const { data, error } = await sb.from("checkins").select("id,title,name,mda,photo_url,arrived_at")
        .eq("programme_id", kProg.id).is("tap_out_at", null).ilike("name", like).order("name").limit(8);
      if (error) { $("outErr").textContent = "Couldn't search. Check the connection."; return; }
      $("outResults").innerHTML = data.length
        ? data.map((r, i) => `<button type="button" data-i="${i}">${r.photo_url ? `<img src="${esc(r.photo_url)}" alt="">` : `<span class="ph"></span>`}<span><span class="nm">${esc(fullName(r))}</span><br><span class="sm">${esc(r.mda)} · in ${fmtTime(r.arrived_at)}</span></span></button>`).join("")
        : `<p class="muted">No one still checked in matches “${esc(q)}”.</p>`;
      $("outResults").querySelectorAll("button").forEach(b => b.addEventListener("click", () => chooseForOut(data[+b.dataset.i], false)));
    }, 300);
  });
  $("outMineBtn").addEventListener("click", async () => {
    if (!outChosen) return;
    const btn = $("outMineBtn"); btn.disabled = true; btn.textContent = "Tapping you out…";
    const { error } = await sb.rpc("tap_out", { p_checkin: outChosen.id });
    btn.disabled = false; btn.textContent = "Tap me out";
    if (error) { $("outErr").textContent = /Already/.test(error.message) ? "You're already tapped out, or the programme has closed." : "Couldn't tap you out. Check the connection and try again."; return; }
    const mine = store.get("tapin_mine_" + kProg.code);
    if (mine && mine.id === outChosen.id) store.set("tapin_mine_" + kProg.code, { ...mine, out: true });
    showDone("out", outChosen, outChosen.photo_url);
  });

  let doneTimer = null;
  function showDone(kind, e, src) {
    stopCamera();
    $("ciForm").hidden = true; $("outPanel").hidden = true; $("ciDone").hidden = false;
    $("doneImg").src = src || ""; $("doneImg").hidden = !src;
    if (kind === "in") {
      $("doneEyebrow").textContent = "You're checked in";
      $("doneName").textContent = "Ẹ káàbọ̀, " + fullName(e);
      $("doneMsg").textContent = "You are welcome. Look up at the screen.";
      $("roomLink").href = "room/#" + kProg.code; $("roomLink").hidden = false;
    } else {
      $("doneEyebrow").textContent = "You've tapped out";
      $("doneName").textContent = "Ó dàbọ̀, " + fullName(e);
      $("doneMsg").textContent = "Goodbye, and thank you for attending.";
      $("roomLink").href = "room/#" + kProg.code; $("roomLink").hidden = false;
      fbFor = e.id; fbStars = 0; $("fbText").value = ""; $("fbErr").textContent = ""; paintStars();
      $("fbForm").hidden = false; $("fbThanks").hidden = true;
    }
    clearTimeout(doneTimer); doneTimer = setTimeout(resetKiosk, kind === "out" ? 60000 : 20000);
  }
  // Tap-out feedback: stars and an optional comment (saved with leave_feedback, upgrade 6).
  let fbFor = null, fbStars = 0;
  const holdDone = () => { clearTimeout(doneTimer); doneTimer = setTimeout(resetKiosk, 60000); };
  function paintStars() { document.querySelectorAll("#fbStars button").forEach(b => b.classList.toggle("on", +b.dataset.s <= fbStars)); }
  $("fbStars").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; fbStars = +b.dataset.s; paintStars(); holdDone(); });
  $("fbText").addEventListener("input", holdDone);
  $("fbForm").addEventListener("submit", async e => {
    e.preventDefault();
    if (!fbFor) return;
    if (!fbStars) { $("fbErr").textContent = "Tap the stars to rate the session."; return; }
    $("fbErr").textContent = "Sending…";
    const { error } = await sb.rpc("leave_feedback", { p_checkin: fbFor, p_stars: fbStars, p_comment: $("fbText").value.trim() });
    if (error) { $("fbErr").textContent = /Could not find the function|schema cache/i.test(error.message || "") ? "Feedback isn't switched on yet." : "Couldn't send. Try again."; return; }
    $("fbForm").hidden = true; $("fbThanks").hidden = false; $("fbThanks").textContent = "Thank you for your feedback " + "★".repeat(fbStars);
    clearTimeout(doneTimer); doneTimer = setTimeout(resetKiosk, 6000);
  });
  function resetKiosk() {
    clearTimeout(doneTimer);
    $("fbForm").hidden = true; $("fbThanks").hidden = true; fbFor = null;
    $("ciForm").reset(); fallbackPhoto = null; $("still").hidden = true; $("ciErr").textContent = "";
    if (!$("kiosk").hidden && !$("kMain").hidden) setTab("in");
  }
  $("nextBtn").addEventListener("click", resetKiosk);

  // =====================================================================
  // DISPLAY — welcome / farewell
  // =====================================================================
  let dProg = null, entries = [], queue = [], playing = false, initialLoaded = false, lastSig = null;
  const shown = new Set(), outShown = new Set();

  async function openDisplay(code, token) {
    show("display");
    entries = []; queue = []; initialLoaded = false; lastSig = null; shown.clear(); outShown.clear();
    $("dDate").textContent = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" }).toUpperCase();
    dProg = await getProgramme(code);
    if (token !== routeToken) return;
    if (!dProg) { $("dEvent").textContent = "Programme not found"; $("roll").innerHTML = `<div class="empty"><h2>Open this screen from the programme list</h2><div>Sign in on the menu page and choose Welcome screen for your programme.</div></div>`; return; }
    $("dEvent").textContent = dProg.name;
    if (dProg.programme_code) $("dDate").textContent += " · " + dProg.programme_code;
    $("qrBar").innerHTML = qrSvg(kioskLink(dProg.code));
    keepAwake();
    await loadEntries(token);
    const ch = sb.channel("display-" + dProg.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "checkins", filter: `programme_id=eq.${dProg.id}` }, () => loadEntries(token))
      .subscribe(s => { if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") status("Live link interrupted. Refreshing every few seconds."); });
    const poll = setInterval(() => loadEntries(token), 15000);
    cleanup.push(() => { sb.removeChannel(ch); clearInterval(poll); });
  }

  async function loadEntries(token) {
    if (!dProg || token !== routeToken) return;
    const { data, error } = await sb.from("checkins").select("id,title,name,mda,photo_url,arrived_at,tap_out_at")
      .eq("programme_id", dProg.id).order("arrived_at", { ascending: true }).limit(2000);
    if (error) { status("Can't reach the database. Retrying…"); return; }
    status("");
    const sig = data.map(e => e.id + (e.tap_out_at ? "o" : "")).join(",");
    if (sig === lastSig && initialLoaded) return;
    lastSig = sig; entries = data;
    if (!initialLoaded) {
      data.forEach(e => { shown.add(e.id); if (e.tap_out_at) outShown.add(e.id); });
      initialLoaded = true;
    } else {
      data.forEach(e => {
        if (!shown.has(e.id) && !queue.some(q => q.kind === "in" && q.id === e.id)) queue.push({ kind: "in", id: e.id });
        if (e.tap_out_at && !outShown.has(e.id) && !queue.some(q => q.kind === "out" && q.id === e.id)) queue.push({ kind: "out", id: e.id });
      });
    }
    renderRoll(); playNext();
  }

  function renderRoll() {
    const roll = $("roll");
    $("dCount").textContent = entries.length;
    $("dOut").textContent = entries.filter(e => e.tap_out_at && outShown.has(e.id)).length;
    if (!entries.length) {
      roll.innerHTML = `<div class="empty"><h2>Waiting for the first arrival</h2><div class="qr" id="qrEmpty">${qrSvg(kioskLink(dProg.code))}</div><div>Scan to check in. Each arrival is welcomed here, then listed in order.</div></div>`;
      return;
    }
    roll.innerHTML = entries.map((e, i) => {
      const pic = e.photo_url ? `<img src="${esc(e.photo_url)}" alt="" loading="lazy">` : `<div class="ph">${esc(initials(e.name))}</div>`;
      const isOut = e.tap_out_at && outShown.has(e.id);
      return `<div class="entry${shown.has(e.id) ? "" : " pending"}${isOut ? " isout" : ""}" data-id="${esc(e.id)}"><div class="sn">${i + 1}.</div>${pic}<div class="who"><div class="nm">${esc(fullName(e))}</div><div class="md">${esc(e.mda)}</div><div class="tm">In ${fmtTime(e.arrived_at)}${isOut ? `<span class="o">Out ${fmtTime(e.tap_out_at)}</span>` : ""}</div></div></div>`;
    }).join("");
  }

  async function playNext() {
    if (playing || !queue.length || $("display").hidden) return;
    playing = true;
    const job = queue.shift();
    const idx = entries.findIndex(x => x.id === job.id);
    if (idx >= 0) await showMoment(job.kind, entries[idx], idx + 1, true);
    playing = false; playNext();
  }

  async function showMoment(kind, e, serial, real) {
    const w = $("welcome");
    if (e.photo_url) await new Promise(r => { const i = new Image(); i.onload = i.onerror = r; i.src = e.photo_url; setTimeout(r, 3000); });
    $("wBig").outerHTML = e.photo_url ? `<img class="big" id="wBig" src="${esc(e.photo_url)}" alt="">` : `<div class="big" id="wBig">${esc(initials(e.name))}</div>`;
    $("wHello").innerHTML = kind === "in"
      ? `<span lang="yo">Ẹ káàbọ̀</span><span class="en">You are welcome</span>`
      : `<span lang="yo">Ó dàbọ̀</span><span class="en">Goodbye · Thank you for attending</span>`;
    $("wName").textContent = fullName(e); $("wMda").textContent = e.mda;
    $("wNum").textContent = kind === "in" ? `No. ${serial} · arrived ${fmtTime(e.arrived_at)}` : `No. ${serial} · in ${fmtTime(e.arrived_at)} · out ${fmtTime(e.tap_out_at)}`;
    w.classList.toggle("bye", kind === "out");
    w.hidden = false; w.classList.remove("in"); void w.offsetWidth; w.classList.add("in");
    await wait(reduced ? 3000 : kind === "in" ? 4800 : 4000);

    const sel = real ? `.entry[data-id="${CSS.escape(e.id)}"]` : null;
    const target = sel ? $("roll").querySelector(sel) : null;
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
      if (kind === "in") shown.add(e.id); else outShown.add(e.id);
      renderRoll();
      const live = $("roll").querySelector(sel);
      if (live) live.classList.add("fresh");
    }
    w.hidden = true; w.getAnimations({ subtree: true }).forEach(an => an.cancel()); w.classList.remove("in", "bye");
  }

  $("demoBtn").addEventListener("click", () => {
    if (playing) return; playing = true;
    showMoment("in", { title: "Dr", name: "Sample Attendee", mda: "Example MDA (preview only, not saved)", arrived_at: new Date().toISOString() }, entries.length + 1, false)
      .then(() => { playing = false; playNext(); });
  });
  $("fsBtn").addEventListener("click", async () => { try { document.fullscreenElement ? await document.exitFullscreen() : await document.documentElement.requestFullscreen(); } catch {} });
  function status(t) { const n = $("dNote"); n.textContent = t; n.hidden = !t; }

  // =====================================================================
  // REGISTER (organiser)
  // =====================================================================
  let rProg = null, rRows = [], rPin = "", rRole = null;
  async function accessFor(code) {
    if (pin() && await verifyPin(pin())) return { p: pin(), role: "organiser" };
    const cp = session.get("tapin_cpin_" + code);
    if (cp) {
      const { data } = await sb.rpc("coordinator_check", { p_code: code, p_pin: cp });
      if (data) return { p: cp, role: data };
      session.del("tapin_cpin_" + code);
    }
    return null;
  }
  async function openRegister(code, token) {
    show("register");
    $("rSignin").hidden = true; $("rBody").hidden = true; $("rMsg").textContent = "";
    rProg = await getProgramme(code);
    if (token !== routeToken) return;
    if (!rProg) { $("rTitle").textContent = "Programme not found"; return; }
    $("rTitle").textContent = rProg.name;
    const acc = await accessFor(code);
    if (token !== routeToken) return;
    if (!acc) { $("rSignin").hidden = false; $("rPin").focus(); return; }
    rPin = acc.p; rRole = acc.role;
    $("rBody").hidden = false;
    $("rDisplay").href = "#display/" + rProg.code;
    $("rQr").href = "#qr/" + rProg.code;
    $("rThrow").href = "throw/#" + rProg.code;
    $("rWheel").href = "wheel/#" + rProg.code;
    $("rAssess").href = "assess/#" + rProg.code;
    $("rBack").textContent = rRole === "organiser" ? "Back to programmes" : "Sign out";
    setStatusBtn();
    await loadRegister();
    const ch = sb.channel("register-" + rProg.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "checkins", filter: `programme_id=eq.${rProg.id}` }, () => loadRegister())
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "programmes", filter: `id=eq.${rProg.id}` }, p => { rProg = { ...rProg, ...p.new }; setStatusBtn(); })
      .subscribe();
    cleanup.push(() => sb.removeChannel(ch));
  }
  function setStatusBtn() {
    const b = $("rStatus"); b.dataset.sure = "";
    b.textContent = rProg.status === "open" ? "Close programme" : "Reopen programme";
  }
  $("rPinForm").addEventListener("submit", async e => {
    e.preventDefault();
    const p = $("rPin").value, code = rProg?.code;
    if (!code || !p) return ($("rPinErr").textContent = "Enter the coordinator PIN.");
    $("rPinErr").textContent = "Checking…";
    const { data } = await sb.rpc("coordinator_check", { p_code: code, p_pin: p });
    if (!data) return ($("rPinErr").textContent = "That PIN is wrong for this programme.");
    if (data === "organiser") session.set("tapin_pin", p); else session.set("tapin_cpin_" + code, p);
    $("rPin").value = ""; $("rPinErr").textContent = "";
    route();
  });
  $("rStatus").addEventListener("click", async () => {
    const b = $("rStatus"), closing = rProg.status === "open";
    if (closing && b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Tap again to close"; $("rMsg").textContent = "Closing stops new check-ins and tap-outs. The register is kept."; return; }
    const { error } = await sb.rpc("set_programme_status", { p_pin: rPin, p_id: rProg.id, p_status: closing ? "closed" : "open" });
    if (error) { $("rMsg").textContent = "Couldn't change the status."; return; }
    rProg.status = closing ? "closed" : "open"; $("rMsg").textContent = closing ? "Programme closed." : "Programme reopened."; setStatusBtn();
  });
  $("rBack").addEventListener("click", () => { if (rRole === "coordinator" && rProg) session.del("tapin_cpin_" + rProg.code); });
  async function loadRegister() {
    const { data } = await sb.from("checkins").select("id,title,name,mda,photo_url,arrived_at,tap_out_at")
      .eq("programme_id", rProg.id).order("arrived_at", { ascending: true }).limit(5000);
    rRows = data || [];
    const out = rRows.filter(r => r.tap_out_at);
    const mins = out.map(r => (new Date(r.tap_out_at) - new Date(r.arrived_at)) / 60000);
    const avg = mins.length ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) : null;
    $("rStats").innerHTML = [
      ["Programme code", esc(rProg.programme_code || "—")], ["Coordinator", esc(rProg.coordinator || "—")],
      ["Checked in", rRows.length], ["Tapped out", out.length], ["Still in", rRows.length - out.length],
      ["Average time", avg == null ? "—" : `${Math.floor(avg / 60)}h ${String(avg % 60).padStart(2, "0")}m`]
    ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join("");
    $("rTable").innerHTML = `<thead><tr><th>S/N</th><th>Photo</th><th>Title</th><th>Name</th><th>MDA</th><th>Date</th><th>Time in</th><th>Time out</th><th>Duration</th></tr></thead><tbody>` +
      (rRows.length ? rRows.map((r, i) => `<tr><td class="n">${i + 1}</td><td>${r.photo_url ? `<a href="${esc(r.photo_url)}" target="_blank" rel="noopener"><img src="${esc(r.photo_url)}" alt="" loading="lazy"></a>` : ""}</td><td>${esc(r.title)}</td><td>${esc(r.name)}</td><td>${esc(r.mda)}</td><td class="n">${fmtDate(r.arrived_at)}</td><td class="n">${fmtTime(r.arrived_at)}</td><td class="n">${fmtTime(r.tap_out_at) || "—"}</td><td class="n">${fmtDur(r.arrived_at, r.tap_out_at) || "—"}</td></tr>`).join("")
        : `<tr><td colspan="9" class="muted">No one has checked in yet.</td></tr>`) + `</tbody>`;
  }
  $("csvBtn").addEventListener("click", () => {
    if (!rProg) return;
    const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      ["Programme", rProg.name], ["Programme code", rProg.programme_code], ["Coordinator", rProg.coordinator], ["Exported", new Date().toLocaleString()], [],
      ["S/N", "Title", "Name", "MDA", "Date", "Time in", "Time out", "Duration", "Photo link"],
      ...rRows.map((r, i) => [i + 1, r.title, r.name, r.mda, fmtDate(r.arrived_at), fmtTime(r.arrived_at), fmtTime(r.tap_out_at), fmtDur(r.arrived_at, r.tap_out_at), r.photo_url])
    ].map(row => row.map(q).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + lines], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Register - ${(rProg.programme_code || rProg.code).replace(/[\\/:*?"<>|]/g, "-")} - ${rProg.name.replace(/[\\/:*?"<>|]/g, "-").slice(0, 60)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // =====================================================================
  // QR POSTER
  // =====================================================================
  async function openQrPage(code, token) {
    show("qrpage");
    const p = await getProgramme(code);
    if (token !== routeToken) return;
    if (!p) { $("qTitle").textContent = "Programme not found"; $("qrBig").innerHTML = ""; $("qUrl").textContent = ""; return; }
    $("qTitle").textContent = p.name;
    $("qrBig").innerHTML = qrSvg(kioskLink(p.code));
    $("qUrl").textContent = kioskLink(p.code);
  }

  // ---------- boot ----------
  route();
})();
