import type { StreamParser, StringStream } from '@codemirror/language'
import { css } from '@codemirror/legacy-modes/mode/css'
import { go } from '@codemirror/legacy-modes/mode/go'
import {
	javascript,
	json,
	typescript,
} from '@codemirror/legacy-modes/mode/javascript'
import { python } from '@codemirror/legacy-modes/mode/python'
import { rust } from '@codemirror/legacy-modes/mode/rust'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { html, xml } from '@codemirror/legacy-modes/mode/xml'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'

/** Legacy stream mode bundled for fenced ```lang``` regions. */
export type LegacyCodeMode = StreamParser<unknown>

function norm(s: string): string {
	return s.trim().toLowerCase()
}

const ALIASES: Record<string, LegacyCodeMode> = {
	js: javascript,
	javascript,
	mjs: javascript,
	cjs: javascript,
	ts: typescript,
	tsx: typescript,
	jsx: javascript,
	json,
	jsonc: json,
	py: python,
	python,
	rs: rust,
	rust,
	css,
	scss: css,
	less: css,
	html,
	htm: html,
	xml,
	svg: xml,
	yaml,
	yml: yaml,
	sh: shell,
	bash: shell,
	zsh: shell,
	go,
}

export function resolveLegacyLang(raw: string): LegacyCodeMode | null {
	const k = norm(raw)
	if (!k) return null
	return ALIASES[k] ?? null
}

export function startLegacyState(
	mode: LegacyCodeMode,
	stream: StringStream,
): unknown {
	const f = mode.startState
	if (!f) return {}
	return f(stream.indentUnit)
}

export function readLegacyToken(
	mode: LegacyCodeMode,
	stream: StringStream,
	inner: unknown,
): string | null {
	stream.start = stream.pos
	for (let i = 0; i < 12; i++) {
		const style = mode.token(stream, inner)
		if (stream.pos > stream.start) {
			return style ?? null
		}
	}
	throw new Error(`legacy mode ${mode.name ?? '?'} failed to advance`)
}
