/* InvoiceSheet app: everything runs in the browser; files are never uploaded. */
(function () {
  'use strict';

  const CFG = window.IS_CONFIG;
  const T = window.IS_I18N;
  const LANG = document.documentElement.lang || 'en';
  const LIB = {
    pdf: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    zip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    xlsx: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  };
  const LICENSE_KEY = 'invoicesheet.license';
  const REVALIDATE_MS = 30 * 24 * 3600 * 1000;

  const $ = (sel) => document.querySelector(sel);
  const state = { invoices: [], errors: [] };

  /* ---------- helpers ---------- */

  const track = (name, data) => {
    try { window.umami && window.umami.track(name, data); } catch (_) { /* analytics is optional */ }
  };

  const loaded = {};
  function loadScript(src) {
    loaded[src] = loaded[src] || new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('load ' + src));
      document.head.appendChild(s);
    });
    return loaded[src];
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const nf = new Intl.NumberFormat(LANG, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qf = new Intl.NumberFormat(LANG, { maximumFractionDigits: 4 });
  const money = (v) => (v == null ? '' : nf.format(v));
  const qty = (v) => (v == null ? '' : qf.format(v));

  const UNITS = { C62: T.u_pcs, H87: T.u_pcs, EA: T.u_pcs, NAR: T.u_pcs, XPP: T.u_pcs, HUR: 'h', DAY: T.u_day, MON: T.u_month, ANN: T.u_year,
    KGM: 'kg', GRM: 'g', MTR: 'm', MTK: 'm²', MTQ: 'm³', LTR: 'l', KWH: 'kWh', MIN: 'min', WEE: T.u_week, LS: T.u_lumpsum, SET: T.u_set, KMT: 'km', TNE: 't' };
  const unitName = (c) => UNITS[c] || c;

  /* ---------- reading files ---------- */

  async function xmlFromPdf(buf) {
    await loadScript(LIB.pdf);
    const pdfjs = window.pdfjsLib;
    pdfjs.GlobalWorkerOptions.workerSrc = LIB.pdfWorker;
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    const att = (await pdf.getAttachments()) || {};
    const files = Object.values(att);
    const pick = files.find((a) => /^(factur-x|zugferd-invoice|xrechnung|ZUGFeRD-invoice)\.xml$/i.test(a.filename))
      || files.find((a) => /\.xml$/i.test(a.filename));
    if (!pick) throw new Error(T.err_pdf_no_xml);
    return new TextDecoder('utf-8').decode(pick.content);
  }

  async function* expand(file) {
    const name = file.name;
    if (/\.zip$/i.test(name)) {
      await loadScript(LIB.zip);
      const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
      for (const entry of Object.values(zip.files)) {
        if (entry.dir || /(^|\/)(__MACOSX|\.)/.test(entry.name)) continue;
        if (/\.(xml|pdf)$/i.test(entry.name)) {
          yield { name: entry.name, kind: /\.pdf$/i.test(entry.name) ? 'pdf' : 'xml', data: () => entry.async('arraybuffer') };
        }
      }
      return;
    }
    const isPdf = /\.pdf$/i.test(name) || file.type === 'application/pdf';
    yield { name, kind: isPdf ? 'pdf' : 'xml', data: () => file.arrayBuffer() };
  }

  async function handleFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    setBusy(true);
    let added = 0;
    for (const f of files) {
      try {
        for await (const item of expand(f)) {
          try {
            const buf = await item.data();
            const xml = item.kind === 'pdf' ? await xmlFromPdf(buf) : new TextDecoder('utf-8').decode(buf);
            const inv = window.InvoiceParser.parseXml(xml);
            inv.file = item.name;
            inv.fromPdf = item.kind === 'pdf';
            state.invoices.push(inv);
            added++;
          } catch (e) {
            state.errors.push({ file: item.name, msg: e instanceof window.InvoiceParser.NotAnInvoiceError ? T.err_not_invoice : (e.message || T.err_read) });
          }
        }
      } catch (e) {
        state.errors.push({ file: f.name, msg: e.message || T.err_read });
      }
    }
    setBusy(false);
    track('parse', { added, errors: state.errors.length, total: state.invoices.length });
    render();
  }

  /* ---------- rendering ---------- */

  function setBusy(on) {
    $('#is-drop').classList.toggle('busy', on);
    $('#is-drop-status').textContent = on ? T.parsing : '';
  }

  const kindLabel = (inv) => (inv.kind === 'credit' ? T.kind_credit : inv.kind === 'correction' ? T.kind_correction : T.kind_invoice);
  const warnText = (inv) => inv.warnings.map((w) => T['warn_' + w]).join(' · ');

  function render() {
    const n = state.invoices.length;
    $('#is-results').hidden = n === 0 && state.errors.length === 0;
    $('#is-count').textContent = T.n_invoices.replace('{n}', n);

    const rows = state.invoices.map((inv, i) => `
      <tr>
        <td><button class="link" data-view="${i}">${esc(inv.number || '—')}</button>${inv.kind !== 'invoice' ? ` <span class="tag">${esc(kindLabel(inv))}</span>` : ''}</td>
        <td class="nowrap">${esc(inv.issueDate)}</td>
        <td>${esc(inv.seller.name)}</td>
        <td>${esc(inv.buyer.name)}</td>
        <td class="num">${money(inv.totals.taxExclusive)}</td>
        <td class="num">${money(inv.totals.tax)}</td>
        <td class="num">${money(inv.totals.taxInclusive)}</td>
        <td>${esc(inv.currency)}</td>
        <td class="muted small">${esc(inv.format)}${inv.warnings.length ? ` <span class="warn" title="${esc(warnText(inv))}">⚠</span>` : ''}</td>
      </tr>`).join('');
    $('#is-tbody').innerHTML = rows;

    // Per-currency sums; credit notes count negative so the totals mean something.
    const sums = {};
    for (const inv of state.invoices) {
      const s = (sums[inv.currency || '?'] ||= { net: 0, tax: 0, gross: 0 });
      const sign = inv.kind === 'credit' ? -1 : 1;
      s.net += sign * (inv.totals.taxExclusive || 0);
      s.tax += sign * (inv.totals.tax || 0);
      s.gross += sign * (inv.totals.taxInclusive || 0);
    }
    $('#is-tfoot').innerHTML = Object.entries(sums).map(([cur, s]) => `
      <tr><td colspan="4">${esc(T.totals_label)}</td><td class="num">${money(s.net)}</td><td class="num">${money(s.tax)}</td><td class="num">${money(s.gross)}</td><td>${esc(cur)}</td><td></td></tr>`).join('');

    $('#is-errors').innerHTML = state.errors.map((e) => `<li><strong>${esc(e.file)}</strong>: ${esc(e.msg)}</li>`).join('');
    $('#is-errors').hidden = !state.errors.length;
    renderGateNote();
  }

  function party(p) {
    return `<strong>${esc(p.name)}</strong>${p.tradingName && p.tradingName !== p.name ? `<br>${esc(p.tradingName)}` : ''}
      ${p.street ? `<br>${esc(p.street)}` : ''}${p.postcode || p.city ? `<br>${esc([p.postcode, p.city].filter(Boolean).join(' '))}` : ''}${p.country ? `, ${esc(p.country)}` : ''}
      ${p.vatId ? `<br>${esc(T.v_vatid)}: ${esc(p.vatId)}` : ''}${p.taxId ? `<br>${esc(T.v_taxid)}: ${esc(p.taxId)}` : ''}
      ${p.email ? `<br>${esc(p.email)}` : ''}`;
  }

  function invoiceHtml(inv) {
    const t = inv.totals;
    const totalRow = (label, v, strong) => (v == null ? '' : `<tr${strong ? ' class="strong"' : ''}><td>${esc(label)}</td><td class="num">${money(v)} ${esc(inv.currency)}</td></tr>`);
    return `
      <div class="inv">
        <div class="inv-head">
          <div><div class="muted small">${esc(kindLabel(inv))} · ${esc(inv.format)}</div><h2>${esc(inv.number)}</h2></div>
          <dl>
            <dt>${esc(T.v_issued)}</dt><dd>${esc(inv.issueDate)}</dd>
            ${inv.dueDate ? `<dt>${esc(T.v_due)}</dt><dd>${esc(inv.dueDate)}</dd>` : ''}
            ${inv.deliveryDate ? `<dt>${esc(T.v_delivery)}</dt><dd>${esc(inv.deliveryDate)}</dd>` : ''}
            ${inv.buyerReference ? `<dt>${esc(T.col_buyer_ref)}</dt><dd>${esc(inv.buyerReference)}</dd>` : ''}
            ${inv.orderReference ? `<dt>${esc(T.col_order_ref)}</dt><dd>${esc(inv.orderReference)}</dd>` : ''}
          </dl>
        </div>
        <div class="inv-parties">
          <div><div class="muted small">${esc(T.v_seller)}</div>${party(inv.seller)}</div>
          <div><div class="muted small">${esc(T.v_buyer)}</div>${party(inv.buyer)}</div>
        </div>
        <table class="inv-lines">
          <thead><tr><th>#</th><th>${esc(T.col_item)}</th><th class="num">${esc(T.col_qty)}</th><th>${esc(T.col_unit)}</th><th class="num">${esc(T.col_unit_price)}</th><th class="num">${esc(T.col_vat_rate)}</th><th class="num">${esc(T.col_line_net)}</th></tr></thead>
          <tbody>${inv.lines.map((l) => `<tr><td>${esc(l.id)}</td><td>${esc(l.name)}${l.description ? `<div class="muted small">${esc(l.description)}</div>` : ''}</td><td class="num">${qty(l.quantity)}</td><td>${esc(unitName(l.unit))}</td><td class="num">${money(l.unitPrice)}</td><td class="num">${l.vatRate == null ? esc(l.vatCategory) : qty(l.vatRate) + ' %'}</td><td class="num">${money(l.net)}</td></tr>`).join('')}</tbody>
        </table>
        <div class="inv-bottom">
          <div>
            ${inv.vat.length ? `<table class="inv-vat"><thead><tr><th>${esc(T.col_vat_cat)}</th><th class="num">${esc(T.col_vat_rate)}</th><th class="num">${esc(T.col_vat_base)}</th><th class="num">${esc(T.col_vat_amount)}</th></tr></thead>
              <tbody>${inv.vat.map((v) => `<tr><td>${esc(v.category)}${v.exemption ? `<div class="muted small">${esc(v.exemption)}</div>` : ''}</td><td class="num">${v.rate == null ? '' : qty(v.rate) + ' %'}</td><td class="num">${money(v.base)}</td><td class="num">${money(v.tax)}</td></tr>`).join('')}</tbody></table>` : ''}
            ${inv.payment.iban || inv.payment.reference || inv.payment.terms ? `<p class="small"><strong>${esc(T.v_payment)}</strong><br>
              ${inv.payment.iban ? `IBAN: ${esc(inv.payment.iban)}${inv.payment.bic ? ` · BIC: ${esc(inv.payment.bic)}` : ''}<br>` : ''}
              ${inv.payment.reference ? `${esc(T.col_pay_ref)}: ${esc(inv.payment.reference)}<br>` : ''}
              ${inv.payment.terms ? esc(inv.payment.terms) : ''}</p>` : ''}
          </div>
          <table class="inv-totals">
            ${totalRow(T.v_lines_total, t.lineTotal)}
            ${t.allowances ? totalRow(T.v_allowances, -t.allowances) : ''}
            ${t.charges ? totalRow(T.v_charges, t.charges) : ''}
            ${totalRow(T.col_net, t.taxExclusive)}
            ${totalRow(T.col_vat, t.tax)}
            ${totalRow(T.col_gross, t.taxInclusive, true)}
            ${t.prepaid ? totalRow(T.v_prepaid, -t.prepaid) : ''}
            ${totalRow(T.col_payable, t.payable, true)}
          </table>
        </div>
        ${inv.notes.length ? `<div class="small inv-notes">${inv.notes.map(esc).join('<br>')}</div>` : ''}
        ${inv.warnings.length ? `<p class="warn small">⚠ ${esc(warnText(inv))}</p>` : ''}
        <p class="muted small">${esc(T.v_generated)} · ${esc(inv.file)}</p>
      </div>`;
  }

  function openInvoice(i) {
    $('#is-modal-body').innerHTML = invoiceHtml(state.invoices[i]);
    $('#is-modal').showModal();
    track('view');
  }

  /* ---------- export ---------- */

  function sheets() {
    const invoices = [[T.col_file, T.col_format, T.col_type, T.col_number, T.col_issue, T.col_due, T.col_currency, T.col_seller, T.col_seller_vat,
      T.col_seller_country, T.col_buyer, T.col_buyer_vat, T.col_buyer_ref, T.col_order_ref, T.col_net, T.col_vat, T.col_gross, T.col_prepaid,
      T.col_payable, 'IBAN', T.col_pay_ref, T.col_lines, T.col_check]];
    const lines = [[T.col_file, T.col_number, T.col_seller, T.col_line, T.col_item, T.col_desc, T.col_item_id, T.col_qty, T.col_unit,
      T.col_unit_price, T.col_line_net, T.col_vat_cat, T.col_vat_rate]];
    const vat = [[T.col_file, T.col_number, T.col_seller, T.col_vat_cat, T.col_vat_rate, T.col_vat_base, T.col_vat_amount]];
    for (const inv of state.invoices) {
      const t = inv.totals;
      invoices.push([inv.file, inv.format, kindLabel(inv), inv.number, inv.issueDate, inv.dueDate, inv.currency, inv.seller.name, inv.seller.vatId,
        inv.seller.country, inv.buyer.name, inv.buyer.vatId, inv.buyerReference, inv.orderReference, t.taxExclusive, t.tax, t.taxInclusive,
        t.prepaid, t.payable, inv.payment.iban, inv.payment.reference, inv.lines.length, inv.warnings.length ? warnText(inv) : 'OK']);
      for (const l of inv.lines) {
        lines.push([inv.file, inv.number, inv.seller.name, l.id, l.name, l.description, l.sellerItemId, l.quantity, unitName(l.unit), l.unitPrice,
          l.net, l.vatCategory, l.vatRate]);
      }
      for (const v of inv.vat) vat.push([inv.file, inv.number, inv.seller.name, v.category, v.rate, v.base, v.tax]);
    }
    return { invoices, lines, vat };
  }

  const stamp = () => new Date().toISOString().slice(0, 10);

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  async function exportXlsx() {
    await loadScript(LIB.xlsx);
    const X = window.XLSX;
    const s = sheets();
    const wb = X.utils.book_new();
    const add = (rows, name) => {
      const ws = X.utils.aoa_to_sheet(rows);
      ws['!cols'] = rows[0].map((h, c) => ({ wch: Math.min(40, Math.max(String(h).length, ...rows.slice(1, 200).map((r) => String(r[c] ?? '').length)) + 2) }));
      ws['!autofilter'] = { ref: X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: rows[0].length - 1 } }) };
      X.utils.book_append_sheet(wb, ws, name.slice(0, 31));
    };
    add(s.invoices, T.sheet_invoices);
    add(s.lines, T.sheet_lines);
    add(s.vat, T.sheet_vat);
    X.writeFile(wb, `invoices-${stamp()}.xlsx`);
  }

  // Excel in DE/FR/NL/PL/HR locales expects ';' separators and decimal commas in CSV.
  function exportCsv(which) {
    const semi = LANG !== 'en';
    const sep = semi ? ';' : ',';
    const cell = (v) => {
      if (v == null) return '';
      if (typeof v === 'number') return semi ? String(v).replace('.', ',') : String(v);
      const s = String(v);
      return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = sheets()[which];
    const csv = '﻿' + rows.map((r) => r.map(cell).join(sep)).join('\r\n');
    download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${which}-${stamp()}.csv`);
  }

  /* ---------- Pro licence (Polar) ---------- */

  const paymentsLive = () => Boolean(CFG.checkoutUrl && CFG.polarOrgId);

  function readLicense() {
    try { return JSON.parse(localStorage.getItem(LICENSE_KEY) || 'null'); } catch (_) { return null; }
  }
  function saveLicense(v) {
    try { v ? localStorage.setItem(LICENSE_KEY, JSON.stringify(v)) : localStorage.removeItem(LICENSE_KEY); } catch (_) { /* private mode */ }
  }
  const isPro = () => Boolean(readLicense());

  // Returns true/false for a definite answer, null when Polar could not be reached.
  async function validateKey(key) {
    try {
      const r = await fetch('https://api.polar.sh/v1/customer-portal/license-keys/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, organization_id: CFG.polarOrgId }),
      });
      if (r.ok) return (await r.json()).status === 'granted';
      return r.status === 404 || r.status === 422 ? false : null;
    } catch (_) {
      return null;
    }
  }

  async function revalidateQuietly() {
    const lic = readLicense();
    if (!lic || !paymentsLive() || Date.now() - lic.checked < REVALIDATE_MS) return;
    const ok = await validateKey(lic.key);
    if (ok === false) saveLicense(null);
    else if (ok) saveLicense({ key: lic.key, checked: Date.now() });
    renderGateNote();
  }

  function renderGateNote() {
    const el = $('#is-gate-note');
    if (!paymentsLive()) el.textContent = T.launch_free;
    else if (isPro()) el.textContent = T.pro_active;
    else el.textContent = T.free_limit.replace('{n}', CFG.freeLimit);
  }

  const needsPro = () => paymentsLive() && !isPro() && state.invoices.length > CFG.freeLimit;

  function guarded(fn, label) {
    return async () => {
      if (!state.invoices.length) return;
      if (needsPro()) {
        $('#is-paywall-count').textContent = state.invoices.length;
        $('#is-key-msg').textContent = '';
        $('#is-paywall').showModal();
        track('paywall_shown', { n: state.invoices.length });
        return;
      }
      track('export', { type: label, n: state.invoices.length, pro: isPro() });
      await fn();
    };
  }

  /* ---------- wiring ---------- */

  function init() {
    const drop = $('#is-drop');
    const input = $('#is-file');
    drop.addEventListener('click', (e) => { if (e.target.tagName !== 'INPUT') input.click(); });
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => { handleFiles(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));

    $('#is-tbody').addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]');
      if (b) openInvoice(Number(b.dataset.view));
    });
    $('#is-xlsx').addEventListener('click', guarded(exportXlsx, 'xlsx'));
    $('#is-csv').addEventListener('click', guarded(() => exportCsv('invoices'), 'csv'));
    $('#is-csv-lines').addEventListener('click', guarded(() => exportCsv('lines'), 'csv_lines'));
    $('#is-clear').addEventListener('click', () => { state.invoices = []; state.errors = []; render(); });
    $('#is-print').addEventListener('click', () => window.print());
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

    $('#is-buy').href = CFG.checkoutUrl || '#';
    $('#is-buy').addEventListener('click', () => track('checkout_click', { n: state.invoices.length }));
    $('#is-key-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = $('#is-key').value.trim();
      if (!key) return;
      $('#is-key-msg').textContent = '…';
      const ok = await validateKey(key);
      if (ok) {
        saveLicense({ key, checked: Date.now() });
        $('#is-key-msg').textContent = T.key_ok;
        track('license_ok');
        renderGateNote();
        setTimeout(() => $('#is-paywall').close(), 900);
      } else {
        $('#is-key-msg').textContent = ok === false ? T.key_bad : T.key_offline;
      }
    });

    renderGateNote();
    revalidateQuietly();
    window.addEventListener('beforeprint', () => document.body.classList.toggle('printing-invoice', $('#is-modal').open));
  }

  init();
})();
