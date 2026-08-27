import { defineConfig } from 'vitest/config';

const isWin = process.platform === 'win32';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // 60s is enough for any single test in isolation, but under a full `npm
    // test` run vitest's parallel worker processes contend for CPU/IO, and
    // tests that finish in well under a second alone (kicad-cli subprocess
    // calls, filesystem-heavy repl session-log tests) can cross 60s under
    // that contention. 180s gives headroom without hiding a genuine hang; a
    // few individually slower tests (e.g. double kicad-cli calls) still set
    // their own higher per-test timeout on top of this.
    testTimeout: 180_000,
    // CI (ubuntu-latest) never runs Windows, so this only affects local runs:
    // Windows process-spawn overhead is inherently higher than POSIX, and it
    // was severe enough here that even the 180s bump above wasn't reliably
    // sufficient for the worst-contended files under full parallelism (a test
    // that took 211ms in isolation still timed out at 180s in the full run).
    // Serializing file execution on Windows trades wall-clock speed for
    // actually deterministic results, which is the whole point of this
    // config on the one platform where contention made timeouts unreliable.
    fileParallelism: !isWin,
  },
});
