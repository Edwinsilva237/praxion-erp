# Publicar Praxion en la App Store (iOS) — guía + textos listos

> Generado 2026-06-05. Hermano de `docs/play-store/GUIA-PLAY-STORE.md` (Android), adaptado a
> Apple. **El build de iOS se hace EN LA MAC** (Xcode), no desde Windows — la receta técnica
> para el Claude de la Mac está en `docs/ios-app-setup.md` (sección "Subir a App Store").
> Esta guía es el **contenido + los pasos de App Store Connect** que haces tú en el navegador.

---

## 0. Datos clave

| Campo | Valor |
|---|---|
| Nombre en la tienda | **Praxion ERP** |
| Bundle ID | `com.praxionops.erp` *(igual que Android/Firebase; permanente)* |
| Versión / build | `1.0` (build `1`) — la próxima subida sube el **build number** |
| Apple Developer | **ACTIVO (de paga)** · Team `Z69ZT5UW4M` (Individual) |
| Categoría | Principal: **Business** · Secundaria: Productivity |
| Precio | Gratis · sin compras dentro de la app |
| Idioma principal | Español (México) |
| Política de privacidad | `https://www.praxionsystems.mx/privacidad` *(en vivo)* |
| URL de soporte / marketing | `https://www.praxionsystems.mx` |
| Correo de contacto | contacto@praxionsystems.mx |
| Ícono 1024 | `docs/app-store/assets/icon-1024.png` *(ya va embebido en el build; no se sube aparte)* |

---

## 1. ⚠️ Realidades de Apple antes de empezar (leer)

1. **El build/subida es en la Mac.** El Claude de la Mac hace Archive en Xcode y sube a App
   Store Connect (receta en `docs/ios-app-setup.md`). Tú haces lo del navegador.
2. **TestFlight es la escala intermedia.** Todo build que subes aparece **primero en TestFlight**.
   Desde ahí puedes (a) repartirlo YA a tu equipo (testers internos, sin espera) y (b) someter
   ESE mismo build a revisión para la App Store pública. **Recomendado: TestFlight primero**,
   confirmas que jala en iPhones reales, y luego mandas a revisión pública.
3. **Riesgo de rechazo Guideline 4.2 (funcionalidad mínima).** Apple a veces rechaza apps que
   "parecen un sitio web envuelto". **Mitigación (a nuestro favor):** la app usa funciones
   **nativas reales** — escáner de código de barras, cámara para evidencia, **notificaciones
   push**. En las notas de revisión hay que **resaltar esas funciones nativas** (texto listo en §4.4).
4. **App detrás de login → cuenta demo obligatoria.** Apple necesita entrar a revisar. Hay que
   dar usuario/contraseña de prueba en "App Review Information" (igual que en Google).
5. **Revisión manual de Apple:** típico **24–48 h**, a veces más, y pueden rechazar con motivo
   (se corrige y se reenvía). No hay requisito de "12 testers" como Google personal.

> **Alternativa B2B (opcional):** si prefieres NO listar público, existe **Unlisted App
> Distribution** (link directo, no aparece en búsquedas) o **TestFlight** como canal permanente.
> Esta guía asume **listado público**, que es lo que pediste.

---

## 2. Crear la app en App Store Connect (tú, navegador)

1. Entra a **https://appstoreconnect.apple.com** con tu Apple ID de desarrollador.
2. **My Apps → ➕ → New App**:
   - Platform: **iOS** · Name: `Praxion ERP` · Primary Language: **Spanish (Mexico)**
   - Bundle ID: **`com.praxionops.erp`** *(debe aparecer en la lista; si no, el Claude de la Mac
     lo registra al hacer el primer Archive con firma automática)*
   - SKU: `praxion-erp-ios` (identificador interno tuyo, libre)
   - User Access: Full
3. Eso crea el "contenedor" de la app. Aún sin build (el build lo sube la Mac, §receta).

---

## 3. Subir el build (Mac) — resumen

