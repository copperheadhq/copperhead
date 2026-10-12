"""Generate GPIO definitions exclusively from the reviewed PINOUT table."""
import argparse
import pathlib
import re

p = argparse.ArgumentParser()
p.add_argument('--pinout', required=True)
p.add_argument('--output', required=True)
p.add_argument('--snapshot', required=True)
a = p.parse_args()
rows = {}
for line in pathlib.Path(a.pinout).read_text(encoding='utf-8').splitlines():
    cells = [s.strip() for s in line.split('|')[1:-1]]
    if len(cells) == 4 and cells[0] == 'U1':
        _, pin, net, function = cells
        if net in rows:
            raise SystemExit('Duplicate U1 net in PINOUT: ' + net)
        rows[net] = (pin, function)
nets = ['I2C_SDA', 'I2C_SCL', 'OLED_RST', 'EF_FAULT_N']
lines = ['/* Generated from docs/PINOUT.md by tools/generate_pins.py; do not edit. */', '#pragma once']
assigned = []
for net in nets:
    if net not in rows:
        raise SystemExit('Missing U1 net in PINOUT: ' + net)
    m = re.search(r'GPIO\s*(\d+)\b', rows[net][1])
    if not m:
        raise SystemExit('Missing GPIO function for ' + net)
    gpio = int(m.group(1))
    if gpio in (2, 8, 9, 18, 19, 20, 21) or not 0 <= gpio <= 21:
        raise SystemExit('Peripheral conflicts with straps/USB/UART: ' + net)
    assigned.append(gpio)
    lines.append(f'#define PIN_{net} {gpio}')
if len(set(assigned)) != len(assigned):
    raise SystemExit('Duplicate peripheral GPIO assignment')
for net, macro, function in [('U_RX', 'RX', 'RXD0'), ('U_T', 'TX', 'TXD0')]:
    pin, description = rows[net]
    if function not in description or not pin.isdigit():
        raise SystemExit('UART package function missing in PINOUT: ' + net)
    lines.append(f'#define PIN_UART_{macro}_PACKAGE {pin}')
lines.append('/* GPIO2/8/9 are reserved boot straps; UART0 uses the SDK default pads. */')
content = '\n'.join(lines) + '\n'
if pathlib.Path(a.snapshot).read_text(encoding='utf-8') != content:
    raise SystemExit('firmware/pins.h differs from PINOUT-derived output; regenerate the snapshot before building')
out = pathlib.Path(a.output)
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(content, encoding='utf-8')
