# Guía de configuración de costeo

> Guía práctica para entender **cómo el sistema calcula el costo de lo que produces**,
> qué se captura en cada ventana, qué significan las opciones de configuración y
> cómo armar el costeo de tu negocio con ejemplos reales.
>
> Está escrita para que la entienda cualquier persona, sin tecnicismos.

---

## 1. La idea en una frase

> El costo de cada turno se **estima en el momento** con los datos que tienes,
> y se **corrige al cierre del mes** cuando ya conoces tus gastos reales.

Durante el mes ves un número *aproximado*. Al final del mes capturas lo que
**realmente** pagaste y el sistema reparte ese gasto real entre todos los turnos
que hubo. Ese segundo número es el bueno.

---

## 2. ¿De qué se compone el costo?

Cada pieza/bolsita/kilo que produces carga 4 tipos de costo:

| Pieza del costo | Qué es | Cómo se captura |
|---|---|---|
| **1. Materia prima (MP)** | El material que se transforma (maíz, resina, harina…) | Carga de MP en el turno |
| **2. Empaque** | Bolsa, etiqueta, caja, costal | Se define en la **receta** del producto |
| **3. Gastos indirectos** | Luz, gas, renta, mano de obra, mantenimiento… | Módulo **Costeo** |
| **4. Merma** | Material desperdiciado | Se captura aparte (no encarece el turno que la generó — ver §6) |

La fórmula final de cada turno es:

```
Costo total del turno = Materia prima + Empaque + Gastos indirectos
Costo por unidad      = (Costo total − valor de 2da calidad) ÷ unidades buenas
```

---

## 3. Las ventanas donde se captura o configura el costo

### 3.1 Carga de materia prima (durante el turno)
**Dónde:** Producción → Captura → pestaña **"Mat. Primas"**
*(solo aparece si el tenant usa lotes).*

- El operador elige el **material** y escribe los **kilogramos cargados**.
- **No se escribe el costo aquí.** El costo por kg sale solo, del precio que
  tiene configurado ese material (o del lote que se consume si usas lotes).
- Es opcional: si no se declara, el sistema estima el consumo a partir de la receta.

> 💡 El precio de cada material se configura en su ficha (catálogo de materias primas).
> Ahí es donde realmente "vive" el costo/kg que usará el costeo.

### 3.2 Captura de merma
**Dónde:** Producción → Captura → pestaña **"Merma"**

- El operador elige el **tipo de merma** y escribe los **kilogramos**.
- Tampoco se escribe costo. El sistema lo valúa solo (ver §6).

### 3.3 Configuración de gastos indirectos (módulo Costeo)
**Dónde:** Costeo → **"Gastos indirectos"** → botón **"Nuevo gasto"**

Aquí defines *una vez* cada gasto fijo del negocio. Por cada gasto capturas:

| Campo | Qué pones | Ejemplo |
|---|---|---|
| **Código** | Nombre corto sin espacios (no cambia después) | `renta`, `gas`, `mano_obra` |
| **Nombre** | Nombre legible | "Renta del local" |
| **Base de prorrateo** | Cómo se reparte entre turnos (ver §4) | "Por kg" |
| **Frecuencia** | Cada cuánto capturarás el monto real (ver §5) | "Mensual" |
| **Monto estimado por período** | Cuánto crees que costará al mes | $660 |

### 3.4 Períodos del mes
**Dónde:** Costeo → **"Períodos del mes"**

- A inicio de mes das clic en **"Crear períodos del mes"**: genera una fila por
  cada gasto activo, con su estimado.
- Puedes ajustar el **estimado** de ese mes si sabes que será distinto al de costumbre.

### 3.5 Cierre de mes (el recosteo real) ⭐
**Dónde:** Costeo → **"Cierre de mes"**

Es un asistente de 4 pasos:
1. Eliges **mes y año**.
2. Capturas el **monto real** que pagaste de cada gasto.
3. Revisas el resumen: **estimado vs. real vs. varianza**.
4. Confirmas → el sistema **recostea todos los turnos del mes** con los números reales.

> ⚠ El cierre es **irreversible**. Asegúrate de tener los montos reales antes.

### 3.6 Dónde se ve el costo resultante
**Dónde:** Producción → Resumen del turno → **"Desglose de costos del turno"**

Muestra: materia prima estimada, cada gasto fijo, empaque, costo total y
**costo por pieza** (o por metro).

