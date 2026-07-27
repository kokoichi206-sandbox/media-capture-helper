# CLAUDE.md

開いている動画ページの動画をダウンロードする Chrome 拡張。

## 検証の境界

- 一括検証は `pnpm check`。実機ダウンロードの検証は `pnpm e2e`(要 ffprobe)。
- 純粋ロジック(`src/extractor` の URL 解析・ストリーム選別・ファイル名生成)だけがユニットテスト対象。
- ネットワーク取得・ffmpeg 結合・chrome.\* の連携・DNR による Referer 付与・offscreen の生成・サイドパネルの動線は**実機 Chrome(= `pnpm e2e`)でしか検証できない**。

## 守る原則(壊しても気づきにくい設計判断)

- **暗黙の fallback を作らない。** API エラー・DASH 欠落・画質不一致は握りつぶさず、Result 型の error か例外で明示する。CDN の backupUrl は「多重化」であって fallback ではない(全滅時はエラーにする)。
- **画質 API は content script(対象サイトのページ内)から呼ぶ。** HttpOnly の認証 Cookie はページコンテキストからの same-site fetch でしか送信されない。background や popup に移すとログイン画質が取れなくなる。
- **CDN 取得の Referer は DNR で付与する。** fetch で Referer は偽装できない。ルールは `public/rules/referer.json`(xmlhttprequest 対象)。
- **ffmpeg.wasm はバンドルせず public/vendor から実行時ロードする**(`src/downloader/ffmpeg-loader.ts`)。Vite に載せると worker バンドルと CSP で不確実になる。
- **結合はフルサイズの連続バッファを作らない。** 入力は WORKERFS mount(Blob 遅延読み)、出力は fMP4 セグメント列(HLS muxer)の Blob 連結。writeFile や古典的 MP4(+faststart)出力に戻すと、MEMFS がファイル全長の連続配列を要求し、数 GB の動画で確保に失敗する(Chrome の worker では巨大連続確保が通らない)。
- **状態の書き手は background だけ。** UI(sidepanel)は `storage.session` を購読して描画するだけで、実処理も決定も持たない。画質選択・結合対象の決定は `src/extractor/streams.ts` に集約する。

## 変更時にどこを触るか

- コントラクト層は `src/shared/`(`messages.ts` の Result/VideoInfo/DownloadJob、`api-types.ts` の API 型)。実装層(entrypoints)はここから再生成可能に保つ。
- 対応サイトの追加: `entrypoints/content.ts`(API 呼び出し・matches)、`src/extractor`(URL 解析・ストリーム選別)、`wxt.config.ts` の host/DNR、`public/rules/referer.json`。
- ダウンロードの実体(fetch/結合/保存)は `entrypoints/offscreen/main.ts`、起動・キュー・状態管理は `entrypoints/background.ts`。

## 落とし穴

- pnpm 環境で `prettier .` が node_modules を辿るため、format は `.` でなく scoped glob。
- この環境の pnpm は store パスの `~` を展開できず、cwd に literal な `/~` を作ることがある(`.gitignore` 済み)。
- 音声トラックが無い動画がある(古い/無音)。`DownloadJob.audio` は null を取り、downloader は映像のみで MP4 を作る。エラー扱いにしない。
