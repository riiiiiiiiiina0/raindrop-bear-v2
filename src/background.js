// Raindrop Bear Background Service Worker (Manifest V3) – modular orchestration
import { apiPOST, setFacadeToken } from './modules/api-facade.js';
import {
  TOKEN_NOTIFICATION_ID,
  notifySyncFailure,
  notifySyncSuccess,
  SYNC_SUCCESS_NOTIFICATION_ID,
  notifyUnsortedSave,
  UNSORTED_SAVE_NOTIFICATION_ID,
  notify,
} from './modules/notifications.js';
import {
  UNSORTED_COLLECTION_ID,
  removeLegacyTopFolders,
} from './modules/bookmarks.js';
import { chromeP } from './modules/chrome.js';
import { setBadge, clearBadge, flashBadge } from './modules/ui.js';
import { loadState, saveState } from './modules/state.js';
import {
  fetchGroupsAndCollections,
  buildCollectionsIndex,
  buildCollectionToGroupMap,
  computeGroupForCollection,
} from './modules/collections.js';
import {
  getOrCreateRootFolder,
  getOrCreateChildFolder as getOrCreateChildFolderLocal,
  syncFolders,
} from './modules/folder-sync.js';
import {
  syncNewAndUpdatedItems,
  syncDeletedItems,
} from './modules/item-sync.js';
import { ensureRootAndMaybeReset } from './modules/root-ensure.js';
import {
  isSyncing,
  setIsSyncing,
  setSuppressLocalBookmarkEvents,
} from './modules/shared-state.js';
import {
  ACTIVE_SYNC_SESSIONS_KEY,
  WINDOW_SYNC_ALARM_PREFIX,
  windowSyncSessions,
  loadActiveSyncSessionsIntoMemory,
  scheduleWindowSync,
  stopWindowSync,
  restoreActionUiForActiveWindow,
  overrideCollectionWithWindowTabs,
} from './modules/window-sync.js';
import {
  listSavedProjects,
  recoverSavedProject,
  deleteSavedProject,
  saveCurrentOrHighlightedTabsToRaindrop,
  saveHighlightedTabsAsProject,
  saveWindowAsProject,
  replaceSavedProjectWithTabs,
  addTabsToProject,
  renameSavedProjectsGroup,
  archiveProject,
} from './modules/projects.js';

const ALARM_NAME = 'raindrop-sync';
const SYNC_PERIOD_MINUTES = 10;

async function recursivelyFindBookmarks(folderId) {
  const bookmarks = [];
  try {
    const tree = await chromeP.bookmarksGetSubTree(folderId);
    function flatten(nodes) {
      for (const node of nodes) {
        if (node.url) {
          bookmarks.push(node);
        }
        if (node.children) {
          flatten(node.children);
        }
      }
    }
    if (tree && tree[0] && tree[0].children) {
      flatten(tree[0].children);
    }
  } catch (e) {
    console.error(`Failed to get bookmarks subtree for ${folderId}`, e);
  }
  return bookmarks;
}

async function deleteLocalData() {
  try {
    const { rootFolderId } = await loadState();
    if (rootFolderId) {
      try {
        await chromeP.bookmarksRemoveTree(rootFolderId);
      } catch (error) {
        // Ignore error if folder is already gone
        if (!String(error).includes('not found')) {
          console.error('Failed to remove root folder:', error);
        }
      }
    }
  } catch (error) {
    console.error('Failed to get root folder for deletion:', error);
  }

  // Clear all sync-related data
  await saveState({
    lastSync: null,
    collectionMap: {},
    groupMap: {},
    itemMap: {},
    rootFolderId: null,
  });
}

