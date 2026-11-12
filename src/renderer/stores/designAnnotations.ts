import {
  type AnnotateFamiliarity,
  annotateFamiliarityOf,
  createAnnotationQueueReducer,
  type DesignAnnotation,
  type DesignAnnotationDraft,
  type DesignAnnotationImage,
  type DesignAnnotationQueueAction,
  type DesignAnnotationQueueState,
  designModePageKey,
  parsePersistedAnnotations,
  serializePersistedAnnotations,
} from '@shared/browser/designAnnotation';
import { create } from 'zustand';

const STORAGE_KEY_ANNOTATIONS = 'enso:design-annotations:v1';
const STORAGE_KEY_PREFS = 'enso:annotate-prefs:v1';

const queueReducer = createAnnotationQueueReducer((item) => item.pageKey);
const EMPTY_ITEMS: readonly DesignAnnotation[] = [];
const filteredByBrowserCache = new WeakMap<
  readonly DesignAnnotation[],
  Map<string, readonly DesignAnnotation[]>
>();

interface AnnotatePrefs {
  annotateHovered: boolean;
  annotateEntered: boolean;
  annotateUseCount: number;
  annotateSendImmediately: boolean;
}

const DEFAULT_PREFS: AnnotatePrefs = {
  annotateHovered: false,
  annotateEntered: false,
  annotateUseCount: 0,
  annotateSendImmediately: true,
};

function readStorage(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch {
    // 忽略存储配额错误
  }
}

