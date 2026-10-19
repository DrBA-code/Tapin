// Contact-card helpers shared by the room (participant) and throw (facilitator) pages.
// Builds .vcf files that phones import straight into Contacts, and turns handles into follow links.
(function () {
  "use strict";
  const clean = s => String(s || "").trim();
  const handle = s => clean(s).replace(/^@/, "").replace(/\s+/g, "");
  const isUrl = s => /^https?:\/\//i.test(clean(s));
  const withHttps = s => (isUrl(s) ? clean(s) : "https://" + clean(s).replace(/^\/+/, ""));
  // Nigerian numbers: 0803… -> 234803… for WhatsApp links.
  const intlDigits = s => { let d = clean(s).replace(/[^\d+]/g, "").replace(/^\+/, ""); if (/^0\d{10}$/.test(d)) d = "234" + d.slice(1); return d; };

  function socialLinks(c) {
    const out = [];
    const add = (label, v, base) => { if (clean(v)) out.push({ label, url: isUrl(v) ? clean(v) : base + handle(v) }); };
    add("LinkedIn", c.linkedin, "https://www.linkedin.com/in/");
    add("X", c.x, "https://x.com/");
    add("Instagram", c.instagram, "https://instagram.com/");
    add("Facebook", c.facebook, "https://facebook.com/");
    add("TikTok", c.tiktok, "https://www.tiktok.com/@");
    add("YouTube", c.youtube, "https://www.youtube.com/@");
    if (clean(c.whatsapp)) out.push({ label: "WhatsApp", url: "https://wa.me/" + intlDigits(c.whatsapp) });
    if (clean(c.website)) out.push({ label: "Website", url: withHttps(c.website) });
    return out;
  }

  const esc = s => clean(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");

  // c: { name, title?, role?, org?, phone?, whatsapp?, email?, website?, linkedin?, x?, instagram?, facebook?, note? }
  function build(c) {
    const full = [clean(c.title), clean(c.name)].filter(Boolean).join(" ");
    const parts = clean(c.name).split(/\s+/);
    const last = parts.length > 1 ? parts.pop() : "", first = parts.join(" ");
    const L = ["BEGIN:VCARD", "VERSION:3.0",
      `N:${esc(last)};${esc(first)};;${esc(c.title)};`, `FN:${esc(full || c.name)}`];
    if (clean(c.org)) L.push(`ORG:${esc(c.org)}`);
    if (clean(c.role)) L.push(`TITLE:${esc(c.role)}`);
    if (clean(c.phone)) L.push(`TEL;TYPE=CELL:${clean(c.phone)}`);
    if (clean(c.whatsapp) && clean(c.whatsapp) !== clean(c.phone)) L.push(`TEL;TYPE=CELL,WhatsApp:${clean(c.whatsapp)}`);
    if (clean(c.email)) L.push(`EMAIL;TYPE=INTERNET:${clean(c.email)}`);
    socialLinks(c).forEach(l => {
      L.push(`URL;TYPE=${l.label}:${l.url}`);
      if (l.label !== "Website" && l.label !== "WhatsApp") L.push(`X-SOCIALPROFILE;TYPE=${l.label.toLowerCase()}:${l.url}`);
    });
    if (clean(c.note)) L.push(`NOTE:${esc(c.note)}`);
    L.push("END:VCARD");
    return L.join("\r\n") + "\r\n";
  }

  const initials = n => clean(n).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";
  const fileName = n => (clean(n) || "contact").replace(/[\\/:*?"<>|]+/g, " ").slice(0, 60) + ".vcf";

  function download(name, text) {
    const blob = new Blob([text], { type: "text/vcard;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  window.VCard = { build, socialLinks, initials, fileName, download, intlDigits };
})();
