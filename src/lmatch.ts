// L-network impedance matching calculator (/tools/l-network-matching/).
//
// Two reactive parts, one in series and one in shunt, that match a load impedance ZL to a source
// impedance Zs at one frequency: the network presents the conjugate of Zs to the source, so the
// source delivers all its available power. Closed-form solutions for both orientations (the shunt
// part beside the load, or beside the source), up to four in all, then standard part values, the
// loss from the parts' finite Q, the spread from part tolerances, and the return loss across
// frequency, all from the exact two-port (ABCD) response of the network with the parts as fitted.
// Checked by scripts/test-lmatch.ts against worked textbook examples and brute force.
//
// Pure functions, no DOM. Impedances in ohms, frequencies in MHz, part values in henries and farads.

// ---- Complex numbers ----
export interface Cx {
  re: number;
  im: number;
}
export const cx = (re: number, im = 0): Cx => ({ re, im });
export const add = (a: Cx, b: Cx): Cx => cx(a.re + b.re, a.im + b.im);
export const sub = (a: Cx, b: Cx): Cx => cx(a.re - b.re, a.im - b.im);
export const mul = (a: Cx, b: Cx): Cx => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
export const div = (a: Cx, b: Cx): Cx => {
  const d = b.re * b.re + b.im * b.im;
  return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
};
export const inv = (a: Cx): Cx => div(cx(1), a);
export const conj = (a: Cx): Cx => cx(a.re, -a.im);
export const abs = (a: Cx) => Math.hypot(a.re, a.im);

const TWO_PI = 2 * Math.PI;
const omega = (fMHz: number) => TWO_PI * fMHz * 1e6;

// ---- Parts ----
export type Kind = 'L' | 'C' | 'none';
export type Topology = 'shuntLoad' | 'shuntSource';
export interface Part {
  /** 'none': not fitted (a series short or an empty shunt position). */
  kind: Kind;
  /** Henries or farads (NaN for none). */
  value: number;
}
export const NONE: Part = { kind: 'none', value: NaN };

/** The part that gives a series reactance X (Ω) at f: an inductor for X > 0, a capacitor for X < 0. */
export function seriesPart(x: number, fMHz: number, tiny: number): Part {
  if (Math.abs(x) <= tiny) return NONE;
  const w = omega(fMHz);
  return x > 0 ? { kind: 'L', value: x / w } : { kind: 'C', value: -1 / (w * x) };
}
/** The part that gives a shunt susceptance B (S) at f: a capacitor for B > 0, an inductor for B < 0. */
export function shuntPart(b: number, fMHz: number, tiny: number): Part {
  if (Math.abs(b) <= tiny) return NONE;
  const w = omega(fMHz);
  return b > 0 ? { kind: 'C', value: b / w } : { kind: 'L', value: -1 / (w * b) };
}

/**
 * Impedance of a part at f. A finite Q, given at the design frequency f0, becomes a fixed series
 * resistance (ωL/Q for an inductor, 1/(ωCQ) for a capacitor), held constant across frequency.
 * Q of 0, NaN or Infinity means a lossless part. Series 'none' is a short; shunt 'none' is open (NaN).
 */
export function partZ(p: Part, fMHz: number, f0MHz: number, q: number): Cx {
  if (p.kind === 'none') return cx(NaN);
  const w = omega(fMHz);
  const w0 = omega(f0MHz);
  const lossless = !(q > 0) || !Number.isFinite(q);
  if (p.kind === 'L') return cx(lossless ? 0 : (w0 * p.value) / q, w * p.value);
  return cx(lossless ? 0 : 1 / (w0 * p.value * q), -1 / (w * p.value));
}

