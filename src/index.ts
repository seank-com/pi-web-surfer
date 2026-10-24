import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWebSurferSession, registerWebSurferTools, getStateForCtx, type SessionState } from "./tools.ts";

/**
 * Pi extension entry point for pi-web-surfer.
 *
 * Registers web_fetch and web_search during initialization; loads project
 * configuration and initializes session resources at session_start; no
 * network requests occur at load or session start. Works without a terminal
 * UI. See docs/design.md for the full contract.
 */
export function createWebSurferExtension(): (pi: ExtensionAPI) => void {
	return (pi) => {
		const piState: { current?: SessionState } = {};
		registerWebSurferTools(pi, (ctx) => getStateForCtx(piState, ctx));
		registerWebSurferSession(pi, piState);
	};
}

export default createWebSurferExtension();
