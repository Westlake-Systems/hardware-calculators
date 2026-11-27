// Coin cell pulse load calculator (/tools/coin-cell-pulse/). A small battery is modelled as a voltage source (its
// open-circuit voltage) behind its internal resistance, with an optional series resistor, feeding a node where a
// buffer capacitor (with its ESR) sits beside the load. The load draws a burst made of steps of constant current,
// then sleeps until the next burst.
//
// With R = Ri + Rs (cell plus series resistor), E = ESR and C the capacitance, and Vc the voltage on the ideal
// capacitor inside the ESR, a step of constant load current I gives, exactly:
//   dVc/dt = (Voc − R·I − Vc) / ((R + E)·C), so Vc relaxes toward Voc − R·I with τ = (R + E)·C
//   node (load) voltage  Vn = (R·Vc + E·Voc − E·R·I) / (R + E)
//   cell current          Is = (Voc − Vc + E·I) / (R + E)
// Vn is linear in Vc and Vc is monotonic within a step, so the extremes lie at step ends. With bursts repeating,
// one whole cycle maps Vc affinely (Vc_end = a·Vc_start + b with a = exp(−T/τ)), so the repeating state is the fixed
// point b / (1 − a). Without a capacitor, Vn = Voc − R·I.
// Pure functions, no DOM.

export interface Step {
  label: string;
  mA: number; // load current during the step
  us: number; // duration, µs
}

export type CellPick = 'fresh' | 'mid' | 'late' | 'end' | 'own';
export type ProfilePick = 'uwb' | 'ble' | 'own';

export interface PulseInputs {
  cell: CellPick;
  vocV: number; // open-circuit voltage between bursts
  riOhm: number; // internal resistance at room temperature
  coldX: number; // resistance multiplier for the lowest temperature (1 = as entered)
  capacityMAh: number; // optional: rated capacity, for the life ceiling
  profile: ProfilePick;
  steps: Step[];
  periodMs: number; // optional: a burst starts every this many ms (NaN = one burst after a long rest)
  sleepUA: number; // optional: current between bursts, capacitor leakage included
  floorV: number; // highest minimum supply of anything on the rail
  marginV: number; // margin kept above it for ripple
  capUF: number; // optional: buffer capacitor, nominal (NaN or 0 = none)
  capLossPct: number; // optional: capacitance lost to DC bias, cold, ageing and tolerance
  esrOhm: number; // optional: the capacitor's ESR
  seriesOhm: number; // optional: resistor between the cell and the capacitor
  limitMA: number; // optional: a peak current to keep the cell below
}

/**
 * One maker's 2032 lithium coin cell, from the handbook curves quoted in the coin cell article
 * (/articles/coin-cell-pulse-loads/): a 30 mA, 0.1 s pulse every 5 s, room temperature. Approximate, read off a
 * plotted curve. Mid-life uses the top of its 13 to 16 Ω band.
 */
export const cells: Record<Exclude<CellPick, 'own'>, { name: string; used: string; vocV: number; riOhm: number }> = {
  fresh: { name: 'Fresh', used: 'new', vocV: 3.1, riOhm: 10 },
  mid: { name: 'Mid-life', used: '25 to 100 mAh used', vocV: 2.88, riOhm: 16 },
  late: { name: 'Late', used: '150 mAh used', vocV: 2.8, riOhm: 18 },
  end: { name: 'Near the end', used: 'about 210 mAh used', vocV: 2.6, riOhm: 65 },
};

/**
 * Burst profiles from the coin cell article, each with the supply floor and repetition that go with it. UWB: the
 * initiator's side of a double-sided two-way ranging exchange from one transceiver's datasheet, channel 5, with 1 ms
 * of idle between the bursts as an example (the reply delays are set by firmware), against its main radio supply's
 * 2.4 V minimum, once a second (an example rate). BLE: the load in a chip maker's 2010 coin cell white paper, which
 * rests at 0.1 mA for 200 ms between events, against a BLE chip's 1.8 V minimum.
 */
export const profiles: Record<
  Exclude<ProfilePick, 'own'>,
  { name: string; steps: Step[]; floorV: number; periodMs: number; sleepUA: number }
