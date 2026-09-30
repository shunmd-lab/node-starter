import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type * as Yaml from 'yaml';

vi.mock('yaml', async (importOriginal) => {
  const actual = await importOriginal<typeof Yaml>();
  return { ...actual, parse: vi.fn(actual.parse) };
});

import {
  validateConfigurationValues,
  validateMainRulesetApprovalPolicy,
} from './github-settings-approval-policy.ts';
import { validateCiWorkflowContract } from './github-settings-ci-contract.ts';
import {
  validateEnvironment,
  validateSecrets,
} from './github-settings-environment.ts';
import {
  checkRequiredSecrets,
  comparableJson,
  environmentBody,
  normalizeEnvironmentForComparison,
  normalizeRulesetForComparison,
  parseRepositoryReference,
  reportDrift,
  secretNames,
  selectFields,
  sortJson,
} from './github-settings-normalize.ts';
import {
  validateRepository,
  validateRuleset,
} from './github-settings-schema.ts';
import {
  repositoryBooleanFields,
  repositorySecurityFeatures,
  repositoryStringFields,
  type JsonObject,
} from './github-settings-types.ts';

/** A repository-settings.json that satisfies every field. */
function compliantRepository(): JsonObject {
  return {
    default_branch: 'main',
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    allow_auto_merge: false,
    delete_branch_on_merge: true,
    use_squash_pr_title_as_default: true,
    squash_merge_commit_title: 'PR_TITLE',
    squash_merge_commit_message: 'PR_BODY',
    vulnerability_alerts: true,
    automated_security_fixes: true,
  };
}

/** rulesets/main.json as it must read once ADR 0008 applies. */
function compliantMainRuleset(): JsonObject {
  return {
    name: 'main',
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'required_linear_history' },
      {
        type: 'pull_request',
        parameters: {
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: true,
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          do_not_enforce_on_create: false,
          required_status_checks: [
            { context: 'check' },
            { context: 'mutation' },
            { context: 'github-settings' },
          ],
          strict_required_status_checks_policy: true,
        },
      },
    ],
  };
}

function compliantProductionEnvironment(): JsonObject {
  return {
    environment: 'production',
    wait_timer: 0,
    prevent_self_review: true,
    reviewers: [],
    deployment_branch_policy: {
      protected_branches: true,
      custom_branch_policies: false,
    },
  };
}

function compliantSecrets(): JsonObject {
  return { repository: [], environments: {} };
}

function compliantCiWorkflow(): string {
  return `
jobs:
  check:
    steps:
      - run: pnpm verify
  mutation:
    steps:
      - run: pnpm test:mutation
  github-settings:
    steps:
      - run: node scripts/github-settings.ts --check
`;
}

describe('validateRepository', () => {
  it('accepts a fully specified repository', () => {
    const errors: string[] = [];
    expect(validateRepository(compliantRepository(), errors)).toBeDefined();
    expect(errors).toStrictEqual([]);
  });

  it('rejects a missing required field', () => {
    const value = compliantRepository();
    delete value['has_wiki'];
    const errors: string[] = [];
    validateRepository(value, errors);
    expect(errors).toStrictEqual([
      expect.stringContaining('has_wiki is required'),
    ]);
  });

  it('rejects a field of the wrong type', () => {
    const value = { ...compliantRepository(), has_issues: 'yes' };
    const errors: string[] = [];
    validateRepository(value, errors);
    expect(errors).toStrictEqual([
      expect.stringContaining('has_issues must be a boolean'),
    ]);
  });

  it('rejects an unsupported key', () => {
    const value = { ...compliantRepository(), private: true };
    const errors: string[] = [];
    validateRepository(value, errors);
    expect(errors).toStrictEqual([
      'repository-settings.json.private is not supported',
    ]);
  });

  it('rejects a non-object value', () => {
    const errors: string[] = [];
    expect(validateRepository([], errors)).toBeUndefined();
    expect(errors).toStrictEqual([
      expect.stringContaining('must contain a JSON object'),
    ]);
  });

  it('rejects null without crashing', () => {
    const errors: string[] = [];
    let result: JsonObject | undefined;
    expect(() => {
      result = validateRepository(null, errors);
    }).not.toThrow();
    expect(result).toBeUndefined();
    expect(errors).toStrictEqual([
      'repository-settings.json must contain a JSON object',
    ]);
  });

  it('rejects a string field of the wrong type', () => {
    const value = { ...compliantRepository(), default_branch: 1 };
    const errors: string[] = [];
    validateRepository(value, errors);
    expect(errors).toStrictEqual([
      expect.stringContaining('default_branch must be a string'),
    ]);
  });

  it.each([...repositoryBooleanFields])(
    'rejects %s when it is not a boolean',
    (field) => {
      const value = { ...compliantRepository(), [field]: 'nope' };
      const errors: string[] = [];
      validateRepository(value, errors);
      expect(errors).toStrictEqual([
        `repository-settings.json.${field} must be a boolean`,
      ]);
    },
  );

  it.each(repositorySecurityFeatures.map(({ field }) => field))(
    'requires the %s switch as a boolean',
    (field) => {
      const missing = Object.fromEntries(
        Object.entries(compliantRepository()).filter(([key]) => key !== field),
      );
      const errors: string[] = [];
      validateRepository(missing, errors);
      validateRepository({ ...compliantRepository(), [field]: 'on' }, errors);
      expect(errors).toStrictEqual([
        `repository-settings.json.${field} must be a boolean`,
        `repository-settings.json.${field} must be a boolean`,
      ]);
    },
  );

  it.each([...repositoryStringFields])(
    'rejects %s when it is not a string',
    (field) => {
      const value = { ...compliantRepository(), [field]: 1 };
      const errors: string[] = [];
      validateRepository(value, errors);
      expect(errors).toStrictEqual([
        `repository-settings.json.${field} must be a string`,
      ]);
    },
  );
});

