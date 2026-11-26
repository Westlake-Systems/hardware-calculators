// PCB trace width and via current calculator (/tools/trace-width/). The common curve fit to the
// IPC-2221 charts, I = k · ΔT^0.44 · A^0.725 (I in A, ΔT in °C, A in square mils; k = 0.048 for
// outer layers, 0.024 for inner layers), solved three ways: the width for a current, the current
// for a width, and the temperature rise for a current and width. An optional voltage-drop limit
// can set the width (or current) instead of heating. Also the trace's DC resistance, voltage drop
// and power loss, and the same for vias (plated barrel cross-section treated like a trace).
// Pure functions, no DOM.
//
// Units used internally: millimetres for lengths, micrometres for copper and plating thickness.
// 1 oz/ft² copper is taken as 35 µm (1.378 mil), the usual nominal value.
//
// Test vectors (checked by scripts/test-trace.ts in the site repository):
// - 1 A, 10 °C rise, 1 oz, outer layer: A = (1 / (0.048 · 10^0.44))^(1/0.725) = 16.3 mil²,
//   width 16.3 / 1.378 = 11.8 mil = 0.300 mm (the commonly quoted "about 12 mil").
// - 2 A, 10 °C rise, 1 oz, outer layer: 42.4 mil², 30.8 mil (0.78 mm). A published worked example
//   gets 42.2 mil² and 30.8 mil with 1 oz = 1.37 mil.
// - Inner layer: same current, rise and copper need 2^(1/0.725) = 2.60 × the width.
// - 10 mil wide, 1 oz, 1 inch long at 25 °C: 1.724e-8 · (1 + 0.00393 · 5) · 0.0254 m /
//   (10 · 1.378 · 25.4e-6² m²) = 0.0502 Ω.
// - Rise for 1 A in 0.300 mm, 1 oz, outer: (1 / (0.048 · 16.3^0.725))^(1/0.44) = 10 °C.

export type Layer = 'outer' | 'inner';
/** 'width': width for a current; 'current': current for a width; 'rise': rise for a current and width. */
export type Mode = 'width' | 'current' | 'rise';
/** How the via hole is given: finished (after plating, as CAD shows it) or drilled. */
export type HoleKind = 'finished' | 'drilled';
/** The allowed voltage drop, in millivolts or as a percentage of the supply. */
export type DropUnit = 'mV' | 'pct';

export interface TraceInputs {
  mode: Mode;
  currentA: number; // used in 'width' and 'rise' modes
  riseC: number; // allowed temperature rise above ambient; used in 'width' and 'current' modes
  copperUm: number; // finished copper thickness
  layer: Layer;
  widthMm: number; // used in 'current' and 'rise' modes
  lengthMm: number; // one way
  ambientC: number;
  supplyV: number; // optional (NaN): shows the drop as a share of the supply
  dropLimit: number; // optional (NaN): allowed voltage drop, in `dropUnit`
  dropUnit: DropUnit;
  holeMm: number; // via hole diameter, finished or drilled per `holeKind`
  holeKind: HoleKind;
  platingUm: number; // via barrel plating thickness
  boardMm: number; // board thickness, the length of a through via
}

export const defaultTrace: TraceInputs = {
  mode: 'width',
  currentA: 1,
  riseC: 10,
  copperUm: 35,
  layer: 'outer',
  widthMm: 0.5,
  lengthMm: 50,
  ambientC: 25,
  supplyV: NaN,
  dropLimit: NaN,
  dropUnit: 'mV',
  holeMm: 0.3,
  holeKind: 'finished',
  platingUm: 20, // IPC-6012 Class 2, the common and the more cautious case
  boardMm: 1.6,
};

export const MM_PER_MIL = 0.0254;
export const UM_PER_OZ = 35;
export const copperWeights = [0.5, 1, 2, 3].map((oz) => ({ oz, um: oz * UM_PER_OZ }));

export const K: Record<Layer, number> = { outer: 0.048, inner: 0.024 };
const B = 0.44;
const C = 0.725;

/** Copper resistivity at 20 °C, Ω·m (annealed copper standard), and its temperature coefficient, 1/°C. */
export const RHO_20 = 1.724e-8;
export const ALPHA = 0.00393;

