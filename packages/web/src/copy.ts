/**
 * Clipboard helper for the chat view's copy buttons.
 *
 * navigator.clipboard requires a secure context; the pi web UI is commonly
 * served over plain HTTP on a LAN/tailnet address, so a hidden-textarea
 * execCommand fallback is kept for insecure origins.
 */

export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// Fall through to the legacy path.
	}
	try {
		const textarea = document.createElement("textarea");
		textarea.value = text;
		textarea.style.position = "fixed";
		textarea.style.opacity = "0";
		document.body.appendChild(textarea);
		textarea.select();
		const ok = document.execCommand("copy");
		textarea.remove();
		return ok;
	} catch {
		return false;
	}
}
