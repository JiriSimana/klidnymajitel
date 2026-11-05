// Odeslání poptávky z webu přes Resend (https://resend.com)
// Vyžaduje env proměnné ve Vercelu:
//   RESEND_API_KEY  – API klíč Resend (povinné)
//   LEAD_TO         – kam poptávky chodí (výchozí info@klidnymajitel.cz)
//   LEAD_FROM       – odesílatel; doména musí být ověřená v Resend
//                     (výchozí "Klidný majitel <poptavky@info.klidnymajitel.cz>")
// Volitelné — Meta Conversions API (server-side konverze):
//   FB_PIXEL_ID           – ID datasetu/pixelu z Events Manageru
//   FB_CAPI_ACCESS_TOKEN  – přístupový token Conversions API
//   FB_TEST_EVENT_CODE    – jen pro testování v Events Manageru (pak smazat)

const crypto = require("crypto");

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// Meta vyžaduje normalizaci před hashováním: e-mail lowercase/trim,
// telefon jen číslice s předvolbou (CZ 9 číslic → doplnit 420)
const normMail = (s) => String(s || "").trim().toLowerCase();
const normPhone = (s) => {
  let p = String(s || "").replace(/\D/g, "");
  if (p.length === 9) p = "420" + p;
  return p;
};

async function sendCapiEvent(d, req) {
  const pixelId = process.env.FB_PIXEL_ID;
  const token = process.env.FB_CAPI_ACCESS_TOKEN;
  if (!pixelId || !token) return; // měření vypnuto, poptávky fungují dál

  const userData = { };
  const mail = normMail(d.mail);
  if (mail) userData.em = [sha256(mail)];
  const phone = normPhone(d.tel);
  if (phone) userData.ph = [sha256(phone)];
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (ip) userData.client_ip_address = ip;
  const ua = req.headers["user-agent"];
  if (ua) userData.client_user_agent = String(ua).slice(0, 400);
  if (d.fbp) userData.fbp = String(d.fbp).slice(0, 100);
  if (d.fbc) userData.fbc = String(d.fbc).slice(0, 400);

  const event = {
    event_name: d.form === "seek" ? "SeekSubmit" : "Lead",
    event_time: Math.floor(Date.now() / 1000),
    action_source: "website",
    event_source_url: String(d.url || "https://www.klidnymajitel.cz/").slice(0, 300),
    user_data: userData,
  };
  // stejné event_id posílá i prohlížečový pixel (přes GTM) → deduplikace
  if (d.eid) event.event_id = String(d.eid).slice(0, 80);

  const body = { data: [event] };
  if (process.env.FB_TEST_EVENT_CODE) body.test_event_code = process.env.FB_TEST_EVENT_CODE;

  try {
    const r = await fetch(
      `https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    const t = await r.text();
    if (!r.ok) console.error("capi-error", r.status, t.slice(0, 300));
    else console.log("capi-ok", t.slice(0, 120));
  } catch (e) {
    console.error("capi-error", e && e.message);
  }
}

const esc = (s) =>
  String(s || "")
    .slice(0, 600)
    .replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method" });
  }
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    return res.status(500).json({ ok: false, error: "missing-key" });
  }

  const d = req.body || {};
  // honeypot — roboti pole vyplní, lidé ho nevidí (a do měření nejdou)
  if (d.web) return res.status(200).json({ ok: true });

  const isSeek = d.form === "seek";
  const subject = isSeek
    ? `Zájemce: ${d.cil || "bydlení"} — ${d.kde || "bez lokality"}`
    : `Poptávka pronájmu: ${d.typ || "nemovitost"} — ${d.kde || "bez lokality"}`;

  const rows = isSeek
    ? [
        ["Co potřebuje", d.cil],
        ["Hledá", d.typ],
        ["Lokalita", d.kde],
        ["Max. nájem", d.max],
        ["E-mail", d.mail],
      ]
    : [
        ["Co pronajímá", d.typ],
        ["Adresa / lokalita", d.kde],
        ["Telefon", d.tel],
        ["E-mail", d.mail],
        ["Poznámka", d.pozn],
      ];

  const html =
    `<h2 style="font-family:sans-serif">${esc(subject)}</h2>` +
    `<table style="font-family:sans-serif;font-size:15px;border-collapse:collapse">` +
    rows
      .filter(([, v]) => v)
      .map(
        ([k, v]) =>
          `<tr><td style="padding:6px 14px 6px 0;color:#666">${k}</td>` +
          `<td style="padding:6px 0"><b>${esc(v)}</b></td></tr>`
      )
      .join("") +
    `</table>` +
    `<p style="font-family:sans-serif;color:#888;font-size:13px">Odesláno z formuláře na www.klidnymajitel.cz</p>`;

  const FROM = process.env.LEAD_FROM || "Klidný majitel <poptavky@info.klidnymajitel.cz>";
  const payload = {
    from: FROM,
    to: [process.env.LEAD_TO || "info@klidnymajitel.cz"],
    subject,
    html,
  };
  if (d.mail) payload.reply_to = String(d.mail).slice(0, 200);

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("resend-error", r.status, t.slice(0, 300));
      return res.status(502).json({ ok: false, error: "send" });
    }

    // poptávka je u nás → konverze do Meta Conversions API (selhání nevadí)
    await sendCapiEvent(d, req);

    // poděkování odesílateli (když uvedl e-mail) — selhání nevadí, poptávka už je u nás
    if (d.mail) {
      const thanks = {
        from: FROM,
        to: [String(d.mail).slice(0, 200)],
        subject: isSeek
          ? "Děkujeme — Vaše zadání evidujeme | Klidný majitel"
          : "Děkujeme za poptávku — ozveme se do 24 hodin | Klidný majitel",
        html:
          `<div style="font-family:sans-serif;font-size:15px;color:#14262A">` +
          `<p>Dobrý den,</p>` +
          (isSeek
            ? `<p>Vaše zadání evidujeme. Jakmile se objeví nemovitost podle Vašich podmínek, ozveme se Vám dřív, než se dostane na inzertní portály.</p>`
            : `<p>děkujeme za Vaši poptávku. Ozveme se Vám <b>do 24 hodin</b> a domluvíme nezávaznou prohlídku zdarma.</p>`) +
          `<p>Tým Klidný majitel<br>` +
          `<span style="color:#666">Petr Živčák · +420 731 618 347 · www.klidnymajitel.cz<br>` +
          `Přemyslova 111/3, Plzeň · provozuje Profiservis24 s.r.o.</span></p></div>`,
      };
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(thanks),
        });
      } catch (e) {
        console.error("thanks-error", e && e.message);
      }
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("lead-error", e && e.message);
    return res.status(500).json({ ok: false, error: "server" });
  }
};