El Claude de la Mac sigue `docs/ios-app-setup.md` → "Subir a App Store":
`git pull` → set versión/build → `npm run sync:ios` → Xcode **Archive** con el Team de paga →
**Distribute App → App Store Connect → Upload**. En ~5–15 min el build aparece en App Store
Connect → pestaña **TestFlight**. (Export compliance: ver §5.5.)

---

## 4. Textos de la ficha (copiar/pegar)

### 4.1 Nombre (máx. 30) y Subtítulo (máx. 30)
```
Nombre:    Praxion ERP
Subtítulo: Tu operación en el iPhone
```

### 4.2 Texto promocional (máx. 170, se puede cambiar sin revisión)
```
Lleva ventas, inventario, producción y compras al iPhone: escáner de código de barras,
evidencia con foto y notificaciones en tiempo real para tu equipo.
```

### 4.3 Descripción (máx. 4000)
```
Praxion ERP lleva la operación diaria de tu empresa al iPhone. Vende, surte, produce y compra
desde donde estés, con escáner de código de barras y avisos en tiempo real.

Pensado para empresas de manufactura y distribución que ya usan Praxion: la app se conecta a la
misma cuenta y los datos se sincronizan al instante.

FUNCIONES PRINCIPALES

• Ventas y pedidos: consulta y da seguimiento a pedidos, remisiona y registra entregas con foto
  de evidencia o firma en pantalla.
• Inventario: revisa existencias, haz conteos físicos y movimientos con el escáner de código de
  barras de tu cámara.
• Producción: consulta órdenes, confirma turnos y captura el avance de piso.
• Compras: levanta órdenes de compra y valida recepciones de mercancía con evidencia.
• Escáner integrado: lee códigos de barras con la cámara.
• Documentos: genera y comparte remisiones, recibos y comprobantes en PDF.
• Notificaciones: recibe avisos de nuevos pedidos, recepciones, stock bajo y más, según tu rol.

SEGURIDAD Y MULTIEMPRESA

Cada empresa opera de forma aislada. El acceso está protegido con autenticación por token y
permisos por rol, de modo que cada usuario solo ve lo que le corresponde.

REQUISITO

Praxion ERP es una herramienta de trabajo para clientes con una cuenta Praxion activa. Si tu
empresa aún no usa Praxion, contáctanos en contacto@praxionsystems.mx.
```

### 4.4 Notas para el revisor (App Review Information → Notes) — IMPORTANTE para evitar 4.2
```
Praxion ERP es una herramienta de gestión empresarial (B2B) para clientes con cuenta activa.

Funciones NATIVAS de iOS que usa la app (no es solo contenido web):
- Cámara: escáner de código de barras para inventario/compras y captura de fotos de evidencia
  de entrega/recepción.
- Notificaciones push (APNs/Firebase): avisos operativos de pedidos, recepciones y stock bajo.
- Generación y compartición de documentos PDF (hoja de compartir de iOS).

CUENTA DE PRUEBA (requerida porque la app es de acceso restringido):
- Usuario: [CORREO_DEMO]
- Contraseña: [CONTRASEÑA_DEMO]
La app descubre la empresa automáticamente con el correo; usa datos de demostración.

Contacto del desarrollador: contacto@praxionsystems.mx
```

### 4.5 Keywords (máx. 100 caracteres, separadas por coma, sin espacios)
```
ERP,inventario,ventas,produccion,compras,facturacion,almacen,pedidos,negocio,manufactura
```
*(98 caracteres — si App Store Connect marca exceso, quita la última.)*

### 4.6 Copyright
```
2026 Praxion Systems
```

---

## 5. Formularios obligatorios — respuestas sugeridas

### 5.1 App Review Information (acceso para Apple)
- **Sign-in required: SÍ.** Da el usuario y contraseña de la cuenta demo (mismo de §4.4).
- Notes: pega el texto de §4.4 (resalta las funciones nativas → reduce riesgo 4.2).
- Contact: tu nombre, teléfono y contacto@praxionsystems.mx.

