"""Optional, pure read-only query API for context JSON. Copy into your single script if needed."""
class Context:
    def __init__(self, payload):
        self.payload = payload

    def account(self):
        return self.payload["account"]

    def universe(self):
        return list(self.payload["environment"]["universe"])

    def history(self, symbol, count=20):
        if count <= 0:
            return []
        return [{"timestamp":row["as_of"],"slot":row["slot"],**row["bars"][symbol]} for row in self.payload["history"] if symbol in row["bars"]][-count:]

    def quote(self, symbol):
        rows = self.history(symbol, 1)
        return rows[-1] if rows else None

    def position(self, symbol):
        return self.account()["positions"].get(symbol, {"quantity":0,"sellable":0,"cost":0})

    def buy(self, symbol, quantity, reason=""):
        return {"symbol":symbol,"side":"buy","quantity":quantity,"reason":reason}

    def sell(self, symbol, quantity, reason=""):
        return {"symbol":symbol,"side":"sell","quantity":quantity,"reason":reason}
