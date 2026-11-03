# Manual test log

Executed 2026-10-09 on the isolated public review branch with Node 24.19.0 and KiCad 9.0.2. No model API call was made in this manual session. The variant was the repository's documented `edit` sandbox, created by its setup script, not a copied completed design.

```text
$ bash manual-tests/setup.sh edit
exit 0: sandbox ready at manual-tests/runs/edit

$ node dist/cli.js --repo manual-tests/runs/edit init
exit 0: created SPEC/BOM/PINOUT/SUBSYSTEMS/LAYOUT/DECISIONS/CHANGELOG docs and pre-commit hook

$ git -C manual-tests/runs/edit add -A
exit 0
$ git -C manual-tests/runs/edit commit -m "scaffold docs"
first attempt exit 1: copperhead executable was not on PATH for the generated hook
```

A process-local PATH entry pointing to this branch's compiled `dist/cli.js` was then supplied under the executable name `copperhead`. The hook was not disabled or changed. The same commit succeeded and the hook actually ran ERC, DRC and drift checks.

```text
$ git -C manual-tests/runs/edit commit -m "scaffold docs"
exit 0: real pre-commit checks executed; scaffold docs committed

$ node dist/cli.js --repo manual-tests/runs/edit check
exit 0: ERC clean, normalized DRC clean, drift clean
retained: 1 unlabeled-group legibility error, 5 advisories, score 40/100

$ node dist/cli.js --repo manual-tests/runs/edit export bom --supplier jlcpcb
exit 0: wrote outputs/jlcpcb-bom.csv; 0 parts included, 3 excluded for missing MPN
```

The fixture's group name is absent from its newly scaffolded subsystem document. `check` reports that legibility error without making it an exit failure under the existing check contract. No fixture or threshold was edited to hide it. Excluding all three unsourced parts is the expected honest supplier-export result; it is not an orderable BOM or successful hardware qualification.

The optional live `do` net-rename command in the README was not run in this session. It must not be listed as passed. Agent-loop behavior is separately covered by the recorded real-tool integration and the earlier disclosed experimental live create run. That prior create used an isolated initially empty Git repository and a separate 500 mA brief, tighter bounded budgets, supplemental research and an experimental provider; it was not the literal default 100-turn setup command or a fresh official-provider run.

The integration command `node scripts/run-recorded-create-e2e.mjs` was also executed on this review branch: five cases passed, including actual eight-stage completion from blank initialization and the missing-final-response negative control. It is an automated gated replay, not a new manual model inference run.
