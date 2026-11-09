import { BrowserWindow } from 'electron'
import { errorMessage } from '../../shared/error'
import { appLog } from '../log'

/** Legacy one-way operations cannot reject to their caller. Consume and log failures. */
export function runOneWay(operation: string, action: () => unknown): void {
  void Promise.resolve()
    .then(action)
    .catch((error) => {
      appLog('ipc', `${operation}: ${errorMessage(error)}`, 'error')
    })
}

/** A closing renderer must not prevent delivery to the remaining windows. */
export function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send(channel, payload)
    } catch (error) {
      appLog('ipc', `${channel}: ${errorMessage(error)}`, 'error')
    }
  }
}
