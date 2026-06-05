'use strict'

/* Política de privacidad pública de la app Praxion (requisito de Google Play y
 * de la tienda de iOS). Se sirve como HTML estático sin auth desde /privacidad.
 * La URL pública estable es ${API_PUBLIC_URL}/privacidad — esa va en Play Console
 * (campo "Política de privacidad") y en la ficha de App Store. */

const UPDATED = '5 de junio de 2026'
const CONTACT_EMAIL = 'contacto@praxionsystems.mx'

const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Política de privacidad · Praxion</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; background:#0B0F12; color:#1c2128; font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; line-height:1.6; }
  .wrap { max-width:780px; margin:0 auto; background:#fff; padding:48px 40px 64px; }
  header { border-bottom:4px solid #82a926; padding-bottom:16px; margin-bottom:8px; }
  h1 { font-size:28px; margin:0 0 4px; color:#0B0F12; }
  .sub { color:#5b6770; font-size:14px; }
  h2 { font-size:19px; margin:34px 0 8px; color:#0B0F12; }
  h3 { font-size:15px; margin:18px 0 4px; color:#33414b; }
  p, li { font-size:15px; color:#33414b; }
  ul { padding-left:22px; }
  a { color:#5a7a12; }
  code { background:#f0f2ee; padding:1px 5px; border-radius:4px; font-size:14px; }
  footer { margin-top:48px; padding-top:16px; border-top:1px solid #e6e9e4; color:#7a8590; font-size:13px; }
  @media (max-width:640px){ .wrap{ padding:32px 20px 48px; } h1{ font-size:23px; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Política de privacidad — Praxion</h1>
    <div class="sub">Última actualización: ${UPDATED}</div>
  </header>

  <p>Esta política describe cómo la aplicación <strong>Praxion</strong> (en adelante, "la App"),
  un sistema de gestión empresarial (ERP) operado por <strong>Praxion Systems</strong>, recopila,
  usa y protege la información de sus usuarios. La App está dirigida a empleados y administradores
  de empresas que contratan el servicio; no está dirigida al público general ni a menores de edad.</p>

  <h2>1. Responsable del tratamiento</h2>
  <p>Praxion Systems es responsable del tratamiento de los datos recabados a través de la App.
  Para cualquier asunto relacionado con privacidad puede escribir a
  <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>

  <h2>2. Información que recopilamos</h2>
  <h3>Datos de cuenta</h3>
  <ul>
    <li><strong>Nombre y correo electrónico</strong>: para identificar al usuario, autenticarlo
        e iniciar sesión, y asociarlo a la empresa (tenant) a la que pertenece.</li>
  </ul>
  <h3>Contenido generado por el usuario</h3>
  <ul>
    <li><strong>Fotografías y documentos</strong> que el usuario captura voluntariamente como
        evidencia de entregas y recepciones (foto del paquete, comprobante firmado, documento
        escaneado). Se almacenan asociados al registro operativo correspondiente.</li>
    <li><strong>Firmas digitales</strong> trazadas en pantalla cuando se registra una entrega
        sin documento físico.</li>
  </ul>
  <h3>Datos operativos del negocio</h3>
  <ul>
    <li>Información de la operación de la empresa (pedidos, inventario, producción, compras,
        facturación) capturada por el usuario en el desempeño de su trabajo. Estos datos
        pertenecen a la empresa contratante, no al usuario individual.</li>
  </ul>
  <h3>Identificadores técnicos</h3>
  <ul>
    <li><strong>Token de notificaciones push</strong> (Firebase Cloud Messaging): para enviar
        avisos operativos al dispositivo. No es un identificador publicitario y no se usa con
        fines de marketing.</li>
    <li><strong>Datos de diagnóstico</strong>: registros técnicos y de errores para mantener la
        estabilidad del servicio.</li>
  </ul>

  <h2>3. Permisos del dispositivo</h2>
  <ul>
    <li><strong>Cámara</strong>: para escanear códigos de barras, escanear documentos y tomar
        fotos de evidencia. La cámara solo se activa cuando el usuario lo solicita.</li>
    <li><strong>Notificaciones</strong>: para entregar avisos operativos (nuevos pedidos,
        recepciones, stock bajo, etc.).</li>
    <li><strong>Almacenamiento / archivos</strong>: para guardar y compartir documentos PDF
        (remisiones, recibos) generados por la App.</li>
  </ul>

  <h2>4. Cómo usamos la información</h2>
  <ul>
    <li>Prestar el servicio de la App y permitir la operación diaria de la empresa.</li>
    <li>Autenticar al usuario y proteger su cuenta.</li>
    <li>Enviar notificaciones operativas relevantes para su rol.</li>
    <li>Generar documentos (remisiones, recibos, recepciones) y, cuando aplica, comprobantes
        fiscales (CFDI).</li>
    <li>Mantener la seguridad, prevenir el fraude y diagnosticar fallas.</li>
  </ul>
  <p>No vendemos datos personales ni los usamos para publicidad de terceros.</p>

  <h2>5. Con quién compartimos la información</h2>
  <p>Compartimos datos únicamente con proveedores que nos ayudan a operar el servicio, bajo
  obligaciones de confidencialidad:</p>
  <ul>
    <li><strong>Render</strong> — alojamiento del servidor y base de datos.</li>
    <li><strong>Cloudflare R2</strong> — almacenamiento de archivos (fotos y documentos).</li>
    <li><strong>Google Firebase (Cloud Messaging)</strong> — entrega de notificaciones push.</li>
    <li><strong>Facturapi</strong> — timbrado de comprobantes fiscales (CFDI), cuando el usuario
        emite facturas.</li>
    <li><strong>Google Workspace</strong> — envío de correos transaccionales (invitaciones,
        comprobantes).</li>
    <li><strong>Sentry</strong> — monitoreo de errores y diagnóstico técnico.</li>
  </ul>
  <p>También podremos divulgar información cuando lo exija la ley o una autoridad competente.</p>

  <h2>6. Seguridad</h2>
  <p>La información se transmite cifrada mediante TLS/HTTPS. El acceso está protegido por
  autenticación basada en tokens y por un modelo de permisos por rol. Cada empresa (tenant)
  está aislada de las demás.</p>

  <h2>7. Conservación de los datos</h2>
  <p>Conservamos los datos mientras la cuenta esté activa y durante el tiempo necesario para
  cumplir obligaciones legales, contables y fiscales aplicables. Después de ese periodo se
  eliminan o se anonimizan.</p>

  <h2>8. Sus derechos y eliminación de datos</h2>
  <p>El usuario puede solicitar acceso, rectificación o eliminación de sus datos personales.
  La eliminación de una cuenta de usuario puede realizarse a través del administrador de su
  empresa o solicitándola a <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>. Atenderemos
  la solicitud conforme a la legislación aplicable.</p>

  <h2>9. Menores de edad</h2>
  <p>La App es una herramienta de trabajo y no está dirigida a menores de 18 años. No
  recopilamos conscientemente datos de menores.</p>

  <h2>10. Cambios a esta política</h2>
  <p>Podremos actualizar esta política. Publicaremos la versión vigente en esta misma dirección
  e indicaremos la fecha de la última actualización en la parte superior.</p>

  <h2>11. Contacto</h2>
  <p>Dudas o solicitudes sobre privacidad: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>

  <footer>© Praxion Systems · Praxion ERP. Esta página se publica como parte de los requisitos
  de las tiendas de aplicaciones.</footer>
</div>
</body>
</html>`

module.exports = { html, UPDATED, CONTACT_EMAIL }
