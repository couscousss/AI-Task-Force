import { Hono } from 'hono';
import type { AppBindings } from '../../env';

export const participantAdminRoutes = new Hono<AppBindings>();