/**
 * The range the IPC-2221 curves are commonly quoted as covering. The inner-layer chart is the
 * outer-layer chart with the current halved, so it reaches 17.5 A where the outer one reaches 35 A.
 */
export const validity = {
  maxCurrentA: { outer: 35, inner: 17.5 } as Record<Layer, number>,
  maxWidthMil: 400,
  minRiseC: 10,
  maxRiseC: 100,
  minOz: 0.5,
  maxOz: 3,
};

/** Rises the comparison rows use (the chosen rise is left out). All inside the curves' range. */
export const comparisonRises = [10, 20, 40];
/** Ambient temperatures accepted; the linear resistivity model is not meant for more. */
export const ambientRange = { min: -55, max: 150 };
/** Above this running temperature the result carries a note about board and part ratings. */
export const HOT_C = 105;
/** Below this width (mm) the result notes that the board house's minimum width governs. */
export const MIN_ETCH_MM = 0.1;
/** At or above this share of the supply (%) the voltage drop gets a warning line. */
export const HIGH_DROP_PCT = 10;

type NumKey =
  | 'currentA'
  | 'riseC'
  | 'copperUm'
  | 'widthMm'
  | 'lengthMm'
  | 'ambientC'
  | 'supplyV'
  | 'dropLimit'
  | 'holeMm'
  | 'platingUm'
  | 'boardMm';
type Rule = 'positive' | 'nonNegative' | 'ambient' | 'optionalPositive';

/** What each numeric input must be, for validation and for marking fields invalid. */
export const inputRules: Record<NumKey, Rule> = {
  currentA: 'positive',
  riseC: 'positive',
  copperUm: 'positive',
  widthMm: 'positive',
  lengthMm: 'nonNegative',
  ambientC: 'ambient',
  supplyV: 'optionalPositive',
  dropLimit: 'optionalPositive',
  holeMm: 'positive',
  platingUm: 'positive',
  boardMm: 'positive',
};

/** The inputs each mode uses (the others are ignored). */
export const modeInputs: Record<Mode, NumKey[]> = {
  width: ['currentA', 'riseC'],
  current: ['widthMm', 'riseC'],
  rise: ['currentA', 'widthMm'],
};

/** Whether a value meets its rule. Empty (NaN) is valid only for optional inputs. */
export function meetsRule(rule: Rule, n: number): boolean {
  if (rule === 'optionalPositive') return Number.isNaN(n) || (Number.isFinite(n) && n > 0);
  if (!Number.isFinite(n)) return false;
  if (rule === 'positive') return n > 0;
  if (rule === 'nonNegative') return n >= 0;
  return n >= ambientRange.min && n <= ambientRange.max;
}

/** IPC-2221: current (A) a cross-section of `areaMil2` carries at a rise of `riseC`. */
export const currentFor = (areaMil2: number, riseC: number, layer: Layer) => K[layer] * riseC ** B * areaMil2 ** C;

/** IPC-2221 solved for the cross-section (square mils) that carries `currentA` at a rise of `riseC`. */
export const areaFor = (currentA: number, riseC: number, layer: Layer) => (currentA / (K[layer] * riseC ** B)) ** (1 / C);

/** IPC-2221 solved for the rise (°C) of a cross-section of `areaMil2` carrying `currentA`. */
export const riseFor = (currentA: number, areaMil2: number, layer: Layer) => (currentA / (K[layer] * areaMil2 ** C)) ** (1 / B);

const mil = (mm: number) => mm / MM_PER_MIL;
const um2mil = (um: number) => um / 1000 / MM_PER_MIL;

/** Width (mm) for a current, rise, copper thickness and layer, from heating alone. */
export const widthFor = (currentA: number, riseC: number, copperUm: number, layer: Layer) =>
  (areaFor(currentA, riseC, layer) / um2mil(copperUm)) * MM_PER_MIL;

/** Copper resistivity at a temperature, Ω·m. */
export const rhoAt = (tempC: number) => RHO_20 * (1 + ALPHA * (tempC - 20));

