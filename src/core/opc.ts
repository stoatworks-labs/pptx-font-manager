import { walkTags } from './xml'

/**
 * Open Packaging Conventions plumbing shared by the font and media scanners:
 * where a part's relationships live and how their targets resolve.
 */

export interface Relationship {
  id: string
  /** The last path segment of the Type URI: `slideLayout`, `video`, `hyperlink`. */
  type: string
  /**
   * For an internal target, the resolved part path (`ppt/media/media1.mp4`).
   * For an external one, the Target exactly as written — a URL or file path.
   */
  target: string
  external: boolean
}

/** `ppt/slides/slide1.xml` -> `ppt/slides/_rels/slide1.xml.rels` */
export function relsPathFor(part: string): string {
  const slash = part.lastIndexOf('/')
  const dir = slash === -1 ? '' : part.slice(0, slash)
  const file = slash === -1 ? part : part.slice(slash + 1)
  return `${dir}/_rels/${file}.rels`
}

export function parseRels(xml: string, part: string): Relationship[] {
  const slash = part.lastIndexOf('/')
  const dir = slash === -1 ? '' : part.slice(0, slash)
  const out: Relationship[] = []
  for (const tag of walkTags(xml)) {
    if (tag.local !== 'Relationship' || tag.close) continue
    const target = tag.attrs.Target
    const type = tag.attrs.Type ?? ''
    if (!target) continue
    const external = tag.attrs.TargetMode === 'External'
    out.push({
      id: tag.attrs.Id ?? '',
      type: type.slice(type.lastIndexOf('/') + 1),
      target: external ? target : resolvePath(dir, target),
      external,
    })
  }
  return out
}

/** Resolve a rels Target (often `../theme/theme1.xml`) against its part's dir. */
export function resolvePath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const stack = baseDir ? baseDir.split('/') : []
  for (const seg of target.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') stack.pop()
    else stack.push(seg)
  }
  return stack.join('/')
}
