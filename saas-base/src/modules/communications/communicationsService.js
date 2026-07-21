'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// Módulo "Comunicados": el tenant envía un aviso (texto + N adjuntos libres) por
// correo a sus CLIENTES, PROVEEDORES y/o correos MANUALES. UN correo INDIVIDUAL
// por socio (a todos sus contactos con email) — no se cruzan entre socios; los
// manuales van 1 correo por dirección. La bitácora (communication_sends /
// _recipients) es el comprobante de cada envío. Reusa la plomería branded de la
// distribución fiscal vía utils/emailBroadcast + email/templates.
//
// FASE 2: el envío corre en SEGUNDO PLANO vía pg-boss (Postgres, sin Redis). El
// endpoint pre-inserta los destinatarios en estado 'queued', encola un job y
// responde al instante; el worker `communications.dispatch` hace el fan-out,
// actualiza `sent_count` (progreso) y marca cada destinatario. Es REANUDABLE: si
// el proceso se reinicia a media tanda, al reintentar solo procesa los que
// siguen en 'queued'. Si pg-boss no está disponible (tests/local), cae a envío
// SÍNCRONO inline. Ver [[communications-module-roadmap]].
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../../db')
const config = require('../../config')
const attachmentService = require('../attachments/attachmentService')
const storage = require('../../utils/storage')
const { sendEmail } = require('../email/emailService')
const { audit } = require('../../utils/audit')
const { communicationEmail } = require('../email/templates')
const { normalizeManualEmails, resolveIssuerName, getTenantEmailBranding } = require('../../utils/emailBroadcast')

// Cola pg-boss del fan-out en segundo plano.
const DISPATCH_QUEUE = 'communications.dispatch'
// Espaciado entre correos (ms) para no saturar Workspace en lotes grandes.
const SEND_STAGGER_MS = 200
// Tope de audiencia por comunicado. Con el envío en 2º plano ya no bloquea el
// request; el tope es una salvaguarda de reputación/volumen (Fase 3 = opt-out).
const MAX_RECIPIENTS = 2000

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Encola el fan-out en pg-boss. Require PEREZOSO + guard de test: pg-boss es
// ESM y jest no lo transforma, así que en tests devolvemos null → envío inline
// (mismo patrón que app.js, que evita cargar pg-boss/crons en test).
async function tryEnqueueDispatch(payload) {
  if (config.env === 'test') return null
  try {
    const { enqueue } = require('../../utils/pgboss')
    return await enqueue(DISPATCH_QUEUE, payload,
      { retryLimit: 5, retryDelay: 30, expireInSeconds: 900 })
  } catch (_) { return null }
}

// ─── Socios (clientes/proveedores) activos con contacto(s) con email ─────────
// Devuelve, para el tipo pedido, la lista de socios con sus correos. `ids`
// (opcional) acota; si es undefined se traen TODOS los de ese tipo (para el
// preview). Excluye ocasionales.
async function loadPartners({ tenantId, partnerTypes, ids }) {
  const params = [tenantId, partnerTypes]
  let idFilter = ''
  // Distinción clave: ids === [] (selección vacía) = NINGUNO; undefined = todos.
  if (Array.isArray(ids)) {
    if (ids.length === 0) return { withEmail: [], withoutEmail: [] }
    params.push(ids)
    idFilter = `AND bp.id = ANY($${params.length}::uuid[])`
  }

  const { rows: partners } = await query(
    `SELECT bp.id, COALESCE(NULLIF(bp.tax_name, ''), bp.name) AS name
       FROM business_partners bp
      WHERE bp.tenant_id = $1
        AND bp.type = ANY($2)
        AND bp.is_active = true
        AND COALESCE(bp.is_occasional, false) = false
        ${idFilter}
      ORDER BY name`,
    params
  )
  if (partners.length === 0) return { withEmail: [], withoutEmail: [] }

  const pIds = partners.map(p => p.id)
  const { rows: contacts } = await query(
    `SELECT business_partner_id, LOWER(TRIM(email)) AS email
       FROM business_partner_contacts
      WHERE business_partner_id = ANY($1::uuid[])
        AND email IS NOT NULL AND TRIM(email) <> ''`,
    [pIds]
  )
  const byPartner = {}
  for (const c of contacts) {
    (byPartner[c.business_partner_id] || (byPartner[c.business_partner_id] = new Set())).add(c.email)
  }

  const withEmail = []
  const withoutEmail = []
  for (const p of partners) {
    const emails = Array.from(byPartner[p.id] || [])
    if (emails.length > 0) withEmail.push({ id: p.id, name: p.name, emails })
    else withoutEmail.push({ id: p.id, name: p.name })
  }
  return { withEmail, withoutEmail }
}

