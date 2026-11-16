// The binding between the Monaco editor and the shared Yjs text.
//
// It does three jobs:
//   1. local edits   -> Y.Text       (so they are sent to everyone)
//   2. Y.Text changes -> the editor   (edits made by other people)
//   3. cursors       <-> awareness    (show where everyone else is)
//
// The y-monaco package does the same; this is a ~150 line version written for
// this project so that every step can be read and explained.

import type * as Monaco from 'monaco-editor';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

// Tags our own transactions so the Y.Text observer can tell "I typed this"
// from "this came from someone else".
const LOCAL = 'local-editor';

export function bindMonaco(
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  ytext: Y.Text,
  awareness: Awareness,
): () => void {
  const model = editor.getModel()!;
  const doc = ytext.doc!;
  let applyingRemote = false; // true while we are writing remote edits into the editor

  // WHY force "\n" line endings: Monaco may use "\r\n" on Windows. Positions in
  // Y.Text are plain character offsets, so both sides must count line breaks
  // the same way or every offset after the first newline would be wrong.
  // (setEOL must come after setValue, because setValue resets the line ending.)
  applyingRemote = true;
  model.setValue(ytext.toString());
  model.setEOL(monaco.editor.EndOfLineSequence.LF);
  applyingRemote = false;

  // ---- 1. local edits -> Y.Text ----
  const localSub = model.onDidChangeContent((event) => {
    if (applyingRemote) return;
    doc.transact(() => {
      // One event can hold several changes (multi-cursor, find/replace). Their
      // offsets all refer to the text BEFORE the event, so we apply them from
      // the end of the document backwards: an edit never shifts the offsets
      // of the edits still to come.
      const changes = [...event.changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
      for (const change of changes) {
        if (change.rangeLength > 0) ytext.delete(change.rangeOffset, change.rangeLength);
        if (change.text) ytext.insert(change.rangeOffset, change.text.replace(/\r\n/g, '\n'));
      }
    }, LOCAL);
  });

  // ---- 2. Y.Text changes -> editor ----
  const onYText = (event: Y.YTextEvent, transaction: Y.Transaction) => {
    if (transaction.origin !== LOCAL) {
      applyingRemote = true;
      // A delta is a list of steps that walk through the text:
      // retain n (skip n characters), insert "abc", delete n.
      let index = 0;
      for (const step of event.delta) {
        if (step.retain !== undefined) {
          index += step.retain;
        } else if (typeof step.insert === 'string') {
          const at = model.getPositionAt(index);
          model.applyEdits([{ range: monaco.Range.fromPositions(at, at), text: step.insert }]);
          index += step.insert.length;
        } else if (step.delete !== undefined) {
          const range = monaco.Range.fromPositions(
            model.getPositionAt(index),
            model.getPositionAt(index + step.delete),
          );
          model.applyEdits([{ range, text: '' }]);
        }
      }
      applyingRemote = false;
    }
    renderCursors(); // any edit can move other people's cursors
  };
  ytext.observe(onYText);

  // ---- undo/redo ----
  // WHY not Monaco's own undo: it would also undo text typed by other people.
  // Y.UndoManager only tracks transactions tagged LOCAL, i.e. my own edits.
  const undoManager = new Y.UndoManager(ytext, { trackedOrigins: new Set([LOCAL]) });
  const { KeyMod, KeyCode } = monaco;
  editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyZ, () => undoManager.undo());
  editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyY, () => undoManager.redo());
  editor.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ, () => undoManager.redo());

  // ---- 3a. my cursor -> awareness ----
  // WHY relative positions: "offset 42" becomes wrong the moment someone types
  // before it. A relative position points at a character's CRDT id instead,
  // so it stays attached to the same place in the text.
  const cursorSub = editor.onDidChangeCursorSelection((event) => {
    const { selection } = event;
    const toRelative = (position: Monaco.Position) =>
      Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, model.getOffsetAt(position)));
    awareness.setLocalStateField('cursor', {
      anchor: toRelative(selection.getSelectionStart()),
      head: toRelative(selection.getPosition()),
    });
  });

  // ---- 3b. other people's cursors -> editor decorations ----
  const decorations = editor.createDecorationsCollection();
  const style = document.createElement('style');
  document.head.appendChild(style);

  function renderCursors() {
    const next: Monaco.editor.IModelDeltaDecoration[] = [];
    let css = '';
    awareness.getStates().forEach((state, clientId) => {
      if (clientId === doc.clientID || !state.cursor || !state.user) return;
      const toIndex = (json: unknown) =>
        Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), doc)?.index;
      const anchor = toIndex(state.cursor.anchor);
      const head = toIndex(state.cursor.head);
      if (anchor === undefined || head === undefined) return;

      const headPosition = model.getPositionAt(head);
      next.push({
        range: monaco.Range.fromPositions(
          model.getPositionAt(Math.min(anchor, head)),
          model.getPositionAt(Math.max(anchor, head)),
        ),
        options: { className: `rc-selection-${clientId}` },
      });
      next.push({
        range: monaco.Range.fromPositions(headPosition, headPosition),
        options: { beforeContentClassName: `rc-caret rc-caret-${clientId}` },
      });

      // WHY validate: name and colour come from another user's browser and are
      // placed into a stylesheet. Only a strict hex colour and a name without
      // quote or escape characters are allowed, so they cannot inject CSS.
      const color = /^#[0-9a-f]{6}$/i.test(state.user.color) ? state.user.color : '#8b7cff';
      const name = String(state.user.name ?? '').replace(/[^\w .-]/g, '').slice(0, 24);
      css += `.rc-selection-${clientId}{background:${color}40}`;
      css += `.rc-caret-${clientId}{border-color:${color}}`;
      css += `.rc-caret-${clientId}::after{content:"${name}";background:${color}}`;
    });
    decorations.set(next);
    style.textContent = css;
  }
  awareness.on('change', renderCursors);
  renderCursors();

  // Returns a cleanup function, called when the editor is removed.
  return () => {
    localSub.dispose();
    cursorSub.dispose();
    ytext.unobserve(onYText);
    awareness.off('change', renderCursors);
    undoManager.destroy();
    decorations.clear();
    style.remove();
  };
}
