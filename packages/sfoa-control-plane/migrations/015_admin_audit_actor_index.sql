-- ADR-0034: the Console audit workbench can filter by 操作人 (actor_admin) once more than one
-- account exists. Shaped like the sibling audit indexes in 002_p5_indexes.sql so the filter
-- stays an index range scan rather than a full scan of the master audit table.
CREATE INDEX idx_sfoa_audit_actor ON sfoa_audit_log (actor_admin, occurred_at DESC);
