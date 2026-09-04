## Purpose
Define USB-C sink connector and CC pull-down termination.

## Requirements
### Requirement: 5 V USB-C sink presentation
The board SHALL accept 5 V from a USB-C receptacle and terminate CC1 and CC2 with 5.1 kOhm pull-down resistors.

#### Scenario: VBUS enabled on plug-in
- **WHEN** connected to a compliant USB-C power source
- **THEN** the source detects Rd pull-downs and asserts 5 V on VBUS.
