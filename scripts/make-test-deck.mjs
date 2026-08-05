#!/usr/bin/env node
/**
 * Build a small synthetic .pptx for the test suite.
 *
 * The other fixtures are real presentations and are gitignored because they
 * are private, which means a clean clone runs a suite that skips nearly
 * everything. This one is generated, contains no one's content, and is
 * committed — so the scanner's behaviour is actually tested in CI.
 *
 * It deliberately reproduces the shapes that matter:
 *
 *   - a theme with a **script fallback table**, the thing that inflates a
 *     naive scan from 3 fonts to 30-odd;
 *   - slide text that names no font at all and resolves through `+mn-lt`;
 *   - a face name with a style suffix (`Lobster Two Bold`);
 *   - a font on an unused layout, which must land in the `elsewhere` tier.
 *
 *   node scripts/make-test-deck.mjs
 */
import { zipSync, strToU8 } from 'fflate'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures')

/** The ~30 fonts every Office theme lists as script fallbacks. Pure noise. */
const FALLBACKS = [
  ['Jpan', 'Yu Gothic'],
  ['Hang', 'Malgun Gothic'],
  ['Hans', 'DengXian'],
  ['Hant', 'Microsoft JhengHei'],
  ['Arab', 'Times New Roman'],
  ['Hebr', 'Times New Roman'],
  ['Thai', 'Angsana New'],
  ['Ethi', 'Nyala'],
  ['Beng', 'Vrinda'],
  ['Gujr', 'Shruti'],
  ['Khmr', 'MoolBoran'],
  ['Knda', 'Tunga'],
  ['Guru', 'Raavi'],
  ['Cans', 'Euphemia'],
  ['Cher', 'Plantagenet Cherokee'],
  ['Yiii', 'Microsoft Yi Baiti'],
  ['Tibt', 'Microsoft Himalaya'],
  ['Thaa', 'MV Boli'],
  ['Deva', 'Mangal'],
  ['Telu', 'Gautami'],
  ['Taml', 'Latha'],
  ['Syrc', 'Estrangelo Edessa'],
  ['Orya', 'Kalinga'],
  ['Mlym', 'Kartika'],
  ['Laoo', 'DokChampa'],
  ['Sinh', 'Iskoola Pota'],
  ['Mong', 'Mongolian Baiti'],
  ['Viet', 'Times New Roman'],
  ['Uigh', 'Microsoft Uighur'],
  ['Geor', 'Sylfaen'],
]

const fallbackXml = FALLBACKS.map(([s, t]) => `<a:font script="${s}" typeface="${t}"/>`).join('')

const theme = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Test">
<a:themeElements>
<a:fontScheme name="Test">
<a:majorFont><a:latin typeface="Bebas Neue"/><a:ea typeface=""/><a:cs typeface=""/>${fallbackXml}</a:majorFont>
<a:minorFont><a:latin typeface="Lato"/><a:ea typeface=""/><a:cs typeface=""/>${fallbackXml}</a:minorFont>
</a:fontScheme>
</a:themeElements>
</a:theme>`

/** A run with an explicit typeface. */
const run = (text, typeface) =>
  `<a:r><a:rPr lang="en-GB"${typeface ? '' : ''}>${
    typeface ? `<a:latin typeface="${typeface}"/><a:cs typeface="${typeface}"/>` : '<a:latin typeface="+mn-lt"/>'
  }</a:rPr><a:t>${text}</a:t></a:r>`

const shape = (id, name, runs) => `<p:sp>
<p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p>${runs}</a:p></p:txBody>
</p:sp>`

const slide = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
${body}
</p:spTree></p:cSld></p:sld>`

const rels = (entries) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join('')}
</Relationships>`

const files = {
  '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>`,

  '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),

  'ppt/presentation.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>
</p:presentation>`,

  'ppt/_rels/presentation.xml.rels': rels([
    ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
    ['rId2', 'slide', 'slides/slide1.xml'],
  ]),

  // Slide 1: one run naming a Google font that is almost never installed,
  // one naming a face with a style suffix, and one inheriting via +mn-lt.
  'ppt/slides/slide1.xml': slide(
    shape(2, 'Title', run('Heading', 'Lobster')) +
      shape(3, 'Sub', run('Subtitle', 'Lobster Two Bold')) +
      shape(4, 'Body', run('Inherited body text', null)),
  ),
  'ppt/slides/_rels/slide1.xml.rels': rels([
    ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
  ]),

  'ppt/slideLayouts/slideLayout1.xml': slide(shape(2, 'Ph', run('Layout', 'Lato'))),
  'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([
    ['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml'],
  ]),

  // A layout no slide references — its font must be reported as `elsewhere`.
  'ppt/slideLayouts/slideLayout2.xml': slide(shape(2, 'Ph', run('Unused', 'Courier New'))),
  'ppt/slideLayouts/_rels/slideLayout2.xml.rels': rels([
    ['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml'],
  ]),

  'ppt/slideMasters/slideMaster1.xml': slide(shape(2, 'Ph', run('Master', 'Bebas Neue'))),
  'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([
    ['rId1', 'theme', '../theme/theme1.xml'],
    ['rId2', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
    ['rId3', 'slideLayout', '../slideLayouts/slideLayout2.xml'],
  ]),

  'ppt/theme/theme1.xml': theme,
}

mkdirSync(outDir, { recursive: true })
const zip = zipSync(
  Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])),
  { level: 9 },
)
const out = join(outDir, 'synthetic.pptx')
writeFileSync(out, zip)
console.log(`Wrote ${out} (${zip.length} bytes, ${FALLBACKS.length} fallback fonts embedded)`)
