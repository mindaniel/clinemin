import { resolveModelOptions } from "../deepseek-web";

// ── Page-side send script (transcribed from sendmessage.js) ──────────────────

/**
 * The same UI-driving code as the reference `sendmessage.js` (functions only —
 * the trailing demo calls are omitted). Evaluated inside chat.deepseek.com via
 * `page.evaluate`. Selectors intentionally mirror the working reference.
 */
const SEND_MESSAGE_SOURCE = `
function toggleDeepThinking(enable) {
    // The current chat.deepseek.com UI exposes a single "Deep thinking"
    // toggle button instead of the old model radiogroup. Find it either by
    // the label span or by the toggle-button classes / aria-pressed state.
    var toggle = null;
    var buttons = document.querySelectorAll('.ds-toggle-button');
    for (var i = 0; i < buttons.length; i++) {
        var label = buttons[i].querySelector('._6dbc175, .ds-toggle-button__label');
        var text = label ? label.textContent.trim().toLowerCase()
                         : (buttons[i].textContent || '').trim().toLowerCase();
        if (text.indexOf('deep thinking') !== -1 || text.indexOf('deepthink') !== -1) {
            toggle = buttons[i];
            break;
        }
    }
    if (!toggle) {
        console.warn('Deep thinking toggle not found');
        return false;
    }
    var isSelected = function () {
        return toggle.classList.contains('ds-toggle-button--selected')
               || toggle.getAttribute('aria-pressed') === 'true';
    };
    if (enable !== isSelected()) {
        toggle.click();
        console.log('Deep thinking ' + (enable ? 'ENABLED' : 'DISABLED'));
    } else {
        console.log('Deep thinking already ' + (enable ? 'ENABLED' : 'DISABLED'));
    }
    // Report whether the toggle now matches the request. A click that did not
    // commit (React not listening yet) leaves this false so the caller retries.
    return enable === isSelected();
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
    var deepThinking = options.deepThinking !== undefined ? options.deepThinking : null;
    var textarea = null;
    var textareas = document.querySelectorAll('textarea');
    for (var ti = 0; ti < textareas.length; ti++) {
        var candidate = textareas[ti];
        if (candidate.getAttribute('placeholder')) {
            textarea = candidate;
            break;
        }
    }
    if (!textarea && textareas.length > 0) textarea = textareas[0];
    if (!textarea) {
        console.error('Textarea not found');
        return false;
    }

    // Type first, then set the Deep Thinking toggle right before sending, then
    // submit. The toggle is applied last (and verified) because chat.deepseek.com
    // can re-render the model controls between typing and submit, which would
    // silently revert an earlier click. Mirrors the reference sendmessage.js
    // fire-and-forget contract — the caller verifies the outcome via the DOM.
    setTimeout(function () {
        var nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        nativeSetter.call(textarea, message);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        // Apply the toggle, then submit. Retries are spaced out because React
        // commits the toggle's aria-pressed asynchronously — clicking again
        // immediately would toggle it back off before the state settles.
        var submit = function () {
            var sendBtn = findSendButton();
            if (sendBtn) {
                sendBtn.click();
                console.log('Sent: "' + message + '"');
            } else {
                textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                console.log('Sent with Enter: "' + message + '"');
            }
        };
        var attemptToggle = function (remaining) {
            if (deepThinking === null) {
                submit();
                return;
            }
            if (toggleDeepThinking(deepThinking)) {
                // Let the toggle commit before the submit click.
                setTimeout(submit, 250);
                return;
            }
            if (remaining <= 0) {
                console.warn('Deep thinking toggle could not be set; sending anyway');
                submit();
                return;
            }
            setTimeout(function () { attemptToggle(remaining - 1); }, 200);
        };
        setTimeout(function () { attemptToggle(5); }, 300);
    }, 0);

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
	const opts: Record<string, unknown> = {};
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
 * Map a model id to the web UI's Deep Thinking toggle state. The current UI
 * has only two modes (Instant = off, Deep thinking = on), so `modelType` is
 * always `"default"` and `deepThinking` is never null.
 */
export function resolveV2ModelOptions(modelId: string): {
	modelType: string;
	deepThinking: boolean | null;
} {
	const { modelType, thinkingEnabled } = resolveModelOptions(modelId);
	// The radio-based model selector is gone; only the Deep Thinking toggle
	// distinguishes the two modes. `modelType` is kept in the return shape for
	// callers that still log/thread it, but is always "default" now.
	void modelType;
	return { modelType: "default", deepThinking: thinkingEnabled };
}