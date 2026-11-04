import {flushSync} from "react-dom";
import type {SettingsSection, SettingsService} from "@lodestory/sdk/settings";

export type SettingsSnapshot = Readonly<{
  open: boolean;
  selectedId: string | null;
  sections: readonly SettingsSection[];
}>;

/** Application-scoped state; each contribution remains owned by its registering plugin. */
export function createSettingsStore() {
  const sections = new Map<string, SettingsSection>();
  const listeners = new Set<() => void>();
  let active = true;
  let started = false;
  let snapshot: SettingsSnapshot = Object.freeze({open: false, selectedId: null, sections: Object.freeze([])});
  const sortedSections = () => [...sections.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  function publish(open: boolean, selectedId: string | null) {
    const ordered = sortedSections();
    if (snapshot.open === open && snapshot.selectedId === selectedId && snapshot.sections.length === ordered.length
      && snapshot.sections.every((section, index) => section === ordered[index])) return;
    snapshot = Object.freeze({open, selectedId, sections: Object.freeze(ordered)});
    for (const listener of [...listeners]) {
      try { listener(); } catch (error) { console.error("Settings subscriber failed.", {error}); }
    }
  }

  const service: SettingsService = Object.freeze({
    open(sectionId) {
      if (!active || !started || sectionId !== undefined && !sections.has(sectionId)) return false;
      const selectedId = sectionId ?? (snapshot.selectedId && sections.has(snapshot.selectedId) ? snapshot.selectedId : snapshot.sections[0]?.id);
      if (!selectedId) return false;
      publish(true, selectedId);
      return true;
    },
    registerSection(section) {
      if (!active) throw new Error("Settings service is no longer active.");
      if (started) throw new Error("Settings sections must be registered before pluginsReady.");
      if (!section || typeof section !== "object") throw new TypeError("Settings section must be an object.");
      if (typeof section.id !== "string" || !section.id.trim()) throw new Error("Settings section id cannot be empty.");
      if (typeof section.group !== "string" || !section.group.trim()) throw new Error("Settings section group cannot be empty.");
      if (typeof section.title !== "string" || !section.title.trim()) throw new Error("Settings section title cannot be empty.");
      if (section.order !== undefined && !Number.isFinite(section.order)) throw new Error("Settings section order must be finite.");
      if (typeof section.render !== "function") throw new Error("Settings section must have a render function.");
      if (sections.has(section.id)) throw new Error(`Settings section '${section.id}' is already registered.`);
      const entry = Object.freeze({id: section.id, group: section.group, title: section.title, order: section.order ?? 0, render: section.render});
      sections.set(entry.id, entry);
      publish(snapshot.open, snapshot.selectedId);
      return () => {
        if (sections.get(entry.id) !== entry) return;
        const remove = () => {
          sections.delete(entry.id);
          const next = snapshot.selectedId === entry.id ? sortedSections()[0]?.id ?? null : snapshot.selectedId;
          publish(snapshot.open && next !== null, next);
        };
        // A contributor can release its services as soon as this disposer returns.
        if (started && snapshot.open && snapshot.selectedId === entry.id) flushSync(remove);
        else remove();
      };
    },
  });

  return {
    service,
    start() { if (active) started = true; },
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { if (!active) return () => {}; listeners.add(listener); return () => { listeners.delete(listener); }; },
    select(id: string) { if (active && sections.has(id)) publish(snapshot.open, id); },
    close() { if (active) publish(false, snapshot.selectedId); },
    dispose() { active = false; sections.clear(); listeners.clear(); },
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
