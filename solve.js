// A fast drop-in for makefun-site 1.0.0: run(input) returns the same output tree,
// byte for byte, built with a single-pass pipeline instead of the reference's
// plugin chain. No dependencies, no I/O, no clock, no randomness: the answer is
// a pure function of the input, so two runs are byte-identical.
//
// The semantics follow makefun-site's README and its code (the code wins where
// they differ): strict front matter, its own Markdown subset, its template
// dialect, the slug rule, and build-report.txt.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------------------------------------------ text */

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_ALL = /[&<>"']/g;

/** `s` with & < > " ' escaped; unchanged when it holds none of them. */
function esc(s) {
  if (!ESC_TEST.test(s)) return s;
  let out = '';
  let last = 0;
  let m;
  ESC_ALL.lastIndex = 0;
  while ((m = ESC_ALL.exec(s)) !== null) {
    out += s.slice(last, m.index) + ESC_MAP[m[0]];
    last = m.index + 1;
  }
  return out + s.slice(last);
}

const SLUG_MAX = 64;
const MARK_RE = /\p{M}/gu;

/** The slug cache, rebuilt for every run() so nothing leaks between cases. */
let slugCache = new Map();

function slugifySlow(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  // ASCII normalises to itself under NFKD, so the slow path is skipped.
  if (!ascii) plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX);
  let e = out.length;
  while (e > 0 && out[e - 1] === '-') e--;
  out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

/** The slug of `text`, memoised within one case. */
function slugify(text) {
  let s = slugCache.get(text);
  if (s === undefined) {
    s = slugifySlow(text);
    slugCache.set(text, s);
  }
  return s;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out;
  do {
    out = `${slug}-${n}`;
    n++;
  } while (taken.has(out));
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether a line holds only spaces and tabs (or is empty). */
function isBlank(l) {
  for (let i = 0; i < l.length; i++) {
    const c = l.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line with its leading and trailing spaces and tabs dropped. */
function trimLine(l) {
  let a = 0;
  let b = l.length;
  while (a < b && (l.charCodeAt(a) === 32 || l.charCodeAt(a) === 9)) a++;
  while (b > a && (l.charCodeAt(b - 1) === 32 || l.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === l.length ? l : l.slice(a, b);
}

/* ------------------------------------------------------------ front matter */

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function validDate(raw) {
  if (raw.length !== 10 || raw[4] !== '-' || raw[7] !== '-') return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = Number(raw.slice(0, 4));
  const m = Number(raw.slice(5, 7));
  const d = Number(raw.slice(8, 10));
  if (y < 1970 || y > 2099 || m < 1 || m > 12 || d < 1) return false;
  return d <= daysIn(y, m);
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else {
        out += c;
      }
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function hasTagChar(t) {
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '"' || c === '[' || c === ']') return true;
  }
  return false;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return validDate(raw)
        ? { value: raw }
        : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let i = 0; i < tags.length; i++) {
        if (tags[i] === '' || hasTagChar(tags[i])) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true'
        ? { value: true }
        : raw === 'false'
          ? { value: false }
          : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) {
          return { error: 'key "layout": not a template name' };
        }
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '-') {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
          prevDash = false;
        } else {
          return { error: 'key "slug": not a slug' };
        }
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, bodyStart } (the first body line's
 * index in `lines`), or { error } with the first reason it is refused.
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    // `key: value`: a key of a-z and _, a colon, one space and the value.
    let j = 0;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if (!((c >= 97 && c <= 122) || c === 95)) break;
      j++;
    }
    let raw;
    if (j === 0 || line.charCodeAt(j) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    if (j + 1 === line.length) raw = '';
    else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    // Trailing spaces and tabs dropped.
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    if (e !== raw.length) raw = raw.slice(0, e);
    const key = line.slice(0, j);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

/* --------------------------------------------------------------- markdown */

const ESCAPABLE = '\\`*_[]()#+-.!>';
const WS_RE = /\s/;

function isLangChar(c) {
  return (
    (c >= 'A' && c <= 'Z') ||
    (c >= 'a' && c <= 'z') ||
    (c >= '0' && c <= '9') ||
    c === '_' ||
    c === '+' ||
    c === '-'
  );
}

/** The rest of `line` after its opening ``` is spaces/tabs only. */
function restIsSpaceTab(line, from) {
  for (let i = from; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence's language, or null when the line does not open one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line[j])) j++;
  if (!restIsSpaceTab(line, j)) return null;
  return line.slice(3, j);
}

/** Whether the line closes a fence. */
function fenceClose(line) {
  return line.charCodeAt(0) === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && restIsSpaceTab(line, 3);
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n + 1;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

/** Whether the line is a thematic break. */
function isHr(line) {
  const p = line.slice(0, 3);
  return (p === '---' || p === '***') && restIsSpaceTab(line, 3);
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/** A bullet item's text, or null when the line does not open one. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's start number and text, or null. */
function orderedOf(line) {
  let n = 0;
  let v = 0;
  while (n < line.length) {
    const c = line.charCodeAt(n);
    if (c < 48 || c > 57) break;
    v = v * 10 + (c - 48);
    n++;
    if (n === 9) break;
  }
  if (n === 0) return null;
  if (n < line.length) {
    const c = line.charCodeAt(n);
    if (c >= 48 && c <= 57) return null;
  }
  if (line.charCodeAt(n) !== 46 || line.charCodeAt(n + 1) !== 32) return null;
  return { start: v, text: line.slice(n + 2) };
}

/** Whether the line continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (line.charCodeAt(i) === 32) i++;
  return i < line.length && !WS_RE.test(line[i]);
}

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from) {
  const n = s.length;
  const w = what.length;
  for (let j = from; j <= n - w; j++) {
    if (s[j] === '\\' && j + 1 < n && ESCAPABLE.indexOf(s[j + 1]) !== -1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.indexOf(s[j + 1]) !== -1) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s` rendered inline into `out`; `link(target)` is a link's href. */
const SPECIAL_RE = /[\\`*\[]/g;

function inlineInto(s, link, out) {
  SPECIAL_RE.lastIndex = 0;
  let m = SPECIAL_RE.exec(s);
  if (m === null) {
    if (s !== '') out.push(esc(s));
    return;
  }
  let seg = 0; // start of the current plain run
  while (m !== null) {
    const idx = m.index;
    const c = s[idx];
    let next = idx + 1; // where scanning resumes when no construct opens
    if (c === '\\' && idx + 1 < s.length && ESCAPABLE.indexOf(s[idx + 1]) !== -1) {
      // Of the escapable characters only '>' is HTML-special.
      if (idx > seg) out.push(esc(s.slice(seg, idx)));
      out.push(s[idx + 1] === '>' ? '&gt;' : s[idx + 1]);
      seg = idx + 2;
      next = seg;
    } else if (c === '`') {
      const j = s.indexOf('`', idx + 1);
      if (j > idx + 1) {
        if (idx > seg) out.push(esc(s.slice(seg, idx)));
        out.push('<code>', esc(s.slice(idx + 1, j)), '</code>');
        seg = j + 1;
        next = seg;
      }
    } else if (c === '*') {
      if (s[idx + 1] === '*') {
        const j = findUnescaped(s, '**', idx + 2);
        if (j > idx + 2) {
          if (idx > seg) out.push(esc(s.slice(seg, idx)));
          out.push('<strong>');
          inlineInto(s.slice(idx + 2, j), link, out);
          out.push('</strong>');
          seg = j + 2;
          next = seg;
        } else {
          next = idx + 2;
        }
      } else {
        const j = findSingleStar(s, idx + 1);
        if (j > idx + 1) {
          if (idx > seg) out.push(esc(s.slice(seg, idx)));
          out.push('<em>');
          inlineInto(s.slice(idx + 1, j), link, out);
          out.push('</em>');
          seg = j + 1;
          next = seg;
        }
      }
    } else if (c === '[') {
      const k = findUnescaped(s, ']', idx + 1);
      const q = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = q === -1 ? '' : s.slice(k + 2, q);
      if (target !== '' && !WS_RE.test(target)) {
        if (idx > seg) out.push(esc(s.slice(seg, idx)));
        out.push('<a href="', esc(link(target)), '">');
        inlineInto(s.slice(idx + 1, k), link, out);
        out.push('</a>');
        seg = q + 1;
        next = seg;
      }
    }
    SPECIAL_RE.lastIndex = next;
    m = SPECIAL_RE.exec(s);
  }
  if (s.length > seg) out.push(esc(s.slice(seg)));
}

/**
 * Lines `from`..`to` rendered: its HTML, its table of contents and its excerpt
 * (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(lines, from, to, link) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = '';
  let seenPara = false;
  let i = from;
  while (i < to) {
    const line = lines[i];
    if (line.length === 0) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
      // An indented line at block level is a paragraph line.
    } else if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < to && !fenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const codeParts = [];
        for (let k = 0; k < body.length; k++) codeParts.push(esc(body[k]), '\n');
        blocks.push(`<pre><code${lang === '' ? '' : ` class="language-${esc(lang)}"`}>${codeParts.join('')}</code></pre>\n`);
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), ids);
        const tmp = [];
        inlineInto(h.text, link, tmp);
        const html = tmp.join('');
        blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>\n`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        blocks.push('<hr>\n');
        i++;
        continue;
      }
      const b = bulletOf(line);
      if (b !== null) {
        const items = [[trimLine(b)]];
        i++;
        while (i < to) {
          const l = lines[i];
          const item = bulletOf(l);
          if (item !== null) {
            items.push([trimLine(item)]);
            i++;
          } else if (isContinued(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        }
        let s = '<ul>\n';
        for (let k = 0; k < items.length; k++) {
          const tmp = [];
          inlineInto(items[k].join('\n'), link, tmp);
          s += `<li>${tmp.join('')}</li>\n`;
        }
        s += '</ul>\n';
        blocks.push(s);
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < to && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.length > 1 && l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) {
        blocks.push('<blockquote>\n</blockquote>\n');
      } else {
        const tmp = [];
        inlineInto(kept.join('\n'), link, tmp);
        blocks.push(`<blockquote>\n<p>${tmp.join('')}</p>\n</blockquote>\n`);
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const o = orderedOf(line);
      if (o !== null) {
        const items = [[trimLine(o.text)]];
        i++;
        while (i < to) {
          const l = lines[i];
          const m = orderedOf(l);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
          } else if (isContinued(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        }
        let s = o.start !== 1 ? `<ol start="${o.start}">\n` : '<ol>\n';
        for (let k = 0; k < items.length; k++) {
          const tmp = [];
          inlineInto(items[k].join('\n'), link, tmp);
          s += `<li>${tmp.join('')}</li>\n`;
        }
        s += '</ol>\n';
        blocks.push(s);
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < to && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const tmp = [];
    inlineInto(body.join('\n'), link, tmp);
    const html = tmp.join('');
    if (!seenPara) {
      excerpt = html;
      seenPara = true;
    }
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt };
}

/** The words of the body lines: runs of characters other than whitespace. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [32, 9, 10, 13, 12, 11, 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;

function countWords(lines, from, to) {
  let n = 0;
  for (let i = from; i < to; i++) {
    const l = lines[i];
    let inW = false;
    for (let j = 0; j < l.length; j++) {
      if (WS_TABLE[l.charCodeAt(j)] === 1) inW = false;
      else if (!inW) {
        inW = true;
        n++;
      }
    }
  }
  return n;
}

/* -------------------------------------------------------------- templates */

const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s` holds only spaces and tabs between `a` and `b`. */
function onlySpaceTab(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}/{{{ }}} and {% %}; a standalone tag's line goes with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaceTab(src, lineStart, open) && onlySpaceTab(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Compiled node kinds: 0 text, 1 var/raw, 2 if, 3 for, 4 include.
//   [0, text]  [1, path, raw]  [2, path, not, then, else|null]
//   [3, name, path, body]  [4, name]

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push([0, tok.text]);
    else if (tok.t === 'var' || tok.t === 'raw') body.push([1, tok.path, tok.t === 'raw']);
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = [3, m[1], pathOf(name, m[2]), []];
        body.push(node);
        stack.push({ kind: 'for', body: node[3] });
        body = node[3];
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = [2, pathOf(name, m[2]), m[1] !== undefined, [], null];
        body.push(node);
        stack.push({ kind: 'if', node });
        body = node[3];
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.node[4] !== null) {
          throw new TemplateError(`template "${name}": an else outside an if`);
        }
        top.node[4] = [];
        body = top.node[4];
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.node[4] ?? parent.node[3];
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
        body.push([4, m[1]]);
      } else {
        throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
      }
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest frame holding it. */
function lookup(frames, path) {
  const name = path[0];
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    const v0 = f[name];
    if (v0 !== undefined) {
      let v = v0;
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object') return undefined;
        v = v[path[k]];
        if (v === undefined) return undefined;
      }
      return v;
    }
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += textOf(v[i]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out` in the scope chain `frames`. */
function renderOps(nodes, frames, templates, out, depth) {
  for (let o = 0; o < nodes.length; o++) {
    const n = nodes[o];
    switch (n[0]) {
      case 0:
        out.push(n[1]);
        break;
      case 1: {
        const v = lookup(frames, n[1]);
        const s = typeof v === 'string' ? v : textOf(v);
        out.push(n[2] ? s : esc(s));
        break;
      }
      case 2: {
        const v = truthy(lookup(frames, n[1]));
        const branch = v !== n[2] ? n[3] : n[4];
        if (branch !== null) renderOps(branch, frames, templates, out, depth);
        break;
      }
      case 3: {
        const xs = lookup(frames, n[2]);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = { [n[1]]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
          frames.push(vars);
          renderOps(n[3], frames, templates, out, depth);
          frames.pop();
        }
        break;
      }
      case 4: {
        if (depth < INCLUDE_DEPTH) {
          const t = templates.get(n[1]);
          if (t !== undefined) renderOps(t, frames, templates, out, depth + 1);
        }
        break;
      }
    }
  }
}

/* ------------------------------------------------------------------- build */

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const key = `${dir}\n${rel}`;
  if (resolveCache.has(key)) return resolveCache.get(key);
  const parts = dir === '' ? [] : dir.split('/');
  let ok = true;
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) {
        ok = false;
        break;
      }
      parts.pop();
    } else parts.push(seg);
  }
  const out = ok ? parts.join('/') : null;
  resolveCache.set(key, out);
  return out;
}

