declare module "@chenglou/pretext" {
  export type PreparedText = unknown

  export type PreparedLine = {
    text: string
    width: number
  }

  export function prepareWithSegments(
    text: string,
    font: string,
    options: { whiteSpace?: string },
  ): PreparedText

  export function walkLineRanges(
    prepared: PreparedText,
    maxWidth: number,
    callback: (line: PreparedLine) => void,
  ): void

  export function layoutWithLines(
    prepared: PreparedText,
    maxWidth: number,
    lineHeight: number,
  ): { lines: PreparedLine[] }
}
