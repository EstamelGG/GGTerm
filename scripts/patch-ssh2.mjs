import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// ssh2#1473: some devices pad ECDSA mpints with redundant zero bytes.
// Preserve integer values and signature verification; only canonicalize DER.
const target = join(dirname(require.resolve('ssh2/package.json')), 'lib/protocol/utils.js')
const before = `        const r = utilBufferParser.readString();
        const s = utilBufferParser.readString();
        utilBufferParser.clear();
        if (r === undefined || s === undefined)
          return;

        const asnWriter = new Ber.Writer();`
const after = `        let r = utilBufferParser.readString();
        let s = utilBufferParser.readString();
        utilBufferParser.clear();
        if (r === undefined || s === undefined)
          return;

        // ATerminal: canonicalize ECDSA mpints (ssh2#1473).
        // Keep the sign byte when the next byte has its high bit set.
        while (r.length > 1 && r[0] === 0 && !(r[1] & 0x80))
          r = r.subarray(1);
        while (s.length > 1 && s[0] === 0 && !(s[1] & 0x80))
          s = s.subarray(1);

        const asnWriter = new Ber.Writer();`

const source = readFileSync(target, 'utf8')
if (source.includes(after)) {
  console.log('ssh2 ECDSA compatibility patch already applied')
} else {
  if (source.split(before).length !== 2) {
    throw new Error('ssh2 ECDSA patch target changed; review upstream before updating this patch')
  }
  writeFileSync(target, source.replace(before, after))
  console.log('Applied ssh2 ECDSA compatibility patch')
}
