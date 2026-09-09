-- Deletes every BUG from the Bugzilla database, keeping the installation itself intact.
--
-- Purpose: start a run from a true zero so the filed count reflects one run's findings
-- rather than accumulated history.
--
-- TAKE A VERIFIED BACKUP FIRST. Bugzilla's REST API has no delete, and neither does this;
-- once these tables are truncated the tickets, their comments and their attachments are gone.
-- "Verified" means restored into a scratch database and row-counted against live, not merely
-- dumped -- a mysqldump that hit max_allowed_packet exits non-zero with a plausible-looking
-- partial file:
--
--   mariadb-dump --host=127.0.0.1 --port=3307 --user=root -p \
--     --single-transaction --quick --max-allowed-packet=512M \
--     --add-drop-table --routines --events --triggers --databases bugs > backup.sql
--
-- WHAT THIS DESTROYS: every ticket, comment, attachment, activity record and alias.
-- That includes every human judgement -- each INVALID / WONTFIX call your team made lives
-- only in Bugzilla and no re-run reconstructs it. The bench's re-filing suppression reads
-- those resolutions from Bugzilla, so after a wipe every previously-judged finding is filed
-- again as a fresh open bug.
--
-- WHAT THIS KEEPS: products, components, versions, milestones, classifications, the group
-- and user_group access control, user accounts and their settings, field definitions, the
-- status workflow, and the schema version row. The installation stays usable; it is simply
-- empty of bugs.
--
-- TRUNCATE rather than DELETE: it resets AUTO_INCREMENT, so the next bug filed is bug 1.
-- Foreign key checks are disabled for the duration because these tables reference each
-- other in both directions (bugs_activity -> attachments -> bugs), which admits no ordering
-- that satisfies every constraint.
--
-- Usage:
--   "C:\Program Files\MariaDB 10.11\bin\mariadb.exe" --host=127.0.0.1 --port=3307 \
--     --user=root -p bugs < scripts/sql/wipe-bugzilla-bugs.sql

SET FOREIGN_KEY_CHECKS = 0;

-- Attachments and their payloads.
TRUNCATE TABLE attach_data;
TRUNCATE TABLE attachments;

-- Comments and their tags.
TRUNCATE TABLE longdescs_tags_activity;
TRUNCATE TABLE longdescs_tags;
TRUNCATE TABLE longdescs;

-- Per-bug relationships and metadata.
TRUNCATE TABLE bug_group_map;
TRUNCATE TABLE bug_see_also;
TRUNCATE TABLE bug_tag;
TRUNCATE TABLE bug_user_last_visit;
TRUNCATE TABLE bugs_aliases;
TRUNCATE TABLE bugs_fulltext;
TRUNCATE TABLE cc;
TRUNCATE TABLE dependencies;
TRUNCATE TABLE duplicates;
TRUNCATE TABLE email_bug_ignore;
TRUNCATE TABLE flags;
TRUNCATE TABLE keywords;

-- Change history. Not configuration: every row here describes a bug that is about to stop
-- existing, so leaving it behind would keep an audit trail pointing at nothing.
TRUNCATE TABLE bugs_activity;
TRUNCATE TABLE audit_log;

-- The bugs themselves, last.
TRUNCATE TABLE bugs;

SET FOREIGN_KEY_CHECKS = 1;

-- Proof, printed by the client that runs this.
SELECT 'bugs' AS table_, COUNT(*) AS remaining FROM bugs
UNION ALL SELECT 'longdescs',   COUNT(*) FROM longdescs
UNION ALL SELECT 'attachments', COUNT(*) FROM attachments
UNION ALL SELECT 'attach_data', COUNT(*) FROM attach_data
UNION ALL SELECT 'bugs_aliases',COUNT(*) FROM bugs_aliases
UNION ALL SELECT 'bugs_activity',COUNT(*) FROM bugs_activity
UNION ALL SELECT '-- kept --',  NULL
UNION ALL SELECT 'products',    COUNT(*) FROM products
UNION ALL SELECT 'components',  COUNT(*) FROM components
UNION ALL SELECT 'profiles',    COUNT(*) FROM profiles
UNION ALL SELECT 'groups',      COUNT(*) FROM `groups`
UNION ALL SELECT 'user_group_map', COUNT(*) FROM user_group_map
UNION ALL SELECT 'group_control_map', COUNT(*) FROM group_control_map;