describe('validateRuleset', () => {
  it('accepts a compliant main ruleset', () => {
    const errors: string[] = [];
    expect(
      validateRuleset(compliantMainRuleset(), 'rulesets/main.json', errors),
    ).toBeDefined();
    expect(errors).toStrictEqual([]);
  });

  it('rejects an unsupported target', () => {
    const ruleset = { ...compliantMainRuleset(), target: 'commit' };
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      'rulesets/main.json.target must be branch, tag, or push',
    );
  });

  it.each(['tag', 'push'])('accepts %s as a valid target', (target) => {
    const ruleset = { ...compliantMainRuleset(), target };
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toStrictEqual([]);
  });

  it.each(['disabled', 'evaluate'])(
    'accepts %s as a valid enforcement',
    (enforcement) => {
      const ruleset = { ...compliantMainRuleset(), enforcement };
      const errors: string[] = [];
      validateRuleset(ruleset, 'rulesets/main.json', errors);
      expect(errors).toStrictEqual([]);
    },
  );

  it('rejects an unsupported enforcement', () => {
    const ruleset = { ...compliantMainRuleset(), enforcement: 'sometimes' };
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      'rulesets/main.json.enforcement must be active, disabled, or evaluate',
    );
  });

  it('rejects a pull_request rule missing a parameter', () => {
    const ruleset = compliantMainRuleset();
    const rules = ruleset['rules'] as JsonObject[];
    const pullRequestRule = rules.find(
      (rule) => rule['type'] === 'pull_request',
    )!;
    delete (pullRequestRule['parameters'] as JsonObject)[
      'require_code_owner_review'
    ];
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      expect.stringContaining(
        'parameters.require_code_owner_review must be a boolean',
      ),
    );
  });

  it('rejects an empty required_status_checks array', () => {
    const ruleset = compliantMainRuleset();
    const rules = ruleset['rules'] as JsonObject[];
    const statusChecksRule = rules.find(
      (rule) => rule['type'] === 'required_status_checks',
    )!;
    (statusChecksRule['parameters'] as JsonObject)['required_status_checks'] =
      [];
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      'rulesets/main.json.rules[4].parameters.required_status_checks must be a non-empty array',
    );
  });

  it('rejects a rules value that is not an array', () => {
    const ruleset = { ...compliantMainRuleset(), rules: 'none' };
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      'rulesets/main.json.rules must be a non-empty array',
    );
  });

  it('rejects an empty rules array', () => {
    const ruleset = { ...compliantMainRuleset(), rules: [] };
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      'rulesets/main.json.rules must be a non-empty array',
    );
  });

  it('reports only the missing-target error when target is absent', () => {
    const ruleset = compliantMainRuleset();
    delete ruleset['target'];
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toStrictEqual([
      'rulesets/main.json.target must be a non-empty string',
    ]);
  });

  it('reports only the missing-enforcement error when enforcement is absent', () => {
    const ruleset = compliantMainRuleset();
    delete ruleset['enforcement'];
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toStrictEqual([
      'rulesets/main.json.enforcement must be a non-empty string',
    ]);
  });

  it('rejects an unsupported pull_request parameter key', () => {
    const ruleset = compliantMainRuleset();
    const rules = ruleset['rules'] as JsonObject[];
    const pullRequestRule = rules.find(
      (rule) => rule['type'] === 'pull_request',
    )!;
    (pullRequestRule['parameters'] as JsonObject)['unexpected'] = true;
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      'rulesets/main.json.rules[3].parameters.unexpected is not supported',
    );
  });

  it('rejects an unsupported required_status_checks parameter key', () => {
    const ruleset = compliantMainRuleset();
    const rules = ruleset['rules'] as JsonObject[];
    const statusChecksRule = rules.find(
      (rule) => rule['type'] === 'required_status_checks',
    )!;
    (statusChecksRule['parameters'] as JsonObject)['unexpected'] = true;
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      'rulesets/main.json.rules[4].parameters.unexpected is not supported',
    );
  });

  it('rejects malformed conditions', () => {
    const ruleset = { ...compliantMainRuleset(), conditions: { ref_name: {} } };
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      'rulesets/main.json.conditions.ref_name include and exclude must be string arrays',
    );
  });

  it('rejects a ref_name with a valid include but a malformed exclude', () => {
    const ruleset = {
      ...compliantMainRuleset(),
      conditions: {
        ref_name: { include: ['refs/heads/main'], exclude: 'none' },
      },
    };
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      'rulesets/main.json.conditions.ref_name include and exclude must be string arrays',
    );
  });

  it('rejects a conditions value that is not an object', () => {
    const ruleset = { ...compliantMainRuleset(), conditions: 'always' };
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      'rulesets/main.json.conditions must be an object',
    );
  });

  it('rejects a ref_name that is not an object', () => {
    const ruleset = {
      ...compliantMainRuleset(),
      conditions: { ref_name: 'main' },
    };
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      'rulesets/main.json.conditions.ref_name must be an object',
    );
  });

  it('rejects a pull_request rule with no parameters object', () => {
    const ruleset = compliantMainRuleset();
    const rules = ruleset['rules'] as JsonObject[];
    const pullRequestRule = rules.find(
      (rule) => rule['type'] === 'pull_request',
    )!;
    delete pullRequestRule['parameters'];
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      'rulesets/main.json.rules[3].parameters must be an object',
    );
  });

  it.each([-1, 3.5, 7])(
    'rejects %s as an out-of-range or non-integer required_approving_review_count',
    (count) => {
      const ruleset = compliantMainRuleset();
      const rules = ruleset['rules'] as JsonObject[];
      const pullRequestRule = rules.find(
        (rule) => rule['type'] === 'pull_request',
      )!;
      (pullRequestRule['parameters'] as JsonObject)[
        'required_approving_review_count'
      ] = count;
      const errors: string[] = [];
      validateRuleset(ruleset, 'rulesets/main.json', errors);
      expect(errors).toStrictEqual([
        'rulesets/main.json.rules[3].parameters.required_approving_review_count must be an integer from 0 to 6',
      ]);
    },
  );

  it.each([0, 6])(
    'accepts %s as a valid required_approving_review_count',
    (count) => {
      const ruleset = compliantMainRuleset();
      const rules = ruleset['rules'] as JsonObject[];
      const pullRequestRule = rules.find(
        (rule) => rule['type'] === 'pull_request',
      )!;
      (pullRequestRule['parameters'] as JsonObject)[
        'required_approving_review_count'
      ] = count;
      const errors: string[] = [];
      validateRuleset(ruleset, 'rulesets/main.json', errors);
      expect(errors).toStrictEqual([]);
    },
  );

  it('rejects a required_status_checks rule with no parameters object', () => {
    const ruleset = compliantMainRuleset();
    const rules = ruleset['rules'] as JsonObject[];
    const statusChecksRule = rules.find(
      (rule) => rule['type'] === 'required_status_checks',
    )!;
    delete statusChecksRule['parameters'];
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      'rulesets/main.json.rules[4].parameters must be an object',
    );
  });

  it('rejects a non-boolean required_status_checks flag', () => {
    const ruleset = compliantMainRuleset();
    const rules = ruleset['rules'] as JsonObject[];
    const statusChecksRule = rules.find(
      (rule) => rule['type'] === 'required_status_checks',
    )!;
    (statusChecksRule['parameters'] as JsonObject)[
      'strict_required_status_checks_policy'
    ] = 'yes';
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      'rulesets/main.json.rules[4].parameters.strict_required_status_checks_policy must be a boolean',
    );
  });

  it('rejects a non-boolean do_not_enforce_on_create flag', () => {
    const ruleset = compliantMainRuleset();
    const rules = ruleset['rules'] as JsonObject[];
    const statusChecksRule = rules.find(
      (rule) => rule['type'] === 'required_status_checks',
    )!;
    (statusChecksRule['parameters'] as JsonObject)['do_not_enforce_on_create'] =
      'yes';
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      'rulesets/main.json.rules[4].parameters.do_not_enforce_on_create must be a boolean',
    );
  });

  it('rejects a required status check entry that is not an object', () => {
    const ruleset = compliantMainRuleset();
    const rules = ruleset['rules'] as JsonObject[];
    const statusChecksRule = rules.find(
      (rule) => rule['type'] === 'required_status_checks',
    )!;
    (statusChecksRule['parameters'] as JsonObject)['required_status_checks'] = [
      'not-an-object',
    ];
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      'rulesets/main.json.rules[4].parameters.required_status_checks[0] must be an object',
    );
  });

  it('accepts a required status check with a valid integration_id', () => {
    const ruleset = compliantMainRuleset();
    const rules = ruleset['rules'] as JsonObject[];
    const statusChecksRule = rules.find(
      (rule) => rule['type'] === 'required_status_checks',
    )!;
    (statusChecksRule['parameters'] as JsonObject)['required_status_checks'] = [
      { context: 'check', integration_id: 42 },
    ];
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toStrictEqual([]);
  });

  it('rejects a required status check with a malformed integration_id', () => {
    const ruleset = compliantMainRuleset();
    const rules = ruleset['rules'] as JsonObject[];
    const statusChecksRule = rules.find(
      (rule) => rule['type'] === 'required_status_checks',
    )!;
    (statusChecksRule['parameters'] as JsonObject)['required_status_checks'] = [
      { context: 'check', integration_id: 1.5 },
    ];
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toStrictEqual([
      'rulesets/main.json.rules[4].parameters.required_status_checks[0].integration_id must be an integer when present',
    ]);
  });

  it('rejects a required status check with an unsupported key', () => {
    const ruleset = compliantMainRuleset();
    const rules = ruleset['rules'] as JsonObject[];
    const statusChecksRule = rules.find(
      (rule) => rule['type'] === 'required_status_checks',
    )!;
    (statusChecksRule['parameters'] as JsonObject)['required_status_checks'] = [
      { context: 'check', unexpected: true },
    ];
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      'rulesets/main.json.rules[4].parameters.required_status_checks[0].unexpected is not supported',
    );
  });

  it('rejects a rule that is not an object', () => {
    const ruleset = compliantMainRuleset();
    const rules = ruleset['rules'] as JsonObject[];
    rules.push('not-a-rule' as unknown as JsonObject);
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      'rulesets/main.json.rules[5] has an unsupported type',
    );
  });

  it('rejects a null rule without crashing', () => {
    const ruleset = compliantMainRuleset();
    const rules = ruleset['rules'] as JsonObject[];
    rules.push(null as unknown as JsonObject);
    const errors: string[] = [];
    expect(() =>
      validateRuleset(ruleset, 'rulesets/main.json', errors),
    ).not.toThrow();
    expect(errors).toContainEqual(
      'rulesets/main.json.rules[5] has an unsupported type',
    );
  });

  it('rejects a rule whose type is not a string', () => {
    const ruleset = compliantMainRuleset();
    const rules = ruleset['rules'] as JsonObject[];
    rules.push({ type: 5 });
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      'rulesets/main.json.rules[5] has an unsupported type',
    );
  });

  it('rejects a rule with an unsupported type', () => {
    const ruleset = compliantMainRuleset();
    const rules = ruleset['rules'] as JsonObject[];
    rules.push({ type: 'not-a-real-type' });
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      'rulesets/main.json.rules[5] has an unsupported type',
    );
  });

  it('rejects bypass_actors that is not an array', () => {
    const ruleset = { ...compliantMainRuleset(), bypass_actors: 'none' };
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual(
      "rulesets/main.json['bypass_actors'] must be an array",
    );
  });

  it('returns undefined when the ruleset has no name', () => {
    const ruleset = { ...compliantMainRuleset(), name: '' };
    const errors: string[] = [];
    expect(
      validateRuleset(ruleset, 'rulesets/main.json', errors),
    ).toBeUndefined();
    expect(errors).toContainEqual(
      'rulesets/main.json.name must be a non-empty string',
    );
  });

  it('rejects a value that is not a JSON object', () => {
    const errors: string[] = [];
    expect(validateRuleset([], 'rulesets/main.json', errors)).toBeUndefined();
    expect(errors).toStrictEqual([
      'rulesets/main.json must contain a JSON object',
    ]);
  });

  it('rejects an unsupported top-level key', () => {
    const ruleset = { ...compliantMainRuleset(), owner: 'someone' };
    const errors: string[] = [];
    validateRuleset(ruleset, 'rulesets/main.json', errors);
    expect(errors).toContainEqual('rulesets/main.json.owner is not supported');
  });
});

