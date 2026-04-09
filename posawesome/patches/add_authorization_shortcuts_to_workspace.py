import frappe


WORKSPACE_NAME = "POS Awesome"
SHORTCUTS = (
    {
        "label": "POSA Authorization Code",
        "link_to": "POSA Authorization Code",
        "type": "DocType",
        "doc_view": "List",
        "color": "Grey",
    },
    {
        "label": "POSA Item Removal Log",
        "link_to": "POSA Item Removal Log",
        "type": "DocType",
        "doc_view": "List",
        "color": "Grey",
    },
)


def execute():
    if not frappe.db.table_exists("Workspace"):
        return

    if not frappe.db.table_exists("DocType"):
        return

    if not frappe.db.exists("Workspace", WORKSPACE_NAME):
        return

    workspace = frappe.get_doc("Workspace", WORKSPACE_NAME)
    existing_shortcuts = workspace.shortcuts or []
    existing_link_targets = {(shortcut.link_to or "").strip() for shortcut in existing_shortcuts}

    changed = False
    for shortcut in SHORTCUTS:
        if shortcut["link_to"] in existing_link_targets:
            continue

        if not frappe.db.exists("DocType", shortcut["link_to"]):
            continue

        workspace.append(
            "shortcuts",
            {
                "label": shortcut["label"],
                "link_to": shortcut["link_to"],
                "type": shortcut["type"],
                "doc_view": shortcut["doc_view"],
                "color": shortcut["color"],
            },
        )
        changed = True

    if changed:
        if not workspace.get("type"):
            workspace.type = "Workspace"
        workspace.save(ignore_permissions=True)
