/**
 * The JavaScript injected into the Claude page to type and send a message.
 *
 * `SEND_MESSAGE_SOURCE` is a template literal holding plain browser JavaScript,
 * NOT TypeScript. The `async function` declarations inside it are string
 * content evaluated by Chrome; they cannot be imported, split, or typechecked,
 * and must remain byte-for-byte identical to the original file.
 */

export const SEND_MESSAGE_SOURCE = `
// ---------- 0. Pick an editor we can actually type into ----------
// claude.ai renders a DISABLED placeholder textarea (#static-composer-input)
// alongside the real contenteditable composer. Taking the first element that
// matches a selector types into something that ignores every event, so skip
// anything disabled or hidden.
function pickUsableEditor(selectors) {
    for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
            if (el.disabled) continue;
            if (el.getAttribute('contenteditable') === 'false') continue;
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden') continue;
            return el;
        }
    }
    return null;
}

// ---------- 1. Set text in editor ----------
async function setClaudeInput(message) {
    const selectors = [
        '[data-testid="chat-input"]',
        '#prompt-textarea',
        'textarea[name="prompt"]',
        'textarea[placeholder*="Message" i]',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]'
    ];
    
    let editor = pickUsableEditor(selectors);

    if (!editor) {
        console.error('❌ Input editor not found. Available inputs:', Array.from(document.querySelectorAll('textarea, div[contenteditable="true"]')).map(e => e.tagName + (e.className ? '.'+e.className : '')));
        return false;
    }

    editor.focus();
    await new Promise(resolve => setTimeout(resolve, 100));

    if (editor.tagName.toLowerCase() === 'textarea' || editor.tagName.toLowerCase() === 'input') {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
        if (nativeInputValueSetter) {
            nativeInputValueSetter.call(editor, message);
        } else {
            editor.value = message;
        }
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
        editor.innerHTML = '';
        try {
            document.execCommand('insertText', false, message);
        } catch (e) {
            editor.innerText = message;
        }
        editor.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: message
        }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
    }
    
    await new Promise(resolve => setTimeout(resolve, 300));
    return true;
}

// ---------- 2. Click the send button ----------
async function waitForSendButton(timeout) {
    timeout = timeout || 5000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const selectors = [
            'button[data-testid="chat-input-send"]',
            'button[type="submit"]',
            '.send-button',
            'button[aria-label*="Send" i]',
            'button[aria-label*="发送" i]',
            'button.send-message-button'
        ];
        for (const sel of selectors) {
            const btn = document.querySelector(sel);
            if (btn && !btn.disabled && btn.offsetParent !== null) return btn;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    return null;
}

async function clickClaudeSend() {
    const sendBtn = await waitForSendButton();
    if (sendBtn) {
        sendBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        sendBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        sendBtn.click();
        console.log('✅ Send button clicked');
        return true;
    }
    
    const selectors = [
        '[data-testid="chat-input"]',
        '#prompt-textarea',
        'textarea[name="prompt"]',
        'div[contenteditable="true"]'
    ];
    let editor = pickUsableEditor(selectors);
    
    if (editor) {
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        console.log('✅ Enter key dispatched as fallback');
        return true;
    }
    
    console.warn('❌ Send button not found and Enter key failed');
    return false;
}

// ---------- 3. Main function ----------
async function sendMessageToClaude(message, options) {
    options = options || {};
    const inputSuccess = await setClaudeInput(message);
    if (!inputSuccess) {
        console.error('❌ Failed to set input');
        return false;
    }

    await new Promise(resolve => setTimeout(resolve, 500));

    const sendSuccess = await clickClaudeSend();
    if (sendSuccess) {
        console.log('✅ Message sent successfully: ' + message.substring(0, 50) + '...');
    }
    return sendSuccess;
}
`;

export function buildSendScript(
	prompt: string,
	options?: { think?: boolean },
): string {
	const opts = options || {};
	return `(async () => {
        ${SEND_MESSAGE_SOURCE}
        await sendMessageToClaude(${JSON.stringify(prompt)}, ${JSON.stringify(opts)});
    })(); true;`;
}