// ─── Preview: TODOS los clientes y proveedores con email (para el selector) ───
async function previewRecipients({ tenantId }) {
  const [cli, prov] = await Promise.all([
    loadPartners({ tenantId, partnerTypes: ['customer', 'both'] }),
    loadPartners({ tenantId, partnerTypes: ['supplier', 'both'] }),
  ])
  return {
    clients:            cli.withEmail,
    clientsWithoutEmail: cli.withoutEmail,
    suppliers:          prov.withEmail,
    suppliersWithoutEmail: prov.withoutEmail,
  }
}

// ─── Enviar un comunicado ────────────────────────────────────────────────────
// files: [{ originalname, buffer, mimetype, size }] (de multer, en memoria).
// Pre-inserta los destinatarios y ENCOLA el fan-out (pg-boss). Responde al
// instante; el worker procesa. Si no hay pg-boss, envía inline (síncrono).
async function distribute({
  tenantId, subject, message, category,
  clientIds, supplierIds, manualEmails, files = [],
  sentBy, ipAddress, userAgent,
}) {
  const finalSubject = String(subject || '').trim()
  if (!finalSubject) throw createError(400, 'El asunto es requerido.')

  // 1) Adjuntos: guard de tamaño total (los correos topan ~25 MB; usamos el
  //    límite de subida configurado como tope conservador del TOTAL).
  const totalBytes = files.reduce((n, f) => n + (f.size || (f.buffer ? f.buffer.length : 0)), 0)
  const maxBytes = config.uploads.maxSizeMb * 1024 * 1024
  if (totalBytes > maxBytes) {
    throw createError(400, `Los adjuntos superan ${config.uploads.maxSizeMb} MB en total. Reduce o divide el envío.`)
  }

  // 2) Destinatarios: clientes + proveedores SELECCIONADOS + manuales, con DEDUPE
  //    global por correo (nadie recibe dos copias). OJO: en el ENVÍO, una lista
  //    ausente = NINGUNO (no "todos"); solo el preview trae todos.
  const clientSel   = Array.isArray(clientIds) ? clientIds : []
  const supplierSel = Array.isArray(supplierIds) ? supplierIds : []
  const [cli, prov] = await Promise.all([
    loadPartners({ tenantId, partnerTypes: ['customer', 'both'], ids: clientSel }),
    loadPartners({ tenantId, partnerTypes: ['supplier', 'both'], ids: supplierSel }),
  ])
  const manual = normalizeManualEmails(manualEmails)

  const seen = new Set()
  const dedupe = (emails) => {
    const out = []
    for (const e of emails) { if (!seen.has(e)) { seen.add(e); out.push(e) } }
    return out
  }
  const clientR   = cli.withEmail.map(c => ({ ...c, type: 'customer', emails: dedupe(c.emails) })).filter(c => c.emails.length)
  const supplierR = prov.withEmail.map(s => ({ ...s, type: 'supplier', emails: dedupe(s.emails) })).filter(s => s.emails.length)
  const manualR   = dedupe(manual)

  const recipientCount = clientR.reduce((n, c) => n + c.emails.length, 0)
                       + supplierR.reduce((n, s) => n + s.emails.length, 0)
                       + manualR.length
  if (recipientCount === 0) {
    throw createError(400, 'No hay destinatarios: selecciona clientes/proveedores con correo o escribe correos manuales.')
  }
  if (recipientCount > MAX_RECIPIENTS) {
    throw createError(400, `El envío supera el máximo de ${MAX_RECIPIENTS} destinatarios por comunicado. Divide la audiencia.`)
  }

  // 3) Batch (bitácora) en estado 'queued'.
  const { rows: sendRows } = await query(
    `INSERT INTO communication_sends
       (tenant_id, subject, message, category, attachment_count,
        client_count, supplier_count, manual_count, recipient_count, status, sent_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10)
     RETURNING id`,
    [tenantId, finalSubject, String(message || '').trim() || null, category || null,
     files.length, clientR.length, supplierR.length, manualR.length, recipientCount, sentBy || null]
  )
  const sendId = sendRows[0].id

  // 4) Persistir los adjuntos ligados al envío. En modo 2º plano el worker los
  //    RE-LEE de storage para adjuntarlos (los buffers en memoria ya no existen),
  //    así que aquí SÍ importa que se guarden bien.
  const attachErrors = []
  for (const f of files) {
    try {
      await attachmentService.saveAttachment({
        tenantId, entityType: 'communication', entityId: sendId, category: 'communication',
        originalFilename: f.originalname, buffer: f.buffer, mimeType: f.mimetype,
        uploadedBy: sentBy || null,
      })
    } catch (err) { attachErrors.push(f.originalname) }
  }

  // 5) Pre-insertar los destinatarios (status 'queued') = lista de trabajo del
  //    worker (una fila por dirección de correo).
  const pIds = [], pNames = [], pTypes = [], emails = []
  const pushRows = (list, type) => {
    for (const r of list) for (const em of r.emails) {
      pIds.push(r.id); pNames.push(r.name); pTypes.push(type); emails.push(em)
    }
  }
  pushRows(clientR, 'customer')
  pushRows(supplierR, 'supplier')
  for (const em of manualR) { pIds.push(null); pNames.push(null); pTypes.push('manual'); emails.push(em) }

  await query(
    `INSERT INTO communication_send_recipients
       (send_id, tenant_id, partner_id, partner_name, partner_type, email, status)
     SELECT $1, $2, t.pid, t.pname, t.ptype, t.email, 'queued'
       FROM unnest($3::uuid[], $4::text[], $5::text[], $6::text[]) AS t(pid, pname, ptype, email)`,
    [sendId, tenantId, pIds, pNames, pTypes, emails]
  )

  // 6) Encolar el fan-out. Reintentos ante crash (job reanudable). Si pg-boss no
  //    está disponible (null), enviamos inline con los buffers en memoria.
  const jobId = await tryEnqueueDispatch({ sendId, tenantId })

  const base = {
    sendId, recipientCount,
    clientCount: clientR.length, supplierCount: supplierR.length,
    manualCount: manualR.length, attachmentCount: files.length,
    attachErrors,
  }

  if (jobId) {
    return { ...base, status: 'queued', queued: true, sentCount: 0, failedCount: 0 }
  }

  // Fallback síncrono (sin pg-boss): procesamos ahora, con los buffers en mano.
  const inMemoryFiles = files.map(f => ({
    filename: f.originalname, content: f.buffer, contentType: f.mimetype,
  }))
  const final = await processSend({ sendId, tenantId, inMemoryFiles, ipAddress, userAgent })
  return { ...base, queued: false, ...final }
}

