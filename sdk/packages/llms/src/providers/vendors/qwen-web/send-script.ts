/**
 * The JavaScript injected into the Qwen page to type and send a message.
 *
 * `SEND_MESSAGE_SOURCE` is a template literal holding plain browser JavaScript,
 * NOT TypeScript. The `async function` declarations inside it are string
 * content evaluated by Chrome; they cannot be imported, split, or typechecked,
 * and must remain byte-for-byte identical to the original file.
 */

export const SEND_MESSAGE_SOURCE = `
// ---------- Helper: Select thinking mode ----------
async function selectThinkingMode(mode) {
    // mode: 'auto' | 'fast' | 'thinking'
    // Find the thinking mode toggle/button
    const selectors = [
        'button[aria-label*="Think" i]',
        'button[aria-label*="思考" i]',
        '[role="button"][aria-label*="Think" i]',
        '.thinking-toggle',
        '.deep-thinking-toggle'
    ];
    let btn = null;
    for (const sel of selectors) {
        btn = document.querySelector(sel);
        if (btn) break;
    }
    if (!btn) {
        console.warn('⚠️ Thinking mode toggle not found');
        return false;
    }
    // Click to toggle to desired mode (simple toggle: if mode is 'thinking' and not active, click; if mode is 'fast' and active, click)
    const isActive = btn.classList.contains('active') || btn.getAttribute('aria-pressed') === 'true';
    const targetActive = mode === 'thinking';
    if (isActive !== targetActive) {
        btn.click();
        console.log('🔄 Toggled thinking mode to', mode);
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    return true;
}

// ---------- Helper: Select model ----------
async function selectModel(modelName) {
    if (!modelName) return true;
    
    // Find the model selector button
    const modelBtn = document.querySelector('button[aria-label*="Model" i], button[aria-label*="模型" i], .model-selector, [role="button"][aria-label*="Model"], .chat-header-model');
    if (!modelBtn) {
        console.warn('⚠️ Model selector button not found');
        return false;
    }
    
    // Normalize strings for robust comparison (remove hyphens, spaces, underscores)
    const normalize = (str) => str.toLowerCase().replace(/[-_s]/g, '');
    const targetModel = normalize(modelName);
    
    // Check text content, aria-label, title, and common data attributes
    const currentText = normalize(modelBtn.textContent || '');
    const currentLabel = normalize(modelBtn.getAttribute('aria-label') || modelBtn.getAttribute('title') || '');
    const dataModel = normalize(modelBtn.getAttribute('data-model') || modelBtn.getAttribute('data-value') || '');
    
    // Avoid false positives from generic words like "model" or "模型"
    const genericWords = ['model', '模型', 'choose', 'select'];
    const isGeneric = genericWords.some(w => currentText === normalize(w));
    
    // Check if the target model is already reflected in the UI
    const isMatch = 
        currentText.includes(targetModel) || 
        (currentText.length > 2 && targetModel.includes(currentText)) ||
        currentLabel.includes(targetModel) ||
        dataModel.includes(targetModel);
        
    if (!isGeneric && isMatch) {
        console.log('✅ Model already selected:', modelName, '(UI shows:', modelBtn.textContent.trim(), ')');
        return true;
    }
    
    modelBtn.click();
    await new Promise(resolve => setTimeout(resolve, 400));
    
    // Find the model option in dropdown
    const options = document.querySelectorAll('[role="option"], .model-option, li');
    for (const opt of options) {
        if (normalize(opt.textContent || '').includes(targetModel) || targetModel.includes(normalize(opt.textContent || ''))) {
            opt.click();
            console.log('✅ Selected model:', modelName);
            await new Promise(resolve => setTimeout(resolve, 300));
            return true;
        }
    }
    
    console.warn('⚠️ Model not found in dropdown:', modelName);
    // Close dropdown
    document.body.click();
    return false;
}

// ---------- Robust Send Button Clicker ----------
async function clickSendButton(timeout) {
    timeout = timeout || 3000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const selectors = [
            'button[type="submit"]',
            'button[aria-label*="Send" i]',
            'button[aria-label*="发送" i]',
            'button[class*="send"]',
            'button[class*="send-btn"]',
            '.ant-btn-primary',
            'button[class*="ant-btn-primary"]',
            '[role="button"][aria-label*="Send" i]',
            '[role="button"][aria-label*="发送" i]'
        ];
        for (const sel of selectors) {
            const btn = document.querySelector(sel);
            if (btn && !btn.disabled && btn.offsetWidth > 0) {
                btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                btn.click();
                console.log('🖱️ Clicked send button:', sel);
                return true;
            }
        }
        // Check for button with icon arrow up
        const arrowButton = document.querySelector('button svg[class*="send"]')?.closest('button');
        if (arrowButton && arrowButton.offsetWidth > 0) {
            arrowButton.click();
            console.log('🖱️ Clicked send button (icon)');
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    console.warn('⚠️ Send button not found, falling back to Enter');
    return false;
}

// ---------- Main send function ----------
async function sendMessageToQwen(message, options) {
    options = options || {};
    const { thinkingMode, model } = options;

    // Apply thinking mode if specified
    if (thinkingMode) {
        await selectThinkingMode(thinkingMode);
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Model selection disabled on purpose: sending a message should not touch
    // the model picker. Whatever model the Qwen web UI already has selected is
    // the one we use.
    // if (model) {
    //     await selectModel(model);
    //     await new Promise(resolve => setTimeout(resolve, 500));
    // }
    void model;

    // Find input field. IMPORTANT: never pick a textarea that belongs to a
    // rendered code block (Qwen wraps those in .qwen-markdown-code / Monaco and
    // embeds a readonly .ime-text-area). Falling through to a bare textarea is
    // what made the assistant code box get mistaken for the composer.
    const inputField = (() => {
        const preferred = document.querySelector('textarea[placeholder*="消息" i], textarea[placeholder*="Message" i], [contenteditable="true"]');
        if (preferred && !preferred.disabled && !preferred.readOnly) {
            const bad = preferred.closest && preferred.closest('.qwen-markdown-code, .monaco-editor, [class*="markdown-code"], pre');
            if (!bad) return preferred;
        }
        const all = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'));
        for (const el of all) {
            if (el.disabled || el.readOnly) continue;
            if (el.closest && el.closest('.qwen-markdown-code, .monaco-editor, [class*="markdown-code"], pre')) continue;
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden') continue;
            if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
            return el;
        }
        return null;
    })();
    if (!inputField) {
        console.error('❌ Input field not found');
        return false;
    }

    // Focus and set text
    inputField.focus();
    if (inputField.tagName === 'TEXTAREA') {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        if (nativeSetter) {
            nativeSetter.call(inputField, message);
        } else {
            inputField.value = message;
        }
        inputField.dispatchEvent(new Event('input', { bubbles: true }));
        inputField.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (inputField.isContentEditable) {
        inputField.textContent = message;
        inputField.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Wait for React state update
    await new Promise(resolve => setTimeout(resolve, 300));

    // Attempt to click send button
    const sendSuccess = await clickSendButton();
    if (sendSuccess) {
        console.log('✅ Sent:', message);
        return true;
    }

    // Fallback: try pressing Enter
    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
    inputField.dispatchEvent(enterEvent);
    console.log('✅ Sent with Enter:', message);
    return true;
}
`;

export function buildSendScript(
	prompt: string,
	options?: { model?: string; thinkingMode?: string },
): string {
	const opts = options || {};
	return `(async () => {
        ${SEND_MESSAGE_SOURCE}
        await sendMessageToQwen(${JSON.stringify(prompt)}, ${JSON.stringify(opts)});
    })(); true;`;
}
