// I2C pull-up resistor calculator (/tools/i2c-pull-up/). Sizes the pull-up resistors on SDA and SCL
// from the NXP I2C-bus specification (UM10204, Rev. 7.0, 2021): Tables 10 and 11 and Section 7.
// Pure functions, no DOM.
//
// The limits, each on the pull-up resistance the bus line actually sees (the new resistor in
// parallel with any pull-ups already on the bus), at the worst end of the supply and resistor
// tolerances:
// - Sink current (low end): the weakest driver must pull the line down to its VOL while sinking
//   the pull-up current. Rp ≥ (VDD,max − VOL) / IOL − Rs. VOL 0.4 V at 3 mA (Standard and Fast
//   mode) or 20 mA (Fast-mode Plus) above 2 V; at 2 V and below, 0.2·VDD at 2 mA (Fast and
//   Fast-mode Plus). Fast-mode parts that sink 6 mA at 0.6 V can drive the full 400 pF. A supply
//   range that spans 2 V is checked on both sides of it.
// - Low-level noise margin with series resistors (low end): the line must sit at least 0.1·VDD
//   below VIL = 0.3·VDD, so VOL + Rs·I ≤ 0.2·VDD, giving Rp ≥ Rs · 0.8·VDD / (0.2·VDD − VOL), at
//   VDD,min (Section 7.3, Figure 46).
// - Rise time (high end): from 0.3·VDD to 0.7·VDD an RC edge takes ln(7/3)·RC = 0.8473·RC, so
//   Rp ≤ tr / (0.8473 · Cb), tr = 1000, 300 or 120 ns (Section 7.1, Equation 1).
// - Input leakage (high end): the high level must stay 0.2·VDD above VIH = 0.7·VDD with every
//   input's high-level current (up to 10 µA each) through Rp, so Rp ≤ 0.1·VDD,min / ΣIi (Section 7.4).
// A bus that cannot meet its rise time can still run slower: fmax = 1 / (tLOW + tHIGH + tr + tf)
// (Section 7.2.1, Equation 3), with the mode's minimum tLOW and tHIGH and its maximum tf.
//
// Test vectors (checked by scripts/test-i2c.ts in the site repository):
// - TI SLVA689A: Fast mode, 3.3 V, Cb 200 pF: Rp(max) = 300 ns / (0.8473 · 200 pF) = 1.77 kΩ,
//   Rp(min) = (3.3 − 0.4) / 3 mA = 966.7 Ω.
// - UM10204 Section 7.2.4: 5 V ± 10 %, 0.4 V at 3 mA: Rp(min) = (5.5 − 0.4) / 3 mA = 1.7 kΩ, which
//   limits a Fast-mode bus to about 200 pF (300 ns / (0.8473 · 1.7 kΩ) = 208 pF).
// - Equation 3 at each mode's own limits gives its rated clock: 1 / (4.7 + 4.0 + 1.0 + 0.3 µs) =
//   100 kHz, 1 / (1.3 + 0.6 + 0.3 + 0.3 µs) = 400 kHz, 1 / (0.5 + 0.26 + 0.12 + 0.12 µs) = 1 MHz.

export type Mode = 'standard' | 'fast' | 'fastPlus';
/** The weakest driver: the spec's minimum for the mode, Fast mode's 6 mA option, or a datasheet figure. */
export type Driver = 'spec' | 'fast6' | 'custom';
/** The bus capacitance: estimated from its parts, or entered as a total. */
export type CapEntry = 'estimate' | 'total';
export type Series = 'E12' | 'E24' | 'E96';

export interface I2cInputs {
  mode: Mode;
  vdd: number; // pull-up supply, V
  vddTolPct: number; // ±%
  capEntry: CapEntry;
  capTotalPf: number; // used when capEntry is 'total'
  devices: number; // devices on the bus (pins on each line); also counts the leakage
  pinPf: number; // capacitance of each device's pin
  lengthCm: number; // trace and cable length
  pfPerCm: number;
  otherPf: number; // connectors, ESD protection, test points
  driver: Driver;
  volV: number; // custom driver: VOL at…
  iolMa: number; // …this sink current
  leakUa: number; // high-level input current of each device
  rsOhm: number; // series resistor between each device's pin and the bus (0: none)
  existingOhm: number; // pull-ups already on the line, combined (NaN: none)
  tolPct: number; // pull-up resistor tolerance, ±%
  series: Series;
  chosenOhm: number; // a value to check (NaN: none)
}

