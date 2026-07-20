'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// Distribución de documentos fiscales (CSF + Opinión 32-D) a clientes.
//
// El tenant sube su Constancia de Situación Fiscal (CSF) y su Opinión de
// Cumplimiento (art. 32-D CFF) —descargadas del SAT en PDF— y el ERP las envía
// por correo a sus clientes: UN correo INDIVIDUAL por cliente (no se cruzan
// entre sí = privacidad), a TODOS los contactos con email de ese cliente.
//
// Los docs se guardan como attachments a nivel tenant (entity_type='tenant',
// categorías fiscal_csf/fiscal_32d, reemplazables). La bitácora de cada envío
// vive en fiscal_doc_sends + fiscal_doc_send_recipients (comprobante de
// cumplimiento). Ver [[fiscal-docs-distribution-plan]].
// ─────────────────────────────────────────────────────────────────────────────

const { query } = require('../../db')
const attachmentService = require('../attachments/attachmentService')
const storage = require('../../utils/storage')
const { enqueueEmail } = require('../../queues/emailQueue')
const { audit } = require('../../utils/audit')
const { fiscalDocsEmail } = require('../email/templates')

// Logos que los clientes de correo renderizan inline de forma confiable (SVG NO
// — Gmail lo bloquea; si el logo es SVG el correo cae al encabezado de texto).
const LOGO_MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

const ENTITY_TYPE = 'tenant'
const CATEGORY = { csf: 'fiscal_csf', opinion: 'fiscal_32d' }
// Espaciado entre correos (ms) para no saturar Workspace en lotes grandes.
const SEND_STAGGER_MS = 300

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

function docTypeToCategory(docType) {
  const cat = CATEGORY[docType]
  if (!cat) throw createError(400, `docType inválido: ${docType}. Usa 'csf' u 'opinion'.`)
  return cat
}

// ─── Subir / reemplazar un documento fiscal del tenant ───────────────────────
async function uploadFiscalDoc({ tenantId, docType, buffer, originalFilename, mimeType, uploadedBy }) {
  const category = docTypeToCategory(docType)
  // replaceCategory: solo un documento vigente por tipo (el nuevo pisa al viejo).
  return attachmentService.saveAttachment({
    tenantId,
    entityType: ENTITY_TYPE,
    entityId:   tenantId,
    category,
    originalFilename,
    buffer,
    mimeType,
    uploadedBy,
    replaceCategory: true,
  })
}

// ─── Consultar los documentos fiscales cargados ──────────────────────────────
async function getFiscalDocs({ tenantId }) {
  const [csfList, opinionList] = await Promise.all([
    attachmentService.listAttachments({ tenantId, entityType: ENTITY_TYPE, entityId: tenantId, category: CATEGORY.csf }),
    attachmentService.listAttachments({ tenantId, entityType: ENTITY_TYPE, entityId: tenantId, category: CATEGORY.opinion }),
  ])
  return { csf: csfList[0] || null, opinion: opinionList[0] || null }
}

// ─── Metadata + key de un doc para servirlo/descargarlo ──────────────────────
async function getFiscalDocForServe({ tenantId, docType }) {
  const category = docTypeToCategory(docType)
  const list = await attachmentService.listAttachments({ tenantId, entityType: ENTITY_TYPE, entityId: tenantId, category })
  if (!list[0]) return null
  return attachmentService.getAttachmentInfo({ tenantId, attachmentId: list[0].id })
}

// ─── Eliminar un doc fiscal ──────────────────────────────────────────────────
async function deleteFiscalDoc({ tenantId, docType }) {
  const category = docTypeToCategory(docType)
  const list = await attachmentService.listAttachments({ tenantId, entityType: ENTITY_TYPE, entityId: tenantId, category })
  if (!list[0]) return null
  return attachmentService.deleteAttachment({ tenantId, attachmentId: list[0].id })
}

