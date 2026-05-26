# HANDOFF — 2026-05-15 (cierre sesión 9)

## Módulo trabajado
**Ventas end-to-end** — cierre del ciclo fiscal completo: envío de correos, edición de borradores, multi-pedido en remisión, multi-factura por remisión, cancelación SAT, notas de crédito (monto y por línea), complementos de pago, copia institucional, pestañas Remisionado/Facturado en cobranza.

## Estado de la tarea
**Sesión cerrada con flujo fiscal operativo**. El usuario ya emitió facturas/NCs/complementos. Quedó un pendiente reportado: **verificar y/o ajustar el timbrado automático del complemento desde el modal CXC** (Fase 2 del flujo de pagos PPD).

## Pendiente reportado al cierre

> "Falta generar el complemento de pago timbrado"

El backend ya orquesta `stampPaymentComplement` dentro de `registerPayment` cuando aplica pago a una factura PPD. La integración con Facturapi se hace dentro de la misma transacción. Si el operador reporta que no se está timbrando, revisar:
1. Que `bp.tax_regime_code` y `bp.zip_code` estén poblados (Facturapi los exige en el customer).
2. Que la factura origen tenga `cfdi_uuid` y la marca `[facturapi_id:...]` en `notes`.
3. Que el TC (`invoice_exchange_rate`) esté disponible si la factura es USD.
4. Revisar logs de Facturapi al fallar — el error sube como `422` con `Error al timbrar complemento de pago de ${docNumber}: ${msg}` y hace rollback global.

## Migraciones aplicadas en sesión 9 (076–081)

- **076** `tenants.notification_email` — correo institucional configurable por tenant para BCC de remisiones / inclusión en envíos de factura.
- **077** `delivery_note_lines.sales_order_id` + `sales_order_line_id` — habilita remisiones multi-pedido. Backfill de líneas históricas.
- **078** Recálculo masivo de `sales_orders.status` post-077 (corrige estados atascados por remisiones consolidadas).
- **079** `invoices.receptor_legal_name` — override de razón social por factura.
- **080** `invoice_lines.delivery_note_line_id` — habilita split de una remisión en N facturas con uso CFDI distinto por línea. Backfill por `product_id`.
- **081** `accounts_receivable.amount_credited` + reescritura de `amount_pending` como generated (`total - paid - credited`). Fix del bug que mutaba `amount_total` al emitir NC. Datos dañados corregidos manualmente.

## Funcionalidad nueva sesión 9

### Envío de correos (módulo email + sales + invoicing)
- **Remisión**: `markAsSentByEmail` envía PDF adjunto vía nodemailer/Gmail SMTP. `to` = contactos seleccionados; `bcc` = `tenants.notification_email` (fallback al usuario logueado); `replyTo` = correo institucional. Si remisión estaba `issued`, avanza a `sent_by_email`.
- **Factura (auto-send al timbrar)**: si `bp.auto_send_invoice=true`, después de timbrar Facturapi envía a contactos del cliente. Se agrega el correo institucional al array (Facturapi no soporta BCC).
- **Factura (envío manual)**: modal con checklist de contactos del cliente, "correos adicionales" libres y aviso de copia.
- **Modal de envío unificado** (remisión + factura): preselecciona el contacto principal del cliente o todos los que tengan email si solo hay uno. Avisa qué correo recibirá la copia (institucional vs usuario).
- Nuevo módulo `Configuración → Notificaciones` (`/configuracion/notificaciones`) para editar `tenants.notification_email`.

### PDF de remisión propio (pdfkit)
- `saas-base/src/modules/sales/remisionPdfService.js` con header azul, tablas, totales, "EVIDENCIA DE ENTREGA" con foto al pie si delivered, marca de "CANCELADA" en watermark. Look consistente con el PDF de factura.
- Ruta `GET /delivery-notes/:id/pdf` para descarga directa.

### Bug de foto de evidencia
- `routes.js` importaba `path` y `fs` lazy → ReferenceError silencioso. Fix: imports top-level + `path.resolve` para asegurar ruta absoluta en `res.sendFile`.

### Bloqueo de cancelación de remisión
- `cancelDelivery` ahora rechaza con 409 si `status ∈ {delivered, invoiced}` o si tiene factura activa. Se eliminó el reverso de inventario automático (era complejo y arriesgado).
- Frontend: oculta el botón "Cancelar remisión" en estados bloqueados.

