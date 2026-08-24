import { Hono } from 'hono';
import type { AppBindings } from '../../env';

export const inviteRoutes = new Hono<AppBindings>();
