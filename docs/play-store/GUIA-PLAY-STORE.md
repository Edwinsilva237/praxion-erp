# Publicar Praxion en Google Play — guía + textos listos

> Generado 2026-06-05. Acompaña al AAB firmado y a los gráficos de `docs/play-store/assets/`.
> El AAB de release está en el **Escritorio**: `Praxion-release.aab` (y en
> `saas-erp-frontend/android/app/build/outputs/bundle/release/app-release.aab`).

---

## 0. Datos clave de la app

| Campo | Valor |
|---|---|
| Nombre en la tienda | **Praxion ERP** |
| Package / applicationId | `com.praxionops.erp` *(permanente, no se puede cambiar)* |
| versionCode | `1` · versionName `1.0` *(la próxima subida debe usar versionCode 2, 3, …)* |
| Categoría | Empresa (Business) · alterna: Productividad |
| Precio | Gratis · sin compras dentro de la app · sin anuncios |
| Idioma por defecto | Español (México) — es-MX |
| Política de privacidad | `https://www.praxionsystems.mx/privacidad` *(en vivo en el sitio)* |
| Correo de contacto | contacto@praxionsystems.mx |

---

## 1. ⚠️ Antes de empezar — dos cosas que definen el calendario

**A) Tipo de cuenta (decide AHORA):**
- **Personal** — alta más rápida, pero Google obliga a una **prueba cerrada con ≥12 testers
  durante ≥14 días** antes de poder publicar en producción. O sea: aunque todo esté listo,
  hay un mínimo de ~2 semanas de testers reales.
- **Organización** — NO aplica el requisito de 12 testers (vas directo a producción), pero
  pide un **número D-U-N-S** de la empresa (gratis, tarda ~7–30 días en emitirse) + datos
  legales del negocio. Praxion Systems califica como organización.
- **Recomendación:** si tienes prisa por probar en pocos teléfonos → Personal. Si quieres
  publicar al público pronto sin la fricción de los 12 testers y tienes el negocio dado de
  alta → Organización (saca el D-U-N-S ya, en paralelo).

