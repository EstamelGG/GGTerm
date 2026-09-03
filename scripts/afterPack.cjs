'use strict'

/**
 * electron-builder `afterPack` 钩子 —— 执行时机：打包完成之后、代码签名之前。
 *
 * 时序由 app-builder-lib `PlatformPackager.pack()` 保证：
 *   emitAfterPack  →  doAddElectronFuses  →  doSignAfterPack
 * 必须在签名前改二进制，因为签名覆盖 Mach-O 内容；改完由 electron-builder 统一重签。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * electron-builder 打包 macOS 时，只是把 `node_modules/electron/dist/Electron.app/
 * Contents/MacOS/Electron` 复制、改名成 `<ProductName>` 再重新签名。改名和重签名
 * **都不会改变 Mach-O 的 `LC_UUID`**，于是「同一个 Electron 版本」产出的所有 app
 * —— 包括 dev Electron、以及机器上任何其它同版本 Electron 应用 —— 共享同一个 UUID：
 *
 *   $ dwarfdump --uuid dist/mac-arm64/GGTerm.app/Contents/MacOS/GGTerm
 *   UUID: 4C4C442B-5555-3144-A1CD-D19486D5DA3D (arm64)
 *   $ dwarfdump --uuid node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
 *   UUID: 4C4C442B-5555-3144-A1CD-D19486D5DA3D (arm64)     ← 逐字节相同
 *
 * 而 macOS 的本地网络隐私（macOS 15+）**用主可执行文件的 UUID 参与身份判定**。
 * Apple 官方文档 TN3179《Understanding local network privacy》原文：
 *
 *   “Local network privacy uses your main executable UUID as part of its
 *    implementation. If your main executable has no UUID, or **shares a UUID with
 *    other programs**, local network privacy may behave weirdly. To fix that,
 *    **make sure your main executable has a UUID and that it's unique**.”
 *
 * 实测症状（本机 macOS 27 上抓到的内核日志）：
 *
 *   $ log stream --predicate 'eventMessage CONTAINS "LocalNetwork:" OR eventMessage CONTAINS "NECP"'
 *   tcp drop outgoing [...:22] interface: bridge100  process: GGTerm  reason: NECP
 *   LocalNetwork: found bundle id com.estamelgg.ggterm by PID
 *   LocalNetwork: found bundle id com.github.Electron  by UUID 4C4C442B-…   ← 身份判给了别人
 *
 * 结果：本地网络授权记录挂到 `com.github.Electron` 名下，自己的 app 既不出现在
 * 「系统设置 → 隐私与安全性 → 本地网络」，连局域网 / 本地虚拟机（192.168.x.x）的包
 * 也被 NetworkExtension（NECP）静默丢弃 —— 表现为 SSH 只报超时，而终端里 `nc`/`ping`
 * 同一个地址却完全正常（macOS 自动放行从 Terminal/SSH 启动的 CLI 及其子进程）。
 *
 * 注意：`lsregister -u node_modules/electron/dist/Electron.app` **不能**解决问题。
 * 即使 LaunchServices 里只剩自己独占该 UUID，日志仍报 `by UUID com.github.Electron`
 * —— 这个映射缓存在 root 拥有的
 * `/Library/Preferences/com.apple.networkextension.uuidcache.plist` 里，普通用户清不掉。
 * 唯一有效解就是让本 app 不再共用那个 UUID（即本钩子）。
 *
 * ── 上游状况（2026-09 查证）────────────────────────────────────────────────
 * - Electron / electron-builder **没有任何内置处理**：`app-builder-lib` 26.15.3 的
 *   macPackager / platformPackager / ElectronFramework 里 LC_UUID 出现 0 次，
 *   `@electron/{osx-sign,fuses,universal,asar}` 也都不碰。
 * - 唯一一次上游尝试 electron/electron#22958（strip uuid from darwin binaries）
 *   已于 2020-04-10 关闭：Chromium 明确表示移除 UUID 会破坏 crash 符号化
 *   （“Removing UUIDs will absolutely break crash reporting”），因此上游不会改。
 * - electron-builder#9158 报的就是这个问题，被 stale bot 关成 not planned。
 * - 所以只能在自己的构建里补。
 *
 * ── UUID 怎么派生（稳定性关键）─────────────────────────────────────────────
 *   UUID = sha256("ggterm/macho-uuid/v1:" + appId + "|" + 包内相对路径)
 * 种子**不含版本号**，所以：
 *   - 以后每次更新（1.x → 2.x）派生结果都一样 → 权限不会失效、**不需要重新授权**
 *   - 同一个 app 装在不同路径（/Applications 与 dist/）得到同一个 UUID → 身份一致
 *   - 确定性 → 构建可复现，不像随机 UUID 那样每次构建都换身份
 * 反例：只按 bundleId 派生（某些项目这么做）会让主程序与 4 个 Helper 拿到同一个
 * UUID，反而制造新的歧义；这里按「appId + 每个二进制各自的相对路径」派生，逐个唯一。
 *
 * 只改入口二进制（主程序 + 各 Helper），**不动 `Electron Framework`** ——
 * 所以崩溃报告里框架栈帧的符号化不受影响。
 */