describe('validateEnvironment', () => {
  it('accepts a compliant production environment', () => {
    const errors: string[] = [];
    expect(
      validateEnvironment(
        compliantProductionEnvironment(),
        'environments/production.json',
        errors,
      ),
    ).toBeDefined();
    expect(errors).toStrictEqual([]);
  });

  it('rejects a deployment_branch_policy enabling both flags', () => {
    const environment = {
      ...compliantProductionEnvironment(),
      deployment_branch_policy: {
        protected_branches: true,
        custom_branch_policies: true,
      },
    };
    const errors: string[] = [];
    validateEnvironment(environment, 'environments/production.json', errors);
    expect(errors).toContainEqual(
      expect.stringContaining('must enable exactly one policy'),
    );
  });

  it('rejects a non-object deployment_branch_policy', () => {
    const environment = {
      ...compliantProductionEnvironment(),
      deployment_branch_policy: 'always',
    };
    const errors: string[] = [];
    validateEnvironment(environment, 'environments/production.json', errors);
    expect(errors).toContainEqual(
      expect.stringContaining('deployment_branch_policy must be an object'),
    );
  });

  it('rejects a negative wait_timer', () => {
    const environment = { ...compliantProductionEnvironment(), wait_timer: -1 };
    const errors: string[] = [];
    validateEnvironment(environment, 'environments/production.json', errors);
    expect(errors).toContainEqual(
      expect.stringContaining("['wait_timer'] must be a non-negative number"),
    );
  });

  it('rejects a prevent_self_review of the wrong type', () => {
    const environment = {
      ...compliantProductionEnvironment(),
      prevent_self_review: 'yes',
    };
    const errors: string[] = [];
    validateEnvironment(environment, 'environments/production.json', errors);
    expect(errors).toContainEqual(
      expect.stringContaining("['prevent_self_review'] must be a boolean"),
    );
  });

  it('rejects a reviewers value that is not an array', () => {
    const environment = {
      ...compliantProductionEnvironment(),
      reviewers: 'nobody',
    };
    const errors: string[] = [];
    validateEnvironment(environment, 'environments/production.json', errors);
    expect(errors).toContainEqual(
      expect.stringContaining('reviewers must be an array'),
    );
  });

  it('rejects a reviewer entry with an unsupported type or non-integer id', () => {
    const environment = {
      ...compliantProductionEnvironment(),
      reviewers: [
        { type: 'Bot', id: 1 },
        { type: 'User', id: 1.5 },
      ],
    };
    const errors: string[] = [];
    validateEnvironment(environment, 'environments/production.json', errors);
    expect(errors).toContainEqual(
      expect.stringContaining(
        'reviewers[0] must contain a User or Team type and integer id',
      ),
    );
    expect(errors).toContainEqual(
      expect.stringContaining(
        'reviewers[1] must contain a User or Team type and integer id',
      ),
    );
  });

  it('accepts a valid reviewer entry without an error', () => {
    const environment = {
      ...compliantProductionEnvironment(),
      reviewers: [{ type: 'Team', id: 42 }],
    };
    const errors: string[] = [];
    validateEnvironment(environment, 'environments/production.json', errors);
    expect(errors).toStrictEqual([]);
  });

  it('rejects deployment_branch_policy flags that are not booleans', () => {
    const environment = {
      ...compliantProductionEnvironment(),
      deployment_branch_policy: {
        protected_branches: 'yes',
        custom_branch_policies: false,
      },
    };
    const errors: string[] = [];
    validateEnvironment(environment, 'environments/production.json', errors);
    expect(errors).toContainEqual(
      expect.stringContaining(
        'deployment_branch_policy flags must be booleans',
      ),
    );
  });

  it('rejects a value that is not a JSON object', () => {
    const errors: string[] = [];
    expect(
      validateEnvironment([], 'environments/production.json', errors),
    ).toBeUndefined();
    expect(errors).toContainEqual(
      expect.stringContaining('must contain a JSON object'),
    );
  });

  it('returns undefined when the environment name is missing', () => {
    const environment = {
      ...compliantProductionEnvironment(),
      environment: '',
    };
    const errors: string[] = [];
    expect(
      validateEnvironment(environment, 'environments/production.json', errors),
    ).toBeUndefined();
  });
});

