// Checks src/lib/i2c.ts against the worked examples in TI's SLVA689A and the NXP I2C-bus
// specification (UM10204 Rev. 7.0), the spec's own consistency (Equation 3 gives each mode's rated
// clock at its limits), hand-worked numbers, and brute force (every value the calculator offers
// passes every check, and the standard values just outside its range fail one).
// Usage: node scripts/test-i2c.ts
import { calculate, check, bounds, clockFor, defaultI2c, standardList, busCap, RISE_K, type I2cInputs, type I2cResult } from '../../src/i2c.ts';

let failures = 0;
const near = (name: string, got: number, want: number, tol: number) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got.toPrecision(6)} (want ${want} ± ${tol})`);
};
const truth = (name: string, ok: boolean) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
};
const inputs = (over: Partial<I2cInputs>): I2cInputs => ({ ...defaultI2c, ...over });
const run = (over: Partial<I2cInputs>): I2cResult => {
  const r = calculate(inputs(over));
  if (!r.ok) throw new Error(r.error);
  return r;
};
const bound = (over: Partial<I2cInputs>, limit: string) => bounds(inputs(over)).find((b) => b.limit === limit)!.ohms;
// An exact bus: no tolerances, no leakage, a total capacitance.
const exact: Partial<I2cInputs> = { vddTolPct: 0, tolPct: 0, leakUa: 0, capEntry: 'total' };

// TI SLVA689A, section 4: Fast mode, Cb = 200 pF, VCC = 3.3 V.
const ti = { ...exact, mode: 'fast' as const, vdd: 3.3, capTotalPf: 200 };
near('TI: Rp(max) 1.77 kΩ', bound(ti, 'rise'), 1770, 1);
near('TI: Rp(min) 966.667 Ω', bound(ti, 'sink'), 966.667, 0.01);
near('0.8473 (ln 7/3)', RISE_K, 0.8473, 0.00001);

// UM10204 Section 7.2.4: 5 V ± 10 %, 0.4 V at 3 mA → Rp(min) 1.7 kΩ, about 200 pF at 300 ns.
const nxp = { ...exact, mode: 'fast' as const, vdd: 5, vddTolPct: 10 };
near('NXP 7.2.4: Rp(min) 1.7 kΩ', bound(nxp, 'sink'), 1700, 1e-6);
near('NXP 7.2.4: about 200 pF at 1.7 kΩ', run({ ...nxp, capTotalPf: 100 }).cbMax * 1e12, 208.3, 0.1);

// UM10204 Figure 42: Rp(min) against VDD, 3 mA (Standard and Fast) and 20 mA (Fast-mode Plus).
near('Fig 42: 3 mA at 12 V, 3.87 kΩ', bound({ ...exact, mode: 'standard', vdd: 12 }, 'sink'), (12 - 0.4) / 3e-3, 1e-6);
near('Fig 42: 20 mA at 12 V, 580 Ω', bound({ ...exact, mode: 'fastPlus', vdd: 12 }, 'sink'), 580, 1e-6);

// UM10204 Figure 41: Rp(max) at 400 pF: 2.95 kΩ (Standard), 885 Ω (Fast); 550 pF Fast-mode Plus 257 Ω.
near('Fig 41: Standard 400 pF', bound({ ...exact, mode: 'standard', capTotalPf: 400 }, 'rise'), 1000e-9 / (RISE_K * 400e-12), 1e-6);
near('Fig 41: Standard 400 pF ≈ 2.95 kΩ', bound({ ...exact, mode: 'standard', capTotalPf: 400 }, 'rise'), 2950, 5);
near('Fig 41: Fast 400 pF ≈ 885 Ω', bound({ ...exact, mode: 'fast', capTotalPf: 400 }, 'rise'), 885, 1);
near('Fig 41: Fm+ 550 pF ≈ 257 Ω', bound({ ...exact, mode: 'fastPlus', capTotalPf: 550 }, 'rise'), 257.5, 0.5);

// UM10204 Figure 47: total high-level input current against Rp(max): 5 V and 200 µA → 2.5 kΩ; 15 V and 200 µA → 7.5 kΩ.
near('Fig 47: 5 V, 200 µA', bound({ ...exact, vdd: 5, devices: 20, leakUa: 10 }, 'leak'), 2500, 1e-6);
near('Fig 47: 15 V, 200 µA', bound({ ...exact, vdd: 15, devices: 20, leakUa: 10 }, 'leak'), 7500, 1e-6);

// UM10204 Figure 46, series resistors: Rs(max) = Rp · (0.2·VDD − 0.4) / (0.8·VDD): 0.05·Rp at 2.5 V, 0.15·Rp at 5 V.
near('Fig 46: 2.5 V, Rs 500 Ω needs Rp ≥ 10 kΩ', bound({ ...exact, vdd: 2.5, rsOhm: 500 }, 'noise'), 10000, 1e-6);
near('Fig 46: 5 V, Rs 1500 Ω needs Rp ≥ 10 kΩ', bound({ ...exact, vdd: 5, rsOhm: 1500 }, 'noise'), 10000, 1e-6);
truth('No series resistor: no noise limit', Number.isNaN(bound({ ...exact }, 'noise')));
truth('2 V and below, spec driver, Rs > 0: no room (infinite limit)', bound({ ...exact, vdd: 1.8, rsOhm: 100 }, 'noise') === Infinity);
truth('… so no value works', run({ ...exact, vdd: 1.8, rsOhm: 100 }).blocked === 'clash');

// Low-voltage driver: 0.2·VDD at 2 mA. 1.8 V: (1.8 − 0.36) / 2 mA = 720 Ω.
near('1.8 V: Rp(min) 720 Ω', bound({ ...exact, vdd: 1.8 }, 'sink'), 720, 1e-6);
near('1.8 V ± 5 %: (1.89 · 0.8) / 2 mA = 756 Ω', bound({ ...exact, vdd: 1.8, vddTolPct: 5 }, 'sink'), 756, 1e-6);
truth('1.8 V Standard-mode is flagged', run({ ...exact, vdd: 1.8, mode: 'standard' }).lowVddStandard);
truth('1.8 V spec driver leaves exactly the margin (no flag)', !run({ ...exact, vdd: 1.8 }).volMargin);
// Fast mode's 6 mA option: (3.3 − 0.6) / 6 mA = 450 Ω; at 3.3 V there is margin, at 2.7 V there is not.
near('Fast 6 mA: 450 Ω', bound({ ...exact, driver: 'fast6' }, 'sink'), 450, 1e-6);
truth('Fast 6 mA at 3.3 V: margin', !run({ ...exact, driver: 'fast6' }).volMargin);
truth('Fast 6 mA at 2.7 V: no margin', run({ ...exact, driver: 'fast6', vdd: 2.7 }).volMargin);
// A rated VOL above 0.2·VDD is a warning, not a block (its low level falls with less current), and
// calculate and check agree on the values offered: 6 mA at 0.6 V on 3.0 V ± 5 %.
const nm = run({ driver: 'fast6', vdd: 3.0 });
truth('Low-level margin short: flagged, values still offered and passing', nm.volMargin && nm.feasible && nm.picks.length > 0 && nm.picks.every((p) => p.ok));
truth('… but with a series resistor there is no room', run({ driver: 'fast6', vdd: 3.0, rsOhm: 50 }).blocked === 'clash');
truth('6 mA option ignored outside Fast mode', bound({ ...exact, driver: 'fast6', mode: 'standard' }, 'sink') === (3.3 - 0.4) / 3e-3);
// Fast mode with 6 mA at 0.6 V drives the full 400 pF at 3.3 V (spec footnote): 450 Ω < 885 Ω.
truth('Fast 6 mA reaches 400 pF', run({ ...exact, driver: 'fast6', capTotalPf: 400 }).feasible);
truth('Fast 3 mA does not reach 400 pF at 3.3 V', !run({ ...exact, capTotalPf: 400 }).feasible);

// A supply range spanning 2 V is checked on both sides (Neon review): 2.05 V ± 5 % reaches 1.9475 V,
// where the spec gives only 2 mA at 0.2·VDD: (2.0 − 0.4) / 2 mA = 800 Ω, more than (2.1525 − 0.4) / 3 mA = 584 Ω.
near('2.05 V ± 5 %: sink limit 800 Ω', bound({ ...exact, vdd: 2.05, vddTolPct: 5 }, 'sink'), 800, 1e-6);
truth('2.05 V ± 5 %: no false margin flag', !run({ ...exact, vdd: 2.05, vddTolPct: 5 }).volMargin);
near('2.05 V ± 5 % Fm+: sink limit 800 Ω (not 87.6 Ω)', bound({ ...exact, mode: 'fastPlus', vdd: 2.05, vddTolPct: 5 }, 'sink'), 800, 1e-6);
truth('2.05 V ± 5 %, Rs 100 Ω: no room', bound({ ...exact, vdd: 2.05, vddTolPct: 5, rsOhm: 100 }, 'noise') === Infinity);
truth('5.5 V ± 5 % is flagged above 5.5 V', run({ vdd: 5.5 }).vddHigh);
truth('5 V ± 10 % is not', !run({ vdd: 5, vddTolPct: 10 }).vddHigh);

// Equation 3 at each mode's own limits gives its rated clock.
near('Eq 3: Standard 100 kHz', 1 / (4.7e-6 + 4.0e-6 + 1000e-9 + 300e-9), 100e3, 1e-6);
near('Eq 3: Fast 400 kHz', 1 / (1.3e-6 + 0.6e-6 + 300e-9 + 300e-9), 400e3, 1e-6);
near('Eq 3: Fm+ 1 MHz', 1 / (0.5e-6 + 0.26e-6 + 120e-9 + 120e-9), 1e6, 1e-6);
near('clockFor caps at the rating', clockFor('fast', 100e-9), 400e3, 1e-6);
near('clockFor: Fast with a 500 ns rise', clockFor('fast', 500e-9), 1 / (1.3e-6 + 0.6e-6 + 500e-9 + 300e-9), 1e-6);

// Capacitance estimate: 4 × 10 pF + 10 cm × 1 pF/cm + 10 pF = 60 pF.
near('Estimate: 60 pF', busCap(defaultI2c) * 1e12, 60, 1e-9);

// Defaults, by hand: 3.3 V ± 5 %, 1 % resistors, 60 pF, 4 devices at 10 µA.
// sink (3.465 − 0.4) / 3 mA = 1021.67 Ω → nominal ≥ 1031.99; rise 300 ns / (0.847298 · 60 pF) = 5901.1 Ω,
// leak 0.1 · 3.135 / 40 µA = 7837.5 Ω → nominal ≤ 5842.7. E24 picks 1.1 kΩ, 2.4 kΩ, 5.6 kΩ.
const d = run({});
near('Default: sink limit', d.lineLow, 1021.667, 0.01);
near('Default: rise limit', d.lineHigh, 5901.1, 0.1);
truth('Default: rise sets the high end, sink the low end', d.highBy === 'rise' && d.lowBy === 'sink');
near('Default: rMin', d.rMin, 1021.667 / 0.99, 0.01);
near('Default: rMax', d.rMax, 5901.1 / 1.01, 0.1);
truth(`Default picks 1.1k, 2.4k, 5.6k (got ${d.picks.map((p) => p.ohms).join(', ')})`, d.picks.map((p) => p.ohms).join() === '1100,2400,5600');
truth('Default picks all pass', d.picks.every((p) => p.ok));

// A chosen value: 4.7 kΩ at the defaults. Rise worst 0.8473 · 4747 · 60 pF = 241 ns.
const c = run({ chosenOhm: 4700 }).chosen!;
near('4.7 kΩ: worst rise', c.riseWorst * 1e9, RISE_K * 4747 * 60e-3, 1e-6);
near('4.7 kΩ: current while low', c.currentNom * 1e3, (3.3 - 0.4) / 4.7, 1e-9);
truth('4.7 kΩ passes', c.ok);
const c10 = run({ chosenOhm: 10000 }).chosen!;
truth('10 kΩ fails the rise time', !c10.riseOk && !c10.ok);
near('10 kΩ: clock', c10.fMax, clockFor('fast', RISE_K * 10100 * 60e-12), 1e-6);

// Pull-ups already on the bus: two 10 kΩ modules (5 kΩ combined). The new resistor R must give
// R ∥ 5 kΩ ≥ 1031.99 → R ≥ 1300.4 Ω.
const e = run({ existingOhm: 5000 });
near('Existing 5 kΩ: rMin', e.rMin, (1031.987 * 5000) / (5000 - 1031.987), 0.05);
truth('Existing 5 kΩ: within the high limit alone, so none needed', e.existingEnough && e.rMax === Infinity);
truth('Existing 1 kΩ: too strong', run({ existingOhm: 1000 }).blocked === 'existing');
// A clash is reported ahead of pull-ups that are too strong (Neon review).
truth('400 pF and existing 1 kΩ: the clash first', run({ capEntry: 'total', capTotalPf: 400, existingOhm: 1000 }).blocked === 'clash');
truth('1.8 V, Rs 100 Ω, existing 10 kΩ: the clash, not the pull-ups', run({ vdd: 1.8, rsOhm: 100, existingOhm: 10000 }).blocked === 'clash');
// Existing pull-ups exactly at the low limit are allowed: NXP 7.2.4's 1.7 kΩ at 5 V ± 10 %.
const edge = run({ ...nxp, capTotalPf: 100, existingOhm: 1700 });
truth('Existing exactly at the limit: enough on their own', edge.feasible && edge.existingEnough && check(inputs({ ...nxp, capTotalPf: 100, existingOhm: 1700 }), Infinity).ok);
truth('Existing enough: no "no standard value" flag', !run({ existingOhm: 1033 }).noStandard);
// Neon round 2: "enough on their own" agrees with an open upper end, and the low-level threshold is the same everywhere.
const leakEdge = { ...exact, mode: 'standard' as const, vdd: 5, capTotalPf: 10, devices: 20, leakUa: 10 };
const le = run({ ...leakEdge, existingOhm: 2500 + 1e-6 });
truth('Existing just above the leakage limit: enough exactly when rMax is open', le.existingEnough === !Number.isFinite(le.rMax));
const vm = run({ ...exact, capTotalPf: 60, vdd: 3.0, driver: 'custom', volV: 0.6 + 1.5e-9, iolMa: 3 });
truth('VOL a hair above 0.2·VDD: calculate and check agree', vm.feasible ? vm.picks.every((p) => p.ok) : vm.picks.length === 0);
// One standard value in a narrow range: 300 pF at the defaults leaves 1.03 to 1.17 kΩ, only 1.1 kΩ in E24.
const one = run({ capEntry: 'total', capTotalPf: 300 });
truth(`300 pF: only 1.1 kΩ (got ${one.picks.map((p) => p.ohms).join(', ')})`, one.picks.length === 1 && one.picks[0].ohms === 1100 && Number.isFinite(one.rMax));
const e2 = run({ existingOhm: 20000 });
truth('Existing 20 kΩ: a resistor is still needed', !e2.existingEnough && Number.isFinite(e2.rMax));

// Brute force: across random buses, every standard value the calculator offers passes every
// check, every value inside [rMin, rMax] passes, and the standard values just outside fail one.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
let cases = 0;
let infeasible = 0;
let bad = 0;
for (let n = 0; n < 4000; n++) {
  const modesList = ['standard', 'fast', 'fastPlus'] as const;
  const i = inputs({
    mode: modesList[Math.floor(rand() * 3)],
    vdd: [1.2, 1.8, 2.05, 2.5, 3.0, 3.3, 5, 12][Math.floor(rand() * 8)],
    vddTolPct: rand() * 10,
    capEntry: 'total',
    capTotalPf: 10 + rand() * 350,
    devices: 1 + Math.floor(rand() * 20),
    leakUa: rand() < 0.3 ? 0 : rand() * 10,
    rsOhm: rand() < 0.5 ? 0 : rand() * 500,
    existingOhm: rand() < 0.7 ? NaN : 1000 + rand() * 20000,
    tolPct: [0, 1, 5][Math.floor(rand() * 3)],
    series: (['E12', 'E24', 'E96'] as const)[Math.floor(rand() * 3)],
    driver: rand() < 0.2 ? 'custom' : rand() < 0.2 ? 'fast6' : 'spec',
    volV: 0.1 + rand() * 0.3,
    iolMa: 1 + rand() * 20,
  });
  const r = calculate(i);
  if (!r.ok) continue;
  cases++;
  if (!r.feasible) {
    infeasible++;
    // Nothing from 10 Ω to 1 MΩ, on a fine grid, may pass when the calculator says none works.
    for (let k = 0; k <= 400; k++) {
      const x = 10 * 10 ** (5 * (k / 400));
      if (check(i, x).ok) {
        bad++;
        break;
      }
    }
    continue;
  }
  for (const p of r.picks) if (!p.ok) bad++;
  for (let k = 0; k <= 20; k++) {
    const x = r.rMin * (Number.isFinite(r.rMax) ? (r.rMax / r.rMin) ** (k / 20) : 10 ** (k / 10));
    if (!check(i, x).ok) {
      bad++;
      break;
    }
  }
  const list = standardList(i.series);
  const below = [...list].reverse().find((x) => x < r.rMin * (1 - 1e-9));
  const above = list.find((x) => x > r.rMax * (1 + 1e-9));
  if (below !== undefined && check(i, below).ok) bad++;
  if (above !== undefined && check(i, above).ok) bad++;
}
truth(`Brute force: ${cases} buses (${infeasible} with no value), ${bad} disagreements`, bad === 0 && cases > 3000);

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
