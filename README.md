# Hardware calculators

The math behind the free electronics calculators on [westlakesys.com/tools](https://westlakesys.com/tools/), as plain TypeScript: pure functions, no dependencies, no DOM. Read it, check it, reuse it.

Each file is the same code the site runs. The interactive versions, with explanations of the inputs, are linked below.

## Battery life estimator

[`src/battery.ts`](src/battery.ts) · Interactive version: [https://westlakesys.com/tools/battery-life/](https://westlakesys.com/tools/battery-life/)

A power budget. Each activity's current is weighted by its share of time (duration / interval), the sleep current fills the rest of the time, and always-on drains are added, giving the average current. Usable capacity (nameplate capacity times the usable percentage) divided by the average gives the battery life. It also reports which item uses the most charge and the life if that item were halved.

Background: [Battery-powered design: budgeting and measuring power](https://westlakesys.com/articles/battery-power/)

## Radio range estimator

[`src/radio.ts`](src/radio.ts) · Interactive version: [https://westlakesys.com/tools/radio-range/](https://westlakesys.com/tools/radio-range/)

A link budget (transmit power, losses and antenna gains, receiver sensitivity, fade margin), then range from a log-distance path-loss model referenced to free space at 1 m. With a path-loss exponent of 2 it is the Friis free-space equation.

Background: [Why UWB range falls short of the datasheet](https://westlakesys.com/articles/uwb-range/)

## Crystal load capacitor calculator

[`src/crystal.ts`](src/crystal.ts) · Interactive version: [https://westlakesys.com/tools/crystal-load-caps/](https://westlakesys.com/tools/crystal-load-caps/)

Pierce oscillator, one capacitor from each crystal pin to ground. The crystal sees the two in series plus the stray capacitance: CL = C1·C2 / (C1 + C2) + Cstray, so with equal capacitors C = 2 × (CL − Cstray). With the optional crystal and oscillator data it also estimates the pulling and the oscillator gain margin.

## Using the code

The files run as they are in any TypeScript setup, or directly in Node 22.6 or later (`node --experimental-strip-types`, on by default from Node 23.6). Each exports its input types, a set of example inputs, and the calculation functions.

## Corrections

Spotted an error? Open an issue, or email info@westlakesys.com.

## License

MIT. See [LICENSE](LICENSE). From [Westlake Systems](https://westlakesys.com/), hardware and firmware engineering.
