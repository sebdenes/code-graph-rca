from .validate import normalize_key


class Transformer:
    def apply(self, record: dict) -> dict:
        if "raw_key" in record:
            record["key"] = normalize_key(record.pop("raw_key"))
        return record