// ─── Worker: procesar (o reanudar) el fan-out de un envío ────────────────────
// Idempotente: solo toca destinatarios en 'queued'. `inMemoryFiles` (opcional)
// evita re-leer storage en el camino síncrono.
async function processSend({ sendId, tenantId, inMemoryFiles = null, ipAddress = null, userAgent = null }) {
  const { rows: sr } = await query(
    `SELECT id, subject, message, category, sent_by, status, recipient_count
       FROM communication_sends WHERE id = $1 AND tenant_id = $2`,
    [sendId, tenantId]
  )
  const send = sr[0]
  if (!send) return { status: 'completed', sentCount: 0, failedCount: 0 }

  // Marcar 'sending' (no piso un estado final ya alcanzado).
  await query(
    `UPDATE communication_sends SET status = 'sending'
      WHERE id = $1 AND status IN ('queued','sending')`,
    [sendId]
  )

  // Destinatarios pendientes, agrupados en "mensajes": un correo por socio (a
  // todos sus contactos) y uno por correo manual.
  const { rows: pending } = await query(
    `SELECT id, partner_id, partner_name, partner_type, email
       FROM communication_send_recipients
      WHERE send_id = $1 AND tenant_id = $2 AND status = 'queued'
      ORDER BY partner_type, partner_name NULLS LAST, email`,
    [sendId, tenantId]
  )

  if (pending.length > 0) {
    const groups = new Map()
    for (const r of pending) {
      const key = r.partner_id ? `p:${r.partner_id}` : `m:${r.email}`
      let g = groups.get(key)
      if (!g) { g = { name: r.partner_name, type: r.partner_type, emails: [], rowIds: [] }; groups.set(key, g) }
      g.emails.push(r.email)
      g.rowIds.push(r.id)
    }

    // Emisor (razón social) + branding (color + logo inline).
    const tenantName = await resolveIssuerName(tenantId)
    const { brandColor, logoCid, logoAttachment } = await getTenantEmailBranding(tenantId)

    // Adjuntos: buffers en memoria (síncrono) o re-leídos de storage (worker).
    const { emailAttachments, attachmentLabels } = await loadEmailAttachments({
      tenantId, sendId, inMemoryFiles, logoAttachment,
    })

    let i = 0
    for (const g of groups.values()) {
      const html = communicationEmail({
        tenantName, recipientName: g.name, subject: send.subject, message: send.message,
        attachmentLabels, brandColor, logoCid,
      })
      try {
        await sendEmail({ to: g.emails, subject: send.subject, html, attachments: emailAttachments })
        await query(
          `UPDATE communication_send_recipients SET status = 'sent', error = NULL
            WHERE id = ANY($1::uuid[])`, [g.rowIds])
      } catch (err) {
        await query(
          `UPDATE communication_send_recipients SET status = 'failed', error = $2
            WHERE id = ANY($1::uuid[])`, [g.rowIds, err?.message || 'Error al enviar'])
      }
      // Progreso: refrescamos el contador de enviados en el batch.
      await query(
        `UPDATE communication_sends
            SET sent_count = (SELECT COUNT(*) FROM communication_send_recipients
                               WHERE send_id = $1 AND status = 'sent')
          WHERE id = $1`, [sendId])
      if (++i < groups.size) await sleep(SEND_STAGGER_MS)
    }
  }

  // Estado final desde la bitácora de destinatarios.
  const { rows: cnt } = await query(
    `SELECT
        COUNT(*) FILTER (WHERE status = 'sent')   AS sent,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COUNT(*) FILTER (WHERE status = 'queued') AS queued
       FROM communication_send_recipients WHERE send_id = $1`,
    [sendId]
  )
  const sent = Number(cnt[0].sent), failed = Number(cnt[0].failed), queued = Number(cnt[0].queued)
  const status = queued > 0 ? 'sending' : (failed > 0 ? 'partial' : 'completed')

  await query(
    `UPDATE communication_sends SET status = $2, sent_count = $3 WHERE id = $1`,
    [sendId, status, sent]
  )

  // Auditoría una sola vez, al terminar (best-effort).
  if (queued === 0) {
    try {
      await audit({
        tenantId, userId: send.sent_by,
        action: 'communications.sent', resource: 'communication_sends', resourceId: sendId,
        payload: { subject: send.subject, category: send.category,
                   recipientCount: send.recipient_count, sent, failed },
        ipAddress, userAgent,
      })
    } catch (_) { /* la auditoría no debe romper el envío */ }
  }

  return { status, sentCount: sent, failedCount: failed }
}

