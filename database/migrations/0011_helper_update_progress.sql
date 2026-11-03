alter table helpers
  add column if not exists update_phase text
    check (update_phase in ('requested', 'preparing', 'downloading', 'installing', 'reconnected', 'failed')),
  add column if not exists update_phase_version text
    check (update_phase_version ~ '^\d+\.\d+\.\d+$'),
  add column if not exists update_phase_updated_at timestamptz;
