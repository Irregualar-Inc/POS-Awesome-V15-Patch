import { useItemAddition } from "../../../composables/pos/items/useItemAddition";
import { get_invoice_doc, get_invoice_items, get_payments } from "./document";
import { _logPriceListDebug, _buildPriceListSnapshot } from "./currency";
import { applyReturnDiscountProration } from "./item_updates";

declare const __: (_text: string, _args?: any[]) => string;
declare const frappe: any;

/**
 * Action Utils
 * Handles high-level invoice actions like adding, removing items, saving, and canceling.
 *
 * Context requirements:
 * - context.schedulePricingRuleApplication (method)
 * - context.customer
 * - context.customer_info
 * - context.pos_profile
 * - context.get_price_list (method)
 * - context.selected_price_list
 * - context.invoice_doc
 * - context.eventBus
 * - context.toastStore
 * - context.float_precision
 * - context.get_invoice_doc (proxy to document.js)
 * - context.invoiceType (setter)
 * - context.invoiceTypes (setter)
 * - context.posting_date (setter)
 * - context.clear_invoice (method/proxy)
 * - context.customersStore
 * - context.cancel_dialog (setter)
 * - context.update_invoice (method)
 * - context.items
 * - context.posa_offers
 * - context.posa_coupons
 * - context.return_doc
 * - context.discount_amount
 * - context.additional_discount_percentage
 * - context._normalizeReturnDocTotals (method)
 * - context.makeid (method)
 * - context.set_batch_qty (method)
 * - context.formatDateForBackend (method)
 * - context.update_items_details (method)
 */

let itemAdditionApi: ReturnType<typeof useItemAddition> | null = null;
const FIVE_DIGIT_CODE_REGEX = /^\d{5}$/;

function parseBooleanSetting(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value === 1;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		return (
			normalized === "1" || normalized === "true" || normalized === "yes"
		);
	}
	return false;
}

function showRemovalAuthError(context: any, message: string) {
	if (context?.toastStore?.show) {
		context.toastStore.show({
			title: __("Authorization required"),
			text: message,
			color: "error",
		});
		return;
	}

	frappe.msgprint({
		title: __("Authorization required"),
		message,
		indicator: "red",
	});
}

function elevateDialogAbovePaymentUI(dialog: any) {
	const wrapper = dialog?.$wrapper;
	if (!wrapper?.css) {
		return;
	}

	// Keep Frappe dialogs above Vuetify overlays used by payment screens.
	wrapper.css("z-index", 3000);

	const backdrop = wrapper.prev?.(".modal-backdrop");
	if (backdrop?.css) {
		backdrop.css("z-index", 2990);
	}
}

function toRemovalNumber(value: any): number {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : 0;
}

function buildRemovalAuditContext(context: any, item: any, removalReason = "") {
	const invoiceDoc = get_invoice_doc(context) || {};
	const invoiceItems = get_invoice_items(context) || [];

	return {
		pos_profile:
			context?.pos_profile?.name || invoiceDoc?.pos_profile || "",
		invoice_name: invoiceDoc?.name || "",
		company: invoiceDoc?.company || context?.company?.name || "",
		warehouse: invoiceDoc?.set_warehouse || item?.warehouse || "",
		customer: invoiceDoc?.customer || context?.customer || "",
		currency: invoiceDoc?.currency || context?.pos_profile?.currency || "",
		removal_reason: String(removalReason || "").trim(),
		remover_employee: context?.pos_opening_shift?.employee || "",
		removed_item: {
			item_code: item?.item_code || "",
			item_name: item?.item_name || "",
			qty: toRemovalNumber(item?.qty),
			rate: toRemovalNumber(item?.rate),
			amount: toRemovalNumber(item?.amount),
		},
		items_state: invoiceItems.map((line: any) => ({
			item_code: line?.item_code || "",
			item_name: line?.item_name || "",
			qty: toRemovalNumber(line?.qty),
			rate: toRemovalNumber(line?.rate),
			amount: toRemovalNumber(line?.amount),
		})),
	};
}

function validateAndUseCodeFromServer(code: string): Promise<any> {
	return new Promise((resolve) => {
		frappe.call({
			method: "posawesome.posawesome.api.authorization_codes.validate_and_use_authorization_code",
			args: { code },
			callback: (r: any) => {
				resolve(
					r?.message || {
						valid: false,
						message: __("Authorization failed."),
					},
				);
			},
			error: () => {
				resolve({
					valid: false,
					message: __("Unable to validate authorization code."),
				});
			},
		});
	});
}