// ---- Two-port ----
/** ABCD matrix [a, b, c, d] of complex entries. */
type Abcd = [Cx, Cx, Cx, Cx];
const seriesAbcd = (z: Cx): Abcd => [cx(1), z, cx(0), cx(1)];
const shuntAbcd = (y: Cx): Abcd => [cx(1), cx(0), y, cx(1)];
const times = (m: Abcd, n: Abcd): Abcd => [
  add(mul(m[0], n[0]), mul(m[1], n[2])),
  add(mul(m[0], n[1]), mul(m[1], n[3])),
  add(mul(m[2], n[0]), mul(m[3], n[2])),
  add(mul(m[2], n[1]), mul(m[3], n[3])),
];

export interface Network {
  topology: Topology;
  series: Part;
  shunt: Part;
}
export interface Losses {
  /** Series resistances from the parts' Q: inductor Q and capacitor Q at the design frequency. */
  qL: number;
  qC: number;
}
export const LOSSLESS: Losses = { qL: NaN, qC: NaN };

/** The network's ABCD matrix at f, source side first. */
function networkAbcd(n: Network, fMHz: number, f0MHz: number, loss: Losses): Abcd {
  const q = (p: Part) => (p.kind === 'L' ? loss.qL : loss.qC);
  const ser = n.series.kind === 'none' ? seriesAbcd(cx(0)) : seriesAbcd(partZ(n.series, fMHz, f0MHz, q(n.series)));
  const sh = n.shunt.kind === 'none' ? shuntAbcd(cx(0)) : shuntAbcd(inv(partZ(n.shunt, fMHz, f0MHz, q(n.shunt))));
  // shuntLoad: source, series part, shunt part, load. shuntSource: source, shunt part, series part, load.
  return n.topology === 'shuntLoad' ? times(ser, sh) : times(sh, ser);
}

export interface Response {
  /** Impedance seen by the source looking into the network and load. */
  zin: Cx;
  /** Power-wave reflection at the source, (Zin − Zs*)/(Zin + Zs); |Γ|² is the share of the available power not delivered. */
  gamma: number;
  /** Share of the source's available power that reaches the load (transducer gain, ≤ 1). */
  gain: number;
}
/** Exact response of the network between Zs and ZL (both at f). */
export function respond(n: Network, zs: Cx, zl: Cx, fMHz: number, f0MHz: number, loss: Losses): Response {
  const [a, b, c, d] = networkAbcd(n, fMHz, f0MHz, loss);
  const den = add(mul(c, zl), d);
  const zin = div(add(mul(a, zl), b), den);
  const gamma = abs(div(sub(zin, conj(zs)), add(zin, zs)));
  const gain = (4 * zs.re * zl.re) / (abs(add(zs, zin)) ** 2 * abs(den) ** 2);
  return { zin, gamma, gain };
}

export const returnLossDb = (gamma: number) => (gamma > 0 ? -20 * Math.log10(gamma) : Infinity);
export const mismatchLossDb = (gamma: number) => -10 * Math.log10(1 - Math.min(gamma, 1 - 1e-15) ** 2);
export const vswr = (gamma: number) => (gamma < 1 ? (1 + gamma) / (1 - gamma) : Infinity);

// ---- Impedance across frequency ----
/**
 * How a load or source given at f0 is extended to other frequencies: as its resistance with one
 * inductor or capacitor in series ('series'), in parallel ('parallel'), or the same at every
 * frequency ('fixed').
 */
export type LoadModel = 'series' | 'parallel' | 'fixed';
export function impedanceAt(z: Cx, f0MHz: number, fMHz: number, model: LoadModel): Cx {
  if (model === 'fixed' || fMHz === f0MHz) return z;
  const scale = (v: number) => (v > 0 ? (v * fMHz) / f0MHz : (v * f0MHz) / fMHz);
  if (model === 'series') return cx(z.re, scale(z.im));
  const y = inv(z);
  // A shunt capacitor's susceptance (B > 0) grows with frequency; a shunt inductor's (B < 0) shrinks.
  return inv(cx(y.re, scale(y.im)));
}

