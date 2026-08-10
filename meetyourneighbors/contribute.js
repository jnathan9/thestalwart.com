(() => {
  "use strict";

  const WORD_BUDGET = 10_000;
  const MIN_USABLE_WORDS = 9_500;
  const MAX_DOCS = 12_000;
  const WINDOW_DAYS = 365 * 3;
  const TIME_STRATA = 12;
  const MAX_TWEET_DATA_BYTES = 500 * 1024 * 1024;
  const PIPELINE_VERSION = "0.7.0";
  const SCHEMA_VERSION = "meetmyneighbors-contribution-v1";
  const CONSENT_VERSION = "2026-08-10";

  const $ = (id) => document.getElementById(id);
  const fileInput = $("files");
  const drop = $("drop");
  const endpoint = document.querySelector('meta[name="mmn-submit-endpoint"]')?.content.trim() || "";
  let prepared = null;

  if (!endpoint) $("submit").textContent = "Download contribution packet";

  function setStatus(id, message, kind = "") {
    const el = $(id);
    el.textContent = message;
    el.className = `status ${kind}`.trim();
  }

  function words(text) {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }

  function decodeHtml(text) {
    const area = document.createElement("textarea");
    area.innerHTML = text;
    return area.value;
  }

  function cleanText(raw) {
    return decodeHtml(raw)
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/^(?:@\w+\s+)+/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseTwitterDate(raw) {
    const match = /^(?:\w{3}) (\w{3}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/.exec(raw || "");
    if (!match) return null;
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(match[1]);
    if (month < 0) return null;
    const offset = (Number(match[7]) * 60 + Number(match[8])) * (match[6] === "+" ? 1 : -1);
    const time = Date.UTC(Number(match[9]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])) - offset * 60_000;
    const date = new Date(time);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function parsePart(text) {
    const body = text.replace(/^\s*window\.YTD\.[\w.]+\s*=\s*/, "").trim().replace(/;\s*$/, "");
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed)) throw new Error("The tweets file did not contain a list of posts.");
    return parsed.map((item) => item.tweet || item);
  }

  function uint(view, offset, bytes) {
    if (bytes === 2) return view.getUint16(offset, true);
    return view.getUint32(offset, true);
  }

  async function inflateRaw(bytes) {
    if (!("DecompressionStream" in window)) {
      throw new Error("This browser cannot open ZIP files locally. Unzip the archive and choose tweets.js instead.");
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function tweetPartsFromZip(file) {
    setStatus("file-status", `Opening ${file.name} locally…`);
    const buffer = await file.arrayBuffer();
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    let eocd = -1;
    for (let i = Math.max(0, bytes.length - 65_557); i <= bytes.length - 22; i += 1) {
      if (view.getUint32(i, true) === 0x06054b50) eocd = i;
    }
    if (eocd < 0) throw new Error("This does not look like a readable ZIP archive.");

    const entryCount = uint(view, eocd + 10, 2);
    let cursor = uint(view, eocd + 16, 4);
    const entries = [];
    let totalUncompressed = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("The ZIP directory is damaged or unsupported.");
      const method = uint(view, cursor + 10, 2);
      const compressedSize = uint(view, cursor + 20, 4);
      const uncompressedSize = uint(view, cursor + 24, 4);
      const nameLength = uint(view, cursor + 28, 2);
      const extraLength = uint(view, cursor + 30, 2);
      const commentLength = uint(view, cursor + 32, 2);
      const localOffset = uint(view, cursor + 42, 4);
      const name = new TextDecoder().decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
      if (/(^|\/)tweets(?:-part\d+)?\.js$/i.test(name) && !/tweet-headers/i.test(name)) {
        entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
        totalUncompressed += uncompressedSize;
      }
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    if (!entries.length) throw new Error("No tweets.js files were found inside this ZIP.");
    if (totalUncompressed > MAX_TWEET_DATA_BYTES) throw new Error("The tweet files in this archive are too large for this pilot (over 500 MB).");

    entries.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
    const result = [];
    for (const entry of entries) {
      if (view.getUint32(entry.localOffset, true) !== 0x04034b50) throw new Error(`Could not read ${entry.name}.`);
      const nameLength = uint(view, entry.localOffset + 26, 2);
      const extraLength = uint(view, entry.localOffset + 28, 2);
      const start = entry.localOffset + 30 + nameLength + extraLength;
      const compressed = bytes.slice(start, start + entry.compressedSize);
      let content;
      if (entry.method === 0) content = compressed;
      else if (entry.method === 8) content = await inflateRaw(compressed);
      else throw new Error(`The ZIP compression used for ${entry.name} is unsupported.`);
      result.push({ name: entry.name, text: new TextDecoder().decode(content) });
    }
    return result;
  }

  async function readParts(files) {
    const zip = files.find((file) => /\.zip$/i.test(file.name) || file.type === "application/zip");
    if (zip) return tweetPartsFromZip(zip);
    const js = files.filter((file) => /tweets(?:-part\d+)?\.js$/i.test(file.name) && !/^tweet-headers/i.test(file.name));
    if (!js.length) throw new Error("Choose the X archive ZIP, or one or more tweets.js files.");
    js.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
    const parts = [];
    for (const file of js) parts.push({ name: file.name, text: await file.text() });
    return parts;
  }

  function buildDocuments(rawTweets) {
    const kept = new Map();
    for (const tweet of rawTweets) {
      const full = tweet.full_text || tweet.text || "";
      if (full.startsWith("RT @") || Object.prototype.hasOwnProperty.call(tweet, "retweeted_status")) continue;
      const text = cleanText(full);
      const date = parseTwitterDate(tweet.created_at);
      const id = String(tweet.id_str || tweet.id || "");
      if (!id || !date || words(text) < 5) continue;
      kept.set(id, { id, text, createdAt: date, replyTo: tweet.in_reply_to_status_id_str || null });
    }

    const children = new Map();
    const isChild = new Set();
    for (const tweet of kept.values()) {
      if (tweet.replyTo && kept.has(tweet.replyTo)) {
        if (!children.has(tweet.replyTo)) children.set(tweet.replyTo, []);
        children.get(tweet.replyTo).push(tweet.id);
        isChild.add(tweet.id);
      }
    }

    const docs = [];
    for (const tweet of kept.values()) {
      if (isChild.has(tweet.id)) continue;
      const chain = [tweet];
      let cursor = tweet.id;
      const visited = new Set([cursor]);
      while (children.has(cursor)) {
        const next = children.get(cursor)
          .map((id) => kept.get(id))
          .filter((item) => item && !visited.has(item.id))
          .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!next) break;
        chain.push(next);
        visited.add(next.id);
        cursor = next.id;
      }
      docs.push({
        text: chain.map((item) => item.text).join(" "),
        createdAt: tweet.createdAt,
        nTweets: chain.length,
      });
    }

    const seen = new Set();
    return docs
      .sort((a, b) => a.createdAt - b.createdAt)
      .filter((doc) => {
        const key = doc.text.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function applyWindow(docs) {
    if (!docs.length) return [];
    const newest = docs[docs.length - 1].createdAt.getTime();
    const cutoff = newest - WINDOW_DAYS * 86_400_000;
    return docs.filter((doc) => doc.createdAt.getTime() >= cutoff);
  }

  function mulberry32(seed) {
    return () => {
      let value = seed += 0x6d2b79f5;
      value = Math.imul(value ^ value >>> 15, value | 1);
      value ^= value + Math.imul(value ^ value >>> 7, value | 61);
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
  }

  function weightedIndex(pool, candidates, random) {
    const weights = candidates.map((index) => Math.max(words(pool[index].text), 1) ** 0.5);
    let target = random() * weights.reduce((sum, value) => sum + value, 0);
    for (let i = 0; i < candidates.length; i += 1) {
      target -= weights[i];
      if (target <= 0) return candidates[i];
    }
    return candidates[candidates.length - 1];
  }

  function sampleDocuments(docs) {
    const total = docs.reduce((sum, doc) => sum + words(doc.text), 0);
    if (total <= WORD_BUDGET && docs.length <= MAX_DOCS) return [...docs];
    const start = docs[0].createdAt.getTime();
    const end = docs[docs.length - 1].createdAt.getTime();
    const span = Math.max(end - start, 1);
    const buckets = Array.from({ length: TIME_STRATA }, () => []);
    for (const doc of docs) {
      const index = Math.min(TIME_STRATA - 1, Math.floor(((doc.createdAt.getTime() - start) / span) * TIME_STRATA));
      buckets[index].push(doc);
    }
    const nonempty = buckets.filter((bucket) => bucket.length);
    const perBucket = WORD_BUDGET / nonempty.length;
    const random = mulberry32(0x4d4d4e07);
    const picked = [];
    const chosen = new Set();
    let totalSpent = 0;
    let carry = 0;
    for (const bucket of nonempty) {
      const target = perBucket + carry;
      const pool = [...bucket];
      let spent = 0;
      while (pool.length && spent < target && picked.length < MAX_DOCS) {
        const room = Math.min(Math.floor(target - spent), WORD_BUDGET - totalSpent);
        const candidates = pool.map((doc, index) => words(doc.text) <= room ? index : -1).filter((index) => index >= 0);
        if (!candidates.length) break;
        const index = weightedIndex(pool, candidates, random);
        const [doc] = pool.splice(index, 1);
        const count = words(doc.text);
        picked.push(doc);
        chosen.add(doc);
        spent += count;
        totalSpent += count;
      }
      carry = Math.max(0, target - spent);
    }
    const pool = docs.filter((doc) => !chosen.has(doc));
    while (pool.length && totalSpent < WORD_BUDGET && picked.length < MAX_DOCS) {
      const room = WORD_BUDGET - totalSpent;
      const candidates = pool.map((doc, index) => words(doc.text) <= room ? index : -1).filter((index) => index >= 0);
      if (!candidates.length) break;
      const index = weightedIndex(pool, candidates, random);
      const [doc] = pool.splice(index, 1);
      picked.push(doc);
      totalSpent += words(doc.text);
    }
    return picked.sort((a, b) => a.createdAt - b.createdAt);
  }

  async function digest(value) {
    const encoded = new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest("SHA-256", encoded);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function formatDate(date) {
    return date.toISOString().slice(0, 10);
  }

  async function prepareFiles(fileList) {
    prepared = null;
    $("review").hidden = true;
    $("done").hidden = true;
    try {
      const parts = await readParts([...fileList]);
      const raw = parts.flatMap((part) => parsePart(part.text));
      const docs = applyWindow(buildDocuments(raw));
      if (!docs.length) throw new Error("No eligible posts were found in the recent three-year window.");
      const sample = sampleDocuments(docs);
      const sampledWords = sample.reduce((sum, doc) => sum + words(doc.text), 0);
      const availableWords = docs.reduce((sum, doc) => sum + words(doc.text), 0);
      prepared = {
        rawCount: raw.length,
        eligibleCount: docs.length,
        availableWords,
        sampledWords,
        dateRange: [sample[0].createdAt, sample[sample.length - 1].createdAt],
        sourceParts: parts.length,
        sample,
      };
      $("stat-raw").textContent = raw.length.toLocaleString();
      $("stat-kept").textContent = docs.length.toLocaleString();
      $("stat-words").textContent = sampledWords.toLocaleString();
      $("stat-dates").textContent = `${prepared.dateRange[0].getUTCFullYear()}–${prepared.dateRange[1].getUTCFullYear()}`;
      const warning = $("sample-warning");
      warning.hidden = sampledWords >= MIN_USABLE_WORDS;
      warning.textContent = `This archive supplies only ${sampledWords.toLocaleString()} usable words. The map needs at least ${MIN_USABLE_WORDS.toLocaleString()} for a usable position.`;
      const preview = $("preview");
      preview.replaceChildren(...sample.map((doc) => {
        const item = document.createElement("li");
        item.textContent = `${formatDate(doc.createdAt)} — ${doc.text}`;
        return item;
      }));
      $("review").hidden = false;
      setStatus("file-status", `Ready. ${parts.length} tweet file${parts.length === 1 ? "" : "s"} read; the complete archive stayed on this device.`, "good");
      updateSubmit();
    } catch (error) {
      console.error(error);
      setStatus("file-status", error instanceof Error ? error.message : "The archive could not be read.", "bad");
    }
  }

  function updateSubmit() {
    const ready = prepared && prepared.sampledWords >= MIN_USABLE_WORDS;
    $("submit").disabled = !(ready && $("map-name").value.trim() && $("own").checked && $("model").checked && $("publish").checked);
  }

  async function makePacket() {
    const sample = prepared.sample.map((doc) => ({
      date: formatDate(doc.createdAt),
      n_tweets: doc.nTweets,
      text: doc.text,
    }));
    return {
      schema_version: SCHEMA_VERSION,
      pipeline_candidate: PIPELINE_VERSION,
      created_at: new Date().toISOString(),
      contributor: {
        map_name: $("map-name").value.trim(),
        x_handle: $("handle").value.trim().replace(/^@/, ""),
        email: $("email").value.trim(),
      },
      consent: {
        version: CONSENT_VERSION,
        owns_archive: true,
        external_model_processing: true,
        public_map: true,
      },
      processing: {
        client_side: true,
        full_archive_uploaded: false,
        source_parts: prepared.sourceParts,
        raw_posts_read: prepared.rawCount,
        eligible_documents: prepared.eligibleCount,
        available_words: prepared.availableWords,
        sampled_words: prepared.sampledWords,
        sample_seed: "mmn-v0.7-browser-constant",
        window_years: 3,
        word_budget: WORD_BUDGET,
        sample_sha256: await digest(JSON.stringify(sample)),
      },
      sample,
    };
  }

  function downloadPacket(packet) {
    const blob = new Blob([JSON.stringify(packet, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `meetmyneighbors-${packet.contributor.map_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "contribution"}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
  }

  async function submit() {
    $("submit").disabled = true;
    setStatus("submit-status", endpoint ? "Sending the bounded sample…" : "Preparing the contribution packet…");
    try {
      const packet = await makePacket();
      let receipt;
      if (endpoint) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(packet),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `Submission failed (${response.status}).`);
        receipt = result.receipt;
      } else {
        downloadPacket(packet);
        receipt = packet.processing.sample_sha256.slice(0, 16);
        $("done").querySelector("h2").textContent = "Contribution packet saved";
        $("done").querySelector("p:last-child").textContent = "Send the downloaded JSON file to the pilot organizer. It contains the reviewed sample—not your complete archive.";
      }
      $("receipt").textContent = receipt;
      $("done").hidden = false;
      setStatus("submit-status", endpoint ? "Received." : "Downloaded.", "good");
      $("done").scrollIntoView({ behavior: "smooth" });
    } catch (error) {
      setStatus("submit-status", error instanceof Error ? error.message : "The contribution could not be submitted.", "bad");
      updateSubmit();
    }
  }

  for (const event of ["dragenter", "dragover"]) drop.addEventListener(event, (e) => { e.preventDefault(); drop.classList.add("drag"); });
  for (const event of ["dragleave", "drop"]) drop.addEventListener(event, (e) => { e.preventDefault(); drop.classList.remove("drag"); });
  drop.addEventListener("drop", (event) => prepareFiles(event.dataTransfer.files));
  fileInput.addEventListener("change", () => prepareFiles(fileInput.files));
  for (const id of ["map-name", "own", "model", "publish"]) $(id).addEventListener("input", updateSubmit);
  $("submit").addEventListener("click", submit);
})();
