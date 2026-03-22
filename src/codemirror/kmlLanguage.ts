import {
	HighlightStyle,
	LanguageSupport,
	StreamLanguage,
	type StringStream,
} from '@codemirror/language'
import { tags } from '@lezer/highlight'
import {
	type LegacyCodeMode,
	readLegacyToken,
	resolveLegacyLang,
	startLegacyState,
} from './legacyModes.ts'

type KmlState = {
	line: number
	inFrontmatter: boolean
	inCodeBlock: boolean
	inDollarDisplay: boolean
	inBracketDisplay: boolean
	inHtmlFence: boolean
	/** Bold / italic nesting (KML does not cross newlines). */
	inlineStack: ('b' | 'i')[]
	codeInnerMode: LegacyCodeMode | null
	codeInnerState: unknown
	/** Heuristic: previous non-blank line was a list marker line. */
	listContinuationCandidate: boolean
}

function trimmedFrom(stream: StringStream, pos: number): string {
	return stream.string.slice(pos).trim()
}

function isFenceLine(stream: StringStream, pos: number): boolean {
	return /^\s*---\s*$/.test(stream.string.slice(pos))
}

function toggleBold(state: KmlState) {
	const s = state.inlineStack
	if (s.length && s[s.length - 1] === 'b') s.pop()
	else s.push('b')
}

function toggleItalic(state: KmlState) {
	const s = state.inlineStack
	if (s.length && s[s.length - 1] === 'i') s.pop()
	else s.push('i')
}

function stackStyleTag(state: KmlState): string | null {
	const { inlineStack: st } = state
	if (!st.length) return null
	const hasB = st.includes('b')
	const hasI = st.includes('i')
	if (hasB && hasI) return 'strong em'
	if (hasB) return 'strong'
	if (hasI) return 'em'
	return null
}

