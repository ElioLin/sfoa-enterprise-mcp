-- Add human-readable 用户名称 (user_name) to identity routes.
-- Required on create/edit from the Admin UI. Existing rows backfill to their
-- platform_user_id so every row stays valid and visible after the migration.
--
-- MySQL fills the NOT NULL VARCHAR column with its implicit default ('') for
-- existing rows; the UPDATE then replaces it with the platform user id.

ALTER TABLE sfoa_identity_route
  ADD COLUMN user_name VARCHAR(128) NOT NULL AFTER platform_user_id;

UPDATE sfoa_identity_route
  SET user_name = platform_user_id
  WHERE user_name = '';
