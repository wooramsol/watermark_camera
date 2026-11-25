/**
 * Invisible watermark for photos — two layers written into the pixels themselves.
 *
 * 1. Pixel layer (LSB): the lowest bit of every pixel's blue channel carries the frame. A ±1 change out of 255
 *    is invisible, and every pixel holds one bit, so a 1920×1080 photo repeats the frame ~5,000 times.
 *    Survives only lossless files (PNG). If any app re-encodes the photo as JPEG this layer disappears,
 *    which also makes it a tamper/re-save check: intact pixel layer = the file is the original.
 *
 * 2. Robust layer (block QIM): each 8×8 block's average brightness is nudged by at most ±STEP/2 levels onto one
 *    of two interleaved grids (bit 0 / bit 1). JPEG keeps block averages (the DC coefficient) well, so this
 *    layer survives JPEG re-compression of the same-size image. It does not survive resizing or cropping.
 *
 * Every photo from this app carries the same fixed pattern (no per-user key): the question answered is only
 * "was this taken with this app?", plus when. Bits are scrambled with a fixed pseudo-random stream so the
 * pattern looks like noise and ordinary photos don't match it. Decoding is a majority vote over every
 * repetition, then a CRC32 check.
 *
 * Frame (FRAME_BYTES, fixed): [version 1B][unix seconds 4B][crc32 4B]
 */

export const VERSION = 2;
const FRAME_BYTES = 1 + 4 + 4;
const FRAME_BITS = FRAME_BYTES * 8;
const BLOCK = 8;
const STEP = 4; // robust-layer quantisation step in brightness levels (max change ±2)
const SEED = 0x57a7e2c1; // fixed app-wide pattern seed — changing it orphans every photo taken before

export type Decoded = { time: Date; votes: number; agreement: number };
export type VerifyResult = { pixel: Decoded | null; robust: Decoded | null };

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Stateless seeded hash of an index → 32 bits (lowbias32 mixer). */
function mix(i: number, seed: number): number {
  let x = (i ^ seed) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

function encodeFrame(time: Date): Uint8Array {
  const f = new Uint8Array(FRAME_BYTES);
  const dv = new DataView(f.buffer);
  f[0] = VERSION;
  dv.setUint32(1, Math.floor(time.getTime() / 1000) >>> 0);
  dv.setUint32(FRAME_BYTES - 4, crc32(f.subarray(0, FRAME_BYTES - 4)));
  return f;
}

function decodeFrame(f: Uint8Array): Date | null {
  const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
  if (f[0] !== VERSION) return null;
  if (dv.getUint32(FRAME_BYTES - 4) !== crc32(f.subarray(0, FRAME_BYTES - 4))) return null;
  return new Date(dv.getUint32(1) * 1000);
}

const frameBit = (f: Uint8Array, i: number) => (f[i >> 3] >> (7 - (i & 7))) & 1;

/** Majority vote: tally[i] = (sum of ±1 votes). Returns frame bytes + how unanimous the vote was. */
function settle(tally: Float64Array, weight: Float64Array) {
  const f = new Uint8Array(FRAME_BYTES);
  let agree = 0;
  let total = 0;
  for (let i = 0; i < FRAME_BITS; i++) {
    if (tally[i] > 0) f[i >> 3] |= 1 << (7 - (i & 7));
    agree += Math.abs(tally[i]);
    total += weight[i];
  }
  return { frame: f, agreement: total ? agree / total : 0 };
}

// ── pixel layer (LSB of blue) ────────────────────────────────────────────────────────────────────────

const LSB_SALT = 0x9e3779b9;

function embedLsb(px: Uint8ClampedArray, frame: Uint8Array, seed: number) {
  const s = (seed ^ LSB_SALT) >>> 0;
  const n = px.length >> 2;
  for (let k = 0; k < n; k++) {
    const bit = frameBit(frame, k % FRAME_BITS) ^ (mix(k, s) & 1);
    const o = k * 4 + 2;
    px[o] = (px[o] & 0xfe) | bit;
  }
}

function readLsb(px: Uint8ClampedArray, seed: number): Decoded | null {
  const s = (seed ^ LSB_SALT) >>> 0;
  const n = px.length >> 2;
  if (n < FRAME_BITS) return null;
  const tally = new Float64Array(FRAME_BITS);
  const weight = new Float64Array(FRAME_BITS);
  for (let k = 0; k < n; k++) {
    const bit = (px[k * 4 + 2] & 1) ^ (mix(k, s) & 1);
    const i = k % FRAME_BITS;
    tally[i] += bit ? 1 : -1;
    weight[i] += 1;
  }
  const { frame, agreement } = settle(tally, weight);
  const p = decodeFrame(frame);
  return p ? { time: p, votes: Math.floor(n / FRAME_BITS), agreement } : null;
}

// ── robust layer (8×8 block brightness QIM) ──────────────────────────────────────────────────────────

const QIM_SALT = 0x51ed270b;

function blockMean(px: Uint8ClampedArray, w: number, bx: number, by: number) {
  let sum = 0;
  for (let y = by * BLOCK; y < by * BLOCK + BLOCK; y++) {
    let o = (y * w + bx * BLOCK) * 4;
    for (let x = 0; x < BLOCK; x++, o += 4) sum += 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
  }
  return sum / (BLOCK * BLOCK);
}

/** Dither offset in [0, STEP) for block k — scrambles the grid so plain photos don't line up with it. */
const dither = (k: number, s: number) => (mix(k, s) / 0x100000000) * STEP;

function embedQim(px: Uint8ClampedArray, w: number, h: number, frame: Uint8Array, seed: number) {
  const s = (seed ^ QIM_SALT) >>> 0;
  const bw = Math.floor(w / BLOCK);
  const bh = Math.floor(h / BLOCK);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const k = by * bw + bx;
      const bit = frameBit(frame, k % FRAME_BITS);
      const d = dither(k, s) + (bit ? STEP / 2 : 0);
      const m = blockMean(px, w, bx, by);
      const target = Math.round((m - d) / STEP) * STEP + d;
      const delta = target - m; // adding the same amount to R,G,B moves luma by exactly delta
      if (Math.abs(delta) < 0.05) continue;
      for (let y = by * BLOCK; y < by * BLOCK + BLOCK; y++) {
        let o = (y * w + bx * BLOCK) * 4;
        for (let x = 0; x < BLOCK; x++, o += 4) {
          px[o] = px[o] + delta;
          px[o + 1] = px[o + 1] + delta;
          px[o + 2] = px[o + 2] + delta;
        }
      }
    }
  }
}

