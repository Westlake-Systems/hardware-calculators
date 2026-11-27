// PCB controlled impedance calculator (/tools/pcb-impedance/). Closed-form, quasi-static (TEM)
// models for five structures, each checked against a 2D field solver (scripts/impedance-fieldsolve.py
// and the reference set in scripts/impedance-reference.json, run by scripts/test-impedance.ts):
//
// - Microstrip: Hammerstad and Jensen (1980), with their copper-thickness correction.
// - Stripline (symmetric): Wheeler (1978), finite thickness. Offset (asymmetric) stripline: the line
//   seen as the two symmetric striplines its two dielectrics would form, capacitances averaged
//   (as in IPC-2141), with a two-constant correction fitted to the field-solver set.
// - Grounded coplanar waveguide (CPWG): conformal mapping (infinitely wide side grounds, ground
//   below), the copper thickness as sidewall capacitance across each gap, and a correction fitted to
//   the field-solver set.
// - Edge-coupled (differential) microstrip: Kirschning and Jansen (1984) even and odd modes, zero
//   thickness, applied with the strip widened for thickness (less on the inner edge of a tight pair)
//   and the gap's sidewall capacitance added in the odd mode.
// - Edge-coupled (differential) stripline: Cohn (1955), exact for zero thickness, with his
//   thickness handled through the single line's (Wheeler) and his fringing-capacitance ratio, plus
//   the sidewalls facing each other in the odd mode; offset pairs as for offset stripline.
//
// Pure functions, no DOM. Lengths in millimetres, copper in micrometres.

export type Structure = 'microstrip' | 'stripline' | 'cpwg' | 'diffMicrostrip' | 'diffStripline';
/** 'impedance': impedance for a geometry; 'width': width for a target; 'spacing': pair spacing for a target. */
export type Mode = 'impedance' | 'width' | 'spacing';

export const isPair = (s: Structure) => s === 'diffMicrostrip' || s === 'diffStripline';
export const isStripline = (s: Structure) => s === 'stripline' || s === 'diffStripline';

/** Free-space wave impedance (Ω) and the speed of light (m/s). */
export const ETA0 = 376.730313668;
export const C0 = 299_792_458;
const PI = Math.PI;

export interface Geometry {
  structure: Structure;
  widthMm: number;
  /** Edge-to-edge gap between the two traces of a pair. */
  spacingMm: number;
  /** Gap from the trace edge to the coplanar ground (CPWG). */
  gapMm: number;
  /** Dielectric between the trace and the plane below (all structures). */
  heightMm: number;
  /** Stripline: dielectric between the top of the trace and the plane above. */
  aboveMm: number;
  copperUm: number;
  er: number;
  /** Solder mask over an outer-layer line: thickness over the copper (0 for none) and its εr. */
  maskUm: number;
  maskEr: number;
}

/** One line (single) or one pair (even and odd modes). */
export interface Line {
  /** Single-ended impedance: Z0 for single lines, the odd-mode impedance for pairs. */
  z0: number;
  /** Effective permittivity of the single line, or of the odd (differential) mode. */
  eeff: number;
  /** Pairs only (NaN otherwise). */
  zOdd: number;
  zEven: number;
  eOdd: number;
  eEven: number;
}

// ---------------------------------------------------------------------------------------------
// Elliptic integrals: K(k)/K(k') from the arithmetic-geometric mean, K(k) = π / (2 AGM(1, k')),
// so K(k)/K(k') = AGM(1, k) / AGM(1, k'). k and k' are passed separately to keep precision near 1.

function agm(a: number, b: number): number {
  if (b === 0) return 0;
  for (let i = 0; i < 60 && Math.abs(a - b) > 1e-15 * a; i++) [a, b] = [(a + b) / 2, Math.sqrt(a * b)];
  return a;
}
/** K(k)/K(k') for a modulus k with complement kp = √(1 − k²). */
export const ellipticRatio = (k: number, kp: number) => agm(1, k) / agm(1, kp);
const ratioOf = (k: number) => ellipticRatio(k, Math.sqrt((1 - k) * (1 + k)));
const coth = (x: number) => 1 / Math.tanh(x);
const lnCosh = (x: number) => Math.abs(x) + Math.log1p(Math.exp(-2 * Math.abs(x))) - Math.LN2;
const lnSinh = (x: number) => x + Math.log1p(-Math.exp(-2 * x)) - Math.LN2; // x > 0
/**
 * K(k)/K(k') for k = tanh α / tanh β (0 < α < β), with the complement from
 * 1 − k² = sinh(β − α) sinh(β + α) / (cosh α sinh β)², in logs, so k near 1 keeps its precision.
 */
function ratioTanh(alpha: number, beta: number): number {
  const lnKp = 0.5 * (lnSinh(beta - alpha) + lnSinh(beta + alpha)) - lnCosh(alpha) - lnSinh(beta);
  return ellipticRatio(Math.tanh(alpha) / Math.tanh(beta), Math.exp(lnKp));
}

// ---------------------------------------------------------------------------------------------
// Microstrip, Hammerstad and Jensen. u = w/h.

