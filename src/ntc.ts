// NTC thermistor calculator (/tools/ntc-thermistor/). A thermistor in a divider: a fixed resistor
// from the bias to the pin and the thermistor network from the pin to ground (or the other way
// round), read by comparators or an ADC. Works out the voltage at each threshold temperature, the
// slope there, and the band of temperatures at which a threshold really trips once the parts'
// tolerances are counted. Pure functions, no DOM.
//
// Thermistor models (T in kelvin, T = t + 273.15; R in ohms):
//   Beta:            R(T) = R25 · exp(B · (1/T − 1/298.15)), a straight line in ln R against 1/T
//   Steinhart-Hart:  1/T = A + B·ln R + C·(ln R)³, with A, B, C solved from three R-T points
// Tolerances: R(T) = (1 + δR) · R25 · (R(T)/R25)^(1 + δB), where δR is the R25 tolerance and δB the
// Beta tolerance. For the Beta model this is exactly a Beta of B·(1 + δB); it is also how many
// thermistor makers build the minimum and maximum columns of their R-T tables.
// Network: Rnet = Rseries + (Rntc ∥ Rparallel), either resistor optional.
// Divider fraction of the bias: thermistor low (to ground) f = Rnet / (Rfixed + Rnet);
// thermistor high (to the bias) f = Rfixed / (Rfixed + Rnet).

export type Model = 'beta' | 'points';
export type Position = 'low' | 'high';
export type ThresholdUnit = 'pct' | 'mv';
export type Reference = 'bias' | 'separate';
/** How a threshold is entered: a temperature, or a fixed comparator level in % of the bias or volts. */
export type LevelUnit = 'C' | 'pct' | 'V';

export interface NtcInputs {
  model: Model;
  r25K: number; // kΩ at 25 °C
  beta: number; // K
  betaTo: number; // the Beta value is specified between 25 °C and this temperature, °C
  // Three points from the thermistor's R-T table, for Steinhart-Hart
  p1C: number;
  p1K: number;
  p2C: number;
  p2K: number;
  p3C: number;
  p3K: number;
  r25Tol: number; // ± %
  betaTol: number; // ± %
  position: Position;
  fixedK: number; // the fixed resistor of the divider, kΩ
  parallelK: number; // optional, across the thermistor (NaN = none)
  seriesK: number; // optional, in series with the thermistor network (NaN = none)
  resTol: number; // ± %, each fixed resistor
  biasV: number;
  lowC: number; // thresholds (either may be NaN), in the unit below
  lowUnit: LevelUnit;
  highC: number;
  highUnit: LevelUnit;
  thresholdTol: number; // ± threshold error, in % of the bias or mV
  thresholdUnit: ThresholdUnit;
  reference: Reference; // 'bias': thresholds (or ADC) are fractions of the bias, so its error cancels
  biasTol: number; // ± %, counted only with a separate reference
  adcBits: number; // optional
  adcRefV: number; // optional, ADC full scale; NaN = the bias
  dissipation: number; // optional dissipation constant, mW/°C
  readV: number; // optional: a measured pin voltage to convert to a temperature
  // Design help with two fixed levels: the temperatures they should trip at, and which second
  // resistor to solve along with the fixed one (the other, if entered, is kept as it is).
  targetLowC: number;
  targetHighC: number;
  solveFor: SolveFor;
}

export type SolveFor = 'parallel' | 'series';

export const defaultNtc: NtcInputs = {
  // A 10 kΩ, B25/85 = 3970 K thermistor on a 3.3 V divider with a 10 kΩ resistor. The three-point
  // defaults are the same part: points from its published R-T table (scripts/test-ntc.ts).
  model: 'beta',
  r25K: 10,
  beta: 3970,
  betaTo: 85,
  p1C: -10,
  p1K: 54.9297,
  p2C: 25,
  p2K: 10,
  p3C: 85,
  p3K: 1.0742,
  r25Tol: 1,
  betaTol: 1,
  position: 'low',
  fixedK: 10,
  parallelK: NaN,
  seriesK: NaN,
  resTol: 1,
  biasV: 3.3,
  lowC: 0,
  lowUnit: 'C',
  highC: 45,
  highUnit: 'C',
  thresholdTol: 0.5,
  thresholdUnit: 'pct',
  reference: 'bias',
  biasTol: 2,
  adcBits: NaN,
  adcRefV: NaN,
  dissipation: NaN,
  readV: NaN,
  targetLowC: 0,
  targetHighC: 45,
  solveFor: 'parallel',
};

const T0 = 273.15;
const K25 = 298.15;

/**
 * Steinhart-Hart coefficients from three (°C, Ω) points. Throws if the points are degenerate
 * (two at the same temperature or resistance), where the coefficients are not finite.
 */
export function steinhartHart(points: [number, number][]) {
  const [[t1, r1], [t2, r2], [t3, r3]] = points;
  const L1 = Math.log(r1);
  const L2 = Math.log(r2);
  const L3 = Math.log(r3);
  const y1 = 1 / (t1 + T0);
  const y2 = 1 / (t2 + T0);
  const y3 = 1 / (t3 + T0);
  const g2 = (y2 - y1) / (L2 - L1);
  const g3 = (y3 - y1) / (L3 - L1);
  const C = ((g3 - g2) / (L3 - L2)) / (L1 + L2 + L3);
  const B = g2 - C * (L1 * L1 + L1 * L2 + L2 * L2);
  const A = y1 - (B + L1 * L1 * C) * L1;
  if (![A, B, C].every(Number.isFinite)) throw new Error('Steinhart-Hart: the three points are degenerate.');
  return { A, B, C };
}