async function performSync() {
  if (isSyncing) return;
  setIsSyncing(true);
  setSuppressLocalBookmarkEvents(true);
  let notifyPref = true;
  try {
    const data = await chromeP.storageGet('notifyOnSync');
    if (data && typeof data.notifyOnSync === 'boolean') {
      notifyPref = data.notifyOnSync;
    }
  } catch (_) {}
  let didSucceed = false;
  let hasAnyChanges = false;
  setBadge('🔄', '#38bdf8');
  try {
    let state = await loadState();
    const {
      didReset,
      rootFolderId,
      state: updatedState,
    } = await ensureRootAndMaybeReset();
    state = updatedState;
    const { groups, rootCollections, childCollections } =
      await fetchGroupsAndCollections();
    const SAVED_PROJECTS_TITLE = '🐻‍❄️ Projects';
    const filteredGroups = (groups || []).filter(
      (g) => (g && g.title) !== SAVED_PROJECTS_TITLE,
    );
    const collectionsById = buildCollectionsIndex(
      rootCollections,
      childCollections,
    );
    const rootCollectionToGroupTitleAll = buildCollectionToGroupMap(
      groups || [],
    );
    for (const id of Array.from(collectionsById.keys())) {
      const groupTitle = computeGroupForCollection(
        id,
        collectionsById,
        rootCollectionToGroupTitleAll,
      );
      if (groupTitle === SAVED_PROJECTS_TITLE) collectionsById.delete(id);
    }
    const { collectionMap, didChange: foldersChanged } = await syncFolders(
      filteredGroups,
      collectionsById,
      state,
    );
    const {
      itemMap: updatedItemMap,
      newLastSyncISO,
      didChange: itemsChanged,
    } = await syncNewAndUpdatedItems(
      state.lastSync,
      collectionMap,
      { ...(state.itemMap || {}) },
      getOrCreateRootFolder,
      getOrCreateChildFolderLocal,
    );
    let prunedItemMap = updatedItemMap;
    let deletionsChanged = false;
    if (state.lastSync) {
      const result = await syncDeletedItems(
        state.lastSync,
        updatedItemMap,
        collectionMap,
      );
      prunedItemMap = result.itemMap;
      deletionsChanged = result.didChange;
    } else {
      // Full sync: find and remove orphaned bookmarks
      const localBookmarks = await recursivelyFindBookmarks(rootFolderId);
      const validLocalIds = new Set(Object.values(updatedItemMap));
      for (const bookmark of localBookmarks) {
        if (!validLocalIds.has(bookmark.id)) {
          try {
            await chromeP.bookmarksRemove(bookmark.id);
            deletionsChanged = true;
          } catch (error) {
            console.warn(`Failed to remove orphaned bookmark: ${error}`);
          }
        }
      }
    }

    hasAnyChanges = Boolean(foldersChanged || itemsChanged || deletionsChanged);
    await saveState({
      lastSync: newLastSyncISO,
      collectionMap,
      itemMap: prunedItemMap,
    });
    didSucceed = true;
  } catch (err) {
    console.error(
      'Raindrop sync failed:',
      err && err.message ? err.message : err,
    );
    if (notifyPref) {
      const msg = err && err.message ? String(err.message) : 'Unknown error';
      try {
        notifySyncFailure(`Sync failed: ${msg}`);
      } catch (_) {}
    }
  } finally {
    setSuppressLocalBookmarkEvents(false);
    setIsSyncing(false);
    try {
      clearBadge();
    } catch (_) {}
    flashBadge(didSucceed);
    try {
      await restoreActionUiForActiveWindow(chrome, chromeP);
    } catch (_) {}
    if (didSucceed) {
      let notifyPref2 = true;
      try {
        const data = await chromeP.storageGet('notifyOnSync');
        if (data && typeof data.notifyOnSync === 'boolean')
          notifyPref2 = data.notifyOnSync;
      } catch (_) {}
      if (notifyPref2 && hasAnyChanges) {
        try {
          notifySyncSuccess('Sync completed successfully.');
        } catch (_) {}
      }
    }
  }
}

