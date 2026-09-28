#!/usr/bin/env node
/**
 * Build test/fixtures/media.pptx: a small deck holding every shape of video
 * and sound the media scanner has to tell apart.
 *
 * Needs ffmpeg on PATH to make the clips (tiny: 64×36, a handful of frames).
 * The result is committed, so the test suite does not need ffmpeg.
 *
 * The slide XML copies what PowerPoint actually writes, taken from real decks:
 * an embedded video is `<a:videoFile r:link>` AND `<p14:media r:embed>`, two
 * relationships to the same file, and the media is stored uncompressed.
 *
 * Show order deliberately differs from file order (slide3.xml is shown
 * first), because "slide 5" means the fifth slide shown, not slide5.xml.
 *
 *   node scripts/make-media-deck.mjs
 */
import { zipSync, strToU8 } from 'fflate'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures')
const work = mkdtempSync(join(tmpdir(), 'media-deck-'))

const SRC = ['-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=25:duration=0.2']
const TONE = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2']

function clip(name, args) {
  const out = join(work, name)
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args, out])
  return new Uint8Array(readFileSync(out))
}

const media = {
  // The one PowerPoint recommends: H.264 High, 8-bit 4:2:0, AAC.
  'media1.mp4': clip('good.mp4', [...SRC, ...TONE, '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']),
  // A camera/editing format no player in PowerPoint decodes.
  'media2.mp4': clip('high10.mp4', [...SRC, '-c:v', 'libx264', '-profile:v', 'high10', '-pix_fmt', 'yuv420p10le']),
  // HEVC tagged hev1 — Windows needs an extension, the Mac refuses the tag.
  'media3.mp4': clip('hev1.mp4', [...SRC, '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-tag:v', 'hev1', '-x265-params', 'log-level=error']),
  'media4.mov': clip('prores.mov', [...SRC, '-c:v', 'prores_ks', '-profile:v', '2']),
  'media5.wmv': clip('old.wmv', [...SRC, '-c:v', 'wmv2']),
  'media6.mp3': clip('sound.mp3', [...TONE, '-c:a', 'libmp3lame']),
  // On a layout: plays on every slide built from it.
  'media7.mp4': clip('layout.mp4', [...SRC, '-c:v', 'libx264', '-pix_fmt', 'yuv420p']),
}
rmSync(work, { recursive: true, force: true })

const NS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`
const P14 = 'xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"'
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const MS = 'http://schemas.microsoft.com/office/2007/relationships'

const title = (text) => `<p:sp><p:nvSpPr><p:cNvPr id="90" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`

/** A video or audio shape the way PowerPoint writes it. */
const mediaPic = (id, name, { tag = 'videoFile', link, embed, trim, webHtml }) => `<p:pic>
<p:nvPicPr><p:cNvPr id="${id}" name="${name}"><a:hlinkClick r:id="" action="ppaction://media"/></p:cNvPr><p:cNvPicPr/>
<p:nvPr><a:${tag} r:link="${link}"/>${
  embed || trim || webHtml
    ? `<p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media ${P14} ${embed ? `r:embed="${embed}"` : `r:link="${link}"`}>${
        trim ? `<p14:trim st="${trim[0]}" end="${trim[1]}"/>` : ''
      }</p14:media></p:ext>${
        webHtml ? `<p:ext uri="{C809E66F-F1BF-436E-B5F7-EEA9579F0CBA}"><p15:webVideoPr xmlns:p15="http://schemas.microsoft.com/office/powerpoint/2012/main" embeddedHtml="${webHtml}" h="315" w="560"/></p:ext>` : ''
      }</p:extLst>`
    : ''
}</p:nvPr></p:nvPicPr><p:blipFill/><p:spPr/></p:pic>`

/** The timing node PowerPoint writes for a clip that starts on its own. */
const autoplay = (spid, { loop = false, fullScreen = false, vol = 80000, mute = false, hide = false } = {}) => `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>
<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst><p:par><p:cTn id="3" fill="hold"><p:childTnLst><p:par><p:cTn id="4" fill="hold"><p:childTnLst>
<p:par><p:cTn id="5" presetID="1" presetClass="mediacall" presetSubtype="0" fill="hold" nodeType="afterEffect"><p:childTnLst>
<p:cmd type="call" cmd="playFrom(0.0)"><p:cBhvr><p:cTn id="6" dur="1000" fill="hold"/><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cBhvr></p:cmd>
</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:seq>
<p:video${fullScreen ? ' fullScrn="1"' : ''}><p:cMediaNode vol="${vol}"${mute ? ' mute="1"' : ''}${hide ? ' showWhenStopped="0"' : ''}><p:cTn id="7"${loop ? ' repeatCount="indefinite"' : ''} fill="hold" display="0"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cMediaNode></p:video>
</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`

const slide = (body, { hidden = false, timing = '' } = {}) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${NS}${hidden ? ' show="0"' : ''}><p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
${body}
</p:spTree></p:cSld>${timing}</p:sld>`