/** A thermistor curve: nominal R(T) and its inverse, T in °C, R in ohms. */
export interface Curve {
  r: (tC: number) => number;
  t: (ohms: number) => number;
  r25: number;
}

export function betaCurve(r25: number, beta: number): Curve {
  return {
    r: (tC) => r25 * Math.exp(beta * (1 / (tC + T0) - 1 / K25)),
    t: (ohms) => 1 / (1 / K25 + Math.log(ohms / r25) / beta) - T0,
    r25,
  };
}

export function shCurve(A: number, B: number, C: number): Curve {
  const t = (ohms: number) => {
    const L = Math.log(ohms);
    return 1 / (A + B * L + C * L * L * L) - T0;
  };
  // ln R from 1/T: solve B·x + C·x³ = 1/T − A. Start from the linear (Beta-like) estimate, exact
  // when C = 0, then Newton's method, which works for either sign of C while the curve is monotonic
  // (B + 3C·x² > 0). NaN if it is not.
  const r = (tC: number) => {
    const y = 1 / (tC + T0) - A;
    let x = y / B;
    if (C !== 0)
      for (let n = 0; n < 60; n++) {
        const slope = B + 3 * C * x * x;
        if (!(slope > 0)) return NaN;
        const step = (B * x + C * x * x * x - y) / slope;
        x -= step;
        if (Math.abs(step) < 1e-13 * Math.max(1, Math.abs(x))) break;
      }
    return Math.exp(x);
  };
  return { r, t, r25: r(25) };
}

/** Parameter deviations, as fractions (0.01 = 1 %), plus the threshold error in volts. */
export interface Deltas {
  r25: number;
  beta: number;
  fixed: number;
  parallel: number;
  series: number;
  bias: number;
  threshold: number; // V
}

export const zero: Deltas = { r25: 0, beta: 0, fixed: 0, parallel: 0, series: 0, bias: 0, threshold: 0 };

/** The circuit with resolved values, ohms and volts. */
export interface Circuit {
  curve: Curve;
  position: Position;
  fixed: number;
  parallel: number; // NaN = none
  series: number; // NaN = none
  bias: number;
}

/** Thermistor resistance at tC with the given deviations. */
export const ntcR = (c: Circuit, tC: number, d: Deltas = zero) =>
  (1 + d.r25) * c.curve.r25 * (c.curve.r(tC) / c.curve.r25) ** (1 + d.beta);

const has = (x: number) => Number.isFinite(x) && x > 0;

/** Resistance of the thermistor network (thermistor with its optional parallel and series resistors). */
export function networkR(c: Circuit, rNtc: number, d: Deltas = zero) {
  const rp = has(c.parallel) ? c.parallel * (1 + d.parallel) : Infinity;
  const pp = rp === Infinity ? rNtc : rNtc === Infinity ? rp : (rNtc * rp) / (rNtc + rp);
  return pp + (has(c.series) ? c.series * (1 + d.series) : 0);
}

/** Divider output as a fraction of the bias, for a network resistance. */
export function fractionOf(c: Circuit, rNet: number, d: Deltas = zero) {
  const rf = c.fixed * (1 + d.fixed);
  if (rNet === Infinity) return c.position === 'low' ? 1 : 0;
  return c.position === 'low' ? rNet / (rf + rNet) : rf / (rf + rNet);
}

/** Pin voltage at a temperature. */
export const voltageAt = (c: Circuit, tC: number, d: Deltas = zero) =>
  c.bias * (1 + d.bias) * fractionOf(c, networkR(c, ntcR(c, tC, d), d), d);

/** Current drawn from the bias through the divider at a temperature, A. */
export const currentAt = (c: Circuit, tC: number) => c.bias / (c.fixed + networkR(c, ntcR(c, tC)));

/**
 * Temperature at which the pin reaches `fraction` of the actual bias, with the given deviations.
 * Closed form through the inverse of each step; NaN when the network cannot reach that fraction.
 */
export function temperatureAtFraction(c: Circuit, fraction: number, d: Deltas = zero) {
  if (!(fraction > 0 && fraction < 1)) return NaN;
  const rf = c.fixed * (1 + d.fixed);
  const rNet = c.position === 'low' ? (rf * fraction) / (1 - fraction) : (rf * (1 - fraction)) / fraction;
  const pp = rNet - (has(c.series) ? c.series * (1 + d.series) : 0);
  if (!(pp > 0)) return NaN;
  let rNtc = pp;
  if (has(c.parallel)) {
    const rp = c.parallel * (1 + d.parallel);
    if (!(pp < rp)) return NaN;
    rNtc = (pp * rp) / (rp - pp);
  }
  const r25 = c.curve.r25;
  const nominal = r25 * (rNtc / ((1 + d.r25) * r25)) ** (1 / (1 + d.beta));
  const t = c.curve.t(nominal);
  return Number.isFinite(t) && t > -T0 ? t : NaN;
}