> = {
  uwb: {
    name: 'UWB ranging exchange (tag side)',
    floorV: 2.4,
    periodMs: 1000,
    sleepUA: NaN,
    steps: [
      { label: 'Transmit poll', mA: 48, us: 170 },
      { label: 'Wait for the response', mA: 18, us: 500 },
      { label: 'Receive response', mA: 78, us: 170 },
      { label: 'Wait', mA: 18, us: 500 },
      { label: 'Transmit final', mA: 48, us: 170 },
    ],
  },
  ble: {
    name: 'BLE stress load (white paper)',
    floorV: 1.8,
    periodMs: 205,
    sleepUA: 100,
    steps: [
      { label: 'Radio on', mA: 8, us: 2000 },
      { label: 'Peak', mA: 30, us: 1000 },
      { label: 'Radio on', mA: 8, us: 2000 },
    ],
  },
};

export const defaultPulse: PulseInputs = {
  cell: 'mid',
  vocV: cells.mid.vocV,
  riOhm: cells.mid.riOhm,
  coldX: 1,
  capacityMAh: 225,
  profile: 'uwb',
  steps: profiles.uwb.steps.map((s) => ({ ...s })),
  periodMs: 1000,
  sleepUA: NaN,
  floorV: 2.4,
  marginV: 0.1,
  capUF: 100,
  capLossPct: NaN,
  esrOhm: 0.05,
  seriesOhm: NaN,
  limitMA: NaN,
};

/** The electrical model, in SI units. */
export interface Circuit {
  voc: number;
  r: number; // cell plus series resistor, Ω
  esr: number; // Ω
  c: number; // F; 0 = no capacitor
  steps: { i: number; t: number }[]; // A, s
  gap: number; // s of sleep after the burst; Infinity = one burst from rest
  iSleep: number; // A
}

const opt = (n: number) => (Number.isFinite(n) ? n : 0);
const sumUs = (steps: Step[]) => steps.reduce((s, x) => s + x.us, 0);

export function circuitOf(i: PulseInputs, over: { voc?: number; ri?: number; c?: number; rs?: number } = {}): Circuit {
  const capF = opt(i.capUF) * 1e-6 * (1 - opt(i.capLossPct) / 100);
  return {
    voc: over.voc ?? i.vocV,
    r: (over.ri ?? i.riOhm) * i.coldX + (over.rs ?? opt(i.seriesOhm)),
    esr: opt(i.esrOhm),
    c: over.c ?? capF,
    steps: i.steps.map((s) => ({ i: s.mA * 1e-3, t: s.us * 1e-6 })),
    // Worked in µs, as the validation does, so a period just longer than the burst never gives a negative gap.
    gap: Number.isFinite(i.periodMs) ? Math.max(0, i.periodMs * 1e3 - sumUs(i.steps)) * 1e-6 : Infinity,
    iSleep: opt(i.sleepUA) * 1e-6,
  };
}

// The state is the drop on the capacitor below the open-circuit voltage, d = Voc − Vc. Written that way, each step
// is a weighted sum of non-negative terms, d' = d·e^(−t/τ) + R·I·(1 − e^(−t/τ)), with 1 − e^(−x) from expm1, so a
// time constant far longer than the burst loses no digits.
const tauOf = (c: Circuit) => (c.r + c.esr) * c.c;
function relax(c: Circuit, d: number, i: number, t: number) {
  if (t === 0) return d;
  const x = t / tauOf(c);
  if (!Number.isFinite(x)) return c.r * i;
  return d * Math.exp(-x) - c.r * i * Math.expm1(-x);
}
/** The load voltage with the capacitor `d` below Voc and load current `i`: Voc − R·(d + ESR·I)/(R + ESR). */
export const nodeV = (c: Circuit, d: number, i: number) =>
  c.c > 0 ? c.voc - (c.r * (d + c.esr * i)) / (c.r + c.esr) : c.voc - c.r * i;
/** The current from the cell: (d + ESR·I)/(R + ESR). */
export const cellI = (c: Circuit, d: number, i: number) => (c.c > 0 ? (d + c.esr * i) / (c.r + c.esr) : i);

const chargeOf = (c: Circuit) => c.steps.reduce((s, x) => s + x.i * x.t, 0);
const burstOf = (c: Circuit) => c.steps.reduce((s, x) => s + x.t, 0);
/** Average current over a cycle; the sleep current for a single burst. */
export const averageOf = (c: Circuit) =>
  Number.isFinite(c.gap) ? (chargeOf(c) + c.iSleep * c.gap) / (burstOf(c) + c.gap) : c.iSleep;

