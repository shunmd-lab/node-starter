/**
 * Structural validation for repository-settings.json and rulesets/*.json:
 * type guards plus the `validate*` functions that walk the JSON and collect
 * problems into an `errors` array, the same shape ../workflow-policy.ts uses.
 */

import {
  parameterlessRuleTypes,
  pullRequestRuleFields,
  repositoryBooleanFields,
  repositoryFields,
  repositorySecurityFeatures,
  repositoryStringFields,
  requiredStatusChecksParameterFields,
  rulesetRuleTypes,
  type JsonObject,
} from './github-settings-types.ts';

export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export function isNumber(value: unknown): value is number {
  // Stryker disable next-line ConditionalExpression,LogicalOperator: every
  // caller pairs this with Number.isInteger, which is already false for any
  // non-finite or non-number value, so a weaker isNumber here is masked.
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return isUnknownArray(value) && value.every(isString);
}

export function readRequiredString(
  object: JsonObject,
  key: string,
  context: string,
  errors: string[],
): string | undefined {
  const value = object[key];
  if (!isString(value) || value.length === 0) {
    errors.push(`${context}.${key} must be a non-empty string`);
    return undefined;
  }
  return value;
}

export function assertAllowedKeys(
  object: JsonObject,
  allowed: ReadonlySet<string>,
  context: string,
  errors: string[],
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      errors.push(`${context}.${key} is not supported`);
    }
  }
}

export function validateRepository(
  value: unknown,
  errors: string[],
): JsonObject | undefined {
  if (!isRecord(value)) {
    errors.push('repository-settings.json must contain a JSON object');
    return undefined;
  }

  assertAllowedKeys(
    value,
    new Set([
      ...repositoryFields,
      ...repositorySecurityFeatures.map(({ field }) => field),
    ]),
    'repository-settings.json',
    errors,
  );

  for (const field of repositoryFields) {
    const fieldValue = value[field];
    if (fieldValue === undefined) {
      errors.push(`repository-settings.json.${field} is required`);
      continue;
    }
    if (repositoryBooleanFields.has(field) && !isBoolean(fieldValue)) {
      errors.push(`repository-settings.json.${field} must be a boolean`);
    }
    if (repositoryStringFields.has(field) && !isString(fieldValue)) {
      errors.push(`repository-settings.json.${field} must be a string`);
    }
  }

  for (const { field } of repositorySecurityFeatures) {
    if (!isBoolean(value[field])) {
      errors.push(`repository-settings.json.${field} must be a boolean`);
    }
  }

  return value;
}

function validateRulesetConditions(
  value: JsonObject,
  path: string,
  errors: string[],
): void {
  const conditions = value['conditions'];
  if (!isRecord(conditions)) {
    errors.push(`${path}.conditions must be an object`);
    return;
  }
  const refName = conditions['ref_name'];
  if (!isRecord(refName)) {
    errors.push(`${path}.conditions.ref_name must be an object`);
    return;
  }
  if (
    !isStringArray(refName['include']) ||
    !isStringArray(refName['exclude'])
  ) {
    errors.push(
      `${path}.conditions.ref_name include and exclude must be string arrays`,
    );
  }
}

function validatePullRequestRule(
  rule: JsonObject,
  path: string,
  errors: string[],
): void {
  const parameters = rule['parameters'];
  if (!isRecord(parameters)) {
    errors.push(`${path}.parameters must be an object`);
    return;
  }
  assertAllowedKeys(
    parameters,
    new Set(pullRequestRuleFields),
    `${path}.parameters`,
    errors,
  );
  for (const field of pullRequestRuleFields) {
    const value = parameters[field];
    if (field === 'required_approving_review_count') {
      if (
        !isNumber(value) ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > 6
      ) {
        errors.push(
          `${path}.parameters.${field} must be an integer from 0 to 6`,
        );
      }
    } else if (!isBoolean(value)) {
      errors.push(`${path}.parameters.${field} must be a boolean`);
    }
  }
}

