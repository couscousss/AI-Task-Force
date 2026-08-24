import { Hono } from 'hono';
import type { AppBindings } from '../../env';

export const runRoutes = new Hono<AppBindings>();
