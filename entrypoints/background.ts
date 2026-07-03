import { defineBackground } from '#imports'

// この拡張のフローは popup(画質選択) -> content(API) -> downloader(取得/結合)で
// 完結し、background に常時処理は無い。MV3 は service worker の存在が必要なため
// 最小限の登録だけ行う。
export default defineBackground(() => {})
