// Utilidad para imprimir la representación de una remisión.
//
// Abre una ventana popup con un HTML standalone (sin Tailwind / CSS del SPA)
// y dispara window.print() automáticamente al cargar. Más portable que pelear
// con @media print en el SPA.

function escape(str) {
  if (str == null) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmtMoney(n, currency = 'MXN') {
  if (n == null || n === '') return '—'
  const sym = currency === 'USD' ? 'US$' : '$'
  return sym + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtQty(n, decimals = 3) {
  if (n == null) return '—'
  return Number(n).toLocaleString('es-MX', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

function fmtDate(d) {
  if (!d) return '—'
  // Fechas de calendario (emisión, vencimiento) sin desfase de zona horaria.
  const s = String(d).slice(0, 10)
  const [y, m, day] = s.split('-').map(Number)
  if (s.length === 10 && y && m && day)
    return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' })
  return new Date(d).toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' })
}

function buildRowsHtml(lines, currency, showPrices) {
  return lines.map(l => {
    const qty   = parseFloat(l.quantity_delivered || 0)
    const price = parseFloat(l.unit_price || 0)
    const disc  = parseFloat(l.discount_pct || 0)
    const importe = qty * price * (1 - disc / 100)
    return `
      <tr>
        <td class="sku">${escape(l.sku || '')}</td>
        <td class="prod">
          ${escape(l.product_name || '')}
          ${l.notes ? `<div class="note">${escape(l.notes)}</div>` : ''}
        </td>
        <td class="num">${fmtQty(qty)} ${escape(l.unit || '')}</td>
        ${showPrices ? `
          <td class="num">${fmtMoney(price, currency)}</td>
          <td class="num">${disc > 0 ? fmtQty(disc, 2) + '%' : '—'}</td>
          <td class="num strong">${fmtMoney(importe, currency)}</td>
        ` : ''}
      </tr>
    `
  }).join('')
}

function buildTotalsHtml(note) {
  const subtotal = parseFloat(note.subtotal_mxn || 0)
  const tax      = parseFloat(note.tax_mxn || 0)
  const total    = parseFloat(note.total_mxn || subtotal + tax)
  return `
    <table class="totals">
      <tr>
        <td>Subtotal</td>
        <td class="num">${fmtMoney(subtotal, note.currency)}</td>
      </tr>
      <tr>
        <td>IVA 16%</td>
        <td class="num">${fmtMoney(tax, note.currency)}</td>
      </tr>
      <tr class="grand">
        <td>Total</td>
        <td class="num">${fmtMoney(total, note.currency)}</td>
      </tr>
    </table>
  `
}

export function printRemision(note, { showPrices = true, companyName = '' } = {}) {
  const lines = note.lines || []
  const headerTitle = showPrices ? 'REMISIÓN' : 'REMISIÓN DE ENTREGA'

  const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Remisión ${escape(note.document_number)}</title>
  <style>
    @page { size: letter; margin: 1.5cm 1.4cm; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: #111;
      font-size: 11px;
      line-height: 1.45;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #111;
      padding-bottom: 14px;
      margin-bottom: 18px;
    }
    .company { font-size: 18px; font-weight: 700; }
    .company .label { font-size: 10px; color: #666; font-weight: 400; margin-top: 2px; }
    .doc-box {
      text-align: right;
      border: 1.5px solid #111;
      padding: 8px 14px;
      min-width: 180px;
    }
    .doc-box .title {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 1px;
    }
    .doc-box .number {
      font-family: 'Courier New', monospace;
      font-size: 16px;
      font-weight: 700;
      margin-top: 4px;
    }
    .doc-box .date {
      font-size: 10px;
      color: #555;
      margin-top: 4px;
    }
    .meta {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px 20px;
      margin-bottom: 18px;
    }
    .meta .row { display: flex; gap: 6px; }
    .meta .label {
      font-size: 9px;
      text-transform: uppercase;
      color: #666;
      letter-spacing: 0.5px;
      min-width: 70px;
    }
    .meta .value { font-weight: 600; }
    table.items {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 14px;
    }
    table.items th {
      text-align: left;
      background: #f3f3f3;
      padding: 7px 9px;
      font-size: 9.5px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: #444;
      border-bottom: 1.5px solid #999;
    }
    table.items td {
      padding: 8px 9px;
      border-bottom: 1px solid #e5e5e5;
      vertical-align: top;
    }
    table.items td.sku { font-family: 'Courier New', monospace; color: #666; font-size: 10px; width: 70px; }
    table.items td.prod { font-weight: 500; }
    table.items td.prod .note { font-size: 10px; color: #777; font-style: italic; margin-top: 2px; }
    table.items td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    table.items td.strong { font-weight: 600; }
    table.totals {
      margin-left: auto;
      border-collapse: collapse;
      min-width: 220px;
    }
    table.totals td { padding: 4px 10px; border: none; font-size: 11px; }
    table.totals td.num { text-align: right; font-variant-numeric: tabular-nums; }
    table.totals tr.grand td {
      font-weight: 700;
      font-size: 13px;
      border-top: 1.5px solid #111;
      padding-top: 6px;
    }
    .notes-block {
      margin-top: 22px;
      padding: 9px 12px;
      background: #fafafa;
      border-left: 3px solid #888;
      font-size: 10.5px;
    }
    .notes-block .label {
      font-size: 9px;
      text-transform: uppercase;
      color: #666;
      letter-spacing: 0.5px;
      margin-bottom: 3px;
    }
    .signatures {
      margin-top: 50px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 50px;
    }
    .sig-box {
      border-top: 1px solid #111;
      padding-top: 6px;
      text-align: center;
      font-size: 10px;
      color: #444;
    }
    .sig-box .label { font-weight: 600; color: #111; }
    .receiver-name {
      margin-top: -42px;
      padding: 0 6px 6px;
      text-align: center;
      font-weight: 600;
      font-size: 13px;
      color: #111;
    }
    .footer-stamp {
      margin-top: 24px;
      font-size: 9px;
      color: #888;
      text-align: center;
    }
    @media print {
      body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="company">
      ${companyName ? escape(companyName) : '&nbsp;'}
      <div class="label">Emisor</div>
    </div>
    <div class="doc-box">
      <div class="title">${headerTitle}</div>
      <div class="number">${escape(note.document_number)}</div>
      <div class="date">Emitida ${fmtDate(note.issue_date)}</div>
    </div>
  </div>

  <div class="meta">
    <div class="row">
      <div class="label">Cliente</div>
      <div class="value">${escape(note.partner_name || '')}</div>
    </div>
    <div class="row">
      <div class="label">RFC</div>
      <div class="value">${escape(note.rfc || '—')}</div>
    </div>
    ${note.order_number ? `
      <div class="row">
        <div class="label">Pedido</div>
        <div class="value" style="font-family:'Courier New',monospace">${escape(note.order_number)}</div>
      </div>
    ` : ''}
    ${note.po_number ? `
      <div class="row">
        <div class="label">OC cliente</div>
        <div class="value">${escape(note.po_number)}</div>
      </div>
    ` : ''}
    ${note.delivery_address ? `
      <div class="row" style="grid-column:1/-1">
        <div class="label">Domicilio</div>
        <div class="value">${escape((note.address_alias ? note.address_alias + ' · ' : '') + note.delivery_address + (note.delivery_city ? ', ' + note.delivery_city : ''))}</div>
      </div>
    ` : ''}
    ${note.credit_due_date ? `
      <div class="row">
        <div class="label">Vence</div>
        <div class="value">${fmtDate(note.credit_due_date)}</div>
      </div>
    ` : ''}
  </div>

  <table class="items">
    <thead>
      <tr>
        <th>SKU</th>
        <th>Producto</th>
        <th style="text-align:right">Cantidad</th>
        ${showPrices ? `
          <th style="text-align:right">P. Unit.</th>
          <th style="text-align:right">Desc.</th>
          <th style="text-align:right">Importe</th>
        ` : ''}
      </tr>
    </thead>
    <tbody>
      ${buildRowsHtml(lines, note.currency, showPrices)}
    </tbody>
  </table>

  ${showPrices ? buildTotalsHtml(note) : ''}

  ${note.notes ? `
    <div class="notes-block">
      <div class="label">Notas</div>
      <div>${escape(note.notes)}</div>
    </div>
  ` : ''}

  <div class="signatures">
    <div class="sig-box">
      <div class="receiver-name">${escape(note.receiver_name || '')}</div>
      <div class="label">Recibí conforme</div>
      <div>Nombre y firma</div>
    </div>
    <div class="sig-box">
      <div class="label">Entregó</div>
      <div>Repartidor</div>
    </div>
  </div>

  <div class="footer-stamp">
    Esta remisión ${showPrices ? '' : 'no muestra precios y '}es un documento interno de control de entrega.
    No sustituye al CFDI.
  </div>

  <script>
    window.onload = function() {
      setTimeout(function() { window.print(); }, 250);
    };
  </script>
</body>
</html>
  `

  const w = window.open('', '_blank', 'width=900,height=1100')
  if (!w) {
    alert('Tu navegador bloqueó la ventana de impresión. Permite popups para este sitio.')
    return
  }
  w.document.open()
  w.document.write(html)
  w.document.close()
  w.focus()
}
