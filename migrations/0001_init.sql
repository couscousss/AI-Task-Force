-- SECC AI Builder Day — initial schema.
--
-- Two deliberate additions to the schema in the build spec, both recorded in DECISIONS.md:
--   * participants.attending also accepts 2 = "not sure yet", because the form offers it.
--   * grouping_runs.progress holds a short human-readable progress line for the polling UI.

CREATE TABLE IF NOT EXISTS participants (
  id                    TEXT PRIMARY KEY,
  token                 TEXT UNIQUE NOT NULL,
  email                 TEXT UNIQUE NOT NULL,
  name                  TEXT,
  department            TEXT,
  attending             INTEGER,               -- NULL = no response, 0 = declined, 1 = attending, 2 = not sure
  problem_statement     TEXT,
  category              TEXT,
  skill_understanding   INTEGER,
  skill_tools           INTEGER,
  skill_prompting       INTEGER,
  skill_building        INTEGER,
  has_personal_laptop   INTEGER,
  hopes                 TEXT,
  submitted_at          TEXT,
  updated_at            TEXT
);

CREATE INDEX IF NOT EXISTS idx_participants_attending ON participants(attending);
CREATE INDEX IF NOT EXISTS idx_participants_submitted ON participants(submitted_at);

CREATE TABLE IF NOT EXISTS grouping_runs (
  id                TEXT PRIMARY KEY,
  status            TEXT NOT NULL,
  seed              INTEGER NOT NULL,
  params_json       TEXT NOT NULL,
  themes_json       TEXT,
  score_json        TEXT,
  violations_json   TEXT,
  error             TEXT,
  progress          TEXT,
  is_published      INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  completed_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_created ON grouping_runs(created_at DESC);

-- At most one published run. A partial unique index is the cheapest way to make the
-- "exactly one canonical run" rule impossible to violate, even from the SQL console.
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_single_published
  ON grouping_runs(is_published) WHERE is_published = 1;

CREATE TABLE IF NOT EXISTS teams (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES grouping_runs(id),
  name          TEXT,
  theme_label   TEXT,
  project_brief TEXT,
  rationale     TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_teams_run ON teams(run_id, sort_order);

CREATE TABLE IF NOT EXISTS team_members (
  team_id            TEXT NOT NULL REFERENCES teams(id),
  participant_id     TEXT NOT NULL REFERENCES participants(id),
  is_manual_override INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, participant_id)
);

CREATE INDEX IF NOT EXISTS idx_team_members_participant ON team_members(participant_id);

CREATE TABLE IF NOT EXISTS email_log (
  id             TEXT PRIMARY KEY,
  participant_id TEXT REFERENCES participants(id),
  kind           TEXT NOT NULL,
  sent_at        TEXT NOT NULL,
  provider_id    TEXT,
  status         TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_log_lookup ON email_log(participant_id, kind, sent_at);
