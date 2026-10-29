# Power

## Simulation
scope: nets VIN, VOUT
analysis: op
source: VIN=3.3
assert: V(VOUT) between 1.6 and 1.7
