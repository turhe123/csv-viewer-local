// worker.js — reads and parses a CSV/TSV file off the main thread (classic worker).
// Bytes are decoded here with a streaming TextDecoder (so multi-byte characters split across chunks stay intact),
// strictly as UTF-8 first and as Windows-1252 if that fails, then fed to papaparse through a minimal stream object.
/* global Papa */
importScripts('vendor/papaparse/papaparse.min.js');

const SLICE = 4 * 1024 * 1024;

self.onmessage = (e) => {
  run(e.data).catch((err) => self.postMessage({ type: 'error', message: `The file could not be read: ${err && err.message ? err.message : err}` }));
};

async function run({ file, delimiter, maxRows }) {
  const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  if (!head.length) return self.postMessage({ type: 'error', message: 'This file is empty, there are no rows to show.' });
  const bomEnc = bomEncoding(head);
  const problem = bomEnc ? null : sniff(head);
  if (problem) return self.postMessage({ type: 'error', message: problem });

  let encoding = bomEnc || 'utf-8';
  let res = await parseWith(file, encoding, encoding === 'utf-8', delimiter, maxRows);
  if (res === 'bad-utf8') {
    self.postMessage({ type: 'restart' });
    encoding = 'windows-1252';
    res = await parseWith(file, encoding, false, delimiter, maxRows);
  }
  self.postMessage({ type: 'done', encoding, truncated: res.truncated });
}

function bomEncoding(b) {
  if (b[0] === 0xff && b[1] === 0xfe) return 'utf-16le';
  if (b[0] === 0xfe && b[1] === 0xff) return 'utf-16be';
  return null;
}

// Returns a human message if the bytes do not look like a text file.
function sniff(b) {
  const starts = (sig) => sig.every((v, i) => b[i] === v);
  if (starts([0x50, 0x4b, 0x03, 0x04])) return 'This looks like an Excel workbook (.xlsx) or a ZIP archive, not a CSV. Save it as CSV from your spreadsheet app, then open the CSV here.';
  if (starts([0xd0, 0xcf, 0x11, 0xe0])) return 'This looks like an old Excel (.xls) file, not a CSV. Save it as CSV from your spreadsheet app, then open the CSV here.';
  if (starts([0x25, 0x50, 0x44, 0x46])) return 'This is a PDF document, not a CSV file.';
  let ctrl = 0;
  for (let i = 0; i < b.length; i++) {
    const v = b[i];
    if (v === 0) return 'This file looks binary (it contains null bytes), so it is not a plain-text CSV. If it is a spreadsheet, export it as CSV first.';
    if (v < 9 || (v > 13 && v < 32 && v !== 27)) ctrl++;
  }
  if (ctrl > b.length * 0.02) return 'This file looks binary rather than text, so it cannot be shown as a table. Check that you picked the CSV export.';
  return null;
}

const NUMERIC = /^\s*[-+]?[$€£]?\s*(\d[\d,. ]*|\.\d+)\s*%?\s*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

// A first row is a header when it has no number- or date-like cells and its names are unique.
function guessHeader(rows) {
  const first = rows[0] || [];
  if (rows.length < 2) return first.every((c) => c.trim() && !NUMERIC.test(c));
  const names = first.map((c) => c.trim());
  if (names.some((c) => c && (NUMERIC.test(c) || ISO_DATE.test(c)))) return false;
  if (names.filter((c) => !c).length > 1) return false;
  return new Set(names).size === names.length;
}

function parseWith(file, encoding, strict, delimiter, maxRows) {
  return new Promise((resolve, reject) => {
    const listeners = {};
    // papaparse accepts any object that looks like a Node readable stream.
    const stream = {
      readable: true,
      read() {},
      on(ev, fn) { listeners[ev] = fn; },
      removeListener(ev) { delete listeners[ev]; },
      pause() {},
      resume() {},
    };
    let sent = 0;
    let sentMeta = false;
    let stopped = false;
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };

    Papa.parse(stream, {
      delimiter: delimiter || '',
      skipEmptyLines: true,
      chunk(res, parser) {
        if (stopped) return;
        let data = res.data;
        if (!data.length) return;
        if (!sentMeta) {
          sentMeta = true;
          if (data[0].length && data[0][0].charCodeAt(0) === 0xfeff) data[0][0] = data[0][0].slice(1);
          self.postMessage({ type: 'meta', delimiter: res.meta.delimiter, header: guessHeader(data.slice(0, 20)), encoding });
        }
        // +1 leaves room for a header row in preview mode.
        if (maxRows && sent + data.length > maxRows + 1) {
          data = data.slice(0, maxRows + 1 - sent);
          stopped = true;
          parser.abort();
        }
        sent += data.length;
        self.postMessage({ type: 'rows', rows: data });
        if (stopped) settle({ truncated: true });
      },
      complete() { settle({ truncated: false }); },
      error(err) { if (!settled) { settled = true; reject(err); } },
    });

    (async () => {
      const decoder = new TextDecoder(encoding, { fatal: strict });
      const size = file.size;
      for (let off = 0; off < size && !stopped; off += SLICE) {
        const buf = await file.slice(off, off + SLICE).arrayBuffer();
        let text;
        try {
          text = decoder.decode(buf, { stream: off + SLICE < size });
        } catch {
          stopped = true;
          return settle('bad-utf8');
        }
        if (text && listeners.data) listeners.data(text);
        self.postMessage({ type: 'progress', done: Math.min(size, off + SLICE), total: size });
      }
      if (!stopped && listeners.end) listeners.end();
      settle({ truncated: false });
    })().catch((err) => { if (!settled) { settled = true; reject(err); } });
  });
}
