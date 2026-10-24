// Tap-In: a Back button and a Home link on every facilitator page.
// <script src="../nav.js" data-home="../"></script>  · data-autohide: hidden until the mouse moves (projector and kiosk screens)
// · data-spa: the main page, where "home" is #home and the bar hides on the home screen.
(() => {
  "use strict";
  const me = document.currentScript, home = me.dataset.home || "../", spa = me.hasAttribute("data-spa");
  const css = document.createElement("style");
  css.textContent = `.tnav{position:fixed;top:max(10px,env(safe-area-inset-top));left:max(10px,env(safe-area-inset-left));z-index:9999;display:flex;gap:6px;font-family:"Figtree",ui-sans-serif,system-ui,sans-serif;transition:opacity .3s}
  .tnav a,.tnav button{display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(0,0,0,.12);background:rgba(255,255,255,.94);color:#14161c;border-radius:999px;padding:8px 14px;font:600 14px/1 inherit;font-family:inherit;text-decoration:none;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.12);backdrop-filter:blur(6px)}
  .tnav a:hover,.tnav button:hover{background:#fff;border-color:#14161c}
  .tnav.dim{opacity:0;pointer-events:none}
  @media print{.tnav{display:none}}
  @media (max-width:700px){body.has-tnav{padding-top:52px}}`;
  document.head.appendChild(css);
  const nav = document.createElement("nav");
  nav.className = "tnav"; nav.setAttribute("aria-label", "Page");
  nav.innerHTML = `<button type="button" id="tnavBack">← Back</button><a href="${home}${spa ? "#home" : ""}" id="tnavHome">Tap-In home</a>`;
  const sameSiteReferrer = () => { try { return document.referrer && new URL(document.referrer).origin === location.origin; } catch { return false; } };
  let inAppSteps = 0;   // hash changes inside this page
  addEventListener("hashchange", () => { inAppSteps++; sync(); });
  nav.querySelector("#tnavBack").addEventListener("click", () => {
    if (inAppSteps > 0 || (history.length > 1 && sameSiteReferrer())) history.back();
    else location.href = home + (spa ? "#home" : "");
  });
  // On screens shown to the room (welcome screen, kiosk, slides), keep it out of sight until the mouse moves.
  const autohide = () => me.hasAttribute("data-autohide") || (spa && /^#(kiosk|display|qr)\//.test(location.hash));
  let t = null;
  function wake() { nav.classList.remove("dim"); clearTimeout(t); if (autohide()) t = setTimeout(() => nav.classList.add("dim"), 2500); }
  addEventListener("pointermove", e => { if (e.pointerType === "mouse") wake(); });
  function sync() {
    const h = location.hash.replace(/^#/, "");
    nav.hidden = spa && (!h || h === "home");
    if (autohide()) nav.classList.add("dim"); else nav.classList.remove("dim");
  }
  const mount = () => { document.body.appendChild(nav); if (!me.hasAttribute("data-autohide") && !spa) document.body.classList.add("has-tnav"); sync(); };
  if (document.body) mount(); else addEventListener("DOMContentLoaded", mount);
})();
