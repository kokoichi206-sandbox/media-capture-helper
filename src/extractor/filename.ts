// 保存ファイル名の組み立て(純粋ロジック)。

// Chrome の downloads API が拒否する Windows 予約文字とパス区切り。
// 空白・ハイフンは許容されるので残す(不要に潰さない)。
const RESERVED = /[\\/:*?"<>|]/g

// 予約文字を _ に、制御文字を除去し、空白の連続を 1 つに畳んで長さを制限する。
export function sanitizeFilename(name: string): string {
  const withoutControl = [...name]
    .filter((ch) => ch.codePointAt(0)! >= 0x20)
    .join('')
  return withoutControl
    .replace(RESERVED, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

export function buildDisplayTitle(title: string, partTitle: string): string {
  return partTitle ? `${title} / ${partTitle}` : title
}

export function buildOutputFilename(
  displayTitle: string,
  qualityLabel: string,
): string {
  return `${sanitizeFilename(displayTitle)} [${qualityLabel}].mp4`
}
