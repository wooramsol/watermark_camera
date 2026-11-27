/**
 * Invisible watermark for photos. Every photo from this app carries the same fixed pattern (no per-user key);
 * the question answered is "was this taken with this app?", plus when it was taken.
 *
 * 1. Tile pattern (survives messengers): a 32×32-cell pseudo-random ±1 tile is repeated over the whole photo as
 *    a faint brightness texture (±1.5…4 levels, stronger where the photo is busy). A cell is 1/256 of the long
 *    side, so a tile is 1/8 of it. Half of the cells are a fixed sync pattern — finding it is what proves the
 *    photo came from this app. The other half carry the capture time (minutes) + CRC16, each bit spread over
 *    many cells and every tile; on heavily shrunk photos the time may be unreadable while the sync still is.
 *    Reading it back needs no knowledge of what happened to the photo:
 *      - row/column autocorrelation of the high-passed brightness finds the tile period separately on x and y
 *        (→ any resize, also a changed aspect ratio),
 *      - folding the photo modulo that period stacks all tiles on top of each other, and an FFT correlation
 *        with the sync pattern finds where the tile starts and how it's turned (→ any crop, 90° rotations),
 *      - the data cells of the stacked tile give the bits (→ JPEG noise averages out over all tiles).
 *    Per-tile correlation then shows *where* in the photo the pattern was found — the evidence overlay.
 *
 * 2. Pixel layer (proves the file is untouched): lowest bit of every blue value carries version + time + CRC32.
 *    Any re-encode (JPEG, resize) destroys it, so "intact" means "this is the original file".
 */

// ── shared helpers ───────────────────────────────────────────────────────────────────────────────────

const SEED = 0x57a7e2c1; // fixed app-wide seed — changing it orphans every photo taken before

