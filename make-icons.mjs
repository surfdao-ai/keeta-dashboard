/* Renders DashKee PWA icons (full-bleed tokyo-night square + K mark) as PNGs
   without any image library: raw PNG encoder (zlib) + polygon fill. */
import zlib from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const W = Number(process.argv[2] || 512);
const OUT = process.argv[3] || `icon-${W}.png`;

/* K glyph path from the favicon SVG (viewBox 32x32) — SVG commands with
   relative moves (v/h/l) must be converted to an absolute polygon */
const PATH = 'M10 8v12.5L19 8h4l-7.5 9L23 24h-4.2l-6-6.6V24H10z';
const tokens = PATH.match(/[MmLlHhVvZz]|-?\d+(\.\d+)?/g);
const poly = [];
let cx = 0, cy = 0, i = 0;
while (i < tokens.length) {
  const cmd = tokens[i++];
  const n = () => parseFloat(tokens[i++]);
  switch (cmd) {
    case 'M': cx = n(); cy = n(); poly.push([cx, cy]); break;
    case 'm': cx += n(); cy += n(); poly.push([cx, cy]); break;
    case 'L': cx = n(); cy = n(); poly.push([cx, cy]); break;
    case 'l': cx += n(); cy += n(); poly.push([cx, cy]); break;
    case 'H': cx = n(); poly.push([cx, cy]); break;
    case 'h': cx += n(); poly.push([cx, cy]); break;
    case 'V': cy = n(); poly.push([cx, cy]); break;
    case 'v': cy += n(); poly.push([cx, cy]); break;
    case 'Z': case 'z': break;
  }
}

const BG = [0x24, 0x28, 0x3b]; // --card (tokyo night)
const FG = [0x7a, 0xa2, 0xf7]; // --accent

const SS = 3; // supersampling factor
const insidePoly = (x, y) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

const rows = [];
for (let py = 0; py < W; py++) {
  const row = Buffer.alloc(1 + W * 4);
  row[0] = 0; // filter: none
  for (let px = 0; px < W; px++) {
    let hit = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = ((px + (sx + 0.5) / SS) / W) * 32;
        const y = ((py + (sy + 0.5) / SS) / W) * 32;
        if (insidePoly(x, y)) hit++;
      }
    }
    const a = hit / (SS * SS);
    const o = 1 + px * 4;
    row[o] = Math.round(BG[0] * (1 - a) + FG[0] * a);
    row[o + 1] = Math.round(BG[1] * (1 - a) + FG[1] * a);
    row[o + 2] = Math.round(BG[2] * (1 - a) + FG[2] * a);
    row[o + 3] = 255;
  }
  rows.push(row);
}

const crcTable = [...Array(256)].map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
mkdirSync('public/icons', { recursive: true });
writeFileSync(`public/icons/${OUT}`, png);
console.log(`public/icons/${OUT}: ${png.length} bytes`);
