# Op-amp drafting fixtures

Six op-amp stages used by [draft-opamp.test.ts](../../draft-opamp.test.ts) to pin the drafting rules for amplifiers (AC-16.39, AC-16.73 to AC-16.80):

- inverting amplifier
- follower
- non-inverting amplifier
- non-inverting amplifier with an analog switch (ADG417) across its feedback resistor, derived from the non-inverting stage
- summing integrator
- simple integrator

Each `schematic.intent.json` (except the switched-gain variant, which adds U2, TP5 and a +5 V pin to J9) is a netlist transcription of a circuit in Texas Instruments' *Handbook of Operational Amplifier Applications* (SBOA092B). It records only which part connects to which. Every stage carries a `J9` ±15 V header, because a rail with a single consumer is refused. The handbook's open-circle terminals are `Connector:TestPoint`.

`sym-lib-cache/` holds verbatim symbol definitions vendored from the [KiCad symbol libraries](https://gitlab.com/kicad/libraries/kicad-symbols) (CC-BY-SA 4.0 with the KiCad libraries exception), so the drafts resolve hermetically, as the reference boards do.