function logAuthorizedRemovalFromServer(
	authorizationRecord: string,
	removalContext: any,
): Promise<any> {
	return new Promise((resolve) => {
		frappe.call({
			method: "posawesome.posawesome.api.authorization_codes.log_authorized_item_removal",
			args: {
				authorization_record: authorizationRecord,
				removal_context: JSON.stringify(removalContext || {}),
			},
			callback: (r: any) => {
				resolve(
					r?.message || {
						success: false,
						message: __("Unable to create removal log."),
					},
				);
			},
			error: () => {
				resolve({
					success: false,
					message: __("Unable to create removal log."),
				});
			},
		});
	});
}

function requestRemovalAuthorization(context: any, item: any): Promise<any> {
	return new Promise((resolve) => {
		const itemLabel = item?.item_name || item?.item_code || __("this item");
		let confirmed = false;

		const dialog = new frappe.ui.Dialog({
			title: __("Authorization required"),
			fields: [
				{
					fieldtype: "HTML",
					fieldname: "authorization_help",
					options: `<div class="text-muted">${__(
						"Removing {0} requires a 5-digit authorization code.",
						[itemLabel],
					)}</div>`,
				},
				{
					fieldtype: "Data",
					fieldname: "authorization_code",
					label: __("Authorization Code"),
					reqd: 1,
					description: __("Enter a 5-digit code to continue."),
				},
				{
					fieldtype: "Small Text",
					fieldname: "removal_reason",
					label: __("Removal Reason"),
					description: __("Optional reason for removing this item."),
				},
			],
			primary_action_label: __("Confirm"),
			primary_action: async (values: {
				authorization_code?: string;
				removal_reason?: string;
			}) => {
				const code = String(values?.authorization_code || "").trim();
				const removalReason = String(
					values?.removal_reason || "",
				).trim();
				const removalContext = buildRemovalAuditContext(
					context,
					item,
					removalReason,
				);

				if (!FIVE_DIGIT_CODE_REGEX.test(code)) {
					showRemovalAuthError(
						context,
						__("Enter a valid 5-digit authorization code."),
					);
					return;
				}

				const validationResult =
					await validateAndUseCodeFromServer(code);
				if (!validationResult?.valid) {
					showRemovalAuthError(
						context,
						validationResult?.message ||
							__("Authorization code validation failed."),
					);
					return;
				}

				confirmed = true;
				resolve({
					authorized: true,
					authorizationRecord: validationResult?.record,
					removalContext,
				});
				dialog.hide();
			},
		});

		dialog.onhide = () => {
			if (!confirmed) {
				resolve({ authorized: false });
			}
		};
		dialog.show();
		elevateDialogAbovePaymentUI(dialog);
		dialog.get_field("authorization_code")?.$input?.attr?.({
			inputmode: "numeric",
			maxlength: 5,
			autocomplete: "off",
		});
		dialog.get_field("authorization_code")?.$input?.focus?.();
	});
}

function requestCancelSaleAuthorization(context: any): Promise<any> {
	return new Promise((resolve) => {
		let confirmed = false;

		const dialog = new frappe.ui.Dialog({
			title: __("Authorization required"),
			fields: [
				{
					fieldtype: "HTML",
					fieldname: "authorization_help",
					options: `<div class="text-muted">${__(
						"Canceling this sale requires a 5-digit authorization code.",
					)}</div>`,
				},
				{
					fieldtype: "Data",
					fieldname: "authorization_code",
					label: __("Authorization Code"),
					reqd: 1,
					description: __("Enter a 5-digit code to continue."),
				},
			],
			primary_action_label: __("Confirm"),
			primary_action: async (values: { authorization_code?: string }) => {
				const code = String(values?.authorization_code || "").trim();

				if (!FIVE_DIGIT_CODE_REGEX.test(code)) {
					showRemovalAuthError(
						context,
						__("Enter a valid 5-digit authorization code."),
					);
					return;
				}

				const validationResult =
					await validateAndUseCodeFromServer(code);
				if (!validationResult?.valid) {
					showRemovalAuthError(
						context,
						validationResult?.message ||
							__("Authorization code validation failed."),
					);
					return;
				}

				confirmed = true;
				resolve({
					authorized: true,
					authorizationRecord: validationResult?.record,
				});
				dialog.hide();
			},
		});

		dialog.onhide = () => {
			if (!confirmed) {
				resolve({ authorized: false });
			}
		};
		dialog.show();
		elevateDialogAbovePaymentUI(dialog);
		dialog.get_field("authorization_code")?.$input?.attr?.({
			inputmode: "numeric",
			maxlength: 5,
			autocomplete: "off",
		});
		dialog.get_field("authorization_code")?.$input?.focus?.();
	});
}