/** Temperature read from a pin voltage (nominal parts). */
export const temperatureAtVoltage = (c: Circuit, volts: number) => temperatureAtFraction(c, volts / c.bias);

/** The tolerance terms that apply to a design, each with its ± size (fractions, or volts for the threshold). */
export interface Term {
  key: keyof Deltas;
  label: string;
  size: number;
}

/**
 * Trip temperature for a threshold set at nominal voltage `vth`, with deviations: the pin reaches
 * vth + threshold error on the actual (possibly off-nominal) bias.
 */
export const tripAt = (c: Circuit, vth: number, d: Deltas) =>
  temperatureAtFraction(c, (vth + d.threshold) / (c.bias * (1 + d.bias)), d);

/** Pin fraction with the thermistor open (the cold limit) and shorted (the hot limit). */
export const openFraction = (c: Circuit, d: Deltas = zero) => fractionOf(c, networkR(c, Infinity, d), d);
export const shortFraction = (c: Circuit, d: Deltas = zero) => fractionOf(c, networkR(c, 0, d), d);

/**
 * When a trip temperature does not exist, which way it ran off: 'cold' if the target lies beyond
 * what the network gives at the coldest (thermistor open), 'hot' if beyond the hottest (shorted).
 */
function runOff(c: Circuit, vth: number, d: Deltas): 'cold' | 'hot' {
  const ft = (vth + d.threshold) / (c.bias * (1 + d.bias));
  const fc = openFraction(c, d);
  const fh = shortFraction(c, d);
  const dir = Math.sign(fc - fh);
  return (ft - fh) * dir <= 0 ? 'hot' : 'cold';
}

const corners = (terms: Term[]) => {
  const out: Deltas[] = [];
  for (let mask = 0; mask < 1 << terms.length; mask++) {
    const d = { ...zero };
    terms.forEach((t, n) => (d[t.key] = mask & (1 << n) ? t.size : -t.size));
    out.push(d);
  }
  return out;
};

/**
 * Lowest and highest trip temperature over every corner of the tolerance box. When some corner has
 * no trip temperature, the end it runs off toward is NaN and flagged (minOut: it runs off colder
 * than the curve reaches; maxOut: hotter); the other end is still reported.
 */
export function worstCase(c: Circuit, vth: number, terms: Term[]) {
  let min = Infinity;
  let max = -Infinity;
  let minOut = false;
  let maxOut = false;
  for (const d of corners(terms)) {
    const tt = tripAt(c, vth, d);
    if (Number.isFinite(tt)) {
      min = Math.min(min, tt);
      max = Math.max(max, tt);
    } else if (runOff(c, vth, d) === 'cold') minOut = true;
    else maxOut = true;
  }
  return {
    min: minOut || min === Infinity ? NaN : min,
    max: maxOut || max === -Infinity ? NaN : max,
    minOut,
    maxOut,
  };
}

/** Largest shift in trip temperature from one term alone, °C (NaN if either end is out of range). */
export function termShift(c: Circuit, vth: number, nominal: number, term: Term) {
  const up = tripAt(c, vth, { ...zero, [term.key]: term.size });
  const down = tripAt(c, vth, { ...zero, [term.key]: -term.size });
  return Math.max(Math.abs(up - nominal), Math.abs(down - nominal));
}

// Standard resistor values, one decade.
const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];
const E96 = [
  1.0, 1.02, 1.05, 1.07, 1.1, 1.13, 1.15, 1.18, 1.21, 1.24, 1.27, 1.3, 1.33, 1.37, 1.4, 1.43, 1.47, 1.5, 1.54, 1.58, 1.62,
  1.65, 1.69, 1.74, 1.78, 1.82, 1.87, 1.91, 1.96, 2.0, 2.05, 2.1, 2.15, 2.21, 2.26, 2.32, 2.37, 2.43, 2.49, 2.55, 2.61, 2.67,
  2.74, 2.8, 2.87, 2.94, 3.01, 3.09, 3.16, 3.24, 3.32, 3.4, 3.48, 3.57, 3.65, 3.74, 3.83, 3.92, 4.02, 4.12, 4.22, 4.32, 4.42,
  4.53, 4.64, 4.75, 4.87, 4.99, 5.11, 5.23, 5.36, 5.49, 5.62, 5.76, 5.9, 6.04, 6.19, 6.34, 6.49, 6.65, 6.81, 6.98, 7.15, 7.32,
  7.5, 7.68, 7.87, 8.06, 8.25, 8.45, 8.66, 8.87, 9.09, 9.31, 9.53, 9.76,
];

/** Nearest standard value to `ohms` (nearest by ratio), from a one-decade series. */
export function nearestStandard(ohms: number, series: 'E24' | 'E96') {
  const base = series === 'E24' ? E24 : E96;
  const decade = 10 ** Math.floor(Math.log10(ohms));
  let best = NaN;
  for (const m of [decade / 10, decade, decade * 10])
    for (const v of base) {
      const x = Number((v * m).toPrecision(3));
      if (!Number.isFinite(best) || Math.abs(Math.log(x / ohms)) < Math.abs(Math.log(best / ohms))) best = x;
    }
  return best;
}

