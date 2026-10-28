// Draws the tray and app icons into assets/ (run with `npm run icons`; the
// output is committed). The glyph is a small track diagram: one source
// station whose line splits into two dependents. Shapes are drawn from signed
// distance functions, so edges are anti-aliased at every size without an
// image library.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../assets/', import.meta.url));

// ---- PNG encoding -----------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {number} size @param {Float64Array} rgba premultiplied-free RGBA in 0..1 */
function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      for (let c = 0; c < 4; c++) {
        raw[y * (size * 4 + 1) + 1 + x * 4 + c] = Math.round(Math.min(1, Math.max(0, rgba[(y * size + x) * 4 + c])) * 255);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---- shapes (in a 16-unit design space) -------------------------------------

const segment = (ax, ay, bx, by, halfWidth) => (x, y) => {
  const px = x - ax;
  const py = y - ay;
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - t * dx, py - t * dy) - halfWidth;
};
const disc = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;
const roundedSquare = (inset, radius) => (x, y) => {
  const c = 8;
  const half = 8 - inset - radius;
  const qx = Math.abs(x - c) - half;
  const qy = Math.abs(y - c) - half;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
};
const union = (...shapes) => (x, y) => Math.min(...shapes.map((s) => s(x, y)));

/** The track glyph, scaled by `k` around the centre. */
function glyph(k = 1) {
  const t = (v) => 8 + (v - 8) * k;
  const w = 0.8 * k;
  return {
    source: disc(t(3), t(8), 2.1 * k),
    targets: union(disc(t(13), t(4.3), 1.9 * k), disc(t(13), t(11.7), 1.9 * k)),
    track: union(
      segment(t(3), t(8), t(6.2), t(8), w),
      segment(t(6.2), t(8), t(9.2), t(4.3), w),
      segment(t(9.2), t(4.3), t(13), t(4.3), w),
      segment(t(6.2), t(8), t(9.2), t(11.7), w),
      segment(t(9.2), t(11.7), t(13), t(11.7), w)
    )
  };
}

/**
 * Renders layers (shape + colour, painted in order) at a pixel size.
 * @param {number} size
 * @param {Array<{ shape: (x:number,y:number)=>number, color: [number,number,number,number] }>} layers
 */
function render(size, layers) {
  const scale = size / 16;
  const out = new Float64Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) / scale;
      const y = (py + 0.5) / scale;
      let [r, g, b, a] = [0, 0, 0, 0];
      for (const { shape, color } of layers) {
        const coverage = Math.max(0, Math.min(1, 0.5 - shape(x, y) * scale)) * color[3];
        if (coverage === 0) continue;
        const outA = coverage + a * (1 - coverage);
        r = (color[0] * coverage + r * a * (1 - coverage)) / outA;
        g = (color[1] * coverage + g * a * (1 - coverage)) / outA;
        b = (color[2] * coverage + b * a * (1 - coverage)) / outA;
        a = outA;
      }
      out.set([r, g, b, a], (py * size + px) * 4);
    }
  }
  return encodePng(size, out);
}

const hex = (h, alpha = 1) => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
  alpha
];

// Palette (matches the renderer's tokens).
const INK = '#26332D';
const ENAMEL = '#DDE4DC';
const AMBER = '#E8A317';
const SIGNAL = '#C23B2A';
const STOPPED = '#7D8A83';
const WHITE = '#FFFFFF';

function write(name, png) {
  fs.mkdirSync(path.dirname(path.join(OUT, name)), { recursive: true });
  fs.writeFileSync(path.join(OUT, name), png);
}

// macOS: template images (black + alpha), the counts go next to them as text.
for (const [name, alpha] of [
  ['trayTemplate', 1],
  ['trayStoppedTemplate', 0.4]
]) {
  for (const [suffix, size] of [
    ['', 16],
    ['@2x', 32]
  ]) {
    const g = glyph(1);
    const black = hex('#000000', alpha);
    write(`tray/${name}${suffix}.png`, render(size, [
      { shape: g.track, color: black },
      { shape: g.source, color: black },
      { shape: g.targets, color: black }
    ]));
  }
}

// Windows and Linux: the state is the colour of a small signal plate, readable
// on light and dark taskbars alike.
const PLATES = {
  idle: { plate: INK, glyph: ENAMEL },
  busy: { plate: AMBER, glyph: INK },
  failing: { plate: SIGNAL, glyph: WHITE },
  stopped: { plate: STOPPED, glyph: WHITE }
};
for (const [state, { plate, glyph: color }] of Object.entries(PLATES)) {
  for (const [suffix, size] of [
    ['', 16],
    ['@2x', 32]
  ]) {
    const g = glyph(0.78);
    write(`tray/tray-${state}${suffix}.png`, render(size, [
      { shape: roundedSquare(0.3, 3.2), color: hex(plate) },
      { shape: g.track, color: hex(color) },
      { shape: g.source, color: hex(color) },
      { shape: g.targets, color: hex(color) }
    ]));
  }
}

// App icon: the idle plate with a lit source station.
{
  const g = glyph(0.72);
  write('icon.png', render(512, [
    { shape: roundedSquare(0.7, 3.4), color: hex(INK) },
    { shape: g.track, color: hex(ENAMEL) },
    { shape: g.targets, color: hex(ENAMEL) },
    { shape: g.source, color: hex(AMBER) }
  ]));
}

console.log(`Icons written to ${OUT}`);