/** DC resistance (Ω) of a copper conductor: cross-section in mm², length in mm. */
export const resistance = (areaMm2: number, lengthMm: number, tempC: number) =>
  (rhoAt(tempC) * lengthMm * 1e-3) / (areaMm2 * 1e-6);

/** Width (mm) that holds the drop to `dropV`: w = ρ(T) · I · L / (ΔV · t). */
export const widthForDrop = (currentA: number, lengthMm: number, dropV: number, copperUm: number, tempC: number) =>
  ((rhoAt(tempC) * currentA * lengthMm * 1e-3) / (dropV * copperUm * 1e-6)) * 1000;

/**
 * Copper cross-section of a via barrel (mm²) with plating `platingUm`. A finished hole d_f gives
 * π·t·(d_f + t); a drilled hole d, with the plating grown inward, gives π·t·(d − t).
 */
export const barrelArea = (holeMm: number, platingUm: number, kind: HoleKind = 'drilled') => {
  const t = platingUm / 1000;
  return kind === 'finished' ? Math.PI * t * (holeMm + t) : Math.PI * t * (holeMm - t);
};

export interface Flag {
  /** What is outside the formula's range, in plain words. */
  text: string;
}

/** Relative tolerance for the range checks, so a value carried across modes (9.9999… °C) is not flagged. */
const EPS = 1e-6;

/**
 * Inputs or results outside the range the IPC-2221 curves cover. A low rise is flagged only when it
 * is an input (`lowRiseCounts`): a computed rise below the curves just means a cool trace.
 */
export function rangeFlags(
  layer: Layer,
  currentA: number,
  widthMm: number,
  riseC: number,
  copperUm: number,
  lowRiseCounts = true,
): Flag[] {
  const v = validity;
  const flags: Flag[] = [];
  const maxA = v.maxCurrentA[layer];
  const oz = copperUm / UM_PER_OZ;
  if (currentA > maxA * (1 + EPS))
    flags.push({ text: `The current is above ${maxA} A${layer === 'inner' ? ', the top of the inner-layer curves' : ''}.` });
  if (mil(widthMm) > v.maxWidthMil * (1 + EPS)) flags.push({ text: `The width is above ${v.maxWidthMil} mil (${(v.maxWidthMil * MM_PER_MIL).toFixed(1)} mm).` });
  if (lowRiseCounts && riseC < v.minRiseC * (1 - EPS)) flags.push({ text: `The temperature rise is below ${v.minRiseC} °C.` });
  if (riseC > v.maxRiseC * (1 + EPS)) flags.push({ text: `The temperature rise is above ${v.maxRiseC} °C.` });
  if (oz < v.minOz - 0.01 || oz > v.maxOz + 0.01) flags.push({ text: `The copper is outside ${v.minOz} to ${v.maxOz} oz.` });
  return flags;
}

/** One trace solved: the three quantities, and which limit set the answer. */
export interface Solved {
  widthMm: number;
  currentA: number;
  /** The rise the trace actually reaches: below the allowed rise when the drop sets the answer. */
  riseC: number;
  /** 'heat' or 'drop' when a drop limit is set in width or current mode; otherwise null. */
  governs: 'heat' | 'drop' | null;
  /** The answer from heating alone (width or current mode). */
  heatOnly: number;
}

/**
 * Root of a decreasing function `f` between `lo` (f > 0) and `hi` (f <= 0), by bisection: slower
 * than fixed-point steps, but it converges for every input.
 */