/** Impedance of a zero-thickness microstrip in air. */
export function z01(u: number): number {
  const f = 6 + (2 * PI - 6) * Math.exp(-((30.666 / u) ** 0.7528));
  return (ETA0 / (2 * PI)) * Math.log(f / u + Math.sqrt(1 + 4 / (u * u)));
}
/** Effective permittivity of a zero-thickness microstrip. */
export function eeffMicrostrip(u: number, er: number): number {
  const a = 1 + Math.log((u ** 4 + (u / 52) ** 2) / (u ** 4 + 0.432)) / 49 + Math.log(1 + (u / 18.1) ** 3) / 18.7;
  const b = 0.564 * ((er - 0.9) / (er + 3)) ** 0.053;
  return (er + 1) / 2 + ((er - 1) / 2) * (1 + 10 / u) ** (-a * b);
}
/** Hammerstad and Jensen's thickness widening, in units of h: in air (du1) and in the dielectric (dur). */
export function thicknessWidening(u: number, tOverH: number, er: number): { du1: number; dur: number } {
  if (!(tOverH > 0)) return { du1: 0, dur: 0 };
  const du1 = (tOverH / PI) * Math.log(1 + (4 * Math.E) / (tOverH * coth(Math.sqrt(6.517 * u)) ** 2));
  return { du1, dur: 0.5 * (1 + 1 / Math.cosh(Math.sqrt(er - 1))) * du1 };
}
export function microstrip(w: number, h: number, t: number, er: number): { z0: number; eeff: number } {
  const u = w / h;
  const { du1, dur } = thicknessWidening(u, t / h, er);
  const e = eeffMicrostrip(u + dur, er);
  const zr = z01(u + dur);
  return { z0: zr / Math.sqrt(e), eeff: e * (z01(u + du1) / zr) ** 2 };
}

// ---------------------------------------------------------------------------------------------
// Stripline, Wheeler. b = plane-to-plane spacing, t = copper thickness, trace centred.

export function striplineSymmetric(w: number, b: number, t: number, er: number): number {
  const x = t / b;
  let dw = 0;
  if (x > 0) {
    const m = 2 / (1 + (2 / 3) * (x / (1 - x)));
    dw = (x / (PI * (1 - x))) * (1 - 0.5 * Math.log((x / (2 - x)) ** 2 + ((0.0796 * x) / (w / b + 1.1 * x)) ** m));
  }
  const q = 1 / (w / (b - t) + dw); // (b − t) / W'
  const p = (8 / PI) * q;
  return (ETA0 / (4 * PI * Math.sqrt(er))) * Math.log(1 + (4 / PI) * q * (p + Math.sqrt(p * p + 6.27)));
}

/**
 * Offset stripline: the average of the capacitances of the two symmetric striplines that the
 * dielectric below (h1) and above (h2) would each form, b = 2h + t (exact when h1 = h2). That
 * average reads high as the trace moves off centre (up to about 5% in the field-solver set), so it is
 * scaled by 1 − 0.163 A² / (1 + 1.54 w/b), A = (h2 − h1)/(h2 + h1), b = h1 + t + h2: two constants
 * fitted to half the field-solver set and checked on the other half (within 0.6%).
 */
export const offsetFactor = (w: number, h1: number, h2: number, t: number) => {
  const a = (h2 - h1) / (h2 + h1);
  return 1 - (0.1628 * a * a) / (1 + (1.5432 * w) / (h1 + h2 + t));
};
export function stripline(w: number, h1: number, h2: number, t: number, er: number): number {
  if (Math.abs(h1 - h2) < 1e-12 * (h1 + h2)) return striplineSymmetric(w, 2 * h1 + t, t, er);
  const z1 = striplineSymmetric(w, 2 * h1 + t, t, er);
  const z2 = striplineSymmetric(w, 2 * h2 + t, t, er);
  return ((2 * z1 * z2) / (z1 + z2)) * offsetFactor(w, h1, h2, t);
}

// ---------------------------------------------------------------------------------------------
// Grounded coplanar waveguide. Conformal mapping, as normalised capacitances C/(2ε0): the slots in air
// above and the substrate between the strip and the ground below. The copper thickness adds the
// sidewalls facing each other across each gap. The conformal result reads high as the gaps widen (the
// air-side field reaching the ground below is not in it), so Z and εeff are corrected with seven
// constants fitted to half the field-solver set (gaps up to 2 h) and checked on the other half (Z
// within about 2%, εeff within 2.5%). Held at the plain microstrip where it would exceed it.

const CPWG_FIT = [1.0874, -0.0561, 1.1323, -0.0208, 0.0375, 0.4072, -0.0059];

export function cpwg(w: number, g: number, h: number, t: number, er: number): { z0: number; eeff: number } {
  const [side, z1, z2, z3, e1, e2, e3] = CPWG_FIT;
  const a = w / 2, b = w / 2 + g;
  const air = ratioOf(a / b) + (t > 0 ? (side * t) / g : 0);
  const sub = ratioTanh((PI * a) / (2 * h), (PI * b) / (2 * h));
  const cAir = air + sub;
  const c = air + er * sub;
  const x = g / h, tau = t / g;
  const z0 = (ETA0 / 2 / Math.sqrt(c * cAir)) * (1 + (z1 * x) / (1 + z2 * x) - z3 * tau);
  // Grounds beside a trace can only lower its impedance: with wide gaps (beyond the range checked)
  // the result is held at the plain microstrip's.
  const ms = microstrip(w, h, t, er);
  if (z0 > ms.z0) return ms;
  const eeff = 1 + (c / cAir - 1) * (1 - (e1 * x) / (1 + e2 * x) - e3);
  return { z0, eeff: Math.min(Math.max(eeff, 1), er) };
}

