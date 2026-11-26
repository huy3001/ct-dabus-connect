import { Router } from 'express';
import { get as getJobs } from '../controllers/jobs.controller';
import { post as postWebhook } from '../controllers/webhook.controller';
import { mcAuth } from '../middleware/mcAuth.middleware';

const serviceRouter = Router();

serviceRouter.get('/api/dabus/jobs', mcAuth, async (req, res, next) => {
  try {
    await getJobs(req, res);
  } catch (error) {
    next(error);
  }
});

serviceRouter.post('/webhooks/dabus', async (req, res, next) => {
  try {
    await postWebhook(req, res);
  } catch (error) {
    next(error);
  }
});

export default serviceRouter;
