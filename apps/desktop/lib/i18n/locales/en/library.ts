/**
 * 英文词典：资料库。形状对齐 zh/library.ts。
 */
import type { zhLibrary } from "../zh/library";

export const enLibrary: typeof zhLibrary = {
  common: {
    newNote: "New note",
    newFile: "New file",
    newFolder: "New folder",
    importFile: "Import file",
    importFolder: "Import folder",
    reference: "Reference",
    reveal: "Open in system",
    revealInSystem: "Show in system",
    rename: "Rename",
    refresh: "Refresh",
    searching: "Searching…",
    noDiskPath: "These items have no disk path and can't be imported",
    tooManyNotes: "Couldn't create the note: too many files with the same name",
  },
  view: {
    title: "Library",
    searchPlaceholder: "Search notes and files…",
    changeLocation: "Change location",
    rootUnavailable:
      "Library location unavailable (it may have been moved, deleted, or unmounted). References are disabled",
    toast: {
      newChatNotReady: "New chat isn't ready; couldn't insert the reference",
      newChatFailed: "Failed to create a new chat: {error}",
    },
  },
  /** Level 1: knowledge-base cards (reference image 1; KBs are entities, see knowledge-bases.ts) */
  landing: {
    heading: "Build an AI-native",
    subheading: "Ready for AI agents anytime.",
    globalScope: "All workspaces",
    createKb: "New knowledge base",
    kbCreated: "Knowledge base created",
    filterAll: "All workspaces",
    itemCount: "{count} items",
    updatedAt: "Updated {date}",
    searchPlaceholder: "Search knowledge bases and files",
    backToSpaces: "All knowledge bases",
    empty:
      "No knowledge bases yet: create one, or save a selection from a chat as a note.",
    cardMenu: {
      more: "More",
      rename: "Rename",
      delete: "Delete",
      renameTitle: "Rename knowledge base",
      renameDesc: "Change the name; contents and tags are kept.",
      deleteTitle: 'Delete "{name}"?',
      deleteDesc:
        "This knowledge base and all of its contents will be permanently deleted. This can't be undone.",
      cancel: "Cancel",
      save: "Save",
      deleted: "Knowledge base deleted",
    },
    createDialog: {
      description:
        "A knowledge base can belong to a workspace or apply to all of them.",
      nameLabel: "Name",
      namePlaceholder: "e.g. Engineering handbook",
      scopeLabel: "Scope",
      scopeUser: "User",
      scopeWorkspace: "Workspace",
      workspaceLabel: "Select workspaces",
      workspacePick: "Select a workspace",
      workspaceHint:
        "Select at least one workspace that can use this knowledge base",
      workspaceEmpty: "No workspaces yet; create one in the sidebar first",
      cancel: "Cancel",
      create: "Create knowledge base",
    },
  },
  /** "Save as note" toasts and errors (lib/workspace/library-save-note.ts) */
  saveNote: {
    saved: "Saved as note",
    open: "Open",
    failed: "Save failed: {error}",
    empty: "Nothing to save",
    desktopOnly: "Notes can only be saved in the desktop app",
    errors: {
      noteTooLarge: "Content is too large (1MB limit)",
      libraryUnavailable:
        "Library location unavailable (check Settings → General → Library location)",
      badPath: "Invalid target path",
      notDesktop: "Desktop app only",
    },
  },
  /** Built-in knowledge-base names (lazy manifest creation) */
  kb: {
    untitled: "Untitled knowledge base",
    defaultName: "Default knowledge base",
    inboxName: "Inbox",
  },
  /** Level 2: single space detail (reference image 2) */
  space: {
    add: "Add knowledge",
    searchPlaceholder: "Search knowledge…",
    emptyProject:
      "Nothing in this knowledge base yet: add files, or save a selection from a chat as a note.",
  },
  pane: {
    libraryAria: "Library files",
    libraryEmpty: "No files yet. Drag one in, or write a note first.",
  },
  explorer: {
    unreadable: "(Can't read this folder)",
    truncated: "… (too many entries, truncated)",
    desktopOnly: "The file tree is only available on desktop",
    preparing: "Preparing directory…",
    empty: "No files in this folder",
    ariaLabel: "File tree",
    emptyHint: "Right-click empty space to refresh or see more actions",
    importHere: "Import here…",
    revealInExplorer: "Show in file manager",
    copyPath: "Copy path",
    copyRelPath: "Copy relative path",
    copyFailed: "Copy failed",
    renameDesc: 'Rename "{name}"',
    location: "Location: {dir}",
    rootDir: "Root",
    folderNamePlaceholder: "Folder name",
    fileNamePlaceholder: "File name (e.g. index.html)",
    deleteTitle: 'Delete "{name}"?',
    deleteDirDesc:
      "This folder and all of its contents will be permanently deleted. This can't be undone.",
    deleteFileDesc:
      "This file will be permanently deleted. This can't be undone.",
    deleteReferenced:
      "This file is referenced by the current chat; deleting it will break the reference.",
    browserPreview: "Browser preview",
  },
  viewer: {
    empty: "Select a file on the left to view and edit it here",
    renameAria: "Rename file",
    renameHint: "Click to rename",
    readFailed:
      "Couldn't read the file (it may have been moved or deleted)",
    tooLarge: "The file exceeds 20MB and isn't previewed in the app",
    unsupported: "This file type can't be previewed yet",
    usageLabel: "Referenced by {count} tasks",
    usageTitle: "Referenced by {count} tasks{recent}",
    usageRecent: "\nRecent: {list}",
    listSeparator: ", ",
    badFileName: 'File name can\'t contain \\ / : * ? " < > |',
    preview: "Preview",
    truncatedNotice:
      "Content over 2MB was truncated; only the visible part is editable. ",
    saving: "Saving…",
    unsaved: "Unsaved (autosaves when idle)",
    saved: "Saved",
    toc: "Contents",
    tocAria: "Document outline",
    tocAriaCollapsed: "Document outline (collapsed)",
    collapseToc: "Collapse outline",
    expandToc: "Expand outline",
  },
  referencePicker: {
    rootDir: "Library root",
    notReady: "Library isn't ready; can't insert a reference",
    composerNotReady: "The composer isn't ready; couldn't insert the reference",
    noMatch: 'No files match "{query}"',
    empty: "No files in the library yet",
    title: "Select from library",
    description:
      "Multi-select is supported. References don't copy files—AI reads the original on demand, so content stays current.",
    searchPlaceholder: "Search file name, title, or #tag…",
    colName: "Name",
    colTags: "Tags",
    colLocation: "Location",
    colModified: "Modified",
    rootMissing:
      "Library location unavailable (it may have been moved or deleted). Change it in Settings",
    selectedCount: "{count} selected",
    truncatedSuffix: "; too many results, showing the first 500",
  },
  noteTags: {
    removed: "Removed #{tag}",
    undo: "Undo",
    missing:
      "The file no longer exists (it may have been moved or deleted). Tags are disabled",
    removeMeta: "Remove metadata",
    removeTitle: "Remove #{tag}",
    removeAria: "Remove tag {tag}",
    addAria: "Add tag",
    placeholder: "Tag name",
    addLabel: "Tag",
  },
  search: {
    noMatch: 'No files match "{query}"',
    truncated: "Too many results; showing the first {count}",
  },
  actions: {
    unknownError: "Unknown error",
    importFailed: "Import failed: {error}",
    partialFailed: "{count} items failed to import: {error}",
    pickFolderTitle: "Choose a folder to import",
    pickFileTitle: "Choose files to import",
  },
  hints: {
    label: "Related",
    referenceTitle: "Reference {path}",
    dismissTitle: "Dismiss these suggestions",
    dismissAria: "Dismiss related note suggestions",
  },
};