// ---------------------------------------------------------------------------------------------
// Edge-coupled microstrip, Kirschning and Jansen (static). u = w/h, g = s/h.

/** Kirschning and Jansen's spacing range is 0.1 to 10 h; beyond 10 h the coupling is negligible and held there. */
export const KJ_G = { min: 0.02, max: 10 };

export function coupledMicrostrip0(u: number, gIn: number, er: number) {
  const g = Math.min(Math.max(gIn, KJ_G.min), KJ_G.max);
  const e0 = eeffMicrostrip(u, er);
  const z0 = z01(u) / Math.sqrt(e0);
  const v = (u * (20 + g * g)) / (10 + g * g) + g * Math.exp(-g);
  const eEven = eeffMicrostrip(v, er);
  const a0 = 0.7287 * (e0 - (er + 1) / 2) * (1 - Math.exp(-0.179 * u));
  const b0 = (0.747 * er) / (0.15 + er);
  const c0 = b0 - (b0 - 0.207) * Math.exp(-0.414 * u);
  const d0 = 0.593 + 0.694 * Math.exp(-0.562 * u);
  const eOdd = ((er + 1) / 2 + a0 - e0) * Math.exp(-c0 * g ** d0) + e0;
  const q1 = 0.8695 * u ** 0.194;
  const q2 = 1 + 0.7519 * g + 0.189 * g ** 2.31;
  const q3 = 0.1975 + (16.6 + (8.4 / g) ** 6) ** -0.387 + Math.log(g ** 10 / (1 + (g / 3.4) ** 10)) / 241;
  const q4 = (2 * q1) / q2 / (Math.exp(-g) * u ** q3 + (2 - Math.exp(-g)) * u ** -q3);
  const q5 = 1.794 + 1.14 * Math.log(1 + 0.638 / (g + 0.517 * g ** 2.43));
  const q6 = 0.2305 + Math.log(g ** 10 / (1 + (g / 5.8) ** 10)) / 281.3 + Math.log(1 + 0.598 * g ** 1.154) / 5.1;
  const q7 = (10 + 190 * g * g) / (1 + 82.3 * g ** 3);
  const q8 = Math.exp(-6.5 - 0.95 * Math.log(g) - (g / 0.15) ** 5);
  const q9 = Math.log(q7) * (q8 + 1 / 16.5);
  const q10 = (q2 * q4 - q5 * Math.exp(Math.log(u) * q6 * u ** -q9)) / q2;
  const k = (z0 / ETA0) * Math.sqrt(e0);
  return {
    zEven: (z0 * Math.sqrt(e0 / eEven)) / (1 - k * q4),
    zOdd: (z0 * Math.sqrt(e0 / eOdd)) / (1 - k * q10),
    eEven,
    eOdd,
  };
}

/** Normalised capacitances C/ε0 of a mode, with and without the dielectric, from Z and εeff. */
const caps = (z: number, e: number) => ({ c: (Math.sqrt(e) * ETA0) / z, cAir: ETA0 / (z * Math.sqrt(e)) });

export function coupledMicrostrip(w: number, s: number, h: number, t: number, er: number) {
  const u = w / h, g = s / h;
  const { du1, dur } = thicknessWidening(u, t / h, er);
  // The single line's thickness widening: the outer edge widens freely, the inner edge more as the
  // gap opens (half the widening for a tight pair, all of it far apart: f = 1 − ½ e^(−0.1 s/h), the
  // constant chosen against the field-solver set), so a pair far apart becomes two single lines. In
  // the odd mode, add the sidewalls facing each other across the gap, ε0 · t / (s/2) per line.
  // Beyond KJ_G.max the coupling is held, and so is the sidewall term; the widening stops growing
  // at 5 h (the edge of the range checked), where it would otherwise outpace the fading coupling.
  // Both keep the impedance monotonic in s.
  const gc = Math.min(g, KJ_G.max);
  const f = 1 - 0.5 * Math.exp(-0.1 * Math.min(g, 5));
  const withDiel = coupledMicrostrip0(u + f * dur, g, er);
  const inAir = coupledMicrostrip0(u + f * du1, g, er);
  const side = (2 * t) / (gc * h);
  const even = { c: caps(withDiel.zEven, withDiel.eEven).c, cAir: caps(inAir.zEven, inAir.eEven).cAir };
  const odd = { c: caps(withDiel.zOdd, withDiel.eOdd).c + side, cAir: caps(inAir.zOdd, inAir.eOdd).cAir + side };
  // Coupling lowers the odd mode and raises the even mode from one trace alone; far apart, where
  // the approximations meet, hold them to that bound.
  const alone = microstrip(w, h, t, er).z0;
  return {
    zEven: Math.max(ETA0 / Math.sqrt(even.c * even.cAir), alone),
    zOdd: Math.min(ETA0 / Math.sqrt(odd.c * odd.cAir), alone),
    eEven: even.c / even.cAir,
    eOdd: odd.c / odd.cAir,
  };
}

// ---------------------------------------------------------------------------------------------
// Edge-coupled stripline, Cohn. b = plane spacing, trace centred.

/**
 * Zero thickness, exact: ke = tanh a · tanh c, ko = tanh a / tanh c, with a = πw/2b, c = π(w + s)/2b.
 * The complements are formed from hyperbolic identities, in logs, so wide traces (k near 1) keep
 * their precision.
 */
