from frappe import _


def get_data():
    return {
        "fieldname": "authorization_code",
        "transactions": [
            {
                "label": _("Authorization & Audit"),
                "items": ["POSA Item Removal Log"],
            }
        ],
    }
