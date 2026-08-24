import { Hono } from 'hono';
import type { AppBindings } from '../env';

export const publicTeamRoutes = new Hono<AppBindings>();