export function coupledStripline0(w: number, s: number, b: number, er: number) {
  const a = (PI * w) / (2 * b);
  const c = (PI * (w + s)) / (2 * b);
  const z = (k: number, lnKp: number) => (ETA0 / (4 * Math.sqrt(er))) * ellipticRatio(Math.exp(lnKp), k);
  // 1 − ke² = cosh(c − a) cosh(c + a) / (cosh a cosh c)²; 1 − ko² = sinh(c − a) sinh(c + a) / (cosh a sinh c)².
  const lnKe = 0.5 * (lnCosh(c - a) + lnCosh(c + a)) - lnCosh(a) - lnCosh(c);
  const lnKo = s > 0 ? 0.5 * (lnSinh(c - a) + lnSinh(c + a)) - lnCosh(a) - lnSinh(c) : -Infinity;
  return { zEven: z(Math.tanh(a) * Math.tanh(c), lnKe), zOdd: z(Math.tanh(a) / Math.tanh(c), lnKo) };
}

/**
 * Finite thickness: the zero-thickness modes moved by the single line's change with thickness
 * (Wheeler), scaled by the ratio of Cohn's thick-edge fringing capacitance to its zero-thickness value.
 */
export function coupledStriplineSymmetric(w: number, s: number, b: number, t: number, er: number) {
  const zero = coupledStripline0(w, s, b, er);
  if (!(t > 0)) return zero;
  const eta = ETA0 / Math.sqrt(er);
  const zs0 = striplineSymmetric(w, b, 0, er);
  const zst = striplineSymmetric(w, b, t, er);
  const x = t / b;
  // Cohn's fringing capacitance of a thick strip edge, in units of ε/π; 2 ln 2 at zero thickness.
  const cf = (2 * Math.log((2 * b - t) / (b - t)) - x * Math.log((t * (2 * b - t)) / (b - t) ** 2)) / (1 - x);
  const r = cf / (2 * Math.log(2));
  return {
    zEven: 1 / (1 / zst - r * (1 / zs0 - 1 / zero.zEven)),
    // The sidewalls facing each other across the gap, as 0.75 · t / (s · η): the physical
    // parallel-plate value is 2 t / (s · η), but the terms above already hold part of it (0.75 chosen
    // against the field-solver set).
    zOdd: 1 / (1 / zst + r * (1 / zero.zOdd - 1 / zs0) + (0.75 * t) / (s * eta)),
  };
}

export function coupledStripline(w: number, s: number, h1: number, h2: number, t: number, er: number) {
  if (Math.abs(h1 - h2) < 1e-12 * (h1 + h2)) return coupledStriplineSymmetric(w, s, 2 * h1 + t, t, er);
  const a = coupledStriplineSymmetric(w, s, 2 * h1 + t, t, er);
  const b = coupledStriplineSymmetric(w, s, 2 * h2 + t, t, er);
  const f = offsetFactor(w, h1, h2, t);
  return { zEven: ((2 * a.zEven * b.zEven) / (a.zEven + b.zEven)) * f, zOdd: ((2 * a.zOdd * b.zOdd) / (a.zOdd + b.zOdd)) * f };
}

// ---------------------------------------------------------------------------------------------

/** The line or pair for a geometry, with solder mask when the geometry has it (outer layers only). */
export function line(g: Geometry): Line {
  const bare = bareLine(g);
  return hasMask(g) ? withMask(g, bare) : bare;
}

/** Whether a geometry has solder mask that matters: an outer-layer line with mask over it. */
export const hasMask = (g: Geometry) => !isStripline(g.structure) && g.maskUm > 0 && g.maskEr > 1;

/**
 * Solder mask raises the capacitance but not the capacitance in air, so each mode's impedance falls as
 * √(εeff / εeff,masked), with εeff,masked = εeff + (εr,mask − 1) · q, q being the share of the field (in
 * air) that the mask's coating takes up. q is estimated from the coating thickness against the
 * line's own dimensions: see maskShare, fitted to the field-solver set in
 * scripts/impedance-mask-reference.json.
 */
function withMask(g: Geometry, l: Line): Line {
  const scale = (z: number, e: number, mode: 'single' | 'odd' | 'even') => {
    const em = e + (g.maskEr - 1) * maskShare(g, mode);
    return { z: z * Math.sqrt(e / em), e: em };
  };
  if (!isPair(g.structure)) {
    const r = scale(l.z0, l.eeff, 'single');
    return { ...l, z0: r.z, eeff: r.e };
  }
  const o = scale(l.zOdd, l.eOdd, 'odd');
  const e = scale(l.zEven, l.eEven, 'even');
  return { z0: o.z, eeff: o.e, zOdd: o.z, zEven: e.z, eOdd: o.e, eEven: e.e };
}

/**
 * The share q of a line's field (in air) taken up by a solder-mask coating of thickness c:
 * q = a · (1 − e^(−b · c / L)), with L the dimension that concentrates the field: the width for a
 * microstrip, the smaller of width and gap for a coplanar line, of width and spacing for a pair's
 * odd mode, and of width and dielectric for its even mode. The constants were fitted to half of
 * scripts/impedance-mask-reference.json (a conformal coating, εr 3.2 to 4, 8 to 35 µm) and checked
 * on the other half.
 */
const MASK_FIT = {
  microstrip: [0.1254, 8.63],
  cpwg: [0.3295, 2.347],
  odd: [0.3746, 2.512],
  even: [0.1039, 8.166],
} as const;

