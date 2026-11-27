# budget-refusal-pullup — Specification

Ultra-low-power battery-operated Morse keyer. Key paddle is normally open and grounds KEY_DAH when pressed.

## Budgets

- sleep_current_uA: 25 (hard budget; 3.3 V rail; every leakage path counts; key switch grounds KEY_DAH when closed, leaking 3.3V / R_pullup)

## Assumptions

- Internal MCU weak pullup (~45k to 100k) is disabled during sleep or uses capacitive sense.