/** Stateless seeded hash of an index → 32 bits (lowbias32 mixer). */
function mix(i: number, seed: number): number {
  let x = (i ^ seed) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

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

/** CRC-16/CCITT of the 24-bit time, salted so an all-zero or all-one read never validates. */
function crc16(v: number): number {
  let c = 0xffff;
  for (const b of [(v >>> 16) & 255, (v >>> 8) & 255, v & 255, 0x57, 0x4d]) {
    c ^= b << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}

const luma = (px: Uint8ClampedArray, o: number) => 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];

// ── tile pattern definition ──────────────────────────────────────────────────────────────────────────

const N = 32; // cells per tile side
const CELLS_PER_LONG_SIDE = 256; // cell = long side / 256 → tile = long side / 8
const BITS = 40; // 24-bit minutes since EPOCH_MIN + CRC16
const EPOCH_MIN = Date.UTC(2025, 0, 1) / 60000; // 24 bits of minutes reach into 2056
const SUB = 4; // folding resolution: bins per cell
const M = N * SUB; // 128 bins per folded tile side

type Tile = { pn: Int8Array; data: Uint8Array; bit: Int8Array };

/** Fixed tile: per cell a ±1 sign, whether it is a data cell, and which payload bit it carries. */
const TILE: Tile = (() => {
  const pn = new Int8Array(N * N);
  const data = new Uint8Array(N * N);
  const bit = new Int8Array(N * N).fill(-1);
  let d = 0;
  for (let k = 0; k < N * N; k++) {
    pn[k] = mix(k, SEED ^ 0x1f3d5b79) & 1 ? 1 : -1;
    if (mix(k, SEED ^ 0x2a4c6e80) & 1) {
      data[k] = 1;
      bit[k] = d++ % BITS;
    }
  }
  return { pn, data, bit };
})();

function payloadBits(time: Date): Uint8Array {
  const t = Math.max(0, Math.min(0xffffff, Math.floor(time.getTime() / 60000) - EPOCH_MIN));
  const c = crc16(t);
  const b = new Uint8Array(BITS);
  for (let i = 0; i < 24; i++) b[i] = (t >>> (23 - i)) & 1;
  for (let i = 0; i < 16; i++) b[24 + i] = (c >>> (15 - i)) & 1;
  return b;
}

/** Cell value of the full pattern (sync ±1, data ±1 by its bit). */
function cellValues(bits: Uint8Array): Float32Array {
  const v = new Float32Array(N * N);
  for (let k = 0; k < N * N; k++) v[k] = TILE.data[k] ? TILE.pn[k] * (bits[TILE.bit[k]] ? 1 : -1) : TILE.pn[k];
  return v;
}

// ── embedding ────────────────────────────────────────────────────────────────────────────────────────

function embedPattern(img: ImageData, time: Date) {
  const { width: w, height: h, data: px } = img;
  const c = Math.max(3, Math.max(w, h) / CELLS_PER_LONG_SIDE);
  const vals = cellValues(payloadBits(time));
  // Amplitude per global cell from local texture: busy areas hide a stronger signal than flat sky.
  const gw = Math.ceil(w / c) + 2;
  const gh = Math.ceil(h / c) + 2;
  const s1 = new Float64Array(gw * gh);
  const s2 = new Float64Array(gw * gh);
  const n = new Float64Array(gw * gh);
  for (let y = 0; y < h; y += 2) {
    const gy = Math.floor(y / c);
    for (let x = 0; x < w; x += 2) {
      const g = gy * gw + Math.floor(x / c);
      const l = luma(px, (y * w + x) * 4);
      s1[g] += l;
      s2[g] += l * l;
      n[g]++;
    }
  }
  const amp = new Float32Array(gw * gh);
  for (let g = 0; g < amp.length; g++) {
    const sd = n[g] ? Math.sqrt(Math.max(0, s2[g] / n[g] - (s1[g] / n[g]) ** 2)) : 0;
    const mean = n[g] ? s1[g] / n[g] : 128;
    const edge = Math.min(1, Math.min(mean, 255 - mean) / 24); // near black/white there's no headroom
    amp[g] = Math.min(4, 1.5 + 0.12 * sd) * (0.4 + 0.6 * edge);
  }
  const V = (gx: number, gy: number) => {
    const k = (((gy % N) + N) % N) * N + (((gx % N) + N) % N);
    const g = Math.min(gh - 1, Math.max(0, gy)) * gw + Math.min(gw - 1, Math.max(0, gx));
    return vals[k] * amp[g];
  };
  // Bilinear between cell centres: a smooth texture with no hard cell edges.
  const gxi = new Int32Array(w);
  const gxf = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const cx = x / c - 0.5;
    gxi[x] = Math.floor(cx);
    gxf[x] = cx - gxi[x];
  }
  for (let y = 0; y < h; y++) {
    const cy = y / c - 0.5;
    const j = Math.floor(cy);
    const fy = cy - j;
    for (let x = 0; x < w; x++) {
      const i = gxi[x];
      const fx = gxf[x];
      const d =
        (1 - fy) * ((1 - fx) * V(i, j) + fx * V(i + 1, j)) + fy * ((1 - fx) * V(i, j + 1) + fx * V(i + 1, j + 1));
      const o = (y * w + x) * 4;
      px[o] += d;
      px[o + 1] += d;
      px[o + 2] += d;
    }
  }
}

// ── FFT (radix-2, in place) ──────────────────────────────────────────────────────────────────────────

function fft(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  if (inverse)
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
}

function fft2(re: Float64Array, im: Float64Array, s: number, inverse = false) {
  const r = new Float64Array(s);
  const i2 = new Float64Array(s);
  for (let y = 0; y < s; y++) {
    r.set(re.subarray(y * s, y * s + s));
    i2.set(im.subarray(y * s, y * s + s));
    fft(r, i2, inverse);
    re.set(r, y * s);
    im.set(i2, y * s);
  }
  for (let x = 0; x < s; x++) {
    for (let y = 0; y < s; y++) {
      r[y] = re[y * s + x];
      i2[y] = im[y * s + x];
    }
    fft(r, i2, inverse);
    for (let y = 0; y < s; y++) {
      re[y * s + x] = r[y];
      im[y * s + x] = i2[y];
    }
  }
}

