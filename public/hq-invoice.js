/* ============================================================================
 * hq-invoice.js — printable GST tax invoice for a Helm subscription payment.
 * ---------------------------------------------------------------------------
 *   window.HelmInvoice.open(data)   → opens a same-origin print view (about:blank
 *                                     inherits this page's CSP) and calls print()
 *                                     so the operator / studio can "Save as PDF".
 *
 * CSP: no external libraries, no inline <script>, no innerHTML. Every value is
 * written with textContent / createElement. Styling uses a <style> element, which
 * the existing policy allows (style-src 'self' 'unsafe-inline').
 *
 * ASSUMED INPUT SHAPE (the JSON from rpc hq_invoice(payment_id) / my_invoice(payment_id),
 * migration 0045 — NOT FINAL, so every field is read defensively and has fallbacks):
 * {
 *   invoice_no:   "HELM/2026-27/0001",
 *   issued_on:    "2026-10-07"            (fallback: paid_on, then today)
 *   paid_on:      "2026-10-07",
 *   period_start: "2026-10-01", period_end: "2026-10-31",
 *   currency:     "INR",
 *   net:          999.00                  (taxable value, RUPEES not paise)
 *   gst_rate:     18                      (percent; fallback seller.gst_rate)
 *   gst_amount:   179.82,
 *   amount:       1178.82                 (total; fallback net + gst_amount)
 *   method:       "razorpay" | "upi" | "bank" | ...,  reference: "pay_XXXX",
 *   voided_at:    null | timestamp,
 *   plan:         { name: "Studio Pro" }  (or plan_name: "Studio Pro")
 *   seller:       { legal_name, gstin, address, gst_rate, invoice_prefix }
 *                 (or flat: seller_legal_name / seller_gstin / seller_address)
 *   buyer:        { legal_name?, name, gstin?, address?, state? }  (or studio_name / org_name)
 *   seller.state: "Telangana"
 *   gst_split:    { type: 'IGST' | 'CGST_SGST', igst, cgst, sgst }
 *                 Missing → derived: seller.state === buyer.state (case-insensitive) →
 *                 CGST_SGST (half each), different states → IGST, either unknown →
 *                 one plain "GST" line. Place of supply = buyer.state.
 * }
 *
 * GLOBAL SHAPE (preferred; the GST fields above are the fallback when `tax` is absent):
 * { invoice_no, issued_on, paid_on, currency, fx_rate_to_inr, inr_equivalent,
 *   net_amount, total, status, voided_at, period_start, period_end, method, reference,
 *   tax: { regime, components: [{ name, rate, amount }], note, lut_number },  (0 lines OK)
 *   seller: { legal_name, gstin, address, state, country },
 *   buyer:  { legal_name, name, country, state, tax_id_type, tax_id, address, email },
 *   place_of_supply, plan: { name }, lines: [{ description, amount }] }
 * Title: "Tax Invoice" for Indian buyers, "Invoice" for exports (buyer.country not India,
 * or tax.regime mentions export). Money uses Intl.NumberFormat in the invoice currency;
 * a non-INR invoice with fx_rate_to_inr also shows "INR equivalent @ rate: ₹x".
 * Also usable from node: module.exports = { helpers } for unit tests.
 * ========================================================================== */