function validateRequiredStatusCheck(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  assertAllowedKeys(
    value,
    new Set(['context', 'integration_id']),
    path,
    errors,
  );
  readRequiredString(value, 'context', path, errors);
  const integrationId = value['integration_id'];
  if (
    integrationId !== undefined &&
    (!isNumber(integrationId) || !Number.isInteger(integrationId))
  ) {
    errors.push(`${path}.integration_id must be an integer when present`);
  }
}

function validateRequiredStatusChecksRule(
  rule: JsonObject,
  path: string,
  errors: string[],
): void {
  const parameters = rule['parameters'];
  if (!isRecord(parameters)) {
    errors.push(`${path}.parameters must be an object`);
    return;
  }
  assertAllowedKeys(
    parameters,
    new Set(requiredStatusChecksParameterFields),
    `${path}.parameters`,
    errors,
  );
  for (const field of requiredStatusChecksParameterFields) {
    const value = parameters[field];
    if (field !== 'required_status_checks' && !isBoolean(value)) {
      errors.push(`${path}.parameters.${field} must be a boolean`);
    }
  }
  const statusChecks = parameters['required_status_checks'];
  if (!isUnknownArray(statusChecks) || statusChecks.length === 0) {
    errors.push(
      `${path}.parameters.required_status_checks must be a non-empty array`,
    );
    return;
  }
  for (const [index, statusCheck] of statusChecks.entries()) {
    validateRequiredStatusCheck(
      statusCheck,
      `${path}.parameters.required_status_checks[${String(index)}]`,
      errors,
    );
  }
}

function validateRulesetRule(
  rule: unknown,
  path: string,
  errors: string[],
): void {
  if (
    !isRecord(rule) ||
    !isString(rule['type']) ||
    !rulesetRuleTypes.has(rule['type'])
  ) {
    errors.push(`${path} has an unsupported type`);
    return;
  }
  if (parameterlessRuleTypes.has(rule['type'])) {
    assertAllowedKeys(rule, new Set(['type']), path, errors);
    return;
  }
  if (rule['type'] === 'pull_request') {
    validatePullRequestRule(rule, path, errors);
    return;
  }
  validateRequiredStatusChecksRule(rule, path, errors);
}

function validateRulesetRules(
  value: JsonObject,
  path: string,
  errors: string[],
): void {
  const rules = value['rules'];
  if (!isUnknownArray(rules) || rules.length === 0) {
    errors.push(`${path}.rules must be a non-empty array`);
    return;
  }
  for (const [index, rule] of rules.entries()) {
    validateRulesetRule(rule, `${path}.rules[${String(index)}]`, errors);
  }
}

export function validateRuleset(
  value: unknown,
  path: string,
  errors: string[],
): JsonObject | undefined {
  if (!isRecord(value)) {
    errors.push(`${path} must contain a JSON object`);
    return undefined;
  }

  assertAllowedKeys(
    value,
    new Set([
      'name',
      'target',
      'enforcement',
      'bypass_actors',
      'conditions',
      'rules',
    ]),
    path,
    errors,
  );
  const name = readRequiredString(value, 'name', path, errors);
  const target = readRequiredString(value, 'target', path, errors);
  const enforcement = readRequiredString(value, 'enforcement', path, errors);
  if (target !== undefined && !new Set(['branch', 'tag', 'push']).has(target)) {
    errors.push(`${path}.target must be branch, tag, or push`);
  }
  if (
    enforcement !== undefined &&
    !new Set(['active', 'disabled', 'evaluate']).has(enforcement)
  ) {
    errors.push(`${path}.enforcement must be active, disabled, or evaluate`);
  }

  if (!isUnknownArray(value['bypass_actors'])) {
    errors.push(`${path}['bypass_actors'] must be an array`);
  }
  validateRulesetConditions(value, path, errors);
  validateRulesetRules(value, path, errors);

  return name === undefined ? undefined : value;
}
