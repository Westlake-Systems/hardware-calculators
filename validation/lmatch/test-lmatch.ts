// Checks src/lib/lmatch.ts against worked textbook examples, hand-worked numbers, and brute force
// (every solution's reflection, the match seen from the other end, and a scan for the bandwidth).
// Usage: node scripts/test-lmatch.ts
import {
  calculate,
  defaultMatch,
  solve,
  respond,
  standardAround,
  zFromS11,
  smithPath,
  rlAt,
  cx,
  abs,
  sub,
  add,
  mul,
  div,
  conj,
  inv,
  LOSSLESS,
  type Cx,
  type MatchInputs,
  type Network,
  type Solution,
} from '../../src/lmatch.ts';

let failures = 0;
const check = (name: string, got: number, want: number, tol: number) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got.toPrecision(6)} (want ${want} ± ${tol})`);
};
const truth = (name: string, ok: boolean) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
};
const run = (over: Partial<MatchInputs>) => {
  const r = calculate({ ...defaultMatch, ...over });
  if (!r.ok) throw new Error(r.error);
  return r;
};
const pf = (v: number) => v * 1e12;
const nh = (v: number) => v * 1e9;
const find = (s: Solution[], topology: string, series: string, shunt: string) =>
  s.find((x) => x.topology === topology && x.series.kind === series && x.shunt.kind === shunt)!;

// Pozar, Microwave Engineering (4th ed.), Example 5.1: ZL = 200 − j100 Ω to a 100 Ω line at 500 MHz.
// Solution 1: B = 0.0029 S, X = 122 Ω, a 0.92 pF shunt capacitor and a 38.8 nH series inductor.
// Solution 2: B = −0.0069 S, X = −122 Ω, a 46.1 nH shunt inductor and a 2.61 pF series capacitor.
{
  const s = solve(cx(100), cx(200, -100), 500);
  truth('Pozar 5.1: two solutions, both shunt beside the load', s.length === 2 && s.every((x) => x.topology === 'shuntLoad'));
  const a = find(s, 'shuntLoad', 'L', 'C');
  const b = find(s, 'shuntLoad', 'C', 'L');
  check('Pozar 5.1 sol 1 B (S)', a.b, 0.0029, 0.00005);
  check('Pozar 5.1 sol 1 X (Ω)', a.x, 122, 0.6);
  check('Pozar 5.1 sol 1 C (pF)', pf(a.shunt.value), 0.92, 0.01);
  check('Pozar 5.1 sol 1 L (nH)', nh(a.series.value), 38.8, 0.3); // 38.99 unrounded; Pozar rounds X to 122 first
  check('Pozar 5.1 sol 2 B (S)', b.b, -0.0069, 0.00005);
  check('Pozar 5.1 sol 2 L (nH)', nh(b.shunt.value), 46.1, 0.1);
  check('Pozar 5.1 sol 2 C (pF)', pf(b.series.value), 2.61, 0.015); // 2.599 unrounded; Pozar uses X = 122 Ω
}

// Bowick, RF Circuit Design: 100 Ω source to a 1000 Ω load at 100 MHz, low-pass L.
// Q = √(1000/100 − 1) = 3; series reactance 300 Ω (477 nH), shunt reactance 333 Ω (4.8 pF).
{
  const s = solve(cx(100), cx(1000), 100);
  const lp = find(s, 'shuntLoad', 'L', 'C');
  check('Bowick Q', lp.q, 3, 1e-9);
  check('Bowick L (nH)', nh(lp.series.value), 477, 0.5);
  check('Bowick C (pF)', pf(lp.shunt.value), 4.77, 0.01);
  truth('Bowick: a real step up has only the shunt-beside-the-load pair', s.length === 2);
}

// Hand-worked: 50 Ω to 10 Ω at 1 GHz. Q = √(50/10 − 1) = 2; shunt beside the source Xp = 50/2 = 25 Ω,
// series Xs = 2·10 = 20 Ω: low-pass C = 1/(2π·1e9·25) = 6.3662 pF, L = 20/(2π·1e9) = 3.1831 nH.
{
  const s = solve(cx(50), cx(10), 1000);
  const lp = find(s, 'shuntSource', 'L', 'C');
  check('50 to 10 Ω Q', lp.q, 2, 1e-9);
  check('50 to 10 Ω C (pF)', pf(lp.shunt.value), 6.3662, 1e-3);
  check('50 to 10 Ω L (nH)', nh(lp.series.value), 3.1831, 1e-3);
}

// Brute force: random complex sources and loads. Every solution matches exactly (Γ = 0, all the
// power delivered), and seen from the load the network presents ZL* (a lossless match works both ways).
{
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let worstGamma = 0;
  let worstOther = 0;
  let worstGain = 0;
  let minCount = 4;
  for (let k = 0; k < 2000; k++) {
    const zs = cx(1 + 200 * rand(), (rand() - 0.5) * 300);
    const zl = cx(0.5 + 500 * rand(), (rand() - 0.5) * 800);
    const f = 1 + 6000 * rand();
    const s = solve(zs, zl, f);
    minCount = Math.min(minCount, s.length);
    for (const sol of s) {
      const r = respond(sol, zs, zl, f, f, LOSSLESS);
      worstGamma = Math.max(worstGamma, r.gamma);
      worstGain = Math.max(worstGain, Math.abs(1 - r.gain));
      // Looking back from the load: the source through the reversed network.
      const rev: Network = { ...sol, topology: sol.topology === 'shuntLoad' ? 'shuntSource' : 'shuntLoad' };
      const back = respond(rev, zl, zs, f, f, LOSSLESS);
      worstOther = Math.max(worstOther, abs(sub(back.zin, conj(zl))) / abs(zl));
    }
  }
  truth('random: at least two solutions every time', minCount >= 2);
  check('random: worst |Γ| at the source', worstGamma, 0, 1e-9);
  check('random: worst |1 − gain|', worstGain, 0, 1e-9);
  check('random: worst relative miss seen from the load', worstOther, 0, 1e-9);
}

// S11 to impedance: −9.542 dB at 0° is Γ = 1/3, so 100 Ω on 50; at 180° it is 25 Ω.
{
  const db = 20 * Math.log10(1 / 3);
  check('S11 1/3 at 0° (Ω)', zFromS11(db, 0, 50).re, 100, 1e-9);
  check('S11 1/3 at 180° (Ω)', zFromS11(db, 180, 50).re, 25, 1e-9);
  const z = zFromS11(-6, -120, 50);
  const g = div(sub(z, cx(50)), add(z, cx(50)));
  check('S11 round trip |Γ| (dB)', 20 * Math.log10(abs(g)), -6, 1e-9);
  check('S11 round trip angle (°)', (Math.atan2(g.im, g.re) * 180) / Math.PI, -120, 1e-9);
}

// "The impedance it should see": the network then presents the entered impedance to the part.
{
  const zt = cx(15, 25);
  const r = run({ loadMeans: 'wants', rl: zt.re, xl: zt.im, values: 'exact', qL: NaN, qC: NaN });
  for (const s of r.solutions) {
    const rev: Network = { ...s.exact, topology: s.exact.topology === 'shuntLoad' ? 'shuntSource' : 'shuntLoad' };
    const back = respond(rev, conj(zt), cx(50), defaultMatch.fMHz, defaultMatch.fMHz, LOSSLESS);
    check(`wants: ${s.exact.topology} ${s.exact.series.kind}/${s.exact.shunt.kind} presents the target`, abs(sub(back.zin, zt)), 0, 1e-9);
  }
}

// Loss from Q, hand-worked: 50 Ω to 50 − j50 Ω needs only a series +50 Ω inductor. With Q 50 it has
// 1 Ω of resistance: delivered share = 4·50·50/101² = 0.980296 (0.08642 dB), reflection (1/101)².
{
  const r = run({ fMHz: 1000, bandLoMHz: NaN, bandHiMHz: NaN, rl: 50, xl: -50, values: 'exact', qL: 50, qC: NaN, tolCpF: 0, tolCPct: 0, tolLnH: 0, tolLPct: 0 });
  const one = r.solutions.find((s) => s.exact.shunt.kind === 'none')!;
  truth('series-only solution found', Boolean(one) && one.exact.series.kind === 'L');
  check('series-only L (nH)', nh(one.exact.series.value), 50 / (2 * Math.PI), 1e-6);
  check('Q 50 total loss (dB)', one.fit.totalLossDb, -10 * Math.log10((4 * 50 * 50) / 101 ** 2), 1e-9);
  check('Q 50 return loss (dB)', one.fit.rlDb, 20 * Math.log10(101), 1e-9);
  check('Q 50 part loss + mismatch = total (dB)', one.fit.partLossDb + one.fit.mismatchDb, one.fit.totalLossDb, 1e-12);
  check('zero tolerance: corner RL = RL', one.fit.tolRlDb, one.fit.rlDb, 1e-9);
}

// Standard values.
truth('E24 around 0.923 pF is 0.91 and 1.0', JSON.stringify(standardAround(0.923, 'E24')) === '[0.91,1]');
truth('E12 around 4.77 is 4.7 and 5.6', JSON.stringify(standardAround(4.77, 'E12')) === '[4.7,5.6]');
truth('E24 at 3.3 exactly is 3.3 alone', JSON.stringify(standardAround(3.3, 'E24')) === '[3.3]');
truth('E12 around 9.5 is 8.2 and 10', JSON.stringify(standardAround(9.5, 'E12')) === '[8.2,10]');
{
  // The standard pair chosen is the best of the four neighbour combinations (at f, with no band).
  const noBand = { ...defaultMatch, bandLoMHz: NaN, bandHiMHz: NaN };
  const r = run(noBand);
  for (const s of r.solutions) {
    const opts = (v: number, k: string) => standardAround(k === 'L' ? v * 1e9 : v * 1e12, 'E24');
    let best = -Infinity;
    const ser = s.exact.series;
    const sh = s.exact.shunt;
    for (const a of ser.kind === 'none' ? [NaN] : opts(ser.value, ser.kind))
      for (const b of sh.kind === 'none' ? [NaN] : opts(sh.value, sh.kind)) {
        const n: Network = {
          topology: s.exact.topology,
          series: ser.kind === 'none' ? ser : { kind: ser.kind, value: a * (ser.kind === 'L' ? 1e-9 : 1e-12) },
          shunt: sh.kind === 'none' ? sh : { kind: sh.kind, value: b * (sh.kind === 'L' ? 1e-9 : 1e-12) },
        };
        best = Math.max(best, rlAt(n, noBand, r.zs, r.zl, noBand.fMHz));
      }
    check(`default ${s.exact.topology} ${s.exact.series.kind}/${s.exact.shunt.kind}: standard pair is the best of four (dB)`, s.fit.rlDb, best, 1e-9);
  }
}

// Bandwidth edges against a plain linear scan.
{
  const i = { ...defaultMatch, values: 'exact' as const, qL: NaN, qC: NaN };
  const r = run(i);
  for (const s of r.solutions) {
    let lo = NaN;
    let hi = NaN;
    const step = 0.01; // MHz
    for (let f = i.fMHz; f > 1; f -= step) if (rlAt(s.fit, i, r.zs, r.zl, f) < i.rlBwDb) { lo = f + step / 2; break; }
    for (let f = i.fMHz; f < 4 * i.fMHz; f += step) if (rlAt(s.fit, i, r.zs, r.zl, f) < i.rlBwDb) { hi = f - step / 2; break; }
    check(`bandwidth low edge ${s.exact.series.kind}/${s.exact.shunt.kind} (MHz)`, s.fit.bwLoMHz, lo, step);
    check(`bandwidth high edge ${s.exact.series.kind}/${s.exact.shunt.kind} (MHz)`, s.fit.bwHiMHz, hi, step);
  }
}

// Real-to-real with ideal parts: narrower band for a bigger step (higher Q).
{
  const bw = (rl: number) => {
    const r = run({ rl, xl: 0, values: 'exact', qL: NaN, qC: NaN, loadModel: 'fixed' });
    const s = r.solutions.find((x) => x.exact.series.kind === 'L' && x.exact.shunt.kind === 'C')!;
    return s.fit.bwHiMHz - s.fit.bwLoMHz;
  };
  truth('bigger step, narrower band (25, 10, 5 Ω)', bw(25) > bw(10) && bw(10) > bw(5));
}

// Smith path: starts at the load and ends at the network's input impedance.
{
  const r = run({ values: 'exact', qL: NaN, qC: NaN });
  for (const s of r.solutions) {
    const [p1, p2] = smithPath(s.exact, r.zl, defaultMatch.fMHz);
    check(`path starts at the load (${s.exact.topology})`, abs(sub(p1[0], r.zl)), 0, 1e-9);
    check(`path ends at Zs* (${s.exact.topology})`, abs(sub(p2[p2.length - 1], conj(r.zs))), 0, 1e-6);
  }
}

// The default: 10 − j25 Ω at 2440 MHz. RL·Gs = 0.2 and Rs·GL = 50·10/725 = 0.69, both ≤ 1: four solutions.
{
  const r = run({});
  truth('default: four solutions, two of each orientation', r.solutions.length === 4 && r.solutions.filter((s) => s.exact.topology === 'shuntSource').length === 2);
  for (const s of r.solutions)
    console.log(
      `     ${s.exact.series.kind} ${(s.exact.series.kind === 'L' ? nh : pf)(s.exact.series.value).toFixed(3)} / shunt ${s.exact.shunt.kind} ${(s.exact.shunt.kind === 'L' ? nh : pf)(s.exact.shunt.value).toFixed(3)} -> fitted ${(s.fit.series.kind === 'L' ? nh : pf)(s.fit.series.value)} / ${(s.fit.shunt.kind === 'L' ? nh : pf)(s.fit.shunt.value)}; RL ${s.fit.rlDb.toFixed(2)} dB, tol ${s.fit.tolRlDb.toFixed(2)} dB, loss ${s.fit.totalLossDb.toFixed(3)} dB (parts ${s.fit.partLossDb.toFixed(3)}), BW ${s.fit.bwLoMHz.toFixed(1)}-${s.fit.bwHiMHz.toFixed(1)} MHz, Q ${s.solution.q.toFixed(3)}`,
    );
  console.log(`     best: ${r.best}; bare RL ${r.bareRlDb.toFixed(2)} dB; band ${r.solutions.map((s) => s.fit.bandRlDb.toFixed(2) + '/' + s.fit.bandRlTolDb.toFixed(2)).join(', ')}`);
}

// Review cases (2026-11-26). Q counts the load's own Q: 2 − j80 Ω has Q 40 whatever the network.
{
  const r = run({ rl: 2, xl: -80, values: 'exact', qL: NaN, qC: NaN });
  truth('2 − j80 Ω: every network reports Q 40', r.solutions.every((s) => Math.abs(s.solution.q - 40) < 1e-9));
}
// 50 − j50 Ω: one shunt-beside-the-load solution needs no shunt part, the same circuit as the series-only one.
{
  const r = run({ rl: 50, xl: -50, bandLoMHz: NaN, bandHiMHz: NaN });
  const single = r.solutions.filter((s) => s.fit.shunt.kind === 'none');
  truth('50 − j50 Ω: the series-only network is listed once', single.length === 1 && r.solutions.length === 2);
}
// Parts too small to buy are left out when fitting standard values (S11 −6 dB at −120°, no band: 2.2 pH
// and 0.15 nH series parts), leaving one shunt-inductor network, not two.
{
  const r = run({ loadEntry: 's11', bandLoMHz: NaN, bandHiMHz: NaN });
  truth('no fitted part below 0.2 nH or 0.05 pF', r.solutions.every((s) => [s.fit.series, s.fit.shunt].every((p) => p.kind === 'none' || (p.kind === 'L' ? p.value >= 0.2e-9 : p.value >= 0.05e-12))));
  truth('one shunt-inductor-only network', r.solutions.filter((s) => s.fit.series.kind === 'none' && s.fit.shunt.kind === 'L').length === 1);
}
// Already matched (50 + j0.5 Ω): "no parts" is offered and suggested.
{
  const r = run({ rl: 50, xl: 0.5 });
  truth('50 + j0.5 Ω: no parts suggested', r.matched && r.solutions[r.best].fit.series.kind === 'none' && r.solutions[r.best].fit.shunt.kind === 'none');
}

// Neon review (2026-11-26): a float residual at a boundary must not make bogus networks.
{
  for (const r0 of [49, 98, 24.5]) {
    const r = run({ rs: r0, rl: r0, xl: 0, values: 'exact', qL: NaN, qC: NaN });
    truth(`${r0} Ω to ${r0} Ω: one network, no parts`, r.solutions.length === 1 && r.solutions[0].fit.series.kind === 'none' && r.solutions[0].fit.shunt.kind === 'none');
  }
  const b = run({ rs: 49, rl: 49, xl: -49, values: 'exact', qL: NaN, qC: NaN, bandLoMHz: NaN, bandHiMHz: NaN });
  truth('49 to 49 − j49 Ω: every network has a real part', b.solutions.every((s) => [s.fit.series, s.fit.shunt].every((p) => p.kind === 'none' || p.value > 1e-13)));
}
// The suggestion when no network reaches the bandwidth level: the best return loss with tolerances, not the last one.
{
  const r = run({ bandLoMHz: NaN, bandHiMHz: NaN, rlBwDb: 60 });
  const bestTol = Math.max(...r.solutions.map((s) => s.fit.tolRlDb));
  check('no band, nothing reaches 60 dB: suggested has the best tolerance RL (dB)', r.solutions[r.best].fit.tolRlDb, bestTol, 1e-12);
}

// Errors.
{
  const bad = (over: Partial<MatchInputs>) => !calculate({ ...defaultMatch, ...over }).ok;
  truth('error: zero load resistance', bad({ rl: 0 }));
  truth('error: S11 of 0 dB', bad({ loadEntry: 's11', s11Db: 0 }));
  truth('error: one band end only', bad({ bandHiMHz: NaN }));
  truth('error: band reversed', bad({ bandLoMHz: 2480, bandHiMHz: 2400 }));
  truth('error: frequency outside the band', bad({ fMHz: 915 }));
  truth('no error: blank Q means ideal', !bad({ qL: NaN, qC: NaN }));
  truth('already matched is flagged', run({ rl: 50, xl: 0 }).matched);
}

void mul;
void inv;
void (null as unknown as Cx);
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
if (failures) process.exit(1);