export function maskShare(g: Geometry, mode: 'single' | 'odd' | 'even'): number {
  const c = g.maskUm / 1000;
  const [a, b, len] =
    mode === 'odd'
      ? [...MASK_FIT.odd, Math.min(g.widthMm, g.spacingMm)]
      : mode === 'even'
        ? [...MASK_FIT.even, Math.min(g.widthMm, g.heightMm)]
        : g.structure === 'cpwg'
          ? [...MASK_FIT.cpwg, Math.min(g.widthMm, g.gapMm)]
          : [...MASK_FIT.microstrip, g.widthMm];
  return a * (1 - Math.exp((-b * c) / len));
}

/** The bare-copper line or pair. */
function bareLine(g: Geometry): Line {
  const t = g.copperUm / 1000;
  const w = g.widthMm, h = g.heightMm, er = g.er;
  const single = (z0: number, eeff: number): Line => ({ z0, eeff, zOdd: NaN, zEven: NaN, eOdd: NaN, eEven: NaN });
  switch (g.structure) {
    case 'microstrip': {
      const r = microstrip(w, h, t, er);
      return single(r.z0, r.eeff);
    }
    case 'stripline':
      return single(stripline(w, h, g.aboveMm, t, er), er);
    case 'cpwg': {
      const r = cpwg(w, g.gapMm, h, t, er);
      return single(r.z0, r.eeff);
    }
    case 'diffMicrostrip': {
      const r = coupledMicrostrip(w, g.spacingMm, h, t, er);
      return { z0: r.zOdd, eeff: r.eOdd, ...r };
    }
    case 'diffStripline': {
      const r = coupledStripline(w, g.spacingMm, h, g.aboveMm, t, er);
      return { z0: r.zOdd, eeff: er, ...r, eOdd: er, eEven: er };
    }
  }
}

/** The impedance a target is set against: Z0 for single lines, the differential impedance for pairs. */
export const targetZ = (g: Geometry, l: Line = line(g)) => (isPair(g.structure) ? 2 * l.zOdd : l.z0);

// ---------------------------------------------------------------------------------------------
// The calculator: inputs, solving for a width or spacing, tolerances and range checks.

export interface ImpedanceInputs extends Geometry {
  mode: Mode;
  /** Target: Z0 for single lines, the differential impedance for pairs (width and spacing modes). */
  targetOhm: number;
  /** Etch tolerance on the width, ± mm. Over-etching narrows the trace and widens its gaps by as much. */
  tolWidthMm: number;
  /** Tolerance on every dielectric thickness, ± %. */
  tolHeightPct: number;
  /** Tolerance on the dielectric constant, ± (absolute). */
  tolEr: number;
}

export const defaultImpedance: ImpedanceInputs = {
  structure: 'microstrip',
  mode: 'width',
  targetOhm: 50,
  widthMm: 0.3,
  spacingMm: 0.25,
  gapMm: 0.2,
  heightMm: 0.2,
  aboveMm: 0.3,
  copperUm: 35,
  er: 4.3,
  maskUm: 0,
  maskEr: 3.5,
  tolWidthMm: 0.0254, // 1 mil
  tolHeightPct: 10,
  tolEr: 0.2,
};

/** Example stackups that fill in the dielectric (all FR-4 at εr 4.3); the page says to use the board house's own. */
export const stackups = [
  { id: 'two', label: 'Two-layer board, 1.6 mm: 1.5 mm to the plane', heightMm: 1.5, aboveMm: NaN },
  { id: 'four', label: 'Four-layer, outer layer: 0.2 mm prepreg', heightMm: 0.2, aboveMm: NaN },
  { id: 'six', label: 'Six-layer, inner layer: 0.2 mm below, 0.3 mm above', heightMm: 0.2, aboveMm: 0.3 },
  { id: 'thin', label: 'Thin prepreg: 0.1 mm (0.1 mm each side inside)', heightMm: 0.1, aboveMm: 0.1 },
] as const;

/** Wavelength in the line, mm, at a frequency in GHz. */
export const wavelengthMm = (fGHz: number, eeff: number) => C0 / 1e6 / (fGHz * Math.sqrt(eeff));

/** The usual targets: 50 Ω single-ended, 100 Ω differential. */
export const defaultTarget = (s: Structure) => (isPair(s) ? 100 : 50);

export const UM_PER_OZ = 35;
export const MM_PER_MIL = 0.0254;
export const copperWeights = [0.5, 1, 2].map((oz) => ({ oz, um: oz * UM_PER_OZ }));
/** Below this (mm) a width or gap is finer than many board houses make. */
export const MIN_FEATURE_MM = 0.1;
/**
 * Widths and spacings searched when solving for a target, as multiples of the reference dielectric
 * (h, or the plane-to-plane spacing for stripline): well beyond any practical board, inside the
 * models' sane range.
 */
export const SEARCH = { min: 0.01, max: 30 };
/** The dielectric thickness the search range is scaled to. */
export const reference = (g: Geometry) => (isStripline(g.structure) ? g.heightMm + g.copperUm / 1000 + g.aboveMm : g.heightMm);

/**
 * The range each model was checked over against the field solver (scripts/impedance-sweep.py),
 * as ratios, since the results scale with the geometry. Outside it the result is flagged.
 */