export async function authorizeCancelSaleIfRequired(
	context: any,
	options: any = {},
): Promise<boolean> {
	if (options?.skipAuthorizationPrompt) {
		return true;
	}

	if (
		parseBooleanSetting(
			context?.pos_profile?.posa_allow_user_remove_item_from_pos_till,
		)
	) {
		return true;
	}

	let authorizationResult: any = { authorized: false };
	const providedCode = String(options?.authorization_code || "").trim();

	if (providedCode) {
		if (!FIVE_DIGIT_CODE_REGEX.test(providedCode)) {
			showRemovalAuthError(
				context,
				__("Enter a valid 5-digit authorization code."),
			);
			return false;
		}

		const validationResult =
			await validateAndUseCodeFromServer(providedCode);
		if (!validationResult?.valid) {
			showRemovalAuthError(
				context,
				validationResult?.message ||
					__("Authorization code validation failed."),
			);
			return false;
		}

		authorizationResult = {
			authorized: true,
			authorizationRecord: validationResult?.record,
		};
	} else {
		authorizationResult = await requestCancelSaleAuthorization(context);
	}

	return Boolean(authorizationResult?.authorized);
}

async function shouldAuthorizeRemoval(
	context: any,
	item: any,
	options: any = {},
) {
	if (options?.skipAuthorizationPrompt) return { authorized: true };
	if (
		parseBooleanSetting(
			context?.pos_profile?.posa_allow_user_remove_item_from_pos_till,
		)
	) {
		return { authorized: true };
	}

	return requestRemovalAuthorization(context, item);
}

function getItemAdditionApi() {
	if (!itemAdditionApi) {
		itemAdditionApi = useItemAddition();
	}
	return itemAdditionApi;
}

export async function remove_item(context: any, item: any, options: any = {}) {
	const authorizationResult = await shouldAuthorizeRemoval(
		context,
		item,
		options,
	);
	if (!authorizationResult?.authorized) {
		return false;
	}

	const matchItem = (line: any) =>
		line === item ||
		(line?.posa_row_id &&
			item?.posa_row_id &&
			String(line.posa_row_id) === String(item.posa_row_id)) ||
		(line?.item_code === item?.item_code &&
			(line?.name === item?.name || line?.item_name === item?.item_name));

	const removeFromContextItems = () => {
		const items = Array.isArray(context?.items) ? context.items : [];
		const idx = items.findIndex((line: any) => matchItem(line));
		if (idx < 0) return false;

		if (
			context?.invoiceStore &&
			typeof context.invoiceStore.setItems === "function"
		) {
			const next = [...items];
			next.splice(idx, 1);
			context.invoiceStore.setItems(next);
			return true;
		}

		items.splice(idx, 1);
		return true;
	};

	// Remove immediately from live list to avoid UI stale rows.
	removeFromContextItems();

	const { removeItem } = getItemAdditionApi();
	removeItem(item, context);
	// Fallback: attempt once more if a stale row still exists.
	removeFromContextItems();

	if (authorizationResult?.authorizationRecord) {
		const logResult = await logAuthorizedRemovalFromServer(
			authorizationResult.authorizationRecord,
			authorizationResult.removalContext,
		);

		if (!logResult?.success) {
			showRemovalAuthError(
				context,
				logResult?.message ||
					__("Removal completed, but audit log creation failed."),
			);
		}
	}

	if (context.schedulePricingRuleApplication) {
		context.schedulePricingRuleApplication();
	}
	applyReturnDiscountProration(context);
	return true;
}

