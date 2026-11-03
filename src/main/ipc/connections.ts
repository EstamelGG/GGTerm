import { ipcMain } from 'electron'
import type {
  ConnectionSecrets,
  HostConnection,
  HostGroup,
  LocalSshKey,
  ServerNote,
  SshConfigHost
} from '../../shared/types'
import * as connections from '../connections'
import * as secrets from '../data/secrets'
import { probeLatency, type ProbeTarget } from '../probe'
import { listLocalKeys, parseSshConfig, readLocalKey } from '../ssh/localSsh'
import { sshTest, type SshTestInput } from '../sshTest'

import { channels } from './channels'

export function registerConnectionIpc(): void {
  ipcMain.handle(channels.connList, (): HostConnection[] => connections.listConnections())

  ipcMain.handle(
    channels.connCreate,
    (
      _e,
      input: Parameters<typeof connections.createConnection>[0],
      credentials?: Partial<ConnectionSecrets>
    ) => connections.createConnection(input, credentials)
  )

  ipcMain.handle(
    channels.connUpdate,
    (
      _e,
      {
        id,
        patch,
        credentials
      }: { id: string; patch: Partial<HostConnection>; credentials?: Partial<ConnectionSecrets> }
    ) => connections.updateConnection(id, patch, credentials)
  )

  ipcMain.handle(channels.connDelete, (_e, id: string) => connections.deleteConnection(id))

  // 结构化备注：独立通道（全量替换，不触发 perfInvalidate——改备注不打断性能探测/连接）
  ipcMain.handle(channels.connSetNote, (_e, { id, note }: { id: string; note: ServerNote }) =>
    connections.setNote(id, note)
  )

  ipcMain.handle(channels.groupList, (): HostGroup[] => connections.listGroups())

  ipcMain.handle(channels.groupCreate, (_e, input: Parameters<typeof connections.createGroup>[0]) =>
    connections.createGroup(input)
  )

  ipcMain.handle(
    channels.groupUpdate,
    (_e, { id, patch }: { id: string; patch: Partial<HostGroup> }) =>
      connections.updateGroup(id, patch)
  )

  ipcMain.handle(channels.groupDelete, (_e, id: string) => connections.deleteGroup(id))

  ipcMain.handle(
    channels.secretsSave,
    (_e, { id, secrets: s }: { id: string; secrets: Partial<ConnectionSecrets> }) => {
      connections.saveConnectionSecrets(id, s)
    }
  )

  ipcMain.handle(channels.secretsLoad, (_e, id: string): ConnectionSecrets =>
    secrets.loadSecrets(id)
  )

  ipcMain.handle(channels.secretsDelete, (_e, id: string) =>
    connections.saveConnectionSecrets(id, { password: '', privateKey: '', passphrase: '' })
  )

  /** ~/.ssh 集成：列私钥 / 读私钥 / 解析 config（导入编排在渲染层） */
  ipcMain.handle(channels.localKeysList, (): Promise<LocalSshKey[]> => listLocalKeys())
  ipcMain.handle(channels.localKeysRead, (_e, path: string): Promise<string> => readLocalKey(path))
  ipcMain.handle(channels.sshConfigParse, (): Promise<SshConfigHost[]> => parseSshConfig())

  ipcMain.handle(channels.probeLatency, (_e, targets: ProbeTarget[]) => probeLatency(targets))

  ipcMain.handle(channels.sshTest, (_e, input: SshTestInput) => sshTest(input))
}