export const checked = {
  microstrip: { wh: [0.2, 8] },
  stripline: { wb: [0.1, 3], ratio: 5 },
  cpwg: { wh: [0.3, 5], gh: [0.05, 2], tg: 0.75 },
  diffMicrostrip: { wh: [0.2, 4], sh: [0.2, 5] },
  diffStripline: { wb: [0.1, 1.5], sb: [0.1, 3], ratio: 4 },
  tOverH: 0.5,
  er: [2.2, 10.2],
} as const;

/** The inputs each structure uses. */
export const structureInputs: Record<Structure, (keyof Geometry)[]> = {
  microstrip: ['widthMm', 'heightMm', 'copperUm', 'er'],
  stripline: ['widthMm', 'heightMm', 'aboveMm', 'copperUm', 'er'],
  cpwg: ['widthMm', 'gapMm', 'heightMm', 'copperUm', 'er'],
  diffMicrostrip: ['widthMm', 'spacingMm', 'heightMm', 'copperUm', 'er'],
  diffStripline: ['widthMm', 'spacingMm', 'heightMm', 'aboveMm', 'copperUm', 'er'],
};

/** Plain-language checks against the range above. */
export function rangeFlags(g: Geometry): string[] {
  const f: string[] = [];
  const t = g.copperUm / 1000;
  const out = (x: number, [lo, hi]: readonly number[]) => x < lo * (1 - 1e-9) || x > hi * (1 + 1e-9);
  const ratio = (x: number) => num(x, true, x >= 10 ? 3 : 2);
  const h = g.heightMm;
  switch (g.structure) {
    case 'microstrip':
      if (out(g.widthMm / h, checked.microstrip.wh)) f.push(`The width is ${ratio(g.widthMm / h)} times the dielectric thickness; the check covered 0.2 to 8.`);
      break;
    case 'cpwg':
      if (out(g.widthMm / h, checked.cpwg.wh)) f.push(`The width is ${ratio(g.widthMm / h)} times the dielectric thickness; the check covered 0.3 to 5.`);
      if (g.gapMm / h > checked.cpwg.gh[1] * (1 + 1e-9))
        f.push(`The gap is ${ratio(g.gapMm / h)} times the dielectric thickness, more than 2: the side grounds do little here, and the line is close to a plain microstrip (choose Microstrip).`);
      else if (out(g.gapMm / h, checked.cpwg.gh)) f.push(`The gap is ${ratio(g.gapMm / h)} times the dielectric thickness; the check covered 0.05 to 2.`);
      if (t / g.gapMm > checked.cpwg.tg * (1 + 1e-9)) f.push(`The copper is ${ratio(t / g.gapMm)} times as thick as the gap is wide; the check covered up to 0.75.`);
      break;
    case 'diffMicrostrip':
      if (out(g.widthMm / h, checked.diffMicrostrip.wh)) f.push(`The width is ${ratio(g.widthMm / h)} times the dielectric thickness; the check covered 0.2 to 4.`);
      if (out(g.spacingMm / h, checked.diffMicrostrip.sh)) f.push(`The spacing is ${ratio(g.spacingMm / h)} times the dielectric thickness; the check covered 0.2 to 5.`);
      break;
    case 'stripline':
    case 'diffStripline': {
      const c = g.structure === 'stripline' ? checked.stripline : checked.diffStripline;
      const b = g.heightMm + t + g.aboveMm;
      const r = Math.max(g.heightMm, g.aboveMm) / Math.min(g.heightMm, g.aboveMm);
      if (out(g.widthMm / b, c.wb)) f.push(`The width is ${ratio(g.widthMm / b)} times the plane-to-plane spacing; the check covered ${c.wb[0]} to ${c.wb[1]}.`);
      if (g.structure === 'diffStripline' && out(g.spacingMm / b, checked.diffStripline.sb))
        f.push(`The pair spacing is ${ratio(g.spacingMm / b)} times the plane-to-plane spacing; the check covered 0.1 to 3.`);
      if (r > c.ratio * (1 + 1e-9)) f.push(`One dielectric is ${ratio(r)} times the other; the check covered up to ${c.ratio}.`);
      break;
    }
  }
  const thinnest = isStripline(g.structure) ? Math.min(g.heightMm, g.aboveMm) : h;
  if (t > checked.tOverH * thinnest * (1 + 1e-9)) f.push('The copper is more than half as thick as the dielectric.');
  if (out(g.er, checked.er)) f.push(`The dielectric constant is outside ${checked.er[0]} to ${checked.er[1]}.`);
  return f;
}

/** The first input error, or '' when the inputs are usable. */
export function inputError(i: ImpedanceInputs): string {
  const used = structureInputs[i.structure];
  const pos = (n: number) => Number.isFinite(n) && n > 0;
  const mode = effectiveMode(i);
  if (mode !== 'impedance' && !pos(i.targetOhm)) return 'Enter the impedance you want.';
  if (mode !== 'width' && !pos(i.widthMm)) return 'Enter the trace width.';
  if (used.includes('spacingMm') && mode !== 'spacing' && !pos(i.spacingMm)) return 'Enter the spacing between the two traces.';
  if (used.includes('gapMm') && !pos(i.gapMm)) return 'Enter the gap to the coplanar ground.';
  if (!pos(i.heightMm)) return isStripline(i.structure) ? 'Enter the dielectric thickness below the trace.' : 'Enter the dielectric thickness.';
  if (used.includes('aboveMm') && !pos(i.aboveMm)) return 'Enter the dielectric thickness above the trace.';
  if (!pos(i.copperUm)) return 'Enter the copper thickness.';
  if (!(Number.isFinite(i.er) && i.er >= 1)) return 'Enter the dielectric constant, 1 or more.';
  if (i.maskUm > 0 && !isStripline(i.structure)) {
    if (!(Number.isFinite(i.maskEr) && i.maskEr >= 1)) return 'Enter the solder mask’s dielectric constant, 1 or more.';
  } else if (!(Number.isFinite(i.maskUm) && i.maskUm >= 0)) return 'Enter the solder mask thickness, or 0 for none.';
  if (!(Number.isFinite(i.tolWidthMm) && i.tolWidthMm >= 0)) return 'Enter the width tolerance, or 0.';
  if (!(Number.isFinite(i.tolHeightPct) && i.tolHeightPct >= 0 && i.tolHeightPct < 100)) return 'Enter the dielectric tolerance, from 0 to under 100%.';
  if (!(Number.isFinite(i.tolEr) && i.tolEr >= 0)) return 'Enter the dielectric constant tolerance, or 0.';
  return '';
}