const nextPow2 = (n: number) => 1 << Math.ceil(Math.log2(Math.max(2, n)));

// ── detection ────────────────────────────────────────────────────────────────────────────────────────

const ANALYSIS = 1024; // detection works on a copy whose long side is at most this

/** Separable (2r+1)² box blur with clamped edges. */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const cl = (v: number, n: number) => (v < 0 ? 0 : v >= n ? n - 1 : v);
  const k = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[o + cl(i, w)];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = acc / k;
      acc += src[o + cl(x + r + 1, w)] - src[o + cl(x - r, w)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += tmp[cl(i, h) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / k;
      acc += tmp[cl(y + r + 1, h) * w + x] - tmp[cl(y - r, h) * w + x];
    }
  }
  return out;
}

/** High-passed brightness at analysis resolution (area-averaged downscale, then minus a 7×7 box blur). */
function residual(img: ImageData, target: number) {
  const { width: W, height: H, data: px } = img;
  const s = Math.min(1, target / Math.max(W, H));
  const w = Math.max(1, Math.round(W * s));
  const h = Math.max(1, Math.round(H * s));
  const Y = new Float32Array(w * h);
  const cnt = new Float32Array(w * h);
  const mx = new Int32Array(W);
  for (let x = 0; x < W; x++) mx[x] = Math.min(w - 1, Math.floor((x * w) / W));
  for (let y = 0; y < H; y++) {
    const row = Math.min(h - 1, Math.floor((y * h) / H)) * w;
    for (let x = 0; x < W; x++) {
      Y[row + mx[x]] += luma(px, (y * W + x) * 4);
      cnt[row + mx[x]]++;
    }
  }
  for (let i = 0; i < Y.length; i++) Y[i] /= cnt[i] || 1;
  const blur = boxBlur(Y, w, h, 3);
  const R = new Float32Array(w * h);
  for (let i = 0; i < R.length; i++) R[i] = Y[i] - blur[i];
  // Local contrast normalisation: divide by the local RMS (17×17), so busy texture doesn't drown the pattern
  // elsewhere and flat areas, where the pattern is clean, count fully.
  const E = new Float32Array(w * h);
  for (let i = 0; i < R.length; i++) E[i] = R[i] * R[i];
  const Eb = boxBlur(E, w, h, 8);
  let mean = 0;
  for (let i = 0; i < Eb.length; i++) mean += Eb[i];
  const floor = (0.05 * mean) / Eb.length + 0.25; // noise floor: don't blow up perfectly flat areas
  for (let i = 0; i < R.length; i++) R[i] = Math.max(-3, Math.min(3, R[i] / Math.sqrt(Eb[i] + floor)));
  return { R, w, h, scale: W / w };
}

/** Average autocorrelation of all rows (axis 0) or columns (axis 1), normalised by overlap. */
function autocorr(R: Float32Array, w: number, h: number, axis: 0 | 1): Float64Array {
  const len = axis === 0 ? w : h;
  const lines = axis === 0 ? h : w;
  const P = nextPow2(2 * len);
  const S = new Float64Array(P);
  const re = new Float64Array(P);
  const im = new Float64Array(P);
  const step = Math.max(1, Math.floor(lines / 512));
  for (let l = 0; l < lines; l += step) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < len; i++) re[i] = axis === 0 ? R[l * w + i] : R[i * w + l];
    fft(re, im);
    for (let i = 0; i < P; i++) S[i] += re[i] * re[i] + im[i] * im[i];
  }
  im.fill(0);
  fft(S, im, true);
  const A = new Float64Array(len);
  for (let i = 0; i < len; i++) A[i] = S[i] / (len - i);
  return A;
}

