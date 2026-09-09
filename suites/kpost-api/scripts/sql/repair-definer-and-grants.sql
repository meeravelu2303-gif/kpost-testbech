-- =============================================================================
-- KPOST bench - database repair after a MySQL rebuild
--
-- WHY THIS EXISTS
--
-- A `mysqldump` of a schema carries the stored procedures, but NOT the MySQL
-- accounts they run as - those live in the `mysql` system database. KPOST's
-- three procedures are all declared DEFINER = `root`@`%`:
--
--     InviteKpostPhoneContact   (called during signup)
--     KPOSTLogin                (session row on login)
--     KPOSTLogout
--
-- So on a freshly installed MySQL server, restoring kpost_testdb brings the
-- procedures back but not `root`@`%`. Every CALL then fails with:
--
--     ERROR 1449: The user specified as a definer ('root'@'%') does not exist
--
-- which marks the surrounding transaction rollback-only, and the API answers
-- "Transaction silently rolled back" / 500 on signup.
--
-- Run this after any rebuild or restore. It is idempotent.
--
--   mysql --user=root --password=<pw> --host=127.0.0.1 --port=3306 < repair-definer-and-grants.sql
-- =============================================================================

-- --------------------------------------------------------------- the definer
-- Created ACCOUNT LOCK on purpose: the account only has to EXIST for DEFINER
-- resolution, it is never logged in as. Locking keeps a wildcard-host root from
-- being a remote login path. Privileges are scoped to kpost_testdb because that
-- is the only schema the three procedure bodies touch.
CREATE USER IF NOT EXISTS 'root'@'%'
  IDENTIFIED BY 'Kp0st-Definer-Only-2026!'
  ACCOUNT LOCK;

GRANT ALL PRIVILEGES ON `kpost_testdb`.* TO 'root'@'%';

-- ------------------------------------------------- the backend's own account
-- The application server connects from 192.168.1.176. MySQL matches the most
-- specific host first, so this account - not 'root'@'%' - is what it
-- authenticates as; locking '%' above does not affect it.
-- Uncomment and set the password if this account is ever missing:
-- CREATE USER IF NOT EXISTS 'root'@'192.168.1.176' IDENTIFIED BY '2305';
-- GRANT ALL PRIVILEGES ON *.* TO 'root'@'192.168.1.176' WITH GRANT OPTION;

FLUSH PRIVILEGES;

-- =============================================================================
-- VERIFICATION - every row below should match the expected value
-- =============================================================================

SELECT '1. definer account exists' AS check_name,
       IF(COUNT(*) = 1, 'PASS', 'FAIL') AS result
FROM mysql.user WHERE user = 'root' AND host = '%';

SELECT '2. definer is locked (not a login path)' AS check_name,
       IF(account_locked = 'Y', 'PASS', 'WARN - unlocked') AS result
FROM mysql.user WHERE user = 'root' AND host = '%';

SELECT '3. every procedure definer resolves' AS check_name,
       IF(COUNT(*) = 0, 'PASS', CONCAT('FAIL - ', COUNT(*), ' unresolved')) AS result
FROM information_schema.ROUTINES r
LEFT JOIN mysql.user u
       ON CONCAT(u.user, '@', u.host) = r.DEFINER
WHERE r.ROUTINE_SCHEMA = 'kpost_testdb' AND u.user IS NULL;

SELECT '4. backend account present' AS check_name,
       IF(COUNT(*) = 1, 'PASS', 'FAIL') AS result
FROM mysql.user WHERE user = 'root' AND host = '192.168.1.176';

SELECT '5. no user rows orphaned from domain_master' AS check_name,
       IF(COUNT(*) = 0, 'PASS', CONCAT('FAIL - ', COUNT(*))) AS result
FROM tbl_kpost_user_master u
LEFT JOIN tbl_kpost_domain_master d ON d.domain_id = u.domain_id
WHERE d.domain_id IS NULL;

SELECT '6. bench accounts present' AS check_name,
       IF(COUNT(*) >= 2, 'PASS', CONCAT('FAIL - only ', COUNT(*))) AS result
FROM tbl_kpost_user_master
WHERE kpost_id IN ('qabenchnwvfa@kpostindia.com', 'qabenchnwvfb@kpostindia.com');

-- Smoke-test a procedure end to end. Before the repair this raised 1449.
CALL InviteKpostPhoneContact('9000000000', '09000000000', '+919000000000');
