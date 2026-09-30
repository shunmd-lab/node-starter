/**
 * Compares the desired GitHub configuration against the live repository.
 * Comparison logic (normalization, diffing) lives in
 * ../lib/github-settings-normalize.ts; this module only fetches and reports.
 */

import {
  checkRequiredSecrets,
  environmentBody,
  normalizeEnvironmentForComparison,
  normalizeRulesetForComparison,
  reportDrift,
  secretNames,
  selectFields,
} from '../lib/github-settings-normalize.ts';
import {
  isNumber,
  isRecord,
  isString,
  isUnknownArray,
} from '../lib/github-settings-schema.ts';
import {
  repositoryFields,
  repositorySecurityFeatures,
  type DesiredConfiguration,
  type EnvironmentSummary,
  type RepositoryReference,
  type RulesetSummary,
} from '../lib/github-settings-types.ts';
import {
  request,
  requestRulesetSummaries,
  requireApiSuccess,
} from './github-api.ts';

async function checkRepositoryDrift(
  reference: RepositoryReference,
  configuration: DesiredConfiguration,
  drifts: string[],
): Promise<void> {
  const response = requireApiSuccess(
    await request(reference, ''),
    'Reading repository settings',
  );
  if (!isRecord(response)) {
    throw new Error('Reading repository settings returned an invalid response');
  }
  reportDrift(
    'repository settings',
    selectFields(configuration.repository, repositoryFields),
    selectFields(response, repositoryFields),
    drifts,
  );
}

/**
 * Each switch reads back differently: vulnerability alerts answer 204 when
 * enabled and 404 when disabled; security updates answer 200 with an
 * `enabled` flag, or 404 while alerts are off. Only declared switches are
 * read, so an undeclared one stays unmanaged like every other setting.
 */
async function readSecurityFeature(
  reference: RepositoryReference,
  field: string,
  path: string,
): Promise<boolean> {
  const response = await request(reference, path);
  if (response.status === 404) {
    return false;
  }
  const body = requireApiSuccess(response, `Reading ${field}`);
  if (response.status === 204) {
    return true;
  }
  if (!isRecord(body) || typeof body['enabled'] !== 'boolean') {
    throw new Error(`Reading ${field} returned an invalid response`);
  }
  return body['enabled'];
}

async function checkSecurityFeatureDrift(
  reference: RepositoryReference,
  configuration: DesiredConfiguration,
  drifts: string[],
): Promise<void> {
  const desired: Record<string, unknown> = {};
  const actual: Record<string, unknown> = {};
  for (const { field, path } of repositorySecurityFeatures) {
    if (configuration.repository[field] === undefined) {
      continue;
    }
    desired[field] = configuration.repository[field];
    actual[field] = await readSecurityFeature(reference, field, path);
  }
  reportDrift('repository security features', desired, actual, drifts);
}

async function checkRulesetDrift(
  reference: RepositoryReference,
  configuration: DesiredConfiguration,
  drifts: string[],
): Promise<void> {
  const { available, summaries: response } = await requestRulesetSummaries(
    reference,
    'Listing repository rulesets',
  );
  if (!available) {
    if (configuration.rulesets.length > 0) {
      drifts.push(
        'rulesets are not available on this repository (requires GitHub Pro/Team/Enterprise for a private repository, or making it public); cannot verify ruleset drift',
      );
    }
    return;
  }
  const summaries: RulesetSummary[] = response.flatMap((summary) =>
    isRecord(summary) && isNumber(summary['id']) && isString(summary['name'])
      ? [{ id: summary['id'], name: summary['name'] }]
      : [],
  );
  for (const desiredRuleset of configuration.rulesets) {
    const name = desiredRuleset['name'];
    if (!isString(name)) {
      continue;
    }
    const summary = summaries.find((candidate) => candidate.name === name);
    if (summary === undefined) {
      drifts.push(`ruleset ${name} is missing`);
      continue;
    }
    const actual = requireApiSuccess(
      await request(reference, `/rulesets/${String(summary.id)}`),
      `Reading ruleset ${name}`,
    );
    if (!isRecord(actual)) {
      throw new Error(`Reading ruleset ${name} returned an invalid response`);
    }
    reportDrift(
      `ruleset ${name}`,
      normalizeRulesetForComparison(desiredRuleset),
      normalizeRulesetForComparison(actual),
      drifts,
    );
  }
}

async function checkEnvironmentDrift(
  reference: RepositoryReference,
  configuration: DesiredConfiguration,
  drifts: string[],
): Promise<void> {
  const response = requireApiSuccess(
    await request(reference, '/environments?per_page=100'),
    'Listing repository environments',
  );
  if (!isRecord(response) || !isUnknownArray(response['environments'])) {
    throw new Error(
      'Listing repository environments returned an invalid response',
    );
  }
  const summaries: EnvironmentSummary[] = response['environments'].flatMap(
    (environment) =>
      isRecord(environment) && isString(environment['name'])
        ? [{ name: environment['name'] }]
        : [],
  );
  for (const desiredEnvironment of configuration.environments) {
    const name = desiredEnvironment['environment'];
    if (!isString(name)) {
      continue;
    }
    if (!summaries.some((candidate) => candidate.name === name)) {
      drifts.push(`environment ${name} is missing`);
      continue;
    }
    const actual = requireApiSuccess(
      await request(reference, `/environments/${encodeURIComponent(name)}`),
      `Reading environment ${name}`,
    );
    if (!isRecord(actual)) {
      throw new Error(
        `Reading environment ${name} returned an invalid response`,
      );
    }
    reportDrift(
      `environment ${name}`,
      normalizeEnvironmentForComparison(environmentBody(desiredEnvironment)),
      normalizeEnvironmentForComparison(actual),
      drifts,
    );
  }
}

async function checkSecretDrift(
  reference: RepositoryReference,
  configuration: DesiredConfiguration,
  drifts: string[],
): Promise<void> {
  const repositoryNames = secretNames(
    requireApiSuccess(
      await request(reference, '/actions/secrets?per_page=100'),
      'Listing repository secrets',
    ),
  );
  checkRequiredSecrets(
    'repository',
    configuration.secrets.repository,
    repositoryNames,
    drifts,
  );
  for (const [environment, entries] of Object.entries(
    configuration.secrets.environments,
  )) {
    const names = secretNames(
      requireApiSuccess(
        await request(
          reference,
          `/environments/${encodeURIComponent(environment)}/secrets?per_page=100`,
        ),
        `Listing secrets for environment ${environment}`,
      ),
    );
    checkRequiredSecrets(`environment ${environment}`, entries, names, drifts);
  }
}

async function checkRemote(
  reference: RepositoryReference,
  configuration: DesiredConfiguration,
): Promise<string[]> {
  const drifts: string[] = [];
  await checkRepositoryDrift(reference, configuration, drifts);
  await checkSecurityFeatureDrift(reference, configuration, drifts);
  await checkRulesetDrift(reference, configuration, drifts);
  await checkEnvironmentDrift(reference, configuration, drifts);
  await checkSecretDrift(reference, configuration, drifts);
  return drifts;
}

export async function runRemoteCheck(
  reference: RepositoryReference,
  configuration: DesiredConfiguration,
): Promise<void> {
  const drifts = await checkRemote(reference, configuration);
  if (drifts.length > 0) {
    throw new Error(
      `GitHub settings drift detected for ${reference.owner}/${reference.name}:\n- ${drifts.join('\n- ')}`,
    );
  }
  console.log(
    `GitHub settings match desired state for ${reference.owner}/${reference.name}.`,
  );
}
