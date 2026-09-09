-- ============================================================================
-- KPOST auth diagnosis — read-only database probe
--
-- Answers the questions POST /v2/signupLogin/userLogin refuses to: it reports
-- "no such account", "wrong password", "account not active" and "wrong
-- environment" with one identical message ("Invalid Credential"), so the only
-- way to tell them apart from outside is to look at the row.
--
-- SELECTs only. Nothing here writes, locks or alters anything.
--
-- Run (this instance listens on 3307, NOT the default 3306):
--   mysql -h 127.0.0.1 -P 3307 -u root -p --table kpost_testdb \
--       < scripts/auth/db-check.sql > db-check.txt
--
-- Use -h 127.0.0.1, not localhost: the MySQL client reads "localhost" as a
-- request for a socket / named-pipe connection and silently ignores -P, so you
-- would land on whatever is running on 3306 instead. Section 0 below echoes the
-- connection back precisely so that mistake cannot go unnoticed.
--
-- (Windows, if mysql is not on PATH, use the full path to mysql.exe. Prefer
--  bare -p so the client prompts, rather than putting the password on the
--  command line where it lands in shell history.)
-- ============================================================================

SELECT '=== 0. which database am I actually connected to ===' AS section;
SELECT DATABASE()            AS current_db,
       VERSION()             AS mysql_version,
       @@port                AS server_port,      -- must read 3307
       @@datadir             AS data_dir,
       NOW()                 AS checked_at;

SELECT '=== 1. candidate tables ===' AS section;
SELECT TABLE_NAME, TABLE_ROWS
FROM   information_schema.TABLES
WHERE  TABLE_SCHEMA = DATABASE()
  AND (TABLE_NAME LIKE '%user%' OR TABLE_NAME LIKE '%login%' OR TABLE_NAME LIKE '%session%')
ORDER  BY TABLE_NAME;

SELECT '=== 2. columns on those tables (real names, not guessed) ===' AS section;
SELECT TABLE_NAME, ORDINAL_POSITION AS pos, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM   information_schema.COLUMNS
WHERE  TABLE_SCHEMA = DATABASE()
  AND (TABLE_NAME LIKE '%user%' OR TABLE_NAME LIKE '%login%' OR TABLE_NAME LIKE '%session%')
ORDER  BY TABLE_NAME, ORDINAL_POSITION;

-- ----------------------------------------------------------------------------
-- Everything below assumes the user table is `user`. If section 1 shows a
-- different name, re-run these three with it substituted.
-- ----------------------------------------------------------------------------

SELECT '=== 3. is this database populated at all ===' AS section;
SELECT COUNT(*) AS total_users FROM user;

SELECT '=== 4. THE ACCOUNT (does the row exist on THIS backend?) ===' AS section;
SELECT * FROM user WHERE kpostID = 'qavf91dlmz@kpostindia.com'\G

SELECT '=== 5. password column shape — plaintext, hashed, or encrypted? ===' AS section;
-- The VALUE is deliberately not selected. Its length and prefix are enough to
-- identify the scheme, and that is the whole question:
--   60 chars starting '$2a$' / '$2b$'  -> bcrypt      -> server hashes what you send; PLAINTEXT IS CORRECT
--   32 or 64 hex chars                 -> MD5 / SHA   -> plaintext is correct
--   ~24 chars of base64 ending '=='    -> AES at rest -> PLAINTEXT CAN NEVER MATCH  <-- the suspected cause
SELECT kpostID,
       LENGTH(password)      AS pw_len,
       LEFT(password, 4)     AS pw_prefix,
       RIGHT(password, 2)    AS pw_suffix
FROM   user
WHERE  kpostID = 'qavf91dlmz@kpostindia.com';

SELECT '=== 6. every account the bench has created (kpostID LIKE qa%) ===' AS section;
SELECT kpostID, activeStatus, userType, createdDate
FROM   user
WHERE  kpostID LIKE 'qa%'
ORDER  BY createdDate DESC
LIMIT  25;

SELECT '=== 7. how many device sessions is the QA account carrying ===' AS section;
-- A device cap being hit is reported as "Invalid Credential" like everything
-- else. Hundreds of rows is the fingerprint of the old per-login random UUID.
SELECT COUNT(*) AS session_rows FROM login_session
WHERE  kpostID = 'qavf91dlmz@kpostindia.com';

SELECT deviceIdentity_primary, deviceType, logintime
FROM   login_session
WHERE  kpostID = 'qavf91dlmz@kpostindia.com'
ORDER  BY logintime DESC
LIMIT  10;
