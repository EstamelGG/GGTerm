export interface BrowserBookmark {
  id: string
  title: string
  url: string
  createdAt: number
  updatedAt: number
}
export interface BrowserBookmarkInput {
  title?: string
  url: string
}
