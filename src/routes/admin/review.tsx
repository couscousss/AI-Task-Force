import { Hono } from 'hono';
import type { AppBindings } from '../../env';

export const reviewRoutes = new Hono<AppBindings>();
