/**
 * The JavaScript injected into the Gemini page to type and send a message.
 *
 * `SEND_MESSAGE_SOURCE` is a template literal holding plain browser JavaScript,
 * NOT TypeScript. The `async function` declarations inside it are string
 * content evaluated by Chrome; they cannot be imported, split, or typechecked,
 * only moved as text. That is why this file has no logic of its own.
 */

// ── Enhanced Gemini send script (from send_gemini.txt) ──────────────────────────
export const SEND_MESSAGE_SOURCE = `
// ---------- 0. Select model (Flash, Pro, Flash-Lite, etc.) ----------
async function selectGeminiModel(modelName) {
    if (!modelName) return true;
    const modelBtn = document.querySelector('[data-test-id="bard-mode-menu-button"]');
    if (!modelBtn) {
        console.warn('Model selector button not found');
        return false;
    }

    modelBtn.click();

    let menuItems = null;
    for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 500 + attempt * 200));
        menuItems = document.querySelectorAll('gem-menu-item[role="menuitem"]');
        if (menuItems.length > 0) break;
    }
    if (!menuItems || menuItems.length === 0) {
        console.warn('No model menu items found');
        return false;
    }

    const target = modelName.toLowerCase().trim();
    let exactMatch = null;
    let partialMatch = null;

    for (const item of menuItems) {
        const labelEl = item.querySelector('.label');
        if (!labelEl) continue;
        let label = (labelEl.textContent || '').trim();
        let cleaned = label.replace(/^\\d+\\.\\s*/, '').trim();
        let cleanedLower = cleaned.toLowerCase();
        if (cleanedLower === target) {
            exactMatch = item;
            break;
        }
        if (cleanedLower.includes(target)) {
            partialMatch = item;
        }
    }

    const targetItem = exactMatch || partialMatch;
    if (!targetItem) {
        console.warn('Model "' + modelName + '" not found in menu');
        return false;
    }

    targetItem.click();
    await new Promise(resolve => setTimeout(resolve, 500));
    return true;
}

// ---------- 1. Set text in Quill editor ----------
async function setGeminiInput(message) {
    const editor = document.querySelector('.ql-editor.textarea.new-input-ui') ||
                   document.querySelector('[data-test-id="textarea-inner"] .ql-editor') ||
                   document.querySelector('[contenteditable="true"][role="textbox"]');
    if (!editor) {
        console.error('Input editor not found');
        return false;
    }

    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);

    try {
        document.execCommand('insertText', false, message);
    } catch (e) {
        editor.innerHTML = '<p>' + message + '</p>';
    }

    editor.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: message
    }));

    await new Promise(resolve => setTimeout(resolve, 300));
    return true;
}

// ---------- 2. Click the send button ----------
async function waitForSendButton(timeout) {
    timeout = timeout || 4000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const selectors = [
            '[data-test-id="send-button"]',
            'button[aria-label*="Send"]',
            'button[class*="send"]',
            'button[type="submit"]'
        ];
        for (const sel of selectors) {
            const btn = document.querySelector(sel);
            if (btn && !btn.disabled) return btn;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    return null;
}

async function clickGeminiSend() {
    const sendBtn = await waitForSendButton();
    if (sendBtn) {
        sendBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        sendBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        sendBtn.click();
    } else {
        const editor = document.querySelector('.ql-editor.textarea.new-input-ui') ||
                       document.querySelector('[contenteditable="true"][role="textbox"]');
        if (editor) {
            editor.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true
            }));
        }
    }
    return true;
}

// ---------- 3. Main function ----------
async function sendMessageToGemini(message, options) {
    options = options || {};

    // Mirror the reference automation: pick the requested model (Pro, Flash,
    // Flash-Lite, etc.) before typing, but only when the caller asked for a
    // specific one — otherwise leave Gemini on its current selection.
    var model = options.model || null;
    if (model) {
        var ok = await selectGeminiModel(model);
        if (!ok) {
            console.warn('Model selection failed, continuing with current model');
        }
    }

    const inputSuccess = await setGeminiInput(message);
    if (!inputSuccess) return false;
    await new Promise(resolve => setTimeout(resolve, 500));
    await clickGeminiSend();
    console.log('Message sent');
    return true;
}
`;

export function buildSendScript(
	prompt: string,
	options?: { think?: boolean; model?: string | null },
): string {
	const opts = options || {};
	return `(async () => {
        ${SEND_MESSAGE_SOURCE}
        await sendMessageToGemini(${JSON.stringify(prompt)}, ${JSON.stringify(opts)});
    })(); true;`;
}