/** The standard values just below and just above `ohms` (both equal to it when it is one). */
export function standardAround(ohms: number, series: 'E24' | 'E96'): [number, number] {
  const base = series === 'E24' ? E24 : E96;
  const decade = 10 ** Math.floor(Math.log10(ohms));
  let below = -Infinity;
  let above = Infinity;
  for (const m of [decade / 10, decade, decade * 10])
    for (const v of base) {
      const x = Number((v * m).toPrecision(3));
      if (x <= ohms * (1 + 1e-9) && x > below) below = x;
      if (x >= ohms * (1 - 1e-9) && x < above) above = x;
    }
  return [below, above];
}

/** A fixed level and the temperature it should trip at. */
export interface LevelTarget {
  fraction: number; // of the bias
  tC: number;
}

export type DividerSolution =
  | { ok: false; error: string }
  | {
      ok: true;
      solveFor: SolveFor;
      fixed: number; // exact, ohms
      other: number; // the parallel or series resistor, exact, ohms (NaN when not needed)
      /**
       * False when the second resistor would do next to nothing (a parallel resistor over 100 times,
       * or a series resistor under 1 % of, the thermistor at the high target): the answer is then
       * the fixed resistor alone, without that resistor.
       */
      needed: boolean;
      /** Nominal trip temperatures with the exact values: the targets, unless the second resistor was left out. */
      trips: [number, number];
      /** The best E96 values next to the exact ones, and the nominal trip temperatures they give. */
      e96: { fixed: number; other: number; trips: [number, number] };
    };

/**
 * Two fixed levels and the temperatures they should trip at: the fixed resistor and a parallel (or
 * series) resistor that put the divider at each level at its temperature, with nominal parts. The
 * circuit's other optional resistor, if any, is kept; its fixed and solved resistors are ignored.
 * At each level Rnet = k·Rfixed, with k = f/(1 − f) for the thermistor to ground and (1 − f)/f for
 * the thermistor to the bias.
 * Parallel: 1/(k·Rfixed − Rseries) = 1/Rntc + 1/Rparallel at both levels; subtracting the two
 * eliminates 1/Rparallel, and Rfixed is found by bisection (closed form without a series resistor).
 * Series: k·Rfixed − (Rntc ∥ Rparallel) = Rseries at both, which is linear in Rfixed.
 */
export function solveDivider(c: Circuit, levels: [LevelTarget, LevelTarget], solveFor: SolveFor): DividerSolution {
  const [a, b] = levels;
  if (![a, b].every((l) => l.fraction > 0 && l.fraction < 1 && Number.isFinite(l.tC)))
    return { ok: false, error: 'Enter two levels and two target temperatures.' };
  if (!(b.tC > a.tC)) return { ok: false, error: 'Set the high target temperature above the low one.' };
  if (a.tC < -55 || b.tC > 150) return { ok: false, error: 'Keep the target temperatures between −55 °C and 150 °C.' };
  const k = (f: number) => (c.position === 'low' ? f / (1 - f) : (1 - f) / f);
  const [k1, k2] = [k(a.fraction), k(b.fraction)];
  const [r1, r2] = [c.curve.r(a.tC), c.curve.r(b.tC)];
  let fixed = NaN;
  let other = NaN;
  if (solveFor === 'parallel') {
    const rs = has(c.series) ? c.series : 0;
    const g = (rf: number) => 1 / (k1 * rf - rs) - 1 / r1 - (1 / (k2 * rf - rs) - 1 / r2);
    // Scan upward from where both legs are positive for a sign change, then bisect it.
    let lo = Math.max(1, (rs / Math.min(k1, k2)) * (1 + 1e-9));
    for (let hi = lo * 1.02; hi < 1e9; lo = hi, hi *= 1.02) {
      if (g(lo) * g(hi) > 0) continue;
      let [x0, x1] = [lo, hi];
      for (let n = 0; n < 100; n++) {
        const mid = (x0 + x1) / 2;
        if (g(x0) * g(mid) <= 0) x1 = mid;
        else x0 = mid;
      }
      const rf = (x0 + x1) / 2;
      const inv = 1 / (k1 * rf - rs) - 1 / r1;
      if (inv > 0) {
        fixed = rf;
        other = 1 / inv;
        break;
      }
    }
    if (!Number.isFinite(fixed))
      return {
        ok: false,
        error: 'No parallel resistor puts both levels at these temperatures. Try solving for a series resistor, or move the targets.',
      };
  } else {
    const q = (r: number) => (has(c.parallel) ? (r * c.parallel) / (r + c.parallel) : r);
    const [q1, q2] = [q(r1), q(r2)];
    fixed = (q1 - q2) / (k1 - k2);
    other = k1 * fixed - q1;
    if (!(fixed > 0 && other > 0))
      return {
        ok: false,
        error: 'No series resistor puts both levels at these temperatures. Try solving for a parallel resistor, or move the targets.',
      };
  }
  // A second resistor that does next to nothing is left out (the network's other resistor, if
  // any, stays).
  const needed = solveFor === 'parallel' ? other <= 100 * r2 : other >= 0.01 * r2;
  if (!needed) other = NaN;
  // The E96 neighbours of each value: keep the pair whose trip temperatures land closest to the targets.
  const tripsWith = (rf: number, ro: number): [number, number] => {
    const cc: Circuit = { ...c, fixed: rf, [solveFor]: ro };
    return [temperatureAtFraction(cc, a.fraction), temperatureAtFraction(cc, b.fraction)];
  };
  let best: { fixed: number; other: number; trips: [number, number] } | null = null;
  let bestErr = Infinity;
  for (const rf of standardAround(fixed, 'E96'))
    for (const ro of needed ? standardAround(other, 'E96') : [NaN]) {
      const trips = tripsWith(rf, ro);
      const err = Math.max(Math.abs(trips[0] - a.tC), Math.abs(trips[1] - b.tC));
      if (err < bestErr) [bestErr, best] = [err, { fixed: rf, other: ro, trips }];
    }
  if (!best) return { ok: false, error: 'The standard values next to the solution do not reach both levels.' };
  return { ok: true, solveFor, fixed, other, needed, trips: tripsWith(fixed, other), e96: best };
}

