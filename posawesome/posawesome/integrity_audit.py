# Copyright (c) 2026, POSAwesome contributors
# Detective control for the "totals present but empty items" data integrity bug.
#
# The before_update_after_submit guard in api/invoice.py PREVENTS the corruption
# at the ORM layer. This scheduled audit is the backstop: it catches anything
# that slips past the ORM (raw SQL, db.set_value, flags.ignore_validate, manual
# console operations) by scanning for the impossible state every hour.
#
# Reporting (see audit_empty_items_invoices):
#   - Error Log doctype  (Desk: /app/error-log)  -> durable, searchable record
#   - Email to System Managers                    -> only for newly-seen invoices
#   - Site log file (logs/, via frappe.logger)    -> for log aggregation

import frappe
from frappe import _

SUPPORTED = ("Sales Invoice", "POS Invoice")
CHILD = {"Sales Invoice": "Sales Invoice Item", "POS Invoice": "POS Invoice Item"}
_SEEN_CACHE_KEY = "posa_empty_items_seen"


def find_empty_items_invoices(doctype="Sales Invoice", posa_only=True):
    """Return submitted/draft invoices with grand_total > 0 but zero item rows."""
    if doctype not in SUPPORTED:
        frappe.throw(f"Unsupported doctype: {doctype}")
    cond = ["si.grand_total > 0", "si.docstatus IN (0, 1)"]
    if posa_only:
        cond.append("si.posa_pos_opening_shift IS NOT NULL")
        cond.append("si.posa_pos_opening_shift != ''")
    child = CHILD[doctype]
    return frappe.db.sql(
        f"""
        SELECT si.name, si.docstatus, si.grand_total, si.modified, si.modified_by
        FROM `tab{doctype}` si
        WHERE {" AND ".join(cond)}
          AND NOT EXISTS (SELECT 1 FROM `tab{child}` c WHERE c.parent = si.name)
        ORDER BY si.modified DESC
        """,
        as_dict=True,
    )


def _format_report(affected):
    lines = [f"{len(affected)} invoice(s) have grand_total > 0 but NO item rows:\n"]
    for r in affected[:200]:
        lines.append(
            f"  {r['name']}  docstatus={r['docstatus']}  total={r['grand_total']}  "
            f"last modified by {r['modified_by']} at {r['modified']}"
        )
    if len(affected) > 200:
        lines.append(f"  ... and {len(affected) - 200} more")
    lines.append(
        "\nRecover items from version history with recovery_helper_empty_items.py; "
        "identify the trigger with posa_empty_items_forensics.py."
    )
    return "\n".join(lines)


def _email_system_managers(new_names, affected):
    """Best-effort push alert. Never raises into the scheduler."""
    try:
        from frappe.utils.user import get_system_managers

        recipients = [r for r in (get_system_managers() or []) if r and "@" in r]
        if not recipients:
            return
        frappe.sendmail(
            recipients=recipients,
            subject=_("[POSAwesome] {0} invoice(s) with totals but no items").format(len(new_names)),
            message=(
                "<p>The hourly integrity audit detected invoices whose totals are "
                "non-zero but whose items table is empty. Newly detected since the "
                "last run:</p><pre>{new}</pre><p>Full current list:</p><pre>{full}</pre>"
            ).format(
                new="\n".join(new_names),
                full=frappe.utils.escape_html(_format_report(affected)),
            ),
        )
    except Exception:
        frappe.logger("posawesome").error(
            "empty-items audit: failed to email System Managers\n" + frappe.get_traceback()
        )


def audit_empty_items_invoices(posa_only=True, email_on_new=True):
    """Scheduled hourly. Reports invoices with totals but no items.

    Returns a summary dict so it can also be run manually from bench console.
    """
    try:
        affected = []
        for doctype in SUPPORTED:
            affected.extend(find_empty_items_invoices(doctype, posa_only=posa_only))
    except Exception:
        frappe.logger("posawesome").error(
            "empty-items audit failed to query\n" + frappe.get_traceback()
        )
        return {"count": 0, "invoices": [], "error": True}

    if not affected:
        # Clear the seen-set so the next genuine occurrence re-alerts.
        frappe.cache().delete_value(_SEEN_CACHE_KEY)
        return {"count": 0, "invoices": []}

    names = sorted({r["name"] for r in affected})

    # 1) Durable, searchable record in the Error Log doctype (/app/error-log).
    #    Title is capped at 140 chars by Frappe; detail goes in the message.
    frappe.log_error(
        message=_format_report(affected),
        title="POSAwesome: invoices with totals but no items",
    )

    # 3) Site log file for ops/log aggregation.
    frappe.logger("posawesome").warning(
        f"empty-items audit: {len(names)} affected invoice(s): {names[:50]}"
    )

    # 2) Push alert, but only for invoices not seen in the previous run, so a
    #    standing backlog does not generate an email every hour.
    if email_on_new:
        try:
            seen = set(frappe.cache().get_value(_SEEN_CACHE_KEY) or [])
            new_names = [n for n in names if n not in seen]
            if new_names:
                _email_system_managers(new_names, affected)
            frappe.cache().set_value(_SEEN_CACHE_KEY, names)
        except Exception:
            frappe.logger("posawesome").error(
                "empty-items audit: alert bookkeeping failed\n" + frappe.get_traceback()
            )

    return {"count": len(names), "invoices": names}
