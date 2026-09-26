# Issue 66: native U2 documentation correction

On 2026-09-26, a separate native `do` run corrected one package mapping from
attempt 02's committed part-selection checkpoint. It exited 0 after six turns.
This is not a resumed schematic stage or a successful eight-stage `create` run.
The [machine summary](u2-correction.json) records the exact commits and evidence
hashes.

## Correction

The BOM selected `W25Q16JVSSIQ` but proposed the 150-mil footprint
`Package_SO:SOIC-8_3.9x4.9mm_P1.27mm`. Winbond's SS package is 208-mil: nominal
body 5.28 by 5.28 mm, pitch 1.27 mm and overall lead span 7.9 mm. The installed
candidate is `Package_SO:SOIC-8_5.3x5.3mm_P1.27mm`, also the installed
`Memory_Flash:W25Q16JVSS` symbol's default. The exact MPN and symbol were retained.

The supplied evidence came from the official [W25Q16JV datasheet, Rev G,
section 11.3 and ordering table](https://www.winbond.com/resource-files/w25q16jv%20spi%20revg%2003222018%20plus.pdf).
Its eight pins are CS, DO/IO1, WP/IO2, GND, DI/IO0, CLK, HOLD/IO3 and VCC,
respectively. The native run attributed these supplied facts in the BOM and
decision record; it did not claim independent PDF retrieval or fabrication
signoff. Full manufacturer PDFs are not included here.

## Native workflow and preservation

The original attempt-02 directory retained a modified configuration and three
untracked, empty KiCad scaffolds from the failed capture transition. A default
`do` invocation refused that dirty state before constructing a provider. No
model was started by that preflight probe.

A clean, separate continuation was cloned with `--no-hardlinks` from exact
sandbox HEAD `7950dae1500f3f769c610f2c1058d5a43df5d2fa`. The original directory
was not cleaned, stashed, rewritten or committed. Before/after hashes of its
tracked and nonignored untracked files, status and HEAD were identical.

The continuation used source `7cb174c3dea26fafec5285790450c884cb6ad142`, the
saved-login Codex provider, KiCad 10.0.6 and OpenSpec 1.13.2. Its native tools
proposed a capability delta, passed real OpenSpec validation, then edited the
BOM and recorded the decision. The first finish request was correctly refused
because a final document edit required another drift check. The same run
performed that check and completed; it was never restarted.

- Correction commit: `475ca083aaf326ce18fa1475f232d8d7833dd470`.
- Final archive commit: `f2796066b405d6435f621d00469c860f6a4376e9`.
- The exact starting sandbox commit is an ancestor of both commits.
- The continuation ended clean. Its configuration, SPEC and SUBSYSTEMS files
  were unchanged; all 18 existing constraints retained their original values.
- No schematic, board or project file was created or edited. ERC, DRC and
  legibility checks did not run. The native message `drift vacuously clean`
  refers to absent configured hardware and is not hardware verification.

## Remaining acceptance

The 100 mA preconfiguration, 200 mA configured, 50 mA sensor and 2.5 mA suspend
ceilings remain unchanged. Complete-board current bounds, ROM behavior,
host resume, electrical feasibility and footprint manufacturing acceptance
remain pending. This correction adds no completed create stage and provides no
evidence of an eight-stage success or a passing live smoke.

The generated files were changed only by native validated tools. The local raw
request, six provider responses, tool transcript, terminal result, Git bundle
and preservation checks are retained; their relevant hashes are in the machine
summary. This note contains no workspace paths, account configuration or
credentials. Implementation and verification used Codex assistance.
