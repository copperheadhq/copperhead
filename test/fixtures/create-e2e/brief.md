# Brief: Field humidity/temperature logger

Design a compact battery-powered environmental logger for cold-chain food
transport. It sleeps for minutes between samples and wakes on a schedule.

## Requirements
- Measure ambient temperature and relative humidity every 5 minutes.
- Store samples locally; survive a power interruption without corrupting the log.
- Run for at least 6 months on a CR2032 coin cell.
- A push-button dumps the log over UART at 115200 baud.
- An LED blinks once per sample cycle (budget the LED current).
- Operating range: -20 C to +60 C.
