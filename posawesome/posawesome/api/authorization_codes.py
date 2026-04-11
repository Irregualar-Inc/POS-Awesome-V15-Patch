import json
import random
import re

import frappe
from frappe import _
from frappe.utils import add_to_date, get_datetime, now_datetime, nowdate


AUTH_CODE_REGEX = re.compile(r"^\d{5}$")
ALLOWED_ROLES = {"System Manager", "POSA Manager"}
AUTH_CODE_DOCTYPE = "POSA Authorization Code"
REMOVAL_LOG_DOCTYPE = "POSA Item Removal Log"


def _ensure_allowed_role():
    roles = set(frappe.get_roles(frappe.session.user))
    if not roles.intersection(ALLOWED_ROLES):
        frappe.throw(_("You are not allowed to manage POSA authorization codes."), frappe.PermissionError)


def _new_five_digit_code():
    return f"{random.randint(0, 99999):05d}"


def _parse_removal_context(removal_context):
    if not removal_context:
        return {}

    if isinstance(removal_context, dict):
        return removal_context

    if isinstance(removal_context, str):
        try:
            parsed = json.loads(removal_context)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}

    return {}


def _to_float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _to_text(value):
    return str(value).strip() if value is not None else ""


def _resolve_remover_employee(context):
    from_context = _to_text(context.get("remover_employee"))
    if from_context and frappe.db.exists("Employee", from_context):
        return from_context

    return frappe.db.get_value("Employee", {"user_id": frappe.session.user}, "name")


def _create_removal_log(auth_doc, removal_context):
    context = _parse_removal_context(removal_context)
    items_state = context.get("items_state") if isinstance(context.get("items_state"), list) else []

    remover_employee = _resolve_remover_employee(context)
    normalized_items_state = []
    total_qty = 0.0
    total_amount = 0.0

    for row in items_state:
        if not isinstance(row, dict):
            continue

        qty = _to_float(row.get("qty"), 0)
        amount = _to_float(row.get("amount"), 0)
        normalized_items_state.append(
            {
                "item_code": _to_text(row.get("item_code")),
                "item_name": _to_text(row.get("item_name")),
                "qty": qty,
                "rate": _to_float(row.get("rate"), 0),
                "amount": amount,
            }
        )
        total_qty += qty
        total_amount += amount

    log_doc = frappe.get_doc(
        {
            "doctype": REMOVAL_LOG_DOCTYPE,
            "authorization_code": auth_doc.name,
            "approval_time": auth_doc.used_on or now_datetime(),
            "remover_employee": remover_employee,
            "approver_employee": auth_doc.employee,
            "pos_profile": _to_text(context.get("pos_profile")),
            "invoice_name": _to_text(context.get("invoice_name")),
            "total_qty": total_qty,
            "total_amount": total_amount,
            "company": _to_text(context.get("company")),
            "warehouse": _to_text(context.get("warehouse")),
            "customer": _to_text(context.get("customer")),
            "currency": _to_text(context.get("currency")),
            "removal_reason": _to_text(context.get("removal_reason")),
            "items_state": [],
        }
    )

    for row in normalized_items_state:
        log_doc.append(
            "items_state",
            {
                "item_code": row.get("item_code"),
                "item_name": row.get("item_name"),
                "qty": row.get("qty"),
                "rate": row.get("rate"),
                "amount": row.get("amount"),
            },
        )

    if not log_doc.remover_employee:
        log_doc.remover_employee = auth_doc.employee

    log_doc.insert(ignore_permissions=True)
    return log_doc.name


def _today_range():
    start = get_datetime(nowdate() + " 00:00:00")
    end = add_to_date(start, days=1, seconds=-1)
    return start, end


def _generate_unique_daily_code(day_start, day_end, max_attempts=25):
    for __attempt in range(max_attempts):
        code = _new_five_digit_code()
        existing = frappe.db.exists(
            AUTH_CODE_DOCTYPE,
            {
                "authorization_code": code,
                "generated_on": ["between", [day_start, day_end]],
            },
        )
        if not existing:
            return code

    frappe.throw(_("Unable to generate a unique authorization code. Please try again."))


def _get_employee_code_for_today(employee):
    day_start, day_end = _today_range()
    name = frappe.db.get_value(
        AUTH_CODE_DOCTYPE,
        {
            "employee": employee,
            "generated_on": ["between", [day_start, day_end]],
        },
        "name",
        order_by="creation desc",
    )
    if not name:
        return None

    return frappe.get_doc(AUTH_CODE_DOCTYPE, name)


@frappe.whitelist()
def generate_employee_authorization_code(employee):
    _ensure_allowed_role()

    if not employee:
        frappe.throw(_("Employee is required."))
    if not frappe.db.exists("Employee", employee):
        frappe.throw(_("Employee {0} does not exist.").format(employee))

    existing_doc = _get_employee_code_for_today(employee)
    if existing_doc:
        return {
            "name": existing_doc.name,
            "code": existing_doc.authorization_code,
            "employee": employee,
            "generated_on": str(existing_doc.generated_on),
            "expires_on": str(existing_doc.expires_on) if existing_doc.expires_on else None,
            "is_new": False,
        }

    day_start, day_end = _today_range()
    code = _generate_unique_daily_code(day_start, day_end)
    generated_on = now_datetime()
    expires_on = day_end

    doc = frappe.get_doc(
        {
            "doctype": AUTH_CODE_DOCTYPE,
            "authorization_code": code,
            "employee": employee,
            "generated_by": frappe.session.user,
            "generated_on": generated_on,
            "expires_on": expires_on,
            "is_used": 0,
        }
    )
    doc.insert(ignore_permissions=True)

    return {
        "name": doc.name,
        "code": code,
        "employee": employee,
        "generated_on": str(generated_on),
        "expires_on": str(expires_on),
        "is_new": True,
    }


@frappe.whitelist()
def validate_and_use_authorization_code(code):
    if not code:
        return {"valid": False, "message": _("Authorization code is required.")}

    code = str(code).strip()
    if not AUTH_CODE_REGEX.match(code):
        return {"valid": False, "message": _("Authorization code must be a 5-digit number.")}

    now = now_datetime()
    day_start, day_end = _today_range()
    name = frappe.db.get_value(
        AUTH_CODE_DOCTYPE,
        {
            "authorization_code": code,
            "generated_on": ["between", [day_start, day_end]],
        },
        "name",
        order_by="creation desc",
    )

    if not name:
        return {"valid": False, "message": _("Authorization code was not generated for today.")}

    doc = frappe.get_doc(AUTH_CODE_DOCTYPE, name)

    if not doc.expires_on or doc.expires_on < now:
        return {"valid": False, "message": _("Authorization code has expired for today.")}

    doc.is_used = 1
    doc.used_on = now
    doc.used_by = frappe.session.user
    doc.save(ignore_permissions=True)

    return {
        "valid": True,
        "code": code,
        "record": doc.name,
        "employee": doc.employee,
        "used_on": str(now),
    }


@frappe.whitelist()
def log_authorized_item_removal(authorization_record, removal_context=None):
    if not authorization_record:
        return {"success": False, "message": _("Authorization record is required.")}

    if not frappe.db.exists(AUTH_CODE_DOCTYPE, authorization_record):
        return {"success": False, "message": _("Authorization record was not found.")}

    auth_doc = frappe.get_doc(AUTH_CODE_DOCTYPE, authorization_record)

    log_name = _create_removal_log(auth_doc, removal_context)

    return {
        "success": True,
        "log": log_name,
        "authorization_record": authorization_record,
    }
