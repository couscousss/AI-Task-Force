import { Hono } from 'hono';
import type { AppBindings } from '../env';

export const participantRoutes = new Hono<AppBindings>();
