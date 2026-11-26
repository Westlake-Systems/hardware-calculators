// Battery life estimator (/tools/battery-life/): the power-budget method from the
// battery-power article. Each mode's current is weighted by its share of time and summed into an
// average; usable capacity divided by the average gives the life. Pure functions, no DOM.

export const currentUnits = { nA: 1e-6, µA: 1e-3, mA: 1, A: 1000 } as const; // in mA
export const durationUnits = { ms: 1e-3, s: 1, min: 60 } as const; // in seconds
export const intervalUnits = { s: 1, min: 60, h: 3600, day: 86400 } as const; // in seconds

export type CurrentUnit = keyof typeof currentUnits;
export type DurationUnit = keyof typeof durationUnits;
export type IntervalUnit = keyof typeof intervalUnits;

export interface Activity {
  name: string;
  current: number;
  currentUnit: CurrentUnit;
  duration: number;
  durationUnit: DurationUnit;
  every: number;
  everyUnit: IntervalUnit;
}

export interface Drain {
  name: string;
  current: number;
  currentUnit: CurrentUnit;
}

export interface BatteryInputs {
  preset: string;
  capacity: number; // mAh, nominal
  usable: number; // % of nominal that the product can actually use
  selfDischarge: number; // % of nominal per year
  sleep: Drain;
  activities: Activity[];
  alwaysOn: Drain[];
}

export interface BatteryPreset {
  id: string;
  label: string;
  capacity: number;
  selfDischarge: number;
  /** Shown when the peak current is high for this kind of cell. */
  pulseLimit?: { mA: number; note: string };
  rechargeable?: boolean;
}

// Typical nominal figures for generic cell types, as a starting point only. The page says so:
// real capacity depends on the cell, load, temperature, and cutoff voltage.
export const presets: BatteryPreset[] = [
  {
    id: 'cr2032',
    label: 'CR2032 coin cell, 3 V',
    capacity: 225,
    selfDischarge: 1,
    pulseLimit: {
      mA: 10,
      note: 'Coin cells deliver much less than their rated capacity at high pulse currents. Check the datasheet’s pulse performance, and consider a reservoir capacitor to carry the burst.',
    },
  },
  {
    id: 'cr2477',
    label: 'CR2477 coin cell, 3 V',
    capacity: 1000,
    selfDischarge: 1,
    pulseLimit: {
      mA: 10,
      note: 'Coin cells deliver much less than their rated capacity at high pulse currents. Check the datasheet’s pulse performance, and consider a reservoir capacitor to carry the burst.',
    },
  },
  { id: 'aaa-alk', label: '2 × AAA alkaline, 3 V', capacity: 1100, selfDischarge: 2 },
  { id: 'aa-alk', label: '2 × AA alkaline, 3 V', capacity: 2500, selfDischarge: 2 },
  { id: 'aa-lifes2', label: '2 × AA lithium iron disulfide, 3 V', capacity: 3000, selfDischarge: 1 },
  {
    id: 'aa-lisocl2',
    label: 'AA lithium thionyl chloride, 3.6 V',
    capacity: 2400,
    selfDischarge: 1,
    pulseLimit: {
      mA: 50,
      note: 'Bobbin-type lithium thionyl chloride cells are built for low, steady currents. Pulses this large can pull the voltage down, especially when cold or after storage, and often need a capacitor or a hybrid cell. Check the datasheet’s pulse rating.',
    },
  },
  {
    id: 'd-lisocl2',
    label: 'D lithium thionyl chloride, 3.6 V',
    capacity: 17000,
    selfDischarge: 1,
    pulseLimit: {
      mA: 150,
      note: 'Bobbin-type lithium thionyl chloride cells are built for low, steady currents. Pulses this large can pull the voltage down, especially when cold or after storage, and often need a capacitor or a hybrid cell. Check the datasheet’s pulse rating.',
    },
  },
  { id: 'lipo-1000', label: 'Lithium-ion pouch, 1000 mAh, 3.7 V', capacity: 1000, selfDischarge: 25, rechargeable: true },
  { id: '18650', label: '18650 lithium-ion, 3.7 V', capacity: 3000, selfDischarge: 25, rechargeable: true },
];

export const defaultInputs: BatteryInputs = {
  // The hypothetical example from the battery-power article.
  preset: 'aa-alk',
  capacity: 2500,
  usable: 80,
  selfDischarge: 2,
  sleep: { name: 'Sleep', current: 5, currentUnit: 'µA' },
  activities: [
    { name: 'Wake and sense', current: 5, currentUnit: 'mA', duration: 1, durationUnit: 's', every: 1, everyUnit: 'min' },
    { name: 'Radio transmit', current: 50, currentUnit: 'mA', duration: 20, durationUnit: 'ms', every: 1, everyUnit: 'min' },
  ],
  alwaysOn: [],
};

export interface Contribution {
  name: string;
  /** Average current this item adds, in mA. */
  mA: number;
  share: number; // 0..1 of the total average
}

