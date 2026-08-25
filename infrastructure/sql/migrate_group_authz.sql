-- migrate_group_authz.sql  (GLOBAL plane: fleetshell)
--
-- Brings USER GROUPS under the authorization fast path, so a non-admin "group
-- admin" (a persona holding a group-scoped GroupAdmin grant) can manage their
-- own subtree from the top-level Groups page -- WITHOUT the is_admin gate that
-- guards the Administration section.
--
-- A group is authorized by the group_path SUBTREE dimension (the only meaningful
-- dimension for resource_type='group'): a grant scoped to group_path subtree
-- {P} confers the verb on the group at P and every descendant (path <@ P). A
-- scope with NO group_path constraint is a full wildcard over every group.
--
-- Mirrors migrate_gateway_authz.sql (region-scoped) structure:
--   authz_visible_group_ids  -- the id set a group set may `verb`
--   authz_can_group          -- point check for one target group
--
-- Idempotent. Apply AFTER principal_group + the authz tables exist. reload.sh
-- runs it after migrate_services_authz.sql.

BEGIN;

-- Visible group-id set for a verb: union of the constrained group_path subtrees
-- with the full-wildcard scope (no group_path constraint -> every group).
CREATE OR REPLACE FUNCTION authz_visible_group_ids(
    p_group_ids uuid[], p_verb text
) RETURNS TABLE(group_id uuid)
LANGUAGE sql STABLE AS $$
    WITH es AS (
        SELECT es.scope_id, es.kind,
               array_agg((c.values[1])::ltree)
                 FILTER (WHERE c.dimension = 'group_path') AS gpaths
        FROM authz_effective_scopes(p_group_ids, 'group', p_verb) es
        LEFT JOIN authz_scope_constraint c ON c.scope_id = es.scope_id
        GROUP BY es.scope_id, es.kind
    ),
    subtrees AS (
        SELECT DISTINCT unnest(gpaths) AS gp FROM es WHERE gpaths IS NOT NULL
    )
    -- group_path subtree scopes (collapsed into one GiST scan)
    SELECT pg.group_id
    FROM principal_group pg
    JOIN subtrees st ON pg.path <@ st.gp
    UNION
    -- full-wildcard group scope (attribute kind, no group_path constraint)
    SELECT pg.group_id
    FROM principal_group pg
    WHERE EXISTS (SELECT 1 FROM es WHERE es.kind = 'attribute' AND es.gpaths IS NULL);
$$;

-- Point check: may these groups `verb` the one target group? True when a scope
-- either has NO group_path constraint (wildcard) OR names a subtree the target
-- sits within (target.path <@ scope.group_path).
CREATE OR REPLACE FUNCTION authz_can_group(
    p_group_ids uuid[], p_verb text, p_target_group_id uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
    tgt principal_group%ROWTYPE;
    ok  boolean;
BEGIN
    SELECT * INTO tgt FROM principal_group WHERE group_id = p_target_group_id;
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    SELECT EXISTS (
        SELECT 1
        FROM authz_effective_scopes(p_group_ids, 'group', p_verb) es
        LEFT JOIN authz_scope_constraint c
               ON c.scope_id = es.scope_id AND c.dimension = 'group_path'
        GROUP BY es.scope_id
        HAVING count(c.*) = 0                               -- wildcard scope
            OR bool_or(tgt.path <@ (c.values[1])::ltree)    -- within a subtree
    ) INTO ok;
    RETURN ok;
END;
$$;

COMMIT;
