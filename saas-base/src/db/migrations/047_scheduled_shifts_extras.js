'use strict'

const up = `
  ALTER TABLE scheduled_shifts
    ADD COLUMN IF NOT EXISTS is_overtime          BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS absence_registered   BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS replacement_operator_id UUID REFERENCES users(id);
`

const down = `
  ALTER TABLE scheduled_shifts
    DROP COLUMN IF EXISTS is_overtime,
    DROP COLUMN IF EXISTS absence_registered,
    DROP COLUMN IF EXISTS replacement_operator_id;
`

module.exports = { up, down }
