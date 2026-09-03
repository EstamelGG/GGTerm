/** macOS「文件与文件夹」类受保护目录 */
export type ProtectedFolder = 'downloads' | 'documents' | 'desktop'

export interface LocalAccessDenial {
  folder: ProtectedFolder
  path: string
}