---

## 4. La opción más importante: **Base de prorrateo**

Es **cómo se reparte un gasto entre los turnos del mes**. Hay 5 formas:

| Opción | Cómo reparte | Úsala para gastos que… | Ejemplos |
|---|---|---|---|
| **Partes iguales** | Cada turno paga lo mismo | …no dependen de cuánto produzcas | Renta, sueldo administrativo, internet |
| **Por turno** | Igual que "partes iguales" (cada turno = 1 parte) | …igual que arriba | Vigilancia, seguro |
| **Por horas** | Más horas = más gasto | …se acumulan con el tiempo | Renta de maquinaria por hora, algunos sueldos |
| **Por unidades** | Más piezas = más gasto | …suben con cada pieza producida | Destajo por pieza, consumibles por unidad |
| **Por kg** | Más kilos = más gasto | …suben con el volumen procesado | Luz del molino, gas, agua |

> **Regla simple:** pregúntate *"si produzco el doble, este gasto sube?"*
> - **No sube** → "Partes iguales" (renta, admin).
> - **Sube con las piezas** → "Por unidades".
> - **Sube con los kilos** → "Por kg".
> - **Sube con las horas trabajadas** → "Por horas".

---

## 5. La otra opción: **Frecuencia de captura**

Es **cada cuánto vas a capturar el monto real** de ese gasto. No cambia el cálculo
del turno; solo organiza tu ritmo de captura.

| Opción | Cuándo usarla |
|---|---|
| **Mensual** | La mayoría: renta, luz, gas, sueldos mensuales |
| **Quincenal** | Pagos cada 15 días (nómina quincenal) |
| **Anual** | Gastos que pagas 1 vez al año (seguros, licencias) |
| **Por evento** | Gastos esporádicos (una reparación, un flete puntual) |

---

## 6. La merma: por qué **no encarece** el turno que la generó

Cuando capturas merma, el sistema **no** se la cobra al turno donde ocurrió. En su lugar:

1. La merma entra a un almacén de **material reciclado** (regrind).
2. Se guarda valuada un poco **más cara** que la MP virgen: precio normal × (1 + **factor de reproceso**).
   El factor por defecto es **20%** (representa el costo de volver a procesarla).
3. El **turno que reutilice** ese material reciclado es el que paga ese sobrecosto,
   porque su costo/kg promedio sube al mezclar material reciclado.

> 👉 Así el costo se traslada a *quien aprovecha* el material, no a quien lo desperdició.
> Si nunca se reutiliza, simplemente queda como inventario reciclado disponible.

**Sobre el empaque y la merma:** el empaque se cobra **por paquete realmente
capturado**, nunca por el lote planeado. Si planeabas 250 bolsitas pero solo
empacaste 230, se cobran 230 bolsas + 230 etiquetas. El desperdicio no consume empaque.

---

## 7. Cómo se **estima** el costo durante el mes

Cuando cierras un turno, el sistema:

1. Busca los gastos del mes que estén **abiertos** (no cerrados aún).
2. Por cada gasto calcula la "parte" que le toca a ese turno según su **base de prorrateo**:
   - *Partes iguales / por turno* → 1 parte.
   - *Por horas* → las horas que duró el turno.
   - *Por unidades* → las piezas que produjo.
   - *Por kg* → los kilos que produjo.
3. Suma todas las partes y lo guarda como **overhead estimado del turno**.

> ⚠ **Importante (provisional):** mientras el mes está abierto, este número es
> **aproximado y suele salir alto**, porque el sistema todavía no sabe cuántos
> turnos habrá en total. El número fino llega en el **cierre de mes**.
> No te alarmes si el costo por unidad se ve elevado a mitad de mes.

---

## 8. Cómo se **corrige** al cierre (recosteo real)

En "Cierre de mes" capturas lo que **realmente** pagaste. Entonces el sistema:

1. Cuenta **todo lo que de verdad pasó** en el mes (total de turnos, horas, piezas o kilos, según cada gasto).
2. Reparte tu **gasto real** entre los turnos en esa proporción exacta.
3. Reescribe el costo real de cada turno y de cada orden.
4. Te muestra la **varianza**: cuánto te equivocaste al estimar (estimado vs. real).

**Ejemplo del reparto:** pagaste **$660 de gas** real. En el mes produjiste **55 kg** en total,
repartidos en 4 turnos. El gas es "por kg", así que:

| Turno | Kg producidos | Gas real asignado |
|---|---|---|
| 1 | 20 kg | $660 × 20/55 = **$240.00** |
| 2 | 15 kg | $660 × 15/55 = **$180.00** |
| 3 | 12 kg | $660 × 12/55 = **$144.00** |
| 4 | 8 kg  | $660 × 8/55  = **$96.00** |
| **Total** | **55 kg** | **$660.00** |

---

## 9. Ejemplos prácticos por tipo de negocio

### 9.1 Palomitas / frituras (paopops) — se vende por pieza

**Gastos indirectos a configurar:**

| Gasto | Base de prorrateo | Frecuencia | Estimado mensual | Por qué |
|---|---|---|---|---|
| Mano de obra (destajo empaque) | **Por unidades** | Quincenal | $4,400 | Pagan $2 por bolsita; sube con cada bolsita |
| Gas | **Por kg** | Mensual | $660 | Sube con el volumen que se cocina |
| Renta | *(no aplica)* | — | — | Trabajan desde casa |

**Empaque (en la receta, no en gastos indirectos):** bolsa $1.00 + etiqueta $0.35 = **$1.35/bolsita**.

**Costo de un turno** (produjo 600 bolsitas):

```
Materia prima (maíz + saborizante)............  $540.00
Empaque (600 × $1.35).........................  $810.00
Mano de obra (600 × $2)*...................... $1,200.00
Gas (parte del turno)*........................   $180.00
----------------------------------------------
Costo total del turno......................... $2,730.00
Costo por bolsita (÷ 600).....................     $4.55
```
*\* Mano de obra y gas se afinan en el cierre de mes.*

> Nota: el **aceite** capturado en litros no entra hoy al costo (tema de densidad,
> pendiente documentado). Si lo capturas en kg, sí se cuenta.

### 9.2 Reciclado / plástico — se vende por kg

| Gasto | Base de prorrateo | Frecuencia | Por qué |
|---|---|---|---|
| Energía eléctrica (molino) | **Por kg** | Mensual | El consumo sube con los kilos procesados |
| Renta de la nave | **Partes iguales** | Mensual | Es fija, no depende de la producción |
| Mano de obra directa | **Por horas** | Quincenal | Se paga por tiempo trabajado |
| Mantenimiento mayor | **Por evento** | Por evento | Esporádico (cuando se descompone algo) |

**Empaque (receta):** 1 costal por cada 25 kg producidos.

### 9.3 Pastelería — se vende por pieza

| Gasto | Base de prorrateo | Frecuencia | Por qué |
|---|---|---|---|
| Renta del local | **Partes iguales** | Mensual | Fija |
| Gas del horno | **Por unidades** | Mensual | Sube con cada pieza horneada |
| Mano de obra | **Por horas** | Quincenal | Por tiempo |
| Luz | **Por kg** o **Partes iguales** | Mensual | Según qué tanto dependa del volumen |

---

## 10. Recomendaciones rápidas (resumen)

- **Renta, admin, internet, seguros** → "Partes iguales".
- **Luz/gas/agua de proceso** → "Por kg".
- **Destajo, consumibles por pieza** → "Por unidades".
- **Mano de obra por tiempo, maquinaria por hora** → "Por horas".
- **Empaque** → va en la **receta**, no en gastos indirectos. Se cobra por paquete capturado.
- **Merma** → captúrala; no encarece el turno que la generó, sino al que la reutiliza.
- El costo **durante el mes es provisional**; el **cierre de mes** da el número real.
- Cierra el mes **siempre**: si no, los costos se quedan en el estimado (alto y provisional).

---

## 11. Errores comunes

| Error | Consecuencia | Solución |
|---|---|---|
| No cerrar el mes | El costo se queda en el estimado provisional (sale alto) | Hacer "Cierre de mes" cada mes |
| Meter el empaque como gasto indirecto | Se cobra doble o mal repartido | El empaque va en la **receta** del producto |
| Elegir "Partes iguales" para la luz | Un turno chico paga lo mismo que uno grande | Usar "Por kg" para gastos que escalan |
| No capturar el precio del material | La MP cuesta $0 en el costeo | Configurar el costo/kg en la ficha del material |
| Capturar líquidos en litros | No entran al costo (tema de densidad) | Capturar en kg mientras tanto |
