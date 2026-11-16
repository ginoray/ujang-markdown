// parse.js — a fast, dependency-free Markdown renderer.
//
// Produces byte-identical HTML to marked 18.1.3 with default options
// (GFM enabled, no breaks, not pedantic) for the markdown-render-speed-02
// bounty. Written from scratch as a tokenizing lexer + renderer pipeline:
//
//   source --(block lexer)--> block tokens --(inline lexer)--> inline tokens
//          --(renderer)--> HTML string
//
// Inline jobs are queued while block lexing runs and are only tokenized once
// the whole document has been seen, so link reference definitions can appear
// anywhere in the document. Emphasis/strikethrough closer searches run on a
// masked copy of the inline source in which code spans, link destinations
// and raw HTML have been neutralised, so delimiters inside them never count.

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeAllRe = /[&<>"']/g;
const escapeAllTest = /[&<>"']/;
const escapeNoEncodeRe = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const escapeNoEncodeTest = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;

// Escape &, <, >, ", ' for HTML output. With `encode` false, an ampersand
// that already introduces a character reference is left alone.
function escapeHtml(text, encode) {
  if (encode) {
    return escapeAllTest.test(text) ? text.replace(escapeAllRe, ch => HTML_ESCAPES[ch]) : text;
  }
  return escapeNoEncodeTest.test(text)
    ? text.replace(escapeNoEncodeRe, ch => HTML_ESCAPES[ch])
    : text;
}

const numericRefRe = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const numericRefOrAmpRe = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Decode numeric character references in a text run; a bare ampersand that
// is not part of any reference is escaped (only runs when a valid numeric
// reference is present somewhere in the run).
function decodeNumericRefs(text) {
  if (!numericRefRe.test(text)) return text;
  return text.replace(numericRefOrAmpRe, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '�';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// encodeURI a link destination, restoring literal % characters; null when
// the destination is not encodable (the renderer then drops the link).
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

const anyPunctuationRe = /\\([\p{P}\p{S}])/gu;
// Remove backslash escapes before punctuation ("\*" -> "*").
function unescapePunct(text) {
  return text.replace(anyPunctuationRe, '$1');
}

// Remove trailing copies of `ch` (marked's rtrim helper).
function rtrimChar(str, ch) {
  let len = str.length;
  if (len === 0) return '';
  let count = 0;
  while (count < len) {
    const c = str.charAt(len - count - 1);
    if (c === ch) count++;
    else break;
  }
  return str.slice(0, len - count);
}

// Trim trailing blank lines, but keep the text untouched when there are at
// most two trailing line breaks worth of blank lines.
function trimTrailingBlankLines(text) {
  const lines = text.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && /^[ \t]*$/.test(lines[last])) last--;
  return lines.length - last <= 2 ? text : lines.slice(0, last + 1).join('\n');
}

// Canonical form of a link label used for reference lookup.
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the closing bracket for `str`, honouring backslash escapes.
// Returns the index of the unmatched closer, -1 when balanced, -2 when a
// closer is missing.
function findClosingBracket(str, brackets) {
  if (str.indexOf(brackets[0]) === -1 && str.indexOf(brackets[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === brackets[0]) depth++;
    else if (str[i] === brackets[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, assuming the text starts at column `offset`.
function expandTabs(text, offset = 0) {
  let col = offset;
  let out = '';
  for (const ch of text) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Split a table row into cells on unescaped pipes.
function splitCells(row, count) {
  const spaced = row.replace(/\|/g, (m, offset, str) => {
    let escaped = false;
    let p = offset;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = spaced.split(/ \|/);
  let i = 0;
  if (cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Remove up to the opening fence's indentation from every content line of a
// fenced code block.
function fenceText(raw, text) {
  const m = raw.match(/^(\s+)(?:```)/);
  if (m === null) return text;
  const indent = m[1];
  return text
    .split('\n')
    .map(line => {
      const lead = line.match(/^\s+/);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Grammar tables (CommonMark 0.31.2 + GFM, as tuned by marked's defaults)
// ---------------------------------------------------------------------------

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const HR_SRC = ' {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEADING_BEGIN_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const BLOCKQUOTE_BEGIN_SRC = ' {0,3}>';
const FENCES_BEGIN_SRC = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~{3,})[^\\n]*(?:\\n|$)';
const HTML_BEGIN_SRC =
  ' {0,3}(?:</?(?:' + BLOCK_TAGS + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';

// The "what may interrupt a paragraph" lookahead body shared by the
// paragraph, setext-heading and blockquote patterns. `listSrc` differs per
// call site.
function interruptSrc(listSrc, extra) {
  return (
    '(?!' +
    HR_SRC +
    '|' + HEADING_BEGIN_SRC +
    '|' + BLOCKQUOTE_BEGIN_SRC +
    '|' + FENCES_BEGIN_SRC +
    '|' + listSrc +
    '|' + HTML_BEGIN_SRC +
    (extra || '') +
    '|[ \\t]+\\n)'
  );
}

const PARA_LIST_SRC = ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]';
const TABLE_SRC =
  ' *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)' +
  '(?:\\n((?:(?! *\\n|' + HR_SRC + '|' + HEADING_BEGIN_SRC + '|' + BLOCKQUOTE_BEGIN_SRC +
  '|(?: {4}| {0,3}\\t)[^\\n]| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~{3,})[^\\n]*(?:\\n|$)' +
  '| {0,3}(?:[*+-]|1[.)])[ \\t]|' + HTML_BEGIN_SRC + ').*(?:\\n|$))*)\\n*|$)';

const blockRe = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: new RegExp('^' + HR_SRC),
  blockquote: new RegExp(
    '^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(([^\\n]+(?:\\n' +
      interruptSrc(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)') +
      '[^\\n]+)*))|[^\\n]*)(?:\\n|$))+'
  ),
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  html: new RegExp(
    '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' +
      '|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^^\\n]*(\\n+|$)'.replace('[^^\\n]', '[^\\n]') +
      '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' +
      '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' +
      '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' +
      '|</?(' + BLOCK_TAGS + ')(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)' +
      "|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *\"[^\"\\n]*\"| *= *'[^'\\n]*'| *= *[^\\s\"'=<>`]+)?)*? *\\/?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)" +
      '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))',
    'i'
  ),
  def: /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/,
  table: new RegExp('^' + TABLE_SRC),
  lheading: new RegExp(
    '^(?! {0,3}(?:[*+-]|\\d{1,9}[.)]) |(?: {4}| {0,3}\\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n)' +
      '((?:.|\\n(?!\\s*?\\n| {0,3}(?:[*+-]|\\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)|' +
      ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)' +
      '| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)'
  ),
  paragraph: new RegExp(
    '^([^\\n]+(?:\\n' + interruptSrc(PARA_LIST_SRC, '|' + TABLE_SRC) + '[^\\n]+)*)'
  ),
  text: /^[^\n]+/,
};

const LABEL_SRC =
  '(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const REF_SRC = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const HREF_SRC = '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))';
const TITLE_SRC = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)';

const inlineRe = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  emStrongLDelim: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  emStrongRDelimAst: new RegExp(
    '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])' +
      '|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?=[\\s]|$)' +
      '|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?!\\*)(?=(?!~)[\\s\\p{P}\\p{S}]|$)' +
      '|(?!\\*)(?!~)[\\s\\p{P}\\p{S}](\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))' +
      '|[\\s](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])' +
      '|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])' +
      '|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))',
    'gu'
  ),
  emStrongRDelimUnd: new RegExp(
    '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])' +
      '|(?!_)[\\p{P}\\p{S}](_+)(?=[\\s]|$)' +
      '|[^\\s\\p{P}\\p{S}](_+)(?!_)(?=[\\s\\p{P}\\p{S}]|$)' +
      '|(?!_)[\\s\\p{P}\\p{S}](_+)(?=[^\\s\\p{P}\\p{S}])' +
      '|[\\s](_+)(?!_)(?=[\\p{P}\\p{S}])' +
      '|(?!_)[\\p{P}\\p{S}](_+)(?!_)(?=[\\p{P}\\p{S}])',
    'gu'
  ),
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim: new RegExp(
    '^[^~]+(?=[^~])' +
      '|(?!~)[\\p{P}\\p{S}](~~?)(?=[\\s]|$)' +
      '|[^\\s\\p{P}\\p{S}](~~?)(?!~)(?=[\\s\\p{P}\\p{S}]|$)' +
      '|(?!~)[\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])' +
      '|[\\s](~~?)(?!~)(?=[\\p{P}\\p{S}])' +
      '|(?!~)[\\p{P}\\p{S}](~~?)(?!~)(?=[\\p{P}\\p{S}])' +
      '|[^\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])',
    'gu'
  ),
  autolink: /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/,
  url: /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  tag: /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  link: new RegExp('^!?\\[(' + LABEL_SRC + ')\\]\\([ \\t\\n]*(' + HREF_SRC + ')(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(' + TITLE_SRC + '))?[ \\t\\n]*\\)'),
  reflink: new RegExp('^!?\\[(' + LABEL_SRC + ')\\]\\[(' + REF_SRC + ')\\]'),
  nolink: new RegExp('^!?\\[(' + REF_SRC + ')\\](?:\\[\\])?'),
  reflinkSearch: new RegExp(
    '!?\\[((?:[^\\[\\]\\\\`]*(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\]' +
      '|!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\](?:\\[\\])?(?!\\()',
    'g'
  ),
  blockSkip: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g,
  anyPunctuationOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  text: /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/,
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
};

// Parameterised patterns used by the list tokenizer. The factory argument is
// clamped the same way marked clamps it (indent - 1, at most 3).
function clampedFactory(build) {
  const cache = [];
  return indent => {
    const n = Math.max(0, Math.min(3, indent - 1));
    return cache[n] || (cache[n] = build(n));
  };
}
const listItemRe = bullSrc => new RegExp(`^( {0,3}${bullSrc})((?:[\t ][^\\n]*)?(?:\\n|$))`);
const nextBulletRe = clampedFactory(n => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrIndentRe = clampedFactory(n => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRe = clampedFactory(n => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingBeginRe = clampedFactory(n => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlBeginRe = clampedFactory(
  n => new RegExp(`^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')
);
const blockquoteBeginRe = clampedFactory(n => new RegExp(`^ {0,${n}}>`));

const otherRe = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  endingHash: /#$/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  leadingSpaceTab: /^[ \t]+/,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
};

// Equivalent of s.replace(/\t/g, '    ').search(/[^ ]/) >= 4: is the first
// non-blank character of s at expanded column 4 or beyond?
function tabExpandedDeep(s) {
  let pos = 0;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\t') pos += 4;
    else if (ch === ' ') pos += 1;
    else return pos >= 4;
  }
  return false;
}

function firstLineOf(s) {
  const nl = s.indexOf('\n');
  return nl === -1 ? s : s.slice(0, nl);
}

// Equivalent of /\n[ \t]*\n[ \t]*$/ tested by scanning backwards.
function endsWithBlankLine(s) {
  let i = s.length - 1;
  while (i >= 0 && (s[i] === ' ' || s[i] === '\t')) i--;
  if (i < 0 || s[i] !== '\n') return false;
  i--;
  while (i >= 0 && (s[i] === ' ' || s[i] === '\t')) i--;
  return i >= 0 && s[i] === '\n';
}

// A table can only match when the second line of the block consists solely
// of spaces, '|', ':' and '-' and contains at least one '-' plus a '|' or
// ':'. Anything else and the (expensive) table pattern cannot match.
function tablePossible(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  const start = nl + 1;
  let end = src.indexOf('\n', start);
  if (end === -1) end = src.length;
  let dash = false;
  let pipeOrColon = false;
  for (let i = start; i < end; i++) {
    const c = src.charCodeAt(i);
    if (c === 45) dash = true;
    else if (c === 124 || c === 58) pipeOrColon = true;
    else if (c !== 32) return false;
  }
  return dash && pipeOrColon;
}

// A setext heading needs a line of only '=' or '-' (up to 3 leading spaces,
// optional trailing blanks) somewhere after the first line and before any
// blank line. Without one the lheading pattern cannot match.
function lheadingPossible(src) {
  let pos = src.indexOf('\n');
  if (pos === -1) return false;
  while (pos + 1 < src.length) {
    const start = pos + 1;
    let end = src.indexOf('\n', start);
    if (end === -1) end = src.length;
    let i = start;
    let spaces = 0;
    while (i < end && src[i] === ' ') {
      i++;
      spaces++;
    }
    let blank = true;
    for (let j = start; j < end; j++) {
      const cj = src[j];
      if (cj !== ' ' && cj !== '\t') {
        blank = false;
        break;
      }
    }
    if (blank) return false;
    if (spaces <= 3 && i < end && (src[i] === '=' || src[i] === '-')) {
      const ch = src[i];
      let j = i;
      while (j < end && src[j] === ch) j++;
      while (j < end && (src[j] === ' ' || src[j] === '\t')) j++;
      if (j === end) return true;
    }
    if (end === src.length) return false;
    pos = end;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Lexer: block tokenizers
// ---------------------------------------------------------------------------

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.linkDefCount = 0;
    this.inlineQueue = [];
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    // Stack of emphasis masks for nested inline tokenization.
    this.maskStack = [];
  }

  // Queue an inline source for later tokenization (after the whole document
  // has been block-lexed and every link definition is known).
  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  lex(src) {
    src = src.replace(/\r\n|\r/g, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const job = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(job.src, job.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  blockTokens(src, tokens = [], nested = false) {
    let guard = Infinity;
    while (src) {
      if (src.length < guard) guard = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));

      let tok;

      // Dispatch profile: how many leading spaces (capped at 4) and the
      // first significant character. Most block patterns allow at most 3
      // leading spaces followed by a specific character, so whole families
      // of tokenizers can be skipped when that character cannot match.
      const c0 = src.charCodeAt(0);
      let sp = 0;
      while (sp < 4 && src.charCodeAt(sp) === 32) sp++;
      const deepIndent = sp === 4;
      const sig = deepIndent || sp >= src.length ? -1 : src.charCodeAt(sp);

      // Blank lines.
      if ((c0 === 10 || c0 === 32 || c0 === 9) && (tok = this.tokSpace(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
        else tokens.push(tok);
        continue;
      }

      // Indented code block: needs 4+ spaces of indent or a tab within the
      // first four columns.
      if ((deepIndent || sig === 9) && (tok = this.tokCode(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last?.type === 'paragraph' || last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else {
          tokens.push(tok);
        }
        continue;
      }

      if ((sig === 96 || sig === 126) && (tok = this.tokFences(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }

      if (sig === 35 && (tok = this.tokHeading(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }

      if ((sig === 45 || sig === 95 || sig === 42) && (tok = this.tokHr(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }

      if (sig === 62 && (tok = this.tokBlockquote(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }

      if (
        (sig === 42 || sig === 43 || sig === 45 || (sig >= 48 && sig <= 57)) &&
        (tok = this.tokList(src))
      ) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }

      if (sig === 60 && (tok = this.tokHtml(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }

      if (sig === 91 && (tok = this.tokDef(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last?.type === 'paragraph' || last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.raw;
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else {
          if (!this.tokens.links[tok.tag]) {
            this.tokens.links[tok.tag] = { href: tok.href, title: tok.title };
            this.linkDefCount++;
          }
          tokens.push(tok);
        }
        continue;
      }

      if (tablePossible(src) && (tok = this.tokTable(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }

      if (lheadingPossible(src) && (tok = this.tokLheading(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }

      // Paragraph: only at the top level of a block context.
      let cut = src;
      if (this.state.top && (tok = this.tokParagraph(cut))) {
        const last = tokens[tokens.length - 1];
        if (nested && last?.type === 'paragraph') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else {
          tokens.push(tok);
        }
        src = src.substring(tok.raw.length);
        continue;
      }

      if ((tok = this.tokText(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
        } else {
          tokens.push(tok);
        }
        continue;
      }

      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.state.top = true;
    return tokens;
  }

  tokSpace(src) {
    const cap = blockRe.newline.exec(src);
    if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
  }

  tokCode(src) {
    const cap = blockRe.code.exec(src);
    if (cap) {
      const raw = trimTrailingBlankLines(cap[0]);
      const text = raw.replace(otherRe.codeRemoveIndent, '');
      return { type: 'code', raw, codeBlockStyle: 'indented', text };
    }
  }

  tokFences(src) {
    const cap = blockRe.fences.exec(src);
    if (cap) {
      const raw = cap[0];
      const text = fenceText(raw, cap[3] || '');
      return {
        type: 'code',
        raw,
        lang: cap[2] ? cap[2].trim().replace(anyPunctuationRe, '$1') : cap[2],
        text,
      };
    }
  }

  tokHeading(src) {
    const cap = blockRe.heading.exec(src);
    if (cap) {
      let text = cap[2].trim();
      if (otherRe.endingHash.test(text)) {
        const stripped = rtrimChar(text, '#');
        if (!stripped || otherRe.endingSpaceTabChar.test(stripped)) {
          text = stripped.trim();
        }
      }
      return {
        type: 'heading',
        raw: rtrimChar(cap[0], '\n'),
        depth: cap[1].length,
        text,
        tokens: this.inline(text),
      };
    }
  }

  tokHr(src) {
    const cap = blockRe.hr.exec(src);
    if (cap) return { type: 'hr', raw: rtrimChar(cap[0], '\n') };
  }

  tokBlockquote(src) {
    const cap = blockRe.blockquote.exec(src);
    if (!cap) return;
    let lines = rtrimChar(cap[0], '\n').split('\n');
    let rawOut = '';
    let textOut = '';
    const tokens = [];

    while (lines.length > 0) {
      // Collect the next chunk: lines belonging to one blockquote segment,
      // including lazy continuation lines that precede the first marker.
      let seenMarker = false;
      const chunk = [];
      let p = 0;
      for (; p < lines.length; p++) {
        if (otherRe.blockquoteStart.test(lines[p])) {
          chunk.push(lines[p]);
          seenMarker = true;
        } else if (!seenMarker) {
          chunk.push(lines[p]);
        } else break;
      }
      const rest = lines.slice(p);

      const chunkRaw = chunk.join('\n');
      const chunkText = chunkRaw
        .replace(otherRe.blockquoteMarkerWhitespace, (m, marker, ws) => marker + expandTabs(ws, marker.length))
        .replace(otherRe.blockquoteSetextReplace, '\n    $1')
        .replace(otherRe.blockquoteSetextReplace2, '');
      rawOut = rawOut ? rawOut + '\n' + chunkRaw : chunkRaw;
      textOut = textOut ? textOut + '\n' + chunkText : chunkText;

      const prevTop = this.state.top;
      this.state.top = true;
      this.blockTokens(chunkText, tokens, true);
      this.state.top = prevTop;

      if (rest.length === 0) {
        lines = rest;
        break;
      }

      const lastTok = tokens[tokens.length - 1];
      if (
        lastTok?.type === 'code' ||
        lastTok?.type === 'heading' ||
        lastTok?.type === 'hr' ||
        lastTok?.type === 'html' ||
        lastTok?.type === 'table'
      ) {
        lines = rest;
        break;
      }

      if (lastTok?.type === 'blockquote') {
        // The inner quote ended early; retry with the remaining lines glued
        // back onto it, in case they extend it after all.
        const inner = lastTok;
        const joined = inner.raw + '\n' + rest.join('\n').replace(otherRe.blockquoteSetextReplace2, '');
        const merged = this.tokBlockquote(joined);
        tokens[tokens.length - 1] = merged;
        const leftover = joined.substring(merged.raw.length).replace(/^\n/, '');
        const leftoverCount = leftover ? leftover.split('\n').length : 0;
        const consumed = leftoverCount ? rest.slice(0, -leftoverCount) : rest;
        if (consumed.length > 0) rawOut += '\n' + consumed.join('\n');
        textOut = textOut.substring(0, textOut.length - inner.text.length) + merged.text;
        lines = rest.slice(consumed.length);
        if (lines.length > 0 && otherRe.blockquoteStart.test(lines[0])) continue;
        break;
      }

      if (lastTok?.type === 'list') {
        // Same retry for a list that may continue into the remaining lines.
        const inner = lastTok;
        const joined = inner.raw + '\n' + rest.join('\n');
        const merged = this.tokList(joined);
        tokens[tokens.length - 1] = merged;
        let used = 0;
        if (merged.raw.length > inner.raw.length) {
          used = joined.slice(inner.raw.length + 1, merged.raw.length).split('\n').length;
        }
        if (used > 0) {
          const taken = rest.slice(0, used).join('\n');
          rawOut += '\n' + taken;
          textOut += '\n' + taken;
        }
        lines = rest.slice(used);
        continue;
      }

      lines = rest;
    }

    return { type: 'blockquote', raw: rawOut, tokens, text: textOut };
  }

  tokList(src) {
    let cap = blockRe.list.exec(src);
    if (!cap) return;

    const original = src;
    const consumed = () => original.length - src.length;

    let bullet = cap[1].trim();
    const ordered = bullet.length > 1;
    const list = {
      type: 'list',
      raw: '',
      ordered,
      start: ordered ? +bullet.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    bullet = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
    const itemRe = listItemRe(bullet);
    let pendingLoose = false;

    while (src) {
      let blankItemSkipped = false;
      if (!(cap = itemRe.exec(src)) || blockRe.hr.test(src)) break;

      const itemStart = consumed();
      src = src.substring(cap[0].length);

      const firstLine = firstLineOf(cap[2]);
      const bulletWidth = cap[1].length;
      let content = firstLine.replace(otherRe.leadingSpaceTab, v => expandTabs(v, bulletWidth));
      let nextLine = firstLineOf(src);
      const firstLineBlank = !content.trim();

      let indent;
      let itemText;
      if (firstLineBlank) {
        indent = bulletWidth + 1;
      } else {
        indent = content.search(otherRe.nonSpaceChar);
        if (indent > 4) indent = 1;
        itemText = content.slice(indent);
        indent += bulletWidth;
      }
      if (itemText === undefined) itemText = '';

      // A blank first line followed by a blank line: skip one blank line;
      // the item body is then taken verbatim (no continuation gathering).
      if (firstLineBlank && otherRe.blankLine.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        blankItemSkipped = true;
      }

      if (!blankItemSkipped) {
        const nextBullet = nextBulletRe(indent);
        const hrHere = hrIndentRe(indent);
        const fencesHere = fencesBeginRe(indent);
        const headingHere = headingBeginRe(indent);
        const htmlHere = htmlBeginRe(indent);
        const quoteHere = blockquoteBeginRe(indent);
        let prevLine = content;
        let prevBlank = firstLineBlank;
        while (src) {
          const line = firstLineOf(src);
          nextLine = line;
          const expanded =
            line.charCodeAt(0) === 32 || line.charCodeAt(0) === 9
              ? line.replace(otherRe.leadingSpaceTab, v => expandTabs(v))
              : line;
          const lineBlank = !line.trim();
          // Every "begin" pattern is anchored to at most 3 leading spaces
          // plus one specific character, so dispatch on that character.
          let lineSp = 0;
          while (lineSp < 4 && line.charCodeAt(lineSp) === 32) lineSp++;
          const lc = lineSp >= 4 || lineSp >= line.length ? -1 : line.charCodeAt(lineSp);
          let startsBlock = false;
          if (lc === 35) startsBlock = headingHere.test(line);
          else if (lc === 96 || lc === 126) startsBlock = fencesHere.test(line);
          else if (lc === 60) startsBlock = htmlHere.test(line);
          else if (lc === 62) startsBlock = quoteHere.test(line);
          else if (lc === 45 || lc === 42) startsBlock = nextBullet.test(line) || hrHere.test(line);
          else if (lc === 95) startsBlock = hrHere.test(line);
          else if (lc === 43 || (lc >= 48 && lc <= 57)) startsBlock = nextBullet.test(line);
          if (startsBlock) break;
          let firstNonSpace = 0;
          while (firstNonSpace < expanded.length && expanded[firstNonSpace] === ' ') firstNonSpace++;
          if (firstNonSpace === expanded.length) firstNonSpace = -1;
          if (firstNonSpace >= indent || lineBlank) {
            itemText += '\n' + expanded.slice(indent);
          } else {
            // Lazy continuation line: part of the item only when the
            // previous line was not itself a block start.
            let prevStartsBlock = false;
            if (!prevBlank) {
              let pSp = 0;
              while (pSp < 4 && prevLine.charCodeAt(pSp) === 32) pSp++;
              const pc = pSp >= 4 || pSp >= prevLine.length ? -1 : prevLine.charCodeAt(pSp);
              if (pc === 35) prevStartsBlock = headingHere.test(prevLine);
              else if (pc === 96 || pc === 126) prevStartsBlock = fencesHere.test(prevLine);
              else if (pc === 60) prevStartsBlock = htmlHere.test(prevLine);
              else if (pc === 45 || pc === 95 || pc === 42) prevStartsBlock = hrHere.test(prevLine);
            }
            if (prevBlank || tabExpandedDeep(content) || prevStartsBlock) {
              break;
            }
            const isSetext = /^ {0,3}(?:=+|-+) *$/.test(line) && blockRe.lheading.test(prevLine + '\n' + line);
            itemText += '\n' + (isSetext ? '    ' + line.replace(/^ {0,3}/, '') : line);
          }
          prevBlank = lineBlank;
          src = src.substring(line.length + 1);
          prevLine = expanded.slice(indent);
          content = prevLine;
        }
      }

      const itemRaw = original.slice(itemStart, consumed());
      if (!list.loose) {
        if (pendingLoose) list.loose = true;
        else if (endsWithBlankLine(itemRaw)) pendingLoose = true;
      }
      list.items.push({
        type: 'list_item',
        raw: itemRaw,
        task: listIsTaskTest(itemText),
        loose: false,
        text: itemText,
        tokens: [],
      });
    }

    const lastItem = list.items[list.items.length - 1];
    if (lastItem) {
      lastItem.raw = lastItem.raw.trimEnd();
      lastItem.text = lastItem.text.trimEnd();
    } else {
      return;
    }
    list.raw = original.slice(0, consumed()).trimEnd();

    // Lex each item's blocks (not at top level: paragraphs stay text).
    for (const item of list.items) {
      this.state.top = false;
      item.tokens = this.blockTokens(item.text, []);
      if (!list.loose) {
        const spaces = item.tokens.filter(t => t.type === 'space');
        if (spaces.length > 0 && spaces.some(t => otherRe.anyLine.test(t.raw))) {
          list.loose = true;
        }
      }
    }

    // Task list checkboxes.
    for (const item of list.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(otherRe.listReplaceTask, '');
        first.raw = first.raw.replace(otherRe.listReplaceTask, '');
        first.text = first.text.replace(otherRe.listReplaceTask, '');
        for (let q = this.inlineQueue.length - 1; q >= 0; q--) {
          if (otherRe.listIsTask.test(this.inlineQueue[q].src)) {
            this.inlineQueue[q].src = this.inlineQueue[q].src.replace(otherRe.listReplaceTask, '');
            break;
          }
        }
        const cb = otherRe.listTaskCheckbox.exec(item.raw);
        if (cb) {
          const checkbox = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
          item.checked = checkbox.checked;
          if (list.loose) {
            const head = item.tokens[0];
            if (head && (head.type === 'paragraph' || head.type === 'text') && head.tokens) {
              head.raw = checkbox.raw + head.raw;
              head.text = checkbox.raw + head.text;
              head.tokens.unshift(checkbox);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
            }
          } else {
            item.tokens.unshift(checkbox);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }

    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const t of item.tokens) {
          if (t.type === 'text') t.type = 'paragraph';
        }
      }
    }

    return list;
  }

  tokHtml(src) {
    const cap = blockRe.html.exec(src);
    if (cap) {
      const raw = trimTrailingBlankLines(cap[0]);
      return {
        type: 'html',
        block: true,
        raw,
        pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
        text: raw,
      };
    }
  }

  tokDef(src) {
    const cap = blockRe.def.exec(src);
    if (cap) {
      if (!otherRe.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return;
      const tag = normalizeLabel(cap[1]);
      const href = cap[2]
        ? cap[2].replace(otherRe.hrefBrackets, '$1').replace(anyPunctuationRe, '$1')
        : '';
      const title = cap[3]
        ? cap[3].substring(1, cap[3].length - 1).replace(anyPunctuationRe, '$1')
        : cap[3];
      return { type: 'def', tag, raw: rtrimChar(cap[0], '\n'), href, title };
    }
  }

  tokTable(src) {
    const cap = blockRe.table.exec(src);
    if (!cap || !otherRe.tableDelimiter.test(cap[2])) return;
    const headerCells = splitCells(cap[1]);
    const aligns = cap[2].replace(otherRe.tableAlignChars, '').split('|');
    const rowLines = cap[3]?.trim()
      ? cap[3].replace(otherRe.tableRowBlankLine, '').split('\n')
      : [];
    const table = {
      type: 'table',
      raw: rtrimChar(cap[0], '\n'),
      header: [],
      align: [],
      rows: [],
    };
    if (headerCells.length !== aligns.length) return;
    for (const cell of aligns) {
      if (otherRe.tableAlignRight.test(cell)) table.align.push('right');
      else if (otherRe.tableAlignCenter.test(cell)) table.align.push('center');
      else if (otherRe.tableAlignLeft.test(cell)) table.align.push('left');
      else table.align.push(null);
    }
    for (let i = 0; i < headerCells.length; i++) {
      table.header.push({
        text: headerCells[i],
        tokens: this.inline(headerCells[i]),
        header: true,
        align: table.align[i],
      });
    }
    for (const row of rowLines) {
      table.rows.push(
        splitCells(row, table.header.length).map((cell, j) => ({
          text: cell,
          tokens: this.inline(cell),
          header: false,
          align: table.align[j],
        }))
      );
    }
    return table;
  }

  tokLheading(src) {
    const cap = blockRe.lheading.exec(src);
    if (cap) {
      const text = cap[1].trim();
      return {
        type: 'heading',
        raw: rtrimChar(cap[0], '\n'),
        depth: cap[2].charAt(0) === '=' ? 1 : 2,
        text,
        tokens: this.inline(text),
      };
    }
  }

  tokParagraph(src) {
    const cap = blockRe.paragraph.exec(src);
    if (cap) {
      const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
      return { type: 'paragraph', raw: cap[0], text, tokens: this.inline(text) };
    }
  }

  tokText(src) {
    const cap = blockRe.text.exec(src);
    if (cap) return { type: 'text', raw: cap[0], text: cap[0], tokens: this.inline(cap[0]) };
  }
}

function listIsTaskTest(text) {
  return otherRe.listIsTask.test(text);
}

// ---------------------------------------------------------------------------
// Inline lexing
// ---------------------------------------------------------------------------

// Scan a masked inline source and record, for each delimiter character, the
// last index at which a closing run could start (a run preceded by a
// non-space character).
function scanClosers(masked) {
  const lastEmStrong = { '*': -1, _: -1 };
  let lastDel = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const ch = masked[s];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = s === 0 ? '\n' : masked[s - 1];
    let end = s + 1;
    while (end < n && masked[end] === ch) end++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastDel = s;
      else lastEmStrong[ch] = s;
    }
    s = end - 1;
  }
  return { maskedSrc: masked, lastEmStrong, lastDel };
}

// Does the given text contain a complete link (used by the mask builder)?
Lexer.prototype.linkInText = function (text) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(inlineRe.blockSkip)) {
    if (inlineRe.link.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(inlineRe.reflinkSearch)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (
      !(s.charAt(0) === '!' || !Object.hasOwn(this.tokens.links, normalizeLabel(s.slice(r + 1, -1)))) &&
      !(r > 1 && this.linkInText(s.slice(1, r - 1)))
    ) {
      return true;
    }
  }
  return false;
};

// Build the masked copy of an inline source: reference links collapse to
// bracketed a's, escaped punctuation becomes '+', backticks inside code
// spans become '+', and whole code spans / inline links / HTML tags
// collapse to bracketed a's.
Lexer.prototype.maskSrc = function (src) {
  let masked = src;
  if (this.linkDefCount > 0 && src.includes('[') && src.includes(']')) {
    const search = inlineRe.reflinkSearch;
    const collapse = r => {
      const open = r.lastIndexOf('[');
      if (!Object.hasOwn(this.tokens.links, normalizeLabel(r.slice(open + 1, -1)))) return r;
      if (open > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, open - 1);
        if (this.linkInText(inner)) {
          return '[' + inner.replace(search, collapse) + '][' + 'a'.repeat(r.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    masked = masked.replace(search, collapse);
  }
  // Each masking pass can only change something when its trigger
  // characters are present at all.
  if (src.includes('`') || src.includes('\\')) {
    masked = masked.replace(inlineRe.anyPunctuationOutsideCode, (m, codeRun, punct) => {
      if (punct) return '+'.repeat(m.length);
      if (codeRun) return codeRun + m.slice(codeRun.length, -codeRun.length).replace(/`/g, '+') + codeRun;
      return m;
    });
  }
  if (src.includes('`') || src.includes('<') || src.includes('](')) {
    masked = masked.replace(inlineRe.blockSkip, m => '[' + 'a'.repeat(m.length - 2) + ']');
  }
  return masked;
};

Lexer.prototype.inlineTokens = function (src, tokens = []) {
  const savedParen = this.state.linkParenPossible;
  this.state.linkParenPossible = savedParen && src.includes(')');
  try {
    return this.inlineTokensInner(src, tokens);
  } finally {
    this.state.linkParenPossible = savedParen;
  }
};

Lexer.prototype.inlineTokensInner = function (src, tokens) {
  const needsMask =
    src.includes('*') || src.includes('_') || src.includes('~');
  const masked = needsMask ? this.maskSrc(src) : src;
  const scan = scanClosers(masked);
  this.maskStack.push(scan);
  try {
    return this.inlineLoop(src, masked, tokens);
  } finally {
    this.maskStack.pop();
  }
};

Lexer.prototype.currentScan = function (masked) {
  const top = this.maskStack[this.maskStack.length - 1];
  return top && top.maskedSrc === masked ? top : scanClosers(masked);
};

Lexer.prototype.inlineLoop = function (src, masked, tokens) {
  let prevChar = '';
  let prevWasText = false;
  let guard = Infinity;

  while (src) {
    if (src.length < guard) guard = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));

    if (!prevWasText) prevChar = '';
    prevWasText = false;

    let tok;

    // Every inline pattern is anchored and starts with a distinctive
    // character, so dispatch on the first character (attempt order is
    // unchanged).
    const c = src.charCodeAt(0);

    if (c === 92 && (tok = this.tokEscape(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }

    if (c === 60 && (tok = this.tokTag(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }

    if (c === 91 || (c === 33 && src.charCodeAt(1) === 91)) {
      if ((tok = this.tokLink(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }

      if ((tok = this.tokReflink(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (tok.type === 'text' && last?.type === 'text') {
          last.raw += tok.raw;
          last.text += tok.text;
        } else {
          tokens.push(tok);
        }
        continue;
      }
    }

    if ((c === 42 || c === 95) && (tok = this.tokEmStrong(src, masked, prevChar))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }

    if (c === 96 && (tok = this.tokCodespan(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }

    if (((c === 32 && src.charCodeAt(1) === 32) || c === 92) && (tok = this.tokBr(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }

    if (c === 126 && (tok = this.tokDel(src, masked, prevChar))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }

    if (c === 60 && (tok = this.tokAutolink(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }

    if (
      !this.state.inLink &&
      ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
        c === 46 || c === 95 || c === 43 || c === 45) &&
      (tok = this.tokUrl(src))
    ) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }

    if ((tok = this.tokInlineText(src))) {
      src = src.substring(tok.raw.length);
      const lastCh = tok.raw.charAt(tok.raw.length - 1);
      if (lastCh !== '_') prevChar = lastCh;
      prevWasText = true;
      const last = tokens[tokens.length - 1];
      if (last?.type === 'text') {
        last.raw += tok.raw;
        last.text += tok.text;
      } else {
        tokens.push(tok);
      }
      continue;
    }

    if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  return tokens;
};

Lexer.prototype.tokEscape = function (src) {
  const cap = inlineRe.escape.exec(src);
  if (cap) return { type: 'escape', raw: cap[0], text: cap[1] };
};

Lexer.prototype.tokTag = function (src) {
  const cap = inlineRe.tag.exec(src);
  if (cap) {
    if (!this.state.inLink && otherRe.startATag.test(cap[0])) this.state.inLink = true;
    else if (this.state.inLink && otherRe.endATag.test(cap[0])) this.state.inLink = false;
    if (!this.state.inRawBlock && otherRe.startPreScriptTag.test(cap[0])) this.state.inRawBlock = true;
    else if (this.state.inRawBlock && otherRe.endPreScriptTag.test(cap[0])) this.state.inRawBlock = false;
    return {
      type: 'html',
      raw: cap[0],
      inLink: this.state.inLink,
      inRawBlock: this.state.inRawBlock,
      block: false,
      text: cap[0],
    };
  }
};

// True when the link label at `offset` in `src` contains an HTML tag or
// autolink that would extend past the end of the label.
Lexer.prototype.labelHasLongTag = function (src, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const code = inlineRe.code.exec(label.slice(s));
      if (code) {
        s += code[0].length - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(offset + s);
    const cap = inlineRe.tag.exec(rest) || inlineRe.autolink.exec(rest);
    if (cap) {
      if (cap[0].length > label.length - s) return true;
      s += cap[0].length - 1;
    }
  }
  return false;
};

// Shared tail of link/reflink tokenizing: build the link or image token,
// recursively tokenizing the label. A link whose label itself emitted a
// link is suppressed (links cannot nest).
Lexer.prototype.makeLink = function (cap, hrefTitle, raw, isImageOffset) {
  const label = cap[1].replace(otherRe.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const prevInLink = this.state.inLink;
  const prevEmitted = this.state.linkEmitted;
  const prevRawBlock = this.state.inRawBlock;
  this.state.inLink = true;
  this.state.linkEmitted = false;
  const inner = this.inlineTokens(label);
  const emitted = this.state.linkEmitted;
  this.state.linkEmitted = prevEmitted;
  this.state.inLink = prevInLink;
  if (!isImage) {
    if (emitted) {
      this.state.inRawBlock = prevRawBlock;
      return undefined;
    }
    this.state.linkEmitted = true;
  }
  return {
    type: isImage ? 'image' : 'link',
    raw,
    href: hrefTitle.href,
    title: hrefTitle.title || null,
    text: label,
    tokens: inner,
  };
};

Lexer.prototype.tokLink = function (src) {
  if (this.state.linkParenPossible === false) return;
  const cap = inlineRe.link.exec(src);
  if (!cap) return;
  const offset = cap[0].charAt(0) === '!' ? 2 : 1;
  if (this.labelHasLongTag(src, cap[1], offset)) return;

  let href = cap[2].trim();
  if (otherRe.startAngleBracket.test(href)) {
    if (!otherRe.endAngleBracket.test(href)) return;
    const unescaped = rtrimChar(href.slice(0, -1), '\\');
    if ((href.length - unescaped.length) % 2 === 0) return;
  } else {
    const closeIdx = findClosingBracket(cap[2], '()');
    if (closeIdx === -2) return;
    if (closeIdx > -1) {
      const cut = (cap[0].indexOf('!') === 0 ? 5 : 4) + cap[1].length + closeIdx;
      cap[2] = cap[2].substring(0, closeIdx);
      cap[0] = cap[0].substring(0, cut).trim();
      cap[3] = '';
    }
  }
  const rawMinusLast = rtrimChar(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - rawMinusLast.length) % 2 === 0) return;

  let dest = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  dest = dest.trim();
  if (otherRe.startAngleBracket.test(dest)) dest = dest.slice(1, -1);
  return this.makeLink(
    cap,
    {
      href: dest && dest.replace(anyPunctuationRe, '$1'),
      title: title && title.replace(anyPunctuationRe, '$1'),
    },
    cap[0]
  );
};

Lexer.prototype.tokReflink = function (src) {
  let cap;
  if ((cap = inlineRe.reflink.exec(src)) || (cap = inlineRe.nolink.exec(src))) {
    const offset = cap[0].charAt(0) === '!' ? 2 : 1;
    if (this.labelHasLongTag(src, cap[1], offset)) return;
    const def = this.tokens.links[normalizeLabel(cap[2] || cap[1])];
    if (!def) {
      const first = cap[0].charAt(0);
      return { type: 'text', raw: first, text: first };
    }
    return this.makeLink(cap, def, cap[0]);
  }
};

Lexer.prototype.tokEmStrong = function (src, masked, prevChar) {
  const cap = inlineRe.emStrongLDelim.exec(src);
  if (!cap || (!cap[1] && !cap[2] && !cap[3] && !cap[4])) return;

  const delim = cap[0][0];
  const sameAsPrev = prevChar === delim;
  const fullLen = masked.length;
  const pos = fullLen - src.length;
  let runStart = pos;
  while (runStart > 0 && masked[runStart - 1] === delim) runStart--;

  // Character before the delimiter run (by code point).
  const beforeRun = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const beforeIsDelimOrPunct =
    beforeRun === '*' || beforeRun === '_' || !!inlineRe.punctuation.exec(beforeRun);
  let prev = prevChar;
  if (runStart < pos) prev = beforeRun;
  const canOpen = runStart < pos ? beforeIsDelimOrPunct : !!inlineRe.punctuation.exec(prev);

  if (cap[4] && prev.match(otherRe.unicodeAlphaNumeric)) return;

  const afterPunct = cap[1] || cap[3] || '';
  if (!afterPunct || !prev || canOpen) {
    const openLen = cpLen(cap[0]) - 1;
    let pending = openLen;
    let skipped = 0;
    const totalOpen = pos - runStart + openLen;
    const ruleOf3Guard =
      !!beforeRun.trim() && (!!afterPunct || (delim === '*' && !beforeIsDelimOrPunct));
    const rdelim = delim === '*' ? inlineRe.emStrongRDelimAst : inlineRe.emStrongRDelimUnd;
    const lastCloser = this.currentScan(masked).lastEmStrong[delim];
    const base = fullLen - src.length + openLen;
    if (lastCloser < base) return;
    const rest = masked.slice(pos + openLen);
    const limit = lastCloser - base;

    let m;
    rdelim.lastIndex = 0;
    while ((m = rdelim.exec(rest)) !== null && !(m.index > limit)) {
      const run = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!run) continue;
      let runLen = cpLen(run);
      if (m[3] || m[4]) {
        pending += runLen;
        continue;
      } else if (m[5] || m[6] || ruleOf3Guard) {
        if (sameAsPrev && (m[5] || m[6])) break;
        if (totalOpen % 3 && !((totalOpen + runLen) % 3)) {
          skipped += runLen;
          continue;
        }
      }
      pending -= runLen;
      if (pending > 0) continue;
      runLen = Math.min(runLen, runLen + pending + skipped);
      const firstCharLen = firstCpLen(m[0]);
      const raw = src.slice(0, openLen + m.index + firstCharLen + runLen);
      if (Math.min(openLen, runLen) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: this.inlineTokens(text) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: this.inlineTokens(text) };
    }
  }
};

Lexer.prototype.tokCodespan = function (src) {
  const cap = inlineRe.code.exec(src);
  if (cap) {
    let text = cap[2].replace(/\n/g, ' ');
    const hasNonSpace = /\S/.test(text);
    const startsSpace = text.startsWith(' ');
    const endsSpace = text.endsWith(' ');
    if (hasNonSpace && startsSpace && endsSpace) {
      text = text.substring(1, text.length - 1);
    }
    return { type: 'codespan', raw: cap[0], text };
  }
};

Lexer.prototype.tokBr = function (src) {
  const cap = inlineRe.br.exec(src);
  if (cap) return { type: 'br', raw: cap[0] };
};

Lexer.prototype.tokDel = function (src, masked, prevChar) {
  const cap = inlineRe.delLDelim.exec(src);
  if (!cap) return;
  if (!(cap[1] || '') || !prevChar || inlineRe.punctuation.exec(prevChar)) {
    const openLen = cpLen(cap[0]) - 1;
    let pending = openLen;
    const lastCloser = this.currentScan(masked).lastDel;
    const pos = masked.length - src.length;
    const base = pos + openLen;
    if (lastCloser < base) return;
    const rest = masked.slice(base);
    const limit = lastCloser - base;

    let m;
    const rdelim = inlineRe.delRDelim;
    rdelim.lastIndex = 0;
    while ((m = rdelim.exec(rest)) !== null && !(m.index > limit)) {
      const run = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!run) continue;
      let runLen = cpLen(run);
      if (runLen !== openLen) continue;
      if (m[3] || m[4]) {
        pending += runLen;
        continue;
      }
      pending -= runLen;
      if (pending > 0) continue;
      runLen = Math.min(runLen, runLen + pending);
      const firstCharLen = firstCpLen(m[0]);
      const raw = src.slice(0, openLen + m.index + firstCharLen + runLen);
      const text = raw.slice(openLen, -openLen);
      return { type: 'del', raw, text, tokens: this.inlineTokens(text) };
    }
  }
};

Lexer.prototype.tokAutolink = function (src) {
  const cap = inlineRe.autolink.exec(src);
  if (cap) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[1];
      href = 'mailto:' + text;
    } else {
      text = cap[1];
      href = text;
    }
    return {
      type: 'link',
      raw: cap[0],
      text,
      href,
      autolink: true,
      tokens: [{ type: 'text', raw: text, text }],
    };
  }
};

Lexer.prototype.tokUrl = function (src) {
  const cap = inlineRe.url.exec(src);
  if (!cap) return;
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prev;
    do {
      prev = cap[0];
      cap[0] = inlineRe.backpedal.exec(cap[0])?.[0] ?? '';
    } while (prev !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + text : text;
  }
  return {
    type: 'link',
    raw: cap[0],
    text,
    href,
    autolink: true,
    tokens: [{ type: 'text', raw: text, text }],
  };
};

// Number of code points in s (the spread [...s].length without allocating).
function cpLen(s) {
  let n = s.length;
  for (let k = 0; k + 1 < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(k + 1);
      if (d >= 0xdc00 && d <= 0xdfff) n--;
    }
  }
  return n;
}

// UTF-16 length of the first code point of s.
function firstCpLen(s) {
  const c = s.charCodeAt(0);
  if (c >= 0xd800 && c <= 0xdbff) {
    const d = s.charCodeAt(1);
    if (d >= 0xdc00 && d <= 0xdfff) return 2;
  }
  return 1;
}

Lexer.prototype.tokInlineText = function (src) {
  const cap = inlineRe.text.exec(src);
  if (cap) {
    const inRaw = this.state.inRawBlock;
    return {
      type: 'text',
      raw: cap[0],
      text: inRaw ? cap[0] : decodeNumericRefs(cap[0]),
      escaped: inRaw,
    };
  }
};

// ---------------------------------------------------------------------------
// Renderer: tokens -> HTML
// ---------------------------------------------------------------------------

function renderCodeBlock(tok) {
  const firstWord = (tok.lang || '').match(/^\S*/)?.[0];
  const body = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
  const escaped = escapeHtml(body, true);
  return firstWord
    ? '<pre><code class="language-' + escapeHtml(firstWord) + '">' + escaped + '</code></pre>\n'
    : '<pre><code>' + escaped + '</code></pre>\n';
}

function renderCheckbox(tok) {
  return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderTable(tok) {
  let headCells = '';
  for (const cell of tok.header) headCells += renderTableCell(cell);
  let out = '<table>\n<thead>\n' + renderTableRow(headCells) + '</thead>\n';
  let body = '';
  for (const row of tok.rows) {
    let cells = '';
    for (const cell of row) cells += renderTableCell(cell);
    body += renderTableRow(cells);
  }
  if (body) out += '<tbody>' + body + '</tbody>';
  return out + '</table>\n';
}

function renderTableRow(cellsHtml) {
  return '<tr>\n' + cellsHtml + '</tr>\n';
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return open + renderInline(cell.tokens) + `</${tag}>\n`;
}

function renderList(list) {
  let items = '';
  for (const item of list.items) items += '<li>' + renderBlocks(item.tokens) + '</li>\n';
  const tag = list.ordered ? 'ol' : 'ul';
  const start = list.ordered && list.start !== 1 ? ' start="' + list.start + '"' : '';
  return '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
}

function renderBlocks(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
      case 'def':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += '<h' + tok.depth + '>' + renderInline(tok.tokens) + '</h' + tok.depth + '>\n';
        break;
      case 'code':
        out += renderCodeBlock(tok);
        break;
      case 'table':
        out += renderTable(tok);
        break;
      case 'blockquote':
        out += '<blockquote>\n' + renderBlocks(tok.tokens) + '</blockquote>\n';
        break;
      case 'list':
        out += renderList(tok);
        break;
      case 'checkbox':
        out += renderCheckbox(tok);
        break;
      case 'html':
        out += tok.text;
        break;
      case 'paragraph':
        out += '<p>' + renderInline(tok.tokens) + '</p>\n';
        break;
      case 'text':
        out += renderTextToken(tok, false);
        break;
      default:
        throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

// Render a text-ish token with the main renderer.
function renderTextToken(tok, asText) {
  if (tok.tokens) return asText ? renderInlineAsText(tok.tokens) : renderInline(tok.tokens);
  if ('escaped' in tok && tok.escaped) return tok.text;
  return escapeHtml(tok.text);
}

function renderInline(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape':
        out += renderTextToken(tok, false);
        break;
      case 'html':
        out += tok.text;
        break;
      case 'link':
        out += renderLink(tok, false);
        break;
      case 'image':
        out += renderImage(tok);
        break;
      case 'checkbox':
        out += renderCheckbox(tok);
        break;
      case 'strong':
        out += '<strong>' + renderInline(tok.tokens) + '</strong>';
        break;
      case 'em':
        out += '<em>' + renderInline(tok.tokens) + '</em>';
        break;
      case 'codespan':
        out += '<code>' + escapeHtml(tok.text, true) + '</code>';
        break;
      case 'br':
        out += '<br>';
        break;
      case 'del':
        out += '<del>' + renderInline(tok.tokens) + '</del>';
        break;
      case 'text':
        out += renderTextToken(tok, false);
        break;
      default:
        throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

// The plain-text renderer used for image alt text: markup contributes only
// its textual content, unescaped.
function renderInlineAsText(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape':
      case 'text':
        out += tok.tokens ? renderInlineAsText(tok.tokens) : tok.text;
        break;
      case 'html':
        out += tok.text;
        break;
      case 'link':
      case 'image':
      case 'strong':
      case 'em':
      case 'del':
        out += tok.tokens ? renderInlineAsText(tok.tokens) : tok.text;
        break;
      case 'codespan':
        out += tok.text;
        break;
      case 'br':
        break;
      case 'checkbox':
        out += tok.raw;
        break;
      default:
        throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

function renderLink(tok, asText) {
  const label = tok.autolink ? escapeHtml(tok.text, true) : renderInline(tok.tokens);
  const href = cleanUrl(tok.href);
  if (href === null) return label;
  let out = '<a href="' + escapeHtml(href, tok.autolink) + '"';
  if (tok.title) out += ' title="' + escapeHtml(tok.title) + '"';
  return out + '>' + label + '</a>';
}

function renderImage(tok) {
  const alt = tok.tokens ? renderInlineAsText(tok.tokens) : tok.text;
  const href = cleanUrl(tok.href);
  if (href === null) return escapeHtml(alt);
  let out = '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(alt) + '"';
  if (tok.title) out += ' title="' + escapeHtml(tok.title) + '"';
  return out + '>';
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  return renderBlocks(tokens);
}
