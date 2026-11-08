CREATE UNIQUE INDEX IF NOT EXISTS publish_jobs_project_request
  ON publish_jobs(owner_id, project_id, request_id);

CREATE TABLE IF NOT EXISTS publish_live_addresses (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  alias_id UUID NOT NULL UNIQUE,
  version UUID NOT NULL,
  request_id UUID NOT NULL,
  previous_request_id UUID,
  PRIMARY KEY (owner_id, project_id),
  FOREIGN KEY (owner_id, project_id)
    REFERENCES builder_projects(owner_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, project_id, request_id)
    REFERENCES publish_jobs(owner_id, project_id, request_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, project_id, previous_request_id)
    REFERENCES publish_jobs(owner_id, project_id, request_id) ON DELETE CASCADE,
  CHECK (request_id <> previous_request_id)
);
