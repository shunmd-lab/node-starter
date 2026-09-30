/**
 * Shared types and field lists for the `infra/github/` desired-state schema.
 * No logic lives here so every other github-settings-*.ts module can import
 * from it without risking a cycle.
 */

export type JsonObject = Record<string, unknown>;

export interface RepositoryReference {
  readonly owner: string;
  readonly name: string;
}

export interface RulesetSummary {
  readonly id: number;
  readonly name: string;
}

export interface EnvironmentSummary {
  readonly name: string;
}

export interface SecretManifestEntry {
  readonly name: string;
  readonly required: boolean;
}

export interface SecretManifest {
  readonly repository: readonly SecretManifestEntry[];
  readonly environments: Readonly<
    Record<string, readonly SecretManifestEntry[]>
  >;
}

export interface DesiredConfiguration {
  readonly repository: JsonObject;
  readonly rulesets: readonly JsonObject[];
  readonly environments: readonly JsonObject[];
  readonly secrets: SecretManifest;
}

export interface JsonDocument {
  readonly path: string;
  readonly value: unknown;
}

export const repositoryFields = [
  'default_branch',
  'has_issues',
  'has_projects',
  'has_wiki',
  'allow_squash_merge',
  'allow_merge_commit',
  'allow_rebase_merge',
  'allow_auto_merge',
  'delete_branch_on_merge',
  'use_squash_pr_title_as_default',
  'squash_merge_commit_title',
  'squash_merge_commit_message',
] as const;

/**
 * Dependabot switches declared alongside the repository fields but managed
 * through their own endpoints: `PATCH /repos` does not accept them and
 * `GET /repos` does not report them. Security updates open fix pull requests
 * for vulnerable transitive dependencies, which the weekly version-update
 * schedule in .github/dependabot.yml never touches, so a new advisory stops
 * turning the scheduled `check:deps` red until someone upgrades by hand.
 * Listed in dependency order: security updates require vulnerability alerts.
 */
export const repositorySecurityFeatures = [
  { field: 'vulnerability_alerts', path: '/vulnerability-alerts' },
  { field: 'automated_security_fixes', path: '/automated-security-fixes' },
] as const;

export const repositoryBooleanFields = new Set([
  'has_issues',
  'has_projects',
  'has_wiki',
  'allow_squash_merge',
  'allow_merge_commit',
  'allow_rebase_merge',
  'allow_auto_merge',
  'delete_branch_on_merge',
  'use_squash_pr_title_as_default',
]);

export const repositoryStringFields = new Set([
  'default_branch',
  'squash_merge_commit_title',
  'squash_merge_commit_message',
]);

export const rulesetRuleTypes = new Set([
  'deletion',
  'non_fast_forward',
  'required_linear_history',
  'pull_request',
  'required_status_checks',
]);

/** Ruleset rules that are switches: present means enforced, no parameters. */
export const parameterlessRuleTypes = new Set([
  'deletion',
  'non_fast_forward',
  'required_linear_history',
]);

export const pullRequestRuleFields = [
  'dismiss_stale_reviews_on_push',
  'require_code_owner_review',
  'require_last_push_approval',
  'required_approving_review_count',
  'required_review_thread_resolution',
] as const;

export const requiredStatusChecksParameterFields = [
  'do_not_enforce_on_create',
  'required_status_checks',
  'strict_required_status_checks_policy',
] as const;

/**
 * Status checks the `main` ruleset must require. `github-settings` joined
 * `check` and `mutation` once the tool that declares this policy became a
 * required gate itself instead of an informational PR-time job -- see
 * docs/decisions/0008-no-required-human-approval-solo-repo.md.
 */
export const requiredMainStatusChecks = [
  'check',
  'mutation',
  'github-settings',
] as const;

/**
 * The exact command a required-check job must run, keyed by job name, so a
 * job existing under the right name with the wrong command still fails.
 */
export const ciWorkflowJobCommands: Readonly<Record<string, string>> = {
  'github-settings': 'node scripts/github-settings.ts --check',
};
