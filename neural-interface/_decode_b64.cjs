const fs = require("fs");
const path = require("path");
const b64 = fs.readFileSync(path.join(__dirname, "_wizard.b64"), "utf8").trim();
const decoded = Buffer.from(b64, "base64").toString("utf8");
fs.writeFileSync(path.join(__dirname, "_wizard.txt"), decoded, "utf8");
console.log("Decoded", decoded.length, "chars to _wizard.txt");
