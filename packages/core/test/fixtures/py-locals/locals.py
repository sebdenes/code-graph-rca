# Fixture for kind='local' extraction in Python — exercises top-level
# assignments, nested-block assignments, tuple unpacking, and for-loop
# iter vars (single + tuple).


def foo(d):
    a = 1
    b = a + 1
    if b > 0:
        nested = b * 2
        c, e = 3, 4
        (g, h) = (5, 6)
        return nested + c + e + g + h
    return a + b


def loops(items, d):
    acc = 0
    for i in items:
        acc += i
    for k, v in d.items():
        acc += v
        for j in range(k):
            acc += j
    return acc
