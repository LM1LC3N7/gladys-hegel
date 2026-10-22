// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark gradient, the front of
// a minimalist black amplifier (a dot display, two large knobs) and sound
// waves. Plain Node (zlib), no dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
/** Antialiased coverage of a signed distance (negative inside). */
const inside = (distance) => Math.min(1, Math.max(0, 0.5 - distance));

/** Signed distance to a rounded rectangle centred on (cx, cy). */
function roundRect(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

const DARK = [16, 20, 30];
const GREY = [52, 60, 78];
// A black front plate, two silver knobs and a white dot display.
const FRONT = [22, 23, 26];
const FRONT_EDGE = [70, 72, 80];
const DISPLAY = [8, 8, 10];
const DOTS = [236, 240, 248];
const KNOB = [120, 124, 132];
const KNOB_LIGHT = [222, 226, 232];
const WAVE = [120, 180, 255];

const BODY = { cx: 400, cy: 262, w: 320, h: 86, r: 10 };
const KNOBS = [
  { x: 168, y: 262, r: 54 },
  { x: 632, y: 262, r: 54 },
];

function pixel(x, y) {
  let color = mix(DARK, GREY, (x / WIDTH) * 0.5 + (y / HEIGHT) * 0.5);
  // Soft shadow under the amplifier.
  const shadow = Math.hypot((x - BODY.cx) / 350, (y - 378) / 18);
  color = mix(color, [0, 0, 0], (1 - shadow) * 0.7);
  // The front plate, a thin lighter edge around it.
  const body = roundRect(x, y, BODY.cx, BODY.cy, BODY.w, BODY.h, BODY.r);
  color = mix(color, FRONT_EDGE, inside(body));
  color = mix(color, FRONT, inside(body + 3));
  // The display, with a dot-matrix number.
  const display = roundRect(x, y, 400, 262, 90, 30, 4);
  color = mix(color, DISPLAY, inside(display));
  // "4" and "0" drawn as dots (5×7 cells).
  const glyphs = [
    ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  ];
  glyphs.forEach((rows, g) => {
    rows.forEach((row, ry) => {
      [...row].forEach((on, rx) => {
        if (on === '1') {
          const dx = 368 + g * 40 + rx * 6;
          const dy = 244 + ry * 6;
          color = mix(color, DOTS, inside(Math.hypot(x - dx, y - dy) - 2.2));
        }
      });
    });
  });
  // The two knobs: a ring, a brushed cap, a marker.
  for (const knob of KNOBS) {
    const d = Math.hypot(x - knob.x, y - knob.y);
    color = mix(color, DISPLAY, inside(d - knob.r - 5));
    const angle = Math.atan2(y - knob.y, x - knob.x);
    const sheen = 0.5 + 0.5 * Math.cos(angle * 2 + 0.6);
    color = mix(color, mix(KNOB, KNOB_LIGHT, sheen * (1 - d / knob.r) + 0.2), inside(d - knob.r));
    const mx = knob.x + Math.cos(-2.2) * 38;
    const my = knob.y + Math.sin(-2.2) * 38;
    color = mix(color, FRONT, inside(Math.hypot(x - mx, y - my) - 4));
  }
  // Sound waves to the right of the amplifier.
  const center = { x: 720, y: 262 };
  const wd = Math.hypot(x - center.x, y - center.y);
  const waveAngle = Math.abs(Math.atan2(y - center.y, x - center.x));
  if (x > center.x && waveAngle < 0.5) {
    for (const r of [24, 46, 68]) {
      color = mix(color, WAVE, inside(Math.abs(wd - r) - 3) * (1 - waveAngle / 0.5) * 0.9);
    }
  }
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