async function saveUrlToUnsorted(url, title) {
  try {
    const existing = await apiPOST('/import/url/exists', { urls: [url] });

    if (
      existing &&
      existing.result === true &&
      existing.ids &&
      existing.ids.length > 0
    ) {
      notify('Link already exists.');
      flashBadge(true);
      return;
    }

    const body = {
      link: url,
      title: title || url,
      collection: { $id: UNSORTED_COLLECTION_ID },
      pleaseParse: {},
    };
    await apiPOST('/raindrop', body);
    notifyUnsortedSave('Link saved to Unsorted!');
    flashBadge(true);
  } catch (err) {
    console.error('Failed to save link to Unsorted:', err);
    notify('Error saving link to Unsorted.');
    flashBadge(false);
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: SYNC_PERIOD_MINUTES });
  } catch (_) {}
  try {
    await removeLegacyTopFolders();
  } catch (_) {}

  // Clean up window sync sessions
  try {
    await chromeP.storageSet({ [ACTIVE_SYNC_SESSIONS_KEY]: {} });
    const alarms = await new Promise((resolve) =>
      chrome.alarms.getAll((as) => resolve(as || [])),
    );
    (alarms || []).forEach((a) => {
      if (a && a.name && a.name.startsWith(WINDOW_SYNC_ALARM_PREFIX)) {
        try {
          chrome.alarms.clear(a.name);
        } catch (_) {}
      }
    });
  } catch (_) {}

  // Create context menus
  try {
    chrome.contextMenus.create({
      id: 'save-link',
      title: 'Save link to Unsorted',
      contexts: ['link'],
    });
    chrome.contextMenus.create({
      id: 'save-page',
      title: 'Save page to Unsorted',
      contexts: ['page'],
    });
  } catch (err) {
    console.error('Failed to create context menus:', err);
  }

  const isUpdate = details.reason === 'update';
  const [major, minor, patch] =
    details.previousVersion?.split('.').map(Number) || [];

  const shouldMigrateSavedProjects = isUpdate && major === 1 && minor <= 82;

  const shouldShowUpdateNote = isUpdate && major === 1 && minor < 53;

  if (shouldMigrateSavedProjects) {
    try {
      await renameSavedProjectsGroup();
    } catch (e) {
      console.error('Failed to rename saved projects group', e);
    }
  }

  // show update note on update
  if (shouldShowUpdateNote) {
    try {
      chrome.tabs.create({
        url: 'https://triiii.notion.site/Hello-from-Raindrop-Bear-2547aa7407c180d28e08f4f6dc41cdfd',
      });
    } catch (_) {}
  }
  // init after install
  else if (details.reason === 'install') {
    try {
      const data = await chromeP.storageGet('raindropApiToken');
      const token = (
        data && data.raindropApiToken ? String(data.raindropApiToken) : ''
      ).trim();
      if (token) {
        setFacadeToken(token);
        performSync();
      } else {
        try {
          chrome.runtime.openOptionsPage();
        } catch (_) {}
      }
    } catch (_) {}
  }
});

// Initialize window sync sessions at SW start
(async () => {
  await loadActiveSyncSessionsIntoMemory(chromeP);
  try {
    await restoreActionUiForActiveWindow(chrome, chromeP);
  } catch (_) {}
})();