// Construye la lista de adjuntos del correo (archivos del aviso + logo inline).
// Camino síncrono: usa los buffers en memoria. Camino worker: re-lee de storage.
async function loadEmailAttachments({ tenantId, sendId, inMemoryFiles, logoAttachment }) {
  const emailAttachments = []
  const attachmentLabels = []

  if (inMemoryFiles && inMemoryFiles.length) {
    for (const f of inMemoryFiles) {
      emailAttachments.push({ filename: f.filename, content: f.content, contentType: f.contentType })
      attachmentLabels.push(f.filename)
    }
  } else {
    const { rows: files } = await query(
      `SELECT filename, storage_path, mime_type
         FROM attachments
        WHERE tenant_id = $1 AND entity_type = 'communication'
          AND entity_id = $2 AND category = 'communication'
        ORDER BY created_at`,
      [tenantId, sendId]
    )
    for (const f of files) {
      try {
        const buffer = await storage.fetchBuffer(f.storage_path)
        emailAttachments.push({ filename: f.filename, content: buffer, contentType: f.mime_type })
        attachmentLabels.push(f.filename)
      } catch (_) { /* si un adjunto no se puede leer, el correo igual sale */ }
    }
  }

  if (logoAttachment) emailAttachments.push(logoAttachment)
  return { emailAttachments, attachmentLabels }
}

