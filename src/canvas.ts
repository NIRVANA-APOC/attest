// A character canvas: the panel draws every part as cells of text, then reads
// them back as lines of styled runs, painted as ANSI or kept plain for the
// goldens.
import stringWidth from 'string-width'

/** The panel's theme, `dim` lighter so waiting items read. */
export const TONES = {
  bright: '#e8eaf0',
  accent: '#6fa8ff',
  accentBright: '#9ac2ff',
  chrome: '#4e6991',
  warn: '#f4be5c',
  ok: '#98c379',
  error: '#e06c75',
  dim: '#9aa3ad',
  coral: '#f08a7e',
  cyan: '#65cbd4',
  violet: '#b994f0',
  pink: '#e58fc0',
} as const
export type Tone = keyof typeof TONES
export type Hex = `#${string}`
/**
 * `tone` is a theme tone or a colour of its own. `fade` mixes it with the paper (0 is the paper itself,
 * for text on a solid `bg`); `bg` is a background in a tone, `wash` how strongly it covers the paper.
 */
export type Style = { tone?: Tone | Hex; bold?: true; fade?: number; bg?: Tone; wash?: number }
export type Run = Style & { text: string }
export type Line = Run[]

/** The panel's paper, until the terminal tells its own. */
export const PAPER = '#151821'
export type Rgb = readonly [number, number, number]
export const rgbOf = (hex: string): Rgb => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
export const blend = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map(i => Math.round(a[i]! + (b[i]! - a[i]!) * Math.max(0, Math.min(1, t)))) as unknown as Rgb
const hexOf = (tone: Tone | Hex) => (tone.startsWith('#') ? tone : TONES[tone as Tone])
/** A style's colours as RGB on `paper`; absent where the terminal's own shows. */
export const coloursOf = (style: Style, paper: Rgb = rgbOf(PAPER)): { fg?: Rgb; bg?: Rgb } => {
  const tone = style.tone === undefined ? undefined : rgbOf(hexOf(style.tone))
  const fg = tone !== undefined && style.fade !== undefined ? blend(paper, tone, style.fade) : tone

  return { ...(fg && { fg }), ...(style.bg !== undefined && { bg: blend(paper, rgbOf(TONES[style.bg]), style.wash ?? 1) }) }
}
/** Text on a solid `tone`: the paper's colour, bold. */
export const solid = (tone: Tone): Style => ({ tone, fade: 0, bg: tone, bold: true })
const STYLE = ['tone', 'bold', 'fade', 'bg', 'wash'] as const
export const styleOf = (run: Style): Style => Object.fromEntries(STYLE.filter(key => run[key] !== undefined).map(key => [key, run[key]])) as Style
const sameStyle = (a: Style, b: Style) => STYLE.every(key => a[key] === b[key])

export const textOf = (line: Line) => line.map(run => run.text).join('')

// The panel's own text glyphs are one cell wide, whatever their Unicode width
// property: string-width counts text-presentation symbols (◼ ◻ ▶ ▪ ⏺) as emoji
// wide because they are also emoji, while terminals draw them in one cell and
// the panel's boxes, bars and goldens are laid out on that.
const ONE_CELL = new Set(['◼', '◻', '▶', '▪', '⏺'])

/** Cells one character takes: Unicode display width, zero for combining marks. */
const cellOf = (ch: string) => (ONE_CELL.has(ch) ? 1 : stringWidth(ch))

/** Display width of `text` in terminal cells. */
export const cellsOf = (text: string) => [...text].reduce((sum, ch) => sum + cellOf(ch), 0)

/** The longest head of `text` within `width` cells, and the rest. */
const cut = (text: string, width: number): [string, string] => {
  let used = 0
  let head = ''
  const chars = [...text]
  for (const [index, ch] of chars.entries()) {
    if (used + cellOf(ch) > width) return [head, chars.slice(index).join('')]
    used += cellOf(ch)
    head += ch
  }

  return [head, '']
}

/** `text` in `width` cells: padded, or cut with `…`. */
export const fit = (text: string, width: number) => {
  if (width <= 0) return ''
  const size = cellsOf(text)
  if (size <= width) return text + ' '.repeat(width - size)
  const [head] = cut(text, width - 1)

  return `${head}…${' '.repeat(width - 1 - cellsOf(head))}`
}

