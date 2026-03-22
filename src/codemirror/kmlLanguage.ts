import {
	HighlightStyle,
	LanguageSupport,
	StreamLanguage,
	type StringStream,
} from '@codemirror/language'
import { tags } from '@lezer/highlight'

type KmlState = {
	/** 1-based physical line index (including blank lines). */
	line: number
	inFrontmatter: boolean
	inCodeBlock: boolean
	inDollarDisplay: boolean
	inBracketDisplay: boolean
	inHtmlFence: boolean
}

function trimmedFrom(stream: StringStream, pos: number): string {
	return stream.string.slice(pos).trim()
}

function isFenceLine(stream: StringStream, pos: number): boolean {
	return /^\s*---\s*$/.test(stream.string.slice(pos))
}

/** KML link: first `]` closes label; URL uses nested `(` depth. */
function consumeKmlLink(stream: StringStream): boolean {
	const line = stream.string
	const pos = stream.pos
	if (line[pos] !== '[') return false
	const closeBracket = line.indexOf(']', pos + 1)
	if (closeBracket < 0) return false
	const after = line.slice(closeBracket)
	if (!after.startsWith('](')) return false
	let i = closeBracket + 2
	let depth = 1
	while (i < line.length) {
		const c = line[i]
		if (c === '(') depth++
		else if (c === ')') {
			depth--
			if (depth === 0) {
				stream.pos = i + 1
				return true
			}
		}
		i++
	}
	return false
}

/** `^[ … ]` with bracket depth (note may contain `](` for links). */
function consumeKmlFootnote(stream: StringStream): boolean {
	const line = stream.string
	const pos = stream.pos
	if (line[pos] !== '^' || line[pos + 1] !== '[') return false
	let depth = 1
	let i = pos + 2
	while (i < line.length) {
		const c = line[i]
		if (c === '[') depth++
		else if (c === ']') {
			depth--
			if (depth === 0) {
				stream.pos = i + 1
				if (stream.string[stream.pos] === '(') {
					let d = 1
					stream.pos++
					while (stream.pos < line.length) {
						const ch = line[stream.pos]
						if (ch === '(') d++
						else if (ch === ')') {
							d--
							if (d === 0) {
								stream.pos++
								break
							}
						}
						stream.pos++
					}
				}
				return true
			}
		}
		i++
	}
	return false
}

/** Balanced `{…}` with `\{` `\}` escapes (sup/sub). */
function consumeBracedAfter(stream: StringStream, openLen: 2 | 3): boolean {
	const line = stream.string
	let pos = stream.pos + openLen
	let depth = 1
	while (pos < line.length) {
		if (
			line[pos] === '\\' &&
			pos + 1 < line.length &&
			(line[pos + 1] === '{' || line[pos + 1] === '}')
		) {
			pos += 2
			continue
		}
		const c = line[pos]
		if (c === '{') depth++
		else if (c === '}') {
			depth--
			if (depth === 0) {
				stream.pos = pos + 1
				return true
			}
		}
		pos++
	}
	return false
}

function dollarDisplaySingleLine(rest: string): boolean {
	if (!rest.startsWith('$$')) return false
	const close = rest.indexOf('$$', 2)
	return close > 2
}

function dollarDisplayFenceOnly(rest: string): boolean {
	return /^\$\$\s*$/.test(rest)
}

function bracketDisplaySingleLine(rest: string): boolean {
	if (!rest.startsWith('\\[')) return false
	const close = rest.indexOf('\\]')
	return close > 2
}

function tokenFrontmatterLine(stream: StringStream): string | null {
	if (stream.sol()) {
		if (stream.match(/[^:\s]+(?=\s*:)/)) {
			stream.match(/\s*:/)
			return 'keyword'
		}
	}
	stream.skipToEnd()
	return 'string'
}

function tokenInline(stream: StringStream): string | null {
	const line = stream.string
	const pos = stream.pos

	if (line.startsWith('<br>', pos)) {
		stream.pos += 4
		return 'keyword'
	}

	if (line[pos] === '`') {
		const close = line.indexOf('`', pos + 1)
		if (close > pos) {
			stream.pos = close + 1
			return 'code'
		}
		stream.next()
		return 'code'
	}

	if (
		line[pos] === '$' &&
		(pos + 1 >= line.length || line[pos + 1] !== '$')
	) {
		const close = line.indexOf('$', pos + 1)
		if (close > pos) {
			stream.pos = close + 1
			return 'atom'
		}
		stream.next()
		return 'atom'
	}

	if (line.startsWith('\\(', pos)) {
		const rel = line.slice(pos)
		const end = rel.indexOf('\\)')
		if (end >= 0) {
			stream.pos = pos + end + 2
			return 'atom'
		}
		stream.next()
		return 'meta'
	}

	if (line.startsWith('**', pos)) {
		stream.pos += 2
		return 'strong'
	}

	if (line[pos] === '*') {
		stream.next()
		return 'em'
	}

	if (consumeKmlFootnote(stream)) return 'string.special'

	if (line[pos] === '[') {
		if (consumeKmlLink(stream)) return 'link'
		stream.next()
		return 'link'
	}

	if (line.startsWith('^{', pos)) {
		if (consumeBracedAfter(stream, 2)) return 'atom'
		stream.pos += 2
		return 'atom'
	}

	if (line.startsWith('_{', pos)) {
		if (consumeBracedAfter(stream, 2)) return 'atom'
		stream.pos += 2
		return 'atom'
	}

	if (line.startsWith('\\n', pos)) {
		stream.pos += 2
		return 'keyword'
	}

	if (stream.eol()) return null
	stream.next()
	stream.eatWhile((c) => c !== ' ' && c !== '\t')
	return null
}