**B) La revisión de Google necesita poder ENTRAR a la app.** Como Praxion vive detrás de
login, hay que darle a los revisores un **usuario y contraseña de prueba** (sección "Acceso a
la app"). Prepara una cuenta demo (puede ser un tenant sandbox). Sin esto, rechazan la revisión.

---

## 2. Crear la cuenta de Google Play Console

1. Entra a **https://play.google.com/console/signup** con la cuenta de Google del negocio
   (ideal: `contacto@praxionsystems.mx` de Workspace, no una personal).
2. Elige **tipo de cuenta** (Personal u Organización — ver §1A).
3. Paga la **cuota única de ~25 USD**.
4. Completa la **verificación de identidad**: nombre legal, dirección, documento oficial.
   Organización: además datos de la empresa + D-U-N-S.
5. Espera la verificación (de horas a varios días). Mientras tanto, avanza con los gráficos,
   textos y el D-U-N-S si vas por Organización.

---

## 3. Crear la app y subir el AAB

1. En Play Console → **Crear app**.
   - Nombre: `Praxion ERP` · Idioma: Español (México) · Tipo: **App** · **Gratis**.
   - Acepta las declaraciones (políticas + leyes de exportación de EE. UU.).
2. **Play App Signing** (firma de apps de Google): déjalo **activado (predeterminado)**.
   - Google guarda la *llave de firma final*; tú subes el AAB firmado con tu **llave de
     subida** (la que ya generamos: `praxion-upload-key.jks`, alias `praxion-upload`).
   - Si algún día pierdes la llave de subida, Google puede resetearla (la de firma final NO,
     por eso la gestiona Google). Aun así: **respalda tu llave de subida** (ver §6).
3. Ve a **Probar y publicar → Pruebas → Prueba interna** (o **Prueba cerrada** si tu cuenta
   exige los 12 testers) → **Crear versión** → sube `Praxion-release.aab`.
   - Empieza SIEMPRE por prueba interna: es instantánea, sin revisión, y valida que el AAB
     quedó bien antes de exponerlo.
4. Notas de la versión (campo "Novedades"): usa el texto de §4.4.

---

## 4. Textos de la ficha (copiar/pegar)

### 4.1 Título (máx. 30 caracteres)
```
Praxion ERP
```

### 4.2 Descripción corta (máx. 80 caracteres)
```
ERP móvil: ventas, inventario, producción y compras con escáner y avisos.
```

### 4.3 Descripción completa (máx. 4000 caracteres)
```
Praxion ERP lleva la operación diaria de tu empresa al teléfono. Vende, surte, produce
y compra desde donde estés, con escáner de código de barras y avisos en tiempo real.

Pensado para empresas de manufactura y distribución que ya usan Praxion en su computadora:
la app se conecta a la misma cuenta y los datos se sincronizan al instante.

FUNCIONES PRINCIPALES

• Ventas y pedidos: consulta y da seguimiento a pedidos, remisiona y registra entregas con
  foto de evidencia o firma en pantalla.
• Inventario: revisa existencias, haz conteos físicos y movimientos con el escáner de
  código de barras de tu cámara.
• Producción: consulta órdenes, confirma turnos y captura el avance de piso.
• Compras: levanta órdenes de compra y valida recepciones de mercancía con evidencia.
• Escáner integrado: lee códigos de barras y digitaliza documentos con la cámara.
• Documentos: genera e imprime remisiones, recibos y comprobantes de recepción en PDF.
• Notificaciones: recibe avisos de nuevos pedidos, recepciones, stock bajo y más, dirigidos
  según tu rol.

SEGURIDAD Y MULTIEMPRESA

Cada empresa opera de forma aislada. El acceso está protegido con autenticación por token y
permisos por rol, de modo que cada usuario solo ve lo que le corresponde.

REQUISITO

Praxion ERP es una herramienta de trabajo para clientes con una cuenta Praxion activa. Si tu
empresa aún no usa Praxion, contáctanos en contacto@praxionsystems.mx.
```

### 4.4 Novedades / notas de la versión (máx. 500 caracteres)
```
Primera versión de Praxion ERP para Android. Operación diaria desde el teléfono: ventas,
inventario, producción y compras, con escáner de código de barras, captura de evidencia y
notificaciones push.
```

---

## 5. Formularios obligatorios — respuestas sugeridas

### 5.1 Acceso a la app (App access)
- Marca: **"Todas o algunas funciones requieren credenciales"**.
- Agrega una instrucción con un **usuario y contraseña de prueba** (cuenta demo / sandbox) y
  una nota: *"Inicie sesión con el correo y contraseña proporcionados; el sistema descubre la
  empresa automáticamente. La app usa una cuenta de demostración con datos de ejemplo."*

### 5.2 Anuncios (Ads)
- **No, la app no contiene anuncios.**

### 5.3 Clasificación de contenido (cuestionario IARC)
- Categoría de la app: **Productividad / Utilidad** (NO juego).
- Responde **No** a todo: violencia, contenido sexual, lenguaje soez, sustancias controladas,
  juego/apuestas, contenido generado por usuarios de carácter social, ubicación compartida.
- Compras digitales: **No**. Resultado esperado: apta para **todo público (3+)**.

### 5.4 Público objetivo y contenido (Target audience)
- Grupo de edad: **18 y más** (herramienta de trabajo; no dirigida a menores).
- ¿Atrae a menores? **No.**

### 5.5 Seguridad de los datos (Data safety) — el formulario clave
Declara que la app **sí recopila** datos, con estas respuestas:

| Tipo de dato | ¿Se recopila? | ¿Se comparte?* | Propósito | ¿Obligatorio? |
|---|---|---|---|---|
| Nombre | Sí | No | Funcionalidad, Gestión de cuenta | Obligatorio |
| Dirección de correo | Sí | No | Funcionalidad, Gestión de cuenta | Obligatorio |
| Fotos | Sí | No | Funcionalidad (evidencia de entrega/recepción) | Opcional |
| ID de dispositivo (token push) | Sí | No | Funcionalidad (notificaciones) | Obligatorio |
| Registros de fallos / diagnóstico | Sí | No | Análisis / estabilidad | Obligatorio |

\* "Compartir" en el sentido de Google = entregar a terceros para su propio uso. Nuestros
proveedores (Render, Cloudflare, Firebase, Facturapi, Workspace, Sentry) **procesan por
nuestra cuenta**, así que NO cuenta como "compartir".

- **Datos financieros del usuario: No se recopilan.** La app maneja datos de facturación del
  *negocio*, no información de pago personal del usuario, y no hay compras dentro de la app.
- Prácticas de seguridad:
  - ¿Se cifran los datos en tránsito? **Sí.**
  - ¿El usuario puede pedir que se eliminen sus datos? **Sí** (vía administrador o
    contacto@praxionsystems.mx — coincide con la política de privacidad §8).
- URL de la política de privacidad: `https://www.praxionsystems.mx/privacidad`

### 5.6 Apps gubernamentales / financieras / salud
- ¿App del gobierno? **No.** ¿App financiera (préstamos, inversiones, cripto)? **No** — es un
  ERP de gestión empresarial. ¿App de salud? **No.**

---

## 6. Capturas de pantalla (las tomas tú del teléfono)

Google pide **mínimo 2** capturas de teléfono (recomendado 4–8), en vertical, lado mínimo
320 px. Tómalas desde la app instalada (botón de volumen + encendido) en estas pantallas:
1. **Inicio / Dashboard**
2. **Ventas → Pedidos** (lista en tarjetas)
3. **Inventario** (existencias) o el **escáner** en acción
4. **Producción** u **Compras → Recepción**

Mándamelas y te las **reencuadro/redimensiono** al formato exacto que pide Google si hace
falta. (También puedo enmarcarlas en un mockup de teléfono.)

**Ya tienes listos (en `docs/play-store/assets/`):**
- `icon-512.png` — ícono de la tienda (512×512).
- `feature-graphic-1024x500.png` — gráfico destacado (obligatorio).

---

## 7. 🔒 Respaldo de la llave de subida (CRÍTICO)

Sin esta llave + su contraseña no podrás publicar **ninguna actualización** futura. Respáldala
HOY en un lugar seguro (gestor de contraseñas / nube privada), fuera de la máquina:
- `saas-erp-frontend/android/app/praxion-upload-key.jks`
- `saas-erp-frontend/android/keystore.properties` (contiene alias + contraseñas)

(Ambos están fuera de git por diseño — `.gitignore` los excluye.)

---

## 8. Recompilar una versión futura (receta)

```powershell
cd saas-erp-frontend
npm run sync:android
# subir versionCode en android/app/build.gradle (1 -> 2 -> 3 ...)
$env:JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"
cd android; .\gradlew.bat bundleRelease --console=plain
# AAB firmado en: android/app/build/outputs/bundle/release/app-release.aab
```
Sube el nuevo AAB a una pista de prueba → promuévelo a producción.

---

## 9. Checklist de publicación

- [ ] Backend desplegado con la ruta `/privacidad` (para que la URL responda 200).
- [ ] Cuenta Play Console creada, pagada y verificada.
- [ ] (Si Personal) Prueba cerrada con ≥12 testers corriendo ≥14 días.
- [ ] App creada (`Praxion ERP`, `com.praxionops.erp`).
- [ ] AAB subido a prueba interna y verificado en un teléfono.
- [ ] Cuenta demo de prueba dada de alta + credenciales en "Acceso a la app".
- [ ] Ficha completa: título, descripciones, ícono 512, feature graphic, ≥2 capturas.
- [ ] Clasificación de contenido enviada.
- [ ] Seguridad de los datos completada.
- [ ] Política de privacidad enlazada y respondiendo.
- [ ] Llave de subida respaldada fuera de la máquina.
- [ ] Enviar a revisión.
