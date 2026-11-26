// Voltage divider calculator (/tools/voltage-divider/). Two resistors, R1 from the input to the pin and R2
// from the pin to ground, used one of two ways:
//   'scale': divide a known input down to a pin, often an ADC input. Vpin = Vin · R2/(R1 + R2) − Ipin · (R1 ∥ R2)
//   'set':   a pin with a fixed reference or threshold (regulator feedback, enable or undervoltage lockout,
//            a comparator) sets the input level at which it acts.  Level = Vpin · (1 + R1/R2) + Ipin · R1
// Ipin is the current flowing into the pin (leakage or bias), taken as ± its size.
// It finds standard-value pairs for a target, then gives the worst case (every corner of the resistor
// tolerance and temperature coefficient, the pin current and the reference tolerance) and a root-sum-square
// estimate. For an ADC it adds the reading error referred to the input, the sampling capacitor's settling
// through the divider's source resistance, and the charge a capacitor across R2 gives up to each sample.
// Pure functions, no DOM.

export type Mode = 'scale' | 'set';
export type Pick = 'find' | 'own';
export type Series = 'E12' | 'E24' | 'E48' | 'E96' | 'E192';

export interface DividerInputs {
  mode: Mode;
  pick: Pick;
  vinV: number; // scale: the input voltage
  pinV: number; // set: the pin's reference or threshold voltage
  pinTol: number; // set: ± % of the pin voltage
  targetV: number; // find: the pin voltage (scale) or the input level (set) wanted
  series: Series;
  currentUA: number; // find: divider current wanted, µA
  r1K: number; // top resistor, kΩ
  r2K: number; // bottom resistor, kΩ
  choice: number; // find: which of the listed pairs is in use (0 = the best)
  resTol: number; // ± %, each resistor
  tcr: number; // ± ppm/°C, each resistor
  tMinC: number;
  tMaxC: number;
  pinUA: number; // ± current into the pin, µA
  // ADC reading the pin (scale mode). Bits NaN = no ADC.
  adcBits: number;
  adcRefV: number;
  adcRefTol: number; // ± %, optional
  adcErrLsb: number; // ± LSB, total unadjusted error, optional (NaN = ideal, ± ½ LSB)
  sampleCpF: number; // sampling capacitor, pF
  switchK: number; // optional: ADC's internal switch resistance, kΩ
  sampleUs: number; // optional: sampling (acquisition) time, µs
  capNF: number; // optional: capacitor from the pin to ground, nF
  rateKsps: number; // optional: conversions per second on this pin, thousands
}

export const defaultDivider: DividerInputs = {
  mode: 'scale',
  pick: 'find',
  vinV: 12,
  pinV: 0.8,
  pinTol: 1,
  targetV: 3,
  series: 'E96',
  currentUA: 100,
  r1K: 30,
  r2K: 10,
  choice: 0,
  resTol: 1,
  tcr: 100,
  tMinC: -40,
  tMaxC: 85,
  pinUA: 0.1,
  adcBits: 12,
  adcRefV: 3.3,
  adcRefTol: NaN,
  adcErrLsb: NaN,
  sampleCpF: 5,
  switchK: NaN,
  sampleUs: 5,
  capNF: NaN,
  rateKsps: NaN,
};

// Standard values (IEC 60063), one decade. E48 and E96 follow round(10^(i/n), 2 decimals) exactly; E192
// does too except 9.20 (the formula gives 9.19). E12 is every other E24 value, E48 every other E96 value.
const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];
const geometric = (n: number) => Array.from({ length: n }, (_, i) => Math.round(100 * 10 ** (i / n)) / 100);
const E192 = geometric(192).map((v) => (v === 9.19 ? 9.2 : v));
export const seriesValues: Record<Series, number[]> = {
  E12: E24.filter((_, i) => i % 2 === 0),
  E24,
  E48: geometric(48),
  E96: geometric(96),
  E192,
};

