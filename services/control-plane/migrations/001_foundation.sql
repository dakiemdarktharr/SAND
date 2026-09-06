CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE projects (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE runs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  project_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind = 'registry.refresh'),
  status text NOT NULL CHECK (status IN ('queued','running','cancellation_requested','completed','failed','cancelled')),
  next_sequence bigint NOT NULL DEFAULT 0,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id,id)
);
CREATE INDEX runs_recent ON runs(tenant_id,created_at DESC);
CREATE TABLE run_events (
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  id uuid NOT NULL,
  sequence bigint NOT NULL,
  event_key text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  type text NOT NULL,
  payload jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,run_id,sequence),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,run_id,event_key),
  FOREIGN KEY (tenant_id,run_id) REFERENCES runs(tenant_id,id)
);
CREATE TABLE idempotency_records (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid NOT NULL,
  operation text NOT NULL,
  key text NOT NULL,
  input_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,actor_id,operation,key)
);
CREATE TABLE outbox (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('start','cancel')),
  workflow_id text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_error_code text,
  dead_letter_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,run_id,action),
  FOREIGN KEY (tenant_id,run_id) REFERENCES runs(tenant_id,id)
);
CREATE INDEX outbox_pending ON outbox(tenant_id,available_at) WHERE delivered_at IS NULL AND dead_letter_at IS NULL;
CREATE TABLE registry_snapshots (
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  models jsonb NOT NULL,
  providers jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,run_id),
  FOREIGN KEY (tenant_id,run_id) REFERENCES runs(tenant_id,id)
);
CREATE TABLE audit_heads (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  sequence bigint NOT NULL DEFAULT 0,
  head_hash text NOT NULL DEFAULT ''
);
CREATE TABLE audit_ledger (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sequence bigint NOT NULL,
  id uuid NOT NULL,
  body text NOT NULL,
  previous_hash text NOT NULL,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,sequence),
  UNIQUE (tenant_id,id)
);
CREATE FUNCTION sand_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append-only table' USING ERRCODE = '42501'; END;
$$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_ledger FOR EACH ROW EXECUTE FUNCTION sand_immutable();
CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON run_events FOR EACH ROW EXECUTE FUNCTION sand_immutable();
CREATE FUNCTION sand_audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h audit_heads;
BEGIN
  SELECT * INTO h FROM audit_heads WHERE tenant_id=NEW.tenant_id FOR UPDATE;
  IF NOT FOUND OR NEW.sequence <> h.sequence + 1 OR NEW.previous_hash <> h.head_hash
     OR NEW.hash <> encode(sha256(convert_to(NEW.previous_hash || E'\n' || NEW.body,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'invalid audit chain' USING ERRCODE = '23514';
  END IF;
  UPDATE audit_heads SET sequence=NEW.sequence, head_hash=NEW.hash WHERE tenant_id=NEW.tenant_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER audit_chain BEFORE INSERT ON audit_ledger FOR EACH ROW EXECUTE FUNCTION sand_audit_chain();
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['projects','runs','run_events','idempotency_records','outbox','registry_snapshots','audit_heads','audit_ledger'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''sand.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''sand.tenant_id'',true),'''')::uuid)',t);
  END LOOP;
END;
$$;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants USING (id = nullif(current_setting('sand.tenant_id',true),'')::uuid) WITH CHECK (id = nullif(current_setting('sand.tenant_id',true),'')::uuid);
