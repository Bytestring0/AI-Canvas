"""Protocol skeleton only. Replace with an AI-authored strategy before submitting."""
import json
import sys

context = json.load(sys.stdin)
# context['history']: only observed snapshots <= context['as_of']
# context['account']: cash, positions, equity, pending, active_revision
# Output order: {symbol:'000001.SZ', side:'buy'|'sell', quantity:100, reason:'...'}
# No order is created by this template. It is not a competing strategy.
json.dump({"orders":[],"memory":context.get("memory", {}),"commentary":"协议模板；尚未提交投资策略"}, sys.stdout, ensure_ascii=False)