// ─── Armar destinatarios: clientes activos con contacto(s) con email ─────────
// Devuelve por cliente sus correos. `partnerIds` (opcional) acota la selección.
async function buildRecipients({ tenantId, partnerIds }) {
  // Semántica: partnerIds `undefined` = TODOS los clientes activos; un array VACÍO
  // = NINGUNO (el usuario deseleccionó todo y solo manda a correos manuales). Sin
  // esta distinción, `[]` caería en "sin filtro" = enviar a todos por accidente.
  if (Array.isArray(partnerIds) && partnerIds.length === 0) {
    return { clients: [], clientsWithoutEmail: [] }
  }
  const params = [tenantId]
  let idFilter = ''
  if (Array.isArray(partnerIds) && partnerIds.length > 0) {
    params.push(partnerIds)
    idFilter = `AND bp.id = ANY($${params.length}::uuid[])`
  }

  // Clientes activos (customer/both), NO ocasionales.
  const { rows: partners } = await query(
    `SELECT bp.id, COALESCE(NULLIF(bp.tax_name, ''), bp.name) AS name
       FROM business_partners bp
      WHERE bp.tenant_id = $1
        AND bp.type IN ('customer','both')
        AND bp.is_active = true
        AND COALESCE(bp.is_occasional, false) = false
        ${idFilter}
      ORDER BY name`,
    params
  )
  if (partners.length === 0) return { clients: [], clientsWithoutEmail: [] }

  const ids = partners.map(p => p.id)
  const { rows: contacts } = await query(
    `SELECT business_partner_id, LOWER(TRIM(email)) AS email
       FROM business_partner_contacts
      WHERE business_partner_id = ANY($1::uuid[])
        AND email IS NOT NULL AND TRIM(email) <> ''`,
    [ids]
  )
  const emailsByPartner = {}
  for (const c of contacts) {
    if (!emailsByPartner[c.business_partner_id]) emailsByPartner[c.business_partner_id] = new Set()
    emailsByPartner[c.business_partner_id].add(c.email)
  }

  const clients = []
  const clientsWithoutEmail = []
  for (const p of partners) {
    const emails = Array.from(emailsByPartner[p.id] || [])
    if (emails.length > 0) clients.push({ id: p.id, name: p.name, emails })
    else clientsWithoutEmail.push({ id: p.id, name: p.name })
  }
  return { clients, clientsWithoutEmail }
}

// ─── Razón social del emisor (para asunto/cuerpo por default) ────────────────
// Muchos clientes tienen registrado a su proveedor por su RAZÓN SOCIAL, no por
// el nombre comercial. Prioridad: perfil fiscal activo (tax_name = razón social
// CFDI) → tenant_fiscal_info legacy (razon_social) → nombre comercial del tenant.
async function resolveIssuerName(tenantId) {
  const { rows } = await query(
    `SELECT COALESCE(
       -- El tenant tiene 1 perfil activo en la práctica (igual que getProfile /
       -- listProfiles del módulo fiscal-profiles); ordenamos por created_at.
       (SELECT NULLIF(TRIM(tax_name), '')
          FROM tenant_fiscal_profiles
         WHERE tenant_id = $1 AND is_active = TRUE
         ORDER BY created_at ASC
         LIMIT 1),
       (SELECT NULLIF(TRIM(razon_social), '')
          FROM tenant_fiscal_info WHERE tenant_id = $1),
       (SELECT NULLIF(TRIM(display_name), '') FROM tenants WHERE id = $1),
       (SELECT name FROM tenants WHERE id = $1)
     ) AS issuer_name`,
    [tenantId]
  )
  return rows[0]?.issuer_name || 'Su proveedor'
}

// ─── Preview de conteos antes de enviar ──────────────────────────────────────
async function previewRecipients({ tenantId, partnerIds }) {
  const { clients, clientsWithoutEmail } = await buildRecipients({ tenantId, partnerIds })
  const recipientCount = clients.reduce((n, c) => n + c.emails.length, 0)
  return {
    clientCount: clients.length,
    recipientCount,
    clients,
    clientsWithoutEmail,
  }
}

// Correos manuales (campo tipo "Para" de Gmail): separados por coma/;/espacio/
// salto de línea. Normaliza (trim+lowercase), valida forma básica, DEDUPE y topa
// a 200 por seguridad. Los inválidos se IGNORAN en silencio (el front ya avisa).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
function normalizeManualEmails(input) {
  if (!input) return []
  const arr = Array.isArray(input) ? input : String(input).split(/[\s,;]+/)
  const seen = new Set()
  const out = []
  for (const raw of arr) {
    const e = String(raw || '').trim().toLowerCase()
    if (!e || !EMAIL_RE.test(e) || seen.has(e)) continue
    seen.add(e)
    out.push(e)
  }
  return out.slice(0, 200)
}