// Local → Raindrop mirroring (guarded by flags in shared-state)
chrome.bookmarks?.onCreated.addListener(async (id, node) => {
  // try {
  //   if (isSyncing || suppressLocalBookmarkEvents) return;
  //   if (node && node.url && recentlyCreatedRemoteUrls.has(String(node.url)))
  //     return;
  //   // Inline mirror logic moved into projects/mirror earlier; for now, reuse minimal subset
  //   const state = await loadState();
  //   const rootFolderId = state.rootFolderId;
  //   if (!rootFolderId) return;
  //   const underRoot = await (async function isUnderManagedRoot(
  //     nodeId,
  //     rootFolderId,
  //   ) {
  //     async function getAncestorIds(nodeId) {
  //       const ids = [];
  //       let currentId = nodeId;
  //       const visited = new Set();
  //       while (currentId && !visited.has(currentId)) {
  //         visited.add(currentId);
  //         ids.push(String(currentId));
  //         try {
  //           const nodes = await chromeP.bookmarksGet(String(currentId));
  //           const node = nodes && nodes[0];
  //           if (!node || !node.parentId) break;
  //           currentId = node.parentId;
  //         } catch (_) {
  //           break;
  //         }
  //       }
  //       return ids;
  //     }
  //     const ancestors = await getAncestorIds(nodeId);
  //     return ancestors.includes(String(rootFolderId));
  //   })(node.parentId, rootFolderId);
  //   if (!underRoot) return;
  //   const collectionMap = { ...(state.collectionMap || {}) };
  //   const collectionByFolder = invertRecord(collectionMap);
  //   const unsortedFolderId =
  //     collectionMap[String(UNSORTED_COLLECTION_ID)] || '';
  //   if (node.url) {
  //     let collectionId = null;
  //     if (String(node.parentId) === String(unsortedFolderId))
  //       collectionId = UNSORTED_COLLECTION_ID;
  //     else {
  //       const mapped = collectionByFolder[String(node.parentId)];
  //       collectionId = mapped != null ? Number(mapped) : UNSORTED_COLLECTION_ID;
  //     }
  //     // First, check if the URL already exists on Raindrop
  //     const existingOnServer = await apiPOST('/import/url/exists', {
  //       urls: [node.url],
  //     });
  //     if (
  //       existingOnServer &&
  //       existingOnServer.result === true &&
  //       Array.isArray(existingOnServer.ids) &&
  //       existingOnServer.ids.length > 0
  //     ) {
  //       // The item already exists. Don't create a duplicate.
  //       // Instead, update the local itemMap to link this new bookmark to the existing item.
  //       const raindropId = String(existingOnServer.ids[0]);
  //       const itemMap = { ...(state.itemMap || {}) };
  //       itemMap[raindropId] = String(id);
  //       await saveState({ itemMap });
  //       return; // Stop further execution
  //     }
  //     const body = {
  //       link: node.url,
  //       title: node.title || node.url,
  //       collection: { $id: collectionId },
  //     };
  //     try {
  //       const res = await apiPOST('/raindrop', body);
  //       const item = res && (res.item || res.data || res);
  //       const newId =
  //         item && (item._id != null ? String(item._id) : String(item.id || ''));
  //       if (newId) {
  //         const itemMap = { ...(state.itemMap || {}) };
  //         itemMap[newId] = String(id);
  //         await saveState({ itemMap });
  //       }
  //     } catch (_) {}
  //   } else {
  //     const parentCollectionId =
  //       await (async function resolveParentCollectionId(parentFolderId, state) {
  //         const collectionMap = state.collectionMap || {};
  //         const groupMap = state.groupMap || {};
  //         const collectionByFolder = invertRecord(collectionMap);
  //         const unsortedFolderId =
  //           collectionMap[String(UNSORTED_COLLECTION_ID)] || '';
  //         const mapped = collectionByFolder[String(parentFolderId)];
  //         if (mapped != null && mapped !== '') return Number(mapped);
  //         if (String(parentFolderId) === String(unsortedFolderId)) return null;
  //         for (const id of Object.values(groupMap || {})) {
  //           if (String(id) === String(parentFolderId)) return null;
  //         }
  //         if (String(parentFolderId) === String(state.rootFolderId || ''))
  //           return null;
  //         return null;
  //       })(node.parentId, state);
  //     const body =
  //       parentCollectionId == null
  //         ? { title: node.title || '' }
  //         : { title: node.title || '', parent: { $id: parentCollectionId } };
  //     try {
  //       const res = await apiPOST('/collection', body);
  //       const created = res && (res.item || res.data || res);
  //       const colId =
  //         created &&
  //         (created._id != null
  //           ? String(created._id)
  //           : String(created.id || ''));
  //       if (colId) {
  //         const newCollectionMap = { ...(state.collectionMap || {}) };
  //         newCollectionMap[colId] = String(id);
  //         await saveState({ collectionMap: newCollectionMap });
  //       }
  //     } catch (_) {}
  //   }
  // } catch (_) {}
});

chrome.bookmarks?.onRemoved.addListener(async (id) => {
  // try {
  //   if (isSyncing || suppressLocalBookmarkEvents) return;
  //   const state = await loadState();
  //   if (state.rootFolderId) {
  //     try {
  //       const nodes = await chromeP.bookmarksGet(String(state.rootFolderId));
  //       if (!nodes || nodes.length === 0) return;
  //     } catch (_) {
  //       return;
  //     }
  //   }
  //   const itemMap = { ...(state.itemMap || {}) };
  //   const collectionMap = { ...(state.collectionMap || {}) };
  //   const itemByLocal = invertRecord(itemMap);
  //   const collectionByLocal = invertRecord(collectionMap);
  //   if (itemByLocal[String(id)]) {
  //     const raindropId = itemByLocal[String(id)];
  //     try {
  //       await apiDELETE(`/raindrop/${encodeURIComponent(raindropId)}`);
  //     } catch (_) {}
  //     delete itemMap[String(raindropId)];
  //     await saveState({ itemMap });
  //     return;
  //   }
  //   if (collectionByLocal[String(id)]) {
  //     const collectionId = collectionByLocal[String(id)];
  //     try {
  //       await apiDELETE(`/collection/${encodeURIComponent(collectionId)}`);
  //     } catch (_) {}
  //     delete collectionMap[String(collectionId)];
  //     await saveState({ collectionMap });
  //   }
  // } catch (_) {}
});

