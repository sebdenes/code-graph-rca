from .transform import Transformer
from .validate import validate
from .store import Store


def ingest(records: list[dict], store: Store | None = None) -> Store:
    store = store or Store()
    transformer = Transformer()
    for record in records:
        transformed = transformer.apply(record)
        if validate(record):
            store.save(transformed)
    return store
