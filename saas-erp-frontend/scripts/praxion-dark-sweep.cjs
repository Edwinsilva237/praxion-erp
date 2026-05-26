#!/usr/bin/env node
/* eslint-disable no-console */
'use strict'

/**
 * Barrido masivo de clases Tailwind heredadas del tema claro hacia los
 * tokens Praxion (dark + verde industrial). Idempotente — si ya fue corrido,
 * la segunda vez no cambia nada.
 *
 * Uso: node scripts/praxion-dark-sweep.js
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '../src')

// IMPORTANTE: el orden importa. Más específico primero, más genérico después.
// Cada regla es una pareja [regex, reemplazo]. Las regex usan flag global.
//
// Principios de paleta aplicados:
//   - bg-white sobre fondo oscuro = "isla" — preferir transparente o surface elevada
//   - texto gris claro (gray-900) sobre dark = invisible → mover a ink-primary
//   - badges/alertas de color (red/green/blue/amber) → variantes con bg-X/10 + text-X-300/-400
const RULES = [
  // ── Texto sólido (jerarquía 3 niveles) ──────────────────────────────────
  [/\btext-(?:gray|slate|zinc|neutral)-900\b/g, 'text-ink-primary'],
  [/\btext-(?:gray|slate|zinc|neutral)-800\b/g, 'text-ink-primary'],
  [/\btext-(?:gray|slate|zinc|neutral)-700\b/g, 'text-ink-secondary'],
  [/\btext-(?:gray|slate|zinc|neutral)-600\b/g, 'text-ink-secondary'],
  [/\btext-(?:gray|slate|zinc|neutral)-500\b/g, 'text-ink-muted'],
  [/\btext-(?:gray|slate|zinc|neutral)-400\b/g, 'text-ink-muted'],
  [/\btext-(?:gray|slate|zinc|neutral)-300\b/g, 'text-ink-muted'],

  // ── Fondos planos: cards/superficies ────────────────────────────────────
  // bg-white → si está en un contexto card-like, vista mejor sin fondo (deja que .card lo provea).
  // Lo más seguro es darle surface-primary; en modals/menus dará el contraste correcto.
  [/\bbg-white\b/g, 'bg-surface-primary'],
  [/\bbg-(?:gray|slate|zinc|neutral)-50\b/g, 'bg-surface-elevated/40'],
  [/\bbg-(?:gray|slate|zinc|neutral)-100\b/g, 'bg-surface-elevated/60'],
  [/\bbg-(?:gray|slate|zinc|neutral)-200\b/g, 'bg-surface-elevated'],

  // ── Bordes ──────────────────────────────────────────────────────────────
  [/\bborder-(?:gray|slate|zinc|neutral)-(?:50|100|200)\b/g, 'border-line-subtle'],
  [/\bborder-(?:gray|slate|zinc|neutral)-300\b/g, 'border-line-strong'],
  [/\bborder-(?:gray|slate|zinc|neutral)-400\b/g, 'border-line-strong'],

  // ── Divides (tablas) ────────────────────────────────────────────────────
  [/\bdivide-(?:gray|slate|zinc|neutral)-(?:50|100|200|300)\b/g, 'divide-line-subtle'],

  // ── Hovers ──────────────────────────────────────────────────────────────
  [/\bhover:bg-(?:gray|slate|zinc|neutral)-(?:50|100|200)\b/g, 'hover:bg-white/[0.04]'],
  [/\bhover:text-(?:gray|slate|zinc|neutral)-(?:900|800|700)\b/g, 'hover:text-ink-primary'],
  [/\bhover:border-(?:gray|slate|zinc|neutral)-(?:200|300|400)\b/g, 'hover:border-line-strong'],

  // ── Acentos brand (verde) ──────────────────────────────────────────────
  // En dark, los brand-50/100 (muy claros) deben ir a versiones más translúcidas.
  [/\bbg-brand-50\b/g, 'bg-brand-500/10'],
  [/\bbg-brand-100\b/g, 'bg-brand-500/15'],
  [/\btext-brand-(?:600|700|800|900)\b/g, 'text-brand-300'],
  [/\bborder-brand-(?:200|300|400)\b/g, 'border-brand-500/40'],
  [/\bhover:bg-brand-50\b/g, 'hover:bg-brand-500/15'],
  [/\bhover:bg-brand-100\b/g, 'hover:bg-brand-500/20'],
  [/\bhover:text-brand-(?:600|700|800)\b/g, 'hover:text-brand-200'],

  // ── Estados: rojo (danger) ─────────────────────────────────────────────
  [/\bbg-red-50\b/g, 'bg-status-danger/10'],
  [/\bbg-red-100\b/g, 'bg-status-danger/15'],
  [/\btext-red-(?:600|700|800|900)\b/g, 'text-status-danger'],
  [/\btext-red-500\b/g, 'text-status-danger'],
  [/\bborder-red-(?:100|200|300|400)\b/g, 'border-status-danger/40'],
  [/\bhover:bg-red-50\b/g, 'hover:bg-status-danger/15'],
  [/\bhover:text-red-(?:500|600|700)\b/g, 'hover:text-status-danger'],
  [/\bring-red-(?:200|300|400)\b/g, 'ring-status-danger/40'],

  // ── Estados: verde (success) — distinto del brand ──────────────────────
  [/\bbg-green-50\b/g, 'bg-status-success/10'],
  [/\bbg-green-100\b/g, 'bg-status-success/15'],
  [/\btext-green-(?:600|700|800|900)\b/g, 'text-status-success'],
  [/\bborder-green-(?:100|200|300)\b/g, 'border-status-success/40'],

  // ── Estados: ámbar/amarillo (warning) ───────────────────────────────────
  [/\bbg-amber-50\b/g, 'bg-status-warning/10'],
  [/\bbg-amber-100\b/g, 'bg-status-warning/15'],
  [/\bbg-yellow-50\b/g, 'bg-status-warning/10'],
  [/\bbg-yellow-100\b/g, 'bg-status-warning/15'],
  [/\btext-amber-(?:600|700|800|900)\b/g, 'text-status-warning'],
  [/\btext-yellow-(?:600|700|800|900)\b/g, 'text-status-warning'],
  [/\bborder-amber-(?:100|200|300)\b/g, 'border-status-warning/40'],
  [/\bborder-yellow-(?:100|200|300)\b/g, 'border-status-warning/40'],

  // ── Estados: azul (info) ────────────────────────────────────────────────
  [/\bbg-blue-50\b/g, 'bg-status-info/10'],
  [/\bbg-blue-100\b/g, 'bg-status-info/15'],
  [/\btext-blue-(?:600|700|800|900)\b/g, 'text-status-info'],
  [/\bborder-blue-(?:100|200|300)\b/g, 'border-status-info/40'],

  // ── Estados: morado/teal (badges varios) ────────────────────────────────
  [/\bbg-purple-50\b/g, 'bg-purple-500/10'],
  [/\bbg-purple-100\b/g, 'bg-purple-500/15'],
  [/\btext-purple-(?:600|700|800|900)\b/g, 'text-purple-300'],
  [/\bborder-purple-(?:100|200|300)\b/g, 'border-purple-500/40'],

  [/\bbg-teal-50\b/g, 'bg-teal-500/10'],
  [/\bbg-teal-100\b/g, 'bg-teal-500/15'],
  [/\btext-teal-(?:600|700|800|900)\b/g, 'text-teal-300'],
  [/\bborder-teal-(?:100|200|300)\b/g, 'border-teal-500/40'],

  // ── Sombras pesadas ────────────────────────────────────────────────────
  [/\bshadow-(?:lg|xl|2xl)\b/g, 'shadow-card'],

  // ── Backdrops de modales: black/40 → bg-primary/80 + blur ──────────────
  // No reemplazo automáticamente para no romper estructuras — los modales
  // ya tienen su look. Si se ve raro, ajustar manualmente.

  // ── Placeholders ────────────────────────────────────────────────────────
  [/\bplaceholder-(?:gray|slate|zinc|neutral)-(?:300|400|500)\b/g, 'placeholder-ink-muted'],

  // ── Rings de focus genéricos ───────────────────────────────────────────
  [/\bfocus:ring-brand-(?:500|600)\/30\b/g, 'focus:ring-brand-500/30'],
]

// Archivos a procesar: .jsx en src/ (no node_modules, no dist).
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      walk(full, out)
    } else if (/\.(jsx|tsx|js|ts)$/.test(entry.name) && entry.name !== 'praxion-dark-sweep.js') {
      out.push(full)
    }
  }
  return out
}

const files = walk(ROOT)
let totalFiles = 0
let totalRepl = 0

for (const f of files) {
  const orig = fs.readFileSync(f, 'utf8')
  let next = orig
  let countInFile = 0
  for (const [re, repl] of RULES) {
    next = next.replace(re, (m) => { countInFile += 1; return repl })
  }
  if (next !== orig) {
    fs.writeFileSync(f, next, 'utf8')
    totalFiles += 1
    totalRepl += countInFile
    console.log(`  ${path.relative(ROOT, f)}  (${countInFile} cambios)`)
  }
}

console.log('')
console.log(`Archivos modificados: ${totalFiles}`)
console.log(`Reemplazos totales:   ${totalRepl}`)
