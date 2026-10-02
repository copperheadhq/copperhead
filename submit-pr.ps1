# Setup git identity
git config user.email "bot@example.com"
git config user.name "Bounty Bot"

# Create a branch and commit the changes
git checkout -b fix/bounty-66
git add src/commands/create.ts test/create-e2e.test.ts findings.md
git commit -m "fix: Pipeline blocks and false-greens for Bounty #66"

# Create the PR (assuming gh is installed and authenticated)
gh pr create --title "Fix: Bounty #66 Pipeline Blockers and False-Greens" --body-file findings.md
