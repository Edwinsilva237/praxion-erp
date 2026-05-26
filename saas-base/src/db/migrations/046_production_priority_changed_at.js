'use strict'

const up = `
  ALTER TABLE production_orders
    ADD COLUMN IF NOT EXISTS priority_changed_at TIMESTAMPTZ;
`

const down = `
  ALTER TABLE production_orders
    DROP COLUMN IF EXISTS priority_changed_at;
`

module.exports = { up, down }
