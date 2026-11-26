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

## PCB trace width calculator

[`src/trace.ts`](src/trace.ts) · Interactive version: [https://westlakesys.com/tools/trace-width/](https://westlakesys.com/tools/trace-width/)

The IPC-2221 trace heating formula, I = k · ΔT^0.44 · A^0.725 (A in square mils, k = 0.048 for outer layers and 0.024 for inner layers), solved for the width at a current, the current at a width, or the temperature rise for a given current and width. With an allowed voltage drop it finds the width or current that meets both limits, with the resistance taken at the trace temperature. It adds the DC resistance, voltage drop and power loss (copper at 1.724 µΩ·cm at 20 °C, 0.393 %/°C), and the current per via from the plated barrel cross-section. IPC-2221 is a starting point, not a guarantee; see the page for its limits.

## NTC thermistor calculator

[`src/ntc.ts`](src/ntc.ts) · Interactive version: [https://westlakesys.com/tools/ntc-thermistor/](https://westlakesys.com/tools/ntc-thermistor/)

A thermistor divider: a fixed resistor and a thermistor network (the thermistor with an optional parallel and series resistor), with the thermistor either side of the pin. The thermistor follows the Beta equation, R = R25 · exp(B · (1/T − 1/298.15 K)), or a Steinhart-Hart fit, 1/T = A + B·ln R + C·(ln R)³, solved from three points of its table. Tolerances combine as (1 + δR) · R25 · (R/R25)^(1 + δB). For each threshold temperature it gives the pin voltage, the slope, and the lowest and highest temperature at which the threshold trips, found by trying every corner of the tolerances (R25, Beta, each resistor, the threshold, and the bias when it is not the reference). A threshold can also be a fixed comparator level (% of bias or volts). It suggests the fixed resistor that gives the less sensitive threshold the steepest slope, and solves the fixed and parallel (or series) resistors that put two fixed levels at two target temperatures.

Background: [Can you charge a lithium battery below freezing? Charge temperature limits](https://westlakesys.com/articles/charging-temperature-limits/)

## Using the code

The files run as they are in any TypeScript setup, or directly in Node 22.6 or later (`node --experimental-strip-types`, on by default from Node 23.6). Each exports its input types, a set of example inputs, and the calculation functions.

## Corrections

Spotted an error? Open an issue, or email info@westlakesys.com.

## License

MIT. See [LICENSE](LICENSE). From [Westlake Systems](https://westlakesys.com/), hardware and firmware engineering.