/** Candidate periods (sub-pixel) from autocorrelation peaks and their harmonics. */
function periodCandidates(A: Float64Array, len: number): number[] {
  const minLag = 12;
  const maxLag = Math.floor(len * 0.75); // a heavy crop may hold barely two tiles
  if (maxLag <= minLag + 4) return [];
  const W = 6;
  const d = new Float64Array(A.length);
  for (let l = minLag; l <= maxLag; l++) {
    let s = 0;
    let n = 0;
    for (let k = l - W; k <= l + W; k++)
      if (Math.abs(k - l) > 2 && k > 0 && k < A.length) {
        s += A[k];
        n++;
      }
    d[l] = A[l] - s / n;
  }
  // Comb score: a true tile period has peaks at T, 2T, 3T…; texture rarely lines up like that.
  let sd = 0;
  for (let l = minLag; l <= maxLag; l++) sd += d[l] * d[l];
  sd = Math.sqrt(sd / (maxLag - minLag + 1)) || 1;
  const at = (x: number) => {
    const i = Math.floor(x);
    const f = x - i;
    return i + 1 <= maxLag ? (d[i] * (1 - f) + d[i + 1] * f) / sd : 0;
  };
  const combs: { T: number; v: number }[] = [];
  for (let T = minLag; T <= maxLag; T += 0.25) {
    let v = 0;
    let K = 0;
    for (let k = 1; k * T <= maxLag; k++) {
      // tolerate ±1 lag of drift per harmonic (the period is not an integer)
      v += Math.max(at(k * T - 1), at(k * T), at(k * T + 1));
      K++;
    }
    if (K === 1) v *= 0.8; // a single peak is weaker evidence than a comb
    combs.push({ T, v: v / Math.sqrt(K) });
  }
  const peaks: { l: number; v: number }[] = [];
  for (let i = 1; i < combs.length - 1; i++)
    if (combs[i].v > combs[i - 1].v && combs[i].v >= combs[i + 1].v) peaks.push({ l: combs[i].T, v: combs[i].v });
  peaks.sort((a, b) => b.v - a.v);
  const refine = (T0: number) => {
    let num = 0;
    let den = 0;
    for (let k = 1; k * T0 <= maxLag; k++) {
      const c = k * T0;
      const r = Math.max(2, Math.round(0.02 * c));
      let best = -1;
      for (let l = Math.max(minLag, Math.round(c) - r); l <= Math.min(maxLag - 1, Math.round(c) + r); l++)
        if (best < 0 || d[l] > d[best]) best = l;
      if (best <= minLag) continue;
      const a = d[best - 1];
      const b = d[best];
      const cc = d[best + 1];
      const den2 = a - 2 * b + cc;
      const pos = best + (den2 < 0 ? (0.5 * (a - cc)) / den2 : 0);
      num += k * pos;
      den += k * k;
    }
    return den ? num / den : T0;
  };
  const out: number[] = [];
  for (const p of peaks) {
    const T = refine(p.l);
    if (!out.some((o) => Math.abs(o - T) / T < 0.02)) out.push(T);
    if (out.length >= 7) break;
  }
  return out;
}

/** Stack every tile on top of each other: mean residual per (x mod Tx, y mod Ty) bin, M×M. */
function fold(R: Float32Array, w: number, h: number, Tx: number, Ty: number) {
  const sum = new Float64Array(M * M);
  const cnt = new Float64Array(M * M);
  const bx = new Int32Array(w);
  for (let x = 0; x < w; x++) bx[x] = Math.floor(((x / Tx) % 1) * M);
  for (let y = 0; y < h; y++) {
    const by = Math.floor(((y / Ty) % 1) * M) * M;
    for (let x = 0; x < w; x++) {
      sum[by + bx[x]] += R[y * w + x];
      cnt[by + bx[x]]++;
    }
  }
  let mean = 0;
  for (let i = 0; i < sum.length; i++) mean += sum[i] = cnt[i] ? sum[i] / cnt[i] : 0;
  mean /= sum.length;
  for (let i = 0; i < sum.length; i++) sum[i] -= mean;
  return sum;
}

