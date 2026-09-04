# Proposal: spec-seed

> Marker: AUTO (autonomous mode; auto-approved, reviewable after the fact)

## Why

Establish the authoritative requirements and constraints for the USB-C 5 V breakout before any schematic or PCB work begins.

## What Changes

- Create docs/SPEC.md defining the device purpose, scope, interfaces, electrical/mechanical/manufacturing budgets, and explicitly limiting the 3 A figure to board capability rather than USB-C negotiated availability.
- Create docs/DECISIONS.md documenting the required CC pull-down choice (5.1 kOhm Rd on each CC pin) and its rationale.
- Seed OpenSpec capability requirements only if an openspec/ workspace is available.
- Record every stated or assumed budget as a constraint, marking defaults as ASSUMED.