describe('validateSecrets', () => {
  it('accepts an empty secrets manifest', () => {
    const errors: string[] = [];
    expect(validateSecrets(compliantSecrets(), errors)).toStrictEqual({
      repository: [],
      environments: {},
    });
    expect(errors).toStrictEqual([]);
  });

  it('rejects a secret entry without a purpose', () => {
    const value = {
      repository: [{ name: 'TOKEN', required: true, purpose: '' }],
      environments: {},
    };
    const errors: string[] = [];
    validateSecrets(value, errors);
    expect(errors).toContainEqual(
      expect.stringContaining("['purpose'] must be a non-empty string"),
    );
  });

  it('accepts a fully specified secret entry in repository and environment scope', () => {
    const value = {
      repository: [
        {
          name: 'GH_ADMIN_TOKEN',
          required: true,
          purpose: 'apply GitHub settings',
        },
      ],
      environments: {
        production: [
          { name: 'DEPLOY_KEY', required: false, purpose: 'deploy step' },
        ],
      },
    };
    const errors: string[] = [];
    expect(validateSecrets(value, errors)).toStrictEqual({
      repository: [{ name: 'GH_ADMIN_TOKEN', required: true }],
      environments: {
        production: [{ name: 'DEPLOY_KEY', required: false }],
      },
    });
    expect(errors).toStrictEqual([]);
  });

  it('rejects a non-object secret entry', () => {
    const value = { repository: ['not-an-object'], environments: {} };
    const errors: string[] = [];
    validateSecrets(value, errors);
    expect(errors).toContainEqual(
      expect.stringContaining('repository[0] must be an object'),
    );
  });

  it('rejects a missing purpose', () => {
    const value = {
      repository: [{ name: 'TOKEN', required: true }],
      environments: {},
    };
    const errors: string[] = [];
    validateSecrets(value, errors);
    expect(errors).toContainEqual(
      expect.stringContaining("['purpose'] must be a non-empty string"),
    );
  });

  it('rejects a required flag of the wrong type', () => {
    const value = {
      repository: [{ name: 'TOKEN', required: 'yes', purpose: 'auth' }],
      environments: {},
    };
    const errors: string[] = [];
    validateSecrets(value, errors);
    expect(errors).toContainEqual(
      expect.stringContaining("['required'] must be a boolean"),
    );
  });

  it('rejects a repository field that is not an array', () => {
    const value = { repository: 'TOKEN', environments: {} };
    const errors: string[] = [];
    validateSecrets(value, errors);
    expect(errors).toContainEqual(
      expect.stringContaining(
        'secrets-manifest.json.repository must be an array',
      ),
    );
  });

  it('rejects an environments field that is not an object', () => {
    const value = { repository: [], environments: 'production' };
    const errors: string[] = [];
    validateSecrets(value, errors);
    expect(errors).toContainEqual(
      expect.stringContaining(
        'secrets-manifest.json.environments must be an object',
      ),
    );
  });

  it('rejects a non-object secrets manifest', () => {
    const errors: string[] = [];
    expect(validateSecrets([], errors)).toBeUndefined();
    expect(errors).toStrictEqual([
      expect.stringContaining(
        'secrets-manifest.json must contain a JSON object',
      ),
    ]);
  });
});

