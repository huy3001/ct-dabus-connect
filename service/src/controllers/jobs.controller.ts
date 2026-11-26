import { Request, Response } from 'express';
import { getDabusJobs } from '../services/dabusJobs.service';
import { logger } from '../utils/logger.utils';

export async function get(_request: Request, response: Response): Promise<void> {
  logger.info('Fetching stateless Dabus job status');
  response.status(200).json(await getDabusJobs());
}
