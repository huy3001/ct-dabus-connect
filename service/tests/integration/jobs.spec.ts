import request from 'supertest';
import app from '../../src/app';
import { getDabusJobs } from '../../src/services/dabusJobs.service';

jest.mock('../../src/utils/config.utils');
jest.mock('../../src/services/dabusJobs.service', () => ({
  getDabusJobs: jest.fn(),
}));

describe('GET /service/api/dabus/jobs', () => {
  const originalSkipAuth = process.env.SKIP_MC_AUTH;

  beforeEach(() => {
    process.env.SKIP_MC_AUTH = 'true';
    jest.mocked(getDabusJobs).mockReset();
  });

  afterAll(() => {
    if (originalSkipAuth === undefined) {
      delete process.env.SKIP_MC_AUTH;
    } else {
      process.env.SKIP_MC_AUTH = originalSkipAuth;
    }
  });

  it('returns the stateless jobs response', async () => {
    const result = {
      fetchedAt: '2026-11-20T12:10:00.000Z',
      pastJobs: [],
      upcomingJobs: [],
    };
    jest.mocked(getDabusJobs).mockResolvedValue(result);

    const response = await request(app).get('/service/api/dabus/jobs');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(result);
  });

  it('returns 401 without a Merchant Center session token', async () => {
    process.env.SKIP_MC_AUTH = 'false';
    process.env.MC_APP_URL = 'https://service.example';
    process.env.MC_ISSUER = 'https://mc-api.us-east-2.aws.commercetools.com';
    const response = await request(app).get('/service/api/dabus/jobs');

    expect(response.status).toBe(401);
  });
});
