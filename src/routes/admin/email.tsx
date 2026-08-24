import { Hono } from 'hono';
import type { AppBindings } from '../../env';

export const emailAdminRoutes = new Hono<AppBindings>();
