alter table helpers
  add column if not exists supports_self_update boolean not null default false,
  add column if not exists update_requested_version text,
  add column if not exists update_requested_at timestamptz,
  add column if not exists update_error text;