(function (root) {
  'use strict';

  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function pick() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== null && v !== undefined && String(v).trim() !== '') return v;
    }
    return '';
  }
  function num(v) {
    if (v === null || v === undefined || v === '') return NaN;
    if (typeof v !== 'number' && !/^\s*-?[0-9][0-9,]*(\.[0-9]+)?\s*$/.test(String(v))) return NaN;
    var n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s]/g, ''));
    return isFinite(n) ? n : NaN;
  }
  function round2(n) { return Math.round(n * 100) / 100; }

  // Intl.NumberFormat in the invoice currency (en-IN grouping for INR); a bad code or
  // missing Intl falls back to the manual formatter below.
  function formatMoney(v, currency) {
    var n = num(v);
    if (!isFinite(n)) return '—';
    var cur = str(currency || 'INR').toUpperCase();
    if (/^[A-Z]{3}$/.test(cur) && typeof Intl !== 'undefined' && Intl.NumberFormat) {
      try {
        return new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(round2(n));
      } catch (_) { /* fall through */ }
    }
    return manualMoney(n, cur);
  }
  function manualMoney(n, cur) {
    var neg = n < 0; n = Math.abs(round2(n));
    var parts = n.toFixed(2).split('.');
    var int = parts[0];
    var last3 = int.slice(-3), rest = int.slice(0, -3);
    if (rest) rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',';
    var body = rest + last3 + '.' + parts[1];
    var sym = cur === 'INR' ? '₹' : cur + ' ';
    return (neg ? '-' : '') + sym + body;
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // "2026-10-07" / ISO timestamp → "07 Oct 2026"; anything unparseable → "—"
  function formatDate(v) {
    var s = str(v).trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) return '—';
    var mo = Number(m[2]);
    if (mo < 1 || mo > 12) return '—';
    return m[3] + ' ' + MONTHS[mo - 1] + ' ' + m[1];
  }
  function formatPeriod(a, b) {
    var x = formatDate(a), y = formatDate(b);
    if (x === '—' && y === '—') return '—';
    return x + ' – ' + y;
  }

  // { type, igst, cgst, sgst } from the RPC, or derived from the two states.
  function deriveSplit(given, gst, sellerState, buyerState) {
    var g = (given && typeof given === 'object') ? given : null;
    var type = g ? str(g.type).toUpperCase() : '';
    if (type === 'IGST' || type === 'CGST_SGST') {
      var out = { type: type, igst: num(g.igst), cgst: num(g.cgst), sgst: num(g.sgst) };
      if (type === 'IGST' && !isFinite(out.igst)) out.igst = gst;
      if (type === 'CGST_SGST' && isFinite(gst)) {
        if (!isFinite(out.cgst)) out.cgst = round2(gst / 2);
        if (!isFinite(out.sgst)) out.sgst = round2(gst - out.cgst);
      }
      return out;
    }
    var a = sellerState.trim().toLowerCase(), b = buyerState.trim().toLowerCase();
    if (!a || !b) return { type: 'GST', igst: NaN, cgst: NaN, sgst: NaN };
    if (a === b) {
      var c = isFinite(gst) ? round2(gst / 2) : NaN;
      return { type: 'CGST_SGST', igst: NaN, cgst: c, sgst: isFinite(gst) ? round2(gst - c) : NaN };
    }
    return { type: 'IGST', igst: gst, cgst: NaN, sgst: NaN };
  }
  function gstLines(split, rate, gst, cur) {
    var r = isFinite(rate) ? rate + '%' : '—';
    var h = isFinite(rate) ? round2(rate / 2) + '%' : '—';
    if (split.type === 'IGST') return [{ label: 'IGST @ ' + r, amount: formatMoney(split.igst, cur) }];
    if (split.type === 'CGST_SGST') return [
      { label: 'CGST @ ' + h, amount: formatMoney(split.cgst, cur) },
      { label: 'SGST @ ' + h, amount: formatMoney(split.sgst, cur) },
    ];
    return [{ label: 'GST @ ' + r, amount: formatMoney(gst, cur) }];
  }

  // Normalise any plausible invoice JSON into one flat, display-ready model.
  function normalize(data) {
    var d = (data && typeof data === 'object') ? data : {};
    var seller = (d.seller && typeof d.seller === 'object') ? d.seller : {};
    var buyer = (d.buyer && typeof d.buyer === 'object') ? d.buyer : {};
    var plan = (d.plan && typeof d.plan === 'object') ? d.plan : {};
    var currency = str(pick(d.currency, 'INR')).toUpperCase().slice(0, 3);
    var net = num(pick(d.net_amount, d.net));
    var tax = (d.tax && typeof d.tax === 'object') ? d.tax : null;
    var comps = tax && Array.isArray(tax.components) ? tax.components.filter(function (c) { return c && typeof c === 'object'; }) : null;
    var rate = num(pick(d.gst_rate, d.gst_percent, seller.gst_rate));
    var gst = num(d.gst_amount);
    if (comps && !isFinite(gst)) gst = round2(comps.reduce(function (a, c) { var x = num(c.amount); return a + (isFinite(x) ? x : 0); }, 0));
    if (!isFinite(gst) && isFinite(net) && isFinite(rate)) gst = round2(net * rate / 100);
    var total = num(pick(d.amount, d.total));
    if (!isFinite(total) && isFinite(net)) total = round2(net + (isFinite(gst) ? gst : 0));
    if (!isFinite(net) && isFinite(total) && isFinite(gst)) net = round2(total - gst);
    var split = deriveSplit(d.gst_split, gst, str(pick(seller.state, d.seller_state)), str(pick(buyer.state, d.buyer_state)));
    var taxLines = comps ? comps.map(function (c) {
      var cr = num(c.rate);
      return { label: (str(c.name) || 'Tax') + (isFinite(cr) ? ' @ ' + round2(cr) + '%' : ''), amount: formatMoney(c.amount, currency) };
    }) : null;
    var taxNote = tax ? str(tax.note) : '';
    if (tax && str(tax.lut_number) && taxNote.indexOf(str(tax.lut_number)) < 0) taxNote = (taxNote ? taxNote + ' ' : '') + '(LUT ' + str(tax.lut_number) + ')';
    var country = str(buyer.country).trim().toLowerCase();
    var isExport = (!!country && ['in', 'ind', 'india'].indexOf(country) < 0) || /export/i.test(str(tax && tax.regime));
    var fx = num(d.fx_rate_to_inr), inrEq = '';
    if (currency !== 'INR' && isFinite(fx) && fx > 0) {
      var eq = num(d.inr_equivalent);
      if (!isFinite(eq) && isFinite(total)) eq = round2(total * fx);
      if (isFinite(eq)) inrEq = 'INR equivalent @ ' + fx + ': ' + formatMoney(eq, 'INR');
    }
    var lines = Array.isArray(d.lines) ? d.lines.filter(function (l) { return l && typeof l === 'object'; })
      .map(function (l) { return { description: str(l.description) || '—', amount: formatMoney(l.amount, currency) }; }) : [];
    var today = new Date().toISOString().slice(0, 10);
    return {
      invoiceNo: str(pick(d.invoice_no, d.number)) || '—',
      date: formatDate(pick(d.issued_on, d.paid_on, today)),
      period: formatPeriod(d.period_start, d.period_end),
      plan: str(pick(plan.name, d.plan_name, d.plan)) || 'Helm subscription',
      currency: currency,
      net: formatMoney(net, currency),
      gstRate: isFinite(rate) ? (round2(rate) + '%') : '—',
      gstAmount: formatMoney(gst, currency),
      gstLines: taxLines || gstLines(split, isFinite(rate) ? round2(rate) : NaN, gst, currency),
      taxNote: taxNote,
      isExport: isExport,
      title: isExport ? 'Invoice' : 'Tax Invoice',
      inrEquivalent: inrEq,
      lines: lines,
      placeOfSupply: str(pick(d.place_of_supply, buyer.state, d.buyer_state)) || '—',
      total: formatMoney(total, currency),
      method: str(d.method) || '—',
      reference: str(pick(d.reference, d.provider_payment_id)) || '—',
      voided: !!d.voided_at,
      seller: {
        name: str(pick(seller.legal_name, d.seller_legal_name)) || 'Helm',
        gstin: str(pick(seller.gstin, d.seller_gstin)),
        address: str(pick(seller.address, d.seller_address)),
        state: str(pick(seller.state, d.seller_state)),
        country: str(seller.country),
      },
      buyer: {
        name: str(pick(buyer.legal_name, buyer.name, d.studio_name, d.org_name)) || '—',
        state: str(pick(buyer.state, d.buyer_state)),
        gstin: str(pick(buyer.tax_id, buyer.gstin, d.buyer_gstin)),
        taxIdLabel: str(pick(buyer.tax_id_type, buyer.tax_id ? 'Tax ID' : 'GSTIN')).toUpperCase().slice(0, 12),
        country: str(buyer.country),
        address: str(pick(buyer.address, d.buyer_address)),
      },
    };
  }

  var CSS = [
    '*{box-sizing:border-box}body{font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:0;background:#fff}',
    '.inv{max-width:780px;margin:24px auto;padding:32px;position:relative}',
    'h1{font-size:22px;margin:0 0 4px;letter-spacing:.04em}.muted{color:#555}.row{display:flex;justify-content:space-between;gap:24px;margin:20px 0}',
    '.box{flex:1}.box h3{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#666;margin:0 0 6px}.pre{white-space:pre-line}',
    'table{width:100%;border-collapse:collapse;margin-top:16px}th,td{padding:8px 10px;border-bottom:1px solid #ddd;text-align:left}',
    'td.n,th.n{text-align:right}tr.tot td{font-weight:700;border-top:2px solid #111}',
    '.void{position:fixed;top:40%;left:0;right:0;text-align:center;font-size:120px;font-weight:800;color:rgba(200,0,0,.18);transform:rotate(-24deg);pointer-events:none}',
    '.note{margin:16px 0;padding:10px 14px;border:2px solid #111;font-weight:600}.fx{margin-top:8px;text-align:right;color:#333}',
    '.foot{margin-top:28px;font-size:12px;color:#666}@media print{.inv{margin:0;padding:12mm}.noprint{display:none}}',
  ].join('');

  function el(doc, tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // Build the invoice DOM into `doc` (a blank document). Pure DOM, no HTML strings.
  function render(doc, data) {
    var m = normalize(data);
    doc.title = m.title + ' ' + m.invoiceNo;
    var style = doc.createElement('style');
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
    var body = doc.body;
    while (body.firstChild) body.removeChild(body.firstChild);
    var w = el(doc, 'div', 'inv');
    if (m.voided) w.appendChild(el(doc, 'div', 'void', 'VOID'));
    w.appendChild(el(doc, 'h1', '', m.title.toUpperCase() + (m.voided ? ' (VOID)' : '')));
    w.appendChild(el(doc, 'div', 'muted', 'Invoice no. ' + m.invoiceNo + ' · Date ' + m.date));

    if (m.taxNote) w.appendChild(el(doc, 'div', 'note', m.taxNote));
    var row = el(doc, 'div', 'row');
    function party(title, p) {
      var b = el(doc, 'div', 'box');
      b.appendChild(el(doc, 'h3', '', title));
      b.appendChild(el(doc, 'div', '', p.name)).style.fontWeight = '600';
      if (p.gstin) b.appendChild(el(doc, 'div', '', (p.taxIdLabel || 'GSTIN') + ': ' + p.gstin));
      if (p.address) b.appendChild(el(doc, 'div', 'pre', p.address));
      if (p.state) b.appendChild(el(doc, 'div', '', 'State: ' + p.state));
      if (p.country) b.appendChild(el(doc, 'div', '', 'Country: ' + p.country));
      return b;
    }
    row.appendChild(party('Seller', m.seller));
    row.appendChild(party('Bill to', m.buyer));
    w.appendChild(row);

    var t = el(doc, 'table');
    var hr = el(doc, 'tr');
    hr.appendChild(el(doc, 'th', '', 'Description'));
    hr.appendChild(el(doc, 'th', '', 'Period'));
    hr.appendChild(el(doc, 'th', 'n', 'Amount'));
    var thead = el(doc, 'thead'); thead.appendChild(hr); t.appendChild(thead);
    var tb = el(doc, 'tbody');
    function line(a, b, c, cls) {
      var r = el(doc, 'tr', cls || '');
      r.appendChild(el(doc, 'td', '', a)); r.appendChild(el(doc, 'td', '', b)); r.appendChild(el(doc, 'td', 'n', c));
      tb.appendChild(r);
    }
    if (m.lines.length) m.lines.forEach(function (l) { line(l.description, m.period, l.amount); });
    else line('Helm subscription — ' + m.plan, m.period, m.net);
    line('Taxable value', '', m.net);
    m.gstLines.forEach(function (g) { line(g.label, '', g.amount); });
    line('Total (' + m.currency + ')', '', m.total, 'tot');
    t.appendChild(tb);
    w.appendChild(t);
    if (m.inrEquivalent) w.appendChild(el(doc, 'div', 'fx', m.inrEquivalent));

    w.appendChild(el(doc, 'div', 'foot', 'Place of supply: ' + m.placeOfSupply));
    w.appendChild(el(doc, 'div', 'foot', 'Paid via ' + m.method + ' · Reference ' + m.reference));
    w.appendChild(el(doc, 'div', 'foot', 'This is a computer-generated invoice and does not require a signature.'));
    body.appendChild(w);
    return m;
  }

  function open(data) {
    if (typeof window === 'undefined') return null;
    var win = window.open('', '_blank');           // about:blank → same origin, inherits CSP
    if (!win || !win.document) { alert('Allow pop-ups for this site to print the invoice.'); return null; }
    try { win.opener = null; } catch (_) { /* ignore */ }
    var doc = win.document;
    if (!doc.body) { doc.open(); doc.close(); }
    render(doc, data);
    setTimeout(function () { try { win.focus(); win.print(); } catch (_) { /* ignore */ } }, 50);
    return win;
  }

  var api = { open: open, render: render, helpers: { formatMoney: formatMoney, formatDate: formatDate, formatPeriod: formatPeriod, normalize: normalize, deriveSplit: deriveSplit } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.HelmInvoice = api;
})(typeof window !== 'undefined' ? window : null);
