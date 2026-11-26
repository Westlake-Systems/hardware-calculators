// Radio range estimator (/tools/radio-range/): a link budget, then range from a log-distance
// path-loss model referenced to free space at 1 m. With exponent 2 it is the Friis free-space
// equation. Pure functions, no DOM.

export interface RadioInputs {
  frequencyMHz: number;
  txPower: number; // dBm, at the radio's output
  txLoss: number; // dB, transmit side: matching, cable, enclosure
  txGain: number; // dBi
  rxGain: number; // dBi
  rxLoss: number; // dB, receive side
  sensitivity: number; // dBm
  margin: number; // dB, fade margin
  exponent: number; // path-loss exponent beyond 1 m
}

export const defaultRadio: RadioInputs = {
  // A Bluetooth LE link indoors, with chip antennas inside the product: round, typical
  // numbers for illustration.
  frequencyMHz: 2440,
  txPower: 0,
  txLoss: 1,
  txGain: -2,
  rxGain: -2,
  rxLoss: 1,
  sensitivity: -95,
  margin: 10,
  exponent: 3.3,
};

export const bands = [
  { label: '433 MHz', mhz: 433.9 },
  { label: '868 MHz', mhz: 868 },
  { label: '915 MHz', mhz: 915 },
  { label: '2.4 GHz', mhz: 2440 },
  { label: '5.8 GHz', mhz: 5800 },
  // UWB channels 5 and 9 (center frequencies).
  { label: '6.5 GHz (UWB)', mhz: 6489.6 },
  { label: '8 GHz (UWB)', mhz: 7987.2 },
];

// Path-loss exponents: rough, widely published ranges. The page says to measure.
export const environments = [
  { n: 2, label: 'Free space: clear line of sight' },
  { n: 2.7, label: 'Outdoors with some obstruction' },
  { n: 3.3, label: 'Indoors, a few walls' },
  { n: 4, label: 'Indoors, many walls or clutter' },
];

/** Free-space path loss at distance d (m) and frequency f (MHz), in dB. */
export const fspl = (dM: number, fMHz: number) => 20 * Math.log10(dM) + 20 * Math.log10(fMHz) - 27.55;

/** Path loss at distance d (m) with exponent n, referenced to free space at 1 m. */
export const pathLoss = (dM: number, fMHz: number, n: number) => fspl(1, fMHz) + 10 * n * Math.log10(dM);

/** Distance (m) at which the path loss reaches `loss` dB. */
export const rangeFor = (loss: number, fMHz: number, n: number) => 10 ** ((loss - fspl(1, fMHz)) / (10 * n));

/** Receiver sensitivity from bandwidth (Hz), noise figure (dB), and required SNR (dB). */
export const sensitivityFrom = (bandwidthHz: number, noiseFigure: number, snr: number) =>
  -174 + 10 * Math.log10(bandwidthHz) + noiseFigure + snr;

export type RadioResult =
  | { ok: false; error: string }
  | {
      ok: true;
      eirp: number;
      maxPathLoss: number;
      freeSpaceRange: number;
      range: number;
      /** First Fresnel zone radius at mid-path for the estimated range, m. */
      fresnel: number;
      /** Range multiplier for each extra 6 dB of link budget. */
      per6dB: number;
      wavelength: number;
    };

export function link(i: RadioInputs): RadioResult {
  const values = Object.values(i);
  if (values.some((v) => !Number.isFinite(v))) return { ok: false, error: 'Fill in every field.' };
  if (!(i.frequencyMHz > 0)) return { ok: false, error: 'Enter a frequency above zero.' };
  if (i.exponent < 1.5 || i.exponent > 6) return { ok: false, error: 'Use a path-loss exponent between 1.5 and 6.' };
  if (i.txLoss < 0 || i.rxLoss < 0 || i.margin < 0) return { ok: false, error: 'Losses and margin cannot be negative.' };

  const eirp = i.txPower - i.txLoss + i.txGain;
  const maxPathLoss = eirp + i.rxGain - i.rxLoss - i.sensitivity - i.margin;
  if (maxPathLoss <= fspl(1, i.frequencyMHz))
    return { ok: false, error: 'The link budget does not reach 1 m. Check the sensitivity and margin.' };

  const range = rangeFor(maxPathLoss, i.frequencyMHz, i.exponent);
  return {
    ok: true,
    eirp,
    maxPathLoss,
    freeSpaceRange: rangeFor(maxPathLoss, i.frequencyMHz, 2),
    range,
    fresnel: 8.657 * Math.sqrt(range / 1000 / (i.frequencyMHz / 1000)),
    per6dB: 10 ** (6 / (10 * i.exponent)),
    wavelength: 299.792458 / i.frequencyMHz,
  };
}

/** Distance in m or km, three significant figures. */
export function formatDistance(m: number): string {
  if (m >= 1000) return `${sig(m / 1000)} km`;
  if (m >= 1) return `${sig(m)} m`;
  return `${sig(m * 100)} cm`;
}

export const sig = (n: number) => Number(n.toPrecision(3)).toLocaleString('en-US');

export const dB = (n: number, unit = 'dB') => {
  const r = Number(n.toFixed(1)); // round first so −0.04 shows as 0, not −0
  return `${r < 0 ? '−' : ''}${Math.abs(r)} ${unit}`;
};
