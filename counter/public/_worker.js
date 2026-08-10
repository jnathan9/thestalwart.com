// Private hit counter and Meet Your Neighbors contribution intake.

const PIXEL = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (c) => c.charCodeAt(0)
);

const ALLOWED_ORIGINS = new Set([
  "https://thestalwart.com",
  "https://www.thestalwart.com",
  "https://jnathan9.github.io",
]);
const MAX_BODY_BYTES = 1_500_000;
const MIN_SAMPLE_WORDS = 9_500;
const MAX_SAMPLE_WORDS = 10_000;
const MAX_SAMPLE_DOCS = 12_000;

function cors(request) {
  const origin = request.headers.get("Origin") || "";
  return ALLOWED_ORIGINS.has(origin) ? {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  } : {};
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...cors(request),
    },
  });
}

function countWords(text) {
  const clean = String(text || "").trim();
  return clean ? clean.split(/\s+/).length : 0;
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function validatePacket(packet) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    throw new Error("The contribution must be a JSON object.");
  }
  if (packet.schema_version !== "meetmyneighbors-contribution-v1" ||
      packet.pipeline_candidate !== "0.7.0") {
    throw new Error("This contribution packet version is not supported.");
  }
  if (!packet.created_at || Number.isNaN(Date.parse(packet.created_at))) {
    throw new Error("The contribution creation time is invalid.");
  }
  const person = packet.contributor;
  if (!person || typeof person.map_name !== "string" ||
      person.map_name.trim().length < 1 || person.map_name.trim().length > 80) {
    throw new Error("Map name must be between 1 and 80 characters.");
  }
  if (typeof (person.x_handle || "") !== "string" || (person.x_handle || "").length > 80 ||
      typeof (person.email || "") !== "string" || (person.email || "").length > 200) {
    throw new Error("Contributor contact details are invalid.");
  }
  const consent = packet.consent;
  if (!consent || consent.owns_archive !== true ||
      consent.external_model_processing !== true || consent.public_map !== true) {
    throw new Error("All three consent statements must be accepted.");
  }
  const sample = packet.sample;
  if (!Array.isArray(sample) || sample.length < 1 || sample.length > MAX_SAMPLE_DOCS) {
    throw new Error("The sample has an invalid number of documents.");
  }
  let totalWords = 0;
  for (const item of sample) {
    if (!item || typeof item.text !== "string" || !item.text.trim() ||
        item.text.length > 250_000 || !/^\d{4}-\d{2}-\d{2}$/.test(item.date || "") ||
        !Number.isInteger(item.n_tweets) || item.n_tweets < 1 || item.n_tweets > 10_000) {
      throw new Error("A sampled document is invalid.");
    }
    totalWords += countWords(item.text);
  }
  if (totalWords < MIN_SAMPLE_WORDS || totalWords > MAX_SAMPLE_WORDS) {
    throw new Error(`The sample must contain ${MIN_SAMPLE_WORDS.toLocaleString()}–${MAX_SAMPLE_WORDS.toLocaleString()} words.`);
  }
  if (!packet.processing || packet.processing.full_archive_uploaded !== false ||
      packet.processing.sampled_words !== totalWords) {
    throw new Error("The sample provenance does not match its contents.");
  }
  return { totalWords, person, consent, sample };
}