/** The resolve cache, rebuilt for every run() so nothing leaks between cases. */
let resolveCache = new Map();

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45)) return false;
  }
  return false;
}
const RESERVED = ['posts', 'tags', 'page'];

/** A source's tags, each slug once, in its own order. */
function ownTags(names) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < names.length; i++) {
    const slug = slugify(names[i]);
    if (!seen.has(slug)) {
      seen.add(slug);
      out.push(names[i]);
    }
  }
  return out;
}

/** One site's output tree: path -> text. */
export function run(input) {
  slugCache = new Map();
  resolveCache = new Map();
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};

  // 1. The sources, in code-unit order of their paths; a source that is not
  // .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, lines: text.split('\n') });
    } else {
      statics.push({ path: f.path, content: f.content });
    }
  }

  // 2. Each source's front matter: a refused source is reported and dropped,
  // and so is a draft. The checks run in order; the first that fails is reported.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (let d = 1; d < RESERVED.length; d++) {
      if (s.path.startsWith(`${RESERVED[d]}/`)) {
        own = RESERVED[d];
        break;
      }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its
  // directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files
  // they name.
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const link = (target) => {
      if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) return `${pg.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${srcPath} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.lines, s.bodyStart, s.lines.length, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = countWords(s.lines, s.bodyStart, s.lines.length);
    s.tocView = md.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
  }

  // 5. The posts, newest first and then by slug; each post's newer and older.
  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].post) posts.push(kept[i]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts'
  // order, ordered by count and then slug.
  const bySlug = new Map();
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const tags = ownTags(p.data.tags ?? []);
    for (let k = 0; k < tags.length; k++) {
      const name = tags[k];
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const tags = ownTags(s.data.tags ?? []);
    s.tagRefs = [];
    for (let k = 0; k < tags.length; k++) {
      const name = tags[k];
      const slug = slugify(name);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: (s.tagView ??= s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url }))),
  });
  const cards = new Map();
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    cards.set(p, (p.card ??= cardOf(p)));
  }
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const pageOf = (s) => ({
    ...(s.card ??= cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.tocView,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const frames = [{ site, tags: allTags, recent, ...vars }];
    const out = [];
    renderOps(nodes, frames, templates, out, 0);
    return out.join('');
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.length - posts.length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
