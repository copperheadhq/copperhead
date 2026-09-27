// Package e2e contains end-to-end tests for the copperhead CLI.
//
// Bounty: copperheadhq/copperhead#66
// Goal: drive `copperhead create` from a brief through a clean full run and
// emit a findings report. This test is hermetic (no network, no real provider)
// so it is safe to run in CI.
package e2e

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const brief = `# Brief
Build a tiny static site generator that renders markdown to HTML.
`

// buildBinary compiles the copperhead CLI into a temp dir and returns its path.
func buildBinary(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "copperhead")
	cmd := exec.Command("go", "build", "-o", bin, "./cmd/copperhead")
	cmd.Env = os.Environ()
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build failed: %v\n%s", err, out)
	}
	return bin
}

// TestCreateE2E runs `copperhead create` end-to-end against a brief and asserts
// a clean full run.
func TestCreateE2E(t *testing.T) {
	bin := buildBinary(t)

	work := t.TempDir()
	briefPath := filepath.Join(work, "brief.md")
	if err := os.WriteFile(briefPath, []byte(brief), 0o644); err != nil {
		t.Fatalf("write brief: %v", err)
	}

	// Hermetic environment: isolate HOME/config and force an offline/stub mode
	// so the run does not depend on the network or a real provider credential.
	home := t.TempDir()
	cmd := exec.Command(bin, "create", "--brief", briefPath, "--out", filepath.Join(work, "out"))
	cmd.Dir = work
	cmd.Env = append(os.Environ(),
		"HOME="+home,
		"COPPERHEAD_OFFLINE=1",
		"COPPERHEAD_PROVIDER=stub",
	)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	start := time.Now()
	err := cmd.Run()
	elapsed := time.Since(start)

	report := &strings.Builder{}
	report.WriteString("# copperhead create — E2E findings\n\n")
	report.WriteString("Bounty: copperheadhq/copperhead#66\n\n")
	report.WriteString("## Run\n\n")
	report.WriteString("- elapsed: " + elapsed.String() + "\n")
	report.WriteString("- exit error: " + errString(err) + "\n\n")
	report.WriteString("## stdout\n\n```\n" + stdout.String() + "\n```\n\n")
	report.WriteString("## stderr\n\n```\n" + stderr.String() + "\n```\n\n")

	// A "clean full run" means exit code 0 and no error-level log lines.
	if err != nil {
		t.Errorf("create did not exit cleanly: %v\nstderr:\n%s", err, stderr.String())
	}
	if strings.Contains(strings.ToLower(stderr.String()), "error") {
		t.Errorf("stderr contains error-level output:\n%s", stderr.String())
	}

	// The output tree should exist and be non-empty.
	outDir := filepath.Join(work, "out")
	entries, rerr := os.ReadDir(outDir)
	if rerr != nil {
		t.Errorf("expected output dir %s: %v", outDir, rerr)
	} else if len(entries) == 0 {
		t.Errorf("output dir %s is empty", outDir)
	}
	report.WriteString("## Output tree\n\n")
	for _, e := range entries {
		report.WriteString("- " + e.Name() + "\n")
	}

	// Emit the findings report next to the test for reviewers.
	_ = os.WriteFile(filepath.Join(work, "FINDINGS.md"), []byte(report.String()), 0o644)
	t.Logf("findings written to %s", filepath.Join(work, "FINDINGS.md"))
}

func errString(err error) string {
	if err == nil {
		return "<none>"
	}
	return err.Error()
}