/** ADC code for a voltage, clamped to 0 … 2^bits − 1. */
export const adcCount = (volts: number, full: number, bits: number) =>
  Math.min(2 ** bits - 1, Math.max(0, Math.round((volts / full) * 2 ** bits)));

export interface Threshold {
  name: 'low' | 'high'; // by temperature: two fixed levels entered the other way round are swapped
  input: 'low' | 'high'; // the field it was entered in
  tC: number; // set temperature, or the nominal trip temperature of a fixed level
  fixedLevel: boolean; // entered as a comparator level, not a temperature
  volts: number;
  fraction: number;
  adc: number; // counts, clamped; NaN without ADC bits
  adcOver: boolean; // the threshold voltage is above the ADC's full scale
  /** Slope at the threshold: V per °C (signed), and its size in % of the bias per °C. */
  slopeV: number;
  slopePct: number;
  slopeCounts: number; // counts per °C, NaN without ADC bits
  min: number; // worst-case trip temperatures, °C (NaN when that end is out of range)
  max: number;
  minOut: boolean;
  maxOut: boolean;
  /** One term alone, ± °C (NaN when out of range), largest first. */
  shifts: { label: string; shift: number }[];
  selfHeat: number; // °C the thermistor runs above its surroundings, NaN without a dissipation constant
}

/**
 * A thermistor fault: where it puts the pin over the resistor and bias tolerances, and how it
 * compares with the threshold on its side (low for open, which reads cold; high for short).
 * 'none': no threshold on that side. 'marginal': the fault's range overlaps the threshold's
 * tolerance band, so it may fail to trip. 'trips': beyond the threshold at every corner.
 */
export interface Fault {
  fraction: number; // nominal
  vMin: number;
  vMax: number;
  atRail: boolean; // pinned to the bias or to ground
  status: 'none' | 'marginal' | 'trips';
}

function fault(c: Circuit, kind: 'open' | 'short', terms: Term[], thresholds: Threshold[]): Fault {
  const circuitTerms = terms.filter((t) => ['fixed', 'parallel', 'series', 'bias'].includes(t.key));
  const at = (d: Deltas) => c.bias * (1 + d.bias) * (kind === 'open' ? openFraction(c, d) : shortFraction(c, d));
  const vs = corners(circuitTerms).map(at);
  const fraction = kind === 'open' ? openFraction(c) : shortFraction(c);
  const out = {
    fraction,
    vMin: Math.min(...vs),
    vMax: Math.max(...vs),
    atRail: fraction <= 0 || fraction >= 1,
  };
  const th = thresholds.find((t) => t.name === (kind === 'open' ? 'low' : 'high'));
  if (!th) return { ...out, status: 'none' };
  const e = terms.find((t) => t.key === 'threshold')?.size ?? 0;
  // Which way the pin moves as the thermistor reads colder.
  const coldUp = c.position === 'low';
  const beyondHigh = out.vMin > th.volts + e; // whole fault range above the whole threshold band
  const beyondLow = out.vMax < th.volts - e;
  const trips = kind === 'open' ? (coldUp ? beyondHigh : beyondLow) : coldUp ? beyondLow : beyondHigh;
  return { ...out, status: trips ? 'trips' : 'marginal' };
}

