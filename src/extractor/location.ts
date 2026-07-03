// 動画ページ URL から動画 ID とパート番号を取り出す純粋ロジック。

export type VideoLocation =
  | { bvid: string; page: number }
  | { aid: string; page: number }

// 例: /video/BV1xxxx/?p=2 のようなパスから動画 ID とパート番号を取り出す。
// BV 形式と av 形式の両方を受ける。p は 1 始まり(未指定なら 1)。
export function parseVideoLocation(href: string): VideoLocation | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  const m = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/)
  const id = m?.[1]
  if (!id) return null
  const rawPage = Number(url.searchParams.get('p') ?? '1')
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1
  return id.startsWith('BV') ? { bvid: id, page } : { aid: id.slice(2), page }
}