/** The capacitor's drop below Voc as each burst starts, once bursts have repeated long enough to settle. */
function startDrop(c: Circuit): number {
  if (!(c.c > 0) || !Number.isFinite(c.gap)) return c.r * c.iSleep;
  // One cycle maps the drop as d → a·d + b, with a = e^(−T/τ); the settled drop is b / (1 − a).
  const b = relax(c, c.steps.reduce((d, s) => relax(c, d, s.i, s.t), 0), c.iSleep, c.gap);
  const oneMinusA = -Math.expm1(-(burstOf(c) + c.gap) / tauOf(c));
  return oneMinusA > 0 ? b / oneMinusA : c.r * averageOf(c);
}
/** The capacitor's voltage as each burst starts. */
export const startVc = (c: Circuit) => c.voc - startDrop(c);

export interface Sim {
  minV: number; // lowest voltage at the load over the cycle
  minStep: number; // index of the step it falls in; −1 between bursts
  startV: number; // load voltage just before the burst
  restV: number; // load voltage after a full refill
  peakCellA: number; // highest current drawn from the cell over the cycle
  endVc: number; // capacitor voltage as the burst ends
}

export function simulate(c: Circuit): Sim {
  const d0 = startDrop(c);
  let d = d0;
  let minV = Infinity;
  let minStep = 0;
  let peak = cellI(c, d, c.iSleep);
  const see = (v: number, n: number) => {
    if (v < minV - 1e-12) {
      minV = v;
      minStep = n;
    }
  };
  c.steps.forEach((s, n) => {
    see(nodeV(c, d, s.i), n);
    peak = Math.max(peak, cellI(c, d, s.i));
    d = relax(c, d, s.i, s.t);
    see(nodeV(c, d, s.i), n);
    peak = Math.max(peak, cellI(c, d, s.i));
  });
  // Between bursts: as the burst ends, and just before the next (a large sleep current can be the worst case).
  // Within each stretch of constant current the voltage and cell current move one way, so the ends suffice.
  see(nodeV(c, d, c.iSleep), -1);
  see(nodeV(c, d0, c.iSleep), -1);
  peak = Math.max(peak, cellI(c, d, c.iSleep));
  return { minV, minStep, startV: nodeV(c, d0, c.iSleep), restV: c.voc - c.r * c.iSleep, peakCellA: peak, endVc: c.voc - d };
}

/**
 * The smallest capacitance (F, in the circuit) at and above which the load stays at or above `need`: 0 when none
 * is needed, Infinity when even 100 F does not do it. The lowest voltage is not always monotonic in C (with ESR, a
 * mid-sized capacitor can drain in one step, miss its refill in a pause and meet a sharp peak low), so it scans a
 * log grid for the last failing value, then bisects between it and the next.
 */
