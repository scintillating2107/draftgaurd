# DraftGuard

DraftGuard is a minimal Chrome extension that auto-saves and restores what you type in:
- `input` (text-like types)
- `textarea`
- `contenteditable` editors (plain text with line breaks)

It stores drafts **locally in your browser** using `chrome.storage.local`.

## Install (free, no Chrome Web Store)

1. Download this repo as ZIP (or `git clone` it) and unzip it.
2. Open Chrome and go to `chrome://extensions`
3. Turn **Developer mode** ON (top-right)
4. Click **Load unpacked**
5. Select the folder that contains `manifest.json`

## Use

- Type in a text field (minimum ~5 characters).
- Wait ~2 seconds for autosave.
- If the field changes, a **Restore draft** button appears.

### Restore interactions

- **Click**: open the versions menu and pick a version
- **Ctrl + Click**: quick-restore the most recent version
- **Drag**: move the button if it covers text (position is remembered per site+field)
- **Double-click**: reset the button position (snap back near the field)
- **Triple-click**: hide the button until you type again

### Versions menu

- Shows a **single-line preview** (first line) for long/multi-paragraph drafts
- Clicking an item restores the **full** saved text
- Includes **Clear drafts for this field**

## Update / Reload after changes

After editing files, go to `chrome://extensions` and click **Reload** on DraftGuard.

## Files

- `manifest.json`: extension manifest (MV3)
- `content.js`: main logic (content script)
- `styles.css`: minimal UI styles