export const defaultI2c: I2cInputs = {
  mode: 'fast',
  vdd: 3.3,
  vddTolPct: 5,
  capEntry: 'estimate',
  capTotalPf: 100,
  devices: 4,
  pinPf: 10,
  lengthCm: 10,
  pfPerCm: 1,
  otherPf: 10,
  driver: 'spec',
  volV: 0.4,
  iolMa: 3,
  leakUa: 10,
  rsOhm: 0,
  existingOhm: NaN,
  tolPct: 1,
  series: 'E24',
  chosenOhm: NaN,
};

/** UM10204 Rev. 7.0, Tables 10 and 11. Times in seconds, capacitance in farads, current in amps. */
export const modes: Record<Mode, { label: string; fHz: number; tr: number; tf: number; cb: number; tLow: number; tHigh: number; iol: number; trMin: number }> = {
  standard: { label: 'Standard-mode', fHz: 100e3, tr: 1000e-9, tf: 300e-9, cb: 400e-12, tLow: 4.7e-6, tHigh: 4.0e-6, iol: 3e-3, trMin: 0 },
  fast: { label: 'Fast-mode', fHz: 400e3, tr: 300e-9, tf: 300e-9, cb: 400e-12, tLow: 1.3e-6, tHigh: 0.6e-6, iol: 3e-3, trMin: 20e-9 },
  fastPlus: { label: 'Fast-mode Plus', fHz: 1000e3, tr: 120e-9, tf: 120e-9, cb: 550e-12, tLow: 0.5e-6, tHigh: 0.26e-6, iol: 20e-3, trMin: 0 },
};

/** ln(0.7 / 0.3): the 30 % to 70 % rise of an RC edge, in time constants (the spec's 0.8473). */
export const RISE_K = Math.log(7 / 3);
/** At or below this supply the spec gives VOL as 0.2·VDD at 2 mA. */
export const LOW_VDD = 2;
/** The spec's input levels and noise margins, as fractions of VDD. */
export const VIL = 0.3;
export const VIH = 0.7;
export const LOW_LEVEL_MAX = VIL - 0.1; // 0.2·VDD
export const HIGH_LEVEL_MIN = VIH + 0.2; // 0.9·VDD
/** Most I2C parts are rated to 5.5 V; above it the result carries a note. */
export const HIGH_VDD = 5.5;

/** The weakest driver's VOL at the supply v, and its sink current. The spec's figures change at 2 V. */
export function driverAt(i: I2cInputs, v: number): { vol: number; iol: number } {
  if (i.driver === 'custom') return { vol: i.volV, iol: i.iolMa / 1000 };
  if (i.driver === 'fast6' && i.mode === 'fast') return { vol: 0.6, iol: 6e-3 };
  if (v <= LOW_VDD) return { vol: 0.2 * v, iol: 2e-3 };
  return { vol: 0.4, iol: modes[i.mode].iol };
}

/**
 * The supplies the worst case is checked at: both ends of the tolerance, and both sides of 2 V when
 * the range spans it (the spec's driver figures change there, and each limit is monotonic in the
 * supply on either side).
 */
export function supplies(i: I2cInputs): { vMin: number; vMax: number; all: number[] } {
  const t = i.vddTolPct / 100;
  const vMin = i.vdd * (1 - t);
  const vMax = i.vdd * (1 + t);
  const all = [vMin, vMax];
  if (i.driver === 'spec' && vMin <= LOW_VDD && vMax > LOW_VDD) all.push(LOW_VDD, LOW_VDD * (1 + 1e-12));
  return { vMin, vMax, all };
}

/** Room below 0.2·VDD for the drop across a series resistor at the supply v (negative: VOL is already above it). */
const lowRoom = (i: I2cInputs, v: number) => LOW_LEVEL_MAX * v - driverAt(i, v).vol;

/** The bus capacitance, F. */
export const busCap = (i: I2cInputs) =>
  (i.capEntry === 'total' ? i.capTotalPf : i.devices * i.pinPf + i.lengthCm * i.pfPerCm + i.otherPf) * 1e-12;

