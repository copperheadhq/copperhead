<!-- markdownlint-disable MD034 -->
<!--
Template for GitHub release notes, matching the format used from v0.8.0 onward.
The bare-URL rule is disabled above: release bodies are pasted into GitHub,
which autolinks them, and the generated notes use this exact form.

GitHub does not read this file automatically. Cutting a release is:

    npm version <patch|minor|major> -m "Release v%s"
    git push --follow-tags          # the tag push runs .github/workflows/release.yml

That workflow runs CI and publishes to npm. Write the release notes after it
goes green, so the npm link below resolves.

Let GitHub draft the body from the merged PRs, then edit it:

    gh api repos/copperheadhq/copperhead/releases/generate-notes \
      -f tag_name=v<x.y.z> -f previous_tag_name=v<previous> -q .body > notes.md
    # add the npm line, plus any commit that landed on main without a PR
    gh release create v<x.y.z> --title "v<x.y.z>" --notes-file notes.md

Keep prose em-dash-free (use colons, commas, or parentheses).
Delete the sections that do not apply, including this comment.
-->

## What's Changed

<!-- One bullet per merged PR, in the generated format:

     * <PR title> by @<author> in https://github.com/copperheadhq/copperhead/pull/<n>

     Generation only sees PRs. A change pushed straight to main has no bullet,
     so add it by hand and link the commit instead:

     * <commit subject> by @<author> in https://github.com/copperheadhq/copperhead/commit/<sha>

     Check nothing is missing: git log --oneline v<previous>..v<x.y.z> -->

## New Contributors

<!-- Generated. Delete this section when there are none.

     * @<user> made their first contribution in https://github.com/copperheadhq/copperhead/pull/<n> -->

**npm:** https://www.npmjs.com/package/copperhead/v/<x.y.z>

**Full Changelog**: https://github.com/copperheadhq/copperhead/compare/v<previous>...v<x.y.z>
