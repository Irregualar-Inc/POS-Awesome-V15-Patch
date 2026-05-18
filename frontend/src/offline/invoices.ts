import { memory, persist, isOffline } from "./db";
import { syncOfflineCustomers } from "./customers";
import { updateLocalStock } from "./stock";
import { reduceCacheUsage } from "./cache";

type AnyRecord = Record<string, any>;

const asBoolean = (value: any): boolean => {
	return (
		value === true ||
		value === 1 ||
		value === "1" ||
		value === "true" ||
		value === "Yes" ||
		value === "yes"
	);
};

// Flag to avoid concurrent invoice syncs which can cause duplicate submissions
let invoiceSyncInProgress = false;

// Network-error detection so we can keep the offline entry for retry instead
// of silently downgrading the invoice to Draft (which loses payment context).
function isNetworkError(error: any): boolean {
	if (!error) return false;
	if (error instanceof TypeError) return true;
	if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
	const status = error?.statusCode ?? error?.status ?? error?.xhr?.status;
	if (status === 0 || status === 502 || status === 503 || status === 504) return true;
	const msg = String(error?.message || error?.statusText || error || "").toLowerCase();
	return (
		msg.includes("networkerror") ||
		msg.includes("network error") ||
		msg.includes("failed to fetch") ||
		msg.includes("timeout") ||
		msg.includes("timed out") ||
		msg.includes("connection") ||
		msg.includes("offline")
	);
}

// Sidecar log of invoices that fell through to the Draft fallback. The original
// {invoice, data, error} payload is retained so an operator can manually
// re-apply credit/write-off/cashback info after the sync window.
export function appendSyncRecoveryLog(entry: AnyRecord) {
	const log = Array.isArray(memory.posa_sync_recovery_log)
		? memory.posa_sync_recovery_log
		: [];
	try {
		log.push(JSON.parse(JSON.stringify(entry)));
	} catch (e) {
		log.push({ error: "failed-to-serialize", note: String(e) });
	}
	memory.posa_sync_recovery_log = log;
	persist("posa_sync_recovery_log");
}

export function getSyncRecoveryLog() {
	return Array.isArray(memory.posa_sync_recovery_log)
		? memory.posa_sync_recovery_log
		: [];
}

export function clearSyncRecoveryLog() {
	memory.posa_sync_recovery_log = [];
	persist("posa_sync_recovery_log");
}

// Validate stock for offline invoice
export function validateStockForOfflineInvoice(items: AnyRecord[]) {
	const openingStorage = memory.pos_opening_storage || {};
	const stockSettings = openingStorage?.stock_settings || {};
	const posProfile = openingStorage?.pos_profile || {};

	const allowNegativeStock = asBoolean(stockSettings?.allow_negative_stock);
	if (allowNegativeStock) {
		return { isValid: true, invalidItems: [], errorMessage: "" };
	}

	const blockSaleBeyondAvailableQty = asBoolean(
		posProfile?.posa_block_sale_beyond_available_qty,
	);

	const stockCache = memory.local_stock_cache || {};
	const invalidItems: AnyRecord[] = [];

	items.forEach((item) => {
		if (asBoolean(item?.allow_negative_stock)) {
			return;
		}

		const itemCode = item.item_code;
		const requestedQty = Math.abs(item.qty || 0);
		const currentStock = stockCache[itemCode]?.actual_qty || 0;

		if (!blockSaleBeyondAvailableQty) {
			return;
		}

		if (currentStock - requestedQty < 0) {
			invalidItems.push({
				item_code: itemCode,
				item_name: item.item_name || itemCode,
				requested_qty: requestedQty,
				available_qty: currentStock,
			});
		}
	});

	// Create clean error message
	let errorMessage = "";
	if (invalidItems.length === 1) {
		const item = invalidItems[0];
		if (item) {
			errorMessage = `Not enough stock for ${item.item_name}. You need ${item.requested_qty} but only ${item.available_qty} available.`;
		}
	} else if (invalidItems.length > 1) {
		errorMessage =
			"Insufficient stock for multiple items:\n" +
			invalidItems
				.map(
					(item) =>
						`• ${item.item_name}: Need ${item.requested_qty}, Have ${item.available_qty}`,
				)
				.join("\n");
	}

	return {
		isValid: invalidItems.length === 0,
		invalidItems: invalidItems,
		errorMessage: errorMessage,
	};
}

export function saveOfflineInvoice(entry: AnyRecord) {
	// Validate that invoice has items before saving
	if (
		!entry.invoice ||
		!Array.isArray(entry.invoice.items) ||
		!entry.invoice.items.length
	) {
		throw new Error("Cart is empty. Add items before saving.");
	}

	const validation = validateStockForOfflineInvoice(entry.invoice.items);
	if (!validation.isValid) {
		throw new Error(validation.errorMessage);
	}

	const key = "offline_invoices";
	const entries = memory.offline_invoices;
	// Clone the entry before storing to strip Vue reactivity
	// and other non-serializable properties. IndexedDB only
	// supports structured cloneable data, so reactive proxies
	// cause a DataCloneError without this step.
	let cleanEntry;
	try {
		cleanEntry = JSON.parse(JSON.stringify(entry));
	} catch (e) {
		console.error("Failed to serialize offline invoice", e);
		throw e;
	}

	entries.push(cleanEntry);
	memory.offline_invoices = entries;
	persist(key);

	// Update local stock quantities
	if (entry.invoice && entry.invoice.items) {
		updateLocalStock(entry.invoice.items);
	}
}

