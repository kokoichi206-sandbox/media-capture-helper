# media-capture-helper

開いている動画ページの動画をダウンロードする Chrome 拡張 (Manifest V3)。

ログイン済みの Chrome で使うと、ログイン状態で選択できる画質（1080P 以上など）がそのまま選択肢に表示される。

## 対応サイト

- `https://www.bilibili.com/video/...`

## Stack

WXT + TypeScript(strict) + pnpm。UI はフレームワークなしの素の DOM。
映像・音声の結合は ffmpeg.wasm（`-c copy` の remux、再エンコードなし）。

## セットアップ

```sh
pnpm install   # postinstall で wxt prepare と ffmpeg.wasm の同梱(public/vendor)を行う
pnpm dev       # Chrome を起動して拡張をロード(開発)
pnpm build     # 本番ビルド(.output/chrome-mv3)
```

手動で読み込む場合は `pnpm build` 後に `chrome://extensions` →
デベロッパーモード ON →「パッケージ化されていない拡張機能を読み込む」で
`.output/chrome-mv3` を選択する。

## 使い方

1. 対応サイトの動画ページを開く
2. ツールバーの拡張機能アイコンをクリック（サイドパネルが開く）
3. 画質を選んで「ダウンロード」
4. サイドパネルの一覧に進捗が表示され、完了すると MP4 が保存される

ダウンロードは新規タブを開かず、サイドパネルで進捗・キャンセル・直近の履歴
（完了/エラーを最大 20 件）を管理する。恒久的なダウンロード履歴は
`chrome://downloads` に残る。

## 仕組み

```
サイドパネル(画質選択 + 進捗/履歴の管理)
  │  └─ content script: 対象サイトのページ内で view / playurl API を呼ぶ
  │
  ├─ START_DOWNLOAD ─> background(調整役 / 状態を storage.session に集約)
  │                       └─ RUN_JOB ─> offscreen(不可視の作業ページ)
  │                                       ├─ 映像/音声 (.m4s) を fetch
  │                                       │   └─ declarativeNetRequest で Referer を付与
  │                                       ├─ ffmpeg.wasm で結合 (-c copy)
  │                                       └─ chrome.downloads で保存
  └─ storage.session を購読して進捗と履歴を描画
```

- 対象サイトは DASH 配信のため映像と音声が別ファイル。ffmpeg.wasm で 1 つの MP4 に結合する。
- 画質 API はコンテンツスクリプト（対象サイトのページコンテキスト）から呼ぶ。
  HttpOnly の認証 Cookie が same-site として自動送信されるため、
  ログイン状態に応じた画質リストが得られる。
- CDN は `Referer` が必須のため、`declarativeNetRequest` の静的ルール
  (`public/rules/referer.json`)で付与している。
- 取得・結合・保存は不可視の offscreen document で行う。popup は閉じると処理が
  止まり、service worker では `URL.createObjectURL` が使えないため、長時間の作業は
  持続的な document 上で動かす必要がある。UI(サイドパネル)とは `storage.session`
  経由で疎結合にし、パネルの開閉やタブ移動と作業を独立させている。
- ffmpeg.wasm は CSP のため CDN 読み込み不可。`public/vendor/` に同梱し、
  offscreen ページから実行時に動的 import する（Vite のバンドルには載せない）。

## テスト

- ユニット（vitest, 純粋ロジックのみ）:

  ```sh
  pnpm test       # src/**/*.test.ts
  pnpm compile    # 型チェック(tsc --noEmit)
  ```

- E2E（Playwright, 実際にダウンロードして ffprobe で検証）:

  ```sh
  npx playwright install chromium   # 初回のみ
  pnpm e2e                          # 既定のテスト動画(wxt build を含む)
  pnpm e2e 'https://www.bilibili.com/video/BV...'
  ```

  ffprobe (Homebrew の ffmpeg) が必要。テスト用 Chromium は未ログインのため
  480P までとなる。ログイン画質は自分の Chrome に拡張を読み込んで確認する。

## 制限事項

- DASH 形式で取得できる動画のみ対応（有料・地域制限動画は不可）
- 音声は最高ビットレートの AAC を使用（FLAC / Dolby は未対応）
- ダウンロードはメモリ上で行うため、数 GB 級の長時間動画では失敗する可能性がある
- 多パート動画 (`?p=N`) は現在開いているパートのみダウンロードする

## 免責事項

- 本拡張は個人利用・技術検証を目的とする。対象サイトの利用規約および著作権法等の
  関係法令の確認・遵守は、利用者自身の責任で行うこと。
- ダウンロードしたコンテンツの再配布・公開など、私的利用の範囲を超える利用は
  行わないこと。
- 本ソフトウェアは現状有姿（AS IS）で提供され、動作や取得結果についていかなる
  保証もしない。利用によって生じた損害・不利益について、作者は一切の責任を負わない。
- 対象サイトの仕様変更等により、予告なく動作しなくなることがある。
