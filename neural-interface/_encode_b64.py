import base64, sys
data = sys.stdin.buffer.read()
b64 = base64.b64encode(data).decode("ascii")
with open("J:/Sites/Apps/Synabun/neural-interface/_wizard.b64", "w") as f:
    f.write(b64)
print("Encoded", len(data), "bytes to", len(b64), "base64 chars")
