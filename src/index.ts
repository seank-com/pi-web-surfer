import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Pi extension entry point. Browser tools are registered on `pi` here. */
export function createWebSurferExtension(): (pi: ExtensionAPI) => void {
	return (_pi) => {};
}

export default createWebSurferExtension();