chrome.bookmarks?.onChanged.addListener(async (id, changeInfo) => {
  // try {
  //   if (isSyncing || suppressLocalBookmarkEvents) return;
  //   const state = await loadState();
  //   const itemMap = { ...(state.itemMap || {}) };
  //   const collectionMap = { ...(state.collectionMap || {}) };
  //   const itemByLocal = invertRecord(itemMap);
  //   const collectionByLocal = invertRecord(collectionMap);
  //   if (itemByLocal[String(id)]) {
  //     const raindropId = itemByLocal[String(id)];
  //     const body = {};
  //     if (typeof changeInfo.title === 'string')
  //       body['title'] = changeInfo.title;
  //     if (typeof changeInfo.url === 'string') body['link'] = changeInfo.url;
  //     if (Object.keys(body).length > 0) {
  //       try {
  //         await apiPUT(`/raindrop/${encodeURIComponent(raindropId)}`, body);
  //       } catch (_) {}
  //     }
  //     return;
  //   }
  //   if (collectionByLocal[String(id)]) {
  //     const collectionId = collectionByLocal[String(id)];
  //     if (typeof changeInfo.title === 'string') {
  //       try {
  //         await apiPUT(`/collection/${encodeURIComponent(collectionId)}`, {
  //           title: changeInfo.title,
  //         });
  //       } catch (_) {}
  //     }
  //   }
  // } catch (_) {}
});

chrome.bookmarks?.onMoved.addListener(async (id, moveInfo) => {
  // try {
  //   if (isSyncing || suppressLocalBookmarkEvents) return;
  //   const state = await loadState();
  //   const rootFolderId = state.rootFolderId;
  //   if (!rootFolderId) return;
  //   const underRoot = await (async function isUnderManagedRoot(
  //     nodeId,
  //     rootFolderId,
  //   ) {
  //     async function getAncestorIds(nodeId) {
  //       const ids = [];
  //       let currentId = nodeId;
  //       const visited = new Set();
  //       while (currentId && !visited.has(currentId)) {
  //         visited.add(currentId);
  //         ids.push(String(currentId));
  //         try {
  //           const nodes = await chromeP.bookmarksGet(String(currentId));
  //           const node = nodes && nodes[0];
  //           if (!node || !node.parentId) break;
  //           currentId = node.parentId;
  //         } catch (_) {
  //           break;
  //         }
  //       }
  //       return ids;
  //     }
  //     const ancestors = await getAncestorIds(nodeId);
  //     return ancestors.includes(String(rootFolderId));
  //   })(moveInfo.parentId, rootFolderId);
  //   if (!underRoot) return;
  //   const itemMap = { ...(state.itemMap || {}) };
  //   const collectionMap = { ...(state.collectionMap || {}) };
  //   const groupMap = { ...(state.groupMap || {}) };
  //   const itemByLocal = invertRecord(itemMap);
  //   const collectionByLocal = invertRecord(collectionMap);
  //   const unsortedFolderId =
  //     collectionMap[String(UNSORTED_COLLECTION_ID)] || '';
  //   if (itemByLocal[String(id)]) {
  //     const raindropId = itemByLocal[String(id)];
  //     let newCollectionId = null;
  //     if (String(moveInfo.parentId) === String(unsortedFolderId))
  //       newCollectionId = UNSORTED_COLLECTION_ID;
  //     else {
  //       const mapped = collectionByLocal[String(moveInfo.parentId)];
  //       newCollectionId =
  //         mapped != null ? Number(mapped) : UNSORTED_COLLECTION_ID;
  //     }
  //     try {
  //       await apiPUT(`/raindrop/${encodeURIComponent(raindropId)}`, {
  //         collection: { $id: newCollectionId },
  //       });
  //     } catch (_) {}
  //     return;
  //   }
  //   if (collectionByLocal[String(id)]) {
  //     const collectionId = collectionByLocal[String(id)];
  //     let parentCollectionId = null;
  //     const isParentGroup = Object.values(groupMap).some(
  //       (gid) => String(gid) === String(moveInfo.parentId),
  //     );
  //     const isParentRoot = String(moveInfo.parentId) === String(rootFolderId);
  //     if (
  //       isParentGroup ||
  //       isParentRoot ||
  //       String(moveInfo.parentId) === String(unsortedFolderId)
  //     )
  //       parentCollectionId = null;
  //     else {
  //       const mapped = collectionByLocal[String(moveInfo.parentId)];
  //       parentCollectionId = mapped != null ? Number(mapped) : null;
  //     }
  //     const body =
  //       parentCollectionId == null
  //         ? { parent: null }
  //         : { parent: { $id: parentCollectionId } };
  //     try {
  //       await apiPUT(`/collection/${encodeURIComponent(collectionId)}`, body);
  //     } catch (_) {}
  //   }
  // } catch (_) {}
});

