import { Hono } from 'hono';
import type { AppBindings } from '../../env';
import { requireAdmin } from '../../lib/auth';
import { dashboardRoutes } from './dashboard';
import { participantAdminRoutes } from './participants';
import { inviteRoutes } from './invites';
import { runRoutes } from './runs';
import { reviewRoutes } from './review';
import { emailAdminRoutes } from './email';

export const adminRoutes = new Hono<AppBindings>();

// Cloudflare Access sits in front of /admin/* in production; this reads the header it
// sets and falls back to DEV_ADMIN_EMAIL under `wrangler dev`.
adminRoutes.use('*', requireAdmin);

adminRoutes.route('/', dashboardRoutes);
adminRoutes.route('/participants', participantAdminRoutes);
adminRoutes.route('/invites', inviteRoutes);
adminRoutes.route('/runs', runRoutes);
adminRoutes.route('/review', reviewRoutes);
adminRoutes.route('/email', emailAdminRoutes);
