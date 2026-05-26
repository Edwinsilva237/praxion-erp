# Auto-suspensión y auto-reactivación con Stripe

El sistema cierra el ciclo cobro–suspensión sin intervención del platform
admin, siempre que Stripe esté configurado correctamente.

## Cómo funciona el ciclo completo

```
Cliente deja de pagar
      │
      ▼
┌───────────────────────────┐
│ Stripe intenta cobrar     │ ← configurable en Stripe Dashboard
│ (Smart Retries, ~4 veces  │   (Settings → Subscriptions and emails)
│  en 3-4 semanas)          │
└───────────────────────────┘
      │
      ├─ Cobro OK en algún intento ──► invoice.payment_succeeded
      │                                 → subscription pasa a 'active'
      │                                 → si tenant suspendido con
      │                                   reason='payment', se REACTIVA
      │
      └─ Todos los retries fallan ──► customer.subscription.deleted
                                       (o status='unpaid' según config)
                                       → tenant queda SUSPENDIDO
                                         con reason='payment'
                                       → cliente solo puede entrar a
                                         /suspendido (panel de pagos)
                                       → si actualiza tarjeta y paga,
                                         se REACTIVA sola
```

## Configuración requerida en Stripe Dashboard (una sola vez)

Para que Stripe cancele la suscripción tras agotar los retries y dispare el
evento `customer.subscription.deleted`:

1. Entra a https://dashboard.stripe.com/settings/subscriptions
2. En la sección **"Manage failed payments for subscriptions"** revisa:
   - **Retry schedule**: deja Smart Retries activado (default).
   - **If all retries for a payment fail**: selecciona
     **"Cancel the subscription"** (o "Mark as unpaid" si prefieres que
     persista la sub pero bloqueada — ambas opciones disparan auto-suspend).
3. Asegúrate que los webhook events estén suscritos en tu endpoint:
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
   - `invoice.payment_succeeded`
   - `checkout.session.completed`

Si todo esto está en su lugar:
- Cliente deja de pagar → Stripe retries → si fallan, sub cancelada → tenant suspendido.
- Cliente entra a /suspendido, abre portal Stripe, paga → tenant reactivado.

## Reglas internas que no se tocan

- El plan `owner` **nunca** se suspende vía billing (chequeo en `autoSuspendForPayment`).
- Suspensiones manuales (`suspended_reason='manual'`) **no se reactivan** con
  pago — requieren intervención del platform admin.
- Las funciones del webhook (`reactivateIfPaymentSuspended`,
  `autoSuspendForPayment`) son idempotentes — eventos duplicados de Stripe
  no causan loops.

## Verificar que funciona

Modo de prueba con Stripe CLI:

```bash
# Reactivación (cliente paga estando suspendido)
stripe trigger invoice.payment_succeeded

# Suspensión (Stripe se rinde tras retries)
stripe trigger customer.subscription.deleted
```

Observa los logs del backend:
- `[billing] tenant auto-reactivado tras pago`
- `[billing] tenant auto-suspendido (subscription.deleted)`

El panel admin (refresca cada 60s) verá los cambios reflejados.
