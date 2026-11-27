import { createSessionAuthVerifier } from '@commercetools-backend/express';
import { NextFunction, Request, Response } from 'express';
import CustomError from '../errors/custom.error';
import { readConfiguration } from '../utils/config.utils';
import { logger } from '../utils/logger.utils';

const ISSUER_BY_REGION: Record<string, string> = {
  'australia-southeast1.gcp': 'gcp-au',
  'europe-west1.gcp': 'gcp-eu',
  'us-central1.gcp': 'gcp-us',
  'eu-central-1.aws': 'aws-eu',
  'us-east-2.aws': 'aws-us',
};

export async function mcAuth(
  request: Request,
  _response: Response,
  next: NextFunction
): Promise<void> {
  if (process.env.SKIP_MC_AUTH === 'true') {
    next();
    return;
  }

  const serviceUrl =
    process.env.MC_APP_URL ?? process.env.CONNECT_SERVICE_URL;
  const issuer =
    process.env.MC_ISSUER ??
    ISSUER_BY_REGION[process.env.CTP_REGION ?? 'us-east-2.aws'];
  if (!serviceUrl || !issuer) {
    next(
      new CustomError(
        500,
        'Merchant Center session auth requires MC_APP_URL or CONNECT_SERVICE_URL and a supported CTP_REGION'
      )
    );
    return;
  }

  let audience: URL;
  try {
    audience = new URL(serviceUrl);
  } catch {
    next(new CustomError(500, 'Merchant Center service URL is invalid'));
    return;
  }
  if (audience.protocol !== 'https:' && audience.protocol !== 'http:') {
    next(new CustomError(500, 'Merchant Center service URL must use HTTP or HTTPS'));
    return;
  }

  const sessionRequest: Request & {
    session?: { projectKey: string; userPermissions?: string[] };
  } = request;

  try {
    await createSessionAuthVerifier({
      audience: audience.origin,
      issuer,
      inferIssuer: true,
    })(sessionRequest);
  } catch (error) {
    logger.warn(
      `Merchant Center session verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    next(new CustomError(401, 'Merchant Center session is invalid'));
    return;
  }

  const permissions = sessionRequest.session?.userPermissions;
  if (
    sessionRequest.session?.projectKey !== readConfiguration().projectKey ||
    (!permissions?.includes('canViewDabusJobs') &&
      !permissions?.includes('canManageDabusJobs'))
  ) {
    next(new CustomError(403, 'Dabus Jobs permission is required'));
    return;
  }

  next();
}
