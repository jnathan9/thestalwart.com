// Private hit counter for thestalwart.com
// /px.gif — logs a hit, returns an invisible 1x1 pixel (embedded on the site)
// /stats?key=... — private stats page (key is a Worker secret, STATS_KEY)

const PIXEL = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (c) => c.charCodeAt(0)
);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/px.gif") {
      const referrer = request.headers.get("Referer") || "";
      await env.DB.prepare(
        "INSERT INTO hits (ts, referrer) VALUES (datetime('now'), ?)"
      ).bind(referrer.slice(0, 200)).run();
      return new Response(PIXEL, {
        headers: {
          "Content-Type": "image/gif",
          "Cache-Control": "no-store, max-age=0",
        },
      });
    }

    if (url.pathname === "/stats") {
      if (url.searchParams.get("key") !== env.STATS_KEY) {
        return new Response("Not found", { status: 404 });
      }
      const total = (await env.DB.prepare("SELECT COUNT(*) AS total FROM hits").first()).total;
      const days = (await env.DB.prepare(
        "SELECT date(ts) AS day, COUNT(*) AS hits FROM hits GROUP BY day ORDER BY day DESC LIMIT 60"
      ).all()).results;
      const refs = (await env.DB.prepare(
        "SELECT referrer, COUNT(*) AS hits FROM hits WHERE referrer != '' " +
        "AND referrer NOT LIKE '%thestalwart.com%' GROUP BY referrer ORDER BY hits DESC LIMIT 20"
      ).all()).results;

      let html =
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>thestalwart.com stats</title></head>' +
        '<body bgcolor="#DDEEDD"><h2 align="center">thestalwart.com hits</h2>' +
        `<p align="center">Total: <b>${total}</b></p>` +
        '<table border="1" cellpadding="4" align="center"><tr><th>Day</th><th>Hits</th></tr>';
      for (const r of days) html += `<tr><td>${r.day}</td><td align="right">${r.hits}</td></tr>`;
      html += '</table><h3 align="center">Top referrers</h3>' +
        '<table border="1" cellpadding="4" align="center"><tr><th>Referrer</th><th>Hits</th></tr>';
      for (const r of refs) {
        const safe = r.referrer.replace(/&/g, "&amp;").replace(/</g, "&lt;");
        html += `<tr><td>${safe}</td><td align="right">${r.hits}</td></tr>`;
      }
      html += "</table></body></html>";
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    return new Response("ok");
  },
};
