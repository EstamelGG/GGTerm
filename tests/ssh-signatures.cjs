const { test } = require('node:test')
const assert = require('node:assert/strict')
const { generateKeyPairSync, sign, verify } = require('node:crypto')
const { sigSSHToASN1, convertSignature } = require('ssh2/lib/protocol/utils')

function pack(parts) {
  return Buffer.concat(
    parts.map((part) => {
      const length = Buffer.alloc(4)
      length.writeUInt32BE(part.length)
      return Buffer.concat([length, part])
    })
  )
}

function unpack(sig) {
  const parts = []
  let pos = 0
  for (let i = 0; i < 2; i++) {
    const length = sig.readUInt32BE(pos)
    pos += 4
    parts.push(sig.subarray(pos, pos + length))
    pos += length
  }
  return parts
}

for (const [curve, type, hash] of [
  ['prime256v1', 'ecdsa-sha2-nistp256', 'sha256'],
  ['secp384r1', 'ecdsa-sha2-nistp384', 'sha384'],
  ['secp521r1', 'ecdsa-sha2-nistp521', 'sha512']
]) {
  test(`${type}: padded device signatures verify without accepting altered data`, () => {
    const keys = generateKeyPairSync('ec', { namedCurve: curve })
    const other = generateKeyPairSync('ec', { namedCurve: curve })
    const data = Buffer.from('SSH exchange hash fixture')
    const der = sign(hash, data, keys.privateKey)
    const ssh = convertSignature(der, type)
    assert.deepEqual(sigSSHToASN1(ssh, type), der)
    for (const count of [1, 2, 8]) {
      const padded = pack(unpack(ssh).map((part) => Buffer.concat([Buffer.alloc(count), part])))
      const normalized = sigSSHToASN1(padded, type)
      assert.deepEqual(normalized, der)
      assert.equal(verify(hash, data, keys.publicKey, normalized), true)
      assert.equal(verify(hash, Buffer.from('altered'), keys.publicKey, normalized), false)
      assert.equal(verify(hash, data, other.publicKey, normalized), false)
    }
  })
}

test('normalization preserves necessary sign bytes and integer values', () => {
  const type = 'ecdsa-sha2-nistp521'
  const canonical = pack([Buffer.from([0, 0x80]), Buffer.from([0x7f])])
  const padded = pack([Buffer.from([0, 0, 0x80]), Buffer.from([0, 0, 0x7f])])
  assert.deepEqual(sigSSHToASN1(padded, type), sigSSHToASN1(canonical, type))
  assert.notDeepEqual(
    sigSSHToASN1(pack([Buffer.from([0x80]), Buffer.from([0x7f])]), type),
    sigSSHToASN1(canonical, type)
  )
})

test('truncated ECDSA signatures remain rejected', () => {
  assert.equal(sigSSHToASN1(Buffer.from([0, 0, 0, 5, 1]), 'ecdsa-sha2-nistp521'), undefined)
})
