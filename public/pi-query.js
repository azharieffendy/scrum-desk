/* Shared JQL editor helpers. Conversion changes literal tokens only; builder parsing is conservative. */
(function(root) {
  'use strict';

  const MAX_LENGTH = 4000;
  const MAX_RULES = 20;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;

  const quote = v => "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  const upper = t => (t && !t.quoted ? t.raw.toUpperCase() : '');
  const lower = t => (t && !t.quoted ? t.raw.toLowerCase() : '');

  /** 'YYYY-MM-DD' moved by n days (UTC). */
  function shiftDay(d, n) {
    const t = new Date(d + 'T00:00:00Z');
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  }

  function readQuoted(text, i) {
    const q = text[i];
    let value = '';
    for (i++; i < text.length; ) {
      if (text[i] === '\\') {
        if (i + 1 >= text.length) break;
        value += text[i + 1];
        i += 2;
      } else if (text[i] === q) {
        return { value, end: i + 1 };
      } else {
        value += text[i++];
      }
    }
    throw Error('Close the quoted value.');
  }

  /** JQL → tokens { raw, value, start, end, depth, quoted }; throws on unbalanced quotes or brackets. */
  function tokens(text) {
    const out = [];
    let depth = 0;
    let square = 0;
    for (let i = 0; i < text.length; ) {
      const c = text[i];
      const start = i;
      if (/\s/.test(c)) { i++; continue; }
      if (c === '"' || c === "'") {
        const q = readQuoted(text, i);
        i = q.end;
        out.push({ raw: text.slice(start, i), value: q.value, start, end: i, depth, quoted: true });
        continue;
      }
      if (c === '(') { out.push({ raw: c, start, end: ++i, depth }); depth++; continue; }
      if (c === ')') {
        if (--depth < 0) throw Error('There is an extra closing bracket.');
        out.push({ raw: c, start, end: ++i, depth });
        continue;
      }
      if (/[=<>!]/.test(c)) {
        i++;
        if (text[i] === '=') i++;
        out.push({ raw: text.slice(start, i), start, end: i, depth });
        continue;
      }
      if (c === ',') { out.push({ raw: c, start, end: ++i, depth }); continue; }
      while (i < text.length && !/[\s()=<>!,"']/.test(text[i])) i++;
      if (i === start) throw Error('Unexpected character.');
      const raw = text.slice(start, i);
      for (const ch of raw) {
        if (ch === '[') square++;
        if (ch === ']' && --square < 0) throw Error('There is an extra closing square bracket.');
      }
      out.push({ raw, value: raw, start, end: i, depth });
    }
    if (depth) throw Error('Close the opening bracket.');
    if (square) throw Error('Close the opening square bracket.');
    return out;
  }

  /** Removes brackets that wrap the whole text. */
  function strip(text) {
    let s = text.trim();
    for (;;) {
      const ts = tokens(s);
      const wrapped = ts[0] && ts[0].raw === '(' && ts.at(-1).raw === ')' && !ts.slice(1, -1).some(t => t.depth === 0);
      if (!wrapped) return s;
      s = s.slice(1, -1).trim();
    }
  }

  /** Splits on a top-level keyword (AND / OR). */
  function split(text, word) {
    const parts = [];
    let at = 0;
    for (const t of tokens(text)) {
      if (t.depth === 0 && upper(t) === word) {
        parts.push(text.slice(at, t.start).trim());
        at = t.end;
      }
    }
    parts.push(text.slice(at).trim());
    return parts;
  }

  /** { body, suffix } where suffix is a top-level ORDER BY clause ('' when none). */
  function order(text) {
    const ts = tokens(text);
    for (let i = 0; i < ts.length - 1; i++) {
      if (ts[i].depth === 0 && upper(ts[i]) === 'ORDER' && upper(ts[i + 1]) === 'BY') {
        return { body: text.slice(0, ts[i].start).trim(), suffix: text.slice(ts[i].start).trim() };
      }
    }
    return { body: text.trim(), suffix: '' };
  }

  /**
   * Fixed assignee values: "assignee = X" and each X in "assignee IN (X, Y)".
   * Functions such as currentUser() or membersOf(...) are not fixed accounts.
   */
  function fixedAssignees(ts) {
    const found = [];
    const literal = (t, next) => t && t.value !== undefined && !(next && next.raw === '(') && !String(t.value).includes('{');
    for (let i = 0; i < ts.length - 2; i++) {
      if (lower(ts[i]) !== 'assignee') continue;
      if (ts[i + 1].raw === '=') {
        if (literal(ts[i + 2], ts[i + 3])) found.push(ts[i + 2].value);
      } else if (upper(ts[i + 1]) === 'IN' && ts[i + 2].raw === '(') {
        // only the list's own items: skip function arguments such as membersOf("team")
        const inside = ts[i + 2].depth + 1;
        for (let j = i + 3; j < ts.length && ts[j].depth >= inside; j++) {
          if (ts[j].depth === inside && ts[j].raw !== ',' && literal(ts[j], ts[j + 1])) found.push(ts[j].value);
        }
      }
    }
    return [...new Set(found)];
  }

  const isDate = t => DATE.test((t && t.value) || '');

  /** { errors, warnings } for a query; template = true also requires the placeholders. */
  function validate(text, template = true) {
    const errors = [];
    const warnings = [];
    if (!text.trim()) errors.push('Enter a query.');
    if (text.length > MAX_LENGTH) errors.push('Keep the query under 4,000 characters.');
    let ts = [];
    try { ts = tokens(text); } catch (e) { errors.push(e.message); }
    if (template) {
      for (const ph of ['{assignee}', '{start}']) if (!text.includes(ph)) errors.push('Add ' + ph + '.');
      if (!text.includes('{end}') && !text.includes('{afterEnd}')) errors.push('Add {end} or {afterEnd}.');
    }
    for (const t of ts) {
      if (isDate(t)) warnings.push('Fixed date ' + t.value + ' — use {start} or {end} if it should follow the period.');
    }
    for (const a of fixedAssignees(ts)) warnings.push('Fixed assignee ' + a + ' — use {assignee} for each report member.');
    return { errors, warnings: [...new Set(warnings)] };
  }

  /** Assignee accounts and dates found in a pasted query (to prefill the converter). */
  function candidates(text) {
    const ts = tokens(text);
    return { accounts: fixedAssignees(ts), dates: [...new Set(ts.filter(isDate).map(t => t.value))].sort() };
  }

  /**
   * The last boundary as typed may be inclusive ("<= 08-31") or exclusive ("< 09-01"); a query can mix both.
   * Returns which literal dates become {end} and {afterEnd}.
   */
  function endDates(ts, boundary) {
    const exclusive = ts.some((t, i) => t.value === boundary && ts[i - 1] && ts[i - 1].raw === '<');
    const last = exclusive ? shiftDay(boundary, -1) : boundary;
    return { last, after: shiftDay(last, 1) };
  }

  function placeholderFor(ts, i, account, start, ends) {
    const t = ts[i];
    const op = ts[i - 1] ? ts[i - 1].raw : '';
    if (t.value === account && op === '=' && lower(ts[i - 2]) === 'assignee') return '{assignee}';
    if (t.value === start) return '{start}';
    if (t.value === ends.after && op === '<') return '{afterEnd}';
    if (t.value === ends.last && op !== '<') return '{end}';
    return '';
  }

  /** Pasted JIRA query + its original assignee and dates → { template, replaced, warnings, note }. */
  function convert(text, account, start, end) {
    if (!account || !DATE.test(start) || !DATE.test(end) || start > end) {
      throw Error('Choose the original assignee and a valid first and last date.');
    }
    if (start === end) throw Error('A single-day query needs manual date placeholders; its first and last date are identical.');
    const ts = tokens(text);
    const ends = endDates(ts, end);
    const replacements = [];
    const replaced = { accounts: 0, first: 0, last: 0 };
    ts.forEach((t, i) => {
      const ph = placeholderFor(ts, i, account, start, ends);
      if (!ph) return;
      replacements.push({ ...t, ph });
      if (ph === '{assignee}') replaced.accounts++;
      else if (ph === '{start}') replaced.first++;
      else replaced.last++;
    });
    if (!replaced.accounts || !replaced.first || !replaced.last) {
      throw Error('The selected assignee and both dates must appear in the pasted query.');
    }
    let result = text;
    for (const t of replacements.reverse()) result = result.slice(0, t.start) + quote(t.ph) + result.slice(t.end);
    const o = order(result);
    const parts = split(strip(o.body), 'OR');
    result = parts.map(p => (parts.length > 1 ? '(' + strip(p) + ')' : p)).join('\nOR\n') + (o.suffix ? '\n' + o.suffix : '');
    const checked = validate(result);
    if (checked.errors.length) throw Error(checked.errors.join(' '));
    return {
      template: result,
      replaced,
      warnings: checked.warnings,
      note: 'OR groups preserve the original logic. The report includes the whole final day when it fills <= {end}.',
    };
  }

  function ruleJql(r) {
    if (!r.field || (!r.category && !r.status)) throw Error('Choose a date field and status for every rule.');
    const projects = r.projects.length ? 'project IN (' + [...new Set(r.projects)].map(quote).join(', ') + ') AND ' : '';
    const status = r.category ? 'statusCategory = Done' : 'status = ' + quote(r.status);
    return '(' + projects + "assignee = '{assignee}' AND " + status +
      ' AND ' + r.field + " >= '{start}' AND " + r.field + " <= '{end}')";
  }

  /** Builder rules → template (rules joined with OR). */
  function build(rules) {
    if (!rules.length || rules.length > MAX_RULES) throw Error('Use between 1 and 20 rules.');
    return rules.map(ruleJql).join('\nOR\n') + '\nORDER BY created DESC';
  }

  /** Every top-level AND clause of a branch, flattening bracketed AND groups. */
  function ands(s) {
    return split(strip(s), 'AND').flatMap(p => (split(strip(p), 'AND').length > 1 ? ands(p) : [strip(p)]));
  }

  /** "project IN ('A', 'B')" → ['A', 'B']; null when the clause is something else or malformed. */
  function projectList(ts) {
    if (lower(ts[0]) !== 'project' || upper(ts[1]) !== 'IN' || !ts[2] || ts[2].raw !== '(' || ts.at(-1).raw !== ')') return null;
    const vals = ts.slice(3, -1);
    const wellFormed = vals.length % 2 === 1 && vals.every((t, i) => (i % 2 ? t.raw === ',' : Boolean(t.value)));
    return wellFormed ? vals.filter((t, i) => i % 2 === 0).map(t => t.value) : undefined;
  }

  /** One OR branch → rule; null when the builder cannot represent it. */
  function parseBranch(branch) {
    const r = { projects: [], status: 'Done', category: false, field: '' };
    const seen = { assignee: false, status: false, lower: false, upper: false, project: false };
    for (const clause of ands(branch)) {
      const ts = tokens(clause);
      const projects = projectList(ts);
      if (projects === undefined) return null;
      if (projects) {
        if (seen.project) return null;
        r.projects = projects;
        seen.project = true;
        continue;
      }
      if (ts.length !== 3) return null;
      const [f, op, v] = ts;
      const name = lower(f);
      if (name === 'assignee' && op.raw === '=' && v.value === '{assignee}' && !seen.assignee) {
        seen.assignee = true;
        continue;
      }
      if ((name === 'status' || name === 'statuscategory') && op.raw === '=' && !seen.status) {
        r.category = name === 'statuscategory';
        if (r.category && String(v.value).toLowerCase() !== 'done') return null;
        r.status = v.value;
        seen.status = true;
        continue;
      }
      if (r.field && r.field !== f.raw) return null;
      if (op.raw === '>=' && v.value === '{start}' && !seen.lower) {
        r.field = f.raw;
        seen.lower = true;
        continue;
      }
      const isUpper = (op.raw === '<=' && v.value === '{end}') || (op.raw === '<' && v.value === '{afterEnd}');
      if (isUpper && !seen.upper) {
        r.field = f.raw;
        seen.upper = true;
        continue;
      }
      return null;
    }
    return seen.assignee && seen.status && seen.lower && seen.upper ? r : null;
  }

  /** Template → builder rules; null when any part cannot be represented (nothing is dropped). */
  function parse(text) {
    try {
      const o = order(text);
      if (o.suffix && !/^ORDER\s+BY\s+created\s+DESC$/i.test(o.suffix)) return null;
      const rules = split(strip(o.body), 'OR').map(parseBranch);
      return rules.every(Boolean) ? rules : null;
    } catch {
      return null;
    }
  }

  const api = { tokens, validate, candidates, convert, build, parse, quote };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PiQuery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