// Alarms
chrome.runtime.onStartup?.addListener(() => {
  try {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: SYNC_PERIOD_MINUTES });
  } catch (_) {}
  try {
    restoreActionUiForActiveWindow(chrome, chromeP);
  } catch (_) {}
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === ALARM_NAME) performSync();
  else if (alarm && alarm.name === 'raindrop-clear-badge') clearBadge();
  else if (
    alarm &&
    alarm.name &&
    alarm.name.startsWith(WINDOW_SYNC_ALARM_PREFIX)
  ) {
    const winId = Number(alarm.name.substring(WINDOW_SYNC_ALARM_PREFIX.length));
    const sess = windowSyncSessions.get(Number(winId));
    if (!sess || sess.stopped) return;
    (async () => {
      try {
        await overrideCollectionWithWindowTabs(
          chrome,
          sess.collectionId,
          sess.windowId,
        );
      } catch (_) {}
    })();
  }
  try {
    restoreActionUiForActiveWindow(chrome, chromeP);
  } catch (_) {}
});

// Windows/tabs listeners to drive window sync badge/title and scheduling
chrome.tabs?.onCreated.addListener((tab) => {
  try {
    const winId = tab && tab.windowId;
    if (!windowSyncSessions.has(Number(winId))) return;
    scheduleWindowSync(chrome, Number(winId));
  } catch (_) {}
  try {
    restoreActionUiForActiveWindow(chrome, chromeP);
  } catch (_) {}
});
chrome.tabs?.onRemoved.addListener((_tabId, removeInfo) => {
  try {
    const winId = removeInfo && removeInfo.windowId;
    if (!windowSyncSessions.has(Number(winId))) return;
    scheduleWindowSync(chrome, Number(winId));
  } catch (_) {}
  try {
    restoreActionUiForActiveWindow(chrome, chromeP);
  } catch (_) {}
});
chrome.tabs?.onUpdated.addListener((_tabId, changeInfo, tab) => {
  try {
    const winId = tab && tab.windowId;
    if (!windowSyncSessions.has(Number(winId))) return;
    if (
      'url' in (changeInfo || {}) ||
      'title' in (changeInfo || {}) ||
      'pinned' in (changeInfo || {}) ||
      (changeInfo && changeInfo.status === 'complete')
    ) {
      scheduleWindowSync(chrome, Number(winId));
    }
  } catch (_) {}
  try {
    if (changeInfo && changeInfo.status === 'complete') {
      restoreActionUiForActiveWindow(chrome, chromeP);
    }
  } catch (_) {}
});
chrome.tabs?.onMoved.addListener((_tabId, moveInfo) => {
  try {
    const winId = moveInfo && moveInfo.windowId;
    if (!windowSyncSessions.has(Number(winId))) return;
    scheduleWindowSync(chrome, Number(winId));
  } catch (_) {}
  try {
    restoreActionUiForActiveWindow(chrome, chromeP);
  } catch (_) {}
});
chrome.tabs?.onAttached.addListener((_tabId, attachInfo) => {
  try {
    const winId = attachInfo && attachInfo.newWindowId;
    if (!windowSyncSessions.has(Number(winId))) return;
    scheduleWindowSync(chrome, Number(winId));
  } catch (_) {}
  try {
    restoreActionUiForActiveWindow(chrome, chromeP);
  } catch (_) {}
});
chrome.tabs?.onDetached.addListener((_tabId, detachInfo) => {
  try {
    const winId = detachInfo && detachInfo.oldWindowId;
    if (!windowSyncSessions.has(Number(winId))) return;
    scheduleWindowSync(chrome, Number(winId));
  } catch (_) {}
  try {
    restoreActionUiForActiveWindow(chrome, chromeP);
  } catch (_) {}
});
chrome.windows?.onFocusChanged?.addListener((_windowId) => {
  try {
    restoreActionUiForActiveWindow(chrome, chromeP);
  } catch (_) {}
});
chrome.windows?.onCreated?.addListener((_window) => {
  try {
    restoreActionUiForActiveWindow(chrome, chromeP);
  } catch (_) {}
});
chrome.tabs?.onActivated?.addListener((_activeInfo) => {
  try {
    restoreActionUiForActiveWindow(chrome, chromeP);
  } catch (_) {}
});
chrome.tabGroups?.onCreated?.addListener((_group) => {
  try {
    for (const winId of windowSyncSessions.keys())
      scheduleWindowSync(chrome, Number(winId));
  } catch (_) {}
  try {
    restoreActionUiForActiveWindow(chrome, chromeP);
  } catch (_) {}
});
chrome.tabGroups?.onUpdated?.addListener((_group) => {
  try {
    for (const winId of windowSyncSessions.keys())
      scheduleWindowSync(chrome, Number(winId));
  } catch (_) {}
  try {
    restoreActionUiForActiveWindow(chrome, chromeP);
  } catch (_) {}
});
chrome.tabGroups?.onRemoved?.addListener((_group) => {
  try {
    for (const winId of windowSyncSessions.keys())
      scheduleWindowSync(chrome, Number(winId));
  } catch (_) {}
  try {
    restoreActionUiForActiveWindow(chrome, chromeP);
  } catch (_) {}
});
chrome.windows?.onRemoved.addListener((windowId) => {
  try {
    stopWindowSync(chrome, Number(windowId));
  } catch (_) {}
  try {
    restoreActionUiForActiveWindow(chrome, chromeP);
  } catch (_) {}
});