/** Standard values from 1 Ω to 10 MΩ. */
export function standardList(series: Series) {
  const out: number[] = [];
  for (let d = 0; d <= 6; d++) for (const v of seriesValues[series]) out.push(Number((v * 10 ** d).toPrecision(3)));
  out.push(1e7);
  return out;
}

/** The standard values just below and just above `ohms` (both equal to it when it is one). */
export function standardAround(ohms: number, series: Series): [number, number] {
  let below = NaN;
  let above = NaN;
  for (const x of standardList(series)) {
    if (x <= ohms * (1 + 1e-9)) below = x;
    if (x >= ohms * (1 - 1e-9) && Number.isNaN(above)) above = x;
  }
  return [below, above];
}

export const isStandard = (ohms: number, series: Series) => standardList(series).some((x) => Math.abs(x / ohms - 1) < 1e-9);

/** The circuit with resolved values: ohms, volts, amps. `source` is Vin (scale) or the pin voltage (set). */
export interface Circuit {
  mode: Mode;
  source: number;
  r1: number;
  r2: number;
}

/** Deviations from nominal: fractions for the resistors and the pin voltage, amps for the pin current. */
export interface Deltas {
  r1: number;
  r2: number;
  pin: number; // set mode: the reference or threshold
  ip: number;
}
export const zero: Deltas = { r1: 0, r2: 0, pin: 0, ip: 0 };

export const parallel = (a: number, b: number) => (a * b) / (a + b);

/** The divider's result: the pin voltage (scale) or the input level (set). */
export function evaluate(c: Circuit, d: Deltas = zero) {
  const r1 = c.r1 * (1 + d.r1);
  const r2 = c.r2 * (1 + d.r2);
  if (c.mode === 'scale') return (c.source * r2) / (r1 + r2) - d.ip * parallel(r1, r2);
  return c.source * (1 + d.pin) * (1 + r1 / r2) + d.ip * r1;
}

/** Current through R1 at nominal, amps (scale: from the input; set: at the nominal level). */
export const dividerCurrent = (c: Circuit) => (c.mode === 'scale' ? c.source / (c.r1 + c.r2) : c.source / c.r2);

/** Ratio of the top resistor to the bottom one that gives `target`. */
export const idealRatio = (mode: Mode, source: number, target: number) =>
  mode === 'scale' ? source / target - 1 : target / source - 1;

export interface Candidate {
  r1: number;
  r2: number;
  value: number; // nominal pin voltage (scale) or level (set)
  errorPct: number; // against the target
  currentA: number;
}

/** How far each side of the wanted current a pair may land, as a factor. */
export const CURRENT_WINDOW = 2;

/**
 * Standard pairs that come closest to the target with a divider current within a factor of
 * CURRENT_WINDOW of the one wanted. Ranked by error (to the nearest 0.01 %), then by how close the
 * current is. Every bottom resistor in range is tried with the standard values either side of the
 * ideal top resistor.
 */
export function findPairs(mode: Mode, source: number, target: number, series: Series, currentA: number, count = 5): Candidate[] {
  const ratio = idealRatio(mode, source, target);
  const list = standardList(series);
  const found: Candidate[] = [];
  for (const r2 of list) {
    for (const r1 of new Set(standardAround(r2 * ratio, series))) {
      if (!Number.isFinite(r1)) continue;
      const c: Circuit = { mode, source, r1, r2 };
      const i = dividerCurrent(c);
      if (i > currentA * CURRENT_WINDOW || i < currentA / CURRENT_WINDOW) continue;
      const value = evaluate(c);
      found.push({ r1, r2, value, errorPct: (value / target - 1) * 100, currentA: i });
    }
  }
  const score = (p: Candidate) => Math.round(Math.abs(p.errorPct) * 100);
  found.sort((a, b) => score(a) - score(b) || Math.abs(Math.log(a.currentA / currentA)) - Math.abs(Math.log(b.currentA / currentA)));
  return found.slice(0, count);
}

