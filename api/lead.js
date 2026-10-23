// Odeslání poptávky z webu přes Resend (https://resend.com)
// Vyžaduje env proměnné ve Vercelu:
//   RESEND_API_KEY  – API klíč Resend (povinné)
//   LEAD_TO         – kam poptávky chodí (výchozí info@klidnymajitel.cz)
//   LEAD_FROM       – odesílatel; doména musí být ověřená v Resend
//                     (výchozí "Klidný majitel <poptavky@info.klidnymajitel.cz>")

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
  // honeypot — roboti pole vyplní, lidé ho nevidí
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

  const payload = {
    from: process.env.LEAD_FROM || "Klidný majitel <poptavky@info.klidnymajitel.cz>",
    to: [process.env.LEAD_TO || "info@klidnymajitel.cz"],
    subject,
    html,
  };
  if (isSeek && d.mail) payload.reply_to = String(d.mail).slice(0, 200);

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
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("lead-error", e && e.message);
    return res.status(500).json({ ok: false, error: "server" });
  }
};