describe('validateConfigurationValues', () => {
  function validConfiguration() {
    return {
      repositoryValue: compliantRepository(),
      rulesetDocuments: [
        { path: 'rulesets/main.json', value: compliantMainRuleset() },
      ],
      environmentDocuments: [
        {
          path: 'environments/production.json',
          value: compliantProductionEnvironment(),
        },
      ],
      secretValue: compliantSecrets(),
    };
  }

  it('accepts a fully valid configuration', () => {
    const {
      repositoryValue,
      rulesetDocuments,
      environmentDocuments,
      secretValue,
    } = validConfiguration();
    const configuration = validateConfigurationValues(
      repositoryValue,
      rulesetDocuments,
      environmentDocuments,
      secretValue,
    );
    expect(configuration.rulesets).toHaveLength(1);
    expect(configuration.environments).toHaveLength(1);
  });

  it('fails when no ruleset is named main', () => {
    const { repositoryValue, environmentDocuments, secretValue } =
      validConfiguration();
    const rulesetDocuments = [
      {
        path: 'rulesets/other.json',
        value: { ...compliantMainRuleset(), name: 'other' },
      },
    ];
    expect(() =>
      validateConfigurationValues(
        repositoryValue,
        rulesetDocuments,
        environmentDocuments,
        secretValue,
      ),
    ).toThrow(/must contain a main\.json ruleset named main/);
  });

  it.each(['check', 'mutation', 'github-settings'])(
    'fails when the %s status check is missing',
    (missingContext) => {
      const { repositoryValue, environmentDocuments, secretValue } =
        validConfiguration();
      const ruleset = compliantMainRuleset();
      const rules = ruleset['rules'] as JsonObject[];
      const statusChecksRule = rules.find(
        (rule) => rule['type'] === 'required_status_checks',
      )!;
      (statusChecksRule['parameters'] as JsonObject)['required_status_checks'] =
        (
          (statusChecksRule['parameters'] as JsonObject)[
            'required_status_checks'
          ] as JsonObject[]
        ).filter((check) => check['context'] !== missingContext);
      const rulesetDocuments = [{ path: 'rulesets/main.json', value: ruleset }];
      expect(() =>
        validateConfigurationValues(
          repositoryValue,
          rulesetDocuments,
          environmentDocuments,
          secretValue,
        ),
      ).toThrow(new RegExp(`must require the ${missingContext} status check`));
    },
  );

  it('fails when required_status_checks parameters is not an array', () => {
    const { repositoryValue, environmentDocuments, secretValue } =
      validConfiguration();
    const ruleset = compliantMainRuleset();
    const rules = ruleset['rules'] as JsonObject[];
    const statusChecksRule = rules.find(
      (rule) => rule['type'] === 'required_status_checks',
    )!;
    (statusChecksRule['parameters'] as JsonObject)['required_status_checks'] =
      'not-an-array';
    const rulesetDocuments = [{ path: 'rulesets/main.json', value: ruleset }];
    expect(() =>
      validateConfigurationValues(
        repositoryValue,
        rulesetDocuments,
        environmentDocuments,
        secretValue,
      ),
    ).toThrow(/must require the check status check/);
  });

  it('fails when every required_status_checks entry is malformed', () => {
    const { repositoryValue, environmentDocuments, secretValue } =
      validConfiguration();
    const ruleset = compliantMainRuleset();
    const rules = ruleset['rules'] as JsonObject[];
    const statusChecksRule = rules.find(
      (rule) => rule['type'] === 'required_status_checks',
    )!;
    (statusChecksRule['parameters'] as JsonObject)['required_status_checks'] = [
      'not-an-object',
      { integration_id: 1 },
    ];
    const rulesetDocuments = [{ path: 'rulesets/main.json', value: ruleset }];
    expect(() =>
      validateConfigurationValues(
        repositoryValue,
        rulesetDocuments,
        environmentDocuments,
        secretValue,
      ),
    ).toThrow(/must require the check status check/);
  });

  it('fails when the main ruleset has no required_status_checks rule at all', () => {
    const { repositoryValue, environmentDocuments, secretValue } =
      validConfiguration();
    const ruleset = compliantMainRuleset();
    ruleset['rules'] = (ruleset['rules'] as JsonObject[]).filter(
      (rule) => rule['type'] !== 'required_status_checks',
    );
    const rulesetDocuments = [{ path: 'rulesets/main.json', value: ruleset }];
    expect(() =>
      validateConfigurationValues(
        repositoryValue,
        rulesetDocuments,
        environmentDocuments,
        secretValue,
      ),
    ).toThrow(/must require the check status check/);
  });

  it('fails when a ruleset document does not parse to an object', () => {
    const { repositoryValue, environmentDocuments, secretValue } =
      validConfiguration();
    const rulesetDocuments = [
      { path: 'rulesets/broken.json', value: [] },
      { path: 'rulesets/main.json', value: compliantMainRuleset() },
    ];
    expect(() =>
      validateConfigurationValues(
        repositoryValue,
        rulesetDocuments,
        environmentDocuments,
        secretValue,
      ),
    ).toThrow(/rulesets\/broken\.json must contain a JSON object/);
  });

  it('fails when an environment document does not parse to an object', () => {
    const { repositoryValue, rulesetDocuments, secretValue } =
      validConfiguration();
    const environmentDocuments = [
      { path: 'environments/broken.json', value: [] },
      {
        path: 'environments/production.json',
        value: compliantProductionEnvironment(),
      },
    ];
    expect(() =>
      validateConfigurationValues(
        repositoryValue,
        rulesetDocuments,
        environmentDocuments,
        secretValue,
      ),
    ).toThrow(/environments\/broken\.json must contain a JSON object/);
  });

  it('fails when the main ruleset declares a bypass actor', () => {
    const { repositoryValue, environmentDocuments, secretValue } =
      validConfiguration();
    const ruleset = {
      ...compliantMainRuleset(),
      bypass_actors: [
        {
          actor_type: 'RepositoryRole',
          actor_id: 5,
          bypass_mode: 'pull_request',
        },
      ],
    };
    const rulesetDocuments = [{ path: 'rulesets/main.json', value: ruleset }];
    expect(() =>
      validateConfigurationValues(
        repositoryValue,
        rulesetDocuments,
        environmentDocuments,
        secretValue,
      ),
    ).toThrow(/must not declare bypass_actors/);
  });

  it('fails when require_code_owner_review is true', () => {
    const { repositoryValue, environmentDocuments, secretValue } =
      validConfiguration();
    const ruleset = compliantMainRuleset();
    const rules = ruleset['rules'] as JsonObject[];
    const pullRequestRule = rules.find(
      (rule) => rule['type'] === 'pull_request',
    )!;
    (pullRequestRule['parameters'] as JsonObject)['require_code_owner_review'] =
      true;
    const rulesetDocuments = [{ path: 'rulesets/main.json', value: ruleset }];
    expect(() =>
      validateConfigurationValues(
        repositoryValue,
        rulesetDocuments,
        environmentDocuments,
        secretValue,
      ),
    ).toThrow(/require_code_owner_review to false/);
  });

  it('fails when require_last_push_approval is true', () => {
    const { repositoryValue, environmentDocuments, secretValue } =
      validConfiguration();
    const ruleset = compliantMainRuleset();
    const rules = ruleset['rules'] as JsonObject[];
    const pullRequestRule = rules.find(
      (rule) => rule['type'] === 'pull_request',
    )!;
    (pullRequestRule['parameters'] as JsonObject)[
      'require_last_push_approval'
    ] = true;
    const rulesetDocuments = [{ path: 'rulesets/main.json', value: ruleset }];
    expect(() =>
      validateConfigurationValues(
        repositoryValue,
        rulesetDocuments,
        environmentDocuments,
        secretValue,
      ),
    ).toThrow(/require_last_push_approval to false/);
  });

  it('fails on a malformed ruleset structure', () => {
    const { repositoryValue, environmentDocuments, secretValue } =
      validConfiguration();
    const rulesetDocuments = [
      { path: 'rulesets/main.json', value: { name: 'main' } },
    ];
    expect(() =>
      validateConfigurationValues(
        repositoryValue,
        rulesetDocuments,
        environmentDocuments,
        secretValue,
      ),
    ).toThrow(/Invalid GitHub infrastructure configuration/);
  });

  it('fails when no production environment is declared', () => {
    const { repositoryValue, rulesetDocuments, secretValue } =
      validConfiguration();
    expect(() =>
      validateConfigurationValues(
        repositoryValue,
        rulesetDocuments,
        [],
        secretValue,
      ),
    ).toThrow(/must contain a production environment/);
  });

  it('fails when every declared environment is not production', () => {
    const { repositoryValue, rulesetDocuments, secretValue } =
      validConfiguration();
    const environmentDocuments = [
      {
        path: 'environments/staging.json',
        value: { ...compliantProductionEnvironment(), environment: 'staging' },
      },
    ];
    expect(() =>
      validateConfigurationValues(
        repositoryValue,
        rulesetDocuments,
        environmentDocuments,
        secretValue,
      ),
    ).toThrow(/must contain a production environment/);
  });

  it('reports multiple validation failures joined on their own line', () => {
    const { environmentDocuments, secretValue } = validConfiguration();
    expect(() =>
      validateConfigurationValues([], [], environmentDocuments, secretValue),
    ).toThrow(
      'Invalid GitHub infrastructure configuration:\n' +
        '- repository-settings.json must contain a JSON object\n' +
        '- rulesets must contain a main.json ruleset named main',
    );
  });
});