export type BatteryResult =
  | { ok: false; error: string }
  | {
      ok: true;
      averageMA: number;
      peakMA: number;
      lifeHours: number;
      usableMAh: number;
      perDayMAh: number;
      contributions: Contribution[];
      /** Largest contributor, and the life if it were halved. */
      top: Contribution & { lifeHoursIfHalved: number };
      /** Fraction of time spent asleep. */
      sleepFraction: number;
    };

const finite = (n: number) => Number.isFinite(n) && n >= 0;

export function estimate(input: BatteryInputs): BatteryResult {
  if (!finite(input.capacity) || input.capacity <= 0) return { ok: false, error: 'Enter the battery capacity.' };
  if (!finite(input.usable) || input.usable <= 0 || input.usable > 100)
    return { ok: false, error: 'Usable capacity must be above 0% and no more than 100%.' };
  if (!finite(input.selfDischarge)) return { ok: false, error: 'Self-discharge cannot be negative.' };

  const items: { name: string; mA: number }[] = [];
  let duty = 0;
  let peakActivity = 0;

  for (const a of input.activities) {
    const current = a.current * currentUnits[a.currentUnit];
    const on = a.duration * durationUnits[a.durationUnit];
    const period = a.every * intervalUnits[a.everyUnit];
    if (!finite(current) || !finite(on)) return { ok: false, error: `Check the values for “${a.name || 'an activity'}”.` };
    if (!(period > 0)) return { ok: false, error: `Set how often “${a.name || 'an activity'}” happens.` };
    if (on > period)
      return { ok: false, error: `“${a.name || 'An activity'}” lasts longer than the time between repeats.` };
    const fraction = on / period;
    duty += fraction;
    peakActivity = Math.max(peakActivity, current);
    items.push({ name: a.name || 'Activity', mA: current * fraction });
  }
  // A small tolerance so activities that exactly fill the time are not rejected by rounding.
  if (duty > 1 + 1e-9)
    return { ok: false, error: 'The activities add up to more than 100% of the time. Check durations and intervals.' };

  const sleepCurrent = input.sleep.current * currentUnits[input.sleep.currentUnit];
  if (!finite(sleepCurrent)) return { ok: false, error: 'Check the sleep current.' };
  const sleepFraction = Math.max(0, 1 - duty);
  items.unshift({ name: input.sleep.name || 'Sleep', mA: sleepCurrent * sleepFraction });

  let alwaysOn = 0;
  for (const d of input.alwaysOn) {
    const current = d.current * currentUnits[d.currentUnit];
    if (!finite(current)) return { ok: false, error: `Check the current for “${d.name || 'an always-on drain'}”.` };
    alwaysOn += current;
    items.push({ name: d.name || 'Always-on drain', mA: current });
  }

  // Self-discharge as an equivalent steady drain: a share of nominal capacity lost per year.
  const selfMA = (input.capacity * input.selfDischarge) / 100 / (365.25 * 24);
  if (selfMA > 0) items.push({ name: 'Self-discharge', mA: selfMA });

  const averageMA = items.reduce((sum, i) => sum + i.mA, 0);
  if (!(averageMA > 0)) return { ok: false, error: 'Enter at least one current above zero.' };

  const usableMAh = (input.capacity * input.usable) / 100;
  const lifeHours = usableMAh / averageMA;
  const contributions = items.map((i) => ({ ...i, share: i.mA / averageMA }));
  const largest = contributions.reduce((a, b) => (b.mA > a.mA ? b : a));

  return {
    ok: true,
    averageMA,
    peakMA: Math.max(peakActivity, sleepCurrent) + alwaysOn,
    lifeHours,
    usableMAh,
    perDayMAh: averageMA * 24,
    contributions,
    top: { ...largest, lifeHoursIfHalved: usableMAh / (averageMA - largest.mA / 2) },
    sleepFraction,
  };
}

/** Current in the most readable unit: 105 µA, 1.2 mA, 350 nA. */
export function formatCurrent(mA: number): string {
  if (mA >= 1000) return `${round(mA / 1000)} A`;
  if (mA >= 1) return `${round(mA)} mA`;
  if (mA >= 1e-3) return `${round(mA * 1000)} µA`;
  return `${round(mA * 1e6)} nA`;
}

/** Duration in hours as hours, days, months, or years. */
export function formatLife(hours: number): string {
  const days = hours / 24;
  if (hours < 1) return plural(round(hours * 60), 'minute');
  if (hours < 48) return plural(round(hours), 'hour');
  if (days < 60) return `${round(days)} days`;
  if (days < 730) return `${round(days / 30.44)} months`;
  return `${round(days / 365.25)} years`;
}

const plural = (n: string, unit: string) => `${n} ${unit}${n === '1' ? '' : 's'}`;

/** Three significant figures, without trailing zeros. */
function round(n: number): string {
  if (n === 0) return '0';
  const digits = n >= 100 ? 0 : n >= 10 ? 1 : 2;
  return Number(n.toFixed(digits)).toLocaleString('en-US');
}
