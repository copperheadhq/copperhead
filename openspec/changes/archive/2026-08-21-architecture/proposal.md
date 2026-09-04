# Proposal: architecture

> Marker: AUTO (autonomous mode; auto-approved, reviewable after the fact)

## Why

Document the power-breakout architecture before schematic capture so the passive USB-C sink, protection, output, indicator, and intentional non-features remain traceable to the electrical and mechanical budgets.

## What Changes

- Add docs/SUBSYSTEMS.md with a prose block diagram and subsystem-by-subsystem architecture.
- State the 5–6 V input, 3 A capability, <2 mA no-load current, USB-C Rd, PTC, connector, layout, and cost constraints.
- Explicitly record that MCU, connectivity, and data/UI control subsystems are intentionally absent from this power-only breakout.