export async function add_item(context: any, item: any, options: any = {}) {
	const { addItem } = getItemAdditionApi();
	// Build price context for debug
	const priceContext = {
		customer: context.customer,
		customer_price_list: context.customer_info?.customer_price_list || null,
		pos_profile_price_list: context.pos_profile?.selling_price_list || null,
		effective_price_list: context.get_price_list
			? context.get_price_list()
			: null,
		selected_price_list: context.selected_price_list || null,
		invoice_selling_price_list:
			context.invoice_doc?.selling_price_list || null,
		item_before: _buildPriceListSnapshot(context, [item]),
	};

	const res = await addItem(item, context);

	if (context.schedulePricingRuleApplication) {
		context.schedulePricingRuleApplication();
	}
	applyReturnDiscountProration(context);

	// Log debug info
	_logPriceListDebug(context, "add_item", {
		...priceContext,
		item_after: _buildPriceListSnapshot(context, [item]),
	});

	const shouldNotify =
		options?.notifyOnSuccess === true &&
		!options?.skipNotification &&
		context.toastStore;

	if (shouldNotify) {
		const rawQty =
			typeof item?.qty === "number" ? item.qty : parseFloat(item?.qty);
		const shouldAnnounce = Number.isFinite(rawQty) ? rawQty > 0 : true;

		if (shouldAnnounce) {
			const addedQty = Number.isFinite(rawQty) ? Math.abs(rawQty) : 1;
			const rawPrecision = Number(context.float_precision);
			const precision = Number.isInteger(rawPrecision)
				? Math.min(Math.max(rawPrecision, 0), 6)
				: 2;
			const displayQty = Number.isInteger(addedQty)
				? addedQty
				: Number(addedQty.toFixed(precision));
			const itemName = item?.item_name || item?.item_code || __("Item");
			const detail = __("{0} (Qty: {1})", [itemName, displayQty]);

			context.toastStore.show({
				title: __("Item {0} added to invoice", [itemName]),
				summary: __("Items added to invoice"),
				detail,
				color: "success",
				groupId: "invoice-item-added",
			});
		}
	}

	return res;
}

export function get_new_item(context: any, item: any) {
	const { getNewItem } = getItemAdditionApi();
	return getNewItem(item, context);
}

export function clear_invoice(context: any, options: any = {}) {
	const { clearInvoice } = getItemAdditionApi();
	return clearInvoice(context, options);
}

export async function cancel_invoice(context: any, options: any = {}) {
	if (context) {
		context.cancel_dialog = false;
	}

	const canCancelInvoice = await authorizeCancelSaleIfRequired(
		context,
		options,
	);
	if (!canCancelInvoice) {
		return false;
	}

	const { clearInvoice } = getItemAdditionApi();
	// We can directly call get_invoice_doc from document.js if we pass context
	// Or assume context has the method proxied.
	// Since we are refactoring, let's call the util directly if possible, or rely on context.
	const doc = get_invoice_doc(context);

	context.posting_date = frappe.datetime.nowdate();

	if (doc.name && context.pos_profile.posa_allow_delete) {
		await frappe.call({
			method: "posawesome.posawesome.api.invoices.delete_invoice",
			args: { invoice: doc.name },
			async: true,
			callback: function (r) {
				if (r.message) {
					context.toastStore.show({
						text: r.message,
						color: "warning",
					});
				}
			},
		});
	}

	// Use the clear_invoice logic
	clearInvoice(context);

	context.customer = context.pos_profile?.customer || "";
	if (context.customersStore?.setSelectedCustomer) {
		context.customersStore.setSelectedCustomer(context.customer || null);
	}
	if (context.eventBus) {
		context.eventBus.emit("focus_item_search");
	}
	context.cancel_dialog = false;
}

export async function save_and_clear_invoice(context: any) {
	const { clearInvoice } = getItemAdditionApi();
	let old_invoice = null;
	const doc = get_invoice_doc(context);

	try {
		if (doc.name) {
			old_invoice = await context.update_invoice(doc);
		} else if (doc.items.length) {
			old_invoice = await context.update_invoice(doc);
		} else {
			context.toastStore.show({
				title: `Nothing to save`,
				color: "error",
			});
		}
	} catch (error) {
		console.error("Error saving and clearing invoice:", error);
	}

	if (!old_invoice) {
		context.toastStore.show({
			title: `Error saving the current invoice`,
			color: "error",
		});
	} else {
		clearInvoice(context);
		if (context.eventBus) {
			context.eventBus.emit("focus_item_search");
		}
		return old_invoice;
	}
}

