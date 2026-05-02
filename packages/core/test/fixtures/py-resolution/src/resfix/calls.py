import requests


class Foo:
    def method(self):
        return 1


def driver(x, obj):
    a = len(x)
    b = requests.get("http://example.com")
    c = obj.method()
    d = unknown_fn(x)
    return a, b, c, d