// ---- The lossless solutions ----
export interface Solution extends Network {
  /** Series reactance (Ω) and shunt susceptance (S) at the design frequency. */
  x: number;
  b: number;
  /**
   * The highest node Q along the match, |X|/R (or |B|/G) at the load, the middle node and the source
   * end: √(Rhigh/Rlow − 1) between two resistances, and at least the load's own Q.
   */
  q: number;
}

/**
 * Every lossless L-network that matches ZL to Zs at f (conjugate match: Zin = Zs*). Shunt beside the
 * load needs Rs·GL ≤ 1; shunt beside the source needs RL·Gs ≤ 1. At least one always holds for
 * positive resistances, so there are two or four solutions (one or two when a square root is zero).
 */
export function solve(zs: Cx, zl: Cx, fMHz: number): Solution[] {
  const out: Solution[] = [];
  const r0 = Math.max(zs.re, zl.re);
  const tinyX = 1e-9 * r0;
  const tinyB = 1e-9 / r0;
  const endQ = Math.max(Math.abs(zl.im) / zl.re, Math.abs(zs.im) / zs.re);
  const push = (topology: Topology, g: number, bOwn: number, rOther: number, xOwnSide: number) => {
    // g, bOwn: conductance and susceptance of the end the shunt part sits beside;
    // rOther, xOwnSide: resistance and reactance of the other end.
    const disc = g / rOther - g * g;
    // A residual of a few ULPs either side of zero is a boundary case (one solution, or a match already).
    if (disc < -1e-12 * g * g) return;
    const root = disc > 1e-12 * g * g ? Math.sqrt(disc) : 0;
    for (const sign of root > 0 ? [1, -1] : [1]) {
      const bNode = sign * root;
      const b = bNode - bOwn;
      const x = (bNode * rOther) / g - xOwnSide;
      out.push({
        topology,
        x,
        b,
        q: Math.max(Math.abs(bNode) / g, endQ),
        series: seriesPart(x, fMHz, tinyX),
        shunt: shuntPart(b, fMHz, tinyB),
      });
    }
  };
  const yl = inv(zl);
  const ys = inv(zs);
  // Shunt beside the load: Zin = jX + 1/(YL + jB).
  push('shuntLoad', yl.re, yl.im, zs.re, zs.im);
  // Shunt beside the source: seen from the load, jX + 1/(Ys + jB) = ZL*.
  push('shuntSource', ys.re, ys.im, zl.re, zl.im);
  return out;
}

// ---- Standard values ----
export type Values = 'exact' | 'E12' | 'E24';
const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];
export const seriesValues = { E12, E24 } as const;

/** The standard values either side of v (one value when v is standard itself). */
export function standardAround(v: number, series: 'E12' | 'E24'): number[] {
  const d = Math.floor(Math.log10(v));
  const list = [d - 1, d, d + 1].flatMap((k) => seriesValues[series].map((m) => Number((m * 10 ** k).toPrecision(3))));
  const below = Math.max(...list.filter((s) => s <= v * (1 + 1e-9)));
  const above = Math.min(...list.filter((s) => s >= v * (1 - 1e-9)));
  return below === above ? [below] : [below, above];
}

// ---- Inputs and the full calculation ----
export type LoadEntry = 'z' | 's11';
/** 'has': the load's own impedance (match to its conjugate). 'wants': the impedance the part should see. */
export type LoadMeans = 'has' | 'wants';
export interface MatchInputs {
  fMHz: number;
  rs: number;
  xs: number;
  loadEntry: LoadEntry;
  rl: number;
  xl: number;
  /** S11 of the load, in dB (negative) and degrees, against refOhm. */
  s11Db: number;
  s11Deg: number;
  refOhm: number;
  loadMeans: LoadMeans;
  loadModel: LoadModel;
  values: Values;
  /** Part Q at the design frequency; blank (NaN) for lossless. */
  qL: number;
  qC: number;
  /** Tolerances: the larger of the absolute (pF, nH) and the percentage applies. */
  tolCpF: number;
  tolCPct: number;
  tolLnH: number;
  tolLPct: number;
  /** Return loss at which the bandwidth is read. */
  rlBwDb: number;
  /** Optional band (MHz) for the worst return loss across it; NaN when not given. */
  bandLoMHz: number;
  bandHiMHz: number;
}