const { createHash } = require('node:crypto')
const { readFile, readdir, writeFile } = require('node:fs/promises')
const path = require('node:path')

// ---------------------------------------------------------------------------
// Mach-O 常量
// ---------------------------------------------------------------------------

/** LC_UUID：load command = 0x1b，cmdsize = 24（8 字节命令头 + 16 字节 UUID） */
const LC_UUID = 0x1b

// 文件头魔数。一律按大端读取：读到 MH_CIGAM* 说明文件本身是小端。
const MH_MAGIC = 0xfeedface // 32-bit，大端
const MH_CIGAM = 0xcefaedfe // 32-bit，小端
const MH_MAGIC_64 = 0xfeedfacf // 64-bit，大端
const MH_CIGAM_64 = 0xcffaedfe // 64-bit，小端（arm64 / x86_64 都是这种）
const FAT_MAGIC = 0xcafebabe // fat / universal
const FAT_MAGIC_64 = 0xcafebabf

const SEED_PREFIX = 'ggterm/macho-uuid/v1:'

// ---------------------------------------------------------------------------
// Mach-O 解析
// ---------------------------------------------------------------------------

/**
 * 扫描一个 Mach-O 切片（thin），把所有 LC_UUID 的 16 字节载荷偏移收集到 `slots`。
 * @param {Buffer} buf
 * @param {number} base 切片在 buf 中的起始偏移
 * @param {number[]} slots
 */
function collectThin(buf, base, slots) {
  if (base + 4 > buf.length) return

  const magic = buf.readUInt32BE(base)
  /** @type {boolean} 文件是否大端 */
  let bigEndian
  /** @type {number} mach_header(_64) 长度 */
  let headerSize

  if (magic === MH_MAGIC_64) {
    bigEndian = true
    headerSize = 32
  } else if (magic === MH_CIGAM_64) {
    bigEndian = false
    headerSize = 32
  } else if (magic === MH_MAGIC) {
    bigEndian = true
    headerSize = 28
  } else if (magic === MH_CIGAM) {
    bigEndian = false
    headerSize = 28
  } else {
    return // 不是 Mach-O 切片
  }

  if (base + headerSize > buf.length) return
  const readUInt32 = bigEndian ? (o) => buf.readUInt32BE(o) : (o) => buf.readUInt32LE(o)

  const ncmds = readUInt32(base + 16)
  let p = base + headerSize

  for (let i = 0; i < ncmds; i++) {
    if (p + 8 > buf.length) return
    const cmd = readUInt32(p)
    const cmdsize = readUInt32(p + 4)
    if (cmdsize < 8 || p + cmdsize > buf.length) return // 命令表损坏，停止
    if (cmd === LC_UUID && cmdsize >= 24) slots.push(p + 8)
    p += cmdsize
  }
}

/**
 * 找出 `buf` 中所有 LC_UUID 载荷的偏移（兼容 fat / universal 与大小端）。
 * fat 二进制里每个架构切片各有自己的 UUID，都要改。
 * @param {Buffer} buf
 * @returns {number[]}
 */