describe('validateMainRulesetApprovalPolicy', () => {
  it('accepts a compliant main ruleset', () => {
    const errors: string[] = [];
    validateMainRulesetApprovalPolicy(compliantMainRuleset(), errors);
    expect(errors).toStrictEqual([]);
  });

  it('rejects a non-empty bypass_actors array', () => {
    const ruleset = {
      ...compliantMainRuleset(),
      bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 5 }],
    };
    const errors: string[] = [];
    validateMainRulesetApprovalPolicy(ruleset, errors);
    expect(errors).toStrictEqual([
      expect.stringContaining('must not declare bypass_actors'),
    ]);
  });

  it('is a no-op when the ruleset has no pull_request rule', () => {
    const ruleset = {
      ...compliantMainRuleset(),
      rules: (compliantMainRuleset()['rules'] as JsonObject[]).filter(
        (rule) => rule['type'] !== 'pull_request',
      ),
    };
    const errors: string[] = [];
    validateMainRulesetApprovalPolicy(ruleset, errors);
    expect(errors).toStrictEqual([]);
  });
});

describe('validateCiWorkflowContract', () => {
  it('accepts a workflow that defines every required job with the right command', () => {
    expect(validateCiWorkflowContract(compliantCiWorkflow())).toStrictEqual([]);
  });

  it('resolves a required status check by the job name, not the job key', () => {
    const source = `
jobs:
  check:
    steps:
      - run: pnpm verify
  mutation:
    steps:
      - run: pnpm test:mutation
  settings:
    name: github-settings
    steps:
      - run: node scripts/github-settings.ts --check
`;
    expect(validateCiWorkflowContract(source)).toStrictEqual([]);
  });

  it('rejects a job key that matches a required check but reports another name', () => {
    const source = `
jobs:
  check:
    steps:
      - run: pnpm verify
  mutation:
    steps:
      - run: pnpm test:mutation
  github-settings:
    name: settings
    steps:
      - run: node scripts/github-settings.ts --check
`;
    expect(validateCiWorkflowContract(source)).toContainEqual(
      expect.stringContaining(
        'must define a job reporting the github-settings status check',
      ),
    );
  });

  it('reports only the missing job, not also a missing command', () => {
    const source = `
jobs:
  check:
    steps:
      - run: pnpm verify
  mutation:
    steps:
      - run: pnpm test:mutation
`;
    expect(validateCiWorkflowContract(source)).toStrictEqual([
      'ci.yml must define a job reporting the github-settings status check required by rulesets/main.json',
    ]);
  });

  it('accepts a command written with surrounding whitespace', () => {
    const source = `
jobs:
  check:
    steps:
      - run: pnpm verify
  mutation:
    steps:
      - run: pnpm test:mutation
  github-settings:
    steps:
      - run: |
          node scripts/github-settings.ts --check
`;
    expect(validateCiWorkflowContract(source)).toStrictEqual([]);
  });

  it('reports every required check when the document has no jobs mapping', () => {
    expect(validateCiWorkflowContract('jobs: none')).toStrictEqual([
      'ci.yml must define a jobs map',
    ]);
  });

  it('ignores a jobs entry that is not a mapping', () => {
    const source = `
jobs:
  check:
    steps:
      - run: pnpm verify
  mutation:
    steps:
      - run: pnpm test:mutation
  github-settings: skipped
`;
    expect(validateCiWorkflowContract(source)).toContainEqual(
      expect.stringContaining(
        'must define a job reporting the github-settings status check',
      ),
    );
  });

  it('rejects a github-settings job whose steps are not a list', () => {
    const source = `
jobs:
  check:
    steps:
      - run: pnpm verify
  mutation:
    steps:
      - run: pnpm test:mutation
  github-settings:
    steps: none
`;
    expect(validateCiWorkflowContract(source)).toStrictEqual([
      'ci.yml job github-settings must run `node scripts/github-settings.ts --check`',
    ]);
  });

  it('ignores a step that is not a command', () => {
    const source = `
jobs:
  check:
    steps:
      - run: pnpm verify
  mutation:
    steps:
      - run: pnpm test:mutation
  github-settings:
    steps:
      - uses: actions/checkout@v7
      - run: node scripts/github-settings.ts --check
`;
    expect(validateCiWorkflowContract(source)).toStrictEqual([]);
  });

  it('rejects a workflow missing the github-settings job', () => {
    const source = `
jobs:
  check:
    steps:
      - run: pnpm verify
  mutation:
    steps:
      - run: pnpm test:mutation
`;
    expect(validateCiWorkflowContract(source)).toContainEqual(
      expect.stringContaining(
        'must define a job reporting the github-settings status check',
      ),
    );
  });

  it('rejects a github-settings job that runs the wrong command', () => {
    const source = compliantCiWorkflow().replace(
      'node scripts/github-settings.ts --check',
      'node scripts/github-settings.ts --check --remote',
    );
    expect(validateCiWorkflowContract(source)).toContainEqual(
      expect.stringContaining(
        'job github-settings must run `node scripts/github-settings.ts --check`',
      ),
    );
  });

  it('rejects a github-settings job that declares no steps at all', () => {
    const source = `
jobs:
  check:
    steps:
      - run: pnpm verify
  mutation:
    steps:
      - run: pnpm test:mutation
  github-settings: {}
`;
    expect(validateCiWorkflowContract(source)).toContainEqual(
      expect.stringContaining(
        'job github-settings must run `node scripts/github-settings.ts --check`',
      ),
    );
  });

  it('rejects a document with no jobs map', () => {
    expect(validateCiWorkflowContract('name: CI\n')).toStrictEqual([
      'ci.yml must define a jobs map',
    ]);
  });

  it('rejects invalid YAML', () => {
    expect(validateCiWorkflowContract('jobs: [')).toStrictEqual([
      expect.stringContaining('ci.yml is not valid YAML'),
    ]);
  });

  it('stringifies a non-Error thrown while parsing ci.yml', () => {
    vi.mocked(parse).mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercises the non-Error branch of the catch
      throw 'boom';
    });
    expect(validateCiWorkflowContract('jobs: {}')).toStrictEqual([
      'ci.yml is not valid YAML: boom',
    ]);
  });
});

