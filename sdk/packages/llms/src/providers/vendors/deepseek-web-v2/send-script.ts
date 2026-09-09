import { resolveModelOptions } from "../deepseek-web";

// ── Page-side send script (transcribed from sendmessage.js) ─────────────────

/**
 * The same UI-driving code as the reference `sendmessage.js` (functions only —
 * the trailing demo calls are omitted). Evaluated inside chat.deepseek.com via
 * `page.evaluate`. Selectors intentionally mirror the working reference.
 */
const SEND_MESSAGE_SOURCE = `
function selectModel(modelType) {
    var validModels = ['default', 'expert', 'vision'];
    if (validModels.indexOf(modelType) === -1) {
        console.warn('Invalid model type: ' + modelType + '. Using current.');
        return false;
    }
    var radioGroup = document.querySelector('[role="radiogroup"]');
    if (!radioGroup) {
        console.warn('Model selection not found');
        return false;
    }
    var buttons = radioGroup.querySelectorAll('[role="radio"]');
    var found = false;
    buttons.forEach(function (button) {
        var model = button.getAttribute('data-model-type');
        if (model === modelType) {
            var isChecked = button.getAttribute('aria-checked') === 'true';
            if (!isChecked) {
                button.click();
                console.log('Model set to: ' + modelType);
            } else {
                console.log('Model already: ' + modelType);
            }
            found = true;
        }
    });
    if (!found) console.warn('Model button for "' + modelType + '" not found');
    return found;
}

function toggleDeepThinking(enable) {
    var buttons = document.querySelectorAll('.ds-toggle-button');
    var found = false;
    buttons.forEach(function (button) {
        var label = button.querySelector('._6dbc175');
        if (label && label.textContent.trim() === 'Deep thinking') {
            var isSelected = button.classList.contains('ds-toggle-button--selected');
            if ((enable && !isSelected) || (!enable && isSelected)) {
                button.click();
                console.log('Deep thinking ' + (enable ? 'ENABLED' : 'DISABLED'));
            } else {
                console.log('Deep thinking already ' + (enable ? 'ENABLED' : 'DISABLED'));
            }
            found = true;
        }
    });
    if (!found) console.warn('Deep thinking toggle not found');
}

function findSendButton() {
    var filled = document.querySelector('.ds-button--filled');
    if (filled) {
        var filledButton = filled.closest('[role="button"]');
        if (filledButton) return filledButton;
    }
    var icon = document.querySelector('.ds-button__icon svg[viewBox="0 0 16 16"]');
    if (icon) {
        var iconButton = icon.closest('[role="button"]');
        if (iconButton) return iconButton;
    }
    return null;
}

function sendMessageToDeepSeek(message, options) {
    options = options || {};
    var model = options.model !== undefined ? options.model : null;
    var deepThinking = options.deepThinking !== undefined ? options.deepThinking : null;

    var textarea = document.querySelector('textarea[name="search"]');
    if (!textarea) {
        console.error('Textarea not found');
        return false;
    }

    // Apply model selection / Deep Thinking toggle before typing.
    if (model !== null) selectModel(model);
    if (deepThinking !== null) toggleDeepThinking(deepThinking);

    // Type after any clicks settle, then submit 300ms later. This mirrors the
    // reference sendmessage.js exactly — fire-and-forget from the caller's
    // perspective; the caller verifies the outcome via the DOM afterwards.
    setTimeout(function () {
        var nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        nativeSetter.call(textarea, message);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        setTimeout(function () {
            var sendBtn = findSendButton();
            if (sendBtn) {
                sendBtn.click();
                console.log('Sent: "' + message + '"');
            } else {
                textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                console.log('Sent with Enter: "' + message + '"');
            }
        }, 300);
    }, (model !== null || deepThinking !== null) ? 400 : 0);

    return true;
}
`;

/**
 * Build a self-contained page expression that defines the send script and
 * immediately sends `prompt` with the given model options. The message/options
 * are embedded as JSON string literals so the expression is valid without
 * `eval`/`new Function` (which page CSP could block).
 *
 * The page-side send is fire-and-forget (mirrors the reference `sendmessage.js`):
 * typing and the send click happen inside `setTimeout` callbacks after the
 * expression resolves. The caller verifies the outcome by polling the DOM
 * afterwards instead of trusting the evaluate result.
 */
export function buildSendScript(
	prompt: string,
	options: { modelType: string; deepThinking: boolean | null },
): string {
	const opts: Record<string, unknown> = { model: options.modelType };
	if (options.deepThinking !== null) {
		opts.deepThinking = options.deepThinking;
	}
	return `(() => {
${SEND_MESSAGE_SOURCE}
sendMessageToDeepSeek(${JSON.stringify(prompt)}, ${JSON.stringify(opts)});
return true;
})()`;
}

/**
 * Map a model id to the web UI's radio model + Deep Thinking toggle state.
 * `deepThinking` is `null` when the toggle should be left untouched (vision).
 */
export function resolveV2ModelOptions(modelId: string): {
	modelType: string;
	deepThinking: boolean | null;
} {
	const m = modelId.toLowerCase();
	if (m.includes("vision")) return { modelType: "vision", deepThinking: null };
	const { modelType, thinkingEnabled } = resolveModelOptions(modelId);
	return { modelType, deepThinking: thinkingEnabled };
}