// Message router for popup commands
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message && message.type === 'resetAndSync') {
        await deleteLocalData();
        await performSync();
        sendResponse({ ok: true });
        return;
      }
      if (message && message.type === 'saveUrlToUnsorted') {
        const { url, title } = message;
        await saveUrlToUnsorted(url, title);
        sendResponse({ ok: true });
        return;
      }
      if (message && message.type === 'performSync') {
        await performSync();
        sendResponse({ ok: true });
        return;
      }
      if (message && message.type === 'listSavedProjects') {
        const items = await listSavedProjects();
        sendResponse({ ok: true, items });
        return;
      }
      if (message && message.type === 'recoverSavedProject') {
        const { id, title } = message || {};
        const restoreResult = await recoverSavedProject(chrome, id, {
          forceNewWindow: false,
          title,
        });
        sendResponse({ ok: true });
        return;
      }
      if (message && message.type === 'recoverSavedProjectInNewWindow') {
        const { id, title } = message || {};
        await recoverSavedProject(chrome, id, {
          forceNewWindow: true,
          title,
        });
        sendResponse({ ok: true });
        return;
      }
      if (message && message.type === 'deleteSavedProject') {
        const id = message && message.id;
        await deleteSavedProject(chromeP, id);
        sendResponse({ ok: true });
        return;
      }
      if (message && message.type === 'archiveProject') {
        const id = message && message.id;
        await archiveProject(id);
        sendResponse({ ok: true });
        return;
      }
      if (
        message &&
        message.type === 'saveCurrentOrHighlightedTabsToRaindrop'
      ) {
        await saveCurrentOrHighlightedTabsToRaindrop(chrome, chromeP);
        sendResponse({ ok: true });
        return;
      }
      if (message && message.type === 'saveHighlightedTabsAsProject') {
        const projectName = (message && message.name) || '';
        await saveHighlightedTabsAsProject(chrome, projectName);
        sendResponse({ ok: true });
        return;
      }
      if (message && message.type === 'saveWindowAsProject') {
        const projectName = (message && message.name) || '';
        await saveWindowAsProject(chrome, projectName);
        sendResponse({ ok: true });
        return;
      }
      if (message && message.type === 'replaceSavedProject') {
        const { id, useHighlighted } = message;
        const tabs = await new Promise((resolve) =>
          chrome.tabs.query(
            useHighlighted
              ? {
                  windowId: chrome.windows.WINDOW_ID_CURRENT,
                  highlighted: true,
                }
              : { windowId: chrome.windows.WINDOW_ID_CURRENT },
            (ts) => resolve(ts || []),
          ),
        );
        await replaceSavedProjectWithTabs(chrome, id, tabs);
        sendResponse({ ok: true });
        return;
      }
      if (message && message.type === 'addTabsToProject') {
        const { id } = message;
        const tabs = await new Promise((resolve) =>
          chrome.tabs.query(
            {
              windowId: chrome.windows.WINDOW_ID_CURRENT,
              highlighted: true,
            },
            (ts) => resolve(ts || []),
          ),
        );
        const activeTabs =
          tabs.length > 0
            ? tabs
            : await new Promise((resolve) =>
                chrome.tabs.query({ active: true, currentWindow: true }, (ts) =>
                  resolve(ts || []),
                ),
              );
        await addTabsToProject(chrome, id, activeTabs);
        sendResponse({ ok: true });
        return;
      }
    } catch (_) {
      sendResponse({ ok: false });
    }
  })();
  return true;
});

