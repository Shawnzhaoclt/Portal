from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

import numpy as np


def clean_record(record: dict[str, Any]) -> dict[str, Any]:
    cleaned = {}
    for key, value in record.items():
        if isinstance(value, np.generic):
            cleaned[key] = value.item()
        elif isinstance(value, Decimal):
            cleaned[key] = float(value)
        elif isinstance(value, (date, datetime)):
            cleaned[key] = value.isoformat()
        elif isinstance(value, (bytes, bytearray, memoryview)):
            cleaned[key] = bytes(value).hex()
        else:
            cleaned[key] = value

    return cleaned
