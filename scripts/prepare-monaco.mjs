import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { patchMonacoSuggest } from './monaco-suggest-patch.mjs'
const target = createRequire(import.meta.url).resolve(
  'monaco-editor/editor/contrib/suggest/browser/suggestModel.js'
)
const source = readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
const patched = patchMonacoSuggest(source)
if (source !== patched) writeFileSync(target, patched)
