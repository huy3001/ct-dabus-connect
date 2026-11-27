import { createSessionAuthVerifier } from '@commercetools-backend/express';
import request from 'supertest';
import app from '../../src/app';
import { getDabusJobs } from '../../src/services/dabusJobs.service';

jest.mock('../../src/utils/config.utils');
jest.mock('../../src/services/dabusJobs.service');
jest.mock('@commercetools-backend/express', () => ({
  createSessionAuthVerifier: jest.fn(),
}));

describe('jobs permission enforcement', () => {
  const originalEnv = { ...process.env };
  const verify = jest.fn();

  beforeEach(() => {
    process.env.SKIP_MC_AUTH = 'false';
    process.env.MC_APP_URL = 'https://service.example';
    process.env.MC_ISSUER = 'aws-us';
    jest.mocked(createSessionAuthVerifier).mockReturnValue(verify);
    jest.mocked(getDabusJobs).mockResolvedValue({
      fetchedAt: '2026-11-20T12:10:00.000Z',
      pastJobs: [],
      upcomingJobs: [],
    });
    verify.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  it.each(['canViewDabusJobs', 'canManageDabusJobs'])(
    'allows a verified session with %s',
    async (permission) => {
      verify.mockImplementation(async (req: object) => {
        Object.assign(req, {
          session: { projectKey: 'mockedProjectKey', userPermissions: [permission] },
        });
      });

      const response = await request(app).get('/service/api/dabus/jobs');

      expect(response.status).toBe(200);
      expect(getDabusJobs).toHaveBeenCalledTimes(1);
    }
  );

  it('uses the service URL origin when verifying the audience', async () => {
    process.env.MC_APP_URL = 'https://service.example/service';
    verify.mockImplementation(async (req: object) => {
      Object.assign(req, {
        session: {
          projectKey: 'mockedProjectKey',
          userPermissions: ['canViewDabusJobs'],
        },
      });
    });

    const response = await request(app).get('/service/api/dabus/jobs');

    expect(response.status).toBe(200);
    expect(createSessionAuthVerifier).toHaveBeenCalledWith(
      expect.objectContaining({ audience: 'https://service.example' })
    );
  });

  it('rejects a malformed service URL', async () => {
    process.env.MC_APP_URL = 'not-a-url';

    const response = await request(app).get('/service/api/dabus/jobs');

    expect(response.status).toBe(500);
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([undefined, ['canViewOrders']])(
    'denies a verified session without a jobs permission',
    async (permissions) => {
      verify.mockImplementation(async (req: object) => {
        Object.assign(req, {
          session: { projectKey: 'mockedProjectKey', userPermissions: permissions },
        });
      });

      const response = await request(app).get('/service/api/dabus/jobs');

      expect(response.status).toBe(403);
      expect(getDabusJobs).not.toHaveBeenCalled();
    }
  );

  it('denies a session from another project', async () => {
    verify.mockImplementation(async (req: object) => {
      Object.assign(req, {
        session: {
          projectKey: 'another-project',
          userPermissions: ['canViewDabusJobs'],
        },
      });
    });

    const response = await request(app).get('/service/api/dabus/jobs');

    expect(response.status).toBe(403);
    expect(getDabusJobs).not.toHaveBeenCalled();
  });

  it('rejects an invalid session', async () => {
    verify.mockRejectedValue(new Error('Invalid token'));

    const response = await request(app).get('/service/api/dabus/jobs');

    expect(response.status).toBe(401);
    expect(getDabusJobs).not.toHaveBeenCalled();
  });
});
