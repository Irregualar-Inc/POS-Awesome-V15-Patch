declare const __BUILD_VERSION__: string;
import { resolvePosAppNormalizedPath } from "./loader-utils";

const POSAPP_BASE_PATH = "/app/posapp";
const VERSION_ENDPOINT = "/assets/posawesome/dist/js/version.json";
const LOADER_RECOVERY_KEY = "posa_loader_chunk_recovery_once";
const RUNTIME_RECOVERY_KEY = "posa_runtime_recovery_done_v1";

const getBundlePath = (version: string) =>
	`/assets/posawesome/dist/js/posawesome.js?v=${encodeURIComponent(version)}`;

function recordPendingBundleActivation(version: string) {
	if (
		typeof window === "undefined" ||
		!window.sessionStorage ||
		!version
	) {
		return;
	}
	try {
		window.sessionStorage.setItem("posa_pending_bundle_activation", version);
	} catch {}
}

declare global {
	interface Window {
		__posawesomeBundlePromise?: Promise<unknown>;
	}
}

function normalizePosAppPath(): boolean {
	if (typeof window === "undefined" || !window.location) {
		return false;
	}

	const { pathname, search, hash } = window.location;
	const normalizedPath = resolvePosAppNormalizedPath(pathname, POSAPP_BASE_PATH);
	if (!normalizedPath) {
		return false;
	}

	window.location.replace(`${normalizedPath}${search || ""}${hash || ""}`);
	return true;
}

function isDynamicImportFailure(error: unknown): boolean {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: String(error || "");
	const normalized = message.toLowerCase();
	return (
		normalized.includes("failed to fetch dynamically imported module") ||
		normalized.includes("loading chunk") ||
		normalized.includes("chunkloaderror") ||
		normalized.includes("importing a module script failed")
	);
}

async function fetchLatestBuildVersion(): Promise<string | null> {
	try {
		const response = await fetch(`${VERSION_ENDPOINT}?t=${Date.now()}`, {
			cache: "no-store",
		});
		if (!response.ok) {
			return null;
		}
		const payload: any = await response.json();
		const version = payload?.version || payload?.buildVersion;
		return typeof version === "string" && version.trim().length
			? version.trim()
			: null;
	} catch {
		return null;
	}
}

function recoverByReloadingPosApp() {
	if (typeof window === "undefined") {
		return;
	}

	const storage = window.sessionStorage;
	if (!storage) {
		window.location.replace(`/app/posapp?_posa_loader_recovery=${Date.now()}`);
		return;
	}

	if (storage.getItem(LOADER_RECOVERY_KEY) === "1") {
		return;
	}

	storage.setItem(LOADER_RECOVERY_KEY, "1");
	window.location.replace(`/app/posapp?_posa_loader_recovery=${Date.now()}`);
}

async function importPosAwesomeBundle() {
	const initialVersion = __BUILD_VERSION__;
	try {
		return await import(/* @vite-ignore */ getBundlePath(initialVersion));
	} catch (firstError) {
		const latestVersion = await fetchLatestBuildVersion();
		if (latestVersion && latestVersion !== initialVersion) {
			try {
				const reloadedBundle = await import(
					/* @vite-ignore */
					getBundlePath(latestVersion)
				);
				recordPendingBundleActivation(latestVersion);
				return reloadedBundle;
			} catch (retryError) {
				if (isDynamicImportFailure(retryError)) {
					recoverByReloadingPosApp();
				}
				throw retryError;
			}
		}

		if (isDynamicImportFailure(firstError)) {
			recoverByReloadingPosApp();
		}
		throw firstError;
	}
}

async function clearClientRuntimeState() {
	if (typeof window === "undefined") {
		return;
	}

	try {
		window.localStorage?.removeItem("posawesome_version");
		window.localStorage?.removeItem("posawesome_update_dismissed");
		window.localStorage?.removeItem("posawesome_update_last_check");
		window.sessionStorage?.removeItem("posawesome_update_snooze_until");
		window.sessionStorage?.removeItem("posa_pending_bundle_activation");
		window.sessionStorage?.removeItem("posa_loader_chunk_recovery_once");
		window.sessionStorage?.removeItem("posa_chunk_reload_once");
		window.sessionStorage?.removeItem("posa_chunk_cache_recovery_once");
		window.sessionStorage?.removeItem("posa_chunk_recovery_in_progress");
	} catch {}

	try {
		if (
			typeof navigator !== "undefined" &&
			"serviceWorker" in navigator &&
			typeof navigator.serviceWorker.getRegistrations === "function"
		) {
			const registrations =
				await navigator.serviceWorker.getRegistrations();
			await Promise.all(
				registrations.map((registration) => registration.unregister()),
			);
		}
	} catch {}

	try {
		if (typeof caches !== "undefined") {
			const keys = await caches.keys();
			await Promise.all(keys.map((key) => caches.delete(key)));
		}
	} catch {}
}

async function maybeRunOneTimeRuntimeRecovery(): Promise<boolean> {
	if (typeof window === "undefined" || !window.location) {
		return false;
	}

	const path = window.location.pathname || "";
	if (!path.includes(POSAPP_BASE_PATH)) {
		return false;
	}

	const params = new URLSearchParams(window.location.search || "");
	if (params.has("_posa_runtime_recovered")) {
		try {
			window.sessionStorage?.setItem(RUNTIME_RECOVERY_KEY, "1");
		} catch {}
		return false;
	}

	let alreadyRecovered = false;
	try {
		alreadyRecovered =
			window.sessionStorage?.getItem(RUNTIME_RECOVERY_KEY) === "1";
	} catch {}

	if (alreadyRecovered) {
		return false;
	}

	await clearClientRuntimeState();
	try {
		window.sessionStorage?.setItem(RUNTIME_RECOVERY_KEY, "1");
	} catch {}

	window.location.replace(
		`${POSAPP_BASE_PATH}?_posa_runtime_recovered=${Date.now()}`,
	);
	return true;
}

if (typeof window !== "undefined" && !normalizePosAppPath()) {
	window.__posawesomeBundlePromise = (async () => {
		const recovered = await maybeRunOneTimeRuntimeRecovery();
		if (recovered) {
			return null;
		}
		return importPosAwesomeBundle();
	})().catch((error) => {
		console.error("POS Awesome bundle failed to load", error);
		throw error;
	});
}