/** 2440 MHz across the 2.4 GHz band, a 50 Ω source and a 10 − j25 Ω load (low resistance, capacitive). */
export const defaultMatch: MatchInputs = {
  fMHz: 2440,
  rs: 50,
  xs: 0,
  loadEntry: 'z',
  rl: 10,
  xl: -25,
  s11Db: -6,
  s11Deg: -120,
  refOhm: 50,
  loadMeans: 'has',
  loadModel: 'series',
  values: 'E24',
  qL: 30,
  qC: 300,
  tolCpF: 0.1,
  tolCPct: 5,
  tolLnH: 0.3,
  tolLPct: 5,
  rlBwDb: 10,
  bandLoMHz: 2400,
  bandHiMHz: 2483.5,
};

/** Load impedance from S11 (dB, degrees) against a reference resistance. */
export function zFromS11(db: number, deg: number, ref: number): Cx {
  const m = 10 ** (db / 20);
  const g = cx(m * Math.cos((deg * Math.PI) / 180), m * Math.sin((deg * Math.PI) / 180));
  return mul(cx(ref), div(add(cx(1), g), sub(cx(1), g)));
}

/** The load the network is designed against: the entered impedance, or the conjugate of the one the part wants to see. */
export function designLoad(i: MatchInputs): Cx {
  const z = i.loadEntry === 's11' ? zFromS11(i.s11Db, i.s11Deg, i.refOhm) : cx(i.rl, i.xl);
  return i.loadMeans === 'wants' ? conj(z) : z;
}

const bandGiven = (i: MatchInputs) => Number.isFinite(i.bandLoMHz) && Number.isFinite(i.bandHiMHz);

export function inputError(i: MatchInputs): string {
  const pos = (n: number) => Number.isFinite(n) && n > 0;
  if (!pos(i.fMHz)) return 'Enter a frequency above zero.';
  if (!pos(i.rs) || !Number.isFinite(i.xs)) return 'Enter the source resistance (above zero) and reactance.';
  if (i.loadEntry === 'z') {
    if (!Number.isFinite(i.rl) || !Number.isFinite(i.xl)) return 'Enter the load resistance and reactance.';
    if (i.rl <= 0) return 'The load needs a resistance above zero: a pure reactance takes no power, so nothing can match it.';
  } else {
    if (!pos(i.refOhm)) return 'Enter the reference impedance the S11 was measured against.';
    if (!Number.isFinite(i.s11Db) || !Number.isFinite(i.s11Deg)) return 'Enter the S11 magnitude in dB and its angle.';
    if (i.s11Db >= 0)
      return 'S11 in dB is below zero for a load that takes any power: for a return loss of 6 dB, enter −6.';
  }
  for (const [n, what] of [
    [i.qL, 'inductor Q'],
    [i.qC, 'capacitor Q'],
  ] as const)
    if (!Number.isNaN(n) && !(Number.isFinite(n) && n > 0)) return `Leave the ${what} blank for an ideal part, or enter a value above zero.`;
  for (const n of [i.tolCpF, i.tolCPct, i.tolLnH, i.tolLPct])
    if (!(Number.isFinite(n) && n >= 0)) return 'Enter each tolerance as zero or more.';
  if (i.tolCPct >= 100 || i.tolLPct >= 100) return 'Enter percentage tolerances below 100%.';
  if (!pos(i.rlBwDb)) return 'Enter the return loss for the bandwidth, in dB above zero.';
  const lo = Number.isFinite(i.bandLoMHz);
  const hi = Number.isFinite(i.bandHiMHz);
  if (lo !== hi) return 'Enter both ends of the band, or leave both blank.';
  if (lo && hi && !(i.bandLoMHz > 0 && i.bandHiMHz > i.bandLoMHz))
    return 'Enter the band as a lower and a higher frequency, both above zero.';
  if (lo && hi && (i.fMHz < i.bandLoMHz || i.fMHz > i.bandHiMHz))
    return 'Put the frequency inside the band, or clear the band to design at the frequency alone.';
  return '';
}