function readQim(px: Uint8ClampedArray, w: number, h: number, seed: number): Decoded | null {
  const s = (seed ^ QIM_SALT) >>> 0;
  const bw = Math.floor(w / BLOCK);
  const bh = Math.floor(h / BLOCK);
  if (bw * bh < FRAME_BITS) return null;
  const tally = new Float64Array(FRAME_BITS);
  const weight = new Float64Array(FRAME_BITS);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const k = by * bw + bx;
      const m = blockMean(px, w, bx, by);
      // Position inside the grid cell: 0 → bit 0 lattice, 0.5 → bit 1 lattice. Soft vote by distance.
      let r = ((m - dither(k, s)) / STEP) % 1;
      if (r < 0) r += 1;
      const conf = 1 - 4 * Math.min(Math.abs(r - 0.5), 0.5) ; // +1 at bit-1 lattice, -1 at bit-0 lattice
      const i = k % FRAME_BITS;
      tally[i] += conf;
      weight[i] += 1;
    }
  }
  const { frame, agreement } = settle(tally, weight);
  const p = decodeFrame(frame);
  return p ? { time: p, votes: Math.floor((bw * bh) / FRAME_BITS), agreement } : null;
}

// ── public API ───────────────────────────────────────────────────────────────────────────────────────

/** Writes the watermark into RGBA pixels in place. Robust layer first, pixel layer last (it must stay exact). */
export function embed(img: ImageData, time: Date) {
  const frame = encodeFrame(time);
  embedQim(img.data, img.width, img.height, frame, SEED);
  embedLsb(img.data, frame, SEED);
}

export function verify(img: ImageData): VerifyResult {
  return { pixel: readLsb(img.data, SEED), robust: readQim(img.data, img.width, img.height, SEED) };
}

/** Smallest image that can carry a full frame in both layers (blocks are 8×8). */
export const MIN_PIXELS = FRAME_BITS * BLOCK * BLOCK;
