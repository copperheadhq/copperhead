# Medium sample requirements: ESP32-C3 temperature/humidity display

Design a two-layer USB-C 5V-powered board with six subsystems: protected USB-C
input, efficient3.3V regulation, ESP32-C3 module/reset/boot/UART, digital
temperature/humidity sensing, external I2C OLED display, and RF/mechanics.
No USB data connection, USB-PD, battery, mains or external voltage input.

Use real manufacturer modules/parts as architecture candidates: Espressif
ESP32-C3-MINI-1-N4X (current recommended PCB-antenna4MB variant), Sensirion
SHT40-AD1B-R2, TI TPS62162DSGR fixed3.3V buck, TI TPS2553DBVR input protection,
GCT USB4125-GF-A standard1.00mm-stake power-only connector, and external
Adafruit product326 0.96in128x64 I2C OLED module. Part numbers/package pins,
library availability and exact support parts remain to be verified at later
part-selection/capture stages. No invented supply, prices, supplier SKUs or
"verified orderable" claims. Adafruit326 is a catalog part ID, not a guessed
bare-panel MPN. Manufacturer evidence below establishes candidate existence;
it does not prove full-board functional or thermal acceptance.

## Required budgets and acceptance criteria

- Input4.75–5.25V from a documented adequate5V source. Deployment requires a
  source explicitly advertising USB-C1.5A/3A or a separately verified adequate
  supply. Do not assume that fitting Rd grants universal500mA entitlement at
  default USB current. No PD negotiation or voltages above5V. Source-current
  advertisement/detection and allowed deployment must be stated honestly.
- Operational input target<=250mA continuous and<=450mA peak including display
  and protection overhead. These are design targets, not measured facts.
  Assign3.3V allocations: MCU<=150mA continuous/400mA transient, OLED<=50mA,
  sensor<=2mA with heater disabled, other3.3V loads<=20mA. Confirm MCU operating
  modes and actual device peaks against datasheets; report a contradiction
  rather than reducing a documented requirement. Preliminary3.3V peak472mA.
- Use buck regulation rated>=600mA; target3.3V within3.0–3.6V under startup,
  radio bursts and display load. Design efficiency floor75% is an ASSUMED
  acceptance target to verify, not a guaranteed vendor specification. At4.75V,
  3.3V*0.472A/(4.75V*0.75)=437.2mA before upstream overhead, leaving about12mA
  within the450mA input target. Reconcile protection losses, inrush, tolerances,
  quiescent current and thermal conditions; no unsubstantiated LDO heat claim.
- Input protection must address short circuit, ESD and controlled startup.
  TPS2553 adjustable-limit value/tolerance and required capacitors are later
  engineering work; a nominal500mA setting is not a guaranteed hard500mA cap.
- USB4125 mapping: A5=CC1 and B5=CC2 each have separate5.1k Rd to GND;
  A9/B9=VBUS; A12/B12=GND; fourS1 plated shell stakes connect to GND under the
  chosen ground policy. No data contacts, no CC1/CC2 short. Use stock6P symbol
  and exact matching standard-stake footprint later. No reductions to land
  sizes/drills. Required hole-to-copper clearance>=0.25mm remains enforced.
- I2C100kHz shared by SHT40 and external OLED, with3.3V-compatible pull-ups,
  checked parallel resistance/capacitance and no address conflict. Read sensor
  at1Hz; OLED refresh2Hz. Heater off; errors must be displayed/reported.
- External3.3V-level UART programming/debug connector with TX/RX/GND, labeled
  orientation and no target back-power. Manual RESET/EN and BOOT controls with
  ESP32-C3 strapping requirements verified; no automatic USB programming.
- Board envelope<=45x40mm; two copper layers; nominal thickness1.00mm to match
  GCT's standard-stake illustrated land-pattern recommendation. Connector
  shell, module and cable/enclosure fit remain mechanical acceptance checks.
  Ambient0–40C, non-condensing indoor sensing. Sensor>=10mm from regulator/MCU
  heat sources where practicable; report a layout conflict instead of hiding it.
- PCB antenna at a board edge, preferably extending beyond the base board.
  Retain manufacturer's antenna keepout with no copper/traces/components on
  either layer. Additional15mm in-plane clearance target is ASSUMED until
  reconciled with Espressif hardware guidelines and the actual base-board shape.
- Later firmware is mandatory: realSHT40 measurement/CRC/error handling and
  OLED temperature/humidity rendering on ESP-IDF or a documented compatible
  framework, plus a reproducible build. Hardware N/A is prohibited.
  Do not claim compiled success until a real build succeeds.

## Verified public source pointers supplied as input context

- Espressif module datasheetv2.2: <https://www.espressif.com/sites/default/files/documentation/esp32-c3-mini-1_datasheet_en.pdf>
  Recommends N4X and lists older N4 as NRND; module supply3.0–3.6V;3strapping
  pinsGPIO2/8/9; antenna guidance points to hardware design guidelines.
- Sensirion SHT4x manufacturer datasheet: <https://sensirion.com/media/documents/33FD6951/6A7C10A0/HT_DS_Datasheet_SHT4x_V7.3.pdf>
  SHT40 product: <https://sensirion.com/products/catalog/SHT40> . Exact ordering
  suffix and current/address limits require checking against the PDF.
- TI fixed3.3V1A buck: <https://www.ti.com/product/TPS62162>
- TI protection: <https://www.ti.com/product/TPS2553>
- Adafruit module326: <https://www.adafruit.com/product/326> . Manufacturer says
  I2C0x3C/0x3D, compatible with3V MCU, usage-dependent current roughly20mA in
  practice requiring measurement;50mA allocation is a design target only.
- GCT connector: <https://gct.co/connector/usb4125> and manufacturer drawing
  <https://media.digikey.com/pdf/Data%20Sheets/GCT%20PDFs/USB4125%20-%20Product%20Drawing.pdf>
  Standard suffix blank=1.00mm stake,0190=1.90mm. This new brief intentionally
  uses standard USB4125-GF-A with1.00mm nominal board thickness.

Flag every unstated default ASSUMED. Preserve unresolved verification work.