describe('normalizeRulesetForComparison', () => {
  it('drops GitHub API fields the desired-state schema does not declare', () => {
    const apiResponse = {
      id: 42,
      name: 'main',
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [],
      current_user_can_bypass: 'never',
      conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
      rules: [{ type: 'deletion' }],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      _links: {},
    };
    const normalized = normalizeRulesetForComparison(apiResponse);
    expect(normalized).not.toHaveProperty('id');
    expect(normalized).not.toHaveProperty('created_at');
    expect(normalized).toStrictEqual({
      name: 'main',
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [],
      conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
      rules: [{ type: 'deletion' }],
    });
  });

  it('strips extra pull_request parameters the API returns', () => {
    const desired = normalizeRulesetForComparison(compliantMainRuleset());
    const apiResponse = compliantMainRuleset();
    const rules = apiResponse['rules'] as JsonObject[];
    const pullRequestRule = rules.find(
      (rule) => rule['type'] === 'pull_request',
    )!;
    (pullRequestRule['parameters'] as JsonObject)[
      'automatic_copilot_code_review'
    ] = false;
    expect(normalizeRulesetForComparison(apiResponse)).toStrictEqual(desired);
  });

  it('tolerates a ruleset with no rules array', () => {
    expect(normalizeRulesetForComparison({ name: 'main' })).toStrictEqual({
      name: 'main',
    });
  });

  it('passes through a pull_request rule with no parameters field without crashing', () => {
    const apiResponse = { name: 'main', rules: [{ type: 'pull_request' }] };
    expect(() => normalizeRulesetForComparison(apiResponse)).not.toThrow();
    expect(normalizeRulesetForComparison(apiResponse)).toStrictEqual({
      name: 'main',
      rules: [{ type: 'pull_request' }],
    });
  });

  it('passes through a pull_request rule whose parameters is not an object', () => {
    const apiResponse = {
      name: 'main',
      rules: [{ type: 'pull_request', parameters: 'nope' }],
    };
    expect(normalizeRulesetForComparison(apiResponse)).toStrictEqual({
      name: 'main',
      rules: [{ type: 'pull_request', parameters: 'nope' }],
    });
  });

  it('preserves fields outside parameters on a normalized pull_request rule', () => {
    const apiResponse = {
      name: 'main',
      rules: [
        {
          type: 'pull_request',
          extra_field: 'kept',
          parameters: { require_code_owner_review: true },
        },
      ],
    };
    expect(normalizeRulesetForComparison(apiResponse)).toStrictEqual({
      name: 'main',
      rules: [
        {
          type: 'pull_request',
          extra_field: 'kept',
          parameters: { require_code_owner_review: true },
        },
      ],
    });
  });

  it('strips unsupported required_status_checks parameter keys', () => {
    const apiResponse = {
      name: 'main',
      rules: [
        {
          type: 'required_status_checks',
          parameters: {
            do_not_enforce_on_create: false,
            unexpected: 'kept-only-by-a-broken-normalizer',
          },
        },
      ],
    };
    expect(normalizeRulesetForComparison(apiResponse)).toStrictEqual({
      name: 'main',
      rules: [
        {
          type: 'required_status_checks',
          parameters: { do_not_enforce_on_create: false },
        },
      ],
    });
  });

  it('strips unsupported fields from a required status check entry', () => {
    const apiResponse = {
      name: 'main',
      rules: [
        {
          type: 'required_status_checks',
          parameters: {
            required_status_checks: [{ context: 'check', integration_id: 42 }],
          },
        },
      ],
    };
    expect(normalizeRulesetForComparison(apiResponse)).toStrictEqual({
      name: 'main',
      rules: [
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'check' }] },
        },
      ],
    });
  });

  it('passes through a rule of an unrecognized type that still has parameters', () => {
    const apiResponse = {
      name: 'main',
      rules: [
        { type: 'commit_message_pattern', parameters: { pattern: '.*' } },
      ],
    };
    expect(normalizeRulesetForComparison(apiResponse)).toStrictEqual({
      name: 'main',
      rules: [
        { type: 'commit_message_pattern', parameters: { pattern: '.*' } },
      ],
    });
  });

  it('tolerates a required_status_checks rule with no status check array', () => {
    const apiResponse = {
      name: 'main',
      rules: [
        {
          type: 'required_status_checks',
          parameters: { do_not_enforce_on_create: false },
        },
      ],
    };
    expect(normalizeRulesetForComparison(apiResponse)).toStrictEqual({
      name: 'main',
      rules: [
        {
          type: 'required_status_checks',
          parameters: { do_not_enforce_on_create: false },
        },
      ],
    });
  });

  it('passes through a non-object status check entry unchanged', () => {
    const apiResponse = {
      name: 'main',
      rules: [
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: ['check'] },
        },
      ],
    };
    expect(normalizeRulesetForComparison(apiResponse)).toStrictEqual({
      name: 'main',
      rules: [
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: ['check'] },
        },
      ],
    });
  });
});