function loadPrefs(): AnnotatePrefs {
  const raw = readStorage(STORAGE_KEY_PREFS);
  if (!raw) return DEFAULT_PREFS;
  try {
    const parsed = JSON.parse(raw) as Partial<AnnotatePrefs>;
    return {
      annotateHovered:
        typeof parsed.annotateHovered === 'boolean'
          ? parsed.annotateHovered
          : DEFAULT_PREFS.annotateHovered,
      annotateEntered:
        typeof parsed.annotateEntered === 'boolean'
          ? parsed.annotateEntered
          : DEFAULT_PREFS.annotateEntered,
      annotateUseCount:
        typeof parsed.annotateUseCount === 'number' && Number.isFinite(parsed.annotateUseCount)
          ? parsed.annotateUseCount
          : DEFAULT_PREFS.annotateUseCount,
      annotateSendImmediately:
        typeof parsed.annotateSendImmediately === 'boolean'
          ? parsed.annotateSendImmediately
          : DEFAULT_PREFS.annotateSendImmediately,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs: AnnotatePrefs): void {
  writeStorage(STORAGE_KEY_PREFS, JSON.stringify(prefs));
}

export interface RegisteredDesignSession {
  agent: string;
  exit: () => void;
  reveal: (id: string) => void;
  pinned: Set<string>;
}

interface DesignAnnotationsStoreState extends AnnotatePrefs {
  queues: Map<string, DesignAnnotationQueueState>;
  pages: Map<string, string>;
  sessions: Map<string, RegisteredDesignSession>;
  familiarity: () => AnnotateFamiliarity;
  markHovered: () => void;
  markEntered: () => void;
  setSendImmediately: (value: boolean) => void;
  annotationsFor: (agent: string, browserId?: string) => readonly DesignAnnotation[];
  pageKeyOf: (browserId: string) => string | undefined;
  setBrowserUrl: (browserId: string, url: string) => void;
  dispatchQueue: (agent: string, action: DesignAnnotationQueueAction) => void;
  addAnnotation: (agent: string, draft: DesignAnnotationDraft) => DesignAnnotation | undefined;
  updateAnnotation: (
    agent: string,
    id: string,
    comment: string,
    images?: DesignAnnotationImage[]
  ) => void;
  removeAnnotations: (agent: string, ids: Iterable<string>) => void;
  clearAnnotations: (agent: string, browserId?: string) => void;
  restoreAnnotations: (agent: string, items: readonly DesignAnnotation[]) => void;
  registerSession: (
    browserId: string,
    session: { url: string; agent: string; exit: () => void; reveal: (id: string) => void }
  ) => () => void;
  setPinnedIds: (browserId: string, ids: Iterable<string>) => void;
  exitAgentSessions: (agent: string) => void;
  resetForTests: () => void;
}

const initialHydrated = parsePersistedAnnotations(readStorage(STORAGE_KEY_ANNOTATIONS));
const initialPrefs = loadPrefs();

function persistAnnotationsState(
  queues: Map<string, DesignAnnotationQueueState>,
  pages: Map<string, string>
): void {
  writeStorage(STORAGE_KEY_ANNOTATIONS, serializePersistedAnnotations({ queues, pages }));
}

export const useDesignAnnotationsStore = create<DesignAnnotationsStoreState>((set, get) => ({
  ...initialPrefs,
  queues: initialHydrated.queues,
  pages: initialHydrated.pages,
  sessions: new Map(),

  familiarity: () => {
    const s = get();
    return annotateFamiliarityOf(s.annotateEntered, s.annotateUseCount);
  },

  markHovered: () => {
    const s = get();
    if (s.annotateHovered) return;
    const next: AnnotatePrefs = {
      annotateHovered: true,
      annotateEntered: s.annotateEntered,
      annotateUseCount: s.annotateUseCount,
      annotateSendImmediately: s.annotateSendImmediately,
    };
    savePrefs(next);
    set({ annotateHovered: true });
  },

  markEntered: () => {
    const s = get();
    if (s.annotateEntered) return;
    const next: AnnotatePrefs = {
      annotateHovered: s.annotateHovered,
      annotateEntered: true,
      annotateUseCount: s.annotateUseCount,
      annotateSendImmediately: s.annotateSendImmediately,
    };
    savePrefs(next);
    set({ annotateEntered: true });
  },

  setSendImmediately: (value: boolean) => {
    const s = get();
    if (s.annotateSendImmediately === value) return;
    const next: AnnotatePrefs = {
      annotateHovered: s.annotateHovered,
      annotateEntered: s.annotateEntered,
      annotateUseCount: s.annotateUseCount,
      annotateSendImmediately: value,
    };
    savePrefs(next);
    set({ annotateSendImmediately: value });
  },

  annotationsFor: (agent: string, browserId?: string) => {
    const queue = get().queues.get(agent);
    if (!queue || queue.items.length === 0) return EMPTY_ITEMS;
    if (!browserId) return queue.items;
    let byBrowser = filteredByBrowserCache.get(queue.items);
    if (!byBrowser) {
      byBrowser = new Map();
      filteredByBrowserCache.set(queue.items, byBrowser);
    }
    const cached = byBrowser.get(browserId);
    if (cached) return cached;
    const filtered = queue.items.filter((item) => item.browserId === browserId);
    const result = filtered.length === 0 ? EMPTY_ITEMS : filtered;
    byBrowser.set(browserId, result);
    return result;
  },

  pageKeyOf: (browserId: string) => get().pages.get(browserId),

  setBrowserUrl: (browserId: string, url: string) => {
    if (!url) return;
    const pageKey = designModePageKey(url);
    const current = get().pages;
    if (current.get(browserId) === pageKey) return;
    const pages = new Map(current);
    pages.delete(browserId);
    pages.set(browserId, pageKey);
    persistAnnotationsState(get().queues, pages);
    set({ pages });
  },

  dispatchQueue: (agent: string, action: DesignAnnotationQueueAction) => {
    const s = get();
    const current = s.queues.get(agent) ?? { items: [] };
    const next = queueReducer(current, action);
    if (next === current) return;
    const queues = new Map(s.queues);
    queues.delete(agent);
    if (next.items.length > 0) queues.set(agent, next);
    persistAnnotationsState(queues, s.pages);
    set({ queues });
  },

  addAnnotation: (agent: string, draft: DesignAnnotationDraft) => {
    const s = get();
    const current = s.queues.get(agent) ?? { items: [] };
    const next = queueReducer(current, { type: 'add', draft });
    if (next === current) return undefined;
    const queues = new Map(s.queues);
    queues.delete(agent);
    if (next.items.length > 0) queues.set(agent, next);
    persistAnnotationsState(queues, s.pages);
    const nextCount = s.annotateUseCount + 1;
    savePrefs({
      annotateHovered: s.annotateHovered,
      annotateEntered: s.annotateEntered,
      annotateUseCount: nextCount,
      annotateSendImmediately: s.annotateSendImmediately,
    });
    set({ queues, annotateUseCount: nextCount });
    return next.items.find((item) => item.id === draft.id);
  },

  updateAnnotation: (
    agent: string,
    id: string,
    comment: string,
    images?: DesignAnnotationImage[]
  ) => {
    get().dispatchQueue(agent, { type: 'update', id, comment, images });
  },

  removeAnnotations: (agent: string, ids: Iterable<string>) => {
    get().dispatchQueue(agent, { type: 'remove', ids });
  },

  clearAnnotations: (agent: string, browserId?: string) => {
    if (!browserId) {
      get().dispatchQueue(agent, { type: 'clear' });
      return;
    }
    const ids = get()
      .annotationsFor(agent, browserId)
      .map((item) => item.id);
    if (ids.length > 0) get().dispatchQueue(agent, { type: 'remove', ids });
  },

  restoreAnnotations: (agent: string, items: readonly DesignAnnotation[]) => {
    get().dispatchQueue(agent, { type: 'restore', items });
  },

  registerSession: (browserId, { url, ...rest }) => {
    get().setBrowserUrl(browserId, url);
    const sessions = new Map(get().sessions);
    sessions.set(browserId, { ...rest, pinned: new Set() });
    set({ sessions });
    return () => {
      const cur = get().sessions;
      if (cur.get(browserId)?.exit !== rest.exit) return;
      const next = new Map(cur);
      next.delete(browserId);
      set({ sessions: next });
    };
  },

  setPinnedIds: (browserId: string, ids: Iterable<string>) => {
    const cur = get().sessions;
    const session = cur.get(browserId);
    if (!session) return;
    const nextPinned = new Set(ids);
    if (
      session.pinned.size === nextPinned.size &&
      [...session.pinned].every((id) => nextPinned.has(id))
    ) {
      return;
    }
    const sessions = new Map(cur);
    sessions.set(browserId, { ...session, pinned: nextPinned });
    set({ sessions });
  },

  exitAgentSessions: (agent: string) => {
    for (const session of get().sessions.values()) {
      if (session.agent === agent) session.exit();
    }
  },

  resetForTests: () => {
    savePrefs(DEFAULT_PREFS);
    persistAnnotationsState(new Map(), new Map());
    set({
      ...DEFAULT_PREFS,
      queues: new Map(),
      pages: new Map(),
      sessions: new Map(),
    });
  },
}));
