class Store:
    def __init__(self) -> None:
        self.records: list[dict] = []

    def save(self, record: dict) -> None:
        self.records.append(dict(record))