export type NtcResult =
  | { ok: false; error: string }
  | {
      ok: true;
      circuit: Circuit;
      r25: number; // ohms
      coefficients?: { A: number; B: number; C: number };
      /** Effective Beta between the two thresholds (or 25 °C and the one threshold). */
      betaEffective: number;
      betaSpan: [number, number]; // the two temperatures it is taken between
      thresholds: Threshold[];
      terms: Term[];
      /**
       * Suggested fixed resistor, ohms: the value that maximizes the smaller of the threshold
       * slopes. slopesEqual: the two slopes come out equal there; otherwise it sits at the network
       * resistance of the threshold named in `limitedBy`. slopes: V/°C with the E96 value.
       */
      suggested: {
        ideal: number;
        geometricMean: number;
        e24: number;
        e96: number;
        slopes: number[];
        slopesEqual: boolean;
        limitedBy?: 'low' | 'high';
      };
      /** Beta mode: thresholds more than 10 °C outside the range the Beta value is specified over. */
      outsideBeta: number[];
      open: Fault;
      short: Fault;
      /** Divider current at 25 °C and at the hottest threshold, A. */
      current25: number;
      currentHot: { tC: number; amps: number };
      readT: number; // °C for readV, NaN without it
      /** Worst-case temperature band for the reading, over the same tolerances (threshold error = reading error). */
      readBand: { min: number; max: number; minOut: boolean; maxOut: boolean } | null;
      adcFull: number; // ADC full scale, V
      adcBits: number; // NaN without an ADC
      /** ADC full scale differs from the bias although the reference is set to the bias. */
      adcMismatch: boolean;
      /** Full scale below the bias: the temperature past which the pin exceeds full scale (NaN if never in range). */
      adcClip: { tC: number } | null;
      /** Two fixed levels entered high first: shown, and named, in order of temperature. */
      swapped: boolean;
      /** Two fixed levels: the resistors that put them at the target temperatures. */
      design: DividerSolution | null;
    };

const pct = (x: number) => x / 100;