/** Rotate a square M×M map by r × 90° clockwise. */
function rot<T extends Float64Array | Int8Array | Uint8Array>(a: T, r: number): T {
  if (r === 0) return a;
  const out = new (a.constructor as { new (n: number): T })(a.length);
  for (let y = 0; y < M; y++)
    for (let x = 0; x < M; x++) {
      let nx = x;
      let ny = y;
      for (let k = 0; k < r; k++) [nx, ny] = [M - 1 - ny, nx];
      out[ny * M + nx] = a[y * M + x];
    }
  return out;
}

/** Bin-resolution maps of the reference tile: sync sign (0 on data cells), data sign, bit index. */
const REF = (() => {
  const sync = new Float64Array(M * M);
  const pn = new Int8Array(M * M);
  const bit = new Int8Array(M * M).fill(-1);
  for (let y = 0; y < M; y++)
    for (let x = 0; x < M; x++) {
      const k = Math.floor(y / SUB) * N + Math.floor(x / SUB);
      const b = y * M + x;
      pn[b] = TILE.pn[k];
      if (TILE.data[k]) bit[b] = TILE.bit[k];
      else sync[b] = TILE.pn[k];
    }
  const rots = [0, 1, 2, 3].map((r) => {
    const s = rot(sync, r);
    const re = Float64Array.from(s);
    const im = new Float64Array(M * M);
    fft2(re, im, M);
    return { re, im, pn: rot(pn, r), bit: rot(bit, r), sync: s };
  });
  return rots;
})();

type Match = { r: number; sx: number; sy: number; psr: number };
const EDGE_W = [0.5, 1, 1, 0.5];

/** Circular cross-correlation of the folded tile with the sync pattern, in all 4 orientations or just `only`. */
function match(F: Float64Array, only?: number): Match {
  const fre = Float64Array.from(F);
  const fim = new Float64Array(M * M);
  fft2(fre, fim, M);
  let best: Match = { r: 0, sx: 0, sy: 0, psr: -Infinity };
  for (let r = 0; r < 4; r++) {
    if (only !== undefined && r !== only) continue;
    const { re, im } = REF[r];
    const cre = new Float64Array(M * M);
    const cim = new Float64Array(M * M);
    for (let i = 0; i < M * M; i++) {
      cre[i] = fre[i] * re[i] + fim[i] * im[i];
      cim[i] = fim[i] * re[i] - fre[i] * im[i];
    }
    fft2(cre, cim, M, true);
    let mx = 0;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < M * M; i++) {
      if (cre[i] > cre[mx]) mx = i;
      s += cre[i];
      s2 += cre[i] * cre[i];
    }
    // Sidelobe statistics exclude the peak's own cell-sized neighbourhood.
    let n = M * M;
    const px = mx % M;
    const py = Math.floor(mx / M);
    for (let dy = -SUB; dy <= SUB; dy++)
      for (let dx = -SUB; dx <= SUB; dx++) {
        const v = cre[((py + dy + M) % M) * M + ((px + dx + M) % M)];
        s -= v;
        s2 -= v * v;
        n--;
      }
    const mean = s / n;
    const sd = Math.sqrt(Math.max(1e-12, s2 / n - mean * mean));
    const psr = (cre[mx] - mean) / sd;
    if (psr > best.psr) best = { r, sx: px, sy: py, psr };
  }
  return best;
}

/** Map a folded bin to the reference tile bin given the match (F[u,v] ≈ Ref_r[u - sx, v - sy]). */
const refBin = (m: Match, u: number, v: number) => ((v - m.sy + M) % M) * M + ((u - m.sx + M) % M);

function decodeBits(F: Float64Array, m: Match) {
  const soft = new Float64Array(BITS);
  const { pn, bit } = REF[m.r];
  for (let v = 0; v < M; v++)
    for (let u = 0; u < M; u++) {
      const b = refBin(m, u, v);
      // Cell centres carry the cleanest signal; the outer ring of bins is blended with the neighbours.
      if (bit[b] >= 0) soft[bit[b]] += F[v * M + u] * pn[b] * EDGE_W[b % M % SUB] * EDGE_W[Math.floor(b / M) % SUB];
    }
  let t = 0;
  let c = 0;
  for (let i = 0; i < 24; i++) t = (t << 1) | (soft[i] > 0 ? 1 : 0);
  for (let i = 0; i < 16; i++) c = (c << 1) | (soft[24 + i] > 0 ? 1 : 0);
  const bits = new Uint8Array(BITS);
  for (let i = 0; i < BITS; i++) bits[i] = soft[i] > 0 ? 1 : 0;
  return { ok: crc16(t) === c, time: new Date((t + EPOCH_MIN) * 60000), bits };
}

