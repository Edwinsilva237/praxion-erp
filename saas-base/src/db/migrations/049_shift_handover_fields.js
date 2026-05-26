'use strict'

const up = `
  ALTER TABLE production_shifts
    ADD COLUMN IF NOT EXISTS handover_requested_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS handover_waiting_shift_id UUID REFERENCES production_shifts(id),
    ADD COLUMN IF NOT EXISTS force_closed_by         UUID REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS force_close_reason      TEXT,
    ADD COLUMN IF NOT EXISTS force_closed_at         TIMESTAMPTZ;
`

const down = `
  ALTER TABLE production_shifts
    DROP COLUMN IF EXISTS handover_requested_at,
    DROP COLUMN IF EXISTS handover_waiting_shift_id,
    DROP COLUMN IF EXISTS force_closed_by,
    DROP COLUMN IF EXISTS force_close_reason,
    DROP COLUMN IF EXISTS force_closed_at;
`

module.exports = { up, down }