### 5.2 App Privacy (etiquetas de privacidad de Apple)
Declara que la app **recopila** estos datos, todos **vinculados al usuario**, propósito
**App Functionality**, y **NO se usan para rastreo (tracking)**:

| Categoría Apple | Tipo | ¿Rastreo? |
|---|---|---|
| Contact Info | Nombre, Correo electrónico | No |
| User Content | Fotos (evidencia de entrega/recepción) | No |
| Identifiers | ID de dispositivo (token de notificaciones) | No |
| Diagnostics | Datos de diagnóstico / fallos | No |

- **Data used to track you: Ninguno.**
- Privacy Policy URL: `https://www.praxionsystems.mx/privacidad`
- (Datos financieros del usuario / ubicación / contactos / salud: **No** se recopilan.)

### 5.3 Clasificación por edad (Age Rating)
- Responde **No / Ninguno** a todas las categorías (violencia, sexo, lenguaje, sustancias,
  juego, terror, etc.). Resultado: **4+**.

### 5.4 Categoría y precio
- Categoría principal **Business**, secundaria **Productivity**. Precio **Gratis** (Tier 0).
  Sin compras dentro de la app.

### 5.5 Cumplimiento de exportación (Export Compliance)
- La app solo usa **HTTPS estándar** → califica como **exenta**.
- **Mejor solución (una vez):** agregar a `Info.plist` la clave
  `ITSAppUsesNonExemptEncryption = NO` (lo hace la Mac, está en la receta) → App Store Connect
  ya **no vuelve a preguntar** en cada subida.

---

## 6. Capturas de pantalla (se toman en la Mac)

Apple pide capturas de iPhone de pantalla grande. **Tamaño objetivo: 6.9" (iPhone 16 Pro Max)
= 1320×2868** (Apple reescala para pantallas menores). Mínimo 1, hasta 10.
- **Cómo:** correr la app en el **Simulador de iPhone 16 Pro Max** (o un iPhone físico Pro Max)
  → `⌘S` guarda la captura al tamaño exacto. Pantallas sugeridas:
  1. Inicio / Dashboard · 2. Ventas → Pedidos · 3. Inventario o el escáner · 4. Producción/Compras.
- El Claude de la Mac puede capturarlas desde el Simulador (ver receta). **Si me pasas las
  capturas crudas, yo las reencuadro/redimensiono** al tamaño que pida App Store Connect.
- iPad: solo si declaras soporte iPad (por ahora **no**; mantener "iPhone only").

---

## 7. Enviar a revisión

1. En la versión 1.0 de la app: selecciona el **build** (el que subió la Mac, desde TestFlight).
2. Completa: capturas, descripción, keywords, soporte, privacidad, App Privacy, Age Rating,
   App Review Information (con cuenta demo).
3. **Add for Review → Submit.** Apple revisa (~24–48 h). Si rechazan, te llega el motivo en
   App Store Connect → se corrige y se reenvía.

---

## 8. Checklist

- [ ] App creada en App Store Connect (`Praxion ERP`, bundle `com.praxionops.erp`).
- [ ] (Mac) Build subido y visible en TestFlight.
- [ ] Probado en iPhone real vía TestFlight (al menos tú).
- [ ] Cuenta demo creada + credenciales en App Review Information + Notes con funciones nativas.
- [ ] App Privacy completada (con URL de privacidad).
- [ ] Age Rating 4+.
- [ ] Export compliance resuelto (`ITSAppUsesNonExemptEncryption=NO` en Info.plist).
- [ ] ≥1 captura 6.9" subida.
- [ ] Ficha: nombre, subtítulo, descripción, keywords, soporte, copyright.
- [ ] Enviar a revisión.

---

## 9. Después de aprobar
- La app queda pública en la App Store. Para actualizaciones de **UI** sin pasar por revisión,
  está el plan **OTA (Capgo)** — ver `docs/ios-app-setup.md` y [[ios-app-plan]] en memoria.
- Cambios **nativos** (plugins, ícono, permisos, versión de Capacitor) → siempre nuevo build +
  revisión.