export type Evidence = {
  /** Tile grid in source-image pixels: tile (c, r) spans [gx0 + c·tx, +tx) × [gy0 + r·ty, +ty). */
  tx: number;
  ty: number;
  gx0: number;
  gy0: number;
  cols: number;
  rows: number;
  /** Per-tile evidence (row-major cols×rows): z ≳ 3 means the pattern is clearly there; NaN = outside the photo. */
  z: Float32Array;
  /** The pattern of one tile as it lies in the photo (rotation applied), N×N cells of ±1. */
  cells: Float32Array;
  rotation: number; // × 90°
  /** Fraction of the photo's area where the pattern was found. */
  coverage: number;
  /** Expected pattern of one tile (N×N, ±1) and what was read (N×N, −1…1), both in the tile's own orientation. */
  expected: Float32Array;
  read: Float32Array;
  /** Correlation between read and expected cells, 0…1. */
  similarity: number;
  /** Peak-to-sidelobe ratio of the sync match (≥ 8 is a clear detection). */
  psr: number;
};
/** found: the app's sync pattern is clearly there. time: capture time (minute precision) if it could be read. */
export type PatternResult = { found: boolean; time: Date | null; evidence: Evidence | null };

const PSR_MIN = 8;
const REFINE_MIN = 6.5;

/**
 * Try at a ~1024 px analysis size first, then at 1/2 and 1/4 of that: on a heavily cropped photo the cells are
 * large and few tiles fit, and shrinking brings it back to the size the detector is tuned for.
 */
function detectPattern(img: ImageData): PatternResult {
  let last: PatternResult = { found: false, time: null, evidence: null };
  for (const target of [ANALYSIS, ANALYSIS / 2, ANALYSIS / 4]) {
    if (target > Math.max(img.width, img.height) * 1.5 && target !== ANALYSIS) continue;
    const r = detectAt(img, target);
    if (r.found) return r;
    if (!last.evidence || (r.evidence && r.evidence.psr > last.evidence.psr)) last = r;
  }
  return last;
}

