import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as githubApi from './github-api.ts';

import type { DesiredConfiguration } from '../lib/github-settings-types.ts';

const requestMock = vi.hoisted(() => vi.fn());
const requestRulesetSummariesMock = vi.hoisted(() => vi.fn());

vi.mock('./github-api.ts', async () => {
  const actual = await vi.importActual<typeof githubApi>('./github-api.ts');
  return {
    ...actual,
    request: requestMock,
    requestRulesetSummaries: requestRulesetSummariesMock,
  };
});

const { runRemoteCheck } = await import('./drift.ts');

const reference = { owner: 'owner', name: 'name' } as const;

function configuration(
  overrides: Partial<DesiredConfiguration> = {},
): DesiredConfiguration {
  return {
    repository: { default_branch: 'main' },
    rulesets: [{ name: 'main', target: 'branch', enforcement: 'active' }],
    environments: [{ environment: 'production' }],
    secrets: {
      repository: [{ name: 'GH_ADMIN_TOKEN', required: true }],
      environments: { production: [{ name: 'DEPLOY_KEY', required: true }] },
    },
    ...overrides,
  };
}

/**
 * Routes each API path to the live state a matching repository would return,
 * so a test only has to describe the one response it is changing.
 */
function respondWith(overrides: Record<string, unknown> = {}): void {
  const bodies: Record<string, unknown> = {
    '': { default_branch: 'main' },
    '/rulesets/1': { name: 'main', target: 'branch', enforcement: 'active' },
    '/environments?per_page=100': { environments: [{ name: 'production' }] },
    '/environments/production': {},
    '/actions/secrets?per_page=100': { secrets: [{ name: 'GH_ADMIN_TOKEN' }] },
    '/environments/production/secrets?per_page=100': {
      secrets: [{ name: 'DEPLOY_KEY' }],
    },
    ...overrides,
  };
  requestMock.mockImplementation((_reference: unknown, path: string) =>
    Promise.resolve({ status: 200, body: bodies[path] }),
  );
}

