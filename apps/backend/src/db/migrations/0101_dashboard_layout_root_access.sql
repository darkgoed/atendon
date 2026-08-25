ALTER TABLE dashboard_layouts
  DROP CONSTRAINT IF EXISTS dashboard_layouts_workspace_id_user_id_fkey;

ALTER TABLE dashboard_layouts
  ADD CONSTRAINT dashboard_layouts_workspace_fkey
    FOREIGN KEY(workspace_id) REFERENCES tenants(id) ON DELETE CASCADE,
  ADD CONSTRAINT dashboard_layouts_user_fkey
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;