export function calculate(i: NtcInputs): NtcResult {
  let curve: Curve;
  let coefficients: { A: number; B: number; C: number } | undefined;
  if (i.model === 'points') {
    const pts: [number, number][] = [
      [i.p1C, i.p1K * 1000],
      [i.p2C, i.p2K * 1000],
      [i.p3C, i.p3K * 1000],
    ];
    if (pts.some(([t, r]) => !Number.isFinite(t) || !(r > 0)))
      return { ok: false, error: 'Enter three temperatures and resistances from the thermistor’s table.' };
    pts.sort((a, b) => a[0] - b[0]);
    if (pts[1][0] - pts[0][0] < 5 || pts[2][0] - pts[1][0] < 5)
      return { ok: false, error: 'Spread the three points at least 5 °C apart, ideally across the range you care about.' };
    if (!(pts[0][1] > pts[1][1] && pts[1][1] > pts[2][1]))
      return { ok: false, error: 'For an NTC thermistor, resistance should fall as temperature rises. Check the three points.' };
    coefficients = steinhartHart(pts);
    const { A, B, C } = coefficients;
    curve = shCurve(A, B, C);
    // The fit must give a falling, invertible curve over the whole range the calculator uses.
    const probe = [-55, -20, 25, 70, 150].map((t) => curve.r(t));
    const fits =
      B > 0 &&
      probe.every((r, n) => Number.isFinite(r) && r > 0 && (n === 0 || r < probe[n - 1])) &&
      [-55, 25, 150].every((t) => Math.abs(curve.t(curve.r(t)) - t) < 0.01);
    if (!fits) return { ok: false, error: 'These three points do not fit a thermistor curve. Check for a typing error.' };
  } else {
    if (!(i.r25K > 0)) return { ok: false, error: 'Enter the thermistor’s resistance at 25 °C.' };
    if (!(i.beta >= 1000 && i.beta <= 10000))
      return { ok: false, error: 'Enter the thermistor’s Beta value, typically 3000 to 4500 K.' };
    curve = betaCurve(i.r25K * 1000, i.beta);
  }

  if (!(i.fixedK > 0)) return { ok: false, error: 'Enter the fixed resistor’s value.' };
  if (!(i.biasV > 0)) return { ok: false, error: 'Enter the bias voltage.' };
  if (!Number.isFinite(i.lowC) && !Number.isFinite(i.highC)) return { ok: false, error: 'Enter at least one threshold.' };
  const percentages: [number, string][] = [
    [i.r25Tol, 'R25 tolerance'],
    [i.betaTol, 'Beta tolerance'],
    [i.resTol, 'resistor tolerance'],
  ];
  if (i.thresholdUnit === 'pct') percentages.push([i.thresholdTol, 'threshold error']);
  if (i.reference === 'separate') percentages.push([i.biasTol, 'bias tolerance']);
  for (const [v, name] of percentages) {
    if (!(v >= 0)) return { ok: false, error: `Enter the ${name} (0 if you want to leave it out).` };
    if (!(v < 100)) return { ok: false, error: `The ${name} should be below 100 %.` };
  }
  if (!(i.thresholdTol >= 0)) return { ok: false, error: 'Enter the threshold error (0 if you want to leave it out).' };
  // Optional fields: blank (NaN) is fine; anything entered must make sense.
  for (const [v, name] of [
    [i.parallelK, 'parallel resistor'],
    [i.seriesK, 'series resistor'],
    [i.adcRefV, 'ADC full scale'],
    [i.dissipation, 'dissipation constant'],
  ] as const)
    if (!Number.isNaN(v) && !(v > 0)) return { ok: false, error: `The ${name} should be above zero, or blank for none.` };
  if (!Number.isNaN(i.readV) && !(i.readV >= 0)) return { ok: false, error: 'The reading to convert cannot be negative.' };
  if (!Number.isNaN(i.adcBits) && !(Number.isInteger(i.adcBits) && i.adcBits >= 4 && i.adcBits <= 24))
    return { ok: false, error: 'Enter the ADC resolution as a whole number of bits from 4 to 24, or leave it blank.' };

  const c: Circuit = {
    curve,
    position: i.position,
    fixed: i.fixedK * 1000,
    parallel: has(i.parallelK) ? i.parallelK * 1000 : NaN,
    series: has(i.seriesK) ? i.seriesK * 1000 : NaN,
    bias: i.biasV,
  };

  // Thresholds: a temperature as entered, or a fixed level turned into its nominal trip temperature.
  const set: { name: 'low' | 'high'; input: 'low' | 'high'; tC: number; volts: number; fixedLevel: boolean }[] = [];
  for (const [name, value, unit] of [
    ['low', i.lowC, i.lowUnit],
    ['high', i.highC, i.highUnit],
  ] as const) {
    if (!Number.isFinite(value)) continue;
    if (unit === 'pct' || unit === 'V') {
      const volts = unit === 'V' ? value : (value / 100) * c.bias;
      if (!(volts > 0 && volts < c.bias))
        return { ok: false, error: `Set the ${name} level between 0 and the bias (0 to 100 %).` };
      const tC = temperatureAtFraction(c, volts / c.bias);
      if (!Number.isFinite(tC))
        return { ok: false, error: `This divider never reaches the ${name} level; check the level and the resistor values.` };
      set.push({ name, input: name, tC, volts, fixedLevel: true });
    } else {
      if (value < -55 || value > 150) return { ok: false, error: 'Keep the thresholds between −55 °C and 150 °C.' };
      set.push({ name, input: name, tC: value, volts: voltageAt(c, value), fixedLevel: false });
    }
  }
  // Two fixed levels: which one is the cold limit depends on the divider, so take them in order of
  // the temperatures they trip at, whichever field each was entered in.
  const bothFixed = set.length === 2 && set[0].fixedLevel && set[1].fixedLevel;
  const swapped = bothFixed && set[1].tC < set[0].tC;
  if (swapped) {
    set.reverse();
    set[0].name = 'low';
    set[1].name = 'high';
  }
  if (set.length === 2 && !(set[1].tC > set[0].tC))
    return {
      ok: false,
      error: bothFixed
        ? 'The two levels trip at the same temperature; enter two different levels.'
        : set.some((s) => s.fixedLevel)
          ? `The low threshold trips at ${degC(set[0].tC)} and the high one at ${degC(set[1].tC)}; the high threshold should be the warmer one.`
          : 'Set the high threshold above the low one.',
    };
  const levels = set.map((s) => s.tC);

  const terms: Term[] = [
    { key: 'r25', label: 'Thermistor R25', size: pct(i.r25Tol) },
    { key: 'beta', label: 'Thermistor Beta', size: pct(i.betaTol) },
    { key: 'fixed', label: 'Fixed resistor', size: pct(i.resTol) },
  ];
  if (has(c.parallel)) terms.push({ key: 'parallel', label: 'Parallel resistor', size: pct(i.resTol) });
  if (has(c.series)) terms.push({ key: 'series', label: 'Series resistor', size: pct(i.resTol) });
  if (i.reference === 'separate' && i.biasTol > 0) terms.push({ key: 'bias', label: 'Bias voltage', size: pct(i.biasTol) });
  terms.push({
    key: 'threshold',
    label: 'Threshold error',
    size: i.thresholdUnit === 'mv' ? i.thresholdTol / 1000 : pct(i.thresholdTol) * i.biasV,
  });
  const active = terms.filter((t) => t.size > 0);

  const adcFull = has(i.adcRefV) ? i.adcRefV : i.biasV;
  const bits = Number.isNaN(i.adcBits) ? NaN : i.adcBits;
  const counts = (v: number) => (v / adcFull) * 2 ** bits;

  const thresholds: Threshold[] = [];
  for (const { name, input, tC, volts, fixedLevel } of set) {
    const h = 0.05;
    const slopeV = (voltageAt(c, tC + h) - voltageAt(c, tC - h)) / (2 * h);
    const wc = worstCase(c, volts, active);
    const shifts = active
      .map((t) => ({ label: t.label, shift: termShift(c, volts, tC, t) }))
      .sort((a, b) => (Number.isNaN(a.shift) ? -1 : Number.isNaN(b.shift) ? 1 : b.shift - a.shift));
    // Self-heating: power in the thermistor itself at the threshold.
    const rNtc = ntcR(c, tC);
    const rp = has(c.parallel) ? c.parallel : Infinity;
    const pp = rp === Infinity ? rNtc : (rNtc * rp) / (rNtc + rp);
    const vNtc = currentAt(c, tC) * pp;
    const powerMW = ((vNtc * vNtc) / rNtc) * 1000;
    thresholds.push({
      name,
      input,
      tC,
      fixedLevel,
      volts,
      fraction: volts / c.bias,
      adc: Number.isNaN(bits) ? NaN : adcCount(volts, adcFull, bits),
      adcOver: !Number.isNaN(bits) && volts > adcFull,
      slopeV,
      slopePct: (Math.abs(slopeV) / c.bias) * 100,
      slopeCounts: Math.abs(counts(slopeV)),
      ...wc,
      shifts,
      selfHeat: has(i.dissipation) ? powerMW / i.dissipation : NaN,
    });
  }

  // Suggested fixed resistor: the value that gives the less sensitive threshold the steepest slope
  // it can have (maximin). Each threshold's slope peaks where the fixed resistor equals the
  // network's resistance at that temperature, so the best value lies between the two: where the
  // slopes are equal if that point is between the peaks, otherwise at the weaker threshold's own
  // peak (close thresholds, or a network flattened by a parallel or series resistor). Found by a
  // scan in 0.1 % steps.
  const nets = levels.map((t) => networkR(c, ntcR(c, t)));
  const slopesWith = (fixed: number) =>
    levels.map((t) => {
      const cc = { ...c, fixed };
      return Math.abs(voltageAt(cc, t + 0.05) - voltageAt(cc, t - 0.05)) / 0.1;
    });
  let idealR = nets[0];
  let bestSlope = -Infinity;
  for (let r = Math.min(...nets) / 1.5; nets.length === 2 && r <= Math.max(...nets) * 1.5; r *= 1.001) {
    const s = Math.min(...slopesWith(r));
    if (s > bestSlope) [bestSlope, idealR] = [s, r];
  }
  const atIdeal = slopesWith(idealR);
  const slopesEqual = atIdeal.length === 2 && Math.abs(atIdeal[0] - atIdeal[1]) / Math.max(...atIdeal) < 0.01;
  const weaker = atIdeal.length === 2 && !slopesEqual ? (atIdeal[0] < atIdeal[1] ? 0 : 1) : -1;
  const e96 = nearestStandard(idealR, 'E96');
  const suggested = {
    ideal: idealR,
    geometricMean: nets.length === 2 ? Math.sqrt(nets[0] * nets[1]) : nets[0],
    e24: nearestStandard(idealR, 'E24'),
    e96,
    slopes: slopesWith(e96),
    slopesEqual,
    limitedBy: weaker >= 0 ? thresholds[weaker].name : undefined,
  };

  const span: [number, number] = levels.length === 2 ? [levels[0], levels[1]] : [Math.min(25, levels[0]), Math.max(25, levels[0])];
  const betaEffective =
    span[1] - span[0] < 1
      ? NaN
      : Math.log(curve.r(span[0]) / curve.r(span[1])) / (1 / (span[0] + T0) - 1 / (span[1] + T0));

  const outsideBeta =
    i.model === 'beta' && i.betaTo > 25 ? levels.filter((t) => t < 25 - 10 || t > i.betaTo + 10) : [];

  const hot = Math.max(...levels);
  const adcMismatch = i.reference === 'bias' && has(i.adcRefV) && Math.abs(i.adcRefV - i.biasV) > 1e-6 * i.biasV;
  const adcClip =
    !Number.isNaN(bits) && adcFull < c.bias ? { tC: temperatureAtFraction(c, adcFull / c.bias) } : null;

  return {
    ok: true,
    circuit: c,
    r25: curve.r25,
    coefficients,
    betaEffective,
    betaSpan: span,
    thresholds,
    terms: active,
    suggested,
    outsideBeta,
    open: fault(c, 'open', active, thresholds),
    short: fault(c, 'short', active, thresholds),
    current25: currentAt(c, 25),
    currentHot: { tC: hot, amps: currentAt(c, hot) },
    readT: Number.isNaN(i.readV) ? NaN : temperatureAtVoltage(c, i.readV),
    readBand: Number.isNaN(i.readV) || !(i.readV > 0) ? null : worstCase(c, i.readV, active),
    adcFull,
    adcBits: bits,
    adcMismatch,
    adcClip,
    swapped,
    design: bothFixed
      ? solveDivider(
          c,
          [
            { fraction: thresholds[0].fraction, tC: i.targetLowC },
            { fraction: thresholds[1].fraction, tC: i.targetHighC },
          ],
          i.solveFor === 'series' ? 'series' : 'parallel',
        )
      : null,
  };
}