/** One source of error and the worst shift it gives on its own, in volts of the result. */
export interface Term {
  key: 'tol' | 'tcr' | 'ip' | 'pin';
  shift: number; // worst |shift| from this term alone (both resistors where it applies)
  rss: number[]; // independent parts, for the root sum square
}

/** Worst |shift| of the result over the corners of `vary`, everything else nominal. */
function cornerShift(c: Circuit, nominal: number, vary: Partial<Deltas>[]) {
  let worst = 0;
  for (const d of vary) worst = Math.max(worst, Math.abs(evaluate(c, { ...zero, ...d }) - nominal));
  return worst;
}
const pm = (k: keyof Deltas, x: number): Partial<Deltas>[] => [{ [k]: x }, { [k]: -x }];
const both = (x: number): Partial<Deltas>[] => [
  { r1: x, r2: -x },
  { r1: -x, r2: x },
  { r1: x, r2: x },
  { r1: -x, r2: -x },
];

export interface Spread {
  terms: Term[];
  min: number;
  max: number;
  rss: number; // ± volts
}

/**
 * Worst case: each resistor anywhere within ±(tolerance + TCR · the largest step from 25 °C), the pin
 * current anywhere within ±its size, the pin voltage within ±its tolerance. The result is monotonic in
 * each, so the extremes are at the 16 corners.
 */