beforeEach(() => {
  respondWith();
  requestRulesetSummariesMock.mockResolvedValue({
    available: true,
    summaries: [{ id: 1, name: 'main' }],
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('runRemoteCheck', () => {
  it('reports no drift when the live repository matches the declared state', async () => {
    await expect(
      runRemoteCheck(reference, configuration()),
    ).resolves.toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(
      'GitHub settings match desired state for owner/name.',
    );
  });

  it('reports a repository setting that differs', async () => {
    respondWith({ '': { default_branch: 'master' } });
    await expect(runRemoteCheck(reference, configuration())).rejects.toThrow(
      /repository settings/,
    );
  });

  it('rejects a repository response that is not an object', async () => {
    respondWith({ '': [] });
    await expect(runRemoteCheck(reference, configuration())).rejects.toThrow(
      'Reading repository settings returned an invalid response',
    );
  });

  it('reports a declared ruleset that does not exist', async () => {
    requestRulesetSummariesMock.mockResolvedValue({
      available: true,
      summaries: [],
    });
    await expect(runRemoteCheck(reference, configuration())).rejects.toThrow(
      'ruleset main is missing',
    );
  });

  it('reports a ruleset whose live definition differs', async () => {
    respondWith({
      '/rulesets/1': {
        name: 'main',
        target: 'branch',
        enforcement: 'disabled',
      },
    });
    await expect(runRemoteCheck(reference, configuration())).rejects.toThrow(
      /ruleset main/,
    );
  });

  it('rejects a ruleset response that is not an object', async () => {
    respondWith({ '/rulesets/1': [] });
    await expect(runRemoteCheck(reference, configuration())).rejects.toThrow(
      'Reading ruleset main returned an invalid response',
    );
  });

  it('reports declared rulesets that the plan cannot verify', async () => {
    requestRulesetSummariesMock.mockResolvedValue({
      available: false,
      summaries: [],
    });
    await expect(runRemoteCheck(reference, configuration())).rejects.toThrow(
      'rulesets are not available on this repository',
    );
  });

  it('accepts unavailable rulesets when none are declared', async () => {
    requestRulesetSummariesMock.mockResolvedValue({
      available: false,
      summaries: [],
    });
    await expect(
      runRemoteCheck(reference, configuration({ rulesets: [] })),
    ).resolves.toBeUndefined();
  });

  it('skips a declared ruleset with no name', async () => {
    await expect(
      runRemoteCheck(reference, configuration({ rulesets: [{ id: 1 }] })),
    ).resolves.toBeUndefined();
  });

  it('ignores a ruleset summary GitHub returned without an id or name', async () => {
    requestRulesetSummariesMock.mockResolvedValue({
      available: true,
      summaries: ['unexpected', { id: 1, name: 'main' }],
    });
    await expect(
      runRemoteCheck(reference, configuration()),
    ).resolves.toBeUndefined();
  });

  it('ignores an environment entry GitHub returned without a name', async () => {
    respondWith({
      '/environments?per_page=100': {
        environments: ['unexpected', { name: 'production' }],
      },
    });
    await expect(
      runRemoteCheck(reference, configuration()),
    ).resolves.toBeUndefined();
  });

  it('reports an environment that is missing', async () => {
    respondWith({ '/environments?per_page=100': { environments: [] } });
    await expect(runRemoteCheck(reference, configuration())).rejects.toThrow(
      'environment production is missing',
    );
  });

  it('rejects an environment listing that is not an environments array', async () => {
    respondWith({ '/environments?per_page=100': {} });
    await expect(runRemoteCheck(reference, configuration())).rejects.toThrow(
      'Listing repository environments returned an invalid response',
    );
  });

  it('rejects an environment response that is not an object', async () => {
    respondWith({ '/environments/production': [] });
    await expect(runRemoteCheck(reference, configuration())).rejects.toThrow(
      'Reading environment production returned an invalid response',
    );
  });

  it('skips a declared environment with no name', async () => {
    await expect(
      runRemoteCheck(reference, configuration({ environments: [{}] })),
    ).resolves.toBeUndefined();
  });

  it('reports a required repository secret that is absent', async () => {
    respondWith({ '/actions/secrets?per_page=100': { secrets: [] } });
    await expect(runRemoteCheck(reference, configuration())).rejects.toThrow(
      /GH_ADMIN_TOKEN/,
    );
  });

  it('reports a required environment secret that is absent', async () => {
    respondWith({
      '/environments/production/secrets?per_page=100': { secrets: [] },
    });
    await expect(runRemoteCheck(reference, configuration())).rejects.toThrow(
      /DEPLOY_KEY/,
    );
  });

  it('collects every drift into one error', async () => {
    respondWith({
      '': { default_branch: 'master' },
      '/environments?per_page=100': { environments: [] },
    });
    await expect(runRemoteCheck(reference, configuration())).rejects.toThrow(
      /repository settings[\s\S]*environment production is missing/,
    );
  });

  it('names the operation and the drift path for each failing call', async () => {
    const failures = [
      ['', 'Reading repository settings failed with HTTP 500: boom'],
      ['/rulesets/1', 'Reading ruleset main failed with HTTP 500: boom'],
      [
        '/environments?per_page=100',
        'Listing repository environments failed with HTTP 500: boom',
      ],
      [
        '/environments/production',
        'Reading environment production failed with HTTP 500: boom',
      ],
      [
        '/actions/secrets?per_page=100',
        'Listing repository secrets failed with HTTP 500: boom',
      ],
      [
        '/environments/production/secrets?per_page=100',
        'Listing secrets for environment production failed with HTTP 500: boom',
      ],
    ] as const;

    for (const [failingPath, message] of failures) {
      respondWith();
      const healthy = requestMock.getMockImplementation();
      requestMock.mockImplementation((reference_: unknown, path: string) =>
        path === failingPath
          ? Promise.resolve({ status: 500, body: { message: 'boom' } })
          : (healthy as (a: unknown, b: string) => Promise<unknown>)(
              reference_,
              path,
            ),
      );
      await expect(runRemoteCheck(reference, configuration())).rejects.toThrow(
        message,
      );
    }
  });

  it('lists rulesets under the operation name the drift report uses', async () => {
    await runRemoteCheck(reference, configuration());
    expect(requestRulesetSummariesMock).toHaveBeenCalledWith(
      reference,
      'Listing repository rulesets',
    );
  });

  it('reports the drifted repository field, not just that something drifted', async () => {
    respondWith({ '': { default_branch: 'master' } });
    await expect(runRemoteCheck(reference, configuration())).rejects.toThrow(
      'GitHub settings drift detected for owner/name:\n' +
        '- repository settings\n' +
        '  desired: {"default_branch":"main"}\n' +
        '  actual:  {"default_branch":"master"}',
    );
  });

  it('reports a ruleset drift under the ruleset name', async () => {
    respondWith({
      '/rulesets/1': { name: 'main', target: 'tag', enforcement: 'active' },
    });
    await expect(runRemoteCheck(reference, configuration())).rejects.toThrow(
      /- ruleset main\n {2}desired: /,
    );
  });

  it('reports an environment drift under the environment name', async () => {
    respondWith({
      '/environments/production': { wait_timer: 30 },
    });
    await expect(runRemoteCheck(reference, configuration())).rejects.toThrow(
      /- environment production\n {2}desired: /,
    );
  });

  it('names the scope of a missing secret', async () => {
    respondWith({
      '/actions/secrets?per_page=100': { secrets: [] },
      '/environments/production/secrets?per_page=100': { secrets: [] },
    });
    await expect(runRemoteCheck(reference, configuration())).rejects.toThrow(
      /- repository secret GH_ADMIN_TOKEN[\s\S]*- environment production secret DEPLOY_KEY/,
    );
  });

  it('ignores a ruleset summary that has an id but no name', async () => {
    requestRulesetSummariesMock.mockResolvedValue({
      available: true,
      summaries: [{ id: 1 }],
    });
    await expect(runRemoteCheck(reference, configuration())).rejects.toThrow(
      'ruleset main is missing',
    );
  });

  it('ignores a ruleset summary that has a name but no numeric id', async () => {
    requestRulesetSummariesMock.mockResolvedValue({
      available: true,
      summaries: [{ id: 'one', name: 'main' }],
    });
    await expect(runRemoteCheck(reference, configuration())).rejects.toThrow(
      'ruleset main is missing',
    );
  });

  it('matches the declared ruleset by name among several rulesets', async () => {
    requestRulesetSummariesMock.mockResolvedValue({
      available: true,
      summaries: [
        { id: 9, name: 'release' },
        { id: 1, name: 'main' },
      ],
    });
    await expect(
      runRemoteCheck(reference, configuration()),
    ).resolves.toBeUndefined();
  });

  it('matches the declared environment by name among several environments', async () => {
    respondWith({
      '/environments?per_page=100': {
        environments: [{ name: 'staging' }, { name: 'production' }],
      },
    });
    await expect(
      runRemoteCheck(reference, configuration()),
    ).resolves.toBeUndefined();
  });

  it('ignores an environment entry whose name is not a string', async () => {
    respondWith({
      '/environments?per_page=100': { environments: [{ name: 7 }] },
    });
    await expect(runRemoteCheck(reference, configuration())).rejects.toThrow(
      'environment production is missing',
    );
  });

  describe('security features', () => {
    const declared = configuration({
      repository: {
        default_branch: 'main',
        vulnerability_alerts: true,
        automated_security_fixes: true,
      },
    });

    function securityResponses(
      alerts: { status: number; body?: unknown },
      fixes: { status: number; body?: unknown },
    ): void {
      respondWith();
      const fallback = requestMock.getMockImplementation() as (
        requestReference: unknown,
        path: string,
      ) => Promise<unknown>;
      const switches: Record<string, unknown> = {
        '/vulnerability-alerts': alerts,
        '/automated-security-fixes': fixes,
      };
      requestMock.mockImplementation(
        (requestReference: unknown, path: string): Promise<unknown> =>
          path in switches
            ? Promise.resolve(switches[path])
            : fallback(requestReference, path),
      );
    }

    function requestedPaths(): string[] {
      const calls = requestMock.mock.calls as [unknown, string][];
      return calls.map(([, path]) => path);
    }

    it('reads nothing when no switch is declared', async () => {
      await runRemoteCheck(reference, configuration());
      const paths = requestedPaths();
      expect(paths).not.toContain('/vulnerability-alerts');
      expect(paths).not.toContain('/automated-security-fixes');
    });

    it('matches when both switches are on', async () => {
      securityResponses(
        { status: 204 },
        { status: 200, body: { enabled: true, paused: false } },
      );
      await expect(
        runRemoteCheck(reference, declared),
      ).resolves.toBeUndefined();
    });

    it('reports alerts that are off, and security updates unavailable because of it', async () => {
      securityResponses({ status: 404 }, { status: 404 });
      await expect(runRemoteCheck(reference, declared)).rejects.toThrow(
        'repository security features\n  desired: {"automated_security_fixes":true,"vulnerability_alerts":true}\n  actual:  {"automated_security_fixes":false,"vulnerability_alerts":false}',
      );
    });

    it('reports security updates that are switched off', async () => {
      securityResponses(
        { status: 204 },
        { status: 200, body: { enabled: false } },
      );
      await expect(runRemoteCheck(reference, declared)).rejects.toThrow(
        '"automated_security_fixes":false,"vulnerability_alerts":true}',
      );
    });

    it('matches a switch that is declared off and is off', async () => {
      securityResponses({ status: 404 }, { status: 404 });
      await expect(
        runRemoteCheck(
          reference,
          configuration({
            repository: {
              default_branch: 'main',
              vulnerability_alerts: false,
              automated_security_fixes: false,
            },
          }),
        ),
      ).resolves.toBeUndefined();
    });

    it('names the switch when GitHub refuses to report it', async () => {
      securityResponses(
        { status: 403, body: { message: 'Must have admin rights' } },
        { status: 200, body: { enabled: true } },
      );
      await expect(runRemoteCheck(reference, declared)).rejects.toThrow(
        'Reading vulnerability_alerts failed with HTTP 403: Must have admin rights',
      );
    });

    it('rejects a security updates response without an enabled flag', async () => {
      securityResponses(
        { status: 204 },
        { status: 200, body: { enabled: 'yes' } },
      );
      await expect(runRemoteCheck(reference, declared)).rejects.toThrow(
        'Reading automated_security_fixes returned an invalid response',
      );
    });

    it('rejects a security updates response that is not an object', async () => {
      securityResponses({ status: 204 }, { status: 200, body: null });
      await expect(runRemoteCheck(reference, declared)).rejects.toThrow(
        'Reading automated_security_fixes returned an invalid response',
      );
    });
  });
});
