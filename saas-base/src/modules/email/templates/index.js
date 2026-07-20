'use strict'

const config = require('../../../config')
const { htmlWitnessMark } = require('../../../utils/praxionWitnessMark')

/**
 * Template base — wrapper HTML compartido por todos los emails de cuenta
 * (bienvenida, invitación, restablecer contraseña).
 *
 * Si el caller pasa `brandColor` y/o `headerName`, el header del email lleva
 * la identidad del tenant (no la de Praxion). Cuando no hay tenant context
 * — por ejemplo en auto-registro — se cae al branding por defecto.
 */
function baseTemplate({ title, preheader, body, brandColor, headerName, logoCid }) {
  const headerBg = brandColor || '#1a1a2e'
  const btnBg    = brandColor || '#4f46e5'
  const heading  = headerName || config.email.fromName
  // Si el tenant tiene logo, lo mostramos dentro de un "chip" blanco para que
  // sea legible sobre cualquier color de marca; si no, cae al nombre en texto.
  const headerInner = logoCid
    ? `<span style="display:inline-block;background:#ffffff;border-radius:10px;padding:10px 16px;">
         <img src="cid:${logoCid}" alt="${heading}" style="max-height:44px;max-width:220px;display:block;">
       </span>`
    : `<h1>${heading}</h1>`
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { margin: 0; padding: 0; background: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .wrapper { max-width: 560px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .header { background: ${headerBg}; padding: 32px 40px; text-align: center; }
    .header h1 { color: #ffffff; margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.3px; }
    .body { padding: 40px; color: #374151; font-size: 15px; line-height: 1.7; }
    .body h2 { color: #111827; font-size: 20px; font-weight: 600; margin: 0 0 16px; }
    .body p { margin: 0 0 16px; }
    .btn { display: inline-block; background: ${btnBg}; color: #ffffff !important; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 15px; margin: 8px 0 24px; }
    .credentials { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px 24px; margin: 20px 0; }
    .credentials p { margin: 4px 0; font-size: 14px; }
    .credentials strong { color: #111827; }
    .credentials code { background: #e5e7eb; padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 13px; }
    .footer { padding: 24px 40px; text-align: center; font-size: 12px; color: #9ca3af; border-top: 1px solid #f3f4f6; }
    .footer a { color: #6b7280; }
  </style>
</head>
<body>
  <div style="display:none;max-height:0;overflow:hidden;">${preheader}</div>
  <div class="wrapper">
    <div class="header">
      ${headerInner}
    </div>
    <div class="body">
      ${body}
    </div>
    <div class="footer">
      <p>© ${new Date().getFullYear()} ${heading}. Todos los derechos reservados.</p>
    </div>
    ${htmlWitnessMark()}
  </div>
</body>
</html>`
}

/**
 * Email de invitación a un nuevo usuario.
 */
function invitationEmail({ fullName, email, tempPassword, tenantName, invitedByName, brandColor }) {
  const loginUrl = `${config.appUrl}/login`

  return baseTemplate({
    title:     `Invitación a ${tenantName}`,
    preheader: `${invitedByName} te ha invitado a unirte a ${tenantName}`,
    brandColor,
    headerName: tenantName,
    body: `
      <h2>Te han invitado a ${tenantName}</h2>
      <p>Hola <strong>${fullName}</strong>,</p>
      <p><strong>${invitedByName}</strong> te ha invitado a unirte a <strong>${tenantName}</strong>.</p>
      <p>Usa estas credenciales para acceder por primera vez:</p>
      <div class="credentials">
        <p><strong>Email:</strong> <code>${email}</code></p>
        <p><strong>Contraseña temporal:</strong> <code>${tempPassword}</code></p>
      </div>
      <p>Te recomendamos cambiar tu contraseña después de iniciar sesión.</p>
      <a href="${loginUrl}" class="btn">Iniciar sesión</a>
      ${androidDownloadBlock(tenantName)}
      <p style="font-size:13px;color:#6b7280;">Si no esperabas esta invitación, puedes ignorar este correo.</p>
    `,
  })
}

/**
 * Bloque "Descargar app Android" para los correos de onboarding. Apunta a una
 * URL ESTABLE del backend (/app/android) que sirve el APK auto-hospedado hoy y
 * redirige a Play Store cuando ANDROID_APP_URL esté configurada — sin reenviar
 * correos ni cambiar la plantilla.
 */
function androidDownloadBlock(tenantName) {
  const androidUrl = `${config.apiPublicUrl}/app/android`
  return `
      <div style="margin:8px 0 24px;padding:16px 20px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
        <p style="margin:0 0 6px;font-size:14px;color:#111827;"><strong>📱 ¿Operas desde el celular?</strong></p>
        <p style="margin:0 0 12px;font-size:13px;color:#6b7280;">Instala la app Android de ${tenantName} para vender, surtir, producir y comprar desde tu teléfono — con escáner de código de barras.</p>
        <a href="${androidUrl}" style="display:inline-block;background:#111827;color:#ffffff !important;text-decoration:none;padding:10px 22px;border-radius:8px;font-weight:600;font-size:14px;">⬇ Descargar app Android</a>
      </div>`
}

/**
 * Email de bienvenida al provisionar un nuevo tenant.
 * Si se pasa `tempPassword`, lo incluye en la caja de credenciales — caso de
 * uso: el super-admin crea la cuenta en nombre del cliente y nosotros le
 * mandamos sus datos de acceso. En el flujo público (auto-registro), la
 * password la escogió el propio usuario, así que no se envía de vuelta.
 */
function welcomeEmail({ fullName, email, tenantName, tenantSlug, tempPassword = null, brandColor = null }) {
  const loginUrl = `${config.appUrl}/login`

  return baseTemplate({
    title:     `Bienvenido a ${config.email.fromName}`,
    preheader: `Tu cuenta de ${tenantName} está lista`,
    brandColor,
    headerName: tenantName,
    body: `
      <h2>¡Bienvenido, ${fullName}!</h2>
      <p>Tu cuenta de <strong>${tenantName}</strong> ha sido creada exitosamente.</p>
      <div class="credentials">
        <p><strong>Organización:</strong> <code>${tenantSlug}</code></p>
        <p><strong>Email:</strong> <code>${email}</code></p>
        ${tempPassword ? `<p><strong>Contraseña inicial:</strong> <code>${tempPassword}</code></p>` : ''}
      </div>
      ${tempPassword
        ? `<p>Por seguridad, te recomendamos cambiar tu contraseña al entrar por primera vez (Mi perfil → Cambiar contraseña).</p>`
        : `<p>Ya puedes iniciar sesión y comenzar a configurar tu espacio de trabajo.</p>`}
      <a href="${loginUrl}" class="btn">Ir al panel</a>
      ${androidDownloadBlock(tenantName)}
    `,
  })
}

/**
 * Email de restablecimiento de contraseña.
 */
function passwordResetEmail({ fullName, resetToken, tenantSlug, tenantName, brandColor }) {
  // Incluimos el tenant slug en la URL: el frontend lo necesita para enviar el
  // header X-Tenant-Slug correcto al endpoint /auth/reset-password, que valida
  // que el tenant del token coincida.
  const slugParam = tenantSlug ? `&tenant=${encodeURIComponent(tenantSlug)}` : ''
  const resetUrl = `${config.appUrl}/reset-password?token=${resetToken}${slugParam}`

  return baseTemplate({
    title:     'Restablecer contraseña',
    preheader: 'Solicitud de restablecimiento de contraseña',
    brandColor,
    headerName: tenantName,
    body: `
      <h2>Restablecer contraseña</h2>
      <p>Hola <strong>${fullName}</strong>,</p>
      <p>Recibimos una solicitud para restablecer tu contraseña. Haz clic en el botón para continuar:</p>
      <a href="${resetUrl}" class="btn">Restablecer contraseña</a>
      <p style="font-size:13px;color:#6b7280;">Este enlace expira en <strong>1 hora</strong>.</p>
      <p style="font-size:13px;color:#6b7280;">Si no solicitaste este cambio, puedes ignorar este correo — tu contraseña no cambiará.</p>
    `,
  })
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ))
}

/**
 * Email de distribución de documentos fiscales (CSF + Opinión 32-D) a un
 * cliente. Usa el layout branded compartido (header con color/logo del tenant +
 * pie "Powered by Praxion"). `clientName` ausente = correo manual (saludo
 * genérico). `userMessage` reemplaza el saludo estándar si viene.
 */
function fiscalDocsEmail({ tenantName, clientName, userMessage, docLabels = [], brandColor, logoCid }) {
  const heading = tenantName || config.email.fromName
  const greeting = clientName
    ? `Estimad@ <strong>${escapeHtml(clientName)}</strong>,`
    : 'Estimad@ cliente,'
  const intro = userMessage
    ? `<p>${escapeHtml(userMessage).replace(/\n/g, '<br>')}</p>`
    : `<p>${greeting}</p>
       <p>Adjuntamos nuestros documentos fiscales vigentes para sus registros y trámites.</p>`
  const list = docLabels.length
    ? `<p style="margin:16px 0 4px">Documentos adjuntos:</p>
       <ul style="margin:0 0 16px">${docLabels.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`
    : ''
  return baseTemplate({
    title:     `Documentos fiscales — ${escapeHtml(heading)}`,
    preheader: `Documentos fiscales de ${escapeHtml(heading)}`,
    brandColor,
    headerName: heading,
    logoCid,
    body: `
      <h2>Documentos fiscales</h2>
      ${intro}
      ${list}
      <p style="font-size:13px;color:#6b7280;">Si no esperabas recibir estos documentos, puedes ignorar este mensaje.</p>
    `,
  })
}

module.exports = { invitationEmail, welcomeEmail, passwordResetEmail, fiscalDocsEmail }
