## Decisions

### D1. The bundle is the whole context

The model sees only the bundles block-map emits for the parts in question, and the role guide. It
cannot name a part outside them: the parser drops it, and block-map would refuse it.

### D2. Drop, then verify

The parser drops unknown kinds and roles, parts outside the bundle and DNP parts, and counts what it
dropped in the file's header; block-map then checks every remaining part against its role's nets. Two
gates, neither trusting the model.

### D3. One call per design

All the parts of one design go in one prompt, so the model can tell a regulator's input capacitors from
a neighbouring regulator's output capacitors on a shared rail.