// Registra el worker pg-boss. Se llama en el arranque (crons.js) antes de
// startBoss(). En tests no se invoca (pg-boss desactivado).
function registerDispatchWorker() {
  const { registerWorker } = require('../../utils/pgboss')
  registerWorker(DISPATCH_QUEUE, async (data) => {
    if (!data || !data.sendId || !data.tenantId) return
    await processSend({ sendId: data.sendId, tenantId: data.tenantId })
  })
}

// ─── Historial ────────────────────────────────────────────────────────────────
async function listSends({ tenantId, limit = 50, category }) {
  const params = [tenantId]
  let catClause = ''
  if (category && String(category).trim()) {
    params.push(String(category).trim())
    catClause = `AND s.category = $${params.length}`
  }
  params.push(Math.min(Number(limit) || 50, 200))

  const { rows } = await query(
    `SELECT s.id, s.subject, s.category, s.attachment_count,
            s.client_count, s.supplier_count, s.manual_count, s.recipient_count,
            s.status, s.sent_count, s.created_at, u.full_name AS sent_by_name,
            COUNT(r.id) FILTER (WHERE r.status = 'failed') AS failed_count
       FROM communication_sends s
       LEFT JOIN users u ON u.id = s.sent_by
       LEFT JOIN communication_send_recipients r ON r.send_id = s.id
      WHERE s.tenant_id = $1
        ${catClause}
      GROUP BY s.id, u.full_name
      ORDER BY s.created_at DESC
      LIMIT $${params.length}`,
    params
  )
  return rows
}

async function getSend({ tenantId, sendId }) {
  const { rows: sr } = await query(
    `SELECT s.*, u.full_name AS sent_by_name
       FROM communication_sends s
       LEFT JOIN users u ON u.id = s.sent_by
      WHERE s.id = $1 AND s.tenant_id = $2`,
    [sendId, tenantId]
  )
  if (!sr[0]) return null
  const { rows: recipients } = await query(
    `SELECT id, partner_id, partner_name, partner_type, email, status, error, created_at
       FROM communication_send_recipients
      WHERE send_id = $1 AND tenant_id = $2
      ORDER BY partner_type, partner_name, email`,
    [sendId, tenantId]
  )
  const attachments = await attachmentService.listAttachments({
    tenantId, entityType: 'communication', entityId: sendId, category: 'communication',
  })
  return { ...sr[0], recipients, attachments }
}

// ─── Plantillas / borradores reutilizables ───────────────────────────────────
async function listTemplates({ tenantId }) {
  const { rows } = await query(
    `SELECT id, name, subject, message, category, created_at, updated_at
       FROM communication_templates
      WHERE tenant_id = $1
      ORDER BY name`,
    [tenantId]
  )
  return rows
}

