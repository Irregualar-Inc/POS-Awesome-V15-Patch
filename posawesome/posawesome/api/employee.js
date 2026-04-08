frappe.ui.form.on("Employee", {
	refresh(frm) {
		if (frm.is_new()) {
			return;
		}

		const can_manage_codes =
			frappe.user.has_role("System Manager") || frappe.user.has_role("POSA Manager");
		if (!can_manage_codes) {
			return;
		}

		frm.add_custom_button(
			__("Generate POSA Authorization Code"),
			() => {
				frappe.call({
					method: "posawesome.posawesome.api.authorization_codes.generate_employee_authorization_code",
					args: {
						employee: frm.doc.name,
					},
					freeze: true,
					freeze_message: __("Generating authorization code..."),
					callback: function (r) {
						if (!r.message || !r.message.code) {
							return;
						}

						frappe.msgprint({
							title: __("POSA Authorization Code Generated"),
							message: __("Code: <b>{0}</b><br>Expires At: {1}", [
								r.message.code,
								r.message.expires_on,
							]),
							indicator: "green",
						});
					},
				});
			},
			__("POS Awesome"),
		);
	},
});
