import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() =>
  vi.fn<
    (
      file: string,
      args: readonly string[],
      options: unknown,
      callback: (error: unknown, stdout: { stdout: string }) => void,
    ) => void
  >(),
);

vi.mock('node:child_process', () => ({ execFile: execFileMock }));

const {
  getRepositoryReference,
  request,
  requestRulesetSummaries,
  requireApiSuccess,
} = await import('./github-api.ts');

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: () => Promise.resolve(body) } as unknown as Response;
}

function gitRemote(url: string): void {
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    callback(null, { stdout: url });
  });
}

beforeEach(() => {
  vi.stubEnv('GITHUB_REPOSITORY', '');
  vi.stubEnv('GH_TOKEN', 'token');
  vi.stubEnv('GITHUB_TOKEN', '');
});

describe('getRepositoryReference', () => {
  it('prefers GITHUB_REPOSITORY over the git remote', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'owner/name');
    await expect(getRepositoryReference('/repo')).resolves.toStrictEqual({
      owner: 'owner',
      name: 'name',
    });
  });

  it('rejects a GITHUB_REPOSITORY that is not OWNER/REPOSITORY', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'owner-only');
    await expect(getRepositoryReference('/repo')).rejects.toThrow(
      'GITHUB_REPOSITORY must use OWNER/REPOSITORY format: owner-only',
    );
  });

  it('rejects a GITHUB_REPOSITORY with an empty half', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'owner/');
    await expect(getRepositoryReference('/repo')).rejects.toThrow(
      'GITHUB_REPOSITORY must use OWNER/REPOSITORY format',
    );
  });

  it('falls back to the origin remote', async () => {
    gitRemote('git@github.com:owner/name.git\n');
    await expect(getRepositoryReference('/repo')).resolves.toStrictEqual({
      owner: 'owner',
      name: 'name',
    });
  });

  it('reports a git failure as an unreadable origin remote', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error('no remote'), { stdout: '' });
    });
    await expect(getRepositoryReference('/repo')).rejects.toThrow(
      'Unable to read the origin remote from git',
    );
  });

  it('reports an origin remote that is not a GitHub repository', async () => {
    gitRemote('https://example.com/not-github\n');
    await expect(getRepositoryReference('/repo')).rejects.toThrow(
      'Unable to determine the GitHub repository from GITHUB_REPOSITORY or origin',
    );
  });
});

describe('request', () => {
  const reference = { owner: 'owner', name: 'name' } as const;

  it('sends an authenticated GET with no body', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { ok: true })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(request(reference, '/rulesets')).resolves.toStrictEqual({
      status: 200,
      body: { ok: true },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.github.com/repos/owner/name/rulesets');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer token');
    expect(new Headers(init.headers).get('Content-Type')).toBeNull();
  });

  it('returns no body for a 204 without trying to parse one', async () => {
    const json = vi.fn(() => Promise.reject(new Error('no body')));
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({ status: 204, json } as unknown as Response),
      ),
    );

    await expect(
      request(reference, '/vulnerability-alerts'),
    ).resolves.toStrictEqual({ status: 204, body: undefined });
    expect(json).not.toHaveBeenCalled();
  });

  it('serializes a body and sets its content type', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(201, {})));
    vi.stubGlobal('fetch', fetchMock);

    await request(reference, '/rulesets', 'POST', { name: 'main' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"name":"main"}');
    expect(new Headers(init.headers).get('Content-Type')).toBe(
      'application/json',
    );
  });

  it('percent-encodes the owner and repository in the URL', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, {})));
    vi.stubGlobal('fetch', fetchMock);

    await request({ owner: 'own er', name: 'na/me' }, '');
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://api.github.com/repos/own%20er/na%2Fme');
  });

  it('accepts GITHUB_TOKEN when GH_TOKEN is unset', async () => {
    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', 'fallback');
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, {})));
    vi.stubGlobal('fetch', fetchMock);

    await request(reference, '');
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer fallback',
    );
  });

  it('refuses to call GitHub with no token', async () => {
    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', '');
    await expect(request(reference, '')).rejects.toThrow(
      'Remote operations require GH_TOKEN or GITHUB_TOKEN',
    );
  });
});

describe('requireApiSuccess', () => {
  it('returns the body of a successful response', () => {
    expect(
      requireApiSuccess({ status: 200, body: { a: 1 } }, 'op'),
    ).toStrictEqual({ a: 1 });
  });

  it('uses the API error message when GitHub supplies one', () => {
    expect(() =>
      requireApiSuccess(
        { status: 404, body: { message: 'Not Found' } },
        'Reading',
      ),
    ).toThrow('Reading failed with HTTP 404: Not Found');
  });

  it('falls back to the raw body when there is no message', () => {
    expect(() =>
      requireApiSuccess({ status: 500, body: [1] }, 'Reading'),
    ).toThrow('Reading failed with HTTP 500: [1]');
  });

  it('rejects a status below the success range', () => {
    expect(() =>
      requireApiSuccess({ status: 100, body: {} }, 'Reading'),
    ).toThrow('Reading failed with HTTP 100');
  });
});

