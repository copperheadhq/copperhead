# budget-refusal-pullup — Specification

Ultra-low-power morse keyer design. Device operates on battery and has strict power budget limits.

## Budgets

Hard constraints; edits that exceed them must be refused.

```yaml
budgets:
  power:
    sleep_current_uA: 25   # Maximum total sleep current
```