/** Points for a V–T curve and table, every `step` °C from `from` to `to`. */
export function curvePoints(c: Circuit, from: number, to: number, step: number) {
  const out: { tC: number; ohms: number; volts: number }[] = [];
  for (let t = from; t <= to + 1e-9; t += step) out.push({ tC: t, ohms: ntcR(c, t), volts: voltageAt(c, t) });
  return out;
}

/** A sensible table and chart range around the thresholds, in steps of 5 °C. */
export function rangeFor(levels: number[]) {
  const lo = Math.max(-55, Math.floor((Math.min(...levels) - 20) / 5) * 5);
  const hi = Math.min(150, Math.ceil((Math.max(...levels) + 20) / 5) * 5);
  return { from: lo, to: hi };
}

/** °C with one decimal and a real minus sign; never "−0.0". */
export function degC(n: number) {
  const s = Math.abs(n).toFixed(1);
  return `${n < 0 && s !== '0.0' ? '−' : ''}${s} °C`;
}

/** Volts with three decimals. */
export const volts = (n: number) => `${n.toFixed(3)} V`;

/** Ohms as Ω, kΩ or MΩ, three significant figures. */
export function ohms(n: number): string {
  if (n >= 1e6) return `${Number((n / 1e6).toPrecision(3))} MΩ`;
  if (n >= 1000) return `${Number((n / 1000).toPrecision(3))} kΩ`;
  return `${Number(n.toPrecision(3))} Ω`;
}
