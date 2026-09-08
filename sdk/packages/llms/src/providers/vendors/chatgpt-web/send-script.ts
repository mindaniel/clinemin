/**
 * The JavaScript injected into the ChatGPT page to send a message.
 */

export const SEND_MESSAGE_SOURCE = `
// ---------- 1. Toggle "Think" mode ----------
async function setChatGPTThink(enable) {
    const thinkBtn = Array.from(document.querySelectorAll('button')).find(btn => {
        const text = btn.textContent.trim();
        return text === 'Think' || text.includes('Think');
    });

    if (!thinkBtn) {
        console.warn('⚠️ Think button not found');
        return false;
    }

    const isPressed = thinkBtn.getAttribute('aria-pressed') === 'true';
    if (enable === isPressed) {
        console.log('🧠 Think already ' + (enable ? 'ON' : 'OFF'));
        return true;
    }

    thinkBtn.click();
    console.log('🧠 Think ' + (enable ? 'ENABLED' : 'DISABLED'));

    await new Promise(resolve => setTimeout(resolve, 300));
    return true;
}

// ---------- 2. Set text in ProseMirror contenteditable ----------
async function setChatGPTInput(message) {
    console.log('🔍 Step 1: Looking for input editor...');
    const editor = document.querySelector('#prompt-textarea');
    if (!editor) {
        console.error('❌ Input editor #prompt-textarea not found');
        return false;
    }
    console.log('✅ Found editor:', editor);

    // Focus the editor
    console.log('🔍 Step 2: Focusing editor...');
    editor.focus();

    // Clear existing content (select all)
    console.log('🔍 Step 3: Selecting existing content to clear...');
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);

    // Method 1: Use execCommand to insert text (works well with ProseMirror)
    console.log('🔍 Step 4: Inserting text via execCommand...');
    try {
        const success = document.execCommand('insertText', false, message);
        console.log('✍️ Text inserted via execCommand, success:', success);
    } catch (e) {
        console.warn('⚠️ execCommand failed, trying innerHTML fallback:', e);
        // Method 2: Fallback – set innerHTML and dispatch input event
        editor.innerHTML = '<p>' + message + '</p>';
        editor.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: message
        }));
        console.log('✍️ Text inserted via innerHTML fallback');
    }

    // Dispatch a secondary input event to ensure React state updates
    console.log('🔍 Step 5: Dispatching secondary input event for React...');
    editor.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: message
    }));

    // Wait for the send button to become enabled
    console.log('🔍 Step 6: Waiting 500ms for send button to enable...');
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('✅ setChatGPTInput completed successfully');
    return true;
}

// ---------- 3. Click the send button ----------
async function clickChatGPTSend() {
    const selectors = [
        'button[data-testid="send-button"]',
        'button[aria-label="Send"]',
        'button[aria-label="Send message"]',
        'button[type="submit"]',
        'form button[type="submit"]',
        'button[class*="send"]'
    ];

    let sendBtn = null;
    // Try each selector with a small delay between attempts
    for (const sel of selectors) {
        sendBtn = document.querySelector(sel);
        if (sendBtn && !sendBtn.disabled) {
            break;
        }
        // Wait a bit before trying the next selector
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    // If not found, look for the icon arrow-up button
    if (!sendBtn || sendBtn.disabled) {
        sendBtn = Array.from(document.querySelectorAll('button')).find(btn => {
            const svg = btn.querySelector('svg');
            const label = (btn.getAttribute('aria-label') || '').toLowerCase();
            // Look for SVG with arrow-up or send icon
            if (svg) {
                const innerHTML = svg.innerHTML.toLowerCase();
                const hasArrow = innerHTML.includes('arrow') || innerHTML.includes('send') || innerHTML.includes('up');
                if (hasArrow || label.includes('send')) {
                    return !btn.disabled;
                }
            }
            return svg && label.includes('send') && !btn.disabled;
        });
    }

    if (!sendBtn || sendBtn.disabled) {
        console.warn('⚠️ Send button not found or disabled, trying Enter key');
        const editor = document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"]');
        if (editor) {
            // Try both keydown and keypress events
            editor.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true
            }));
            editor.dispatchEvent(new KeyboardEvent('keypress', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true
            }));
            // Also try a simulated Enter on the textarea if it exists
            if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
                editor.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Enter',
                    code: 'Enter',
                    keyCode: 13,
                    which: 13,
                    bubbles: true,
                    cancelable: true
                }));
            }
        }
        return true;
    }

    // Ensure the button is fully visible and clickable
    try {
        sendBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch (e) {}

    // Simulate a full click
    sendBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    sendBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    sendBtn.click();
    console.log('🖱️ Send button clicked');
    return true;
}

// ---------- 4. Main function ----------
async function sendMessageToChatGPT(message, options) {
    options = options || {};
    const think = options.think !== undefined ? options.think : null; // true/false or null to skip

    // Toggle Think if requested
    if (think !== null) {
        await setChatGPTThink(think);
    }

    // Set the message text
    const inputSuccess = await setChatGPTInput(message);
    if (!inputSuccess) {
        console.error('❌ Failed to set input text');
        return false;
    }

    // Wait for send button to become enabled
    await new Promise(resolve => setTimeout(resolve, 500));

    // Send the message
    await clickChatGPTSend();
    console.log('✅ Message sent: ' + message);
    return true;
}
`;

export function buildSendScript(
	prompt: string,
	options?: { think?: boolean },
): string {
	const opts = options || {};
	return `(async () => {
        ${SEND_MESSAGE_SOURCE}
        await sendMessageToChatGPT(${JSON.stringify(prompt)}, ${JSON.stringify(opts)});
    })(); true;`;
}