const rels = (entries) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${entries
  .map(([id, type, target, external]) => {
    const uri = type === 'media' ? `${MS}/media` : type.startsWith('http') ? type : `${OFFICE}/${type}`
    return `<Relationship Id="${id}" Type="${uri}" Target="${target.replaceAll('&', '&amp;')}"${external ? ' TargetMode="External"' : ''}/>`
  })
  .join('\n')}
</Relationships>`

const layoutRel = ['rIdL', 'slideLayout', '../slideLayouts/slideLayout1.xml']
const layout2Rel = ['rIdL', 'slideLayout', '../slideLayouts/slideLayout2.xml']

const YT = 'https://www.youtube.com/embed/aqz-KE-bpKQ?feature=oembed'
const iframe = `&lt;iframe width=&quot;560&quot; height=&quot;315&quot; src=&quot;${YT}&quot; frameborder=&quot;0&quot; allowfullscreen&gt;&lt;/iframe&gt;`
const STREAM = 'https://contoso.sharepoint.com/sites/comms/_layouts/15/stream.aspx?id=%2Fsites%2Fcomms%2FShared%20Documents%2Ftownhall.mp4'

const files = {
  '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="mp4" ContentType="video/mp4"/>
<Default Extension="mov" ContentType="video/quicktime"/>
<Default Extension="wmv" ContentType="video/x-ms-wmv"/>
<Default Extension="mp3" ContentType="audio/mpeg"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>`,
  '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),

  'ppt/presentation.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation ${NS}>
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>
<p:sldId id="256" r:id="rId4"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId3"/>
<p:sldId id="259" r:id="rId5"/><p:sldId id="260" r:id="rId6"/><p:sldId id="261" r:id="rId7"/>
<p:sldId id="262" r:id="rId8"/><p:sldId id="263" r:id="rId9"/>
</p:sldIdLst>
</p:presentation>`,
  'ppt/_rels/presentation.xml.rels': rels([
    ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
    ['rId2', 'slide', 'slides/slide1.xml'],
    ['rId3', 'slide', 'slides/slide2.xml'],
    ['rId4', 'slide', 'slides/slide3.xml'],
    ['rId5', 'slide', 'slides/slide4.xml'],
    ['rId6', 'slide', 'slides/slide5.xml'],
    ['rId7', 'slide', 'slides/slide6.xml'],
    ['rId8', 'slide', 'slides/slide7.xml'],
    ['rId9', 'slide', 'slides/slide8.xml'],
  ]),

  // Shown 1st: the good clip, trimmed, looping, full screen, starting by itself.
  'ppt/slides/slide3.xml': slide(title('Welcome &amp; intro') + mediaPic(4, 'Intro film.mp4', { link: 'rId2', embed: 'rId1', trim: ['1500', '250.5'] }), {
    timing: autoplay(4, { loop: true, fullScreen: true, vol: 50000, hide: true }),
  }),
  'ppt/slides/_rels/slide3.xml.rels': rels([
    ['rId1', 'media', '../media/media1.mp4'],
    ['rId2', 'video', '../media/media1.mp4'],
    layoutRel,
  ]),

  // Shown 2nd: the same file reused, beside a 10-bit clip. No timing, so the
  // only way to start either is to click it.
  'ppt/slides/slide1.xml': slide(mediaPic(4, 'Intro again', { link: 'rId2', embed: 'rId1' }) + mediaPic(5, 'Camera original', { link: 'rId4', embed: 'rId3' })),
  'ppt/slides/_rels/slide1.xml.rels': rels([
    ['rId1', 'media', '../media/media1.mp4'],
    ['rId2', 'video', '../media/media1.mp4'],
    ['rId3', 'media', '../media/media2.mp4'],
    ['rId4', 'video', '../media/media2.mp4'],
    layoutRel,
  ]),

  // Shown 3rd: an online YouTube video, a hyperlink to Vimeo, and a hyperlink
  // to an ordinary web page (which is not media and must not be reported).
  'ppt/slides/slide2.xml': slide(
    mediaPic(4, 'YouTube video', { link: 'rId2', webHtml: iframe }) +
      `<p:sp><p:nvSpPr><p:cNvPr id="5" name="Links"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p>
