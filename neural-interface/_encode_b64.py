import base64, sys, os
data = sys.stdin.buffer.read()
b64 = base64.b64encode(data).decode("ascii")
out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_wizard.b64")
with open(out_path, "w") as f:
    f.write(b64)
print("Encoded", len(data), "bytes to", len(b64), "base64 chars")
