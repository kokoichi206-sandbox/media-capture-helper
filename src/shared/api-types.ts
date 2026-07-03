// 対応サイトの Web API のレスポンス型(利用する部分のみ)。
// 完全な仕様ではなく、この拡張が依存するフィールドだけをコントラクトとして固定する。

export interface ApiResponse<T> {
  code: number
  message: string
  data: T
}

// DASH の 1 ストリーム(映像 or 音声)。映像と音声は別ファイルで配信される。
export interface DashStream {
  id: number
  baseUrl: string
  backupUrl?: string[]
  codecs: string
  bandwidth: number
  mimeType: string
  // 映像のみ。音声には width/height は無い。
  width?: number
  height?: number
}

export interface Dash {
  duration: number
  video: DashStream[]
  audio: DashStream[] | null
}

// 画質 ID と表示名の対応(accept_quality/accept_description の代わりに使える詳細版)。
export interface SupportFormat {
  quality: number
  new_description?: string
  display_desc?: string
}

export interface PlayInfo {
  quality: number
  accept_quality: number[]
  accept_description: string[]
  support_formats?: SupportFormat[]
  dash?: Dash
}

export interface ViewPage {
  cid: number
  page: number
  part: string
  duration: number
}

export interface ViewData {
  bvid: string
  aid: number
  cid: number
  title: string
  videos: number
  duration: number
  pages: ViewPage[]
}
