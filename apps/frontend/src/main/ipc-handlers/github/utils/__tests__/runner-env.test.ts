import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetAPIProfileEnv = vi.fn();
const mockGetOAuthModeClearVars = vi.fn();
const mockGetPythonEnv = vi.fn();

vi.mock('../../../../services/profile', () => ({
  getAPIProfileEnv: (...args: unknown[]) => mockGetAPIProfileEnv(...args),
}));

vi.mock('../../../../agent/env-utils', () => ({
  getOAuthModeClearVars: (...args: unknown[]) => mockGetOAuthModeClearVars(...args),
}));

vi.mock('../../../../python-env-manager', () => ({
  pythonEnvManager: {
    getPythonEnv: () => mockGetPythonEnv(),
  },
}));

import { getRunnerEnv } from '../runner-env';

describe('getRunnerEnv', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock for Python env - minimal env for testing
    mockGetPythonEnv.mockReturnValue({
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONNOUSERSITE: '1',
      PYTHONPATH: '/bundled/site-packages',
    });
  });

  it('merges Python env with API profile env and OAuth clear vars', async () => {
    mockGetAPIProfileEnv.mockResolvedValue({
      ANTHROPIC_AUTH_TOKEN: 'token',
      ANTHROPIC_BASE_URL: 'https://api.example.com',
    });
    mockGetOAuthModeClearVars.mockReturnValue({
      ANTHROPIC_AUTH_TOKEN: '',
    });

    const result = await getRunnerEnv();

    expect(mockGetOAuthModeClearVars).toHaveBeenCalledWith({
      ANTHROPIC_AUTH_TOKEN: 'token',
      ANTHROPIC_BASE_URL: 'https://api.example.com',
    });
    // Python env is included first, then overridden by OAuth clear vars
    expect(result).toMatchObject({
      PYTHONPATH: '/bundled/site-packages',
      PYTHONDONTWRITEBYTECODE: '1',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: 'https://api.example.com',
    });
  });

  it('includes extra env values with highest precedence', async () => {
    mockGetAPIProfileEnv.mockResolvedValue({
      ANTHROPIC_AUTH_TOKEN: 'token',
    });
    mockGetOAuthModeClearVars.mockReturnValue({});

    const result = await getRunnerEnv({ USE_CLAUDE_MD: 'true' });

    expect(result).toMatchObject({
      PYTHONPATH: '/bundled/site-packages',
      ANTHROPIC_AUTH_TOKEN: 'token',
      USE_CLAUDE_MD: 'true',
    });
  });

  it('includes PYTHONPATH for bundled packages (fixes #139)', async () => {
    mockGetAPIProfileEnv.mockResolvedValue({});
    mockGetOAuthModeClearVars.mockReturnValue({});
    mockGetPythonEnv.mockReturnValue({
      PYTHONPATH: '/app/Contents/Resources/python-site-packages',
    });

    const result = await getRunnerEnv();

    expect(result.PYTHONPATH).toBe('/app/Contents/Resources/python-site-packages');
  });
});
