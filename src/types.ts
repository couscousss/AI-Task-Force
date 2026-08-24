import type { SkillAxis } from './config';

/** The four-dimensional capability vector. Never reduced to a scalar as a solver input. */
export type SkillVector = Record<SkillAxis, number>;

/** A row of `participants`, as stored. */
export interface ParticipantRow {
  id: string;
  token: string;
  email: string;
  name: string | null;
  department: string | null;
  /** NULL = no response yet, 0 = declined, 1 = attending, 2 = not sure yet. */
  attending: number | null;
  problem_statement: string | null;
  category: string | null;
  skill_understanding: number | null;
  skill_tools: number | null;
  skill_prompting: number | null;
  skill_building: number | null;
  has_personal_laptop: number | null;
  hopes: string | null;
  submitted_at: string | null;
  updated_at: string | null;
}

export type RunStatus = 'pending' | 'clustering' | 'solving' | 'naming' | 'done' | 'failed';

export interface GroupingRunRow {
  id: string;
  status: RunStatus;
  seed: number;
  params_json: string;
  themes_json: string | null;
  score_json: string | null;
  violations_json: string | null;
  error: string | null;
  progress: string | null;
  is_published: number;
  created_at: string;
  completed_at: string | null;
}

export interface TeamRow {
  id: string;
  run_id: string;
  name: string | null;
  theme_label: string | null;
  project_brief: string | null;
  rationale: string | null;
  sort_order: number;
}

export interface TeamMemberRow {
  team_id: string;
  participant_id: string;
  is_manual_override: number;
}

export type EmailKind = 'invite' | 'reminder' | 'team_announcement';

export interface EmailLogRow {
  id: string;
  participant_id: string | null;
  kind: EmailKind;
  sent_at: string;
  provider_id: string | null;
  status: string | null;
}
