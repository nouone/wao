// probe/pagegate.mjs - mandatory gate for edits to src/main/local-chat-api/web-ui.ts.
//
// web-ui.ts holds the entire phone page inside one TypeScript template
// literal, so the bytes the browser receives differ from the bytes in the
// file. Two incident classes this gate exists for:
//   1. A LONE backslash in the template source is consumed by the template
//      (e.g. /\/(png|jpeg)/ arrives as /./(png|jpeg)/). Every backslash that
//      must survive is written doubled, so the rule is: backslash counts
//      inside the template must all be even runs.
//   2. createScriptProcessor buffer sizes must be a power of two >= 256
//      (160 crashed Safari).
// The gate compiles the PROCESSED script (what the browser actually gets),
// then checks both rules plus the mangled-regex signature of past incidents.
//
// Recovered 2026-11-25: the original webuiproc4.mjs/escscan.mjs lived in
// C:\Data\Resume\Interview Prep\cbl-voice\probe, which no longer exists on
// this machine. Paths are now relative to the repo, and the gate is a single
// file with a non-zero exit on failure.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(here, '..', 'src', 'main', 'local-chat-api', 'web-ui.ts')
const src = fs.readFileSync(file, 'utf8')

const marker = 'export const LOCAL_CHAT_WEB_UI = '
const start = src.indexOf(marker)
if (start < 0) {
  console.log('GATE FAIL: template export not found')
  process.exit(1)
}

// The template interpolates paletteCss(theme), which lives in web-ui.ts
// itself. Provide the same helper + palette here so the eval below matches
// what the module produces (theme-colors is plain enough to inline).
import { readFileSync as readFs } from 'node:fs'
const tc = readFs(path.join(here, '..', 'src', 'shared', 'theme-colors.ts'), 'utf8')
const paletteMatch = tc.match(/export const LAMINA_PALETTE = \{[\s\S]*?\n\}/m)
if (!paletteMatch) {
  console.log('GATE FAIL: LAMINA_PALETTE not found in theme-colors.ts (gate needs updating)')
  process.exit(1)
}
let palette
try {
  palette = eval('(' + paletteMatch[0].replace('export const LAMINA_PALETTE = ', '') + ')')
} catch (error) {
  console.log('GATE FAIL: palette does not evaluate:', error.message)
  process.exit(1)
}
const LAMINA_PALETTE = palette
const paletteCss = (theme) =>
  Object.entries(palette[theme])
    .map(([name, value]) => `--lc-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${value}`)
    .join(';')

let html
try {
  html = eval(src.slice(start + marker.length))
} catch (error) {
  console.log('GATE FAIL: template does not evaluate:', error.message)
  process.exit(1)
}

const script = html.match(/<script>([\s\S]*)<\/script>/)[1]
let bad = 0

// 1. the served script must parse
try {
  new Function(script)
  console.log('processed script compiles OK, length', script.length)
} catch (error) {
  console.log('COMPILE FAIL:', error.message)
  bad++
}

// 2. ScriptProcessor buffer must be a power of two >= 256
const buffer = /createScriptProcessor\((\d+)/.exec(script)
if (buffer) {
  const size = Number(buffer[1])
  const ok = size >= 256 && (size & (size - 1)) === 0
  console.log('createScriptProcessor buffer:', buffer[1], ok ? '(power of two, OK)' : '(BAD)')
  if (!ok) bad++
} else {
  console.log('createScriptProcessor: not present (streaming worklet path)')
}

// 3. frame accumulator (the 160-samples-per-frame contract with the desktop
//    endpointer) must still be there while the legacy VAD exists
if (script.includes('createScriptProcessor')) {
  console.log('accumulator present:', script.includes('pendLen'))
}

// 4. backslash parity: inside the template, odd-length runs mean a lone
//    backslash was eaten by the template before the browser saw it
const templateBody = src.slice(start + marker.length, src.lastIndexOf('`'))
const oddRuns = []
const runRe = /\\+/g
let match
while ((match = runRe.exec(templateBody))) {
  if (match[0].length % 2 === 1) {
    const line = templateBody.slice(0, match.index).split('\n').length
    oddRuns.push(`${line}: ${JSON.stringify(templateBody.slice(Math.max(0, match.index - 40), match.index + 40))}`)
  }
}
console.log('lone backslashes in template source (must be 0):', oddRuns.length)
oddRuns.forEach((r) => console.log('  ' + r))
if (oddRuns.length) bad++

// 5. mangled-regex signature: a character class that opens with a bare slash
//    is what "/\/(" looks like AFTER the template ate the escape. The
//    intentional form is "[/]" (a class containing a slash), which is fine.
const mangled = script.match(/\/[^/\n]*\[(?:\/[^\]]*[^}\]])/g) || []
console.log('suspect regexes in processed page:', mangled.length ? mangled.join(' , ') : 'none')
if (mangled.length) bad++

if (bad) {
  console.log('GATE FAILED:', bad, 'problem(s)')
  process.exit(1)
}
console.log('GATE OK')
