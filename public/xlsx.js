/* ================================================================
   Minimal .xlsx writer — no dependencies, no build step.
   Builds an Office Open XML workbook (inline strings, a fixed set of
   cell styles) inside an uncompressed ZIP. Enough for reports; not a
   general spreadsheet library.

   XlsxLite.build([{ name, rows, cols, freeze }]) → Uint8Array
     rows:   array of rows; each cell is a string, a number, null,
             or { v: value, s: styleName, link: 'https://…' }
             (link: optional external hyperlink, http(s) only;
              styles 'date' / 'day' expect an Excel serial number)
     cols:   optional column widths (characters)
     freeze: optional { row, col } — rows above / cols left stay put
   ================================================================ */
'use strict';

(function (root) {
  const STYLE = {
    default: 0, title: 1, header: 2, text: 3, num: 4,
    present: 5, late: 6, leave: 7, sick: 8, noshow: 9,
    weekend: 10, pct: 11, boldText: 12, note: 13, boldNum: 14, boldPct: 15, link: 16,
    date: 17, day: 18,
  };
  const HYPERLINK_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';

  const STYLES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="d/m/yyyy h:mm"/></numFmts>' +
    '<fonts count="5">' +
      '<font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="14"/><name val="Calibri"/></font>' +
      '<font><i/><sz val="10"/><color rgb="FF666C76"/><name val="Calibri"/></font>' +
      '<font><b/><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font>' +
    '</fonts>' +
    '<fills count="9">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      fill('FFEDEFFD') + fill('FFEAF5EE') + fill('FFFBF3E2') + fill('FFE9F2FB') +
      fill('FFF1EDFB') + fill('FFFBEDEB') + fill('FFF1F1F1') +
    '</fills>' +
    '<borders count="2">' +
      '<border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border>' + ['left', 'right', 'top', 'bottom'].map((s) =>
        '<' + s + ' style="thin"><color rgb="FFD9D9D9"/></' + s + '>').join('') + '<diagonal/></border>' +
    '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="19">' +
      xf(0, 0, 0, 0) +                              // 0 default
      xf(0, 2, 0, 0) +                              // 1 title
      xf(0, 1, 2, 1, 'center', 'center', true) +    // 2 header
      xf(0, 0, 0, 1, null, 'top', true) +           // 3 text (wrapped)
      xf(0, 0, 0, 1, 'center', 'top') +             // 4 number
      xf(0, 0, 3, 1, 'center', 'center') +          // 5 present
      xf(0, 0, 4, 1, 'center', 'center') +          // 6 late
      xf(0, 0, 5, 1, 'center', 'center') +          // 7 leave
      xf(0, 0, 6, 1, 'center', 'center') +          // 8 sick
      xf(0, 0, 7, 1, 'center', 'center') +          // 9 no show
      xf(0, 0, 8, 1, 'center', 'center') +          // 10 weekend / no record
      xf(9, 0, 0, 1, 'center', 'top') +             // 11 percent
      xf(0, 1, 0, 1, null, 'top') +                 // 12 bold text
      xf(0, 3, 0, 0) +                              // 13 note
      xf(0, 1, 0, 1, 'center', 'top') +             // 14 bold number
      xf(9, 1, 0, 1, 'center', 'top') +             // 15 bold percent
      xf(0, 4, 0, 1, null, 'top') +                 // 16 hyperlink
      xf(164, 0, 0, 1, null, 'top') +               // 17 date + time (value = Excel serial)
      xf(14, 0, 0, 1, null, 'top') +                // 18 date only (value = Excel serial)
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  function fill(rgb) {
    return '<fill><patternFill patternType="solid"><fgColor rgb="' + rgb + '"/><bgColor indexed="64"/></patternFill></fill>';
  }

  function xf(numFmt, font, fillId, border, h, v, wrap) {
    const attrs = ' numFmtId="' + numFmt + '" fontId="' + font + '" fillId="' + fillId + '" borderId="' + border + '" xfId="0"' +
      (numFmt ? ' applyNumberFormat="1"' : '') + (font ? ' applyFont="1"' : '') +
      (fillId ? ' applyFill="1"' : '') + (border ? ' applyBorder="1"' : '');
    if (!h && !v && !wrap) return '<xf' + attrs + '/>';
    return '<xf' + attrs + ' applyAlignment="1"><alignment' +
      (h ? ' horizontal="' + h + '"' : '') + (v ? ' vertical="' + v + '"' : '') +
      (wrap ? ' wrapText="1"' : '') + '/></xf>';
  }

  // XML-escape and drop characters XML 1.0 does not allow
  function xmlText(s) {
    return String(s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function colName(i) {
    let n = i + 1;
    let s = '';
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  function cellXml(cell, ref) {
    const c = cell !== null && typeof cell === 'object' ? cell : { v: cell };
    const s = STYLE[c.s] || 0;
    const sAttr = s ? ' s="' + s + '"' : '';
    if (c.v === null || c.v === undefined || c.v === '') {
      return s ? '<c r="' + ref + '"' + sAttr + '/>' : '';
    }
    if (typeof c.v === 'number' && isFinite(c.v)) {
      return '<c r="' + ref + '"' + sAttr + '><v>' + c.v + '</v></c>';
    }
    return '<c r="' + ref + '"' + sAttr + ' t="inlineStr"><is><t xml:space="preserve">' +
      xmlText(c.v) + '</t></is></c>';
  }

  /** The cell's link when it is an absolute http(s) URL, else null. */
  function cellLink(cell) {
    const link = cell !== null && typeof cell === 'object' ? cell.link : null;
    return typeof link === 'string' && /^https?:\/\/[^\s"<>]+$/i.test(link) ? link : null;
  }

  /** [{ ref, url }] for every linked cell of the sheet, in row order. */
  function sheetLinks(sheet) {
    const out = [];
    (sheet.rows || []).forEach((row, r) => (row || []).forEach((cell, c) => {
      const url = cellLink(cell);
      if (url) out.push({ ref: colName(c) + (r + 1), url });
    }));
    return out;
  }

  function sheetRelsXml(links) {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      links.map((l, i) => '<Relationship Id="rId' + (i + 1) + '" Type="' + HYPERLINK_REL +
        '" Target="' + xmlText(l.url) + '" TargetMode="External"/>').join('') +
      '</Relationships>';
  }

  function sheetXml(sheet, links) {
    const rows = sheet.rows || [];
    const cols = sheet.cols || [];
    let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
    const fr = sheet.freeze;
    if (fr && (fr.row || fr.col)) {
      const top = colName(fr.col || 0) + ((fr.row || 0) + 1);
      xml += '<sheetViews><sheetView workbookViewId="0"><pane' +
        (fr.col ? ' xSplit="' + fr.col + '"' : '') + (fr.row ? ' ySplit="' + fr.row + '"' : '') +
        ' topLeftCell="' + top + '" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>';
    }
    if (cols.length) {
      xml += '<cols>' + cols.map((w, i) =>
        '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>';
    }
    xml += '<sheetData>';
    rows.forEach((row, r) => {
      const cells = (row || []).map((cell, c) => cellXml(cell, colName(c) + (r + 1))).join('');
      xml += '<row r="' + (r + 1) + '">' + cells + '</row>';
    });
    xml += '</sheetData>';
    if (links.length) {
      xml += '<hyperlinks>' + links.map((l, i) => '<hyperlink ref="' + l.ref + '" r:id="rId' + (i + 1) + '"/>').join('') +
        '</hyperlinks>';
    }
    return xml + '</worksheet>';
  }

  function safeSheetName(name, used) {
    let base = String(name || 'Sheet').replace(/[\[\]:*?\/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
    let n = base;
    for (let i = 2; used.has(n.toLowerCase()); i++) n = base.slice(0, 28) + ' ' + i;
    used.add(n.toLowerCase());
    return n;
  }

  function workbookParts(sheets) {
    const used = new Set();
    const names = sheets.map((s) => safeSheetName(s.name, used));
    const files = [];
    files.push(['[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      names.map((_, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) +
        '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') +
      '</Types>']);
    files.push(['_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>']);
    files.push(['xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      names.map((n, i) => '<sheet name="' + xmlText(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') +
      '</sheets></workbook>']);
    files.push(['xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      names.map((_, i) => '<Relationship Id="rId' + (i + 1) +
        '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' +
        (i + 1) + '.xml"/>').join('') +
      '<Relationship Id="rId' + (names.length + 1) +
        '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>']);
    files.push(['xl/styles.xml', STYLES_XML]);
    sheets.forEach((s, i) => {
      const links = sheetLinks(s);
      files.push(['xl/worksheets/sheet' + (i + 1) + '.xml', sheetXml(s, links)]);
      if (links.length) files.push(['xl/worksheets/_rels/sheet' + (i + 1) + '.xml.rels', sheetRelsXml(links)]);
    });
    return files;
  }

  /* ---------- ZIP (store only, no compression) ---------- */

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function zip(files) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const [name, content] of files) {
      const nameBytes = enc.encode(name);
      const data = enc.encode(content);
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);          // UTF-8 names
      local.setUint16(8, 0, true);               // stored
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      locals.push(new Uint8Array(local.buffer), nameBytes, data);

      const central = new DataView(new ArrayBuffer(46));
      central.setUint32(0, 0x02014b50, true);
      central.setUint16(4, 20, true);
      central.setUint16(6, 20, true);
      central.setUint16(8, 0x0800, true);
      central.setUint16(10, 0, true);
      central.setUint16(12, dosTime, true);
      central.setUint16(14, dosDate, true);
      central.setUint32(16, crc, true);
      central.setUint32(20, data.length, true);
      central.setUint32(24, data.length, true);
      central.setUint16(28, nameBytes.length, true);
      central.setUint32(42, offset, true);
      centrals.push(new Uint8Array(central.buffer), nameBytes);

      offset += 30 + nameBytes.length + data.length;
    }

    const centralSize = centrals.reduce((n, b) => n + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
    const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
    let p = 0;
    for (const b of parts) { out.set(b, p); p += b.length; }
    return out;
  }

  function build(sheets) {
    if (!Array.isArray(sheets) || !sheets.length) throw new Error('At least one sheet is required.');
    return zip(workbookParts(sheets));
  }

  const api = { build, STYLE, MIME: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XlsxLite = api;
})(typeof window !== 'undefined' ? window : globalThis);
