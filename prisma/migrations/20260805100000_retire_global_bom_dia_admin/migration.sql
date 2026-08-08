-- Remove global bom_dia_admin role assignments now that Events, Schedules,
-- Persona, and Triggers all check GroupAdmin membership per-resource instead
-- of this global role. The Role row itself is left in place (harmless,
-- unreferenced) in case the slug is ever reused. super_admin must manually
-- reassign each former bom_dia_admin to the specific group(s) they should
-- administer via POST /groups/:groupId/admins.
DELETE FROM "UserRole"
WHERE "roleId" IN (SELECT "id" FROM "Role" WHERE "slug" = 'bom_dia_admin');
