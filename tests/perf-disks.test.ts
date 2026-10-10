import { expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
vi.mock('electron', () => ({ app: {}, dialog: {}, shell: {}, utilityProcess: { fork: vi.fn() } }))
vi.mock('../src/main/log', () => ({ appLog: vi.fn() }))
import { buildDisks } from '../src/main/ssh/perf'
import { PERF_SCRIPT } from '../src/main/ssh/remoteScripts'
const boot = { device: 'sda2', fstype: 'ext4', size: 2000, used: 259, avail: 1600, mount: '/boot' }
const root = {
  device: 'mapper/ubuntu--vg-ubuntu--lv',
  fstype: 'ext4',
  size: 194000,
  used: 29000,
  avail: 156000,
  mount: '/'
}
it('includes boot, nested LVM root, and filesystems directly on a disk', () => {
  const disk = buildDisks(
    [
      { name: 'sda', type: 'disk', pkname: '', size: 250000, mount: '' },
      { name: 'sda2', type: 'part', pkname: 'sda', size: 2000, mount: '/boot' },
      { name: 'sda3', type: 'part', pkname: 'sda', size: 248000, mount: '' },
      { name: 'ubuntu--vg-ubuntu--lv', type: 'lvm', pkname: 'sda3', size: 194000, mount: '/' },
      { name: 'sdb', type: 'disk', pkname: '', size: 500000, mount: '/data' }
    ],
    [boot, root, { ...root, device: 'sdb', mount: '/data' }],
    {},
    null,
    0
  )
  expect(disk[0].mounts.map((item) => item.mount)).toEqual(['/boot', '/'])
  expect(disk[1].mounts[0].mount).toBe('/data')
})
it('keeps device-backed volumes when lsblk has no corresponding nodes', () => {
  expect(buildDisks([], [root], {}, null, 0)[0].mounts[0]).toMatchObject(root)
})
it('collects mapper filesystems without depending on lsblk mountpoint output', () => {
  const line = PERF_SCRIPT.split('\n').find((line) => line.startsWith('df -PTk'))!
  const program = line.split("awk '")[1].slice(0, -1)
  const result = execFileSync('awk', [program], {
    input:
      'Filesystem Type 1024-blocks Used Available Capacity Mounted on\n/dev/mapper/ubuntu--vg-ubuntu--lv ext4 194000 29000 156000 16% /\ntmpfs tmpfs 100 0 100 0% /run\n/dev/sda2 ext4 2000 259 1600 15% /boot\n',
    encoding: 'utf8'
  })
  expect(result).toContain('F /dev/mapper/ubuntu--vg-ubuntu--lv ext4 194000 29000 156000 /')
  expect(result).toContain('F /dev/sda2')
  expect(result).not.toContain('tmpfs')
})