/** Spacing mode only applies to pairs; single lines fall back to width mode. */
export const effectiveMode = (i: ImpedanceInputs): Mode => (i.mode === 'spacing' && !isPair(i.structure) ? 'width' : i.mode);

/**
 * The value of `key` (log scale, over SEARCH times the reference dielectric) at which the target
 * impedance is met, by bisection, or the reachable range when it is not. `rising`: the impedance
 * rises with the value (spacing); falls with it (width).
 */
function solveFor(g: Geometry, key: 'widthMm' | 'spacingMm', target: number, rising: boolean) {
  const at = (v: number) => targetZ({ ...g, [key]: v });
  const lo = SEARCH.min * reference(g), hi = SEARCH.max * reference(g);
  const zLo = at(lo), zHi = at(hi);
  const zMin = Math.min(zLo, zHi), zMax = Math.max(zLo, zHi);
  const fail = { ok: false as const, zMin, zMax, lo, hi, model: false };
  const broken = { ...fail, model: true };
  if (!Number.isFinite(zLo) || !Number.isFinite(zHi) || (rising ? zHi < zLo : zLo < zHi)) return broken;
  if (!(target >= zMin && target <= zMax)) return fail;
  let a = Math.log(lo), b = Math.log(hi);
  for (let n = 0; n < 100 && b - a > 1e-12; n++) {
    const m = (a + b) / 2;
    const above = at(Math.exp(m)) > target;
    // Falling impedance: above the target means the value is still too small.
    if (above !== rising) a = m;
    else b = m;
  }
  const value = Math.exp((a + b) / 2);
  // A model that is not monotonic would leave the bisection short of the target: report that, never a wrong width.
  if (Math.abs(at(value) - target) > 1e-6 * target) return broken;
  return { ok: true as const, value };
}

export interface ToleranceRow {
  /** 'width', 'height' or 'er': one tolerance alone; 'all': every corner at once. */
  what: 'width' | 'height' | 'er' | 'all';
  lo: number;
  hi: number;
}

export interface ImpedanceResult {
  ok: true;
  mode: Mode;
  /** The geometry used, with the solved width or spacing filled in. */
  geometry: Geometry;
  line: Line;
  /** Z0 for single lines, the differential impedance for pairs. */
  z: number;
  /** Pairs: common-mode impedance (Zeven / 2), and one trace alone, as a single line on the same stackup. */
  zCommon: number;
  zAlone: number;
  /** With solder mask: the same line in bare copper (NaN without mask). */
  zBare: number;
  /** Pairs: how much of a trace's field the other shares, (Ze − Zo)/(Ze + Zo). */
  coupling: number;
  eeff: number;
  /** Propagation delay, ps per mm. */
  delayPsPerMm: number;
  tolerance: ToleranceRow[];
  /** Set (and `tolerance` empty) when the width tolerance is as large as the trace or a gap. */
  tolError: string;
  /** Which tolerance moves the impedance most. */
  biggest: 'width' | 'height' | 'er';
  flags: string[];
  /** The width, or a gap or spacing in use, is below MIN_FEATURE_MM. */
  narrow: boolean;
}

export type Result = { ok: false; error: string } | ImpedanceResult;

/** The geometry with every tolerance applied in the given directions (−1, 0 or +1). */
export function corner(g: Geometry, dw: number, dh: number, de: number, i: ImpedanceInputs): Geometry {
  const d = dw * i.tolWidthMm;
  const k = 1 + (dh * i.tolHeightPct) / 100;
  return {
    ...g,
    widthMm: Math.max(g.widthMm + d, 1e-6),
    spacingMm: Math.max(g.spacingMm - d, 1e-6),
    gapMm: Math.max(g.gapMm - d, 1e-6),
    heightMm: g.heightMm * k,
    aboveMm: g.aboveMm * k,
    er: Math.max(g.er + de * i.tolEr, 1),
  };
}

