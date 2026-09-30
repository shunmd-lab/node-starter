# GitHub infrastructure

The JSON files in this directory are the desired state for repository-level
GitHub settings. `scripts/github-settings.ts` validates the files and can
compare or apply the settings through the GitHub REST API.

```sh
node scripts/github-settings.ts --check
node scripts/github-settings.ts --check --remote
```

`check` is local and does not need credentials. `drift` reads the repository
from `GITHUB_REPOSITORY` or the `origin` remote and compares managed settings,
rulesets, environments, and required secret names with GitHub. Secret values
are never read or written.

Mutation is deliberately restricted to an explicit local opt-in or the
protected `workflow_dispatch` run on `main`:

```sh
ALLOW_GITHUB_SETTINGS_APPLY=1 \
GH_TOKEN="$(gh auth token)" \
node scripts/github-settings.ts --apply
```

The local command obtains the GitHub API token from the authenticated `gh`
account. That token must have the repository administration and secret metadata
read permissions required by the GitHub API.

`vulnerability_alerts` and `automated_security_fixes` in
`repository-settings.json` are Dependabot switches rather than repository
fields: the script sets them through their own endpoints and checks them for
drift the same way. Security updates open fix pull requests for vulnerable
transitive dependencies, which the version updates in
`.github/dependabot.yml` do not cover, so a newly published advisory arrives
as a pull request instead of only as a red scheduled `check:deps`. The
dependency-policy gate itself is unchanged.

The required `GH_ADMIN_TOKEN` secret is used by drift checks and the apply
workflow. It must have the repository administration and secret metadata read
permissions required by the GitHub API. The `production` reviewer list is
empty until concrete GitHub user or team IDs are selected; no reviewer is
inferred from a repository login.

The template's `main` ruleset does not require an approving review, code-owner
review, or approval after the last push, and grants no bypass actor. It still
requires the `check`, `mutation` and `github-settings` status checks and
review-thread resolution. This is a solo-repository policy, not a default to
be relaxed later without thought; see
[ADR 0008](../../docs/decisions/0008-no-required-human-approval-solo-repo.md)
for the reasoning and the conditions under which it should change. The script
manages only named rulesets and environments. It does not delete unmanaged
GitHub settings, rulesets, environments, or secrets.
