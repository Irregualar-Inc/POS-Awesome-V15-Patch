import json

import frappe


WORKSPACE_NAME = "POS Awesome"
CARD_LABEL = "Authorization & Audit"
LINKS = (
    ("Authorization Codes", "POSA Authorization Code"),
    ("Removal Audit Logs", "POSA Item Removal Log"),
)


def _recompute_card_break_counts(links):
    card_break = None
    for link in links:
        if link.type == "Card Break":
            card_break = link
            card_break.link_count = 0
            continue
        if card_break and link.type == "Link":
            card_break.link_count = (card_break.link_count or 0) + 1


def _set_link_indexes(links):
    for idx, link in enumerate(links, start=1):
        link.idx = idx


def _ensure_workspace_content(workspace):
    content = []
    if workspace.content:
        try:
            content = json.loads(workspace.content)
        except Exception:
            content = []

    changed = False

    filtered_content = []
    for block in content:
        block_type = block.get("type")
        shortcut_name = (block.get("data") or {}).get("shortcut_name")
        if block_type == "shortcut" and shortcut_name in {
            "POSA Authorization Code",
            "POSA Item Removal Log",
        }:
            changed = True
            continue
        filtered_content.append(block)
    content = filtered_content

    has_auth_card = any(
        block.get("type") == "card" and (block.get("data") or {}).get("card_name") == CARD_LABEL
        for block in content
    )
    if not has_auth_card:
        content.append(
            {
                "id": "posaAuthorizationAuditCard",
                "type": "card",
                "data": {"card_name": CARD_LABEL, "col": 4},
            }
        )
        changed = True

    workspace.content = json.dumps(content, separators=(",", ":"))
    return changed


def execute():
    if not frappe.db.table_exists("Workspace"):
        return

    if not frappe.db.table_exists("DocType"):
        return

    if not frappe.db.exists("Workspace", WORKSPACE_NAME):
        return

    workspace = frappe.get_doc("Workspace", WORKSPACE_NAME)
    links = workspace.links or []
    changed = False

    shortcut_targets = {
        "POSA Authorization Code",
        "POSA Item Removal Log",
    }
    existing_shortcuts = workspace.shortcuts or []
    filtered_shortcuts = [
        shortcut
        for shortcut in existing_shortcuts
        if (shortcut.link_to or "").strip() not in shortcut_targets
    ]
    if len(filtered_shortcuts) != len(existing_shortcuts):
        workspace.shortcuts = filtered_shortcuts
        changed = True

    available_links = [(label, link_to) for (label, link_to) in LINKS if frappe.db.exists("DocType", link_to)]
    if not available_links:
        return

    has_card_break = any(link.type == "Card Break" and link.label == CARD_LABEL for link in links)
    if not has_card_break:
        workspace.append(
            "links",
            {
                "type": "Card Break",
                "label": CARD_LABEL,
                "link_count": 0,
                "hidden": 0,
                "is_query_report": 0,
                "onboard": 0,
            },
        )
        changed = True

    links = workspace.links or []
    existing_targets = {(link.link_to or "").strip() for link in links if link.type == "Link"}

    for label, link_to in available_links:
        if link_to in existing_targets:
            continue
        workspace.append(
            "links",
            {
                "type": "Link",
                "label": label,
                "link_to": link_to,
                "link_type": "DocType",
                "link_count": 0,
                "hidden": 0,
                "is_query_report": 0,
                "onboard": 0,
            },
        )
        changed = True

    links = workspace.links or []
    _recompute_card_break_counts(links)
    _set_link_indexes(links)

    content_changed = _ensure_workspace_content(workspace)
    changed = changed or content_changed

    if changed:
        if not workspace.get("type"):
            workspace.type = "Workspace"
        workspace.save(ignore_permissions=True)
