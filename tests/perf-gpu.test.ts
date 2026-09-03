import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  dialog: {},
  shell: {},
  utilityProcess: { fork: vi.fn() }
}))
vi.mock('../src/main/log', () => ({ appLog: vi.fn() }))

import { parseGpuAppRow, parseGpuRow } from '../src/main/ssh/perf'

/**
 * GPU_SCRIPT 的行 = nvidia-smi CSV 原样透传：
 * G：index, uuid, utilization.gpu, memory.used(MiB), memory.total(MiB), temperature.gpu,
 *    power.draw, power.limit, fan.speed, driver_version, name（name 含空格，固定最后）
 * A：gpu_uuid, pid, used_memory(MiB), process_name（path 固定最后）
 */
const MIB = 1024 * 1024
// 真实采集样本（192.168.133.216 / RTX 2080 Ti / 驱动 595.80）：
// nvidia-smi --query-gpu=index,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu,\
//   power.draw,power.limit,fan.speed,driver_version,name --format=csv,noheader,nounits
const REAL_2080TI =
  'G 0, GPU-c4f8b4db-e2d8-b87b-ddaa-94dc184c4727, 35, 1887, 11264, 65, 92.28, 250.00, 26, 595.80, NVIDIA GeForce RTX 2080 Ti'

it('parses a real row (MiB → bytes, uuid kept, name with spaces)', () => {
  expect(parseGpuRow(REAL_2080TI)).toEqual({
    index: 0,
    uuid: 'GPU-c4f8b4db-e2d8-b87b-ddaa-94dc184c4727',
    utilPct: 35,
    memUsed: 1887 * MIB,
    memTotal: 11264 * MIB,
    tempC: 65,
    powerW: 92.28,
    powerCapW: 250,
    fanPct: 26,
    driver: '595.80',
    name: 'NVIDIA GeForce RTX 2080 Ti',
    procs: []
  })
})

it('parses a real compute-app row (uuid / pid / MiB → bytes / 长路径完整保留)', () => {
  expect(
    parseGpuAppRow(
      'A GPU-c4f8b4db-e2d8-b87b-ddaa-94dc184c4727, 953998, 1204, /root/miniconda3/envs/GPTSoVits/bin/python'
    )
  ).toEqual({
    uuid: 'GPU-c4f8b4db-e2d8-b87b-ddaa-94dc184c4727',
    proc: {
      pid: 953998,
      mem: 1204 * MIB,
      name: '/root/miniconda3/envs/GPTSoVits/bin/python'
    }
  })
})

it('keeps null for unsupported fields ([N/A]，数据中心卡无风扇)', () => {
  expect(
    parseGpuRow(
      'G 1, GPU-aaaa-bbbb, [N/A], 0, 81920, [N/A], [N/A], [N/A], [N/A], 580.10, NVIDIA A100-SXM4-80GB'
    )
  ).toEqual({
    index: 1,
    uuid: 'GPU-aaaa-bbbb',
    utilPct: null,
    memUsed: 0,
    memTotal: 81920 * MIB,
    tempC: null,
    powerW: null,
    powerCapW: null,
    fanPct: null,
    driver: '580.10',
    name: 'NVIDIA A100-SXM4-80GB',
    procs: []
  })
})

it('drops truncated / malformed rows（列数不足、卡序号或 pid 非数值）', () => {
  expect(parseGpuRow('G 0, GPU-x, 0, 1701, 11264, 39')).toBeNull()
  expect(
    parseGpuRow('G x, GPU-x, 0, 1701, 11264, 39, 18.51, 250.00, 18, 595.80, RTX 2080 Ti')
  ).toBeNull()
  expect(parseGpuAppRow('A GPU-x, -1, 1204, /usr/bin/python')).toBeNull()
  expect(parseGpuAppRow('A GPU-x, abc, 1204, /usr/bin/python')).toBeNull()
  expect(parseGpuAppRow('A GPU-x, 953998, 1204')).toBeNull()
})
