import { defineContentScript } from '#imports'
import type { ApiResponse, PlayInfo, ViewData } from '../src/shared/api-types'
import {
  isContentRequest,
  type VideoInfo,
  type VideoInfoResponse,
} from '../src/shared/messages'
import { parseVideoLocation } from '../src/extractor/location'

// 対応サイトのページコンテキストで API を呼ぶことで、ログイン Cookie
// (HttpOnly の認証 Cookie を含む) が same-site として自動送信され、
// ログイン状態に応じた画質リストが得られる。
const API_BASE = 'https://api.bilibili.com'

async function apiGet<T>(
  path: string,
  params: Record<string, string | number>,
): Promise<T> {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  )
  const res = await fetch(`${API_BASE}${path}?${qs}`, {
    credentials: 'include',
  })
  if (!res.ok) {
    throw new Error(`API HTTP ${res.status}: ${path}`)
  }
  const body = (await res.json()) as ApiResponse<T>
  if (body.code !== 0) {
    throw new Error(`API エラー code=${body.code}: ${body.message}`)
  }
  return body.data
}

async function getVideoInfo(): Promise<VideoInfo> {
  const loc = parseVideoLocation(location.href)
  if (!loc) {
    throw new Error('URL から動画 ID を特定できませんでした')
  }
  const view = await apiGet<ViewData>(
    '/x/web-interface/view',
    'bvid' in loc ? { bvid: loc.bvid } : { aid: loc.aid },
  )
  const pageInfo = view.pages[loc.page - 1] ?? view.pages[0]
  const cid = pageInfo?.cid ?? view.cid
  const playinfo = await apiGet<PlayInfo>('/x/player/playurl', {
    bvid: view.bvid,
    cid,
    fnval: 4048,
    fnver: 0,
    fourk: 1,
  })
  return {
    bvid: view.bvid,
    cid,
    page: loc.page,
    title: view.title,
    partTitle: view.videos > 1 ? (pageInfo?.part ?? '') : '',
    durationSec: pageInfo?.duration ?? view.duration,
    playinfo,
  }
}

export default defineContentScript({
  matches: ['https://www.bilibili.com/video/*'],
  runAt: 'document_idle',
  main() {
    // ネイティブ Chrome の onMessage は Promise 返却での非同期応答に非対応なので、
    // sendResponse + 同期 return true で応答する。
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!isContentRequest(message)) return
      getVideoInfo().then(
        (info) => {
          const res: VideoInfoResponse = { ok: true, data: info }
          sendResponse(res)
        },
        (err: unknown) => {
          const res: VideoInfoResponse = {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }
          sendResponse(res)
        },
      )
      return true
    })
  },
})
