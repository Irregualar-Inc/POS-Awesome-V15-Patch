frappe.ui.form.on("Employee", {
	refresh(frm) {
		if (frm.is_new()) {
			return;
		}

		const can_manage_codes =
			frappe.user.has_role(["System Manager", "POSA Manager"]) && frappe.session.user === frm.doc.user_id;
		if (!can_manage_codes) {
			return;
		}

		frm.add_custom_button(
			__("View POSA Authorization Code"),
			() => {
				frappe.call({
					method: "posawesome.posawesome.api.authorization_codes.generate_employee_authorization_code",
					args: {
						employee: frm.doc.name,
					},
					freeze: true,
					freeze_message: __("Loading today's authorization code..."),
					callback: function (r) {
						if (!r?.message?.code) {
							return;
						}

						frappe.msgprint({
							title: __("Today's POSA Authorization Code"),
							message: __("Code: <b>{0}</b><br>Valid Until End of Day: {1}", [
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
