from fixture_pkg import ingest, Store


def test_ingest_saves_one_record():
    store = Store()
    result = ingest([{"id": 1, "raw_key": "Foo-Bar"}], store=store)
    assert len(result.records) == 1
    assert result.records[0]["key"] == "foo_bar"
    assert result.records[0]["id"] == 1