export interface Fit extends Network {
  /** Return loss at the design frequency, with the parts as fitted and their Q. */
  rlDb: number;
  gamma: number;
  mismatchDb: number;
  /** Power lost as heat in the parts (dB), and the total from source to load. */
  partLossDb: number;
  totalLossDb: number;
  /** Contiguous band around f where the return loss stays at or above rlBwDb (NaN when it is not met at f). */
  bwLoMHz: number;
  bwHiMHz: number;
  /** The worst return loss across the entered band (NaN with no band), as fitted and with tolerances. */
  bandRlDb: number;
  bandRlTolDb: number;
  /** The worst return loss at f with the parts anywhere in their tolerances (corners and midpoints). */
  tolRlDb: number;
}

export interface SolutionResult {
  solution: Solution;
  /** The lossless exact parts and the parts as fitted (standard values, or exact). */
  exact: Network;
  fit: Fit;
}

export interface MatchResult {
  ok: true;
  zs: Cx;
  zl: Cx;
  /** Already matched (return loss above 40 dB with no parts). */
  matched: boolean;
  /** Return loss with no network at all. */
  bareRlDb: number;
  solutions: SolutionResult[];
  /** Index of the suggested solution: the widest band, then the best worst case. */
  best: number;
}
export type Result = { ok: false; error: string } | MatchResult;

export const lossesOf = (i: MatchInputs): Losses => ({ qL: i.qL, qC: i.qC });

/**
 * The model the load follows across frequency. An impedance a part should see is a target, not a
 * load, so it is held the same across the band.
 */
export const loadModelOf = (i: MatchInputs): LoadModel => (i.loadMeans === 'wants' ? 'fixed' : i.loadModel);

/** Return loss of a network at f: the source held as entered, the load extended by its model. */
export function rlAt(n: Network, i: MatchInputs, zs: Cx, zl: Cx, fMHz: number): number {
  const r = respond(n, zs, impedanceAt(zl, i.fMHz, fMHz, loadModelOf(i)), fMHz, i.fMHz, lossesOf(i));
  return returnLossDb(r.gamma);
}

/** The points of a band where the return loss is read (ends included). */
const bandPoints = (lo: number, hi: number, n = 41) => Array.from({ length: n }, (_, k) => lo + ((hi - lo) * k) / (n - 1));

function worstInBand(n: Network, i: MatchInputs, zs: Cx, zl: Cx): number {
  if (!bandGiven(i)) return NaN;
  return Math.min(...bandPoints(i.bandLoMHz, i.bandHiMHz).map((f) => rlAt(n, i, zs, zl, f)));
}

/** One edge of the contiguous band around f0 where RL ≥ level: scan outward in 0.25% steps, then bisect. */
function edge(n: Network, i: MatchInputs, zs: Cx, zl: Cx, dir: 1 | -1): number {
  const level = i.rlBwDb;
  const f0 = i.fMHz;
  const limit = dir > 0 ? f0 * 4 : f0 / 4;
  let inside = f0;
  for (let k = 1; k < 2000; k++) {
    const f = dir > 0 ? f0 * 1.0025 ** k : f0 / 1.0025 ** k;
    if (dir > 0 ? f > limit : f < limit) return dir > 0 ? Infinity : 0;
    if (rlAt(n, i, zs, zl, f) < level) {
      let a = inside;
      let b = f;
      for (let j = 0; j < 40; j++) {
        const m = (a + b) / 2;
        if (rlAt(n, i, zs, zl, m) >= level) a = m;
        else b = m;
      }
      return (a + b) / 2;
    }
    inside = f;
  }
  return dir > 0 ? Infinity : 0;
}