### Remisión multi-pedido (consolidación)
- `createDeliveryNote` acepta `salesOrderIds[]` además del legacy `salesOrderId`. Valida mismo cliente / moneda / domicilio. Cada línea recuerda su pedido origen en `dnl.sales_order_id`. `recalcOrderStatusFromDeliveries` corre para cada pedido afectado.
- `RemisionFormModal` rediseñado: selector de cliente → checklist de pedidos elegibles (`confirmed/in_delivery/partially_delivered`) → líneas agregadas con columna "Pedido" cuando hay >1.
- Bug corregido: `listOrders` no devolvía `partner_id`, los pedidos se agrupaban bajo undefined.
- `getOrderDeliveryBreakdown` y `recalcOrderStatusFromDeliveries` reescritos para consultar por `dnl.sales_order_id` en lugar de `dn.sales_order_id` (que solo apunta al pedido principal en consolidadas).

### Edición de factura borrador
- `updateInvoice` service + `PATCH /invoices/:id` (solo `draft`). Whitelist de campos: razón social, régimen y CP del receptor, uso CFDI, fecha emisión, método/forma de pago, exportación, OC, notas.
- `stampService` y `pdfService` usan fallback `receptor_legal_name → partner_tax_name → partner_name` al timbrar y renderizar.
- Modal `EditDraftModal` en `FacturaDetallePanel` con todas las secciones.

### Cancelar SAT
- Botón rojo en facturas `stamped`. Modal con selector de motivo (02 default, opciones 01/03/04). Motivo 01 muestra input para UUID de sustitución con validación de formato.
- Backend: `cancelStampedInvoice` ya conectado a Facturapi, ahora usa `revertInvoiceArOnCancel` para mantener una sola fuente de verdad sobre cómo recalcular AR.

### Notas de crédito
- Modal `CreditNoteModal` con toggle **"Por monto" / "Por línea"**.
  - Por monto: descuento/corrección global con línea genérica (clave SAT `84111506`).
  - Por línea: checklist de líneas de la factura origen con input de cantidad a devolver, validación de máximo. Genera CFDI tipo E con líneas detalladas (`sat_product_code`, `sat_unit_code` reales del producto).
- Numeración: `NC-FAC-XXXXX-NN` (con sufijo secuencial — fix del bug "duplicate key" al emitir 2 NCs de la misma factura).
- Sección "Notas de crédito emitidas" en el panel de la factura origen con botones PDF/XML.
- Fix CXC: `amount_total` no se muta. Se suma a `amount_credited`. `amount_pending` se recalcula automáticamente (columna generada).

### Complementos de pago (CFDI tipo P)
- Botón "Registrar pago" (primary) en facturas `stamped` con `payment_method='PPD'`.
- Modal `PaymentComplementModal` con fecha, forma de pago (default 03 transferencia), monto, referencia y TC del DOF si la factura es USD.
- Validación: monto ≤ saldo pendiente (calculado como `total - sum(complementos no cancelados)`).
- Sección "Complementos de pago" (teal) en el panel con botones PDF/XML.
- **Auto-emisión desde modal CXC**: `registerPayment` detecta facturas PPD timbradas y dispara `stampPaymentComplement` por la porción aplicada. Transacción atómica — si timbra falla, rollback global.

### CXC con pestañas
- `PagoModal` tiene tabs **Remisionado** / **Facturado**. Cada pestaña muestra contador, monto pendiente total y monto aplicado.
- Botón "Aplicar a los más vencidos" por pestaña (FIFO selectivo).
- Las PPDs muestran badge `PPD` + leyenda teal "Al guardar se emitirá un complemento" cuando tienen monto aplicado.
- Pago global único: la mutation hace un solo `registerPayment` con `applications[]` de todas las pestañas. El servicio decide qué complementos timbrar.

### Split de factura (Fase 1)
- Una remisión puede facturarse en N facturas con distintos usos CFDI por subset de líneas.
- `createFromRemission` acepta `deliveryNoteLineIds[]` opcional. Si llega y NO cubre todas las líneas → crea AR-factura nuevo y reduce AR-remisión; si llega a 0 cancela AR-remisión (manteniendo `amount_total` histórico por constraint).
- `cancelInvoice` y `cancelStampedInvoice` usan helper `revertInvoiceArOnCancel` que recalcula AR-remisión desde cero: `total_remisión - SUM(facturas activas)`. Robusto ante cancelar múltiples facturas.
- `listDeliveryNotes` con `invoiceable=true` ahora filtra por "tiene al menos una línea sin facturar".
- `getDeliveryNote` devuelve `invoice_id/number/status/use_cfdi` por cada línea.
- Modal `FacturaFormModal`: cuando hay 1 sola remisión seleccionada, muestra checklist de sus líneas pendientes con default todas marcadas.
- Multi-remisión (Fase 1): NO soporta split por línea (se factura todo). Sí en Fase 2.

