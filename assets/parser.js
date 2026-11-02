/* InvoiceSheet parser: turns e-invoice XML (UBL 2.x Invoice/CreditNote, UN/CEFACT CII,
 * legacy ZUGFeRD 1.0, Polish KSeF FA(1)-FA(3)) into plain objects. No dependencies; needs a DOMParser-compatible
 * document. Matching is by local name so namespace prefixes never matter. */
(function (root) {
  'use strict';

  const local = (n) => n.localName || n.nodeName.split(':').pop();

  function kids(el, name) {
    const out = [];
    if (!el) return out;
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1 && local(c) === name) out.push(c);
    }
    return out;
  }

  // All elements reached by a '/'-separated path of direct-child local names.
  function all(el, path) {
    let cur = el ? [el] : [];
    for (const step of path.split('/')) {
      const next = [];
      for (const e of cur) next.push(...kids(e, step));
      cur = next;
    }
    return cur;
  }

  // First match among one or more alternative paths.
  function at(el, paths) {
    for (const p of [].concat(paths)) {
      const hit = all(el, p)[0];
      if (hit) return hit;
    }
    return null;
  }

  const txt = (el, paths) => {
    const n = paths ? at(el, paths) : el;
    return n ? n.textContent.trim() : '';
  };

  const toNum = (s) => {
    if (s === '' || s == null) return null;
    const v = Number(s);
    return Number.isFinite(v) ? v : null;
  };
  const num = (el, paths) => toNum(txt(el, paths));
  const attr = (el, name) => (el && el.getAttribute(name)) || '';

  // CII dates: format 102 = YYYYMMDD; also tolerate ISO and 610 (YYYYMM).
  function ciiDate(el) {
    if (!el) return '';
    const s = el.textContent.trim();
    if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    if (/^\d{6}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
    return s.slice(0, 10);
  }

  const CREDIT_CODES = new Set(['381', '261', '262', '296', '308', '396', '420', '458', '532']);
  const docKind = (code, isUblCreditNote) =>
    isUblCreditNote || CREDIT_CODES.has(code) ? 'credit' : 'invoice';

  // Pick the amount element whose currencyID matches the document currency (CII and UBL both
  // allow a second tax total in the tax accounting currency).
  function inCurrency(els, currency) {
    return els.find((e) => attr(e, 'currencyID') === currency) || els.find((e) => !attr(e, 'currencyID')) || els[0] || null;
  }

  // Zero-VAT invoices often omit the tax amount, and some Minimum/Basic-WL generators omit
  // the net total; derive whichever one is missing.
  function fillMissingTotals(t) {
    const r2 = (v) => Math.round(v * 100) / 100;
    if (t.tax == null && t.taxExclusive != null && t.taxInclusive != null) t.tax = r2(t.taxInclusive - t.taxExclusive);
    if (t.taxExclusive == null && t.taxInclusive != null && t.tax != null) t.taxExclusive = r2(t.taxInclusive - t.tax);
  }

  function checkTotals(inv) {
    const t = inv.totals;
    const w = [];
    const close = (a, b) => Math.abs(a - b) < 0.015;
    if (t.taxExclusive != null && t.tax != null && t.taxInclusive != null && !close(t.taxExclusive + t.tax, t.taxInclusive)) {
      w.push('net+vat');
    }
    if (inv.lines.length && t.lineTotal != null) {
      const sum = inv.lines.reduce((s, l) => s + (l.net || 0), 0);
      if (!close(sum, t.lineTotal)) w.push('lines');
    }
    if (t.taxInclusive != null && t.payable != null && !close(t.taxInclusive - (t.prepaid || 0) + (t.rounding || 0), t.payable)) {
      w.push('payable');
    }
    return w;
  }

  /* ---------------- UBL 2.x ---------------- */

  function ublParty(p) {
    const schemes = all(p, 'PartyTaxScheme');
    const vat = schemes.find((s) => /^VAT$/i.test(txt(s, 'TaxScheme/ID'))) || schemes[0];
    const other = schemes.find((s) => s !== vat);
    const addr = at(p, 'PostalAddress');
    return {
      name: txt(p, 'PartyLegalEntity/RegistrationName') || txt(p, 'PartyName/Name'),
      tradingName: txt(p, 'PartyName/Name'),
      vatId: txt(vat, 'CompanyID'),
      taxId: txt(other, 'CompanyID'),
      companyId: txt(p, 'PartyLegalEntity/CompanyID') || txt(p, 'PartyIdentification/ID'),
      street: [txt(addr, 'StreetName'), txt(addr, 'AdditionalStreetName'), txt(addr, 'AddressLine/Line')].filter(Boolean).join(', '),
      city: txt(addr, 'CityName'),
      postcode: txt(addr, 'PostalZone'),
      country: txt(addr, 'Country/IdentificationCode'),
      email: txt(p, 'Contact/ElectronicMail'),
      phone: txt(p, 'Contact/Telephone'),
      endpoint: txt(p, 'EndpointID'),
    };
  }

  function ublFormat(custom) {
    if (/xrechnung/i.test(custom)) return 'XRechnung (UBL)';
    if (/mfin\.gov\.hr/i.test(custom)) return 'eRačun HR (UBL)';
    if (/peppol/i.test(custom)) return 'Peppol BIS (UBL)';
    if (/factur-x|zugferd/i.test(custom)) return 'Factur-X (UBL)';
    return 'UBL';
  }

  function parseUbl(doc) {
    const isCN = local(doc) === 'CreditNote';
    const currency = txt(doc, 'DocumentCurrencyCode');
    const typeCode = txt(doc, isCN ? 'CreditNoteTypeCode' : 'InvoiceTypeCode');
    const taxTotals = kids(doc, 'TaxTotal');
    const mainTax = taxTotals.find((t) => kids(t, 'TaxSubtotal').length && attr(at(t, 'TaxAmount'), 'currencyID') === currency)
      || inCurrency(taxTotals.map((t) => at(t, 'TaxAmount')), currency)?.parentNode || null;
    const sum = at(doc, 'LegalMonetaryTotal');
    const pm = at(doc, 'PaymentMeans');

    const lines = [...kids(doc, 'InvoiceLine'), ...kids(doc, 'CreditNoteLine')].map((l) => {
      const q = at(l, ['InvoicedQuantity', 'CreditedQuantity']);
      const cat = at(l, 'Item/ClassifiedTaxCategory');
      return {
        id: txt(l, 'ID'),
        name: txt(l, 'Item/Name'),
        description: txt(l, 'Item/Description'),
        sellerItemId: txt(l, 'Item/SellersItemIdentification/ID'),
        quantity: toNum(q ? q.textContent.trim() : ''),
        unit: attr(q, 'unitCode'),
        unitPrice: num(l, 'Price/PriceAmount'),
        priceBaseQty: num(l, 'Price/BaseQuantity'),
        net: num(l, 'LineExtensionAmount'),
        vatCategory: txt(cat, 'ID'),
        vatRate: num(cat, 'Percent'),
      };
    });

    const inv = {
      format: ublFormat(txt(doc, 'CustomizationID')),
      kind: docKind(typeCode, isCN),
      typeCode,
      number: txt(doc, 'ID'),
      issueDate: txt(doc, 'IssueDate'),
      dueDate: txt(doc, 'DueDate') || txt(pm, 'PaymentDueDate'),
      deliveryDate: txt(doc, ['Delivery/ActualDeliveryDate', 'InvoicePeriod/EndDate']),
      currency,
      buyerReference: txt(doc, 'BuyerReference'),
      orderReference: txt(doc, 'OrderReference/ID'),
      seller: ublParty(at(doc, 'AccountingSupplierParty/Party')),
      buyer: ublParty(at(doc, 'AccountingCustomerParty/Party')),
      totals: {
        lineTotal: num(sum, 'LineExtensionAmount'),
        allowances: num(sum, 'AllowanceTotalAmount'),
        charges: num(sum, 'ChargeTotalAmount'),
        taxExclusive: num(sum, 'TaxExclusiveAmount'),
        tax: mainTax ? num(mainTax, 'TaxAmount') : null,
        taxInclusive: num(sum, 'TaxInclusiveAmount'),
        prepaid: num(sum, 'PrepaidAmount'),
        rounding: num(sum, 'PayableRoundingAmount'),
        payable: num(sum, 'PayableAmount'),
      },
      vat: all(mainTax, 'TaxSubtotal').map((s) => ({
        category: txt(s, 'TaxCategory/ID'),
        rate: num(s, 'TaxCategory/Percent'),
        base: num(s, 'TaxableAmount'),
        tax: num(s, 'TaxAmount'),
        exemption: txt(s, 'TaxCategory/TaxExemptionReason'),
      })),
      payment: {
        iban: txt(pm, 'PayeeFinancialAccount/ID'),
        bic: txt(pm, 'PayeeFinancialAccount/FinancialInstitutionBranch/ID'),
        reference: txt(pm, 'PaymentID'),
        meansCode: txt(pm, 'PaymentMeansCode'),
        terms: txt(doc, 'PaymentTerms/Note'),
      },
      notes: kids(doc, 'Note').map((n) => n.textContent.trim()).filter(Boolean),
      lines,
    };
    fillMissingTotals(inv.totals);
    inv.warnings = checkTotals(inv);
    return inv;
  }

  /* ---------------- CII (ZUGFeRD 2.x / Factur-X / XRechnung CII) and ZUGFeRD 1.0 ---------------- */

  function ciiParty(p) {
    const regs = all(p, 'SpecifiedTaxRegistration/ID');
    const addr = at(p, 'PostalTradeAddress');
    return {
      name: txt(p, 'Name'),
      tradingName: txt(p, 'SpecifiedLegalOrganization/TradingBusinessName'),
      vatId: txt(regs.find((r) => attr(r, 'schemeID') === 'VA')),
      taxId: txt(regs.find((r) => attr(r, 'schemeID') === 'FC')),
      companyId: txt(p, 'SpecifiedLegalOrganization/ID') || txt(p, 'ID') || txt(p, 'GlobalID'),
      street: [txt(addr, 'LineOne'), txt(addr, 'LineTwo'), txt(addr, 'LineThree')].filter(Boolean).join(', '),
      city: txt(addr, 'CityName'),
      postcode: txt(addr, 'PostcodeCode'),
      country: txt(addr, 'CountryID'),
      email: txt(p, ['URIUniversalCommunication/URIID', 'DefinedTradeContact/EmailURIUniversalCommunication/URIID']),
      phone: txt(p, 'DefinedTradeContact/TelephoneUniversalCommunication/CompleteNumber'),
      endpoint: txt(p, 'URIUniversalCommunication/URIID'),
    };
  }

  function ciiFormat(guideline, v1) {
    if (v1) return 'ZUGFeRD 1.0';
    if (/xrechnung/i.test(guideline)) return 'XRechnung (CII)';
    if (/factur-x|zugferd|en16931|basic|minimum|extended/i.test(guideline)) return 'ZUGFeRD / Factur-X';
    return 'CII';
  }

  function parseCii(rootEl) {
    const v1 = local(rootEl) === 'CrossIndustryDocument';
    // ZUGFeRD 1.0 uses different element names for the same concepts.
    const P = v1
      ? { doc: 'HeaderExchangedDocument', ctx: 'SpecifiedExchangedDocumentContext', tx: 'SpecifiedSupplyChainTradeTransaction',
          agr: 'ApplicableSupplyChainTradeAgreement', del: 'ApplicableSupplyChainTradeDelivery', set: 'ApplicableSupplyChainTradeSettlement',
          sum: 'SpecifiedTradeSettlementMonetarySummation', lAgr: 'SpecifiedSupplyChainTradeAgreement', lDel: 'SpecifiedSupplyChainTradeDelivery',
          lSet: 'SpecifiedSupplyChainTradeSettlement', lSum: 'SpecifiedTradeSettlementMonetarySummation', rate: 'ApplicablePercent' }
      : { doc: 'ExchangedDocument', ctx: 'ExchangedDocumentContext', tx: 'SupplyChainTradeTransaction',
          agr: 'ApplicableHeaderTradeAgreement', del: 'ApplicableHeaderTradeDelivery', set: 'ApplicableHeaderTradeSettlement',
          sum: 'SpecifiedTradeSettlementHeaderMonetarySummation', lAgr: 'SpecifiedLineTradeAgreement', lDel: 'SpecifiedLineTradeDelivery',
          lSet: 'SpecifiedLineTradeSettlement', lSum: 'SpecifiedTradeSettlementLineMonetarySummation', rate: 'RateApplicablePercent' };

    const doc = at(rootEl, P.doc);
    const tx = at(rootEl, P.tx);
    const agr = at(tx, P.agr);
    const set = at(tx, P.set);
    const sum = at(set, P.sum);
    const currency = txt(set, 'InvoiceCurrencyCode');
    const typeCode = txt(doc, 'TypeCode');
    const amount = (name) => {
      const el = inCurrency(kids(sum, name), currency);
      return el ? toNum(el.textContent.trim()) : null;
    };
    const pm = at(set, 'SpecifiedTradeSettlementPaymentMeans');

    const lines = all(tx, 'IncludedSupplyChainTradeLineItem').map((l) => {
      const q = at(l, `${P.lDel}/BilledQuantity`);
      const tax = at(l, `${P.lSet}/ApplicableTradeTax`);
      return {
        id: txt(l, 'AssociatedDocumentLineDocument/LineID'),
        name: txt(l, 'SpecifiedTradeProduct/Name'),
        description: txt(l, 'SpecifiedTradeProduct/Description'),
        sellerItemId: txt(l, 'SpecifiedTradeProduct/SellerAssignedID'),
        quantity: toNum(q ? q.textContent.trim() : ''),
        unit: attr(q, 'unitCode'),
        unitPrice: num(l, `${P.lAgr}/NetPriceProductTradePrice/ChargeAmount`),
        priceBaseQty: num(l, `${P.lAgr}/NetPriceProductTradePrice/BasisQuantity`),
        net: num(l, `${P.lSet}/${P.lSum}/LineTotalAmount`),
        vatCategory: txt(tax, 'CategoryCode'),
        vatRate: num(tax, P.rate),
      };
    });

    const inv = {
      format: ciiFormat(txt(rootEl, `${P.ctx}/GuidelineSpecifiedDocumentContextParameter/ID`), v1),
      kind: docKind(typeCode, false),
      typeCode,
      number: txt(doc, 'ID'),
      issueDate: ciiDate(at(doc, 'IssueDateTime/DateTimeString')),
      dueDate: ciiDate(at(set, 'SpecifiedTradePaymentTerms/DueDateDateTime/DateTimeString')),
      deliveryDate: ciiDate(at(tx, `${P.del}/ActualDeliverySupplyChainEvent/OccurrenceDateTime/DateTimeString`)),
      currency,
      buyerReference: txt(agr, 'BuyerReference'),
      orderReference: txt(agr, 'BuyerOrderReferencedDocument/IssuerAssignedID'),
      seller: ciiParty(at(agr, 'SellerTradeParty')),
      buyer: ciiParty(at(agr, 'BuyerTradeParty')),
      totals: {
        lineTotal: amount('LineTotalAmount'),
        allowances: amount('AllowanceTotalAmount'),
        charges: amount('ChargeTotalAmount'),
        taxExclusive: amount('TaxBasisTotalAmount'),
        tax: amount('TaxTotalAmount'),
        taxInclusive: amount('GrandTotalAmount'),
        prepaid: amount('TotalPrepaidAmount'),
        rounding: amount('RoundingAmount'),
        payable: amount('DuePayableAmount'),
      },
      vat: kids(set, 'ApplicableTradeTax').map((t) => ({
        category: txt(t, 'CategoryCode'),
        rate: num(t, P.rate),
        base: num(t, 'BasisAmount'),
        tax: num(t, 'CalculatedAmount'),
        exemption: txt(t, 'ExemptionReason'),
      })),
      payment: {
        iban: txt(pm, ['PayeePartyCreditorFinancialAccount/IBANID', 'PayeePartyCreditorFinancialAccount/ProprietaryID']),
        bic: txt(pm, 'PayeeSpecifiedCreditorFinancialInstitution/BICID'),
        reference: txt(set, 'PaymentReference'),
        meansCode: txt(pm, 'TypeCode'),
        terms: txt(set, 'SpecifiedTradePaymentTerms/Description'),
      },
      notes: all(doc, 'IncludedNote/Content').map((n) => n.textContent.trim()).filter(Boolean),
      lines,
    };
    fillMissingTotals(inv.totals);
    inv.warnings = checkTotals(inv);
    return inv;
  }

  /* ---------------- Polish KSeF structured invoice (FA(1), FA(2), FA(3)) ---------------- */

  // Totals per VAT bucket: net in P_13_x, VAT in P_14_x (P_14_xW is only the PLN conversion).
  // Buckets 1-4 carry two possible rates (23/22, 8/7, 5, 4/3); the lines tell which one applies.
  const KSEF_BUCKETS = [
    ['1', ['23', '22']], ['2', ['8', '7']], ['3', ['5']], ['4', ['4', '3']], ['5', ['OSS']],
    ['6_1', ['0 KR']], ['6_2', ['0 WDT']], ['6_3', ['0 EX']], ['7', ['zw']], ['8', ['np I']],
    ['9', ['np II']], ['10', ['oo']], ['11', ['marża']],
  ];

  function ksefParty(p) {
    const id = at(p, 'DaneIdentyfikacyjne');
    const addr = at(p, 'Adres');
    const nip = txt(id, 'NIP');
    const euVat = txt(id, 'NrVatUE') ? txt(id, 'KodUE') + txt(id, 'NrVatUE') : '';
    const person = [txt(id, 'ImiePierwsze'), txt(id, 'Nazwisko')].filter(Boolean).join(' ');
    return {
      name: txt(id, ['Nazwa', 'PelnaNazwa']) || person,
      tradingName: txt(id, 'NazwaHandlowa'),
      vatId: nip || euVat,
      taxId: txt(id, 'NrID'),
      companyId: nip,
      // FA(2)/FA(3) addresses are two free lines; FA(1) used separate fields.
      street: txt(addr, ['AdresL1', 'AdresPol/Ulica']),
      city: txt(addr, ['AdresL2', 'AdresPol/Miejscowosc']),
      postcode: txt(addr, 'AdresPol/KodPocztowy'),
      country: txt(addr, 'KodKraju') || (at(addr, 'AdresPol') ? 'PL' : ''),
      email: txt(p, 'DaneKontaktowe/Email'),
      phone: txt(p, 'DaneKontaktowe/Telefon'),
      endpoint: '',
    };
  }

  function parseKsef(rootEl) {
    const fa = at(rootEl, 'Fa');
    const variant = attr(at(rootEl, 'Naglowek/KodFormularza'), 'kodSystemowy').replace(/\s+/g, '') || 'FA';
    // VAT RR invoices (purchases from flat-rate farmers) use a different structure.
    if (/^FA_RR/.test(variant)) throw new Error('FA_RR (faktura VAT RR): format not supported yet');
    const kindCode = txt(fa, 'RodzajFaktury');
    // FA(2)/FA(3) list lines directly under Fa; FA(1) wrapped them in FaWiersze.
    const lineEls = [...kids(fa, 'FaWiersz'), ...all(fa, 'FaWiersze/FaWiersz')];
    const lineRates = new Set(lineEls.map((l) => txt(l, 'P_12')));

    const vat = [];
    let net = 0;
    let tax = 0;
    let any = false;
    for (const [k, rates] of KSEF_BUCKETS) {
      const base = num(fa, `P_13_${k}`);
      const amount = num(fa, `P_14_${k}`);
      if (base == null && amount == null) continue;
      any = true;
      const label = rates.find((r) => lineRates.has(r)) || rates[0];
      const rate = /^\d+$/.test(label) ? Number(label) : /^0 /.test(label) ? 0 : null;
      vat.push({ category: label, rate, base, tax: amount == null ? (rate === 0 || rate == null ? 0 : null) : amount, exemption: k === '7' ? txt(fa, ['Adnotacje/Zwolnienie/P_19A', 'Adnotacje/Zwolnienie/P_19B', 'Adnotacje/Zwolnienie/P_19C']) : '' });
      net += base || 0;
      tax += amount || 0;
    }
    const r2 = (v) => Math.round(v * 100) / 100;
    const gross = num(fa, 'P_15');
    // Paid in full (Zaplacono = 1) or partly: report what is still due.
    const pay = at(fa, 'Platnosc');
    const paid = txt(pay, 'Zaplacono') === '1'
      ? gross
      : all(pay, 'ZaplataCzesciowa').reduce((s, z) => s + (num(z, 'KwotaZaplatyCzesciowej') || 0), 0) || null;

    const lines = lineEls.map((l) => {
      const rateText = txt(l, 'P_12');
      return {
        id: txt(l, 'NrWierszaFa'),
        name: txt(l, 'P_7'),
        description: txt(l, 'StanPrzed') === '1' ? 'stan przed korektą' : '',
        sellerItemId: txt(l, ['Indeks', 'GTIN']),
        quantity: num(l, 'P_8B'),
        unit: txt(l, 'P_8A'),
        unitPrice: num(l, ['P_9A', 'P_9B']),
        priceBaseQty: null,
        net: num(l, 'P_11'),
        vatCategory: rateText,
        vatRate: /^\d+$/.test(rateText) ? Number(rateText) : /^0 /.test(rateText) ? 0 : null,
      };
    });

    const inv = {
      format: `KSeF ${variant}`,
      kind: /^KOR/.test(kindCode) ? 'correction' : 'invoice',
      typeCode: kindCode,
      number: txt(fa, 'P_2'),
      issueDate: txt(fa, 'P_1'),
      dueDate: txt(pay, ['TerminPlatnosci/Termin', 'TerminyPlatnosci/TerminPlatnosci']),
      deliveryDate: txt(fa, ['P_6', 'OkresFa/P_6_Do']),
      currency: txt(fa, 'KodWaluty'),
      buyerReference: txt(rootEl, 'Podmiot2/NrKlienta'),
      orderReference: txt(fa, 'WarunkiTransakcji/Zamowienia/NrZamowienia'),
      seller: ksefParty(at(rootEl, 'Podmiot1')),
      buyer: ksefParty(at(rootEl, 'Podmiot2')),
      totals: {
        lineTotal: null,
        allowances: null,
        charges: null,
        taxExclusive: any ? r2(net) : null,
        tax: any ? r2(tax) : null,
        taxInclusive: gross,
        prepaid: paid == null ? null : r2(paid),
        rounding: null,
        payable: gross == null ? null : r2(gross - (paid || 0)),
      },
      vat,
      payment: {
        iban: txt(pay, 'RachunekBankowy/NrRB'),
        bic: txt(pay, 'RachunekBankowy/SWIFT'),
        reference: txt(pay, 'IPKSeF'),
        meansCode: txt(pay, 'FormaPlatnosci'),
        terms: ['Ilosc', 'Jednostka', 'ZdarzeniePoczatkowe'].map((k) => txt(pay, `TerminPlatnosci/TerminOpis/${k}`)).filter(Boolean).join(' ').replace(/\s+/g, ' '),
      },
      notes: [
        ...kids(fa, 'DodatkowyOpis').map((d) => [txt(d, 'Klucz'), txt(d, 'Wartosc')].filter(Boolean).join(': ')),
        txt(rootEl, 'Stopka/Informacje/StopkaFaktury'),
        txt(fa, 'DaneFaKorygowanej/NrFaKorygowanej') ? `Korekta faktury ${txt(fa, 'DaneFaKorygowanej/NrFaKorygowanej')}` : '',
      ].filter(Boolean),
      lines,
    };
    inv.warnings = checkTotals(inv);
    return inv;
  }

  /* ---------------- entry point ---------------- */

  class NotAnInvoiceError extends Error {}

  function parseDocument(xmlDoc) {
    const rootEl = xmlDoc && xmlDoc.documentElement;
    if (!rootEl || xmlDoc.getElementsByTagName('parsererror').length) {
      throw new NotAnInvoiceError('xml');
    }
    switch (local(rootEl)) {
      case 'Invoice':
      case 'CreditNote':
        return parseUbl(rootEl);
      case 'CrossIndustryInvoice':
      case 'CrossIndustryDocument':
        return parseCii(rootEl);
      case 'Faktura':
        return parseKsef(rootEl);
      // Some senders wrap UBL in an envelope (e.g. Peppol SBD, HR eRačun envelopes).
      default: {
        for (const tag of ['Invoice', 'CreditNote', 'CrossIndustryInvoice']) {
          const inner = [...xmlDoc.getElementsByTagNameNS('*', tag)][0];
          if (inner && inner !== rootEl) return tag === 'CrossIndustryInvoice' ? parseCii(inner) : parseUbl(inner);
        }
        throw new NotAnInvoiceError('root:' + local(rootEl));
      }
    }
  }

  function parseXml(text, DOMParserImpl) {
    const P = DOMParserImpl || root.DOMParser;
    const clean = text.replace(/^﻿/, '');
    return parseDocument(new P().parseFromString(clean, 'application/xml'));
  }

  root.InvoiceParser = { parseXml, parseDocument, NotAnInvoiceError };
})(typeof globalThis !== 'undefined' ? globalThis : this);
