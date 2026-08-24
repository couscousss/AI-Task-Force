/**
 * Pure grouping engine. Nothing in `src/grouping/` may import D1, fetch, or any Worker
 * binding: it takes data in and returns teams out, so it can be tested at speed with
 * generated fixtures and re-run deterministically from a stored seed.
 */
export * from './types';
export { solve } from './solver';
export { evaluateArrangement } from './constraints';
export { computeTeamCount, computeTeamSizes } from './solver';
