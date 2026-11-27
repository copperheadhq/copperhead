# Power

## Simulation
scope: nets VIN, VOUT
analysis: op
source: VIN=3.3
assert: V(VOUT) between 3.0 and 3.1
