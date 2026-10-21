// make-fixtures.js — generates the fictional CSV fixtures used by app.js (__demo) and smoke.spec.js.
// Run with: node tests/make-fixtures.js   (deterministic output, all names and places are made up)
const fs = require('fs');
const path = require('path');

const out = (name) => path.join(__dirname, 'fixtures', name);

// Small deterministic PRNG so the files are identical on every run.
let seed = 20261021;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pick = (list) => list[Math.floor(rand() * list.length)];

const FIRST = ['Mara', 'Tobin', 'Ilsa', 'Corvin', 'Wren', 'Dalia', 'Fenn', 'Oriel', 'Pella', 'Quint', 'Rosk', 'Sabeth', 'Tamsin', 'Ulric', 'Vesna', 'Yorick'];
const LAST = ['Quillfeather', 'Brambleton', 'Ashgrove', 'Marrowby', 'Thistlewood', 'Copperfield', 'Driftmoor', 'Saltmarsh', 'Fernhollow', 'Gullstone'];
const CITIES = ['Port Alder', 'Eastwick Bay', 'Larkhaven', 'Millbrook Cove', 'Stonereach', 'Tidewater Falls', 'Wrenmouth', 'Harrowgate Point'];
const ITEMS = [
  ['Brass deck cleat', 14.5], ['Rope, 10 m coil', 22], ['Canvas tote', 18.75], ['Lantern wick pack', 4.2],
  ['Tide chart 2026', 9.99], ['Oilskin jacket', 129], ['Marine varnish 1 L', 31.4], ['Signal whistle', 6.5],
  ['Bilge sponge', 3.1], ['Galvanised shackle', 7.85], ['Wool watch cap', 24], ['Chart dividers', 38.6],
];

function orders(count) {
  const lines = ['order_id,date,customer,city,item,qty,total'];
  const start = Date.UTC(2025, 0, 1);
  for (let i = 0; i < count; i++) {
    const id = `NP-${String(100000 + i)}`;
    const date = new Date(start + Math.floor(rand() * 600) * 86400000).toISOString().slice(0, 10);
    let customer = `${pick(FIRST)} ${pick(LAST)}`;
    if (i === 7 || i % 4999 === 11) customer = 'Renée Saltmarsh'; // a name with an accent
    const city = i % 1237 === 5 ? '' : pick(CITIES); // a few empty cells
    const [item, price] = pick(ITEMS);
    const qty = 1 + Math.floor(rand() * 9);
    const total = i % 2311 === 9 ? '' : (qty * price).toFixed(2);
    const quote = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    lines.push([id, date, quote(customer), quote(city), quote(item), qty, total].join(','));
  }
  return lines.join('\n') + '\n';
}

fs.writeFileSync(out('sample-orders.csv'), orders(50000));

// Semicolon-separated export with decimal commas, as some European spreadsheet apps write.
const semi = ['sku;product;stock;price'];
for (let i = 0; i < 40; i++) {
  const [item, price] = ITEMS[i % ITEMS.length];
  semi.push(`SKU-${200 + i};${item};${(i * 7) % 50};${price.toFixed(2).replace('.', ',')}`);
}
fs.writeFileSync(out('sample-semicolon.csv'), semi.join('\n') + '\n');

console.log('fixtures written');
