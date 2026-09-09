-- =============================================================================
-- Mark QA Dashboard defects resolved when they no longer reproduce.
--
-- The ingest never closes a defect — it only inserts new ones and bumps
-- occurrence counts — so qa.defects accumulates and every row stays 'open'.
-- The dashboard then reports every defect ever found as currently broken.
--
-- SAFE BY DESIGN, unlike the Bugzilla equivalent: qa.defects.status is
-- documented as "open | resolved; automatically reopened if the defect is seen
-- again after being resolved", and ingestService.ts implements exactly that:
--
--     status = CASE WHEN defects.status = 'resolved' THEN 'open' ELSE ... END
--
-- So a premature resolve here is self-correcting — the next run that observes
-- the defect flips it back to 'open'. There is no duplicate-row risk, which is
-- what made the same mistake expensive in Bugzilla.
--
-- The two-run rule still applies: a defect must be absent from the two most
-- recent runs, not merely the newest. A single run's silence is weak evidence —
-- a test can execute and still verify nothing (a rate-limited OTP flow, an
-- upstream setup call that failed), and closing on that basis is what produced
-- 25 re-filed tickets in Bugzilla on 2026-08-24.
--
-- Run:  psql -h localhost -p 5432 -U postgres -d qa_dashboard \
--         -f scripts/sql/resolve-stale-dashboard-defects.sql
-- =============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- The two most recent runs, and every defect either of them observed.
CREATE TEMP TABLE recent_runs ON COMMIT DROP AS
  SELECT id FROM qa.test_runs ORDER BY id DESC LIMIT 2;

CREATE TEMP TABLE seen_recently ON COMMIT DROP AS
  SELECT DISTINCT defect_id AS id
  FROM qa.defect_occurrences
  WHERE run_id IN (SELECT id FROM recent_runs);

-- Refuse to run without two runs to compare: with one run (or none) every
-- defect looks absent and this would resolve the entire table.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM recent_runs;
  IF n < 2 THEN
    RAISE EXCEPTION 'need 2 archived runs to judge absence, found %', n;
  END IF;
END $$;

\echo ''
\echo '--- before ---'
SELECT status, count(*) FROM qa.defects GROUP BY status ORDER BY status;

UPDATE qa.defects
   SET status = 'resolved'
 WHERE status = 'open'
   AND id NOT IN (SELECT id FROM seen_recently);

\echo ''
\echo '--- after ---'
SELECT status, count(*) FROM qa.defects GROUP BY status ORDER BY status;

\echo ''
\echo '--- open defects by severity (this is now the live picture) ---'
SELECT severity, count(*)
  FROM qa.defects
 WHERE status = 'open'
 GROUP BY severity
 ORDER BY CASE severity
            WHEN 'Critical' THEN 1 WHEN 'Major' THEN 2
            WHEN 'Minor' THEN 3 ELSE 4 END;

COMMIT;
