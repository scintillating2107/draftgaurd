/**
 * DraftGuard — Content script (Manifest V3)
 * Auto-saves text fields locally; restores up to 3 versions per field.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'draftGuardData';
  const UI_KEY = 'draftGuardUi';
  const DEBOUNCE_MS = 2000;
  const MIN_SAVE_LENGTH = 5;
  const MAX_VERSIONS = 3;
  const LONG_PRESS_MS = 500;
  const ATTR_BOUND = 'data-draftguard-bound';

  /**
   * @type {WeakMap<Element, {
   *  fieldId: string,
   *  button: HTMLButtonElement,
   *  debounceTimer: number | null,
   *  longPressTimer: number | null,
   *  longPressFired: boolean,
   *  onScrollResize: (() => void) | null,
   *  manualButtonPos: { top: number, left: number } | null,
   *  drag: { pointerId: number, startX: number, startY: number, startLeft: number, startTop: number, moved: boolean } | null,
   *  dismissed: boolean,
   * }>}
   */
  const fieldState = new WeakMap();

  let openMenu = null;
  let menuCloseOnDocListener = null;

  /** Sync hint so `contextmenu` can call preventDefault immediately (async storage cannot). */
  const versionCountByFieldId = new Map();

  /** @type {Map<string, { top: number, left: number }>} */
  const manualPosCache = new Map(); // key = hostname|fieldId

  let uiLoaded = false;
  let uiLoadPromise = null;

  async function ensureUiLoaded() {
    if (uiLoaded) return;
    if (!uiLoadPromise) {
      uiLoadPromise = (async () => {
        try {
          const result = await chrome.storage.local.get(UI_KEY);
          const ui = result[UI_KEY];
          if (ui && typeof ui === 'object') {
            for (const [k, v] of Object.entries(ui)) {
              if (v && typeof v === 'object' && typeof v.top === 'number' && typeof v.left === 'number') {
                manualPosCache.set(k, { top: v.top, left: v.left });
              }
            }
          }
        } catch {
          // ignore
        } finally {
          uiLoaded = true;
        }
      })();
    }
    await uiLoadPromise;
  }

  function makePosKey(hostname, fieldId) {
    return String(hostname) + '|' + String(fieldId);
  }

  async function saveManualPos(hostname, fieldId, pos) {
    const key = makePosKey(hostname, fieldId);
    if (!pos) manualPosCache.delete(key);
    else manualPosCache.set(key, pos);

    await ensureUiLoaded();
    const result = await chrome.storage.local.get(UI_KEY);
    const ui = (result && result[UI_KEY] && typeof result[UI_KEY] === 'object') ? result[UI_KEY] : {};

    if (pos) ui[key] = { top: pos.top, left: pos.left };
    else delete ui[key];

    await chrome.storage.local.set({ [UI_KEY]: ui });
  }

  function setVersionCountCache(fieldId, count) {
    if (count > 0) versionCountByFieldId.set(fieldId, count);
    else versionCountByFieldId.delete(fieldId);
  }

  // ---------------------------------------------------------------------------
  // Host & field identity
  // ---------------------------------------------------------------------------

  function getHostname() {
    return location.hostname || 'unknown';
  }

  /**
   * Compact DOM path for disambiguation when id/name are missing.
   */
  function getDomPath(el) {
    const parts = [];
    let node = el;
    const maxDepth = 12;
    let depth = 0;

    while (
      node &&
      node.nodeType === Node.ELEMENT_NODE &&
      node !== document.documentElement &&
      depth < maxDepth
    ) {
      let sel = node.tagName.toLowerCase();
      if (node.id) {
        sel += '#' + (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(node.id) : node.id.replace(/([^\w-])/g, '\\$1'));
        parts.unshift(sel);
        break;
      }
      const parent = node.parentElement;
      if (!parent) {
        parts.unshift(sel);
        break;
      }
      const tag = node.tagName;
      const sameTagSiblings = Array.from(parent.children).filter((c) => c.tagName === tag);
      const idx = sameTagSiblings.indexOf(node) + 1;
      sel += ':nth-of-type(' + idx + ')';
      parts.unshift(sel);
      node = parent;
      depth++;
    }
    return parts.join('>');
  }

  /**
   * Stable-ish id: tag + id + name + limited class + path.
   */
  function generateFieldId(el) {
    const tag = el.tagName.toLowerCase();
    const idPart = el.id ? String(el.id) : '';
    let namePart = '';
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      namePart = el.name || '';
    }
    let classPart = '';
    if (typeof el.className === 'string' && el.className.trim()) {
      classPart = el.className.trim().split(/\s+/).slice(0, 3).join('.');
    }
    const path = getDomPath(el);
    const raw = [tag, idPart, namePart, classPart, path].join('|');
    return raw.length > 240 ? raw.slice(0, 240) : raw;
  }

  // ---------------------------------------------------------------------------
  // Field type detection
  // ---------------------------------------------------------------------------

  function isPasswordInput(el) {
    return el instanceof HTMLInputElement && el.type === 'password';
  }

  /**
   * Text-like inputs we support (per spec + common text variants).
   */
  function isSupportedInput(el) {
    if (!(el instanceof HTMLInputElement)) return false;
    if (isPasswordInput(el)) return false;
    const t = (el.type || 'text').toLowerCase();
    return (
      t === 'text' ||
      t === 'search' ||
      t === 'email' ||
      t === 'url' ||
      t === 'tel' ||
      t === ''
    );
  }

  function isTextarea(el) {
    return el instanceof HTMLTextAreaElement;
  }

  function isContentEditable(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.isContentEditable !== true) return false;
    if (el.closest('[contenteditable="false"]')) return false;
    return true;
  }

  function looksSensitiveField(el) {
    if (!(el instanceof HTMLElement)) return false;

    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (
      autocomplete.includes('one-time-code') ||
      autocomplete.includes('cc-number') ||
      autocomplete.includes('cc-csc') ||
      autocomplete.includes('cc-exp') ||
      autocomplete.includes('cc-exp-month') ||
      autocomplete.includes('cc-exp-year') ||
      autocomplete.includes('cc-name')
    ) {
      return true;
    }

    const name = (/** @type {any} */ (el).name || '').toLowerCase();
    const id = (el.id || '').toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
    const hay = [name, id, aria, placeholder].filter(Boolean).join(' ');

    // Keep intentionally small + obvious heuristics to avoid false positives.
    if (/\b(otp|one[-\s]?time|2fa|mfa|totp|verification|passcode|pin)\b/.test(hay)) return true;
    if (/\b(cvv|cvc|card\s?number|credit\s?card|debit\s?card)\b/.test(hay)) return true;

    if (el instanceof HTMLInputElement) {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'password') return true;
    }

    return false;
  }

  function isTrackableField(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.closest('[data-draftguard-ignore]')) return false;
    if (looksSensitiveField(el)) return false;
    if (isTextarea(el)) return !isPasswordInput(el);
    if (isSupportedInput(el)) return true;
    if (isContentEditable(el)) return true;
    return false;
  }

  // ---------------------------------------------------------------------------
  // Value read/write
  // ---------------------------------------------------------------------------

  function getFieldValue(el) {
    if (isContentEditable(el)) {
      // `innerText` preserves paragraph/line breaks; fallback keeps something reasonable.
      return el.innerText != null ? el.innerText : el.textContent || '';
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      return el.value;
    }
    return '';
  }

  function setFieldValue(el, text) {
    if (isContentEditable(el)) {
      el.focus();
      // Using innerText keeps paragraph breaks (newlines) stable across sites.
      el.innerText = text;
      // Some sites/browsers throw on `new InputEvent(...)`; fall back to a plain Event.
      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
      } catch {
        el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      }
      return;
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.focus();
      const proto =
        el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // ---------------------------------------------------------------------------
  // Storage: { "domain.com": { "fieldId": ["v1","v2","v3"] } }
  // ---------------------------------------------------------------------------

  async function loadAllData() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const data = result[STORAGE_KEY];
    return data && typeof data === 'object' ? data : {};
  }

  async function saveAllData(root) {
    await chrome.storage.local.set({ [STORAGE_KEY]: root });
  }

  async function getVersionsForField(hostname, fieldId) {
    const root = await loadAllData();
    const bucket = root[hostname];
    if (!bucket || typeof bucket !== 'object') return [];
    const arr = bucket[fieldId];
    return Array.isArray(arr) ? arr.filter((v) => typeof v === 'string') : [];
  }

  async function setVersionsForField(hostname, fieldId, versions) {
    const root = await loadAllData();
    if (!root[hostname]) root[hostname] = {};
    root[hostname][fieldId] = versions;
    if (versions.length === 0) {
      delete root[hostname][fieldId];
      if (Object.keys(root[hostname]).length === 0) delete root[hostname];
    }
    setVersionCountCache(fieldId, versions.length);
    await saveAllData(root);
  }

  /**
   * Append new version; FIFO trim to MAX_VERSIONS; skip duplicates of latest.
   */
  async function persistNewVersion(hostname, fieldId, text) {
    const trimmed = text.trim();
    if (trimmed.length < MIN_SAVE_LENGTH) return;

    const root = await loadAllData();
    if (!root[hostname]) root[hostname] = {};
    let arr = Array.isArray(root[hostname][fieldId]) ? [...root[hostname][fieldId]] : [];
    if (arr.length && arr[arr.length - 1] === text) return;

    arr.push(text);
    while (arr.length > MAX_VERSIONS) arr.shift();
    root[hostname][fieldId] = arr;
    setVersionCountCache(fieldId, arr.length);
    await saveAllData(root);
  }

  async function clearFieldDrafts(hostname, fieldId) {
    await setVersionsForField(hostname, fieldId, []);
  }

  async function clearHostDrafts(hostname) {
    const root = await loadAllData();
    if (root && typeof root === 'object' && root[hostname]) {
      delete root[hostname];
      await saveAllData(root);
    }
  }

  // ---------------------------------------------------------------------------
  // UI: positioning
  // ---------------------------------------------------------------------------

  /** Button uses `position: fixed`; coordinates are viewport-relative. */
  function positionNearField(field, el) {
    const state = fieldState.get(field);
    if (state && state.manualButtonPos) {
      el.style.top = state.manualButtonPos.top + 'px';
      el.style.left = state.manualButtonPos.left + 'px';
      return;
    }
    const r = field.getBoundingClientRect();
    const pad = 6;
    const top = r.top + Math.max(0, r.height / 2 - 14);
    let left = r.right + pad;

    const w = el.offsetWidth || 120;
    if (left + w > window.innerWidth - 8) {
      left = r.left - w - pad;
    }
    if (left < 8) left = 8;

    el.style.top = top + 'px';
    el.style.left = left + 'px';
  }

  function closeMenu() {
    if (openMenu) {
      openMenu.remove();
      openMenu = null;
    }
    if (menuCloseOnDocListener) {
      document.removeEventListener('click', menuCloseOnDocListener, true);
      document.removeEventListener('contextmenu', menuCloseOnDocListener, true);
      menuCloseOnDocListener = null;
    }
  }

  /** Menu uses `position: fixed`; pass viewport coordinates (e.g. clientX / clientY). */
  function showVersionMenu(field, versions, clientX, clientY) {
    closeMenu();
    const hostname = getHostname();
    const state = fieldState.get(field);
    const fieldId = state ? state.fieldId : generateFieldId(field);

    const menu = document.createElement('div');
    menu.className = 'draftguard-menu draftguard-root';
    menu.setAttribute('role', 'menu');

    const title = document.createElement('span');
    title.className = 'draftguard-menu-title';
    title.textContent = 'Draft versions';
    menu.appendChild(title);

    versions.forEach((text, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'draftguard-menu-item';
      item.setAttribute('role', 'menuitem');
      // Menu preview: always single-line (first line only), but restore uses full text.
      const firstLine = String(text).split(/\r?\n/)[0] || '';
      const preview = firstLine.replace(/\s+/g, ' ').trim();
      const short = preview.length > 72 ? preview.slice(0, 72) + '…' : preview || '(empty)';
      const label = document.createElement('span');
      label.textContent = short;
      item.appendChild(label);
      const meta = document.createElement('span');
      meta.className = 'draftguard-menu-item--meta';
      meta.textContent = index === 0 ? 'Most recent' : 'Older save #' + (index + 1);
      item.appendChild(meta);

      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setFieldValue(field, text);
        closeMenu();
        void refreshButtonForField(field);
      });

      menu.appendChild(item);
    });

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'draftguard-menu-item';
    clear.setAttribute('role', 'menuitem');
    clear.textContent = 'Clear drafts for this field';
    clear.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void (async () => {
        await clearFieldDrafts(hostname, fieldId);
        closeMenu();
        void refreshButtonForField(field);
      })();
    });
    menu.appendChild(clear);

    document.documentElement.appendChild(menu);

    const mx = typeof clientX === 'number' ? clientX : 8;
    const my = typeof clientY === 'number' ? clientY : 8;
    menu.style.top = my + 'px';
    menu.style.left = mx + 'px';

    requestAnimationFrame(() => {
      const mr = menu.getBoundingClientRect();
      let top = my;
      let left = mx;
      if (mr.right > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mr.width - 8);
      if (mr.bottom > window.innerHeight - 8) top = Math.max(8, window.innerHeight - mr.height - 8);
      menu.style.top = top + 'px';
      menu.style.left = left + 'px';
    });

    openMenu = menu;

    menuCloseOnDocListener = (e) => {
      if (menu.contains(e.target)) return;
      closeMenu();
    };
    setTimeout(() => {
      document.addEventListener('click', menuCloseOnDocListener, true);
      document.addEventListener('contextmenu', menuCloseOnDocListener, true);
    }, 0);
  }

  // ---------------------------------------------------------------------------
  // Per-field controller
  // ---------------------------------------------------------------------------

  function ensureButton(field) {
    let state = fieldState.get(field);
    if (state && state.button && state.button.isConnected) return state;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'draftguard-btn draftguard-root';
    btn.textContent = 'Restore draft';
    btn.setAttribute('aria-label', 'Restore saved draft');
    btn.style.display = 'none';
    document.documentElement.appendChild(btn);

    const newState = {
      fieldId: generateFieldId(field),
      button: btn,
      debounceTimer: null,
      longPressTimer: null,
      longPressFired: false,
      onScrollResize: null,
      manualButtonPos: null,
      drag: null,
      dismissed: false,
    };
    fieldState.set(field, newState);

    // Load saved manual position (if any) for this site+field.
    void (async () => {
      await ensureUiLoaded();
      const key = makePosKey(getHostname(), newState.fieldId);
      const pos = manualPosCache.get(key);
      if (pos) {
        newState.manualButtonPos = { top: pos.top, left: pos.left };
        btn.style.top = pos.top + 'px';
        btn.style.left = pos.left + 'px';
      }
    })();

    function clamp(n, min, max) {
      return Math.min(max, Math.max(min, n));
    }

    btn.addEventListener('pointerdown', (e) => {
      // Only drag on primary button/touch/pen.
      if (e.button != null && e.button !== 0) return;

      // If a menu is open, close it before dragging.
      closeMenu();

      const br = btn.getBoundingClientRect();
      newState.drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startLeft: br.left,
        startTop: br.top,
        moved: false,
      };

      newState.longPressFired = false;
      btn.setPointerCapture?.(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });

    btn.addEventListener('pointermove', (e) => {
      if (!newState.drag || newState.drag.pointerId !== e.pointerId) return;
      const dx = e.clientX - newState.drag.startX;
      const dy = e.clientY - newState.drag.startY;
      if (!newState.drag.moved && Math.hypot(dx, dy) >= 4) newState.drag.moved = true;

      const bw = btn.offsetWidth || 120;
      const bh = btn.offsetHeight || 32;
      const left = clamp(newState.drag.startLeft + dx, 8, window.innerWidth - bw - 8);
      const top = clamp(newState.drag.startTop + dy, 8, window.innerHeight - bh - 8);

      newState.manualButtonPos = { top, left };
      btn.style.top = top + 'px';
      btn.style.left = left + 'px';

      e.preventDefault();
      e.stopPropagation();
    });

    function endDrag(e) {
      if (!newState.drag || newState.drag.pointerId !== e.pointerId) return;
      const moved = newState.drag.moved;
      newState.drag = null;

      // If user dragged, suppress the subsequent click that would open restore.
      if (moved) newState.longPressFired = true;
      if (moved && newState.manualButtonPos) {
        void saveManualPos(getHostname(), newState.fieldId, newState.manualButtonPos);
      }

      try {
        btn.releasePointerCapture?.(e.pointerId);
      } catch {
        // ignore
      }
      e.preventDefault();
      e.stopPropagation();
    }

    btn.addEventListener('pointerup', endDrag);
    btn.addEventListener('pointercancel', endDrag);

    btn.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Reset position: snap back near the field (and forget saved pos).
      newState.manualButtonPos = null;
      void saveManualPos(getHostname(), newState.fieldId, null);
      closeMenu();
      // Prevent the second click from opening the menu.
      newState.longPressFired = true;
      void refreshButtonForField(field);
    });

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Double-click is reserved for "reset position".
      if (e.detail === 2) return;
      // Triple-click: dismiss the button until the next input/change for this field.
      if (e.detail >= 3) {
        newState.dismissed = true;
        btn.style.display = 'none';
        closeMenu();
        return;
      }
      if (newState.longPressFired) {
        newState.longPressFired = false;
        return;
      }
      // Default behavior: open picker so user can choose older versions.
      // Power-user shortcut: Ctrl/Cmd+Click quickly restores the most recent version.
      if (e.ctrlKey || e.metaKey) {
        void (async () => {
          const versions = await getVersionsForField(getHostname(), newState.fieldId);
          if (!versions.length) return;
          const latest = versions[versions.length - 1];
          setFieldValue(field, latest);
          void refreshButtonForField(field);
        })();
        return;
      }

      const br = btn.getBoundingClientRect();
      void openVersionPicker(field, br.left, br.bottom + 4);
    });

    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void openVersionPicker(field, e.clientX, e.clientY);
    });

    // Long-press (touch)
    btn.addEventListener(
      'touchstart',
      () => {
        newState.longPressFired = false;
        newState.longPressTimer = window.setTimeout(() => {
          newState.longPressFired = true;
          void openVersionPicker(field);
        }, LONG_PRESS_MS);
      },
      { passive: true }
    );
    btn.addEventListener('touchend', () => {
      if (newState.longPressTimer) {
        clearTimeout(newState.longPressTimer);
        newState.longPressTimer = null;
      }
    });
    btn.addEventListener('touchcancel', () => {
      if (newState.longPressTimer) {
        clearTimeout(newState.longPressTimer);
        newState.longPressTimer = null;
      }
    });

    return newState;
  }

  async function openVersionPicker(field, clientX, clientY) {
    const state = fieldState.get(field);
    if (!state) return;
    const versions = await getVersionsForField(getHostname(), state.fieldId);
    if (!versions.length) return;
    const reversed = [...versions].reverse();
    const br = state.button.getBoundingClientRect();
    const x = typeof clientX === 'number' ? clientX : br.left;
    const y = typeof clientY === 'number' ? clientY : br.bottom + 4;
    showVersionMenu(field, reversed, x, y);
  }

  async function refreshButtonForField(field) {
    const state = ensureButton(field);
    state.fieldId = generateFieldId(field);
    const versions = await getVersionsForField(getHostname(), state.fieldId);
    const btn = state.button;

    if (!versions.length) {
      setVersionCountCache(state.fieldId, 0);
      btn.style.display = 'none';
      return;
    }

    setVersionCountCache(state.fieldId, versions.length);

    const current = getFieldValue(field);
    const latest = versions[versions.length - 1];
    const looksSynced = current === latest;

    btn.style.display = looksSynced || state.dismissed ? 'none' : 'inline-block';
    positionNearField(field, btn);

    if (!state.onScrollResize) {
      state.onScrollResize = () => {
        if (btn.style.display !== 'none') positionNearField(field, btn);
      };
      window.addEventListener('scroll', state.onScrollResize, true);
      window.addEventListener('resize', state.onScrollResize);
    }
  }

  function scheduleSave(field) {
    const state = ensureButton(field);
    if (state.debounceTimer) clearTimeout(state.debounceTimer);

    state.debounceTimer = window.setTimeout(() => {
      state.debounceTimer = null;
      const text = getFieldValue(field);
      if (text.trim().length < MIN_SAVE_LENGTH) return;
      void (async () => {
        state.dismissed = false;
        await persistNewVersion(getHostname(), state.fieldId, text);
        await refreshButtonForField(field);
      })();
    }, DEBOUNCE_MS);
  }

  function bindField(field) {
    if (!(field instanceof HTMLElement)) return;
    if (field.getAttribute(ATTR_BOUND) === '1') return;
    if (!isTrackableField(field)) return;

    field.setAttribute(ATTR_BOUND, '1');
    ensureButton(field);

    const onInput = () => {
      const state = fieldState.get(field);
      if (state) state.dismissed = false;
      scheduleSave(field);
      void refreshButtonForField(field);
    };

    field.addEventListener('input', onInput);
    field.addEventListener('focus', () => void refreshButtonForField(field));

    // Right-click on field: version picker when drafts exist (cache allows sync preventDefault).
    field.addEventListener('contextmenu', (e) => {
      const state = fieldState.get(field);
      const fid = state ? state.fieldId : generateFieldId(field);
      if ((versionCountByFieldId.get(fid) || 0) === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const cx = e.clientX;
      const cy = e.clientY;
      void (async () => {
        const versions = await getVersionsForField(getHostname(), fid);
        if (!versions.length) return;
        showVersionMenu(field, [...versions].reverse(), cx, cy);
      })();
    });

    // Long-press on field (touch)
    let touchTimer = null;
    field.addEventListener(
      'touchstart',
      () => {
        touchTimer = window.setTimeout(() => {
          touchTimer = null;
          void (async () => {
            const state = fieldState.get(field);
            const fid = state ? state.fieldId : generateFieldId(field);
            const versions = await getVersionsForField(getHostname(), fid);
            if (!versions.length) return;
            const r = field.getBoundingClientRect();
            openVersionPicker(field, r.left, r.bottom + 4);
          })();
        }, LONG_PRESS_MS);
      },
      { passive: true }
    );
    field.addEventListener('touchend', () => {
      if (touchTimer) clearTimeout(touchTimer);
    });
    field.addEventListener('touchcancel', () => {
      if (touchTimer) clearTimeout(touchTimer);
    });

    const form = field.closest('form');
    if (form) {
      form.addEventListener(
        'submit',
        () => {
          const state = fieldState.get(field);
          const fid = state ? state.fieldId : generateFieldId(field);
          void clearFieldDrafts(getHostname(), fid);
          void refreshButtonForField(field);
        },
        { capture: true }
      );
    }

    void refreshButtonForField(field);
  }

  function scanNode(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    const el = /** @type {Element} */ (root);

    if (isTrackableField(el)) bindField(el);

    const inputs = el.querySelectorAll?.('textarea, input, [contenteditable]');
    if (inputs) {
      inputs.forEach((node) => {
        if (node instanceof HTMLElement) bindField(node);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Boot: observe dynamic DOM
  // ---------------------------------------------------------------------------

  function init() {
    scanNode(document.body);

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType === Node.ELEMENT_NODE) scanNode(/** @type {Element} */ (n));
        });
      }
    });

    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        scanNode(document.body);
        observer.observe(document.body, { childList: true, subtree: true });
      });
    }
  }

  init();
})();
