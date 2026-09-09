-- =============================================================================
-- Mark this bench's QA Dashboard defects resolved when they no longer reproduce.
--
-- The ingest never closes a defect — it only inserts new ones and bumps
-- occurrence counts — so `qa.defects` accumulates and every row stays 'open'.
-- The dashboard then reports every defect ever found as currently broken.
--
-- SAFE BY DESIGN, unlike the Bugzilla equivalent: `qa.defects.status` is
-- documented as "open | resolved; automatically reopened if the defect is seen
-- again after being resolved", and `ingestService.ts` implements exactly that:
--
--     status = CASE WHEN defects.status = 'resolved' THEN 'open' ELSE ... END
--
-- So a premature resolve here is self-correcting — the next run that observes
-- the defect flips it back to 'open'. There is no duplicate-row risk, which is
-- what makes the same mistake expensive in Bugzilla.
--
-- -----------------------------------------------------------------------------
-- SCOPED TO ONE APPLICATION. This is the difference from the version in
-- kpost-automation-v1, and it is not cosmetic.
--
-- That script filters by neither application nor bench: `recent_runs` is the two
-- most recent runs *in the whole table*, and the UPDATE touches all of
-- `qa.defects`. This dashboard serves three benches (kpost-api, kpost-ui,
-- kpost-admin). Run it after two kpost-admin runs and every kpost-api and
-- kpost-ui defect is absent from both — so all of them are resolved at once,
-- silently, in a single transaction. The status flag is recoverable, but the
-- other teams' dashboards read as "everything fixed" until their next run.
--
-- Every statement below is therefore constrained by :slug.
-- -----------------------------------------------------------------------------
--
-- The two-run rule: a defect must be absent from the two most recent runs OF
-- THIS APPLICATION, not merely the newest. A single run's silence is weak
-- evidence — a test can execute and still verify nothing (a timed-out request,
-- an upstream setup call that failed), and this backend times out under load.
--
-- Run:  psql -h localhost -p 5432 -U postgres -d qa_dashboard \
--         -v slug=kpost-admin \
--         -f scripts/sql/resolve-stale-dashboard-defects.sql
-- =============================================================================

\set ON_ERROR_STOP on
-- Default the slug so an accidental bare invocation targets this bench, never
-- the whole dashboard.
\if :{?slug}
\else
  \set slug kpost-admin
\endif

BEGIN;

CREATE TEMP TABLE target_app ON COMMIT DROP AS
  SELECT id FROM qa.applications WHERE slug = :'slug';

-- An unknown slug must abort, not match zero rows and silently do nothing.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM target_app;
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 application for the given slug, found %', n;
  END IF;
END $$;

-- The two most recent runs OF THIS APPLICATION, and every defect either observed.
CREATE TEMP TABLE recent_runs ON COMMIT DROP AS
  SELECT id FROM qa.test_runs
   WHERE application_id IN (SELECT id FROM target_app)
   ORDER BY id DESC LIMIT 2;

CREATE TEMP TABLE seen_recently ON COMMIT DROP AS
  SELECT DISTINCT defect_id AS id
    FROM qa.defect_occurrences
   WHERE run_id IN (SELECT id FROM recent_runs);

-- Refuse to run without two runs to compare: with one run (or none) every
-- defect looks absent and this would resolve the application's entire table.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM recent_runs;
  IF n < 2 THEN
    RAISE EXCEPTION 'need 2 archived runs for this application to judge absence, found %', n;
  END IF;
END $$;

\echo ''
\echo '--- before (this application only) ---'
SELECT status, count(*)
  FROM qa.defects
 WHERE application_id IN (SELECT id FROM target_app)
 GROUP BY status ORDER BY status;

UPDATE qa.defects
   SET status = 'resolved'
 WHERE status = 'open'
   AND application_id IN (SELECT id FROM target_app)
   AND id NOT IN (SELECT id FROM seen_recently);

\echo ''
\echo '--- after ---'
SELECT status, count(*)
  FROM qa.defects
 WHERE application_id IN (SELECT id FROM target_app)
 GROUP BY status ORDER BY status;

\echo ''
\echo '--- open defects by severity (this is now the live picture) ---'
SELECT severity, count(*)
  FROM qa.defects
 WHERE status = 'open'
   AND application_id IN (SELECT id FROM target_app)
 GROUP BY severity
 ORDER BY CASE severity
            WHEN 'Critical' THEN 1 WHEN 'Major' THEN 2
            WHEN 'Minor' THEN 3 WHEN 'Trivial' THEN 4 ELSE 5 END;

COMMIT;
