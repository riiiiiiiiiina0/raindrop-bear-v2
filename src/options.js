import { apiGET, apiDELETEWithBody } from './modules/raindrop.js';
import { fetchGroupsAndCollections } from './modules/collections.js';
import {
  getAllBookmarkFolders,
  getBookmarksBarFolderId,
  ROOT_FOLDER_NAME,
} from './modules/bookmarks.js';
import { chromeP } from './modules/chrome.js';
import { loadState, saveState } from './modules/state.js';

/* global Toastify */
(() => {
  const formEl = /** @type {HTMLFormElement|null} */ (
    document.getElementById('auth-form')
  );
  const tokenEl = /** @type {HTMLInputElement|null} */ (
    document.getElementById('token')
  );
  const saveEl = /** @type {HTMLButtonElement|null} */ (
    document.getElementById('save')
  );
  const statusEl = /** @type {HTMLSpanElement|null} */ (
    document.getElementById('status')
  );
  const notifyEl = /** @type {HTMLInputElement|null} */ (
    document.getElementById('notify-sync')
  );
  const notifyStatusEl = /** @type {HTMLSpanElement|null} */ (
    document.getElementById('notify-status')
  );
  const parentFolderEl = /** @type {HTMLSelectElement} */ (
    document.getElementById('parent-folder')
  );
  const parentFolderStatusEl = /** @type {HTMLSpanElement|null} */ (
    document.getElementById('parent-folder-status')
  );
  const parentFolderDescriptionEl = /** @type {HTMLParagraphElement|null} */ (
    document.getElementById('parent-folder-description')
  );

  // --- new: helper to populate parent folder select ---
  /**
   * Populate the parent folder <select> with current bookmark folders.
   * Attempts to preserve the current selection if it still exists.
   * @param {string=} preferredId – Folder id that should be selected if present.
   */
  async function populateParentFolders(preferredId) {
    try {
      const folders = await getAllBookmarkFolders();
      const bookmarksBarId = await getBookmarksBarFolderId();

      // Clear existing options
      parentFolderEl.innerHTML = '';
      folders.forEach((item) => {
        const option = document.createElement('option');
        option.value = item.folder.id;
        option.textContent = item.path;
        parentFolderEl.appendChild(option);
      });

      // Determine which option should be selected
      const valueToSelect =
        preferredId &&
        Array.from(parentFolderEl.options).some((o) => o.value === preferredId)
          ? preferredId
          : bookmarksBarId;
      parentFolderEl.value = valueToSelect;
    } catch (err) {
      console.error('Failed to populate parent folders', err);
    }
  }

  // Debounced refresh when bookmark tree changes
  let refreshTimeoutId;
  function scheduleParentFolderRefresh() {
    clearTimeout(refreshTimeoutId);
    refreshTimeoutId = setTimeout(() => {
      populateParentFolders(parentFolderEl.value);
    }, 200);
  }
  // Register listeners only once (they are no-ops if added multiple times)
  chrome.bookmarks.onCreated.addListener(scheduleParentFolderRefresh);
  chrome.bookmarks.onRemoved.addListener(scheduleParentFolderRefresh);
  chrome.bookmarks.onMoved.addListener(scheduleParentFolderRefresh);
  chrome.bookmarks.onChanged.addListener(scheduleParentFolderRefresh);
  if (chrome.bookmarks.onChildrenReordered)
    chrome.bookmarks.onChildrenReordered.addListener(
      scheduleParentFolderRefresh,
    );
  // --- end new helper ---

  if (
    !(formEl instanceof HTMLFormElement) ||
    !(tokenEl instanceof HTMLInputElement) ||
    !(saveEl instanceof HTMLButtonElement) ||
    !(statusEl instanceof HTMLSpanElement) ||
    !(notifyEl instanceof HTMLInputElement) ||
    !(notifyStatusEl instanceof HTMLSpanElement) ||
    !(parentFolderEl instanceof HTMLSelectElement) ||
    !(parentFolderStatusEl instanceof HTMLSpanElement)
  ) {
    // DOM not ready; abort quietly
    return;
  }

  async function load() {
    if (parentFolderDescriptionEl) {
      parentFolderDescriptionEl.textContent = `Choose the parent bookmark folder. A "${ROOT_FOLDER_NAME}" subfolder will be created.`;
    }
    try {
      const data = await chromeP.storageGet([
        'raindropApiToken',
        'notifyOnSync',
        'parentFolderId',
        'rootFolderId',
      ]);
      if (tokenEl) tokenEl.value = (data && data.raindropApiToken) || '';
      const enabled =
        data && typeof data.notifyOnSync === 'boolean'
          ? data.notifyOnSync
          : true; // default ON
      if (notifyEl) notifyEl.checked = !!enabled;

      // Populate the select with current folders (and keep previous selection if possible)
      await populateParentFolders(data.parentFolderId);

      parentFolderEl.addEventListener('change', async () => {
        const newParentId = parentFolderEl.value;
        await saveState({ parentFolderId: newParentId });

        try {
          const { rootFolderId } = await loadState();
          if (rootFolderId) {
            await chromeP.bookmarksMove(rootFolderId, {
              parentId: newParentId,
            });
          }
          /** @type {any} */ (window)
            .Toastify({
              text: '📂 Parent folder updated',
              duration: 3000,
              position: 'right',
              style: { background: '#3b82f6' },
            })
            .showToast();
        } catch (error) {
          console.error('Failed to move Raindrop folder:', error);
          /** @type {any} */ (window)
            .Toastify({
              text: 'Failed to move Raindrop folder.',
              duration: 3000,
              position: 'right',
              style: { background: '#ef4444' },
            })
            .showToast();
        }
      });
    } catch (_) {}
  }

  function save() {
    if (saveEl) saveEl.disabled = true;
    const value = tokenEl ? tokenEl.value.trim() : '';
    try {
      chrome.storage.local.set({ raindropApiToken: value }, () => {
        try {
          // Show toast instead of inline "Saved" text
          /** @type {any} */ (window)
            .Toastify({
              text: '🔐 API token saved',
              duration: 3000,
              position: 'right',
              style: { background: '#22c55e' },
            })
            .showToast();
        } catch (_) {}
        // Clear inline status text after success
        if (statusEl) statusEl.textContent = '';
        if (saveEl) saveEl.disabled = false;
      });
    } catch (e) {
      if (saveEl) saveEl.disabled = false;
    }
  }

  if (saveEl) saveEl.addEventListener('click', save);
  if (formEl)
    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      save();
    });
  // notifications toggle: save immediately
  if (notifyEl)
    notifyEl.addEventListener('change', () => {
      const value = !!notifyEl.checked;
      if (notifyStatusEl) {
        notifyStatusEl.textContent = 'Saving…';
        notifyStatusEl.className = 'text-sm text-blue-600 dark:text-blue-400';
      }
      try {
        chrome.storage.local.set({ notifyOnSync: value }, () => {
          try {
            // Show toast instead of inline "Saved" text
            /** @type {any} */ (window)
              .Toastify({
                text: '📣 Notification preference saved',
                duration: 3000,
                position: 'right',
                style: { background: '#3b82f6' },
              })
              .showToast();
          } catch (_) {}
          if (notifyStatusEl) notifyStatusEl.textContent = '';
        });
      } catch (_) {
        if (notifyStatusEl) {
          notifyStatusEl.textContent = 'Failed to save';
          notifyStatusEl.className = 'text-sm text-red-600 dark:text-red-400';
        }
      }
    });

  const findDuplicatesEl = /** @type {HTMLButtonElement} */ (
    document.getElementById('find-duplicates')
  );
  const duplicatesContainerEl = /** @type {HTMLDivElement} */ (
    document.getElementById('duplicates-container')
  );

  if (
    !(findDuplicatesEl instanceof HTMLButtonElement) ||
    !(duplicatesContainerEl instanceof HTMLDivElement)
  ) {
    return;
  }

  async function findAndDisplayDuplicates() {
    findDuplicatesEl.disabled = true;
    duplicatesContainerEl.innerHTML =
      '<p class="text-sm">Finding duplicates...</p>';

    try {
      const { rootCollections, childCollections } =
        await fetchGroupsAndCollections();
      const collectionIdToName = new Map();
      for (const c of [...rootCollections, ...childCollections]) {
        collectionIdToName.set(c._id, c.title);
      }

      let allRaindrops = [];
      let page = 0;
      while (true) {
        const res = await apiGET(`/raindrops/0?perpage=50&page=${page}`);
        if (res.items.length === 0) {
          break;
        }
        allRaindrops.push(...res.items);
        page++;
      }

      const raindropsByCollection = new Map();
      for (const r of allRaindrops) {
        const collectionId = r.collection.$id;
        if (!raindropsByCollection.has(collectionId)) {
          raindropsByCollection.set(collectionId, []);
        }
        raindropsByCollection.get(collectionId).push(r);
      }

      let duplicatesByCollection = new Map();
      for (const [collectionId, raindrops] of raindropsByCollection.entries()) {
        raindrops.sort(
          (a, b) =>
            new Date(a.lastUpdate).getTime() - new Date(b.lastUpdate).getTime(),
        );
        const seenUrls = new Set();
        const collectionDuplicates = [];
        for (const raindrop of raindrops) {
          if (seenUrls.has(raindrop.link)) {
            collectionDuplicates.push(raindrop);
          } else {
            seenUrls.add(raindrop.link);
          }
        }

        if (collectionDuplicates.length > 0) {
          let collectionName = collectionIdToName.get(collectionId);
          if (!collectionName) {
            if (collectionId === -1) collectionName = 'Unsorted';
            else collectionName = `Collection ${collectionId}`;
          }
          duplicatesByCollection.set(collectionId, {
            name: collectionName,
            duplicates: collectionDuplicates,
          });
        }
      }

      if (duplicatesByCollection.size === 0) {
        duplicatesContainerEl.innerHTML =
          '<p class="text-sm">No duplicates found.</p>';
        return;
      }

      let html = '';
      let allDuplicateIds = [];
      for (const [
        collectionId,
        { name, duplicates },
      ] of duplicatesByCollection.entries()) {
        html += `<h3 class="text-lg font-medium mt-4">${name}</h3>`;
        html += '<ul class="list-disc list-inside">';
        for (const dup of duplicates) {
          html += `<li class="text-sm"><a href="${dup.link}" target="_blank" class="text-blue-600 hover:underline dark:text-blue-400">${dup.title}</a></li>`;
          allDuplicateIds.push(dup._id);
        }
        html += '</ul>';
      }

      html += `<button id="remove-duplicates" class="mt-4 inline-flex items-center rounded-lg bg-red-600 px-4 py-2 text-white shadow-sm transition cursor-pointer hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-60">Remove ${allDuplicateIds.length} Duplicates</button>`;
      duplicatesContainerEl.innerHTML = html;

      const removeButton = /** @type {HTMLButtonElement} */ (
        document.getElementById('remove-duplicates')
      );
      if (removeButton) {
        removeButton.addEventListener('click', async () => {
          removeButton.disabled = true;
          removeButton.textContent = 'Removing...';

          const duplicateIdsByCollection = new Map();
          for (const [
            collectionId,
            { duplicates },
          ] of duplicatesByCollection.entries()) {
            const ids = duplicates.map((d) => d._id);
            duplicateIdsByCollection.set(collectionId, ids);
          }

          for (const [
            collectionId,
            ids,
          ] of duplicateIdsByCollection.entries()) {
            await apiDELETEWithBody(`/raindrops/${collectionId}`, { ids });
          }

          // @ts-ignore
          Toastify({
            text: '✅ Duplicates removed successfully',
            duration: 3000,
            position: 'right',
            style: { background: '#22c55e' },
          }).showToast();

          // After removing duplicates, also perform a reset and re-sync
          // to make sure local bookmarks are in sync with raindrop after dedup
          // @ts-ignore
          Toastify({
            text: '🗑️ Deleting local data and starting a full sync...',
            duration: 5000,
            position: 'right',
            style: { background: '#f59e0b' },
          }).showToast();

          try {
            await chrome.runtime.sendMessage({ type: 'resetAndSync' });
          } catch (error) {
            console.error('Failed to send resetAndSync message:', error);
            // @ts-ignore
            Toastify({
              text: 'Failed to start reset and sync.',
              duration: 3000,
              position: 'right',
              style: { background: '#ef4444' },
            }).showToast();
          }

          duplicatesContainerEl.innerHTML = '';
        });
      }
    } catch (error) {
      duplicatesContainerEl.innerHTML = `<p class="text-sm text-red-600 dark:text-red-400">Error: ${error.message}</p>`;
    } finally {
      findDuplicatesEl.disabled = false;
    }
  }

  findDuplicatesEl.addEventListener('click', findAndDisplayDuplicates);

  const resetAndSyncEl = /** @type {HTMLButtonElement} */ (
    document.getElementById('reset-and-sync')
  );

  if (resetAndSyncEl instanceof HTMLButtonElement) {
    resetAndSyncEl.addEventListener('click', async () => {
      // @ts-ignore
      Toastify({
        text: '🗑️ Deleting local data and starting a full sync...',
        duration: 5000,
        position: 'right',
        style: { background: '#f59e0b' },
      }).showToast();

      try {
        await chrome.runtime.sendMessage({ type: 'resetAndSync' });
      } catch (error) {
        console.error('Failed to send resetAndSync message:', error);
        // @ts-ignore
        Toastify({
          text: 'Failed to start reset and sync.',
          duration: 3000,
          position: 'right',
          style: { background: '#ef4444' },
        }).showToast();
      }
    });
  }
  // removed action button preferences
  load();
})();