async function receiveContribution(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!ALLOWED_ORIGINS.has(origin)) return json(request, { error: "This origin is not allowed." }, 403);
  const statedLength = Number(request.headers.get("Content-Length") || "0");
  if (statedLength > MAX_BODY_BYTES) return json(request, { error: "The contribution packet is too large." }, 413);

  let packet;
  try {
    const body = await request.text();
    if (!body || new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
      return json(request, { error: "The contribution packet is too large or empty." }, 413);
    }
    packet = JSON.parse(body);
  } catch {
    return json(request, { error: "The contribution packet is not valid JSON." }, 400);
  }

  let checked;
  try {
    checked = validatePacket(packet);
    const expected = await sha256(JSON.stringify(checked.sample));
    if (packet.processing.sample_sha256 !== expected) {
      throw new Error("The sample fingerprint does not match; the packet may be incomplete.");
    }
  } catch (error) {
    return json(request, { error: error.message || "The contribution is invalid." }, 400);
  }

  // A one-way address fingerprint is retained only as a daily abuse counter.
  const day = new Date().toISOString().slice(0, 10);
  const address = request.headers.get("CF-Connecting-IP") || "unknown";
  const addressHash = await sha256(`meetmyneighbors:${day}:${address}`);
  const prior = await env.DB.prepare(
    "SELECT submissions FROM contribution_rate WHERE day = ? AND address_hash = ?"
  ).bind(day, addressHash).first();
  if (prior && prior.submissions >= 3) {
    return json(request, { error: "This network has reached today's contribution limit." }, 429);
  }

  const receipt = crypto.randomUUID().replaceAll("-", "");
  const createdAt = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO contributions " +
        "(receipt, created_at, map_name, x_handle, email, consent_version, sample_sha, sampled_words, document_count, packet_json, status) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')"
      ).bind(
        receipt,
        createdAt,
        checked.person.map_name.trim(),
        (checked.person.x_handle || "").trim(),
        (checked.person.email || "").trim(),
        checked.consent.version || "2026-08-10",
        packet.processing.sample_sha256,
        checked.totalWords,
        checked.sample.length,
        JSON.stringify(packet)
      ),
      env.DB.prepare(
        "INSERT INTO contribution_rate (day, address_hash, submissions) VALUES (?, ?, 1) " +
        "ON CONFLICT(day, address_hash) DO UPDATE SET submissions = submissions + 1"
      ).bind(day, addressHash),
    ]);
  } catch (error) {
    console.error("contribution insert failed", error);
    return json(request, { error: "The contribution could not be stored. Please try again." }, 500);
  }
  return json(request, { receipt, status: "pending", received_at: createdAt }, 201);
}

async function contributionStatus(request, env, receipt) {
  if (!/^[a-f0-9]{32}$/.test(receipt)) return json(request, { error: "Not found." }, 404);
  const row = await env.DB.prepare(
    "SELECT status, created_at FROM contributions WHERE receipt = ?"
  ).bind(receipt).first();
  return row ? json(request, row) : json(request, { error: "Not found." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/contributions")) {
      return new Response(null, { status: 204, headers: cors(request) });
    }
    if (request.method === "POST" && url.pathname === "/api/contributions") {
      return receiveContribution(request, env);
    }
    const statusMatch = /^\/api\/contributions\/([a-f0-9]{32})$/.exec(url.pathname);
    if (request.method === "GET" && statusMatch) {
      return contributionStatus(request, env, statusMatch[1]);
    }

    if (url.pathname === "/px.gif") {
      const referrer = request.headers.get("Referer") || "";
      await env.DB.prepare(
        "INSERT INTO hits (ts, referrer) VALUES (datetime('now'), ?)"
      ).bind(referrer.slice(0, 200)).run();
      return new Response(PIXEL, {
        headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, max-age=0" },
      });
    }

    if (url.pathname === "/stats") {
      if (url.searchParams.get("key") !== env.STATS_KEY) return new Response("Not found", { status: 404 });
      const total = (await env.DB.prepare("SELECT COUNT(*) AS total FROM hits").first()).total;
      const days = (await env.DB.prepare(
        "SELECT date(ts) AS day, COUNT(*) AS hits FROM hits GROUP BY day ORDER BY day DESC LIMIT 60"
      ).all()).results;
      const refs = (await env.DB.prepare(
        "SELECT referrer, COUNT(*) AS hits FROM hits WHERE referrer != '' " +
        "AND referrer NOT LIKE '%thestalwart.com%' GROUP BY referrer ORDER BY hits DESC LIMIT 20"
      ).all()).results;

      let html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>thestalwart.com stats</title></head>' +
        '<body bgcolor="#DDEEDD"><h2 align="center">thestalwart.com hits</h2>' +
        `<p align="center">Total: <b>${total}</b></p>` +
        '<table border="1" cellpadding="4" align="center"><tr><th>Day</th><th>Hits</th></tr>';
      for (const r of days) html += `<tr><td>${r.day}</td><td align="right">${r.hits}</td></tr>`;
      html += '</table><h3 align="center">Top referrers</h3><table border="1" cellpadding="4" align="center"><tr><th>Referrer</th><th>Hits</th></tr>';
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