function looksLikeBlockStartText(text: string): boolean {
	const u = text.trimStart()
	return (
		/^#/.test(u) ||
		/^\$\$/.test(u) ||
		/^\\\[(?:\s|$)/.test(u) ||
		/^```/.test(u) ||
		/^:::html\s*$/.test(u) ||
		/^---\s*$/.test(u) ||
		/^-\s/.test(u) ||
		/^-\[[^\]]+\]\s+/.test(u) ||
		/^=\[[^\]]+\]\s+/.test(u) ||
		/^=(?:[0-9]+|[aAiI])\.(?:\s|$)/.test(u)
	)
}

function nextDelimiterIndex(line: string, pos: number): number {
	for (let i = pos; i < line.length; i++) {
		if (line.startsWith('<br>', i)) return i
		if (line.startsWith('**', i)) return i
		if (line[i] === '*' && line[i + 1] !== '*') return i
		if (line[i] === '`') return i
		if (line[i] === '$' && line[i + 1] !== '$') return i
		if (line.startsWith('\\(', i)) return i
		if (line.startsWith('^[', i)) return i
		if (line[i] === '[') return i
		if (line.startsWith('^{', i)) return i
		if (line.startsWith('_{', i)) return i
		if (line.startsWith('\\n', i)) return i
	}
	return -1
}

function eatBacktickRun(
	stream: StringStream,
	line: string,
	pos: number,
): string {
	let n = 0
	while (pos + n < line.length && line[pos + n] === '`') n++
	stream.pos = pos + n
	if (n === 0) {
		stream.next()
		return 'code'
	}
	const fence = '`'.repeat(n)
	const close = line.indexOf(fence, stream.pos)
	if (close >= 0) {
		stream.pos = close + n
	} else {
		stream.skipToEnd()
	}
	return 'code'
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

function tokenInlineRich(stream: StringStream, state: KmlState): string | null {
	const line = stream.string
	const pos = stream.pos

	if (line.startsWith('<br>', pos)) {
		stream.pos += 4
		return 'keyword'
	}

	if (line[pos] === '`') {
		return eatBacktickRun(stream, line, pos)
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
		stream.pos = pos + 2
		toggleBold(state)
		return 'strong'
	}

	if (line[pos] === '*' && line[pos + 1] !== '*') {
		stream.pos = pos + 1
		toggleItalic(state)
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
		stream.pos = pos + 2
		return 'atom'
	}

	if (line.startsWith('_{', pos)) {
		if (consumeBracedAfter(stream, 2)) return 'atom'
		stream.pos = pos + 2
		return 'atom'
	}

	if (line.startsWith('\\n', pos)) {
		stream.pos += 2
		return 'keyword'
	}

	const nx = nextDelimiterIndex(line, pos)
	const st = stackStyleTag(state)
	if (nx < 0) {
		if (stream.eol()) return null
		stream.next()
		return st
	}
	if (nx > pos) {
		stream.pos = nx
		return st
	}

	if (!stream.eol()) stream.next()
	return st
}

function tokenHeadingRest(stream: StringStream, state: KmlState): void {
	while (!stream.eol()) {
		stream.eatSpace()
		if (stream.eol()) break
		if (stream.match(/^\{#([^}\\]|\\.)+\}/, false)) {
			stream.match(/^\{#([^}\\]|\\.)+\}/)
			continue
		}
		const before = stream.pos
		tokenInlineRich(stream, state)
		if (stream.pos === before) {
			stream.next()
		}
	}
}

function initCodeInnerState(state: KmlState, stream: StringStream) {
	if (!state.codeInnerMode) return
	if (state.codeInnerState == null) {
		state.codeInnerState = startLegacyState(state.codeInnerMode, stream)
		return
	}
	if (!state.codeInnerMode.copyState) {
		state.codeInnerState = startLegacyState(state.codeInnerMode, stream)
	}
}

function copyKmlState(state: KmlState): KmlState {
	const next: KmlState = {
		...state,
		inlineStack: [...state.inlineStack],
	}
	if (state.codeInnerMode?.copyState && state.codeInnerState != null) {
		next.codeInnerState = state.codeInnerMode.copyState(
			state.codeInnerState,
		)
	} else if (
		state.codeInnerState != null &&
		typeof state.codeInnerState === 'object'
	) {
		try {
			next.codeInnerState = structuredClone(state.codeInnerState)
		} catch {
			next.codeInnerState = state.codeInnerState
		}
	}
	return next
}

const kmlStream = StreamLanguage.define<KmlState>({
	name: 'kml',
	copyState: copyKmlState,

	startState() {
		return {
			line: 0,
			inFrontmatter: false,
			inCodeBlock: false,
			inDollarDisplay: false,
			inBracketDisplay: false,
			inHtmlFence: false,
			inlineStack: [],
			codeInnerMode: null,
			codeInnerState: null,
			listContinuationCandidate: false,
		}
	},

	blankLine(state) {
		state.listContinuationCandidate = false
	},

	tokenTable: {
		code: tags.monospace,
		hr: tags.contentSeparator,
		tag: tags.tagName,
	},

	token(stream, state) {
		if (stream.sol()) {
			state.line += 1
			const blockish =
				state.inCodeBlock ||
				state.inFrontmatter ||
				state.inDollarDisplay ||
				state.inBracketDisplay ||
				state.inHtmlFence
			if (!blockish) {
				state.inlineStack = []
			}
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
					state.codeInnerMode = null
					state.codeInnerState = null
					stream.skipToEnd()
					return 'meta'
				}
				initCodeInnerState(state, stream)
			}
			if (state.codeInnerMode && state.codeInnerState != null) {
				try {
					const t = readLegacyToken(
						state.codeInnerMode,
						stream,
						state.codeInnerState,
					)
					return t ?? 'code'
				} catch {
					stream.skipToEnd()
					return 'code'
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

			if (
				state.listContinuationCandidate &&
				/^(\s{2,})(.+)$/.test(stream.string)
			) {
				const m = /^(\s{2,})(.+)$/.exec(
					stream.string,
				) as RegExpExecArray
				const body = m[2]
				if (!looksLikeBlockStartText(body)) {
					stream.skipToEnd()
					return 'quote'
				}
			}

			if (isFenceLine(stream, pos)) {
				state.listContinuationCandidate = false
				if (state.line === 1) {
					state.inFrontmatter = true
					stream.skipToEnd()
					return 'meta'
				}
				stream.skipToEnd()
				return 'hr'
			}

			if (stream.match('```')) {
				state.listContinuationCandidate = false
				state.inCodeBlock = true
				stream.eatWhile(/[ \t]/)
				let lang = ''
				const beforeLang = stream.pos
				if (stream.match(/[\w.#+-]+/)) {
					lang = stream.string.slice(beforeLang, stream.pos).trim()
				}
				state.codeInnerMode = resolveLegacyLang(lang)
				state.codeInnerState = null
				stream.skipToEnd()
				return lang ? 'meta keyword' : 'meta'
			}

			if (/^:::html\s*$/.test(trim)) {
				state.listContinuationCandidate = false
				state.inHtmlFence = true
				stream.skipToEnd()
				return 'meta'
			}

			if (trim.startsWith('$$')) {
				state.listContinuationCandidate = false
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
				state.listContinuationCandidate = false
				if (bracketDisplaySingleLine(rest)) {
					stream.skipToEnd()
					return 'atom'
				}
				state.inBracketDisplay = true
				stream.skipToEnd()
				return 'atom'
			}

			if (trim.startsWith('#')) {
				state.listContinuationCandidate = false
				if (stream.match(/^#\[\d+\]/)) {
					tokenHeadingRest(stream, state)
					return 'header'
				}
				if (stream.match(/^#/)) {
					tokenHeadingRest(stream, state)
					return 'header'
				}
			}

			if (
				stream.match(/^-\[[^\]]+\]\s+/) ||
				stream.match(/^-\s+/) ||
				stream.match(/^=\[[^\]]+\]\s+/) ||
				stream.match(/^=(?:[0-9]+|[aAiI])\.(?:\s|$)/)
			) {
				state.listContinuationCandidate = true
				stream.skipToEnd()
				return 'list'
			}
		}

		return tokenInlineRich(stream, state)
	},
})

export const kmlHighlightStyle = HighlightStyle.define([
	{ tag: tags.meta, class: 'cm-meta' },
	{ tag: tags.keyword, class: 'cm-keyword' },
	{ tag: tags.heading, class: 'cm-header' },
	{ tag: tags.list, class: 'cm-list' },
	{ tag: tags.quote, class: 'cm-quote' },
	{ tag: tags.contentSeparator, class: 'cm-hr' },
	{ tag: tags.tagName, class: 'cm-tag' },
	{ tag: tags.strong, class: 'cm-strong' },
	{ tag: tags.emphasis, class: 'cm-em' },
	{ tag: tags.link, class: 'cm-link' },
	{ tag: tags.url, class: 'cm-url' },
	{ tag: tags.string, class: 'cm-string' },
	{ tag: tags.special(tags.string), class: 'cm-string-special' },
	{ tag: tags.atom, class: 'cm-atom' },
	{ tag: tags.monospace, class: 'cm-code' },
	{ tag: tags.definition(tags.variableName), class: 'cm-def' },
	{ tag: tags.comment, class: 'cm-comment' },
	{ tag: tags.operator, class: 'cm-operator' },
	{ tag: tags.number, class: 'cm-number' },
])

export function kmlLanguage() {
	return new LanguageSupport(kmlStream)
}
