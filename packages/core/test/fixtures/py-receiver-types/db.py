# Fixture for receiver-type inference (v6).
#
# Conn defines `execute` and `commit`. ServiceA holds a Conn-typed
# attribute and a Conn-typed local; both call `.execute(...)` and
# `.commit(...)` — the resolver should map those to Conn's methods.


class Conn:
    def execute(self, sql: str) -> None:
        pass

    def commit(self) -> None:
        pass


class ServiceA:
    def __init__(self, db: Conn) -> None:
        self._db = db

    def run(self, db: Conn) -> None:
        # `db` is a typed param → execute/commit resolve to Conn.execute / Conn.commit.
        db.execute("select 1")
        db.commit()
        # Self-receiver: self.helper() should resolve to ServiceA.helper.
        self.helper()
        # A typed local with annotated assignment.
        local: Conn = make_conn()
        local.execute("select 2")

    def helper(self) -> None:
        pass


def make_conn() -> Conn:
    return Conn()
