def normalize_key(key: str) -> str:
    return key.strip().lower().replace("-", "_")


def validate(record: dict) -> bool:
    if not isinstance(record, dict):
        return False
    if "id" not in record:
        return False
    if "raw_key" not in record:
        return False
    return True
