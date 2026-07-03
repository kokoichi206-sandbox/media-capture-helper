import { defineConfig } from 'wxt'

// https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    name: 'media-capture-helper',
    description:
      '開いている動画ページの動画を、ログイン状態の画質でダウンロードする',
    // アイコンクリックでサイドパネルを開くため、popup 無しの action を定義する。
    action: {},
    // downloads: 生成した MP4 の保存。storage: 状態(job / 進捗)の受け渡し。
    // tabs: アクティブな動画タブの特定。sidePanel: 管理 UI の常設面。
    // offscreen: 可視タブなしで fetch/ffmpeg/保存を行う作業ページ。
    // declarativeNetRequest: CDN 取得時に必須の Referer を静的ルールで付与。
    permissions: [
      'downloads',
      'storage',
      'tabs',
      'sidePanel',
      'offscreen',
      'declarativeNetRequest',
    ],
    host_permissions: [
      'https://*.bilibili.com/*',
      'https://*.bilivideo.com/*',
      'https://*.bilivideo.cn/*',
      'https://*.akamaized.net/*',
    ],
    // 動画 CDN は Referer が無いと 403 を返す。fetch では Referer を偽装
    // できないため、xmlhttprequest に対して DNR でヘッダを付与する。
    declarative_net_request: {
      rule_resources: [
        {
          id: 'cdn_referer',
          enabled: true,
          path: 'rules/referer.json',
        },
      ],
    },
    // ffmpeg.wasm の実行に wasm-unsafe-eval が要る。スクリプトは自前のみ(self)。
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
})
