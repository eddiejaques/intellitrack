// Draws the toolbar/store icons (a signal ring with a centre dot on an indigo tile) as anti-aliased PNGs.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const t = Buffer.from(type), len = Buffer.alloc(4), c = Buffer.alloc(4);
  len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, c]);
};

function render(size) {
  const S = 4, N = size * S; // 4x supersampling
  const px = Buffer.alloc(size * size * 4);
  const cx = N / 2, cy = N / 2;
  const tile = [79, 70, 229]; // accent indigo
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let a = 0, r = 0, g = 0, b = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const X = x * S + sx + .5, Y = y * S + sy + .5;
      // rounded square tile
      const rad = N * .24, dx = Math.max(Math.abs(X - cx) - (N / 2 - rad), 0), dy = Math.max(Math.abs(Y - cy) - (N / 2 - rad), 0);
      if (Math.hypot(dx, dy) > rad) continue;
      a++;
      const d = Math.hypot(X - cx, Y - cy) / N;
      const ring = Math.abs(d - .27) < .055, dot = d < .105;
      const fg = ring || dot;
      r += fg ? 255 : tile[0]; g += fg ? 255 : tile[1]; b += fg ? 255 : tile[2];
    }
    const i = (y * size + x) * 4, n = S * S;
    px[i] = a ? r / a : 0; px[i + 1] = a ? g / a : 0; px[i + 2] = a ? b / a : 0; px[i + 3] = Math.round((a / n) * 255);
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

mkdirSync("extension/static/icons", { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(`extension/static/icons/icon-${s}.png`, render(s));
console.log("icons written");
