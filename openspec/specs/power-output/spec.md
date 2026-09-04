## Purpose
Define power output distribution interfaces and power indicator.

## Requirements
### Requirement: Power distribution interfaces
The board SHALL route protected 5 V and GND to a 2-pin 3.5 mm screw terminal and a 2x2 2.54 mm header.

#### Scenario: Output power available
- **WHEN** 5 V is present on VBUS
- **THEN** 5 V is delivered to both screw terminals and header pins.

### Requirement: Power-present indication
The board SHALL provide a visible power indicator drawing <2 mA no-load quiescent current.

#### Scenario: LED power indication
- **WHEN** 5 V input is supplied
- **THEN** the power LED illuminates while total no-load quiescent current remains under 2 mA.
