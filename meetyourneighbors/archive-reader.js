((root, factory) => {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MYNArchiveReader = api;
})(typeof window !== "undefined" ? window : globalThis, (root) => {
  "use strict";

  const EOCD_SIGNATURE = 0x06054b50;
  const ZIP64_EOCD_SIGNATURE = 0x06064b50;
  const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
  const CENTRAL_SIGNATURE = 0x02014b50;
  const LOCAL_SIGNATURE = 0x04034b50;
  const ZIP64_EXTRA_ID = 0x0001;
  const MAX_DIRECTORY_BYTES = 128 * 1024 * 1024;
  const MAX_ENTRIES = 2_000_000;

  function uint64(view, offset) {
    const low = view.getUint32(offset, true);
    const high = view.getUint32(offset + 4, true);
    const value = high * 0x100000000 + low;
    if (!Number.isSafeInteger(value)) throw new Error("This ZIP archive is too large for this browser.");
    return value;
  }

  async function readRange(file, start, length) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > file.size) {
      throw new Error("The ZIP archive contains an invalid file location.");
    }
    try {
      return new Uint8Array(await file.slice(start, start + length).arrayBuffer());
    } catch (error) {
      const replacement = new Error(
        `The browser could not read ${file.name || "this archive"}. Make sure the download has finished, then choose the file again from Downloads or Desktop.`
      );
      replacement.cause = error;
      throw replacement;
    }
  }

  function zip64Values(extra, needs) {
    const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
    let cursor = 0;
    while (cursor + 4 <= extra.length) {
      const id = view.getUint16(cursor, true);
      const size = view.getUint16(cursor + 2, true);
      const start = cursor + 4;
      const end = start + size;
      if (end > extra.length) break;
      if (id === ZIP64_EXTRA_ID) {
        let valueCursor = start;
        const values = {};
        for (const key of ["uncompressedSize", "compressedSize", "localOffset"]) {
          if (!needs[key]) continue;
          if (valueCursor + 8 > end) throw new Error("The ZIP64 directory is incomplete.");
          values[key] = uint64(view, valueCursor);
          valueCursor += 8;
        }
        return values;
      }
      cursor = end;
    }
    throw new Error("The ZIP64 directory is missing required size information.");
  }

  async function findDirectory(file) {
    const tailLength = Math.min(file.size, 65_557 + 20);
    const tailStart = file.size - tailLength;
    const tail = await readRange(file, tailStart, tailLength);
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let eocd = -1;
    for (let cursor = tail.length - 22; cursor >= 0; cursor -= 1) {
      if (view.getUint32(cursor, true) === EOCD_SIGNATURE) {
        eocd = cursor;
        break;
      }
    }
    if (eocd < 0) throw new Error("This does not look like a readable ZIP archive.");

    let entryCount = view.getUint16(eocd + 10, true);
    let directorySize = view.getUint32(eocd + 12, true);
    let directoryOffset = view.getUint32(eocd + 16, true);
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      const eocdOffset = tailStart + eocd;
      const locator = await readRange(file, eocdOffset - 20, 20);
      const locatorView = new DataView(locator.buffer, locator.byteOffset, locator.byteLength);
      if (locatorView.getUint32(0, true) !== ZIP64_LOCATOR_SIGNATURE) {
        throw new Error("The ZIP64 directory locator is missing.");
      }
      const zip64Offset = uint64(locatorView, 8);
      const zip64 = await readRange(file, zip64Offset, 56);
      const zip64View = new DataView(zip64.buffer, zip64.byteOffset, zip64.byteLength);
      if (zip64View.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) {
        throw new Error("The ZIP64 directory is damaged.");
      }
      entryCount = uint64(zip64View, 32);
      directorySize = uint64(zip64View, 40);
      directoryOffset = uint64(zip64View, 48);
    }
    if (entryCount > MAX_ENTRIES || directorySize > MAX_DIRECTORY_BYTES) {
      throw new Error("This ZIP contains too many files for the browser uploader.");
    }
    return { entryCount, directorySize, directoryOffset };
  }

  async function inflateRaw(bytes) {
    if (!("DecompressionStream" in root)) {
      throw new Error("This browser cannot open compressed ZIP files locally. Unzip the archive and choose tweets.js instead.");
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new root.DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readEntryText(file, entry) {
    const header = await readRange(file, entry.localOffset, 30);
    const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (headerView.getUint32(0, true) !== LOCAL_SIGNATURE) throw new Error(`Could not read ${entry.name}.`);
    const nameLength = headerView.getUint16(26, true);
    const extraLength = headerView.getUint16(28, true);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const compressed = await readRange(file, start, entry.compressedSize);
    let content;
    if (entry.method === 0) content = compressed;
    else if (entry.method === 8) content = await inflateRaw(compressed);
    else throw new Error(`The ZIP compression used for ${entry.name} is unsupported.`);
    return new TextDecoder().decode(content);
  }

  async function openTweetParts(file, options = {}) {
    const maximum = options.maxTotalUncompressedBytes ?? 2 * 1024 * 1024 * 1024;
    const directory = await findDirectory(file);
    const bytes = await readRange(file, directory.directoryOffset, directory.directorySize);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder();
    const entries = [];
    let totalUncompressed = 0;
    let cursor = 0;

    for (let index = 0; index < directory.entryCount; index += 1) {
      if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
        throw new Error("The ZIP directory is damaged or unsupported.");
      }
      const method = view.getUint16(cursor + 10, true);
      let compressedSize = view.getUint32(cursor + 20, true);
      let uncompressedSize = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      let localOffset = view.getUint32(cursor + 42, true);
      const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
      if (recordEnd > bytes.length) throw new Error("The ZIP directory is incomplete.");
      const name = decoder.decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
      const needs = {
        uncompressedSize: uncompressedSize === 0xffffffff,
        compressedSize: compressedSize === 0xffffffff,
        localOffset: localOffset === 0xffffffff,
      };
      if (needs.uncompressedSize || needs.compressedSize || needs.localOffset) {
        const extra = bytes.slice(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
        const values = zip64Values(extra, needs);
        if (needs.uncompressedSize) uncompressedSize = values.uncompressedSize;
        if (needs.compressedSize) compressedSize = values.compressedSize;
        if (needs.localOffset) localOffset = values.localOffset;
      }
      if (/(^|\/)tweets(?:-part\d+)?\.js$/i.test(name) && !/tweet-headers/i.test(name)) {
        const entry = { name, method, compressedSize, uncompressedSize, localOffset };
        entry.readText = () => readEntryText(file, entry);
        entries.push(entry);
        totalUncompressed += uncompressedSize;
      }
      cursor = recordEnd;
    }
    if (!entries.length) throw new Error("No tweets.js files were found inside this ZIP.");
    if (totalUncompressed > maximum) {
      throw new Error(`The tweet files in this archive are too large for this pilot (over ${Math.round(maximum / 1024 / 1024)} MB).`);
    }
    entries.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
    return entries;
  }

  return { openTweetParts };
});
