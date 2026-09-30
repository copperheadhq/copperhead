# add-pattern-expansion-helper: Tasks

- [ ] 1. OpenSpec change specification and validation <!-- id: 1 -->
- [ ] 2. Implement `src/kicad/draft/patternExpand.ts` <!-- id: 2 -->
  - [ ] 2.1 Pattern file loader with path resolution and caching <!-- id: 2.1 -->
  - [ ] 2.2 Reference renumbering and net pin rewrite logic <!-- id: 2.2 -->
  - [ ] 2.3 Parameter validation and descriptive error reporting <!-- id: 2.3 -->
- [ ] 3. Unit tests in `test/pattern-expand.test.ts` <!-- id: 3 -->
  - [ ] 3.1 Test expansion of all standard patterns (regulator, usb-c, crystal) <!-- id: 3.1 -->
  - [ ] 3.2 Test prefix, instanceId, and group override options <!-- id: 3.2 -->
  - [ ] 3.3 Verify expanded output passes `validateIntent()` when wrapped <!-- id: 3.3 -->
  - [ ] 3.4 Test error conditions (unknown pattern, missing files, bad inputs) <!-- id: 3.4 -->
- [ ] 4. Build, typecheck, and full test suite verification <!-- id: 4 -->