### Notas de crédito en getInvoice + complementos en getInvoice
- `getInvoice` ahora devuelve `creditNotes[]` y `paymentComplements[]` para que el panel los liste.
- API client agregó descargas para ambos.

## Patrones operativos nuevos (memory ya actualizado)

### Correo de copia institucional
Prioridad: `tenants.notification_email` → `users.email` del logueado (fallback). Aplicable a remisiones (BCC SMTP) y a facturas (To array en Facturapi).

### Split de factura por línea
Una remisión `delivered` aparece como "facturable" mientras tenga al menos una línea sin `delivery_note_line_id` en factura activa. AR-remisión se reduce al facturar parcialmente; al facturar la última línea queda cancelado conservando `amount_total` histórico.

### AR con notas de crédito
`amount_total` es inmutable post-emisión. NCs suman a `amount_credited`. `amount_pending` es columna generada `total - paid - credited`. Cancelar NC NO está implementado todavía (Fase 2).

### Cobro mixto desde modal CXC
- Remisión: solo aplica pago a AR.
- Factura PUE: solo aplica pago a AR.
- Factura PPD: aplica pago + emite CFDI tipo P automáticamente (transaccional).

## Convenciones de operación (refrescadas)

### "Resetear turnos"
Ver `feedback_reset_turnos.md`. Snapshot → confirmación → DELETE en orden FK-safe en transacción. Reset semanal: filtro `shift_date BETWEEN date_trunc('week', CURRENT_DATE) AND +6 days`. Si el usuario pide revertir inventario: DELETE `inventory_movements` + recalcular `balance_after` de movs posteriores.

### "Resetear ventas"
Mismo patrón: `ar_payments → ar_advances → accounts_receivable → credit_notes → payment_complements → invoice_lines → invoices → delivery_record_lines → delivery_records → delivery_notes (type='sale') → sales_order_lines → sales_orders → document_status_log`.

### Modal de envío (remisión y factura)
Checklist de contactos del cliente con email. Preselecciona el principal (o todos si solo hay uno). Soporta correos extras libres. Muestra el correo de copia con `useQuery(['tenant','current'])` cacheado 60s.

## Pendientes de la sesión 9 — para la próxima

Ver `project_ventas_pendientes.md`. Top:

1. **Verificar timbrado automático de complementos desde modal CXC** (pendiente reportado por el usuario al cierre).
2. **Fase 2 split de facturas**: multi-remisión + split por línea combinados. AR dinámico que permita cobrar antes de facturar.
3. **Imagen + ficha técnica de producto** — catálogo más rico.
4. **Asignar repartidor** — UI sobre endpoint existente.
5. **Aplicar anticipos desde panel CXC** — botón dedicado sobre `applyAdvance` existente.

## Cosas a tener cuidado en sesiones futuras

- `accounts_receivable.amount_total` es INMUTABLE post-emisión. Solo se modifica vía `amount_paid` (al cobrar) o `amount_credited` (al emitir NC).
- `delivery_notes.sales_order_id` apunta al PRIMER pedido de una remisión consolidada por compat con queries existentes. La fuente de verdad es `delivery_note_lines.sales_order_id`.
- `invoices.delivery_note_id` apunta a la primera/única remisión. Para split N→M usar `invoice_lines.delivery_note_line_id`.
- El check constraint `ar_amount_positive` exige `amount_total > 0` estricto. NUNCA hacer `SET amount_total = 0`. Para "cancelar" un AR mantener el monto y solo cambiar `status='cancelled'`.
- Cancelaciones de factura (draft o timbrada) usan `revertInvoiceArOnCancel` que recalcula AR-remisión desde origen — preferir reusar el helper en lugar de duplicar lógica.

## Modelo de email (resumen)

```
Remisión (SMTP/nodemailer):
  to:       contactos seleccionados + extras
  bcc:      tenants.notification_email (o users.email)
  replyTo:  mismo correo institucional
  attach:   PDF de remisión generado con pdfkit

Factura (Facturapi):
  to:       contactos del cliente + correo institucional (visible)
  attach:   Facturapi maneja XML+PDF timbrado
```

## Plan de migración SMTP

Ver `project_email_smtp_migration.md`. Postergado pero documentado. Migrar a Resend/Postmark/SES cuando crezca el volumen — cero cambios en código, solo .env.