/** Greedy wrap on spaces; a word longer than the width is cut into pieces. */
export const wrap = (text: string, width: number): string[] => {
  width = Math.max(1, width)
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word
    while (cellsOf(rest) > width) {
      if (line !== '') lines.push(line)
      let [head, tail] = cut(rest, width)
      if (head === '') [head, tail] = [[...rest][0] ?? '', [...rest].slice(1).join('')]
      lines.push(head)
      rest = tail
      line = ''
    }
    if (line === '') line = rest
    else if (cellsOf(line) + 1 + cellsOf(rest) <= width) line += ` ${rest}`
    else {
      lines.push(line)
      line = rest
    }
  }

  return line === '' ? lines : [...lines, line]
}

type Cell = Style & { ch: string }

export const SINGLE = '┌─┐│└┘'
export const DOUBLE = '╔═╗║╚╝'
export const ROUND = '╭─╮│╰╯'

export class Canvas {
  readonly cells: Cell[][]
  readonly width: number
  readonly height: number
  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.cells = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ ch: ' ' })))
  }
  private set(line: Cell[], col: number, cell: Cell) {
    const old = line[col]
    if (old !== undefined && old.ch === '' && col > 0) line[col - 1] = { ch: ' ' }
    if (old !== undefined && cellsOf(old.ch) === 2 && col + 1 < this.width) line[col + 1] = { ch: ' ' }
    line[col] = cell
  }
  /** Writes `text` from (row, col); what falls outside is dropped, a wide char that does not fit becomes a space. Returns the column after it, in cells. */
  put(row: number, col: number, text: string, style: Style = {}): number {
    const line = this.cells[row]
    let at = col
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0
      // Control characters take no cell and never attach to the one before.
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue
      const size = cellOf(ch)
      if (line !== undefined && size === 0) {
        const prev = line[at - 1]
        if (prev !== undefined && prev.ch !== '' && at - 1 >= 0 && at - 1 < this.width) prev.ch += ch
      } else if (line !== undefined && size === 1) {
        if (at >= 0 && at < this.width) this.set(line, at, { ch, ...style })
      } else if (line !== undefined) {
        if (at >= 0 && at + 1 < this.width) {
          this.set(line, at, { ch, ...style })
          this.set(line, at + 1, { ch: '', ...style })
        } else {
          for (const c of [at, at + 1]) if (c >= 0 && c < this.width) this.set(line, c, { ch: ' ', ...style })
        }
      }
      at += size
    }

    return at
  }
  /** Writes runs one after another from (row, col). */
  runs(row: number, col: number, line: Line): number {
    let at = col
    for (const run of line) at = this.put(row, at, run.text, styleOf(run))

    return at
  }
  box(row: number, col: number, width: number, height: number, tone: Tone | Style, set = SINGLE) {
    const [tl = '┌', h = '─', tr = '┐', v = '│', bl = '└', br = '┘'] = [...set]
    const style = typeof tone === 'string' ? { tone } : tone
    this.put(row, col, `${tl}${h.repeat(width - 2)}${tr}`, style)
    for (let r = row + 1; r < row + height - 1; r += 1) {
      this.put(r, col, v, style)
      this.put(r, col + width - 1, v, style)
    }
    this.put(row + height - 1, col, `${bl}${h.repeat(width - 2)}${br}`, style)
  }
  /** Lines of runs, equal styles merged, trailing blanks dropped. */
  lines(): Line[] {
    return this.cells.map(cells => {
      const line: Run[] = []
      for (const cell of cells) {
        const last = line[line.length - 1]
        if (last && sameStyle(last, cell)) last.text += cell.ch
        else line.push({ text: cell.ch, ...styleOf(cell) })
      }
      const tail = line[line.length - 1]
      if (tail && Object.keys(styleOf(tail)).length === 0) tail.text = tail.text.trimEnd()

      return line.filter(run => run.text !== '')
    })
  }
}

/** A line as ANSI: each styled run in its colours, reset after. */
export const paint = (line: Line) =>
  line.map(run => {
    const { fg, bg } = coloursOf(run)
    if (fg === undefined && bg === undefined && !run.bold) return run.text

    return `${fg ? `\x1b[38;2;${fg.join(';')}m` : ''}${bg ? `\x1b[48;2;${bg.join(';')}m` : ''}${run.bold ? '\x1b[1m' : ''}${run.text}\x1b[0m`
  }).join('')