export const parallel = (a: number, b: number) => (Number.isFinite(b) ? (a * b) / (a + b) : a);

// Standard values (IEC 60063), one decade. E96 follows round(10^(i/96), 2 decimals) exactly.
const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];
export const seriesValues: Record<Series, number[]> = {
  E12: E24.filter((_, n) => n % 2 === 0),
  E24,
  E96: Array.from({ length: 96 }, (_, n) => Math.round(100 * 10 ** (n / 96)) / 100),
};
/** Standard values from 10 Ω to 1 MΩ. */
export function standardList(series: Series): number[] {
  const out: number[] = [];
  for (let d = 1; d <= 5; d++) for (const v of seriesValues[series]) out.push(Number((v * 10 ** d).toPrecision(3)));
  out.push(1e6);
  return out;
}

export type Limit = 'sink' | 'noise' | 'rise' | 'leak';
export interface Bound {
  limit: Limit;
  /** The pull-up resistance this limit allows the line to have at its worst, Ω (NaN: no limit). */
  ohms: number;
}

/** The four limits on the line's pull-up resistance, at the worst ends of the supply. */
export function bounds(i: I2cInputs): Bound[] {
  const { vMin, all } = supplies(i);
  const sink = Math.max(0, ...all.map((v) => {
    const d = driverAt(i, v);
    return (v - d.vol) / d.iol - i.rsOhm;
  }));
  // The low level must stay at or below 0.2·VDD. With no series resistor that puts no limit on Rp: a
  // driver whose rated VOL is already above it is flagged (volMargin), since its low level falls with
  // less current and a larger pull-up helps. With one, the drop across it needs room below 0.2·VDD.
  const noiseAt = (v: number) => {
    const room = lowRoom(i, v);
    if (!(i.rsOhm > 0)) return NaN;
    return room > LOW_LEVEL_MAX * 1e-9 * v ? (i.rsOhm * (1 - LOW_LEVEL_MAX) * v) / room : Infinity;
  };
  const ns = all.map(noiseAt).filter((n) => !Number.isNaN(n));
  const noise = ns.length ? Math.max(...ns) : NaN;
  const rise = modes[i.mode].tr / (RISE_K * busCap(i));
  const leakA = i.devices * i.leakUa * 1e-6;
  const leak = leakA > 0 ? ((1 - HIGH_LEVEL_MIN) * vMin) / leakA : NaN;
  return [
    { limit: 'sink', ohms: sink },
    { limit: 'noise', ohms: noise },
    { limit: 'rise', ohms: rise },
    { limit: 'leak', ohms: leak },
  ];
}

/** How one resistor value performs, at its tolerance and the supply's. */
export interface Check {
  ohms: number; // the new resistor (Infinity: none added)
  line: number; // the line's pull-up, nominal: the resistor in parallel with any already there
  lineMin: number;
  lineMax: number;
  riseWorst: number; // s, at the highest line resistance
  riseNom: number;
  riseMin: number;
  sinkWorst: number; // A, the driver's current at the lowest line resistance, at the supply where it is nearest its rating
  sinkLimit: number; // A, the driver's rating at that supply
  sinkOk: boolean;
  lowLevel: number; // V, the line's low level through the series resistor, worst case
  lowLimit: number; // V, 0.2·VDD at the same supply
  highLevel: number; // V, the high level with leakage, worst case (0 when the leakage would pull it below ground)
  highLimit: number; // V, 0.9·VDD,min
  currentNom: number; // A, per line while held low, nominal
  riseOk: boolean;
  lowOk: boolean;
  highOk: boolean;
  fMax: number; // Hz, the highest clock the rise time allows (capped at the mode's rating)
  tooFast: boolean; // Fast mode only: rise faster than the spec's 20 ns minimum
  ok: boolean;
}