function tokenHeadingRest(stream: StringStream): void {
	while (!stream.eol()) {
		stream.eatSpace()
		if (stream.eol()) break
		if (stream.match(/^\{#([^}\\]|\\.)+\}/, false)) {
			stream.match(/^\{#([^}\\]|\\.)+\}/)
			continue
		}
		const before = stream.pos
		tokenInline(stream)
		if (stream.pos === before) {
			stream.next()
		}
	}
}

const kmlStream = StreamLanguage.define<KmlState>({
	name: 'kml',

	startState() {
		return {
			line: 0,
			inFrontmatter: false,
			inCodeBlock: false,
			inDollarDisplay: false,
			inBracketDisplay: false,
			inHtmlFence: false,
		}
	},

	/** Map token names that are not valid bare Lezer tag paths. */
	tokenTable: {
		code: tags.monospace,
		hr: tags.contentSeparator,
		tag: tags.tagName,
	},

	token(stream, state) {
		if (stream.sol()) {
			state.line += 1
		}

		if (state.inHtmlFence) {
			if (stream.sol()) {
				stream.eatSpace()
				if (/^:::\s*$/.test(stream.string.slice(stream.pos))) {
					state.inHtmlFence = false
					stream.skipToEnd()
					return 'meta'
				}
			}
			stream.skipToEnd()
			return 'tag'
		}

		if (state.inCodeBlock) {
			if (stream.sol()) {
				stream.eatSpace()
				if (stream.match('```')) {
					state.inCodeBlock = false
					stream.skipToEnd()
					return 'meta'
				}
			}
			stream.skipToEnd()
			return 'code'
		}

		if (state.inFrontmatter) {
			if (stream.sol()) {
				stream.eatSpace()
				if (isFenceLine(stream, stream.pos)) {
					state.inFrontmatter = false
					stream.skipToEnd()
					return 'meta'
				}
			}
			return tokenFrontmatterLine(stream)
		}

		if (state.inDollarDisplay) {
			if (stream.sol()) {
				stream.eatSpace()
				const rest = stream.string.slice(stream.pos)
				if (dollarDisplayFenceOnly(rest)) {
					state.inDollarDisplay = false
					stream.skipToEnd()
					return 'atom'
				}
			}
			stream.skipToEnd()
			return 'atom'
		}

		if (state.inBracketDisplay) {
			if (stream.sol()) {
				stream.eatSpace()
				const t = trimmedFrom(stream, stream.pos)
				if (t === '\\]') {
					state.inBracketDisplay = false
					stream.skipToEnd()
					return 'atom'
				}
			}
			stream.skipToEnd()
			return 'atom'
		}

		if (stream.sol()) {
			stream.eatSpace()
			const pos = stream.pos
			const rest = stream.string.slice(pos)
			const trim = rest.trim()

			if (isFenceLine(stream, pos)) {
				if (state.line === 1) {
					state.inFrontmatter = true
					stream.skipToEnd()
					return 'meta'
				}
				stream.skipToEnd()
				return 'hr'
			}

			if (stream.match('```')) {
				state.inCodeBlock = true
				stream.eatWhile(/[ \t]/)
				if (stream.match(/[\w.#+-]+/)) {
					stream.skipToEnd()
					return 'meta keyword'
				}
				stream.skipToEnd()
				return 'meta'
			}

			if (/^:::html\s*$/.test(trim)) {
				state.inHtmlFence = true
				stream.skipToEnd()
				return 'meta'
			}

			if (trim.startsWith('$$')) {
				if (dollarDisplaySingleLine(rest)) {
					stream.skipToEnd()
					return 'atom'
				}
				if (dollarDisplayFenceOnly(rest)) {
					state.inDollarDisplay = true
					stream.skipToEnd()
					return 'atom'
				}
			}

			if (trim.startsWith('\\[')) {
				if (bracketDisplaySingleLine(rest)) {
					stream.skipToEnd()
					return 'atom'
				}
				state.inBracketDisplay = true
				stream.skipToEnd()
				return 'atom'
			}

			if (trim.startsWith('#')) {
				if (stream.match(/^#\[\d+\]/)) {
					tokenHeadingRest(stream)
					return 'header'
				}
				if (stream.match(/^#/)) {
					tokenHeadingRest(stream)
					return 'header'
				}
			}

			if (
				stream.match(/^-\[[^\]]+\]\s+/) ||
				stream.match(/^-\s+/) ||
				stream.match(/^=\[[^\]]+\]\s+/) ||
				stream.match(/^=(?:[0-9]+|[aAiI])\.(?:\s|$)/)
			) {
				stream.skipToEnd()
				return 'list'
			}
		}

		return tokenInline(stream)
	},
})

/** Maps parsed tags to static `cm-*` classes (pair with app `syntaxHighlighting`). */
export const kmlHighlightStyle = HighlightStyle.define([
	{ tag: tags.meta, class: 'cm-meta' },
	{ tag: tags.keyword, class: 'cm-keyword' },
	{ tag: tags.heading, class: 'cm-header' },
	{ tag: tags.list, class: 'cm-list' },
	{ tag: tags.contentSeparator, class: 'cm-hr' },
	{ tag: tags.tagName, class: 'cm-tag' },
	{ tag: tags.strong, class: 'cm-strong' },
	{ tag: tags.emphasis, class: 'cm-em' },
	{ tag: tags.link, class: 'cm-link' },
	{ tag: tags.string, class: 'cm-string' },
	{ tag: tags.special(tags.string), class: 'cm-string-special' },
	{ tag: tags.atom, class: 'cm-atom' },
	{ tag: tags.monospace, class: 'cm-code' },
])

export function kmlLanguage() {
	return new LanguageSupport(kmlStream)
}
