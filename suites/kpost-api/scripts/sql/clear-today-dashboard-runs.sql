-- =============================================================================
-- Remove today's runs from the QA Dashboard, so the current report can be
-- re-published as a single clean entry.
--
-- Two runs were published today (ids 3 and 4, 2026-08-24 in local time). They
-- describe the same working session, and the second supersedes the first. This
-- drops both, then re-pushing BUG_REPORT.json leaves one run for today.
--
-- WHAT IT TOUCHES
--   qa.test_runs           the two rows for today
--   qa.defect_occurrences  cascade-deleted with them (ON DELETE CASCADE)
--   qa.defects             ONLY rows left with no occurrence in any surviving
--                          run - 34 defects first seen today. Every other defect
--                          keeps its history from runs 1 and 2.
--
-- WHAT IT KEEPS
--   applications, users, access grants, and every defect still evidenced by an
--   earlier run - including its seq, so KPA numbering does not shift.
--
-- Re-publishing afterwards is safe: the ingest upserts on the defect
-- fingerprint, so surviving defects are updated rather than duplicated, and the
-- 34 removed here are recreated from the current report.
--
-- Run:
--   psql -h localhost -p 5432 -U postgres -d qa_dashboard \
--     -f scripts/sql/clear-today-dashboard-runs.sql
-- then:
--   npm run dashboard:push
-- =============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- Today in the database's own timezone, so this stays correct whenever it runs
-- rather than hard-coding the two ids observed on 2026-08-24.
CREATE TEMP TABLE todays_runs ON COMMIT DROP AS
  SELECT id FROM qa.test_runs WHERE run_date::date = CURRENT_DATE;

-- A guard against clearing everything: if today somehow matched every run, the
-- dashboard would be left with no history at all and the re-push would have
-- nothing to merge into.
DO $$
DECLARE today int; total int;
BEGIN
  SELECT count(*) INTO today FROM todays_runs;
  SELECT count(*) INTO total FROM qa.test_runs;
  IF today = 0 THEN
    RAISE EXCEPTION 'no runs dated today - nothing to clear';
  END IF;
  IF today = total THEN
    RAISE EXCEPTION 'today matches all % run(s); refusing to clear the entire history', total;
  END IF;
  RAISE NOTICE 'clearing % of % run(s)', today, total;
END $$;

\echo ''
\echo '--- before ---'
SELECT (SELECT count(*) FROM qa.test_runs)           AS runs,
       (SELECT count(*) FROM qa.defects)             AS defects,
       (SELECT count(*) FROM qa.defect_occurrences)  AS occurrences;

DELETE FROM qa.test_runs WHERE id IN (SELECT id FROM todays_runs);

-- Defects whose only evidence came from the runs just removed. Anything still
-- observed by a surviving run is kept, history intact.
DELETE FROM qa.defects d
 WHERE NOT EXISTS (SELECT 1 FROM qa.defect_occurrences o WHERE o.defect_id = d.id);

\echo ''
\echo '--- after (re-publish now with: npm run dashboard:push) ---'
SELECT (SELECT count(*) FROM qa.test_runs)           AS runs,
       (SELECT count(*) FROM qa.defects)             AS defects,
       (SELECT count(*) FROM qa.defect_occurrences)  AS occurrences,
       (SELECT count(*) FROM qa.applications)        AS applications_kept,
       (SELECT count(*) FROM qa.users)               AS users_kept;

COMMIT;