function detectAt(img: ImageData, target: number): PatternResult {
  const { R, w, h, scale } = residual(img, target);
  if (w < 48 || h < 48) return { found: false, time: null, evidence: null };
  const cx = periodCandidates(autocorr(R, w, h, 0), w);
  const cy = periodCandidates(autocorr(R, w, h, 1), h);
  type Cand = { Tx: number; Ty: number; m: Match };
  const tried: Cand[] = [];
  const tryPair = (Tx: number, Ty: number, rotation?: number): Cand => {
    const c = { Tx, Ty, m: match(fold(R, w, h, Tx, Ty), rotation) };
    tried.push(c);
    return c;
  };
  for (const Tx of cx) for (const Ty of cy) tryPair(Tx, Ty);
  for (const T of [...cx, ...cy]) tryPair(T, T); // aspect kept: one axis may have a weak peak
  if (!tried.length) return { found: false, time: null, evidence: null };
  // Sub-pixel refinement of the most promising pairs: a period off by 0.5% drifts a whole cell after a few
  // tiles and smears the stack, so the right pair may only stand out once refined.
  tried.sort((a, b) => b.m.psr - a.m.psr);
  let best = tried[0];
  // Measured: every photo that ends up recognised starts ≥ 8 here; photos without the pattern stay < 6.
  for (const start of tried.slice(0, 3).filter((c) => c.m.psr >= REFINE_MIN)) {
    let cur = start;
    for (const step of [0.003, 0.001])
      for (const axis of [0, 1, 0, 1] as const)
        for (let d = -3; d <= 3; d++) {
          if (!d) continue;
          const c =
            axis === 0
              ? tryPair(cur.Tx * (1 + d * step), cur.Ty, cur.m.r)
              : tryPair(cur.Tx, cur.Ty * (1 + d * step), cur.m.r);
          if (c.m.psr > cur.m.psr) cur = c;
        }
    if (cur.m.psr > best.m.psr) best = cur;
    if (best.m.psr >= PSR_MIN * 1.5) break; // clearly found — no need to polish the others
  }
  const { Tx, Ty, m } = best;
  const F = fold(R, w, h, Tx, Ty);
  const dec = decodeBits(F, m);
  const found = m.psr >= PSR_MIN;

  // Expected full pattern in reference-bin space (rotated like the photo), to correlate locally.
  const vals = cellValues(dec.bits);
  const fullRef = new Float64Array(M * M);
  for (let y = 0; y < M; y++)
    for (let x = 0; x < M; x++) fullRef[y * M + x] = vals[Math.floor(y / SUB) * N + Math.floor(x / SUB)];
  const fullRot = rot(fullRef, m.r);

  // Per-tile normalised correlation → z score (≈ N(0,1) without the pattern, cells are the independent units).
  const x0a = ((m.sx / M) * Tx) % Tx;
  const y0a = ((m.sy / M) * Ty) % Ty;
  const nx = Math.ceil((w - x0a) / Tx) + 1;
  const ny = Math.ceil((h - y0a) / Ty) + 1;
  const rp = new Float64Array(nx * ny);
  const rr = new Float64Array(nx * ny);
  const pp = new Float64Array(nx * ny);
  const area = new Float64Array(nx * ny);
  const bx = new Int32Array(w);
  const tix = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    bx[x] = Math.floor(((x / Tx) % 1) * M);
    tix[x] = Math.floor((x - x0a) / Tx) + 1;
  }
  for (let y = 0; y < h; y++) {
    const by = Math.floor(((y / Ty) % 1) * M);
    const tiy = Math.floor((y - y0a) / Ty) + 1;
    for (let x = 0; x < w; x++) {
      const p = fullRot[refBin(m, bx[x], by)];
      const r = R[y * w + x];
      const t = tiy * nx + tix[x];
      rp[t] += r * p;
      rr[t] += r * r;
      pp[t] += p * p;
      area[t]++;
    }
  }
  const cellArea = (Tx / N) * (Ty / N);
  const z = new Float32Array(nx * ny).fill(NaN);
  let hit = 0;
  let total = 0;
  for (let t = 0; t < nx * ny; t++) {
    if (!area[t]) continue;
    const ncc = rr[t] && pp[t] ? rp[t] / Math.sqrt(rr[t] * pp[t]) : 0;
    z[t] = ncc * Math.sqrt(area[t] / cellArea);
    total += area[t];
    if (z[t] >= 3) hit += area[t];
  }
  // One tile's cells as they lie in the photo: the reference rotated like the photo.
  const cells = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) cells[j * N + i] = fullRot[(j * SUB + 1) * M + i * SUB + 1];

  // What was read, cell by cell, brought back into the tile's own orientation for the side-by-side view.
  const read = new Float32Array(N * N);
  const cellN = new Float32Array(N * N);
  for (let v = 0; v < M; v++)
    for (let u = 0; u < M; u++) {
      const b = refBin(m, u, v); // bin in rotated reference space → undo the rotation
      let bxr = b % M;
      let byr = Math.floor(b / M);
      for (let q = 0; q < (4 - m.r) % 4; q++) [bxr, byr] = [M - 1 - byr, bxr];
      const cell = Math.floor(byr / SUB) * N + Math.floor(bxr / SUB);
      read[cell] += F[v * M + u];
      cellN[cell]++;
    }
  let ra = 0;
  let rb = 0;
  let rab = 0;
  for (let k = 0; k < N * N; k++) {
    read[k] /= cellN[k] || 1;
    rab += read[k] * vals[k];
    ra += read[k] * read[k];
    rb += vals[k] * vals[k];
  }
  const sim = ra && rb ? Math.max(0, rab / Math.sqrt(ra * rb)) : 0;
  let mx = 1e-9;
  for (let k = 0; k < N * N; k++) mx = Math.max(mx, Math.abs(read[k]));
  for (let k = 0; k < N * N; k++) read[k] /= mx;

  return {
    found,
    time: found && dec.ok ? dec.time : null,
    evidence: {
      tx: Tx * scale,
      ty: Ty * scale,
      gx0: (x0a - Tx) * scale,
      gy0: (y0a - Ty) * scale,
      cols: nx,
      rows: ny,
      z,
      cells,
      rotation: m.r,
      coverage: total ? hit / total : 0,
      expected: vals,
      read,
      similarity: sim,
      psr: m.psr,
    },
  };
}

