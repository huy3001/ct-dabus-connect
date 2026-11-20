import { Router } from 'express';
import { post } from '../controllers/webhook.controller';

const serviceRouter = Router();

serviceRouter.post('/webhooks/dabus', async (req, res, next) => {
  try {
    await post(req, res);
  } catch (error) {
    next(error);
  }
});

export default serviceRouter;
