# Propuestas de entradas para DECISIONS.md — Sesión 5 (2026-05-13)

Las siguientes entradas se proponen para agregarse a `DECISIONS.md`. Todas tienen el mismo formato: contexto, decisión, alternativas descartadas, consecuencias.

---

## D-2026-05-13-01: Pantalla separada de "Resumen del turno cerrado"

**Contexto**: cuando un operador cerraba su turno, la única pantalla post-cierre era una caja verde escueta con "Turno finalizado" y dos botones (reabrir / volver). El operador no tenía visibilidad de lo que produjo, y al recargar la página perdía esa pantalla. Además, no había forma natural para que el operador "se despida" de su turno con cierre informativo.

**Decisión**: crear un componente nuevo `ClosedShiftSummary` que reemplaza la pantalla verde y muestra resumen completo del turno (duración, paquetes 1ª/2ª, MP en paquetes + en merma, incidentes por categoría, orden activa). Se accede vía endpoint nuevo `GET /shifts/:id/closed-summary`. Persiste al recargar (detección desde BD del estado `pending_handover` con `closed_at` del propio operador).

**Alternativas descartadas**:
- *Reutilizar `getShiftSummary`*: muy detallado para este caso, devuelve listas completas pensadas para la pantalla de validación del supervisor. Hacer un endpoint dedicado mantiene cada uno enfocado.
- *Mostrar la pantalla solo al supervisor que cierra a otro*: descartado por confusión (Francisco vio el resumen ajeno de Víctor; el operador real Víctor no lo vio).

**Consecuencias**:
- El supervisor que cierra el turno de otro NO ve el resumen — recibe un toast verde "Turno cerrado correctamente. Pendiente de validación" y vuelve a la lista.
- Si se quiere que el supervisor también pueda revisar el resumen, debe ser desde una pantalla distinta (módulo de validación o histórico).

---

## D-2026-05-13-02: Bloqueo de "regresar turno" en validación cuando el relevo ya aceptó

**Contexto**: el módulo de validación tiene un botón "Regresar turno" que ejecuta `validateShift(approved=false)`, lo cual reactiva el `production_shift` a `active`. Si el relevo ya aceptó la línea (existe fila en `shift_receptions` y su turno está en `active`), regresar el saliente deja dos `production_shifts` en `active` simultáneamente sobre la misma línea física — captura duplicada, inventario inconsistente.

**Decisión**: bloquear duramente la operación con error 409 (`RELAY_ALREADY_ACTIVE`) y dirigir al supervisor a las herramientas de corrección (`editPackage`, `deletePackage`, `addPackage`, etc.) que ya existen para operar sobre turnos en `pending_handover` sin desbloquearlos.

**Alternativas descartadas**:
- *Permitir con advertencia*: requería decidir qué hacer con el turno del relevo (cerrarlo destruye captura, dejarlo abierto perpetúa la inconsistencia). Inviable.
- *No hacer nada (status quo)*: bomba de tiempo. Cualquier clic accidental dejaba BD en estado caótico.

**Consecuencias**:
- Si hay error real en un turno cerrado y el relevo ya aceptó, el supervisor debe usar las funciones de corrección quirúrgica en vez de desbloquear.
- El frontend del módulo de validación recibe el error 409 y lo muestra como mensaje. Si se quiere UX más amable (deshabilitar visualmente el botón "Regresar"), se requiere que el endpoint de detalle del turno devuelva un flag `relayAlreadyActive` para que el frontend lo sepa antes de presionar. **Pendiente para próxima iteración**.

---

## D-2026-05-13-03: MP calculada en vivo en lugar de leer `mp_real_kg`

**Contexto**: la columna `production_shifts.mp_real_kg` es el "campo oficial" para la MP consumida en un turno, pero **no se actualiza por ningún proceso** (verificado en sesión 5: todos los turnos recientes la tienen en 0). Esto afectaba al `getHandoverSummary` que mostraba "MP consumida: 0 kg" en la pantalla de recepción.

**Decisión**: calcular MP en vivo desde tablas hijas (`SUM(shift_progress.real_weight_kg) + SUM(shift_scrap.kg)`) en los puntos donde se necesita mostrar al operador (`getHandoverSummary`, `getClosedShiftSummary`). NO arreglar el campo `mp_real_kg` en esta iteración.

