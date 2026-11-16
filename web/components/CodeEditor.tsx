'use client';

// The Monaco editor (the editor inside VS Code) with our dark theme.
// Two modes:
//   - live:   pass `ytext` + `awareness`, edits are shared through Yjs
//   - replay: pass `value`, read-only, with an optional caret marker

import Editor, { loader, type Monaco } from '@monaco-editor/react';
import type * as MonacoTypes from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { Language } from '@/lib/api';
import { bindMonaco } from '@/lib/yMonaco';

// Load Monaco from our own /public copy instead of a CDN (see scripts/copy-monaco.mjs).
loader.config({ paths: { vs: '/monaco/vs' } });

function defineTheme(monaco: Monaco) {
  monaco.editor.defineTheme('codepair', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '5b6375', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'a99bff' },
      { token: 'string', foreground: '7fd6a8' },
      { token: 'number', foreground: 'f5b84b' },
    ],
    colors: {
      'editor.background': '#0a0c10',
      'editor.lineHighlightBackground': '#11151c',
      'editorLineNumber.foreground': '#3a4254',
      'editorLineNumber.activeForeground': '#8a93a6',
      'editorCursor.foreground': '#8b7cff',
      'editor.selectionBackground': '#8b7cff40',
      'editorIndentGuide.background1': '#161a22',
      'editorWidget.background': '#0f1218',
      'scrollbarSlider.background': '#2a314080',
    },
  });
}

interface Props {
  language: Language;
  // live mode
  ytext?: Y.Text;
  awareness?: Awareness;
  onRun?: () => void;
  // replay mode
  value?: string;
  caretOffset?: number | null;
}

export default function CodeEditor({ language, ytext, awareness, onRun, value, caretOffset }: Props) {
  const [mounted, setMounted] = useState<{
    editor: MonacoTypes.editor.IStandaloneCodeEditor;
    monaco: Monaco;
  } | null>(null);
  const readOnly = !ytext;

  // Keep the latest onRun without re-registering the keyboard shortcut.
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  // Live mode: connect the editor to the shared text once both exist.
  useEffect(() => {
    if (!mounted || !ytext || !awareness) return;
    return bindMonaco(mounted.monaco, mounted.editor, ytext, awareness);
  }, [mounted, ytext, awareness]);

  // Replay mode: show where the latest keystroke happened and keep it in view.
  const caretDecoration = useRef<MonacoTypes.editor.IEditorDecorationsCollection | null>(null);
  useEffect(() => {
    if (!mounted || !readOnly) return;
    const { editor, monaco } = mounted;
    const model = editor.getModel();
    if (!model) return;
    caretDecoration.current ??= editor.createDecorationsCollection();
    if (caretOffset === null || caretOffset === undefined) return caretDecoration.current.clear();
    const position = model.getPositionAt(caretOffset);
    caretDecoration.current.set([
      {
        range: monaco.Range.fromPositions(position, position),
        options: { beforeContentClassName: 'replay-caret' },
      },
    ]);
    editor.revealPositionInCenterIfOutsideViewport(position);
  }, [mounted, readOnly, caretOffset, value]);

  return (
    <Editor
      theme="codepair"
      language={language}
      // In live mode the binding owns the text, so no `value` is passed.
      value={readOnly ? (value ?? '') : undefined}
      beforeMount={defineTheme}
      onMount={(editor, monaco) => {
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onRunRef.current?.());
        setMounted({ editor, monaco });
      }}
      loading={<div className="text-sm text-faint">Loading editor…</div>}
      options={{
        readOnly,
        fontSize: 14,
        lineHeight: 22,
        fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
        fontLigatures: true,
        minimap: { enabled: false },
        padding: { top: 16, bottom: 16 },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorSmoothCaretAnimation: 'on',
        renderLineHighlight: 'line',
        tabSize: 4,
        automaticLayout: true, // re-measure when the window is resized
        overviewRulerLanes: 0,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      }}
    />
  );
}