export function check(i: I2cInputs, r: number): Check {
  const m = modes[i.mode];
  const t = i.tolPct / 100;
  const { vMin, all } = supplies(i);
  const ext = i.existingOhm;
  // Both the new resistor and those already there are taken at the same tolerance, so the
  // parallel combination scales with it.
  const line = Number.isFinite(r) ? parallel(r, ext) : ext;
  const lineMin = line * (1 - t);
  const lineMax = line * (1 + t);
  const cb = busCap(i);
  const riseWorst = RISE_K * lineMax * cb;
  // The driver's current, and the low level at the bus (its VOL plus the drop across its series
  // resistor), at each supply checked; the worst of each is kept.
  const at = all.map((v) => {
    const d = driverAt(i, v);
    const current = (v - d.vol) / (lineMin + i.rsOhm);
    return { current, iol: d.iol, level: d.vol + i.rsOhm * current, limit: LOW_LEVEL_MAX * v };
  });
  const sink = at.reduce((x, y) => (y.current / y.iol > x.current / x.iol ? y : x));
  const low = at.reduce((x, y) => (y.limit - y.level < x.limit - x.level ? y : x));
  const leakA = i.devices * i.leakUa * 1e-6;
  const highLevel = Math.max(0, vMin - leakA * lineMax);
  const highLimit = HIGH_LEVEL_MIN * vMin;
  const nomD = driverAt(i, i.vdd);
  const riseOk = riseWorst <= m.tr * (1 + 1e-9);
  const sinkOk = sink.current <= sink.iol * (1 + 1e-9);
  // Only checked with series resistors: without them the low level is the driver's own, flagged by
  // calculate() as volMargin rather than charged to the resistor.
  const lowOk = !(i.rsOhm > 0) || low.level <= low.limit * (1 + 1e-9);
  const highOk = highLevel >= highLimit * (1 - 1e-9);
  return {
    ohms: r,
    line,
    lineMin,
    lineMax,
    riseWorst,
    riseNom: RISE_K * line * cb,
    riseMin: RISE_K * lineMin * cb,
    sinkWorst: sink.current,
    sinkLimit: sink.iol,
    sinkOk,
    lowLevel: low.level,
    lowLimit: low.limit,
    highLevel,
    highLimit,
    currentNom: (i.vdd - nomD.vol) / (line + i.rsOhm),
    riseOk,
    lowOk,
    highOk,
    fMax: clockFor(i.mode, riseWorst),
    tooFast: m.trMin > 0 && RISE_K * lineMin * cb < m.trMin,
    ok: riseOk && sinkOk && lowOk && highOk,
  };
}

/** The highest clock a rise time allows (Equation 3, with the mode's tLOW, tHIGH and maximum tf), capped at the mode's rating. */
export function clockFor(mode: Mode, rise: number): number {
  const m = modes[mode];
  return Math.min(m.fHz, 1 / (m.tLow + m.tHigh + rise + m.tf));
}

export interface I2cResult {
  ok: true;
  cb: number; // F
  bounds: Bound[];
  /** The line's pull-up resistance must stay within these at its worst (Ω); `lowBy`/`highBy` name the limit that sets each. */
  lineLow: number;
  lineHigh: number;
  lowBy: Limit;
  highBy: Limit;
  /** Nominal values of the new resistor that keep the line within them at the resistor's tolerance (high is Infinity when none is needed). */
  rMin: number;
  rMax: number;
  feasible: boolean;
  /** Why no value works: the limits clash (reported first), or the pull-ups already on the bus are too strong. */
  blocked: '' | 'clash' | 'existing';
  /** The pull-ups already on the bus are enough on their own. */
  existingEnough: boolean;
  /** Standard values in range: the lowest, one near the geometric middle, and the highest (distinct, ascending). */
  picks: Check[];
  /** No standard value of the series fits the range. */
  noStandard: boolean;
  /** When no value works: the smallest standard value that meets the low-end limits, and what it gives. */
  fallback: Check | null;
  /** The largest bus capacitance this supply, driver and tolerance allow in the mode, F. */
  cbMax: number;
  chosen: Check | null;
  cbOver: boolean; // above the spec's limit for the mode
  vddHigh: boolean;
  /** At 2 V and below with the spec's driver: Standard-mode figures are not given, the Fast-mode ones are used. */
  lowVddStandard: boolean;
  /** The driver's rated VOL leaves less than the spec's noise margin at the low level (above 0.2·VDD at some supply in the range). A warning: its low level falls with less current. */
  volMargin: boolean;
}
export type Result = { ok: false; error: string } | I2cResult;