export async function new_order(context: any, data: any = {}) {
	if (context.eventBus) context.eventBus.emit("set_customer_readonly", false);
	context.expanded = [];
	context.posa_offers = [];
	if (context.eventBus) context.eventBus.emit("set_pos_coupons", []);
	context.posa_coupons = [];
	context.return_doc = "";

	if (!data.name && !data.is_return) {
		context.items = [];
		context.customer = context.pos_profile.customer;
		context.invoice_doc = "";
		context.discount_amount = 0;
		context.additional_discount_percentage = 0;
		context.invoiceType = "Invoice";
		context.invoiceTypes = ["Invoice", "Order", "Quotation"];
	} else {
		if (data.is_return) {
			if (context._normalizeReturnDocTotals) {
				context._normalizeReturnDocTotals(data);
			}
			if (data.return_against) {
				if (context.eventBus)
					context.eventBus.emit("set_customer_readonly", true);
			} else {
				if (context.eventBus)
					context.eventBus.emit("set_customer_readonly", false);
			}
			context.invoiceType = "Return";
			context.invoiceTypes = ["Return"];
		}
		context.invoice_doc = data;
		context.posa_offers = data.posa_offers || [];
		context.items = data.items;

		context.items.forEach((item) => {
			if (!item.posa_row_id) {
				item.posa_row_id = context.makeid
					? context.makeid(20)
					: Math.random().toString(36).substr(2, 9);
			}
			if (item.batch_no) {
				if (context.set_batch_qty)
					context.set_batch_qty(item, item.batch_no);
			}
		});

		context.customer = data.customer;
		context.posting_date = context.formatDateForBackend
			? context.formatDateForBackend(
					data.posting_date || frappe.datetime.nowdate(),
				)
			: data.posting_date || new Date().toISOString().slice(0, 10);
		context.discount_amount = data.discount_amount;

		if (
			data.is_return &&
			context.pos_profile?.posa_use_percentage_discount
		) {
			context.additional_discount_percentage = -Math.abs(
				Number.parseFloat(data.additional_discount_percentage),
			);
		} else {
			context.additional_discount_percentage =
				data.additional_discount_percentage;
		}

		context.items.forEach((item) => {
			if (item.serial_no) {
				item.serial_no_selected = [];
				const serial_list = item.serial_no.split("\n");
				serial_list.forEach((element) => {
					if (element.length) {
						item.serial_no_selected.push(element);
					}
				});
				item.serial_no_selected_count = item.serial_no_selected.length;
			}
		});
	}
}

export async function get_invoice_from_order_doc(context: any) {
	let doc: any = {};
	if (context.invoice_doc.doctype == "Sales Order") {
		await frappe.call({
			method: "posawesome.posawesome.api.invoices.create_sales_invoice_from_order",
			args: {
				sales_order: context.invoice_doc.name,
			},
			callback: function (r) {
				if (r.message) {
					doc = r.message;
				}
			},
		});
	} else {
		doc = context.invoice_doc;
	}
	const items: any[] = [];
	const updatedItemsData: any[] = get_invoice_items(context);
	doc.items.forEach((item) => {
		const updatedData = updatedItemsData.find(
			(updatedItem) => updatedItem.item_code === item.item_code,
		);
		if (updatedData) {
			item.item_code = updatedData.item_code;
			item.posa_row_id = updatedData.posa_row_id;
			item.posa_offers = updatedData.posa_offers;
			item.posa_offer_applied = updatedData.posa_offer_applied;
			item.posa_is_offer = updatedData.posa_is_offer;
			item.posa_is_replace = updatedData.posa_is_replace;
			item.is_free_item = updatedData.is_free_item;
			item.qty = Number.parseFloat(updatedData.qty);
			item.rate = Number.parseFloat(updatedData.rate);
			item.uom = updatedData.uom;
			item.amount =
				Number.parseFloat(updatedData.qty) *
				Number.parseFloat(updatedData.rate);
			item.conversion_factor = updatedData.conversion_factor;
			item.serial_no = updatedData.serial_no;
			item.discount_percentage = Number.parseFloat(
				updatedData.discount_percentage,
			);
			item.discount_amount = Number.parseFloat(
				updatedData.discount_amount,
			);
			item.batch_no = updatedData.batch_no;
			item.posa_notes = updatedData.posa_notes;
			item.posa_delivery_date = context.formatDateForDisplay
				? context.formatDateForDisplay(updatedData.posa_delivery_date)
				: updatedData.posa_delivery_date;
			item.price_list_rate = updatedData.price_list_rate;
			items.push(item);
		}
	});

	doc.items = items;
	const newItems: any[] = [...doc.items];
	const existingItemCodes = new Set(newItems.map((item) => item.item_code));
	updatedItemsData.forEach((updatedItem) => {
		if (!existingItemCodes.has(updatedItem.item_code)) {
			newItems.push(updatedItem);
		}
	});
	doc.items = newItems;
	doc.update_stock = 1;
	doc.is_pos = 1;
	doc.payments = get_payments(context);
	return doc;
}