// ─── Enviar los docs fiscales a los clientes ─────────────────────────────────
async function distributeToClients({ tenantId, partnerIds, manualEmails, message, subject, sentBy, ipAddress, userAgent }) {
  // 1) Documentos: al menos uno requerido.
  const docs = await getFiscalDocs({ tenantId })
  if (!docs.csf && !docs.opinion) {
    throw createError(400, 'Sube al menos un documento fiscal (CSF u Opinión 32-D) antes de enviar.')
  }

  // 2) Buffers desde storage (una sola vez; el mismo adjunto va a todos).
  const attachments = []
  const docLabels = []
  for (const [docType, doc] of [['csf', docs.csf], ['opinion', docs.opinion]]) {
    if (!doc) continue
    const info = await attachmentService.getAttachmentInfo({ tenantId, attachmentId: doc.id })
    const buffer = info && await storage.fetchBuffer(info.storage_path)
    if (!buffer) throw createError(500, `No se pudo leer el archivo de ${docType === 'csf' ? 'la CSF' : 'la Opinión 32-D'}.`)
    attachments.push({ filename: info.filename, content: buffer, contentType: 'application/pdf' })
    docLabels.push(docType === 'csf' ? 'Constancia de Situación Fiscal (CSF)' : 'Opinión de Cumplimiento (art. 32-D)')
  }

  // 3) Destinatarios: clientes del catálogo + correos manuales (campo tipo Gmail).
  const { clients } = await buildRecipients({ tenantId, partnerIds })
  const manual = normalizeManualEmails(manualEmails)
  if (clients.length === 0 && manual.length === 0) {
    throw createError(400, 'No hay destinatarios: selecciona clientes con correo o escribe al menos un correo manual válido.')
  }
  const clientRecipientCount = clients.reduce((n, c) => n + c.emails.length, 0)
  const recipientCount = clientRecipientCount + manual.length

  // 4) Razón social del emisor para el asunto/cuerpo por default (ver
  //    resolveIssuerName: razón social fiscal → legacy → nombre comercial).
  const tenantName = await resolveIssuerName(tenantId)
  const finalSubject = (subject || '').trim() || `Documentos fiscales — ${tenantName}`

  // 4b) Branding del tenant para el correo: color de marca + logo. El logo se
  //     incrusta INLINE (cid) — un solo adjunto compartido por todos los correos
  //     del lote — para que se vea sin depender de hosting público ni CORS. SVG
  //     y formatos raros se omiten (caen al encabezado de texto).
  const { rows: brandRows } = await query(
    `SELECT brand_color_primary, logo_storage_path FROM tenants WHERE id = $1`,
    [tenantId]
  )
  const brandColor = brandRows[0]?.brand_color_primary || null
  let logoCid = null
  const logoPath = brandRows[0]?.logo_storage_path
  if (logoPath) {
    const ext  = String(logoPath.split('.').pop() || '').toLowerCase()
    const mime = LOGO_MIME_BY_EXT[ext]
    if (mime) {
      try {
        const logoBuf = await storage.fetchBuffer(logoPath)
        if (logoBuf) {
          logoCid = 'brandlogo'
          attachments.push({
            filename: `logo.${ext}`, content: logoBuf, contentType: mime,
            cid: logoCid, contentDisposition: 'inline',
          })
        }
      } catch (_) { /* si el logo falla, el correo sale con encabezado de texto */ }
    }
  }

  // 5) Crear el batch de envío (bitácora).
  const { rows: sendRows } = await query(
    `INSERT INTO fiscal_doc_sends
       (tenant_id, csf_filename, opinion_filename, included_csf, included_opinion,
        subject, message, client_count, recipient_count, status, sent_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10)
     RETURNING id`,
    [tenantId,
     docs.csf?.filename || null, docs.opinion?.filename || null,
     !!docs.csf, !!docs.opinion,
     finalSubject, (message || '').trim() || null,
     clients.length, recipientCount, sentBy || null]
  )
  const sendId = sendRows[0].id

  // 6) Encolar UN correo por cliente (a todos sus contactos), con bitácora por
  //    correo. Los fallos síncronos (modo sin cola) no abortan el lote.
  let failed = 0
  let idx = 0
  for (const client of clients) {
    const html = fiscalDocsEmail({ tenantName, clientName: client.name, userMessage: message, docLabels, brandColor, logoCid })
    let clientFailed = false
    let errMsg = null
    try {
      await enqueueEmail(
        {
          to: client.emails,
          subject: finalSubject,
          html,
          attachments,
          tenantId, // habilita la alerta email_delivery_failed si rebota definitivo
        },
        { delay: idx * SEND_STAGGER_MS }
      )
    } catch (err) {
      clientFailed = true
      errMsg = err?.message || 'Error al enviar'
    }

    for (const email of client.emails) {
      if (clientFailed) failed++
      await query(
        `INSERT INTO fiscal_doc_send_recipients
           (send_id, tenant_id, partner_id, partner_name, email, status, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [sendId, tenantId, client.id, client.name, email,
         clientFailed ? 'failed' : 'queued', errMsg]
      )
    }
    idx++
  }

  // 6b) Correos manuales: UN correo individual por dirección (privacidad, mismo
  //     criterio que por cliente). Sin nombre de cliente → saludo genérico.
  for (const email of manual) {
    const html = fiscalDocsEmail({ tenantName, clientName: null, userMessage: message, docLabels, brandColor, logoCid })
    let recFailed = false
    let errMsg = null
    try {
      await enqueueEmail(
        { to: email, subject: finalSubject, html, attachments, tenantId },
        { delay: idx * SEND_STAGGER_MS }
      )
    } catch (err) {
      recFailed = true
      errMsg = err?.message || 'Error al enviar'
    }
    if (recFailed) failed++
    await query(
      `INSERT INTO fiscal_doc_send_recipients
         (send_id, tenant_id, partner_id, partner_name, email, status, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [sendId, tenantId, null, '(Correo manual)', email,
       recFailed ? 'failed' : 'queued', errMsg]
    )
    idx++
  }

  // 7) Estado final del batch.
  const status = failed === 0 ? 'completed' : 'partial'
  await query(`UPDATE fiscal_doc_sends SET status = $1 WHERE id = $2`, [status, sendId])

  try {
    await audit({
      tenantId, userId: sentBy,
      action: 'fiscal_docs.distributed', resource: 'fiscal_doc_sends', resourceId: sendId,
      payload: { clientCount: clients.length, manualCount: manual.length, recipientCount, failed, docLabels },
      ipAddress, userAgent,
    })
  } catch (_) { /* audit no debe romper el envío */ }

  return { sendId, clientCount: clients.length, manualCount: manual.length, recipientCount, failedCount: failed, status }
}

// ─── Historial de envíos ─────────────────────────────────────────────────────
async function listSends({ tenantId, limit = 50 }) {
  const { rows } = await query(
    `SELECT s.id, s.subject, s.included_csf, s.included_opinion,
            s.csf_filename, s.opinion_filename,
            s.client_count, s.recipient_count, s.status, s.created_at,
            u.full_name AS sent_by_name,
            COUNT(r.id) FILTER (WHERE r.status = 'failed') AS failed_count
       FROM fiscal_doc_sends s
       LEFT JOIN users u ON u.id = s.sent_by
       LEFT JOIN fiscal_doc_send_recipients r ON r.send_id = s.id
      WHERE s.tenant_id = $1
      GROUP BY s.id, u.full_name
      ORDER BY s.created_at DESC
      LIMIT $2`,
    [tenantId, Math.min(Number(limit) || 50, 200)]
  )
  return rows
}

async function getSend({ tenantId, sendId }) {
  const { rows: sr } = await query(
    `SELECT s.*, u.full_name AS sent_by_name
       FROM fiscal_doc_sends s
       LEFT JOIN users u ON u.id = s.sent_by
      WHERE s.id = $1 AND s.tenant_id = $2`,
    [sendId, tenantId]
  )
  if (!sr[0]) return null
  const { rows: recipients } = await query(
    `SELECT id, partner_id, partner_name, email, status, error, created_at
       FROM fiscal_doc_send_recipients
      WHERE send_id = $1 AND tenant_id = $2
      ORDER BY partner_name, email`,
    [sendId, tenantId]
  )
  return { ...sr[0], recipients }
}

module.exports = {
  uploadFiscalDoc,
  getFiscalDocs,
  getFiscalDocForServe,
  deleteFiscalDoc,
  previewRecipients,
  distributeToClients,
  listSends,
  getSend,
}
