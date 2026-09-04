## Purpose
Define output short-circuit protection for the USB-C 5 V power breakout.

## Requirements
### Requirement: Output short current limiting
The device SHALL limit sustained fault current when the output terminals are shorted to GND.

#### Scenario: Output short circuit
- **WHEN** an output terminal (+5V_OUT) is shorted to GND
- **THEN** the series resettable PTC shall trip and limit sustained fault current.

### Requirement: PTC rating and thermal specification
The protection element SHALL provide a resettable PTC with >=3 A hold current at 25 °C reference temperature and <=6 A trip current at 25 °C, with standard thermal derating across the 0 to 50 °C ambient range.

#### Scenario: Normal 3 A operation at room temperature
- **WHEN** continuous load current up to 3 A is drawn at 25 °C ambient
- **THEN** the PTC remains in the conductive un-tripped state.
