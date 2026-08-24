-- Make "never the same message to the same person twice in one day" a database
-- guarantee rather than a check the caller is trusted to have done.
--
-- Eligibility was read once, before a batch started sending, and reserve() was an
-- unconditional INSERT. Two overlapping triggers — the hourly cron firing while an
-- organizer clicks "Send reminders", or a retried cron — both selected the same people
-- and both sent. §8 says that must be impossible, so the constraint moves into the
-- schema: the second INSERT now fails and that person is skipped.
--
-- day_key is the LOCAL calendar day (the event's UTC offset), not the UTC day, because
-- that is the day the rule is written in terms of. It is left NULL on a failed send, and
-- SQLite treats NULLs as distinct in a unique index, so a failure never occupies the slot
-- and can always be retried.

ALTER TABLE email_log ADD COLUMN day_key TEXT;

UPDATE email_log
   SET day_key = substr(sent_at, 1, 10)
 WHERE day_key IS NULL
   AND status NOT LIKE 'failed%'
   AND sent_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_log_once_per_day
  ON email_log(participant_id, kind, day_key);