export function capNeeded(c: Circuit, need: number): number {
  const ok = (cap: number) => simulate({ ...c, c: cap }).minV >= need;
  if (ok(0)) return 0;
  const grid = Array.from({ length: 111 }, (_, k) => 10 ** (-9 + k / 10)); // 1 nF to 100 F, 10 per decade
  let lastFail = -1;
  grid.forEach((cap, k) => {
    if (!ok(cap)) lastFail = k;
  });
  if (lastFail === grid.length - 1) return Infinity;
  if (lastFail < 0) return grid[0];
  let lo = grid[lastFail];
  let hi = grid[lastFail + 1];
  for (let n = 0; n < 40; n++) {
    const mid = Math.sqrt(lo * hi);
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Why no capacitor up to 100 F works, from the limit as C grows without bound. */
export type NoCap = 'rest' | 'average' | 'esr' | 'size';
export function whyNoCap(c: Circuit, need: number): NoCap {
  if (c.voc - c.r * c.iSleep < need) return 'rest';
  const avg = averageOf(c);
  if (c.voc - c.r * avg < need) return 'average';
  const peak = Math.max(...c.steps.map((s) => s.i));
  // An endless capacitor sits at Voc − R·Iavg; each step adds (I − Iavg)·(R ∥ ESR) on top.
  if (c.voc - c.r * avg - (peak - avg) * ((c.r * c.esr) / (c.r + c.esr)) < need) return 'esr';
  return 'size';
}

/**
 * The series resistor that holds the cell's peak current to `limit` (A), by bisection, given the rest of the
 * circuit (`c.r` already includes any series resistor entered, `ri` is the cell's own resistance). The peak falls
 * steadily as the resistance rises. NaN when no resistor up to 10 kΩ does it.
 */
export function seriesFor(c: Circuit, ri: number, limit: number): number {
  const peak = (rs: number) => simulate({ ...c, r: ri + rs }).peakCellA;
  if (peak(0) <= limit) return 0;
  let lo = 0;
  let hi = 1e4;
  if (peak(hi) > limit) return NaN;
  for (let n = 0; n < 60; n++) {
    const mid = (lo + hi) / 2;
    if (peak(mid) <= limit) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Points for a plot of the load voltage and current over the burst and the start of the refill. */
export function trace(c: Circuit, tail: number, per = 24) {
  const pts: { t: number; v: number; i: number }[] = [];
  let d = startDrop(c);
  let t0 = 0;
  const steps = [...c.steps, { i: c.iSleep, t: tail }];
  for (const s of steps) {
    for (let k = 0; k <= per; k++) {
      const dt = (s.t * k) / per;
      pts.push({ t: t0 + dt, v: nodeV(c, relax(c, d, s.i, dt), s.i), i: s.i });
    }
    d = relax(c, d, s.i, s.t);
    t0 += s.t;
  }
  return pts;
}

export interface LifeRow {
  key: Exclude<CellPick, 'own'>;
  vocV: number;
  riOhm: number; // with the cold factor
  minV: number; // with the capacitor as entered
  directMinV: number; // without a capacitor
  capNeededF: number; // in the circuit
}

export interface PulseResult {
  ok: true;
  circuit: Circuit;
  sim: Sim;
  need: number; // floor plus margin
  chargeC: number; // charge drawn by one burst
  burstS: number;
  peakA: number; // highest load current
  directMinV: number; // lowest load voltage with no capacitor
  directMaxA: number; // the largest load current the cell can carry directly and stay above `need`
  plainF: number; // C = Q / ΔV, with no help from the cell (NaN when ΔV ≤ 0)
  plainDv: number; // the ΔV it uses: Voc − R·Isleep − need − Ipeak · ESR
  capNeededF: number; // smallest capacitance in the circuit that works, with the cell's help
  whyNone: NoCap | ''; // when capNeededF is Infinity
  capInCircuitF: number;
  tauS: number; // refill time constant, (R + ESR) · C
  refillS: number; // time to refill 99 % of the drop
  inrushA: number; // fitting a cell to an empty capacitor
  avgA: number; // NaN without a period
  lifeH: number; // capacity / average, NaN without both
  seriesForLimit: number; // Ω, NaN without a limit or when none works
  life: LifeRow[];
}
export type Result = { ok: false; error: string } | PulseResult;

type Rule = 'positive' | 'nonNegative' | 'optionalPositive' | 'optionalNonNegative' | 'percent';
type NumKey = { [K in keyof PulseInputs]: PulseInputs[K] extends number ? K : never }[keyof PulseInputs];
export const inputRules: Record<NumKey, Rule> = {
  vocV: 'positive',
  riOhm: 'positive',
  coldX: 'positive',
  capacityMAh: 'optionalPositive',
  periodMs: 'optionalPositive',
  sleepUA: 'optionalNonNegative',
  floorV: 'positive',
  marginV: 'nonNegative',
  capUF: 'optionalNonNegative',
  capLossPct: 'percent',
  esrOhm: 'optionalNonNegative',
  seriesOhm: 'optionalNonNegative',
  limitMA: 'optionalPositive',
};
export function meetsRule(rule: Rule, n: number): boolean {
  if (rule === 'optionalPositive') return Number.isNaN(n) || (Number.isFinite(n) && n > 0);
  if (rule === 'optionalNonNegative') return Number.isNaN(n) || (Number.isFinite(n) && n >= 0);
  if (rule === 'percent') return Number.isNaN(n) || (Number.isFinite(n) && n >= 0 && n < 100);
  if (!Number.isFinite(n)) return false;
  if (rule === 'positive') return n > 0;
  return n >= 0;
}
/** Sensible ranges, which also keep the arithmetic clear of overflow and underflow. */
export const limits: Record<NumKey, [number, number]> = {
  vocV: [0.1, 60],
  riOhm: [1e-3, 1e6],
  coldX: [0.1, 100],
  capacityMAh: [1e-3, 1e7],
  periodMs: [1e-3, 1e11],
  sleepUA: [0, 1e6],
  floorV: [0.1, 60],
  marginV: [0, 10],
  capUF: [0, 1e8],
  capLossPct: [0, 100],
  esrOhm: [0, 1e4],
  seriesOhm: [0, 1e6],
  limitMA: [1e-3, 1e5],
};
export function fieldOk(k: NumKey, n: number) {
  if (!meetsRule(inputRules[k], n)) return false;
  if (Number.isNaN(n)) return true;
  if (k === 'capUF' && n > 0 && n < 1e-6) return false;
  return n >= limits[k][0] && n <= limits[k][1];
}
export const stepOk = (s: Step) =>
  Number.isFinite(s.mA) && s.mA >= 0 && s.mA <= 1e5 && Number.isFinite(s.us) && s.us >= 1e-3 && s.us <= 1e9;

export function inputError(i: PulseInputs): string {
  for (const k of Object.keys(inputRules) as NumKey[])
    if (!fieldOk(k, i[k])) return k === 'capLossPct' ? 'Capacitance lost is a percentage below 100.' : 'Check the highlighted inputs: one is empty or out of range.';
  if (!i.steps.length) return 'Add at least one step to the burst.';
  if (!i.steps.every(stepOk)) return 'Each step needs a current from 0 to 100 A and a time from 1 ns to 1000 s.';
  if (!i.steps.some((s) => s.mA > 0)) return 'The burst draws no current.';
  if (Number.isFinite(i.periodMs) && i.periodMs * 1e3 <= sumUs(i.steps)) return 'The time between bursts must be longer than the burst itself.';
  if (i.floorV + i.marginV >= i.vocV) return 'The lowest supply plus its margin is at or above the cell’s open-circuit voltage.';
  return '';
}

export function calculate(i: PulseInputs): Result {
  const error = inputError(i);
  if (error) return { ok: false, error };
  const c = circuitOf(i);
  const need = i.floorV + i.marginV;
  const sim = simulate(c);
  const chargeC = c.steps.reduce((s, x) => s + x.i * x.t, 0);
  const burstS = c.steps.reduce((s, x) => s + x.t, 0);
  const peakA = Math.max(...c.steps.map((s) => s.i));
  const rest = c.voc - c.r * c.iSleep;
  const plainDv = rest - need - peakA * c.esr;
  const tauS = (c.r + c.esr) * c.c;
  const avgA = Number.isFinite(c.gap) ? averageOf(c) : NaN;
  const capNeededF = capNeeded(c, need);
  const lifeRow = (key: Exclude<CellPick, 'own'>): LifeRow => {
    const cell = cells[key];
    const lc = circuitOf(i, { voc: cell.vocV, ri: cell.riOhm });
    return {
      key,
      vocV: cell.vocV,
      riOhm: cell.riOhm * i.coldX,
      minV: simulate(lc).minV,
      directMinV: simulate({ ...lc, c: 0 }).minV,
      capNeededF: capNeeded(lc, need),
    };
  };
  return {
    ok: true,
    circuit: c,
    sim,
    need,
    chargeC,
    burstS,
    peakA,
    directMinV: simulate({ ...c, c: 0 }).minV,
    directMaxA: (c.voc - need) / c.r,
    plainF: plainDv > 0 ? chargeC / plainDv : NaN,
    plainDv,
    capNeededF,
    whyNone: Number.isFinite(capNeededF) ? '' : whyNoCap(c, need),
    capInCircuitF: c.c,
    tauS,
    refillS: tauS * Math.log(100),
    inrushA: c.voc / (c.r + c.esr),
    avgA,
    lifeH: Number.isFinite(avgA) && Number.isFinite(i.capacityMAh) ? (i.capacityMAh * 3.6) / avgA / 3600 : NaN,
    seriesForLimit: Number.isFinite(i.limitMA) ? seriesFor(c, i.riOhm * i.coldX, i.limitMA * 1e-3) : NaN,
    life: (Object.keys(cells) as Exclude<CellPick, 'own'>[]).map(lifeRow),
  };
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
export const seconds = (n: number) => si(n, 's');
export const farads = (n: number) => si(n, 'F');
export const ohms = (n: number) => si(n, 'Ω', 3, true);
/** Coulombs, shown as µC for a burst. */
export const coulombs = (n: number) => si(n, 'C');