type NumKey =
  | 'vdd'
  | 'vddTolPct'
  | 'capTotalPf'
  | 'devices'
  | 'pinPf'
  | 'lengthCm'
  | 'pfPerCm'
  | 'otherPf'
  | 'volV'
  | 'iolMa'
  | 'leakUa'
  | 'rsOhm'
  | 'existingOhm'
  | 'tolPct'
  | 'chosenOhm';
type Rule = 'positive' | 'nonNegative' | 'percent' | 'count' | 'optionalPositive' | 'supply';
export const inputRules: Record<NumKey, Rule> = {
  vdd: 'supply',
  vddTolPct: 'percent',
  capTotalPf: 'positive',
  devices: 'count',
  pinPf: 'nonNegative',
  lengthCm: 'nonNegative',
  pfPerCm: 'nonNegative',
  otherPf: 'nonNegative',
  volV: 'nonNegative',
  iolMa: 'positive',
  leakUa: 'nonNegative',
  rsOhm: 'nonNegative',
  existingOhm: 'optionalPositive',
  tolPct: 'percent',
  chosenOhm: 'optionalPositive',
};
/** Supplies accepted, V. */
export const SUPPLY = { min: 0.8, max: 20 };
/** Tolerances must be below this, %. */
export const MAX_TOL = 50;

export function meetsRule(rule: Rule, n: number): boolean {
  if (rule === 'optionalPositive') return Number.isNaN(n) || (Number.isFinite(n) && n > 0);
  if (!Number.isFinite(n)) return false;
  if (rule === 'positive') return n > 0;
  if (rule === 'nonNegative') return n >= 0;
  if (rule === 'percent') return n >= 0 && n < MAX_TOL;
  if (rule === 'count') return Number.isInteger(n) && n >= 1 && n <= 128;
  return n >= SUPPLY.min && n <= SUPPLY.max;
}

/** Whether a numeric input is used by the current choices. */
export function inUse(i: I2cInputs, k: NumKey): boolean {
  if (k === 'capTotalPf') return i.capEntry === 'total';
  if (k === 'pinPf' || k === 'lengthCm' || k === 'pfPerCm' || k === 'otherPf') return i.capEntry === 'estimate';
  if (k === 'volV' || k === 'iolMa') return i.driver === 'custom';
  return true;
}

const labels: Record<NumKey, string> = {
  vdd: `The pull-up supply must be between ${SUPPLY.min} and ${SUPPLY.max} V.`,
  vddTolPct: `The supply tolerance must be from 0 to under ${MAX_TOL}%.`,
  capTotalPf: 'Enter the bus capacitance, above zero.',
  devices: 'The number of devices must be a whole number from 1 to 128.',
  pinPf: 'The pin capacitance cannot be negative.',
  lengthCm: 'The length cannot be negative.',
  pfPerCm: 'The capacitance per centimetre cannot be negative.',
  otherPf: 'The other capacitance cannot be negative.',
  volV: 'The driver’s low level cannot be negative.',
  iolMa: 'Enter the driver’s sink current, above zero.',
  leakUa: 'The input current cannot be negative.',
  rsOhm: 'The series resistor cannot be negative.',
  existingOhm: 'The pull-ups already on the bus must be above zero, or left empty.',
  tolPct: `The resistor tolerance must be from 0 to under ${MAX_TOL}%.`,
  chosenOhm: 'The value to check must be above zero, or left empty.',
};

export function inputError(i: I2cInputs): string {
  for (const k of Object.keys(inputRules) as NumKey[]) {
    if (inUse(i, k) && !meetsRule(inputRules[k], i[k])) return labels[k];
  }
  const { vMin } = supplies(i);
  if (driverAt(i, vMin).vol >= vMin) return 'The driver’s low level must be below the supply.';
  if (!(busCap(i) > 0)) return 'The bus capacitance comes to zero; add the pins, the wiring or a total.';
  return '';
}

/** The nominal new resistor that puts the line's pull-up at `line`, with `ext` already there (Infinity when ext alone gives it). */
export const resistorFor = (line: number, ext: number) =>
  !Number.isFinite(ext) ? line : line >= ext * (1 - 1e-9) ? Infinity : (line * ext) / (ext - line);

