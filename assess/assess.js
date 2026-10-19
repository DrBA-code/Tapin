// Assessments console: tiles → builder → live stage on the projector. Phones answer in the session room (room/).
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ss = { get(k) { try { return sessionStorage.getItem(k); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch {} } };
  const ls = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
  const { KINDS, BANDS, LETTERS, COLORS, blankStep, SCHEMA } = window.ASSESS;
  document.querySelectorAll("[data-logos]").forEach(el => el.appendChild($("logosTpl").content.cloneNode(true)));
  const cfg = window.TAPIN_CONFIG || {};
  const sb = window.supabase && cfg.SUPABASE_URL ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
  const code = location.hash.replace("#", "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const ROOM = new URL("../room/", location.href).href + "#" + code;
  const SCORED = k => !!(KINDS[k] && KINDS[k].scored);
  const initials = n => String(n || "?").replace(/^(Prof|Dr|Mr|Mrs|Miss)\.?\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";
  const firstName = n => String(n || "").replace(/^(Prof|Dr|Mr|Mrs|Miss)\.?\s+/i, "").split(/\s+/)[0] || n || "";
  const pct = x => Math.round((x || 0) * 100);
  let prog = null, pin = "", acts = [], channel = null, phones = 0;

  function note(t) { $("note").hidden = !t; $("note").textContent = t || ""; }
  function qrSvg(t) { if (!window.qrcode) return ""; const q = window.qrcode(0, "M"); q.addData(t); q.make(); return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); }
  const dbHint = e => /Could not find the function|does not exist|schema cache/i.test((e && e.message) || "");
  function dbErr(e, fallback) { return dbHint(e) ? "The database needs an update: run supabase/upgrade-6-assess.sql in Supabase (SQL Editor), then reload." : (e && e.message) || fallback; }

  // ================= access =================
  async function check(p) {
    const { data, error } = await sb.rpc("coordinator_check", { p_code: code, p_pin: p });
    if (error && dbHint(error)) note("The database needs updating: run the upgrade SQL files in Supabase, then reload.");
    return data || null;
  }
  async function boot() {
    if (!sb) return note("Can't reach the database. Check the connection.");
    if (!code) return note("Open Assessments from your programme on the menu page.");
    const { data } = await sb.from("programmes").select("*").eq("code", code).maybeSingle();
    prog = data;
    if (!prog) return note("Programme not found. Open Assessments from the menu page.");
    $("title").textContent = prog.name; document.title = "Assessments · " + prog.name;
    for (const p of [ss.get("tapin_pin"), ss.get("tapin_cpin_" + code)].filter(Boolean)) if (await check(p)) { pin = p; return start(); }
    $("lock").hidden = false;
  }
  $("pinForm").addEventListener("submit", async e => {
    e.preventDefault();
    const p = $("pin").value; $("pinErr").textContent = "Checking…";
    const role = await check(p);
    if (!role) return ($("pinErr").textContent = "That PIN is wrong for this programme.");
    ss.set(role === "organiser" ? "tapin_pin" : "tapin_cpin_" + code, p);
    pin = p; $("lock").hidden = true; start();
  });

  async function start() {
    $("roomChip").hidden = false; $("chipQr").innerHTML = qrSvg(ROOM);
    $("dlgQr").innerHTML = qrSvg(ROOM); $("dlgUrl").textContent = ROOM; $("sQr").innerHTML = qrSvg(ROOM);
    await loadActs(); show("home");
    connectRoom();
    // An activity left live (e.g. this page was reloaded mid-question): offer to end it on the phones.
    const { data: ls0 } = await sb.from("live_state").select("*").eq("programme_id", prog.id).maybeSingle();
    if (ls0 && ls0.activity_id && ls0.phase !== "idle") {
      const a = acts.find(x => x.id === ls0.activity_id);
      $("stuck").hidden = false; $("stuckTxt").textContent = `“${a ? a.title : "An activity"}” is still showing on participants' phones.`;
      $("stuckResume").hidden = !a;
      $("stuckResume").onclick = () => { $("stuck").hidden = true; openStage(a, ls0.run, Math.min(ls0.step, a.data.steps.length - 1)); };
      $("stuckEnd").onclick = async () => { await sb.rpc("set_live", { p_pin: pin, p_programme: prog.id, p_activity: null, p_run: "", p_step: 0, p_phase: "idle", p_seconds: 0 }); say("live", { phase: "idle" }); $("stuck").hidden = true; };
    }
  }
  $("roomChip").addEventListener("click", () => $("qrDlg").showModal());

  async function loadActs() {
    const { data, error } = await sb.rpc("list_activities", { p_pin: pin, p_programme: prog.id });
    if (error) { note(dbErr(error, "Couldn't load activities.")); acts = []; return; }
    acts = data || [];
  }

  function connectRoom() {
    channel = sb.channel("room-" + code, { config: { broadcast: { self: false }, presence: { key: "console-" + crypto.randomUUID() } } });
    channel.on("presence", { event: "sync" }, () => {
      const st = channel.presenceState();
      phones = Object.keys(st).filter(k => !k.startsWith("console-")).length;
      $("nIn").textContent = phones;
      if (L && !$("stage").hidden) updateCount();
    });
    channel.on("broadcast", { event: "answered" }, () => { if (L) soonFetch(); });
    channel.subscribe();
  }
  const say = (event, payload = {}) => channel?.send({ type: "broadcast", event, payload });

  // ================= views =================
  const VIEWS = ["home", "kindView", "builder", "mine", "bank", "ai", "results"];
  function show(v) {
    VIEWS.forEach(x => ($(x).hidden = x !== v));
    if (v === "home") renderHome();
    scrollTo({ top: 0 });
  }
  document.addEventListener("click", e => { if (e.target.closest("[data-back]")) show("home"); });

  function renderHome() {
    const n = k => acts.filter(a => a.kind === k).length;
    $("home").innerHTML = BANDS.map(([b, label]) => `<div class="band"><h2>${label}</h2><div class="tiles">${
      Object.entries(KINDS).filter(([, k]) => k.band === b).map(([id, k]) =>
        `<button class="tile" data-kind="${id}" type="button"><span class="ic">${k.ic}</span><b>${esc(k.name)}</b>${n(id) ? `<span class="n">${n(id)}</span>` : ""}</button>`).join("")
    }</div></div>`).join("") +
    `<div class="band"><h2>Tools</h2><div class="tiles">
      <button class="tile tool" data-tool="mine" type="button"><span class="ic">🗂️</span><b>My activities</b></button>
      <button class="tile tool" data-tool="ai" type="button"><span class="ic">✨</span><b>AI question writer</b></button>
      <button class="tile tool" data-tool="bank" type="button"><span class="ic">📚</span><b>Question bank</b></button>
      <button class="tile tool" data-tool="results" type="button"><span class="ic">📋</span><b>Results</b></button>
    </div></div>`;
  }
  $("home").addEventListener("click", e => {
    const t = e.target.closest(".tile"); if (!t) return;
    if (t.dataset.kind === "wheel") return window.open("../wheel/#" + code, "_blank", "noopener");
    if (t.dataset.kind) return openKind(t.dataset.kind);
    const tool = t.dataset.tool;
    if (tool === "mine") { renderList($("mList"), acts); show("mine"); }
    if (tool === "ai") openAI("quiz");
    if (tool === "bank") openBank();
    if (tool === "results") openResults();
  });

  let curKind = "quiz";
  function openKind(kind) {
    curKind = kind; const k = KINDS[kind];
    $("kIc").textContent = k.ic; $("kName").textContent = k.name; $("kLine").textContent = k.line;
    $("kAI").hidden = kind === "spot";
    renderList($("kList"), acts.filter(a => a.kind === kind), `Nothing saved yet. Tap “+ New” to make your first ${k.name.toLowerCase()}.`);
    show("kindView");
  }
  $("kNew").addEventListener("click", () => openBuilder(curKind, null));
  $("kAI").addEventListener("click", () => openAI(curKind));

  function renderList(el, list, empty) {
    el.innerHTML = list.length ? list.map(a => {
      const k = KINDS[a.kind] || { ic: "•", name: a.kind };
      const n = (a.data?.steps || []).length;
      return `<div class="arow" data-id="${esc(a.id)}"><span class="ic">${k.ic}</span><div><b>${esc(a.title || k.name)}</b><small>${esc(k.name)} · ${n} question${n === 1 ? "" : "s"}</small></div>
        <div class="acts"><button class="btn small" data-act="go" type="button">▶ Go live</button><button class="btn small ghost" data-act="edit" type="button">Edit</button></div></div>`;
    }).join("") : `<div class="empty2">${esc(empty || "Nothing saved yet. Pick an activity tile to make one.")}</div>`;
  }
  ["kList", "mList"].forEach(id => $(id).addEventListener("click", e => {
    const b = e.target.closest("button[data-act]"); if (!b) return;
    const a = acts.find(x => x.id === b.closest(".arow").dataset.id); if (!a) return;
    if (b.dataset.act === "go") goLive(a); else openBuilder(a.kind, a);
  }));

  // ================= builder =================
  let B = null;   // { kind, id, title, steps, seconds, from }
  function openBuilder(kind, act, draft) {
    const k = KINDS[kind];
    B = { kind, id: act?.id || null, from: VIEWS.find(v => !$(v).hidden) || "home",
          title: draft?.title ?? act?.title ?? "", steps: structuredClone(draft?.steps || act?.data?.steps || [blankStep(kind)]),
          seconds: act?.data?.seconds ?? k.sec ?? 0 };
    if (!B.steps.length) B.steps.push(blankStep(kind));
    $("bIc").textContent = k.ic; $("bKind").textContent = k.name; $("bLine").textContent = k.line;
    $("bTitle").value = B.title;
    $("bSec").value = String(B.seconds); if ($("bSec").value !== String(B.seconds)) $("bSec").value = "0";
    $("bDel").hidden = !B.id; $("bErr").textContent = ""; $("bAI").hidden = kind === "spot";
    $("bAdd").textContent = ["case", "exit", "feedback", "scale", "words"].includes(kind) ? "+ Add another prompt" : "+ Add question";
    renderSteps(); show("builder");
  }
  $("bBack").addEventListener("click", () => { if (B?.from === "kindView") openKind(B.kind); else if (B?.from === "mine") { renderList($("mList"), acts); show("mine"); } else show("home"); });
  $("bTitle").addEventListener("input", e => (B.title = e.target.value));
  $("bSec").addEventListener("change", e => (B.seconds = +e.target.value));
  $("bAdd").addEventListener("click", () => { B.steps.push(blankStep(B.kind)); renderSteps(); $("bSteps").lastElementChild?.querySelector("textarea,input")?.focus(); });

  function stepCard(s, i) {
    const k = KINDS[B.kind], kind = B.kind;
    let body = `<label class="f">${kind === "case" ? "Task" : "Question"}<textarea rows="2" data-f="q" data-i="${i}" placeholder="${kind === "case" ? "What should the officer do, and why?" : "Type the question"}">${esc(s.q)}</textarea></label>`;
    if (k.opts) {
      const max = k.maxOpts || 6;
      body += `<div class="opts">${s.options.map((o, j) => `<div class="opt">
        ${k.scored ? `<input type="radio" name="c${i}" data-f="correct" data-i="${i}" value="${j}" ${s.correct === j ? "checked" : ""} aria-label="Correct answer ${LETTERS[j]}">` : "<span></span>"}
        <span class="let" style="background:${COLORS[j]}">${kind === "finger" ? j + 1 : LETTERS[j]}</span>
        <input type="text" data-f="opt" data-i="${i}" data-o="${j}" value="${esc(o)}" placeholder="Option ${LETTERS[j]}">
        <button class="x" data-a="delopt" data-i="${i}" data-o="${j}" type="button" aria-label="Remove option" ${s.options.length <= 2 ? "hidden" : ""}>×</button></div>`).join("")}</div>
        <div class="row">${s.options.length < max ? `<button class="btn small ghost" data-a="addopt" data-i="${i}" type="button">+ Option</button>` : ""}
        <span class="hint">${k.scored ? "Tick the correct answer." : kind === "finger" ? "Participants raise 1 finger for option 1, 2 fingers for option 2, and so on." : ""}</span></div>`;
    } else if (kind === "words") {
      body += `<label class="f inline">Answers per person<select data-f="max" data-i="${i}">${[1, 2, 3].map(n => `<option ${s.max === n ? "selected" : ""}>${n}</option>`).join("")}</select></label>`;
    } else if (kind === "scale") {
      body += `<div class="row"><label class="f" style="flex:1">Label for 0<input type="text" data-f="lo" data-i="${i}" value="${esc(s.lo)}"></label><label class="f" style="flex:1">Label for 10<input type="text" data-f="hi" data-i="${i}" value="${esc(s.hi)}"></label></div>`;
    } else if (kind === "order") {
      body += `<label class="f">Items in the CORRECT order, one per line<textarea rows="5" data-f="items" data-i="${i}" placeholder="Raise a requisition&#10;Get approval&#10;Invite quotations&#10;…">${esc((s.items || []).join("\n"))}</textarea></label><span class="hint">Phones get them shuffled.</span>`;
    } else if (kind === "match") {
      body += `<label class="f">One pair per line: term = meaning<textarea rows="5" data-f="pairs" data-i="${i}" placeholder="MDA = Ministry, Department or Agency&#10;LPO = Local Purchase Order">${esc((s.pairs || []).map(p => p.l + " = " + p.r).join("\n"))}</textarea></label>`;
    } else if (kind === "spot") {
      body += `<div class="row"><label class="btn small ghost">${s.image ? "Change picture" : "Upload a slide or document picture"}<input type="file" accept="image/*" data-a="spotimg" data-i="${i}" hidden></label><span class="hint">${s.image ? "Click the picture where the error is." : "PNG or JPG. A screenshot of a slide or document works well."}</span></div>
        ${s.image ? `<div class="spotpick" data-a="spot" data-i="${i}"><img src="${esc(s.image)}" alt="">${s.region ? `<span class="ring" style="left:${s.region.x * 100}%;top:${s.region.y * 100}%;width:${s.region.r * 2 / s.aspect * 100}%;aspect-ratio:1"></span>` : ""}</div>
        <label class="f inline">Target size<input type="range" min="0.03" max="0.25" step="0.01" value="${s.region?.r || 0.08}" data-f="r" data-i="${i}"></label>` : ""}`;
    } else if (kind === "case") {
      body += `<label class="f">The case (shown on phones)<textarea rows="6" data-f="text" data-i="${i}" placeholder="Describe the situation…">${esc(s.text)}</textarea></label>`;
    }
    return `<div class="stepc"><div class="sh"><b>${B.steps.length > 1 ? (["case", "exit", "feedback", "scale", "words"].includes(kind) ? "Prompt " : "Question ") + (i + 1) : (["case", "exit", "feedback", "scale", "words"].includes(kind) ? "Prompt" : "Question")}</b>
      <span class="mini">${i > 0 ? `<button data-a="up" data-i="${i}" type="button" aria-label="Move up">↑</button>` : ""}${i < B.steps.length - 1 ? `<button data-a="down" data-i="${i}" type="button" aria-label="Move down">↓</button>` : ""}${B.steps.length > 1 ? `<button data-a="del" data-i="${i}" type="button" aria-label="Remove">×</button>` : ""}</span></div>${body}</div>`;
  }
  function renderSteps() { $("bSteps").innerHTML = B.steps.map(stepCard).join(""); }

  $("bSteps").addEventListener("input", e => {
    const t = e.target, i = +t.dataset.i, s = B.steps[i]; if (!s || !t.dataset.f) return;
    const f = t.dataset.f;
    if (f === "q" || f === "lo" || f === "hi" || f === "text") s[f] = t.value;
    else if (f === "opt") s.options[+t.dataset.o] = t.value;
    else if (f === "correct") s.correct = +t.value;
    else if (f === "max") s.max = +t.value;
    else if (f === "items") s.items = t.value.split("\n").map(x => x.trim()).filter(Boolean);
    else if (f === "pairs") s.pairs = t.value.split("\n").map(x => x.trim().match(/^(.+?)\s*(?:=|→|:|\s-\s)\s*(.+)$/)).filter(Boolean).map(m => ({ l: m[1].trim(), r: m[2].trim() }));
    else if (f === "r") { s.region = s.region ? { ...s.region, r: +t.value } : null; const ring = t.closest(".stepc").querySelector(".ring"); if (ring && s.region) ring.style.width = (s.region.r * 2 / s.aspect * 100) + "%"; }
  });
  $("bSteps").addEventListener("change", async e => {
    const t = e.target; if (t.dataset.a !== "spotimg" || !t.files[0]) return;
    const s = B.steps[+t.dataset.i]; $("bErr").textContent = "Uploading picture…";
    try {
      const { blob, aspect } = await shrink(t.files[0], 1600);
      const path = `${code}/assess-${crypto.randomUUID()}.jpg`;
      const up = await sb.storage.from("throws").upload(path, blob, { contentType: "image/jpeg" });
      if (up.error) throw up.error;
      s.image = sb.storage.from("throws").getPublicUrl(path).data.publicUrl; s.aspect = aspect; s.region = null;
      $("bErr").textContent = ""; renderSteps();
    } catch (err) { $("bErr").textContent = "Couldn't upload the picture. " + (err.message || ""); }
  });
  $("bSteps").addEventListener("click", e => {
    const pick = e.target.closest(".spotpick");
    if (pick) {
      const s = B.steps[+pick.dataset.i], r = pick.getBoundingClientRect();
      s.region = { x: +((e.clientX - r.left) / r.width).toFixed(4), y: +((e.clientY - r.top) / r.height).toFixed(4), r: s.region?.r || 0.08 };
      renderSteps(); return;
    }
    const b = e.target.closest("button[data-a]"); if (!b) return;
    const i = +b.dataset.i, s = B.steps[i], a = b.dataset.a;
    if (a === "addopt") s.options.push("");
    if (a === "delopt") { const o = +b.dataset.o; s.options.splice(o, 1); if (s.correct === o) s.correct = 0; else if (s.correct > o) s.correct--; }
    if (a === "up" && i > 0) [B.steps[i - 1], B.steps[i]] = [B.steps[i], B.steps[i - 1]];
    if (a === "down" && i < B.steps.length - 1) [B.steps[i + 1], B.steps[i]] = [B.steps[i], B.steps[i + 1]];
    if (a === "del") B.steps.splice(i, 1);
    renderSteps();
  });

  function shrink(file, max) {
    return new Promise((res, rej) => {
      const img = new Image(); img.onerror = () => rej(new Error("That file isn't a picture."));
      img.onload = () => {
        const sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(b => b ? res({ blob: b, aspect: +(c.width / c.height).toFixed(4) }) : rej(new Error("Couldn't read the picture.")), "image/jpeg", 0.86);
        URL.revokeObjectURL(img.src);
      };
      img.src = URL.createObjectURL(file);
    });
  }

  // Tidy and check what the facilitator typed. Returns [steps, error].
  function clean(kind, steps) {
    const k = KINDS[kind], out = [];
    for (const [n, s0] of steps.entries()) {
      const s = structuredClone(s0), at = steps.length > 1 ? ` (question ${n + 1})` : "";
      s.q = String(s.q || "").trim();
      if (!s.q) return [null, "Type the question" + at + "."];
      if (k.opts) {
        const kept = []; let correct = -1;
        s.options.forEach((o, j) => { o = String(o || "").trim(); if (o) { if (j === s.correct) correct = kept.length; kept.push(o); } });
        if (kept.length < 2) return [null, "Give at least two options" + at + "."];
        s.options = kept;
        if (k.scored) { if (correct < 0) return [null, "Tick the correct answer" + at + "."]; s.correct = correct; } else delete s.correct;
      }
      if (kind === "order" && (s.items || []).length < 3) return [null, "List at least three items" + at + ", one per line."];
      if (kind === "order" && new Set(s.items).size !== s.items.length) return [null, "Each item must be different" + at + "."];
      if (kind === "match" && (s.pairs || []).length < 2) return [null, "Add at least two pairs" + at + ", like: term = meaning."];
      if (kind === "match" && new Set(s.pairs.map(p => p.r)).size !== s.pairs.length) return [null, "Each meaning must be different" + at + "."];
      if (kind === "spot" && !s.image) return [null, "Upload a picture" + at + "."];
      if (kind === "spot" && !s.region) return [null, "Click the picture where the error is" + at + "."];
      if (kind === "case") s.text = String(s.text || "").trim();
      out.push(s);
    }
    if (!out.length) return [null, "Add a question."];
    return [out, null];
  }

  async function saveB() {
    const [steps, err] = clean(B.kind, B.steps);
    if (err) { $("bErr").textContent = err; return null; }
    $("bErr").textContent = "Saving…";
    const title = (B.title || "").trim() || `${KINDS[B.kind].name} · ${new Date().toLocaleDateString([], { day: "numeric", month: "short" })}`;
    const { data, error } = await sb.rpc("save_activity", { p_pin: pin, p_programme: prog.id, p_id: B.id, p_kind: B.kind, p_title: title, p_data: { steps, seconds: B.seconds } });
    if (error) { $("bErr").textContent = dbErr(error, "Couldn't save."); return null; }
    B.id = data.id; B.title = data.title; $("bTitle").value = data.title; $("bDel").hidden = false;
    acts = [data, ...acts.filter(a => a.id !== data.id)];
    $("bErr").textContent = "Saved ✓";
    return data;
  }
  $("bSave").addEventListener("click", saveB);
  $("bLive").addEventListener("click", async () => { const a = await saveB(); if (a) goLive(a); });
  $("bAI").addEventListener("click", () => openAI(B.kind));
  $("bDel").addEventListener("click", async () => {
    if (!B.id) return;
    if ($("bDel").dataset.sure !== "1") { $("bDel").dataset.sure = "1"; $("bDel").textContent = "Tap again to delete (results go too)"; setTimeout(() => { $("bDel").dataset.sure = ""; $("bDel").textContent = "Delete"; }, 4000); return; }
    const { error } = await sb.rpc("delete_activity", { p_pin: pin, p_id: B.id });
    if (error) { $("bErr").textContent = dbErr(error, "Couldn't delete."); return; }
    acts = acts.filter(a => a.id !== B.id); openKind(B.kind);
  });

  // ================= question bank =================
  let bankRows = [];
  async function openBank() {
    show("bank"); $("bankList").innerHTML = `<div class="empty2">Loading…</div>`;
    const { data, error } = await sb.rpc("bank_activities", { p_pin: pin });
    if (error) { $("bankList").innerHTML = `<div class="empty2">${esc(dbErr(error, "Couldn't load the bank."))}</div>`; return; }
    bankRows = data || []; drawBank();
  }
  function drawBank() {
    const q = $("bankQ").value.trim().toLowerCase();
    const list = bankRows.filter(r => !q || (r.title + " " + r.programme + " " + JSON.stringify(r.data)).toLowerCase().includes(q));
    $("bankList").innerHTML = list.length ? list.map(r => {
      const k = KINDS[r.kind] || { ic: "•", name: r.kind }, n = (r.data?.steps || []).length;
      return `<div class="arow" data-id="${esc(r.id)}"><span class="ic">${k.ic}</span><div><b>${esc(r.title || k.name)}</b><small>${esc(k.name)} · ${n} question${n === 1 ? "" : "s"} · ${esc(r.programme)}</small></div><div class="acts"><button class="btn small" data-act="copy" type="button">Copy here</button></div></div>`;
    }).join("") : `<div class="empty2">No activities found.</div>`;
  }
  $("bankQ").addEventListener("input", drawBank);
  $("bankList").addEventListener("click", async e => {
    const b = e.target.closest("button[data-act=copy]"); if (!b) return;
    const r = bankRows.find(x => x.id === b.closest(".arow").dataset.id); if (!r) return;
    b.disabled = true; b.textContent = "Copying…";
    const { data, error } = await sb.rpc("save_activity", { p_pin: pin, p_programme: prog.id, p_id: null, p_kind: r.kind, p_title: r.title, p_data: r.data });
    if (error) { b.textContent = "Couldn't copy"; return; }
    acts = [data, ...acts]; b.textContent = "Copied ✓";
  });

  // ================= AI =================
  const DEFAULT_MODEL = "claude-sonnet-5-5";
  const aiCfg = () => ls.get("assess_ai") || {};
  function drawKey() {
    const c = aiCfg();
    $("keySum").textContent = c.key ? "AI connected on this laptop ✓ (change)" : "Connect AI (one time on this laptop)";
    $("keyBox").open = !c.key; $("aiModel").value = c.model || DEFAULT_MODEL; $("aiKey").value = "";
  }
  $("aiKeySave").addEventListener("click", () => {
    const c = aiCfg(); const key = $("aiKey").value.trim() || c.key;
    if (!key) return ($("aiErr").textContent = "Paste your API key first.");
    ls.set("assess_ai", { key, model: $("aiModel").value.trim() || DEFAULT_MODEL }); $("aiErr").textContent = "Saved."; drawKey();
  });
  $("aiKeyClear").addEventListener("click", () => { ls.set("assess_ai", null); drawKey(); });
  $("aiKind").innerHTML = Object.entries(KINDS).filter(([id, k]) => !k.link && id !== "spot").map(([id, k]) => `<option value="${id}">${k.ic} ${esc(k.name)}</option>`).join("");
  function openAI(kind) { if (KINDS[kind] && !KINDS[kind].link && kind !== "spot") $("aiKind").value = kind; $("aiErr").textContent = ""; drawKey(); show("ai"); $("aiText").focus(); }

  async function askAI(prompt, maxTokens = 4000) {
    const c = aiCfg();
    if (!c.key) throw new Error("Connect AI first: open the AI question writer and paste your Claude API key.");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": c.key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model: c.model || DEFAULT_MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] })
    }).catch(() => { throw new Error("Couldn't reach the AI. Check the internet connection."); });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 401 ? "The AI key was rejected. Check it in the AI question writer." : (j.error && j.error.message) || "The AI request failed (" + r.status + ").");
    const text = (j.content || []).map(x => x.text || "").join("");
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error("The AI reply wasn't in the expected format. Try again.");
    return JSON.parse(text.slice(a, b + 1));
  }

  $("aiGo").addEventListener("click", async () => {
    const kind = $("aiKind").value, k = KINDS[kind], n = +$("aiN").value, text = $("aiText").value.trim();
    if (text.length < 40) return ($("aiErr").textContent = "Paste a bit more material (at least a paragraph).");
    $("aiErr").textContent = "Drafting… this takes a few seconds."; $("aiGo").disabled = true;
    const prompt = `You are helping a facilitator at the Lagos State Public Service Staff Development Centre (PSSDC), Nigeria, build a "${k.name}" activity for civil servants on a training programme.
From the material below, write ${n} item${n > 1 ? "s" : ""}. Difficulty: ${$("aiLevel").value}. Use clear British English and short options${k.scored ? ". Exactly one option is correct; make the wrong options plausible and vary where the correct option sits" : ""}. Base everything on the material; do not invent facts or figures that are not in it.
Return ONLY a JSON object, with no commentary, in this shape:
{"title":"a short title","steps":[${SCHEMA[kind]}]}

Material:
"""
${text.slice(0, 30000)}
"""`;
    try {
      const out = await askAI(prompt);
      const steps = (out.steps || []).map(s => { const x = { ...blankStep(kind), ...s }; if (x.correct != null) x.correct = +x.correct; return x; });
      if (!steps.length) throw new Error("The AI didn't return any questions. Try again.");
      $("aiErr").textContent = "";
      openBuilder(kind, null, { title: out.title || "", steps });
      $("bErr").textContent = "Drafted by AI. Check every question before going live.";
    } catch (err) { $("aiErr").textContent = err.message; }
    finally { $("aiGo").disabled = false; }
  });

  // ================= LIVE STAGE =================
  let L = null;  // { act, kind, steps, run, step, phase, all, rows, deadline, winner, ai, locked, fcounts }
  const step = () => L.act.data.steps[L.step];

  function goLive(act) {
    if (act.kind === "test") {
      $("runDlg").returnValue = ""; $("runDlg").showModal();
      $("runDlg").onclose = () => { const v = $("runDlg").returnValue; if (v) openStage(act, v); };
      return;
    }
    openStage(act, "r" + Date.now().toString(36));
  }

  function openStage(act, run, at = 0) {
    $("stuck").hidden = true;
    L = { act, kind: act.kind, run, step: 0, phase: "open", all: [], rows: [], deadline: 0, winner: null, ai: null, locked: null, fcounts: null, overlay: null };
    $("stage").hidden = false; document.body.style.overflow = "hidden";
    $("sTug").hidden = !KINDS[act.kind].teams || act.kind === "case";
    wakeOn(); poke();
    goStep(at);
  }

  async function goStep(i) {
    if (!L) return;
    const steps = L.act.data.steps; if (i < 0 || i >= steps.length) return;
    L.step = i; L.rows = []; L.winner = null; L.ai = null; L.locked = null; L.fcounts = null; closeOverlay();
    if (L.kind === "finger") fingerStart(); else fingerStop();
    await setPhase("open");
    fetchRows();
  }

  async function setPhase(phase) {
    L.phase = phase;
    const sec = L.kind === "finger" ? 0 : +(L.act.data.seconds || 0);
    L.deadline = phase === "open" && sec > 0 ? Date.now() + sec * 1000 : 0;
    const { error } = await sb.rpc("set_live", { p_pin: pin, p_programme: prog.id, p_activity: L.act.id, p_run: L.run, p_step: L.step, p_phase: phase, p_seconds: sec });
    if (error) toastStage(dbErr(error, "Couldn't update the phones."));
    say("live", { phase, step: L.step });
    render();
  }

  // Main button: open → reveal → next question (→ leaderboard at the end of a scored activity).
  function mainAction() {
    if (!L) return;
    if (L.overlay) { closeOverlay(); if (L.phase === "reveal" && L.overlayThen) { const f = L.overlayThen; L.overlayThen = null; f(); } return; }
    if (L.phase === "open" || L.phase === "closed") {
      if (L.kind === "finger" && !L.locked) lockCount();
      return setPhase("reveal").then(fetchRows);
    }
    if (L.step < L.act.data.steps.length - 1) return goStep(L.step + 1);
    if (SCORED(L.kind)) return showBoard(true);
    endStage();
  }
  function mainLabel() {
    if (!L) return "";
    if (L.overlay) return "Continue";
    if (L.phase === "open" || L.phase === "closed") return SCORED(L.kind) ? "Reveal answer" : L.kind === "finger" ? "Lock and show" : "Show results";
    if (L.step < L.act.data.steps.length - 1) return "Next question ▶";
    return SCORED(L.kind) ? "🏆 Final leaderboard" : "Finish";
  }

  async function endStage() {
    if (!L) return;
    fingerStop(); closeOverlay();
    await sb.rpc("set_live", { p_pin: pin, p_programme: prog.id, p_activity: null, p_run: "", p_step: 0, p_phase: "idle", p_seconds: 0 });
    say("live", { phase: "idle" });
    L = null; $("stage").hidden = true; document.body.style.overflow = "";
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    wakeOff();
  }

  // ---- results for the live step ----
  let fetchTimer = null, fetching = false, again = false;
  function soonFetch() { clearTimeout(fetchTimer); fetchTimer = setTimeout(fetchRows, 350); }
  async function fetchRows() {
    if (!L) return;
    if (fetching) { again = true; return; }
    fetching = true;
    const act = L.act, run = L.run;
    const { data, error } = await sb.rpc("results", { p_pin: pin, p_activity: act.id, p_run: run });
    fetching = false;
    if (again) { again = false; setTimeout(fetchRows, 0); }
    if (!L || L.act !== act || L.run !== run) return;
    if (error) return toastStage(dbErr(error, "Couldn't load answers."));
    L.all = data || []; L.rows = L.all.filter(r => r.step === L.step);
    // First to catch: the first correct answer wins and closes the round.
    if (L.kind === "buzz" && !L.winner && L.phase === "open") {
      const w = L.rows.filter(r => +r.score === 1).sort((a, b) => new Date(a.at) - new Date(b.at))[0];
      if (w) { L.winner = w; say("winner", { name: w.name, step: L.step }); await setPhase("reveal"); showWinner(w); }
    }
    render();
  }
  setInterval(() => { if (L && L.phase === "open" && !document.hidden) fetchRows(); }, 3000);
  // timer
  setInterval(() => {
    if (!L) return;
    const t = $("sTimer");
    if (!L.deadline || L.phase !== "open") { t.classList.remove("on"); return; }
    const sec = +(L.act.data.seconds || 0), left = Math.max(0, L.deadline - Date.now());
    t.classList.add("on"); t.classList.toggle("low", left < 5000);
    t.firstElementChild.style.transform = `scaleX(${left / (sec * 1000)})`;
    $("sStep").textContent = stepLabel() + ` · ${Math.ceil(left / 1000)}s`;
    if (left <= 0) { L.deadline = 0; setPhase("closed").then(fetchRows); tick(880, 0.3); }
  }, 250);
  const stepLabel = () => L.act.data.steps.length > 1 ? `Question ${L.step + 1} of ${L.act.data.steps.length}` : "";

  function updateCount() {
    if (!L) return;
    if (L.kind === "finger") { const n = (L.locked || L.fcounts || []).reduce((a, b) => a + b, 0); $("sCount").textContent = n; $("sCountLbl").textContent = "hands counted"; return; }
    $("sCount").textContent = L.rows.length; $("sCountLbl").textContent = phones ? `of ${phones} answered` : "answered";
  }

  // ---- render the stage ----
  function render() {
    if (!L) return;
    const k = KINDS[L.kind], s = step(), rev = L.phase === "reveal";
    $("sKind").textContent = k.ic + " " + k.name; $("sStep").textContent = stepLabel();
    $("sQ").textContent = s.q;
    $("sSub").textContent = "";
    updateCount();
    $("dMain").textContent = mainLabel();
    $("dPrev").disabled = L.step === 0; $("dNext").disabled = L.step >= L.act.data.steps.length - 1;
    $("dBoard").hidden = !SCORED(L.kind);
    $("dLock").hidden = L.kind !== "finger"; $("dLock").textContent = L.locked ? "🔓 Count again" : "🔒 Lock count";
    $("dAI").hidden = !KINDS[L.kind].text; $("dAI").textContent = L.ai && L.ai.feedback && !L.ai.sent ? "📨 Send AI feedback to phones" : L.ai?.sent ? "✓ Feedback sent" : "✨ AI review";
    // tug of war
    if (!$("sTug").hidden) {
      const t = { A: 0, B: 0 }; L.all.forEach(r => { if (r.grp === "A" || r.grp === "B") t[r.grp] += r.points || 0; });
      $("tugA").textContent = t.A; $("tugB").textContent = t.B;
      $("tugBar").style.width = (t.A + t.B ? 15 + 70 * t.A / (t.A + t.B) : 50) + "%";
    }
    // faces of people who answered (hidden once results show)
    const showFaces = !rev && !["finger", "words", "poll", "scale", "exit", "feedback"].includes(L.kind);
    $("sFaces").innerHTML = showFaces ? L.rows.slice(-60).map(r => `<span class="fc ${r.grp}">${r.photo ? `<img src="${esc(r.photo)}" alt="">` : esc(initials(r.name))}</span>`).join("") : "";
    const v = $("sViz");
    const R = VIZ[L.kind] || VIZ.text;
    R(v, s, L.rows, rev);
  }

  function counts(rows, n) { const c = Array(n).fill(0); rows.forEach(r => { const i = +r.answer?.i; if (i >= 0 && i < n) c[i]++; }); return c; }
  function barsHtml(options, c, { hide = false, correct = null, numLabel = false } = {}) {
    const max = Math.max(1, ...c), total = c.reduce((a, b) => a + b, 0);
    return `<div class="bars${hide ? " hidebars" : ""}">${options.map((o, j) => `<div class="bar${correct != null ? (j === correct ? " right" : " dim") : ""}">
      <span class="let" style="background:${COLORS[j]}">${numLabel ? j + 1 : LETTERS[j]}</span>
      <span class="tr"><span class="fill" style="width:${(c[j] / max) * 100}%;background:${COLORS[j]}"></span><span class="lab">${esc(o)}</span></span>
      <span class="num">${total ? (numLabel ? c[j] : Math.round(c[j] / total * 100) + "%") : "–"}</span></div>`).join("")}</div>`;
  }

  const VIZ = {
    poll(v, s, rows) { v.innerHTML = barsHtml(s.options, counts(rows, s.options.length)); },
    quiz(v, s, rows, rev) {
      v.innerHTML = barsHtml(s.options, counts(rows, s.options.length), { hide: !rev, correct: rev ? s.correct : null });
      if (rev && rows.length) $("sSub").textContent = `${pct(rows.filter(r => +r.score === 1).length / rows.length)}% got it right`;
    },
    battle(v, s, rows, rev) { VIZ.quiz(v, s, rows, rev); },
    test(v, s, rows, rev) { VIZ.quiz(v, s, rows, rev); $("sKind").textContent += L.run === "pre" ? " · Pre-test" : L.run === "post" ? " · Post-test" : ""; },
    buzz(v, s, rows, rev) {
      v.innerHTML = barsHtml(s.options, counts(rows, s.options.length), { hide: !rev, correct: rev ? s.correct : null });
      if (L.winner) $("sSub").textContent = `⚡ ${L.winner.name} caught it first · ${(L.winner.ms / 1000).toFixed(1)}s`;
      else if (rev) $("sSub").textContent = "Nobody caught this one.";
      else $("sSub").textContent = "First correct answer wins!";
    },
    finger(v, s) {
      if (!v.querySelector(".finger")) {
        v.innerHTML = `<div class="finger"><div class="cam"><video id="fVid" playsinline muted></video><canvas id="fCan"></canvas><span class="locked" id="fLocked" hidden>Locked</span><div class="cammsg" id="fMsg">Starting camera…</div></div><div id="fBars"></div></div>`;
        fx.attach();
      }
      $("sSub").innerHTML = "Raise your hand high: " + s.options.map((o, j) => `<span class="fhint" style="display:inline-flex;margin-right:22px"><b style="color:${COLORS[j]}">✋ ${j + 1} finger${j ? "s" : ""}</b>&nbsp;= ${esc(o)}</span>`).join("");
      $("fBars").innerHTML = barsHtml(s.options, L.locked || L.fcounts || Array(s.options.length).fill(0), { numLabel: true });
      $("fLocked").hidden = !L.locked;
    },
    words(v, s, rows) {
      const m = new Map();
      rows.forEach(r => (r.answer?.words || []).forEach(w => { const key = String(w).trim().toLowerCase().replace(/[.!?,;:]+$/, ""); if (key) { const e = m.get(key) || { w: String(w).trim(), n: 0 }; e.n++; m.set(key, e); } }));
      const list = [...m.values()].sort((a, b) => b.n - a.n).slice(0, 60);
      const max = Math.max(1, ...list.map(x => x.n));
      const hash = t => [...t].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
      const shown = [...list].sort((a, b) => hash(a.w) - hash(b.w));
      v.innerHTML = list.length ? `<div class="cloud">${shown.map(x => `<span style="font-size:${Math.round(22 + 98 * Math.sqrt(x.n / max))}px;color:${COLORS[hash(x.w) % COLORS.length]}" title="${x.n}">${esc(x.w)}</span>`).join("")}</div>` : waiting("Words appear here as people answer.");
    },
    scale(v, s, rows) {
      const vals = rows.map(r => +r.answer?.v).filter(x => x >= 0 && x <= 10);
      const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      const h = Array(11).fill(0); vals.forEach(x => h[Math.round(x)]++); const hm = Math.max(1, ...h);
      const ang = Math.PI * (1 - avg / 10), nx = 150 + 110 * Math.cos(ang), ny = 160 - 110 * Math.sin(ang);
      v.innerHTML = `<div class="gauge"><svg viewBox="0 0 300 190" role="img" aria-label="Average ${avg.toFixed(1)} out of 10">
          <defs><linearGradient id="gg" x1="0" x2="1"><stop offset="0" stop-color="#f2786f"/><stop offset=".5" stop-color="#e8b44a"/><stop offset="1" stop-color="#3fb98a"/></linearGradient></defs>
          <path d="M30 160 A120 120 0 0 1 270 160" fill="none" stroke="url(#gg)" stroke-width="24" stroke-linecap="round"/>
          <line x1="150" y1="160" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="#eef4ef" stroke-width="6" stroke-linecap="round" style="transition:all .8s"/>
          <circle cx="150" cy="160" r="10" fill="#eef4ef"/>
        </svg>
        <div class="gside"><div class="gnum">${vals.length ? avg.toFixed(1) : "–"}<small>average out of 10</small></div>
        <div class="hist">${h.map((n, i) => `<div><i style="height:${n ? Math.max(4, (n / hm) * 26) : 0.4}vh"></i><small>${i}</small></div>`).join("")}</div>
        <div class="glab"><span>0 · ${esc(s.lo || "")}</span><span>${esc(s.hi || "")} · 10</span></div></div></div>`;
    },
    order(v, s, rows, rev) {
      if (!rev) { v.innerHTML = waiting(`${rows.length} answered. Reveal to see the right order.`); return; }
      const full = rows.filter(r => +r.score === 1).length;
      $("sSub").textContent = rows.length ? `${pct(full / rows.length)}% got the whole order right` : "";
      v.innerHTML = `<div class="olist">${s.items.map((it, i) => { const ok = rows.filter(r => r.answer?.items?.[i] === it).length; return `<div style="animation-delay:${i * 0.12}s"><b>${i + 1}</b><span>${esc(it)}</span><small>${rows.length ? pct(ok / rows.length) + "% placed right" : ""}</small></div>`; }).join("")}</div>`;
    },
    match(v, s, rows, rev) {
      if (!rev) { v.innerHTML = waiting(`${rows.length} answered. Reveal to see the pairs.`); return; }
      const full = rows.filter(r => +r.score === 1).length;
      $("sSub").textContent = rows.length ? `${pct(full / rows.length)}% matched them all` : "";
      v.innerHTML = `<div class="olist">${s.pairs.map((p, i) => { const ok = rows.filter(r => r.answer?.rights?.[i] === p.r).length; return `<div style="animation-delay:${i * 0.12}s"><b>${LETTERS[i] || i + 1}</b><span>${esc(p.l)} → ${esc(p.r)}</span><small>${rows.length ? pct(ok / rows.length) + "% right" : ""}</small></div>`; }).join("")}</div>`;
    },
    spot(v, s, rows, rev) {
      const dots = rev ? rows.map(r => `<span class="dot${+r.score === 1 ? " hit" : ""}" style="left:${(+r.answer?.x || 0) * 100}%;top:${(+r.answer?.y || 0) * 100}%"></span>`).join("") : "";
      const ring = rev && s.region ? `<span class="ring" style="left:${s.region.x * 100}%;top:${s.region.y * 100}%;width:${s.region.r * 2 / s.aspect * 100}%;aspect-ratio:1"></span>` : "";
      v.innerHTML = `<div class="spotview"><div class="wrapimg" style="--ar:${s.aspect || 1.5}"><img src="${esc(s.image)}" alt="">${dots}${ring}</div></div>`;
      if (rev && rows.length) $("sSub").textContent = `${pct(rows.filter(r => +r.score === 1).length / rows.length)}% found it`;
      else $("sSub").textContent = `${rows.length} tapped`;
    },
    text(v, s, rows, rev) {
      const live = L.kind === "exit" || rev;
      const ai = L.ai ? `<div class="aibox"><b>✨ AI summary.</b> ${esc(L.ai.summary || "")}${(L.ai.themes || []).length ? `<br><small>${L.ai.themes.map(t => esc(t.theme) + (t.count ? ` (${t.count})` : "")).join(" · ")}</small>` : ""}</div>` : "";
      const card = r => `<div class="tc ${r.grp}${L.ai?.best?.includes(r.id) ? " best" : ""}">${esc(r.answer?.text)}<small>${esc(r.name || "Anonymous")}${r.grp !== "all" ? " · Group " + r.grp : ""}</small>${L.ai?.feedback?.[r.id] ? `<span class="fb">✨ ${esc(L.ai.feedback[r.id])}</span>` : ""}</div>`;
      let html = "";
      if (L.kind === "case" && s.text && !rev) html += `<div class="casebox">${esc(s.text)}</div>`;
      if (!live) html += waiting(`${rows.length} answer${rows.length === 1 ? "" : "s"} in. Show results to read them.`);
      else if (L.kind === "case") {
        const groups = ["A", "B", "all"].filter(g => rows.some(r => r.grp === g));
        const firsts = groups.filter(g => g !== "all").map(g => ({ g, r: rows.filter(r => r.grp === g).sort((a, b) => a.ms - b.ms)[0] })).filter(x => x.r).sort((a, b) => a.r.ms - b.r.ms);
        if (firsts.length) $("sSub").textContent = `🏁 Group ${firsts[0].g} answered first (${fmtMs(firsts[0].r.ms)})`;
        html += ai + (rows.length ? `<div class="teamcols" style="grid-template-columns:repeat(${groups.length},1fr)">${groups.map(g => `<div><h3>${g === "all" ? "No group" : "Group " + g}</h3><div class="cards" style="columns:1">${rows.filter(r => r.grp === g).map(card).join("")}</div></div>`).join("")}</div>` : waiting("No answers yet."));
      } else html += ai + (rows.length ? `<div class="cards">${rows.slice().reverse().map(card).join("")}</div>` : waiting("Answers appear here as people send them."));
      v.innerHTML = html;
    },
    feedback(v, s, rows) {
      const st = rows.map(r => +r.answer?.stars).filter(x => x >= 1 && x <= 5);
      const avg = st.length ? st.reduce((a, b) => a + b, 0) / st.length : 0;
      const h = [1, 2, 3, 4, 5].map(n => st.filter(x => x === n).length);
      const comments = rows.filter(r => (r.answer?.text || "").trim());
      v.innerHTML = `<div class="starbig"><div class="avg">${st.length ? avg.toFixed(1) : "–"}<small>OUT OF 5 · ${st.length} RATING${st.length === 1 ? "" : "S"}</small></div>
        <div style="flex:1;min-width:0">${barsHtml(["★", "★★", "★★★", "★★★★", "★★★★★"], h, { numLabel: true })}</div></div>
        ${comments.length ? `<div class="cards" style="flex:none;max-height:28vh">${comments.slice(-12).reverse().map(r => `<div class="tc">${esc(r.answer.text)}<small>${"★".repeat(+r.answer.stars || 0)} · ${esc(r.name || "Anonymous")}</small></div>`).join("")}</div>` : ""}`;
    }
  };
  VIZ.exit = VIZ.text; VIZ.case = VIZ.text;
  const waiting = t => `<div class="empty2" style="border-color:var(--stage-line);color:var(--stage-muted);margin:auto;font-size:clamp(16px,1.6vw,24px)">${esc(t)}</div>`;
  const fmtMs = ms => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : s + "s"; };

  // ---- overlays: leaderboard, winner ----
  function totals() {
    const m = new Map();
    L.all.forEach(r => { const e = m.get(r.device) || { name: r.name, photo: r.photo, grp: r.grp, points: 0, right: 0 }; e.points += r.points || 0; e.right += +r.score === 1 ? 1 : 0; if (r.photo) e.photo = r.photo; m.set(r.device, e); });
    return [...m.values()].sort((a, b) => b.points - a.points);
  }
  const face = (p, cls = "ph") => `<span class="${cls}">${p.photo ? `<img src="${esc(p.photo)}" alt="">` : esc(initials(p.name))}</span>`;
  function showBoard(final) {
    const t = totals(), top = t.slice(0, 3), rest = t.slice(3, 11);
    let head = `<h2>${final ? "🏆 Final leaderboard" : "🏆 Leaderboard"}</h2>`;
    if (KINDS[L.kind].teams) {
      const g = { A: 0, B: 0 }; L.all.forEach(r => { if (g[r.grp] != null) g[r.grp] += r.points || 0; });
      const lead = g.A === g.B ? "It's a draw!" : (g.A > g.B ? "Group A" : "Group B") + " wins!";
      head = `<div class="teamwin">${final ? lead : "Group A " + g.A + " · " + g.B + " Group B"}</div>` + (final ? `<p style="color:var(--stage-muted);font-size:22px;margin:0">Group A ${g.A} · ${g.B} Group B</p>` : "") + `<h2 style="font-size:28px">Top players</h2>`;
    }
    const order = [top[1], top[0], top[2]].map((p, i) => p ? `<div class="pod p${[2, 1, 3][i]}" style="animation-delay:${[0.4, 0.9, 0][i]}s"><span class="rk">${[2, 1, 3][i]}</span>${face(p)}<b>${esc(firstName(p.name))}</b><span>${p.points} pts</span></div>` : "").join("");
    overlay(`<div class="board">${head}${t.length ? `<div class="podium">${order}</div>${rest.length ? `<div class="rest">${rest.map((p, i) => `<div><b>${i + 4}</b>${p.photo ? `<img src="${esc(p.photo)}" alt="">` : `<span class="ini">${esc(initials(p.name))}</span>`}<span>${esc(p.name)}</span><b>${p.points}</b></div>`).join("")}</div>` : ""}` : `<p style="color:var(--stage-muted)">No answers yet.</p>`}</div>`);
    fanfare();
    if (final) L.overlayThen = endStage;
  }
  function showWinner(w) {
    overlay(`<div class="winner"><div class="bolt">⚡ Caught it first</div>${face(w)}<h2>${esc(w.name || "Someone")}</h2><p>${esc(w.mda || "")}${w.mda ? " · " : ""}${(w.ms / 1000).toFixed(1)} seconds</p></div>`);
    fanfare();
  }
  function overlay(html) { L.overlay = true; $("sOver").innerHTML = html; $("sOver").hidden = false; $("dMain").textContent = mainLabel(); }
  function closeOverlay() { if (L) L.overlay = null; $("sOver").hidden = true; $("sOver").innerHTML = ""; if (L) $("dMain").textContent = mainLabel(); }
  $("sOver").addEventListener("click", () => mainAction());

  let stT = null;
  function toastStage(t) { $("sSub").textContent = t; clearTimeout(stT); }

  // ---- AI review of written answers ----
  async function aiReview() {
    if (!L) return;
    if (L.ai && L.ai.feedback && !L.ai.sent) return sendAIFeedback();
    const rows = L.rows.filter(r => (r.answer?.text || "").trim());
    if (!rows.length) return toastStage("No written answers to review yet.");
    $("dAI").textContent = "✨ Reviewing…"; $("dAI").disabled = true;
    const s = step();
    const prompt = `You are helping a facilitator at the Lagos State Public Service Staff Development Centre (PSSDC), Nigeria. Participants (civil servants) answered this ${L.kind === "case" ? "case study" : "reflection prompt"}.
Task: ${s.q}
${s.text ? "Case:\n" + s.text + "\n" : ""}
Answers (id | group | text):
${rows.map(r => `${r.id} | ${r.grp === "all" ? "-" : r.grp} | ${String(r.answer.text).replace(/\s+/g, " ").slice(0, 800)}`).join("\n")}

Return ONLY JSON: {"summary":"2 or 3 sentences on what the room said, for the projector","themes":[{"theme":"short theme","count":number}],"best":["up to 3 ids of the strongest answers"],"feedback":{"<id>":"one specific, encouraging sentence of feedback for that person (max 30 words)"}}`;
    try {
      L.ai = await askAI(prompt, 6000); L.ai.sent = false;
      if (L.phase !== "reveal") await setPhase("reveal");
      render();
    } catch (err) { toastStage(err.message); }
    finally { $("dAI").disabled = false; render(); }
  }
  async function sendAIFeedback() {
    const ids = Object.keys(L.ai.feedback || {}).filter(id => L.rows.some(r => r.id === id));
    $("dAI").textContent = "📨 Sending…";
    for (const id of ids) await sb.rpc("set_response_feedback", { p_pin: pin, p_response: id, p_text: L.ai.feedback[id] });
    L.ai.sent = true; say("feedback", {}); render();
  }

  // ---- finger vote (webcam counts raised fingers on every hand it sees) ----
  const fx = { stream: null, lm: null, raf: 0, hist: [], on: false, attach() {} };
  const FMODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
  function fingersUp(p) {
    const d = (a, b) => Math.hypot(p[a].x - p[b].x, p[a].y - p[b].y);
    let n = 0;
    for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) if (d(0, tip) > d(0, pip) * 1.12) n++;
    if (d(4, 17) > d(2, 17) * 1.22 && d(4, 5) > d(3, 5)) n++;   // thumb out, away from the palm
    return n;
  }
  async function fingerStart() {
    fx.on = true;
    if (fx.stream) return;
    fx.attach = async () => {
      const v = $("fVid"); if (!v || !fx.stream) return;
      v.srcObject = fx.stream; try { await v.play(); } catch {}
      loopF();
    };
    try {
      fx.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (err) {
      fx.stream = null; const m = $("fMsg");
      if (m) m.textContent = err.name === "NotReadableError" ? "Camera busy: close other apps or tabs using it (e.g. AirSwipe.exe)." : "Camera blocked. Allow the camera for this site, then go to this question again.";
      return;
    }
    if (!fx.lm) {
      try {
        const { FilesetResolver, HandLandmarker } = await import("../slides/vendor/vision_bundle.mjs");
        const fs = await FilesetResolver.forVisionTasks(new URL("../slides/vendor/mediapipe-wasm", location.href).href);
        const opts = d => ({ baseOptions: { modelAssetPath: FMODEL, delegate: d }, runningMode: "VIDEO", numHands: 16, minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4 });
        try { fx.lm = await HandLandmarker.createFromOptions(fs, opts("GPU")); } catch { fx.lm = await HandLandmarker.createFromOptions(fs, opts("CPU")); }
      } catch { const m = $("fMsg"); if (m) m.textContent = "Couldn't load hand tracking. Check the internet connection."; return; }
    }
    fx.attach();
  }
  let lastTs = 0;
  function loopF() {
    cancelAnimationFrame(fx.raf);
    const v = $("fVid"), c = $("fCan");
    if (!fx.on || !fx.stream || !fx.lm || !v || !c || !L || L.kind !== "finger") return;
    const frame = () => {
      if (!fx.on || !L || L.kind !== "finger" || !document.body.contains(v)) return;
      fx.raf = requestAnimationFrame(frame);
      if (v.readyState < 2 || L.locked) return;
      const now = performance.now(); if (now - lastTs < 90) return; lastTs = now;
      const res = fx.lm.detectForVideo(v, now);
      const n = step().options.length, cnt = Array(n).fill(0);
      c.width = v.videoWidth; c.height = v.videoHeight;
      const g = c.getContext("2d"); g.clearRect(0, 0, c.width, c.height);
      (res.landmarks || []).forEach(p => {
        const k = fingersUp(p);
        if (k >= 1 && k <= n) cnt[k - 1]++;
        const col = k >= 1 && k <= n ? COLORS[k - 1] : "#8fa69b";
        g.fillStyle = col; p.forEach(q => { g.beginPath(); g.arc(q.x * c.width, q.y * c.height, 4, 0, 7); g.fill(); });
        const w = p[9]; g.font = "bold 44px Bricolage Grotesque, sans-serif"; g.textAlign = "center";
        g.save(); g.translate(w.x * c.width, w.y * c.height - 60); g.scale(-1, 1); g.fillStyle = col; g.fillText(String(k), 0, 0); g.restore();
      });
      fx.hist.push(cnt); if (fx.hist.length > 12) fx.hist.shift();
      L.fcounts = cnt.map((_, j) => { const a = fx.hist.map(h => h[j]).sort((x, y) => x - y); return a[Math.floor(a.length * 0.6)] || 0; });
      const m = $("fMsg"); if (m) m.textContent = (res.landmarks || []).length ? `${res.landmarks.length} hand${res.landmarks.length > 1 ? "s" : ""} in view. Hold them up high and still.` : "Waiting for hands… hold them up facing the camera.";
      $("fBars").innerHTML = barsHtml(step().options, L.fcounts, { numLabel: true }); updateCount();
    };
    frame();
  }
  function fingerStop() { fx.on = false; cancelAnimationFrame(fx.raf); fx.hist = []; if (fx.stream) { fx.stream.getTracks().forEach(t => t.stop()); fx.stream = null; } }
  async function lockCount() {
    if (!L || L.kind !== "finger") return;
    if (L.locked) { L.locked = null; fx.hist = []; render(); return; }
    L.locked = (L.fcounts || Array(step().options.length).fill(0)).slice();
    await sb.rpc("save_tally", { p_pin: pin, p_activity: L.act.id, p_run: L.run, p_step: L.step, p_counts: L.locked });
    tick(660, 0.25); render();
  }
  document.addEventListener("visibilitychange", () => {
    if (!L || L.kind !== "finger") return;
    if (document.hidden) { const keep = fx.on; fingerStop(); fx.on = keep; }
    else if (fx.on && !fx.stream) { fingerStart(); }
  });

  // ---- controls ----
  $("dMain").addEventListener("click", mainAction);
  $("dPrev").addEventListener("click", () => L && goStep(L.step - 1));
  $("dNext").addEventListener("click", () => L && goStep(L.step + 1));
  $("dBoard").addEventListener("click", () => { if (!L) return; if (L.overlay) closeOverlay(); else showBoard(false); });
  $("dLock").addEventListener("click", lockCount);
  $("dAI").addEventListener("click", aiReview);
  $("dFs").addEventListener("click", fs);
  $("dEnd").addEventListener("click", endStage);
  function fs() { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else $("stage").requestFullscreen?.().catch(() => {}); }
  document.addEventListener("keydown", e => {
    if (!L || $("stage").hidden || e.target.closest("input,textarea,select")) return;
    if (e.key === " " || e.key === "Enter" || e.key === "PageDown") { e.preventDefault(); mainAction(); }
    else if (e.key === "ArrowRight") goStep(L.step + 1);
    else if (e.key === "ArrowLeft" || e.key === "PageUp") goStep(L.step - 1);
    else if (e.key === "l" || e.key === "L") { if (SCORED(L.kind)) { if (L.overlay) closeOverlay(); else showBoard(false); } }
    else if (e.key === "f" || e.key === "F") fs();
    else if (e.key === "Escape" && !document.fullscreenElement) { if (L.overlay) closeOverlay(); else endStage(); }
    poke();
  });
  let idleT = null;
  function poke() { $("dock").classList.remove("idle"); clearTimeout(idleT); idleT = setTimeout(() => $("dock").classList.add("idle"), 3500); }
  $("stage").addEventListener("mousemove", poke);

  // ---- sound ----
  let actx = null;
  const ac = () => { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === "suspended") actx.resume(); } catch {} return actx; };
  function tick(f, len) { const a = ac(); if (!a) return; const o = a.createOscillator(), g = a.createGain(), t = a.currentTime; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + len); o.connect(g).connect(a.destination); o.start(t); o.stop(t + len); }
  function fanfare() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tick(f, 0.35), i * 120)); }
  document.addEventListener("pointerdown", ac, { once: true });

  let wake = null;
  async function wakeOn() { try { wake = await navigator.wakeLock?.request("screen"); } catch {} }
  function wakeOff() { try { wake?.release(); } catch {} wake = null; }

  // ================= RESULTS =================
  let RES = null;
  async function openResults() {
    show("results"); $("rTable").innerHTML = ""; $("rMore").innerHTML = `<div class="empty2">Loading…</div>`; $("rStats").innerHTML = "";
    await loadActs();
    const [{ data, error }, ck] = await Promise.all([
      sb.rpc("programme_results", { p_pin: pin, p_programme: prog.id }),
      sb.from("checkins").select("id,title,name,mda,arrived_at,tap_out_at").eq("programme_id", prog.id).order("arrived_at")
    ]);
    if (error) { $("rMore").innerHTML = `<div class="empty2">${esc(dbErr(error, "Couldn't load results."))}</div>`; return; }
    RES = buildResults(data, ck.data || []); drawResults();
  }
  $("rRefresh").addEventListener("click", openResults);

  function buildResults(data, checkins) {
    const actMap = new Map(acts.map(a => [a.id, a]));
    const ckMap = new Map(checkins.map(c => [c.id, c]));
    const people = new Map();
    const person = r => {
      const key = r.checkin || r.device;
      if (!people.has(key)) { const c = ckMap.get(r.checkin); people.set(key, { key, name: c ? (c.title ? c.title + " " : "") + c.name : r.name || "Anonymous", mda: c?.mda || "", cols: {}, points: 0 }); }
      return people.get(key);
    };
    checkins.forEach(c => people.set(c.id, { key: c.id, name: (c.title ? c.title + " " : "") + c.name, mda: c.mda, cols: {}, points: 0 }));
    const cols = new Map(), tests = new Map(), groups = new Map();
    for (const r of data.responses || []) {
      const a = actMap.get(r.activity); if (!a) continue;
      const gk = r.activity + "|" + r.run;
      if (!groups.has(gk)) groups.set(gk, { a, run: r.run, rows: [], at: r.at });
      groups.get(gk).rows.push(r);
      if (!SCORED(a.kind)) continue;
      const p = person(r); p.points += r.points || 0;
      if (a.kind === "test" && (r.run === "pre" || r.run === "post")) {
        if (!tests.has(a.id)) tests.set(a.id, a);
        const k = "test|" + a.id + "|" + r.run; p.cols[k] = (p.cols[k] || 0) + (+r.score || 0);
        continue;
      }
      if (!cols.has(gk)) cols.set(gk, { key: gk, a, run: r.run, at: r.at });
      p.cols[gk] = (p.cols[gk] || 0) + (+r.score || 0);
    }
    return { people: [...people.values()], cols: [...cols.values()].sort((x, y) => new Date(x.at) - new Date(y.at)), tests: [...tests.values()], groups: [...groups.values()].sort((x, y) => new Date(x.at) - new Date(y.at)), tallies: data.tallies || [], feedback: data.feedback || [], actMap };
  }
  const nSteps = a => Math.max(1, (a.data?.steps || []).length);
  const colLabel = c => `${c.a.title}${RES.cols.filter(x => x.a.id === c.a.id).length > 1 ? " · " + new Date(c.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}`;
  function tableRows() {
    const head = ["#", "Name", "MDA", ...RES.cols.map(colLabel).map(t => t + " %"), ...RES.tests.flatMap(t => [t.title + " pre %", t.title + " post %", t.title + " gain"]), "Total points"];
    const body = RES.people.map((p, i) => {
      const cells = RES.cols.map(c => p.cols[c.key] != null ? pct(p.cols[c.key] / nSteps(c.a)) : "");
      const tc = RES.tests.flatMap(t => {
        const pre = p.cols["test|" + t.id + "|pre"], post = p.cols["test|" + t.id + "|post"];
        const a = pre != null ? pct(pre / nSteps(t)) : "", b = post != null ? pct(post / nSteps(t)) : "";
        return [a, b, a !== "" && b !== "" ? b - a : ""];
      });
      return [i + 1, p.name, p.mda, ...cells, ...tc, p.points];
    });
    return { head, body };
  }
  function drawResults() {
    const { head, body } = tableRows();
    const answered = RES.people.filter(p => p.points || Object.keys(p.cols).length).length;
    const fb = RES.feedback.map(f => f.stars), fbAvg = fb.length ? (fb.reduce((a, b) => a + b, 0) / fb.length).toFixed(1) : "–";
    const gains = RES.tests.flatMap(t => RES.people.map(p => { const a = p.cols["test|" + t.id + "|pre"], b = p.cols["test|" + t.id + "|post"]; return a != null && b != null ? pct(b / nSteps(t)) - pct(a / nSteps(t)) : null; }).filter(x => x != null));
    $("rStats").innerHTML = `<div class="stat"><b>${RES.people.length}</b><small>people</small></div><div class="stat"><b>${answered}</b><small>took a scored activity</small></div><div class="stat"><b>${RES.groups.length}</b><small>activities run</small></div>
      <div class="stat"><b>${gains.length ? (gains.reduce((a, b) => a + b, 0) / gains.length > 0 ? "+" : "") + Math.round(gains.reduce((a, b) => a + b, 0) / gains.length) + "%" : "–"}</b><small>average learning gain</small></div><div class="stat"><b>${fbAvg}</b><small>tap-out rating (${fb.length})</small></div>`;
    $("rTable").innerHTML = `<thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${body.map(r => `<tr>${r.map((c, j) => {
      const isGain = head[j].endsWith(" gain") && c !== "";
      return `<td class="${j === 0 || j > 2 ? "n" : ""}${isGain ? (c > 0 ? " gain" : c < 0 ? " loss" : "") : ""}">${esc(isGain && c > 0 ? "+" + c : c)}</td>`;
    }).join("")}</tr>`).join("")}</tbody>`;
    if (!body.length) $("rTable").innerHTML = `<tbody><tr><td class="muted">No one has checked in or answered yet.</td></tr></tbody>`;
    // Opinion activities and written answers, one closed card each.
    const more = RES.groups.map(g => {
      const a = g.a, k = KINDS[a.kind] || { ic: "", name: a.kind };
      const when = new Date(g.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      const parts = (a.data.steps || []).map((s, i) => {
        const rows = g.rows.filter(r => r.step === i);
        let inner = "";
        if (k.opts && a.kind !== "finger") { const c = counts(rows, s.options.length); inner = s.options.map((o, j) => `${LETTERS[j]}. ${esc(o)}: <b>${c[j]}</b>${k.scored && j === s.correct ? " ✓" : ""}`).join("<br>"); }
        else if (a.kind === "finger") { const t = RES.tallies.find(t => t.activity_id === a.id && t.run === g.run && t.step === i); inner = t ? s.options.map((o, j) => `${j + 1}. ${esc(o)}: <b>${t.counts[j] || 0}</b> hands`).join("<br>") : "Count not locked."; }
        else if (a.kind === "words") { const m = {}; rows.forEach(r => (r.answer?.words || []).forEach(w => { w = String(w).trim().toLowerCase(); if (w) m[w] = (m[w] || 0) + 1; })); inner = Object.entries(m).sort((x, y) => y[1] - x[1]).slice(0, 25).map(([w, n]) => `${esc(w)} (${n})`).join(", ") || "—"; }
        else if (a.kind === "scale") { const v = rows.map(r => +r.answer?.v); inner = v.length ? `Average <b>${(v.reduce((x, y) => x + y, 0) / v.length).toFixed(1)}</b> / 10 from ${v.length}` : "—"; }
        else if (a.kind === "feedback") { const v = rows.map(r => +r.answer?.stars).filter(Boolean); inner = (v.length ? `Average <b>${(v.reduce((x, y) => x + y, 0) / v.length).toFixed(1)}</b> ★ from ${v.length}<br>` : "") + rows.filter(r => r.answer?.text).map(r => `<div class="quote">${esc(r.answer.text)}<small>${esc(r.name)} · ${"★".repeat(+r.answer.stars || 0)}</small></div>`).join(""); }
        else if (k.text) inner = rows.map(r => `<div class="quote">${esc(r.answer?.text)}<small>${esc(r.name)}${r.grp !== "all" ? " · Group " + r.grp : ""}${r.feedback ? " · ✨ " + esc(r.feedback) : ""}</small></div>`).join("") || "—";
        else inner = `${rows.length} answered · ${rows.length ? pct(rows.reduce((x, r) => x + (+r.score || 0), 0) / rows.length) : 0}% average`;
        return `<div><b>${esc(s.q)}</b><div class="muted small" style="margin-top:4px">${inner}</div></div>`;
      }).join("");
      return `<details class="res"><summary>${k.ic} ${esc(a.title)} <span class="muted small">· ${esc(k.name)}${g.run === "pre" ? " · Pre-test" : g.run === "post" ? " · Post-test" : ""} · ${when} · ${new Set(g.rows.map(r => r.device)).size} people</span></summary><div class="body">${parts}</div></details>`;
    });
    if (RES.feedback.length) more.push(`<details class="res"><summary>⭐ Tap-out feedback <span class="muted small">· ${RES.feedback.length} · average ${fbAvg} ★</span></summary><div class="body">${RES.feedback.map(f => `<div class="quote">${"★".repeat(f.stars)}${f.comment ? " " + esc(f.comment) : ""}<small>${esc((f.title ? f.title + " " : "") + f.name)} · ${esc(f.mda)}</small></div>`).join("")}</div></details>`);
    $("rMore").innerHTML = more.join("") || `<div class="empty2">No activities have been run yet.</div>`;
  }
  $("rCsv").addEventListener("click", () => {
    if (!RES) return;
    const { head, body } = tableRows();
    const csv = "﻿" + [head, ...body].map(r => r.map(c => { const s = String(c ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(",")).join("\r\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `${(prog.programme_code || prog.name).replace(/[^\w-]+/g, "_")}_assessment_results.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  boot();
})();
