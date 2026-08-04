/**
 * Minimal XML tag tokenizer.
 *
 * Why not DOMParser: this core has to run unchanged in three places — the
 * browser, vitest under the `node` environment, and (later) the Tauri desktop
 * port. DOMParser only exists in one of them. Everything we need out of
 * OOXML is attribute values plus enough nesting awareness to tell
 * `<a:majorFont><a:latin/>` from `<a:minorFont><a:latin/>`, which does not
 * justify a real XML parser.
 *
 * Deliberately NOT a general XML parser. It does not resolve entities beyond
 * the five predefined ones, does not validate, and does not build a tree.
 */

export interface XmlTag {
  /** Qualified name as written, e.g. `a:latin`. */
  name: string
  /** Local name with any prefix stripped, e.g. `latin`. */
  local: string
  attrs: Record<string, string>
  /** True for `</a:p>`. */
  close: boolean
  /** True for `<a:latin/>`. */
  selfClose: boolean
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body] ?? whole
  })
}

const ATTR_RE = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  ATTR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ATTR_RE.exec(src)) !== null) {
    const key = m[1] ?? m[3]
    const val = m[2] ?? m[4]
    if (key !== undefined) attrs[key] = decodeEntities(val ?? '')
  }
  return attrs
}

/**
 * Walk every element tag in `xml`, in document order.
 *
 * Comments, CDATA sections, processing instructions and the DOCTYPE are
 * skipped rather than emitted — OOXML parts contain an XML declaration and
 * occasionally comments, and treating `<?xml ...?>` as an element would put a
 * bogus frame on the nesting stack.
 */
export function* walkTags(xml: string): Generator<XmlTag> {
  let i = 0
  const n = xml.length
  while (i < n) {
    const lt = xml.indexOf('<', i)
    if (lt === -1) return
    // <!-- comment -->, <![CDATA[...]]>, <!DOCTYPE ...>
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      i = end === -1 ? n : end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      i = end === -1 ? n : end + 3
      continue
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    if (xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt + 2)
      i = end === -1 ? n : end + 1
      continue
    }

    // Find the closing '>' that is not inside a quoted attribute value.
    let j = lt + 1
    let quote: string | null = null
    for (; j < n; j++) {
      const c = xml[j]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'") {
        quote = c
      } else if (c === '>') {
        break
      }
    }
    if (j >= n) return

    let body = xml.slice(lt + 1, j)
    const close = body[0] === '/'
    if (close) body = body.slice(1)
    const selfClose = body.endsWith('/')
    if (selfClose) body = body.slice(0, -1)

    const sp = body.search(/[\s]/)
    const name = (sp === -1 ? body : body.slice(0, sp)).trim()
    if (name) {
      const colon = name.indexOf(':')
      yield {
        name,
        local: colon === -1 ? name : name.slice(colon + 1),
        attrs: sp === -1 ? {} : parseAttrs(body.slice(sp)),
        close,
        selfClose,
      }
    }
    i = j + 1
  }
}