**Alternativas descartadas**:
- *Arreglar el llenado de `mp_real_kg`*: requiere encontrar y modificar todos los puntos que afectan al turno (captura, scrap, correcciones), con riesgo de romper otros consumidores del campo. Fuera de alcance.
- *Trigger en BD*: similar complejidad, agregaría lógica difícil de auditar.

**Consecuencias**:
- Cualquier reporte o pantalla NO actualizada en sesión 5 que use `mp_real_kg` sigue mostrando 0. **Deuda técnica registrada**.
- Las pantallas modificadas en sesión 5 (recepción, resumen cerrado) son correctas.
- Cuando se arregle el llenado del campo, se puede revertir a leer del campo y los resultados deberían ser iguales (validación cruzada útil).

---

## D-2026-05-13-04: Comentarios anti-eliminación en endpoints "huérfanos"

**Contexto**: en esta sesión se detectó que `POST /orders/preview-stock` no estaba registrado en `routes.js` aunque sí lo consumía el frontend. El usuario reportó que "ya se había arreglado antes" — es decir, el bug es recurrente. La función service `getOrderStockAvailability` también existía sin ruta expuesta (huérfana). Es razonable pensar que en alguna refactorización anterior se eliminó como "código no usado".

**Decisión**: agregar bloques de comentarios visibles (con barras de igual `═════`) marcando estos endpoints como "NO ELIMINAR" en `routes.js` y `productionService.js`, con explicación del consumidor frontend, instrucciones de qué revisar antes de modificar, e historial de incidentes para registrar cada vez que se rompa.

**Alternativas descartadas**:
- *Tests E2E*: ideal pero overkill para esta iteración. Cuando exista una capa de testing, se trasladarán estas anotaciones a tests que fallan si las rutas se eliminan.
- *Registro centralizado de rutas*: refactor grande. No justifica el costo ahora.

**Consecuencias**:
- Bajo costo (solo comentarios), alta señal preventiva.
- Cada vez que la regresión vuelva a ocurrir, se debe agregar línea al historial dentro del bloque (formato: `- 2026-MM-DD sesión N: descripción del incidente`).
- Patrón replicable para otros endpoints que se detecten en situación similar.

---

## D-2026-05-13-05: Force-close de turno por supervisor — parámetros de UX

**Contexto**: el endpoint `POST /shifts/:id/force-close` y la función `forceCloseShift` existían en backend pero no había ningún botón en frontend que los disparara. Se decidió en sesión 5 implementar la UI.

**Decisiones de UX**:

1. **Quién puede force-cerrar**: solo el supervisor del turno (`shift.supervisor_id === currentUser.id`). NO se usa rol global porque alguien puede ser supervisor en general pero no de ese turno específico.

2. **Cuándo aparece el botón**: solo cuando hay relevo esperando (`handover_requested_at` poblado en el shift activo) Y han pasado ≥5 minutos. Si aún no se llega a los 5 min, se muestra "Cierre forzado disponible en X min" en su lugar.

3. **Dónde aparece**: link inline dentro del banner amarillo de "El siguiente turno está listo", en color rojo subrayado. Diseño discreto pero diferenciado. Solo en vista "captura" (no en cola ni en pantalla de selección).

4. **Captura de motivo**: dropdown de 5 motivos predefinidos (abandono, no responde, emergencia médica, falla operativa, otro) + campo opcional de detalles. Si elige "otro", detalles obligatorios mínimo 10 caracteres.

5. **Confirmación**: checkbox obligatorio "Confirmo que entiendo las consecuencias..." antes de habilitar el botón "Forzar cierre" del modal.

**Alternativas descartadas**:
- *Botón en cola*: el supervisor que llega al turno generalmente entra a captura, no a cola. Duplicar aumenta riesgo de modales abiertos por accidente.
- *Texto libre sin dropdown*: menos estructurado para reportes. El dropdown facilita análisis posterior por categoría.
- *Sin tiempo mínimo*: el backend ya valida 5 min, replicarlo en frontend evita peticiones que fallarán.

**Consecuencias**:
- El supervisor que force-cierra NO ve el resumen del turno (ver D-2026-05-13-01).
- La regla de 5 min se replica en frontend pero la fuente de verdad sigue siendo el backend (defensa en profundidad).
- Si en el futuro se decide cambiar el tiempo mínimo (5 → 3 min, por ejemplo), hay que actualizar tanto frontend como backend.