// ── pixel layer (LSB of blue): proves the file is the untouched original ─────────────────────────────

const VERSION = 3;
const FRAME_BYTES = 1 + 4 + 4; // [version][unix seconds][crc32]
const FRAME_BITS = FRAME_BYTES * 8;
const LSB_SALT = 0x9e3779b9;

function lsbFrame(time: Date): Uint8Array {
  const f = new Uint8Array(FRAME_BYTES);
  const dv = new DataView(f.buffer);
  f[0] = VERSION;
  dv.setUint32(1, Math.floor(time.getTime() / 1000) >>> 0);
  dv.setUint32(5, crc32(f.subarray(0, 5)));
  return f;
}

function embedLsb(px: Uint8ClampedArray, frame: Uint8Array) {
  const s = (SEED ^ LSB_SALT) >>> 0;
  for (let k = 0, n = px.length >> 2; k < n; k++) {
    const i = k % FRAME_BITS;
    const bit = ((frame[i >> 3] >> (7 - (i & 7))) & 1) ^ (mix(k, s) & 1);
    px[k * 4 + 2] = (px[k * 4 + 2] & 0xfe) | bit;
  }
}

/** True only when the low bits agree almost perfectly — i.e. this file was never re-encoded. */
function lsbIntact(px: Uint8ClampedArray): boolean {
  const s = (SEED ^ LSB_SALT) >>> 0;
  const n = px.length >> 2;
  if (n < FRAME_BITS * 4) return false;
  const tally = new Int32Array(FRAME_BITS);
  for (let k = 0; k < n; k++) tally[k % FRAME_BITS] += (px[k * 4 + 2] & 1) ^ (mix(k, s) & 1) ? 1 : -1;
  const f = new Uint8Array(FRAME_BYTES);
  let agree = 0;
  for (let i = 0; i < FRAME_BITS; i++) {
    if (tally[i] > 0) f[i >> 3] |= 1 << (7 - (i & 7));
    agree += Math.abs(tally[i]);
  }
  const dv = new DataView(f.buffer);
  return f[0] === VERSION && dv.getUint32(5) === crc32(f.subarray(0, 5)) && agree / n > 0.98;
}

// ── public API ───────────────────────────────────────────────────────────────────────────────────────

/** Smallest photo that can carry the pattern (needs a few tiles across). */
export const MIN_PIXELS = 256 * 256;

/** Writes both layers into RGBA pixels in place. The tile pattern first; the pixel layer last (it must stay exact). */
export function embed(img: ImageData, time: Date) {
  embedPattern(img, time);
  embedLsb(img.data, lsbFrame(time));
}

export type VerifyResult = PatternResult & { original: boolean };

export function verify(img: ImageData): VerifyResult {
  const original = lsbIntact(img.data);
  return { ...detectPattern(img), original };
}

export const TILE_CELLS = N;

/** One tile of the app pattern (N×N cells, ±1) as it is written for the given capture time — for illustrations. */
export function tileCells(time: Date): Float32Array {
  return cellValues(payloadBits(time));
}
