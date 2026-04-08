import frappe


POSA_MANAGER_ROLE = "POSA Manager"


def ensure_posa_manager_role():
    if frappe.db.exists("Role", POSA_MANAGER_ROLE):
        return

    role = frappe.new_doc("Role")
    role.role_name = POSA_MANAGER_ROLE
    role.desk_access = 1
    role.insert(ignore_permissions=True)


def after_install():
    ensure_posa_manager_role()
