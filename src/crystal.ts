// Crystal load capacitor calculator (/tools/crystal-load-caps/). Pierce oscillator: one
// capacitor from each crystal pin to ground. The crystal sees the two in series (through
// ground) plus the stray capacitance in parallel: CL = C1·C2 / (C1 + C2) + Cstray.
// Pure functions, no DOM.

export interface CrystalInputs {
  frequencyMHz: number;
  loadPF: number; // CL from the crystal datasheet
  strayPF: number; // pins, traces, and pads, as the crystal sees it
  // Optional crystal and oscillator details (NaN when not given)
  esrOhm: number; // maximum ESR from the crystal datasheet
  c0PF: number; // shunt capacitance
  cmFF: number; // motional capacitance, fF
  gmMAV: number; // oscillator transconductance, mA/V, from the MCU datasheet
}

export const defaultCrystal: CrystalInputs = {
  // A typical 16 MHz crystal on a microcontroller: round numbers for illustration.
  frequencyMHz: 16,
  loadPF: 12,
  strayPF: 3.5,
  esrOhm: 50,
  c0PF: 3,
  cmFF: 5,
  gmMAV: NaN,
};

const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];

/** Standard values from 1 pF to 910 pF (or 820 pF for E12). */
export const series = (base: number[]) =>
  [1, 10, 100].flatMap((decade) => base.map((v) => Math.round(v * decade * 10) / 10));

export const e12 = series(E12);
export const e24 = series(E24);

/** Load capacitance the crystal sees for a given pair. */
export const loadOf = (c1: number, c2: number, stray: number) => (c1 * c2) / (c1 + c2) + stray;

/** Frequency offset in ppm from running at load `actual` instead of the specified load. */
export const pullingPpm = (cmFF: number, c0PF: number, specPF: number, actualPF: number) =>
  1e6 * ((cmFF * 1e-3) / 2) * (1 / (c0PF + actualPF) - 1 / (c0PF + specPF));

/** Critical transconductance (A/V) the oscillator needs to start: 4·ESR·(2πf)²·(C0 + CL)². */
export const gmCritical = (esrOhm: number, fHz: number, c0PF: number, loadPF: number) =>
  4 * esrOhm * (2 * Math.PI * fHz) ** 2 * ((c0PF + loadPF) * 1e-12) ** 2;

export interface Pair {
  label: string;
  c1: number;
  c2: number;
  load: number;
  /** Load error, pF. */
  error: number;
  /** Frequency offset from the load error, ppm (NaN without crystal details). */
  ppm: number;
}

export type CrystalResult =
  | { ok: false; error: string }
  | {
      ok: true;
      ideal: number; // each capacitor, equal pair, pF
      pairs: Pair[];
      /** What happens with the common mistake of fitting capacitors equal to CL. */
      mistake: Pair;
      gmCrit: number; // A/V, NaN without ESR and C0
      margin: number; // gm / gmCrit, NaN without gm
      rextStart: number; // ohms: reactance of C2 at f, for the chosen E12 pair
      marginWithRext: number; // NaN without gm
    };

const nearest = (values: number[], target: number) =>
  values.reduce((best, v) => (Math.abs(v - target) < Math.abs(best - target) ? v : best));

export function calculate(i: CrystalInputs): CrystalResult {
  if (!(i.frequencyMHz > 0)) return { ok: false, error: 'Enter the crystal frequency.' };
  if (!(i.loadPF > 0)) return { ok: false, error: 'Enter the load capacitance from the crystal datasheet.' };
  if (!(i.strayPF >= 0)) return { ok: false, error: 'Stray capacitance cannot be negative.' };
  if (i.strayPF >= i.loadPF)
    return {
      ok: false,
      error:
        'The stray capacitance alone reaches the load capacitance, so no external capacitors can work. Choose a crystal with a higher load capacitance, or check the stray estimate.',
    };

  const ideal = 2 * (i.loadPF - i.strayPF);
  if (ideal < 1)
    return {
      ok: false,
      error:
        'Each capacitor would be under 1 pF, too small to be practical. Choose a crystal with a higher load capacitance, or check the stray estimate.',
    };
  const hasDetails = i.cmFF > 0 && i.c0PF >= 0;
  const pair = (label: string, c1: number, c2: number): Pair => {
    const load = loadOf(c1, c2, i.strayPF);
    return {
      label,
      c1,
      c2,
      load,
      error: load - i.loadPF,
      ppm: hasDetails ? pullingPpm(i.cmFF, i.c0PF, i.loadPF, load) : NaN,
    };
  };

  const eq12 = nearest(e12, ideal);
  const eq24 = nearest(e24, ideal);
  // Best unequal E24 pair, if it is meaningfully closer than the equal one.
  let best = pair('', eq24, eq24);
  for (const a of e24)
    for (const b of e24) {
      if (b < a || b > a * 1.35) continue; // keep the pair close to symmetric
      const p = pair('', a, b);
      if (Math.abs(p.error) < Math.abs(best.error) - 0.05) best = p;
    }

  const pairs = [pair('Equal, E12 values', eq12, eq12)];
  if (eq24 !== eq12) pairs.push(pair('Equal, E24 values', eq24, eq24));
  if (best.c1 !== best.c2) pairs.push({ ...best, label: 'Closest E24 pair' });

  const fHz = i.frequencyMHz * 1e6;
  const chosen = pairs[0];
  const gmCrit = i.esrOhm > 0 && i.c0PF >= 0 ? gmCritical(i.esrOhm, fHz, i.c0PF, chosen.load) : NaN;
  const rextStart = 1 / (2 * Math.PI * fHz * chosen.c2 * 1e-12);
  const gm = i.gmMAV / 1000;
  const margin = gm > 0 ? gm / gmCrit : NaN;
  const marginWithRext =
    gm > 0 && i.esrOhm > 0 ? gm / gmCritical(i.esrOhm + rextStart, fHz, i.c0PF, chosen.load) : NaN;

  const mistakeC = Math.round(i.loadPF * 10) / 10;
  return {
    ok: true,
    ideal,
    pairs,
    mistake: pair('Capacitors equal to CL', mistakeC, mistakeC),
    gmCrit,
    margin,
    rextStart,
    marginWithRext,
  };
}

export const pF = (n: number) => `${Number(n.toFixed(n < 10 ? 2 : 1))} pF`;
export const ppm = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Number(Math.abs(n).toFixed(1))} ppm`;

/** Ohms as Ω or kΩ, three significant figures. */
export function ohms(n: number): string {
  if (n >= 1e6) return `${Number((n / 1e6).toPrecision(3))} MΩ`;
  if (n >= 1000) return `${Number((n / 1000).toPrecision(3))} kΩ`;
  return `${Number(n.toPrecision(3))} Ω`;
}
