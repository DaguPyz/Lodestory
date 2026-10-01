import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { DocumentSession } from "./DocumentSession";
import { documentErrorMessage, readDocument, saveDocument, type DocumentRecord, type WorkspaceDocument } from "./documentApi";

export function useDocumentWorkspace(projectPath: string) {
  const sessions = useRef(new Map<string, DocumentSession>());
  const openingSequence = useRef(0);
  const [documents, setDocuments] = useState<WorkspaceDocument[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const publish = useCallback(() => {
    setDocuments([...sessions.current.values()].map((session) => session.document));
  }, []);

  const install = useCallback((record: DocumentRecord, select = true) => {
    const id = encodeURIComponent(record.path);
    if (!sessions.current.has(id)) {
      sessions.current.set(id, new DocumentSession(record,
        (path, content, expectedContent) => saveDocument(projectPath, path, content, expectedContent), publish));
      publish();
    }
    if (select) {
      setActiveId(id);
      requestAnimationFrame(() => document.getElementById(`editor-document-input-${id}`)?.focus());
    }
  }, [projectPath, publish]);

  const open = useCallback(async (path: string) => {
    const sequence = ++openingSequence.current;
    setError(null);
    const existing = sessions.current.get(encodeURIComponent(path));
    if (existing) { install(existing.document); setOpeningPath(null); return; }
    setOpeningPath(path);
    try {
      const record = await readDocument(projectPath, path);
      if (sequence === openingSequence.current) install(record);
    } catch (cause) {
      if (sequence === openingSequence.current) setError(documentErrorMessage(cause));
    } finally {
      if (sequence === openingSequence.current) setOpeningPath(null);
    }
  }, [projectPath, install]);

  function openCreated(record: DocumentRecord) {
    openingSequence.current += 1;
    setOpeningPath(null);
    setError(null);
    install(record);
  }

  async function close(id: string) {
    const session = sessions.current.get(id);
    if (!session) return;
    if (!await session.save()) {
      setActiveId(id);
      requestAnimationFrame(() => document.getElementById(`editor-document-input-${id}`)?.focus());
      return;
    }
    const ids = [...sessions.current.keys()];
    const index = ids.indexOf(id);
    sessions.current.delete(id);
    session.dispose();
    publish();
    const remaining = [...sessions.current.keys()];
    const nextId = remaining[Math.max(0, index - 1)] ?? null;
    setActiveId((current) => current === id ? nextId : current);
    requestAnimationFrame(() => {
      const focusId = activeIdRef.current;
      document.getElementById(focusId ? `document-tab-${focusId}` : "editor-empty-title")?.focus();
    });
  }

  const saveAll = useCallback(async () => {
    const openSessions = [...sessions.current.values()];
    const results = await Promise.all(openSessions.map((session) => session.save()));
    const failed = openSessions.find((_session, index) => !results[index]);
    if (failed) setActiveId(failed.document.id);
    return !failed;
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let stop: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested(async (event) => {
      if (!await saveAll()) event.preventDefault();
    }).then((unlisten) => {
      if (alive) stop = unlisten; else unlisten();
    }).catch((cause) => { if (alive) setError(documentErrorMessage(cause)); });
    return () => { alive = false; stop?.(); };
  }, [saveAll]);

  useEffect(() => {
    const openSessions = sessions.current;
    return () => {
      openingSequence.current += 1;
      for (const session of openSessions.values()) session.dispose();
    };
  }, []);

  return {
    documents, activeId, currentDocument: documents.find((record) => record.id === activeId),
    openingPath, error, clearError: () => setError(null), select: setActiveId,
    open, openCreated, close, saveAll,
    update: (id: string, content: string) => sessions.current.get(id)?.update(content),
    save: (id: string) => sessions.current.get(id)?.save() ?? Promise.resolve(true),
  };
}
