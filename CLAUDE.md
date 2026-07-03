# CLAUDE.md

開いている動画ページの動画をダウンロードする Chrome 拡張。機能と使い方・対応サイトは [README](./README.md) を参照(ここでは重複させない)。

## Stack

WXT + TypeScript(strict) + pnpm。UI はフレームワークなしの素の DOM。
映像・音声の結合は ffmpeg.wasm(`-c copy` の remux)。

## Commands

- `pnpm dev` — 開発(Chrome 起動して拡張をロード)
- `pnpm build` — 本番ビルド(`.output/chrome-mv3`)
- `pnpm test` — ユニットテスト(vitest)
- `pnpm compile` — 型チェック(`tsc --noEmit`)
- `pnpm e2e` — 実機ダウンロードの E2E(`wxt build` + Playwright、要 ffprobe)
- `pnpm lint` / `pnpm format` — ESLint / Prettier

## 検証の境界(コードから読めない前提)

- 純粋ロジック(`src/extractor` の URL 解析・ストリーム選別・ファイル名生成)だけが
  ユニットテスト対象。
- ネットワーク取得・ffmpeg 結合・chrome.\* の連携・DNR による Referer 付与は
  **実機 Chrome(= `pnpm e2e`)でしか検証できない**。

## 守る原則(プロジェクト固有・必ず守る)

- **暗黙の fallback を作らない。** API エラー・DASH 欠落・画質不一致は握りつぶさず、
  Result 型の error か例外で明示する。CDN の backupUrl は「多重化」であって
  fallback ではない(全滅時はエラーにする)。
- **画質 API は content script(対象サイトのページ内)から呼ぶ。** 認証 Cookie は
  HttpOnly で、same-site 送信されるのはページコンテキストからの fetch のみ。
  background や popup から呼ぶとログイン画質が取れないので移さない。
- **CDN 取得の Referer は DNR で付与する。** fetch で Referer は偽装できない。
  ルールは `public/rules/referer.json`(xmlhttprequest 対象)。
- **ffmpeg.wasm はバンドルせず public/vendor から実行時ロードする。** Vite に載せると
  worker バンドルと CSP で不確実になる。`chrome.runtime.getURL()` の実行時文字列で
  動的 import する(`src/downloader/ffmpeg-loader.ts`)。
- コメントは Why のみ。

## アーキテクチャの継ぎ目

- コントラクト層は `src/shared/`(`messages.ts` の Result/VideoInfo/DownloadJob、
  `api-types.ts` の API 型)。実装層(entrypoints)はここから再生成可能に保つ。
- サイト固有の入出力は `entrypoints/content.ts`(API 呼び出し・対象 URL の matches)と
  `src/extractor`(URL 解析・ストリーム選別)に閉じている。対応サイトを増やす場合は
  ここと `wxt.config.ts` の host/DNR、`public/rules/referer.json` を触る。
- 画質選択・結合対象の決定は `src/extractor/streams.ts` に集約。UI は決定を持たない。
- ダウンロードの実体(fetch/結合/保存)は `entrypoints/downloader/main.ts`。
  純粋部分(ファイル名・ffmpeg ロード)は `src/` に分離してテスト/差し替え可能にする。

## 落とし穴

- pnpm 環境で `prettier .` が node_modules を辿るため、format は `.` でなく scoped glob。
- この環境の pnpm は store パスの `~` を展開できず、cwd に literal な `/~` を作ることがある
  (`.gitignore` 済み)。
- 音声トラックが無い動画がある(古い/無音)。`DownloadJob.audio` は null を取り、
  downloader は映像のみで MP4 を作る。