/** A part moved by a fraction of its tolerance (−1, 0 or 1). */
export function shifted(p: Part, k: number, i: MatchInputs): Part {
  if (p.kind === 'none' || k === 0) return p;
  const d =
    p.kind === 'C'
      ? Math.max(i.tolCpF * 1e-12, (i.tolCPct / 100) * p.value)
      : Math.max(i.tolLnH * 1e-9, (i.tolLPct / 100) * p.value);
  return { ...p, value: Math.max(p.value * 1e-3, p.value + k * d) };
}
/** The network at each tolerance corner and edge midpoint (the nominal included). */
export function toleranceNetworks(n: Network, i: MatchInputs): Network[] {
  const ks = [-1, 0, 1];
  return ks.flatMap((a) => ks.map((b) => ({ ...n, series: shifted(n.series, a, i), shunt: shifted(n.shunt, b, i) })));
}

function fitOf(n: Network, i: MatchInputs, zs: Cx, zl: Cx): Fit {
  const r = respond(n, zs, zl, i.fMHz, i.fMHz, lossesOf(i));
  const rlDb = returnLossDb(r.gamma);
  const delivered = 1 - r.gamma ** 2;
  const met = rlDb >= i.rlBwDb;
  const tols = toleranceNetworks(n, i);
  return {
    ...n,
    rlDb,
    gamma: r.gamma,
    mismatchDb: mismatchLossDb(r.gamma),
    partLossDb: delivered > 0 ? -10 * Math.log10(Math.min(1, r.gain / delivered)) : NaN,
    totalLossDb: -10 * Math.log10(Math.min(1, r.gain)),
    bwLoMHz: met ? edge(n, i, zs, zl, -1) : NaN,
    bwHiMHz: met ? edge(n, i, zs, zl, 1) : NaN,
    bandRlDb: worstInBand(n, i, zs, zl),
    bandRlTolDb: bandGiven(i) ? Math.min(...tols.map((t) => worstInBand(t, i, zs, zl))) : NaN,
    tolRlDb: Math.min(...tols.map((t) => rlAt(t, i, zs, zl, i.fMHz))),
  };
}

/**
 * The parts as fitted: exact, or the pair of standard values (each part's neighbours below and above)
 * with the best return loss, at f or, with a band, its worst across the band.
 */
export function fitParts(s: Solution, i: MatchInputs, zs: Cx, zl: Cx): Network {
  const exact: Network = { topology: s.topology, series: s.series, shunt: s.shunt };
  if (i.values === 'exact') return exact;
  const series = i.values;
  // Parts too small to buy become a link (series) or an empty position (shunt).
  const options = (p: Part): Part[] => (p.kind === 'none' || isTiny(p) ? [NONE] : standardAround(p.kind === 'L' ? p.value * 1e9 : p.value * 1e12, series).map((v) => ({ kind: p.kind, value: p.kind === 'L' ? v * 1e-9 : v * 1e-12 })));
  const score = (n: Network) => (bandGiven(i) ? worstInBand(n, i, zs, zl) : rlAt(n, i, zs, zl, i.fMHz));
  let best = exact;
  let bestScore = -Infinity;
  for (const a of options(s.series))
    for (const b of options(s.shunt)) {
      const n = { topology: s.topology, series: a, shunt: b };
      const v = score(n);
      if (v > bestScore) {
        best = n;
        bestScore = v;
      }
    }
  return best;
}

