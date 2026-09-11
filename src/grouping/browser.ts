/**
 * Browser entry point for the grouping engine.
 *
 * The solver is a pure module — no D1, no fetch, no clock in any decision — so it runs
 * identically here and on the server. It runs in the browser because a Worker on
 * Cloudflare's free plan is cut off at 10ms of CPU per request, and balancing needs
 * 12-60ms depending on the size of the pool.
 *
 * Bundled to public/solver.js by `npm run build:solver`, which `npm run dev` and
 * `npm run deploy` both do for you.
 *
 * `globalThis` rather than `window` so this file typechecks against the Workers types
 * the rest of the project uses; esbuild targets the browser regardless.
 */
import { solve, evaluateArrangement } from './index';

export interface BuilderDaySolver {
  solve: typeof solve;
  evaluateArrangement: typeof evaluateArrangement;
}

(globalThis as unknown as { BuilderDaySolver: BuilderDaySolver }).BuilderDaySolver = {
  solve,
  evaluateArrangement,
};