chrome.storage?.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes && changes.raindropApiToken) {
    const newToken = (changes.raindropApiToken.newValue || '').trim();
    const oldToken = (changes.raindropApiToken.oldValue || '').trim();
    setFacadeToken(newToken);
    if (newToken && newToken !== oldToken) {
      try {
        performSync();
      } catch (_) {}
    }
  }
});

chrome.notifications?.onClicked.addListener((notificationId) => {
  if (notificationId === TOKEN_NOTIFICATION_ID) {
    try {
      chrome.runtime.openOptionsPage();
    } catch (_) {}
    try {
      chrome.notifications.clear(notificationId);
    } catch (_) {}
  } else if (String(notificationId).startsWith('project-archived-')) {
    const collectionId = String(notificationId).substring(
      'project-archived-'.length,
    );
    if (collectionId) {
      try {
        chrome.tabs?.create({
          url: `https://app.raindrop.io/my/${collectionId}`,
        });
      } catch (_) {}
    }
    try {
      chrome.notifications.clear(notificationId);
    } catch (_) {}
  } else if (notificationId === SYNC_SUCCESS_NOTIFICATION_ID) {
    (async () => {
      try {
        const data = await chromeP.storageGet('rootFolderId');
        const rootId =
          data && data.rootFolderId ? String(data.rootFolderId) : '';
        const url = rootId
          ? `chrome://bookmarks/?id=${encodeURIComponent(rootId)}`
          : 'chrome://bookmarks';
        try {
          chrome.tabs?.create({ url });
        } catch (_) {
          try {
            chrome.tabs?.create({ url: 'chrome://bookmarks' });
          } catch (_) {}
        }
      } catch (_) {}
      try {
        chrome.notifications.clear(notificationId);
      } catch (_) {}
    })();
  } else if (notificationId === UNSORTED_SAVE_NOTIFICATION_ID) {
    try {
      chrome.tabs?.create({
        url: 'https://app.raindrop.io/my/-1',
      });
    } catch (_) {}
    try {
      chrome.notifications.clear(notificationId);
    } catch (_) {}
  } else if (String(notificationId).startsWith('project-saved-')) {
    const collectionId = String(notificationId).substring(
      'project-saved-'.length,
    );
    if (collectionId) {
      try {
        chrome.tabs?.create({
          url: `https://app.raindrop.io/my/${collectionId}`,
        });
      } catch (_) {}
    }
    try {
      chrome.notifications.clear(notificationId);
    } catch (_) {}
  }
});

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  const { menuItemId } = info;
  if (menuItemId === 'save-link') {
    const url = info.linkUrl;
    if (url) {
      // For links, the title is the link's text content, or the URL itself if no text is selected.
      const title = info.selectionText || info.linkUrl;
      await saveUrlToUnsorted(url, title);
    }
  } else if (menuItemId === 'save-page') {
    const url = info.pageUrl;
    if (url) {
      await saveUrlToUnsorted(url, tab?.title || info.pageUrl);
    }
  }
});