export function getOfflineInvoices() {
	return memory.offline_invoices;
}

export function clearOfflineInvoices() {
	memory.offline_invoices = [];
	persist("offline_invoices");
}

export function deleteOfflineInvoice(index: number) {
	if (
		Array.isArray(memory.offline_invoices) &&
		index >= 0 &&
		index < memory.offline_invoices.length
	) {
		memory.offline_invoices.splice(index, 1);
		persist("offline_invoices");
	}
}

export function getPendingOfflineInvoiceCount() {
	return memory.offline_invoices.length;
}

// Reset cached invoices and customers after syncing
// but preserve the stock cache so offline validation
// still has access to the last known quantities
export function resetOfflineState() {
	memory.offline_invoices = [];
	memory.offline_customers = [];
	memory.offline_payments = [];
	memory.pos_last_sync_totals = { pending: 0, synced: 0, drafted: 0 };

	persist("offline_invoices");
	persist("offline_customers");
	persist("offline_payments");
	persist("pos_last_sync_totals");
}

export function setLastSyncTotals(totals: {
	pending: number;
	synced: number;
	drafted: number;
}) {
	memory.pos_last_sync_totals = totals;
	persist("pos_last_sync_totals");
}

export function getLastSyncTotals() {
	return memory.pos_last_sync_totals || { pending: 0, synced: 0, drafted: 0 };
}

// Add sync function to clear local cache when invoices are successfully synced
export async function syncOfflineInvoices() {
	// Prevent concurrent syncs which can lead to duplicate submissions
	if (invoiceSyncInProgress) {
		return {
			pending: getPendingOfflineInvoiceCount(),
			synced: 0,
			drafted: 0,
		};
	}
	invoiceSyncInProgress = true;
	try {
		// Ensure any offline customers are synced first so that invoices
		// referencing them do not fail during submission
		await syncOfflineCustomers();

		const invoices = getOfflineInvoices();
		if (!invoices.length) {
			// No invoices to sync; clear last totals to avoid repeated messages
			const totals = { pending: 0, synced: 0, drafted: 0 };
			setLastSyncTotals(totals);
			return totals;
		}
		if (isOffline()) {
			// When offline just return the pending count without attempting a sync
			return { pending: invoices.length, synced: 0, drafted: 0 };
		}

		const failures: AnyRecord[] = [];
		let synced = 0;
		let drafted = 0;

		for (const inv of invoices) {
			try {
				await frappe.call({
					method: "posawesome.posawesome.api.invoices.submit_invoice",
					args: {
						invoice: inv.invoice,
						data: inv.data,
					},
				});
				synced++;
			} catch (error) {
				// Network/transport errors are retryable. Keep the entry in
				// the queue (with its full {invoice, data}) so payment context
				// survives until the next sync attempt.
				if (isNetworkError(error)) {
					console.warn(
						"Network error during invoice sync, will retry next cycle",
						error,
					);
					failures.push(inv);
					continue;
				}

				// Permanent (validation) error: fall back to Draft so the
				// invoice still lands on the server, but merge inv.data into
				// the payload so payments/credit/write-off info isn't dropped.
				console.error(
					"Submit failed (non-network); saving as Draft with merged payload",
					error,
				);
				try {
					const mergedPayload = {
						...(inv.invoice || {}),
						...(inv.data || {}),
					};
					await frappe.call({
						method: "posawesome.posawesome.api.invoices.update_invoice",
						args: { data: JSON.stringify(mergedPayload) },
					});
					drafted += 1;
					// Retain the original payload + error for manual recovery,
					// since update_invoice doesn't apply credit-redemption /
					// write-off / cashback the way submit_invoice does.
					appendSyncRecoveryLog({
						timestamp: new Date().toISOString(),
						reason: "submit_failed_drafted",
						error: String((error as any)?.message || error),
						invoice: inv.invoice,
						data: inv.data,
					});
				} catch (draftErr) {
					console.error("Failed to save invoice as draft", draftErr);
					failures.push(inv);
					appendSyncRecoveryLog({
						timestamp: new Date().toISOString(),
						reason: "submit_and_draft_failed",
						submit_error: String((error as any)?.message || error),
						draft_error: String(
							(draftErr as any)?.message || draftErr,
						),
						invoice: inv.invoice,
						data: inv.data,
					});
				}
			}
		}

		// Only reset the full offline state (customers, payments, totals) when
		// every invoice synced cleanly. Otherwise the customer/payment context
		// for still-pending entries would be wiped.
		if (synced > 0 && failures.length === 0 && drafted === 0) {
			resetOfflineState();
		}

		const pendingLeft = failures.length;

		if (pendingLeft) {
			memory.offline_invoices = failures;
			persist("offline_invoices");
		} else {
			clearOfflineInvoices();
			if (synced > 0 && drafted === 0) {
				reduceCacheUsage();
			}
		}

		const totals = { pending: pendingLeft, synced, drafted };
		if (pendingLeft || drafted) {
			// Persist totals only if there are invoices still pending or drafted
			setLastSyncTotals(totals);
		} else {
			// Clear totals so success message only shows once
			setLastSyncTotals({ pending: 0, synced: 0, drafted: 0 });
		}
		return totals;
	} finally {
		invoiceSyncInProgress = false;
	}
}
