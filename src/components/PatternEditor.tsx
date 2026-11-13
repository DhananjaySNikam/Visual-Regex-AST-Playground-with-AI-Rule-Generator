import { useCallback, useEffect, useRef } from 'react'
import Editor, { type Monaco, type OnMount } from '@monaco-editor/react'
import type { editor as MonacoEditor } from 'monaco-editor'
import type { ParseError } from '../../shared/regex/types'

export interface PatternEditorProps {
  value: string
  onChange: (v: string) => void
  /** Source range of the node currently hovered/pinned in the graph. */
  highlight: { start: number; end: number } | null
  error: ParseError | null
  /** Editor cursor offset → drives graph highlighting in the reverse direction. */
  onCursorOffset: (offset: number) => void
  vim?: boolean
}

const THEME = 'regex-atlas'

function defineTheme(monaco: Monaco) {
  monaco.editor.defineTheme(THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: 'c084fc' },
      { token: 'string', foreground: '7dd3fc' },
      { token: 'number', foreground: 'fbbf24' },
      { token: 'delimiter', foreground: '64748b' },
      { token: 'type.identifier', foreground: '34d399' },
    ],
    colors: {
      'editor.background': '#080c13',
      'editor.foreground': '#dbe4f0',
      'editorLineNumber.foreground': '#334155',
      'editorLineNumber.activeForeground': '#94a3b8',
      'editor.selectionBackground': '#1e3a5f66',
      'editor.lineHighlightBackground': '#0e1521',
      'editorCursor.foreground': '#22d3ee',
      'editorIndentGuide.background1': '#131c29',
      'editorWidget.background': '#0b121c',
      'editorWidget.border': '#1e293b',
    },
  })
}

/**
 * Monaco wrapper that owns the highlight plumbing.
 *
 * Decoration rendering happens imperatively (via the editor API) instead of
 * through React state, so hovering across 200 nodes never re-renders the tree.
 */
export function PatternEditor({ value, onChange, highlight, error, onCursorOffset }: PatternEditorProps) {
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<Monaco | null>(null)
  const decorationsRef = useRef<MonacoEditor.IEditorDecorationsCollection | null>(null)
  const suppressCursor = useRef(false)

  const onMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor
      monacoRef.current = monaco
      defineTheme(monaco)
      monaco.editor.setTheme(THEME)
      decorationsRef.current = editor.createDecorationsCollection([])

      editor.onDidChangeCursorPosition((e) => {
        if (suppressCursor.current) return
        const model = editor.getModel()
        if (!model) return
        onCursorOffset(model.getOffsetAt(e.position))
      })

      editor.focus()
    },
    [onCursorOffset],
  )

  // Draw / clear the active-node range decoration.
  useEffect(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    const decorations = decorationsRef.current
    if (!editor || !monaco || !decorations) return

    if (!highlight) {
      decorations.set([])
      return
    }
    const model = editor.getModel()
    if (!model) return
    const max = model.getValueLength()
    const start = Math.min(highlight.start, max)
    const end = Math.min(Math.max(highlight.end, start + 1), max)
    const from = model.getPositionAt(start)
    const to = model.getPositionAt(end)

    decorations.set([
      {
        range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column),
        options: {
          inlineClassName: 'monaco-node-highlight',
          className: 'monaco-node-highlight-block',
          overviewRuler: {
            color: '#22d3ee',
            position: monaco.editor.OverviewRulerLane.Center,
          },
        },
      },
    ])

    // Keep the highlighted token in view without stealing focus.
    suppressCursor.current = true
    editor.revealRangeInCenterIfOutsideViewport(
      new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column),
      0,
    )
    suppressCursor.current = false
  }, [highlight])

  // Surface parse errors as editor markers.
  useEffect(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco) return
    const model = editor.getModel()
    if (!model) return
    if (!error) {
      monaco.editor.setModelMarkers(model, 'regex', [])
      return
    }
    const pos = model.getPositionAt(Math.min(error.index, model.getValueLength()))
    monaco.editor.setModelMarkers(model, 'regex', [
      {
        severity: monaco.MarkerSeverity.Error,
        message: error.message,
        startLineNumber: pos.lineNumber,
        startColumn: pos.column,
        endLineNumber: pos.lineNumber,
        endColumn: pos.column + 1,
      },
    ])
  }, [error])

  return (
    <Editor
      height="100%"
      defaultLanguage="regex-atlas"
      theme={THEME}
      value={value}
      beforeMount={(monaco) => {
        defineTheme(monaco)
        // Register a tiny Monarch grammar so regex reads as code, not plain text.
        monaco.languages.register({ id: 'regex-atlas' })
        monaco.languages.setMonarchTokensProvider('regex-atlas', {
          tokenizer: {
            root: [
              [/\\./, 'string.escape'],
              [/\[/, 'delimiter.bracket', '@class'],
              [/[()|]/, 'keyword'],
              [/\{\d+(,\d*)?\}/, 'number'],
              [/[?*+]/, 'keyword'],
              [/[^\\[\](|){?*+]+/, 'type.identifier'],
            ],
            class: [
              [/\\./, 'string.escape'],
              [/[^\]]+/, 'string'],
              [/\]/, 'delimiter.bracket', '@pop'],
            ],
          },
        })
        monaco.languages.setLanguageConfiguration('regex-atlas', {
          brackets: [
            ['[', ']'],
            ['(', ')'],
          ],
          autoClosingPairs: [
            { open: '[', close: ']' },
            { open: '(', close: ')' },
          ],
        })
      }}
      onMount={onMount}
      onChange={(v) => onChange(v ?? '')}
      options={{
        fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 15,
        lineHeight: 26,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderLineHighlight: 'none',
        padding: { top: 14, bottom: 14 },
        wordWrap: 'on',
        overviewRulerLanes: 1,
        overviewRulerBorder: false,
        folding: false,
        glyphMargin: false,
        lineNumbers: 'off',
        renderWhitespace: 'selection',
        quickSuggestions: false,
        suggestOnTriggerCharacters: false,
        occurrencesHighlight: 'off',
        contextmenu: false,
        tabSize: 2,
        automaticLayout: true,
        scrollbar: { vertical: 'auto', horizontal: 'hidden', verticalScrollbarSize: 8 },
        bracketPairColorization: { enabled: true },
      }}
    />
  )
}
