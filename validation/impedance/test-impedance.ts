// Checks src/lib/impedance.ts against exact results, published values, and a 2D field solver
// (scripts/impedance-fieldsolve.py; reference set from scripts/impedance-sweep.py).
// Usage: node scripts/test-impedance.ts [--all]   (--all prints every reference case)
import { readFileSync } from 'node:fs';
import { line, targetZ, cpwg, microstrip, striplineSymmetric, coupledStripline0, calculate, defaultImpedance, rangeFlags, ETA0, type Geometry, type Structure, type ImpedanceInputs } from '../../src/impedance.ts';

let failures = 0;
const check = (name: string, got: number, want: number, tol: number) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got.toPrecision(5)} (want ${want} ± ${tol})`);
};

// Exact: zero-thickness centred stripline, Z0 = η0 / (4 √εr) · K(k) / K(k'), k = sech(πw / 2b).
// w = 0.2, b = 0.5, εr = 4: 56.424 Ω (scipy ellipk). Wheeler's closed form is within 0.5%.
check('stripline t=0, Wheeler vs exact, Ω', striplineSymmetric(0.2, 0.5, 0, 4), 56.424, 0.3);
// Exact: Cohn's zero-thickness coupled stripline, w = s = 0.15, b = 0.5, εr = 4: even 74.582, odd 53.893 Ω.
const c0 = coupledStripline0(0.15, 0.15, 0.5, 4);
check('coupled stripline t=0 even, Ω', c0.zEven, 74.582, 0.01);
check('coupled stripline t=0 odd, Ω', c0.zOdd, 53.893, 0.01);
// Classic microstrip: w/h = 1.875 on εr = 4.5, zero thickness, is close to 50 Ω (field solver 50.03).
check('microstrip w=3.0 h=1.6 εr=4.5 t=0, Ω', microstrip(3.0, 1.6, 0, 4.5).z0, 50.03, 0.3);
check('free-space impedance, Ω', ETA0, 376.73, 0.01);

// Field-solver reference set: errors by structure.
interface Ref {
  kind: Structure;
  seed: number;
  w: number;
  t: number;
  er: number;
  h?: number;
  h1?: number;
  h2?: number;
  g?: number;
  s?: number;
  z?: number;
  e?: number;
  z_even?: number;
  z_odd?: number;
  e_odd?: number;
  e_even?: number;
}
const refs: Ref[] = JSON.parse(readFileSync(new URL('./impedance-reference.json', import.meta.url), 'utf8'));
const all = process.argv.includes('--all');
/**
 * Worst error allowed, %, for cases inside the checked range (rangeFlags empty). The page states
 * these: microstrip and stripline within 1%; grounded coplanar lines and the differential impedance
 * of pairs within 3% (coplanar εeff within 2.5%); the common-mode impedance within 4%; and the
 * odd-mode εeff of outer-layer pairs within 6%, so their delay within 3%.
 */
const bound: Record<string, number> = {
  'microstrip z0': 1,
  'microstrip eeff': 1,
  'stripline z0': 1,
  'cpwg z0': 3,
  'cpwg eeff': 2.5,
  'diffMicrostrip zdiff': 3,
  'diffMicrostrip zeven': 4,
  'diffMicrostrip eodd': 6,
  'diffStripline zdiff': 3,
  'diffStripline zeven': 4,
};
let outside = 0;
const errs: Record<string, number[]> = {};
/** The two fitted corrections are fitted on even seeds; odd seeds are the held-out check. */
const heldOut: Record<string, number[]> = {};
for (const r of refs) {
  const g: Geometry = {
    structure: r.kind,
    widthMm: r.w,
    spacingMm: r.s ?? NaN,
    gapMm: r.g ?? NaN,
    heightMm: r.h ?? r.h1 ?? NaN,
    aboveMm: r.h2 ?? NaN,
    copperUm: r.t * 1000,
    er: r.er,
    maskUm: 0,
    maskEr: 1,
  };
  if (rangeFlags(g).length) {
    outside++;
    continue;
  }
  const l = line(g);
  const pct = (a: number, b: number) => (100 * (a - b)) / b;
  const rows: [string, number][] = r.z !== undefined ? [['z0', pct(l.z0, r.z)]] : [['zdiff', pct(l.zOdd, r.z_odd!)], ['zeven', pct(l.zEven, r.z_even!)]];
  if (r.kind === 'microstrip' || r.kind === 'cpwg') rows.push(['eeff', pct(l.eeff, r.e!)]);
  // A pair's odd-mode effective εr sets its delay (the delay error is about half this).
  if (r.kind === 'diffMicrostrip') rows.push(['eodd', pct(l.eOdd, r.e_odd!)]);
  for (const [q, e] of rows) {
    const key = `${r.kind} ${q}`;
    (errs[key] ??= []).push(e);
    if (r.seed % 2 && (r.kind === 'cpwg' || (r.kind === 'stripline' && r.h1 !== r.h2) || (r.kind === 'diffStripline' && r.h1 !== r.h2)))
      (heldOut[key] ??= []).push(e);
    const bad = Math.abs(e) > bound[key];
    if (all || bad) console.log(`${bad ? 'FAIL' : '    '} ${key} ${e.toFixed(2)}%  ${JSON.stringify(r)}`);
    if (bad) failures++;
  }
}
console.log(`field-solver set: ${refs.length} cases, ${outside} outside the checked range and skipped`);
for (const [k, v] of Object.entries(errs)) {
  const worst = Math.max(...v.map(Math.abs));
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  console.log(`${k.padEnd(22)} ${v.length} cases, worst ${worst.toFixed(2)}%, mean ${mean.toFixed(2)}%`);
}

for (const [k, v] of Object.entries(heldOut))
  console.log(`held out (odd seeds, fitted structures) ${k.padEnd(22)} ${v.length} cases, worst ${Math.max(...v.map(Math.abs)).toFixed(2)}%`);

// Edge cases: a very wide stripline pair keeps its precision; grounded coplanar never exceeds microstrip.
const wide = coupledStripline0(20, 0.2, 0.5, 4.3);
check('very wide stripline pair, odd mode > 0', Number(wide.zOdd > 0.1), 1, 0);
for (const g of [0.4, 1, 10, 100]) check(`cpwg gap ${g} mm ≤ microstrip`, Number(cpwg(0.36, g, 0.2, 0.035, 4.3).z0 <= microstrip(0.36, 0.2, 0.035, 4.3).z0 + 1e-9), 1, 0);

// Solder mask: the calculator with mask against the field solver with a conformal mask coating
// (scripts/impedance-mask-reference.json). Checks the whole masked result, so it includes the bare
// model's own error.
const masks: any[] = JSON.parse(readFileSync(new URL('./impedance-mask-reference.json', import.meta.url), 'utf8'));
const maskErr: Record<string, number[]> = {};
for (const r of masks) {
  const g: Geometry = { structure: r.kind, widthMm: r.w, spacingMm: r.s ?? NaN, gapMm: r.g ?? NaN, heightMm: r.h, aboveMm: NaN, copperUm: r.t * 1000, er: r.er, maskUm: r.mask * 1000, maskEr: r.er_mask };
  if (rangeFlags(g).length) continue;
  const l = line(g);
  const rows: [string, number][] = r.kind === 'diffMicrostrip' ? [['zdiff', l.zOdd / r.masked[0]], ['zeven', l.zEven / r.masked[1]]] : [['z0', l.z0 / r.masked[0]]];
  for (const [q, ratio] of rows) (maskErr[`${r.kind} ${q} with mask`] ??= []).push(100 * (ratio - 1));
}
for (const [k, v] of Object.entries(maskErr)) {
  const worst = Math.max(...v.map(Math.abs));
  check(`${k}: worst error, % (${v.length} cases)`, worst, 0, 4);
}

// Monotonic: the impedance falls with width (and rises with pair spacing) over the whole search
// range, on a grid of stackups, so the bisection always finds the one answer.
let nonMonotonic = 0;
for (const structure of ['microstrip', 'stripline', 'cpwg', 'diffMicrostrip', 'diffStripline'] as const)
  for (const h of [0.075, 0.2, 1.6])
    for (const t of [0.0175, 0.035, 0.07])
      for (const er of [2.2, 4.3, 10.2])
        for (const key of ['widthMm', 'spacingMm'] as const) {
          if (key === 'spacingMm' && !structure.startsWith('diff')) continue;
          const g: Geometry = { structure, widthMm: 0.2, spacingMm: 0.2, gapMm: 0.2, heightMm: h, aboveMm: h * 1.5, copperUm: t * 1000, er, maskUm: 20, maskEr: 3.5 };
          const ref = structure.endsWith('ipline') ? h + t + h * 1.5 : h;
          let prev = NaN;
          for (let k = 0; k <= 200; k++) {
            const v = ref * 0.01 * 3000 ** (k / 200);
            const z = targetZ({ ...g, [key]: v });
            if (!Number.isFinite(z) || (k > 0 && (key === 'widthMm' ? z > prev * (1 + 1e-9) : z < prev * (1 - 1e-9)))) {
              nonMonotonic++;
              console.log(`FAIL not monotonic: ${structure} ${key} h=${h} t=${t} er=${er} at ${v.toPrecision(3)} mm: ${prev} → ${z}`);
              break;
            }
            prev = z;
          }
        }
failures += nonMonotonic;
// Coupling can only lower a trace's impedance: a pair's odd mode is never above one trace alone.
let above = 0;
for (const h of [0.075, 0.2, 1.6])
  for (const t of [0.0175, 0.035, 0.07])
    for (const u of [0.3, 1, 2, 4])
      for (const g of [0.2, 0.5, 1, 2, 5, 10, 20, 50]) {
        if (t > 0.5 * h) continue;
        const geo: Geometry = { structure: 'diffMicrostrip', widthMm: u * h, spacingMm: g * h, gapMm: NaN, heightMm: h, aboveMm: NaN, copperUm: t * 1000, er: 4.3, maskUm: 0, maskEr: 3.5 };
        if (line(geo).zOdd > microstrip(u * h, h, t, 4.3).z0 * (1 + 1e-4)) above++;
      }
check('pair odd mode above one trace alone (count)', above, 0, 0);
console.log(`monotonic over the search range: ${nonMonotonic ? `${nonMonotonic} failures` : 'ok'}`);

// The calculator: solving for a width or spacing returns the target, and the tolerances bracket it.
const run = (over: Partial<ImpedanceInputs>) => {
  const r = calculate({ ...defaultImpedance, ...over });
  if (!r.ok) throw new Error(r.error);
  return r;
};
for (const structure of ['microstrip', 'stripline', 'cpwg', 'diffMicrostrip', 'diffStripline'] as const) {
  const target = structure.startsWith('diff') ? 100 : 50;
  const r = run({ structure, targetOhm: target });
  check(`${structure}: width for ${target} Ω gives ${target} Ω`, r.z, target, 1e-6);
  const back = run({ structure, mode: 'impedance', widthMm: r.geometry.widthMm });
  check(`${structure}: impedance at that width`, back.z, target, 1e-6);
  const all = r.tolerance.find((t) => t.what === 'all')!;
  check(`${structure}: tolerance corners bracket the result`, Number(all.lo < target && all.hi > target), 1, 0);
  console.log(`     ${structure}: ${r.geometry.widthMm.toFixed(4)} mm, εeff ${r.eeff.toFixed(3)}, ${r.delayPsPerMm.toFixed(2)} ps/mm, corners ${all.lo.toFixed(1)} to ${all.hi.toFixed(1)} Ω`);
}
const sp = run({ structure: 'diffMicrostrip', mode: 'spacing', widthMm: 0.15, targetOhm: 90 });
check('spacing for 90 Ω at 0.15 mm gives 90 Ω', sp.z, 90, 1e-6);
// Delay: stripline in εr 4 is √4 / c = 6.67 ps/mm.
check('stripline delay at εr 4, ps/mm', run({ structure: 'stripline', mode: 'impedance', er: 4 }).delayPsPerMm, 6.671, 0.001);
// Out of reach: a 300 Ω microstrip on 0.2 mm is not possible.
const far = calculate({ ...defaultImpedance, targetOhm: 300 });
check('300 Ω microstrip is out of reach', Number(!far.ok), 1, 0);
// A width tolerance as large as the trace gives no range, only a note.
const big = run({ tolWidthMm: 0.5 });
check('huge width tolerance: no range', Number(big.tolerance.length === 0 && big.tolError !== ''), 1, 0);

console.log(failures ? `\n${failures} failures` : '\nall passed');
process.exit(failures ? 1 : 0);
