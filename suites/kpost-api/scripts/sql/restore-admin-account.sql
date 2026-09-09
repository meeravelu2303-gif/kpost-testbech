-- Restores the company-admin account gldema.mevelu349@kpost.in from
-- _backups/kpost_testdb-20260826-135744.sql, without touching any other data.
-- Generated 2026-08-27. Safe to re-run: each insert is guarded by DELETE.

SET FOREIGN_KEY_CHECKS=0;

DELETE FROM `tbl_kpost_user_master` WHERE kpost_id = 'gldema.mevelu349@kpost.in';
INSERT INTO `tbl_kpost_user_master` VALUES
('gldema.mevelu349@kpost.in',NULL,'yes',NULL,814,'91',1,'admin','2026-08-20 01:52:49.629000','2004-03-23',NULL,'gldema.mevelu349@kpost.in','Meera','female',_binary '\0','$2a$10$Lxip.SYkPJGdOr.WymPbg.WeX5nbPgmn/0KomAuvWVbVwkVD6NyPm','Velu','9043063930',NULL,NULL,0,'2VETEn9xkRSii1mEJO5SRg==',NULL,NULL,'BUSINESS_S',NULL);

DELETE FROM `tbl_kpost_user_profile` WHERE kpost_id = 'gldema.mevelu349@kpost.in';
INSERT INTO `tbl_kpost_user_profile` VALUES
('gldema.mevelu349@kpost.in',NULL,NULL,NULL,NULL,'Chennai',NULL,'SAI RAM Technologies','India','admin','2026-08-20 01:52:49.629000','Global Delivery Manager',0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'meeravelu2303@gmail.com',NULL,NULL,'600020',NULL,'English',' ',NULL,0,0,NULL,NULL,NULL,NULL,NULL,'',NULL,'Tamil Nadu',NULL,NULL);

DELETE FROM `tbl_kpost_users_kmail_settings` WHERE kpost_id = 'gldema.mevelu349@kpost.in';
INSERT INTO `tbl_kpost_users_kmail_settings` VALUES
('gldema.mevelu349@kpost.in','Regards,\n Meera Velu\n Global Delivery Manager\n 9043063930 ','admin',NULL,NULL,NULL,'2026-08-20 01:52:49.649000',0,NULL,NULL,'Y',NULL,NULL);

DELETE FROM `tbl_kpost_admin_registration` WHERE kpost_id = 'gldema.mevelu349@kpost.in';
INSERT INTO `tbl_kpost_admin_registration` VALUES
(814,'gldema.mevelu349@kpost.in','Business_S',NULL,NULL,'Meera','Velu','Global Delivery Manager','9043063930',NULL,NULL,'600020',NULL,'mevelu349@kpost.in','Chennai','Tamil Nadu','India','mevelu349',NULL,'Free',NULL,'2027-02-20 10:52:50',250,NULL,NULL,0,NULL,NULL,'{\"branch\": null, \"bankName\": null, \"ifscCode\": null, \"accountNumber\": null, \"accountHolderName\": null}','\0',NULL,'IT',NULL,NULL,0,NULL);

SET FOREIGN_KEY_CHECKS=1;

-- verification
SELECT kpost_id, active_status, user_type, company_id, domain_id
FROM tbl_kpost_user_master WHERE kpost_id = 'gldema.mevelu349@kpost.in';