describe('normalizeEnvironmentForComparison', () => {
  it('extracts reviewers from the API protection_rules shape', () => {
    const apiResponse = {
      wait_timer: 0,
      prevent_self_review: true,
      protection_rules: [
        {
          type: 'required_reviewers',
          reviewers: [{ reviewer: { type: 'User', id: 1 } }],
        },
      ],
      deployment_branch_policy: {
        protected_branches: true,
        custom_branch_policies: false,
      },
    };
    expect(normalizeEnvironmentForComparison(apiResponse)).toStrictEqual({
      wait_timer: 0,
      prevent_self_review: true,
      reviewers: [{ type: 'User', id: 1 }],
      deployment_branch_policy: {
        protected_branches: true,
        custom_branch_policies: false,
      },
    });
  });

  it('matches a desired environment through environmentBody', () => {
    const desired = normalizeEnvironmentForComparison(
      environmentBody(compliantProductionEnvironment()),
    );
    expect(desired).toStrictEqual({
      wait_timer: 0,
      prevent_self_review: true,
      reviewers: [],
      deployment_branch_policy: {
        protected_branches: true,
        custom_branch_policies: false,
      },
    });
  });

  it('drops a reviewer entry whose reviewer field is not an object', () => {
    const apiResponse = {
      protection_rules: [
        {
          type: 'required_reviewers',
          reviewers: ['not-an-object', { reviewer: { type: 'Team', id: 7 } }],
        },
      ],
    };
    expect(
      normalizeEnvironmentForComparison(apiResponse)['reviewers'],
    ).toStrictEqual([{ type: 'Team', id: 7 }]);
  });

  it('drops a reviewer entry with a malformed actor', () => {
    const apiResponse = {
      protection_rules: [
        {
          type: 'required_reviewers',
          reviewers: [{ reviewer: { type: 1, id: 'not-a-number' } }],
        },
      ],
    };
    expect(
      normalizeEnvironmentForComparison(apiResponse)['reviewers'],
    ).toStrictEqual([]);
  });

  it('drops a reviewer entry whose actor id is not a number', () => {
    const apiResponse = {
      protection_rules: [
        {
          type: 'required_reviewers',
          reviewers: [{ reviewer: { type: 'User', id: 'not-a-number' } }],
        },
      ],
    };
    expect(
      normalizeEnvironmentForComparison(apiResponse)['reviewers'],
    ).toStrictEqual([]);
  });

  it('drops a reviewer entry whose reviewer field is an array, not a plain object', () => {
    const reviewer = Object.assign([], { type: 'User', id: 5 });
    const apiResponse = {
      protection_rules: [
        {
          type: 'required_reviewers',
          reviewers: [{ reviewer }],
        },
      ],
    };
    expect(
      normalizeEnvironmentForComparison(apiResponse)['reviewers'],
    ).toStrictEqual([]);
  });

  it('picks the required_reviewers protection rule, not any other rule', () => {
    const apiResponse = {
      protection_rules: [
        'not-an-object',
        {
          type: 'other_rule',
          reviewers: [{ reviewer: { type: 'Bot', id: 99 } }],
        },
        {
          type: 'required_reviewers',
          reviewers: [{ reviewer: { type: 'User', id: 1 } }],
        },
      ],
    };
    expect(
      normalizeEnvironmentForComparison(apiResponse)['reviewers'],
    ).toStrictEqual([{ type: 'User', id: 1 }]);
  });

  it('ignores protection_rules when it is not an array', () => {
    const apiResponse = { protection_rules: 'none' };
    expect(
      normalizeEnvironmentForComparison(apiResponse)['reviewers'],
    ).toStrictEqual([]);
  });
});

describe('environmentBody', () => {
  it('removes the environment field but keeps everything else', () => {
    expect(
      environmentBody({ environment: 'production', wait_timer: 0 }),
    ).toStrictEqual({ wait_timer: 0 });
  });
});

describe('reportDrift', () => {
  it('reports nothing when desired and actual are equivalent regardless of key order', () => {
    const drifts: string[] = [];
    reportDrift('repository settings', { a: 1, b: 2 }, { b: 2, a: 1 }, drifts);
    expect(drifts).toStrictEqual([]);
  });

  it('reports a difference between desired and actual', () => {
    const drifts: string[] = [];
    reportDrift(
      'repository settings',
      { allow_auto_merge: false },
      { allow_auto_merge: true },
      drifts,
    );
    expect(drifts).toStrictEqual([
      expect.stringContaining('repository settings'),
    ]);
  });
});

describe('sortJson / comparableJson', () => {
  it('sorts object keys recursively', () => {
    const result = sortJson({ b: 1, a: { d: 2, c: 3 } });
    expect(result).toStrictEqual({
      a: { c: 3, d: 2 },
      b: 1,
    });
    expect(Object.keys(result as object)).toStrictEqual(['a', 'b']);
    const nested = (result as Record<string, object>)['a']!;
    expect(Object.keys(nested)).toStrictEqual(['c', 'd']);
  });

  it('sorts objects nested inside arrays without reordering the array itself', () => {
    const result = sortJson([{ b: 1, a: 2 }, 'x']) as unknown[];
    expect(result).toStrictEqual([{ a: 2, b: 1 }, 'x']);
    expect(Object.keys(result[0] as object)).toStrictEqual(['a', 'b']);
  });

  it('produces the same comparable string for differently ordered objects', () => {
    expect(comparableJson({ a: 1, b: 2 })).toBe(comparableJson({ b: 2, a: 1 }));
  });
});

describe('selectFields', () => {
  it('omits fields the object does not define', () => {
    expect(selectFields({ a: 1 }, ['a', 'b'])).toStrictEqual({ a: 1 });
  });
});

describe('secretNames', () => {
  it('reads secret names from a GitHub API secrets response', () => {
    expect(
      secretNames({
        secrets: [{ name: 'GH_ADMIN_TOKEN' }, { name: 'NPM_TOKEN' }],
      }),
    ).toStrictEqual(['GH_ADMIN_TOKEN', 'NPM_TOKEN']);
  });

  it('returns an empty array for a malformed response', () => {
    expect(secretNames({})).toStrictEqual([]);
  });

  it('skips entries that are not a record with a string name', () => {
    expect(
      secretNames({ secrets: ['not-an-object', { name: 42 }, { name: 'OK' }] }),
    ).toStrictEqual(['OK']);
  });
});

describe('checkRequiredSecrets', () => {
  it('does not report an optional secret that is missing', () => {
    const drifts: string[] = [];
    checkRequiredSecrets(
      'repository',
      [{ name: 'OPTIONAL_TOKEN', required: false }],
      [],
      drifts,
    );
    expect(drifts).toStrictEqual([]);
  });

  it('does not report a required secret that is already present', () => {
    const drifts: string[] = [];
    checkRequiredSecrets(
      'repository',
      [{ name: 'GH_ADMIN_TOKEN', required: true }],
      ['GH_ADMIN_TOKEN'],
      drifts,
    );
    expect(drifts).toStrictEqual([]);
  });

  it('reports a required secret that is missing', () => {
    const drifts: string[] = [];
    checkRequiredSecrets(
      'repository',
      [{ name: 'GH_ADMIN_TOKEN', required: true }],
      [],
      drifts,
    );
    expect(drifts).toStrictEqual([
      'repository secret GH_ADMIN_TOKEN is missing',
    ]);
  });
});

describe('parseRepositoryReference', () => {
  it('parses an SSH remote URL', () => {
    expect(
      parseRepositoryReference('git@github.com:shunmd/node-starter.git'),
    ).toStrictEqual({
      owner: 'shunmd',
      name: 'node-starter',
    });
  });

  it('parses an HTTPS remote URL without a .git suffix', () => {
    expect(
      parseRepositoryReference('https://github.com/shunmd/node-starter'),
    ).toStrictEqual({
      owner: 'shunmd',
      name: 'node-starter',
    });
  });

  it('returns undefined for a non-GitHub remote', () => {
    expect(
      parseRepositoryReference('https://gitlab.com/shunmd/node-starter.git'),
    ).toBeUndefined();
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(
      parseRepositoryReference('  git@github.com:shunmd/node-starter.git  '),
    ).toStrictEqual({
      owner: 'shunmd',
      name: 'node-starter',
    });
  });
});