<a:r><a:rPr><a:hlinkClick r:id="rId3"/></a:rPr><a:t>Watch on Vimeo</a:t></a:r>
<a:r><a:rPr><a:hlinkClick r:id="rId4"/></a:rPr><a:t>Our website</a:t></a:r></a:p></p:txBody></p:sp>`,
  ),
  'ppt/slides/_rels/slide2.xml.rels': rels([
    ['rId2', 'video', YT, true],
    ['rId3', 'hyperlink', 'https://vimeo.com/76979871', true],
    ['rId4', 'hyperlink', 'https://example.com/about', true],
    layoutRel,
  ]),

  // Shown 4th: already hidden; a video linked from the author's disk.
  'ppt/slides/slide4.xml': slide(mediaPic(4, 'Linked clip', { link: 'rId2' }), { hidden: true }),
  'ppt/slides/_rels/slide4.xml.rels': rels([
    ['rId2', 'video', 'file:///C:\\Users\\presenter\\Videos\\walkout.mp4', true],
    layoutRel,
  ]),

  // Shown 5th: Stream on SharePoint, a Flash control, and a web add-in.
  'ppt/slides/slide5.xml': slide(
    mediaPic(4, 'Town hall', { link: 'rId2' }) +
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="Web Viewer"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/>
<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/webextensions/webextension/2010/11"><we:webextensionref xmlns:we="http://schemas.microsoft.com/office/webextensions/webextension/2010/11" r:id="rId4"/></a:graphicData></a:graphic></p:graphicFrame>
<p:controls><p:control spid="7" name="ShockwaveFlash1" r:id="rId3" imgW="100" imgH="100"/></p:controls>`,
  ),
  'ppt/slides/_rels/slide5.xml.rels': rels([
    ['rId2', 'video', STREAM, true],
    ['rId3', 'control', '../activeX/activeX1.xml'],
    ['rId4', 'http://schemas.microsoft.com/office/2011/relationships/webextension', '../webextensions/webextension1.xml'],
    layoutRel,
  ]),
  'ppt/activeX/activeX1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<ax:ocx ax:classid="{D27CDB6E-AE6D-11CF-96B8-444553540000}" ax:persistence="persistPropertyBag" xmlns:ax="http://schemas.microsoft.com/office/2006/activeX" xmlns:r="${OFFICE}">
<ax:ocxPr ax:name="_cx" ax:value="4000"/><ax:ocxPr ax:name="Movie" ax:value="http://www.youtube.com/v/aqz-KE-bpKQ"/></ax:ocx>`,
  'ppt/webextensions/webextension1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<we:webextension xmlns:we="http://schemas.microsoft.com/office/webextensions/webextension/2010/11" id="{11111111-2222-3333-4444-555555555555}">
<we:reference id="wa104295828" version="1.0.0.0" store="en-US" storeType="OMEX"/>
<we:properties><we:property name="url" value="&quot;https://player.vimeo.com/video/76979871&quot;"/></we:properties>
</we:webextension>`,

  // Shown 6th: sound, and three clips in formats that fail somewhere.
  'ppt/slides/slide6.xml': slide(
    mediaPic(4, 'Walk-in music', { tag: 'audioFile', link: 'rId2', embed: 'rId1' }) +
      mediaPic(5, 'Old WMV', { link: 'rId4', embed: 'rId3' }) +
      mediaPic(6, 'HEVC export', { link: 'rId6', embed: 'rId5' }) +
      mediaPic(7, 'ProRes master', { link: 'rId8', embed: 'rId7' }),
  ),
  'ppt/slides/_rels/slide6.xml.rels': rels([
    ['rId1', 'media', '../media/media6.mp3'],
    ['rId2', 'audio', '../media/media6.mp3'],
    ['rId3', 'media', '../media/media5.wmv'],
    ['rId4', 'video', '../media/media5.wmv'],
    ['rId5', 'media', '../media/media3.mp4'],
    ['rId6', 'video', '../media/media3.mp4'],
    ['rId7', 'media', '../media/media4.mov'],
    ['rId8', 'video', '../media/media4.mov'],
    layoutRel,
  ]),

  // Shown 7th and 8th: nothing on the slide; the video is on its layout.
  'ppt/slides/slide7.xml': slide(title('Section break')),
  'ppt/slides/_rels/slide7.xml.rels': rels([layout2Rel]),
  'ppt/slides/slide8.xml': slide(title('Second section')),
  'ppt/slides/_rels/slide8.xml.rels': rels([layout2Rel]),

  'ppt/slideLayouts/slideLayout1.xml': slide(''),
  'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
  'ppt/slideLayouts/slideLayout2.xml': slide(mediaPic(3, 'Background loop', { link: 'rId2', embed: 'rId3' })),
  'ppt/slideLayouts/_rels/slideLayout2.xml.rels': rels([
    ['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml'],
    ['rId2', 'video', '../media/media7.mp4'],
    ['rId3', 'media', '../media/media7.mp4'],
  ]),
  'ppt/slideMasters/slideMaster1.xml': slide(''),
  'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([['rId1', 'theme', '../theme/theme1.xml']]),
  'ppt/theme/theme1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Test"><a:themeElements><a:fontScheme name="Test">
<a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont>
</a:fontScheme></a:themeElements></a:theme>`,
}

const entries = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))
// Stored, as PowerPoint stores media.
for (const [name, data] of Object.entries(media)) entries[`ppt/media/${name}`] = [data, { level: 0 }]

mkdirSync(outDir, { recursive: true })
const zip = zipSync(entries, { level: 9 })
const out = join(outDir, 'media.pptx')
writeFileSync(out, zip)
console.log(`Wrote ${out} (${zip.length} bytes, ${Object.keys(media).length} clips)`)