function uuidSlots(buf) {
  const slots = []
  if (buf.length < 8) return slots

  const magic = buf.readUInt32BE(0)

  if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
    // fat 头统一大端：magic(4) + nfat_arch(4)，随后每项 20（fat）/ 32（fat64）字节
    const is64 = magic === FAT_MAGIC_64
    const entrySize = is64 ? 32 : 20
    const nArch = buf.readUInt32BE(4)
    for (let i = 0; i < nArch; i++) {
      const entry = 8 + i * entrySize
      if (entry + entrySize > buf.length) break
      const offset = is64
        ? Number(buf.readBigUInt64BE(entry + 8))
        : buf.readUInt32BE(entry + 8)
      collectThin(buf, offset, slots)
    }
    return slots
  }

  collectThin(buf, 0, slots)
  return slots
}

/**
 * 就地把文件里所有 LC_UUID 替换成 `uuid`（不改变文件长度）。
 * @param {string} file
 * @param {Buffer} uuid 16 字节
 * @returns {Promise<number>} 实际替换的个数
 */
async function patchMachO(file, uuid) {
  const buf = await readFile(file)
  const slots = uuidSlots(buf)
  if (slots.length === 0) return 0

  for (const offset of slots) uuid.copy(buf, offset)
  await writeFile(file, buf)
  return slots.length
}

// ---------------------------------------------------------------------------
// UUID 生成
// ---------------------------------------------------------------------------

/**
 * 由种子派生一个稳定的 UUID v4。
 * 同一 (appId, 包内路径) 永远得到同一个值 —— 这正是「更新后不用重新授权」的前提。
 * @param {string} seed
 * @returns {Buffer} 16 字节
 */
function deterministicUuid(seed) {
  const uuid = Buffer.from(
    createHash('sha256').update(SEED_PREFIX + seed).digest().subarray(0, 16)
  )
  uuid[6] = (uuid[6] & 0x0f) | 0x40 // version 4
  uuid[8] = (uuid[8] & 0x3f) | 0x80 // RFC 4122 variant
  return uuid
}

/** @param {Buffer} uuid */
function formatUuid(uuid) {
  const h = uuid.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// ---------------------------------------------------------------------------
// 钩子主体
// ---------------------------------------------------------------------------

/** @param {import('app-builder-lib').AfterPackContext} context */
async function afterPack(context) {
  // 只处理 macOS：Windows / Linux 没有 LC_UUID，也没有本地网络隐私
  if (context.electronPlatformName !== 'darwin') return

  const { appOutDir, packager } = context
  const appName = packager.appInfo.productFilename
  const appPath = path.join(appOutDir, `${appName}.app`)
  const appId = packager.config.appId ?? packager.appInfo.id ?? appName

  // 收集所有「会成为进程」的可执行文件：主程序 + Contents/Frameworks/*.app 内的 Helper
  const mainMacOS = path.join(appPath, 'Contents', 'MacOS')
  const executables = []
  for (const entry of await readdir(mainMacOS)) {
    executables.push(path.join(mainMacOS, entry))
  }

  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks')
  for (const entry of await readdir(frameworksDir)) {
    if (!entry.endsWith('.app')) continue
    const dir = path.join(frameworksDir, entry, 'Contents', 'MacOS')
    try {
      for (const name of await readdir(dir)) executables.push(path.join(dir, name))
    } catch {
      // 没有 Contents/MacOS 的嵌套 bundle 直接跳过
    }
  }

  console.log(`  • afterPack: 为 ${appName} 写入唯一 Mach-O UUID（消除与其它 Electron 应用的身份冲突）`)

  for (const file of executables) {
    const relative = path.relative(appPath, file)
    const uuid = deterministicUuid(`${appId}|${relative}`)
    const count = await patchMachO(file, uuid)
    if (count > 0) {
      console.log(`    - ${formatUuid(uuid)}  ${relative}`)
    } else if (path.dirname(file) === mainMacOS) {
      // 主程序必须成功，否则身份冲突会静默复发（正是本钩子要修的那个 bug）。
      // 宁可让构建失败，也不要产出一个「看起来正常但连不上局域网」的包。
      throw new Error(`afterPack: 主可执行文件里找不到 LC_UUID，Mach-O 结构可能已变: ${relative}`)
    } else {
      console.log(`    - 跳过（该 Helper 不是 Mach-O 或无 LC_UUID）: ${relative}`)
    }
  }
}

module.exports = afterPack
module.exports.afterPack = afterPack
module.exports.default = afterPack
