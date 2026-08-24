import { Hono } from 'hono';
import type { AppBindings } from '../../env';

export const dashboardRoutes = new Hono<AppBindings>();
