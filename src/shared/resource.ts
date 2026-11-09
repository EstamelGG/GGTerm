/** Runtime resource identity; host configuration identity alone is never a lifetime boundary. */
export interface ResourceIdentity {
  hostId: string
  kind: 'shell' | 'sftp' | 'perf' | 'gpu'
  resourceId: string
  generation: number
  connectionId?: string
  connectionGeneration?: number
}
