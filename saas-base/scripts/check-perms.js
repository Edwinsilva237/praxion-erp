'use strict'
require('dotenv').config()
const { Pool } = require('pg')
const p = new Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD })
p.query("SELECT perm.name, perm.resource, perm.action FROM permissions perm JOIN role_permissions rp ON rp.permission_id = perm.id JOIN roles r ON r.id = rp.role_id WHERE r.name = 'super_admin' AND perm.resource = 'purchases'").then(r => { console.log(r.rows); p.end() }).catch(e => { console.error(e.message); p.end() })