// Small Markdown helpers shared by gen-pages and check-dashboard (no dependencies).

/** Parse a flat YAML-ish frontmatter block (`key: value` strings only). Returns { data, body }. */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    data[kv[1]] = v;
  }
  return { data, body: text.slice(m[0].length) };
}

/** GitHub-style heading slug (lowercase, punctuation dropped, spaces to hyphens). */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** All heading slugs in a Markdown body (outside code fences). */
export function headingSlugs(body) {
  const slugs = new Set();
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) slugs.add(slugify(h[1]));
  }
  return slugs;
}

/** Title: frontmatter title, else the first `# ` heading, else the file name in Title Case. */
export function deriveTitle(data, body, fallbackName) {
  if (data.title) return data.title;
  const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  if (h1) return h1[1].replace(/[`*_]/g, '');
  return titleCase(fallbackName);
}

export function titleCase(slug) {
  return slug.replace(/^\d+[-_.]?/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim() || slug;
}

/** Drop the first `# ` heading (Starlight renders the frontmatter title). */
export function stripFirstH1(body) {
  return body.replace(/^#\s+.+\r?\n+/m, '');
}

/** One-line description: frontmatter summary/description, else the first paragraph, clipped. */
export function deriveDescription(data, body, max = 160) {
  let text = data.description || data.summary || '';
  if (!text) {
    const para = body
      .split(/\r?\n\r?\n/)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith('#') && !p.startsWith('```') && !p.startsWith('<') && !p.startsWith('|') && !p.startsWith('!['));
    text = (para ?? '').replace(/\s+/g, ' ');
  }
  text = text.replace(/\[src:[^\]]*\]/g, '').replace(/[`*_#]/g, '').replace(/\s+/g, ' ').trim();
  if (text.length > max) text = `${text.slice(0, max - 3).replace(/\s+\S*$/, '')}...`;
  return text;
}

/** Escape a raw `<tag` outside backtick spans so Markdown never swallows it as HTML. */
export function escapeHtml(line) {
  return line
    .split(/(`[^`]*`)/)
    .map((part) => (part.startsWith('`') ? part : part.replace(/<(?=[A-Za-z/!])/g, '&lt;')))
    .join('');
}

/** Apply `fn(line)` to every line outside code fences. */
export function mapOutsideFences(body, fn) {
  let inFence = false;
  return body
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : fn(line);
    })
    .join('\n');
}

/** YAML frontmatter block; every value is JSON-quoted, so colons and quotes are always safe. */
export function frontmatter(fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const [k2, v2] of Object.entries(v)) lines.push(`  ${k2}: ${JSON.stringify(v2)}`);
    } else lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}
