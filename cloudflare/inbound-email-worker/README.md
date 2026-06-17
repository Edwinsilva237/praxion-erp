# Buzón de facturas por correo — Email Worker (paso 3)

Capa final del correo entrante de facturas. Recibe correos en
`<token>@inbox.praxionops.com`, extrae los adjuntos (CFDI XML / PDF) y los manda
a la API del ERP, que da de alta el gasto en el tenant correcto.

```
Proveedor → correo a <token>@inbox.praxionops.com
          → Cloudflare Email Routing (catch-all del dominio raíz; atrapa también el subdominio)
          → este Worker (postal-mime saca los adjuntos)
          → POST https://praxion-api.onrender.com/api/inbound/expense  (X-Ingest-Secret)
          → API: candado RFC receptor == RFC del tenant → match proveedor → alta de gasto (anti-dup por UUID)
```

El `token` es per-tenant: lo genera la mig 208 y cada tenant lo ve/copia/rota en
**Gastos → 📧 Buzón de facturas** (paso 2, ya en prod).

---

## Antes de empezar

- `praxionops.com` ya está en Cloudflare (mismo account que Pages).
- Node + npm instalados. Desde esta carpeta:
  ```bash
  cd cloudflare/inbound-email-worker
  npm install
  npx wrangler login        # abre el navegador, autoriza el account
  ```

---

## Paso A — Habilitar Email Routing en el subdominio

> El subdominio SÍ se puede (Email Routing rutea cualquier subdominio de la misma
> zona). La nota vieja "CF solo rutea a la raíz" quedó desmentida.

1. Dashboard de Cloudflare → tu dominio `praxionops.com`.
2. **Compute (AI) → Email Service → Email Routing**. Si nunca lo activaste en este
   dominio, dale **Get started / Enable** (agrega los MX + SPF del apex — no estorban).
3. En Email Routing → **Settings** → sección **Subdomains** → escribe
   `inbox.praxionops.com` → **Add**.
4. Cloudflare provisiona solo los MX + SPF del subdominio. Espera a que salgan
   verdes (propagación; suele ser minutos).

## Paso B — Desplegar el Worker

```bash
# secrets (no se commitean)
npx wrangler secret put INGEST_URL
#   pega:  https://praxion-api.onrender.com
npx wrangler secret put INGEST_SECRET
#   pega un secreto largo y aleatorio — GUÁRDALO, va idéntico en Render (paso D)

npx wrangler deploy
```

Toma nota del nombre del Worker desplegado: **`praxion-inbound-email`**.

## Paso C — Catch-all del DOMINIO RAÍZ → Worker

> ⚠️ **Clave:** Cloudflare **solo permite catch-all a nivel del dominio raíz**, NO
> por subdominio. PERO el catch-all del raíz **también atrapa el correo de los
> subdominios** (el MX del subdominio entrega a Cloudflare y, al no haber regla
> específica, cae en el catch-all del raíz → Worker). Es el patrón documentado de
> Cloudflare para "subdomain addressing" con un Worker. Como el token es dinámico
> (uno por tenant), NO se crea una regla por dirección: el Worker saca el token del
> local-part de `message.to`, sin importar el dominio.

1. Email Routing (zona `praxionops.com`) → pestaña **Routing rules**.
2. En la sección **Catch-all rule** (fila `Catch-all`), menú **"..."** → **Edit**.
3. Action = **Send to a Worker** → elige `praxion-inbound-email` → **Save**.
4. Activa el **toggle de Status** → **Enabled**.

> Esto enruta TODO el correo de `praxionops.com` (raíz + subdominios) al Worker. Si
> no usas buzones humanos `@praxionops.com`, no afecta nada (el Worker descarta lo
> que no sea factura). Para un buzón real tipo `hola@praxionops.com`, agrega una
> regla específica de esa dirección (las específicas le ganan al catch-all).

## Paso D — Encender la ingesta en Render (API)

Hasta aquí el Worker entrega, pero la API responde **401** a todo porque el
secret no está puesto. En **Render → praxion-api → Environment**:

- `INBOUND_INGEST_SECRET` = el **mismo** valor que pusiste en `INGEST_SECRET` (paso B).
- (opcional) `INBOUND_EMAIL_DOMAIN` = `inbox.praxionops.com`
  (es el default en el código; solo cámbialo si algún día mueves el subdominio).

Guardar → **Manual Deploy** de praxion-api si no auto-deploya.

En cuanto el secret está puesto, en **Gastos → 📧 Buzón de facturas** desaparece
el aviso ámbar "no está activo".

---

## Probar de punta a punta

1. Manda un correo a tu dirección (la que ves en **Gastos → 📧 Buzón de facturas**)
   con un **CFDI XML** adjunto cuyo RFC receptor sea el de tu tenant.
2. `npx wrangler tail` → deberías ver `inbound-worker: entregado a la API`.
3. En el ERP, **Gastos** → aparece el gasto nuevo (proveedor emparejado por RFC).
4. Reenvía el MISMO correo otra vez → no se duplica (anti-dup por UUID).

### Diagnóstico rápido

| Síntoma | Causa probable |
|---|---|
| `wrangler tail` no muestra nada al enviar | catch-all no apunta al Worker, o MX del subdominio sin propagar (paso A/C) |
| `la API respondió error status: 401` | `INGEST_SECRET` (Worker) ≠ `INBOUND_INGEST_SECRET` (Render), o falta en Render (paso D) |
| `status: 403` | el RFC receptor del CFDI no coincide con el RFC del tenant (candado de seguridad) |
| `status: 404` | token desconocido — ¿el tenant rotó su dirección? usa la dirección actual |
| `sin adjunto XML/PDF, descartado` | el correo no traía factura adjunta (solo texto/imagen) |

## Notas

- Tope de correo entrante: **25 MiB** (Email Routing). El Worker rechaza arriba de eso.
- El Worker filtra adjuntos a **.xml / .pdf / .zip** (CFDI). Ignora firmas e imágenes.
  El **.zip** se reenvía tal cual; la API lo descomprime y procesa el XML/PDF de adentro
  (prefiere el XML; soporta zips con varios CFDI). Ver `inboundEmailService.expandAttachments`.
- Errores de la API o de red **no rebotan** el correo: se loguean (`wrangler tail`).
  Decisión deliberada — un hipo de infra no debe devolverle un bounce al proveedor.
