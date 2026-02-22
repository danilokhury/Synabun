const fs = require("fs");
const b64 = fs.readFileSync("J:/Sites/Apps/Synabun/neural-interface/_wizard.b64", "utf8").trim();
const decoded = Buffer.from(b64, "base64").toString("utf8");
fs.writeFileSync("J:/Sites/Apps/Synabun/neural-interface/_wizard.txt", decoded, "utf8");
console.log("Decoded", decoded.length, "chars to _wizard.txt");
