/**
 * Pushes the desired configuration to GitHub. Restricted to the protected
 * `workflow_dispatch` apply job on `main` or an explicit local opt-in --
 * never a normal pull request, since that would be the bypass ADR 0008
 * removes. See docs/decisions/0008-no-required-human-approval-solo-repo.md.
 */

import {
  environmentBody,
  selectFields,
} from '../lib/github-settings-normalize.ts';
import { isNumber, isRecord, isString } from '../lib/github-settings-schema.ts';
import {
  repositoryFields,
  repositorySecurityFeatures,
  type DesiredConfiguration,
  type RepositoryReference,
} from '../lib/github-settings-types.ts';
import { getStringEnvironmentVariable } from './env.ts';
import {
  request,
  requestRulesetSummaries,
  requireApiSuccess,
} from './github-api.ts';

export function assertApplyIsAuthorized(): void {
  const isProtectedWorkflow =
    getStringEnvironmentVariable('GITHUB_ACTIONS') === 'true' &&
    getStringEnvironmentVariable('GITHUB_EVENT_NAME') === 'workflow_dispatch' &&
    getStringEnvironmentVariable('GITHUB_REF') === 'refs/heads/main';
  if (
    !isProtectedWorkflow &&
    getStringEnvironmentVariable('ALLOW_GITHUB_SETTINGS_APPLY') !== '1'
  ) {
    throw new Error(
      'Apply is restricted to workflow_dispatch on main or ALLOW_GITHUB_SETTINGS_APPLY=1',
    );
  }
}

/**
 * Security updates depend on vulnerability alerts, so switches are enabled in
 * dependency order and disabled in reverse. Undeclared switches are left as
 * they are.
 */
async function applySecurityFeatures(
  reference: RepositoryReference,
  configuration: DesiredConfiguration,
): Promise<void> {
  const declared = repositorySecurityFeatures.filter(
    ({ field }) => typeof configuration.repository[field] === 'boolean',
  );
  const enablingAlerts =
    configuration.repository['vulnerability_alerts'] !== false;
  const ordered = enablingAlerts ? declared : [...declared].reverse();
  for (const { field, path } of ordered) {
    const enabled = configuration.repository[field] === true;
    requireApiSuccess(
      await request(reference, path, enabled ? 'PUT' : 'DELETE'),
      `Applying ${field}`,
    );
    console.log(`${enabled ? 'Enabled' : 'Disabled'} ${field}.`);
  }
}

async function applyRulesets(
  reference: RepositoryReference,
  configuration: DesiredConfiguration,
): Promise<void> {
  const { available, summaries: rulesetSummariesResponse } =
    await requestRulesetSummaries(
      reference,
      'Listing repository rulesets before apply',
    );
  if (!available) {
    console.warn(
      'Rulesets are not available on this repository (requires GitHub Pro/Team/Enterprise for a private repository, or making it public). Skipping ruleset apply.',
    );
    return;
  }
  for (const desiredRuleset of configuration.rulesets) {
    const name = desiredRuleset['name'];
    if (!isString(name)) {
      continue;
    }
    const existing = rulesetSummariesResponse.find(
      (candidate) =>
        isRecord(candidate) &&
        candidate['name'] === name &&
        isNumber(candidate['id']),
    );
    if (isRecord(existing) && isNumber(existing['id'])) {
      requireApiSuccess(
        await request(
          reference,
          `/rulesets/${String(existing['id'])}`,
          'PUT',
          desiredRuleset,
        ),
        `Updating ruleset ${name}`,
      );
      console.log(`Updated ruleset ${name}.`);
    } else {
      requireApiSuccess(
        await request(reference, '/rulesets', 'POST', desiredRuleset),
        `Creating ruleset ${name}`,
      );
      console.log(`Created ruleset ${name}.`);
    }
  }
}

async function applyEnvironments(
  reference: RepositoryReference,
  configuration: DesiredConfiguration,
): Promise<void> {
  for (const desiredEnvironment of configuration.environments) {
    const name = desiredEnvironment['environment'];
    if (!isString(name)) {
      continue;
    }
    requireApiSuccess(
      await request(
        reference,
        `/environments/${encodeURIComponent(name)}`,
        'PUT',
        environmentBody(desiredEnvironment),
      ),
      `Applying environment ${name}`,
    );
    console.log(`Applied environment ${name}.`);
  }
}

export async function applyConfiguration(
  reference: RepositoryReference,
  configuration: DesiredConfiguration,
): Promise<void> {
  requireApiSuccess(
    await request(
      reference,
      '',
      'PATCH',
      selectFields(configuration.repository, repositoryFields),
    ),
    'Applying repository settings',
  );
  console.log('Applied repository settings.');

  await applySecurityFeatures(reference, configuration);

  await applyRulesets(reference, configuration);
  await applyEnvironments(reference, configuration);
  console.log('Secret values were not read or changed.');
}