export function spread(c: Circuit, tol: number, tcrPpm: number, tMinC: number, tMaxC: number, ipA: number, pinTol: number): Spread {
  const nominal = evaluate(c);
  const drift = tcrPpm * 1e-6 * Math.max(Math.abs(tMinC - 25), Math.abs(tMaxC - 25));
  const res = tol + drift;
  const pinT = c.mode === 'set' ? pinTol : 0;
  let min = Infinity;
  let max = -Infinity;
  for (const s1 of [-1, 1])
    for (const s2 of [-1, 1])
      for (const sp of [-1, 1])
        for (const si of [-1, 1]) {
          const v = evaluate(c, { r1: s1 * res, r2: s2 * res, pin: sp * pinT, ip: si * ipA });
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
  const one = (vary: Partial<Deltas>[]) => cornerShift(c, nominal, vary);
  const terms: Term[] = [
    { key: 'tol', shift: one(both(tol)), rss: [one(pm('r1', tol)), one(pm('r2', tol))] },
    { key: 'tcr', shift: one(both(drift)), rss: [one(pm('r1', drift)), one(pm('r2', drift))] },
    { key: 'ip', shift: one(pm('ip', ipA)), rss: [one(pm('ip', ipA))] },
  ];
  if (c.mode === 'set') terms.push({ key: 'pin', shift: one(pm('pin', pinT)), rss: [one(pm('pin', pinT))] });
  const rss = Math.sqrt(terms.flatMap((t) => t.rss).reduce((s, x) => s + x * x, 0));
  return { terms, min, max, rss };
}

/** Worst case ± as a % of nominal for a resistor tolerance, the other terms as given (for the table). */
export function spreadPctWith(c: Circuit, i: DividerInputs, tolPct: number) {
  const s = spread(c, tolPct / 100, i.tcr, i.tMinC, i.tMaxC, i.pinUA * 1e-6, i.pinTol / 100);
  const n = evaluate(c);
  return (Math.max(s.max - n, n - s.min) / n) * 100;
}

export interface AdcResult {
  lsbV: number; // at the pin
  lsbInV: number; // referred to the input
  terms: { key: 'divider' | 'ref' | 'adc' | 'sample'; shift: number }[]; // ± volts at the input
  worstInV: number; // ± volts at the input, every term at its worst at once
  sourceOhm: number; // R1 ∥ R2
  tau: number; // without a pin capacitor: (source + switch) · sampling capacitor, s
  settleS: number; // without a pin capacitor: time to settle the largest step to ½ LSB, s
  settled: boolean | undefined; // sampling error within ½ LSB; undefined when nothing could be checked
  stepV: number; // largest step the sampling capacitor may need to make
  sampleErrV: number; // at the pin
  droopV: number; // pin capacitor: steady droop before each conversion, from repeated conversions
  kickV: number; // pin capacitor: the drop when one conversion first shares charge with it
  capNeededF: number; // pin capacitor that keeps one sample's kick (before any recovery) within ½ LSB
  capTau: number; // source resistance × pin capacitor, s (NaN without one)
  capSettleS: number; // that capacitor settling to ½ LSB after a step, s
  cornerHz: number; // the low-pass corner it makes with the source resistance
  clipsAt: number; // the input at which the pin reaches the reference, nominal parts
  clipsAtWorst: number; // the same with the parts and the reference at their worst
  clips: boolean; // the worst-case pin voltage is above the lowest reference
}

/**
 * How the errors of the pin capacitor C1 and the sampling capacitor C2 (each from the settled pin voltage)
 * evolve over a sampling time ts: [e1, e2] → M · [e1, e2]. C1 charges from the source through rs; C2 is
 * joined to C1 through the switch resistance rw. With rw = 0 the two share charge at once, then recover
 * together through rs. Otherwise M = e^(A·ts) for the two-capacitor network, from its two real eigenvalues.
 */
export function sampleWindow(rs: number, rw: number, c1: number, c2: number, ts: number): number[][] {
  if (!(rw > 0)) {
    const d = Math.exp(-ts / (rs * (c1 + c2)));
    const a = (d * c1) / (c1 + c2);
    const b = (d * c2) / (c1 + c2);
    return [
      [a, b],
      [a, b],
    ];
  }
  const a11 = -1 / (rs * c1) - 1 / (rw * c1);
  const a12 = 1 / (rw * c1);
  const a21 = 1 / (rw * c2);
  const a22 = -1 / (rw * c2);
  const tr = a11 + a22;
  const det = a11 * a22 - a12 * a21;
  const l1 = tr / 2 - Math.sqrt(Math.max(0, (tr * tr) / 4 - det)); // the fast one, most negative
  const l2 = det / l1; // the slow one, computed without cancellation
  const e1 = Math.exp(l1 * ts);
  const e2 = Math.exp(l2 * ts);
  const k = l1 - l2;
  return [
    [(e1 * (a11 - l2) - e2 * (a11 - l1)) / k, ((e1 - e2) * a12) / k],
    [((e1 - e2) * a21) / k, (e1 * (a22 - l2) - e2 * (a22 - l1)) / k],
  ];
}

/** The input at which the worst-case pin voltage reaches `ref` (bisection; the worst case rises with the input). */
function clipInput(c: Circuit, i: DividerInputs, ref: number) {
  const worstMax = (vin: number) => spread({ ...c, source: vin }, i.resTol / 100, i.tcr, i.tMinC, i.tMaxC, i.pinUA * 1e-6, 0).max;
  let lo = 0;
  let hi = (ref * (c.r1 + c.r2)) / c.r2;
  while (worstMax(hi) < ref) hi *= 2;
  for (let n = 0; n < 60; n++) {
    const mid = (lo + hi) / 2;
    if (worstMax(mid) < ref) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Error in reading the input with an ADC on the pin, worst case, referred to the input. */
export function adcReading(c: Circuit, i: DividerInputs, s: Spread): AdcResult {
  const bits = i.adcBits;
  const ref = i.adcRefV;
  const k = c.r2 / (c.r1 + c.r2);
  const vpin = evaluate(c);
  const lsbV = ref / 2 ** bits;
  const half = lsbV / 2;
  const sourceOhm = parallel(c.r1, c.r2);
  const csh = i.sampleCpF * 1e-12;
  const rsw = Number.isFinite(i.switchK) ? i.switchK * 1e3 : 0;
  const tau = (sourceOhm + rsw) * csh;
  // The sampling capacitor may be left anywhere from 0 to the reference by the previous conversion.
  const stepV = Math.max(vpin, ref - vpin);
  const settleS = tau * Math.log(stepV / half);
  const halfLsbLn = (bits + 1) * Math.LN2; // ln(2^(N+1)): a full-reference step to ½ LSB
  const ts = i.sampleUs * 1e-6;
  const hasTs = Number.isFinite(ts) && ts > 0;
  const cext = Number.isFinite(i.capNF) && i.capNF > 0 ? i.capNF * 1e-9 : 0;
  let sampleErrV = 0;
  let capTau = NaN;
  let capSettleS = NaN;
  let cornerHz = NaN;
  let droopV = 0;
  let kickV = 0;
  if (cext > 0) {
    // The pin capacitor C1 (from the source through Rsource) and the sampling capacitor C2 (through the
    // switch resistance) during the sampling time; errors are taken from the settled pin voltage. Before a
    // conversion the pin has drooped by e0 and the sampling capacitor is stepV away. Between conversions the
    // pin recovers through Rsource alone, so with conversions every T the droop settles where
    // e0 = (pin error after sampling) · e^(−(T − ts)/(Rsource · C1)).
    capTau = sourceOhm * cext;
    capSettleS = capTau * halfLsbLn;
    cornerHz = 1 / (2 * Math.PI * capTau);
    kickV = (stepV * csh) / (csh + cext);
    const m = sampleWindow(sourceOhm, rsw, cext, csh, hasTs ? ts : 0);
    const rate = i.rateKsps * 1e3;
    const g = Number.isFinite(rate) && rate > 0 ? Math.exp(-(1 / rate - (hasTs ? ts : 0)) / capTau) : 0;
    droopV = (m[0][1] * stepV * g) / (1 - m[0][0] * g);
    sampleErrV = m[1][0] * droopV + m[1][1] * stepV;
  } else if (hasTs) {
    sampleErrV = stepV * Math.exp(-ts / tau);
  }
  const nominalIn = c.source;
  const r = Number.isFinite(i.adcRefTol) ? i.adcRefTol / 100 : 0;
  const divider = Math.max(s.max - vpin, vpin - s.min) / k;
  const refT = (r / (1 - r)) * nominalIn;
  const adcV = Number.isFinite(i.adcErrLsb) ? i.adcErrLsb * lsbV : half;
  const adc = adcV / k;
  const sample = sampleErrV / k;
  // Firmware reads Vin = code · LSB / k with the nominal reference; the code follows Vpin / Vref(actual).
  // The total takes every term at its worst at once, exactly rather than as a sum.
  const readHigh = ((s.max + sampleErrV) / (1 - r) + adcV) / k;
  const readLow = ((s.min - sampleErrV) / (1 + r) - adcV) / k;
  const refLow = ref * (1 - r);
  const terms = [
    { key: 'divider' as const, shift: divider },
    { key: 'ref' as const, shift: refT },
    { key: 'adc' as const, shift: adc },
    { key: 'sample' as const, shift: sample },
  ];
  return {
    lsbV,
    lsbInV: lsbV / k,
    terms,
    worstInV: Math.max(readHigh - nominalIn, nominalIn - readLow),
    sourceOhm,
    tau,
    settleS,
    settled: cext > 0 || hasTs ? sampleErrV <= half : undefined,
    stepV,
    sampleErrV,
    droopV,
    kickV,
    capNeededF: csh * (stepV / half - 1),
    capTau,
    capSettleS,
    cornerHz,
    clipsAt: ref / k,
    clipsAtWorst: clipInput(c, i, refLow),
    clips: s.max > refLow,
  };
}

/** The voltage across a single resistor above which the result notes the resistor's voltage rating. */
export const HIGH_VOLTAGE = 50;
/** The power in a single resistor above which the result notes the resistor's power rating, W. */
export const HIGH_POWER = 1 / 16;

export interface DividerResult {
  ok: true;
  circuit: Circuit;
  nominal: number;
  target: number; // NaN with own values
  errorPct: number; // the pick against the target (NaN with own values)
  candidates: Candidate[];
  spread: Spread;
  worstPct: number; // ± % of nominal
  rssPct: number;
  currentA: number;
  powerW: number; // both resistors
  p1W: number;
  p2W: number;
  v1: number; // across R1
  v2: number; // across R2
  sourceOhm: number;
  sensitivity: number; // fraction of the resistors' combined error that reaches the result
  adc?: AdcResult;
  tolRows: { tol: number; pct: number }[];
}
export type Result = { ok: false; error: string } | DividerResult;

type Rule = 'positive' | 'nonNegative' | 'optionalPositive' | 'optionalNonNegative' | 'any' | 'bits';
/** Numeric inputs that are form fields (the chosen pair's index is not). */
type NumKey = Exclude<{ [K in keyof DividerInputs]: DividerInputs[K] extends number ? K : never }[keyof DividerInputs], 'choice'>;
export const inputRules: Record<NumKey, Rule> = {
  vinV: 'positive',
  pinV: 'positive',
  pinTol: 'nonNegative',
  targetV: 'positive',
  currentUA: 'positive',
  r1K: 'positive',
  r2K: 'positive',
  resTol: 'nonNegative',
  tcr: 'nonNegative',
  tMinC: 'any',
  tMaxC: 'any',
  pinUA: 'nonNegative',
  adcBits: 'bits',
  adcRefV: 'positive',
  adcRefTol: 'optionalNonNegative',
  adcErrLsb: 'optionalNonNegative',
  sampleCpF: 'positive',
  switchK: 'optionalNonNegative',
  sampleUs: 'optionalPositive',
  capNF: 'optionalPositive',
  rateKsps: 'optionalPositive',
};
export function meetsRule(rule: Rule, n: number): boolean {
  if (rule === 'optionalPositive') return Number.isNaN(n) || (Number.isFinite(n) && n > 0);
  if (rule === 'optionalNonNegative') return Number.isNaN(n) || (Number.isFinite(n) && n >= 0);
  if (rule === 'bits') return Number.isNaN(n) || (Number.isInteger(n) && n >= 6 && n <= 24);
  if (!Number.isFinite(n)) return false;
  if (rule === 'positive') return n > 0;
  if (rule === 'nonNegative') return n >= 0;
  return true;
}

/** Fields that apply in a state. */
export function inUse(i: DividerInputs, k: NumKey) {
  if (k === 'vinV') return i.mode === 'scale';
  if (k === 'pinV' || k === 'pinTol') return i.mode === 'set';
  if (k === 'targetV' || k === 'currentUA') return i.pick === 'find';
  if (k === 'r1K' || k === 'r2K') return i.pick === 'own';
  if (k.startsWith('adc') || ['sampleCpF', 'switchK', 'sampleUs', 'capNF', 'rateKsps'].includes(k))
    return i.mode === 'scale' && (k === 'adcBits' || Number.isFinite(i.adcBits));
  return true;
}

export function inputError(i: DividerInputs): string {
  for (const k of Object.keys(inputRules) as NumKey[])
    if (inUse(i, k) && !meetsRule(inputRules[k], i[k]))
      return k === 'adcBits' ? 'ADC resolution is a whole number of bits from 6 to 24, or leave it empty.' : 'Check the highlighted inputs.';
  if (i.tMinC > i.tMaxC) return 'The lowest temperature is above the highest.';
  if (i.resTol >= 50 || (i.mode === 'set' && i.pinTol >= 50) || (inUse(i, 'adcRefTol') && i.adcRefTol >= 50))
    return 'Tolerances are in ±%, below 50%.';
  if (i.resTol / 100 + i.tcr * 1e-6 * Math.max(Math.abs(i.tMinC - 25), Math.abs(i.tMaxC - 25)) >= 0.5)
    return 'The resistor tolerance plus its drift over the temperature range must stay below 50%.';
  if (inUse(i, 'sampleUs') && i.sampleUs > 0 && i.rateKsps > 0 && i.capNF > 0 && i.sampleUs * i.rateKsps >= 1e3)
    return 'The sampling time is longer than the time between conversions.';
  if (i.pick === 'find') {
    if (i.mode === 'scale' && i.targetV >= i.vinV) return 'A divider’s output is below its input: make the target pin voltage lower than the input.';
    if (i.mode === 'set' && i.targetV <= i.pinV) return 'The level must be above the pin voltage: the divider divides it down to the pin.';
  }
  return '';
}

export function calculate(i: DividerInputs): Result {
  const error = inputError(i);
  if (error) return { ok: false, error };
  const source = i.mode === 'scale' ? i.vinV : i.pinV;
  let candidates: Candidate[] = [];
  let r1 = i.r1K * 1e3;
  let r2 = i.r2K * 1e3;
  if (i.pick === 'find') {
    candidates = findPairs(i.mode, source, i.targetV, i.series, i.currentUA * 1e-6);
    if (!candidates.length) return { ok: false, error: 'No standard pair between 1 Ω and 10 MΩ fits that current. Try another divider current.' };
    ({ r1, r2 } = candidates[Math.min(Math.max(0, Math.round(i.choice) || 0), candidates.length - 1)]);
  }
  const circuit: Circuit = { mode: i.mode, source, r1, r2 };
  const nominal = evaluate(circuit);
  const s = spread(circuit, i.resTol / 100, i.tcr, i.tMinC, i.tMaxC, i.pinUA * 1e-6, i.pinTol / 100);
  if (!(s.min > 0))
    return { ok: false, error: 'At its worst, the pin current pulls the result to 0 V or below: use smaller resistors, or check the pin current.' };
  const target = i.pick === 'find' ? i.targetV : NaN;
  const top = i.mode === 'scale' ? i.vinV : nominal;
  const v2 = i.mode === 'scale' ? nominal : i.pinV;
  const v1 = top - v2;
  const currentA = dividerCurrent(circuit);
  const result: DividerResult = {
    ok: true,
    circuit,
    nominal,
    target,
    errorPct: (nominal / target - 1) * 100,
    candidates,
    spread: s,
    worstPct: (Math.max(s.max - nominal, nominal - s.min) / nominal) * 100,
    rssPct: (s.rss / nominal) * 100,
    currentA,
    powerW: (top * top) / (r1 + r2),
    p1W: (v1 * v1) / r1,
    p2W: (v2 * v2) / r2,
    v1,
    v2,
    sourceOhm: parallel(r1, r2),
    sensitivity: r1 / (r1 + r2),
    tolRows: [0.1, 0.5, 1, 2, 5].map((tol) => ({ tol, pct: spreadPctWith(circuit, i, tol) })),
  };
  if (i.mode === 'scale' && Number.isFinite(i.adcBits)) result.adc = adcReading(circuit, i, s);
  return result;
}

/**
 * A number to `p` significant figures in plain decimal notation (never "1.00e+3"). Rounds first,
 * so 999.7 becomes "1000". Keeps trailing zeros ("0.300") unless `trim` is set.
 */
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
];
/** A value with an SI prefix, rounded before choosing so 999.7 reads "1.00 k". */
export function si(n: number, unit: string, p = 3, trim = false): string {
  if (!Number.isFinite(n)) return '–';
  const r = Number(n.toPrecision(p));
  if (Math.abs(r) < 1e-12) return `0 ${unit}`;
  const [f, pre] = prefixes.find(([f]) => Math.abs(r) >= f * (1 - 1e-12)) ?? prefixes[prefixes.length - 1];
  return `${num(r / f, trim, p)} ${pre}${unit}`;
}
export const volts = (n: number, p = 3) => si(n, 'V', p);
export const amps = (n: number) => si(n, 'A');
export const watts = (n: number) => si(n, 'W');
export const seconds = (n: number) => si(n, 's');
export const farads = (n: number) => si(n, 'F');
/** Resistor values as written on a schematic: 3 significant figures, trailing zeros dropped. */
export const ohms = (n: number) => si(n, 'Ω', 3, true);
