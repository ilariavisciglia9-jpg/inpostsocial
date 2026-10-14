// ===== SCRITTE SULLE IMMAGINI =====
// Le AI che creano immagini sbagliano le lettere: qui il testo viene disegnato dal server
// con un carattere vero (Montserrat), quindi è sempre scritto in modo corretto.
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const opentype = require('opentype.js');

let fonts = null;
function loadFonts() {
  if (fonts) return fonts;
  // caratteri TTF inclusi nel progetto (cartella fonts, licenza SIL OFL)
  const read = (name) => { const b = fs.readFileSync(path.join(__dirname, 'fonts', name)); return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
  fonts = { bold: read('Montserrat_800ExtraBold.ttf'), regular: read('Montserrat_600SemiBold.ttf') };
  return fonts;
}

// misura e disegna lettera per lettera (più affidabile del getPath di opentype con questi file)
function measure(font, text, size) {
  const k = size / font.unitsPerEm;
  let w = 0;
  for (const ch of String(text)) w += (font.charToGlyph(ch).advanceWidth || font.unitsPerEm * 0.3) * k;
  return w;
}
// converte i comandi del glifo in testo SVG (il toPathData di opentype a volte restituisce NaN)
function pathData(cmds) {
  const n = (v) => (Math.round(v * 100) / 100).toString();
  let d = '';
  for (const c of cmds) {
    if (c.type === 'M' || c.type === 'L') d += c.type + n(c.x) + ' ' + n(c.y);
    else if (c.type === 'Q') d += 'Q' + n(c.x1) + ' ' + n(c.y1) + ' ' + n(c.x) + ' ' + n(c.y);
    else if (c.type === 'C') d += 'C' + n(c.x1) + ' ' + n(c.y1) + ' ' + n(c.x2) + ' ' + n(c.y2) + ' ' + n(c.x) + ' ' + n(c.y);
    else if (c.type === 'Z') d += 'Z';
  }
  return d;
}

function textPath(font, text, x, y, size, attrs) {
  // un <path> per ogni lettera: evita problemi di rendering con tracciati unici molto lunghi
  const k = size / font.unitsPerEm;
  let out = '';
  for (const ch of String(text)) {
    const g = font.charToGlyph(ch);
    const pd = pathData(g.getPath(x, y, size).commands);
    if (pd && !/NaN/.test(pd)) out += `<path d="${pd}" ${attrs}/>`;
    x += (g.advanceWidth || font.unitsPerEm * 0.3) * k;
  }
  return out;
}

// manda a capo le parole perché stiano nella larghezza indicata
function wrap(font, text, size, maxWidth) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (measure(font, test, size) <= maxWidth || !line) line = test;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

function hexOk(c) { return /^#[0-9a-f]{6}$/i.test(c || '') ? c : null; }

// buffer immagine + titolo (+ sottotitolo) -> buffer PNG con la scritta in basso
async function addTextOverlay(imageBuffer, title, subtitle, opts) {
  opts = opts || {};
  const f = loadFonts();
  const img = sharp(imageBuffer);
  const meta = await img.metadata();
  const W = meta.width, H = meta.height;
  const pad = Math.round(W * 0.07);
  const maxW = W - pad * 2;

  // titolo: parte grande e si riduce finché sta in massimo 3 righe
  let size = Math.round(W * 0.085), tLines = [];
  for (; size > W * 0.045; size -= 2) {
    tLines = wrap(f.bold, String(title || '').toUpperCase(), size, maxW);
    if (tLines.length <= 3) break;
  }
  const subSize = Math.round(size * 0.42);
  const sLines = subtitle ? wrap(f.regular, subtitle, subSize, maxW).slice(0, 2) : [];
  const lh = size * 1.12, slh = subSize * 1.35;
  const blockH = tLines.length * lh + (sLines.length ? subSize * 0.6 + sLines.length * slh : 0);
  const bottom = H - pad;
  let y = bottom - blockH + size * 0.9;

  const accent = hexOk(opts.accent) || '#ffffff';
  const paths = [];
  for (const l of tLines) {
    paths.push(textPath(f.bold, l, pad, y, size, 'fill="#ffffff"'));
    y += lh;
  }
  if (sLines.length) {
    y += subSize * 0.6 - (lh - size);
    const barY = y - subSize * 1.15;
    paths.push(`<rect x="${pad}" y="${barY.toFixed(1)}" width="${Math.round(W * 0.12)}" height="${Math.max(3, Math.round(W * 0.006))}" fill="${accent}"/>`);
    y += subSize * 0.4;
    for (const l of sLines) {
      paths.push(textPath(f.regular, l, pad, y, subSize, 'fill="#ffffff" fill-opacity="0.92"'));
      y += slh;
    }
  }
  const gradTop = Math.max(0, (bottom - blockH - pad * 1.6) / H);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="${gradTop.toFixed(3)}" stop-color="#000" stop-opacity="0"/>
      <stop offset="${Math.min(1, gradTop + (1 - gradTop) * 0.45).toFixed(3)}" stop-color="#000" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.78"/>
    </linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
    ${paths.join('\n')}
  </svg>`;
  return img.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
}

module.exports = { addTextOverlay };