export function calculate(i: ImpedanceInputs): Result {
  const error = inputError(i);
  if (error) return { ok: false, error };
  const mode = effectiveMode(i);
  const geometry: Geometry = {
    structure: i.structure,
    widthMm: i.widthMm,
    spacingMm: i.spacingMm,
    gapMm: i.gapMm,
    heightMm: i.heightMm,
    aboveMm: i.aboveMm,
    copperUm: i.copperUm,
    er: i.er,
    maskUm: i.maskUm,
    maskEr: i.maskEr,
  };
  const pair = isPair(i.structure);
  const target = `${num(i.targetOhm, true)} Ω`;
  const what = pair ? 'the pair is' : 'a trace is';
  const mmMil = (mm: number) => `${num(mm, true, 2)} mm (${num(mm / MM_PER_MIL, true, 2)} mil)`;
  const unreliable = `The calculator cannot find a ${mode} for ${target} here: the models are not reliable this far outside the range checked.`;
  if (mode === 'width') {
    const s = solveFor(geometry, 'widthMm', i.targetOhm, false);
    if (!s.ok && s.model) return { ok: false, error: unreliable };
    if (!s.ok)
      return {
        ok: false,
        error:
          i.targetOhm > s.zMax
            ? `No width gives ${target} on this stackup: even ${mmMil(s.lo)} wide, ${what} only ${ohms(s.zMax)}. A thicker dielectric${pair ? ', a wider spacing' : i.structure === 'cpwg' ? ', a wider gap' : ''} or a lower εr raises the impedance.`
            : `No width gives ${target} on this stackup: even ${mmMil(s.hi)} wide, ${what} ${ohms(s.zMin)}. A thinner dielectric${pair ? ', a narrower spacing' : i.structure === 'cpwg' ? ', a narrower gap' : ''} or a higher εr lowers the impedance.`,
      };
    geometry.widthMm = s.value;
  } else if (mode === 'spacing') {
    const s = solveFor(geometry, 'spacingMm', i.targetOhm, true);
    if (!s.ok && s.model) return { ok: false, error: unreliable };
    if (!s.ok)
      return {
        ok: false,
        error:
          i.targetOhm > s.zMax
            ? `No spacing gives ${target} with this width: even far apart the pair reaches only about ${ohms(s.zMax)}. Make the traces narrower or the dielectric thicker.`
            : `No spacing gives ${target} with this width: even ${mmMil(s.lo)} apart the pair is ${ohms(s.zMin)}. Make the traces wider or the dielectric thinner.`,
      };
    geometry.spacingMm = s.value;
  }

  const l = line(geometry);
  const z = targetZ(geometry, l);
  const alone = pair
    ? targetZ({ ...geometry, structure: i.structure === 'diffMicrostrip' ? 'microstrip' : 'stripline' })
    : NaN;

  // Tolerances: each alone, then every corner. Over-etching by as much as the trace or a gap is
  // meaningless, so then there is no range, only a note.
  const used = structureInputs[i.structure];
  const features = [geometry.widthMm, ...(used.includes('spacingMm') ? [geometry.spacingMm] : []), ...(used.includes('gapMm') ? [geometry.gapMm] : [])];
  const tolError =
    i.tolWidthMm >= Math.min(...features)
      ? `The width tolerance, ±${mmMil(i.tolWidthMm)}, is as large as the ${geometry.widthMm <= Math.min(...features) ? 'trace' : pair ? 'spacing' : 'gap'} itself, so there is no meaningful range: make it smaller.`
      : '';
  const zAt = (dw: number, dh: number, de: number) => targetZ(corner(geometry, dw, dh, de, i));
  const span = (vals: number[]) => ({ lo: Math.min(...vals), hi: Math.max(...vals) });
  const one = {
    width: span([zAt(-1, 0, 0), zAt(1, 0, 0)]),
    height: span([zAt(0, -1, 0), zAt(0, 1, 0)]),
    er: span([zAt(0, 0, -1), zAt(0, 0, 1)]),
  };
  const corners: number[] = [];
  for (const dw of [-1, 1]) for (const dh of [-1, 1]) for (const de of [-1, 1]) corners.push(zAt(dw, dh, de));
  const tolerance: ToleranceRow[] = [
    { what: 'width', ...one.width },
    { what: 'height', ...one.height },
    { what: 'er', ...one.er },
    { what: 'all', ...span(corners) },
  ];
  const biggest = (['width', 'height', 'er'] as const).reduce((a, b) => (one[b].hi - one[b].lo > one[a].hi - one[a].lo ? b : a));

  return {
    ok: true,
    mode,
    geometry,
    line: l,
    z,
    zCommon: pair ? l.zEven / 2 : NaN,
    zAlone: alone,
    zBare: hasMask(geometry) ? targetZ({ ...geometry, maskUm: 0 }) : NaN,
    coupling: pair ? (l.zEven - l.zOdd) / (l.zEven + l.zOdd) : NaN,
    eeff: l.eeff,
    delayPsPerMm: (Math.sqrt(l.eeff) / C0) * 1e9,
    tolerance: tolError ? [] : tolerance,
    tolError,
    biggest,
    flags: rangeFlags(geometry),
    narrow: features.some((f) => f < MIN_FEATURE_MM - 1e-9),
  };
}

/**
 * A number to `p` significant figures in plain decimal notation (never "1.00e+3"). Rounds first.
 * Keeps trailing zeros ("0.300") unless `trim` is set.
 */
export function num(n: number, trim = false, p = 3): string {
  if (!Number.isFinite(n)) return '–';
  const r = Number(n.toPrecision(p));
  if (r === 0) return '0';
  const decimals = Math.max(0, p - 1 - Math.floor(Math.log10(Math.abs(r))));
  const s = r.toFixed(Math.min(decimals, 20));
  return !trim || !s.includes('.') ? s : s.replace(/\.?0+$/, '');
}
/** Impedance to three significant figures (whole ohms from 100 Ω). */
export const ohms = (z: number) => `${num(z)} Ω`;