export function calculate(i: MatchInputs): Result {
  const error = inputError(i);
  if (error) return { ok: false, error };
  const zs = cx(i.rs, i.xs);
  const zl = designLoad(i);
  if (!(zl.re > 0) || !Number.isFinite(zl.re)) return { ok: false, error: 'That load has no resistance, so nothing can match it.' };
  const bare = abs(div(sub(zl, conj(zs)), add(zl, zs)));
  const bareRlDb = returnLossDb(bare);
  // Solutions can coincide once fitted (a single part, or none when already matched): keep one of
  // each circuit, the better one where two differ only in a single part's value.
  const all: SolutionResult[] = solve(zs, zl, i.fMHz).map((s) => ({
    solution: s,
    exact: { topology: s.topology, series: s.series, shunt: s.shunt },
    fit: fitOf(fitParts(s, i, zs, zl), i, zs, zl),
  }));
  const score = (r: SolutionResult) => (bandGiven(i) ? r.fit.bandRlTolDb : r.fit.tolRlDb);
  const byKey = new Map<string, SolutionResult>();
  for (const r of all) {
    const key = networkKey(r.fit);
    const had = byKey.get(key);
    if (!had || score(r) > score(had)) byKey.set(key, r);
  }
  const solutions = all.filter((r) => byKey.get(networkKey(r.fit)) === r);
  // A load already matched needs no parts: offer that first, and suggest it.
  const matched = bareRlDb >= 40;
  if (matched && !solutions.some((r) => r.fit.series.kind === 'none' && r.fit.shunt.kind === 'none')) {
    const none: Network = { topology: 'shuntLoad', series: NONE, shunt: NONE };
    const q = Math.max(Math.abs(zl.im) / zl.re, Math.abs(zs.im) / zs.re);
    solutions.unshift({ solution: { ...none, x: 0, b: 0, q }, exact: none, fit: fitOf(none, i, zs, zl) });
  }
  // Suggested: the widest band at the bandwidth level (or, with a band, the best worst case across
  // it with tolerances), then the best return loss at the tolerance corners.
  const width = (r: SolutionResult) => (Number.isFinite(r.fit.bwLoMHz) ? Math.min(r.fit.bwHiMHz, 4 * i.fMHz) - r.fit.bwLoMHz : -1);
  const key = (r: SolutionResult) => (bandGiven(i) ? [r.fit.bandRlTolDb, r.fit.tolRlDb] : [width(r), r.fit.tolRlDb]);
  let best = 0;
  if (!matched) solutions.forEach((r, n) => {
    const [a, b] = key(r);
    const [c, d] = key(solutions[best]);
    const tie = Math.abs(c) * 1e-6 + 1e-9;
    if (a > c + tie || (Math.abs(a - c) <= tie && b > d)) best = n;
  });
  return { ok: true, zs, zl, matched, bareRlDb, solutions, best };
}

/** The circuit a network is, for spotting duplicates: orientation only matters with both parts fitted. */
export function networkKey(n: Network): string {
  if (n.series.kind === 'none' && n.shunt.kind === 'none') return 'none';
  // One part: the orientation doesn't matter, and two values of the same part are near duplicates.
  if (n.shunt.kind === 'none') return `series ${n.series.kind}`;
  if (n.series.kind === 'none') return `shunt ${n.shunt.kind}`;
  const part = (p: Part) => `${p.kind}${p.value.toPrecision(9)}`;
  return `${n.topology}/${part(n.series)}/${part(n.shunt)}`;
}

// ---- Describing a network ----
/** Below these a part is too small to buy and is left out when fitting standard values. */
export const TINY = { c: 0.05e-12, l: 0.2e-9 };
export const isTiny = (p: Part) => (p.kind === 'C' ? p.value < TINY.c : p.kind === 'L' ? p.value < TINY.l : false);
/** Values below these are about the size of the pads', trace's and part's own parasitics. */
export const SMALL = { c: 0.5e-12, l: 1e-9 };
export const isSmall = (p: Part) => (p.kind === 'C' ? p.value < SMALL.c : p.kind === 'L' ? p.value < SMALL.l : false);
/** Filter character: series inductor with shunt capacitor is low-pass; series capacitor with shunt inductor high-pass. */
export function character(n: Network): 'low-pass' | 'high-pass' | '' {
  if (n.series.kind === 'L' && n.shunt.kind === 'C') return 'low-pass';
  if (n.series.kind === 'C' && n.shunt.kind === 'L') return 'high-pass';
  return '';
}

