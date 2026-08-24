import type { SolverParams } from '../config';
import type { SkillVector } from '../types';

export type { SolverParams };

/**
 * The only shape the solver ever sees. Note there is no email and no token: the
 * grouping engine has no business with contact details.
 */
export interface SolverParticipant {
  id: string;
  name: string | null;
  department: string | null;
  category: string | null;
  skills: SkillVector;
  has_laptop: boolean;
}

/** Output of the clustering step (LLM or category fallback), after validation. */
export interface Theme {
  label: string;
  summary: string;
  participant_ids: string[];
}

export interface SolverInput {
  participants: SolverParticipant[];
  themes: Theme[];
  params: SolverParams;
  seed: number;
}

export interface SolvedTeam {
  /** Stable 0-based index; also the display order. */
  index: number;
  theme_label: string;
  theme_summary: string;
  member_ids: string[];
}

export interface ScoreBreakdown {
  theme_cohesion: number;
  skill_diversity: number;
  across_team_balance: number;
  category_match: number;
  department_mixing: number;
  /** Sum of the components multiplied by their configured weights. */
  weighted_total: number;
}

export type ViolationCode = 'H1' | 'H2' | 'H3' | 'H4';

export interface Violation {
  code: ViolationCode;
  /**
   * A complete sentence an organizer can act on, e.g.
   * "H3: 3 teams have no member rating themselves 3+ on Building. Only 6 such
   *  participants across 9 teams. Consider pairing these teams or recruiting a facilitator."
   */
  message: string;
  /** Team indexes affected. Empty for pool-level statements. */
  team_indexes: number[];
  /** 'pool' = the participant pool cannot satisfy this; 'team' = this arrangement does not. */
  scope: 'pool' | 'team';
}

export interface SolverStats {
  team_count: number;
  attending_count: number;
  local_search_iterations: number;
  local_search_improvements: number;
  repair_swaps: number;
  duration_ms: number;
}

export interface SolverResult {
  teams: SolvedTeam[];
  /**
   * participant id -> the theme key the solver actually scored against. This is the
   * POST-merge bucket, not the raw clustering label, so anything that re-scores an
   * arrangement later (the review board) gets the same number for untouched teams.
   */
  theme_of: Record<string, string>;
  score: ScoreBreakdown;
  violations: Violation[];
  stats: SolverStats;
}

/** Result of evaluating an arbitrary (e.g. hand-edited) arrangement. */
export interface Evaluation {
  score: ScoreBreakdown;
  violations: Violation[];
  /** Per-team violation messages, keyed by team index, for inline display. */
  per_team: Record<number, string[]>;
}

/** A team arrangement being evaluated — e.g. one the organizer just dragged people around in. */
export interface ArrangementTeam {
  index: number;
  theme_label: string;
  member_ids: string[];
}
