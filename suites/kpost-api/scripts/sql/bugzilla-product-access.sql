-- =============================================================================
-- Bugzilla — restrict each product to its own group
--
-- WHY THIS EXISTS
--
-- The bug groups `KPost API` and `KPost UI` existed, and jagan@kpost.in /
-- ayyappan@kpostindia.com were already members of the right one — but
-- `group_control_map` was EMPTY, so no product was actually restricted and
-- `bug_group_map` held zero rows. Every user saw every bug in every product:
-- jagan (API only) was shown bug 111, a UI-bench self-test sitting in
-- Bugzilla's sample `TestProduct`.
--
-- Group membership alone restricts nothing. A product is only protected once
-- it is bound to a group here, and existing bugs are only protected once they
-- are listed in `bug_group_map` — Bugzilla applies groups at filing time, so
-- bugs that pre-date the binding stay world-readable until backfilled.
--
-- membercontrol / othercontrol use Bugzilla's CONTROLMAP constants:
--   0 = NA, 1 = Shown, 2 = Default, 3 = Mandatory
-- MANDATORY on both means: every bug in the product is placed in the group and
-- only members of that group can see it.
--
--   mysql --user=root --password=<pw> --host=127.0.0.1 --port=3307 bugs < bugzilla-product-access.sql
-- =============================================================================

-- ----------------------------------------------------------- product bindings
-- KPost API (product 2) -> group "KPost API" (15)
INSERT INTO group_control_map (group_id, product_id, entry, membercontrol, othercontrol, canedit,
                               editcomponents, editbugs, canconfirm)
SELECT g.id, p.id, 1, 3, 3, 0, 0, 0, 0
  FROM groups g, products p
 WHERE g.name = 'KPost API' AND p.name = 'KPost API'
ON DUPLICATE KEY UPDATE entry = 1, membercontrol = 3, othercontrol = 3;

-- KPost UI (product 3) -> group "KPost UI" (16)
INSERT INTO group_control_map (group_id, product_id, entry, membercontrol, othercontrol, canedit,
                               editcomponents, editbugs, canconfirm)
SELECT g.id, p.id, 1, 3, 3, 0, 0, 0, 0
  FROM groups g, products p
 WHERE g.name = 'KPost UI' AND p.name = 'KPost UI'
ON DUPLICATE KEY UPDATE entry = 1, membercontrol = 3, othercontrol = 3;

-- TestProduct (product 1) -> group "KPost UI".
-- Its single bug is a UI-bench self-test filed by the UI bench, so the UI owner
-- keeps it and the API owner stops seeing it. The product is deactivated below
-- so nothing new lands in Bugzilla's sample product again.
INSERT INTO group_control_map (group_id, product_id, entry, membercontrol, othercontrol, canedit,
                               editcomponents, editbugs, canconfirm)
SELECT g.id, p.id, 1, 3, 3, 0, 0, 0, 0
  FROM groups g, products p
 WHERE g.name = 'KPost UI' AND p.name = 'TestProduct'
ON DUPLICATE KEY UPDATE entry = 1, membercontrol = 3, othercontrol = 3;

UPDATE products SET isactive = 0 WHERE name = 'TestProduct';

-- ------------------------------------------------- the admin keeps full sight
-- Bugzilla's `admin` group does NOT bypass bug-group restrictions: an admin who
-- is not a member of a bug group cannot see that group's bugs. Without this the
-- act of securing the products would blind the dashboard owner.
INSERT INTO user_group_map (user_id, group_id, isbless, grant_type)
SELECT p.userid, g.id, 0, 0
  FROM profiles p, groups g
 WHERE p.login_name = 'meeravelu2303@gmail.com' AND g.name IN ('KPost API', 'KPost UI')
ON DUPLICATE KEY UPDATE grant_type = grant_type;

-- --------------------------------------------------- backfill existing bugs
-- Bugs filed before the binding above carry no group row and are therefore
-- visible to everyone. Place each one in the group its product now maps to.
INSERT INTO bug_group_map (bug_id, group_id)
SELECT b.bug_id, gcm.group_id
  FROM bugs b
  JOIN group_control_map gcm ON gcm.product_id = b.product_id
 WHERE NOT EXISTS (
         SELECT 1 FROM bug_group_map m
          WHERE m.bug_id = b.bug_id AND m.group_id = gcm.group_id);

-- =============================================================================
-- VERIFICATION
-- =============================================================================

SELECT 'product bindings' AS check_name, p.name AS product, g.name AS restricted_to,
       gcm.membercontrol, gcm.othercontrol
  FROM group_control_map gcm
  JOIN products p ON p.id = gcm.product_id
  JOIN groups   g ON g.id = gcm.group_id
 ORDER BY p.name;

SELECT 'unrestricted bugs (must be 0)' AS check_name, COUNT(*) AS n
  FROM bugs b
 WHERE NOT EXISTS (SELECT 1 FROM bug_group_map m WHERE m.bug_id = b.bug_id);

SELECT 'visibility per user' AS check_name, pr.login_name,
       p.name AS product, COUNT(*) AS bugs_visible
  FROM bugs b
  JOIN products p        ON p.id = b.product_id
  JOIN bug_group_map bgm ON bgm.bug_id = b.bug_id
  JOIN user_group_map ugm ON ugm.group_id = bgm.group_id AND ugm.grant_type = 0
  JOIN profiles pr        ON pr.userid = ugm.user_id
 GROUP BY pr.login_name, p.name
 ORDER BY pr.login_name, p.name;
