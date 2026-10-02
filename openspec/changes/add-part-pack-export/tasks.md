## 1. Drafting

- [x] 1.1 `core/fields.ts`: `PACK_FIELD_SPECS`.
- [x] 1.2 `core/pack.ts`: parameter mapping, units, one fact per row, sibling variants, notes (design D1 to D3).
- [x] 1.3 `scripts/pack.ts`.
- [x] 1.4 Tests in `test/pack.test.ts`: mapping and units, a drafted row with a held reading, sibling variants.

## 2. Confirmation

- [x] 2.1 `core/pack.ts` `verifyQuotes`; `scripts/confirm-pack.ts` (design D4).
- [x] 2.2 Tests in `test/pack.test.ts`: a quote found after normalisation, one not on its page, a page not in the document.

## 3. Verification

- [x] 3.1 `npm run typecheck`, `npm test`; a live draft of the AP63205 checked against a hand-written pack, confirmed, refused with one quote altered, and accepted by copperhead-tools' pack validator.