export function calculate(i: I2cInputs): Result {
  const error = inputError(i);
  if (error) return { ok: false, error };
  const m = modes[i.mode];
  const cb = busCap(i);
  const bs = bounds(i);
  const pickMax = (ls: Limit[]) => bs.filter((b) => ls.includes(b.limit) && !Number.isNaN(b.ohms)).reduce((x, y) => (y.ohms > x.ohms ? y : x));
  const pickMin = (ls: Limit[]) =>
    bs.filter((b) => ls.includes(b.limit) && !Number.isNaN(b.ohms)).reduce((x, y) => (y.ohms < x.ohms ? y : x));
  const low = pickMax(['sink', 'noise']);
  const high = pickMin(['rise', 'leak']);
  const t = i.tolPct / 100;
  const ext = i.existingOhm;
  // Nominal line resistance that stays inside the limits at the resistor tolerance.
  const lineLowNom = low.ohms / (1 - t);
  const lineHighNom = high.ohms / (1 + t);
  const clash = !(lineLowNom <= lineHighNom);
  const existingTooStrong = Number.isFinite(ext) && ext < lineLowNom * (1 - 1e-9);
  const feasible = !clash && !existingTooStrong;
  const rMin = existingTooStrong ? NaN : resistorFor(lineLowNom, ext);
  const rMax = existingTooStrong ? NaN : resistorFor(lineHighNom, ext);
  // Enough on their own exactly when no upper limit is left on the resistor to add.
  const existingEnough = feasible && Number.isFinite(ext) && !Number.isFinite(rMax);

  const list = standardList(i.series);
  const fits = feasible ? list.filter((r) => r >= rMin * (1 - 1e-9) && r <= rMax * (1 + 1e-9)) : [];
  let picks: Check[] = [];
  if (fits.length) {
    const lo = fits[0];
    const hi = fits[fits.length - 1];
    const mid = fits.reduce((x, y) => (Math.abs(Math.log(y / Math.sqrt(lo * hi))) < Math.abs(Math.log(x / Math.sqrt(lo * hi))) ? y : x));
    // With the pull-ups already there enough on their own, any larger value also works: offer only the lowest.
    picks = (Number.isFinite(rMax) ? [...new Set([lo, mid, hi])] : [lo]).map((r) => check(i, r));
  }
  // With no value that works, the smallest standard value that meets the low-end limits shows
  // how slow the edges get and the clock the bus can still run at.
  let fallback: Check | null = null;
  if (clash && !existingTooStrong && Number.isFinite(rMin)) {
    const r = list.find((x) => x >= rMin * (1 - 1e-9));
    if (r !== undefined) fallback = check(i, r);
  }
  const { vMin, vMax, all } = supplies(i);
  const lowVdd = i.driver === 'spec' && vMin <= LOW_VDD;
  return {
    ok: true,
    cb,
    bounds: bs,
    lineLow: low.ohms,
    lineHigh: high.ohms,
    lowBy: low.limit,
    highBy: high.limit,
    rMin,
    rMax,
    feasible,
    blocked: clash ? 'clash' : existingTooStrong ? 'existing' : '',
    existingEnough,
    picks,
    noStandard: feasible && !existingEnough && fits.length === 0,
    fallback,
    cbMax: (m.tr * (1 - t)) / (RISE_K * low.ohms * (1 + t)),
    chosen: Number.isFinite(i.chosenOhm) ? check(i, i.chosenOhm) : null,
    cbOver: cb > m.cb * (1 + 1e-9),
    vddHigh: vMax > HIGH_VDD * (1 + 1e-9),
    lowVddStandard: lowVdd && i.mode === 'standard',
    volMargin: all.some((v) => lowRoom(i, v) < -LOW_LEVEL_MAX * 1e-9 * v),
  };
}

// Formatting, shared with the page.
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
  if (Math.abs(r) < 1e-15) return `0 ${unit}`;
  const [f, pre] = prefixes.find(([f]) => Math.abs(r) >= f * (1 - 1e-12)) ?? prefixes[prefixes.length - 1];
  return `${num(r / f, trim, p)} ${pre}${unit}`;
}
/** Resistor values as written on a schematic: 3 significant figures, trailing zeros dropped. */
export const ohms = (n: number) => si(n, 'Ω', 3, true);