function bisect(f: (x: number) => number, lo: number, hi: number): number {
  for (let n = 0; n < 200 && hi - lo > 1e-14 * hi; n++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Solves one trace for the mode's unknown. `dropV` is the allowed drop in volts, or NaN. When the
 * drop sets the answer, the trace runs cooler than the allowed rise, and the copper's resistance is
 * worked out at the rise it actually reaches, found by bisection.
 */
export function solve(i: TraceInputs, dropV: number): Solved {
  const tM = (i.copperUm / 1000) * 1e-3; // copper thickness, m
  const hasLimit = dropV > 0 && i.lengthMm > 0;
  const areaOf = (wMm: number) => mil(wMm) * um2mil(i.copperUm);
  if (i.mode === 'width') {
    const heat = widthFor(i.currentA, i.riseC, i.copperUm, i.layer);
    // The widest the drop can call for: the copper at the full allowed rise.
    const most = hasLimit ? widthForDrop(i.currentA, i.lengthMm, dropV, i.copperUm, i.ambientC + i.riseC) : 0;
    if (most <= heat) return { widthMm: heat, currentA: i.currentA, riseC: i.riseC, governs: hasLimit ? 'heat' : null, heatOnly: heat };
    // Between `heat` and `most`, find the width whose own rise gives exactly the allowed drop.
    const excess = (w: number) =>
      widthForDrop(i.currentA, i.lengthMm, dropV, i.copperUm, i.ambientC + riseFor(i.currentA, areaOf(w), i.layer)) - w;
    const w = Math.max(bisect(excess, heat, most), heat);
    return { widthMm: w, currentA: i.currentA, riseC: riseFor(i.currentA, areaOf(w), i.layer), governs: 'drop', heatOnly: heat };
  }
  if (i.mode === 'current') {
    const area = areaOf(i.widthMm);
    const heat = currentFor(area, i.riseC, i.layer);
    const areaM2 = i.widthMm * 1e-3 * tM;
    const dropAt = (tempC: number) => (dropV * areaM2) / (rhoAt(tempC) * i.lengthMm * 1e-3);
    const least = hasLimit ? dropAt(i.ambientC + i.riseC) : Infinity;
    if (least >= heat) return { widthMm: i.widthMm, currentA: heat, riseC: i.riseC, governs: hasLimit ? 'heat' : null, heatOnly: heat };
    // Between 0 and `heat`, find the current whose own rise gives exactly the allowed drop.
    const room = (c: number) => dropAt(i.ambientC + riseFor(c, area, i.layer)) - c;
    const cur = Math.min(bisect(room, 0, heat), heat);
    return { widthMm: i.widthMm, currentA: cur, riseC: riseFor(cur, area, i.layer), governs: 'drop', heatOnly: heat };
  }
  return {
    widthMm: i.widthMm,
    currentA: i.currentA,
    riseC: riseFor(i.currentA, mil(i.widthMm) * um2mil(i.copperUm), i.layer),
    governs: null,
    heatOnly: NaN,
  };
}

/** A comparison row: the same trace with one thing changed. */
export interface Row extends Solved {
  /** What changed: the other layer, a rise in °C, a copper weight in oz, or twice the width. */
  change: { layer: Layer } | { riseC: number } | { oz: number } | { doubleWidth: true };
  /** The row falls outside the range the curves cover. */
  outside: boolean;
}

/** A computed rise within this of 10 °C displays as 10.0 °C and counts as at the curves' lowest line. */
export const COOL_MARGIN_C = 0.005;

/** In rise mode the vias are sized at no less than this rise, the curves' lowest line. */
export const MIN_VIA_RISE_C = 10;

export interface ViaResult {
  areaMm2: number;
  /** Current per via with the outer-layer constant, as is common, and with the inner-layer one. */
  perViaA: number;
  perViaInnerA: number;
  /** Vias needed for the trace current, with each constant. */
  count: number;
  countInner: number;
  resistanceOhm: number; // one via, at the operating temperature
  groupOhm: number; // `count` vias in parallel
}

export interface TraceResult extends Solved {
  ok: true;
  areaMm2: number; // trace copper cross-section
  rows: Row[];
  tempC: number; // ambient plus rise: the temperature the resistance is worked out at
  resistanceOhm: number;
  dropV: number;
  dropPct: number; // NaN without a supply voltage
  powerW: number;
  /** The allowed drop in volts (NaN when not set or not usable), and why a % limit was not used. */
  dropLimitV: number;
  dropLimitNote: string;
  /** The drop sets the answer, so the rows for other rises are left out (they would all match). */
  riseRowsDropped: boolean;
  /** Rise mode: the computed rise is below the curves' lowest line (a cool trace, not a flag). */
  cool: boolean;
  /** The rise the vias are sized at: the allowed rise, or in rise mode max(rise, 10 °C). */
  viaRiseC: number;
  /** Rise mode: the width a 10 °C rise would need. Current mode: the rise at 80 % of the current. */
  widthFor10Mm: number;
  riseAt80C: number;
  via: ViaResult | null;
  /** Why there are no via figures, when there are none. */
  viaError: string;
  flags: Flag[];
  /** Ambient plus rise is above HOT_C. */
  hot: boolean;
  /** The width, or a width in the comparison rows, is below MIN_ETCH_MM (width mode). */
  narrow: boolean;
  /** The drop is HIGH_DROP_PCT of the supply or more. */
  highDrop: boolean;
}

export type Result = { ok: false; error: string } | TraceResult;

/** The first input error for this mode, or '' when the inputs are usable. */
export function inputError(i: TraceInputs): string {
  const used = modeInputs[i.mode];
  const bad = (k: NumKey) => used.includes(k) && !meetsRule(inputRules[k], i[k]);
  if (bad('currentA')) return 'Enter the current the trace carries.';
  if (bad('widthMm')) return 'Enter the trace width.';
  if (bad('riseC')) return 'Enter the temperature rise you can allow, above 0 °C.';
  if (!meetsRule(inputRules.copperUm, i.copperUm)) return 'Enter the copper thickness.';
  if (!Number.isFinite(i.lengthMm)) return 'Enter the trace length.';
  if (i.lengthMm < 0) return 'Trace length cannot be negative.';
  if (!Number.isFinite(i.ambientC)) return 'Enter the ambient temperature.';
  if (!meetsRule(inputRules.ambientC, i.ambientC))
    return `Enter an ambient temperature from ${ambientRange.min} to ${ambientRange.max} °C.`;
  if (!meetsRule(inputRules.supplyV, i.supplyV)) return 'Enter a supply voltage above 0, or leave it empty.';
  if (!meetsRule(inputRules.dropLimit, i.dropLimit)) return 'Enter an allowed voltage drop above 0, or leave it empty.';
  return '';
}

export function calculate(i: TraceInputs): Result {
  const error = inputError(i);
  if (error) return { ok: false, error };

  const hasSupply = i.supplyV > 0;
  let dropLimitV = NaN;
  let dropLimitNote = '';
  if (i.dropLimit > 0) {
    if (i.dropUnit === 'mV') dropLimitV = i.dropLimit / 1000;
    else if (hasSupply) dropLimitV = (i.dropLimit / 100) * i.supplyV;
    else dropLimitNote = 'Your drop limit is a percentage of the supply, so it is not used until you enter the supply voltage.';
  }

  const s = solve(i, dropLimitV);
  const tempC = i.ambientC + s.riseC;
  const areaMm2 = s.widthMm * (i.copperUm / 1000);
  const resistanceOhm = resistance(areaMm2, i.lengthMm, tempC);
  const dropV = s.currentA * resistanceOhm;
  const dropPct = hasSupply ? (100 * dropV) / i.supplyV : NaN;

  // Comparison rows: the same trace with one thing changed, solved the same way.
  const rows: Row[] = [];
  const row = (change: Row['change'], over: Partial<TraceInputs>) => {
    const j = { ...i, ...over };
    // Rise mode keeps the current and width; the others re-solve for their unknown.
    const r = solve(j, dropLimitV);
    const outside = rangeFlags(j.layer, r.currentA, r.widthMm, r.governs === 'drop' ? j.riseC : r.riseC, j.copperUm, i.mode !== 'rise');
    rows.push({ ...r, change, outside: outside.length > 0 });
  };
  const other: Layer = i.layer === 'outer' ? 'inner' : 'outer';
  row({ layer: other }, { layer: other });
  const riseRowsDropped = s.governs === 'drop';
  if (i.mode !== 'rise' && !riseRowsDropped) for (const rise of comparisonRises.filter((r) => Math.abs(r - i.riseC) > 1e-9)) row({ riseC: rise }, { riseC: rise });
  const oz = i.copperUm / UM_PER_OZ;
  const next = copperWeights.find((w) => w.oz > oz + 0.01) ?? copperWeights.filter((w) => w.oz < oz - 0.01).at(-1);
  if (i.mode !== 'current' && next) row({ oz: next.oz }, { copperUm: next.um });
  if (i.mode !== 'width') row({ doubleWidth: true }, { widthMm: i.widthMm * 2 });

  // Vias carry the trace current at the allowed rise; in rise mode at no less than the curves' lowest line.
  const viaRiseC = i.mode === 'rise' ? Math.max(s.riseC, MIN_VIA_RISE_C) : i.riseC;
  let via: ViaResult | null = null;
  let viaError = '';
  const r = inputRules;
  if (!meetsRule(r.holeMm, i.holeMm)) viaError = 'Enter the via hole diameter to see the via figures.';
  else if (!meetsRule(r.platingUm, i.platingUm)) viaError = 'Enter the plating thickness to see the via figures.';
  else if (!meetsRule(r.boardMm, i.boardMm)) viaError = 'Enter the board thickness to see the via figures.';
  else if (i.holeKind === 'drilled' && i.platingUm / 1000 >= i.holeMm / 2)
    viaError = 'The plating is at least half the drill diameter, which closes the hole: check the drill and plating.';
  else {
    const viaMm2 = barrelArea(i.holeMm, i.platingUm, i.holeKind);
    const viaMil2 = viaMm2 / MM_PER_MIL ** 2;
    const perViaA = currentFor(viaMil2, viaRiseC, 'outer');
    const perViaInnerA = currentFor(viaMil2, viaRiseC, 'inner');
    const count = Math.max(1, Math.ceil(s.currentA / perViaA - 1e-9));
    const rVia = resistance(viaMm2, i.boardMm, tempC);
    via = {
      areaMm2: viaMm2,
      perViaA,
      perViaInnerA,
      count,
      countInner: Math.max(1, Math.ceil(s.currentA / perViaInnerA - 1e-9)),
      resistanceOhm: rVia,
      groupOhm: rVia / count,
    };
  }

  const areaMil2 = mil(s.widthMm) * um2mil(i.copperUm);
  return {
    ok: true,
    ...s,
    areaMm2,
    rows,
    tempC,
    resistanceOhm,
    dropV,
    dropPct,
    powerW: s.currentA * dropV,
    dropLimitV,
    dropLimitNote,
    riseRowsDropped,
    // Below 9.995 °C, so a rise that displays as 10.0 °C is not called cool.
    cool: i.mode === 'rise' && s.riseC < validity.minRiseC - COOL_MARGIN_C,
    viaRiseC,
    widthFor10Mm: i.mode === 'rise' ? widthFor(s.currentA, 10, i.copperUm, i.layer) : NaN,
    riseAt80C: i.mode === 'current' ? riseFor(0.8 * s.currentA, areaMil2, i.layer) : NaN,
    via,
    viaError,
    // Flag the allowed rise (an input), not the lower rise a drop-limited trace reaches.
    flags: rangeFlags(i.layer, s.currentA, s.widthMm, s.governs === 'drop' ? i.riseC : s.riseC, i.copperUm, i.mode !== 'rise'),
    hot: tempC > HOT_C,
    narrow: i.mode === 'width' && [s.widthMm, ...rows.map((x) => x.widthMm)].some((w) => w < MIN_ETCH_MM),
    highDrop: dropPct >= HIGH_DROP_PCT,
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

/** Millimetres and mils to three significant figures; tiny widths read "under 0.01 mm". */
export const mm = (n: number) => (n > 0 && n < 0.01 ? 'under 0.01 mm' : `${num(n)} mm`);
export const milOf = (mmValue: number) => {
  const m = mmValue / MM_PER_MIL;
  return m > 0 && m < 0.1 ? 'under 0.1 mil' : `${num(m)} mil`;
};

/** A value with a milli or kilo prefix where it reads better, rounded before choosing. */
function scaled(n: number, unit: string): string {
  const r = Number(n.toPrecision(3));
  if (r !== 0 && Math.abs(r) < 1) return `${num(r * 1000)} m${unit}`;
  if (Math.abs(r) >= 1000) return `${num(r / 1000)} k${unit}`;
  return `${num(r)} ${unit}`;
}
export const amps = (n: number) => scaled(n, 'A');
export const volts = (n: number) => scaled(n, 'V');
export const watts = (n: number) => scaled(n, 'W');
export const ohms = (n: number) => scaled(n, 'Ω');