describe('requestRulesetSummaries', () => {
  const reference = { owner: 'owner', name: 'name' } as const;

  it('returns a single short page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(200, [{ id: 1 }]))),
    );
    await expect(
      requestRulesetSummaries(reference, 'Listing'),
    ).resolves.toStrictEqual({ available: true, summaries: [{ id: 1 }] });
  });

  it('follows pagination until a page is short', async () => {
    const firstPage = Array.from({ length: 100 }, (_value, index) => ({
      id: index,
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, firstPage))
      .mockResolvedValueOnce(jsonResponse(200, [{ id: 100 }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await requestRulesetSummaries(reference, 'Listing');
    expect(result.summaries).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain('page=2');
  });

  it('treats the plan/visibility 403 as rulesets being unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(403, {
            message: 'Upgrade to GitHub Pro or make this repository public.',
          }),
        ),
      ),
    );
    await expect(
      requestRulesetSummaries(reference, 'Listing'),
    ).resolves.toStrictEqual({ available: false, summaries: [] });
  });

  it('does not hide an ordinary 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(jsonResponse(403, { message: 'Bad credentials' })),
      ),
    );
    await expect(requestRulesetSummaries(reference, 'Listing')).rejects.toThrow(
      'Listing failed with HTTP 403: Bad credentials',
    );
  });

  it('rejects a response that is not an array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(200, { rulesets: [] }))),
    );
    await expect(requestRulesetSummaries(reference, 'Listing')).rejects.toThrow(
      'Listing returned an invalid response',
    );
  });
});

describe('getRepositoryReference details', () => {
  it('asks git for the origin remote in the given repository', async () => {
    gitRemote('git@github.com:owner/name.git\n');
    await getRepositoryReference('/repo');
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['config', '--get', 'remote.origin.url'],
      { cwd: '/repo', encoding: 'utf8' },
      expect.any(Function),
    );
  });

  it('rejects a GITHUB_REPOSITORY with an empty owner', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', '/name');
    await expect(getRepositoryReference('/repo')).rejects.toThrow(
      'GITHUB_REPOSITORY must use OWNER/REPOSITORY format: /name',
    );
  });
});

describe('request status handling', () => {
  const reference = { owner: 'owner', name: 'name' } as const;

  it('accepts the last success status', () => {
    expect(requireApiSuccess({ status: 299, body: 'ok' }, 'op')).toBe('ok');
  });

  it('rejects the first redirect status', () => {
    expect(() => requireApiSuccess({ status: 300, body: {} }, 'op')).toThrow(
      'op failed with HTTP 300',
    );
  });

  it('falls back to the raw body when the message is not a string', () => {
    expect(() =>
      requireApiSuccess({ status: 404, body: { message: 7 } }, 'op'),
    ).toThrow('op failed with HTTP 404: {"message":7}');
  });

  it('sends the API version header GitHub pins responses to', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, {})));
    vi.stubGlobal('fetch', fetchMock);
    await request(reference, '');
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const headers = new Headers(init.headers);
    expect(headers.get('X-GitHub-Api-Version')).toBe('2022-11-28');
    expect(headers.get('Accept')).toBe('application/vnd.github+json');
  });
});

describe('requestRulesetSummaries paging details', () => {
  const reference = { owner: 'owner', name: 'name' } as const;

  it('requests a full page at a time', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, [])));
    vi.stubGlobal('fetch', fetchMock);
    await requestRulesetSummaries(reference, 'Listing');
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe(
      'https://api.github.com/repos/owner/name/rulesets?per_page=100&page=1',
    );
  });

  it('treats the plan 403 as unavailable only on the first page', async () => {
    const firstPage = Array.from({ length: 100 }, (_value, index) => ({
      id: index,
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, firstPage))
      .mockResolvedValueOnce(
        jsonResponse(403, {
          message: 'Upgrade to GitHub Pro or make this repository public.',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestRulesetSummaries(reference, 'Listing')).rejects.toThrow(
      'Listing failed with HTTP 403',
    );
  });

  it('does not treat a non-403 plan message as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(404, {
            message: 'Upgrade to GitHub Pro or make this repository public.',
          }),
        ),
      ),
    );
    await expect(requestRulesetSummaries(reference, 'Listing')).rejects.toThrow(
      'Listing failed with HTTP 404',
    );
  });

  it('does not treat a 403 without a message as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(403, ['forbidden']))),
    );
    await expect(requestRulesetSummaries(reference, 'Listing')).rejects.toThrow(
      'Listing failed with HTTP 403: ["forbidden"]',
    );
  });
});
