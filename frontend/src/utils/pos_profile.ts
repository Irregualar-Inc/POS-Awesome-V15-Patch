import {
	getOpeningStorage,
	setOpeningStorage,
	setPrintTemplate,
	setTermsAndConditions,
} from "../offline/index";

declare const frappe: any;

async function cachePrintTemplateAndTerms(profile: any) {
	if (!profile || typeof frappe === "undefined" || !navigator.onLine) return;

	// Fetch the configured Print Format's raw HTML/Jinja so the offline
	// renderer at offline_print_template.ts can use the real template instead
	// of falling back to the hardcoded 80mm thermal receipt.
	try {
		const printFormatName =
			profile.print_format_for_online || profile.print_format;
		if (printFormatName) {
			const pf = await frappe.call({
				method: "frappe.client.get_value",
				args: {
					doctype: "Print Format",
					fieldname: ["html", "print_format_type"],
					filters: { name: printFormatName },
				},
			});
			const html = pf?.message?.html;
			if (typeof html === "string" && html.trim()) {
				setPrintTemplate(html);
			}
		}
	} catch (e) {
		console.error("Failed to fetch print format template", e);
	}

	try {
		const termsName = profile.tc_name || profile.terms_and_conditions;
		if (termsName) {
			const tc = await frappe.call({
				method: "frappe.client.get_value",
				args: {
					doctype: "Terms and Conditions",
					fieldname: "terms",
					filters: { name: termsName },
				},
			});
			if (tc.message && tc.message.terms) {
				setTermsAndConditions(tc.message.terms);
			}
		}
	} catch (e) {
		console.error("Failed to fetch terms and conditions", e);
	}
}

function hasProfileChanged(currentProfile: any, nextProfile: any) {
	if (!nextProfile) return false;
	if (!currentProfile) return true;
	if (currentProfile.name !== nextProfile.name) return true;
	if (currentProfile.modified && nextProfile.modified) {
		return currentProfile.modified !== nextProfile.modified;
	}
	return false;
}

function updateOpeningStorageProfile(profile: any) {
	const cached = getOpeningStorage() as any;
	if (cached?.pos_profile) {
		setOpeningStorage({ ...cached, pos_profile: profile });
	}
}

export async function ensurePosProfile() {
	const bootProfile = frappe?.boot?.pos_profile;
	if (
		bootProfile &&
		bootProfile.warehouse &&
		bootProfile.selling_price_list
	) {
		await cachePrintTemplateAndTerms(bootProfile);
		if (navigator.onLine) {
			try {
				const res = await frappe.call({
					method: "posawesome.posawesome.api.utils.get_active_pos_profile",
					args: { user: frappe.session.user },
				});
				if (
					res.message &&
					hasProfileChanged(bootProfile, res.message)
				) {
					frappe.boot.pos_profile = res.message;
					updateOpeningStorageProfile(res.message);
					await cachePrintTemplateAndTerms(res.message);
					return res.message;
				}
			} catch (e) {
				console.error("Failed to refresh active POS profile", e);
			}
		}
		return bootProfile;
	}
	try {
		const res = await frappe.call({
			method: "posawesome.posawesome.api.utils.get_active_pos_profile",
			args: { user: frappe.session.user },
		});
		if (res.message) {
			frappe.boot.pos_profile = res.message;
			updateOpeningStorageProfile(res.message);
			await cachePrintTemplateAndTerms(res.message);
			return res.message;
		}
	} catch (e) {
		console.error("Failed to fetch active POS profile", e);
	}
	const cached = getOpeningStorage() as any;
	if (cached && cached.pos_profile) {
		await cachePrintTemplateAndTerms(cached.pos_profile);
		return cached.pos_profile;
	}
	await cachePrintTemplateAndTerms(bootProfile);
	return bootProfile || null;
}
