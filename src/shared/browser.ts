export interface BrowserTab {
  id: string
  url: string
  title: string
  loading: boolean
  error?: string
  certificateError?: BrowserCertificateError
  certificateTrust?: BrowserCertificateTrust
  canGoBack: boolean
  canGoForward: boolean
}
export interface BrowserState {
  tabs: BrowserTab[]
  foregroundId: string | null
}
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserContent {
  url: string
  title: string
  content: string
  totalCharacters: number
  nextOffset: number | null
  links: { text: string; url: string }[]
  note: string
}
export interface BrowserElement {
  selector: string
  tagName: string
  text: string
  html: string
}
export interface AiBrowserReference {
  id: string
  kind: 'page' | 'element'
  tabId: string
  url: string
  title: string
  capturedAt: number
  content: string
  totalCharacters?: number
  element?: BrowserElement
}

export interface BrowserCertificateError {
  requestId: string
  url: string
  origin: string
  error: string
  subject: string
  issuer: string
  fingerprint: string
  validFrom: number
  validTo: number
}
export interface BrowserCertificateTrust {
  origin: string
  fingerprint: string
}
