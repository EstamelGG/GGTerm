// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { index?: number }) =>
      opts?.index === undefined ? key : `GPU ${opts.index}`
  })
}))
/** 图表在 jsdom 下没有布局尺寸：替换为直通容器，本用例只验证 GPU 区块 */
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  Cell: () => null,
  Line: () => null,
  LineChart: () => null,
  Pie: () => null,
  PieChart: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null
}))
import { PerformancePanel } from '../src/renderer/src/components/activity/panels/PerformancePanel'
import { usePerfStore } from '../src/renderer/src/stores/perf'
import type { PerfSample } from '../src/shared/types'

const GB = 1024 ** 3
const MIB = 1024 * 1024

const base = {
  hostId: 'host',
  cores: 8,
  cpuPct: 12,
  memTotal: 16 * GB,
  memPct: 50,
  diskTotal: 100 * GB,
  diskPct: 20,
  swapTotal: 0,
  swapPct: null,
  netRx: 0,
  netTx: 0,
  load1: 0,
  load5: 0,
  load15: 0,
  procsRun: 1,
  procsTotal: 100,
  uptimeSec: 3600,
  osName: 'Linux',
  timezone: 'Asia/Shanghai',
  memFree: 8 * GB,
  memCache: 0,
  perCore: [],
  disks: [],
  t: 1
} satisfies PerfSample

const gpu = {
  index: 0,
  uuid: 'GPU-c4f8b4db-e2d8-b87b-ddaa-94dc184c4727',
  name: 'NVIDIA GeForce RTX 2080 Ti',
  driver: '595.80',
  memUsed: 4 * GB,
  memTotal: 11 * GB,
  utilPct: 37,
  tempC: 62,
  powerW: 180.4,
  powerCapW: 250,
  fanPct: 45,
  procs: [
    { pid: 953998, name: '/root/miniconda3/envs/GPTSoVits/bin/python', mem: 1204 * MIB },
    { pid: 123817, name: '/root/comfyui/venv/bin/python', mem: 280 * MIB }
  ]
}

afterEach(() => {
  cleanup()
  usePerfStore.setState({ samples: {}, histories: {}, gpuSamples: {}, osNames: {} })
})

it('renders GPU card from the GPU stream (3s 全量样本不再带 GPU)', () => {
  usePerfStore.setState({ samples: { host: base } })
  usePerfStore.getState().applyGpu({ hostId: 'host', gpus: [gpu], t: 1000 })
  render(<PerformancePanel hostId="host" />)
  expect(screen.getByText('activity.perfGpu')).toBeTruthy()
  expect(screen.getByText('595.80')).toBeTruthy()
  expect(screen.getByText('37%')).toBeTruthy()
  expect(screen.getByText('4.00 GB / 11.00 GB')).toBeTruthy()
  expect(screen.getByText('62°C · 180W / 250W · activity.perfGpuFan 45%')).toBeTruthy()
  // 占用进程（top5）：路径完整显示（不截断，允许换行）
  expect(screen.getByText('activity.perfGpuProcs')).toBeTruthy()
  expect(screen.getByText('1.18 GB')).toBeTruthy()
  expect(screen.getByText('280.0 MB')).toBeTruthy()
  const proc = screen.getByText('/root/miniconda3/envs/GPTSoVits/bin/python')
  expect(proc.className).toMatch(/break-words/)
  expect(proc.className).not.toMatch(/truncate/)
  // 名称完整显示且允许换行（不能截断成省略号）
  const name = screen.getByText('GPU 0 · NVIDIA GeForce RTX 2080 Ti')
  expect(name.className).toMatch(/break-words/)
  expect(name.className).not.toMatch(/truncate/)
})

it('hides the whole GPU section when the host has no nvidia-smi', () => {
  usePerfStore.setState({ samples: { host: base }, gpuSamples: {} })
  render(<PerformancePanel hostId="host" />)
  expect(screen.queryByText('activity.perfGpu')).toBeNull()
  expect(screen.queryByText('activity.perfGpuUtil')).toBeNull()
})
