import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_field


FIELD_NAME = "posa_default_items_display"
CUSTOM_FIELD_NAME = f"POS Profile-{FIELD_NAME}"


def _upsert_custom_field():
    field = {
        "fieldname": FIELD_NAME,
        "label": "Default Items Display",
        "fieldtype": "Select",
        "options": "List\nCard",
        "default": "List",
        "description": "Default item display mode when opening POS Awesome.",
        "insert_after": "posa_default_card_view",
    }

    if not frappe.db.exists("Custom Field", CUSTOM_FIELD_NAME):
        create_custom_field("POS Profile", field)
        return

    updates = {k: v for k, v in field.items() if k != "insert_after"}
    frappe.db.set_value(
        "Custom Field",
        CUSTOM_FIELD_NAME,
        updates,
        update_modified=False,
    )
    frappe.db.set_value(
        "Custom Field",
        CUSTOM_FIELD_NAME,
        "insert_after",
        field["insert_after"],
        update_modified=False,
    )


def _migrate_existing_values():
    # Keep backward compatibility with legacy checkbox setting.
    profiles = frappe.get_all(
        "POS Profile",
        fields=["name", "posa_default_card_view", FIELD_NAME],
        limit_page_length=0,
    )
    for profile in profiles:
        current_value = (profile.get(FIELD_NAME) or "").strip() if profile.get(FIELD_NAME) else ""
        if current_value in {"List", "Card"}:
            continue

        migrated_value = "Card" if frappe.utils.cint(profile.get("posa_default_card_view")) else "List"
        frappe.db.set_value(
            "POS Profile",
            profile.name,
            FIELD_NAME,
            migrated_value,
            update_modified=False,
        )


def execute():
    _upsert_custom_field()
    _migrate_existing_values()
    frappe.clear_cache(doctype="POS Profile")
