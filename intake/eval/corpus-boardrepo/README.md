# BoardRepo datasheet corpus

The intake's first evaluation corpus: the datasheets of ICs used on the BoardRepo boards reviewed in the copperhead
showcase. Each part's datasheet is the one its board's KiCad symbol links to (the `Datasheet` field), fetched from
the manufacturer and pinned by sha256 in `documents/<id>.json`.

| | |
|---|---|
| Documents | one per part, `documents/<id>.json` |
| Pages | each document's absolute maximum ratings, recommended operating conditions and electrical characteristics pages |
| Fields | the intake's five default fields (`core/fields.ts`) |
| Labels | one labeller (Claude), from the datasheet text only, never from extractor output, by a written guide |
| Decision fixtures | `corpus.json`, each expected verdict derived from the labels |

The PDFs are copyrighted and are not committed. Fetch them with `npx tsx scripts/fetch-corpus.ts eval/corpus-boardrepo`,
which refuses any file whose sha256 differs from the one labelled. Manufacturers revise documents in place; a hash
mismatch means the labels no longer describe the file.

Parts whose manufacturer blocked automated download (STMicroelectronics, Analog Devices, onsemi, Silicon Labs) are not
in the corpus.

## Labelling rules

Each document labels every printed reading, on its selected pages, of the following five fields.

| Field | What is labelled |
|---|---|
| `supply_voltage_V` | Each MIN, TYP and MAX of the operating supply-voltage rows, from Recommended Operating Conditions where that table exists. |
| `quiescent_current_uA` | Every supply current: quiescent, ground-pin, operating, standby and shutdown. |
| `pin_input_leakage_uA` | Every input leakage or input current of a digital or control input pin. Output leakage and analog bias currents are excluded. |
| `abs_max_vin_V` | The maximum rating of each supply- or input-voltage row of Absolute Maximum Ratings, as ABS_MAX. |
| `recommended_pullup_ohm` | Every printed pull-up resistance. |

The format of each label:

- **Value:** a decimal number. A value that is not a single number ("0.75×VDD", "VCC + 0.5") is not labelled, and a range in one cell is two labels.
- **Unit:** normalised (µ as u, Ω as ohm).
- **Qualifier:** from the column header.
- **Conditions:** only those printed in the row itself, using the keys VCC, VDD, VIN, TA, TJ, F, IOUT and ILOAD.
- **Citation:** the page and a substring of the line the value is printed on.

Judgement calls are in each document's `labelNotes`.

## Status

One labeller and no second means the corpus audit fails (`npm run eval` prints why). A run on this corpus measures
the extractor; it never writes a calibration record.