async function createTemplate({ tenantId, name, subject, message, category, createdBy }) {
  const nm = String(name || '').trim()
  if (!nm) throw createError(400, 'El nombre de la plantilla es requerido.')
  const { rows } = await query(
    `INSERT INTO communication_templates (tenant_id, name, subject, message, category, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, name, subject, message, category, created_at, updated_at`,
    [tenantId, nm, String(subject || '').trim() || null,
     String(message || '').trim() || null, String(category || '').trim() || null, createdBy || null]
  )
  return rows[0]
}

async function updateTemplate({ tenantId, id, name, subject, message, category }) {
  const nm = String(name || '').trim()
  if (!nm) throw createError(400, 'El nombre de la plantilla es requerido.')
  const { rows } = await query(
    `UPDATE communication_templates
        SET name = $3, subject = $4, message = $5, category = $6, updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2
      RETURNING id, name, subject, message, category, created_at, updated_at`,
    [id, tenantId, nm, String(subject || '').trim() || null,
     String(message || '').trim() || null, String(category || '').trim() || null]
  )
  if (!rows[0]) throw createError(404, 'Plantilla no encontrada.')
  return rows[0]
}

async function deleteTemplate({ tenantId, id }) {
  const { rowCount } = await query(
    `DELETE FROM communication_templates WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  )
  if (rowCount === 0) throw createError(404, 'Plantilla no encontrada.')
  return { ok: true }
}

// ─── Categorías configurables por tenant ─────────────────────────────────────
async function listCategories({ tenantId, activeOnly = false }) {
  const { rows } = await query(
    `SELECT id, name, sort_order, is_active
       FROM communication_categories
      WHERE tenant_id = $1 ${activeOnly ? 'AND is_active = true' : ''}
      ORDER BY sort_order, name`,
    [tenantId]
  )
  return rows
}

async function createCategory({ tenantId, name, sortOrder }) {
  const nm = String(name || '').trim()
  if (!nm) throw createError(400, 'El nombre de la categoría es requerido.')
  try {
    const { rows } = await query(
      `INSERT INTO communication_categories (tenant_id, name, sort_order)
       VALUES ($1,$2,$3) RETURNING id, name, sort_order, is_active`,
      [tenantId, nm, Number.isFinite(+sortOrder) ? +sortOrder : 0]
    )
    return rows[0]
  } catch (err) {
    if (err.code === '23505') throw createError(409, 'Ya existe una categoría con ese nombre.')
    throw err
  }
}

async function updateCategory({ tenantId, id, name, sortOrder, isActive }) {
  const sets = []
  const params = [id, tenantId]
  if (name !== undefined) {
    const nm = String(name || '').trim()
    if (!nm) throw createError(400, 'El nombre de la categoría es requerido.')
    params.push(nm); sets.push(`name = $${params.length}`)
  }
  if (sortOrder !== undefined) { params.push(+sortOrder || 0); sets.push(`sort_order = $${params.length}`) }
  if (isActive !== undefined)  { params.push(!!isActive);      sets.push(`is_active = $${params.length}`) }
  if (sets.length === 0) throw createError(400, 'Nada que actualizar.')
  try {
    const { rows } = await query(
      `UPDATE communication_categories SET ${sets.join(', ')}
        WHERE id = $1 AND tenant_id = $2
        RETURNING id, name, sort_order, is_active`,
      params
    )
    if (!rows[0]) throw createError(404, 'Categoría no encontrada.')
    return rows[0]
  } catch (err) {
    if (err.code === '23505') throw createError(409, 'Ya existe una categoría con ese nombre.')
    throw err
  }
}

async function deleteCategory({ tenantId, id }) {
  const { rowCount } = await query(
    `DELETE FROM communication_categories WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  )
  if (rowCount === 0) throw createError(404, 'Categoría no encontrada.')
  return { ok: true }
}

module.exports = {
  previewRecipients, distribute, processSend, registerDispatchWorker,
  listSends, getSend,
  listTemplates, createTemplate, updateTemplate, deleteTemplate,
  listCategories, createCategory, updateCategory, deleteCategory,
}
