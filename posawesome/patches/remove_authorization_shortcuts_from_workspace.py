import json

import frappe


WORKSPACE_NAME = "POS Awesome"
SHORTCUT_TARGETS = {
    "POSA Authorization Code",
    "POSA Item Removal Log",
}


def execute():
    if not frappe.db.table_exists("Workspace"):
        return

    if not frappe.db.exists("Workspace", WORKSPACE_NAME):
        return

    workspace = frappe.get_doc("Workspace", WORKSPACE_NAME)
    changed = False

    existing_shortcuts = workspace.shortcuts or []
    filtered_shortcuts = [
        shortcut
        for shortcut in existing_shortcuts
        if (shortcut.link_to or "").strip() not in SHORTCUT_TARGETS
    ]
    if len(filtered_shortcuts) != len(existing_shortcuts):
        workspace.shortcuts = filtered_shortcuts
        changed = True

    content = []
    if workspace.content:
        try:
            content = json.loads(workspace.content)
        except Exception:
            content = []

    filtered_content = []
    for block in content:
        block_type = block.get("type")
        shortcut_name = (block.get("data") or {}).get("shortcut_name")
        if block_type == "shortcut" and shortcut_name in SHORTCUT_TARGETS:
            changed = True
            continue
        filtered_content.append(block)

    if changed:
        workspace.content = json.dumps(filtered_content, separators=(",", ":"))
        if not workspace.get("type"):
            workspace.type = "Workspace"
        workspace.save(ignore_permissions=True)