/** Intermediate impedances (lossless, at f) from the load to the source end, for drawing the path on a Smith chart. */
export function smithPath(n: Network, zl: Cx, fMHz: number, steps = 48): Cx[][] {
  const w = omega(fMHz);
  const xOf = (p: Part) => (p.kind === 'none' ? 0 : p.kind === 'L' ? w * p.value : -1 / (w * p.value));
  const bOf = (p: Part) => (p.kind === 'none' ? 0 : p.kind === 'C' ? w * p.value : -1 / (w * p.value));
  const x = xOf(n.series);
  const b = bOf(n.shunt);
  const ramp = (f: (t: number) => Cx) => Array.from({ length: steps + 1 }, (_, k) => f(k / steps));
  if (n.topology === 'shuntLoad') {
    // Shunt part first (constant conductance), then the series part (constant resistance).
    const yl = inv(zl);
    const first = ramp((t) => inv(add(yl, cx(0, b * t))));
    const mid = first[first.length - 1];
    return [first, ramp((t) => add(mid, cx(0, x * t)))];
  }
  const first = ramp((t) => add(zl, cx(0, x * t)));
  const mid = inv(first[first.length - 1]);
  return [first, ramp((t) => inv(add(mid, cx(0, b * t))))];
}

// ---- Formatting ----
/** n to p significant figures; trim drops trailing zeros. */
export function num(n: number, trim = false, p = 3): string {
  if (!Number.isFinite(n)) return '–';
  const r = Number(n.toPrecision(p));
  if (r === 0) return '0';
  const decimals = Math.max(0, p - 1 - Math.floor(Math.log10(Math.abs(r))));
  const s = r.toFixed(Math.min(decimals, 20));
  return !trim || !s.includes('.') ? s : s.replace(/\.?0+$/, '');
}

const prefixes: [number, string][] = [
  [1e6, 'M'],
  [1e3, 'k'],
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'µ'],
  [1e-9, 'n'],
  [1e-12, 'p'],
  [1e-15, 'f'],
];
/** A value with an SI prefix, rounded before choosing so 999.7 reads "1.00 k". */
export function si(n: number, unit: string, p = 3, trim = false): string {
  if (!Number.isFinite(n)) return '–';
  const r = Number(n.toPrecision(p));
  if (Math.abs(r) < 1e-18) return `0 ${unit}`;
  const [f, pre] = prefixes.find(([f]) => Math.abs(r) >= f * (1 - 1e-12)) ?? prefixes[prefixes.length - 1];
  return `${num(r / f, trim, p)} ${pre}${unit}`;
}
/**
 * A part's value as RF parts are listed: pF below 1 nF and nH below 1 µH ("0.56 pF", "2.7 nH"), SI
 * prefixes above. Trims zeros for standard values.
 */
export function partValue(p: Part, trim = false): string {
  if (p.kind === 'none') return 'none';
  const [small, f, unit] = p.kind === 'L' ? [1e-6, 1e-9, 'nH'] : [1e-9, 1e-12, 'pF'];
  if (Number(p.value.toPrecision(3)) >= small) return si(p.value, p.kind === 'L' ? 'H' : 'F', 3, trim);
  return `${num(p.value / f, trim, 3)} ${unit}`;
}
/** An impedance as "20 − j15 Ω". */
export function zText(z: Cx, p = 3): string {
  const im = Math.abs(z.im) < 1e-9 * Math.max(1, Math.abs(z.re)) ? 0 : z.im;
  return `${num(z.re, true, p)} ${im < 0 ? '−' : '+'} j${num(Math.abs(im), true, p)} Ω`;
}
