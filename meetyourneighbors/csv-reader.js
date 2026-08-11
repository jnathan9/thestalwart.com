((root, factory) => {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MYNCsvReader = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  "use strict";

  const TEXT_COLUMNS = ["full_text", "tweet_text", "text", "tweet", "content", "post_text", "post", "body"];
  const DATE_COLUMNS = ["created_at", "createdat", "date", "timestamp", "datetime", "posted_at", "published_at", "time"];
  const ID_COLUMNS = ["tweet_id", "tweetid", "id_str", "status_id", "statusid", "id"];
  const REPLY_COLUMNS = [
    "in_reply_to_status_id_str",
    "in_reply_to_status_id",
    "reply_to_tweet_id",
    "reply_to_status_id",
    "reply_to_id",
    "parent_id",
  ];
  const RETWEET_COLUMNS = ["is_retweet", "retweeted", "retweet"];

  function normalizedHeader(value) {
    return String(value || "")
      .replace(/^\ufeff/, "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function delimiterFor(text) {
    const counts = new Map([[",", 0], ["\t", 0], [";", 0]]);
    let quoted = false;
    for (let index = 0; index < Math.min(text.length, 100_000); index += 1) {
      const character = text[index];
      if (character === '"') {
        if (quoted && text[index + 1] === '"') index += 1;
        else quoted = !quoted;
      } else if (!quoted && (character === "\r" || character === "\n")) {
        break;
      } else if (!quoted && counts.has(character)) {
        counts.set(character, counts.get(character) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  function parseRows(text) {
    const delimiter = delimiterFor(text);
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index <= text.length; index += 1) {
      const character = index === text.length ? "\n" : text[index];
      if (quoted) {
        if (character === '"' && text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else if (character === '"') {
          quoted = false;
        } else {
          field += character;
        }
      } else if (character === '"' && field.length === 0) {
        quoted = true;
      } else if (character === delimiter) {
        row.push(field);
        field = "";
      } else if (character === "\n") {
        row.push(field.replace(/\r$/, ""));
        if (row.some((value) => value.trim())) rows.push(row);
        row = [];
        field = "";
      } else {
        field += character;
      }
    }
    if (quoted) throw new Error("The CSV has an unterminated quoted field.");
    return rows;
  }

  function findColumn(headers, candidates) {
    for (const candidate of candidates) {
      const index = headers.indexOf(candidate);
      if (index >= 0) return index;
    }
    return -1;
  }

  function truthy(value) {
    return /^(?:1|true|yes|y)$/i.test(String(value || "").trim());
  }

  function parseTweets(text, filename = "tweets.csv") {
    const rows = parseRows(text);
    if (rows.length < 2) throw new Error("The CSV does not contain any tweet rows.");
    const headers = rows[0].map(normalizedHeader);
    const textIndex = findColumn(headers, TEXT_COLUMNS);
    const dateIndex = findColumn(headers, DATE_COLUMNS);
    const idIndex = findColumn(headers, ID_COLUMNS);
    const replyIndex = findColumn(headers, REPLY_COLUMNS);
    const retweetIndex = findColumn(headers, RETWEET_COLUMNS);
    if (textIndex < 0 || dateIndex < 0) {
      const missing = [textIndex < 0 ? "tweet text" : "", dateIndex < 0 ? "date" : ""].filter(Boolean).join(" and ");
      throw new Error(`The CSV needs a ${missing} column. Recognized headers include text, full_text, tweet_text, created_at, date, and timestamp.`);
    }

    const tweets = [];
    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index];
      const fullText = String(row[textIndex] || "").trim();
      const createdAt = String(row[dateIndex] || "").trim();
      if (!fullText || !createdAt) continue;
      const tweet = {
        full_text: fullText,
        created_at: createdAt,
        id_str: String(idIndex >= 0 ? row[idIndex] || "" : "").trim() || `csv:${filename}:${index}`,
        in_reply_to_status_id_str: String(replyIndex >= 0 ? row[replyIndex] || "" : "").trim() || null,
      };
      if (retweetIndex >= 0 && truthy(row[retweetIndex])) tweet.retweeted_status = {};
      tweets.push(tweet);
    }
    if (!tweets.length) throw new Error("The CSV has no rows containing both tweet text and a date.");
    return tweets;
  }

  return { parseTweets };
});
